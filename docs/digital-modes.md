# Digital modes

DigiShack decodes and transmits FT8, FT4 and FT2 itself. There is no WSJT-X in the
path, no virtual audio cable, and no second program to keep in sync.

## How the audio gets here

Two radios, two transports, one decoder. Everything above the audio — the window
scheduler, the decoders, the waveform generator, the QSO sequencer, the automatic modes
— is shared, and neither half knows which radio it is talking to. That is the whole
point of `lib/radio/types.ts`.

### FlexRadio (DAX)

A FlexRadio streams DAX audio over the network as VITA-49 packets. DigiShack:

1. Connects to the radio's SmartSDR API on TCP 4992 and asks for a DAX channel.
2. Receives audio on UDP 4991 — type 3 packets, stereo float32, class `0x03e3`.
3. Buffers it into cycle-aligned windows and decodes each one.
4. For transmit, sends type 1 packets: **mono int16 big-endian at 24 kHz**, class
   `0x0123`.

The one non-obvious requirement: **`client gui` is mandatory**. A non-GUI client can
connect, subscribe and receive audio perfectly well, and the radio will silently
discard its transmit audio and ignore its `rfpower` commands. Nothing errors. This
cost a long afternoon.

### Icom (RS-BA1)

A networked IC-7300, IC-705, IC-9700 or IC-7610 speaks the RS-BA1 protocol — the same
one Icom's own remote software uses. DigiShack:

1. Logs in on UDP 50001 and is told which ports the other two streams are on.
2. Takes CI-V on 50002 for frequency, mode, meters and PTT, and audio on 50003.
3. Receives **48 kHz signed 16-bit little-endian**, decimated by four to the decoders'
   12 kHz — against the Flex's 24 kHz decimated by two.

Both rates divide exactly into 12 kHz, which is luck worth not squandering. The extra
decimation pass is also why the Icom needs its own silence threshold: the same signal
arrives about 20% quieter at the point that gets measured.

The equivalent afternoon-costing requirement here is **`MOD Input -> DATA MOD = LAN`**
on the radio, without which it keys perfectly and transmits silence. See
[Using a networked Icom](icom.md).

## The modes

| | FT8 | FT4 | FT2 |
|---|---|---|---|
| T/R period | 15 s | 7.5 s | **3.75 s** |
| Modulation | 8-FSK | 4-GFSK | binary GFSK, h=0.8 |
| Symbols | 79 | 105 | 144 (16 sync + 128 data) |
| Payload | 77 bits | 77 bits | 77 bits |
| FEC | LDPC(174,91) | LDPC(174,91) | **LDPC(128,90)**, CRC-13 |
| On air | 12.64 s | 4.48 s | 1.947 s |

All three share the same 77-bit message packing, so a callsign or grid means the same
thing in each.

### About FT2

FT2 is ported from `wsjt-x_improved`. Two things are worth recording because they are
easy to get wrong and hard to notice:

**Where the constants come from.** `lib/<mode>/` in the WSJT-X tree is K1JT's
*standalone harness*. The wire-format constants there are authoritative; the scheduling
and frequency values are **not**. The T/R period lives in
`widgets/mainwindow.cpp` (`on_action<MODE>_triggered`) and the frequencies in
`models/FrequencyList.cpp`. An earlier version of this project took both from the wrong
place and shipped an FT2 that could never have worked with anyone.

**Interoperability is unproven.** The encoder and decoder agree with each other across
219 assertions, and the wire format matches the reference implementation as far as it
can be checked offline — but no FT2 signal from another station has ever been decoded
here, because there is almost nobody to hear. Treat FT2 as experimental until two
stations have confirmed a contact.

## The passband

`digital.passbandHz` sets **both** what the decoders search and what the waterfall draws
— one number, so the display can never disagree with the decoder. The default 3000 Hz is
the conventional FT8 sub-band and the decoder library's own default.

Raising it finds stations that were being clipped: on a busy band the decode histogram
shows a hard stop at exactly 3000, which is a clipped distribution rather than a natural
one. It costs decode time, so watch for the `decode took Nms` warning.

