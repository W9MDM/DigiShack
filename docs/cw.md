# CW

CW on the decodes page: the mode chip, the radio in CW mode with the decoder on its pitch,
the terminal, sending through the radio's own keyer, and what the automatic modes do about
it. The decoder is best effort, and the first section says what that means.

## Listening

Press **CW** in the mode group on the decodes page. It tunes the radio to the band's CW
segment (the table below), puts the slice in CW mode, and the decoder switches to a
stream - no windows, text as it is keyed at the far end, newest at the bottom. The
decoder listens at the radio's CW pitch, the sidetone frequency SmartSDR reports, so a
signal tuned to zero-beat with the sidetone is a signal the decoder is on; the panel says
which pitch it is using and whether it came from the radio or from Settings.

Like RTTY, CW has a segment on each band rather than a calling frequency, so once the
decoder is on CW it stays there while the dial moves. A slice in CW mode means CW to the
bridge whatever the frequency; the dial landing on another mode's calling frequency, or
another mode's chip, lets go. Tuning to a data mode from CW puts the slice back in DIGU.

| Band | Dial (MHz) | Band | Dial (MHz) |
|------|-----------:|------|-----------:|
| 160 m | 1.830 | 17 m | 18.080 |
| 80 m | 3.550 | 15 m | 21.040 |
| 40 m | 7.030 | 12 m | 24.900 |
| 30 m | 10.120 | 10 m | 28.040 |
| 20 m | 14.040 | 6 m | 50.095 |

**Best effort.** A machine reads clean, well-spaced CW at a steady speed as well as an
operator does. It reads a sloppy fist, a swinging bug, a station in QSB or two stations on
one pitch worse than any operator, and nothing on this page changes that. What it is for
is reading a callsign or a report off the page rather than copying it; when the page and
your ear disagree, your ear is right. The decoder re-estimates the speed from the last
few characters, so a station changing speed is followed within a word, and the panel
shows the speed it hears. A pattern it cannot read prints as `#`.

A signal has to stand about 16 dB over the noise in the decoder's narrow filter before it
prints anything, which is roughly what a machine needs to read CW at all and is what keeps
an empty channel silent. Weaker than that, you will hear it before the page shows it.

## Sending

Type a line under the terminal and press Enter, or press **CQ** or **73**. The text goes to
the FlexRadio's CWX keyer, which keys the transmitter itself at the speed shown (the −2 /
+2 buttons, or `cw.wpm` in Settings) with the radio's own rise times and sidetone. The
radio has to be in CW mode with break-in on, which is how the CW chip leaves it. The line
appears in the terminal as `[TX]` once it has been sent, or as `[TX refused: ...]` with the
reason: transmit off in Settings, the radio busy, the decoder not on CW, or the radio
refusing the CWX command. "Allow transmit" has to be on, the same gate as every other
transmission here. A line is capped at forty seconds on the air at the speed set.

## What the automatic modes do

Nothing: there are no structured messages for a sequencer to answer, so the automatic
modes refuse to start on CW, landing on CW with one running stops it, and the Call button
is not offered. The transmitter refuses CW as a framed mode; text goes through CWX.

## The decoder, and how it was checked

`lib/digital/cw.ts` is the Morse table (ITU-R M.1677 with the prosigns), the PARIS
timing and a keyed-tone waveform with shaped edges for the checks; `lib/digital/cwdemod.ts`
reads the key against a two-second peak with hysteresis, keeps the noise floor from the
key-up envelope alone, debounces the edges, re-estimates the dit from the last ten marks
and reads each character at its end with that estimate. It is checked at 12, 20, 30 and
40 WPM from one 20 WPM guess, off pitch, weak, in noise, through a speed change, on
prosigns, and on silence and noise alone; the pipeline's stream branch is checked the same
way at the FlexRadio's 24 kHz. See the changelog for 1.192.0 and 1.193.0.

## Not yet

- A logging panel beside the terminal, and macros you can edit.
- Setting the radio's pitch from the page (it is the radio's sidetone; change it there).
- Click-to-tune the radio to a signal on the panadapter.
