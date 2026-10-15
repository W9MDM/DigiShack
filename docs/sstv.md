# SSTV

Slow-scan television on the decodes page: pictures received, shown as they come in, and
kept in a gallery.

## Receiving

Press **SSTV** in the mode group. It tunes to the band's SSTV frequency and the decoder
starts listening for the VIS header that opens every picture - a two-tone call of about
three quarters of a second that names the mode. When one arrives, the panel shows
"Receiving Martin 1 · row 37 of 256" and the picture fills in line by line, as it does
in MMSSTV or QSSTV. A Martin 1 picture takes just under two minutes, a Scottie 1 about
the same, Robot 36 thirty-six seconds, PD 120 just over two minutes.

| Band | Dial (MHz) | Sideband |
|------|-----------:|----------|
| 80 m | 3.845 | lower |
| 40 m | 7.171 | lower |
| 20 m | 14.230 | upper |
| 15 m | 21.340 | upper |
| 10 m | 28.680 | upper |

SSTV operators run lower sideband on 80 and 40 m, so the chip puts the slice in DIGL
there and DIGU above. 14.230 is the busiest by far, at weekends especially.

The modes: Martin 1 and 2, Scottie 1, 2 and DX, Robot 36, and PD 50, 90, 120, 160, 180
and 240. The header names the mode, so there is nothing to choose. A picture in a mode
outside these - Robot 72, Wraase, Pasokon, the MMSSTV extended modes - is heard but not
drawn: the panel and the bridge log say which it was ("Last header: Robot 72"), so a
missing mode shows up by name rather than as a count.

## The gallery

Every finished picture is saved as a PNG under `data/sstv` on the station, named by the
time and the mode, and listed under the picture as thumbnails, newest first. Click one to
show it; the next picture to start takes the display back. A page opened half way
through a picture gets everything received so far and carries on from there.

## How it reads a picture

The audio is mixed down around 1900 Hz and the phase differenced, giving the frequency
sample by sample - 1500 Hz is black, 2300 Hz white, 1200 Hz sync. The VIS is read from
the last three quarters of a second of that, every 10 ms. Then each line is read where
its sync pulse actually is, searched for near where the timing says, and the drift
between the two is followed, so a sending sound card a little fast or slow does not lean
the picture. In noise the picture is snowy and washed out toward grey, as on any
decoder. `scripts/check-sstv.ts` and `check-sstv-pipeline.ts` test all nine modes,
noise and clock error on generated pictures.

## On the air

The first picture, 22:05 UTC on 15 October 2026, 14.230: N3CHX in Martin 1, decoded off
the air two minutes after the decoder was deployed. The streaks are ordinary HF fading
and interference; the picture underneath is whole.

![N3CHX, Martin 1, 14.230](sstv-first-n3chx.png)

## Not yet

- Sending pictures.
- Slant correction by hand, and saving a picture that was cut off part way.
