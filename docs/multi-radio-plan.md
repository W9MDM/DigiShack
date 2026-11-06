# DigiShack multi-radio: final implementation plan (from v1.278.0)

> Status: Phase 0 shipped in 1.279.0. Phases 1-5 not started. Produced 2026-11-01 by a judged design panel (process-per-radio won, 30.5 vs 29.5 vs 27.0); every judge-raised fatal flaw is addressed below. Open question 2 (fail closed on a DB outage for a one-radio install) awaits the owner.


**Approach.** This builds on the top-ranked design: one bridge process per radio, a thin supervisor, and database leases. It fixes every fatal flaw the judges raised and borrows the best ideas from the other two designs. I re-checked the key claims against the code:
- `switchStation` (index.ts:3919) writes ActiveStation id 1 and then calls `switchSource(..., {restart:true})`.
- `persistAutoMode` and `persistScheduleApplied` write to `prisma.setting` directly (707, 734), so they bypass the settings layer.
- `schedule.enabled`, `schedule.hours` and `schedule.sleep` are read at 3671–3675.
- The Flex client records `chassis_serial` (lib/flex/client.ts:351), and discovery exposes `serial` (discovery.ts:22, 71).
- `effectiveStationId()` falls back to `homeStationId()` (scope.ts:88).
- The source starts at 3996, before `server.listen` at 6535.

## Core model

- **Main radio.** The existing PM2 app `digishack-bridge` is radio `"main"`. It has no env var, reads today's global keys, uses `bridge.port`, `/ws/decodes`, `/ws/audio` and ActiveStation id 1. It is the only process allowed to run install-wide jobs.
- **Extra radios.** Each extra radio is a `Radio` row, run as a child process (`DIGISHACK_RADIO_ID=<id>`) by a new PM2 app `digishack-radios` (the supervisor). Children are always kind `flex` or `icom`. The external WSJT-X decoder stays main-only because it needs the single UDP 2237 bind.
- **Why per process.** Every module singleton, `exitLatched`, `digitalHold` and the `process.exit` watchdogs become per-radio without rewriting the transmit path.

