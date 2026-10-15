# Olivia

Olivia on the decodes page: the mode chip, the panel, the size, tuning, sending, and what
the decoder is doing.

## Listening

Press **OLIVIA** in the mode group. It tunes the radio to the band's Olivia dial (below),
puts the slice in DIGU, and the decoder listens for a tone set centred 1500 Hz above the
dial - which is where the published centre frequencies put it: the 20 m convention of
14.0725 is a 14.071 dial. The panel is the one RTTY, CW and PSK31 use: a terminal of the
text as it comes, newest at the bottom, with what the decoder measures beside it.

| Band | Dial (MHz) | Band | Dial (MHz) |
|------|-----------:|------|-----------:|
| 80 m | 3.581 | 17 m | 18.1035 |
| 40 m | 7.071 | 15 m | 21.071 |
| 30 m | 10.141 | 12 m | 24.921 |
| 20 m | 14.071 | 10 m | 28.121 |

A slice already on one of these dials decodes Olivia without the chip, since the
inference knows them; a pinned `digital.mode = olivia` in Settings holds the mode
anywhere.

**The size.** Olivia comes in sizes, bandwidth/tones: 500/16 and 1000/32 are what the air
mostly runs, 250/8 and 500/8 for narrow or fast, 1000/16 and 2000/64 for the rest. The
picker in the panel changes it for the session; `olivia.tones` and `olivia.bandwidth` are
what the bridge starts with. The size must match the station you are listening to - a
500/16 signal is not readable as 1000/32.

**Tuning.** Click the signal's centre on the waterfall, or nudge with −10 / +10. The
synchroniser searches eight tone-spacings either way (125 Hz at 500/16) and the header
shows the offset it found, so a signal within that margin reads without a click. The
waterfall marks the centre and both edges of the tone set.

**Blocks.** Olivia is coded in blocks of 64 symbols - two seconds at 500/16 - carrying
four or five characters each, and the decoder prints a block only when it is sure of the
sync and of the block itself, a few blocks after the signal starts. The *S/N* bar is the
synchroniser's signal over noise (noise alone reads about 3, a readable signal 6 and up);
`olivia.threshold` (4) is the floor below which nothing prints. The *sync* bar is whether
it is printing.

## Sending

A line at a time, Enter sends it: about two characters a second at 500/16, through the
DAX audio path with the same gate, key, stream and unkey as RTTY, with one idle block
before the text and one after, as fldigi sends it, so the far end syncs and knows the
end. **CQ** and **73** are the two lines a contact begins and ends with. A line is capped
at 40 seconds of air time; a longer one is refused with "send it in pieces". The
transmitter sends on the centre the decoder listens on. The automatic modes do not run
on Olivia: there are no structured messages to answer.

## How the decoder works

`lib/digital/olivia.ts` is the parameters, Gray code, the fast Hadamard transforms, the
block code both ways (each character a 64-element Walsh function, scrambled, spread one
bit per symbol with the tone bit rotating) and the Hann-shaped overlapped MFSK waveform,
ported from Pawel Jalocha's reference as carried in fldigi. `lib/digital/oliviademod.ts`
takes a windowed FFT twice a symbol, turns the tone energies into soft bits, and runs a
decoder for every slice, frequency offset and block phase, filtering each one's signal
and noise over four blocks; the largest filtered signal is the sync, and half a block
after it that decoder's block is printed when its signal over noise clears the threshold
and so does the block's own. `scripts/check-olivia.ts` runs it on generated signals in
three sizes at both radios' rates, off frequency, in noise to −10 dB and on noise alone;
`check-olivia-pipeline` runs a line through the real pipeline at the FlexRadio's 24 kHz.

## Not yet

- Contestia and RTTYM, the same engine with other alphabets.
- A real-signal report: see the changelog for what 20 m did.
