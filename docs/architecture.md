# Architecture

## Processes

```
┌─────────────────┐         ┌──────────────────────────┐
│  Next.js app    │  HTTP   │  Radio bridge            │
│  (npm start)    │◄───────►│  (npm run bridge)        │
│                 │  :3101  │                          │
│  pages + API    │         │  FlexClient  TCP :4992   │──► FlexRadio
└────────┬────────┘         │  DAX audio   UDP :4991   │◄──
         │                  │  Icom RS-BA1  UDP        │◄─► networked Icom
 browser ◄── WS /ws/decodes │  DX cluster   telnet     │──► cluster node
         ◄── WS /ws/audio ──│  decoders / QSO / auto   │
         │                  └────────────┬─────────────┘
         │                               │
         └──────────► MySQL ◄────────────┘
```

**Why two processes.** The bridge binds a UDP socket for DAX audio, and a bound UDP
socket cannot be shared across cluster workers. Keeping it separate is what lets the
web tier scale, and it means a Next.js rebuild does not drop the radio.

They talk over HTTP on `127.0.0.1:3101`, guarded by `bridge.token`. Browsers reach the
bridge only through its two WebSockets, which nginx proxies onto the app's own origin. The
bridge listens on loopback unless `bridge.bindAddress` says otherwise.

### The bridge's HTTP API

Served on `bridge.port` (3101). Never proxied by nginx; the web tier calls it from
`pages/api/bridge/*` and `pages/api/cluster/spots.ts`, attaching the token server-side so
it never reaches a browser.

| Endpoint | Auth | |
|---|---|---|
| `GET /status` | none | The whole station picture: status, recent decodes, QSO and auto state, telemetry, stream, clock, memory. Read through `/api/bridge/status`, and trimmed to the header's few fields by `/api/bridge/gate` (`lib/radio/station-gate.ts`), which every page polls every 4 s for the TX control and FT-0 |
| `GET /cluster/spots` | token | The last 500 DX cluster spots and the link state. Behind the token because it carries the login callsign and what the log still needs. Proxied at `/api/cluster/spots` |
| `POST /transmit-gate` `{armed, actorId?}` | token | Arm or disarm the active radio's gate (`flex.allowTransmit` / `icom.allowTransmit`), written by the bridge so it takes effect at once. Disarming halts the contact in flight (or unkeys), pauses auto and remembers the mode; arming resumes that mode and nothing else. 409 while FT-0 is engaged. Reached through `/api/bridge/control` action `transmit-gate`, which requires ADMIN to arm and OPERATOR to disarm |
| `POST` `/ft0`, `/auto`, `/call`, `/qso-halt`, `/qso-skip`, `/rearm`, `/halt`, `/reply`, `/free-text`, `/tune`, `/rig`, `/power`, `/atu`, `/voice`, `/source`, `/restart`, `/time/sync`, `/stream`, … and the per-mode send endpoints (`/rtty-send`, `/cw`, `/psk`, `/olivia`, `/hell`, `/jtty`, `/js8-send`, `/sstv-send`, …) | token | The control API. Each of these can key, retune or reconfigure the radio, which is why none is reachable from outside the box |

`services/radio/index.ts` is the definitive list: grep it for `url.pathname ===` and
`case "/`.

### The WebSockets, and who may open them

`/ws/decodes` carries status, QSO and auto state, every decode, spectrum and panadapter
frames and cluster spots (`spot`); `/ws/audio` carries receiver audio. Any other path is
dropped. Since 1.222.0 every upgrade is judged by `createWsGate()` in
[`lib/bridge/ws-auth.ts`](../lib/bridge/ws-auth.ts) before a socket exists:

1. **Origin**, when present, must name the request's `Host` (or `X-Forwarded-Host`) — 403
   otherwise. Ports are not compared.
2. **A signed-in session**: the `digishack_session` cookie a browser already sends on a
   same-origin handshake, checked the way `getAuth()` checks it (hash, expiry, active user,
   role at least VIEWER). Lookups are cached for 10 s, and open session sockets are
   re-checked every 2 minutes and closed when the session has ended.
3. **Or the bridge token** (`X-Bridge-Token` header, or `?token=`), honoured **only** on a
   direct loopback connection carrying none of the headers a proxy adds (`X-Real-IP`,
   `X-Forwarded-*`, `CF-Connecting-IP`, `CF-Ray`). Through a proxy it is refused even when
   correct.

