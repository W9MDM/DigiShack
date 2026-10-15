# Radio API

Three routes under `/api/v1/radio` let a program that is not a browser read and move the
receiver DigiShack is driving — written for a knob on the desk (an M5Stack Dial and its
worker on the PC), usable by anything that can speak HTTP with an API key.

```text
knob -> worker on the PC -> /api/v1/radio -> the radio service (bridge) -> the radio
```

The worker never talks to the radio. DigiShack's radio service owns the one connection to
it, and this API is a door into that service, not a second connection beside it.

## Authentication

An API key, created by an admin under **API keys**, sent as `Authorization: Bearer dsk_…` or
`X-API-Key: dsk_…`. `GET` routes need VIEWER; `POST /commands` needs OPERATOR. A key can hold
either role and never ADMIN. Revoking the key stops it on the next request.

## `GET /api/v1/radio/state`

The receiver as the radio service sees it right now. Poll it; a few times a second is fine.

```json
{
  "api": 1,
  "at": "2026-10-14T20:12:33.410Z",
  "bridge": { "running": true, "reason": null },
  "connection": {
    "connected": true,
    "source": "flex",
    "radio": { "vendor": "flex", "model": "FLEX-6400" },
    "lastHeartbeat": "2026-10-14T20:12:33.102Z",
    "linkRttMs": 17
  },
  "receiver": {
    "frequencyHz": 7074000,
    "band": "40M",
    "modulation": "USB-D",
    "digitalMode": "FT8",
    "filterLoHz": 100, "filterHiHz": 3100,
    "agc": "med", "nb": false, "nr": null,
    "rxAntenna": "ANT1", "txAntenna": "ANT1"
  },
  "transmitter": { "transmitting": false, "armed": true, "rfPowerPercent": 90 },
  "qso": { "active": false, "theirCall": null, "state": null },
  "automation": { "mode": "hunt", "lastAction": "hunting VE9ZK (-15 dB)" },
  "voice": { "active": false, "mode": null },
  "ft0": false,
  "locks": [
    { "reason": "auto", "detail": "The automatic operator is running (hunt)" }
  ]
}
```

- **`modulation`** is what the radio demodulates (`USB-D`, `USB`, `CW`…). **`digitalMode`**
  is what DigiShack is operating (`FT8`, `FT4`, `FT2`), and is null in voice mode. They are
  different things and are never folded into one field.
- **`null` means the radio has not said.** It is never a default. A dial shows a blank, not
  a number it invented.
- **`locks`** are the reasons a command would be refused *now*. Show them before the knob is
  turned. The names are fixed: `qso`, `auto`, `transmitting`, `ft0`.
- **Staleness** is yours to judge from `at` (when this snapshot was taken) and
  `connection.lastHeartbeat` (when the radio last spoke). There is no revision counter in
  this version; a command's response carries the state after it, which is the confirmation.
- There is **one receiver**, the one the service drives. Nothing here implies a second.

## `GET /api/v1/radio/capabilities`

What the active radio accepts. Read it when you connect and again when `connection.source`
changes.

```json
{
  "api": 1,
  "target": { "source": "flex", "radio": { "vendor": "flex", "model": "FLEX-6400" }, "label": "the FlexRadio" },
  "receivers": ["active"],
  "commands": ["tune-relative", "set-frequency", "set-modulation", "stop-automation"],
  "tuning": { "lowHz": 30000, "highHz": 54000000, "maxDeltaHz": 1000000, "unit": "Hz" },
  "modulations": ["USB", "LSB", "USB-D", "LSB-D", "CW", "AM", "FM", "RTTY"],
  "agc": ["off", "slow", "med", "fast"],
  "filterEdgesHz": true,
  "notes": []
}
```

## `POST /api/v1/radio/commands`

One command per request. Every command carries an **`id` you chose** (up to 64 characters);
if the response is lost and you send the same id again, you get the first outcome back and
the command is **not applied twice**. That is the difference between a knob that nudged
once and one that nudged twice — generate a fresh id per intended move.

```json
{ "id": "k-0001", "command": "tune-relative", "deltaHz": 100 }
{ "id": "k-0002", "command": "set-frequency", "frequencyHz": 14074000 }
{ "id": "k-0003", "command": "set-modulation", "modulation": "USB" }
{ "id": "k-0004", "command": "stop-automation" }
```

Rules: `deltaHz` is a non-zero integer within ±`tuning.maxDeltaHz`; `frequencyHz` is an
integer within the radio's range; `modulation` is one of `capabilities.modulations`; a
command takes exactly the field it needs and no others. Anything else is `400` with the
field named.

The response is the outcome plus the state **after** the command — render that frequency,
not the one you asked for:

```json
{ "id": "k-0001", "command": "tune-relative", "status": "accepted", "bridge": { "ok": true, "results": [...] }, "state": { ... } }
```

| HTTP | `status`    | Meaning                                                              |
|------|-------------|----------------------------------------------------------------------|
| 200  | `accepted`  | The radio took it. `state` is the receiver afterwards.               |
| 409  | `rejected`  | Refused. `reason` says why; `locks` lists them when that is why.      |
| 200  | `duplicate` | This `id` was already answered; the first outcome is repeated.       |
| 400  | —           | The request did not parse; `details` names the field.                |

### Locks

A contact in progress, an automatic mode, a transmission or FT-0 **owns the receiver**, and
a knob does not take it from them. The radio service decides this at the moment of the
command, not the worker from a copy of the state, so the two cannot disagree about whether
the receiver was free. `stop-automation` is the one command allowed through a lock, because
it is how the `auto` lock is lifted; it does not end a contact or clear anything else.

### What is deliberately not here

- Nothing that keys the transmitter. No tune carrier, no calling, no power.
- No second receiver or slice. `receivers` is `["active"]` so a later version can add one
  without a client assuming this one was ever more.
- No push stream. Poll `state`; the decode WebSocket is not a contract.

## Relative tuning lives in the radio service

`tune-relative` is added to the frequency the service is reporting *inside the service*,
where the current value is authoritative, rather than in the web tier against a copy. Two
deltas in flight add up correctly; a worker that coalesces encoder ticks should still send
one command at a time and wait for its answer.

## Trying it

```sh
curl -s -H "Authorization: Bearer dsk_…" https://your-digishack/api/v1/radio/state
curl -s -H "Authorization: Bearer dsk_…" -H "Content-Type: application/json" \
     -d '{"id":"t1","command":"tune-relative","deltaHz":1000}' \
     https://your-digishack/api/v1/radio/commands
```

The rule in `lib/radio/api.ts`, the reducer, the command schema and the idempotency store
are asserted in `scripts/check-radio-api.ts`, so the contract here and the code agree.
