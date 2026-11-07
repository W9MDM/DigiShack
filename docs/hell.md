# Hell

Hellschreiber on the decodes page, in six modes: the mode chip, the painted page, the mode
picker, the North American nets, tuning, sending, and what the receiver is doing. It works
on the FlexRadio and, since 1.280, on the Icom.

Hell is the odd one out among the digital modes. Nothing is decoded. Each character is a
small bitmap, sent one column at a time, and the receiver paints what it hears. You read the
page by eye. Noise shows as specks and a fade as a pale patch, and the text stays readable
through both long after a decoder would print garbage.

## The modes

Every mode paints the same 14-element column from the same font. They differ in speed and
in how an element is keyed. The figures are fldigi's (`src/feld/feld.cxx`), because fldigi
is what the North American nets run.

| Mode | Columns a second | Keying | Width | Used for |
|------|-----------------:|--------|-------|----------|
| Feld Hell | 17.5 | carrier on for ink, off for paper | about 350 Hz | the calling frequencies, most casual Hell |
| FM Hell-105 | 17.5 | FSK, 55 Hz shift, ink on the lower tone | about 110 Hz | **the North American weekly nets** |
| FM Hell-245 | 17.5 | FSK, 122.5 Hz shift | about 250 Hz | |
| Hell 80 | 35 | FSK, 300 Hz shift | about 600 Hz | |
| Slow Hell | 2.1875 | on and off, Feld Hell at an eighth of the speed | about 30 Hz | weak signals |
| PSK Hell | 17.5 | phase reversal at the start of an ink element | about 350 Hz | |

fldigi has no PSK Hell. This one follows hellschreiber.com's description ("an unchanged
phase at the beginning of a pixel means white, and a reversed phase means black") at Feld
Hell's element rate. It has only been checked against itself.

Pick the mode with **Mode** on the panel. The **Tune** buttons on the nets list switch it
for you. `hell.variant` sets the mode the HELL chip starts in.

## Where Hell is

The panel's **Where Hell is** list has these, with the next meeting of each net in your own
time and in UTC. **Tune** sets the mode, then puts the dial one carrier below the signal.

**North American nets** (FM Hell-105, published in Eastern time):

| Net | Signal (MHz) | When (Eastern) | Coordinator |
|-----|-------------:|----------------|-------------|
| Wednesday | 10.1425 (10.1345 if busy) | Wed 20:00 | VA3PC |
| Thursday | 7.0695 | Thu 21:00 | VA3PC |
| Friday | 3.585 | Fri 21:45 | KD8WCK |

7.0695 is outside the Region 2 narrow-band segment (7.040-7.047). It is listed because it is
where the net meets.

**Feld Hell calling frequencies** (Feld Hell Club):

| Band | Dial (MHz) | Signal (MHz) |
|------|-----------:|-------------:|
| 80 m | 3.584 | 3.585 |
| 40 m | 7.083 | 7.084 |
| 30 m | 10.143 | 10.144 |
| 20 m | 14.062 | 14.063 |
| 17 m | 18.104 | 18.105 |
| 15 m | 21.062 | 21.063 |
| 10 m | 28.062 | 28.063 |
| 6 m | 50.285 | 50.286 |

160 m and 12 m are left out because the club's frequencies there now sit on the FT8, FT2 and
JS8 dials. 14.063 is below the Region 2 narrow-band segment (14.070-14.099). It is kept
because it is the club's calling frequency, where Feld Hell activity is.

A Hell signal takes a few hundred hertz, not the whole segment. A band-plan segment is room
for many narrow stations; you sit on one frequency and move a little if it is busy.

## Listening

Press **HELL** in the mode group. It tunes the radio to the band's Hell dial and puts the
slice in DIGU. The receiver listens on a carrier 1000 Hz above the dial.

**Tuning.** Click the signal on the waterfall, or nudge with −10 / +10. On and off and PSK:
put the carrier between the two edge markers. FSK: the markers are the two tones, ink below
and paper above; put the signal's tones on them. A station 60 Hz off still paints in Feld
Hell; FSK wants to be within about 10 Hz.

**The page.** Each column is painted twice, one copy above the other. The two stations'
clocks are not the same, so a character can start part way up a column; between the two
copies there is always a whole one. Read whichever copy is complete. Lines that slope mean
the clocks differ, and the text still reads.

**The level.** On and off: the peak over the noise floor in dB. FSK and PSK: how steadily the
carrier's phase moves, put on the same scale. Noise alone reads under 17 dB in every mode;
anything over 18 dB is reported as a signal. Without a signal the FSK and PSK page is drawn
pale, so noise does not fill it with snow.

On generated signals at 24 kHz (check:hell), every mode paints 94-100% of the elements right
when clean, and 94-100% at 0 dB S/N in 2.5 kHz.

## Sending

A line at a time, and Enter sends it. Feld Hell and FM Hell run at 2.5 characters a second,
Hell 80 at 5 and Slow Hell at about one every three seconds. Lowercase goes out as capitals.
The line goes through the same gate, key, stream and unkey as RTTY and PSK31. A line longer
than 40 seconds of air (two minutes in Slow Hell) is refused before anything keys. **CQ** and
**73** send the usual lines with your callsign.

On the Icom the receiver is not fed while the radio transmits, because the Icom hears its
own signal and would paint it.

## Settings

| Key | Default | What it does |
|-----|---------|--------------|
| `hell.variant` | feld | The Hell mode the chip starts in |
| `hell.centreHz` | 1000 | Where the receiver paints and the transmitter keys, Hz above the dial |
| `digital.mode` | auto | `hell` holds the mode anywhere on the FlexRadio, not only on the dials above |

## Not yet

- A slant control to straighten lines from a station whose clock is off.
- Logging a contact from the panel: Hell is logged as mode HELL, by hand.
- Printing to a receipt printer, as the original machines printed to tape.
- An on-air test against a real station in any mode.
