# RTTY

Listening to RTTY: the mode chip, the tones and the sideband, the text panel, sending a
line, and what the automatic modes do about it.

## Listening

Press **RTTY** in the mode group on the decodes page. It tunes the radio to the band's RTTY
segment (the table below) and the decoder switches from windows to a stream: there is no
T/R period in RTTY, the line idles on mark between keystrokes, and the decoder runs the
whole time. The decode table becomes a terminal. Text arrives as it is typed at the far
end, newest at the bottom.

RTTY has no calling frequency. Activity spreads across a segment of each band and the
station tunes around inside it, so once the decoder is on RTTY it stays there while the
dial moves. It lets go when the dial lands on another mode's calling frequency (FT8 at
14.074, say), or when another mode's chip is pressed.

| Band | Dial (MHz) | Band | Dial (MHz) |
|------|-----------:|------|-----------:|
| 80 m | 3.590 | 17 m | 18.102 |
| 40 m | 7.080 (Region 2) / 7.040 (1 and 3) | 15 m | 21.085 |
| 30 m | 10.140 | 12 m | 24.922 |
| 20 m | 14.085 | 10 m | 28.085 |

These are segment centres, not calling frequencies: where to start looking.

## The tones

An RTTY signal is two tones 170 Hz apart. Where the pair sits in the passband is up to the
station that sent it, so the decoder has to be put on it: **click the signal on the
waterfall** and the tone pair moves there, or nudge it with the −10 / +10 buttons. The
panel shows the mark and space frequencies it is listening on and two level bars; a
signal on the pair fills them and the text starts. The starting centre and shift come
from Settings → Modes → RTTY and the page moves them live.

Mark is the higher radio frequency by convention. On upper sideband (DIGU, which is what
a data mode on the FlexRadio is) that makes mark the higher audio tone; on lower sideband
the lower. The bridge takes the sideband from the slice, so a signal that produces
nothing but framing errors on one sideband is very likely on the other: switch the slice
to DIGL and the same pair decodes.

The decoder unshifts on space (a received space returns it to letters), which is what
every amateur RTTY program does by default, and reads the figures case as US TTY
(`$ ! & # ; "`). Both are settings.

So is the squelch. An empty channel is not silent to an RTTY decoder: band noise trips
the start-bit detector and about two characters a second survive the frame check (the
first live try printed 337 characters of nothing in 150 s). The squelch asks how sure the
decoder was of each bit and drops a character below the mark - at the default of 0.7 a
signal needs about 6 dB over the noise in the one-bit filter, which is where RTTY copy
begins anyway, and noise prints a few characters a minute. The panel counts what was
dropped as "weak" beside the framing errors; lower the setting for a station you can
hear but not read.

## Sending

Type a line under the terminal and press Enter, or press **CQ** or **73** for the two lines
every RTTY contact begins and ends with. The radio keys, the line goes out at the tone pair
the decoder is listening on (so what you send is where the other station is), and the
radio unkeys; at 45.45 baud that is about six characters a second, and a line is capped at
forty seconds on the air. The line appears in the terminal as `[TX]` once it has gone, or
as `[TX refused: ...]` with the reason - transmit off in Settings, the radio busy, or not
on RTTY. "Allow transmit" has to be on, the same gate as every other transmission here.

## What the automatic modes do

Nothing. RTTY has no structured messages, so there is nothing for a sequencer to answer:
the automatic modes refuse to start while the decoder is on RTTY, landing on RTTY with one
running stops it, and the Call button is not offered. The transmitter refuses RTTY as a
framed mode; text goes out through its own path, above.

## The decoder, and how it was checked

`lib/digital/rtty.ts` is ITA2 - the code, the shifts, the 7.5-bit character frame, the
tone arithmetic and a phase-continuous FSK waveform - and `lib/digital/rttydemod.ts` is
the demodulator: two one-bit matched filters, a level-independent decision, and the UART's
clock, restarted at every start bit. The tables are asserted against their published
values and the frame against the RY line test; the demodulator is run clean, one sample
at a time, through noise at about 0 dB across the passband, 1.5 % fast and slow, 20 Hz
off, at 24 kHz, across a gap, and on the wrong sideband (which must not decode). The
pipeline's stream branch is checked the same way at the FlexRadio's 24 kHz in DAX-sized
packets. See the changelog for 1.189.0 and 1.190.0.

The liveness watchdog, which restarts a bridge whose pipeline has stopped, beats on the
stream's once-a-second heartbeat here, since no window will ever arrive.

## Not yet

- A logging panel beside the terminal, and macros you can edit (an exchange with a serial
  number, for a contest).
- Reading callsigns out of the text for PSKReporter and the worked-before index.
- Click-to-tune the RADIO to a signal on the panadapter, rather than the tones within
  the passband.
