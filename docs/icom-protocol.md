# The Icom RS-BA1 network protocol

Notes taken while working out how to talk to an IC-7300 mk2 over the network, so the
next person — probably me, in six months — does not have to work it out again.

## Where this came from, and the licence

Almost everything here was learned by reading
[kappanhang](https://github.com/nonoo/kappanhang) by Norbert Varga (HA1ABC) and Akos
Marton (ES1ABC). Icom publishes no specification; kappanhang is the clearest
description of the protocol that exists.

**kappanhang is MIT licensed** (copyright 2020, the authors above). MIT is compatible
with DigiShack's GPL-3.0 — MIT code can be incorporated into a GPL-3.0 work, and the
combined result is distributed under GPL-3.0 with the MIT notice retained.

An earlier draft of `roadmap.md` claimed kappanhang was GPL-2.0, which would have been
a genuine problem: GPL-2.0-only and GPL-3.0 are incompatible, and a straight port would
have been undistributable. That claim was wrong. It is recorded here because "we
checked, and here is the answer" is worth more than silence — the next person who
worries about it can stop worrying.

Any file in `lib/icom/` that carries a direct port of kappanhang logic states so at the
top and names the authors. That is the whole obligation MIT imposes, and it is cheap.

## Shape of the thing

The radio listens on three UDP ports. Not one connection carrying three kinds of
traffic — three genuinely separate UDP conversations, each with its own sequence
numbers, its own keepalives and its own teardown.

| Port | Carries |
|---|---|
| 50001 | Control: login, authentication, keepalive, stream setup |
| 50002 | Serial: CI-V, the same command set as the USB CAT port |
| 50003 | Audio: receive and transmit audio |

The control stream is opened first. It authenticates, and only then asks the radio to
open the other two. Serial and audio each then run their own handshake on their own
port.

### The common header

Every packet starts with the same 16-byte header:

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | Length, little-endian uint32 |
| 4 | 2 | Type, little-endian uint16 |
| 6 | 2 | Sequence, little-endian uint16 |
| 8 | 4 | Sender ID |
| 12 | 4 | Destination ID |

The sender and destination IDs are the ones exchanged when the stream was opened, and
they swap between the two directions. Anything beyond byte 16 is specific to the type.

**The length field is not reliable.** The radio sends ping packets with the length set
to zero. kappanhang's own check ignores byte 0 for exactly this reason, and any parser
here has to use the actual datagram length, never the declared one. This is the detail
most likely to cost an afternoon: a parser that trusts the header drops every ping the
radio sends, the keepalive never completes, and the session dies after a few seconds
with no error that points at the cause.

Types seen on the wire:

| Type | Length | Meaning |
|---|---|---|
| 0 | 16 | Idle, and the wrapper for tracked payloads |
| 1 | 16 | Retransmit request, one packet |
| 1 | 24 | Retransmit request, a range |
| 3 | 16 | Open request |
| 4 | 16 | Open reply, carrying the peer's ID |
| 5 | 16 | Disconnect |
| 6 | 16 | Session-open confirm — steps three and four of the open |
| 7 | 21 | Ping — keepalive, both directions |

Above that layer the control stream carries larger packets that it discriminates by
**length**, not by type:

| Length | Meaning |
|---|---|
| 64 | Authentication: token request, reply, renewal, removal |
| 80 | Stream-open request / reply |
| 128 | Login |
| 96 | Login reply — the auth token, or a rejection |
| 144 | Serial/audio stream request |
| 168 | Capabilities — the radio's name, sent unprompted after the login reply |

So both rules are in play, at different layers. Type field for the transport packets;
length for the control-stream payloads.

### Ping, byte by byte

The one packet that must be right before anything else works, so here it is in full.
From the radio (note the zero length):

```
00 00 00 00 | 07 00 | 1c 0e | e4 35 dd 72 | be d9 f2 63 | 00 | 57 2b 12 00
len (wrong)   type    seq     sender        destination   req  echo
```

The reply from the PC — IDs swapped, byte 16 set to `0x01`, sequence and the trailing
four bytes echoed back unchanged:

```
15 00 00 00 | 07 00 | 1c 0e | be d9 f2 63 | e4 35 dd 72 | 01 | 57 2b 12 00
len (21)      type    seq     sender        destination   rep  echo
```

## Sequence numbers and retransmission

UDP, so the protocol builds its own reliability. Both sides keep a send sequence and a
buffer of recently sent packets. When a receiver notices a gap it sends a retransmit
request naming the missing sequence number (the 16-byte form) or a range (the 18-byte
form), and the sender replays from its buffer.

Sequence numbers are **little-endian uint16** and they wrap. Any comparison has to
handle wrap-around, or the stream stalls forever at 65535 — an hour or so into a
session at the ping rate, which is exactly long enough to look like a different bug.

## The control stream, in order

1. **Open — FOUR steps, not two.** The PC sends type 3 (twice), the radio answers type 4
   carrying its session ID, the PC sends type 6 with sequence 1 (twice), and the radio
   answers type 6. Only then will it accept a login. Stopping at the type-4 reply gives a
   session the radio keeps alive with idle packets every 100 ms and answers nothing else
   on — and because type 6 was briefly mislabelled "close" here, the radio's own final
   handshake packet was read as a disconnect and tore the session down on arrival. Close
   is type **5**. Confirmed against an IC-7300MK2.
2. **Ping loop starts.** Type 7, 21 bytes, laid out above. The radio sends one every
   100 ms; the PC need not match that rate — kappanhang uses 3 s and the radio is
   content — but every ping from the radio must be answered, and the timeout is about
   3 s. Stop replying and the session drops with no diagnostic.
3. **Login.** A 128-byte packet carrying the username and password, each passed through
   `passcode()` (below), plus the literal ASCII `icom-pc` as the client name.

   **It must carry transport sequence 1, and be sent exactly once.** Sequence 0 is
   discarded in total silence — no reply, no rejection — while the byte-identical packet
   with sequence 1 is answered in 30 ms. Sending it twice, the way the untracked open
   request is deliberately duplicated, earns the same silence. Both measured against an
   IC-7300MK2, and between them they cost an afternoon: every byte of the login matched
   the reference implementation and the transport was demonstrably healthy.

   The reply is **96 bytes**, carrying the auth token at byte 26 — beginning with the two
   random bytes we sent, which is how you know it is answering *your* login. `ff ff ff fe`
   at byte 48 means the credentials were rejected.

   The 168-byte capabilities packet arrives **separately and afterwards**, carrying the
   model name. Treating it as the login reply means the real one matches no length case
   and is dropped, which presents as a login timeout from a radio that answered instantly.
4. **Token acknowledge** — a 64-byte auth packet with magic `0x02`.
5. **Token confirm** — a 64-byte auth packet with magic `0x05`. The same packet is
   re-sent periodically to renew the token; let it lapse and the radio disconnects.
6. **Request serial and audio.** An 80-byte packet naming the ports and the audio
   parameters. The radio replies with the ports it has opened, and the serial and audio
   streams can then run their own handshakes.
7. **Teardown** — a 64-byte auth packet with magic `0x01`, which removes the token. Skip
   this and the radio holds the session open, and the next connection attempt is
   refused as "already in use" until it times out. Worth getting right: the failure
   mode is "my radio is broken", not "my program exited untidily".

### Control packets have a second sequence space

Every control-stream packet carries an "inner" block starting at byte 16, with its own
length at byte 19 and **its own sequence counter** at bytes 23–24 — entirely separate
from the transport sequence at bytes 6–7. Two counters in one packet. Conflating them
gets the first exchange through and then the radio rejects everything after it.

And the byte order is mixed *within a single packet*. Length, type and both sequences
are little-endian; the session IDs at bytes 8–15 are **big-endian**; and in the
serial/audio request the sample rate and port numbers from byte 112 on are big-endian
too. This is not a transcription error, it is what the protocol does.

Ping will not catch a mistake here. It only ever copies the two session IDs around as
opaque blocks, so a consistently-wrong reader passes every ping test and then builds a
login packet the radio silently ignores.

### Verified field offsets

Confirmed against captures in `scripts/check-icom.ts`.

Login request, 128 bytes: auth-start id at 26 (2 bytes), username passcode at 64,
password passcode at 80, the literal ASCII `icom-pc` at 96.

Login reply, 168 bytes: auth id at 26 (6 bytes), the "a8 reply id" at 66 (16 bytes),
the radio's own name at 82 (null-terminated, e.g. `IC-705`), the audio device name at
114 (`ICOM_VAUDIO`).

Auth, 64 bytes: magic at 21, auth id at 26. Magic `0x02` acknowledges, `0x05` confirms
and later renews, `0x01` removes the token at shutdown.

Serial/audio request, 144 bytes: auth id at 26, a8 reply id at 32, **radio name at 64**,
username passcode at 96, sample rate big-endian at 118 and 122, serial port at 126,
audio port at 130, transmit buffer milliseconds at 134.

**The radio name at byte 64 is a portability trap.** kappanhang hardcodes `IC-705`,
because that is the radio it was written for. DigiShack sends back the name the radio
gave us in its login reply instead. Whether a 7300 would accept `IC-705` is unknown and
not worth finding out — the correct value is already in hand by the time this packet is
built.

## passcode()

Username and password are not sent in clear, but this is obfuscation and not
encryption — the table is a fixed substitution and it is published here in full. It
stops a casual packet capture from showing a password; it stops nothing else. Treat the
radio password as compromised on any network you would not trust with plaintext.

The algorithm: for each character at index `i`, take its ASCII value, add `i`, and if
the result exceeds 126 wrap it with `32 + p % 127`. The result indexes a 95-entry
substitution table covering 32–126. Output is always exactly 16 bytes, zero-padded.

The `+ i` is what makes it slightly more than a Caesar shift: the same character
encodes differently depending on where it sits in the string.

Two quirks worth mirroring exactly rather than "fixing":

- **Input longer than 16 characters is truncated**, not rejected. A 20-character
  password authenticates on its first 16 characters.
- **The wrap can produce an out-of-table index.** `32 + p % 127` yields 32–158, and
  entries above 126 do not exist; Go's map returns zero, so those become `0x00`. For
  printable ASCII within 16 characters the maximum is `126 + 15 = 141`, which wraps to
  46 and stays in range — so real passwords never hit it. Any reimplementation must
  still produce `0x00` there, because matching the reference is the requirement, not
  being correct in the abstract.

## Audio

**48000 Hz, signed 16-bit little-endian, mono.**

Which is a gift. The decoders want 12 kHz, and 48000 / 12000 = 4 exactly, so getting
from the radio to the decoder is integer decimation by four — two applications of the
existing `decimateBy2`, no resampler, no fractional-rate arithmetic, no drift.

**But two passes are not free, and this changes a setting.** `decimateBy2`'s FIR has a
gain of about 0.80, measured: a 400 Hz tone goes in at 0.7071 RMS and comes out at
0.5639 after one pass and 0.4455 after two. The interior of the array matches the whole
array, so that is the filter's passband gain and not an edge transient.

Flex is 24 kHz and takes one pass. Icom is 48 kHz and takes two. **The same signal
therefore reaches the decoder about 20% quieter on the Icom path.** `silenceRms`, the
threshold below which a window is skipped without decoding at all, has to be lowered
correspondingly for Icom — carrying the Flex default across unchanged silently drops
marginal windows, and the symptom is "the Icom hears less than the Flex", which reads
as an antenna or a receiver fault and is neither. Per-radio defaults, not one constant.
`scripts/check-icom.ts` asserts the gain so that a future change to the taps cannot
move it without someone noticing.

Compare the Flex path, which is 24 kHz float32 stereo for receive and 24 kHz mono
int16 **big**-endian for transmit. Icom is little-endian, as x86 and ARM both are, so
the conversion is a `Buffer` read with no byte swapping.

Audio packets are sequence-numbered and retransmit-tracked like everything else, but
a lost audio packet is not worth replaying — by the time it arrives the moment has
passed. Requesting retransmission of audio is how you turn a click into a stall.

### The stream is bidirectional, and the radio expects it to be used

**A client that only ever receives gets its audio cut off after a minute or two.** The
radio keeps pinging the same socket throughout, so the session is alive and the route is
fine — it has simply stopped streaming. That asymmetry is what identified it: 219 pings
arrived on the audio socket *after* the audio stopped.

Send silence when there is nothing else to send. 1920 bytes every 200 ms is a trickle
against 48 kHz coming back, and it carries no risk of transmitting — audio without PTT
goes nowhere, which is the same reason a wrong `MOD Input` setting produces a keyed radio
sending nothing.

Nothing in the public protocol descriptions mentions this. It presents as "the Icom
decodes for a minute and then the band goes dead", which reads as a receiver or antenna
fault and is neither, and it is invisible to a liveness check that counts decode windows
because those come off a timer.

## Serial: CI-V

Port 50002 carries CI-V framed exactly as it is on the USB CAT port — `FE FE` preamble,
destination and source addresses, command, data, `FD` terminator. So whatever already
knows how to speak CI-V over a serial port speaks it over this socket unchanged, which
is the good news: frequency, mode, PTT and S-meter are all existing, documented CI-V
commands.

The IC-7300's default CI-V address is `0x94`. The controller uses `0xE0`.

## What this means for DigiShack

The work splits into four pieces, in dependency order:

1. **The radio abstraction** — `RadioSource` and `RadioTransmitter`, so nothing above
   the driver layer knows which radio it is talking to. Needed regardless, and it is
   the piece that makes the rest additive rather than invasive. `lib/radio/types.ts`.
2. **Control stream** — `lib/icom/`: passcode, packet encode/decode, the handshake, the
   ping loop, the token lifecycle. Testable without a radio, because the packets are
   pure functions of their inputs.
3. **CI-V** — frequency, mode, PTT, S-meter. Reuses the framing above.
4. **Audio** — receive into the existing decode pipeline, transmit from the existing
   waveform generator. The decimation is exact, so this is plumbing.

Only step 4 requires a radio on the bench to verify. Steps 1 to 3 can be built and
tested against recorded bytes, and should be.
