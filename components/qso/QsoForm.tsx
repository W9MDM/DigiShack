import { useEffect, useMemo, useState } from "react";

import { ResendQslButton } from "@/components/qsl/ResendQslButton";
import {
  Badge,
  Button,
  ErrorBanner,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { formatRefList, parseRefList } from "@/lib/pota/ref-list";
import { ApiError, apiGet } from "@/lib/client/api";
import {
  BAND_NAMES,
  COMMON_BANDS,
  formatFreqMHz,
  freqToBand,
  parseFreqToHz,
} from "@/lib/ham/bands";
import { LOGGABLE_MODES, defaultRst } from "@/lib/ham/modes";
import { formatUtc, fromUtcInputValue, toUtcInputValue, utcNowInputValue } from "@/lib/time";
import type { DupeCheckResponse, Qso, Station } from "@/lib/types";

export interface QsoFormValues {
  callsign: string;
  freqMHz: string;
  band: string;
  mode: string;
  startTime: string; // UTC "YYYY-MM-DDTHH:mm"
  endTime: string;
  rstSent: string;
  rstRcvd: string;
  gridSquare: string;
  name: string;
  qth: string;
  dxcc: string;
  state: string;
  cqZone: string;
  iota: string;
  sig: string;
  sigInfo: string;
  continent: string;
  notes: string;
  stationId: string;
  operatorId: string;
  qslSent: string;
  qslRcvd: string;
  lotwSent: boolean;
  lotwRcvd: boolean;
  qrzSent: boolean;
  qrzRcvd: boolean;
  eqslSent: boolean;
  emailQslSent: boolean;
  eqslRcvd: boolean;
}

export function emptyValues(): QsoFormValues {
  return {
    callsign: "",
    freqMHz: "",
    band: "",
    mode: "FT8",
    startTime: utcNowInputValue(),
    endTime: "",
    rstSent: defaultRst("FT8"),
    rstRcvd: defaultRst("FT8"),
    gridSquare: "",
    name: "",
    qth: "",
    dxcc: "",
    state: "",
    cqZone: "",
    iota: "",
    sig: "",
    sigInfo: "",
    continent: "",
    notes: "",
    stationId: "",
    operatorId: "",
    qslSent: "NONE",
    qslRcvd: "NONE",
    lotwSent: false,
    lotwRcvd: false,
    qrzSent: false,
    qrzRcvd: false,
    eqslSent: false,
    emailQslSent: false,
    eqslRcvd: false,
  };
}

export function valuesFromQso(qso: Qso): QsoFormValues {
  return {
    callsign: qso.callsign,
    freqMHz: formatFreqMHz(qso.freqHz),
    band: qso.band,
    mode: qso.mode,
    startTime: toUtcInputValue(qso.startTime),
    endTime: toUtcInputValue(qso.endTime),
    rstSent: qso.rstSent ?? "",
    rstRcvd: qso.rstRcvd ?? "",
    gridSquare: qso.gridSquare ?? "",
    name: qso.name ?? "",
    qth: qso.qth ?? "",
    dxcc: qso.dxcc === null ? "" : String(qso.dxcc),
    state: qso.state ?? "",
    cqZone: qso.cqZone === null ? "" : String(qso.cqZone),
    iota: qso.iota ?? "",
    sig: qso.sig ?? "",
    sigInfo: formatRefList(
      qso.sigRefs?.length
        ? [...qso.sigRefs]
            .sort((a, b) => Number(b.primary) - Number(a.primary))
            .map((r) => r.sigInfo)
        : qso.sigInfo
          ? [qso.sigInfo]
          : [],
    ),
    continent: qso.continent ?? "",
    notes: qso.notes ?? "",
    stationId: qso.stationId,
    operatorId: qso.operatorId ?? "",
    qslSent: qso.qslSent,
    qslRcvd: qso.qslRcvd,
    lotwSent: qso.lotwSent,
    lotwRcvd: qso.lotwRcvd,
    qrzSent: qso.qrzSent,
    qrzRcvd: qso.qrzRcvd,
    eqslSent: qso.eqslSent,
    emailQslSent: qso.emailQslSent,
    eqslRcvd: qso.eqslRcvd,
  };
}

/** Turn form strings into the JSON body the API expects. */
export function toRequestBody(v: QsoFormValues) {
  const freqHz = parseFreqToHz(v.freqMHz);
  const start = fromUtcInputValue(v.startTime);
  const end = fromUtcInputValue(v.endTime);

  return {
    callsign: v.callsign.trim().toUpperCase(),
    freqHz: freqHz ?? 0, // 0 fails validation server-side with a clear message
    band: v.band || undefined,
    mode: v.mode,
    startTime: start ? start.toISOString() : "",
    endTime: end ? end.toISOString() : null,
    rstSent: v.rstSent.trim() || null,
    rstRcvd: v.rstRcvd.trim() || null,
    gridSquare: v.gridSquare.trim() || null,
    // Not upper-cased: it is a person's name and a place, and both get printed.
    name: v.name.trim() || null,
    qth: v.qth.trim() || null,
    dxcc: v.dxcc.trim() === "" ? null : Number(v.dxcc),
    state: v.state.trim() || null,
    cqZone: v.cqZone.trim() === "" ? null : Number(v.cqZone),
    iota: v.iota.trim() || null,
    sig: v.sig.trim() || null,
    // The field holds a list; the primary is its first entry.
    sigRefs: parseRefList(v.sigInfo),
    sigInfo: parseRefList(v.sigInfo)[0] ?? null,
    continent: v.continent.trim() || null,
    notes: v.notes.trim() || null,
    stationId: v.stationId,
    operatorId: v.operatorId || null,
    qslSent: v.qslSent,
    qslRcvd: v.qslRcvd,
    lotwSent: v.lotwSent,
    lotwRcvd: v.lotwRcvd,
    qrzSent: v.qrzSent,
    qrzRcvd: v.qrzRcvd,
    eqslSent: v.eqslSent,
    emailQslSent: v.emailQslSent,
    eqslRcvd: v.eqslRcvd,
  };
}

// ---------------------------------------------------------------------------
// Draft persistence
// ---------------------------------------------------------------------------
//
// THE FAULT THIS EXISTS FOR. A contact typed into this form lived in React state and
// nowhere else, and nothing in the tree wrote to localStorage, IndexedDB or a
// background sync queue — a sweep for all four returned zero hits. `public/sw.js`
// deliberately declines to intercept anything that is not a GET (`isLive()` returns
// true for every mutation, and the fetch handler returns without `respondWith`), which
// is the right call for a radio — a cached or replayed mutation is worse than a failed
// one — but it means `POST /api/qsos` has no offline path whatsoever.
//
// So on a tethered phone halfway up a hill, the sequence was: tap Log QSO, `apiPost`
// throws `ApiError(0, "Failed to fetch")`, the red banner renders at the TOP of a
// 21-field form the operator has already scrolled past, and the visible result is
// "nothing happened". Then ANY of switching apps (Android discards the tab), tapping a
// manifest shortcut, hitting back, or the phone locking unmounts the component and the
// contact is gone. Not recoverable: the other operator is 800 miles away and off the
// air.
//
// The fix needs no service worker and no API change. The form is a few hundred bytes of
// strings; localStorage holds it across a tab discard, a reload and a browser restart.
//
// WHAT WAS REJECTED. IndexedDB — the extra asynchrony buys durability this does not
// need for one in-progress contact, and an async read cannot run before the first
// paint. A background sync queue — that is a real offline log, and it needs conflict
// rules, a queue UI and a service worker that is allowed to replay mutations; none of
// that should be smuggled in under a bug fix.
//
// A KNOWN LIMIT, stated rather than hidden: there is ONE draft per origin, not one per
// tab. Two tabs on /qsos/new overwrite each other. That is deliberate — a per-tab key
// would be unreadable by the new tab Android opens after discarding the old one, which is
// the exact case this exists for — and it is the wrong trade only for someone logging two
// contacts side by side in two tabs on a desktop, where the network is not the problem
// this solves. UNVERIFIED on a real handset: the tab-discard behaviour here is reasoned
// from the reported symptom, not measured on the phone that reported it.

/** Namespaced and versioned: `parseDraft` refuses a payload written by another shape. */
export const QSO_DRAFT_KEY = "digishack:qso-draft:v1";

/**
 * Bumped only when a stored draft can no longer be read into the current
 * `QsoFormValues`. A draft carrying the wrong number is DISCARDED, never guessed at —
 * a half-restored contact with a plausible-looking wrong frequency is worse than an
 * empty form, because the empty form is obviously empty.
 */
export const QSO_DRAFT_VERSION = 1;

export interface QsoDraft {
  v: number;
  /** ISO-8601, so the page can say when the restored contact was last touched. */
  savedAt: string;
  /** The idempotency key this contact will be submitted under. See `newClientId`. */
  clientId: string;
  values: QsoFormValues;
}

/**
 * The fields that belong to the OPERATING SESSION rather than to one contact.
 *
 * The same distinction `pages/qsos/new.tsx` already makes when it clears the form after
 * a save: station, operator, frequency, band and mode carry to the next contact because
 * they describe where you are sitting, and everything else does not. Here it decides
 * whether there is a contact in progress at all — a form holding nothing but "14.074,
 * 20M, FT8, my station" is a form nobody has started typing into yet, and persisting
 * that would put a draft on disk every time this page was opened.
 *
 * `startTime` is in this list for a second reason: it is `utcNowInputValue()`, so it
 * differs from a freshly built `emptyValues()` within a second of mounting and would
 * make every untouched form look edited.
 */
const SESSION_FIELDS: readonly string[] = [
  "stationId",
  "operatorId",
  "freqMHz",
  "band",
  "mode",
  "startTime",
];

/**
 * Is there a contact in progress worth keeping?
 *
 * Used in both directions, and that symmetry is the point: a draft is written only when
 * this is true, and a stored draft is restored only into a form for which it is false.
 * So a restore can never overwrite something the operator has already typed.
 */
export function hasContactContent(v: QsoFormValues): boolean {
  const empty = emptyValues();
  for (const key of Object.keys(empty) as (keyof QsoFormValues)[]) {
    if (SESSION_FIELDS.includes(key)) continue;
    // The reports default from the CURRENT mode, not from the mode `emptyValues()`
    // happens to start on. Switching FT8 -> SSB rewrites both to "59", and treating
    // that as typed content would put a draft on disk for an untouched form.
    const def =
      key === "rstSent" || key === "rstRcvd" ? defaultRst(v.mode) : empty[key];
    if (v[key] !== def) return true;
  }
  return false;
}

/** Encode a draft. Pure and round-trippable — `parseDraft(serialiseDraft(x))` yields x. */
export function serialiseDraft(
  values: QsoFormValues,
  clientId: string,
  savedAt: Date = new Date(),
): string {
  const draft: QsoDraft = {
    v: QSO_DRAFT_VERSION,
    savedAt: savedAt.toISOString(),
    clientId,
    values,
  };
  return JSON.stringify(draft);
}

/**
 * Decode a stored draft. NEVER THROWS, for any input.
 *
 * This reads a string that a previous release of this application wrote, that a browser
 * extension may have mangled, or that somebody typed into devtools. Every one of those
 * has to end as `null` and an empty form, because the alternative — an exception inside
 * the mount effect — takes the whole logging page down at exactly the moment the
 * operator is trying to recover a contact from it.
 *
 * Unknown keys are dropped and missing keys fall back to `emptyValues()`, so a draft
 * written before a field existed still restores everything it does carry. Keys whose
 * stored type disagrees with the current shape (a string where a boolean belongs) are
 * dropped rather than coerced: `Boolean("false")` is `true`, and a coercion like that
 * would silently flip a QSL flag.
 */
export function parseDraft(raw: string | null | undefined): QsoDraft | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  // Typed as unknown fields rather than as `Partial<QsoDraft>`: this came out of
  // storage, so claiming its members already have their declared types is the assumption
  // that makes a decoder throw.
  const d = parsed as {
    v?: unknown;
    savedAt?: unknown;
    clientId?: unknown;
    values?: unknown;
  };
  if (d.v !== QSO_DRAFT_VERSION) return null;
  if (!d.values || typeof d.values !== "object" || Array.isArray(d.values)) return null;

  const stored = d.values as Record<string, unknown>;
  const values = emptyValues();
  const out = values as unknown as Record<string, unknown>;
  for (const key of Object.keys(values) as (keyof QsoFormValues)[]) {
    const got = stored[key];
    if (typeof got === typeof values[key]) out[key] = got;
  }

  return {
    v: QSO_DRAFT_VERSION,
    savedAt: typeof d.savedAt === "string" ? d.savedAt : "",
    // Empty rather than minted here, so this function stays pure and its round trip is
    // testable. `readDraft` mints one when storage handed back a draft without a usable
    // key.
    clientId: isClientIdShape(d.clientId) ? d.clientId : "",
    values,
  };
}

