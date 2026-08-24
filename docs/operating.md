# Operating

## Logging by hand

**New QSO** takes a callsign, band, mode and time and fills in the rest. Times are UTC
and the field says so; the form interprets what you type as UTC rather than local,
which is the difference between a log that matches LoTW and one that does not.

DXCC entity, CQ zone and continent resolve from the callsign as you type, once
[cty.csv is loaded](../README.md#dxcc-reference-data). State, county, IOTA and the
special-activity fields are there for the awards that need them.

**References (SIG_INFO)** takes a list — `US-0765, US-2258` — because one contact can
genuinely be several parks at once. See [POTA](pota.md#n-fers).

## Which radio

The Radio box on the Digital page picks it: **FlexRadio**, **Icom** or **external
decoder**. Changing it releases the current radio and opens the other one in place, with
no restart, and **stops any automatic mode on the way through** — carrying "hunt" onto a
radio whose antenna, power and tuner state nobody has looked at is not a favour.

Everything below applies to both radios. The automatic modes, the sequencer, the brakes
and the logging are one implementation shared between them; what differs is two functions
for moving the dial.

**Transmit is armed per radio** — `flex.allowTransmit` and `icom.allowTransmit`, each off
by default, inheriting nothing from the other. Arming a FlexRadio on a real antenna says
nothing about an IC-7300 that might be on a dummy load or half way through being set up.

## The automatic modes

Set from the Digital page. All of them are off by default and every one of them still
goes through the brakes below.

| Mode | What it does |
|---|---|
| **CQ** | Calls CQ on your cycle, works whoever answers, repeats |
| **Hunt** | Watches the decodes for callable CQs and works them, best first |
| **Hunt POTA** | The same, but only stations calling `CQ POTA` |
| **POTA chase** | Retunes to spotted park activators — see [POTA](pota.md#chase-mode) |

"Best first" is award value, not signal strength. Ranking by SNR alone means working the
same nearby stations all evening while a new entity two S-units down goes unanswered.

## Click to call

The most useful control is the simplest: click a callsign in the decode list. That
starts a full QSO with them — the sequencer picks the right message for each state,
transmits on the correct cycle, and logs the contact when it completes. No mode needs
to be enabled.

## The brakes

Unattended transmitting is where a logging program can do real damage — to a band, to
an amplifier, or to a reputation. Every limit is a [setting](settings.md#automatic-operating-limits).

| Guard | Default | Stops when |
|---|---|---|
| Run length | 240 min | Wall clock since the run started |
| QSOs per run | 100 | Contacts made this run |
| SWR | 3:1 | A damaged or disconnected antenna |
| PA temperature | 75 °C | The amplifier needs to cool |
| Consecutive transmissions | 20 | Nothing has been answered and nobody has touched it |
| Unanswered CQs | 15 | Treated as a quiet band |
| Silent receive windows | 4 | A dead audio path — a station that cannot hear must not transmit |

The first two are the only ones that bound a session in absolute terms. Every other
guard counts events and is reset by making progress, so a station that keeps working
people could otherwise transmit indefinitely.

**A pause carries a cause,** and the cause decides what happens next:

- `fault` (SWR, PA temperature, deaf receiver) — band-hopping will **not** clear it. A
  different band fixes none of those, and it needs you to look at the antenna.
- `quiet` (nobody answering) — band-hopping may move on.
- `runaway` (transmitted a lot with no human) — needs a human.

## FT-0

The button in the header. Named for the joke at [ft-0.com](https://ft-0.com/) — 0 baud,
0 Hz bandwidth, −∞ dB minimum SNR, a 100% success rate, and *"when all else fails:
nothing."*

The name is the joke; the button is a real kill switch, in the header because the one
control you want in a hurry should not be two pages deep. In order: unkey, stop the
automatic modes, clear the held resume mode, persist the transmit gate off **for the
radio in use** so a restart cannot resume, then release the radio.

Releasing brings the radio back and deliberately does **not** re-enable transmit.
Coming out of a full stop should be deliberate.

The name is borrowed with thanks from the FT-0 Working Group at
[ft-0.com](https://ft-0.com/). Their FT-0 achieves a 100% success rate by never
transmitting; this one achieves the same thing on purpose, briefly, when something has
gone wrong.

## Band conditions

The strip along the top of the Digital page answers "where should I be?" from three
sources, kept visibly separate because they know different things:

- **Seen** — how many stations PSKReporter is hearing on each band right now, in your
  mode. The "how busy is 20 m" answer, and the only one that covers bands you are not
  listening to.
- **Heard** — what *this* receiver decoded. One band at a time, but it is ground truth
  for your antenna. A model cannot know your 40 m dipole is deaf to the north-west.
- **Est** — a coarse guess from solar flux and local time, for the rest.

They are never blended into one number. A measurement beats an estimate, and a single
score would hide which one produced it.

## Reconnecting

If the radio's command channel drops, the supervisor rebuilds the connection and
restores the automatic mode that was running — gated on the transmit switch for that
radio, re-read after the outage, because you may well have turned it off while the radio
was down and that decision must win.

The run clock carries forward across the outage rather than resetting. Resetting it
would let a flapping radio extend an unattended session indefinitely, each dropout
granting a fresh four hours.

A release DigiShack asked for — switching radios, or FT-0 — is not an outage, and the
supervisor is told so. Without that distinction it dutifully reconnected the radio FT-0
had just stopped, and brought a released FlexRadio back while the Icom was taking over,
so both ran at once.

### The Icom rebuilds itself for two more reasons

Both are specific to how the radio holds its session, and both were found by operating it
rather than by testing it:

- **The streams opened but carry nothing.** A restart can leave the radio holding the
  previous session, and the new streams open perfectly and then deliver no CI-V, or no
  audio. "Open" is a socket fact; DigiShack waits for a real CI-V frame *and* a real audio
  packet before treating the radio as usable, and rebuilds if it does not get them.
- **The audio stops mid-session.** Nothing else notices this, because the decode pipeline
  emits windows on a timer whether or not a sample arrived — so the liveness watchdog sees
  a healthy radio while it has gone completely deaf. Twenty seconds without an audio packet
  (excluding while transmitting, when receive audio legitimately stops) rebuilds the
  session. Detected in 20 s, recovered in about 3.

**Why the radio stops sending audio is not yet understood.** This is recovery, not a cure,
and you may see a short gap in the decode stream every few minutes.
