# Thor

Thor in ten speeds: what it is, the submodes, tuning, what the receiver does, and sending.
The modem follows fldigi 4.2.13 (`src/thor/`), because fldigi is what nearly every Thor
station runs. The encoder and decoder are in `lib/digital/thor.ts` and
`lib/digital/thordemod.ts`; the mode chip, the panel and the log are not wired up yet.

Thor is DominoEX with error correction. It sends DominoEX's 18 tones the same way: the
data is the step from one tone to the next, not the tone itself. So, as in DominoEX:

- **Tuning hardly matters.** A station tens of hertz off still prints, and slow drift does
  no harm.
- **No tone ever repeats.** An echo of the last symbol cannot be mistaken for this one, so
  multipath and flutter do less damage than in PSK31.

What is new is underneath. The text is protected by a convolutional code and spread over
many symbols by an interleaver, as in MFSK16, so a static crash or a short fade costs
scattered bits that the decoder puts back. The cost is speed: at the same baud, Thor sends
text at half DominoEX's rate.

Thor is Dave Freese W1HKJ's design (2008), with John Douyere VK2ETA and John Phelps
KL4YFD. NBEMS (flmsg and friends) uses Thor 22 and Thor 11 for messages.

## On the decodes page

Choose **THOR** in the mode list. Like DominoEX it has no calling frequencies, so choosing it
decodes where the dial already is (the list marks it "here"), and it stays chosen while the
dial stays within 5 kHz. The panel has the speed picker (Thor 16 to start; Thor 22 is common
on NBEMS) and the ± buttons for the centre; a click on the waterfall centres it on a signal.

Text prints a few seconds after it is sent (2.4 s at Thor 22, up to 13 s at Thor 4): the
interleaver, as in fldigi. The exchange bar, F1-F8 and **Log contact** work as in the other
keyboard modes; each speed logs as ADIF MODE=THOR with its SUBMODE (THOR16, THOR25X4 and so
on). RSID both ways; the fast modes' codes go after an ESCAPE, as fldigi sends them.

## The submodes

| Mode | Baud | Tone spacing | Width | Characters a second, lower case | Text lags the audio by |
|------|-----:|-------------:|------:|--------------------------------:|-----------------------:|
| Thor 4 | 3.91 | 7.8 Hz | 141 Hz | about 1.5 | 13 s |
| Thor 5 | 5.38 | 10.8 Hz | 194 Hz | about 2 | 10 s |
| Thor 8 | 7.81 | 15.6 Hz | 281 Hz | about 3 | 7 s |
| Thor 11 | 10.77 | 10.8 Hz | 194 Hz | about 4 | 5 s |
| Thor 16 | 15.63 | 15.6 Hz | 281 Hz | about 6 | 3.4 s |
| **Thor 22** | 21.53 | 21.5 Hz | 388 Hz | about 8.5 | 2.4 s |
| Thor 25x4 | 25 | 100 Hz | 1800 Hz | about 10 | 10 s |
| Thor 50x1 | 50 | 50 Hz | 900 Hz | about 20 | 5 s |
| Thor 50x2 | 50 | 100 Hz | 1800 Hz | about 20 | 5 s |
| Thor 100 | 100 | 100 Hz | 1800 Hz | about 40 | 2.4 s |