**Fixed rules (the judges' fatal flaws, each closed):**
1. **Physical identity is checked after connecting, through a hardware claim that also covers main.** Before attaching any transmitter, a process must win the `HardwareClaim` row for the identity it actually reached:
   - Flex: `flex:<chassis_serial>`, read after the TCP connect.
   - Icom: `icom:<resolved IP>:<controlPort>`.

   A loss means it refuses, disconnects and records `lastError`. This also catches a host on one row colliding with a serial on another, and any collision with main's global `flex.host` or `icom.host`. On top of that, once any Flex `Radio` row exists:
   - Main must have `flex.host` or `flex.serial` set.
   - Discovery for every process excludes serials claimed by other rows and never falls back to `found[0]`.
   - Radio CRUD rejects a host or serial equal to main's.
2. **Leases fence themselves.** Each lease is renewed every 5 s with a 30 s TTL. The holder keeps `fenceAt = monotonic time when the renew request was sent + TTL − 10 s`. Past `fenceAt`:
   - `isTransmitArmed` returns false, and the transmitter unkeys.
   - Automation goes to off (in memory only; nothing is persisted).
   - `jobs.held` is set to false.

   A rival may only acquire at `expiresAt + TTL`, so the old holder has always fenced itself first.
3. **There is no same-host dead-pid takeover.** A cloned or restored LXC would defeat it. Instead, every orderly exit path (`exitForRestart`, SIGTERM, IPC disconnect) does a conditional delete of its own lease (`WHERE ownerToken=?`) before exiting, so restarts are immediate. A hard crash waits about 60 s. `ownerToken` is a random value per process start, and hostname and pid are kept for diagnostics only.
4. **Transmit checks the lease and the station.** Each child's identity is pinned at attach time (`pinnedStationId`). The per-key-down gate closure does one uncached read of `Radio.enabled`, `Radio.stationId` and the lease. It refuses if the lease is stale or if `stationId` ≠ pinned, and then schedules a source restart. Auto-log uses the pinned station, never a fresh read. `Radio.stationId` is written only by the owning child's `station` action, and the relation is `onDelete: Restrict`.
5. **Unaddressed requests use an allowlist.** Once any enabled `Radio` row exists, every mutating bridge request, including to main, needs `X-Radio-Id`. Energy-adding actions also need `X-Expected-Station`; otherwise the bridge returns 409. The only actions allowed without a radio id are the energy-removing ones (halt, transmit-gate disarm, auto off, ft0 engage, sstv-stop, js8-cancel), and those fan out to every radio. FT-0 release counts as energy-adding.
6. **In a child, `/source` is refused and the kind is fixed from `Radio.kind`.** `switchStation` calls a new `restartSource()` instead of `switchSource()`.
7. **All radio runtime state is per radio**, including the direct upserts (`auto.resumeMode`, `auto.runStartedAt`, `schedule.lastApplied`, `bridge.noPowerRestartAt` at about 960). They go through a new `writeRadioState()`. Every `schedule.*` key is radio-scoped, and a child's schedule defaults to off.
8. **A child's station-scoped reads resolve to its own station.** `effectiveStationId()` falls back to `processStationId()` (the pinned station), not the home station. This covers the per-child PSKReporter uploader and SSTV stamping (1796), because in a child `activeStation()` returns the pinned station.

## Data model (MySQL, additive and idempotent)

New tables, with no Json columns:
- **`Radio`**: `id` cuid, `name`, `kind` (`flex`|`icom`), `stationId?` (Restrict), `host?`, `flexSerial?`, `port Int @unique` (3102–3116), `enabled @default(false)`, `lastError Text?`, `configVersion Int`, timestamps.
- **`RadioSetting`**: `@@id([radioId, key])`, `value Text`, `encrypted` (for `icom.password`), `onDelete Cascade`.
- **`RadioLease`**: `radioId @id` (`"main"` or a cuid), `ownerToken`, `hostname`, `pid`, `expiresAt`.
- **`JobLease`**: `name @id`, same fields.
- **`HardwareClaim`**: `identity @id`, `radioId`, `ownerToken`, `expiresAt`. Renewed alongside the RadioLease.

Changes to existing tables:
- `Qso.radioId String? @db.VarChar(32)` with `@@index`; null means main.
- `DigitalDecode.radioId`, the same.
- `Station.radios`.

Shipping it:
- `prisma db push` without the accept-data-loss flag. The new `@@unique` constraints sit only on new, empty tables.
- `deploy/sql/1.279-multi-radio.sql` as the guarded fallback: `CREATE TABLE IF NOT EXISTS`, plus `ADD COLUMN` and `CREATE INDEX` wrapped in `information_schema` checks so it can be re-run.
- All lease writes are conditional `updateMany` or `create` calls checked by affected-row count. `GET_LOCK` is never used, because Prisma's pool can hand the next query a different connection.

## Settings storage

- `lib/radio/scope.ts` defines `RADIO_SCOPED`: `flex.*`, `icom.*`, `digital.source`, `digital.mode`, `auto.*` except `dupeWindowHours`, `rtty.*`, `cw.*`, `js8.*`, `sstv.powerPct`, `radio.lastTune`, `schedule.*`, `pskreporter.antenna`, `bridge.noPowerRestartAt`.
- **In main**, a short-circuit runs the existing code byte for byte.
- **In a child** (`processRadioId()`), or in the web under `withRadio(id)` (an AsyncLocalStorage twin of `withStation`), reads go to `RadioSetting`, then the registry default. They never fall back to the global row. `*.allowTransmit`, `schedule.enabled` and `auto.resumeMode` default to false or empty.
- The cache is keyed per radio.
- `PUT /api/settings` refuses radio `*.allowTransmit` and the state keys.
- The CSV file name gets the radio as a suffix.
- Install-wide keys stay global: `bridge.*`, `wsjtx.*`, `digital.passbandHz`, `digital.decodeCsvDir`, `digital.decodeRetentionDays`, `lotw`, `eqsl`, `qsl`, `uploads`, `time`, `youtube`, `pskreporter.enabled`, `pskreporter.upload`.
- "Copy from main" is explicit and excludes gates, secrets, host, serial and state keys.

## Ports and routing

- Main stays on `bridge.port`. Children bind `bridge.bindAddress` on `Radio.port`, which is allocated in a transaction from 3102–3116 and never equal to `bridge.port`.
- nginx gets one new location, `~ ^/ws/p/(310[2-9]|311[0-6])/(decodes|audio)$`, which proxies to `127.0.0.1:$1/ws/$2` with today's header block. Inside the bridge the paths are unchanged, so ws-auth `KNOWN_PATHS` stays as it is.
- `localBridgeSocket` (ws-auth.ts:637) takes a port.
- Web callers go through `lib/bridge/target.ts`:
  - `resolveBridge(id)`: an unknown or disabled id returns 404, with no fallback to main.
  - `bridgeFetch()`: always sends the token, `X-Radio-Id` and, where given, `X-Expected-Station`.
  - `mainBridge()`: for install-wide status.
- The bridge returns 409 when `X-Radio-Id` ≠ `processRadioId()`.
- The `/status` reply and the WebSocket hello carry `radioId`, and the client refuses a mismatch.

## Install-wide jobs

There are two guards:
1. **Structural.** The section-5 block runs only `if (isMainRadio())`: cluster, auto-QSL, LoTW sync and reconcile, eQSL, inbound QSL, uploads, PSKReporter collect, prune, ft8br, YouTube panels. The bridge-token self-provisioning is main-only as well.
2. **`JobLease("install-jobs")`** with self-fencing. Every tick returns early unless `jobs.held`, and `forEachStation` loops and upload batches re-check `held` between iterations.

The cluster and PSKReporter collection keep reading `activeStation()`, which in main is still ActiveStation. Web-side readers of ActiveStation (shift, pota, psk-spots, stats, qso-map, the sstv/log fallback) keep meaning "main's station", and that is documented.

## Phases

### Phase 0: harden the single radio (v1.279.0)
**Changes**
- `startFlexSource`: when `flex.host` is empty and more than one radio is discovered, throw an error that names each serial.
- `lib/radio/identity.ts`.
- `radioId:"main"` in `/status` and the hellos.
- An optional `X-Radio-Id` header: absent or `"main"` proceeds, anything else returns 409.
- `writeRadioState()` wraps the direct upserts. In main it writes the same key.

**Files:** services/radio/index.ts (2131–2145, 698–740, ~960, dispatcher, hellos), lib/radio/identity.ts, package.json.

**New checks**
- `check:flex-discovery`: a fake discovery returning 0, 1 or 2 radios.
- `check:radio-state-writes`: greps for `prisma.setting.(upsert|update|create)` under services/radio and fails on any hit outside `writeRadioState`.

**Must pass:** tsc, check:flex-wiring, check:flex-greeting, check:bridge-control, check:transmit-gate, check:operating, check:watchdog, check:schedule, check:automation-gate.

### Phase 1: leases, hardware claim, self-fencing (main only)
**Changes**
- `lib/radio/lease.ts`: acquire, renew, fence and release, with time and store injected so it can be tested.
- Acquire `RadioLease("main")` at the top of `main()`, before line 3996. Losing it exits before the radio is touched.
- Claim the `HardwareClaim` after connecting and before the transmitter attaches.
- `exitForRestart`, SIGTERM and shutdown release the leases.
- `transmitArmed()` (498) and `transmitGate` closures AND in `leaseFresh()`.
- Install-wide ticks are gated on `jobs.held`.
- `/status` shows `jobsLeader`.

**Files:** prisma/schema.prisma (the lease and claim tables), lib/radio/lease.ts, services/radio/index.ts (main top, 2585/2630 wrappers, section-5 ticks, shutdown ~7040), icom-source.ts (324/335 via an injected `leaseFresh` dependency).

**New checks**
- `check:radio-lease`. It covers:
  - two contenders, one holder;
  - a stale renew past `fenceAt` disarms and drops `held`;
  - a rival cannot acquire before `expiresAt + TTL`;
  - an orderly exit releases, so a restart is immediate;
  - a foreign owner triggers the exit callback.
- `check:hardware-claim`: the same serial from host-row versus serial-row loses, and main versus a child loses.

**Verify on a dev DB:** a second bridge exits without connecting; a `kill -9` restart takes over within about 60 s.

**Must pass:** check:job-visibility, check:upload-state, check:cluster, check:pskreporter, check:qsl-inbound, check:lotw-upload.

### Phase 2: Radio rows, scoped settings and child mode (child started by hand)
**Changes**
- Schema: `Radio`, `RadioSetting`, `Qso.radioId`, `DigitalDecode.radioId`.
- lib/settings and lib/radio/scope.ts routing.
- `activeStation()`, `effectiveStationId()` and `processStationId()` resolve through the radio in a child.
- Child branches in index.ts:
  - kind fixed from `Radio.kind`, and `/source` refused;
  - no WSJT-X UDP bind;
  - token read-only;
  - jobs skipped;
  - alert keys prefixed `radio:<id>:` (guard-alerts.ts);
  - CSV suffix;
  - listen on `Radio.port`;
  - serial-pinned discovery;
  - station pin and fence;
  - `restartSource()`.
- `switchStation` in a child writes `Radio.stationId`. It is refused while armed or transmitting.
- In main: once Flex rows exist, `flex.host` or `flex.serial` is required, and claimed serials are excluded.
- `radioId` is stamped at 1116 and at the `qso.create` sites.
- The supervisor builds its own RSS limit in Phase 4, because `max_memory_restart` covers only the PM2 app.

**New check:** `check:radio-scope`. It covers:
- with the env var unset, a snapshot of every registry key matches;
- in a child, `flex.allowTransmit` is false even when the global value is true;
- no leak between radios;
- `activeStation()` returns null when no station is set;
- `schedule.enabled` defaults false;
- `writeRadioState` targets `RadioSetting`.

**Extend:**
- check:station-scope (child fallback goes to the pinned station);
- check:transmit-gate (arming one child leaves another false; a station mismatch refuses).

**Bench test:** a second radio on a dummy load reaches the right radio, logs no LoTW or upload ticks, and stays unarmed when main is armed.

### Phase 3: the web addresses a radio
**Changes**
- `lib/bridge/target.ts`. Convert:
  - per radio: control.ts (copy `radio` into the payloads rebuilt at 164–171), gate.ts, status.ts, sstv/send.ts, bridge-client.ts (v1/radio/*, digital/broadcast, settings stopAutomation);
  - main only: cluster/spots, integrations/status, psk-spots, qsl/queue, qsl/received, uploads;
  - health.ts: main plus each enabled radio, no longer reading `process.env.BRIDGE_PORT`.
- Apply the allowlist and `X-Expected-Station` rules on the bridge.

**New check:** `check:bridge-target`. It covers 404s, the headers, the payload copy, and a grep that nothing outside target.ts and ws-url.ts reads `bridge.port`.

**Extend:** check:bridge-control (unaddressed CQ returns 409 when there are several radios; unaddressed halt fans out; FT-0 release returns 409), check:radio-api.

### Phase 4: supervisor, PM2, nginx, sockets
**Changes**
- `services/radio/supervisor.ts`:
  - polls every 15 s and restarts a child when `configVersion` changes;
  - forks `process.execPath` with the tsx `cli.mjs` and IPC;
  - logs to `logs/radio-<id>-*.log`;
  - backoff, then gives up after 10 restarts in 10 minutes and writes `lastError`;
  - RSS limit of 256 MB;
  - shutdown over IPC, then SIGKILL after 8 s;
  - children exit through the unkey and release path on IPC disconnect.
- ecosystem.config.js gains the `digishack-radios` app (kill_timeout 12000).
- nginx regex location.
- `bridgeWsUrl(headers, radioId)`, plus use-receiver-audio and the 5 pages checking the hello.
- healthcheck.sh, install.sh and update.sh. A deploy restarts every child, and that is documented.

**New check:** `check:supervisor` with a fake fork.

**Extend:**
- check:install-scripts: the nginx range equals the allocator range;
- check:ws-auth;
- check:receiver-listen;
- check:socket-retry.

**Bench test:** a watchdog on a child restarts only that child; main's gate is unchanged.

### Phase 5: UI
**Changes**
- Settings › Radios (ADMIN):
  - CRUD;
  - discovery picker;
  - surfaced uniqueness and claim errors;
  - per-radio tabs under `withRadio`;
  - "copy from main";
  - station assignment through the bridge `station` action.
- A per-viewer radio picker (`?radio=` plus localStorage) on rig, decodes, spectrum, gridmap and cluster. The radio's tag letter and the callsign appear on every Call, CQ, Tune and Arm button.
- A per-radio gate strip. The arm dialog names the radio, host and callsign, and is confirmed from the bridge's echo.
- HALT ALL and DISARM ALL (OPERATOR).
- Radio column in the logbook, and a decode filter.

**Must pass:** check:page-auth, check:transmit-gate-banner, check:nav, check:settings-tabs, check:help, check:docs.

**Bench test:** two radios as K9XYZ and K9PC. Each Qso carries the right `stationId` and `radioId`, and main's sweep uploads each one with the right accounts.

## A one-radio install

With zero `Radio` rows, the supervisor idles and main runs today's code paths on the same keys, port, sockets, nginx locations and timers. The new columns stay null. The deliberate differences:
1. `radioId` and `jobsLeader` appear in `/status`.
2. Ambiguous Flex discovery is refused instead of picked at random.
3. A second bridge on the same DB cannot connect to the radio or run sweeps.
4. Transmit is refused once the bridge has been unable to renew its lease against MySQL for more than about 20 s.

## Open questions

1. **Icom identity beyond IP and port.** If the RS-BA1 login reply exposes a radio name or MAC, the Icom claim should use it. Ship with IP and controlPort until someone checks lib/icom/control-packets.ts.
2. **Is failing closed during a DB outage on a one-radio install acceptable?** If not, the lease fence can be applied only when `Radio` rows exist. The cost is losing the "second main" transmit fence.