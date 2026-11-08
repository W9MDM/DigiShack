# DominoEX

DominoEX in six speeds: what it is, the submodes, tuning, what the receiver does, and
sending. The modem follows fldigi 4.2.13 (`src/dominoex/`), because fldigi is what nearly
every DominoEX station runs.

DominoEX is a keyboard mode like PSK31, built for paths where PSK31 struggles: low bands at
night, NVIS, a signal with flutter or multipath. It sends one of 18 tones at a time, and
what carries the data is the step from one tone to the next, not the tone itself. That has
two results you will notice:

- **Tuning hardly matters.** A station several tens of hertz off still prints, and a slow
  drift does no harm. There is no AFC to wait for.
- **No tone ever repeats.** Every symbol moves at least two tones, so an echo of the last
  symbol cannot be mistaken for this one.

There is no error correction. A noise burst costs a character or two, as in PSK31.

## The submodes

| Mode | Baud | Tone spacing | Width | Characters a second, plain English |
|------|-----:|-------------:|------:|-----------------------------------:|
| DominoEX 4 | 3.91 | 7.8 Hz | 141 Hz | about 2.8 |
| DominoEX 5 | 5.38 | 10.8 Hz | 194 Hz | about 3.8 |
| DominoEX 8 | 7.81 | 15.6 Hz | 281 Hz | about 5.5 |
| DominoEX 11 | 10.77 | 10.8 Hz | 194 Hz | about 7.6 |
| DominoEX 16 | 15.63 | 15.6 Hz | 281 Hz | about 11 |
| DominoEX 22 | 21.53 | 21.5 Hz | 388 Hz | about 15 |

DominoEX 11 is the common one; 22 is for a good path and 4 to 8 for a poor one. In 4, 5 and
8 the tones are two baud apart, so a slow signal is not squeezed into a few tens of hertz.
The rates come from fldigi working the even modes at 8000 Hz and DominoEX 5, 11 and 22 at
11025 Hz. That is why 11 and 22 are not round numbers.

A lower-case letter is usually one symbol and a capital or digit two, which is where the
speeds above come from. The MultiPSK-compatible FEC option and DominoEX Micro are not
supported. FEC is off by default in fldigi too.

## On the decodes page

Choose **DOMINO** in the mode list. DominoEX has no calling frequencies; it is worked in
the digital segments beside PSK and Olivia, so choosing it decodes where the dial already
is (the list marks it "here"), and it stays chosen while the dial stays within 5 kHz. The
panel has the speed picker (DominoEX 11 to start) and the ± buttons for the centre; a click
on the waterfall puts the centre on a signal, and the waterfall marks the centre and the
edges of the tone set.

The exchange bar, F1-F8 and **Log contact** work as in the other keyboard modes. ADIF has no
DominoEX speeds, so every speed logs as MODE=DOMINO SUBMODE=DOMINOEX, which is what LoTW,
eQSL and Club Log take.

An RSID heard for DominoEX 4 to 22 switches to that speed at that frequency, and with
**Send RSID before each line** on, yours goes out as fldigi's code for the speed (84 to
90), so an fldigi station with RxID on follows you.

## Tuning

The frequency is the **centre** of the tone set, as in fldigi: tones 8 and 9 sit half a
spacing either side of it. A station on the same centre in fldigi and here is on the same
tones.

The receiver looks across the tone set and nine tones either side. In DominoEX 11 that is
about 100 Hz each way, in DominoEX 8 about 140 Hz. A station anywhere in that window
prints. The receiver reports how far off the signal sits, so you can centre it before
replying.

## Listening

**The squelch.** The quality figure shows how far the strongest tone stands above the rest.
Noise alone reads 0 to 0.1, a signal at the edge of copy about 0.25, and a clean one 0.5 or
more. Below the squelch (default 0.2) nothing prints. On generated band noise, six minutes in
each submode at 24 and 48 kHz printed nothing.

A received character prints six symbols after it arrives, and only if the squelch is still
open then. This stops the noise after an over from printing a letter or two. In DominoEX 11
the wait is about half a second; in DominoEX 4 it is a second and a half.

**Framing.** fldigi starts each over with CR, STX, CR and ends it with CR, EOT, CR. These
control characters are not printed. Between characters fldigi sends its secondary text,
usually `fldigi 4.2.13`. That goes to a separate field, not the conversation.

**How weak.** Generated signals with white noise, S/N measured in 2.5 kHz:

| Mode | Copies every time | Most characters still right |
|------|------------------:|----------------------------:|
| DominoEX 4 | −15 dB | −16 dB |
| DominoEX 5 | −13 dB | −14 dB |
| DominoEX 8 | −12 dB | −13 dB |
| DominoEX 11 | −10 dB | −11 dB |
| DominoEX 16 | −8 dB | −9 dB |
| DominoEX 22 | −7 dB | −8 dB |

These are flat-noise figures; a fading path will need more. A static crash that lights up
every tone at once does not print.

## Sending

A line goes out as fldigi sends an over: one idle symbol group, CR STX CR, the text, CR EOT
CR, then four idles so the far end prints the last character. A newline goes as CR LF.
Accented letters go as UTF-8, the way fldigi sends them. The tones are continuous in phase
from one symbol to the next, and the start and end are ramped over 4 ms so the key-up does not
click.

## Not yet

- An on-air test against fldigi. The tone arithmetic and the Varicode are checked against
  sequences worked by hand from fldigi's source (`scripts/check-dominoex.ts`), but nothing has been
  copied off the air yet.
- Sending secondary text while idle.
- The FEC option, and DominoEX Micro.
