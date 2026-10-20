# Getting started

## What you need

- **Node 20+**
- **MySQL 8+ or MariaDB 10.4+**
- A **FlexRadio 6000/8000 series** or a **networked Icom** (see [icom.md](icom.md)) on
  the same network, for the native digital modes. Everything else works with no radio at
  all.

Redis is not needed: nothing queues work.

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
3. **Settings** (top right, admins only) — one sidebar of categories: Station, Radio,
   Modes, Automation, Logbook sync, Spotting & broadcast, QSL & email, System. The search
   box at the top (press `/`) finds any setting by name, key or help text. Each group
   shows its essential settings and folds the rest under **Advanced**; a save bar appears
   once something is changed. At minimum:
   - `digital.source` (Modes → Decode source) — which radio, and there are three answers:
     - `flex` — a FlexRadio over DAX. Set `flex.host`, or leave it blank to discover
       the radio on the network.
     - `icom` — a networked Icom over RS-BA1. Set `icom.host`, `icom.username` and
       `icom.password` from the radio's own Network menu, and read
       [Using a networked Icom](icom.md) first — one menu setting on the radio will
       otherwise cost you an evening.
     - `wsjtx` — decodes from an external program (WSJT-X, JTDX, wsjtx-omega) over its
       UDP protocol.
   - your QRZ/LoTW/eQSL credentials if you want them (Logbook sync)
   - optionally, **System → DX cluster → Connect to a DX cluster** for the Cluster page;
     it is off by default

   You can change radios later without touching Settings or restarting anything — the
   Radio card on the Digital page has a picker, and so does the Rig page's header.
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

1. Arm transmit with the **TX** control in the header (it reads **TX OFF**; an admin
   clicks it and confirms). It is the same per-radio switch as Settings → Radio →
   **Allow transmit** (`flex.allowTransmit` or `icom.allowTransmit` — arming one radio
   arms nothing on the other), and it is re-read before *every* transmission. Clicking
   **TX ARMED** again disarms at once: it halts a contact in progress, pauses any
   automatic mode, and stops a transmission still waiting for its window.
2. Click a decoded callsign on the Digital page to call them.

The QSO runs itself from there: report, roger-report, RR73, logged. Watch it happen
once before turning on any automatic mode.

## Finding your way round

The header groups the pages into **Operate** (Digital, Grid map, Spectrum, DX cluster,
and Rig control once Settings → Station → *Show the experimental Rig page* is on),
**Log** (Logbook, New QSO, QSL, POTA), **Analyze** (Statistics, Awards, Coverage) and
**Tools** (the ham toolkit). **Ctrl+K** (⌘K on a Mac) jumps to any page by name. The
**Night** button beside FT-0 switches this device to a red-on-black theme for a dark
shack. **Help** answers the questions this software actually raises — why it skipped a
station, why nothing transmits, why the waterfall is dark.

## Then

- [Operating](operating.md) — the automatic modes and the brakes that make them safe
- [DXCC reference data](../README.md#dxcc-reference-data) — load `cty.csv` so entities,
  zones and continents resolve on every contact
- [Backup](backup-and-moving.md) — make one before you have anything to lose
