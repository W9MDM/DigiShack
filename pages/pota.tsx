import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import type { PotaReport } from "@/pages/api/pota";
import { formatAgo, formatUtc, formatUtcDate } from "@/lib/time";
import { cn } from "@/lib/utils";

import { useVisibleInterval } from "@/lib/client/use-visible-interval";
// Parks on the Air.
//
// The page is built around a distinction worth being explicit about, because
// conflating the two would make it quietly wrong: POTA's own numbers are the
// authority on your history, and the local log is the authority on what to do next.
//
// POTA knows about every park contact you have ever made, including the years before
// this software existed. It does not know your antenna, your band, or that you worked
// KB1ABC forty minutes ago. The log knows all of that and — for parks specifically —
// knows nothing before the reference column was added, so its park totals start small
// and grow. Both are shown, labelled, and never added together.

/** Refresh often enough to be a spot list, rarely enough to be polite. */
const REFRESH_MS = 60_000;


function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "accent" | "muted";
}) {
  return (
    <div className="border border-line rounded-sm bg-surface-2 px-3 py-2" title={hint}>
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">{label}</div>
      <div
        className={cn(
          "font-display text-xl tnum leading-tight",
          tone === "accent" && "text-accent-bright",
          tone === "muted" && "text-fg-muted",
        )}
      >
        {value}
      </div>
      {hint && <div className="text-[10px] text-fg-subtle mt-0.5">{hint}</div>}
    </div>
  );
}

interface ImportReport {
  dryRun: boolean;
  kind: string;
  potaCount: number;
  fetched: number;
  rows: number;
  contacts: number;
  multiRef: number;
  unusableRows: number;
  referencesToAdd: number;
  referencesWritten: number;
  counts: Record<string, number>;
  updates: number;
  applied: number;
  windowMinutes: number;
  sample: {
    outcome: string;
    callsign: string;
    references: string[];
    adding: string[];
    band: string | null;
    at: string | null;
    qsoId: string | null;
    existing: string[];
    detail: string | null;
  }[];
}

const OUTCOME_TONE: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
  matched: "ok",
  "already-set": "neutral",
  conflict: "danger",
  ambiguous: "warn",
  missing: "info",
  unusable: "neutral",
};

const OUTCOME_MEANING: Record<string, string> = {
  matched: "will gain the references it is missing",
  "already-set": "already has every reference POTA reports — nothing to do",
  conflict:
    "carries references POTA does not know of, with none in common — left alone unless you allow it",
  ambiguous: "two contacts fit equally well, so neither is touched",
  missing: "POTA has this contact and your log does not",
  unusable: "the POTA row lacks a park or a usable timestamp",
};

/**
 * Import the POTA hunter log.
 *
 * Two steps, always. The preview is a real run of the matcher against the real log
 * with nothing written, because this touches thousands of existing contacts and a
 * wrong park reference cannot be told from a right one afterwards. "Apply" only
 * appears once there is a plan to look at.
 */
