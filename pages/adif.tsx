import { useRef, useState } from "react";
import { ToolTabs } from "@/components/settings/ToolTabs";

import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { BAND_NAMES } from "@/lib/ham/bands";
import { LOGGABLE_MODES } from "@/lib/ham/modes";
import type { ListResponse, Station } from "@/lib/types";

interface ImportReport {
  dryRun: boolean;
  dedupe: boolean;
  station: { id: string; callsign: string };
  parsed: number;
  valid: number;
  duplicatesInFile: number;
  alreadyInLog: number;
  imported: number;
  pending: number;
  rejected: number;
  problems: { record: number; callsign?: string; message: string }[];
  problemsTruncated: number;
  frequencyInferred: number;
  otherStationCallsigns: string[];
  unmatchedOperators: string[];
}

interface QrzMarkCounts {
  records: number;
  matched: number;
  newlySent: number;
  newlyConfirmed: number;
  idChanged: number;
  unmatched: number;
  highestLogId: number | null;
}

interface QrzImportReport {
  dryRun: boolean;
  pages: number;
  fetched: number;
  imported: number;
  pending: number;
  alreadyInLog: number;
  rejected: number;
  frequencyInferred: number;
  lastLogId: number | null;
  startedAfterLogId: number;
  cursorNow: number | null;
  marked: QrzMarkCounts;
  stoppedBecause: "complete" | "page-limit" | "error";
  error?: string;
  problems: { record: number; callsign?: string; message: string }[];
}

