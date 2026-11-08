# PSK: every speed, and QPSK

BPSK31 is [its own page](psk31.md): the chip, the panel, the dials, sending. This page is
the rest of the family: the faster BPSK speeds, QPSK, and what changes between them. All of
them are fldigi's modes bit for bit, so a station on fldigi copies DigiShack and the other
way round.

## Choosing one

On the PSK31 panel, the speed picker has BPSK31, 63, 125, 250 and 500 and QPSK31, 63 and 125.
The choice holds for the session; Settings has the speed it starts at. Each logs as ADIF
MODE=PSK with its own SUBMODE (PSK250, QPSK63 and so on), and each has fldigi's RSID code,
so an RSID heard for any of them switches to it, and yours names it.

## The speeds

| Mode | Baud | Width on the waterfall | Typing speed | Preamble / postamble |
|------|-----:|-----------------------:|-------------:|---------------------:|
| BPSK31 | 31.25 | about 60 Hz | about 5 characters a second | 32 symbols, 1.0 s |
| BPSK63 | 62.5 | about 120 Hz | about 10 | 64 symbols, 1.0 s |
| BPSK125 | 125 | about 250 Hz | about 20 | 128 symbols, 1.0 s |
| BPSK250 | 250 | about 500 Hz | about 40 | 256 symbols, 1.0 s |
| BPSK500 | 500 | about 1 kHz | about 80 | 512 symbols, 1.0 s |
| QPSK31 | 31.25 | about 60 Hz | about 5 | as BPSK31 |
| QPSK63 | 62.5 | about 120 Hz | about 10 | as BPSK63 |
| QPSK125 | 125 | about 250 Hz | about 20 | as BPSK125 |

Each speed doubles the last and halves the time a character takes. The width doubles too,
and so does the noise a receiver lets in, so each step up needs about 3 dB more signal for
the same copy. BPSK31 is where the activity is. BPSK63 and 125 are common in contests.
BPSK250 and 500 are for strong, short-range paths and for moving a lot of text.

Every transmission starts with a second of reversals (the two-tone idle you see on the
waterfall) so the far end can lock on before the first character. BPSK ends with a second
of steady carrier and QPSK with a second of reversals, as fldigi does.

## QPSK

QPSK sends the same characters at the same speed in the same width as BPSK, but adds
error correction. Each bit goes through a small convolutional code (constraint length 5,
G3PLX's design). The code's two output bits pick one of four phase changes instead of
two. The receiver runs a Viterbi decoder over the phases and corrects the odd wrong
symbol, which BPSK prints as a wrong or missing character.

**What it buys.** On generated signals in white noise, at the default squelch, QPSK copies
about 2 dB below where BPSK starts dropping characters. At −9 dB in 2.5 kHz, BPSK31 dropped
9 characters in 495 and QPSK31 none. At −3 dB, BPSK125 dropped 20 and QPSK125 none. It does
better still against short bursts of interference, which is what the code was designed for.

**What it costs.**
- *Tuning is twice as tight.* QPSK's four phases leave the AFC half the room BPSK has:
  about 4 Hz each way at QPSK31 and 16 Hz at QPSK125, where BPSK has 8 and 31. The AFC
  pulls in from further only during the preamble, up to about half the baud. A click
  that lands mid-over has to be closer.
- *Characters print about 30 symbols late:* about a second at QPSK31 and a quarter of
  a second at QPSK125. The decoder looks ahead before it commits a bit. The last
  character still prints before the carrier drops, because the postamble covers it.
- *Both ends must agree on sideband.* BPSK does not care if the audio is mirrored.
  QPSK does: a QPSK signal heard on the wrong sideband, or sent by a station with
  fldigi's **Rev** set, prints nothing useful. The receiver's *reverse* option is the
  same as fldigi's Rev. Set it when a QPSK signal is clearly there, with good quality,
  but prints nothing.

## Tuning and the squelch, at any speed

Put the carrier on the signal: click it on the waterfall. The AFC finds the exact spot and
the header shows how far it moved, up to one baud each way. At the faster BPSK speeds a
click can be well off, since the signal is wide. BPSK500 pulls in from 180 Hz away.

*quality* means the same thing at every speed and in both modes: near 1 on a good signal,
near 0 to 0.2 on noise. The same squelch setting (`psk31.squelch`, 0.5) does the same job
everywhere. For BPSK it is how consistently the symbols read as a phase or its reverse.
For QPSK it is how well the symbols fit the error-correcting code, which tells a weak
signal from noise far better than the phases alone can.

As in fldigi, BPSK's preamble opens the squelch as soon as sixteen reversals have been
heard. A steady carrier closes it after about 21 symbols, so the noise after a station
stops prints nothing.

## What the decoder does differently by speed

At the radio's sample rate (24 kHz on the FlexRadio, 48 kHz on an Icom, 12 kHz in tests)
the decoder samples each symbol at sixteen points to find the timing. At 500 baud and
12 kHz it uses twelve points, because a symbol is only 24 samples long. QPSK's matched
filter weights the middle of each symbol more heavily than BPSK's plain sum does. That
keeps the quarter-turn neighbours from twisting the phase, at a cost of 0.15 dB.

`lib/digital/psk31.ts` (the code and the waveform), `lib/digital/qpsk.ts` (the
convolutional code and the Viterbi decoder) and `lib/digital/psk31demod.ts` (the
receiver) are the code. `scripts/check-pskx.ts` runs every speed at all three sample
rates, in odd chunk sizes, off frequency, in noise and on a minute of noise alone. It
checks the code against outputs worked out by hand from fldigi's encoder.
