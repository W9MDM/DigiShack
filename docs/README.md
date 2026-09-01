# DigiShack documentation

A self-contained amateur radio logging platform: a full logbook, native FT8/FT4/FT2
decoding and transmitting straight from a FlexRadio, DXCC and award tracking, QSL cards
and email, POTA chasing, and the integrations that connect all of it to the outside
world.

**Self-contained is the point.** No WSJT-X, no external decoder, no cloud service that
has to be up for the station to work. Everything runs on one machine, the log is yours,
and a backup moves the whole installation.

## Start here

| | |
|---|---|
| [Getting started](getting-started.md) | Install it, point it at a radio, make the first contact |
| [Operating](operating.md) | Day-to-day use: logging, hunting, calling CQ, the safety brakes |
| [Digital modes](digital-modes.md) | How FT8, FT4 and FT2 actually work here, and what to do when they do not |
| [POTA](pota.md) | Chasing parks, importing your hunter log, the page |
| [QSL cards and email](qsl.md) | Designing a card, the templates, sending one, sending hundreds |
| [Logbook sync](logbook-sync.md) | Uploads, QRZ's differential download, and what Sent and Rcvd actually mean |
| [Streaming to YouTube](streaming.md) | Putting the waterfall and the receiver audio on YouTube Live |
| [Backup and moving](backup-and-moving.md) | Bundles, restore, and the two traps that break a migration |
| [Settings reference](settings.md) | Every one of the 175 settings, generated from the code |
| [Networked Icom](icom.md) | Driving an IC-7300 or IC-705 over the network, with no bridge software |
| [Architecture](architecture.md) | What runs where, and why the radio is its own process |
| [Icom protocol](icom-protocol.md) | The RS-BA1 wire format, for anyone working on the driver |
| [Troubleshooting](troubleshooting.md) | Symptoms, in the order you are likely to meet them |
| [Development](development.md) | Conventions, the test suite, how to add things |

## The short version

DigiShack is two processes and a database:

- **The web app** (`npm start`) — everything you look at.
- **The radio bridge** (`npm run bridge`) — talks to the FlexRadio, decodes audio,
  runs the automatic operating modes, and keys the transmitter. Separate because it
  binds a UDP socket, and a bound UDP socket cannot be shared across workers.

They talk over a token-guarded HTTP API on localhost and a WebSocket carrying the live
decode feed.

## Conventions used throughout

**Every time is UTC.** Amateur radio runs on UTC and nothing else; a log with local
timestamps does not match LoTW, does not match the other operator, and cannot be
compared with anything. Every timestamp on screen carries a `Z` or the word UTC. If you
ever see one that does not, that is a bug.

**Nothing transmits without being told to.** Automatic modes are off by default,
`flex.allowTransmit` is a master gate re-read before every transmission, and the
[operating guards](operating.md#the-brakes) will stop a run rather than let a station
key unattended into a fault.

**Nothing is hardcoded that an operator might reasonably want to change.** If a piece
of text, a threshold or a frequency matters to how your station behaves, it is in
[Settings](settings.md), not in the source.
