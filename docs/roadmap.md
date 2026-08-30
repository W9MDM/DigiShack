# Roadmap

What is planned but not built. Kept in the repository rather than in a chat log or an
issue tracker, because the reasoning is the part that gets lost.

## Icom IC-7300 mk2 — operating, self-healing, not yet understood

As of 1.19.0 the Icom is a second radio in full: it connects, decodes, draws a waterfall,
tunes over CI-V, transmits, and **operates by itself**. Auto CQ, Auto Hunt, Hunt POTA,
Chase POTA and Call all run here, from the same `buildOperating` the FlexRadio uses.

Proven on the air on 2 August 2026 — a complete autonomous contact, hunted and logged
with no human involved:

    03:15:15 RX  -2dB 1614Hz CQ W1ABC FN31
    03:16:00 TX       1614Hz W1ABC K9XYZ EN61
    03:16:15 RX  -2dB 1614Hz KG7WFQ W1ABC RR73     (they were busy)
    03:16:30 TX       1614Hz W1ABC K9XYZ EN61
    03:16:45 RX  +2dB 1614Hz K9XYZ W1ABC -11
    03:17:00 TX       1614Hz W1ABC K9XYZ R-02
    03:17:15 RX  -3dB 1614Hz K9XYZ W1ABC RR73
    03:17:30 TX       1614Hz W1ABC K9XYZ 73

### What still needs doing

The four items that stood here are closed as of 1.28.0. What each turned out to be,
because the reasoning is the part worth keeping:

**1. Detect a keyed radio producing no RF - done (1.20.0).** `MOD Input -> DATA MOD` set to
anything but LAN makes the radio key perfectly and transmit silence, and this project said
for weeks that no software could detect it. That was true only while the meters did not
work. SSB with no modulation produces no output, so **forward power reading zero while
keyed is exactly that fault**. `rfWatch` in `icom-source.ts` tracks peak forward power
across each transmission and says so once per session, naming the menu item.

**2. Band hop and POTA chase on the Icom - proven in software, not yet on the air.** Both
now run through `check-operating` on Icom-shaped dependencies and are required to reach the
same frequency by the same path as the FlexRadio. The invariant worth having is not which
band it picks but that a hop goes through **`retune`**, the only path that runs the antenna
tuner: a hop reaching `tuneHz` instead would land on a band the tuner has never seen and
fold back to a few watts - unattended, on a band nobody is watching.

Two things came out of writing that test. A hop only follows a pause whose cause is
**quiet**, deliberately: a fault is not something a different band fixes, and hopping used
to call `rearm()`, which cleared the fault outright and carried on transmitting. And
`hopIndex` started at the head of the list while `hopNext` increments before reading, so
**the first hop skipped the operator's first choice** - invisible except on the one hop most
likely to be watched.

What remains is hardware: nobody has watched an Icom hop bands and tune on the air.

**3. `/rig` on the Icom - done.** AGC, RF gain, noise blanker, noise reduction and the tune
cycle all work over CI-V now, and each write waits for the radio's own OK or NG reply - so a
sub-command a model does not implement is reported as refused rather than silently doing
nothing. That confirmation is the point: nothing reads these back, so without it a wrong
command byte would be indistinguishable from success.

Two things are still refused **by name**, each for a reason:

- **`filterLo`/`filterHi`** - the Icom selects FIL1/2/3, whose widths live in the radio's
  menu. There is no honest mapping from a passband in Hz, and guessing one would move the
  filter to something the operator did not ask for.
- **`agc=off`** - these radios have no AGC-OFF in this command set. Mapping it to fast would
  be a control that says one thing and does another.

`rfGain` is a percentage here and dB of attenuation on the FlexRadio, so a value outside
0-100 is rejected rather than clamped: a -10 silently becoming 0% is the panel lying about
the radio.

**4. No spectrum history on reconnect - closed, deliberately not built.** Measured rather
than assumed: rows arrive every 250 ms (`SPECTRUM_INTERVAL_MS`) and the canvas is 300 px
tall, so **a fresh page fills its whole waterfall in 75 seconds**. Backfilling it means
holding 300 rows of ~512 bins and sending ~200 kB on every page load - and replayed rows
would be drawn flush against live ones, making a gap in time look like continuous band
activity. A waterfall that lies about when a signal was there is worse than one that is
briefly empty, and the display is inherently about *now*.

