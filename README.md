<p align="center">
  <a href="https://github.com/nesha14586/mdstat-ui">
  <img width="250" alt="mdstat-ui logo" src="assets/logo.svg">
  </a>
</p>

# mdstat-ui

![Docker](https://img.shields.io/badge/docker-ready-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-linux-lightgrey)
![RAID](https://img.shields.io/badge/mdadm-supported-orange)

A lightweight, self-hosted status page for Linux `mdadm` RAID arrays.

It periodically reads:

-   `/proc/mdstat`
-   `mdadm --detail`
-   `smartctl` (for serial numbers and WWN)

and generates a static `status.json` file served by Nginx.

Designed for homelabs and small servers where you want a clean overview
of array health without installing a full monitoring stack.

> NOTE: This is a Work-in-Progress project built for personal use.

------------------------------------------------------------------------

![mdadm RAID Status UI Preview](assets/dashboard.png)

## Features

-   RAID state overview (clean, degraded, failed)
-   Supports multiple RAID arrays
-   Active / degraded / failed device counters
-   Per-disk state
-   Disk serial numbers
-   WWN display
-   Raw `mdstat` and `mdadm --detail` output
-   Dark / Light UI
-   Fully containerized
-   No privileged container required

------------------------------------------------------------------------

## Architecture

    +------------------+        +------------------+
    |  raid-status-gen | -----> |  status.json     |
    |  (generator)     |        |  (shared volume) |
    +------------------+        +------------------+
                                           |
                                           v
                                 +------------------+
                                 |  raid-status-web |
                                 |  (nginx static)  |
                                 +------------------+

-   The generator container periodically writes `status.json`
-   The web container serves static files only
-   No database required

------------------------------------------------------------------------

## Requirements

-   Linux host using `mdadm`
-   Docker + Docker Compose
-   Access to RAID devices (`/dev/mdX` and member disks)

------------------------------------------------------------------------

## Quick Start

``` bash
git clone https://github.com/nesha14586/mdstat-ui.git
cd mdstat-ui
cp docker-compose.example.yml docker-compose.yml
# edit docker-compose.yml and set your /dev/mdX and disks
docker compose up -d --build
```

Open:

http://localhost:8099

------------------------------------------------------------------------

## Configuration

The generator uses generator/config.json to control array filtering and labels.

``` json
{
  "include_arrays": [],
  "exclude_arrays": [],
  "labels": {
    "/dev/md0": "Storage Array"
  }
}
```

Fields:

-   `include_arrays` If not empty, only listed arrays will be processed.
-   `exclude_arrays` Arrays listed here will be ignored.
-   `labels` Allows custom display names for arrays in the UI.

If both `include_arrays` and `exclude_arrays` are empty, all detected arrays will be shown.

------------------------------------------------------------------------

## File permissions

The generator container writes `status.json` to the shared volume.
Make sure the project directory is writable by Docker.

## Security Model

This project does NOT use `privileged: true`.

It uses:

-   Explicit device mapping
-   `cap_drop: ALL`
-   `cap_add: SYS_RAWIO` for SMART access
-   `no-new-privileges`
-   Read-only container filesystem
-   `tmpfs` for temporary files

If SMART data is not needed, remove `SYS_RAWIO` and disk device mappings
and keep only `/dev/md0`.

------------------------------------------------------------------------

## Hardened Example docker-compose

``` yaml
services:
  raid-status-gen:
    build: ./generator
    restart: unless-stopped
    environment:
      - OUT=/data/status.json
      - INTERVAL=30
      - CONF=/app/config.json
    volumes:
      - ./web:/data
      - /run/udev:/run/udev:ro
      - ./generator/config.json:/app/config.json:ro
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - SYS_RAWIO
    devices:
      - /dev/md0:/dev/md0
      - /dev/sda:/dev/sda
      - /dev/sdb:/dev/sdb

  raid-status-web:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8099:80"
    volumes:
      - ./web:/usr/share/nginx/html:ro
```

------------------------------------------------------------------------

## Roadmap

-   TBA

------------------------------------------------------------------------

## License

MIT
