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
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "Saving…" : submitLabel}
          </Button>
          {secondaryAction}
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