### Traps already paid for, so nobody pays again

Recorded properly in [icom-protocol.md](icom-protocol.md) and [icom.md](icom.md), but the
short list:

- The transport sequence on a tracked packet **starts at 1**. Zero is discarded in
  silence. This cost an afternoon.
- The open handshake is **four steps**, and type 6 is session-open, not close. Close is 5.
- The login reply is **96 bytes**; the 168-byte packet is a separate capabilities packet.
- The radio **zeroes the length field** on pings — frame on the datagram, never the header.
- `MOD Input → DATA MOD` must be **LAN**, or the radio keys perfectly and transmits
  silence. Long believed undetectable in software — and it is not: SSB with no modulation
  produces no output, so forward power reading zero while keyed is exactly this fault. It
  only became detectable once the meters worked (1.21.0).
- **The audio stream is bidirectional and the radio expects it to be used.** A client that
  only receives gets its audio cut off after a minute or two, while the radio keeps
  pinging the same socket. Send silence when there is nothing else to send.

## The two radios were modelled twice — resolved by deletion

The `Rig` table held operator-entered inventory: a name, a type (FLEX_6000 / FLEX_8000 /
HAMLIB_NET / MANUAL) and an IP address, attached to a station. **Nothing in the radio path
ever read it.** The radio DigiShack operates is configured in Settings, and a contact
records `Qso.radio` — what the radio called itself over the air, which cannot disagree with
reality and needs no setting up.

So the table was worse than unused: it invited an operator to configure a radio somewhere
that does nothing, and this install had two rows with one of them being exactly that mistake
in progress — `Barn Flex, FLEX_6000, 192.0.2.10`. Dropped in 1.34.0, with those two rows
recorded in the migration because dropping a table is not reversible.

## Closed in 1.30.0-1.31.0, because the UI was telling the truth

Three things the application itself said were unbuilt, all found by an operator reading a
page rather than by anyone reading a roadmap:

- **QRZ Sent/Rcvd on a contact.** Missing because the schema asserted QRZ never confirms
  contacts. It does. Along with it: a differential download instead of re-reading the whole
  logbook every run, and marking contacts QRZ already has so uploads stop offering them.
- **"Heard by"**, which said PSKReporter collection was a Phase 5 feature. Phase 5 was
  finished. The table, the dedupe key, the panel and the setting all existed; only the query
  was missing.
- **"Linked decodes"**, which said the bridge would populate it in Phase 4a. Nothing ever
  set `DigitalDecode.qsoId`, so the retention sweep's exception for decodes attached to a
  contact protected nothing, and every real contact's raw decodes were pruned with the noise.

**Old exchanges are rebuilt as far as the data allows** — 272 contacts. 25,961 cannot be:
no decodes survive from before 1 August, and for those the exchange was never recorded
anywhere. The data does not exist, so this will not improve later.

A station-wide "who hears me" view is the natural next step, and needs `PskSpot.qsoId` to
become nullable: most reception reports are of CQs that produced no contact, so today they
are counted and discarded rather than kept against nothing.

## Per-radio profiles, instead of one shape both radios are forced into

Raised by the operator, and correct: *"you don't have to average everything for both radios,
you can make different radio profiles"*, and *"merging everything into one profile for both
radios has jacked a lot up."*

The shared operating layer is genuinely right and has earned its keep — the QSO sequencer, the
guards, the scheduler and award-aware hunting are the same behaviour on any radio, and
`check-operating` proves both produce identical transmissions. That is not what went wrong.

What went wrong is forcing HARDWARE differences through one shape. Every one of these was a
real defect, all of them in the same week:

| Merged thing | What it caused |
|---|---|
| One modulation vocabulary | `USB-D` sent to a FlexRadio, silently rejected — every data mode selection did nothing |
| One `status.mode` field | Digital mode on the Icom, modulation on the Flex; the picker displayed `FT8`, then `DIGU` |
| One `status.receiver` | The Icom's noise-blanker reading shown next to a FlexRadio that was never asked |
| One voice-mode flag | Survived a radio change, claiming voice mode on a radio still in DIGU |
| One spectrum analyser | Below |