function ImportPanel({ onDone }: { onDone: () => void }) {
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [windowMinutes, setWindowMinutes] = useState(10);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiPost<ImportReport>("/api/pota/import", {
        dryRun,
        kind: "hunter",
        overwrite,
        windowMinutes,
      });
      setReport(r);
      if (!dryRun) onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Import your POTA hunter log"
      className="mt-4"
      actions={
        <div className="flex items-center gap-2">
          <Button onClick={() => void run(true)} disabled={busy}>
            {busy ? "Working…" : "Preview"}
          </Button>
          {report?.dryRun && report.updates > 0 && (
            <Button variant="primary" onClick={() => void run(false)} disabled={busy}>
              Apply {report.referencesToAdd.toLocaleString()} reference
              {report.referencesToAdd === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      }
    >
      <p className="text-sm text-fg-muted">
        POTA knows every park you have ever hunted; this log only knows the ones recorded
        since park references were added. This fills in the rest by matching POTA&apos;s
        logbook against contacts already here — it never creates QSOs, and it never
        adds a reference to a contact whose parks have nothing in common with POTA's
      </p>
      <p className="mt-2 text-xs text-fg-subtle">
        Needs a POTA session token in Settings → POTA chasing. It expires within hours,
        so this is a one-time backfill: from now on references are recorded as contacts
        are made.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-fg-muted">Match within</span>
          <Input
            type="number"
            min={1}
            max={120}
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(Number(e.target.value) || 10)}
            className="w-16 tnum"
          />
          <span className="text-fg-muted">minutes</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="accent-accent"
          />
          <span className="text-fg-muted">
            Add POTA references even when none of the parks match
          </span>
        </label>
      </div>

      {err && (
        <div className="mt-3">
          <ErrorBanner>{err}</ErrorBanner>
        </div>
      )}

      {report && (
        <div className="mt-4">
          <p className="text-sm">
            {report.dryRun ? (
              <>
                Preview only — nothing written. POTA returned{" "}
                <span className="tnum">{report.rows.toLocaleString()}</span> rows
                describing <span className="tnum">{report.contacts.toLocaleString()}</span>{" "}
                contacts, of which{" "}
                <span className="tnum">{report.multiRef.toLocaleString()}</span> are in more
                than one park at once.
              </>
            ) : (
              <span className="text-ok">
                Applied — {report.referencesWritten.toLocaleString()} reference
                {report.referencesWritten === 1 ? "" : "s"} written across{" "}
                {report.applied.toLocaleString()} contact
                {report.applied === 1 ? "" : "s"}.
              </span>
            )}
          </p>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(report.counts)
              .filter(([, n]) => n > 0)
              .map(([outcome, n]) => (
                <span key={outcome} title={OUTCOME_MEANING[outcome]}>
                  <Badge tone={OUTCOME_TONE[outcome] ?? "neutral"}>
                    {outcome} {n.toLocaleString()}
                  </Badge>
                </span>
              ))}
          </div>

          {report.sample.length > 0 && (
            <div className="mt-3 max-h-80 overflow-y-auto overflow-x-auto border border-line rounded-sm">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface-2">
                  <tr className="text-left uppercase tracking-wide text-fg-muted">
                    <th className="px-2 py-1 font-medium">Outcome</th>
                    <th className="px-2 py-1 font-medium">Callsign</th>
                    <th className="px-2 py-1 font-medium">Park</th>
                    <th className="px-2 py-1 font-medium">POTA time</th>
                    <th className="px-2 py-1 font-medium">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.sample.map((s, i) => (
                    <tr key={`${s.callsign}-${s.references.join()}-${i}`}>
                      <td className="px-2 py-1">
                        <Badge tone={OUTCOME_TONE[s.outcome] ?? "neutral"}>{s.outcome}</Badge>
                      </td>
                      <td className="px-2 py-1 font-display tracking-wide">{s.callsign}</td>
                      <td className="px-2 py-1 tnum">
                        {s.qsoId ? (
                          <Link href={`/qsos/${s.qsoId}`} className="hover:text-accent-bright">
                            {s.references.join(", ")}
                          </Link>
                        ) : (
                          s.references.join(", ")
                        )}
                        {s.references.length > 1 && (
                          <span className="ml-1 text-fg-subtle">
                            {s.references.length}-fer
                          </span>
                        )}
                        {s.band && <span className="text-fg-subtle"> · {s.band}</span>}
                      </td>
                      <td className="px-2 py-1 tnum text-fg-subtle whitespace-nowrap">
                        {s.at ? formatUtc(s.at) : "—"}
                      </td>
                      <td className="px-2 py-1 text-fg-subtle">
                        {s.outcome === "conflict"
                          ? `log says ${s.existing.join(", ")}`
                          : s.adding.length > 0 && s.adding.length < s.references.length
                            ? `adding ${s.adding.join(", ")}`
                            : (s.detail ?? "")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export default function PotaPage() {
  const { data, error, reload } = useApi<PotaReport>("/api/pota");
  const [modeFilter, setModeFilter] = useState<"all" | "FT8" | "FT4">("all");
  const [newOnly, setNewOnly] = useState(false);

  // Spots go stale in minutes. The server caches POTA's response, so polling here
  // costs a local query rather than a request to a volunteer-run API.
  // Suspended while the tab is hidden. This is the heaviest poll in the app for a field
  // operator: a full LTE wake-up and TLS round trip every minute, running with the phone in
  // a pocket, and on flaky signal a FAILED fetch is worse still because the modem ramps to
  // full power hunting for a connection. Catches up on return, since a spot list that is
  // ten minutes stale is the one case where waiting another minute is clearly wrong.
  useVisibleInterval(() => void reload(), REFRESH_MS);

  const spots = useMemo(() => {
    const list = data?.spots ?? [];
    return list.filter(
      (s) =>
        (modeFilter === "all" || s.mode === modeFilter) &&
        (!newOnly || (!s.workedPark && !s.workedToday)),
    );
  }, [data?.spots, modeFilter, newOnly]);

  if (error) {
    return (
      <>
        <PageHeader title="POTA" />
        <ErrorBanner>{error.message}</ErrorBanner>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <PageHeader title="POTA" />
        <p className="text-sm text-fg-muted">Loading…</p>
      </>
    );
  }

  const p = data.profile;

  return (
    <>
      <PageHeader
        title="POTA"
        subtitle={
          data.callsign
            ? `Parks on the Air — ${data.callsign}`
            : "Parks on the Air — set up a station to see your profile"
        }
        actions={
          <span className="text-xs text-fg-subtle tnum">updated {formatAgo(data.fetchedAt)} ago</span>
        }
      />

      {data.profileError && (
        <div className="mb-4 text-sm text-fg-muted border border-line rounded-sm bg-surface-2 px-3 py-2">
          {data.profileError}. Spots and your own park contacts below still work — POTA
          only has a profile once you have logged something with them.
        </div>
      )}

      {p && (
        <div className="grid gap-4 lg:grid-cols-2 mb-4">
          <Card
            title="Hunter"
            actions={<span className="text-[10px] text-fg-subtle">from pota.app</span>}
          >
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Parks" value={p.hunter.parks.toLocaleString()} tone="accent" />
              <Stat label="QSOs" value={p.hunter.qsos.toLocaleString()} />
            </div>
            {/* The local figure is separate and smaller on purpose. It is not a
                correction of POTA's number — it is a different, narrower fact. */}
            <p className="mt-3 text-xs text-fg-subtle">
              This log has {data.local.parkQsos.toLocaleString()} park contact
              {data.local.parkQsos === 1 ? "" : "s"} across {data.local.parks} reference
              {data.local.parks === 1 ? "" : "s"} — park references are only recorded from
              the version that added the column, so POTA&apos;s totals above are the
              history.
            </p>
          </Card>

          <Card
            title="Activator"
            actions={<span className="text-[10px] text-fg-subtle">from pota.app</span>}
          >
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Activations" value={p.activator.activations} tone="accent" />
              <Stat label="Parks" value={p.activator.parks} />
              <Stat label="QSOs" value={p.activator.qsos} />
            </div>
            {p.attempts.activations > p.activator.activations && (
              <p className="mt-3 text-xs text-fg-subtle">
                {p.attempts.activations} attempt
                {p.attempts.activations === 1 ? "" : "s"} in total — an activation needs ten
                contacts, and the difference is the ones that fell short.
              </p>
            )}
          </Card>
        </div>
      )}

      <Card
        title={`Live spots${data.spotsError ? "" : ` (${spots.length})`}`}
        className="mb-4"
        actions={
          <div className="flex items-center gap-2 text-xs">
            {(["all", "FT8", "FT4"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setModeFilter(m)}
                className={cn(
                  "px-1.5 py-0.5 rounded-sm border",
                  modeFilter === m
                    ? "border-accent text-accent-bright bg-accent/10"
                    : "border-line text-fg-muted hover:text-fg",
                )}
              >
                {m === "all" ? "All" : m}
              </button>
            ))}
            <label className="flex items-center gap-1 text-fg-muted cursor-pointer ml-1">
              <input
                type="checkbox"
                checked={newOnly}
                onChange={(e) => setNewOnly(e.target.checked)}
                className="accent-accent"
              />
              New only
            </label>
          </div>
        }
      >
        {data.spotsError ? (
          <ErrorBanner>POTA spots unavailable: {data.spotsError}</ErrorBanner>
        ) : spots.length === 0 ? (
          <EmptyState title="Nothing to chase">
            {newOnly
              ? "Every digital activator on the air right now is already in the log."
              : "No FT8 or FT4 activators spotted at the moment."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-fg-muted">
                  <th className="px-2 py-1.5 font-medium">Activator</th>
                  <th className="px-2 py-1.5 font-medium">Park</th>
                  <th className="px-2 py-1.5 font-medium">Freq</th>
                  <th className="px-2 py-1.5 font-medium">Mode</th>
                  <th className="px-2 py-1.5 font-medium">Where</th>
                  <th className="px-2 py-1.5 font-medium">Spotted</th>
                  <th className="px-2 py-1.5 font-medium">In the log</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {spots.map((s) => (
                  <tr key={s.spotId} className="hover:bg-surface-2">
                    <td className="px-2 py-1.5">
                      <Link
                        href={`/qsos?q=${encodeURIComponent(s.activator)}`}
                        className="font-display tracking-wide hover:text-accent-bright"
                      >
                        {s.activator}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="tnum text-fg-muted">{s.reference}</span>
                      {s.parkName && (
                        <span className="text-fg-subtle text-xs"> · {s.parkName}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 tnum whitespace-nowrap">
                      {(s.freqHz / 1e6).toFixed(3)}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge tone={s.mode === "FT8" ? "accent" : "info"}>{s.mode}</Badge>
                      {s.band && <span className="ml-1 text-xs text-fg-subtle">{s.band}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-fg-muted text-xs">{s.location ?? "—"}</td>
                    <td className="px-2 py-1.5 tnum text-fg-subtle text-xs whitespace-nowrap">
                      {formatAgo(s.spottedAt)} ago
                    </td>
                    <td className="px-2 py-1.5">
                      {/* Three different answers, and they matter differently. Worked
                          TODAY almost certainly means this same activation — a dupe.
                          The park being in the log is an award fact. The activator
                          being known is neither, just context. */}
                      {s.workedToday ? (
                        <Badge tone="warn">Today</Badge>
                      ) : s.workedPark ? (
                        <Badge tone="neutral">Park worked</Badge>
                      ) : s.workedActivator ? (
                        <Badge tone="neutral">Call worked</Badge>
                      ) : (
                        <Badge tone="ok">New</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {p && p.awards.length > 0 && (
        <Card
          title={`Awards (${p.awardCount})`}
          className="mb-4"
          actions={
            <span className="text-[10px] text-fg-subtle">
              {p.endorsementCount} endorsements
            </span>
          }
        >
          {/* Endorsements are most of what a POTA award says. "Bronze Hunter" alone is
              one line; "Bronze Hunter, endorsed on eleven bands and three modes" is the
              actual achievement, so they are all shown rather than counted. */}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {p.awards.map((a) => (
              <div key={a.name} className="border border-line rounded-sm bg-surface-2 p-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-display text-sm tracking-wide">{a.name}</span>
                  {a.granted && (
                    <span className="text-[10px] text-fg-subtle tnum whitespace-nowrap">
                      {formatUtcDate(a.granted)}
                    </span>
                  )}
                </div>
                {a.endorsements.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {a.endorsements.map((e) => (
                      <span
                        key={e}
                        className="text-[10px] uppercase tracking-wide text-fg-subtle border border-line-strong rounded-sm px-1"
                      >
                        {e}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {p && p.recentActivations.length > 0 && (
          <Card title="Your recent activations">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[22rem] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-fg-muted">
                  <th className="py-1 font-medium">Date</th>
                  <th className="py-1 font-medium">Park</th>
                  <th className="py-1 font-medium text-right">CW</th>
                  <th className="py-1 font-medium text-right">Data</th>
                  <th className="py-1 font-medium text-right">Phone</th>
                  <th className="py-1 font-medium text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {p.recentActivations.map((a) => (
                  <tr key={`${a.date}-${a.reference}`}>
                    <td className="py-1 tnum text-fg-muted whitespace-nowrap">{a.date}</td>
                    <td className="py-1">
                      <span className="tnum">{a.reference}</span>
                      {a.park && <span className="text-fg-subtle text-xs"> · {a.park}</span>}
                    </td>
                    <td className="py-1 tnum text-right text-fg-subtle">{a.cw || "—"}</td>
                    <td className="py-1 tnum text-right text-fg-subtle">{a.data || "—"}</td>
                    <td className="py-1 tnum text-right text-fg-subtle">{a.phone || "—"}</td>
                    <td
                      className={cn(
                        "py-1 tnum text-right",
                        // Ten is the threshold for a valid activation.
                        a.total >= 10 ? "text-ok" : "text-warn",
                      )}
                    >
                      {a.total}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </Card>
        )}

        <Card
          title="Park contacts in this log"
          actions={<span className="text-[10px] text-fg-subtle">from your log</span>}
        >
          {data.local.recent.length === 0 ? (
            <EmptyState title="None yet">
              Park references are recorded on contacts made from now on — by the POTA
              chase and hunt modes automatically, and by hand on any QSO. Your history
              before that lives in POTA&apos;s own totals above.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[22rem] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-fg-muted">
                  <th className="py-1 font-medium">Time (UTC)</th>
                  <th className="py-1 font-medium">Callsign</th>
                  <th className="py-1 font-medium">Park</th>
                  <th className="py-1 font-medium">Band</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.local.recent.map((q) => (
                  <tr key={q.id} className="hover:bg-surface-2">
                    <td className="py-1 tnum text-fg-muted whitespace-nowrap">
                      {formatUtc(q.startTime)}
                    </td>
                    <td className="py-1">
                      <Link
                        href={`/qsos/${q.id}`}
                        className="font-display tracking-wide hover:text-accent-bright"
                      >
                        {q.callsign}
                      </Link>
                    </td>
                    <td className="py-1 tnum text-fg-muted">
                      {/* Every park, not just the first. A two-fer showing one park
                          would read as a complete record and quietly under-count. */}
                      {q.references.length > 0 ? (
                        q.references.join(", ")
                      ) : (
                        <span className="text-fg-subtle">unknown</span>
                      )}
                    </td>
                    <td className="py-1 text-fg-subtle text-xs">
                      {q.band} {q.mode}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </Card>
      </div>

      <ImportPanel onDone={() => void reload()} />

      {p && (p.name || p.qth || p.grid) && (
        <p className="mt-4 text-xs text-fg-subtle">
          POTA profile: {[p.name, p.qth, p.grid].filter(Boolean).join(" · ")}
        </p>
      )}
    </>
  );
}

export const getServerSideProps = withPageAuth({ role: "VIEWER" });
