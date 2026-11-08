# Throb and ThrobX

Throb and ThrobX in three speeds each: what they are, the submodes, tuning, what the
receiver does, and sending. The modem follows fldigi 4.2.13 (`src/throb/`), because fldigi
is what nearly every Throb station runs.

Throb is a slow keyboard mode by G3PPT. Each character goes out as one "throb": a pulse
that swells up from nothing and dies away again, carrying one or two tones at once from a
small set. You can hear it: a slow, regular throbbing, one beat a character. It is narrow
and copies well below the noise on a steady path, but it is slow, and a fading path hurts
it more than DominoEX or Olivia.

- **Throb** has nine tones. Every pair and every single tone is a character: capital
  letters, digits, `, . ' / ( )` and space. `? @ -` and a newline go as two throbs, a
  SHIFT and then a letter.
- **ThrobX** has eleven tones and uses only pairs. It adds `# " + - ; : ? ! @ =` and a
  newline, each one throb. A pause in typing reads as a space.

There is no error correction. A misread throb is a wrong character.

## The submodes

| Mode | Throbs a second | Tone spacing | Width | Pulse |
|------|----------------:|-------------:|------:|-------|
| Throb 1 | 0.98 | 8 Hz | 64 Hz | flat top, soft edges |
| Throb 2 | 1.95 | 8 Hz | 64 Hz | flat top, soft edges |
| Throb 4 | 3.91 | 16 Hz | 128 Hz | raised cosine |
| ThrobX 1 | 0.98 | 7.8 Hz | 78 Hz | flat top, soft edges |
| ThrobX 2 | 1.95 | 7.8 Hz | 78 Hz | flat top, soft edges |
| ThrobX 4 | 3.91 | 15.6 Hz | 156 Hz | raised cosine |

The width is from the lowest tone to the highest. A throb is one character, so the throbs a
second are the characters a second, less a little for Throb's shifted characters. The
rates come from fldigi working Throb at 8000 Hz with symbols of 8192, 4096 and 2048
samples. fldigi itself marks ThrobX 4 as non-standard.

## On the decodes page

Choose **THROB** in the mode list, then the speed. Throb has no calling frequencies; it is
worked in the digital segments, so choosing it decodes where the dial already is. The ±
buttons move the centre, a click on the waterfall puts it on a signal, and the waterfall
marks the centre and the edges of the tone set.

ADIF has one mode for both: Throb logs as MODE=THRB, ThrobX as MODE=THRB SUBMODE=THRBX,
the names fldigi writes.

An RSID heard for any of the six switches to it at that frequency, and with **Send RSID
before each line** on, yours goes out as fldigi's code for the speed (43, 44 and 45 for
Throb 1, 2 and 4; 46, 47 and 146 for ThrobX 1, 2 and 4).

## Tuning

The frequency is the **middle tone**, as in fldigi: tone 5 of Throb's nine, tone 6 of
ThrobX's eleven, sits exactly on it. A station on the same frequency in fldigi and here is
on the same tones.

Throb is fussy about tuning: at the slow speeds the tones are only 8 Hz apart and each one
lasts a second. The receiver has an AFC. It looks up to half a tone spacing either side
(about 4 Hz at Throb 1 and 2, 8 Hz at Throb 4) and pulls in during the four idle throbs
that start every over, then follows a slow drift. The panel shows how far off the signal
sits; centre it before you reply, so your signal lands where theirs is. A station a whole
tone spacing off reads as the wrong characters, so get within a few hertz.

## Listening

**The squelch.** The quality figure shows how far the throb's tones stand above the noise.
Noise alone reads 0 to 0.05, a signal at the edge of copy 0.15 to 0.3, and a clean one 0.8
or more. Below the squelch (default 0.1) nothing prints.

A received character prints one throb after it arrives, and only if the squelch stayed
open, the throb was clear, and so was the one after it. Every over ends with an idle throb,
so the last character still prints, about a throb late: a second at Throb 1. This is what
stops the noise after an over from printing a letter. On generated band noise, six minutes
in each submode at 12, 24 and 48 kHz printed nothing. Over a strong signal followed by
noise, about one over in forty adds one stray character at the end. Digital silence (a
FlexRadio's DAX between overs is exact zeros) prints nothing.

**ThrobX spaces.** ThrobX has no separate idle: the space and the idle are two throbs that
swap roles each time either one is sent. A run of them prints one space after a word, so a
pause in typing reads as a space and double spaces come out single, as in fldigi. The space
is printed when the next word starts, so a line never ends with one.

**How weak.** Generated signals with white noise, S/N measured in 2.5 kHz, eight runs each:

| Mode | Copies every time | Most words still right |
|------|------------------:|-----------------------:|
| Throb 1 | −17 dB | −20 dB |
| Throb 2 | −14 dB | −17 dB |
| Throb 4 | −10 dB | −13 dB |
| ThrobX 1 | −19 dB | −21 dB |
| ThrobX 2 | −15 dB | −18 dB |
| ThrobX 4 | −12 dB | −15 dB |

ThrobX copies 1 to 2 dB further down than Throb at the same speed, because every ThrobX
throb is a pair. A Throb throb can be one tone or two, and in noise one of a pair can fade
under the other. These are flat-noise figures; a fading path will need more.

## Sending

A line goes out as fldigi sends an over: four idle throbs, the text, and one closing idle.
Lower case goes as capitals. A character the alphabet lacks goes as a space, one for each
byte of an accented letter, as fldigi sends it. In Throb, `?`, `@`, `-` and a newline go as
SHIFT and a letter. In ThrobX the space and idle alternate as fldigi's do. Each throb rises
from nothing and falls back, so there is no click between throbs or at the start and end.

## Not yet

- An on-air test against fldigi. The tables and the transmit sequence are checked against
  tone pairs worked by hand from fldigi's source (`scripts/check-throb.ts`), but nothing has
  been copied off the air yet.
- One deliberate difference: in Throb, fldigi prints `=` for the shifted throb its own
  transmitter sends for `-`. Here it prints `-`, which is what was sent. fldigi has no way to
  send `=` in Throb.
- fldigi's "reverse" (the tone set upside down for lower sideband) is not offered.
