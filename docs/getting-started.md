# Getting started

## What you need

- **Node 20+**
- **MySQL 8+ or MariaDB 10.4+**
- **Redis** — only for background queues; the logbook and the radio work without it
- A **FlexRadio 6000/8000 series** on the same network, for the native digital modes.
  Everything else works with no radio at all.

Windows, Linux and macOS all work. Most of this was developed on Windows against a
FLEX-6400.

## Install

**On Proxmox?** [`deploy/proxmox/digishack-lxc.sh`](../deploy/proxmox/digishack-lxc.sh),
run on the Proxmox host, does everything below in a container for you — and prints the two
container-specific gotchas (the host's clock, and multicast discovery) when it finishes.

Create the database first:

```sql
CREATE DATABASE digishack CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'digishack'@'localhost' IDENTIFIED BY 'a-real-password';
GRANT ALL PRIVILEGES ON digishack.* TO 'digishack'@'localhost';
FLUSH PRIVILEGES;
```

> **On Linux, decide about table-name case now.** MySQL and MariaDB on Windows fold
> table names to lower case and Linux does not, and it cannot be changed after the
> database exists. It only matters if you ever restore a backup made on Windows — see
> [Backup and moving](backup-and-moving.md#the-linux-trap). Setting
> `lower_case_table_names=1` before creating the database saves the trouble later.

Then:

```bash
./scripts/install.sh
```

It writes `.env`, generates `SETTINGS_KEY`, installs dependencies, migrates, builds and
starts PM2. It is safe to re-run, and it stops and tells you if `DATABASE_URL` is still
the example value.

Manual equivalent and production notes are in the [main README](../README.md#setup).

## First run

1. Open the app. The **setup wizard** creates the first admin account. There is no
   default password — an installation without an account cannot be logged into, which
   is the correct failure.
2. **Stations** — add your callsign and grid. Everything else keys off this.
3. **Settings** — at minimum:
   - `digital.source` — which radio, and there are three answers:
     - `flex` — a FlexRadio over DAX. Set `flex.host`, or leave it blank to discover
       the radio on the network.
     - `icom` — a networked Icom over RS-BA1. Set `icom.host`, `icom.username` and
       `icom.password` from the radio's own Network menu, and read
       [Using a networked Icom](icom.md) first — one menu setting on the radio will
       otherwise cost you an evening.
     - `wsjtx` — decodes from an external program (WSJT-X, JTDX, wsjtx-omega) over its
       UDP protocol.
   - your QRZ/LoTW/eQSL credentials if you want them

   You can change radios later from the Digital page without touching Settings or
   restarting anything — the Radio box has a picker.
4. Start the radio bridge. For anything other than development, run it supervised —
   it should come back after a crash, a reboot, or the terminal closing:
   ```bash
   npx pm2 start ecosystem.config.js
   npx pm2 save
   ```
   `npm run bridge` runs it in the foreground, which is what you want while
   developing and not what you want overnight: it exits with the shell that
   started it.
   It connects to the radio, attaches to its audio, and starts decoding. Watch the
   **Digital** page — decodes should appear within a cycle or two.

## Your first contact

**Receiving** proves the audio path: the Digital page fills with decodes and the band
strip populates. If it stays empty, go to
[Troubleshooting](troubleshooting.md#no-decodes).

**Transmitting** is deliberately behind two doors:

1. Set `flex.allowTransmit` = on in Settings. This is the master gate and it is
   re-read before *every* transmission, so turning it off stops the station
   immediately — no restart.
2. Click a decoded callsign on the Digital page to call them.

The QSO runs itself from there: report, roger-report, RR73, logged. Watch it happen
once before turning on any automatic mode.

## Then

- [Operating](operating.md) — the automatic modes and the brakes that make them safe
- [DXCC reference data](../README.md#dxcc-reference-data) — load `cty.csv` so entities,
  zones and continents resolve on every contact
- [Backup](backup-and-moving.md) — make one before you have anything to lose