Thor 4 to 22 keep DominoEX's speeds and spacing. In 4, 5 and 8 the tones are two baud apart,
and in 25x4 four baud apart. The 11025 Hz rates come from fldigi working those modes at
that sample rate. The slow modes use the NASA K=7 code, the one MFSK uses, with a
10-stage interleaver. The fast ones (25x4 to 100, VK2ETA's, meant for ARQ) use a stronger
K=15 code with a 50-stage interleaver, about two seconds at 25 baud.

The lag is the interleaver plus the decoder's look-back. fldigi has the same lag. The text
of an over finishes printing that long after the signal stops, so leave the receiver
listening.

Capitals and digits take more bits than lower case, so a callsign is slower than the
figures above.

## Tuning

The frequency is the **centre** of the tone set, as in fldigi: tones 8 and 9 sit half a
spacing either side of it. A station on the same centre in fldigi and here is on the same
tones.

The receiver searches the tone set plus nine tones either side. In Thor 22 that is about
190 Hz each way; in Thor 11 about 100 Hz. A station anywhere in that window prints. The
receiver reports how far off the signal sits, so you can centre it before replying.

## Listening

**The squelch.** The quality figure is the decoder's own measure of how well the received
bits fit the code. Noise alone reads under 0.1 and a clean signal near 1. Below the squelch
(default 0.15) nothing prints. On a minute of generated band noise in each of several
submodes, nothing printed. A character prints only if its own bits read as signal, which
stops the noise after an over printing a letter or two.

**Between overs.** The interleaver means the last second or so of an over is only partly
sent, and the first bits out of the receiver are partly whatever came before. Both decode
as a line of confident junk; fldigi prints it. Here the receiver goes quiet at the end of
an over (the EOT fldigi sends, or the signal stopping) and starts again at the next over's
preamble. If you tune in partway through an over, printing starts after a few clean
characters.

**Framing.** fldigi starts each over with CR, STX, CR and ends it with CR, EOT, CR. These
control characters are not printed. Between characters fldigi sends secondary text,
usually its version string. That goes to a separate field, not the conversation.

**How weak.** Generated signals with white noise, S/N measured in 2.5 kHz, at a 12 kHz
sample rate:

| Mode | Copies every time | DominoEX at the same speed |
|------|------------------:|---------------------------:|
| Thor 4 | −18 dB | −15 dB |
| Thor 5 | −16 dB | −13 dB |
| Thor 8 | −15 dB | −12 dB |
| Thor 11 | −13 dB | −10 dB |
| Thor 16 | −12 dB | −8 dB |
| Thor 22 | −9 dB | −7 dB |
| Thor 25x4 | −10 dB | |
| Thor 50x1 | −6 dB | |
| Thor 50x2 | −7 dB | |
| Thor 100 | −3 dB | |

"Every time" is a 38-character line with nothing missing and nothing extra, three noise
seeds in three. The code has a sharp edge: a dB or two below these figures copy stops
altogether rather than getting gradually worse. These are flat-noise figures; a fading path
will need more. Against DominoEX you get 2 to 4 dB in exchange for half the text speed.
A burst that wrecks one symbol in fifteen still prints perfectly.

## Sending

A line goes out as fldigi sends an over. It starts with a preamble of 16 symbols climbing
the tones in steps of two, which tells the far end to clear its decoder. Then an idle
character, CR STX CR, the text, CR EOT CR, and idles to push the last bits through the far
end's interleaver: 4 in Thor 4 to 8, 8 in 11 and 16, 16 in 22, and 40 in the fast modes. A
newline goes as CR LF, and accented letters go as UTF-8, as fldigi sends them.

The audio matches fldigi's default settings. The level rises over the first ~100 ms, each
symbol has 4 ms rounded edges, and the over ends with the lowest tone fading out. The
tones are continuous in phase from one symbol to the next.

The RSID codes fldigi uses are 136 (Thor 4), 139 (Thor 5), 137 (Thor 8), 143 (Thor 11),
138 (Thor 16) and 145 (Thor 22). The fast modes are in fldigi's second RSID table: 639
(25x4), 649 (50x1), 653 (50x2) and 658 (100).

## Not yet

- An on-air test against fldigi. The tones, the code and the Varicode are checked
  against sequences worked by hand from fldigi's source (`scripts/check-thor.ts`), but
  nothing has been copied off the air yet.
- Sending secondary text while idle, and showing the secondary text received (the decoder
  collects it).
- Thor Micro, 25, 32, 44 and 56, and Thor's picture modes.
