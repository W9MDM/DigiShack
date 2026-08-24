# Feature audit against Cloudlog

Cloudlog (magicbug/Cloudlog) is the closest mature comparison to DigiShack: a self-hosted
PHP logbook with 78 controllers and a long history. This is a read of its source against
ours, done to find what is genuinely missing rather than what merely has a different name.

Cloudlog and DigiShack are not aiming at the same thing. Cloudlog is a general logbook that
talks to radios; DigiShack decodes and transmits FT8/FT4 itself and logs what it works. So
"missing" below means missing AND worth having for a digital station, and several Cloudlog
features are deliberately not wanted.

## Already equivalent, or better here

| Cloudlog | DigiShack |
| --- | --- |
| `Adif` | `/adif` — export reuses the log view's filter schema, so "export what I am looking at" works. Plus QRZ sync. |
| `Lookup`, `Calltester` | `/dxcc` test-a-callsign, QRZ lookup |
| `Logbook`, `Qso` | `/qsos`, `/qsos/new`, `/qsos/[id]` |
| `Awards` (partly) | `/awards` — DXCC, WAS, WAZ, WAC, grid, IOTA |
| `Backup` | `/backup` |
| `Settings`, `Options`, `User_options` | `/settings`, 152 registered settings with generated docs |
| `Station`, `Logbooks` | `/stations` |
| `Update`, `Migrate`, `Maintenance` | `/update` |
| `User`, `Thirdpartylogins` | `/users`, `/account`, API keys |
| `Api` | `pages/api/v1` |
| `Radio` | `/rig` — considerably further along; Cloudlog only displays what CAT reports |
| `Qsl`, `Qslmanagement` | `/qsl`, `/qsl/cards`, plus an emailed-QSL queue Cloudlog has no equivalent for |
| `Dashboard` | `/` |
| `Gridmap`, `Map` | `/gridmap`, `/map` |
| `Activators`, `Activatorsmap` | `/pota` — spot chasing, plus an importer that pulls your POTA hunter/activator logbook and merges it |

Two things DigiShack has that Cloudlog does not, worth stating so they are not "simplified"
away later: it decodes and transmits without an external decoder, and it has an operating
schedule with real safety brakes (SWR, PA temperature, duty cycle, wall-clock, deafness).

## Missing and worth building

Ordered by what would change day-to-day operating.

**1. LoTW upload.** Not implemented, and the settings lie about it — see below. Full
mechanism now written up in `docs/lotw-upload.md`: no TQSL binary needed, `node:crypto` is
enough. 6,565 contacts pending.

**2. eQSL upload.** Also not implemented; 23,711 pending. Much simpler than LoTW — eQSL
takes a GET to `https://www.eqsl.cc/qslcard/importADIF.cfm` with the ADIF in the query
string and no signing at all.

**3. There is no upload setting for either, and that is worth stating precisely.** An
earlier draft of this audit claimed `uploads.lotw` and `uploads.eqsl` existed as switches
that did nothing. They do not exist at all — the claim came from probing
`getBooleanSetting("uploads.lotw", false)`, which returns the DEFAULT for an unregistered
key and looks exactly like a registered setting that is off. The registered upload keys are
`enabled`, `qrz`, `clublog`, `cloudlog`, `since`, `maxPerRun` and `intervalMinutes`, and
`UPLOADABLE` is `["qrz", "clublog", "cloudlog"]`.

So the absence is honest rather than misleading, which is better than reported. The lesson
is about the probe, not the code: asking a settings API for a key you assume exists cannot
distinguish "off" from "not a thing", and a default is not evidence.

**4. DX cluster.** Cloudlog's `Dxcluster` is small — `qsy` and `check_worked` — but it is the
join between "what is being spotted" and "what I need", which is exactly what an award
chaser wants and what our POTA-only spot feed half provides.

**5. Workable DXCC.** `Workabledxcc` answers "of the entities I still need, which are
audible now". We have the pieces — band strip, spots, the worked index — and not the join.

**6. Statistics beyond the summary.** Cloudlog has per-year, per-mode, per-band, unique
callsigns, most-worked, continent breakdown and trends. We have bands, summary and today.
Per-year and most-worked are the two an operator actually opens.

**7. Callsign history.** "Have I worked them before, when, on what" as a view rather than a
log filter. The data is all there.

**8. Cabrillo and CSV export.** ADIF is done; Cabrillo matters if a contest is ever entered,
CSV is trivial and people want it for spreadsheets.

## Missing, and probably not wanted

Recorded so the decision is deliberate rather than an oversight, and so nobody re-audits
this ground later.

- **Award programmes for other countries** — `dok` (Germany), `waja` (Japan), `wab` (UK),
  `gmdxsummer`. Real awards, and irrelevant to a US station unless chasing them.
- **SOTA, WWFF, POTA award progress.** We chase POTA activators already; tracking POTA as an
  AWARD (references worked, progress, map) is a different feature and a fair candidate if
  POTA operating grows.
- **Counties (USA-CA), Gridmaster, FFMA.** County and 6 m grid-square awards. FFMA needs
  every 6 m grid in the lower 48 — not this station's operating.
- **VUCC per band.** We track grids as one dimension; VUCC is per-band above 50 MHz. Worth
  it only if VHF becomes a thing here.
- **Contesting, Cabrillo scoring, Simple FLE.** Fast Log Entry and a contest engine are for
  a different operating style. Cabrillo EXPORT is listed above as worth having; the scoring
  engine is not.
- **Satellites and EME** — `Hamsat`, `Sattimers`, `Emeinitials`.
- **SSTV.**
- **OQRS** — a whole online QSL-request system with request forms and not-in-log handling.
  Large, and the emailed-QSL queue already covers the same need for this station.
- **QSL label printing** — `Labels`, `Qslprint`. Paper QSL workflow.
- **Plugins, widgets, themes, components.** An extension system. I would argue against it:
  it is a large amount of surface whose purpose is to let other people add features, and
  this project's value is that every behaviour is deliberate and documented.
- **Public visitor view** — a read-only shared log. Plausible later; no demand now.
- **Notes / station diary.** Cheap, if wanted.
- **QRB calculator** (distance and bearing between two grids). Cheap, and the maths already
  exists in `lib/` for the coverage map.
- **Propagation advisor.** We already show band conditions on the Digital page from three
  sources, which is most of the value.

## The honest summary

The gap is narrower than 78 controllers suggests. Most of Cloudlog's surface is either
already here under a different name, or aimed at operating this station does not do.

What actually matters, in order: **LoTW upload, eQSL upload, and the dead settings that hide
both.** Everything after that is enhancement rather than absence — with the exception of DX
cluster and workable-DXCC, which are the two features that would change what an operator
does with their evening rather than what they can see afterwards.

## A note on discoverability

Four features were asked for during this audit that already existed: ADIF import/export,
DXCC backfill ("apply DXCC data to the logbook"), and the POTA log importer. That is not a
feature gap, it is a findability gap, and it is worth treating as its own defect — a feature
nobody can find has the same value as one that was never written, at higher maintenance
cost.

The Help page added in 1.87.0 is aimed at behaviour rather than inventory, which is the
right choice for the questions this software generates. But it means there is still no
answer to "what can this thing do", and the README is doing that job alone for an operator
who is already inside the application.
