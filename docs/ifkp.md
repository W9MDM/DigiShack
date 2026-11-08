# IFKP

IFKP in three speeds: what it is, the speeds, tuning, what the receiver prints, and sending.
The modem follows fldigi 4.2.13 (`src/ifkp/`), because fldigi is the program that has it.
The encoder and decoder are in `lib/digital/ifkp.ts` and `lib/digital/ifkpdemod.ts`; the
mode chip, the panel and the log are not wired up yet.

IFKP (incremental frequency keying, "plus") is ZL1BPU and ZL2AFP's keyboard mode built on
the same keying as FSQ: 33 tones, and the data is the step from one tone to the next, not
the tone itself. So, as in FSQ and DominoEX:

- **Tuning hardly matters.** Only the steps are read, so a station tens of hertz off still
  prints and slow drift does no harm.
- **The tone always moves.** Every symbol steps at least one tone.

Where FSQ is a chat mode with callsign headers and automatic replies, IFKP is a plain
keyboard mode like PSK31: what you type goes out, with nothing added. There is no error
correction. Image and avatar transfer are not supported.

## On the decodes page

Choose **IFKP** in the mode list: it decodes where the dial is (marked "here") and holds while
the dial stays within 5 kHz. Speed picker (IFKP 1.0 to start), centre ±, click the waterfall
to centre on a signal.

There is no exchange bar or Log contact for IFKP: ADIF has no name for it, and LoTW, eQSL and
the other services refuse a contact under a mode they do not know (JTTY is the same). RSID
both ways, with fldigi's one code for IFKP (heard as IFKP 1.0).

## The speeds

| Speed | Baud | Tone spacing | Width | Copies every time | Most characters still right |
|-------|-----:|-------------:|------:|------------------:|----------------------------:|
| IFKP 0.5 | 1.95 | 11.7 Hz | 386 Hz | −14 dB | −17 dB |
| IFKP 1.0 | 3.91 | 11.7 Hz | 386 Hz | −12 dB | −14 dB |
| IFKP 2.0 | 7.81 | 11.7 Hz | 386 Hz | −10 dB | −12 dB |

fldigi calls them "1/2 speed", "1x speed" and "2x speed", and starts at 1x. They come from
fldigi working IFKP at 16000 Hz with a symbol of 4096 samples, doubled or halved. The tones
are the same at every speed.

A lower-case letter or a space is one symbol; a capital, a digit or most punctuation is two,
and a new line is two. fldigi converts your call to lower case in IFKP macros for that
reason.

The S/N figures are for generated signals in white noise, measured in 2.5 kHz, ten overs at
each level. A fading path needs more.

## Tuning

fldigi holds IFKP on 1500 Hz unless "IFKP frequency lock" is turned off, so nearly every
IFKP signal sits on the same tones: 1308.6 to 1683.6 Hz, the middle one on 1496.1. With the
lock off, the frequency is the one fldigi shows and the tones sit around it the same way.

The receiver looks across the tone set and eight tones either side, about 94 Hz each way.
A station anywhere in that window prints, and the receiver reports how far off it sits.

## Listening

**The squelch.** The quality figure shows how far the strongest tone stands above the rest.
Noise alone reads under 0.1, a signal that copies every time 0.5 to 0.65, a clean one 1.
Each character is judged on the symbols around it, not on a running average. Below the
squelch (default 0.2) nothing prints. On generated noise, six minutes in each speed at 24 and
48 kHz printed nothing, and four seconds of digital silence after an over printed nothing.

A received character prints three symbols after it arrives (it is read a symbol late, so the
timing has seen past it, and judged two symbols later): about 1.5 s at IFKP 0.5, 0.4 s at
IFKP 2.0.

IFKP's idle between characters is a code that prints nothing, so a pause in typing at the
far end is silent here too.

## Sending

A line goes out as fldigi sends an over: two idle symbols, the text, and one idle so the far
end prints the last character. A new line goes as IFKP's two-symbol LF. The five Latin-1
signs the Varicode has (£ ° ± × ÷) are sent; any other character it has no code for is left
out. The tones are continuous in phase from one symbol to the next, and the start and end are
ramped over 4 ms so the key-up does not click.

**RSID.** fldigi's RSID code for IFKP is 1171, in its second table. It names the mode, not the
speed.

**The log.** ADIF has no IFKP mode or submode.

## Not yet

- An on-air test against fldigi. The tone arithmetic, the tone frequencies and the Varicode
  are checked against fldigi's source (`scripts/check-ifkp.ts`), but nothing has been copied
  off the air yet.
- Image and avatar transfer.
