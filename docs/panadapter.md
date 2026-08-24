# Panadapters — a brief for starting the work

Written at the end of the session that established the need, so the next one does not have to
rediscover it. Read this, then `docs/roadmap.md` § *Per-radio profiles*.

## The goal, concretely

A **band** waterfall: tens of kHz of RF spectrum with every station on it, the way a remote
operating site shows `7.178 — 7.220 MHz` with a dozen signals across it.

What exists today is **not that, and cannot become it by tuning**. The current waterfall shows
**0–3 kHz of demodulated audio** — the output of the receiver, which is one signal. The
operator's description was exact: *"soooo zoomed in, it's focused on like one voice."* No FFT
setting bridges audio to RF. It is a different source of data.

## Keep the audio waterfall

It is the right display for FT8 — the decoder searches a 3 kHz passband and the waterfall must
show the same span or it lies about what will decode — and it is the quickest confirmation that
audio is arriving at all. It becomes **one profile among several**, not the only one.

`lib/radio/spectrum.ts` already has two profiles (`digital` at 5.9 Hz bins every 250 ms,
`voice` at 23 Hz bins every 50 ms) and both sources can switch at runtime via
`setSpectrumProfile`. A panadapter is a third source, not a third profile of the same source.

## Per radio, because they are genuinely different

This is the architectural point the operator raised, and it is right:

> you don't have to average everything for both radios, you can make different radio profiles

The shared **operating** layer is not the problem and should not be touched — the QSO
sequencer, guards, scheduler and hunting are the same behaviour on any radio, and
`npm run check:operating` proves both radios produce identical transmissions. Forcing
**hardware** differences through one shape is what caused four separate defects in a week:
`USB-D` silently rejected by the Flex, `status.mode` meaning two things, one radio's AGC shown
next to the other, and voice mode surviving a radio change. See the roadmap table.

### FlexRadio

Panadapter objects over the SmartSDR API. Roughly: create one (`display pan create ...`), the
radio answers with a stream id, and FFT frames arrive over VITA-49 UDP — the same transport
`lib/flex/dax.ts` already parses for audio, with a different packet class.

**Verified in this codebase already** (see `lib/flex/tx.ts` and `dax.ts`), and worth reusing
rather than rediscovering:

- VITA-49 header is **28 bytes**; payload follows.
- The radio sends audio from port **4993** and receives on **4991**. Do not assume the observed
  source port is the destination — that mistake produces a transmission with no output and no
  error anywhere.
- Packet class `0x03e3` is float32 RX audio; `0x0123` is mono int16 TX at 24 kHz.
- OUI `0x001c2d`, information class `0x534c`.

Unverified and needing discovery: the exact `display pan` syntax this firmware wants, the
packet class for FFT frames, and how bin count and span are requested. `FlexClient.command`
returns the radio's own status replies, which is the cheapest way to find out.

### Icom

The IC-7300's own spectrum scope, over CI-V **`0x27 0x00`**. Span is selectable from about
±2.5 kHz to ±500 kHz.

**The trap, and it is a serious one.** Scope data arrives on the *same CI-V stream* as every
command and every meter read — and this project has already lost weeks to that stream's
timing. `lib/icom/rig.ts` paces writes 70 ms apart because the radio answers the first command
of a burst and silently drops the rest; that is why every meter reported nothing for weeks.
A scope sweep is many frames arriving continuously. Before enabling it, decide what happens to
the frequency poll, the three meters and the mode poll while it runs, and measure rather than
assume — `civFrames` and the unmatched-frame warning in `onCivFrame` are the instruments.

It may turn out that the scope and useful CAT polling cannot share the stream at a sensible
rate. That is a legitimate finding and should be written down rather than worked around
quietly.

#### Status as of 1.49.0: instrumented, not yet measured — the radio is not answering

Everything needed to answer the loading question is built and waiting:

