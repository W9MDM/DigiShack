# The exchange and the log for the keyboard modes

RTTY, CW, PSK31/63/125, Olivia, Contestia and the six Hell modes have no sequencer: unlike
FT8, nothing follows the exchange for you. Under each of their panels on the decodes page is
a bar that does the typing and the logging.

## The fields

| Field | What it is |
|-------|------------|
| Their call | The station you are working. Typing a new one clears the rest, because a new call is a new contact. |
| Sent | The report you give, 599 unless you change it. |
| Rcvd | The report they gave you. |
| Name, QTH, Grid | Optional, logged if filled in. |

## F1-F8

Each key sends a line with your call (%M), theirs (%H), your report (%R) and their name
(%N) filled in. The buttons show the line as it will go out. A line that needs their call is
not sent until you have typed it. The keys work from the keyboard too, as in fldigi, whenever
the bar is showing.

| Key | Line |
|-----|------|
| F1 | CQ CQ CQ DE %M %M %M K |
| F2 | %H %H DE %M %M %M K |
| F3 | %H DE %M TNX FER CALL UR %R %R %R BK |
| F4 | %H DE %M TNX QSO 73 SK |
| F5 | %H DE %M PSE AGN K |
| F6 | %H DE %M K |
| F7 | %H DE %M R R TNX UR %R %R BK |
| F8 | %M |

The first line you send with their call in it marks when the contact started.

## Logging

**Log contact** writes the contact. **Log when I send 73** (on by default) does it for you when
F4 goes out. Each contact is logged once; the button says so afterwards.

The frequency logged is the signal's, the dial plus the carrier, as fldigi logs it. CW is
logged at the dial. The mode is logged as ADIF knows it, so LoTW, eQSL, QRZ and Club Log
take it as it is:

| On the air | Logged as | ADIF |
|------------|-----------|------|
| RTTY | RTTY | MODE=RTTY |
| CW | CW | MODE=CW |
| PSK31 / 63 / 125 | PSK31 / PSK63 / PSK125 | MODE=PSK SUBMODE=PSK31 / PSK63 / PSK125 |
| Olivia | OLIVIA | MODE=OLIVIA |
| Contestia | CONTESTI | MODE=CONTESTI |
| Feld Hell | HELL | MODE=HELL |
| FM Hell-105 | FSKH105 | MODE=HELL SUBMODE=FSKH105 |
| FM Hell-245 | FSKH245 | MODE=HELL SUBMODE=FSKH245 |
| Hell 80 | HELL80 | MODE=HELL SUBMODE=HELL80 |
| Slow Hell | SLOWHELL | MODE=HELL SUBMODE=SLOWHELL |
| PSK Hell | PSKHELL | MODE=HELL SUBMODE=PSKHELL |

An ADIF import of any of these comes back as the same mode. `check:text-log` covers both
directions.

JTTY is not in the bar: it has no ADIF mode yet, and a contact logged under a mode the
upload services do not know would be refused there.
