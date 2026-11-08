# RSID: knowing which mode a station is in

RSID is the two-second burst fldigi sends before a transmission to name its mode and mark
its frequency: fifteen tones, 10.8 Hz apart, under the signal that follows. A station with
RxID on hears it and switches to that mode at that frequency by itself. DigiShack hears and
sends the same burst, ported from fldigi 4.2.13.

## Hearing one

In RTTY, CW, PSK, Olivia, Contestia and the Hell modes, DigiShack listens for an RSID
across the whole passband, not just where the decoder is set. The line above the
exchange bar says what was last heard:

> RSID heard Olivia 8/250 at 1502 Hz, 12 s ago · switched to it

**When heard** decides what happens:

| Setting | What it does |
|---------|--------------|
| switch to it (default) | The decoder goes to that mode, size or speed, and that frequency. If it is another mode (PSK while on Olivia), the mode changes where the dial is, as the mode picker changes it. CW moves the dial so the signal sits on your pitch. |
| just show it | Shown, with a **Switch to it** button. |
| ignore | Not listened for. |

A mode DigiShack does not have yet (MT63, Thor, MFSK, DominoEX and so on) is shown by name
and not switched to. Your own RSID is never obeyed, nor is anything heard while you
transmit.

The frequency is the signal's within about 2.5 Hz: closer than PSK31's AFC needs.

## Sending one

**Send RSID before each line** puts the burst in front of each line in RTTY (45, 50 and
75 baud at fldigi's shifts), PSK31/63/125, every Olivia and Contestia size, Feld Hell, FM
Hell-105 and -245, and Hell 80. It adds 2.3 s to each line; the Hell page starts painting
your line when the line itself starts. Off by default, as in fldigi.

No RSID goes out for CW, JTTY, Slow Hell or PSK Hell: fldigi has no code for them (its PSK
Hell code is a different mode from DigiShack's).

Both switches are in Settings too (`rsid.receive`, `rsid.transmit`) as the starting values;
the ones on the decodes page last until the radio service restarts.

## How it works

`lib/digital/rsid.ts`: each mode number is spread over fifteen 4-bit symbols by a
Reed-Solomon (15,3) code, so any two modes differ in at least 13 of the 15 tones and one
tone lost to fading still identifies the mode. The receiver brings the audio to 11025
samples a second (fldigi's rate), takes a 2048-point FFT every 512 samples, remembers which
of the 16 tone positions is loudest above every bin, and reads a word every symbol.
`check:rsid` covers the code, the burst, hearing it at 12, 24 and 48 kHz, under noise
and beside another carrier, two minutes of noise naming nothing, the second table after
ESCAPE, and a receiving pipeline hearing an RSID and printing the line after it.