/**
 * A client id we are willing to submit under.
 *
 * Checked on the way OUT of storage as well as in, because the stored value reaches the
 * server as an idempotency key: a mangled one is either rejected there or — worse —
 * collides with another contact's key and returns somebody else's QSO.
 */
export function isClientIdShape(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._:-]{8,64}$/.test(v);
}

/**
 * A per-contact idempotency key, sent with the QSO and stored on it under a unique
 * index so that a retry or a double tap cannot log the contact twice.
 *
 * THREE RUNGS, and the middle one is the one that matters here. `crypto.randomUUID`
 * exists only in a SECURE CONTEXT, and this application is routinely reached over plain
 * http on a LAN address — `http://192.0.2.1:3100` — where it is undefined.
 * `crypto.getRandomValues` carries no such requirement and is present on http, so that
 * is the working path for the deployment this project actually has. UNVERIFIED on the
 * phone in question: reasoned from the specification, not measured on that handset.
 *
 * The last rung is `Math.random`, which is NOT cryptographically random and is not
 * claimed to be. It does not need to be: this value is never a secret, it only has to
 * be unique among one operator's contacts, and the clock is folded in so that two draws
 * within the same millisecond are the only case relying on `Math.random` alone. It
 * exists so a browser with no Web Crypto at all still gets idempotency rather than an
 * exception on the logging page.
 */
