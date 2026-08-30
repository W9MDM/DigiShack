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
import { useCan } from "@/lib/client/session";
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

interface PendingCounts {
  service: string;
  /** Awaiting upload AND newer than the cutoff — what an automatic sweep will send. */
  pending: number;
  /** Everything unsent, cutoff ignored — the back catalogue. */
  backlog: number;
  configured: boolean;
}

interface UploadsResponse {
  enabled: boolean;
  since: string | null;
  intervalMinutes: number;
  counts: PendingCounts[];
  /** Whether anything is actually going to run a sweep. See the card below. */
  sweeper: { running: boolean; detail: string };
}

interface ServiceStatus {
  id: string;
  label: string;
  configured: boolean;
  /** null when there is no safe way to check without writing. */
  ok: boolean | null;
  detail: string;
  capabilities: string[];
}

/**
 * The eQSL inbox sync, as reported by /api/integrations/status.
 *
 * Every field here existed nowhere before. The sync ran on the radio service's timer and
 * recorded nothing, so the only honest thing this page could have said about it was that it
 * might exist. See eqslInboxStatus in pages/api/integrations/status.ts.
 */
interface EqslInboxStatus {
  configured: boolean;
  autoSync: boolean;
  running: boolean;
  intervalMinutes: number;
  lastSyncAt: string | null;
  lastResult: string | null;
  port: number;
  /** Ordered by what to fix first; empty when there is nothing to say. */
  detail: string;
}

