# MFSK

MFSK16 and its family: what the modes are, how fast and how wide, where you hear them, and
what the receiver is doing. The encoder and decoder are in `lib/digital/mfsk.ts` and
`lib/digital/mfskdemod.ts`; the mode chip, the panel and the log are not wired up yet.

MFSK sends one tone at a time out of sixteen (or thirty-two), each a baud apart, and the
text rides on which tone it is. The characters are MFSK Varicode, protected by the same
K=7 convolutional code the Voyager probes use and spread out in time by an interleaver, so
a crash of static or a short fade costs a few scattered bits that the decoder puts back.
It copies through flutter and multipath that leave PSK31 printing junk, and well below the
noise you can hear.

MFSK16 is Nino Porcino IZ8BLY's and Murray Greenman ZL1BPU's design (2000). The figures
below are fldigi's (`src/mfsk/mfsk.cxx`), because fldigi is what the other station runs.

## On the decodes page

Choose **MFSK** in the mode list. MFSK has no calling frequencies; it is worked in the digital
segments, so choosing it decodes where the dial already is (the list marks it "here"), and
it stays chosen while the dial stays within 5 kHz. The panel has the speed picker (MFSK16 to
start) and the ± buttons for the centre; a click on the waterfall centres it on a signal, and
the waterfall marks the centre and the edges of the tones.

Text prints a few seconds after it is sent (about 3.4 s at MFSK16): that is the interleaver,
and fldigi is the same. The exchange bar, F1-F8 and **Log contact** work as in the other
keyboard modes; each speed logs as ADIF MODE=MFSK with its SUBMODE (MFSK16 and so on).

An RSID heard for MFSK8, 11, 16, 22 or 32 switches to that speed at that frequency, and with
**Send RSID before each line** on, yours tells an fldigi station with RxID on which you are in.

## The modes

| Mode | Tones | Baud and spacing | Width | Characters a second | Copies down to |
|------|------:|-----------------:|------:|--------------------:|---------------:|
| MFSK8 | 32 | 7.8 Hz | 242 Hz | about 2 | −12 dB |
| MFSK11 | 16 | 10.8 Hz | 162 Hz | about 2.5 | −14 dB |
| **MFSK16** | 16 | 15.6 Hz | 234 Hz | about 3.5 | −13 dB |
| MFSK22 | 16 | 21.5 Hz | 323 Hz | about 5 | −11 dB |
| **MFSK32** | 16 | 31.25 Hz | 469 Hz | about 7 | −9 dB |

*Width* is from the lowest tone to the highest; the signal is about one spacing wider.
*Characters a second* is for ordinary mixed text: the code carries half a bit per tone bit,
and a character averages about nine bits.
*Copies down to* is the signal-to-noise ratio in 2.5 kHz at which the decoder here reads a
whole line, on generated signals in white noise (check:mfsk and the sweep behind it). Real
fading costs a few dB.

**MFSK16** is the one to call on: slow enough to dig out of the noise, fast enough to chat.
**MFSK32** is twice as fast and needs about 4 dB more signal; it is one of the modes
NBEMS emergency nets use on HF to send flmsg forms. MFSK8 is for very weak
and slow paths, and MFSK11 and MFSK22 are the in-between speeds fldigi offers. Pick the
same mode as the other station: an MFSK16 signal does not read as MFSK32.

## Where it is

MFSK shares the narrow-band digital segments with PSK31, RTTY and Olivia. There is no fixed
calling frequency; tune around the segment for a signal about a quarter of a kilohertz wide
(half that again for MFSK32) that sounds like a slow, burbling tune.

## Tuning

The tone set is centred on the frequency you click, as fldigi centres it: the lowest tone
half the width below, the highest half above. Click the middle of the signal.

The decoder follows the signal once it is copying (the AFC), and pulls in from about two
fifths of a tone spacing off: 6 Hz at MFSK16, 12 Hz at MFSK32. Further off than that it
prints nothing, so click again.

## What the receiver is doing

- **Starting.** A call begins with a second or so of the lowest tone alone, then the text.
  Text appears about three seconds behind the air at MFSK16 (a second and a half at
  MFSK32): the interleaver and the decoder each need that long to see the bits on both
  sides of the one they print.
- **Quality.** The decoder's own measure of how well what it hears fits the code: 0 on
  noise, 1 on a clean signal, 0.2 to 0.35 at the edge of copy. Below the squelch (0.15)
  nothing prints. A minute of band noise prints nothing at all.
- **The end.** A call ends with a few seconds of steady tone while the far end's decoder
  empties; the squelch closes behind it.
- **Carriers.** A steady tone sitting inside the signal (a carrier, a birdie) is noticed
  after a few symbols and ignored, as fldigi does.

## Sending

The transmitter sends what fldigi sends: the preamble, CR STX CR, the text, CR EOT CR, and
the flush, with the level eased up and down over 100 ms so the carrier never clicks. A
newline goes as CR LF. Accented letters go as UTF-8, as fldigi sends them.

## Not yet

- The mode chip, the panel, sending from the page and logging.
- MFSKpic (pictures in MFSK16 and MFSK32), MFSK4, MFSK31 and the fast MFSK64 and MFSK128.
- An on-air test against fldigi. The tones on the air are checked against a sequence
  worked out by hand from fldigi's source, and the receiver against our own transmitter.