export function newClientId(): string {
  const c: Crypto | undefined =
    typeof globalThis === "undefined" ? undefined : globalThis.crypto;

  try {
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
  } catch {
    // Some embedded browsers expose the name and throw on the call.
  }

  const bytes = new Uint8Array(16);
  let filled = false;
  try {
    if (c && typeof c.getRandomValues === "function") {
      c.getRandomValues(bytes);
      filled = true;
    }
  } catch {
    // Fall through to the last rung.
  }

  if (!filled) {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    // Fold the wall clock into the leading bytes, so a collision needs two draws inside
    // one millisecond rather than merely two unlucky `Math.random` sequences.
    let t = Date.now();
    for (let i = 5; i >= 0; i--) {
      bytes[i] = (bytes[i]! ^ (t & 0xff)) & 0xff;
      t = Math.floor(t / 256);
    }
  }

  // UUID v4 version and variant nibbles, so all three rungs produce one shape and the
  // column holds one kind of value.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i]!.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

// localStorage itself throws, and not only in exotic setups: Safari's private mode
// historically threw on every `setItem`, Firefox throws on `getItem` when site data is
// blocked for the origin, and any browser throws `QuotaExceededError` on a full store.
// The logging page has to survive all of it, so every access below is wrapped and every
// failure degrades to "no draft" rather than to an exception.

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The stored draft, or null. `clientId` on the result is always usable. */
export function readDraft(): QsoDraft | null {
  const s = storage();
  if (!s) return null;

  let raw: string | null;
  try {
    raw = s.getItem(QSO_DRAFT_KEY);
  } catch {
    return null;
  }

  const draft = parseDraft(raw);
  if (!draft) {
    // A draft we cannot read is a draft that will never be read. Drop it so it stops
    // being handed to `parseDraft` on every mount for the life of the browser profile.
    if (raw !== null) clearDraft();
    return null;
  }

  // A draft written before this field existed, or one whose key did not survive
  // storage. Mint a fresh one rather than submitting without a key: no key means no
  // protection against the double tap this whole mechanism exists to stop.
  return draft.clientId ? draft : { ...draft, clientId: newClientId() };
}

/**
 * Persist a draft. Returns whether it actually landed.
 *
 * The return value is load-bearing and not decoration. `pages/qsos/new.tsx` tells the
 * operator their contact is safe, and it is only entitled to say that when this
 * returned true. A browser with site data blocked has to be told the truth — the
 * contact is held in the page and nowhere else — rather than reassured.
 */
export function writeDraft(values: QsoFormValues, clientId: string): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(QSO_DRAFT_KEY, serialiseDraft(values, clientId));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(QSO_DRAFT_KEY);
  } catch {
    // Nothing useful to do, and nothing depends on it having worked: a draft that
    // outlives its contact is caught on the next submit by the idempotency key.
  }
}

