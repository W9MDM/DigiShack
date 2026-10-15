# JS8

JS8 on the decodes page: the mode chip, what a frame is, what a message is, how what is
heard reaches PSKReporter, and sending.

## Listening

Press **JS8** in the mode group. It tunes the radio to the band's JS8 calling frequency
(JS8Call's defaults, below) and the decoder switches to JS8's windows: fifteen seconds
on the clock, as FT8, with the transmission starting half a second in. Every frame that
decodes appears as a row in the decode table, printed as JS8Call would print it -
`KN4CRD: @HB HEARTBEAT EM73`, `KN4CRD: J1Y SNR -12`, or a piece of text - and the
messages the frames join into appear in the box above the table, one line each, when
their last frame arrives (or, after a minute and a half without it, with an ellipsis).

| Band | Dial (MHz) | Band | Dial (MHz) |
|------|-----------:|------|-----------:|
| 160 m | 1.842 | 17 m | 18.104 |
| 80 m | 3.578 | 15 m | 21.078 |
| 40 m | 7.078 | 12 m | 24.922 |
| 30 m | 10.130 | 10 m | 28.078 |
| 20 m | 14.078 | 6 m | 50.318 |

Only the normal submode (15 s) is listened to. JS8Call's fast, turbo, slow and ultra
submodes share the frame at other speeds; the codec knows them and the decoder does not
yet run them.

## Frames and messages

A JS8 frame is FT8's first design kept: 79 symbols, an LDPC(174,87) codeword, 72 bits of
payload with a 3-bit transmission type beside them. The message layer reads the payload
as one of four shapes: a HEARTBEAT or CQ (callsign, grid, which string), a COMPOUND
frame (a callsign that does not fit the standard form, or a group), a DIRECTED frame
(from, to, one of 36 commands such as SNR?, ACK, 73, and a number), or DATA (text, as
Huffman codes or as words from JS8Call's 262,144-entry dictionary). The transmission type
marks the first and last frames of a message, and the bridge joins frames from first to
last per frequency.

The dictionary is carried as `lib/digital/js8-jsc-words.json` and read by the decoder
thread on its first dictionary frame. Without it, dictionary text would print as a
placeholder; it is in every install.

## PSKReporter

A heartbeat or CQ names a station and usually its grid, which is a spot. When PSKReporter
reporting is on, every heartbeat heard goes up as a JS8 reception report, the same path
FT8 CQs take. Directed frames and text do not: they name a station but not where it is.

## On the air

The first listen, 15:27 UTC on 7.078, four frames in four minutes: two stations answering
KQ4DNM's heartbeat with SNR reports, N6GRG's own heartbeat from CN86, and WE3D answering
it. Each printed as JS8Call prints it, joined into a one-frame message, and the
heartbeat went to PSKReporter as a JS8 spot. A window costs about three seconds on the
station.

The first send, 16:20 UTC the same day: a heartbeat from the page, one frame in the
16:20:30 window at 1500 Hz, and in the next window four stations answered it -
`N0GES: K9XYZ HEARTBEAT SNR +16`, `WD4U: K9XYZ HEARTBEAT SNR +13`, `WA8WQU: K9XYZ
HEARTBEAT SNR +17`, `KE4ZDJ: K9XYZ HEARTBEAT SNR +11` - each decoded here and named by
its sender. The whole path, both directions, in one window pair.

## What the automatic modes do

Nothing. JS8 has its own conversation model - heartbeats, directed queries with automatic
replies, relays - and the FT8 sequencer does not run on it: the automatic modes refuse to
start while the decoder is on JS8, landing on JS8 with one running stops it, and the Call
button is not offered on a JS8 row.

The operating schedule and the resume after a restart start the station with nobody at the
screen, so they do what you would: leave JS8 for FT8 on the same band, then start. A
station left on JS8 the evening before still hunts at its scheduled hour, and the log
says it moved.

## The decoder, and how it was checked

`lib/digital/js8.ts` is the frame, the code and the waveform, checked bit for bit against
a reference encoder built from JS8Call's own Fortran; `js8demod.ts` is the decoder
(candidates, downconversion, fine sync, soft bits, belief propagation), checked on
generated signals clean, offset, weak and two at once; `js8-message.ts` and `js8-jsc.ts`
are the message layer and the dictionary, checked through 135 assertions; and the
pipeline check runs a heartbeat frame through the real pipeline at the FlexRadio's 24 kHz
and reads it back as JS8Call would print it. See the changelog for 1.194.0 to 1.197.0.

The decoder runs on its own thread, as a bundle (`npm run build:js8-worker`), for the
reason the WSPR one does: a worker thread on the station's Node 20 does not inherit the
bridge's TypeScript loader.

## Sending

Under the message box, a line and an offset. **HB** sends a heartbeat (your callsign and
grid, one frame); **CQ** sends `CQ CQ CQ` with your grid; a line such as `KK4COV SNR?` is
a directed message and anything else is text, as many frames as it takes - a short line
is one, a sentence three or four, each a fifteen-second window. The offset is where in
the passband the signal goes: type it, or click the waterfall. The bridge answers as soon
as the first frame is scheduled; the message box gets a `[TX]` line saying how many
frames and from which window, the status line under the form counts them out, and a
`[TX done]` or `[TX stopped: ...]` line closes it. **Cancel** stops after the frame on the
air.

The rules a transmission goes through are FT8's: "Allow transmit" in Settings, the
power and SWR guards, the window timing (keyed half a second after the boundary, refused
rather than sent late). Frames go in consecutive windows at one offset because the
receiving station joins them per frequency; a refused frame stops the message rather
than send a tail without its head, and moving the dial off JS8 cancels what is left.

## Not yet

- The automatic replies JS8Call stations expect (SNR?, QUERY, ACK, relays).
- A panel of stations heard and conversations, rather than frames in a table.
- The other submodes.
