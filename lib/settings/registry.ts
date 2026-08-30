import { tokenHelp } from "@/lib/qsl/template";
// The list only — lib/qsl/fonts.ts imports node:fs and this module reaches the browser.
import { BUNDLED_FONTS, DEFAULT_CARD_FONT } from "@/lib/qsl/font-list";

/** Token list, shown in the QSL template hints. */
const TOKEN_HELP = tokenHelp();

// The definitive list of runtime settings.
//
// Everything here is managed from /settings and stored in the database — secrets
// encrypted. Each entry may name an `envFallback`, which is read only when the
// database has no value: that keeps an existing .env-based install working after
// upgrading, and gives a migration path rather than a hard cutover.
//
// NOT in this registry, because they cannot be:
//   DATABASE_URL  — settings live in the database
//   SETTINGS_KEY  — the key that decrypts the secrets here
//   PORT          — needed before the app can query anything
// Those three stay in .env permanently. Everything else belongs here.

/**
 * `text` renders as a textarea rather than a single-line input.
 *
 * Needed for the QSL templates: an email body is several paragraphs, and forcing
 * it through a one-line input makes it unusable — which is the practical
 * difference between "configurable" and "configurable in theory".
 */
export type SettingType =
  | "string"
  | "secret"
  | "number"
  | "boolean"
  | "text"
  | "limit"
  | "select";

/**
 * `limit` is a number with an on/off checkbox, stored as 0 when off.
 *
 * Every automatic operating limit was a bare number where the way to switch it off
 * was to type 0 — undiscoverable, and until now not even uniformly true: some guards
 * treated 0 as "trip immediately" rather than "no limit". See `limitOn` in
 * lib/digital/qso.ts.
 */

export interface SettingDef {
  key: string;
  label: string;
  type: SettingType;
  /**
   * The choices, for `select`.
   *
   * Added because a setting whose valid values are a fixed list was still a free-text box:
   * the card font shipped with three typefaces and no way to discover their names, so the
   * only route to a working value was reading the help text and typing it exactly.
   * "How is someone supposed to know what fonts loaded" — they were not.
   *
   * A `select` writes the same plain string as a `string` setting, so nothing downstream
   * changes and a value set before the picker existed still loads.
   */
  options?: { value: string; label: string }[];
  /**
   * Render across both columns of the settings grid.
   *
   * For controls that are genuinely wide — the schedule editor with its day strip — and
   * that look absurd squeezed into half a page next to an empty gap.
   */
  wide?: boolean;
  group: string;
  help?: string;
  placeholder?: string;
  /** Read when the database has no value. Migration path from .env. */
  envFallback?: string;
  /**
   * Keys this setting used to be stored under, newest first.
   *
   * Read when the current key has no row, BEFORE `envFallback` — a value an operator
   * saved in the UI must outrank one left behind in a `.env` file. The rename migration
   * moves the rows, so this is the belt to that braces: an install that restores an old
   * database, or one whose migration has not run yet, keeps working rather than losing
   * its bridge token and going quietly dark.
   *
   * Nothing writes to a legacy key. They are read-only history.
   */
  legacyKeys?: string[];
  default?: string;
  /**
   * A value the operator has to acknowledge in so many words before it is written.
   *
   * For the small number of settings whose off position removes a protection rather than
   * changing a preference. The check is enforced in the PATCH route, NOT only in the page,
   * because a guard that a direct API call can step around is a guard for honest people.
   *
   * USE THIS SPARINGLY. A confirmation on something that is not actually dangerous is
   * worse than none: it teaches the reader that these dialogues are noise, and the next
   * one — the real one — gets the same reflexive click. If the message would have to
   * overstate the consequence to justify the dialogue, there should be no dialogue.
   *
   * `when` receives the incoming value exactly as the request carried it. `null` and `""`
   * both mean "clear it", which restores the default, so those are normally SAFE and the
   * predicate should say so rather than firing on everything falsy.
   */
  confirm?: {
    when: (value: string | null) => boolean;
    /** What the operator is agreeing to. Written as a consequence, not a warning. */
    message: string;
  };
}

export interface SettingGroup {
  id: string;
  title: string;
  blurb?: string;
  /**
   * Document in `docs/` that explains this group, without the `.md`.
   *
   * Rendered as a help icon beside the heading. Set only where a document genuinely
   * covers the group: a link to a page that turns out not to discuss the setting is
   * worse than no link, because the reader pays a click to discover that.
   */
  doc?: string;
  /** What the reader will find there. Shown as the icon's tooltip. */
  docLabel?: string;
}

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: "general",
    doc: "getting-started",
    docLabel: "First run and the settings every station needs",
    title: "General",
    blurb: "Instance-wide behaviour.",
  },
  {
    id: "qrz",
    doc: "logbook-sync",
    docLabel: "QRZ lookup and logbook upload — two different credentials",
    title: "QRZ.com",
    blurb:
      "XML API for callsign and email lookup (needs a paid XML subscription), plus the Logbook API key for uploads. The Logbook key is per-logbook and separate from your XML login.",
  },
  {
    id: "lotw",
    doc: "lotw-upload",
    docLabel: "Certificates, signing and downloading confirmations",
    title: "Logbook of the World",
    blurb:
      "Uploads are signed by a local TQSL install; the username and password are used to download inbound confirmations.",
  },
  {
    id: "eqsl",
    doc: "logbook-sync",
    docLabel: "eQSL, where the upload is the card",
    title: "eQSL.cc",
    blurb:
      "Electronic QSL cards. Unlike the other services the upload IS the card, so there is no log-only mode — sending is an approach to the other operator, which is why the reciprocal-only option under Uploads exists.",
  },
  {
    id: "clublog",
    doc: "logbook-sync",
    docLabel: "Club Log, and why uploads from here are refused",
    title: "ClubLog",
    blurb:
      "DXCC statistics, an online log and the OQRS card service. Authenticates by REGISTERED EMAIL rather than callsign. Uploads from this installation are refused at Club Log's edge; downloads work, and the code says so where it happens.",
  },
  {
    id: "cloudlog",
    doc: "logbook-sync",
    docLabel: "Cloudlog and Wavelog on your own server",
    title: "Cloudlog / Wavelog",
    blurb:
      "Self-hosted logging software. Unlike the public services this needs no developer registration and imposes no rate limit — it is your own server. Wavelog is a fork of Cloudlog and speaks the same API, so either works here.",
  },
  {
    id: "hrdlog",
    doc: "logbook-sync",
    docLabel: "HRDLOG.net",
    title: "HRDLOG.net",
    blurb:
      "Ham Radio Deluxe's online logbook. Needs the callsign the account logs under plus its upload code, which is not the website password.",
  },
  {
    id: "n3fjp",
    doc: "logbook-sync",
    docLabel: "Setting up the TCP API, and why 127.0.0.1 is usually wrong",
    title: "N3FJP Amateur Contact Log",
    blurb:
      "A logging program on your own desk rather than a web service, reached over its TCP " +
      "API. Enable the listener in ACLog first, under Settings -> Application Program " +
      "Interface (API) -> \"TCP API Enabled (Server)\". There is no password of any kind on " +
      "that API, so point DigiShack at a machine on your own network and never expose the " +
      "port to the internet. Switch the actual sending on under Uploads.",
  },
  {
    id: "dxcc",
    doc: "getting-started",
    docLabel: "Where the callsign-to-entity data comes from",
    title: "DXCC reference data",
    blurb:
      "Callsign-to-entity mapping. The DXCC page downloads it in one click from " +
      "country-files.com (AD1C's Big CTY) and needs NOTHING configured here — no account, " +
      "no key. The setting below is only for operators who happen to hold a Club Log cty " +
      "API key and would rather use their cty.xml. Manage the data itself on the DXCC page.",
  },
  {
    id: "pskreporter",
    doc: "operating",
    docLabel: "Reporting what you hear to PSKReporter",
    title: "PSKReporter",
    blurb:
      "PSKReporter asks developers to identify their traffic and to poll no more than once per callsign every 5 minutes. Anonymous polling risks being blocked.",
  },
  {
    id: "digital",
    doc: "digital-modes",
    docLabel: "FT8, FT4 and FT2 — windows, decoding and what each setting costs",
    title: "Digital modes",
    blurb:
      "Where decodes and rig status come from. `wsjtx` takes them from an external decoder — WSJT-X or a fork of it — over its UDP protocol; `flex` and `icom` talk to the radio directly with no external decoder at all. All three are implemented — pick one.",
  },
  {
    id: "bridge",
    doc: "architecture",
    docLabel: "The radio service: what it owns and why it is a separate process",
    title: "DigiShack bridge",
    blurb:
      "DigiShack's own radio service (`npm run bridge`): the process that owns the radio, decodes, transmits and serves the live feed. It runs separately from the web application because it binds a UDP socket, and a bound socket cannot be shared across cluster workers. These settings are about the service itself, whichever radio it is driving.",
  },
  {
    id: "wsjtx",
    doc: "digital-modes",
    docLabel: "Reading an external decoder over UDP",
    title: "External decoder (WSJT-X)",
    blurb:
      "Used when the digital source is `wsjtx`. Point the decoder's UDP server at this host. Any program speaking the WSJT-X UDP protocol works — WSJT-X itself, JTDX, wsjtx-omega.",
  },
  {
    id: "flex",
    doc: "panadapter",
    docLabel: "The FlexRadio path, the panadapter and what is measured versus assumed",
    title: "FlexRadio (direct)",
    blurb:
      "Used when the digital source is `flex`. DigiShack connects to the radio's SmartSDR API itself. Read-only: it never changes slices, modes or transmits — an operator's SmartSDR session is not disturbed.",
  },
  {
    id: "schedule",
    doc: "operating",
    docLabel: "Operating windows and how the schedule decides",
    title: "Operating schedule",
    blurb:
      "What the station should be doing, and when. All times are the SERVER's LOCAL time, not UTC — sleeping hours are a fact about your house, not about the log. Three separate things: which automatic mode runs during which hours, a quiet period when nothing transmits at all, and a duty-cycle limit that rests the finals.",
  },
  {
    id: "watchdog",
    doc: "troubleshooting",
    docLabel: "What restarts the bridge, and what to look at when it does",
    title: "Bridge watchdog",
    blurb:
      "Restarts the radio bridge when it stops working while still appearing to run. PM2 only checks that the process exists, and on 2 August 2026 the process existed for five hours after it had produced its last decode. This watches the decode windows instead, which arrive once per T/R period whether or not anything is heard.",
  },
  {
    id: "icom",
    doc: "icom",
    docLabel: "The IC-7300 path: CI-V, audio and what this radio cannot do",
    title: "Icom (network)",
    blurb:
      "Used when the digital source is `icom`. Speaks the RS-BA1 network protocol directly — the same one the Icom remote software uses — so no third-party bridge, no virtual audio cable and no virtual COM port. The username and password are the ones set in the radio's own network menu, not your callsign or your DigiShack login.",
  },
  {
    id: "alerts",
    doc: "troubleshooting",
    docLabel: "What the station emails about, and what each alert means",
    title: "Issue alerts",
    blurb:
      "Email when the station goes wrong — the radio unreachable, the bridge restarted by its watchdog, uploads failing repeatedly. One email per condition with a cooldown, and a recovery note when it comes back. Uses the same SMTP settings as QSL email.",
  },
  {
    id: "update",
    doc: "development",
    docLabel: "Self-update from the public repository",
    title: "Software updates",
    blurb:
      "Lets an admin pull and deploy a new version from the Updates page. This runs code from the remote branch on this server, so it is off until you turn it on. Only ever fast-forwards, and refuses to run with uncommitted local changes.",
  },
  {
    id: "smtp",
    doc: "qsl",
    docLabel: "Outgoing email, used for QSL cards and station alerts",
    title: "Outgoing email",
    blurb:
      "Used by the QSL emailer. Those are unsolicited emails to other operators, so bulk sends always go through a review queue.",
  },
  {
    id: "auto",
    doc: "operating",
    docLabel: "Automatic operating and every brake on it",
    title: "Automatic operating limits",
    blurb:
      "Brakes on the autonomous modes. The wall-clock and QSO limits are the only ones that bound a session in absolute terms — every other guard counts events and is reset by making progress. SWR and PA temperature protect the radio, and a band change deliberately does not clear them.",
  },
  {
    id: "uploads",
    doc: "logbook-sync",
    docLabel: "How the upload sweep works, and the cutoff that protects a back catalogue",
    title: "Automatic uploading",
    blurb:
      "Pushing contacts to the log-hosting services as they are made. Off by default, and it uploads only contacts logged AFTER you switch it on — a log that predates this feature is almost certainly already on those services from whatever you used before, and re-sending 26,000 contacts to discover that is rude to them and slow for you. Use the compare on the Integrations page to mark what is already there.",
  },
  {
    id: "pota",
    doc: "pota",
    docLabel: "Parks on the Air: spots, chasing and references",
    title: "POTA chasing",
    blurb:
      "How the POTA chase mode picks activators. The band rule is the important one: a chaser that follows every spot spends most of its time tuned to frequencies where nothing is audible, and every excursion costs the give-up time before it can try again.",
  },
  {
    id: "qsl",
    doc: "qsl",
    docLabel: "QSL cards, email and the artwork",
    title: "QSL card and email",
    blurb:
      "Everything the recipient sees is a template here, not a string in the code. A QSL card makes claims about how you operate — which services you upload to, whether you will answer a paper card — and those are yours to word. Use the Preview button on the QSL page to see a real card before sending anything.",
  },
];