/**
 * What to say when the save never reached the server.
 *
 * `ApiError(0, ...)` is the sentinel for "the request did not arrive", and the message
 * behind it is `Failed to fetch` — true, useless, and it reads as data loss. The
 * operator's question is not what the browser called the failure, it is whether the
 * contact still exists. So the answer leads with that, and it is derived from what
 * `writeDraft` actually returned rather than assumed.
 */
export function draftFailureMessage(cause: string, kept: boolean): string {
  const head = `Not logged — the server was not reached (${cause}).`;
  return kept
    ? `${head} The contact is held on this device: it survives closing the tab, switching apps and locking the phone. Tap Retry when you have signal — logging it twice is safe, it cannot be duplicated.`
    : `${head} This browser is blocking site storage, so the contact is held only in this page — do not close it. Tap Retry when you have signal.`;
}

const QSL_STATUSES = ["NONE", "REQUESTED", "SENT", "CONFIRMED"] as const;

export interface QsoFormProps {
  values: QsoFormValues;
  onChange: (values: QsoFormValues) => void;
  stations: Station[];
  submitting: boolean;
  error: ApiError | null;
  onSubmit: () => void;
  submitLabel: string;
  /** Editing an existing QSO — enables the QSL/confirmation panel. */
  qsoId?: string;
  /**
   * Where the emailed card went, and when.
   *
   * Read-only, from the QslEmail row rather than the QSO: the flag says a card was
   * emailed, this says to whom — which is the question actually asked when a reply
   * or a bounce arrives.
   */
  emailedTo?: string | null;
  emailedAt?: string | null;
  secondaryAction?: React.ReactNode;
  /**
   * Rendered directly under the submit row.
   *
   * Exists for the network-failure notice and its Retry button. The banner this form
   * already renders sits at the TOP of twenty-one fields, and on a phone the operator
   * has scrolled well past it by the time they tap Log QSO — so the one place a failure
   * is certain to be seen is beside the button that just failed. The wording lives in
   * the page rather than here, because only the page knows whether the draft was
   * actually written.
   */
  submitFooter?: React.ReactNode;
  /**
   * VIEWER role: show the QSO but allow no edits. Cosmetic only — the API
   * rejects the mutation regardless.
   */
  readOnly?: boolean;
}

