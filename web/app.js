const TZ = "Europe/Belgrade";
const STATUS_URL = "./status.json";

const els = {
  arraysRoot: document.getElementById("arraysRoot"),
  lastFetch: document.getElementById("lastFetch"),
  toast: document.getElementById("toast"),
  btnRefresh: document.getElementById("btnRefresh"),
  btnThemeLight: document.getElementById("btnThemeLight"),
  btnThemeDark: document.getElementById("btnThemeDark"),
};

let lastData = null; // cuvamo poslednji payload za "ago" refresh

function toast(msg){
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("show"), 1600);
}

function fmtLocal(ts){
  if(!ts) return "-";
  const d = new Date(ts);
  if(Number.isNaN(d.getTime())) return ts;
  return new Intl.DateTimeFormat("sr-RS", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
}

function timeAgoFromIso(ts){
  const d = new Date(ts);
  if(Number.isNaN(d.getTime())) return "-";
  const diffMs = Date.now() - d.getTime();
  const s = Math.max(0, Math.floor(diffMs/1000));
  if(s < 5) return "just now";
  if(s < 60) return `${s}s ago`;
  const m = Math.floor(s/60);
  if(m < 60) return `${m}m ago`;
  const h = Math.floor(m/60);
  if(h < 48) return `${h}h ago`;
  const days = Math.floor(h/24);
  return `${days}d ago`;
}

function setBadge(el, text, kind){
  el.textContent = text;
  el.classList.remove("good","warn","bad");
  if(kind) el.classList.add(kind);
}

function normalizeState(s){
  return (s || "").toLowerCase().trim();
}

function memberKind(memberState){
  const s = normalizeState(memberState);
  if(s.includes("faulty") || s.includes("failed") || s.includes("removed")) return "bad";
  if(s.includes("spare") || s.includes("rebuilding") || s.includes("recover") || s.includes("resync") || s.includes("reshape")) return "warn";
  if(s.includes("active") && (s.includes("sync") || s.includes("in-sync") || s.includes("in_sync"))) return "good";
  return "";
}

function arrayStateKind(state, degraded, failed){
  const s = normalizeState(state);
  const d = Number(degraded);
  const f = Number(failed);

  if(!Number.isNaN(f) && f > 0) return "bad";
  if(!Number.isNaN(d) && d > 0) return "warn";
  if(s.includes("clean")) return "good";
  if(s.includes("active")) return "warn";
  if(s.includes("degraded")) return "warn";
  return "";
}

async function copyToClipboard(text){
  try{
    await navigator.clipboard.writeText(text);
    toast("Copied");
  }catch{
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("Copied");
  }
}

function memberCard(m){
  const wrap = document.createElement("div");
  wrap.className = "member";

  const top = document.createElement("div");
  top.className = "memberTop";

  const title = document.createElement("div");
  title.className = "memberTitle";

  const pRaid = document.createElement("span");
  pRaid.className = "pill";
  pRaid.textContent = `RaidDevice: ${m.raid_device ?? "-"}`;

  const pNum = document.createElement("span");
  pNum.className = "pill";
  pNum.textContent = `Num: ${m.number ?? "-"}`;

  const pDev = document.createElement("span");
  pDev.className = "pill";
  pDev.textContent = `Dev: ${m.device ?? "-"}`;

  const pState = document.createElement("span");
  const kind = memberKind(m.state);
  pState.className = `pill ${kind}`;
  pState.textContent = `State: ${m.state ?? "-"}`;

  title.appendChild(pRaid);
  title.appendChild(pNum);
  title.appendChild(pDev);
  title.appendChild(pState);

  const btns = document.createElement("div");
  btns.style.display = "flex";
  btns.style.gap = "8px";
  btns.style.flexWrap = "wrap";

  const serial = (m.serial || "").trim();
  const wwn = (m.wwn || "").trim();
  const dev = (m.device || "").trim();

  if(serial){
    const b = document.createElement("button");
    b.className = "iconBtn";
    b.type = "button";
    b.title = "Copy serial";
    b.textContent = "Copy serial";
    b.onclick = () => copyToClipboard(serial);
    btns.appendChild(b);
  }

  if(wwn){
    const b = document.createElement("button");
    b.className = "iconBtn";
    b.type = "button";
    b.title = "Copy WWN";
    b.textContent = "Copy WWN";
    b.onclick = () => copyToClipboard(wwn);
    btns.appendChild(b);
  }

  if(dev){
    const b = document.createElement("button");
    b.className = "iconBtn";
    b.type = "button";
    b.title = "Copy device path";
    b.textContent = "Copy dev";
    b.onclick = () => copyToClipboard(dev);
    btns.appendChild(b);
  }

  top.appendChild(title);
  top.appendChild(btns);

  const body = document.createElement("div");
  body.className = "memberBody";

  const line = document.createElement("div");
  line.className = "kv";
  line.innerHTML =
    `Serial: <b class="mono">${serial || "-"}</b> <span class="muted">|</span> ` +
    `WWN: <b class="mono">${wwn || "-"}</b>`;
  body.appendChild(line);

  wrap.appendChild(top);
  wrap.appendChild(body);

  return wrap;
}

function arrayCard(a, globalMdstat){
  const card = document.createElement("section");
  card.className = "card";

  const header = document.createElement("div");
  header.className = "cardHeader";

  const row1 = document.createElement("div");
  row1.className = "row";

  const meta = document.createElement("div");
  meta.className = "meta";

  const label = (a.label || "").trim();
  meta.innerHTML =
    `<span class="k">Array:</span> <span class="v mono">${a.array || "-"}</span>` +
    (label ? ` <span class="muted">(${label})</span>` : "");

  const badges = document.createElement("div");
  badges.className = "badges";

  const bState = document.createElement("span");
  bState.className = "badge";
  const bActive = document.createElement("span");
  bActive.className = "badge";
  const bDegraded = document.createElement("span");
  bDegraded.className = "badge";
  const bFailed = document.createElement("span");
  bFailed.className = "badge";

  const state = (a.state || "-").toString().trim();
  const active = (a.active ?? "-").toString().trim();
  const degraded = (a.degraded ?? "-").toString().trim();
  const failed = (a.failed ?? "-").toString().trim();
  const kind = arrayStateKind(state, degraded, failed);

  setBadge(bState, `State: ${state}`, kind);
  setBadge(bActive, `Active: ${active}`, "");
  setBadge(bDegraded, `Degraded: ${degraded}`, (Number(degraded) > 0 ? "warn" : ""));
  setBadge(bFailed, `Failed: ${failed}`, (Number(failed) > 0 ? "bad" : ""));

  badges.appendChild(bState);
  badges.appendChild(bActive);
  badges.appendChild(bDegraded);
  badges.appendChild(bFailed);

  row1.appendChild(meta);
  row1.appendChild(badges);

  const row2 = document.createElement("div");
  row2.className = "row smallrow";

  // RAID + capacity (from structured fields, stable)
  const specWrap = document.createElement("div");
  specWrap.className = "specWrap";

  const raidLevelRaw = (a.raid_level || "").toString().trim();
  const raidLevel = raidLevelRaw ? raidLevelRaw.toUpperCase() : "";

  const arraySize = ((a.array_size_human || a.array_size) || "").toString().trim();
  const usedDevSize = ((a.used_dev_size_human || a.used_dev_size) || "").toString().trim();

  const parts = [];
  if(raidLevel) parts.push(`<span class="k">RAID:</span> <span class="v mono">${raidLevel}</span>`);
  if(arraySize) parts.push(`<span class="k">Array:</span> <span class="v mono">${arraySize}</span>`);
  if(usedDevSize) parts.push(`<span class="k">Disk:</span> <span class="v mono">${usedDevSize}</span>`);

  if(parts.length){
    specWrap.innerHTML = parts.join(' <span class="dot">•</span> ');
  }else{
    specWrap.classList.add("hidden");
  }


  const updatedWrap = document.createElement("div");
  updatedWrap.className = "muted";
  updatedWrap.innerHTML = `
    Generated:
    <span class="mono js-updatedAt">${fmtLocal(a.timestamp || null)}</span>
    <span class="dot">•</span>
    <span class="muted js-updatedAgo">-</span>
    <span class="muted" title="Time when status.json was last generated by the server" style="cursor: help;"> ⓘ</span>
  `;

  const progressWrap = document.createElement("div");
  progressWrap.className = "progressWrap hidden";

  const progBadge = document.createElement("span");
  progBadge.className = "badge warn";
  progressWrap.appendChild(progBadge);

  const prog = a.progress || {};
  const action = (prog.action || "").trim();
  const percent = (prog.percent || "").trim();
  const finish = (prog.finish || "").trim();
  const speed = (prog.speed || "").trim();

  if(action){
    progressWrap.classList.remove("hidden");
    const parts = [];
    parts.push(action);
    if(percent) parts.push(percent);
    if(speed) parts.push(speed);
    if(finish) parts.push(`finish ${finish}`);
    progBadge.textContent = parts.join(" | ");
  }

  row2.appendChild(specWrap);
  row2.appendChild(updatedWrap);
  row2.appendChild(progressWrap);

  header.appendChild(row1);
  header.appendChild(row2);

  const body = document.createElement("div");
  body.className = "cardBody";

  const h2 = document.createElement("h2");
  h2.textContent = "Members";

  const grid = document.createElement("div");
  grid.className = "grid";

  const members = Array.isArray(a.members) ? a.members : [];
  for(const m of members){
    grid.appendChild(memberCard(m));
  }

  body.appendChild(h2);
  body.appendChild(grid);

  const rawCard = document.createElement("section");
  rawCard.className = "card";

  const rawBody = document.createElement("div");
  rawBody.className = "cardBody";

  const d1 = document.createElement("details");
  d1.className = "details";
  const s1 = document.createElement("summary");
  s1.className = "summary";
  s1.textContent = "mdstat";
  const p1 = document.createElement("pre");
  p1.className = "code";
  p1.textContent = globalMdstat || "";
  d1.appendChild(s1);
  d1.appendChild(p1);

  const d2 = document.createElement("details");
  d2.className = "details";
  const s2 = document.createElement("summary");
  s2.className = "summary";
  s2.textContent = "mdadm --detail";
  const p2 = document.createElement("pre");
  p2.className = "code";
  p2.textContent = a.detail || "";
  d2.appendChild(s2);
  d2.appendChild(p2);

  rawBody.appendChild(d1);
  rawBody.appendChild(d2);
  rawCard.appendChild(rawBody);

  card.appendChild(header);
  card.appendChild(body);

  // wrapper koji drzi 2 kartice zaredom kao ranije
  const wrap = document.createElement("div");
  wrap.style.display = "grid";
  wrap.style.gap = "16px";
  wrap.appendChild(card);
  wrap.appendChild(rawCard);

  // sacuvaj iso timestamp za "ago"
  wrap.dataset.iso = a.timestamp || "";

  return wrap;
}

function renderAll(data){
  lastData = data;

  const arrays = Array.isArray(data?.arrays) ? data.arrays : [];
  const globalMdstat = data?.mdstat || "";

  els.arraysRoot.innerHTML = "";

  if(arrays.length === 0){
    const empty = document.createElement("section");
    empty.className = "card";
    const b = document.createElement("div");
    b.className = "cardBody";
    b.textContent = "No mdadm arrays found. Check device mappings in docker-compose.yml.";
    empty.appendChild(b);
    els.arraysRoot.appendChild(empty);
    return;
  }

  for(const a of arrays){
    // dopuni timestamp po array-u: ako ti generator ne salje, koristi global timestamp
    if(!a.timestamp && data.timestamp) a.timestamp = data.timestamp;

    els.arraysRoot.appendChild(arrayCard(a, globalMdstat));
  }

  refreshAges();
}

function refreshAges(){
  const blocks = els.arraysRoot.querySelectorAll("[data-iso]");
  for(const block of blocks){
    const iso = block.dataset.iso;
    const agoEl = block.querySelector(".js-updatedAgo");
    const atEl = block.querySelector(".js-updatedAt");
    if(!agoEl || !atEl) continue;

    if(!iso){
      agoEl.textContent = "-";
      continue;
    }

    agoEl.textContent = timeAgoFromIso(iso);
    // updatedAt se ne menja, ali ako zelis, moze ostati
  }
}

async function fetchStatus(){
  const cacheBust = `t=${Date.now()}`;
  const url = STATUS_URL.includes("?") ? `${STATUS_URL}&${cacheBust}` : `${STATUS_URL}?${cacheBust}`;
  const started = Date.now();

  try{
    const res = await fetch(url, { cache: "no-store" });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderAll(data);
    const ms = Date.now() - started;
    els.lastFetch.textContent = `Fetched in ${ms}ms`;
  }catch(e){
    els.lastFetch.textContent = `Fetch failed: ${e?.message || e}`;
    toast("Fetch failed");
  }
}

function setTheme(mode){
  localStorage.setItem("raidTheme", mode);
  applyTheme();
}

function applyTheme(){
  const saved = localStorage.getItem("raidTheme") || "light";

  if(saved === "dark"){
    document.documentElement.dataset.theme = "dark";
  }else{
    document.documentElement.dataset.theme = "light";
  }

  const activeBtn = (btn, active) => {
    btn.style.borderColor = active
      ? "color-mix(in srgb, var(--info) 40%, var(--btnBorder))"
      : "var(--btnBorder)";
    btn.style.background = active
      ? "color-mix(in srgb, var(--info) 14%, var(--btn))"
      : "transparent";
  };

  activeBtn(els.btnThemeLight, saved === "light");
  activeBtn(els.btnThemeDark, saved === "dark");
}

// els.btnRefresh.addEventListener("click", fetchStatus);
els.btnRefresh?.addEventListener("click", async () => {
  toast("Refreshing...");
  await fetchStatus();
});
els.btnThemeLight.addEventListener("click", () => setTheme("light"));
els.btnThemeDark.addEventListener("click", () => setTheme("dark"));

applyTheme();
fetchStatus();

setInterval(refreshAges, 5000);