export default function AdifPage() {
  const canImport = useCan("OPERATOR");
  const { data: stationsData } = useApi<ListResponse<Station>>("/api/stations");
  const stations = stationsData?.rows ?? [];

  return (
    <>
      <ToolTabs />
      <PageHeader
        title="ADIF"
        subtitle="Import and export ADIF 3.x logbook files"
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <ExportCard stations={stations} />
        {canImport ? (
          <ImportCard stations={stations} />
        ) : (
          <Card title="Import">
            <p className="text-sm text-fg-subtle">
              Your account is read-only. Ask an admin for the OPERATOR role to
              import contacts.
            </p>
          </Card>
        )}
        {canImport && <QrzSyncCard stations={stations} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * Pull from QRZ's logbook, and mark what it already has.
 *
 * There was no way to reach this from the app at all - the endpoint existed and only curl
 * ever called it. The download is differential: it resumes from the highest QRZ record id
 * already seen, so an ordinary sync fetches the handful of new records rather than the
 * whole logbook, which is what every run used to do.
 *
 * The marking is the half that matters for uploads. A contact QRZ already has gets
 * `qrzSent` set, so the upload sweep stops offering it - before this, the only thing that
 * stopped a duplicate was QRZ rejecting it on arrival.
 */
function QrzSyncCard({ stations }: { stations: Station[] }) {
  const [stationId, setStationId] = useState("");
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<QrzImportReport | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function run(dryRun: boolean) {
    if (!stationId) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ stationId, maxPages: "5" });
      params.set("dryRun", dryRun ? "1" : "0");
      // Only sent when asked for. Omitting it is what makes the fetch differential;
      // sending 0 is an explicit "read the whole logbook again".
      if (full) params.set("afterLogId", "0");

      const res = await fetch(`/api/integrations/qrz-import?${params}`, { method: "POST" });
      const body = (await res.json()) as QrzImportReport & {
        error?: string;
        details?: Record<string, string[]>;
      };
      if (!res.ok) {
        throw new ApiError(res.status, body.error ?? "QRZ sync failed", body.details);
      }
      setReport(body);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "QRZ sync failed"));
    } finally {
      setBusy(false);
    }
  }

  const m = report?.marked;

  return (
    <Card title="Sync from QRZ">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">
          Reads QRZ Logbook and brings back anything missing. Contacts QRZ already has are
          marked, so they stop being offered for upload &mdash; and QRZ&apos;s own
          confirmations are recorded against them.
        </p>

        <Field label="Station" htmlFor="qrzStation">
          <Select
            id="qrzStation"
            value={stationId}
            onChange={(e) => setStationId(e.target.value)}
          >
            <option value="">Choose a station&hellip;</option>
            {stations.map((st) => (
              <option key={st.id} value={st.id}>
                {st.callsign}
              </option>
            ))}
          </Select>
        </Field>

        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input
            type="checkbox"
            checked={full}
            onChange={(e) => setFull(e.target.checked)}
            className="accent-accent"
          />
          Read the whole logbook again, from the beginning
        </label>

        <div className="flex gap-2">
          <Button onClick={() => run(true)} disabled={busy || !stationId}>
            {busy ? "Working…" : "Preview"}
          </Button>
          <Button
            variant="primary"
            onClick={() => run(false)}
            disabled={busy || !stationId}
          >
            Sync
          </Button>
        </div>

        {error && <ErrorBanner>{error.message}</ErrorBanner>}

        {report && (
          <div className="border border-line rounded-sm p-3 flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
              {report.dryRun ? (
                <Badge tone="info">Preview</Badge>
              ) : (
                <Badge tone="ok">Synced</Badge>
              )}
              <span className="text-fg-muted">
                {report.fetched.toLocaleString()} record(s) from QRZ
                {report.startedAfterLogId > 0
                  ? `, after id ${report.startedAfterLogId.toLocaleString()}`
                  : ", from the beginning"}
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <Line
                label={report.dryRun ? "Would import" : "Imported"}
                value={report.dryRun ? report.pending : report.imported}
                tone={report.dryRun ? undefined : "ok"}
              />
              {m && m.newlySent > 0 && (
                <Line label="Marked as in QRZ" value={m.newlySent} tone="ok" />
              )}
              {m && m.newlyConfirmed > 0 && (
                <Line label="Newly confirmed" value={m.newlyConfirmed} tone="ok" />
              )}
              {report.alreadyInLog > 0 && (
                <Line label="Already in log" value={report.alreadyInLog} />
              )}
              {report.rejected > 0 && (
                <Line label="Rejected" value={report.rejected} tone="danger" />
              )}
            </dl>

            {report.stoppedBecause === "page-limit" && (
              <p className="text-xs text-warn">
                Stopped at the page limit with more to fetch. Run it again &mdash; it
                resumes where this left off.
              </p>
            )}
            {report.cursorNow !== null && report.cursorNow > 0 && (
              <p className="text-xs text-fg-subtle">
                Next sync resumes after QRZ record {report.cursorNow.toLocaleString()}.
              </p>
            )}
            {report.dryRun && (
              <p className="text-xs text-fg-subtle">
                A preview changes nothing &mdash; no contacts imported, and nothing marked.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ExportCard({ stations }: { stations: Station[] }) {
  const [stationId, setStationId] = useState("");
  const [band, setBand] = useState("");
  const [mode, setMode] = useState("");
  const [confirmed, setConfirmed] = useState("any");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const params = new URLSearchParams({ confirmed });
  if (stationId) params.set("stationId", stationId);
  if (band) params.set("band", band);
  if (mode) params.set("mode", mode);
  // Dates are UTC day boundaries — the log is kept in UTC throughout.
  if (from) params.set("from", `${from}T00:00:00.000Z`);
  if (to) params.set("to", `${to}T23:59:59.999Z`);

  return (
    <Card title="Export">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">
          Downloads an <code>.adi</code> file. Leave the filters empty to export
          the whole log.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Station" htmlFor="ex-station">
            <Select
              id="ex-station"
              value={stationId}
              onChange={(e) => setStationId(e.target.value)}
            >
              <option value="">All stations</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.callsign}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Confirmed" htmlFor="ex-cfm">
            <Select
              id="ex-cfm"
              value={confirmed}
              onChange={(e) => setConfirmed(e.target.value)}
            >
              <option value="any">Any</option>
              <option value="yes">Confirmed only</option>
              <option value="no">Unconfirmed only</option>
            </Select>
          </Field>

          <Field label="Band" htmlFor="ex-band">
            <Select
              id="ex-band"
              value={band}
              onChange={(e) => setBand(e.target.value)}
            >
              <option value="">All bands</option>
              {BAND_NAMES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Mode" htmlFor="ex-mode">
            <Select
              id="ex-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="">All modes</option>
              {LOGGABLE_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="From (UTC date)" htmlFor="ex-from">
            <Input
              id="ex-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="tnum"
            />
          </Field>

          <Field label="To (UTC date)" htmlFor="ex-to">
            <Input
              id="ex-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="tnum"
            />
          </Field>
        </div>

        {/* Plain links, not fetch — lets the browser handle the download and
            the streaming response without buffering it in JS. */}
        <a href={`/api/adif/export?${params}`} download>
          <Button variant="primary" className="w-full">
            Download ADIF
          </Button>
        </a>

        {/* CSV alongside it, from the SAME filters. ADIF is the interchange format every
            logger reads; CSV is what someone opens in a spreadsheet to sort and count by
            hand. Different jobs, so it is a second button rather than a format dropdown
            that would make one of them feel like an option nobody picks. */}
        <a href={`/api/adif/csv?${params}`} download>
          <Button className="w-full">Download CSV</Button>
        </a>
        <p className="text-xs text-fg-subtle">
          CSV is for spreadsheets — a flat table of the columns a person sorts and filters by,
          not every ADIF field. Use ADIF to move the log into another logger.
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function ImportCard({ stations }: { stations: Station[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [stationId, setStationId] = useState("");
  const [operatorId, setOperatorId] = useState("");
  const [dedupe, setDedupe] = useState(true);
  const [text, setText] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [result, setResult] = useState<ImportReport | null>(null);

  const station = stations.find((s) => s.id === stationId);
  const operators = station?.operators ?? [];

  function reset() {
    setPreview(null);
    setResult(null);
    setError(null);
  }

  async function send(dryRun: boolean) {
    if (!text || !stationId) return;
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ stationId });
      if (operatorId) params.set("operatorId", operatorId);
      if (!dedupe) params.set("dedupe", "0");
      if (dryRun) params.set("dryRun", "1");

      // Raw text body rather than JSON or multipart — see the API route.
      const res = await fetch(`/api/adif/import?${params}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: text,
      });
      const body = (await res.json()) as ImportReport & {
        error?: string;
        details?: Record<string, string[]>;
      };
      if (!res.ok) {
        throw new ApiError(res.status, body.error ?? "Import failed", body.details);
      }

      if (dryRun) {
        setPreview(body);
        setResult(null);
      } else {
        setResult(body);
        setPreview(null);
        setText(null);
        setFilename("");
        if (fileRef.current) fileRef.current.value = "";
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err : new ApiError(0, "Import failed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Import">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">
          Every import is previewed before anything is written.
        </p>

        {error && <ErrorBanner>{error.message}</ErrorBanner>}

        <Field label="ADIF file" htmlFor="im-file" required>
          <input
            ref={fileRef}
            id="im-file"
            type="file"
            accept=".adi,.adif,text/plain"
            onChange={async (e) => {
              reset();
              const file = e.target.files?.[0];
              if (!file) {
                setText(null);
                setFilename("");
                return;
              }
              setFilename(`${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
              setText(await file.text());
            }}
            className="w-full text-sm text-fg-muted file:mr-3 file:border file:border-line-strong file:bg-surface-2 file:text-fg file:px-3 file:py-1.5 file:rounded-sm file:text-sm hover:file:bg-surface-3"
          />
        </Field>

        {filename && <p className="text-xs text-fg-subtle tnum">{filename}</p>}

        <Field
          label="Attribute to station"
          htmlFor="im-station"
          required
          hint="Imported QSOs are logged under this station"
        >
          <Select
            id="im-station"
            value={stationId}
            onChange={(e) => {
              setStationId(e.target.value);
              setOperatorId("");
              reset();
            }}
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
          label="Fallback operator"
          htmlFor="im-op"
          hint="Used only where the file's OPERATOR field matches nobody"
        >
          <Select
            id="im-op"
            value={operatorId}
            onChange={(e) => setOperatorId(e.target.value)}
            disabled={!stationId || operators.length === 0}
          >
            <option value="">None</option>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.callsign} — {o.name}
              </option>
            ))}
          </Select>
        </Field>

        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input
            type="checkbox"
            checked={dedupe}
            onChange={(e) => {
              setDedupe(e.target.checked);
              reset();
            }}
            className="accent-accent size-3.5"
          />
          Skip QSOs already in the log
        </label>

        <div className="flex gap-2">
          <Button
            variant={preview ? "secondary" : "primary"}
            disabled={busy || !text || !stationId}
            onClick={() => void send(true)}
          >
            {busy && !preview ? "Checking…" : "Preview"}
          </Button>
          {preview && preview.pending > 0 && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void send(false)}
            >
              {busy
                ? "Importing…"
                : `Import ${preview.pending.toLocaleString()} QSO${preview.pending === 1 ? "" : "s"}`}
            </Button>
          )}
        </div>

        {preview && <Report report={preview} />}
        {result && <Report report={result} />}
      </div>
    </Card>
  );
}

function Report({ report }: { report: ImportReport }) {
  const done = !report.dryRun;

  return (
    <div className="border border-line rounded-sm p-3 flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2">
        {done ? (
          <Badge tone="ok">Imported</Badge>
        ) : (
          <Badge tone="info">Preview</Badge>
        )}
        <span className="text-fg-muted">
          {report.parsed.toLocaleString()} records read from the file
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        <Line
          label={done ? "Imported" : "Ready to import"}
          value={done ? report.imported : report.pending}
          tone={done ? "ok" : undefined}
        />
        {report.alreadyInLog > 0 && (
          <Line label="Already in log" value={report.alreadyInLog} />
        )}
        {report.duplicatesInFile > 0 && (
          <Line label="Duplicated in file" value={report.duplicatesInFile} />
        )}
        {report.rejected > 0 && (
          <Line label="Rejected" value={report.rejected} tone="danger" />
        )}
        {report.frequencyInferred > 0 && (
          <Line
            label="Frequency inferred"
            value={report.frequencyInferred}
            tone="warn"
          />
        )}
      </dl>

      {report.frequencyInferred > 0 && (
        <p className="text-xs text-warn">
          {report.frequencyInferred} record(s) had no FREQ field. The band&apos;s
          lower edge was used, so those frequencies are approximate.
        </p>
      )}

      {report.otherStationCallsigns.length > 0 && (
        <p className="text-xs text-fg-subtle">
          File also contains STATION_CALLSIGN{" "}
          <span className="font-display tracking-wide">
            {report.otherStationCallsigns.join(", ")}
          </span>
          , which differ from {report.station.callsign}. They will still be
          attributed to {report.station.callsign}.
        </p>
      )}

      {report.unmatchedOperators.length > 0 && (
        <p className="text-xs text-fg-subtle">
          No operator at this station matches{" "}
          <span className="font-display tracking-wide">
            {report.unmatchedOperators.join(", ")}
          </span>
          .
        </p>
      )}

      {report.problems.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-danger">
            {report.problems.length} problem record(s)
            {report.problemsTruncated > 0 &&
              ` — ${report.problemsTruncated} more not shown`}
          </summary>
          <ul className="mt-1.5 flex flex-col gap-0.5 max-h-56 overflow-y-auto">
            {report.problems.map((p, i) => (
              <li key={i} className="text-fg-subtle">
                <span className="tnum">#{p.record}</span>{" "}
                {p.callsign && (
                  <span className="font-display tracking-wide">{p.callsign}</span>
                )}{" "}
                — {p.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Line({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "ok" | "warn" | "danger";
}) {
  const color =
    tone === "ok"
      ? "text-ok"
      : tone === "warn"
        ? "text-warn"
        : tone === "danger"
          ? "text-danger"
          : "text-fg";
  return (
    <>
      <dt className="text-fg-subtle">{label}</dt>
      <dd className={`tnum text-right ${color}`}>{value.toLocaleString()}</dd>
    </>
  );
}

export const getServerSideProps = withPageAuth();