**The waterfall is the clearest case.** Both radios are shown 0–3 kHz of *demodulated audio*,
because that is what the FT8 decoder needs. An operator looking at it sees one signal —
"soooo zoomed in, focused on like one voice" — where a remote-operating site shows 42 kHz of
band with every station on it. That is not a display setting. It is a different source of
data, and each radio has its own:

- **FlexRadio**: panadapter objects over the SmartSDR API (`display pan create`), returning
  FFT frames over VITA-49. Wide span, and the radio does the work.
- **Icom**: the IC-7300's own spectrum scope over CI-V `0x27 0x00`, span selectable from
  ±2.5 kHz to ±500 kHz.

Neither is small and neither resembles the other, which is the point. The audio-passband
waterfall stays — it is the right display for FT8 and for checking that audio is arriving —
but it should be one profile among several rather than the only one.

**The shape to aim for**: a capability profile per radio saying what it has (RF panadapter,
which spans, which filters, whether AGC can be switched off, audio format and rate) and what
it calls things, with the UI asking the profile instead of assuming. The places that already
translate per radio — `toFlexMode`/`toCivMode`, the audio sample rate in the hello frame — are
that idea applied one field at a time.

## Voice operating — mode done, audio next

Voice **mode** landed in 1.37.0: digital transmit closed at the gate, the radio moved out of
the data mode that ignores a microphone, verified on the air. What remains is the audio, and
the design is settled enough to be mechanical. Written down so it does not have to be
rediscovered.

**Both radios can carry it, in different formats.**

| | receive | transmit |
|---|---|---|
| Icom | audio stream, 48 kHz s16**le**, already decoded to Float32 and emitted as `"audio"` (`lib/icom/rig.ts`) | same socket, `sendTracked` data packets, PTT over CI-V `0x1C 0x00` |
| FlexRadio | DAX VITA-49, 24 kHz float32, pushed to the pipeline at `lib/flex/dax.ts:433` — **needs an `"audio"` emit adding** | DAX TX, VITA-49 mono int16 **be** at 24 kHz to port 4991, the path the FT8 waveform already uses (`lib/flex/tx.ts`) |

Note the two differences that will bite: **endianness** (Icom little, Flex big) and **sample
rate** (48 k against 24 k). One `VoiceSink` per radio taking `(Int16Array, rate)` keeps both
out of the browser's business, and the resampling belongs in the bridge where it can be
tested as a pure function.

**Receive first**, because it cannot key a transmitter. The bridge's WebSocket server already
rejects any path but `/ws/decodes` (`noServer: true`, one upgrade handler), so `/ws/audio` is a
contained addition — and it has to be a separate path rather than binary frames on the
existing socket, because 48 kHz × 2 bytes is 96 kB/s and every open page would receive it
whether it wanted to or not.

**Transmit needs two things decided first, neither of them code:**

- **`getUserMedia` requires a secure context.** It works on `localhost` and not on
  `http://<host>:3000` from another machine, so remote voice means terminating TLS. That is
  an infrastructure choice.
- **PTT needs a dead-man.** Today's audio stalls make this concrete rather than theoretical:
  if the socket drops mid-transmission something must unkey the radio. Unkey on socket close
  AND unkey after N ms with no audio, both in the bridge, before this ever keys.

## No way to stop a radio — closed by the FT-0 button

There was no disconnect control. An operator who wanted to stop the radio reached for the
source picker and switched to the external decoder, which does stop it — the station goes off
the air and stays there, because nothing is listening on 2237 — but nothing in the UI said that
was what would happen. Found by watching an operator do exactly that.

Closed. The FT-0 button unkeys the radio, stops the automatic modes, persists the master
transmit switch off and disconnects, in two steps because it takes the station off the air
mid-session. Named for the joke mode at ft-0.com — 0 baud, 0 Hz bandwidth, −∞ dB minimum SNR —
which is credited on the button's help text.

## Hamlib, and what it would and would not buy

Researched 2026-08-30, at the operator's request: what integrating Hamlib would take, and
which radios it would actually add.

**The short version: Hamlib solves the half of the problem this project has already solved
twice, and does not touch the half that is actually expensive.**

### What DigiShack needs from a radio

