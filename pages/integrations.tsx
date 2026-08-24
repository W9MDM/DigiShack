import Link from "next/link";
import { ToolTabs } from "@/components/settings/ToolTabs";
import { useState } from "react";

import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiGet, apiPost, useApi } from "@/lib/client/api";
import { formatUtc } from "@/lib/time";

// The logbook services, and what they are actually doing.
//
// Both halves of this page were already built and neither was reachable. The
// credential probes behind /api/integrations/status had nothing rendering them, and
// the LoTW sync had no button at all — the endpoint existed and the only way to run
// it was a hand-made HTTP request. So confirmations arrived when somebody remembered
// to craft one, which on this station meant the newest was nine days old.
//
// The status a service reports is READ-ONLY. Nothing here uploads or modifies a
// remote logbook, which is what makes it safe to press against a live account.

interface ServiceStatus {
  id: string;
  label: string;
  configured: boolean;
  /** null when there is no safe way to check without writing. */
  ok: boolean | null;
  detail: string;
  capabilities: string[];
}

interface StatusResponse {
  services: ServiceStatus[];
  lotw?: { at: string | null; result: string | null; marker: string | null };
}

interface SyncReport {
  dryRun: boolean;
  fetched: number;
  matched: number;
  updated: number;
  alreadyMarked: number;
  enriched: number;
  unmatched: number;
  incrementalFrom: string | null;
}