- `IcomSource.civStats` counts replies **per command**, plus unmatched frames, the queue's
  high-water mark and scope frames and bytes. Total frame count deliberately is not the
  measure: a radio sending 30 waveform frames a second and answering no reads has a
  magnificent frame count and a dead S-meter, which is the exact shape of the failure that
  cost weeks. `resetCivStats()` scopes a measurement to one phase.
- `setScopeDataOutput`, `setScopeOn`, `setScopeMode` and `setScopeSpan` in `lib/icom/civ.ts`,
  with the two that matter read back and required to have taken.
- `scripts/probe-icom-scope.ts` runs baseline → scope on → span sweep → scope off, and reports
  each polled read as a percentage of the polls that should have answered it, labelled `ok` /
  `DEGRADED` / `STARVED` with what each one costs if it stops. It also checks the poll
  **recovers** after the scope is turned off, which separates "competes while running" from
  "damaged the session".

**It has not run.** On 3 August 2026 the radio at `192.0.2.11` answered ICMP but was silent on
all three RS-BA1 UDP ports — 50001, 50002 and 50003 — to four datagrams each. `probe-icom.ts`,
which predates this work, failed identically with *"No traffic on the control stream — session
lost"*, so this is the radio or the path and not the new code. Note that the ping replies came
back with TTL 254, which is one hop from a device using an initial TTL of 255; that is worth
ruling out before assuming the radio itself is what replied.

Consistent with the same day's finding that the radio allows **one** audio session and a second
client silently takes it (see the 1.47.1 entry). Check nothing else is connected before
concluding anything about the scope.

**The waveform parser is deliberately not written.** Its frame layout — how many frames a
sweep is split into, where the centre and span sit, how many data points and on what scale —
is exactly the thing the brief says to measure. Writing it from the manual and discovering
later that this firmware differs is how the four defects in the table above happened. The
probe prints the first frame's payload as hex and tallies its sequence numbers; that is the
input the parser should be written from.

## Resolution: as high as the chain allows

The operator's requirement is *"as high def as possible"*, and each link has its own ceiling.
Find the real one rather than picking a comfortable number:

- **The radio** decides the bin count it will produce. On the Flex that is a property of the
  panadapter object and is requested; on the Icom the scope's resolution is what it is. Ask
  for the maximum and see what comes back.
- **The wire** is the cheapest link. 2048 bins at 20 frames a second is 40 kB/s as bytes —
  comparable to the audio stream, which already runs fine. Send one byte per bin, as the
  existing spectrum message does; a dB value quantised to 256 levels across a 100 dB range is
  0.4 dB per step, far finer than anything visible.
- **The canvas** is the real limit on screen. A 1024-pixel-wide canvas cannot show 2048 bins;
  it shows the strongest bin per pixel — which is the correct reduction for a waterfall, since
  a narrow carrier must stay visible rather than being averaged away. `Waterfall.tsx` already
  does this. More bins than pixels is not wasted, though: it survives zooming, and taking the
  peak of several bins is what keeps a weak CW signal on screen.
- **Averaging in time is not averaging in frequency, and conflating them cost us the colour
  ramp.** The bullet above is about frequency: averaging ACROSS BINS smears a narrow carrier
  into its neighbours, so the canvas takes the strongest bin per pixel instead. Averaging
  ACROSS FRAMES is a different operation with a different effect — a steady carrier appears in
  every frame and averages to itself, while noise is independent frame to frame and averages
  down. The radio's `average` parameter is the second kind, and it was hardcoded to 0 on the
  strength of the first kind's reasoning. The cost is measurable: an unaveraged FFT bin holding
  only noise has exponentially distributed power, spreading **12.65 dB** from its 25th to its
  99.5th percentile no matter what the band is doing, and all of that has to be given to the
  dark end of the ramp. Averaging four frames narrows it to 6.35 dB and hands the difference to
  the signals. See `flex.panadapterAverage`.
- **Vertical resolution is time.** At 20 rows a second a 300-pixel canvas holds 15 seconds. If
  the radio can only produce 10 frames a second, that is 30 seconds and a coarser scroll —
  which is a trade to make deliberately and to say out loud in the UI, not to hide.