interface StatusResponse {
  services: ServiceStatus[];
  lotw?: { at: string | null; result: string | null; marker: string | null };
  eqsl?: EqslInboxStatus;
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
  const { data: uploads, reload: reloadUploads } = useApi<UploadsResponse>("/api/uploads");
  const isAdmin = useCan("ADMIN");
  const [uploadBusy, setUploadBusy] = useState<string | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);

  /**
   * Send what is waiting, now, from the browser.
   *
   * The only other thing that ever calls `runUploads` is the radio service, so an
   * installation not running it had no way to upload at all — the reported symptom was
   * "turned uploads on and the log still is not uploading at the sweep", with nothing on
   * any page to explain why.
   */
  async function uploadNow(ignoreCutoff: boolean) {
    setUploadBusy(ignoreCutoff ? "backlog" : "now");
    setUploadNote(null);
    try {
      const r = await apiPost<{
        ran: boolean;
        reason: string | null;
        services: { service: string; uploaded: number; failed: number; skipped: string | null; errors: string[] }[];
      }>("/api/uploads", { ignoreCutoff });
      if (!r.ran) {
        setUploadNote(r.reason ?? "Nothing ran");
      } else {
        const sent = r.services.reduce((n, x) => n + x.uploaded, 0);
        const skipped = r.services.filter((x) => x.skipped);
        setUploadNote(
          `${sent} contact${sent === 1 ? "" : "s"} sent` +
            (skipped.length
              ? ` — skipped: ${skipped.map((x) => `${x.service} (${x.skipped})`).join(", ")}`
              : "") +
            (r.services.some((x) => x.errors.length)
              ? ` — ${r.services.flatMap((x) => x.errors).slice(0, 2).join("; ")}`
              : ""),
        );
      }
      reloadUploads();
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setUploadBusy(null);
    }
  }
  /**
   * Mark everything logged so far as already uploaded, WITHOUT sending any of it.
   *
   * The honest way to adopt an upload target on a log that predates it. An operator whose
   * contacts are already at QRZ from a previous logger wants the flags to say so, not
   * thousands of API calls that each come back "duplicate" — and for N3FJP, which is a
   * program on somebody's desk rather than a service, that difference is 29,739 records
   * arriving unannounced.
   *
   * The count is read fresh and echoed back to the server. If it has moved between the
   * confirmation and the click the server refuses, because a dialog that describes 4,992
   * contacts and then acts on 4,993 is not a confirmation.
   */
  async function baseline(service: string) {
    setUploadBusy(`baseline:${service}`);
    setUploadNote(null);
    try {
      const preview = await apiGet<{ count: number; before: string }>(
        `/api/uploads/baseline?service=${encodeURIComponent(service)}`,
      );
      if (preview.count === 0) {
        setUploadNote(`${service} has nothing left to mark.`);
        return;
      }
      if (
        !window.confirm(
          `Mark ${preview.count.toLocaleString()} contacts as already sent to ${service}?\n\n` +
            `Nothing is uploaded. This only sets the flags, so ${service} will never be ` +
            `offered these contacts again.\n\n` +
            `Do this only if they are already there from another logger. It cannot be undone.`,
        )
      ) {
        return;
      }
      const r = await apiPost<{ marked: number }>("/api/uploads/baseline", {
        service,
        before: preview.before,
        expected: preview.count,
      });
      setUploadNote(
        `${r.marked.toLocaleString()} contacts marked as already sent to ${service}. Nothing was uploaded.`,
      );
      reloadUploads();
    } catch (err) {
      setUploadNote(err instanceof ApiError ? err.message : "Could not set the baseline");
    } finally {
      setUploadBusy(null);
    }
  }

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
  const eqsl = data?.eqsl;

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

        {/* eQSL, BESIDE LoTW ON PURPOSE.

            LoTW has printed "Last run / Result / Fetched up to" since it was written, and
            an operator can therefore tell at a glance whether it is alive. The eQSL inbox
            sync — the thing that actually earns eQSL award credit — had no marker at all
            and appeared on no page, so the identical question had no answer anywhere.

            There is no "Sync now" button here and that is not an oversight: eQSL inbox sync
            has no endpoint of its own, only the radio service's timer. Adding a button would
            mean adding a route; saying so is the honest interim. */}
        <Card title="eQSL.cc inbox">
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-muted">
              Downloads the confirmations other operators have sent you and matches them to
              the log, which is what earns eQSL award credit. Read only — it uploads nothing
              and posts no card to anybody.
            </p>

            {eqsl ? (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt className="text-fg-subtle">Last run</dt>
                  <dd className="text-right tnum">
                    {eqsl.lastSyncAt ? formatUtc(eqsl.lastSyncAt) : "never"}
                  </dd>
                  <dt className="text-fg-subtle">Result</dt>
                  <dd className="text-right">{eqsl.lastResult ?? "—"}</dd>
                  <dt className="text-fg-subtle">Checks every</dt>
                  <dd className="text-right tnum">
                    {eqsl.autoSync ? `${eqsl.intervalMinutes} min` : "not scheduled"}
                  </dd>
                </dl>

                {/* The sentence that was missing entirely. Red when nothing can be syncing,
                    because "never" beside a silent explanation is the reading an operator
                    acts on by blaming eQSL. */}
                {eqsl.detail !== "" && (
                  <p className={eqsl.lastSyncAt ? "text-sm text-warn" : "text-sm text-danger"}>
                    {eqsl.detail}
                  </p>
                )}
                {eqsl.detail === "" && (
                  <p className="text-sm text-fg-muted">
                    The radio service is reading the inbox every {eqsl.intervalMinutes} min.
                  </p>
                )}

                <p className="text-[11px] text-fg-subtle">
                  Runs only on the radio service&apos;s timer — there is no button for it
                  here. Confirmations already in the log from an ADIF import are left alone;
                  a confirmation that matches nothing is discarded rather than guessed at,
                  which on a multi-QTH eQSL account is expected rather than a fault.
                </p>
              </>
            ) : (
              <p className="text-sm text-fg-subtle">Checking…</p>
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

        {/* WHAT IS WAITING, AND WHETHER ANYTHING WILL SEND IT.
            
            Two separate facts, and conflating them is the whole bug this card exists for.
            "Automatic uploading" being ON only means the sweep is ALLOWED — something
            still has to run it, and the only thing that ever does is the radio service.
            An installation using DigiShack as a logbook without the bridge running had
            uploads switched on, a growing backlog, and nothing anywhere saying why the
            number never moved. */}
        <Card
          title="Uploads"
          className="lg:col-span-2"
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                disabled={uploadBusy !== null}
                onClick={() => void uploadNow(false)}
                title="Send everything waiting that is newer than the cutoff, right now, without waiting for a sweep."
              >
                {uploadBusy === "now" ? "Uploading…" : "Upload now"}
              </Button>
              {(uploads?.counts.some((c) => c.backlog > c.pending) ?? false) && (
                <Button
                  disabled={uploadBusy !== null}
                  onClick={() => void uploadNow(true)}
                  title="Also send contacts older than the cutoff date — the back catalogue."
                >
                  {uploadBusy === "backlog" ? "Uploading…" : "Include back catalogue"}
                </Button>
              )}
            </div>
          }
        >
          {uploads ? (
            <div className="flex flex-col gap-3">
              {!uploads.enabled && (
                <p className="text-sm text-warn">
                  Automatic uploading is off — nothing is sent on a sweep.{" "}
                  <Link href="/settings" className="text-accent-bright underline">
                    Settings → Uploads
                  </Link>
                  . “Upload now” still works.
                </p>
              )}
              {uploads.enabled && !uploads.sweeper.running && (
                // The message that was missing entirely.
                <p className="text-sm text-danger">{uploads.sweeper.detail}</p>
              )}
              {uploads.enabled && uploads.sweeper.running && (
                <p className="text-sm text-fg-muted">{uploads.sweeper.detail}</p>
              )}
              {uploads.since && (
                <p className="text-xs text-fg-subtle">
                  Automatic sweeps only send contacts made after{" "}
                  <span className="text-fg-muted tnum">{uploads.since}</span>. Anything
                  older is the back catalogue and needs the button above.
                </p>
              )}

              <ul className="flex flex-col gap-1.5">
                {uploads.counts.map((c) => (
                  <li
                    key={c.service}
                    className="flex items-center justify-between gap-3 border-b border-line pb-1.5 last:border-0"
                  >
                    <span className="text-sm text-fg">{c.service}</span>
                    <span className="flex items-center gap-3">
                      <span className="text-xs tnum text-fg-muted">
                        {!c.configured ? (
                          <span className="text-fg-subtle">not set up</span>
                        ) : c.pending === 0 && c.backlog === 0 ? (
                          <span className="text-ok">up to date</span>
                        ) : (
                          <>
                            {c.pending} waiting
                            {c.backlog > c.pending && (
                              <span className="text-fg-subtle">
                                {" "}
                                · {c.backlog - c.pending} older than the cutoff
                              </span>
                            )}
                          </>
                        )}
                      </span>
                      {/* Only where there is a backlog to disclaim, and only for an
                          admin. Offering this beside "up to date" would be offering a
                          destructive action with nothing to act on. */}
                      {isAdmin && c.backlog > 0 && (
                        <Button
                          className="text-xs px-2 py-0.5"
                          disabled={uploadBusy !== null}
                          onClick={() => void baseline(c.service)}
                          title={`Mark all ${c.backlog} unsent contacts as already at ${c.service}, without uploading anything. For a log that was already uploaded by another program.`}
                        >
                          {uploadBusy === `baseline:${c.service}`
                            ? "Marking…"
                            : "Already sent"}
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              {isAdmin && (uploads.counts.some((c) => c.backlog > 0) ?? false) && (
                <p className="text-xs text-fg-subtle">
                  <strong>Already sent</strong> marks a service&rsquo;s whole backlog as
                  uploaded <em>without sending any of it</em> — for a log that another
                  program already uploaded, where the alternative is thousands of calls
                  that each come back &ldquo;duplicate&rdquo;. It cannot be undone.
                </p>
              )}

              {uploadNote && <p className="text-xs text-accent-bright">{uploadNote}</p>}
            </div>
          ) : (
            <p className="text-sm text-fg-subtle">Checking…</p>
          )}
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
