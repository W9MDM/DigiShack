# Using a networked Icom

DigiShack speaks the Icom RS-BA1 network protocol directly. No third-party bridge, no
virtual audio cable, no virtual COM port, nothing to install on the radio's side. If
your IC-7300, IC-705, IC-9700 or IC-7610 is on the network, DigiShack can drive it.

**Status: operating by itself on real hardware.** Verified 2 August 2026 on an
IC-7300MK2 across a Tailscale link — a complete autonomous contact with W1ABC, hunted
from the decode list, worked through the full exchange and logged, with no human
involved. Before that: 135 FT8 decodes in six windows including Turkey, Germany,
Scotland, Ukraine and Belize, and a CQ on 17 m heard by 17 stations.

**Two faults specific to this radio's session handling are handled but not cured**, and
you will see them in the log. Read [When it does not work](#when-it-does-not-work) before
leaving it running: the audio stops on its own every few minutes and the session is
rebuilt automatically, and the meters do not report at all — which also means the SWR
guard is not armed on this radio.

**The automatic modes work here too.** Auto CQ, Auto Hunt, Hunt POTA, Chase POTA and the
Call button run on the Icom from the same operating layer the FlexRadio uses — same
guards, same QSO sequencer, same logging, same PSKReporter reporting. Transmit is armed
separately per radio: `icom.allowTransmit`, off by default, and arming a FlexRadio says
nothing about this one.

**Preflight runs at attach**, as it does on the FlexRadio: mode and data flag, RF power,
whether the radio is already transmitting, whether the ATU is in line, and whether CI-V
is answering at all. Warnings are reported, not enforced — being refused a transmitter
for a reason you cannot see is worse than the warning.

**It cannot check the one that costs you an evening.** `MOD Input → DATA MOD` must be
LAN, and that setting is not exposed over CI-V on any model here. On anything else the
radio keys, the timing is perfect, and it transmits silence. Preflight says so in as many
words rather than implying a clean bill of health it cannot give.

**The ATU** is wired (`0x1C 0x01`). The ATU button on the rig page runs it and waits for
the tuner to finish rather than returning the moment the radio acknowledges — "tuning
started" is not an answer to "is the antenna matched". Switch on **Run the ATU after a
band change** (`icom.atuOnBandChange`) and an automatic band hop or a POTA retune tunes
before it transmits. It is off by default and gated on Allow transmit, because an ATU
cycle is a low-power carrier and one into a disconnected antenna is exactly as unwise as
a CQ into one. Leave it off with a resonant antenna or an external tuner.

## Setting up the radio

On the radio, in the Network menu:

1. **Network Control** — on.
2. **Network User1** — set a user name and password. These are the radio's own
   credentials, nothing to do with your callsign or your DigiShack login.
3. **MOD Input → DATA MOD → LAN.** This is the one that will waste your afternoon if it
   is wrong. It selects where the radio takes transmit audio from in data mode, and the
   default is usually `USB` from a previous cable setup. On anything but `LAN` the
   network audio arrives, the radio keys correctly, the timing is perfect — and it
   transmits silence. Nothing in the software can detect this; the only symptom is that
   nobody hears you.
4. Note the radio's **IP address**.

Then give the radio a **DHCP reservation** on your router. The address is stored in
DigiShack's settings, and a radio that quietly moves to a different address simply stops
answering, with no other symptom.

## Setting up DigiShack

Settings → **Icom (network)**:

| Setting | What to put |
|---|---|
| Radio address | The radio's IP |
| Network user name | From Network User1 |
| Network password | From Network User1 |
| CI-V address | Leave blank |
| Control / Serial / Audio port | Leave at 50001 / 50002 / 50003 |
| Silence threshold | Leave at the default |

Then Settings → **Digital** → **Decode source** → `icom`, and restart the bridge.

Leave the **CI-V address** blank unless you have changed it in the radio's own CI-V menu.
Blank means "use whatever the model that logs in implies", which is 0x94 for an IC-7300
and 0xA4 for an IC-705. If you do set it, `94`, `0x94` and `0X94` are all accepted,
because manuals print it as "94h".

Leave the **silence threshold** alone unless you have a reason. It is lower than the
FlexRadio's on purpose — see [Why the threshold differs](#why-the-threshold-differs).

## About the password

**It is obfuscated on the wire, not encrypted.** The protocol runs each credential
through a fixed substitution table that is published in the source of every
implementation of it, including this one. That stops the password appearing in plain
text in a packet capture and it stops nothing else.

Treat the radio's network password as readable by anyone who can watch the network. Do
not reuse a password that matters anywhere else.

## What works

- Receive audio into the FT8, FT4 and FT2 decoders, and the waterfall
- Frequency: reading it, retuning, and inferring the mode from where you are tuned
- Mode: USB with data mode, set automatically before every transmission
- Transmit, including PTT and every automatic operating mode
- Transmit power, set on connect and from the slider
- The ATU, including after an automatic band change
- Preflight at attach, and automatic recovery from a stranded or stalled session

- The receiver controls: AGC, RF gain, noise blanker, noise reduction. Each write waits
  for the radio's own OK or NG reply, so one this model does not implement is reported as
  refused rather than quietly ignored
- The meters — S-meter, SWR and forward power — which also means **SWR reaches the
  operating guards**, so the guard protecting the finals against a bad antenna is armed
  here too

## What does not

- **`/rig` filter passband (`filterLo`/`filterHi`).** The Icom selects FIL1/2/3, whose
  widths live in the radio's own menu, so there is no honest mapping from a passband in Hz
  — and guessing one would move the filter to something the operator did not ask for.
  Refused by name.
- **`agc=off`.** These radios have no AGC-OFF in this command set. Mapping it to fast
  would be a control that says one thing and does another, so it is refused too.
- **Spectrum history on a fresh page load.** Not a fault and not going to be fixed: rows
  arrive every 250 ms, so the waterfall fills in 75 seconds. See the roadmap for why
  backfilling it would be worse than the gap.

> The meters were the headline entry in this section for weeks — "the polls go out and no
> reply comes back". They work as of 1.21.0, because CI-V is paced one command at a time
> instead of four in a burst. `rfGain` differs between the radios: dB of attenuation on the
> FlexRadio, a percentage here, so a value outside 0-100 is rejected rather than clamped.

## When it does not work

Symptoms in the order you are likely to meet them.

**"Authentication failed — the radio is probably still holding a session."** Almost
always exactly that. If a previous program exited without releasing its token, the radio
keeps the session open and refuses the next connection until it times out. Reboot the
radio. DigiShack releases its own token on shutdown specifically so it does not cause
this, but a crash, a pulled power lead or another program can still leave one behind.

**It connects, then drops after a few seconds, repeatedly.** The radio pings constantly
and drops anything that stops answering within about three seconds. A network that
loses UDP that badly will not carry the audio either. Check for Wi-Fi power saving on
whichever end is wireless.

DigiShack rebuilds the session itself when it drops — backing off from two seconds to
thirty, forever, holding the automatic mode across the outage and putting it back
afterwards if transmit is still armed. You will see `Icom reconnect attempt N` in the
log. It does not give up, because over a VPN the answer is usually "wait".

**Nothing decodes, but the radio is clearly hearing signals.** Check the mode. FT8 needs
USB with data mode on — DigiShack sets that before transmitting, but if you are only
receiving, the radio stays wherever you left it. Also check the silence threshold has not
been raised.

**It keys the transmitter and nothing goes out.** Almost certainly plain USB rather than
USB-D. In plain USB the transmit audio comes from the microphone, so the radio keys
correctly and sends silence. DigiShack sends the mode command before keying, so this
should not happen; if it does, check whether something else is changing the mode.

**The frequency display never changes when you turn the dial.** CI-V transceive is off in
the radio's menu. DigiShack polls every two seconds as a backstop, so the display will
still catch up — it just will not be instant.

**It hears less than another radio or another program does.** See below.

**It decodes for a minute or two, then stops.** Fixed, and worth knowing why. **The audio
stream is bidirectional and the radio expects it to be used**: a client that only ever
receives gets its audio cut off after a minute or two, while the radio carries on pinging
the same socket. DigiShack sends silence when it has nothing else to send, which keeps it
flowing — 32 minutes at 79-84 decodes a minute where sessions used to die every 1-2.

If you do see `Icom audio has stopped` in the log, the session is rebuilt automatically in
about three seconds, and the line after it says whether the radio was still pinging (its
doing) or had gone entirely quiet (the network's).

**No band, no dial, and it will not tune, but decodes are arriving.** The CI-V stream was
stranded by a restart while the radio still held the previous session. DigiShack detects
this at startup — `carrying nothing useful: 0 CI-V frames, N audio packets` — and rebuilds
twice before carrying on with whatever works. If it survives that, check the CI-V address
or power-cycle the radio.

## Why the threshold differs

The decoders want 12 kHz audio. A FlexRadio delivers 24 kHz, which is one halving. An
Icom delivers 48 kHz, which is two.

The anti-alias filter has a passband gain of about 0.80 — measured, not assumed: a 400 Hz
tone goes in at 0.7071 RMS and comes out at 0.5639 after one pass and 0.4455 after two.
So **the same signal off the air reaches the decoder about 20% quieter on the Icom path
than on the Flex path.**

The silence threshold is the level below which a window is skipped without being decoded
at all. Carrying the Flex value across unchanged would silently drop marginal windows,
and the symptom is "the Icom hears less", which reads as an antenna or receiver fault and
is neither. Hence a lower default here. If you raise it, raise it knowing that.

## For developers

[The protocol notes](icom-protocol.md) document the wire format, where each field came
from, and the traps — the radio lying about packet length, the mixed byte order inside a
single packet, the two separate sequence spaces.

The implementation is in `lib/icom/`, and all of it is testable with no radio present:

```
npm run check:icom          # packets and passcode, incl. a real captured ping exchange
npm run check:civ           # CI-V framing, BCD, meter calibration
npm run check:icom-stream   # the control stream against a stub radio
npm run check:icom-io       # serial and audio streams
npm run check:icom-rig      # all three assembled
npm run check:icom-tx       # transmit, mostly about refusing to
```

`check:icom-rig` includes the distinction this radio taught us: a source can report
`connected` — the sockets are open — while `streamsCarrying()` correctly reports that
nothing is arriving. "Open" is a socket fact and it is not the interesting one.

The protocol knowledge came from [kappanhang](https://github.com/nonoo/kappanhang) by
Norbert Varga (HA1ABC) and Akos Marton (ES1ABC), which is MIT licensed. Icom publishes
no specification for any of this.