The seam is already narrow, and deliberately so. A radio has to satisfy exactly two
interfaces (`lib/radio/types.ts`):

    DigitalSource        periodMs, and two events: `decodes` and `window`
    DigitalTransmitter   transmit({ message, mode, offsetHz, startAt }), unkey()

Behind those two, four jobs:

1. **CAT control** - frequency, mode, filter, PTT, antenna, power.
2. **Receive audio** into the decode pipeline, at a known sample rate.
3. **Transmit audio** out, keyed to a window boundary within milliseconds.
4. **Capability reporting**, so the UI offers only controls the radio really has
   (`lib/radio/capabilities.ts`).

### Hamlib answers exactly one of them

Hamlib is a CAT library. It covers **over 200 rig models** behind one command set, and it
is the reason WSJT-X, fldigi and N1MM can drive almost anything. It has **no audio path at
all** - not receive, not transmit. That is not an oversight; audio is a sound-card concern
and Hamlib is a control library.

So Hamlib would answer job 1, contribute usefully to job 4, and answer neither 2 nor 3.

### The integration itself is small, and needs no native bindings

`rigctld` is a daemon speaking a plain-text line protocol over TCP (default **4532**).
Single-letter commands - lower case reads, upper case writes:

    f            get frequency        F 14074000    set frequency
    m            get mode + width     M USB 3000    set mode
    t            get PTT              T 1           key / unkey
    s / S        split                l / L         levels (power, gain)
    \dump_caps   what this rig can do

Prefixing a command with `+` switches the reply to named fields, which is worth doing:
parsing positional output is how a protocol reader breaks silently on the next release.

**This fits how DigiShack already works.** It talks TCP to a FlexRadio on 4992 and to an
Icom over its LAN protocol; a third TCP text protocol is the pattern, not an exception. No
`libhamlib` linkage, no node-gyp, no native build in the container - which matters, because
this ships as an LXC anyone can create from a script.

Rough size: **300-500 lines** for a `rigctld` client plus a `RadioCapabilities` mapping.
Compare `lib/icom/` at 4,363 lines, most of which is not CI-V at all - it is
`control-stream`, `audio-stream`, `packets` and `passcode`, the LAN transport that carries
the audio.

### The expensive half: audio

**There is no sound-device library in this project.** Not one. Both radios stream audio
over the NETWORK - VITA-49 DAX from the Flex, the Icom's own LAN protocol - and the decode
pipeline is fed from UDP packets.

A Hamlib radio is a radio DigiShack controls but does not stream from. Its audio arrives at
a **sound card**: the rig's USB codec, or a physical interface. That is a new subsystem:

- capture at a known rate and feed `DecodePipeline.push()`
- playback of generated FT8/FT4 audio, started at a window boundary
- device enumeration and selection in Settings, because "which sound card" is a question
  every operator will answer differently
- Windows, Linux and macOS all differ here, and the one deployment that matters is a
  headless Linux container

**And a trap this project has now paid for once.** The window cut is timed in the audio's
arrival frame, and 2026-08-30 was spent on a race where a cut could fire twice because
`setTimeout` drifted by a millisecond against a re-measured link latency. A sound card
brings a harder version of the same problem: **its clock is not the radio's clock and not
the system clock**, and it drifts. DAX delivers a disciplined 24 kHz; a USB codec delivers
whatever its crystal says, and over a 15-second window a few hundred ppm is audible to the
decoder as DT drift. Whoever builds this should assume drift tracking or resampling is part
of the job, not a refinement afterwards.

PTT timing is the same shape. Today the transmitter keys early by a measured link latency
and tolerates 1,488 ms of lateness on FT8 (`lib/radio/timing.ts`). `rigctld` adds a TCP
round trip plus the rig's own CAT latency, and on a serial rig that is tens of milliseconds
and variable. **Unverified**: nobody here has measured `rigctld` PTT latency, and it should
be measured before it is designed around, exactly as the FlexRadio link latency was.

### What it would actually add

Sensibly staged:

1. **`rigctld` CAT source.** Tune, mode, PTT, power. Paired with the EXISTING WSJT-X source
   for decodes, this alone gives band hopping, scheduling and logging on any Hamlib rig,
   with WSJT-X still doing the DSP. Small, useful, and it needs no audio work.
2. **Sound-device audio.** The real project. With it, any rig with a USB codec becomes a
   full native DigiShack radio - IC-7300 over USB, FT-991A, K4, G90, and the long tail.
