# POTA

Parks on the Air, on the **POTA** page.

## The page

Three sources, kept apart because they know different things:

- **POTA's profile** — the authority on your history. Every award with every
  endorsement, lifetime activator and hunter totals, recent activations. This is the
  only place your park history from before this logger exists.
- **Your log** — the authority on what to do next. Every callsign you have ever worked,
  and every park reference recorded here or imported.
- **Live spots** — who is on the air right now, cross-referenced against the log.

Each spot is badged:

| Badge | Meaning |
|---|---|
| **Today** | Worked this activator since 00:00 UTC — almost certainly this same activation |
| **Park worked** | This reference is already in your log |
| **Call worked** | Known callsign, but not this park |
| **New** | Neither |

## Chase mode

`pota-chase` retunes the radio to spotted activators and works them, then moves on.
Different from `hunt-pota`, which only works activators already audible where you are.

**Set the band before you enable it.** Chase captures its home band at the moment you
turn it on and, by default, stays there. That default is the difference between chasing
parks and touring empty frequencies: on a typical evening there are thirty FT8 spots
spread over eight bands, and most retunes land somewhere nothing is audible — each one
costing the give-up period before another can be tried.

Each window, in order:

1. If parked on someone, deal with them.
2. Otherwise work any `CQ POTA` already audible — free, no retune, and the activator is
   frequently heard before the spot feed catches up.
3. Only then consider retuning, and only to an allowed band.
4. With nothing worth chasing, return to the calling frequency.

Spots are ranked by same-band first (no retune costs nothing), then an unworked DXCC
entity, then a new band slot, then freshness.

Every knob is a [setting](settings.md#pota-chasing): `pota.chaseBands` (blank = the
starting band, `any` = anywhere), the give-up period, the retry cooldown, and switches
for working audible CQs, award-aware ranking and returning home.

## Park references on contacts

Contacts carry ADIF `SIG` / `SIG_INFO` — `POTA` and `US-1689`. Filled in automatically:

| How the contact happened | SIG | SIG_INFO |
|---|---|---|
| Chased a spot | POTA | the spot's reference |
| Heard `CQ POTA`, a spot agrees on callsign **and** band | POTA | the spot's reference |
| Heard `CQ POTA`, nothing corroborates it | POTA | *empty* |

That last row is deliberate. An FT8 message has no room for a park reference, so when
the spot feed cannot confirm which park, the honest record is `SIG` with no `SIG_INFO`
— which is valid ADIF. Taking a reference from a spot that merely shares the callsign
would write a confident, wrong park into the log, and a wrong reference is worse than
none: afterwards it is indistinguishable from a real one.

## N-fers

**One contact can be several parks at once.** Parks nest and overlap — working an
activator at Indiana Dunes is `US-0765` *and* `US-2258`, the national park and the state
park inside it, and both are true.

This is not rare. Against one real hunter log: 1,050 POTA rows described 863 contacts,
and **126 of them carried more than one reference** — 86 doubles, 29 triples, 7
quadruples and 4 contacts in five parks simultaneously.

So references are a set. The QSO form takes a list separated by commas, spaces or
semicolons; the log shows the primary with `+2` beside it; ADIF exports the primary in
`SIG_INFO` and the full set in `APP_DIGISHACK_SIGREFS`, because ADIF has no repeated
fields and no multi-value `SIG_INFO`.

## Importing your hunter log

POTA's public API stops at 25 recent contacts. The full log is behind
`/user/logbook`, which needs the session token from a signed-in browser — there is no
API key scheme.

**Getting the token:** sign in at pota.app, open developer tools, Network tab, click any
request to `api.pota.app`, and copy the whole `Authorization` request header value.
Paste it into Settings → POTA chasing → *POTA session token*.

It is a short-lived AWS Cognito JWT and expires within hours, which is why this is a
**one-time backfill** rather than a live connection. Once the history is in, DigiShack
records references itself from every contact it makes.

Then **Preview** on the POTA page. It runs the real matcher against the real log and
writes nothing, so what you see is what will happen. Outcomes:

| | |
|---|---|
| **matched** | will gain the references it is missing |
| **already-set** | has them all already |
| **conflict** | carries references with none in common with POTA's — left alone |
| **ambiguous** | two contacts fit equally well, so neither is touched |
| **missing** | POTA has this contact and your log does not — reported, never created |

Matching uses time as the discriminator, not mode: POTA takes the mode from the
activator's ADIF, which says `DATA` for FT8 and `MFSK` for FT4. Band **is** a hard
filter — an activator working you on 20 m and again on 40 m minutes later is ordinary,
and taking the nearer contact would attach a correct park to the wrong QSO, which breaks
every band-slot answer while looking perfectly fine.

Merging only ever adds. POTA's hunter record covers activators who uploaded a log, so it
is incomplete by construction, and a park your log has that POTA does not is still a park
you worked.
