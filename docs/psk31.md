# PSK31

PSK31 on the decodes page: the mode chip, the panel, tuning, sending, and what the decoder
is doing.

## Listening

Press **PSK31** in the mode group. It tunes the radio to the band's PSK31 dial (below),
puts the slice in DIGU, and the decoder listens on a carrier 1000 Hz above the dial, which
is where a 14.070 dial puts the 20 m watering hole. The panel is the one RTTY and CW use: a
terminal of the text as it comes, newest at the bottom, with what the decoder measures
beside it.

| Band | Dial (MHz) | Band | Dial (MHz) |
|------|-----------:|------|-----------:|
| 160 m | 1.838 | 17 m | 18.097 |
| 80 m | 3.580 | 15 m | 21.070 |
| 40 m | 7.070 (Region 2), 7.035 (Regions 1 and 3) | 12 m | 24.920 |
| 30 m | 10.142 | 10 m | 28.120 |
| 20 m | 14.070 | 6 m | 50.290 |

17 m is 18.097: FT8 took 18.100 and the PSK activity moved down. A slice already on one of
these dials decodes PSK31 without the chip, since the inference knows them; a pinned
`digital.mode = psk31` in Settings holds the mode anywhere.

**Tuning.** A PSK31 signal is about 60 Hz wide and the decoder's capture range is a quarter
of the baud rate each way (about 8 Hz at 31.25), so put the carrier on the signal: click it
on the waterfall, or nudge with −10 / +10. Once it is within range the AFC takes it the rest
of the way and the header shows the offset it found. The speed picker chooses BPSK31, 63 or
125; most activity is BPSK31.

**The bars.** *quality* is how consistently the symbols read as a phase or its reverse: near
1 on a signal, near 0.2 on noise, around 0.6 on a weak one. The squelch (`psk31.squelch`,
0.5) is a floor on it: below the floor the decoder keeps tracking but prints nothing, which
is what keeps an empty channel quiet. *level* is the signal at the carrier.

## Sending

A line at a time, Enter sends it: about five characters a second at BPSK31, through the DAX
audio path with the same gate, key, stream and unkey as RTTY. **CQ** and **73** are the two
lines a contact begins and ends with. A line is capped at 40 seconds of air time; a longer
one is refused with "send it in pieces". The transmitter sends on the carrier the decoder
listens on, so what you click is where you transmit. The automatic modes do not run on
PSK31: there are no structured messages to answer.

## How the decoder works

`lib/digital/psk31.ts` is the Varicode table (every code starts and ends with a 1 and never
holds two 0s, so "00" separates characters and the common letters get the short codes), the
bit stream both ways, and the G3PLX-shaped BPSK waveform. `lib/digital/psk31demod.ts` mixes
the audio down with an oscillator at the carrier, decimates to sixteen samples a symbol,
sums over a symbol and reads each symbol as the difference from the one before; timing from
the summed magnitude at each phase, stepped one phase at a time; frequency from the squared
differential products, which fold 0 and π together and leave the error; the quality from
the same products averaged as unit vectors. `scripts/check-psk31.ts` runs it on generated
signals clean, off frequency, in noise to −10 dB and on noise alone; `check-psk31-pipeline`
runs a line through the real pipeline at the FlexRadio's 24 kHz.

## On the air so far

The plumbing, on the station: the chip put the dial on 14.070 and 7.070 with the slice in
DIGU, the decoder streamed with a heartbeat a second, the carrier moved on request, and the
squelch held through twelve minutes of empty passband without printing a character. No
PSK31 station was on either dial at 17:00 UTC on a weekday, so the decoder has read only
the generated signals of its check; the first real one goes in the changelog.

## Not yet

- QPSK31.
- A real-signal report.
