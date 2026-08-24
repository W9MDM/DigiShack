# Architecture

## Processes

```
┌─────────────────┐         ┌──────────────────────────┐
│  Next.js app    │  HTTP   │  Radio bridge            │
│  (npm start)    │◄───────►│  (npm run bridge)        │
│                 │  :3101  │                          │
│  pages + API    │   WS    │  FlexClient  TCP :4992   │──► FlexRadio
│                 │◄────────│  DAX audio   UDP :4991   │◄──
└────────┬────────┘ decodes │  decoders / QSO / auto   │
         │                  └────────────┬─────────────┘
         │                               │
         └──────────► MySQL ◄────────────┘
```

**Why two processes.** The bridge binds a UDP socket for DAX audio, and a bound UDP
socket cannot be shared across cluster workers. Keeping it separate is what lets the
web tier scale, and it means a Next.js rebuild does not drop the radio.

They talk over HTTP on `127.0.0.1:3101`, guarded by `bridge.token`, plus a
WebSocket carrying the live decode feed to browsers. The bridge listens on loopback
only.

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
| `components/` | UI, grouped by feature |
| `lib/` | Everything with logic in it, and where the tests point |
| `lib/digital/` | Mode-independent DSP, message packing, the QSO state machine |
| `lib/flex/` | SmartSDR client, DAX receive and transmit, discovery |
| `lib/dxcc/` | cty.csv parsing and callsign → entity resolution |
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

Roughly 500 assertions across DSP, ADIF, DXCC, QSL, POTA, time, backup and the
auto-operator. See [Development](development.md).
