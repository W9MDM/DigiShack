# NAVTEX and SITOR-B

Receiving the marine safety broadcasts: what they are, where to tune, what the receiver
prints, and how far it can be pushed. The receiver follows fldigi 4.2.13
(`src/navtex/navtex.cxx`), with a few changes listed at the end.

NAVTEX is receive-only. Coast stations send it; ships print it. Amateurs do not transmit
NAVTEX or SITOR-B, and DigiShack has no transmitter for it. (The code has a test signal
generator, used only to check the receiver.)

## On the decodes page

Put the radio on the station first: for 518 kHz, USB with the dial at **517.000 kHz** (490 kHz:
489.000), then choose **NAVTEX** in the mode list. It decodes where the dial is (marked "here")
and stays chosen while the dial stays within 5 kHz. The panel's picker has NAVTEX (messages
with their ZCZC header and NNNN end) and SITOR-B (the same signal on HF, without the framing);
the centre is 1000 Hz, and a click on the waterfall moves it.

NAVTEX is listen-only: the panel has no Send box and no exchange bar, and the radio is never
keyed in it. Nothing is logged. A FlexRadio receives 518 kHz on its general-coverage receiver;
an IC-7300 does too.

## What it is

Coast stations around the world take turns on one frequency, each in its own ten-minute
slots, four hours apart, sending navigational warnings, gale warnings, weather forecasts,
search and rescue notices, ice reports and the like. Every ship over a certain size has a
NAVTEX printer on the bridge. The signal is SITOR mode B: 100 baud FSK, 170 Hz shift,
7-bit characters with exactly four marks in each (so a bit error shows), and every
character sent twice, 350 ms apart, so a burst of static rarely takes both copies.

| Frequency | What |
|----------:|------|
| 518 kHz | International NAVTEX, in English. The busy one. |
| 490 kHz | National NAVTEX, in the country's own language (not everywhere). |
| 4209.5 kHz | Tropical NAVTEX, HF. A few stations. |

SITOR-B is the same signal without NAVTEX's message framing. It turns up on the HF
maritime safety frequencies (4210, 6314, 8416.5, 12579, 16806.5, 19680.5, 22376 and
26100.5 kHz) and on assorted utility stations.

At 518 kHz the signal is ground wave by day, a few hundred miles, and goes much further at
night. From the US Midwest, Portsmouth VA, Boston and the Great Lakes Canadian stations
are the usual catches; from the coasts it is loud.

## Tuning

The receiver expects the signal centred on **1000 Hz audio**, fldigi's default, with the
higher tone at 1085 Hz and the lower at 915 Hz. On **USB**, set the dial **1.000 kHz below**
the station:

| Station | Mode | Dial |
|--------:|:----:|-----:|
| 518 kHz | USB | 517.000 kHz |
| 490 kHz | USB | 489.000 kHz |
| 4209.5 kHz | USB | 4208.500 kHz |

The NAVTEX frequency is the centre of the signal, between the two tones, so with the dial
1 kHz below it the centre lands at 1000 Hz. On the waterfall you will see two lines 170 Hz
apart straddling 1000 Hz.

**LSB works too.** On LSB the dial goes 1.000 kHz *above* the station (519.000 kHz for
518) and the tones come out swapped. The receiver notices this on its own - characters
read with three marks instead of four - and turns them round; the statistics show
`reversed`. No setting is needed.

**Off frequency.** The receiver locks on a signal up to about 45 Hz either side of the
centre, and once locked the AFC pulls it onto the signal (up to 40 Hz) and reports how
far off it was. Further out than that, move the centre or the dial: the receiver cannot
tell 60 Hz high from 40 Hz low.

**Filter.** Anything from 500 Hz to a full SSB width. A narrow filter helps only if there
is a strong neighbour; the receiver's own filters are 100 Hz wide.

**Your radio.** 518 kHz is below the amateur bands, so the radio has to receive there. The
FlexRadio and the IC-7300 both do, but the antenna matters more than usual: a ham antenna
for 80 m is a poor receiving antenna at 518 kHz, and a long wire or an active antenna does
much better.

## What the receiver prints

Phasing (the ten seconds of steady warble before every message) prints nothing; the
receiver locks on it within about a second. Then a message:

```
ZCZC EA42
SECURITE. GALE WARNING 12. SOUTHERN NORTH SEA ...
NNNN
```