Anything else is 401. Anonymous loopback is deliberately **not** admitted — nginx and
cloudflared both connect from loopback, so trusting the address would trust every visitor
they forward. A script on the box opens the socket with
`localBridgeSocket("/ws/audio")` (same module), which reads `bridge.token` from settings
and sends it as the header; it refuses to send the token to any host but loopback. A
custom proxy must route both paths, pass `Host`, and strip a client-sent `X-Bridge-Token`
as `deploy/nginx/digishack.conf` does — see the
[README](../README.md#production). `check:ws-auth` covers the scheme against a real HTTP
server and the shipped nginx file.

`lib/bridge/ws-url.ts` decides which URL a page should open (`bridge.wsUrl`, else the
bridge port on the page's host).

### One bridge, three sources

The bridge drives one of three things, chosen by `digital.source` and switchable at
runtime from the Digital page without restarting anything:

| | Transport | Decoding |
|---|---|---|
| `flex` | SmartSDR API + DAX over VITA-49 | in-process |
| `icom` | RS-BA1: control, CI-V and audio over UDP | in-process |
| `wsjtx` | WSJT-X UDP protocol from an external decoder | by that program |

**Everything above the audio is shared.** The window scheduler, the FT8/FT4/FT2 decoders,
the waveform generator, the QSO sequencer, the operating guards, the award ranking and the
logging are one implementation (`services/radio/operating.ts`, `lib/radio/`), and none of
it knows which radio it is talking to. What differs per radio is how you open a connection,
the audio transport, and two functions for moving the dial.

**Rig control belongs to the bridge**, not the web tier. The band buttons, power, ATU and
the CAT panel all post to the bridge's control API, which applies them to whichever radio
is live. Two page-level routes used to open their own connection to a FlexRadio from
Next.js; they are gone, because a second thing that thinks it owns the radio is a trap
rather than a feature.

## Layout

| Path | |
|---|---|
| `pages/` | Pages Router. **No `app/` directory — do not add one.** |
| `pages/api/` | REST API, one file per resource |
| `components/` | UI, grouped by feature (`layout/` holds the shell: `NavConfig.ts` menus, `CommandPalette`, `TxArmButton`, `Ft0Button`) |
| `lib/` | Everything with logic in it, and where the tests point |
| `lib/digital/` | Mode-independent DSP, message packing, the QSO state machine |
| `lib/radio/` | Shared by both radios: decode pipeline and workers, timing, the transmit gate, `station-gate.ts` (the header's TX view) |
| `lib/flex/` `lib/icom/` | SmartSDR client, DAX receive and transmit, discovery; RS-BA1 and CI-V |
| `lib/bridge/` | `ws-auth.ts` (who may open the bridge's sockets, and `localBridgeSocket`), `ws-url.ts` |
| `lib/cluster/` | DX cluster: telnet client and login, spot parser, dedupe, mode guess, DXCC entity, "needed" slots |
| `lib/spectrum/` | The Spectrum page: frame decoding, history textures, colormaps, camera, preferences |
| `lib/maps/` `lib/geo/` | Canvas map drawing, projection, greyline; distance (import-free, browser-safe) and land outlines |
| `lib/ham/` | Bands, band plan, modes, grid geometry; `ham/tools/` is the toolkit's maths |
| `lib/settings/` | The registry, categories (`tabs.ts`), search, encrypted storage |
| `lib/dxcc/` | cty.xml (Club Log) and cty.csv (AD1C) parsing, callsign → entity resolution |
| `lib/qsl/` | Card rendering, templates, the email queue |
| `lib/pota/` | Spots, profile, logbook import, reference matching |
| `lib/db/` | Prisma client, backup, restore, tar |
| `services/radio/` | The bridge process: supervisor, QSO controller, auto-operator |
| `scripts/check-*.ts` | The test suite. `npm run check` runs all of them. |
| `prisma/` | Schema and migrations |

## Design rules

**Pure logic separates from I/O.** The DSP, the message packing, the DXCC resolver, the
POTA matcher and the tar codec are all pure functions in `lib/`, which is why they can
be tested exhaustively without a radio or a database. The parts that talk to hardware
are thin.

**Settings, not constants.** If a threshold, a piece of text or a frequency affects how
a station behaves, it belongs in `lib/settings/registry.ts` and therefore in the UI.
`docs/settings.md` is generated from that array, so the documentation cannot drift from
what the page renders.

**Fail soft on the network, hard on the data.** Anything reaching outside — POTA,
PSKReporter, QRZ, solar indices — is cached, collapses concurrent requests, and returns
null rather than throwing. A volunteer-run API having a bad afternoon must not break a
page. Anything touching the log does the opposite: a park reference that cannot be
matched with confidence is reported, never guessed.

**Two representations of one fact need one writer.** Where a denormalised copy is
unavoidable — `Qso.sigInfo` mirroring the primary `QsoSigRef` because ADIF needs a
single value — exactly one function maintains both, and a check asserts across the whole
database that they never disagree.

## Data model notes

- **`Qso`** carries the ADIF award fields directly (`state`, `cqZone`, `iota`,
  `continent`) because each is the key to an award that cannot be derived from anything
  else present.
- **`QsoSigRef`** holds park/summit references, one row per reference, because one
  contact can be several parks at once. See [POTA](pota.md#n-fers).
- **`Setting`** values are encrypted when the registry marks them secret. The key is
  `SETTINGS_KEY` in `.env` and never in the database — see
  [Backup](backup-and-moving.md#the-settings-key).
- **`DigitalDecode`** grows fast — tens of thousands of rows a day on a busy band. It is
  indexed for the band-activity queries and is the largest table in a backup after the
  log itself.

## Testing

There is no test framework. Each `scripts/check-*.ts` is a standalone script that
prints `ok`/`FAIL` lines and exits non-zero on failure, and `npm run check` chains them
behind `tsc --noEmit`.

The reason is that the hard problems here are numerical and protocol-shaped — LDPC
decoding, tar checksums, callsign prefix matching, SQL literal escaping — and what those
need is a lot of assertions with the reasoning written next to them, not fixtures and
mocks.

About 150 scripts in `npm run check`, across DSP, ADIF, DXCC, QSL, POTA, time, backup,
the auto-operator, transmit cancellation, socket auth, the navigation and the docs.
See [Development](development.md).
