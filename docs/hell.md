# Feld Hell

Feld Hell (Hellschreiber) on the decodes page: the mode chip, the painted page, tuning,
sending, and what the receiver is doing.

Hell is the odd one out among the digital modes. Nothing is decoded. Each character is a
small bitmap, sent one column at a time by switching a single carrier on and off, and the
receiver paints what it hears. You read the page by eye. Noise shows as specks and a fade
as a pale patch, and the text stays readable through both long after a decoder would print
garbage.

## Listening

Press **HELL** in the mode group. It tunes the radio to the band's Hell dial (below) and
puts the slice in DIGU. The receiver listens on a carrier 1000 Hz above the dial, which puts
a 14.062 dial on the Feld Hell Club's calling frequency, 14.063.

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

These come from the Feld Hell Club's frequency list. 160 m and 12 m are left out because
the club's frequencies there now sit on the FT8, FT2 and JS8 dials. The club runs nets on
Wednesday, Thursday and Friday evenings, and the European Hellschreiber net meets on 40 m
on Sundays. Most activity is during those nets and the club's sprints, not every evening.

**Tuning.** A Feld Hell signal is a carrier about 250 Hz wide at its strongest. Click it on
the waterfall, or nudge with −10 / +10, so the carrier sits between the two edge markers.
The receiver is forgiving: a station 60 Hz off still paints, only a little paler.

**The page.** Each column is painted twice, one copy above the other. The two stations'
clocks are not the same, so a character can start part way up a column; between the two
copies there is always a whole one. Read whichever copy is complete. Lines that slope mean
the clocks differ, and the text still reads.

**The level.** The header shows the peak over the noise floor in dB. Noise alone reads 13 to
15 dB; anything over 16.5 dB is reported as a signal.

## Sending

A line at a time, and Enter sends it. Hell runs at 2.5 characters a second, so a CQ takes
about twelve seconds. Lowercase goes out as capitals, as Hell is traditionally sent. The
line goes through the DAX audio path with the same gate, key, stream and unkey as RTTY and
PSK31, and a line longer than 40 seconds of air is refused before anything keys. **CQ** and
**73** send the usual opening and closing lines with your callsign.

## The numbers

| | |
|---|---|
| Elements in a column | 14, bottom to top |
| Element rate | 245 a second (4.08 ms each) |
| Columns | 17.5 a second |
| Characters | 7 columns each, 2.5 a second |
| Keying | raised-cosine edges one element long, so the signal stays within about 350 Hz |
| Font | 5 by 7, uppercase, slashed zero, one element of paper above and below |

## Settings

| Key | Default | What it does |
|-----|---------|--------------|
| `hell.centreHz` | 1000 | Where the receiver paints and the transmitter keys, Hz above the dial |
| `digital.mode` | auto | `hell` holds the mode anywhere, not only on the dials above |

## Not yet

- Other Hell modes: FM Hell, PSK Hell, Hell 80 and Slow Hell.
- A slant control to straighten lines from a station whose clock is off.
- Logging a contact from the panel: Hell is logged as mode HELL, by hand.