export const SETTINGS: SettingDef[] = [
  // --- general ---
  {
    key: "app.baseUrl",
    label: "Public base URL",
    type: "string",
    group: "general",
    help: "Used for absolute links in outgoing email.",
    placeholder: "https://digishack.example.com",
    envFallback: "APP_BASE_URL",
  },
  {
    key: "app.sessionTtlDays",
    label: "Session lifetime (days)",
    type: "number",
    group: "general",
    help: "How long a login stays valid. Lowering it does not revoke existing sessions — do that from the Users page.",
    envFallback: "SESSION_TTL_DAYS",
    default: "30",
  },
  {
    key: "redis.url",
    label: "Redis URL",
    type: "string",
    group: "general",
    help: "Background job queue. Required from Phase 2 onward.",
    placeholder: "redis://127.0.0.1:6379",
    envFallback: "REDIS_URL",
  },

  // --- QRZ ---
  {
    key: "qrz.username",
    label: "QRZ username",
    type: "string",
    group: "qrz",
    help:
      "Your QRZ.com login, used to LOOK UP callsigns — names, grids and addresses for QSL cards. Nothing to do with uploading contacts, which uses the logbook API key below and works without this.",
    envFallback: "QRZ_USERNAME",
  },
  {
    key: "qrz.password",
    label: "QRZ password",
    type: "secret",
    group: "qrz",
    help:
      "Password for the lookup account above. A QRZ XML subscription is needed for full lookup data; without one QRZ returns a reduced record and DigiShack uses what it gets.",
    envFallback: "QRZ_PASSWORD",
  },
  {
    key: "qrz.logbookApiKey",
    label: "QRZ Logbook API key",
    type: "secret",
    group: "qrz",
    help:
      "Uploads contacts to your QRZ logbook. A DIFFERENT credential from the username and password above — find it on QRZ under Logbook → Settings, one key per logbook. Uploading is switched on separately under Uploads.",
    envFallback: "QRZ_LOGBOOK_API_KEY",
  },

  // --- LoTW ---
  {
    key: "lotw.username",
    label: "LoTW username",
    type: "string",
    group: "lotw",
    help:
      "Your LoTW login, used to DOWNLOAD confirmations. Uploads are signed by your certificate rather than by this, so downloads work with these credentials alone.",
    envFallback: "LOTW_USERNAME",
  },
  {
    key: "lotw.password",
    label: "LoTW password",
    type: "secret",
    group: "lotw",
    help:
      "Password for the LoTW account above. This is the website password, not the passphrase protecting your certificate file — a common mix-up.",
    envFallback: "LOTW_PASSWORD",
  },
  {
    key: "lotw.autoSync",
    label: "Download confirmations automatically",
    type: "boolean",
    group: "lotw",
    help:
      "Fetch new LoTW confirmations on a timer instead of only when the Sync button is " +
      "pressed. Download only — uploading needs your TQSL certificate — so this is " +
      "read-only against ARRL. Does nothing until a username and password are set.",
    default: "true",
  },
  {
    key: "lotw.syncMinutes",
    label: "How often to check LoTW (minutes)",
    type: "number",
    group: "lotw",
    help:
      "An incremental check is one small request. Hourly is what Cloudlog recommends " +
      "for the same service, and LoTW rate-limits heavy use. Minimum 15.",
    default: "60",
  },
  // `lotw.tqslPath` used to be here, pointing at a TQSL binary. It was removed in 1.92.0
  // and it is worth saying why rather than leaving a gap: TQSL is a desktop GUI application
  // that is not installed on a headless server and should not be, so the setting named a
  // file that never existed and the upload path could not run at all. That is why nothing
  // had been uploaded to LoTW since August 1st while the page reported the sync as on.
  // Signing needs the certificate, not the program — see docs/lotw-upload.md.
  {
    key: "lotw.reconcile",
    label: "Check that LoTW kept what we uploaded",
    type: "boolean",
    group: "lotw",
    help:
      "An accepted LoTW upload only means the file was QUEUED — the records are validated " +
      "afterwards and the outcome arrives by email. So a batch marked sent here may not be " +
      "in your LoTW log, and nothing would ever retry it. This asks LoTW what it actually " +
      "holds and clears the flag on anything missing, so it goes up again. It only ever " +
      "clears a flag: the cost of a wrong answer is one redundant upload, which LoTW " +
      "discards as a duplicate.",
    default: "true",
  },
  {
    key: "lotw.reconcileHours",
    label: "How often to check (hours)",
    type: "number",
    group: "lotw",
    help:
      "Daily is right. LoTW processes an upload within minutes to hours, so checking sooner " +
      "reports contacts as missing that are merely still in the queue — which would clear " +
      "the flag and upload them again for no reason. Minimum 6.",
    default: "24",
  },
  {
    key: "lotw.station.state",
    label: "State or province (for LoTW)",
    type: "string",
    group: "lotw",
    help:
      "Two letters, e.g. WI. LoTW grants Worked All States and county credit from the " +
      "station location on the upload, not from anything in the contact — so leaving this " +
      "empty uploads successfully and earns no WAS credit, permanently, unless every " +
      "contact is uploaded again later. It is separate from the station's grid because " +
      "LoTW matches its own list of states rather than deriving one.",
    placeholder: "WI",
  },
  {
    key: "lotw.station.county",
    label: "County (for LoTW)",
    type: "string",
    group: "lotw",
    help:
      "The county name without the word \"County\", e.g. Kenosha. Only meaningful for US " +
      "stations, and only used for county awards.",
    placeholder: "Kenosha",
  },
  {
    key: "lotw.station.canadian",
    label: "The state field is a Canadian province",
    type: "boolean",
    group: "lotw",
    help:
      "LoTW carries provinces in a different field from states, and it is not inferred " +
      "from the value — several two-letter codes are both. Leave off for the US.",
    default: "false",
  },
  {
    key: "lotw.station.cqZone",
    label: "CQ zone (for LoTW)",
    type: "number",
    group: "lotw",
    help: "Optional. Sent on the station record and covered by the signature.",
    placeholder: "4",
  },
  {
    key: "lotw.station.ituZone",
    label: "ITU zone (for LoTW)",
    type: "number",
    group: "lotw",
    help: "Optional. Sent on the station record and covered by the signature.",
    placeholder: "7",
  },
  {
    key: "lotw.station.iota",
    label: "IOTA reference (for LoTW)",
    type: "string",
    group: "lotw",
    help: "Optional, e.g. NA-001. Only for island operations.",
    placeholder: "NA-001",
  },

  // --- eQSL ---
  {
    key: "eqsl.username",
    label: "eQSL username",
    type: "string",
    group: "eqsl",
    help:
      "Your eQSL.cc login, used both to send cards and to fetch your inbox. On eQSL the upload IS the card, so there is no log-only mode to fall back on.",
    envFallback: "EQSL_USERNAME",
  },
  {
    key: "eqsl.qthNickname",
    label: "eQSL QTH nickname",
    type: "string",
    group: "eqsl",
    help:
      "Required only when your eQSL login owns more than one QTH. With several, eQSL refuses " +
      "every request with 'Username/Password found more than 1 account' until told which to " +
      "use. Find the nicknames under My Profile on eqsl.cc. " +
      "MEASURED: this satisfies the request but does NOT filter the inbox — the downloaded " +
      "records carry no station or QTH field, so confirmations belonging to your other " +
      "profiles arrive too and match nothing in this log. That is expected on a multi-QTH " +
      "account, not a fault. " +
      "IT IS ALSO USED ON UPLOADS, so if you move, change it: cards sent under an old QTH " +
      "carry the wrong location to the recipient. A nickname that does not exist is reported " +
      "by eQSL as \"No such Username/Password found\", which points at the password and not " +
      "at the real cause — this application says so explicitly instead.",
  },
  {
    key: "eqsl.autoSync",
    label: "Download eQSL confirmations automatically",
    type: "boolean",
    group: "eqsl",
    help:
      "Pulls your eQSL inbox and matches it to the log, which is what earns award credit. " +
      "This is READ ONLY — it uploads nothing and posts no cards to anyone, so it is safe " +
      "to leave on whether or not you ever upload. `syncEqslInbox` had been written and was " +
      "never called by anything, which is why confirmations only ever arrived through an " +
      "ADIF import.",
    default: "true",
  },
  {
    key: "eqsl.syncMinutes",
    label: "How often to check eQSL (minutes)",
    type: "number",
    group: "eqsl",
    help: "Hourly is plenty — confirmations are not urgent. Minimum 15.",
    default: "60",
  },
  {
    key: "eqsl.password",
    label: "eQSL password",
    type: "secret",
    group: "eqsl",
    help:
      "Password for the eQSL account above. eQSL rejects an upload with a clear message when this is wrong, which the Integrations page reports verbatim.",
    envFallback: "EQSL_PASSWORD",
  },

  // --- ClubLog ---
  {
    key: "clublog.email",
    label: "ClubLog email",
    type: "string",
    group: "clublog",
    help:
      "Club Log authenticates by the email address you REGISTERED WITH, not by callsign. An easy one to get wrong, and it produces an unhelpful refusal when you do.",
    envFallback: "CLUBLOG_EMAIL",
  },
  {
    key: "clublog.password",
    label: "ClubLog password",
    type: "secret",
    group: "clublog",
    help:
      "Your Club Log account password. The API endpoints prefer an application password (below); downloads work with either.",
    envFallback: "CLUBLOG_PASSWORD",
  },
  {
    key: "clublog.callsign",
    label: "Club Log station callsign",
    type: "string",
    group: "clublog",
    help: "Which callsign's log to upload to. Leave blank to use the station on the QSO.",
  },
  {
    key: "clublog.appPassword",
    label: "ClubLog application password",
    type: "secret",
    group: "clublog",
    help: "Club Log's separate API credential, created under Settings -> Application Passwords on clublog.org. Uploads may require this rather than the account password; downloads work with either.",
  },
  {
    key: "clublog.apiKey",
    label: "ClubLog API key",
    type: "secret",
    group: "clublog",
    help: "Optional in Club Log's own documentation, and requested from their helpdesk rather than generated on the site. Sent as the `api` field when set, and omitted entirely when blank — an empty key is not the same as no key, and a service that reads one as an invalid credential would refuse a request that works without it. Worth setting if uploads are refused at the edge: measured from this station, getadif.php answers 200 while putlogs.php and realtime.php return a bare nginx 403 that never reaches the application, which no credential can affect but an allow-listed key might.",
  },

  // --- HRDLOG ---
  {
    key: "cloudlog.url",
    label: "Cloudlog / Wavelog URL",
    type: "string",
    group: "cloudlog",
    help: "The base address of your installation, e.g. https://logging.example.com. A trailing slash, an index.php, or the full /api/qso path are all accepted — whatever you paste is normalised.",
    placeholder: "https://logging.example.com",
  },
  {
    key: "cloudlog.apiKey",
    label: "Cloudlog API key",
    type: "secret",
    group: "cloudlog",
    help: "Generated in Cloudlog under Account > API Keys. It must have write permission; a read-only key accepts the request and logs nothing.",
  },
  {
    key: "cloudlog.stationProfileId",
    label: "Station profile id",
    type: "string",
    group: "cloudlog",
    help: "Which station profile contacts are filed under. Cloudlog shows the id in the URL when you edit a profile — it is a number, not the profile name.",
    placeholder: "1",
  },
  {
    key: "uploads.cloudlog",
    label: "Upload to Cloudlog / Wavelog",
    type: "boolean",
    group: "uploads",
    help: "Push each contact to your own Cloudlog or Wavelog installation. Needs the URL, API key and station profile id under Cloudlog / Wavelog.",
    default: "false",
  },
  {
    key: "uploads.n3fjp",
    label: "Log to N3FJP Amateur Contact Log",
    type: "boolean",
    group: "uploads",
    help:
      "Push each contact to N3FJP Amateur Contact Log over its TCP API. Unlike the other " +
      "targets this is a program on your own desk rather than a web service: enable its " +
      "listener first, under Settings -> Application Program Interface (API) -> \"TCP API " +
      "Enabled (Server)\". Contacts made while the program is closed are not lost — they " +
      "stay flagged unsent and go out on the next sweep after it comes back.",
    default: "false",
  },
  {
    key: "n3fjp.host",
    label: "N3FJP address",
    type: "string",
    group: "n3fjp",
    help:
      "Where Amateur Contact Log is running. 127.0.0.1 is right only when DigiShack is on " +
      "the SAME machine — a container or a separate server needs the desktop PC's own LAN " +
      "address, and this is the setting that catches people out. The API has no password " +
      "of any kind, so point it only at a machine on your own network and never expose " +
      "port 1100 to the internet.",
    placeholder: "127.0.0.1",
    default: "127.0.0.1",
  },
  {
    key: "n3fjp.port",
    label: "N3FJP API port",
    type: "number",
    group: "n3fjp",
    help: "The port shown in that API window. 1100 is the default and rarely changed.",
    default: "1100",
  },
  {
    key: "hrdlog.callsign",
    label: "HRDLOG callsign",
    type: "string",
    group: "hrdlog",
    help:
      "The callsign your HRDLOG.net account logs under. Paired with the upload code below — both are needed.",
    envFallback: "HRDLOG_CALLSIGN",
  },
  {
    key: "hrdlog.code",
    label: "HRDLOG upload code",
    type: "secret",
    group: "hrdlog",
    help:
      "HRDLOG.net's upload code, issued in your account settings there. Not your website password.",
    envFallback: "HRDLOG_CODE",
  },

  // --- DXCC ---
  {
    key: "dxcc.ctyApiKey",
    label: "Club Log cty API key",
    type: "secret",
    group: "dxcc",
    help:
      "OPTIONAL, and most operators should leave it blank. DXCC data downloads from " +
      "country-files.com with no credential at all, which is the button the DXCC page " +
      "leads with. Club Log does not issue these keys to everyone, and requiring one is " +
      "why installations sat with 9 DXCC entities against 160 actually worked. Fill this " +
      "in only if you already have a key and prefer Club Log's cty.xml, which carries " +
      "dated exception records the CSV does not. Nothing to do with uploading contacts.",
  },
  {
    key: "dxcc.autoFill",
    label: "Auto-fill DXCC on entry",
    type: "boolean",
    group: "dxcc",
    help: "Resolve the entity as a callsign is typed on the QSO form.",
    default: "true",
  },

  // --- PSKReporter ---
  {
    key: "pskreporter.contact",
    label: "Contact identifier",
    type: "string",
    group: "pskreporter",
    help: "An email address or callsign, sent with every query and with band-activity requests as appcontact. PSKReporter asks automated users to identify themselves so they can get in touch before blocking anyone — honouring that is the difference between an email and a ban. Falls back to the SMTP From address. Do not leave this blank.",
    placeholder: "k9xyz@example.com",
    envFallback: "PSKREPORTER_CONTACT",
  },
  {
    key: "pskreporter.upload",
    label: "Report my decodes",
    type: "boolean",
    group: "pskreporter",
    help: "Send the stations we decode to PSKReporter, so DigiShack appears as a receiver on the coverage maps. Separate from the lookup setting below: this uploads, that downloads. One small datagram every five minutes.",
    default: "false",
  },
  {
    key: "pskreporter.antenna",
    label: "Antenna description",
    type: "string",
    group: "pskreporter",
    help: "Shown alongside your spots on pskreporter.info. Optional.",
    placeholder: "80m OCF dipole at 12m",
  },
  {
    key: "pskreporter.enabled",
    label: "Collect reception reports",
    type: "boolean",
    group: "pskreporter",
    help: "Ask PSKReporter which receivers heard our transmissions, and attach their reports to the contacts they belong to — the 'Heard by' panel on a contact. Downloads; the setting above uploads. Queried every five minutes, which is the most often PSKReporter permits. Most reports are of CQs that led to no contact and cannot be attached to one, so they are counted and discarded.",
    default: "false",
  },

  // --- Digital source selection ---
  {
    key: "digital.source",
    label: "Decode source",
    type: "string",
    group: "digital",
    help: 'One of "wsjtx" (an external decoder over the WSJT-X UDP protocol), "flex" (direct to a FlexRadio) or "icom" (direct to a networked Icom over RS-BA1). The bridge reads this at startup. "omega" is still accepted and means "wsjtx" — that was a reference to one particular fork of WSJT-X, never to anything DigiShack does.',
    default: "wsjtx",
  },

  {
    key: "time.ntpServer",
    label: "Time server",
    type: "string",
    group: "digital",
    help: "Where to ask what time it is, over SNTP. FT8 tolerates about a second of clock error before decoding degrades and other stations stop decoding you — and DigiShack cannot set the system clock (that needs elevation, and in a container it is the host's clock anyway), so instead it measures the difference and compensates internally. Blank disables the check entirely, which leaves you relying on the decode-median estimate that needs eight decodes before it can say anything.",
    default: "pool.ntp.org",
  },
  {
    key: "time.correct",
    label: "Compensate for a wrong clock",
    type: "boolean",
    group: "digital",
    help: "Apply the measured offset to transmit timing, decode windows and logged contact times. Off measures and displays it without changing anything. Corrections above 5 seconds are always refused: that is not a clock needing a nudge, it is a machine whose time is wrong, and quietly compensating would hide it and produce a log nobody can reconcile.",
    default: "true",
  },
  {
    key: "time.syncMinutes",
    label: "Re-check the clock every (minutes)",
    type: "number",
    group: "digital",
    help: "How often to re-measure. Hourly is plenty for a machine that is roughly synchronised, and one exchange is 48 bytes. 0 measures once at startup and never again.",
    default: "60",
  },
  {
    key: "digital.decodeCsvDir",
    label: "Also write every decode to CSV in",
    type: "string",
    group: "digital",
    help: "A directory on the server. One file per UTC day, `decodes-YYYY-MM-DD.csv`, holding every decode heard — including ones with no resolvable band, which never reach the database. Leave blank to write none. This is separate from the database copy, which is pruned after `digital.decodeRetentionDays`: the table is what the application queries, this is the raw feed kept for its own sake in a format that outlives the schema. A busy band produces around 42,000 rows a day, which is a few megabytes.",
    placeholder: "/var/lib/digishack/decodes",
  },
  {
    key: "digital.passbandHz",
    label: "Passband to decode and display (Hz)",
    type: "number",
    group: "digital",
    help: "Top of the audio passband: what the decoders search AND what the waterfall draws — one number, so the display cannot disagree with the decoder. 3000 is the conventional FT8 sub-band and the decoder library's own default. Raising it finds stations above 3 kHz that were being clipped: a busy band shows a hard stop at exactly 3000, which is a clipped distribution rather than a natural one. It costs decode time, so watch for the \"decode took Nms\" warning, and note that most radios will not TRANSMIT above about 2.9 kHz whatever the receiver hears — stations found up there can be decoded but not answered.",
    default: "3000",
  },

  // --- FlexRadio direct ---
  {
    key: "flex.host",
    label: "Radio address",
    type: "string",
    group: "flex",
    help: "Leave blank to discover the radio automatically on the LAN.",
    placeholder: "192.0.2.10",
  },
  {
    key: "flex.autoDiscover",
    label: "Discover automatically",
    type: "boolean",
    group: "flex",
    help: "Listen for the radio's UDP broadcast instead of using a fixed address.",
    default: "true",
  },
  {
    key: "digital.mode",
    legacyKeys: ["flex.mode"],
    label: "Digital mode",
    type: "string",
    group: "digital",
    help: "auto | ft8 | ft4 | ft2. Auto infers the mode from the dial frequency, which is the only reliable way — a DIGU slice does not say which mode it carries, and the three use different window lengths (15 / 7.5 / 3.75 s). FT2 has provisional calling frequencies so auto does find it, except on 60 m where it shares 5.357 MHz with FT4 and auto resolves to FT4; pin ft2 here to run it there or anywhere off-frequency.",
    default: "auto",
  },
  {
    key: "flex.decodeDepth",
    label: "Decoder depth",
    type: "number",
    group: "flex",
    help:
      "1-4. Leave it at 2. MEASURED on a Xeon E5-2630 v3 with a 3 kHz passband: depth 1 " +
      "takes 1312-2021 ms and depth 2 takes 1435-1795 ms — the SAME, sometimes worse, so " +
      "lowering it buys nothing and only decodes less. Depth 3 is 3910-6692 ms, three to " +
      "four times the cost, and 4 is far beyond the 15 s cycle. Cost barely changes with " +
      "how busy the band is: one signal and twenty measure about the same, because it is " +
      "a search over the passband rather than work per station. An earlier version of " +
      "this text claimed ~0.55 s for depth 2; that was never true on this hardware.",
    default: "2",
  },
  {
    key: "flex.daxChannel",
    label: "DAX IQ / audio channel",
    type: "number",
    group: "flex",
    help: "Which DAX channel carries the audio to decode. Used by the native decode path.",
    default: "1",
  },
  {
    key: "flex.panadapter",
    label: "RF panadapter",
    type: "boolean",
    group: "flex",
    help: "Show tens of kHz of RF spectrum from the radio's own panadapter, alongside the audio waterfall rather than instead of it. The audio waterfall stays because the FT8 decoder searches a 3 kHz passband and the display has to show the same 3 kHz. Costs about 60 kB/s from the radio at the defaults below, comparable to the audio stream. FlexRadio only so far — see docs/panadapter.md for why the Icom's scope is not enabled yet.",
    default: "true",
  },
  {
    key: "flex.panadapterSpanKHz",
    label: "Panadapter span",
    type: "number",
    group: "flex",
    help: "How much band to show, in kHz. The radio accepts 4.92 kHz to 7372.8 kHz (measured, not documented). Normally set from the Span buttons on the panadapter itself, which write back here — this is just where the choice is remembered across restarts. 200 kHz holds a digital sub-band plus the CW and SSB activity either side of it; 20 kHz is enough for one FT8 watering hole in context.",
    default: "200",
  },
  {
    key: "flex.panadapterBins",
    label: "Panadapter resolution",
    type: "number",
    group: "flex",
    help: "Bins across the span. The radio's real ceiling is 4096 — measured: asking for 8192 silently returns 4096. More bins than screen pixels is not wasted, because the display takes the strongest bin per pixel, which is what keeps a narrow carrier visible instead of averaging it into the noise.",
    default: "2048",
  },
  {
    key: "flex.panadapterFps",
    label: "Panadapter frame rate",
    type: "number",
    group: "flex",
    help: "Frames a second. The radio delivered 95 against a request of 100, so this is not the limit — bandwidth is: every frame is sent to every open page. Vertical resolution on a waterfall IS time, so this is a trade rather than a quality setting: at 10 rows a second a 220-pixel canvas holds 22 seconds of history.",
    default: "10",
  },
  {
    key: "alerts.radioDownReminderHours",
    label: "Radio-down reminder interval",
    type: "number",
    group: "alerts",
    help: "How often to email again while the radio stays unreachable, in hours. A radio that is off needs somebody to go and switch it on, and the only thing that produces that is a message which keeps arriving — this used to alert once, four minutes in, and then go quiet. After a mains outage on 11 August 2026 the bridge retried 8,223 times over 94 hours having sent exactly one email on the first evening. These reminders ignore the general alert cooldown below, because repeating is the entire point. Set it to a large number to effectively disable the repeat; the first alert is always sent.",
    default: "12",
  },
  {
    key: "flex.panadapterAverage",
    label: "Panadapter averaging",
    type: "number",
    group: "flex",
    help: "How much the radio averages successive spectrum frames before sending them, 0-100. This is averaging in TIME, not across frequency: a steady carrier is present in every frame and averages to itself, while noise is different every frame and averages down — so unlike the resolution setting above, this does not smear a narrow signal into its neighbours. It was hardcoded off, and off is expensive: a single unaveraged FFT bin's noise spreads 12.65 dB from its 25th to its 99.5th percentile, and the display has to give all of that to the dark end of the colour ramp, leaving less of the palette for actual signals. Averaging four frames roughly halves that spread. 0 disables it; the display is correct either way, just grainier.",
    default: "20",
  },
  {
    key: "flex.allowTransmit",
    label: "Allow transmit",
    type: "boolean",
    group: "flex",
    help: "Master gate for DigiShack's native FT8/FT4 transmit. Off means nothing can key the radio, ever — the QSO controls will refuse. Turn on only when the radio is connected to a proper antenna or load and the power level is where you want it.",
    default: "false",
  },
  {
    key: "auto.huntNewOnly",
    legacyKeys: ["flex.huntNewOnly"],
    label: "Hunt only new ones",
    type: "boolean",
    group: "auto",
    help: "Auto Hunt calls only stations that offer something new (DXCC entity, band slot, state, CQ zone, grid). Off by default — on a quiet band you usually want the contact.",
    default: "false",
  },
  {
    key: "auto.huntMinSnr",
    legacyKeys: ["flex.huntMinSnr"],
    label: "Hunt minimum SNR (dB)",
    type: "number",
    group: "auto",
    help: "Do not call stations weaker than this; the QSO is unlikely to complete and the cycles are better spent elsewhere.",
    default: "-22",
  },
  {
    key: "auto.bandHop",
    legacyKeys: ["flex.bandHop"],
    label: "Auto band-hop",
    type: "boolean",
    group: "auto",
    help: "When an auto mode stalls (dead band, no answers), retune to the next band on the hop list, listen two cycles, and either resume or hop again.",
    default: "false",
  },
  {
    key: "auto.hopBands",
    legacyKeys: ["flex.hopBands"],
    label: "Band-hop list",
    type: "string",
    group: "auto",
    help: "Comma-separated bands to rotate through when band-hopping.",
    default: "40M,20M,30M,80M",
  },
  {
    key: "auto.hopWhenBetterRatio",
    label: "Leave a working band when another is this much busier",
    type: "number",
    group: "auto",
    help:
      "Band-hopping otherwise only triggers when a band goes QUIET — a station happily " +
      "making contacts on 40m will stay there while 20m runs three times busier. This " +
      "moves it: at 2.5, another band on the hop list must be 2.5x busier before the " +
      "radio leaves one that is working. A ratio rather than a difference, so it means " +
      "the same at 30 stations as at 300. Set to 0 or 1 to switch it off. Only ever " +
      "considers bands on the hop list, and never interrupts a contact.",
    default: "2.5",
  },
  {
    key: "auto.hopToBusiest",
    label: "Hop to the busiest band",
    type: "boolean",
    group: "auto",
    help:
      "Instead of rotating through the hop list in order, jump to whichever band on it the " +
      "PSKReporter network currently sees the most stations on — the same SEEN figures the " +
      "band strip on the decodes page shows. Falls back to rotating in order when the network " +
      "is unreachable. Only bands on the hop list are ever considered.",
    default: "false",
  },
  {
    key: "flex.antenna",
    label: "Antenna port",
    type: "string",
    group: "flex",
    help:
      "Which antenna socket to use, on a radio that has more than one. Every FLEX-6000 has " +
      "ANT1 and ANT2, and the larger models add receive-only BNCs and a transverter port — " +
      "DigiShack used to write ANT1 into every slice it created and never read the antenna " +
      "back, so a station with the wire on ANT2 got a bridge listening to an empty socket. " +
      "The names are the RADIO'S own: it reports them (a FLEX-6400 answers ANT1, ANT2, RX_A, " +
      "XVTA) and /rig offers exactly that list. ANT2, ant2 and a bare 2 all mean the same " +
      "socket. Leave blank to use whatever the radio is already set to, which is right for a " +
      "single-antenna station and for one where the choice is made in SmartSDR. A port this " +
      "radio does not have is REFUSED and said so on /rig, not quietly turned back into ANT1. " +
      "Only ever applied to a slice DigiShack owns — an operator working a station in " +
      "SmartSDR does not get their antenna moved underneath them.",
    placeholder: "ANT1",
  },
  {
    key: "flex.rxAntenna",
    label: "Receive antenna port",
    type: "string",
    group: "flex",
    help:
      "A separate socket to LISTEN on: a receive loop, a beverage, or the 6600's RX_A BNC. " +
      "Blank means listen on the antenna above, which is the normal case. The radio keeps two " +
      "lists and so does DigiShack — a receive-only socket appears in one and not the other, " +
      "so it can be selected here and cannot be selected for transmit. The RF panadapter is " +
      "moved with it: a panadapter carries its own antenna, and one left on a different socket " +
      "from the receiver draws a confident spectrum of the wrong aerial with correct-looking " +
      "axis labels.",
    placeholder: "RX_A",
  },
  {
    key: "flex.atuOnBandChange",
    label: "Tune ATU on band change",
    type: "boolean",
    group: "flex",
    help: "Run the antenna tuner (atu start) automatically after retuning to a new band.",
    default: "false",
  },
  {
    key: "flex.defaultFreqHz",
    label: "Default frequency (Hz)",
    type: "number",
    group: "flex",
    help: "Where the radio comes up when DigiShack has to create its own slice (no SmartSDR/AetherSDR running). Default 7074000 = 40m FT8.",
    default: "7074000",
  },

  // --- Operating schedule ---
  {
    key: "schedule.enabled",
    wide: true,
    label: "Follow the operating schedule",
    type: "boolean",
    group: "schedule",
    help: "When on, the automatic mode is chosen by the schedule below instead of whatever you last set by hand. Turning it off leaves the radio exactly as it is — it does not stop an automatic mode that is already running.",
    default: "false",
  },
  {
    key: "schedule.hours",
    wide: true,
    label: "Working hours",
    type: "string",
    group: "schedule",
    help: "Blocks of the day and what to run in each. End times are exclusive, so 08:00-12:00 and 12:00-16:00 sit next to each other without overlapping. Any time not covered is off. Where blocks overlap the later one wins, so you can write a broad rule and carve an exception out of it.",
    placeholder: "08:00-12:00=hunt, 13:00-22:00=cq",
  },
  {
    key: "schedule.sleep",
    wide: true,
    label: "Sleeping hours",
    type: "string",
    group: "schedule",
    help: "Nothing transmits during these hours, whatever the working hours say. Wraps midnight. This overrides the schedule rather than merging with it — it is what stops the station calling CQ next to someone asleep, so it has to win.",
    placeholder: "23:00-07:00",
  },
  {
    key: "schedule.paAfterMinutes",
    label: "PA cooldown after (transmit minutes)",
    type: "number",
    group: "schedule",
    help: "Rest the transmitter once it has been keyed this many minutes. Counts ACTUAL transmit time, not elapsed time: FT8 alternates transmit and receive, so an hour of operating is roughly half an hour of transmitting, and an hour spent listening does not heat anything. 0 turns the cooldown off.",
    default: "0",
  },
  {
    key: "schedule.paRestMinutes",
    label: "PA cooldown rest (minutes)",
    type: "number",
    group: "schedule",
    help: "How long to stay off transmit once the limit above is reached. The transmit counter starts again from zero afterwards.",
    default: "10",
  },

  // --- Bridge watchdog ---
  {
    key: "bridge.watchdog.enabled",
    label: "Restart the bridge if it stops decoding",
    type: "boolean",
    group: "watchdog",
    help: "Exits the bridge when no decode window has arrived for a while, so PM2 restarts it. A hung event loop or a socket that stopped delivering cannot be repaired from inside the process that is hung — a fresh one is the only reliable cure. Off means a hang goes unnoticed until you look.",
    default: "true",
  },
  {
    key: "bridge.watchdog.periods",
    label: "Quiet periods before restarting",
    type: "number",
    group: "watchdog",
    help: "How many T/R periods of no decode window count as dead. 8 is two minutes on FT8, and never fires on a working radio — a single late window is not a fault, so this must not be set to 1 or 2. There is a 60-second floor for the faster modes.",
    default: "8",
  },

  // --- Icom network ---
  {
    key: "icom.host",
    label: "Radio address",
    type: "string",
    group: "icom",
    help: "The radio's IP address on your network. Set a DHCP reservation for it — the address is stored here, and a radio that moves stops answering with no other symptom.",
    placeholder: "192.0.2.20",
  },
  {
    key: "icom.username",
    label: "Network user name",
    type: "string",
    group: "icom",
    help: "From the radio's Network menu, under Network User1. Not your callsign, and not your DigiShack login.",
  },
  {
    key: "icom.password",
    label: "Network password",
    type: "secret",
    group: "icom",
    help: "The password for that network user. It is obfuscated on the wire by a published substitution table, not encrypted — treat it as readable by anyone who can watch the network, and do not reuse a password that matters.",
  },
  {
    key: "icom.civAddress",
    label: "CI-V address",
    type: "string",
    group: "icom",
    help: "Hex, e.g. 94 for an IC-7300 or A4 for an IC-705. Leave blank to use the default for whichever model the radio reports at login, which is right unless you have changed it in the radio's CI-V menu.",
    placeholder: "94",
  },
  {
    key: "icom.controlPort",
    label: "Control port",
    type: "number",
    group: "icom",
    help: "UDP port for the control stream. 50001 unless you have changed it in the radio. The serial and audio streams follow on 50002 and 50003.",
    default: "50001",
  },
  {
    key: "icom.serialPort",
    label: "Serial (CI-V) port",
    type: "number",
    group: "icom",
    help: "UDP port carrying CI-V — frequency, mode, PTT and the meters.",
    default: "50002",
  },
  {
    key: "icom.audioPort",
    label: "Audio port",
    type: "number",
    group: "icom",
    help: "UDP port carrying receive and transmit audio, at 48 kHz.",
    default: "50003",
  },
  {
    key: "icom.decodeDepth",
    label: "Decoder depth",
    type: "number",
    group: "icom",
    help: "1-4. Depth 2 is the live default: about 0.6 s per window, comfortably inside the gap between FT8 cycles. Depth 3 fits with less margin; depth 4 takes around 11 s and cannot keep up with a 15 s cycle.",
    default: "2",
  },
  {
    key: "icom.rfPowerPercent",
    label: "Transmit power (%)",
    type: "number",
    group: "icom",
    help: "Set the radio's RF power on connect, 1-100. Leave at 0 to use whatever the radio is already set to. Worth setting: an IC-7300 left at 100% into a 50%-duty digital mode is how power amplifiers die.",
    default: "0",
  },
  {
    key: "icom.audioKeepalive",
    label: "Send silence on the audio stream",
    type: "boolean",
    group: "icom",
    help: "The RS-BA1 audio socket is bidirectional and the radio appears to cut a receive-only client's audio after a minute or two. Sending silence while idle was meant to prevent that. Measured on the air, it does not: 95 keepalives went out during the 20 seconds before the audio was declared stalled, and the radio answers at roughly the rate we send, which is the shape of a radio reacting to us rather than ignoring us. Leave it on unless you are measuring; turning it off is how to find out whether it helps or harms.",
    default: "true",
  },
  {
    key: "icom.atuOnBandChange",
    label: "Run the ATU after a band change",
    type: "boolean",
    group: "icom",
    help: "Runs the radio's internal tuner (CI-V 1C 01) after an automatic band change or a POTA retune. THIS TRANSMITS — a low-power carrier for a second or two — so it is gated on Allow transmit like every other keying path, and it is off by default. Without it, band hopping lands on a band the tuner has never seen and the radio folds back on the first transmission. Leave it off with a resonant antenna or an external tuner.",
    default: "false",
  },
  {
    key: "icom.allowTransmit",
    label: "Allow transmit",
    type: "boolean",
    group: "icom",
    help: "Off means nothing can key this radio, ever. Separate from the FlexRadio's switch on purpose, and it inherits nothing from it: arming a Flex sitting on a proper antenna says nothing about an IC-7300 that might be on a dummy load or halfway through being set up. Each radio is armed deliberately or not at all.",
    default: "false",
  },
  {
    key: "icom.silenceRms",
    label: "Silence threshold",
    type: "number",
    group: "icom",
    help: "Windows quieter than this are skipped without decoding. Lower than the FlexRadio equivalent on purpose: Icom audio arrives at 48 kHz and needs two decimation passes to reach the decoders' 12 kHz, against the Flex's one from 24 kHz, and the filter has about 0.8 gain per pass — so the same signal is roughly 20% quieter here. Reusing the Flex value would silently skip marginal windows and look like an antenna fault.",
    default: "0.0008",
  },

  // --- The bridge itself ---
  //
  // These three were `omega.bridgePort`, `omega.bridgeToken` and `omega.bridgeWsUrl`,
  // which named the bridge after a program it does not require and mostly does not
  // talk to. `legacyKeys` keeps an existing install working — see lib/settings/index.ts.
  {
    key: "bridge.port",
    label: "Bridge HTTP/WS port",
    type: "number",
    group: "bridge",
    help: "Where the bridge serves the live decode WebSocket and its control API. Not the Next.js port.",
    envFallback: "BRIDGE_PORT",
    legacyKeys: ["omega.bridgePort"],
    default: "3101",
  },
  {
    key: "bridge.bindAddress",
    label: "Bridge listen address",
    type: "string",
    group: "bridge",
    help: "Which address the radio service listens on. 127.0.0.1 (the default) means only this machine can reach it, which is why listening to receiver audio from a phone or another computer does not work out of the box. Set it to 0.0.0.0 to allow the rest of your network. Read this before you do: the control API is protected by a shared secret, but the decode and audio WebSockets are NOT — anything on your network could listen to your receiver. On a home LAN behind a router that is usually fine; on shared or public wifi it is not. The safer alternative is leaving this alone and proxying /ws/decodes and /ws/audio through NGINX on the app's own origin, then setting the public WebSocket URL below.",
    default: "127.0.0.1",
  },
  {
    key: "bridge.token",
    label: "Bridge shared secret",
    type: "secret",
    group: "bridge",
    help: "Authenticates the web app to the bridge's control API. Self-provisioned on first run — there is nothing to decide here.",
    envFallback: "BRIDGE_TOKEN",
    legacyKeys: ["omega.bridgeToken"],
  },
  {
    key: "bridge.wsUrl",
    label: "Public WebSocket URL",
    type: "string",
    group: "bridge",
    help: "Where browsers reach the live decode feed. Leave blank for development (the bridge port on this host). Behind NGINX set wss://your-host/ws/decodes.",
    legacyKeys: ["omega.bridgeWsUrl"],
    placeholder: "wss://digishack.example.com/ws/decodes",
  },

  // --- External decoder (WSJT-X protocol) ---
  {
    key: "wsjtx.udpPort",
    label: "UDP port",
    type: "number",
    group: "wsjtx",
    help: "Port the decoder broadcasts the WSJT-X protocol on. WSJT-X defaults to 2237.",
    envFallback: "WSJTX_UDP_PORT",
    legacyKeys: ["omega.udpPort"],
    default: "2237",
  },
  {
    key: "wsjtx.udpHost",
    label: "UDP bind address",
    type: "string",
    group: "wsjtx",
    help:
      "Address DigiShack listens on for WSJT-X's UDP broadcasts. 0.0.0.0 accepts them from any machine on the network; 127.0.0.1 only from this one. Used only when the digital source is the external decoder.",
    envFallback: "WSJTX_UDP_HOST",
    legacyKeys: ["omega.udpHost"],
    default: "0.0.0.0",
  },
  {
    key: "wsjtx.autoLog",
    label: "Auto-log QSOs from the decoder",
    type: "boolean",
    group: "wsjtx",
    help: "Write a QSO when the external decoder reports a completed contact.",
    legacyKeys: ["omega.autoLog"],
    default: "false",
  },

  // --- Issue alerts ---
  {
    key: "alerts.enabled",
    label: "Email me when something goes wrong",
    type: "boolean",
    group: "alerts",
    help: "Radio unreachable for minutes, the bridge restarted by its own watchdog, uploads failing run after run, a guard stopping transmission over high SWR or PA temperature. Needs working SMTP (Settings → QSL).",
    default: "false",
  },
  {
    key: "alerts.email",
    label: "Send alerts to",
    type: "string",
    group: "alerts",
    help: "Blank sends to the first active admin's address.",
    placeholder: "you@example.com",
  },
  {
    key: "alerts.cooldownMinutes",
    label: "Quietest repeat for the same issue (minutes)",
    type: "number",
    group: "alerts",
    help: "A fault that persists re-sends after this long; a fault that clears and returns emails again immediately. This is what keeps a flapping radio from burying the one email that mattered.",
    default: "360",
  },

  // --- Software updates ---
  {
    key: "update.allowFromUi",
    label: "Allow updating from the UI",
    type: "boolean",
    group: "update",
    help: "Off by default on purpose — enabling it means an admin account can deploy new code to this server.",
    default: "false",
  },
  // `update.gitToken` and `update.gitUsername` were here and are deliberately gone.
  //
  // DigiShack updates itself from its own PUBLIC repository, which anyone can fetch with
  // no credential whatsoever. The settings asked every operator to mint a token — naming
  // a private forge they have no account on — to reach something that needs nothing.
  //
  // And the mechanism had already cost real damage. To use a token, `withCredentials()`
  // wrote it into a temporary credential file and pointed git at it via config; a
  // backslash-escaping bug in that config value made git resolve the path against the
  // REPOSITORY ROOT and write a live token, in a plaintext URL, into the working tree.
  // Five of those reached origin/main before a reviewer found them. The code carried a
  // long comment explaining the fix; the better fix is not to hold the token at all.
  //
  // A private fork that genuinely needs authentication configures a git credential
  // helper on the server, which is ordinary operations and keeps the secret out of the
  // application entirely.

  // --- SMTP ---
  {
    key: "smtp.host",
    label: "SMTP host",
    type: "string",
    group: "smtp",
    help:
      "Mail server for everything DigiShack sends — QSL emails and station alerts. Without it both are silently unavailable, which is why the Integrations page reports SMTP on its own.",
    envFallback: "SMTP_HOST",
  },
  {
    key: "smtp.port",
    label: "SMTP port",
    type: "number",
    group: "smtp",
    help:
      "587 for STARTTLS, which is the usual choice. 465 for implicit TLS with the setting below turned on. 25 only on a local relay.",
    envFallback: "SMTP_PORT",
    default: "587",
  },
  {
    key: "smtp.secure",
    label: "Implicit TLS (port 465)",
    type: "boolean",
    group: "smtp",
    help: "On only for implicit TLS on port 465. Leave it OFF for STARTTLS on 587, which is the usual arrangement — the connection is still encrypted, just negotiated after connecting.",
    envFallback: "SMTP_SECURE",
    default: "false",
  },
  {
    key: "smtp.user",
    label: "SMTP username",
    type: "string",
    group: "smtp",
    help:
      "The account to authenticate as. Often the full email address rather than a short name, depending on the provider.",
    envFallback: "SMTP_USER",
  },
  {
    key: "smtp.password",
    label: "SMTP password",
    type: "secret",
    group: "smtp",
    help: "For Microsoft app passwords, remove the spaces.",
    envFallback: "SMTP_PASSWORD",
  },
  {
    key: "qsl.operatorName",
    label: "Operator name for QSL emails",
    type: "string",
    group: "smtp",
    help: "Signed at the bottom of QSL confirmations, alongside the station callsign. Leave blank to sign with the callsign only.",
  },
  // ---------------------------------------------------------------------------
  // QSL email and card
  //
  // Every word that goes out is a template here rather than a string in the code.
  // A QSL card makes claims about how the operator works — "I have uploaded to
  // LoTW, eQSL, QRZ and Club Log", "will QSL by mail for any cards received" —
  // and code has no business asserting those on their behalf. The defaults match
  // the operator's existing emailer so nothing changes tone on the switch-over.
  // ---------------------------------------------------------------------------
  {
    key: "qsl.email.subject",
    label: "QSL email subject",
    type: "string",
    group: "qsl",
    help: `Tokens: ${TOKEN_HELP}`,
    default: "QSL Confirmation for {THEIR_CALL} / {MY_CALL} QSO",
  },
  {
    key: "qsl.email.body",
    label: "QSL email body",
    type: "text",
    group: "qsl",
    help: `The message above the contact data. Tokens: ${TOKEN_HELP}`,
    default: [
      "{THEIR_CALL},",
      "",
      "Thank you for the QSO. Please find my QSL card attached. I have also uploaded the contact to LOTW, eQSL, QRZ, and Clublog.",
      "",
      "73,",
      "{MY_NAME}",
      "{MY_CALL}",
    ].join("\n"),
  },
  {
    key: "qsl.email.contactDataHeading",
    label: "Contact data heading",
    type: "string",
    group: "qsl",
    help: "Heading above the contact detail block. Blank to omit the block entirely.",
    default: "Contact Data",
  },
  {
    key: "qsl.email.contactData",
    label: "Contact data block",
    type: "text",
    group: "qsl",
    help: `Fixed-width detail block. A line whose only token is empty is dropped, so optional fields disappear cleanly. Tokens: ${TOKEN_HELP}`,
    default: [
      "Call: {THEIR_CALL} DE {MY_CALL}",
      "Date: {DATE} {TIME}:00 UTC",
      "Freq: {FREQ} MHz",
      "Band: {BAND}",
      "Mode: {MODE}",
      "RSTS: {RST_SENT}",
      "RSTR: {RST_RCVD}",
      "TX Power: {POWER}",
      "My Grid: {MY_GRID}",
      "Your Grid: {THEIR_GRID}",
    ].join("\n"),
  },
  {
    key: "qsl.email.cardHeading",
    label: "Embedded card heading",
    type: "string",
    group: "qsl",
    help: "Heading above the card shown inline in the email. Blank to omit the heading.",
    default: "Embedded QSL Card:",
  },
  {
    key: "qsl.email.embedCard",
    label: "Show the card inline",
    type: "boolean",
    group: "qsl",
    help: "Display the card in the message body. Most clients show it; a few show the attachment only.",
    default: "true",
  },
  {
    key: "qsl.email.attachCard",
    label: "Attach the card as a file",
    type: "boolean",
    group: "qsl",
    help: "Attach as well as embed, so the recipient can save it. Recommended: an inline-only image is awkward to keep.",
    default: "true",
  },
  {
    key: "qsl.txPower",
    label: "Transmit power for QSL cards",
    type: "string",
    group: "qsl",
    help: "Fills {POWER}. A station constant rather than a per-QSO field — there is no per-QSO power column, and for digital work it rarely varies. Blank omits the line.",
    placeholder: "100",
    default: "",
  },
  {
    key: "qsl.qth",
    label: "QTH text for QSL cards",
    type: "string",
    group: "qsl",
    help: "Fills {MY_QTH}, e.g. \"Porter County, Indiana\". Blank omits it.",
    default: "",
  },
  // --- automatic QSL emailing ---
  //
  // Off by default, and split across two switches on purpose. Enabling the first
  // only fills the review queue; nothing is sent to anybody until the second is
  // also on. These are unsolicited emails to other operators, and a logger that
  // mails a few hundred strangers because one box was ticked without being
  // understood costs its operator a reputation and its mail server a blocklist
  // entry.
  // --- automatic operating guards ---
  //
  // These were hardcoded in DEFAULT_GUARDS and unreachable from the UI, including
  // the two that protect hardware rather than manners.
  {
    key: "auto.maxRunMinutes",
    label: "Stop automatic operating after (minutes)",
    type: "limit",
    group: "auto",
    help: "Wall-clock ceiling on one run. 0 disables it. This is the ONLY guard that bounds automatic operation in time — every other brake counts events and is reset by making progress, so a station that keeps working people could otherwise transmit indefinitely.",
    default: "240",
  },
  {
    key: "auto.maxQsosPerRun",
    label: "Stop after this many QSOs",
    type: "limit",
    group: "auto",
    help: "Ceiling on contacts in one run. 0 disables it. Not reset by anything short of a re-arm.",
    default: "100",
  },
  {
    key: "auto.maxSwr",
    label: "Stop above this SWR",
    type: "limit",
    group: "auto",
    help: "High SWR unattended means a damaged or disconnected antenna. A Flex folds power back past 3:1 anyway. Changing band does NOT clear this — it needs you to look at the antenna.",
    default: "3",
  },
  {
    key: "auto.maxPaTempC",
    label: "Stop above this PA temperature (C)",
    type: "limit",
    group: "auto",
    help: "Pauses transmitting when the PA reaches this temperature, in Celsius, and resumes once it has fallen back. A duty-cycle brake that reads the radio rather than guessing from a timer.",
    default: "75",
  },
  {
    key: "auto.maxConsecutiveTx",
    label: "Pause after this many transmissions without you",
    type: "limit",
    group: "auto",
    help: "The runaway brake. Reset by any operator interaction and by every completed QSO, which is why the wall-clock limit above exists as well.",
    default: "20",
  },
  {
    key: "auto.maxUnansweredCqs",
    label: "Give up after this many unanswered CQs",
    type: "limit",
    group: "auto",
    help: "Treated as a quiet band, so band-hopping may move rather than stop.",
    default: "15",
  },
  {
    key: "auto.deafWindowLimit",
    label: "Stop after this many silent receive windows",
    type: "limit",
    group: "auto",
    help: "Windows that decode nothing AND carry no audio — a dead audio path, wrong slice or antenna fault. A station that cannot hear must not transmit.",
    default: "4",
  },
  {
    key: "auto.maxCallAttempts",
    label: "Give up on a station after this many calls",
    type: "limit",
    group: "auto",
    help:
      "How many times an automatic mode calls one station before giving up and moving on. Each attempt is a full transmit cycle, so this is a time budget as much as a persistence setting — four is roughly two minutes on FT8.",
    default: "5",
  },
  {
    key: "auto.failureCooldownMin",
    label: "Do not re-call a station for (minutes)",
    type: "limit",
    group: "auto",
    help:
      "How long to leave a station alone after giving up on them. Stops you watching the same unanswered call repeat every few minutes while the rest of the band goes unworked.",
    default: "30",
  },
  {
    key: "auto.dupeWindowHours",
    label: "Skip stations already worked within (hours)",
    type: "limit",
    group: "auto",
    help:
      "Same band and same mode, where mode means FT8, FT4 or FT2. A station is worked at most once per UTC day per slot as well, so shortening this cannot bring same-day duplicates back — set it to two hours to chase an opening and each station is still worked once today. Zero turns the guard off entirely, which is the only way to allow duplicates and has to be typed in deliberately.",
    confirm: {
      // ONLY zero. Clearing the box restores the 24 h default, and any positive number
      // still carries the once-per-UTC-day floor, so neither can produce a duplicate. Zero
      // is the single value that removes the guard, and it is the only one worth stopping.
      when: (v) => v !== null && v.trim() !== "" && Number(v) <= 0,
      message:
        "Setting this to zero removes the only thing stopping the automatic modes from " +
        "working the same station over and over. A live station logged one callsign three " +
        "times in three minutes with this guard absent. Every other value — including a " +
        "very short one — still works each station at most once per UTC day per band and " +
        "mode. Turn it off only if you actually want duplicate contacts.",
    },
    default: "24",
  },
  {
    key: "ui.experimental.rig",
    label: "Show the experimental Rig page",
    type: "boolean",
    group: "general",
    help: "Off by default, and honestly labelled: the Rig page is the least finished part of DigiShack. The panadapter's dB window is not calibrated, the FlexRadio accepts display settings it never reflects in status, and several controls are reasoned from documentation rather than measured against hardware. It is genuinely useful and it is genuinely a work in progress, which is why a new install does not meet it first. Turning this on adds Rig to the menu; the page itself says the same thing at the top so nobody arrives without the warning.",
    default: "false",
  },
  {
    key: "auto.skipWorkedOnBandMode",
    label: "Never make a duplicate contact, with EVERYONE",
    type: "boolean",
    group: "auto",
    help: "OFF by default, and the normal way to prevent duplicates is the per-callsign list below rather than this. Turning this on applies one blanket rule to every station you work: no second contact on a band and mode already in the log, ever. Some operators want exactly that; most would rather honour the specific people who have asked. A different MODE on the same band is still allowed either way, because that is a genuinely new slot.",
    default: "false",
  },
  {
    key: "auto.skipWorkedOnBand",
    label: "Never re-work a station on a band already worked",
    type: "boolean",
    group: "auto",
    help: "A stricter rule than the dupe window above, and a different question: that one asks whether you worked them RECENTLY on this band and mode, this asks whether you have EVER worked them on this band, in any mode. Mode-agnostic on purpose — a band slot is a band slot, and somebody worked on 20 m FT4 is not a new 20 m contact because today it is FT8. Off by default: with a large log this silences a great deal of a domestic band, which is right for an award chaser filling slots and wrong for anyone who just wants contacts. It only ever restricts the automatic modes; you can still call anyone by hand.",
    default: "false",
  },
  // --- POTA chasing ---
  //
  // The default is deliberately conservative: chase only on the band already being
  // decoded. Following every spot across every band sounds like more coverage and is
  // the opposite — see the blurb on the group.
  {
    key: "pota.chaseBands",
    label: "Bands to chase on",
    type: "string",
    group: "pota",
    help: "Comma-separated, e.g. \"20M,17M,15M\". Blank means the band you are already decoding on and nothing else. \"any\" follows spots onto any band. Restricting this is what makes chase mode productive: 30 FT8 spots spread over eight bands means most retunes land somewhere you cannot hear, and each one costs the give-up time below before another can be tried.",
    placeholder: "20M,17M,15M",
    default: "",
  },
  {
    key: "uploads.enabled",
    label: "Upload contacts automatically",
    type: "boolean",
    group: "uploads",
    help: "Master switch. When on, each new contact is uploaded shortly after it is logged, and a sweep catches anything missed. Nothing already in the log is touched — see the cutoff below.",
    default: "false",
  },
  {
    key: "uploads.qrz",
    label: "Upload to QRZ Logbook",
    type: "boolean",
    group: "uploads",
    help: "Needs the QRZ logbook API key (a separate subscription from an ordinary QRZ account). A contact QRZ reports as a duplicate is marked as sent rather than retried — it is already there, which is the outcome wanted.",
    default: "true",
  },
  {
    key: "uploads.eqslReciprocalOnly",
    label: "Only send eQSLs to operators who sent us one",
    type: "boolean",
    group: "uploads",
    help:
      "On eQSL the upload IS the card — it is a card-exchange service with no log-only " +
      "mode, so there is no way to record a contact there without creating an outgoing " +
      "eQSL. With this on, one is only created for a contact where THEY have already sent " +
      "us an eQSL, which is returning a card rather than initiating one, and is the " +
      "etiquette of QSLing anyway. It also cuts the backlog by two thirds, and eQSL takes " +
      "one request per contact.",
    default: "true",
  },
  {
    key: "uploads.cloudlogBatch",
    label: "Contacts per Cloudlog/Wavelog sweep",
    type: "number",
    group: "uploads",
    help:
      "Cloudlog and Wavelog take one request per contact, like QRZ and eQSL — but unlike " +
      "those, the server is YOURS. The general per-run limit exists to be polite to other " +
      "people's services and to stay inside their rate limits; neither applies to a box on " +
      "your own network, so a backlog there has no reason to take days. Lower it if the " +
      "server is small or shared.",
    default: "200",
  },
  {
    key: "uploads.lotwBatch",
    label: "Contacts per LoTW upload",
    type: "number",
    group: "uploads",
    help:
      "LoTW takes one signed file per sweep however many contacts are in it, so the " +
      "general per-run limit means something different here. That limit exists because QRZ " +
      "and eQSL take one request PER CONTACT — 25 of them is 25 API calls — whereas for " +
      "LoTW 25 and 500 are both a single POST. At 25 a six-thousand-contact backlog takes " +
      "two days for no reason. TQSL users routinely upload a whole log in one file.",
    default: "500",
  },
  {
    key: "uploads.lotw",
    label: "Upload to LoTW",
    type: "boolean",
    group: "uploads",
    help:
      "Needs a callsign certificate uploaded under Logbook of the World — there is no " +
      "username-and-password path for uploads, because the signature on each contact is " +
      "the authentication. Contacts go up in one signed batch per run. LoTW discards " +
      "duplicates, so a re-sent batch is harmless, which is why an ambiguous timeout is " +
      "treated as a failure and retried rather than assumed to have worked.",
    default: "false",
  },
  {
    key: "uploads.eqsl",
    label: "Upload to eQSL.cc",
    type: "boolean",
    group: "uploads",
    help: "Off by default like every other upload target, because it posts a card to another operator rather than filing a record with a service. eQSL takes one contact per request as ADIF in a query string, with your username and password in it — that is eQSL's design, not a choice available here, and it is why this needs the eQSL credentials set under eQSL.cc rather than an API key. A contact eQSL reports as a duplicate is marked done rather than retried: already being there is the state we wanted.",
    default: "false",
  },
  {
    key: "uploads.clublog",
    label: "Upload to Club Log",
    type: "boolean",
    group: "uploads",
    help: "Off by default: uploads from this installation are refused with a bare nginx 403 that arrives before authentication, and the cause is outside this software. Downloads and log reconciliation work normally. Pointing Club Log at LoTW populates it without uploading from here at all.",
    default: "false",
  },
  {
    key: "uploads.since",
    label: "Only upload contacts made after",
    type: "string",
    group: "uploads",
    help: "ISO date, e.g. 2026-08-01. Contacts older than this are never uploaded automatically. This is the guard that stops switching the feature on from pushing your entire back catalogue. Leave blank only if you are certain nothing older needs skipping.",
    placeholder: "2026-08-01",
  },
  {
    key: "uploads.maxPerRun",
    label: "Most contacts to upload per run",
    type: "number",
    group: "uploads",
    help: "A cap so a backlog is worked through gradually rather than in one burst against someone else's API.",
    default: "25",
  },
  {
    key: "uploads.intervalMinutes",
    label: "Sweep for un-uploaded contacts every (minutes)",
    type: "number",
    group: "uploads",
    help: "Catches contacts entered by hand or imported, which the per-QSO trigger never sees. 0 disables the sweep, leaving only the per-QSO path.",
    default: "10",
  },
  {
    key: "digital.decodeRetentionDays",
    label: "Keep decodes for (days)",
    type: "number",
    group: "digital",
    help: "A busy band produces around 42,000 decodes a day — roughly 10 MB, or 3.7 GB a year — and nothing used to delete any of it. Decodes attached to a logged contact are NEVER pruned whatever this says; they are the evidence of the QSO. 0 keeps everything, which is fine if you have the disk and want the full history.",
    default: "30",
  },
  {
    key: "pota.userToken",
    label: "POTA session token (for importing your log)",
    type: "secret",
    group: "pota",
    help: "Only needed to import your POTA hunter log — nothing else uses it. POTA's public API stops at 25 recent contacts, and the full log needs the session token from a browser signed in to pota.app. To get it: sign in at pota.app, open your browser's developer tools, go to the Network tab, click any request to api.pota.app, and copy the whole value of the Authorization request header. It is a short-lived AWS Cognito token and will expire in hours, which is why this is a one-time backfill rather than a live connection — once the history is in, DigiShack records park references itself from every contact it makes.",
    placeholder: "eyJhbGciOi…",
  },
  {
    key: "pota.chaseGiveUpSec",
    label: "Give up on an activator after (seconds)",
    type: "number",
    group: "pota",
    help: "How long to sit on a park frequency without hearing the activator. Six FT8 cycles is 90 s. Too short and you miss someone working a pile-up; too long and one dead spot eats the session.",
    default: "90",
  },
  {
    key: "pota.chaseRetrySpotMin",
    label: "Do not retry an activator for (minutes)",
    type: "number",
    group: "pota",
    help: "After giving up on, or finishing with, an activator. They usually stay in a park for an hour or more, so a short value means chasing the same handful repeatedly.",
    default: "30",
  },
  {
    key: "pota.chaseWorkAudible",
    label: "Also work POTA CQs heard on frequency",
    type: "boolean",
    group: "pota",
    help: "While waiting for a spot worth chasing, work any station calling \"CQ POTA\" that is already audible. They are free contacts — no retune, no deaf period — and an activator is often heard before the spot feed catches up.",
    default: "true",
  },
  {
    key: "pota.chasePreferNew",
    label: "Prefer parks and entities you have not worked",
    type: "boolean",
    group: "pota",
    help: "Ranks spots by award value — a new DXCC entity or a callsign never worked before goes first — rather than purely by which spot is freshest.",
    default: "true",
  },
  {
    key: "pota.chaseReturnToCalling",
    label: "Return to the calling frequency when idle",
    type: "boolean",
    group: "pota",
    help: "When there is nothing worth chasing, come back to the band's standard FT8/FT4 frequency instead of sitting on the last park. Without this the radio stays parked wherever the last activator was, hears nothing, and cannot fall back to ordinary hunting.",
    default: "true",
  },
  {
    key: "qsl.auto.enabled",
    label: "Queue QSL emails automatically",
    type: "boolean",
    group: "qsl",
    help: "Look for contacts that have no QSL yet, resolve the address from QRZ, and add them to the review queue. On its own this sends nothing.",
    default: "false",
  },
  {
    key: "qsl.auto.approve",
    label: "Send them without review",
    type: "boolean",
    group: "qsl",
    help: "Approve and send automatically, with no human looking first. Needs the setting above. An emailed QSL cannot be recalled, so leave this off until you have seen a few queued messages you are happy with.",
    default: "false",
  },
  {
    key: "qsl.auto.maxPerDay",
    label: "Most QSL emails per day",
    type: "number",
    group: "qsl",
    help: "Rolling 24-hour ceiling on messages actually sent, counted from the queue's own record. A sudden burst of mail from one address is how a server earns a spam reputation.",
    default: "25",
  },
  {
    key: "qsl.auto.maxPerRun",
    label: "Most per pass",
    type: "number",
    group: "qsl",
    help: "How many one pass may send. Keeps a 26,000-QSO backlog from going out in an afternoon when the feature is first switched on.",
    default: "5",
  },
  {
    key: "qsl.auto.minAgeMinutes",
    label: "Wait this long after the QSO (minutes)",
    type: "number",
    group: "qsl",
    help: "A mistyped callsign is usually spotted within a minute or two, and an emailed QSL cannot be taken back. This is the window in which a logging error is still free to fix.",
    default: "15",
  },
  {
    key: "qsl.auto.maxAgeDays",
    label: "Ignore contacts older than (days)",
    type: "number",
    group: "qsl",
    help: "Stops switching the feature on from mailing years of back-log. Raise it deliberately if you do want to work through older contacts.",
    default: "7",
  },
  {
    key: "qsl.auto.intervalMinutes",
    label: "Check every (minutes)",
    type: "number",
    group: "qsl",
    help: "How often the radio service looks for eligible contacts. Needs a restart to take effect.",
    default: "30",
  },
  {
    key: "qsl.card.enabled",
    label: "Render a QSL card",
    type: "boolean",
    group: "qsl",
    help: "Off sends a text-only confirmation. Needs artwork at the path below.",
    default: "false",
  },
  {
    key: "qsl.card.baseImage",
    label: "Card artwork path",
    type: "string",
    group: "qsl",
    help: "Your card image, with no table or placeholder text on it — the QSO table is composited on top. Relative to the install directory. Never committed to git.",
    default: "data/qsl/card-base.png",
  },
  {
    key: "qsl.card.columns",
    label: "Card table columns",
    type: "string",
    group: "qsl",
    help: "Comma-separated, in order. Available: CALL DATE TIME BAND FREQ REPORT RST_RCVD MODE POWER GRID.",
    default: "CALL,DATE,TIME,BAND,REPORT,MODE",
  },
  {
    key: "qsl.card.footer",
    label: "Card footer line",
    type: "string",
    group: "qsl",
    help: `Full-width line under the table. Blank to omit it. Tokens: ${TOKEN_HELP}`,
    default: "73, Thanks for the QSO! Will QSL by mail for any cards received as well.",
  },
  {
    key: "qsl.card.width",
    label: "Card width for email (px)",
    type: "number",
    group: "qsl",
    help: "Artwork is scaled to this before the table is drawn. 1600 is a good balance; full resolution artwork can be tens of MB and this goes out once per QSO.",
    default: "1600",
  },
  {
    key: "qsl.card.tableWidth",
    label: "Table width (fraction)",
    type: "number",
    group: "qsl",
    help: "0.6 = 60% of the card width. Geometry is fractional so one setting fits any artwork size.",
    default: "0.6",
  },
  {
    key: "qsl.card.tableRight",
    label: "Table inset from right (fraction)",
    type: "number",
    group: "qsl",
    help:
      "How far the QSO table sits from the RIGHT edge, as a fraction of the card's width (0.05 = five per cent in). A fraction rather than pixels, so one setting works whether the artwork is 1500 px wide or 5000.",
    default: "0.012",
  },
  {
    key: "qsl.card.tableBottom",
    label: "Table inset from bottom (fraction)",
    type: "number",
    group: "qsl",
    help:
      "How far the table sits from the BOTTOM edge, as a fraction of the card's height. Same reasoning as the setting above.",
    default: "0.012",
  },
  {
    key: "qsl.card.fontScale",
    label: "Table font scale",
    type: "number",
    group: "qsl",
    help: "1 = automatic size from the table width. Raise or lower to taste.",
    default: "1",
  },
  {
    key: "qsl.card.font",
    label: "Card font",
    type: "select",
    // Built from the shipped list rather than written out twice: adding a font to
    // assets/fonts and the list is then the whole change, and the picker cannot drift out
    // of step with what is actually installed.
    options: BUNDLED_FONTS.map((f) => ({ value: f.family, label: f.label })),
    group: "qsl",
    help:
      "Typeface for the QSO table. DigiShack SHIPS these, so they render identically on " +
      "every machine: \"PT Sans Narrow\" (condensed, the classic QSL table and the " +
      "default), \"Lato\" (a wider humanist sans) or \"PT Serif\" (more formal). All three " +
      "are SIL Open Font License 1.1 with the licence text beside them in assets/fonts. " +
      "Any other name is passed to the system, which works only if that font is installed " +
      "on the server — the bundled ones need nothing. This exists because a card drawn " +
      "with no font available comes out with an empty table and a row of empty boxes, " +
      "which looks like missing QSO data rather than a missing typeface.",
    default: DEFAULT_CARD_FONT,
  },
  {
    key: "qsl.card.textColor",
    label: "Table text colour",
    type: "string",
    group: "qsl",
    help:
      "Colour of the table text, as a CSS colour such as #000000. Choose it against your artwork rather than against the cell fill, since a photographic card shows through a translucent cell.",
    default: "#000000",
  },
  {
    key: "qsl.card.headingBg",
    label: "Table heading background",
    type: "string",
    group: "qsl",
    help:
      "Fill behind the column headings. Accepts a CSS colour including one with alpha — rgba(255,255,255,0.85) is usually what you want over a photograph.",
    default: "#ffffff",
  },
  {
    key: "qsl.card.cellBg",
    label: "Table cell background",
    type: "string",
    group: "qsl",
    help:
      "Fill behind the QSO values, beneath the headings. Usually lighter or more transparent than the heading fill so the two rows read as one table.",
    default: "#ffffff",
  },
  {
    key: "qsl.card.borderColor",
    label: "Table border colour",
    type: "string",
    group: "qsl",
    help:
      "Colour of the lines between cells. Match it to the text for a printed-form look, or make it translucent to let the artwork through.",
    default: "#000000",
  },
  {
    key: "qsl.card.quality",
    label: "Card JPEG quality",
    type: "number",
    group: "qsl",
    help: "40-100. 88 keeps a photographic card around 200 kB.",
    default: "88",
  },
  {
    key: "smtp.from",
    label: "From address",
    type: "string",
    group: "smtp",
    help:
      "The address messages appear to come from. Many providers refuse to send when this does not match the authenticated account, and the refusal usually names the mismatch.",
    placeholder: "DigiShack <noreply@example.com>",
    envFallback: "SMTP_FROM",
  },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

export function getSettingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

export function isSecret(key: string): boolean {
  return BY_KEY.get(key)?.type === "secret";
}

export const SETTING_KEYS: string[] = SETTINGS.map((s) => s.key);
