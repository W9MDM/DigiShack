# JTTY

JTTY on the decodes page: what the mode is, listening, sending, and where this
implementation stands against WSJT-X's.

JTTY is the WSJT project's keyboard mode for RTTY contesters. It was announced on 23
September 2026 with WSJT-X 3.2.0-rc1, and this port follows the code in WSJT-X v3.3.0-beta2.
It is not tied to UTC time slots: a transmission starts whenever the operator sends, lasts
a few seconds, and prints as it arrives, like RTTY. Underneath it is a weak-signal mode,
with forward error correction and a CRC on every frame.

## The signal

| | |
|---|---|
| Modulation | 4-GFSK, tones 31.25 Hz apart, 31.25 baud |
| Width | about 127 Hz |
| Frame | 13 sync symbols and 46 data symbols, 1.888 s |
| Per frame | 34 source bits, a 12-bit CRC, a tail-biting rate-1/2 code (K = 10) |
| A message | one or more frames back to back; the last carries an end-of-message flag |

Each frame carries one "atom". A call action like `CQ K1ABC CQ`, `TU K1ABC CQ` or
`K1ABC AGN?` fits in one frame, as does a structured exchange such as `599 123`, `599 MA`,
`1D EMA` or `FN42`, or a control phrase such as `AGN?` or `QSL TU`. Anything else goes five
characters to a frame. The sender picks the fewest frames that reproduce the text exactly,
so `K9XYZ 599 123` is two frames, about four seconds.

## Listening

Press **JTTY** in the mode group. It tunes the radio to the band's JTTY dial and puts the
slice in DIGU. The receiver decodes every JTTY station in the passband at once; there is
nothing to tune for receiving. Each message prints when its last frame arrives: the
station's frequency, its S/N in 2.5 kHz, and the text. A message that stops without its
last frame prints after two frames of silence, marked `…`.

| Band | Dial (MHz) | Band | Dial (MHz) |
|------|-----------:|------|-----------:|
| 160 m | 1.839 | 17 m | 18.104 |
| 80 m | 3.572 | 15 m | 21.090 |
| 40 m | 7.078 | 12 m | 24.920 |
| 30 m | 10.140 | 10 m | 28.090 |
| 20 m | 14.090 | 6 m | 50.160 |

These are WSJT-X's own list. Three share a dial with another mode here: 7.078 with JS8,
18.104 with FT4, JS8 and Hell, and 24.920 with PSK31. A bare dial on one of those reads as
the other mode; pressing the JTTY chip makes JTTY stick there.

Stations heard in the last five minutes show as tags on the waterfall, labelled with their
first words.

## Sending

**Where.** JTTY transmits at its lowest tone, 1500 Hz above the dial unless moved, as
WSJT-X's "Tx frequency". Click the waterfall or a station's tag to transmit there, or nudge
with −10 / +10. The markers show the lowest tone and the top of the four.

**What.** Type a line and press Enter. **CQ** sends `CQ <your call> CQ` and **73** sends
`TU <your call> CQ`, one frame each, as WSJT-X's F1 and F3 do. Text is sent in capitals;
characters outside JTTY's alphabet go as `#`. A line is at most 80 characters, sixteen
frames, about 30 seconds. It goes through the DAX audio path with the same gate, key,
stream and unkey as RTTY.

## Against WSJT-X

- **Interoperable.** The framing, the code, the CRC and the source grammar are WSJT-X's.
  The specification's ten reference frames pack and unpack bit for bit (`check:jtty`).
- **Sensitivity.** The decoder here is the reference one beside the encoder: a wrap-around
  Viterbi with a list of 32, checked by CRC, reserved bit and grammar. On generated signals
  it copies reliably to about -14 dB S/N and sometimes to -16. WSJT-X's production decoder
  adds coherent integration over several symbols, signal subtraction and AFC, and copies
  somewhat deeper.
- **Contest profiles.** Packing uses the default profile. RTTY Roundup's serial and state
  rules and the native function-key macros are not here yet, so `599 001` goes as two
  frames rather than one.
- **Logging.** Not yet. The ADIF mode for JTTY is not settled, and a guessed one could be
  refused by LoTW.

## Settings

| Key | Default | What it does |
|-----|---------|--------------|
| `jtty.txHz` | 1500 | Where JTTY transmits: the lowest tone, Hz above the dial |
| `digital.mode` | auto | `jtty` holds the mode anywhere, not only on the dials above |
