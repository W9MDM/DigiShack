# Settings reference

Everything configurable, from **Settings** in the nav (ADMIN only).

> Generated from `lib/settings/registry.ts` by `scripts/gen-docs-settings.ts`.
> Do not edit by hand — `npm run check` fails when this file and the registry
> disagree.

Values live in the database, not in `.env`. Secrets are encrypted with
`SETTINGS_KEY`, which stays in `.env` and is **not** part of a database backup —
see [Backup and moving an installation](backup-and-moving.md).

Three keys can never be settings, because they are needed before the database can
be read: `DATABASE_URL`, `SETTINGS_KEY` and `PORT`.

## Contents

- [General](#general) — 4 settings
- [QRZ.com](#qrz-com) — 3 settings
- [Logbook of the World](#logbook-of-the-world) — 12 settings
- [eQSL.cc](#eqsl-cc) — 5 settings
- [ClubLog](#clublog) — 5 settings
- [Cloudlog / Wavelog](#cloudlog-wavelog) — 3 settings
- [HRDLOG.net](#hrdlog-net) — 2 settings
- [N3FJP Amateur Contact Log](#n3fjp-amateur-contact-log) — 2 settings
- [DXCC reference data](#dxcc-reference-data) — 2 settings
- [PSKReporter](#pskreporter) — 4 settings
- [Digital modes](#digital-modes) — 8 settings
- [DigiShack bridge](#digishack-bridge) — 4 settings
- [External decoder (WSJT-X)](#external-decoder-wsjt-x) — 3 settings
- [FlexRadio (direct)](#flexradio-direct) — 15 settings
- [Operating schedule](#operating-schedule) — 5 settings
- [Bridge watchdog](#bridge-watchdog) — 2 settings
- [Icom (network)](#icom-network) — 13 settings
- [Issue alerts](#issue-alerts) — 4 settings
- [Software updates](#software-updates) — 1 setting
- [Outgoing email](#outgoing-email) — 7 settings
- [Automatic operating limits](#automatic-operating-limits) — 18 settings
- [Automatic uploading](#automatic-uploading) — 13 settings
- [POTA chasing](#pota-chasing) — 7 settings
- [QSL card and email](#qsl-card-and-email) — 31 settings

## General

Instance-wide behaviour.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Public base URL | `app.baseUrl` | text | from `APP_BASE_URL` | Used for absolute links in outgoing email. |
| Session lifetime (days) | `app.sessionTtlDays` | number | `30` | How long a login stays valid. Lowering it does not revoke existing sessions — do that from the Users page. |
| Redis URL | `redis.url` | text | from `REDIS_URL` | Background job queue. Required from Phase 2 onward. |
| Show the experimental Rig page | `ui.experimental.rig` | on/off | `false` | Off by default, and honestly labelled: the Rig page is the least finished part of DigiShack. The panadapter's dB window is not calibrated, the FlexRadio accepts display settings it never reflects in status, and several controls are reasoned from documentation rather than measured against hardware. It is genuinely useful and it is genuinely a work in progress, which is why a new install does not meet it first. Turning this on adds Rig to the menu; the page itself says the same thing at the top so nobody arrives without the warning. |

## QRZ.com

XML API for callsign and email lookup (needs a paid XML subscription), plus the Logbook API key for uploads. The Logbook key is per-logbook and separate from your XML login.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| QRZ username | `qrz.username` | text | from `QRZ_USERNAME` | Your QRZ.com login, used to LOOK UP callsigns — names, grids and addresses for QSL cards. Nothing to do with uploading contacts, which uses the logbook API key below and works without this. |
| QRZ password | `qrz.password` | secret | from `QRZ_PASSWORD` | Password for the lookup account above. A QRZ XML subscription is needed for full lookup data; without one QRZ returns a reduced record and DigiShack uses what it gets. |
| QRZ Logbook API key | `qrz.logbookApiKey` | secret | from `QRZ_LOGBOOK_API_KEY` | Uploads contacts to your QRZ logbook. A DIFFERENT credential from the username and password above — find it on QRZ under Logbook → Settings, one key per logbook. Uploading is switched on separately under Uploads. |

## Logbook of the World

Uploads are signed by a local TQSL install; the username and password are used to download inbound confirmations.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| LoTW username | `lotw.username` | text | from `LOTW_USERNAME` | Your LoTW login, used to DOWNLOAD confirmations. Uploads are signed by your certificate rather than by this, so downloads work with these credentials alone. |
| LoTW password | `lotw.password` | secret | from `LOTW_PASSWORD` | Password for the LoTW account above. This is the website password, not the passphrase protecting your certificate file — a common mix-up. |
| Download confirmations automatically | `lotw.autoSync` | on/off | `true` | Fetch new LoTW confirmations on a timer instead of only when the Sync button is pressed. Download only — uploading needs your TQSL certificate — so this is read-only against ARRL. Does nothing until a username and password are set. |
| How often to check LoTW (minutes) | `lotw.syncMinutes` | number | `60` | An incremental check is one small request. Hourly is what Cloudlog recommends for the same service, and LoTW rate-limits heavy use. Minimum 15. |
| Check that LoTW kept what we uploaded | `lotw.reconcile` | on/off | `true` | An accepted LoTW upload only means the file was QUEUED — the records are validated afterwards and the outcome arrives by email. So a batch marked sent here may not be in your LoTW log, and nothing would ever retry it. This asks LoTW what it actually holds and clears the flag on anything missing, so it goes up again. It only ever clears a flag: the cost of a wrong answer is one redundant upload, which LoTW discards as a duplicate. |
| How often to check (hours) | `lotw.reconcileHours` | number | `24` | Daily is right. LoTW processes an upload within minutes to hours, so checking sooner reports contacts as missing that are merely still in the queue — which would clear the flag and upload them again for no reason. Minimum 6. |
| State or province (for LoTW) | `lotw.station.state` | text | — | Two letters, e.g. WI. LoTW grants Worked All States and county credit from the station location on the upload, not from anything in the contact — so leaving this empty uploads successfully and earns no WAS credit, permanently, unless every contact is uploaded again later. It is separate from the station's grid because LoTW matches its own list of states rather than deriving one. |
| County (for LoTW) | `lotw.station.county` | text | — | The county name without the word "County", e.g. Kenosha. Only meaningful for US stations, and only used for county awards. |
| The state field is a Canadian province | `lotw.station.canadian` | on/off | `false` | LoTW carries provinces in a different field from states, and it is not inferred from the value — several two-letter codes are both. Leave off for the US. |
| CQ zone (for LoTW) | `lotw.station.cqZone` | number | — | Optional. Sent on the station record and covered by the signature. |
| ITU zone (for LoTW) | `lotw.station.ituZone` | number | — | Optional. Sent on the station record and covered by the signature. |
| IOTA reference (for LoTW) | `lotw.station.iota` | text | — | Optional, e.g. NA-001. Only for island operations. |

## eQSL.cc

Electronic QSL cards. Unlike the other services the upload IS the card, so there is no log-only mode — sending is an approach to the other operator, which is why the reciprocal-only option under Uploads exists.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| eQSL username | `eqsl.username` | text | from `EQSL_USERNAME` | Your eQSL.cc login, used both to send cards and to fetch your inbox. On eQSL the upload IS the card, so there is no log-only mode to fall back on. |
| eQSL QTH nickname | `eqsl.qthNickname` | text | — | Required only when your eQSL login owns more than one QTH. With several, eQSL refuses every request with 'Username/Password found more than 1 account' until told which to use. Find the nicknames under My Profile on eqsl.cc. MEASURED: this satisfies the request but does NOT filter the inbox — the downloaded records carry no station or QTH field, so confirmations belonging to your other profiles arrive too and match nothing in this log. That is expected on a multi-QTH account, not a fault. IT IS ALSO USED ON UPLOADS, so if you move, change it: cards sent under an old QTH carry the wrong location to the recipient. A nickname that does not exist is reported by eQSL as "No such Username/Password found", which points at the password and not at the real cause — this application says so explicitly instead. |
| Download eQSL confirmations automatically | `eqsl.autoSync` | on/off | `true` | Pulls your eQSL inbox and matches it to the log, which is what earns award credit. This is READ ONLY — it uploads nothing and posts no cards to anyone, so it is safe to leave on whether or not you ever upload. `syncEqslInbox` had been written and was never called by anything, which is why confirmations only ever arrived through an ADIF import. |
| How often to check eQSL (minutes) | `eqsl.syncMinutes` | number | `60` | Hourly is plenty — confirmations are not urgent. Minimum 15. |
| eQSL password | `eqsl.password` | secret | from `EQSL_PASSWORD` | Password for the eQSL account above. eQSL rejects an upload with a clear message when this is wrong, which the Integrations page reports verbatim. |

## ClubLog

DXCC statistics, an online log and the OQRS card service. Authenticates by REGISTERED EMAIL rather than callsign. Uploads from this installation are refused at Club Log's edge; downloads work, and the code says so where it happens.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| ClubLog email | `clublog.email` | text | from `CLUBLOG_EMAIL` | Club Log authenticates by the email address you REGISTERED WITH, not by callsign. An easy one to get wrong, and it produces an unhelpful refusal when you do. |
| ClubLog password | `clublog.password` | secret | from `CLUBLOG_PASSWORD` | Your Club Log account password. The API endpoints prefer an application password (below); downloads work with either. |
| Club Log station callsign | `clublog.callsign` | text | — | Which callsign's log to upload to. Leave blank to use the station on the QSO. |
| ClubLog application password | `clublog.appPassword` | secret | — | Club Log's separate API credential, created under Settings -> Application Passwords on clublog.org. Uploads may require this rather than the account password; downloads work with either. |
| ClubLog API key | `clublog.apiKey` | secret | — | Optional in Club Log's own documentation, and requested from their helpdesk rather than generated on the site. Sent as the `api` field when set, and omitted entirely when blank — an empty key is not the same as no key, and a service that reads one as an invalid credential would refuse a request that works without it. Worth setting if uploads are refused at the edge: measured from this station, getadif.php answers 200 while putlogs.php and realtime.php return a bare nginx 403 that never reaches the application, which no credential can affect but an allow-listed key might. |

## Cloudlog / Wavelog

Self-hosted logging software. Unlike the public services this needs no developer registration and imposes no rate limit — it is your own server. Wavelog is a fork of Cloudlog and speaks the same API, so either works here.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Cloudlog / Wavelog URL | `cloudlog.url` | text | — | The base address of your installation, e.g. https://logging.example.com. A trailing slash, an index.php, or the full /api/qso path are all accepted — whatever you paste is normalised. |
| Cloudlog API key | `cloudlog.apiKey` | secret | — | Generated in Cloudlog under Account > API Keys. It must have write permission; a read-only key accepts the request and logs nothing. |
| Station profile id | `cloudlog.stationProfileId` | text | — | Which station profile contacts are filed under. Cloudlog shows the id in the URL when you edit a profile — it is a number, not the profile name. |

## HRDLOG.net

Ham Radio Deluxe's online logbook. Needs the callsign the account logs under plus its upload code, which is not the website password.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| HRDLOG callsign | `hrdlog.callsign` | text | from `HRDLOG_CALLSIGN` | The callsign your HRDLOG.net account logs under. Paired with the upload code below — both are needed. |
| HRDLOG upload code | `hrdlog.code` | secret | from `HRDLOG_CODE` | HRDLOG.net's upload code, issued in your account settings there. Not your website password. |

## N3FJP Amateur Contact Log

A logging program on your own desk rather than a web service, reached over its TCP API. Enable the listener in ACLog first, under Settings -> Application Program Interface (API) -> "TCP API Enabled (Server)". There is no password of any kind on that API, so point DigiShack at a machine on your own network and never expose the port to the internet. Switch the actual sending on under Uploads.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| N3FJP address | `n3fjp.host` | text | `127.0.0.1` | Where Amateur Contact Log is running. 127.0.0.1 is right only when DigiShack is on the SAME machine — a container or a separate server needs the desktop PC's own LAN address, and this is the setting that catches people out. The API has no password of any kind, so point it only at a machine on your own network and never expose port 1100 to the internet. |
| N3FJP API port | `n3fjp.port` | number | `1100` | The port shown in that API window. 1100 is the default and rarely changed. |

## DXCC reference data

Callsign-to-entity mapping. The DXCC page downloads it in one click from country-files.com (AD1C's Big CTY) and needs NOTHING configured here — no account, no key. The setting below is only for operators who happen to hold a Club Log cty API key and would rather use their cty.xml. Manage the data itself on the DXCC page.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Club Log cty API key | `dxcc.ctyApiKey` | secret | — | OPTIONAL, and most operators should leave it blank. DXCC data downloads from country-files.com with no credential at all, which is the button the DXCC page leads with. Club Log does not issue these keys to everyone, and requiring one is why installations sat with 9 DXCC entities against 160 actually worked. Fill this in only if you already have a key and prefer Club Log's cty.xml, which carries dated exception records the CSV does not. Nothing to do with uploading contacts. |
| Auto-fill DXCC on entry | `dxcc.autoFill` | on/off | `true` | Resolve the entity as a callsign is typed on the QSO form. |

## PSKReporter

PSKReporter asks developers to identify their traffic and to poll no more than once per callsign every 5 minutes. Anonymous polling risks being blocked.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Contact identifier | `pskreporter.contact` | text | from `PSKREPORTER_CONTACT` | An email address or callsign, sent with every query and with band-activity requests as appcontact. PSKReporter asks automated users to identify themselves so they can get in touch before blocking anyone — honouring that is the difference between an email and a ban. Falls back to the SMTP From address. Do not leave this blank. |
| Report my decodes | `pskreporter.upload` | on/off | `false` | Send the stations we decode to PSKReporter, so DigiShack appears as a receiver on the coverage maps. Separate from the lookup setting below: this uploads, that downloads. One small datagram every five minutes. |
| Antenna description | `pskreporter.antenna` | text | — | Shown alongside your spots on pskreporter.info. Optional. |
| Collect reception reports | `pskreporter.enabled` | on/off | `false` | Ask PSKReporter which receivers heard our transmissions, and attach their reports to the contacts they belong to — the 'Heard by' panel on a contact. Downloads; the setting above uploads. Queried every five minutes, which is the most often PSKReporter permits. Most reports are of CQs that led to no contact and cannot be attached to one, so they are counted and discarded. |

## Digital modes

Where decodes and rig status come from. `wsjtx` takes them from an external decoder — WSJT-X or a fork of it — over its UDP protocol; `flex` and `icom` talk to the radio directly with no external decoder at all. All three are implemented — pick one.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Decode source | `digital.source` | text | `wsjtx` | One of "wsjtx" (an external decoder over the WSJT-X UDP protocol), "flex" (direct to a FlexRadio) or "icom" (direct to a networked Icom over RS-BA1). The bridge reads this at startup. "omega" is still accepted and means "wsjtx" — that was a reference to one particular fork of WSJT-X, never to anything DigiShack does. |
| Time server | `time.ntpServer` | text | `pool.ntp.org` | Where to ask what time it is, over SNTP. FT8 tolerates about a second of clock error before decoding degrades and other stations stop decoding you — and DigiShack cannot set the system clock (that needs elevation, and in a container it is the host's clock anyway), so instead it measures the difference and compensates internally. Blank disables the check entirely, which leaves you relying on the decode-median estimate that needs eight decodes before it can say anything. |
| Compensate for a wrong clock | `time.correct` | on/off | `true` | Apply the measured offset to transmit timing, decode windows and logged contact times. Off measures and displays it without changing anything. Corrections above 5 seconds are always refused: that is not a clock needing a nudge, it is a machine whose time is wrong, and quietly compensating would hide it and produce a log nobody can reconcile. |
| Re-check the clock every (minutes) | `time.syncMinutes` | number | `60` | How often to re-measure. Hourly is plenty for a machine that is roughly synchronised, and one exchange is 48 bytes. 0 measures once at startup and never again. |
| Also write every decode to CSV in | `digital.decodeCsvDir` | text | — | A directory on the server. One file per UTC day, `decodes-YYYY-MM-DD.csv`, holding every decode heard — including ones with no resolvable band, which never reach the database. Leave blank to write none. This is separate from the database copy, which is pruned after `digital.decodeRetentionDays`: the table is what the application queries, this is the raw feed kept for its own sake in a format that outlives the schema. A busy band produces around 42,000 rows a day, which is a few megabytes. |
| Passband to decode and display (Hz) | `digital.passbandHz` | number | `3000` | Top of the audio passband: what the decoders search AND what the waterfall draws — one number, so the display cannot disagree with the decoder. 3000 is the conventional FT8 sub-band and the decoder library's own default. Raising it finds stations above 3 kHz that were being clipped: a busy band shows a hard stop at exactly 3000, which is a clipped distribution rather than a natural one. It costs decode time, so watch for the "decode took Nms" warning, and note that most radios will not TRANSMIT above about 2.9 kHz whatever the receiver hears — stations found up there can be decoded but not answered. |
| Digital mode | `digital.mode` | text | `auto` | auto \| ft8 \| ft4 \| ft2. Auto infers the mode from the dial frequency, which is the only reliable way — a DIGU slice does not say which mode it carries, and the three use different window lengths (15 / 7.5 / 3.75 s). FT2 has provisional calling frequencies so auto does find it, except on 60 m where it shares 5.357 MHz with FT4 and auto resolves to FT4; pin ft2 here to run it there or anywhere off-frequency. |
| Keep decodes for (days) | `digital.decodeRetentionDays` | number | `30` | A busy band produces around 42,000 decodes a day — roughly 10 MB, or 3.7 GB a year — and nothing used to delete any of it. Decodes attached to a logged contact are NEVER pruned whatever this says; they are the evidence of the QSO. 0 keeps everything, which is fine if you have the disk and want the full history. |

## DigiShack bridge

DigiShack's own radio service (`npm run bridge`): the process that owns the radio, decodes, transmits and serves the live feed. It runs separately from the web application because it binds a UDP socket, and a bound socket cannot be shared across cluster workers. These settings are about the service itself, whichever radio it is driving.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Bridge HTTP/WS port | `bridge.port` | number | `3101` | Where the bridge serves the live decode WebSocket and its control API. Not the Next.js port. |
| Bridge listen address | `bridge.bindAddress` | text | `127.0.0.1` | Which address the radio service listens on. 127.0.0.1 (the default) means only this machine can reach it, which is why listening to receiver audio from a phone or another computer does not work out of the box. Set it to 0.0.0.0 to allow the rest of your network. Read this before you do: the control API is protected by a shared secret, but the decode and audio WebSockets are NOT — anything on your network could listen to your receiver. On a home LAN behind a router that is usually fine; on shared or public wifi it is not. The safer alternative is leaving this alone and proxying /ws/decodes and /ws/audio through NGINX on the app's own origin, then setting the public WebSocket URL below. |
| Bridge shared secret | `bridge.token` | secret | from `BRIDGE_TOKEN` | Authenticates the web app to the bridge's control API. Self-provisioned on first run — there is nothing to decide here. |
| Public WebSocket URL | `bridge.wsUrl` | text | — | Where browsers reach the live decode feed. Leave blank for development (the bridge port on this host). Behind NGINX set wss://your-host/ws/decodes. |

## External decoder (WSJT-X)

Used when the digital source is `wsjtx`. Point the decoder's UDP server at this host. Any program speaking the WSJT-X UDP protocol works — WSJT-X itself, JTDX, wsjtx-omega.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| UDP port | `wsjtx.udpPort` | number | `2237` | Port the decoder broadcasts the WSJT-X protocol on. WSJT-X defaults to 2237. |
| UDP bind address | `wsjtx.udpHost` | text | `0.0.0.0` | Address DigiShack listens on for WSJT-X's UDP broadcasts. 0.0.0.0 accepts them from any machine on the network; 127.0.0.1 only from this one. Used only when the digital source is the external decoder. |
| Auto-log QSOs from the decoder | `wsjtx.autoLog` | on/off | `false` | Write a QSO when the external decoder reports a completed contact. |

## FlexRadio (direct)

Used when the digital source is `flex`. DigiShack connects to the radio's SmartSDR API itself. Read-only: it never changes slices, modes or transmits — an operator's SmartSDR session is not disturbed.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Radio address | `flex.host` | text | — | Leave blank to discover the radio automatically on the LAN. |
| Discover automatically | `flex.autoDiscover` | on/off | `true` | Listen for the radio's UDP broadcast instead of using a fixed address. |
| Decoder depth | `flex.decodeDepth` | number | `2` | 1-4. Leave it at 2. MEASURED on a Xeon E5-2630 v3 with a 3 kHz passband: depth 1 takes 1312-2021 ms and depth 2 takes 1435-1795 ms — the SAME, sometimes worse, so lowering it buys nothing and only decodes less. Depth 3 is 3910-6692 ms, three to four times the cost, and 4 is far beyond the 15 s cycle. Cost barely changes with how busy the band is: one signal and twenty measure about the same, because it is a search over the passband rather than work per station. An earlier version of this text claimed ~0.55 s for depth 2; that was never true on this hardware. |
| DAX IQ / audio channel | `flex.daxChannel` | number | `1` | Which DAX channel carries the audio to decode. Used by the native decode path. |
| RF panadapter | `flex.panadapter` | on/off | `true` | Show tens of kHz of RF spectrum from the radio's own panadapter, alongside the audio waterfall rather than instead of it. The audio waterfall stays because the FT8 decoder searches a 3 kHz passband and the display has to show the same 3 kHz. Costs about 60 kB/s from the radio at the defaults below, comparable to the audio stream. FlexRadio only so far — see docs/panadapter.md for why the Icom's scope is not enabled yet. |
| Panadapter span | `flex.panadapterSpanKHz` | number | `200` | How much band to show, in kHz. The radio accepts 4.92 kHz to 7372.8 kHz (measured, not documented). Normally set from the Span buttons on the panadapter itself, which write back here — this is just where the choice is remembered across restarts. 200 kHz holds a digital sub-band plus the CW and SSB activity either side of it; 20 kHz is enough for one FT8 watering hole in context. |
| Panadapter resolution | `flex.panadapterBins` | number | `2048` | Bins across the span. The radio's real ceiling is 4096 — measured: asking for 8192 silently returns 4096. More bins than screen pixels is not wasted, because the display takes the strongest bin per pixel, which is what keeps a narrow carrier visible instead of averaging it into the noise. |
| Panadapter frame rate | `flex.panadapterFps` | number | `10` | Frames a second. The radio delivered 95 against a request of 100, so this is not the limit — bandwidth is: every frame is sent to every open page. Vertical resolution on a waterfall IS time, so this is a trade rather than a quality setting: at 10 rows a second a 220-pixel canvas holds 22 seconds of history. |
| Panadapter averaging | `flex.panadapterAverage` | number | `20` | How much the radio averages successive spectrum frames before sending them, 0-100. This is averaging in TIME, not across frequency: a steady carrier is present in every frame and averages to itself, while noise is different every frame and averages down — so unlike the resolution setting above, this does not smear a narrow signal into its neighbours. It was hardcoded off, and off is expensive: a single unaveraged FFT bin's noise spreads 12.65 dB from its 25th to its 99.5th percentile, and the display has to give all of that to the dark end of the colour ramp, leaving less of the palette for actual signals. Averaging four frames roughly halves that spread. 0 disables it; the display is correct either way, just grainier. |
| Take control of the radio's active slice | `flex.controlMainSlice` | on/off | `true` | Tunes the slice you are looking at to the operating frequency, sets it to DIGU, and makes it the transmit slice. Leave it on unless you deliberately want SmartSDR to own the radio. With it OFF and SmartSDR connected, DigiShack transmits through whichever slice already carries the TX flag and does not touch it — which on two stations meant transmitting on 40m while the operator worked 20m, through a slice that was in CW with no transmit audio. It keys and no power comes out. |
| Allow transmit | `flex.allowTransmit` | on/off | `false` | Master gate for DigiShack's native FT8/FT4 transmit. Off means nothing can key the radio, ever — the QSO controls will refuse. Turn on only when the radio is connected to a proper antenna or load and the power level is where you want it. |
| Antenna port | `flex.antenna` | text | — | Which antenna socket to use, on a radio that has more than one. Every FLEX-6000 has ANT1 and ANT2, and the larger models add receive-only BNCs and a transverter port — DigiShack used to write ANT1 into every slice it created and never read the antenna back, so a station with the wire on ANT2 got a bridge listening to an empty socket. The names are the RADIO'S own: it reports them (a FLEX-6400 answers ANT1, ANT2, RX_A, XVTA) and /rig offers exactly that list. ANT2, ant2 and a bare 2 all mean the same socket. Leave blank to use whatever the radio is already set to, which is right for a single-antenna station and for one where the choice is made in SmartSDR. A port this radio does not have is REFUSED and said so on /rig, not quietly turned back into ANT1. Only ever applied to a slice DigiShack owns — an operator working a station in SmartSDR does not get their antenna moved underneath them. |
| Receive antenna port | `flex.rxAntenna` | text | — | A separate socket to LISTEN on: a receive loop, a beverage, or the 6600's RX_A BNC. Blank means listen on the antenna above, which is the normal case. The radio keeps two lists and so does DigiShack — a receive-only socket appears in one and not the other, so it can be selected here and cannot be selected for transmit. The RF panadapter is moved with it: a panadapter carries its own antenna, and one left on a different socket from the receiver draws a confident spectrum of the wrong aerial with correct-looking axis labels. |
| Tune ATU on band change | `flex.atuOnBandChange` | on/off | `false` | Run the antenna tuner (atu start) automatically after retuning to a new band. |
| Default frequency (Hz) | `flex.defaultFreqHz` | number | `7074000` | Where the radio comes up when DigiShack has to create its own slice (no SmartSDR/AetherSDR running). Default 7074000 = 40m FT8. |

## Operating schedule

What the station should be doing, and when. All times are the SERVER's LOCAL time, not UTC — sleeping hours are a fact about your house, not about the log. Three separate things: which automatic mode runs during which hours, a quiet period when nothing transmits at all, and a duty-cycle limit that rests the finals.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Follow the operating schedule | `schedule.enabled` | on/off | `false` | When on, the automatic mode is chosen by the schedule below instead of whatever you last set by hand. Turning it off leaves the radio exactly as it is — it does not stop an automatic mode that is already running. |
| Working hours | `schedule.hours` | text | — | Blocks of the day and what to run in each. End times are exclusive, so 08:00-12:00 and 12:00-16:00 sit next to each other without overlapping. Any time not covered is off. Where blocks overlap the later one wins, so you can write a broad rule and carve an exception out of it. |
| Sleeping hours | `schedule.sleep` | text | — | Nothing transmits during these hours, whatever the working hours say. Wraps midnight. This overrides the schedule rather than merging with it — it is what stops the station calling CQ next to someone asleep, so it has to win. |
| PA cooldown after (transmit minutes) | `schedule.paAfterMinutes` | number | `0` | Rest the transmitter once it has been keyed this many minutes. Counts ACTUAL transmit time, not elapsed time: FT8 alternates transmit and receive, so an hour of operating is roughly half an hour of transmitting, and an hour spent listening does not heat anything. 0 turns the cooldown off. |
| PA cooldown rest (minutes) | `schedule.paRestMinutes` | number | `10` | How long to stay off transmit once the limit above is reached. The transmit counter starts again from zero afterwards. |

## Bridge watchdog

Restarts the radio bridge when it stops working while still appearing to run. PM2 only checks that the process exists, and on 2 August 2026 the process existed for five hours after it had produced its last decode. This watches the decode windows instead, which arrive once per T/R period whether or not anything is heard.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Restart the bridge if it stops decoding | `bridge.watchdog.enabled` | on/off | `true` | Exits the bridge when no decode window has arrived for a while, so PM2 restarts it. A hung event loop or a socket that stopped delivering cannot be repaired from inside the process that is hung — a fresh one is the only reliable cure. Off means a hang goes unnoticed until you look. |
| Quiet periods before restarting | `bridge.watchdog.periods` | number | `8` | How many T/R periods of no decode window count as dead. 8 is two minutes on FT8, and never fires on a working radio — a single late window is not a fault, so this must not be set to 1 or 2. There is a 60-second floor for the faster modes. |

## Icom (network)

Used when the digital source is `icom`. Speaks the RS-BA1 network protocol directly — the same one the Icom remote software uses — so no third-party bridge, no virtual audio cable and no virtual COM port. The username and password are the ones set in the radio's own network menu, not your callsign or your DigiShack login.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Radio address | `icom.host` | text | — | The radio's IP address on your network. Set a DHCP reservation for it — the address is stored here, and a radio that moves stops answering with no other symptom. |
| Network user name | `icom.username` | text | — | From the radio's Network menu, under Network User1. Not your callsign, and not your DigiShack login. |
| Network password | `icom.password` | secret | — | The password for that network user. It is obfuscated on the wire by a published substitution table, not encrypted — treat it as readable by anyone who can watch the network, and do not reuse a password that matters. |
| CI-V address | `icom.civAddress` | text | — | Hex, e.g. 94 for an IC-7300 or A4 for an IC-705. Leave blank to use the default for whichever model the radio reports at login, which is right unless you have changed it in the radio's CI-V menu. |
| Control port | `icom.controlPort` | number | `50001` | UDP port for the control stream. 50001 unless you have changed it in the radio. The serial and audio streams follow on 50002 and 50003. |
| Serial (CI-V) port | `icom.serialPort` | number | `50002` | UDP port carrying CI-V — frequency, mode, PTT and the meters. |
| Audio port | `icom.audioPort` | number | `50003` | UDP port carrying receive and transmit audio, at 48 kHz. |
| Decoder depth | `icom.decodeDepth` | number | `2` | 1-4. Depth 2 is the live default: about 0.6 s per window, comfortably inside the gap between FT8 cycles. Depth 3 fits with less margin; depth 4 takes around 11 s and cannot keep up with a 15 s cycle. |
| Transmit power (%) | `icom.rfPowerPercent` | number | `0` | Set the radio's RF power on connect, 1-100. Leave at 0 to use whatever the radio is already set to. Worth setting: an IC-7300 left at 100% into a 50%-duty digital mode is how power amplifiers die. |
| Send silence on the audio stream | `icom.audioKeepalive` | on/off | `true` | The RS-BA1 audio socket is bidirectional and the radio appears to cut a receive-only client's audio after a minute or two. Sending silence while idle was meant to prevent that. Measured on the air, it does not: 95 keepalives went out during the 20 seconds before the audio was declared stalled, and the radio answers at roughly the rate we send, which is the shape of a radio reacting to us rather than ignoring us. Leave it on unless you are measuring; turning it off is how to find out whether it helps or harms. |
| Run the ATU after a band change | `icom.atuOnBandChange` | on/off | `false` | Runs the radio's internal tuner (CI-V 1C 01) after an automatic band change or a POTA retune. THIS TRANSMITS — a low-power carrier for a second or two — so it is gated on Allow transmit like every other keying path, and it is off by default. Without it, band hopping lands on a band the tuner has never seen and the radio folds back on the first transmission. Leave it off with a resonant antenna or an external tuner. |
| Allow transmit | `icom.allowTransmit` | on/off | `false` | Off means nothing can key this radio, ever. Separate from the FlexRadio's switch on purpose, and it inherits nothing from it: arming a Flex sitting on a proper antenna says nothing about an IC-7300 that might be on a dummy load or halfway through being set up. Each radio is armed deliberately or not at all. |
| Silence threshold | `icom.silenceRms` | number | `0.0008` | Windows quieter than this are skipped without decoding. Lower than the FlexRadio equivalent on purpose: Icom audio arrives at 48 kHz and needs two decimation passes to reach the decoders' 12 kHz, against the Flex's one from 24 kHz, and the filter has about 0.8 gain per pass — so the same signal is roughly 20% quieter here. Reusing the Flex value would silently skip marginal windows and look like an antenna fault. |

## Issue alerts

Email when the station goes wrong — the radio unreachable, the bridge restarted by its watchdog, uploads failing repeatedly. One email per condition with a cooldown, and a recovery note when it comes back. Uses the same SMTP settings as QSL email.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Radio-down reminder interval | `alerts.radioDownReminderHours` | number | `12` | How often to email again while the radio stays unreachable, in hours. A radio that is off needs somebody to go and switch it on, and the only thing that produces that is a message which keeps arriving — this used to alert once, four minutes in, and then go quiet. After a mains outage on 11 August 2026 the bridge retried 8,223 times over 94 hours having sent exactly one email on the first evening. These reminders ignore the general alert cooldown below, because repeating is the entire point. Set it to a large number to effectively disable the repeat; the first alert is always sent. |
| Email me when something goes wrong | `alerts.enabled` | on/off | `false` | Radio unreachable for minutes, the bridge restarted by its own watchdog, uploads failing run after run, a guard stopping transmission over high SWR or PA temperature. Needs working SMTP (Settings → QSL). |
| Send alerts to | `alerts.email` | text | — | Blank sends to the first active admin's address. |
| Quietest repeat for the same issue (minutes) | `alerts.cooldownMinutes` | number | `360` | A fault that persists re-sends after this long; a fault that clears and returns emails again immediately. This is what keeps a flapping radio from burying the one email that mattered. |

## Software updates

Lets an admin pull and deploy a new version from the Updates page. This runs code from the remote branch on this server, so it is off until you turn it on. Only ever fast-forwards, and refuses to run with uncommitted local changes.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Allow updating from the UI | `update.allowFromUi` | on/off | `false` | Off by default on purpose — enabling it means an admin account can deploy new code to this server. |

## Outgoing email

Used by the QSL emailer. Those are unsolicited emails to other operators, so bulk sends always go through a review queue.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| SMTP host | `smtp.host` | text | from `SMTP_HOST` | Mail server for everything DigiShack sends — QSL emails and station alerts. Without it both are silently unavailable, which is why the Integrations page reports SMTP on its own. |
| SMTP port | `smtp.port` | number | `587` | 587 for STARTTLS, which is the usual choice. 465 for implicit TLS with the setting below turned on. 25 only on a local relay. |
| Implicit TLS (port 465) | `smtp.secure` | on/off | `false` | On only for implicit TLS on port 465. Leave it OFF for STARTTLS on 587, which is the usual arrangement — the connection is still encrypted, just negotiated after connecting. |
| SMTP username | `smtp.user` | text | from `SMTP_USER` | The account to authenticate as. Often the full email address rather than a short name, depending on the provider. |
| SMTP password | `smtp.password` | secret | from `SMTP_PASSWORD` | For Microsoft app passwords, remove the spaces. |
| Operator name for QSL emails | `qsl.operatorName` | text | — | Signed at the bottom of QSL confirmations, alongside the station callsign. Leave blank to sign with the callsign only. |
| From address | `smtp.from` | text | from `SMTP_FROM` | The address messages appear to come from. Many providers refuse to send when this does not match the authenticated account, and the refusal usually names the mismatch. |

## Automatic operating limits

Brakes on the autonomous modes. The wall-clock and QSO limits are the only ones that bound a session in absolute terms — every other guard counts events and is reset by making progress. SWR and PA temperature protect the radio, and a band change deliberately does not clear them.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Hunt only new ones | `auto.huntNewOnly` | on/off | `false` | Auto Hunt calls only stations that offer something new (DXCC entity, band slot, state, CQ zone, grid). Off by default — on a quiet band you usually want the contact. |
| Hunt minimum SNR (dB) | `auto.huntMinSnr` | number | `-22` | Do not call stations weaker than this; the QSO is unlikely to complete and the cycles are better spent elsewhere. |
| Auto band-hop | `auto.bandHop` | on/off | `false` | When an auto mode stalls (dead band, no answers), retune to the next band on the hop list, listen two cycles, and either resume or hop again. |
| Band-hop list | `auto.hopBands` | text | `40M,20M,30M,80M` | Comma-separated bands to rotate through when band-hopping. |
| Leave a working band when another is this much busier | `auto.hopWhenBetterRatio` | number | `2.5` | Band-hopping otherwise only triggers when a band goes QUIET — a station happily making contacts on 40m will stay there while 20m runs three times busier. This moves it: at 2.5, another band on the hop list must be 2.5x busier before the radio leaves one that is working. A ratio rather than a difference, so it means the same at 30 stations as at 300. Set to 0 or 1 to switch it off. Only ever considers bands on the hop list, and never interrupts a contact. |
| Hop to the busiest band | `auto.hopToBusiest` | on/off | `false` | Instead of rotating through the hop list in order, jump to whichever band on it the PSKReporter network currently sees the most stations on — the same SEEN figures the band strip on the decodes page shows. Falls back to rotating in order when the network is unreachable. Only bands on the hop list are ever considered. |
| Stop automatic operating after (minutes) | `auto.maxRunMinutes` | limit | `240` | Wall-clock ceiling on one run. 0 disables it. This is the ONLY guard that bounds automatic operation in time — every other brake counts events and is reset by making progress, so a station that keeps working people could otherwise transmit indefinitely. |
| Stop after this many QSOs | `auto.maxQsosPerRun` | limit | `100` | Ceiling on contacts in one run. 0 disables it. Not reset by anything short of a re-arm. |
| Stop above this SWR | `auto.maxSwr` | limit | `3` | High SWR unattended means a damaged or disconnected antenna. A Flex folds power back past 3:1 anyway. Changing band does NOT clear this — it needs you to look at the antenna. |
| Stop above this PA temperature (C) | `auto.maxPaTempC` | limit | `75` | Pauses transmitting when the PA reaches this temperature, in Celsius, and resumes once it has fallen back. A duty-cycle brake that reads the radio rather than guessing from a timer. |
| Pause after this many transmissions without you | `auto.maxConsecutiveTx` | limit | `20` | The runaway brake. Reset by any operator interaction and by every completed QSO, which is why the wall-clock limit above exists as well. |
| Give up after this many unanswered CQs | `auto.maxUnansweredCqs` | limit | `15` | Treated as a quiet band, so band-hopping may move rather than stop. |
| Stop after this many silent receive windows | `auto.deafWindowLimit` | limit | `4` | Windows that decode nothing AND carry no audio — a dead audio path, wrong slice or antenna fault. A station that cannot hear must not transmit. |
| Give up on a station after this many calls | `auto.maxCallAttempts` | limit | `5` | How many times an automatic mode calls one station before giving up and moving on. Each attempt is a full transmit cycle, so this is a time budget as much as a persistence setting — four is roughly two minutes on FT8. |
| Do not re-call a station for (minutes) | `auto.failureCooldownMin` | limit | `30` | How long to leave a station alone after giving up on them. Stops you watching the same unanswered call repeat every few minutes while the rest of the band goes unworked. |
| Skip stations already worked within (hours) | `auto.dupeWindowHours` | limit | `24` | Same band and same mode, where mode means FT8, FT4 or FT2. A station is worked at most once per UTC day per slot as well, so shortening this cannot bring same-day duplicates back — set it to two hours to chase an opening and each station is still worked once today. Zero turns the guard off entirely, which is the only way to allow duplicates and has to be typed in deliberately. |
| Never make a duplicate contact, with EVERYONE | `auto.skipWorkedOnBandMode` | on/off | `false` | OFF by default, and the normal way to prevent duplicates is the per-callsign list below rather than this. Turning this on applies one blanket rule to every station you work: no second contact on a band and mode already in the log, ever. Some operators want exactly that; most would rather honour the specific people who have asked. A different MODE on the same band is still allowed either way, because that is a genuinely new slot. |
| Never re-work a station on a band already worked | `auto.skipWorkedOnBand` | on/off | `false` | A stricter rule than the dupe window above, and a different question: that one asks whether you worked them RECENTLY on this band and mode, this asks whether you have EVER worked them on this band, in any mode. Mode-agnostic on purpose — a band slot is a band slot, and somebody worked on 20 m FT4 is not a new 20 m contact because today it is FT8. Off by default: with a large log this silences a great deal of a domestic band, which is right for an award chaser filling slots and wrong for anyone who just wants contacts. It only ever restricts the automatic modes; you can still call anyone by hand. |

## Automatic uploading

Pushing contacts to the log-hosting services as they are made. Off by default, and it uploads only contacts logged AFTER you switch it on — a log that predates this feature is almost certainly already on those services from whatever you used before, and re-sending 26,000 contacts to discover that is rude to them and slow for you. Use the compare on the Integrations page to mark what is already there.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Upload to Cloudlog / Wavelog | `uploads.cloudlog` | on/off | `false` | Push each contact to your own Cloudlog or Wavelog installation. Needs the URL, API key and station profile id under Cloudlog / Wavelog. |
| Log to N3FJP Amateur Contact Log | `uploads.n3fjp` | on/off | `false` | Push each contact to N3FJP Amateur Contact Log over its TCP API. Unlike the other targets this is a program on your own desk rather than a web service: enable its listener first, under Settings -> Application Program Interface (API) -> "TCP API Enabled (Server)". Contacts made while the program is closed are not lost — they stay flagged unsent and go out on the next sweep after it comes back. |
| Upload contacts automatically | `uploads.enabled` | on/off | `false` | Master switch. When on, each new contact is uploaded shortly after it is logged, and a sweep catches anything missed. Nothing already in the log is touched — see the cutoff below. |
| Upload to QRZ Logbook | `uploads.qrz` | on/off | `true` | Needs the QRZ logbook API key (a separate subscription from an ordinary QRZ account). A contact QRZ reports as a duplicate is marked as sent rather than retried — it is already there, which is the outcome wanted. |
| Only send eQSLs to operators who sent us one | `uploads.eqslReciprocalOnly` | on/off | `true` | On eQSL the upload IS the card — it is a card-exchange service with no log-only mode, so there is no way to record a contact there without creating an outgoing eQSL. With this on, one is only created for a contact where THEY have already sent us an eQSL, which is returning a card rather than initiating one, and is the etiquette of QSLing anyway. It also cuts the backlog by two thirds, and eQSL takes one request per contact. |
| Contacts per Cloudlog/Wavelog sweep | `uploads.cloudlogBatch` | number | `200` | Cloudlog and Wavelog take one request per contact, like QRZ and eQSL — but unlike those, the server is YOURS. The general per-run limit exists to be polite to other people's services and to stay inside their rate limits; neither applies to a box on your own network, so a backlog there has no reason to take days. Lower it if the server is small or shared. |
| Contacts per LoTW upload | `uploads.lotwBatch` | number | `500` | LoTW takes one signed file per sweep however many contacts are in it, so the general per-run limit means something different here. That limit exists because QRZ and eQSL take one request PER CONTACT — 25 of them is 25 API calls — whereas for LoTW 25 and 500 are both a single POST. At 25 a six-thousand-contact backlog takes two days for no reason. TQSL users routinely upload a whole log in one file. |
| Upload to LoTW | `uploads.lotw` | on/off | `false` | Needs a callsign certificate uploaded under Logbook of the World — there is no username-and-password path for uploads, because the signature on each contact is the authentication. Contacts go up in one signed batch per run. LoTW discards duplicates, so a re-sent batch is harmless, which is why an ambiguous timeout is treated as a failure and retried rather than assumed to have worked. |
| Upload to eQSL.cc | `uploads.eqsl` | on/off | `false` | Off by default like every other upload target, because it posts a card to another operator rather than filing a record with a service. eQSL takes one contact per request as ADIF in a query string, with your username and password in it — that is eQSL's design, not a choice available here, and it is why this needs the eQSL credentials set under eQSL.cc rather than an API key. A contact eQSL reports as a duplicate is marked done rather than retried: already being there is the state we wanted. |
| Upload to Club Log | `uploads.clublog` | on/off | `false` | Off by default: uploads from this installation are refused with a bare nginx 403 that arrives before authentication, and the cause is outside this software. Downloads and log reconciliation work normally. Pointing Club Log at LoTW populates it without uploading from here at all. |
| Only upload contacts made after | `uploads.since` | text | — | ISO date, e.g. 2026-08-01. Contacts older than this are never uploaded automatically. This is the guard that stops switching the feature on from pushing your entire back catalogue. Leave blank only if you are certain nothing older needs skipping. |
| Most contacts to upload per run | `uploads.maxPerRun` | number | `25` | A cap so a backlog is worked through gradually rather than in one burst against someone else's API. |
| Sweep for un-uploaded contacts every (minutes) | `uploads.intervalMinutes` | number | `10` | Catches contacts entered by hand or imported, which the per-QSO trigger never sees. 0 disables the sweep, leaving only the per-QSO path. |

## POTA chasing

How the POTA chase mode picks activators. The band rule is the important one: a chaser that follows every spot spends most of its time tuned to frequencies where nothing is audible, and every excursion costs the give-up time before it can try again.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| Bands to chase on | `pota.chaseBands` | text | — | Comma-separated, e.g. "20M,17M,15M". Blank means the band you are already decoding on and nothing else. "any" follows spots onto any band. Restricting this is what makes chase mode productive: 30 FT8 spots spread over eight bands means most retunes land somewhere you cannot hear, and each one costs the give-up time below before another can be tried. |
| POTA session token (for importing your log) | `pota.userToken` | secret | — | Only needed to import your POTA hunter log — nothing else uses it. POTA's public API stops at 25 recent contacts, and the full log needs the session token from a browser signed in to pota.app. To get it: sign in at pota.app, open your browser's developer tools, go to the Network tab, click any request to api.pota.app, and copy the whole value of the Authorization request header. It is a short-lived AWS Cognito token and will expire in hours, which is why this is a one-time backfill rather than a live connection — once the history is in, DigiShack records park references itself from every contact it makes. |
| Give up on an activator after (seconds) | `pota.chaseGiveUpSec` | number | `90` | How long to sit on a park frequency without hearing the activator. Six FT8 cycles is 90 s. Too short and you miss someone working a pile-up; too long and one dead spot eats the session. |
| Do not retry an activator for (minutes) | `pota.chaseRetrySpotMin` | number | `30` | After giving up on, or finishing with, an activator. They usually stay in a park for an hour or more, so a short value means chasing the same handful repeatedly. |
| Also work POTA CQs heard on frequency | `pota.chaseWorkAudible` | on/off | `true` | While waiting for a spot worth chasing, work any station calling "CQ POTA" that is already audible. They are free contacts — no retune, no deaf period — and an activator is often heard before the spot feed catches up. |
| Prefer parks and entities you have not worked | `pota.chasePreferNew` | on/off | `true` | Ranks spots by award value — a new DXCC entity or a callsign never worked before goes first — rather than purely by which spot is freshest. |
| Return to the calling frequency when idle | `pota.chaseReturnToCalling` | on/off | `true` | When there is nothing worth chasing, come back to the band's standard FT8/FT4 frequency instead of sitting on the last park. Without this the radio stays parked wherever the last activator was, hears nothing, and cannot fall back to ordinary hunting. |

## QSL card and email

Everything the recipient sees is a template here, not a string in the code. A QSL card makes claims about how you operate — which services you upload to, whether you will answer a paper card — and those are yours to word. Use the Preview button on the QSL page to see a real card before sending anything.

| Setting | Key | Type | Default | What it does |
|---|---|---|---|---|
| QSL email subject | `qsl.email.subject` | text | `QSL Confirmation for {THEIR_CALL} / {MY_CALL} QSO` | Tokens: {THEIR_CALL} {MY_CALL} {MY_NAME} {MY_GRID} {THEIR_GRID} {DATE} {TIME} {DATETIME} {YEAR} {BAND} {MODE} {FREQ} {RST_SENT} {RST_RCVD} {POWER} {MY_QTH} |
| QSL email body | `qsl.email.body` | multi-line text | `{THEIR_CALL},

Thank you for the QSO. Please find my QSL card attached. I have also uploaded the contact to LOTW, eQSL, QRZ, and Clublog.

73,
{MY_NAME}
{MY_CALL}` | The message above the contact data. Tokens: {THEIR_CALL} {MY_CALL} {MY_NAME} {MY_GRID} {THEIR_GRID} {DATE} {TIME} {DATETIME} {YEAR} {BAND} {MODE} {FREQ} {RST_SENT} {RST_RCVD} {POWER} {MY_QTH} |
| Contact data heading | `qsl.email.contactDataHeading` | text | `Contact Data` | Heading above the contact detail block. Blank to omit the block entirely. |
| Contact data block | `qsl.email.contactData` | multi-line text | `Call: {THEIR_CALL} DE {MY_CALL}
Date: {DATE} {TIME}:00 UTC
Freq: {FREQ} MHz
Band: {BAND}
Mode: {MODE}
RSTS: {RST_SENT}
RSTR: {RST_RCVD}
TX Power: {POWER}
My Grid: {MY_GRID}
Your Grid: {THEIR_GRID}` | Fixed-width detail block. A line whose only token is empty is dropped, so optional fields disappear cleanly. Tokens: {THEIR_CALL} {MY_CALL} {MY_NAME} {MY_GRID} {THEIR_GRID} {DATE} {TIME} {DATETIME} {YEAR} {BAND} {MODE} {FREQ} {RST_SENT} {RST_RCVD} {POWER} {MY_QTH} |
| Embedded card heading | `qsl.email.cardHeading` | text | `Embedded QSL Card:` | Heading above the card shown inline in the email. Blank to omit the heading. |
| Show the card inline | `qsl.email.embedCard` | on/off | `true` | Display the card in the message body. Most clients show it; a few show the attachment only. |
| Attach the card as a file | `qsl.email.attachCard` | on/off | `true` | Attach as well as embed, so the recipient can save it. Recommended: an inline-only image is awkward to keep. |
| Transmit power for QSL cards | `qsl.txPower` | text | — | Fills {POWER}. A station constant rather than a per-QSO field — there is no per-QSO power column, and for digital work it rarely varies. Blank omits the line. |
| QTH text for QSL cards | `qsl.qth` | text | — | Fills {MY_QTH}, e.g. "Porter County, Indiana". Blank omits it. |
| Queue QSL emails automatically | `qsl.auto.enabled` | on/off | `false` | Look for contacts that have no QSL yet, resolve the address from QRZ, and add them to the review queue. On its own this sends nothing. |
| Send them without review | `qsl.auto.approve` | on/off | `false` | Approve and send automatically, with no human looking first. Needs the setting above. An emailed QSL cannot be recalled, so leave this off until you have seen a few queued messages you are happy with. |
| Most QSL emails per day | `qsl.auto.maxPerDay` | number | `25` | Rolling 24-hour ceiling on messages actually sent, counted from the queue's own record. A sudden burst of mail from one address is how a server earns a spam reputation. |
| Most per pass | `qsl.auto.maxPerRun` | number | `5` | How many one pass may send. Keeps a 26,000-QSO backlog from going out in an afternoon when the feature is first switched on. |
| Wait this long after the QSO (minutes) | `qsl.auto.minAgeMinutes` | number | `15` | A mistyped callsign is usually spotted within a minute or two, and an emailed QSL cannot be taken back. This is the window in which a logging error is still free to fix. |
| Ignore contacts older than (days) | `qsl.auto.maxAgeDays` | number | `7` | Stops switching the feature on from mailing years of back-log. Raise it deliberately if you do want to work through older contacts. |
| Check every (minutes) | `qsl.auto.intervalMinutes` | number | `30` | How often the radio service looks for eligible contacts. Needs a restart to take effect. |
| Render a QSL card | `qsl.card.enabled` | on/off | `false` | Off sends a text-only confirmation. Needs artwork at the path below. |
| Card artwork path | `qsl.card.baseImage` | text | `data/qsl/card-base.png` | Your card image, with no table or placeholder text on it — the QSO table is composited on top. Relative to the install directory. Never committed to git. |
| Card table columns | `qsl.card.columns` | text | `CALL,DATE,TIME,BAND,REPORT,MODE` | Comma-separated, in order. Available: CALL DATE TIME BAND FREQ REPORT RST_RCVD MODE POWER GRID. |
| Card footer line | `qsl.card.footer` | text | `73, Thanks for the QSO! Will QSL by mail for any cards received as well.` | Full-width line under the table. Blank to omit it. Tokens: {THEIR_CALL} {MY_CALL} {MY_NAME} {MY_GRID} {THEIR_GRID} {DATE} {TIME} {DATETIME} {YEAR} {BAND} {MODE} {FREQ} {RST_SENT} {RST_RCVD} {POWER} {MY_QTH} |
| Card width for email (px) | `qsl.card.width` | number | `1600` | Artwork is scaled to this before the table is drawn. 1600 is a good balance; full resolution artwork can be tens of MB and this goes out once per QSO. |
| Table width (fraction) | `qsl.card.tableWidth` | number | `0.6` | 0.6 = 60% of the card width. Geometry is fractional so one setting fits any artwork size. |
| Table inset from right (fraction) | `qsl.card.tableRight` | number | `0.012` | How far the QSO table sits from the RIGHT edge, as a fraction of the card's width (0.05 = five per cent in). A fraction rather than pixels, so one setting works whether the artwork is 1500 px wide or 5000. |
| Table inset from bottom (fraction) | `qsl.card.tableBottom` | number | `0.012` | How far the table sits from the BOTTOM edge, as a fraction of the card's height. Same reasoning as the setting above. |
| Table font scale | `qsl.card.fontScale` | number | `1` | 1 = automatic size from the table width. Raise or lower to taste. |
| Card font | `qsl.card.font` | select | `PT Sans Narrow` | Typeface for the QSO table. DigiShack SHIPS these, so they render identically on every machine: "PT Sans Narrow" (condensed, the classic QSL table and the default), "Lato" (a wider humanist sans) or "PT Serif" (more formal). All three are SIL Open Font License 1.1 with the licence text beside them in assets/fonts. Any other name is passed to the system, which works only if that font is installed on the server — the bundled ones need nothing. This exists because a card drawn with no font available comes out with an empty table and a row of empty boxes, which looks like missing QSO data rather than a missing typeface. |
| Table text colour | `qsl.card.textColor` | text | `#000000` | Colour of the table text, as a CSS colour such as #000000. Choose it against your artwork rather than against the cell fill, since a photographic card shows through a translucent cell. |
| Table heading background | `qsl.card.headingBg` | text | `#ffffff` | Fill behind the column headings. Accepts a CSS colour including one with alpha — rgba(255,255,255,0.85) is usually what you want over a photograph. |
| Table cell background | `qsl.card.cellBg` | text | `#ffffff` | Fill behind the QSO values, beneath the headings. Usually lighter or more transparent than the heading fill so the two rows read as one table. |
| Table border colour | `qsl.card.borderColor` | text | `#000000` | Colour of the lines between cells. Match it to the text for a printed-form look, or make it translucent to let the artwork through. |
| Card JPEG quality | `qsl.card.quality` | number | `88` | 40-100. 88 keeps a photographic card around 200 kB. |

## Environment fallbacks

These read an environment variable **only when the database has no value**, so an
older `.env`-based install keeps working after an upgrade. Setting the value in the
UI takes precedence from then on.

| Key | Environment variable |
|---|---|
| `app.baseUrl` | `APP_BASE_URL` |
| `app.sessionTtlDays` | `SESSION_TTL_DAYS` |
| `redis.url` | `REDIS_URL` |
| `qrz.username` | `QRZ_USERNAME` |
| `qrz.password` | `QRZ_PASSWORD` |
| `qrz.logbookApiKey` | `QRZ_LOGBOOK_API_KEY` |
| `lotw.username` | `LOTW_USERNAME` |
| `lotw.password` | `LOTW_PASSWORD` |
| `eqsl.username` | `EQSL_USERNAME` |
| `eqsl.password` | `EQSL_PASSWORD` |
| `clublog.email` | `CLUBLOG_EMAIL` |
| `clublog.password` | `CLUBLOG_PASSWORD` |
| `hrdlog.callsign` | `HRDLOG_CALLSIGN` |
| `hrdlog.code` | `HRDLOG_CODE` |
| `pskreporter.contact` | `PSKREPORTER_CONTACT` |
| `bridge.port` | `BRIDGE_PORT` |
| `bridge.token` | `BRIDGE_TOKEN` |
| `wsjtx.udpPort` | `WSJTX_UDP_PORT` |
| `wsjtx.udpHost` | `WSJTX_UDP_HOST` |
| `smtp.host` | `SMTP_HOST` |
| `smtp.port` | `SMTP_PORT` |
| `smtp.secure` | `SMTP_SECURE` |
| `smtp.user` | `SMTP_USER` |
| `smtp.password` | `SMTP_PASSWORD` |
| `smtp.from` | `SMTP_FROM` |

## Renamed keys

These settings have been renamed. The old key is still **read** when the new one
has no value, so an install that has not run the migration — or one restored from
an older database — keeps working. Nothing writes to an old key.

| Was | Is now |
|---|---|
| `flex.mode` | `digital.mode` |
| `flex.huntNewOnly` | `auto.huntNewOnly` |
| `flex.huntMinSnr` | `auto.huntMinSnr` |
| `flex.bandHop` | `auto.bandHop` |
| `flex.hopBands` | `auto.hopBands` |
| `omega.bridgePort` | `bridge.port` |
| `omega.bridgeToken` | `bridge.token` |
| `omega.bridgeWsUrl` | `bridge.wsUrl` |
| `omega.udpPort` | `wsjtx.udpPort` |
| `omega.udpHost` | `wsjtx.udpHost` |
| `omega.autoLog` | `wsjtx.autoLog` |

## Secrets

Stored encrypted with `SETTINGS_KEY`. The API never returns them — the Settings
page shows whether one is set, not what it is.

- `qrz.password` — QRZ password
- `qrz.logbookApiKey` — QRZ Logbook API key
- `lotw.password` — LoTW password
- `eqsl.password` — eQSL password
- `clublog.password` — ClubLog password
- `clublog.appPassword` — ClubLog application password
- `clublog.apiKey` — ClubLog API key
- `cloudlog.apiKey` — Cloudlog API key
- `hrdlog.code` — HRDLOG upload code
- `dxcc.ctyApiKey` — Club Log cty API key
- `icom.password` — Network password
- `bridge.token` — Bridge shared secret
- `smtp.password` — SMTP password
- `pota.userToken` — POTA session token (for importing your log)
