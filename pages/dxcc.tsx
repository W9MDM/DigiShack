import Link from "next/link";
import { ToolTabs } from "@/components/settings/ToolTabs";
import { useRef, useState } from "react";

import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiGet, apiPost, useApi } from "@/lib/client/api";
import { formatUtc } from "@/lib/time";

interface DxccStatus {
  loaded: boolean;
  entityCount: number;
  prefixCount: number;
  exceptionCount: number;
  fileDate: string | null;
  importedAt: string | null;
  source: string | null;
  canFetch: boolean;
}

interface ImportReport {
  entities: number;
  prefixes: number;
  exceptions: number;
  orphaned: number;
  fileDate: string | null;
  problems: string[];
  source: string;
}

interface LookupResult {
  callsign: string;
  status: "found" | "not-found" | "no-entity" | "no-data";
  reason?: string;
  match?: {
    adif: number;
    name: string;
    prefix: string;
    deleted: boolean;
    cqZone: number | null;
    continent: string | null;
    matchedOn: string;
    source: "exception" | "prefix";
  };
}

interface BackfillReport {
  dryRun: boolean;
  candidates: number;
  examined: number;
  resolved: number;
  unchanged: number;
  unresolved: number;
  distinctCallsignsResolved: number;
  samples: { callsign: string; adif: number; name: string }[];
  unresolvedCallsigns: string[];
}