Measure the maximum each radio actually delivers before designing the display around a number.
The relevant precedent: the FT8 analyser was originally a fixed 4096-point FFT, which was
correct at 24 kHz and silently halved the resolution on a 48 kHz radio — the display went
blobby where the other was crisp, and nothing reported it.

## Where it plugs in

- **Message shape.** Today's spectrum message (`lib/radio/spectrum.ts`, `spectrumMessage`) is
  `{bins, binHz, maxHz, ...}` — audio-relative. A panadapter needs `{centerHz, spanHz, bins}`
  and the UI needs to know which it is receiving. Do not overload the existing `kind:
  "spectrum"`; a display that cannot tell 3 kHz of audio from 42 kHz of band will eventually
  draw one as the other.
- **Transport.** Rows already broadcast over the decode WebSocket. A panadapter at ~1000 bins
  and 10–20 frames a second is ~20 kB/s, which is fine there — but note the precedent set by
  audio: it got `/ws/audio` of its own precisely because 96 kB/s to every open page was not.
- **The component.** `components/digital/Waterfall.tsx` scrolls a canvas one pixel per row and
  takes markers in Hz. It is close to reusable; the axis labels and marker positions are the
  parts that assume audio offsets.
- **The rig page** already renders a waterfall at the top and switches profiles with voice
  mode (`pages/rig.tsx`).

## Conventions that apply

- **No test framework.** Scripts in `scripts/` print `ok`/`FAIL` and exit non-zero; wire a new
  one into the `check` chain in `package.json`. Parsing and framing are exactly the kind of
  thing this project tests heavily — see `scripts/check-civ.ts`.
- **Commit, push, bump the version and write a CHANGELOG entry every step.** The CHANGELOG is
  the reasoning log, not a list of changes.
- **Measure before concluding.** Every wrong turn in this project's radio work came from
  inferring a pattern from weak evidence; every fix came from one counter that separated two
  explanations. Recent examples worth imitating: the audio stall diagnosed by comparing ping
  counts against audio packets, and the 188 packets/second that explained a sound.

## The audio stall may be a second client, not a fault

Raised by the operator while the Icom's audio was dead: *"audio is running again, that might
have been the other session."* It fits the evidence better than anything proposed so far.

The radio allows **one** audio session. A second client taking it — another bridge process, an
RS-BA1 window, a probe script — leaves the first with a session that is still open, still
answering pings, and no longer carrying audio. Which is precisely the signature that has been
measured repeatedly and never explained:

    NOTHING at all has arrived on the audio socket. We sent 39 silence keepalive(s)
    in that time. No gaps in the audio sequence (0 lost all session), so the stream
    ENDED rather than being interrupted — that is the radio, not the link.

Every clause of that reads as "somebody else has the audio". No gaps, because nothing was
lost in transit; it stopped cleanly. The radio still pinging, because the session was never
dropped. And the keepalives we send making no difference, because the radio is not ignoring
us — it is talking to someone else.

**Not proven, and it does not obviously explain the earlier stalls** on days when nothing else
was connected. But it is testable and cheap: before diagnosing an audio stall, establish
whether anything else is holding the radio. Worth a check at session start, and worth saying
in the stall diagnosis, which currently offers "that is the radio, not the link" and stops
short of asking why the radio would do that.

## One measurement still owed

`npm run check:audio-rate` proves the audio stream's true sample rate against WWV's
once-a-second tick. It has never been run to completion — the Icom's audio stalled before a
tick arrived. Worth two minutes on a healthy session, because the Icom's handshake asking for
48 kHz mono and the wire carrying 24 kHz stereo are indistinguishable from the code, and the
second would play everything at double speed.

## A starting move

Take the FlexRadio first — its API is documented and its VITA-49 transport is already parsed
here — and get *one* FFT frame printed with its centre frequency and span before touching any
UI. The Icom afterwards, with the CI-V loading question answered by measurement first.