export default function IntegrationsPage() {
  const { data, error, reload } = useApi<StatusResponse>("/api/integrations/status");
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [smtp, setSmtp] = useState<{ ok: boolean; detail: string } | null>(null);

  async function sync(kind: "check" | "apply" | "full") {
    setBusy(kind);
    setSyncError(null);
    setReport(null);
    try {
      const q = new URLSearchParams({
        dryRun: kind === "check" ? "true" : "false",
        full: kind === "full" ? "true" : "false",
      });
      setReport((await apiPost(`/api/integrations/lotw-sync?${q}`, {})) as SyncReport);
      await reload();
    } catch (e) {
      setSyncError(e instanceof ApiError ? e.message : "Sync failed");
    } finally {
      setBusy(null);
    }
  }

  async function testSmtp() {
    setBusy("smtp");
    setSmtp(null);
    try {
      const r = (await apiGet("/api/qsl/email")) as { ok?: boolean; detail?: string };
      setSmtp({ ok: r.ok !== false, detail: r.detail ?? "Connected and signed in." });
    } catch (e) {
      // A failed test is the ANSWER, not an error in the page — the message from
      // the server is the useful part and belongs where the result goes.
      setSmtp({ ok: false, detail: e instanceof ApiError ? e.message : "Could not reach the mail server" });
    } finally {
      setBusy(null);
    }
  }

  const lotw = data?.lotw;

  return (
    <>
      <ToolTabs />
      <PageHeader
        title="Integrations"
        subtitle="Logbook services, and whether they are working"
        actions={
          <Link href="/settings" className="text-sm text-accent-bright hover:underline">
            Credentials →
          </Link>
        }
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Logbook of the World">
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-muted">
              Downloads confirmations and fills in state, county, zone and grid from
              LoTW&apos;s own record. Download only — uploading needs your TQSL
              certificate — so nothing here can alter your LoTW account.
            </p>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-fg-subtle">Last run</dt>
              <dd className="text-right tnum">{lotw?.at ? formatUtc(lotw.at) : "never"}</dd>
              <dt className="text-fg-subtle">Result</dt>
              <dd className="text-right">{lotw?.result ?? "—"}</dd>
              {/* The marker IS the sync's memory: everything confirmed after this
                  has been fetched. Empty means it has never completed a run, which
                  is the single most useful thing to see when it is misbehaving. */}
              <dt className="text-fg-subtle">Fetched up to</dt>
              <dd className="text-right tnum">{lotw?.marker ?? "nothing yet"}</dd>
            </dl>

            <div className="flex flex-wrap gap-2">
              <Button disabled={busy !== null} onClick={() => void sync("check")}>
                {busy === "check" ? "Checking…" : "Check for new"}
              </Button>
              <Button
                variant="primary"
                disabled={busy !== null}
                onClick={() => void sync("apply")}
              >
                {busy === "apply" ? "Syncing…" : "Sync now"}
              </Button>
              <Button disabled={busy !== null} onClick={() => void sync("full")}>
                {busy === "full" ? "Downloading…" : "Full history"}
              </Button>
            </div>

            <p className="text-[11px] text-fg-subtle">
              Runs hourly on its own; these are for when you don&apos;t want to wait.
              <br />
              <span className="text-fg-muted">Check for new</span> reports what would
              change without writing. <span className="text-fg-muted">Full history</span>{" "}
              walks year by year and takes several minutes — LoTW allows only one
              request at a time, so leave it to finish.
            </p>

            {syncError && <ErrorBanner>{syncError}</ErrorBanner>}

            {report && (
              <div className="rounded-sm border border-line bg-surface-2 px-3 py-2 text-sm">
                <p className="font-medium mb-1">
                  {report.dryRun ? "Would apply" : "Applied"}
                  {report.incrementalFrom ? ` — from ${report.incrementalFrom}` : ""}
                </p>
                <dl className="grid grid-cols-2 gap-x-4 text-xs">
                  <dt className="text-fg-subtle">Records fetched</dt>
                  <dd className="text-right tnum">{report.fetched}</dd>
                  <dt className="text-fg-subtle">Matched to log</dt>
                  <dd className="text-right tnum">{report.matched}</dd>
                  <dt className="text-fg-subtle">
                    {report.dryRun ? "Would confirm" : "Newly confirmed"}
                  </dt>
                  <dd className="text-right tnum text-ok">{report.updated}</dd>
                  <dt className="text-fg-subtle">Already confirmed</dt>
                  <dd className="text-right tnum">{report.alreadyMarked}</dd>
                  <dt className="text-fg-subtle">Award fields filled</dt>
                  <dd className="text-right tnum">{report.enriched}</dd>
                  {/* Not an error. These are confirmations for contacts this log has
                      never held — a different logging program, or another operator
                      using the same callsign. Worth showing; not worth alarming over. */}
                  <dt className="text-fg-subtle">Not in this log</dt>
                  <dd className="text-right tnum text-fg-muted">{report.unmatched}</dd>
                </dl>
              </div>
            )}
          </div>
        </Card>

        {/* SMTP had a working test behind GET /api/qsl/email — it opens a connection
            and authenticates WITHOUT sending anything — and no button anywhere. For a
            station posting 200 QSLs a day, "are my mail settings right" is a question
            worth being able to ask before finding out from a queue full of failures. */}
        <Card title="Outgoing email">
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-muted">
              QSL email and issue alerts both use these settings. The test opens a
              connection and signs in — it does not send anything.
            </p>
            <div>
              <Button disabled={busy !== null} onClick={() => void testSmtp()}>
                {busy === "smtp" ? "Testing…" : "Test connection"}
              </Button>
            </div>
            {smtp && (
              <p className={`text-sm ${smtp.ok ? "text-ok" : "text-danger"}`}>
                {smtp.ok ? "✓ " : "✗ "}
                {smtp.detail}
              </p>
            )}
          </div>
        </Card>

        <Card title="Services">
          {data?.services?.length ? (
            <ul className="flex flex-col gap-2">
              {data.services.map((s) => (
                <li
                  key={s.id}
                  className="flex items-start justify-between gap-3 border-b border-line pb-2 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-fg">{s.label}</p>
                    <p className="text-xs text-fg-subtle">{s.detail}</p>
                  </div>
                  <Badge
                    tone={
                      !s.configured ? "neutral" : s.ok === true ? "ok" : s.ok === false ? "danger" : "accent"
                    }
                  >
                    {!s.configured
                      ? "not set up"
                      : s.ok === true
                        ? "working"
                        : s.ok === false
                          ? "failing"
                          : "configured"}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-subtle">Checking…</p>
          )}
          {/* "configured" rather than "working" is an honest answer, not a hedge:
              some services have no read-only endpoint, and probing them with a write
              would put a stray QSO in somebody's public log to satisfy a status dot. */}
          <p className="mt-3 text-[11px] text-fg-subtle">
            Every check here only reads. A service with no read-only endpoint is shown
            as configured rather than probed with a write.
          </p>
        </Card>
      </div>
    </>
  );
}

export const getServerSideProps = withPageAuth({ role: "OPERATOR" });
