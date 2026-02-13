#!/usr/bin/env bash
set -euo pipefail

OUT="${OUT:-/data/status.json}"
CONF="${CONF:-/data/config.json}"

mdstat="$(cat /proc/mdstat || true)"

python3 - <<'PY' > "${OUT}.tmp"
import json, os, re, subprocess, datetime

OUT = os.environ.get("OUT", "/data/status.json")
CONF = os.environ.get("CONF", "/data/config.json")

# u bash delu mdstat nije automatski prosledjen kao env, pa ga citamo direktno
try:
    with open("/proc/mdstat", "r", encoding="utf-8", errors="ignore") as f:
        mdstat = f.read()
except Exception:
    mdstat = ""

def sh(cmd):
    return subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True)

def read_config():
    try:
        with open(CONF, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

cfg = read_config()
include_arrays = cfg.get("include_arrays") or []
exclude_arrays = set(cfg.get("exclude_arrays") or [])
labels = cfg.get("labels") or {}

def normalize_md_name(name: str) -> str:
    # prihvata "md0" ili "/dev/md0"
    return name if name.startswith("/dev/") else f"/dev/{name}"

def discover_arrays():
    arrays = set()

    # 1) mdadm --detail --scan (najbolje kad radi)
    try:
        out = sh(["mdadm", "--detail", "--scan"])
        for line in out.splitlines():
            m = re.search(r'\bARRAY\s+(\S+)', line)
            if m:
                arrays.add(m.group(1))
    except Exception:
        pass

    # 2) fallback iz /proc/mdstat
    for line in mdstat.splitlines():
        m = re.match(r'^(md\d+)\s*:\s*', line.strip())
        if m:
            arrays.add(f"/dev/{m.group(1)}")

    arrays = sorted(arrays)

    # apply config filtering
    if include_arrays:
        wanted = set(normalize_md_name(x) for x in include_arrays)
        arrays = [a for a in arrays if a in wanted]
    else:
        arrays = [a for a in arrays if a not in set(normalize_md_name(x) for x in exclude_arrays)]

    return arrays

def get_udev_props(dev):
    if not dev:
        return {}
    try:
        out = sh(["udevadm", "info", "--query=property", "--name", dev])
        props = {}
        for line in out.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                props[k] = v
        return props
    except Exception:
        return {}

def looks_like_wwnish(s: str) -> bool:
    if not s:
        return False
    t = s.strip().lower()
    if t.startswith("0x"):
        t = t[2:]
    # tipicno 12-32 heks karaktera (wwn ili scsi id)
    if re.fullmatch(r"[0-9a-f]{12,32}", t or ""):
        return True
    # jos jedan cest slucaj: "50014ee2..." bez 0x
    if t.startswith("500") and re.fullmatch(r"[0-9a-f]{12,32}", t):
        return True
    return False

def smartctl_info(dev: str):
    """
    Vraca tuple (serial, model, raw_output) iz smartctl -i
    Uz fallback na -d sat, -d sat,12, -d sat,16, -d scsi (za diskove iza HBA).
    """
    if not dev:
        return ("", "", "")

    variants = [
        [],                 # smartctl -i /dev/sdX
        ["-d", "sat"],      # SATA iza SAS HBA
        ["-d", "sat,12"],   # cesto radi za LSI passthrough
        ["-d", "sat,16"],
        ["-d", "scsi"],
    ]

    last = ""
    for v in variants:
        try:
            out = sh(["smartctl"] + v + ["-i", dev])
            last = out

            m_ser = re.search(r"(?im)^\s*Serial Number:\s*(.+)\s*$", out)
            m_mod = re.search(r"(?im)^\s*(Device Model|Model Family|Product):\s*(.+)\s*$", out)

            serial = m_ser.group(1).strip() if m_ser else ""
            model = m_mod.group(2).strip() if m_mod else ""

            if serial:
                return (serial, model, out)
        except Exception as e:
            last = str(e)

    return ("", "", last)

def extract_progress(md_name: str):
    # md_name: "md0"
    lines = mdstat.splitlines()
    start = None
    for i, line in enumerate(lines):
        if re.match(rf'^{re.escape(md_name)}\s*:\s*', line.strip()):
            start = i
            break
    if start is None:
        return {"action":"", "percent":"", "finish":"", "speed":"", "raw_line":""}

    # progress moze biti na sledecoj liniji, ponekad i na istoj
    block = "\n".join(lines[start:start+4])

    m_action = re.search(r'(recovery|resync|reshape|check)', block)
    m_pct = re.search(r'(\d+(?:\.\d+)?)%', block)
    m_finish = re.search(r'finish=([^\s]+)', block)
    m_speed = re.search(r'speed=([^\s]+)', block)

    raw_line = ""
    for l in block.splitlines():
        if re.search(r'(recovery|resync|reshape|check)\s*=', l):
            raw_line = l.strip()
            break

    return {
        "action": m_action.group(1) if m_action else "",
        "percent": (m_pct.group(0) if m_pct else ""),
        "finish": (m_finish.group(1) if m_finish else ""),
        "speed": (m_speed.group(1) if m_speed else ""),
        "raw_line": raw_line
    }

def parse_mdadm_detail(detail_text: str):
    def pick(pattern, default=""):
        m = re.search(pattern, detail_text, re.MULTILINE)
        return m.group(1).strip() if m else default

    def pick_size_line(label: str) -> str:
        # returns everything after ":" on the first matching line, e.g.
        # "11720780800 (10.92 TiB 12.00 TB)"
        return pick(rf'^\s*{re.escape(label)}\s*:\s*(.+)$', "")

    def human_from_size_line(size_line: str) -> str:
        # turns "(10.92 TiB 12.00 TB)" into "10.92 TiB (12.00 TB)"
        if not size_line:
            return ""
        m = re.search(r'\(([^)]+)\)', size_line)
        if not m:
            return ""
        inner = " ".join(m.group(1).strip().split())
        parts = inner.split()
        # most common mdadm format: "<num> <unit1> <num> <unit2>"
        if len(parts) == 4:
            return f"{parts[0]} {parts[1]} ({parts[2]} {parts[3]})"
        return inner

    state = pick(r'^\s*State\s*:\s*(.+)$', "unknown")
    active = pick(r'^\s*Active Devices\s*:\s*(\d+)\s*$', "unknown")
    failed = pick(r'^\s*Failed Devices\s*:\s*(\d+)\s*$', "unknown")
    degraded = pick(r'^\s*Degraded Devices\s*:\s*(\d+)\s*$', "unknown")
    raid_level = pick(r'^\s*Raid Level\s*:\s*(.+)$', "")
    raid_devices = pick(r'^\s*Raid Devices\s*:\s*(\d+)\s*$', "")
    spare = pick(r'^\s*Spare Devices\s*:\s*(\d+)\s*$', "")
    array_size = pick_size_line("Array Size")
    used_dev_size = pick_size_line("Used Dev Size")
    array_size_human = human_from_size_line(array_size)
    used_dev_size_human = human_from_size_line(used_dev_size)

    # fallback degraded
    if degraded in ("", "unknown"):
        if "clean" in state and failed in ("0", "", "unknown"):
            degraded = "0"
        else:
            degraded = "unknown"

    members = []
    lines = detail_text.splitlines()
    start_idx = None
    for i, line in enumerate(lines):
        if re.match(r'^\s*Number\s+Major\s+Minor\s+RaidDevice\s+State', line):
            start_idx = i + 1
            break

    if start_idx is not None:
        for line in lines[start_idx:]:
            if not line.strip():
                break
            parts = line.split()
            if len(parts) < 5:
                continue

            number = parts[0]
            major = parts[1]
            minor = parts[2]
            raid_device = parts[3]

            dev_path = ""
            if parts[-1].startswith("/dev/"):
                dev_path = parts[-1]
                state_tokens = parts[4:-1]
            else:
                state_tokens = parts[4:]

            member_state = " ".join(state_tokens).strip()
            props = get_udev_props(dev_path) if dev_path else {}

            serial = (props.get("ID_SERIAL_SHORT") or "").strip()
            wwn = (props.get("ID_WWN") or "").strip()

            # fallback 1: pokusaj iz ID_SERIAL
            if not serial:
                full = (props.get("ID_SERIAL") or "").strip()
                if full:
                    if "_" in full:
                        serial = full.split("_")[-1].strip()
                    else:
                        serial = full

            # fallback 2: ako serial izgleda kao WWN ili je prazan, pokusaj smartctl (sa HBA fallback modovima)
            if (not serial) or looks_like_wwnish(serial):
                sc_serial, sc_model, _raw = smartctl_info(dev_path)
                if sc_serial:
                    serial = sc_serial

            members.append({
                "number": number,
                "raid_device": raid_device,
                "major": major,
                "minor": minor,
                "state": member_state,
                "device": dev_path,
                "serial": serial,
                "wwn": wwn
            })

    return {
        "state": state.strip(),
        "active": active,
        "degraded": degraded,
        "failed": failed,
        "raid_level": raid_level,
        "raid_devices": raid_devices,
        "spare": spare,
        "array_size": array_size,
        "used_dev_size": used_dev_size,
        "array_size_human": array_size_human,
        "used_dev_size_human": used_dev_size_human,
        "members": members
    }

arrays = []
for array_path in discover_arrays():
    md_name = array_path.split("/")[-1]  # md0
    try:
        detail = sh(["mdadm", "--detail", array_path])
    except Exception as e:
        detail = f"ERROR: {e}"

    parsed = parse_mdadm_detail(detail) if not detail.startswith("ERROR:") else {
        "state":"unknown", "active":"unknown", "degraded":"unknown", "failed":"unknown",
        "raid_level":"", "raid_devices":"", "spare":"", "array_size":"", "used_dev_size":"", "array_size_human":"", "used_dev_size_human":"", "members":[]
    }

    arrays.append({
        "array": array_path,
        "label": labels.get(array_path, ""),
        "md_name": md_name,
        "state": parsed["state"],
        "active": parsed["active"],
        "degraded": parsed["degraded"],
        "failed": parsed["failed"],
        "raid_level": parsed["raid_level"],
        "raid_devices": parsed["raid_devices"],
        "spare": parsed["spare"],
        "array_size": parsed.get("array_size", ""),
        "used_dev_size": parsed.get("used_dev_size", ""),
        "array_size_human": parsed.get("array_size_human", ""),
        "used_dev_size_human": parsed.get("used_dev_size_human", ""),
        "progress": extract_progress(md_name),
        "members": parsed["members"],
        "detail": detail
    })

data = {
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "arrays": arrays,
    "mdstat": mdstat
}

print(json.dumps(data, ensure_ascii=False))
PY

mv -f "${OUT}.tmp" "${OUT}"