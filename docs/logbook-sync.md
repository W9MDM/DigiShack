# Logbook sync

Keeping the log in step with QRZ, LoTW and eQSL — what gets uploaded, what comes back,
and how DigiShack avoids doing either twice.

## The question that matters: what have I not uploaded?

Answering it by downloading the remote log and diffing it works. It is how 3,174 Club Log
duplicates were found. But it moves megabytes to discover a handful of missing contacts,
it cannot answer at all when the network is down, and nothing records that a batch *had*
been sent — so the next run cheerfully offers everything again.

So every contact carries its own upload state, and the sweep queries it directly.

| Field | Means |
|---|---|
| `qrzSent` | **QRZ has this contact.** Not "DigiShack sent it" |
| `qrzRcvd` | QRZ reports both operators logged it |
| `lotwSent` / `lotwRcvd` | Uploaded to LoTW / confirmed there |
| `eqslSent` / `eqslRcvd` | The same, for eQSL |
| `clublogSent`, `hrdlogSent`, `cloudlogSent` | Services that accept contacts and never confirm them, so there is nothing to receive back |

`qrzSent` deliberately means *QRZ has it* rather than *we sent it*. A contact logged on
QRZ's own website, or uploaded years ago by another program, is equally not in need of
uploading. Recording it as sent is what stops the sweep offering it, and the alternative —
sending it and relying on QRZ to reject the duplicate — is doing the work anyway and
hoping.

## QRZ is not a write-only service

It was treated as one for a long time, and that was simply wrong. QRZ Logbook marks a
contact **confirmed** once both operators have logged it, and says so on the way back out
in `APP_QRZLOG_STATUS`. Every record also carries QRZ's own id in `APP_QRZLOG_LOGID`.

Both were being thrown away, which cost twice over: nothing knew QRZ already had a
contact, and nothing knew how far a download had got.

**A QRZ confirmation is not a LoTW confirmation.** It counts for QRZ's own awards and it is
good evidence the contact was real. It does not count for DXCC. That is why `qrzRcvd` is its
own field rather than folded into `lotwRcvd`.

Only the status `C` is read as a confirmation. Other codes appear — `V`, and `N`/`Y` in
older exports — and none is documented anywhere authoritative, so anything else is left
alone. Reading an unknown code as confirmed would put a claim in the log that QRZ never
made, and nothing downstream could tell it from a real one.

## The download is differential

**Sync from QRZ** on the [ADIF page](../pages/adif.tsx) fetches with QRZ's `AFTERLOGID`
paging and remembers where it finished, in the setting `qrz.lastLogId`. An ordinary sync
therefore reads the new records and stops. Before this it re-read the whole logbook every
single run: the paging was already being used, but only *within* a run, and the position
was discarded at the end of it.

Three things about that cursor are deliberate:

- **It only moves forward.** A run stopped by the page limit, or a full re-read passed
  explicitly, must not drag it backwards and make the next ordinary sync repeat ground
  already covered.
- **It is saved even when the run fails.** A sync that fetched eight pages and failed on
  the ninth has still learnt where those eight ended; throwing that away means the retry
  redoes the work.
- **A preview changes nothing** — no contacts, no marks, and no cursor movement.

Tick **read the whole logbook again** to start from the beginning. Worth doing
occasionally: QRZ can be edited on their site, and a full pass is the only way to see
that.

## Marking happens before importing

The order is not arbitrary. Importing first creates the missing contacts, and they would
then be marked as being in QRZ's logbook by the very document that proves QRZ has them —
true, harmless, and it makes the counts unreadable, because every new contact reports as
newly-marked as well as imported.

Marking first means **Marked as in QRZ** counts only contacts that were already in the log
and were not known to be in QRZ's.

A sync that reports `0 imported, 400 already in log` used to look like a wasted run. It is
not: those 400 are contacts QRZ demonstrably has, and marking them is what stops the
uploader offering them ever again.

## Matching a QRZ record to a local contact

By `dupeKey` — callsign, band, mode and start time to the minute — which is the same rule
the ADIF importer dedupes with. That sharing is the point. A second matching rule that
disagreed with the importer's would mark the wrong contact, or mark nothing while the
importer skipped everything as a duplicate, and **both failures look exactly like the sync
working**.

For the same reason each record goes through the project's own ADIF parser rather than
having its fields read directly. FT8 arrives as `MODE:FT8` from some programs and
`MODE:MFSK` `SUBMODE:FT8` from others; a hand-rolled reader keying on `MODE` would match
nothing for every digital contact in the log, which here is nearly all of them.

Records QRZ sends that the parser rejects are skipped, and their ids skipped with them —
each record is converted on its own so an id cannot end up attached to the next contact
along.

## Editing by hand

QRZ's Sent and Rcvd boxes sit with LoTW's and eQSL's on the contact page, because the
operator thinks of them as one question: who has this contact, and who confirmed it. They
are editable so a wrong one can be corrected. Ordinarily nothing needs touching — the sync
writes them.

## What is not built

LoTW upload (TQSL is required and not wired), eQSL upload, HRDLOG, and Club Log, which is
blocked outside this codebase: their server returns 403 before authentication is even
attempted. See the [roadmap](roadmap.md).

## N3FJP Amateur Contact Log

The one target here that is not a web service: a Windows program on your own desk with a
TCP listener. Switch it on in ACLog under **Settings → Application Program Interface (API)
→ "TCP API Enabled (Server)"**, then set `uploads.n3fjp`, `n3fjp.host` and `n3fjp.port`
under Settings → Uploads and Settings → N3FJP Amateur Contact Log.

**`n3fjp.host` is the trap.** `127.0.0.1` is correct only when DigiShack runs on the same
machine as ACLog. A container or a separate server needs the desktop PC's own LAN address,
and pointing it at localhost means DigiShack connects to itself and finds nothing. The API
has no password of any kind, so point it only at your own network and never expose port
1100 to the internet.

Contacts are sent as ADIF through `ADDADIFRECORD`, chosen over the other two documented
methods because DigiShack already produces ADIF for four other services — one writer, one
set of field decisions. It joins the ordinary upload sweep, so contacts made while ACLog is
closed are not lost: they stay flagged unsent and go out on the next sweep after it comes
back.

**The API returns no acknowledgement for this command.** N3FJP documents a response for the
ENTER action and says nothing about a reply to ADDADIFRECORD, so "sent" means the bytes
were written to a healthy connection — not that Amateur Contact Log accepted the record.
The wire format is verified against a live ACLog; the acceptance is not, and cannot be.