It does **not** raise what you can transmit. A DIGU slice and an IC-7300's USB-D both roll
off below 3 kHz, so a station heard at 3400 Hz can be decoded and cannot be answered —
the call is refused with a reason rather than clamped to a frequency nobody is listening
on.

## Decoding

Each cycle-aligned window is downsampled, searched for sync patterns across the
audio passband, and every candidate is demodulated and LDPC-decoded. A candidate whose
parity does not satisfy is discarded — there is no "probably right" path.

Decodes appear on the Digital page within a second of the window closing, and are
written to `DigitalDecode` with band, mode, SNR, frequency offset and time.

## Transmitting

The QSO sequencer answers one question: *what would a competent operator send right
now?* It never transmits on its own initiative. Each transmission is a tick on our
cycle parity, and every one passes:

1. `flex.allowTransmit` — the master gate, re-read each time.
2. The [operating guards](operating.md#the-brakes).
3. `preflight()` — transmit inhibited, DAX not selected, another client holding the
   transmitter, a non-DIGU slice, power over 30%. Reported rather than enforced:
   refusing to attach over a warning would leave you unable to operate for a reason you
   cannot see. The findings show up as `txBlockers` and `txWarnings` on the status.

## Clock accuracy

FT8 tolerates roughly a second of error before decoding degrades, and rather less before
other stations stop decoding **you**. That failure reads exactly like a dead band, a wrong
frequency or a broken audio path — which are the three things anyone checks first, for an
hour, before thinking of the clock.

Two independent measurements, kept separate because they know different things:

- **The median DT across recent decodes.** Everyone else's clock errors are independent and
  cancel, so the median is a measurement of *ours*. Real, and free. But it needs eight
  decodes before it will say anything, so on a quiet band it says nothing — and a station
  that cannot hear anybody is exactly the one wondering whether its clock is why.
- **SNTP**, one round trip, millisecond accuracy, works on a dead band. `time.ntpServer`,
  and the **Sync now** button on the Digital page for when the question is being asked right
  now by someone staring at an empty screen.

**DigiShack cannot set the system clock** — that needs elevation on Windows and root on
Linux, and under PM2 it is neither. In a container it is not possible in principle, because
the clock belongs to the host. So it compensates instead: `time.correct` applies the
measured offset to transmit timing, decode window boundaries **and logged contact times**.

That last one is not a detail. Correcting the air and not the log writes every contact's
time wrong by exactly the correction that made the radio work. One clock, used everywhere,
or the log and the air disagree. Duration measurements are left alone — an offset cancels in
a subtraction.

**Corrections above 5 seconds are refused.** That is not a clock needing a nudge, it is a
machine whose time is wrong — the log will be wrong, file timestamps will be wrong, TLS will
start failing — and quietly compensating would hide it. The message says to fix NTP on the
host instead.

An HTTP `Date` header would be the obvious shortcut and is a bad one: one-second resolution
is a third of the entire FT8 budget spent on the measurement itself.

## What is kept

Every contact the native path logs keeps **the whole exchange** in `Qso.transcript`, both
directions, with times, reports, offsets and any transmission the radio refused. Six
lines that answer the question a doubted contact turns on: did they actually receive my
report, or did I log an optimistic QSO. It is shown on the QSO page as **Exchange**.

Every decode can also be written to a **CSV per UTC day** — set `digital.decodeCsvDir`.
That is separate from the `DigitalDecode` table, which is pruned after
`digital.decodeRetentionDays`: the table is what the application queries, the files are
the raw feed in a format that outlives the schema. `npm run export:decodes` back-fills
them from the database.

## PSKReporter

Decodes are uploaded when `pskreporter.enabled` is on. This is how you find out who is
hearing *you*, and it feeds the "seen" column of the band strip. PSKReporter asks
automated users to identify themselves — `pskreporter.contact` is sent with every
query, and honouring that is the difference between an email and a ban.

## When it does not work

See [Troubleshooting](troubleshooting.md#no-decodes).
