# DigiShack documentation

A self-contained amateur radio logging platform: a full logbook, native FT8/FT4/FT2
decoding and transmitting straight from a FlexRadio or a networked Icom, DXCC and award tracking, QSL cards
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
| [Settings reference](settings.md) | Every setting, generated from the code |
| [Networked Icom](icom.md) | Driving an IC-7300 or IC-705 over the network, with no bridge software |
| [Architecture](architecture.md) | What runs where, and why the radio is its own process |
| [Radio API](radio-api.md) | Driving the active receiver from a dial or other controller through /api/v1/radio |
| [WSPR](wspr.md) | Listening to WSPR beacons, and reporting what is heard to wsprnet |
| [RTTY](rtty.md) | RTTY: listening, the tones and the sideband, and sending a line |
| [CW](cw.md) | CW: a best-effort decoder on the radio's pitch, and sending through its keyer |
| [JS8](js8.md) | JS8: heartbeats, directed messages and chat, listening and sending |
| [PSK31](psk31.md) | PSK31: a decoder with AFC and a squelch on the stream pipeline, and sending |
| [Olivia](olivia.md) | Olivia: the MFSK keyboard mode with its block code, on the stream pipeline, and sending |
| [SSTV](sstv.md) | SSTV: receiving pictures in nine modes, live on the page, saved to a gallery |
| [Hell](hell.md) | Hellschreiber in six modes (Feld, FM Hell-105 and -245, Hell 80, Slow, PSK), painted live as a scrolling tape, the North American nets, and sending |
| [Text-mode exchange and log](text-mode-log.md) | F1-F8 lines with the calls filled in, and logging RTTY, CW, PSK, Olivia and Hell with their proper ADIF modes |
| [RSID](rsid.md) | Hearing fldigi's mode identifier and switching to the mode and frequency it names, and sending one before each line |
| [NAVTEX](navtex.md) | NAVTEX and SITOR-B: the marine broadcasts on 518 and 490 kHz, listen-only |
| [IFKP](ifkp.md) | IFKP 0.5 to 2: the 33-tone IFK mode |
| [FSQ](fsq.md) | FSQ 1.5 to 6: slow, weak-signal chat with the callsign heading each over |
| [Throb](throb.md) | Throb and ThrobX 1, 2 and 4: slow tone pairs that copy far below the noise |
| [Thor](thor.md) | Thor 4 to 22 and the fast Thor modes: DominoEX's tones with error correction |
| [PSK speeds and QPSK](psk.md) | BPSK31 to BPSK500 and QPSK31 to 125: what each is for, and QPSK's error correction |
| [MT63](mt63.md) | MT63-500 to 2000, short and long: the NBEMS and ARES net mode |
| [MFSK](mfsk.md) | MFSK8 to MFSK32: tones with error correction and an interleaver, for weak and fading paths |
| [DominoEX](dominoex.md) | DominoEX 4 to 22: the drift-proof chat mode, sent and received |
| [JTTY](jtty.md) | JTTY: the WSJT keyboard mode for RTTY contesters, every station in the passband, and sending |
| [Icom protocol](icom-protocol.md) | The RS-BA1 wire format, for anyone working on the driver |
| [LoTW upload](lotw-upload.md) | Signing and uploading to LoTW from the callsign certificate, without TQSL |
| [Panadapters](panadapter.md) | The brief the RF panadapter work started from, per radio |
| [Exposure](exposure.md) | What is reachable without signing in, and how that was checked |
| [Cloudlog audit](cloudlog-audit.md) | A read of Cloudlog against this codebase: what is missing and worth building |
| [Roadmap](roadmap.md) | Planned and not built, with the reasoning |
| [Backlog](backlog.md) | Pointer to the issue tracker, and what its labels mean |
| [Troubleshooting](troubleshooting.md) | Symptoms, in the order you are likely to meet them |
| [Development](development.md) | Conventions, the test suite, how to add things |

## The short version

DigiShack is two processes and a database:

- **The web app** (`npm start`) — everything you look at.
- **The radio bridge** (`npm run bridge`) — talks to the radio (FlexRadio or Icom), decodes audio,
  runs the automatic operating modes, and keys the transmitter. Separate because it
  binds a UDP socket, and a bound UDP socket cannot be shared across workers.

They talk over a token-guarded HTTP API on localhost. Browsers get the live decode feed
and receiver audio from the bridge's two WebSockets, which need a signed-in session (or,
for a script on the box, the bridge token) — see [Architecture](architecture.md#the-websockets-and-who-may-open-them).

Inside the app, the header's menus (Operate, Log, Analyze, Tools), **Ctrl/⌘+K** to jump
to any page, and the **Help** page — searchable answers to "why did it do that?" — are the
quickest ways round.

## Conventions used throughout

**Every time is UTC.** Amateur radio runs on UTC and nothing else; a log with local
timestamps does not match LoTW, does not match the other operator, and cannot be
compared with anything. Every timestamp on screen carries a `Z` or the word UTC. If you
ever see one that does not, that is a bug.

**Nothing transmits without being told to.** Automatic modes are off by default, each
radio has its own transmit gate (`flex.allowTransmit`, `icom.allowTransmit`, armed from the
header's TX control or Settings) re-read before every transmission, and the
[operating guards](operating.md#the-brakes) will stop a run rather than let a station
key unattended into a fault.

**Nothing is hardcoded that an operator might reasonably want to change.** If a piece
of text, a threshold or a frequency matters to how your station behaves, it is in
[Settings](settings.md), not in the source.
