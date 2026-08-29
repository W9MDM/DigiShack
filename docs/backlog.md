# Backlog

Known work, with the evidence behind it. Written down because carrying it in conversation
loses it — this list already reached fourteen items across one session, and three of them
had been mentioned twice.

**This file is the interim home.** The Gitea issue tracker is the right place and is now
enabled on `PCARC/DigiSHACK`, but the stored API token can read issues and not create them
(`GET /issues` 200, `POST /issues` 403 — it needs the `write:issue` scope). Once that is
granted these move to issues and this file becomes a pointer.

Ordered roughly by what would be picked up next, not by severity.

---

## Answering and logging

### Decode the partner's slice first, so replies go out on time
Every transmission after the first goes out 500-1100 ms late: it is scheduled from the
`decodes` event, and decoding cannot finish until the window has. Measured on the live box
(15 s window, depth 2): the full 200-3000 Hz search takes **1558 ms**, a 200 Hz slice around
the partner's known offset takes **420-476 ms**. `freqLow` exists in the decoder options and
is unused. Decoding the partner's slice first would put the reply inside FT8's 500 ms budget
and remove the extra cycle when answering.

**Not a bug fix.** 1.139.1 showed the lateness is not what loses contacts — completed and
abandoned QSOs have the same median timing (536 ms against 554 ms over 26,000
transmissions). This is wasted margin, so it is a performance improvement.

### We abandon a contact while the far station is still working it
`maxRepeats` is 4. Of 143 incomplete exchanges, **seven had an acknowledgement arrive after
we had already quit**. Those seven were promoted by hand in 1.140.0; the behaviour is
unchanged. Worth weighing: a longer tail, a tail that scales with signal strength, or
keeping the exchange open passively for a cycle after the last transmission.

### Fox/hound compound messages are not parsed
    K9XYZ RR73; DL2HIR <3D2USU> -20
A DXpedition acknowledging one station and reporting to another in one transmission. That is
a genuine RR73 to us; `parseMessage` does not handle the form, and the contact — Fiji — was
recovered by hand. Also involves the hashed-callsign form `<3D2USU>`.

### ~~Reprocess a logged contact to chosen integrations~~ — DONE in 1.144.0
Shipped as a Destinations panel on the contact page plus `/api/qsos/[id]/destinations`.

Note the design changed on the way: the sketch here was "clear the chosen `*Sent` flags and
let the sweep pick it up", and that is wrong twice over. It reports success the instant the
flag is cleared, before anything has been sent; and on an installation with no bridge
running there is no sweep at all, so the contact would sit cleared and unsent for ever. It
uploads directly instead, and reports what each service actually answered.

---

## Uploads

### `baselineAsUploaded()` has no caller
Written, tested, never called. There is no UI for "treat everything up to now as already
uploaded", which is the honest way to adopt an upload target on a log that predates it.
**Needed before N3FJP can be switched on**: it currently shows 29,716 contacts pending, so
enabling it today replays the entire log at a desktop program.

### eQSL has 24,894 pending and is not sending
Configured and switched off, or switched on and failing quietly — unknown which. Needs a
decision as much as a fix: on eQSL the upload IS the card, so sending 24,894 is not neutral.

### Twelve card requests match no QSO and no incomplete exchange
    WP4JKO 08-17   KJ5PWR 08-15   WP4NVX 08-17   VK5MN  08-18
    VE3FSN 08-19   N7GLF  08-20   KQ4NRK 08-19   AC3EK  08-20
    K1EDR  08-23   K3NVI  08-24   K7AKG  07-15   K7ZMS  08-23
Stations claiming a contact with no trace here at all. A busted callsign their end explains
some; contacts lost before reports crossed would explain others, and that would be a real
defect.

---

## Radio

### Verify the stall rebuild against a real stall
1.135.0 rebuilds the DAX stream after 30 s of silence instead of re-sending panadapter
settings that never helped. **It has not been exercised** — zero rebuild attempts since
deployment. `logs/netsample.log` samples eth0 RX every 5 s on the live box (healthy
baseline ~330 kB/s); the next stall shows both whether the rebuild works and whether the
radio stops sending or we stop reading. Stop it with `pkill -f netsample.sh`.

### FT4 and FT2 frequency tables are incomplete, and 60 m FT2 conflicts
Missing FT4: 160 m 1.844, 60 m 5.357, 70 cm 432.065.
Missing second FT2 frequencies: 160 m 1.846, 80 m 3.581, 40 m 7.062, 6 m 50.328.

**Conflict.** We have FT2 on 60 m at 5.357, sourced from `models/FrequencyList.cpp` in
wsjt-x_improved; another table says 5.360. This is not just one number — `inferDigitalMode`
carries a special case for 5.357 being shared by FT4 and FT2, and if 5.360 is right that
ambiguity does not exist. Needs a decision on which source wins before anything changes.

---

## Housekeeping

### Move the Gitea remote to SSH
Still HTTPS with a stored credential, so it can break the way GitHub did — a revoked token
leaves pushes hanging on an interactive prompt. The key exists (`~/.ssh/id_ed25519`, no
passphrase) and is already on GitHub; Gitea takes the same public key.

### Private repo history carries a work email and co-author trailers
    272 commits authored by a work address that resolves to a second account
     24 commits authored as Claude Code
    310 Co-Authored-By trailers
None reaches the public mirror, which is regenerated with a pinned identity every publish.
Rewriting 332 commits is destructive and irreversible — an explicit decision, not a default.
The same applies to `github.com/K9XYZ/nipsco-tracker` (private, already pushed): 122
work-email refs and 61 trailers.

### `npm run check` exits 1 on a fresh install
Seen in another operator's update log: `SKIPPED npm run check exit 1`. The updater treats a
failing suite as skipped rather than fatal, so it does not block an update, but something
fails on an otherwise healthy install. Likely a check needing a database or network without
guarding for their absence — `check:qsl` fails that way on the development machine.