`ZCZC` starts a message and `NNNN` ends it. The four characters after ZCZC are the header:

- **B1**, a letter: which station. Letters are reused around the world, so "E" on 518 kHz
  is Niton in England and Mar del Plata in Argentina. The station can be named from
  fldigi's station list using where you are (see the end of this page).
- **B2**, a letter: the subject (table below).
- **B3B4**, two digits: the message's serial number. A ship's printer uses it to print
  each message once; serial 00 is always printed (distress traffic).

Each completed message is also handed over separately with the station letter, subject,
serial and text, so a page can list messages rather than a scroll of text. A message the
receiver joined part way through, with no ZCZC, is kept only if it ended with NNNN; one
that was cut off by the next ZCZC, or ran ten minutes with no NNNN, is kept and marked as
having lost its end.

| B2 | Subject |
|:--:|---------|
| A | Navigational warning |
| B | Meteorological warning |
| C | Ice report |
| D | Search & rescue information, pirate warnings |
| E | Meteorological forecast |
| F | Pilot service message |
| G | AIS message |
| H | LORAN message |
| I | Not used |
| J | SATNAV messages |
| K | Other electronic navaid messages |
| L | Navigational warnings (additional to A) |
| T | Test transmissions (UK only) |
| V | Notice to fishermen (US only) |
| W | Environmental (US only) |
| X, Y | Special services, allocated by the IMO NAVTEX Panel |
| Z | No message on hand |

A, B, D and L are the ones a ship's receiver may not switch off.

In **SITOR-B** mode the same text prints with no message handling: there is no ZCZC on
those stations.

## The statistics

- **open**: locked onto a signal's characters.
- **quality**, 0 to 1: how cleanly the characters are reading. Near 1 is perfect copy:
  both copies of each character arrive whole and agree. Around 0.7 copy is still good
  but leaning on the second copies; under about 0.5 expect errors.
- **errors**: characters where neither copy arrived whole and the receiver worked out the
  most likely one from both.
- **afcHz**: how far the signal is from the centre you set, as the AFC sees it.
- **level**: the signal's strength at the receiver's input.
- **reversed**: the tones were found swapped (LSB, or an inverting radio).

## How weak a signal it copies

Measured against a test signal in white noise, with S/N given in a 2500 Hz bandwidth (what
an S/N figure on a waterfall usually means):

| S/N in 2500 Hz | Copy |
|---------------:|------|
| -5 dB | Perfect, message after message |
| -6 dB | About one character wrong in 500 |
| -7 dB | About one in 80 |
| -8 dB | About one in 15; messages readable |
| -9 dB and below | Fragments, then nothing |

Below copy it prints next to nothing rather than garbage: band noise, loud noise, clicks
and the exact digital silence a FlexRadio's DAX sends between transmissions all print
nothing over a minute. The last few characters of a weak signal that stops dead can be
lost (the receiver waits for a confirmed character before printing doubtful ones); real
stations end with phasing, which confirms them.

A FIGS shift lost to noise prints the following letters as figures (`(&-)3` for `GALE`)
until the next LTRS, as on any teleprinter; the receiver puts the case back to letters at
every phasing signal, so the next message starts clean.

## Differences from fldigi

- **Tuning is automatic for the sideband**: fldigi has a reverse button; here the receiver
  tries both senses when it is searching and keeps the one that locks.
- **The bit clock** is a single averaged timing estimate rather than fldigi's
  early/prompt/late correlator; it locks faster and holds through noise bursts.
- **Error correction**: when the two copies of a character disagree or neither is whole,
  the receiver picks the most likely character from both copies' soft values. fldigi takes
  the first copy, or tries a short list of guesses and gives up. This roughly halves the
  errors near the copy limit.
- **Doubtful characters are held** until a later character confirms the signal is still
  there, so the noise between a signal ending and the receiver giving up does not print.
  fldigi prints it.
- **The AFC** reads the signal's own phase rather than the waterfall, and does not make
  fldigi's 90 Hz jumps.
- **Not included**: fldigi's ADIF and KML logging of messages, and its minimum message
  length for logging.

## The station list

The station list is fldigi's `NAVTEX_Stations.csv` (204 stations): country, frequency,
B1 letter, callsign, name, position, NAVAREA and language. When a message's station letter
matches more than one station on the frequency, the receiver picks the nearest to you, or
the one whose name appears in the message.
