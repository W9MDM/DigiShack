# FSQ

FSQ in five speeds: what it is, the speeds, tuning, what the receiver prints, and sending.
The modem follows fldigi 4.2.13 (`src/fsq/`), because fldigi is what nearly every FSQ
station runs. The encoder and decoder are in `lib/digital/fsq.ts` and
`lib/digital/fsqdemod.ts`; the mode chip, the panel and the log are not wired up yet.

FSQ ("Fast Simple QSO") is Murray Greenman ZL1BPU and Con Wassilieff ZL2AFP's chat mode
for NVIS and the low bands, built to keep going through the fading, flutter and noise
that stops PSK31. It sends one of 33 tones at a time, and the data is the step from one
tone to the next, not the tone itself:

- **Tuning hardly matters.** Only the steps are read, so a station tens of hertz off still
  prints and slow drift does no harm.
- **The tone always moves.** Every symbol steps at least one tone, so the receiver never
  has to tell two of the same symbol apart.

There is no error correction. A noise burst costs a character or two.

Text only: FSQ's image transfer and its directed-message commands (the `?`, `#`, `$`, `&`
triggers that make fldigi answer automatically) are not supported. What arrives is printed
as it arrives, header and all.

## On the decodes page

Choose **FSQ** in the mode list: it decodes where the dial is (marked "here") and holds while
the dial stays within 5 kHz. Speed picker (FSQ 4.5 to start, as fldigi), centre ±, click the
waterfall to centre on a signal. Each over you send starts with your callsign and a colon,
as fldigi sends it: that is how FSQ stations see who is talking.

The exchange bar and **Log contact** work as in the other keyboard modes; FSQ logs as ADIF
MODE=MFSK SUBMODE=FSQCALL. fldigi has no RSID code for FSQ, so none is sent or recognised.

## The speeds

| Speed | Baud | Tone spacing | Width | Copies every time | Most characters still right |
|-------|-----:|-------------:|------:|------------------:|----------------------------:|
| FSQ 1.5 | 1.46 | 8.8 Hz | 290 Hz | −17 dB | −18 dB |
| FSQ 2 | 1.95 | 8.8 Hz | 290 Hz | −15 dB | −17 dB |
| FSQ 3 | 2.93 | 8.8 Hz | 290 Hz | −13 dB | −15 dB |
| FSQ 4.5 | 3.91 | 8.8 Hz | 290 Hz | −13 dB | −14 dB |
| FSQ 6 | 5.86 | 8.8 Hz | 290 Hz | −11 dB | −12 dB |

The names are FSQCALL's nominal speeds; the true rates are fldigi's 12000 Hz sample rate
over a symbol of 8192, 6144, 4096, 3072 or 2048 samples. The tones are the same at every
speed. fldigi starts at 4.5; 3 and 4.5 are what most FSQ nets use, and 6 is for a good path.

A lower-case letter is one symbol; a capital, a digit or most punctuation is two. That is
why FSQ is usually typed in lower case.

The S/N figures are for generated signals in white noise, measured in 2.5 kHz, ten overs at
each level. A fading path needs more.

## Tuning

The frequency is the one fldigi shows: the tone set sits around it, on fldigi's fixed grid
of 8.789 Hz steps, with the middle tone 1.5 to 10 Hz below it. On 1500 Hz the tones run
from 1353.5 to 1634.8 Hz. fldigi starts FSQ on 1500 Hz, and most stations stay there.

The receiver looks across the tone set and eight tones either side, about 70 Hz each way.
A station anywhere in that window prints, and the receiver reports how far off it sits.

## Listening

**What an over looks like.** fldigi starts every over with a space and a new line, then the
sending station's call and a colon, then the text, then a new line:

```
kc9qrs:cq cq de kc9qrs em48
```

In fldigi's directed mode (off by default) two hex digits follow the colon - a checksum of
the callsign, so a receiver can tell a real header from noise - and the over ends with
space, space, backspace, space, space instead of a new line. Those print as sent: the two
digits stay after the colon, and the backspace ends the line.

**The squelch.** The quality figure shows how far the strongest tone stands above the rest.
Noise alone reads under 0.1, a signal that copies every time 0.5 to 0.65, a clean one 1.
Each character is judged on the symbols around it, not on a running average, so an over's
first character prints even though the preamble is only three symbols long. Below the
squelch (default 0.2) nothing prints. On generated noise, six minutes in each speed at 24 and
48 kHz printed nothing, and four seconds of digital silence after an over printed nothing.

A received character prints three symbols after it arrives (it is read a symbol late, so
the timing has seen past it, and judged two symbols later): about 2 s at FSQ 1.5, half a
second at FSQ 6.

## Sending

A line goes out as fldigi sends an over: a space, a space and a new line, your call and a
colon, the text, then a new line and a space so the far end prints the last character.
The checksum and the backspace ending are sent only in directed mode. A new line goes as a
single LF, as fldigi wants; the Varicode has no CR. The five Latin-1 signs it has (£ ° ± × ÷)
are sent; any other character it has no code for is left out. The tones are continuous in
phase from one symbol to the next, and the start and end are ramped over 4 ms so the
key-up does not click.

**RSID.** fldigi has no RSID code for FSQ, so none is sent or recognised.

**The log.** ADIF has FSQ as FSQCALL, a submode of MFSK: MODE=MFSK SUBMODE=FSQCALL, whatever
the speed.

## Not yet

- An on-air test against fldigi. The tone arithmetic, the tone frequencies and the Varicode
  are checked against fldigi's source (`scripts/check-fsq.ts`), but nothing has been copied
  off the air yet.
- Image transfer, and the directed-message commands and automatic replies.
