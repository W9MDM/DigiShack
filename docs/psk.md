# PSK: every speed, and QPSK

BPSK31 is [its own page](psk31.md): the chip, the panel, the dials, sending. This page is
the rest of the family: the faster BPSK speeds, QPSK, and what changes between them. All of
them are fldigi's modes bit for bit, so a station on fldigi copies DigiShack and the other
way round.

## Choosing one

On the PSK31 panel, the speed picker has BPSK31, 63, 125, 250 and 500, QPSK31, 63 and 125, and
PSK63F, PSK125R, PSK250R and PSK500R.
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
4 characters in 495 and QPSK31 none. At −3 dB, BPSK125 dropped 15 and QPSK125 none. It does
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

## PSK-R

PSK-R is fldigi's error-corrected BPSK: PSK125R, PSK250R and PSK500R. On the waterfall
it looks exactly like BPSK at the same baud and takes the same width. Underneath, the
text goes as MFSK16's Varicode, through a strong convolutional code (constraint length 7,
the NASA code MFSK uses), and through an interleaver that spreads each pair of code bits
over two-thirds of a second. The receiver runs a Viterbi decoder. PSKmail uses it, as it
gets text through on paths where BPSK prints junk.

| Mode | Baud | Width | Typing speed | Interleaver | Preamble / postamble | fldigi RSID |
|------|-----:|------:|-------------:|------------:|---------------------:|------------:|
| PSK63R | 62.5 | about 120 Hz | about 5 | 20 | 128 symbols, 2 s | none |
| PSK125R | 125 | about 250 Hz | about 10 | 40 | 256 symbols, 2 s | 183 |
| PSK250R | 250 | about 500 Hz | about 20 | 80 | 512 symbols, 2 s | 186 |
| PSK500R | 500 | about 1 kHz | about 40 | 160 | 1024 symbols, 2 s | 187 |

**PSK63R is not an fldigi mode.** fldigi has PSK125R, 250R and 500R as single carriers,
and PSK63R only as a multi-carrier family (4 to 32 carriers). PSK63R here continues the
series downward the way fldigi's source describes it (an interleaver of depth 20). It
works between two DigiShack stations, not with fldigi. fldigi's 63-baud error-corrected
mode is **PSK63F** (Multipsk's design, RSID 22): the same code with no interleaver. The
picker offers PSK63F, not PSK63R, so the 63-baud choice copies with fldigi; PSK63R stays in
the code (`pskrDepth: 20` at speed 63) for DigiShack to DigiShack.

**What it buys.** On generated signals in white noise, with the AFC off on both so only the
codes are compared, PSK-R holds under 1% character errors 5 to 6 dB below where BPSK at the
same baud does:

| Baud | BPSK copies to | PSK-R copies to |
|-----:|---------------:|----------------:|
| 62.5 | −7 dB | −12 dB |
| 125 | −4 dB | −9 dB |
| 250 | 0 dB | −6 dB |
| 500 | +3 dB | −3 dB |

(S/N in 2.5 kHz, 5 runs of 99 characters each.) The interleaver is there for fades and
bursts of noise, which these figures do not measure.

**What it costs.**
- *Half the typing speed* of BPSK at the same baud: every bit is sent twice over.
- *Characters print late:* about 2 seconds at PSK125R, 1.3 at PSK250R, 1 at PSK500R and
  3.3 at PSK63R. The de-interleaver holds each bit for as long as the interleaver spread
  it, and the decoder looks ahead 84 bits. The two-second postamble pushes the last character out before the carrier
  drops, at every fldigi speed. At PSK63R the postamble is shorter than the delay; the
  last few characters come out of whatever audio follows (noise or silence both do it).
- *A new signal takes a few seconds to print.* Nothing prints until the bits from the
  start of the transmission have come through the de-interleaver.

**The receiver.** As fldigi does, it decodes every signal two ways at once, because a
receiver cannot tell which of two symbols starts a code pair. Both decoders run all the
time and the one whose path fits the code better prints. The quality is the same phase
measure BPSK uses, averaged over a second or more instead of a fraction of one, so a
signal at the copy threshold reads well above noise and the default squelch (0.5) holds
on a minute of noise without printing a character. The squelch's decision is kept for
the two seconds a bit takes to come through, so a character prints if the squelch was
open when it was sent. The long steady carrier that ends every PSK-R transmission closes
the squelch for everything after it, so the noise after an over prints nothing.

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

`lib/digital/pskr.ts` is PSK-R's code, interleaver, decoders and squelch, and
`scripts/check-pskr.ts` checks it the same way: the encoder against bits worked by hand
from fldigi's, every PSK-R speed at all three rates, noise against BPSK, a minute of noise
alone, and silence and noise after a line.
