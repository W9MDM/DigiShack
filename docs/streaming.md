# Streaming the station to YouTube Live

DigiShack can push the waterfall and the receiver audio to a YouTube Live stream, so
anyone can watch — and hear — the band the station is working.

**The audio is the point.** A silent screen recording of a logging program is neither
interesting to watch nor, as far as YouTube's health checks are concerned, a healthy
stream. What goes out is the actual receiver: the same audio the decoder is working on,
under a waterfall that scrolls in real time, with the decode list drawn over the top.

## Setting it up

1. In YouTube Studio, **Create → Go live → Stream**. Set the stream to unlisted or
   private while testing.
2. Copy the **stream key**.
3. In DigiShack, **Settings → YouTube Live**, paste it into **YouTube stream key**, save.
4. On the **Rig** page, click **Go live**.

YouTube takes about twenty seconds to show the stream after ffmpeg connects. Until then
Studio says the stream is offline, which is normal and not a fault.

To stop, click the same button — it reads **Live ●** while streaming.

### The stream key is a credential

Anyone holding it can broadcast to your channel as you. DigiShack treats it accordingly:

- Stored **encrypted**, the same as the Club Log and QRZ credentials.
- **Never sent to the browser.** The Rig page's button sends `start` or `stop` and nothing
  else — the key is read server-side by the radio service, which is the only process that
  ever sees it.
- **Rewritten out of log lines** before anything prints them, including ffmpeg's own
  error output, which would otherwise print the full RTMP URL on a failed connection.

If you think it has leaked, reset it in YouTube Studio and paste the new one in. The old
key stops working the moment you reset it.

## What it needs

**ffmpeg**, with `libx264`, `aac` and `drawtext` (which needs freetype). On Debian and
Ubuntu:

    apt install ffmpeg fonts-dejavu-core

The font package matters: the decode list is drawn by ffmpeg from
`DejaVuSansMono.ttf`, and without it the stream starts and shows no text.

Check what you have:

    ffmpeg -hide_banner -encoders | grep -E 'libx264|aac'
    ffmpeg -hide_banner -filters | grep drawtext

**Upstream bandwidth.** 4500 kbps by default, which is roughly 2.0 GB an hour, or about
12 GB over a six-hour operating day. On a connection that cannot sustain it, YouTube
shows buffering rather than dropping the stream.

If you need to lower it, **lower the resolution too**. The frame is 1080p because the
decode text was not legible at 720p — YouTube was serving viewers a low rendition and
the player was enlarging it — and 1080p carried at a 720p bitrate is more pixels sharing
the same bits, which is worse per pixel than the 720p it replaced. 4500 is YouTube's own
figure for this frame size.

**CPU.** `libx264` at `veryfast` and ten frames a second. Measured on the reference
container (6 cores): about **1.2 cores** at 1080p, against well under one at 720p — the
2.25x pixel ratio, arriving where expected. Load sat at 3.5 of 6 with the FT8 decoder
running. The preset is deliberately not slower: this shares a machine with a decoder, and
a prettier picture is not worth a late transmission.

## Why the picture is drawn rather than screenshotted

The obvious way to stream "the DigiShack UI" is a headless browser screencasting the real
page, and that was the first plan. On the reference container it costs 135 apt packages,
several hundred megabytes and roughly a core, on a box that has no X server and is already
decoding FT8 — measured before deciding, not assumed.

So the waterfall is drawn from the same spectrum rows the browser gets, and ffmpeg draws
the text over it. That turns out to suit the medium better than it sounds: a stream is
watched, not operated, and a layout built for watching beats a recording of a layout built
for clicking.

The renderer is pure — bins in, pixels out — and asserted by `npm run check:stream-frame`:
the palette's edges, the scroll direction, the bin mapping that a narrow carrier has to
survive, and the bounds. ffmpeg and RTMP cannot be exercised from a check script; that
part is exercised by going live.

## When it does not work

**The button does nothing and an error appears.** Read it. "No YouTube stream key is set"
means step 3 above. Anything else is ffmpeg's own message, with the key removed.

**It goes live and stops a second later.** Almost always a rejected key — YouTube drops
the connection immediately. The Rig page reports the reason it stopped rather than
silently returning the button to "Go live". Reset the key in Studio and paste the new one.

**The stream is up but silent.** The audio is whatever the decoder is receiving. If the
Decodes page is not showing decodes either, the fault is upstream of the stream — see
[troubleshooting](troubleshooting.md).

**The stream is up but the text is missing.** `fonts-dejavu-core` is not installed.

**It stopped when the radio service restarted.** Expected: ffmpeg is a child of the radio
service and goes with it. A stream does not survive a restart and is not resumed
automatically — a station that starts broadcasting on its own after a crash is not
something a watchdog should decide.

## What goes out

Everything the receiver hears, in real time. That includes anything said on the air near
your dial frequency, which on a digital band is data rather than voice, but on any other
mode would be other people's conversations. Streaming a receiver is legal in the
jurisdictions this project is used in and normal practice in the hobby, but it is worth
being deliberate about it rather than surprised.

Nothing from the logbook goes out. The overlay carries the station callsign, grid, band,
mode, dial frequency, today's QSO count, and the recent decode list — all of which is
already public the moment it goes on the air.