export default function DxccPage() {
  const { data: status, error, reload } = useApi<DxccStatus>("/api/dxcc");

  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [backfill, setBackfill] = useState<BackfillReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function fail(err: unknown) {
    setActionError(
      err instanceof ApiError ? err : new ApiError(0, "Request failed"),
    );
  }

  async function doFetch() {
    setBusy("fetch");
    setActionError(null);
    setReport(null);
    try {
      const res = await apiPost<{ report: ImportReport }>("/api/dxcc?fetch=1", {});
      setReport(res.report);
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function doUpload(file: File) {
    setBusy("upload");
    setActionError(null);
    setReport(null);
    try {
      // Sent as a raw body — gzip is detected server-side, so cty.xml.gz works
      // without unpacking it first.
      const res = await fetch("/api/dxcc", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: await file.arrayBuffer(),
      });
      const body = await res.json();
      if (!res.ok) throw new ApiError(res.status, body.error ?? "Import failed");
      setReport(body.report);
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function doBackfill(dryRun: boolean) {
    setBusy(dryRun ? "preview" : "backfill");
    setActionError(null);
    try {
      setBackfill(
        await apiPost<BackfillReport>(
          `/api/dxcc/backfill?dryRun=${dryRun ? 1 : 0}`,
          {},
        ),
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <ToolTabs />
      <PageHeader
        title="DXCC"
        subtitle="Callsign-to-entity reference data from Club Log"
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {actionError && (
        <div className="mb-4">
          <ErrorBanner>{actionError.message}</ErrorBanner>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Status"
          actions={
            status?.loaded ? (
              <Badge tone="ok">Loaded</Badge>
            ) : (
              <Badge tone="warn">No data</Badge>
            )
          }
        >
          {status && (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-fg-subtle">Entities</dt>
                <dd className="tnum text-right">
                  {status.entityCount.toLocaleString()}
                </dd>
                <dt className="text-fg-subtle">Prefixes</dt>
                <dd className="tnum text-right">
                  {status.prefixCount.toLocaleString()}
                </dd>
                <dt className="text-fg-subtle">Callsign exceptions</dt>
                <dd className="tnum text-right">
                  {status.exceptionCount.toLocaleString()}
                </dd>
                <dt className="text-fg-subtle">File date</dt>
                <dd className="tnum text-right">
                  {status.fileDate ? formatUtc(status.fileDate) : "—"}
                </dd>
                <dt className="text-fg-subtle">Imported</dt>
                <dd className="tnum text-right">
                  {status.importedAt ? formatUtc(status.importedAt) : "—"}
                </dd>
                <dt className="text-fg-subtle">Source</dt>
                <dd className="text-right">{status.source ?? "—"}</dd>
              </dl>

              {!status.loaded && (
                <p className="text-sm text-fg-muted mt-4">
                  Until this is loaded, DXCC stays a field you type by hand and
                  award tracking has nothing to count.
                </p>
              )}
            </>
          )}
        </Card>

        <Card title="Load data">
          <div className="flex flex-col gap-4">
            <p className="text-sm text-fg-muted">
              cty.xml is maintained by Club Log and changes regularly, so it is
              not bundled with DigiShack. Refresh it every month or two.
            </p>

            <div>
              <Button
                variant="primary"
                disabled={busy !== null || !status?.canFetch}
                onClick={() => void doFetch()}
                title={
                  status?.canFetch
                    ? undefined
                    : "Add a Club Log cty API key under Settings first"
                }
              >
                {busy === "fetch" ? "Downloading…" : "Fetch from Club Log"}
              </Button>
              {!status?.canFetch && (
                <p className="text-xs text-fg-subtle mt-1.5">
                  Needs a cty API key —{" "}
                  <Link href="/settings" className="text-accent-bright underline">
                    Settings → DXCC reference data
                  </Link>
                  . Club Log issues one on request.
                </p>
              )}
            </div>

            <Field
              label="Or upload cty.xml"
              htmlFor="cty-file"
              hint="Accepts cty.xml or cty.xml.gz — for a shack with no outbound internet"
            >
              <input
                ref={fileRef}
                id="cty-file"
                type="file"
                accept=".xml,.gz,application/gzip,text/xml"
                disabled={busy !== null}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void doUpload(f);
                }}
                className="w-full text-sm text-fg-muted file:mr-3 file:border file:border-line-strong file:bg-surface-2 file:text-fg file:px-3 file:py-1.5 file:rounded-sm file:text-sm hover:file:bg-surface-3"
              />
            </Field>

            {busy === "upload" && (
              <p className="text-sm text-fg-subtle">Parsing and importing…</p>
            )}

            {report && (
              <div className="border border-ok/40 bg-ok/10 rounded-sm p-3 text-sm">
                <p className="text-ok font-medium mb-1">Imported</p>
                <dl className="grid grid-cols-2 gap-x-4">
                  <dt className="text-fg-muted">Entities</dt>
                  <dd className="tnum text-right">{report.entities}</dd>
                  <dt className="text-fg-muted">Prefixes</dt>
                  <dd className="tnum text-right">{report.prefixes}</dd>
                  <dt className="text-fg-muted">Exceptions</dt>
                  <dd className="tnum text-right">{report.exceptions}</dd>
                  {report.orphaned > 0 && (
                    <>
                      <dt className="text-warn">Orphaned records</dt>
                      <dd className="tnum text-right text-warn">
                        {report.orphaned}
                      </dd>
                    </>
                  )}
                </dl>
                {report.problems.length > 0 && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-warn">
                      {report.problems.length} parser note(s)
                    </summary>
                    <ul className="mt-1 text-fg-subtle">
                      {report.problems.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        </Card>

        <LookupCard disabled={!status?.loaded} />

        <Card title="Backfill existing QSOs">
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-muted">
              Fills DXCC on contacts that lack it, resolving each against the
              entity valid on the QSO&apos;s own date. Contacts that already have a
              code are left alone — a value from LoTW or typed by an operator beats
              a prefix guess.
            </p>

            <div className="flex gap-2">
              <Button
                disabled={busy !== null || !status?.loaded}
                onClick={() => void doBackfill(true)}
              >
                {busy === "preview" ? "Checking…" : "Preview"}
              </Button>
              {backfill?.dryRun && backfill.resolved > 0 && (
                <Button
                  variant="primary"
                  disabled={busy !== null}
                  onClick={() => void doBackfill(false)}
                >
                  {busy === "backfill"
                    ? "Updating…"
                    : `Update ${backfill.resolved.toLocaleString()} QSOs`}
                </Button>
              )}
            </div>

            {backfill && (
              <div className="border border-line rounded-sm p-3 text-sm">
                <div className="flex items-center gap-2 mb-1">
                  {backfill.dryRun ? (
                    <Badge tone="info">Preview</Badge>
                  ) : (
                    <Badge tone="ok">Updated</Badge>
                  )}
                  <span className="text-fg-muted">
                    {backfill.examined.toLocaleString()} of{" "}
                    {backfill.candidates.toLocaleString()} examined
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-x-4">
                  <dt className="text-fg-subtle">
                    {backfill.dryRun ? "Would set" : "Set"}
                  </dt>
                  <dd className="tnum text-right text-ok">{backfill.resolved}</dd>
                  <dt className="text-fg-subtle">Unresolved</dt>
                  <dd className="tnum text-right text-warn">
                    {backfill.unresolved}
                  </dd>
                </dl>

                {backfill.samples.length > 0 && (
                  <ul className="mt-2 text-xs text-fg-subtle flex flex-col gap-0.5">
                    {backfill.samples.map((s) => (
                      <li key={s.callsign}>
                        <span className="font-display tracking-wide text-fg">
                          {s.callsign}
                        </span>{" "}
                        → {s.adif} {s.name}
                      </li>
                    ))}
                  </ul>
                )}

                {backfill.unresolvedCallsigns.length > 0 && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-warn">
                      Unresolved callsigns
                    </summary>
                    <p className="mt-1 text-fg-subtle font-mono">
                      {backfill.unresolvedCallsigns.join(", ")}
                    </p>
                  </details>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

function LookupCard({ disabled }: { disabled: boolean }) {
  const [call, setCall] = useState("");
  const [at, setAt] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function go() {
    if (!call.trim()) return;
    setBusy(true);
    try {
      const params = new URLSearchParams({ callsign: call.trim() });
      if (at) params.set("at", `${at}T12:00:00.000Z`);
      setResult(await apiGet<LookupResult>(`/api/dxcc/lookup?${params}`));
    } catch {
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Test a callsign">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Callsign" htmlFor="lk-call">
            <Input
              id="lk-call"
              value={call}
              onChange={(e) => setCall(e.target.value.toUpperCase())}
              placeholder="VP2E/K9XYZ"
              spellCheck={false}
              className="font-display tracking-wide"
              disabled={disabled}
            />
          </Field>
          <Field
            label="As of (UTC date)"
            htmlFor="lk-at"
            hint="Optional — for deleted entities"
          >
            <Input
              id="lk-at"
              type="date"
              value={at}
              onChange={(e) => setAt(e.target.value)}
              className="tnum"
              disabled={disabled}
            />
          </Field>
        </div>

        <Button type="submit" disabled={disabled || busy}>
          {busy ? "Looking up…" : "Look up"}
        </Button>

        {disabled && (
          <p className="text-xs text-fg-subtle">Load cty.xml first.</p>
        )}

        {result && (
          <div className="border border-line rounded-sm p-3 text-sm">
            {result.status === "found" && result.match ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-display text-lg tracking-wide">
                    {result.match.name}
                  </span>
                  <Badge tone="accent">DXCC {result.match.adif}</Badge>
                  {result.match.deleted && <Badge tone="warn">Deleted</Badge>}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 mt-2 text-xs">
                  <dt className="text-fg-subtle">Primary prefix</dt>
                  <dd className="text-right tnum">{result.match.prefix}</dd>
                  <dt className="text-fg-subtle">Continent</dt>
                  <dd className="text-right">{result.match.continent ?? "—"}</dd>
                  <dt className="text-fg-subtle">CQ zone</dt>
                  <dd className="text-right tnum">
                    {result.match.cqZone ?? "—"}
                  </dd>
                  <dt className="text-fg-subtle">Matched</dt>
                  <dd className="text-right">
                    {result.match.matchedOn}{" "}
                    <span className="text-fg-subtle">
                      ({result.match.source})
                    </span>
                  </dd>
                </dl>
              </>
            ) : (
              <p className="text-warn">{result.reason ?? result.status}</p>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}

export const getServerSideProps = withPageAuth({ role: "ADMIN" });