interface DxccLookup {
  status: "found" | "not-found" | "no-entity" | "no-data";
  reason?: string;
  match?: {
    adif: number;
    name: string;
    deleted: boolean;
    continent: string | null;
    cqZone: number | null;
  };
}

export function QsoForm({
  values,
  onChange,
  stations,
  submitting,
  error,
  onSubmit,
  submitLabel,
  qsoId,
  emailedTo,
  emailedAt,
  secondaryAction,
  submitFooter,
  readOnly = false,
}: QsoFormProps) {
  const [dupe, setDupe] = useState<DupeCheckResponse | null>(null);
  const [dxcc, setDxcc] = useState<DxccLookup | null>(null);

  const set = <K extends keyof QsoFormValues>(key: K, value: QsoFormValues[K]) =>
    onChange({ ...values, [key]: value });

  const station = stations.find((s) => s.id === values.stationId);
  const operators = station?.operators ?? [];

  // Band follows frequency: the frequency is the authoritative value, and a
  // band that disagrees with it is rejected by the API anyway.
  const derivedBand = useMemo(() => {
    const hz = parseFreqToHz(values.freqMHz);
    return hz === null ? null : freqToBand(hz);
  }, [values.freqMHz]);

  useEffect(() => {
    if (derivedBand && derivedBand !== values.band) {
      onChange({ ...values, band: derivedBand });
    }
    // Only react to a frequency change, not to every keystroke elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedBand]);

  const fieldErrors = (name: string) => error?.fieldErrors(name);

  async function checkDupe() {
    const call = values.callsign.trim().toUpperCase();
    if (!call || !values.band || !values.mode) {
      setDupe(null);
      return;
    }
    try {
      const params = new URLSearchParams({
        callsign: call,
        band: values.band,
        mode: values.mode,
      });
      if (qsoId) params.set("excludeId", qsoId);
      setDupe(await apiGet<DupeCheckResponse>(`/api/qsos/dupe-check?${params}`));
    } catch {
      // Advisory only — never block logging because the check failed.
      setDupe(null);
    }
  }

  /**
   * Resolve the DXCC entity for the entered callsign, as of the QSO date so a
   * backdated contact gets the entity that existed then.
   *
   * Only fills an EMPTY dxcc field — a value already there was either typed
   * deliberately or came from an import, and neither should be overwritten by a
   * prefix guess.
   */
  async function lookupDxcc() {
    const call = values.callsign.trim().toUpperCase();
    if (call.length < 3) {
      setDxcc(null);
      return;
    }
    try {
      const params = new URLSearchParams({ callsign: call });
      const when = fromUtcInputValue(values.startTime);
      if (when) params.set("at", when.toISOString());

      const result = await apiGet<DxccLookup>(`/api/dxcc/lookup?${params}`);
      setDxcc(result);

      // Fill each award field only when it's empty. cqZone and continent come
      // from the same lookup, and WAZ/WAC are unreachable without them.
      if (result.status === "found" && result.match) {
        const patch: Partial<QsoFormValues> = {};
        if (values.dxcc.trim() === "") patch.dxcc = String(result.match.adif);
        if (values.cqZone.trim() === "" && result.match.cqZone !== null) {
          patch.cqZone = String(result.match.cqZone);
        }
        if (values.continent.trim() === "" && result.match.continent) {
          patch.continent = result.match.continent;
        }
        if (Object.keys(patch).length > 0) onChange({ ...values, ...patch });
      }
    } catch {
      // Advisory, like the dupe check.
      setDxcc(null);
    }
  }

  async function onCallsignBlur() {
    await Promise.all([checkDupe(), lookupDxcc()]);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-5"
    >
      {error && !error.details && <ErrorBanner>{error.message}</ErrorBanner>}

      {/* `disabled` on a fieldset cascades to every control inside it, which is
          why this wraps the whole form rather than each input. */}
      <fieldset disabled={readOnly} className="contents">

      {/* ---- who / where ---- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label="Callsign"
          htmlFor="callsign"
          required
          errors={fieldErrors("callsign")}
        >
          <Input
            id="callsign"
            value={values.callsign}
            onChange={(e) => set("callsign", e.target.value.toUpperCase())}
            onBlur={() => void onCallsignBlur()}
            placeholder="W1AW"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-display text-lg tracking-wide"
            aria-invalid={Boolean(fieldErrors("callsign"))}
          />
        </Field>

        <Field
          label="Frequency (MHz)"
          htmlFor="freq"
          required
          errors={fieldErrors("freqHz")}
          hint={derivedBand ? `→ ${derivedBand}` : "e.g. 14.074"}
        >
          <Input
            id="freq"
            value={values.freqMHz}
            onChange={(e) => set("freqMHz", e.target.value)}
            placeholder="14.074"
            inputMode="decimal"
            className="tnum"
            aria-invalid={Boolean(fieldErrors("freqHz"))}
          />
        </Field>

        <Field label="Band" htmlFor="band" required errors={fieldErrors("band")}>
          <Select
            id="band"
            value={values.band}
            onChange={(e) => set("band", e.target.value)}
            aria-invalid={Boolean(fieldErrors("band"))}
          >
            <option value="">—</option>
            <optgroup label="Common">
              {COMMON_BANDS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </optgroup>
            <optgroup label="All bands">
              {BAND_NAMES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>

        <Field label="Mode" htmlFor="mode" required errors={fieldErrors("mode")}>
          <Select
            id="mode"
            value={values.mode}
            onChange={(e) => {
              const mode = e.target.value;
              // Re-default the reports, but never overwrite something typed.
              const wasDefault =
                values.rstSent === defaultRst(values.mode) &&
                values.rstRcvd === defaultRst(values.mode);
              onChange({
                ...values,
                mode,
                ...(wasDefault && {
                  rstSent: defaultRst(mode),
                  rstRcvd: defaultRst(mode),
                }),
              });
            }}
          >
            {LOGGABLE_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {dupe?.duplicate && dupe.previous && (
        <div className="flex items-center gap-2 text-sm border border-warn/40 bg-warn/10 text-warn px-3 py-2 rounded-sm">
          <Badge tone="warn">Dupe</Badge>
          <span>
            Already worked on {values.band} {values.mode} at{" "}
            {formatUtc(dupe.previous.startTime)} — logging anyway is fine.
          </span>
        </div>
      )}

      {/* ---- when / reports ---- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label="Start (UTC)"
          htmlFor="startTime"
          required
          errors={fieldErrors("startTime")}
        >
          <div className="flex gap-1.5">
            <Input
              id="startTime"
              type="datetime-local"
              value={values.startTime}
              onChange={(e) => set("startTime", e.target.value)}
              className="tnum"
              aria-invalid={Boolean(fieldErrors("startTime"))}
            />
            <Button onClick={() => set("startTime", utcNowInputValue())}>
              Now
            </Button>
          </div>
        </Field>

        <Field
          label="End (UTC)"
          htmlFor="endTime"
          errors={fieldErrors("endTime")}
          hint="Optional"
        >
          <Input
            id="endTime"
            type="datetime-local"
            value={values.endTime}
            onChange={(e) => set("endTime", e.target.value)}
            className="tnum"
            aria-invalid={Boolean(fieldErrors("endTime"))}
          />
        </Field>

        <Field label="RST sent" htmlFor="rstSent" errors={fieldErrors("rstSent")}>
          <Input
            id="rstSent"
            value={values.rstSent}
            onChange={(e) => set("rstSent", e.target.value)}
            className="tnum"
          />
        </Field>

        <Field label="RST rcvd" htmlFor="rstRcvd" errors={fieldErrors("rstRcvd")}>
          <Input
            id="rstRcvd"
            value={values.rstRcvd}
            onChange={(e) => set("rstRcvd", e.target.value)}
            className="tnum"
          />
        </Field>
      </div>

      {/* ---- location / attribution ---- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          label="Name"
          htmlFor="name"
          errors={fieldErrors("name")}
          hint="Their name — what a QSL card opens with"
        >
          <Input
            id="name"
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Matt"
            autoComplete="off"
            aria-invalid={Boolean(fieldErrors("name"))}
          />
        </Field>

        <Field
          label="QTH"
          htmlFor="qth"
          errors={fieldErrors("qth")}
          hint="Where they said they were, in their words"
        >
          <Input
            id="qth"
            value={values.qth}
            onChange={(e) => set("qth", e.target.value)}
            placeholder="Porter County, Indiana"
            autoComplete="off"
            aria-invalid={Boolean(fieldErrors("qth"))}
          />
        </Field>

        <Field
          label="Grid square"
          htmlFor="grid"
          errors={fieldErrors("gridSquare")}
          hint="Maidenhead, e.g. EN61"
        >
          <Input
            id="grid"
            value={values.gridSquare}
            onChange={(e) => set("gridSquare", e.target.value.toUpperCase())}
            className="tnum"
            spellCheck={false}
            aria-invalid={Boolean(fieldErrors("gridSquare"))}
          />
        </Field>

        <Field
          label="DXCC"
          htmlFor="dxcc"
          errors={fieldErrors("dxcc")}
          hint={
            dxcc?.status === "found" && dxcc.match
              ? `${dxcc.match.name}${dxcc.match.continent ? ` · ${dxcc.match.continent}` : ""}${dxcc.match.deleted ? " · deleted entity" : ""}`
              : dxcc?.status === "no-data"
                ? "No DXCC data loaded — an admin can load cty.xml on the DXCC page"
                : dxcc?.status === "no-entity"
                  ? "Maritime/aeronautical mobile — no entity applies"
                  : dxcc?.status === "not-found"
                    ? "No entity matches this callsign"
                    : "Entity code — resolved from the callsign"
          }
        >
          <Input
            id="dxcc"
            value={values.dxcc}
            onChange={(e) => set("dxcc", e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            className="tnum"
            aria-invalid={Boolean(fieldErrors("dxcc"))}
          />
        </Field>

        <Field
          label="State"
          htmlFor="state"
          errors={fieldErrors("state")}
          hint="ADIF STATE — needed for WAS"
        >
          <Input
            id="state"
            value={values.state}
            onChange={(e) => set("state", e.target.value.toUpperCase())}
            placeholder="IN"
            spellCheck={false}
            className="tnum"
            aria-invalid={Boolean(fieldErrors("state"))}
          />
        </Field>

        <Field
          label="CQ zone"
          htmlFor="cqZone"
          errors={fieldErrors("cqZone")}
          hint="Needed for WAZ"
        >
          <Input
            id="cqZone"
            value={values.cqZone}
            onChange={(e) => set("cqZone", e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            className="tnum"
            aria-invalid={Boolean(fieldErrors("cqZone"))}
          />
        </Field>

        <Field
          label="Continent"
          htmlFor="continent"
          errors={fieldErrors("continent")}
          hint="Needed for WAC"
        >
          <Select
            id="continent"
            value={values.continent}
            onChange={(e) => set("continent", e.target.value)}
          >
            <option value="">—</option>
            {["NA", "SA", "EU", "AF", "AS", "OC", "AN"].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="IOTA"
          htmlFor="iota"
          errors={fieldErrors("iota")}
          hint="e.g. NA-001"
        >
          <Input
            id="iota"
            value={values.iota}
            onChange={(e) => set("iota", e.target.value.toUpperCase())}
            placeholder="NA-001"
            spellCheck={false}
            className="tnum"
            aria-invalid={Boolean(fieldErrors("iota"))}
          />
        </Field>

        <Field
          label="Activity (SIG)"
          htmlFor="sig"
          errors={fieldErrors("sig")}
          hint="POTA, SOTA, WWFF…"
        >
          <Input
            id="sig"
            value={values.sig}
            onChange={(e) => set("sig", e.target.value.toUpperCase())}
            placeholder="POTA"
            spellCheck={false}
            aria-invalid={Boolean(fieldErrors("sig"))}
          />
        </Field>

        <Field
          label="References (SIG_INFO)"
          htmlFor="sigInfo"
          errors={fieldErrors("sigInfo")}
          hint="Park, summit or reserve. Several are allowed — a contact can be two parks at once. Comma-separated; the first is the one ADIF exports."
        >
          <Input
            id="sigInfo"
            value={values.sigInfo}
            onChange={(e) => set("sigInfo", e.target.value.toUpperCase())}
            placeholder="US-0765, US-2258"
            spellCheck={false}
            className="tnum"
            aria-invalid={Boolean(fieldErrors("sigInfo"))}
          />
        </Field>

        <Field
          label="My station"
          htmlFor="stationId"
          required
          errors={fieldErrors("stationId")}
        >
          <Select
            id="stationId"
            value={values.stationId}
            onChange={(e) =>
              // Changing station invalidates the selected operator.
              onChange({ ...values, stationId: e.target.value, operatorId: "" })
            }
            aria-invalid={Boolean(fieldErrors("stationId"))}
          >
            <option value="">—</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.callsign} ({s.grid})
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Operator"
          htmlFor="operatorId"
          errors={fieldErrors("operatorId")}
          hint={
            values.stationId && operators.length === 0
              ? "No operators on this station yet"
              : "Optional"
          }
        >
          <Select
            id="operatorId"
            value={values.operatorId}
            onChange={(e) => set("operatorId", e.target.value)}
            disabled={!values.stationId || operators.length === 0}
          >
            <option value="">—</option>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.callsign} — {o.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {/* ---- QSL state: only meaningful once the QSO exists ---- */}
      {qsoId && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 border-t border-line pt-4">
          <Field label="QSL sent" htmlFor="qslSent">
            <Select
              id="qslSent"
              value={values.qslSent}
              onChange={(e) => set("qslSent", e.target.value)}
            >
              {QSL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="QSL received" htmlFor="qslRcvd">
            <Select
              id="qslRcvd"
              value={values.qslRcvd}
              onChange={(e) => set("qslRcvd", e.target.value)}
            >
              {QSL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="LoTW" htmlFor="lotwSent">
            <div className="flex items-center gap-4 h-[34px]">
              <Checkbox
                id="lotwSent"
                label="Sent"
                checked={values.lotwSent}
                onChange={(v) => set("lotwSent", v)}
              />
              <Checkbox
                id="lotwRcvd"
                label="Rcvd"
                checked={values.lotwRcvd}
                onChange={(v) => set("lotwRcvd", v)}
              />
            </div>
          </Field>

          {/* QRZ sits with LoTW and eQSL because the operator thinks of them as one
              question — who has this contact and who confirmed it. It was missing
              entirely, so nothing in the log recorded that QRZ already had a contact and
              every upload run offered the whole log again. */}
          <Field label="QRZ" htmlFor="qrzSent">
            <div className="flex items-center gap-4 h-[34px]">
              <Checkbox
                id="qrzSent"
                label="Sent"
                checked={values.qrzSent}
                onChange={(v) => set("qrzSent", v)}
              />
              <Checkbox
                id="qrzRcvd"
                label="Rcvd"
                checked={values.qrzRcvd}
                onChange={(v) => set("qrzRcvd", v)}
              />
            </div>
          </Field>

          <Field label="eQSL" htmlFor="eqslSent">
            <div className="flex items-center gap-4 h-[34px]">
              <Checkbox
                id="eqslSent"
                label="Sent"
                checked={values.eqslSent}
                onChange={(v) => set("eqslSent", v)}
              />
              <Checkbox
                id="eqslRcvd"
                label="Rcvd"
                checked={values.eqslRcvd}
                onChange={(v) => set("eqslRcvd", v)}
              />
            </div>
          </Field>

          {/* Emailed card image — deliberately its own field, not part of "QSL
              sent". Someone who mails you a card and wants one back still needs a
              card, and folding the two together hides that. */}
          <Field
            label="Emailed card"
            htmlFor="emailQslSent"
            hint={
              emailedTo
                ? `Sent to ${emailedTo}${emailedAt ? ` on ${emailedAt}` : ""}`
                : "A card image emailed to them. Not a paper QSL."
            }
          >
            <div className="flex items-center gap-4 min-h-[34px] flex-wrap">
              <Checkbox
                id="emailQslSent"
                label="Sent"
                checked={values.emailQslSent}
                onChange={(v) => set("emailQslSent", v)}
              />
              {/* Next to the checkbox that records the send, which is where somebody
                  looking at "already emailed" and wanting it emailed again will look. */}
              {qsoId ? (
                <ResendQslButton qsoId={qsoId} callsign={values.callsign} variant="button" />
              ) : null}
            </div>
          </Field>
        </div>
      )}

      <Field label="Notes" htmlFor="notes" errors={fieldErrors("notes")}>
        <Textarea
          id="notes"
          value={values.notes}
          onChange={(e) => set("notes", e.target.value)}
          rows={3}
        />
      </Field>

      </fieldset>

      {readOnly ? (
        <p className="text-sm text-fg-subtle">
          Your account is read-only. Ask an admin for the OPERATOR role to log or
          edit contacts.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? "Saving…" : submitLabel}
            </Button>
            {secondaryAction}
          </div>
          {submitFooter}
        </div>
      )}
    </form>
  );
}

function Checkbox({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-1.5 text-sm text-fg-muted">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent size-3.5"
      />
      {label}
    </label>
  );
}