3. **Capabilities from `\dump_caps`.** Hamlib already knows each rig's tuning range, modes
   and levels. `RadioCapabilities` was written for exactly this - its own comment says a
   third radio should need "two numbers and not a new table".

### What it does not obsolete

The FlexRadio and Icom LAN paths stay. Hamlib would drive both radios' CAT, and give up the
panadapter, the network audio, DAX, and slice control - which is most of what makes those
two first-class here. **Hamlib is how the long tail gets supported, not how the good radios
get supported.**

## Also queued

Accurate as of 1.113.0. The previous version of this list had gone stale in a way worth naming:
it said LoTW upload "needs TQSL installed", and that premise was simply false — reading
Cloudlog showed it never invokes TQSL, and the whole job is PKCS#12 extraction plus an RSA-SHA1
signature, both of which Node does natively. A wrong assumption in a roadmap is worse than a
missing entry, because nobody re-examines it.

### Still open

- **DX cluster, and workable DXCC.** The join between "what is being spotted" and "what I still
  need". Every piece exists — the band strip, the spot feed, the worked index, the award
  progress — and the join does not. The largest remaining item and the most useful for chasing.
- **Cabrillo export.** Only matters if a contest is entered, and it wants the contest's own
  exchange fields rather than a rename of the CSV columns, so it is worth doing when there is a
  contest to test it against.
- **HRDLOG upload.** `hrdlog.callsign` is a registered setting and nothing uploads there;
  `UPLOADABLE` is `qrz`, `clublog`, `cloudlog`, `eqsl`, `lotw`.
- **Club Log uploads remain blocked for an environmental reason.** `putlogs.php` answers 403
  from nginx even for an empty POST, so the refusal happens before authentication and is not
  ours to fix. Now that LoTW upload works, pointing Club Log at LoTW populates it without
  uploading from here at all, which is probably the answer.
- **FT2 interoperability**, which needs a second station. Encoder and decoder agree across 219
  assertions; no signal from another operator has ever been decoded here.
- **The 174 confirmed findings from the 30-persona usability review**, being worked through in
  the order the review recommends.
- **Why QRZ does not match 38 uploaded contacts.** Those contacts are in the log, `qrzSent` is
  true, and QRZ still lists the card request as outstanding. Uploading again will not fix it;
  the next step is comparing what QRZ holds for those exact QSOs against what we hold.
- **Automatic LoTW reconciliation exists; the eQSL equivalent does not.** An accepted LoTW
  upload is only a queue acknowledgement, so `lotwSent` is checked daily against what LoTW
  actually holds. eQSL answers per contact and definitively, so it needs no such check — but
  nothing verifies the eQSL *inbox* matcher against a second source.

### Waiting on the operator, not on code

- **eQSL uploads are off.** The uploader works and `uploads.eqslReciprocalOnly` defaults on, so
  switching it on sends a card only to stations that sent us one — 7,552 of them, at one request
  per contact. It posts cards to other operators, so it stays off until asked for.
- **Roughly 765 contacts recovered from WSJT-X's ALL.TXT are not imported**, of which 455 have
  that station on that band and mode nowhere in the log at all. Each carries up to twelve
  verbatim decode lines as evidence. 80 were imported where a QRZ card request corroborated
  them; the rest are the operator's call.
- **Fourteen August 2026 exchanges predate the incomplete-exchange recorder.** They were found
  by reconciling QRZ requests against `DigitalDecode`, and could be reconstructed the same way
  ALL.TXT was, if wanted.
- **Run limits are switched off on this install** (`auto.maxRunMinutes` and `auto.maxQsosPerRun`
  both 0). The operator's call, but they are exactly what unattended operation is for.

### Closed since this list was last honest

LoTW upload (1.94.0, verified against the live service), LoTW upload verification (1.102.0),
eQSL upload (1.90.0) and inbox sync (1.101.0), Cloudlog/Wavelog upload, the QSO map, statistics
beyond the dashboard (1.103.0), callsign history (1.104.0), CSV export (1.105.0), ADIF import and
export, the scheduled-job list (1.96.0), and the incomplete-exchange recorder with its QRZ
reconciliation (1.111.0-1.112.0).
