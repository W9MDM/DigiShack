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

The modes: Martin 1 and 2, Scottie 1, 2 and DX, Robot 36, and PD 90, 120 and 180 - the
ones heard on the air. The header names the mode, so there is nothing to choose; a
picture in a mode outside these is heard (the panel counts headers) but not drawn.

## The gallery

Every finished picture is saved as a PNG under `data/sstv` on the station, named by the
time and the mode, and listed under the picture as thumbnails, newest first. Click one to
show it; the next picture to start takes the display back. A page opened half way
through a picture shows it from the next one on.

## How it reads a picture

The audio is mixed down around 1900 Hz and the phase differenced, giving the frequency
sample by sample - 1500 Hz is black, 2300 Hz white, 1200 Hz sync. The VIS is read from
the last three quarters of a second of that, every 10 ms. Then each line is read where
its sync pulse actually is, searched for near where the timing says, and the drift
between the two is followed, so a sending sound card a little fast or slow does not lean
the picture. In noise the picture is snowy and washed out toward grey, as on any
decoder. `scripts/check-sstv.ts` and `check-sstv-pipeline.ts` test all nine modes,
noise and clock error on generated pictures.

## Not yet

- Sending pictures.
- Slant correction by hand, and saving a picture that was cut off part way.
