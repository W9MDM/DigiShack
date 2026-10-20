import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { CardTable } from "@/components/dashboard/CardTable";
import { plural } from "@/components/dashboard/format";
import { Loading, Notice } from "@/components/dashboard/Notice";
import { Section } from "@/components/dashboard/Section";
import { Segmented } from "@/components/dashboard/Segmented";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
  Td,
  Th,
} from "@/components/ui/primitives";
import { Stat } from "@/components/ui/Stat";
import {
  type ActivationSession,
  readActivation,
} from "@/components/qso/QsoForm";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import {
  ACTIVATION_MINIMUM,
  activationCountQuery,
  activationProgress,
  utcDayKey,
} from "@/lib/pota/activation";
import type { PotaReport } from "@/pages/api/pota";
import { formatAgo, formatUtc, formatUtcDate } from "@/lib/time";
import type { ListResponse, Qso } from "@/lib/types";
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

/** The small right-hand label naming where a panel's figures come from. */
function Source({ children }: { children: string }) {
  return <span className="text-xs text-fg-subtle">{children}</span>;
}

/**
 * The activation happening RIGHT NOW, counted from this log.
 *
 * THE FAULT THIS ANSWERS. Everything else on this page marked "from pota.app" is
 * somebody else's record of work already finished — including the activation count,
 * which until now described activations this application could not produce, because
 * nothing here stored MY_SIG_INFO. The number an activator actually needs is the one for
 * the activation in progress, and POTA cannot supply it: their totals arrive after the
 * log is uploaded, which is after the operator has packed up and driven home.
 *
 * Counted from the LOG, and labelled as such. It is not a correction of POTA's totals
 * above and must never be added to them — it is the same distinction this page is built
 * around, applied to the one row where the local log is the only possible source.
 *
 * The reference comes from the activation session in localStorage, which /qsos/new
 * writes. So this card appears on the phone that is doing the logging and not on a
 * different device — true, and the honest limit of a session that lives in a browser
 * rather than in the database. Said out loud rather than papered over.
 */
function ActivationInProgress() {
  const [session, setSession] = useState<ActivationSession | null>(null);
  /** Re-read storage and re-ask for the count. Bumped by the poll below. */
  const [tick, setTick] = useState(0);

  // localStorage is not readable during the server render, so this cannot be a lazy
  // initialiser — same reason the logging page gives.
  useEffect(() => {
    setSession(readActivation());
  }, [tick]);

  // The contacts are being logged in ANOTHER TAB (or another window), so nothing in this
  // page's own state changes when the count does. Polling is the only way this page can
  // see it, and it rides the same interval and the same visibility gate as the spot list
  // rather than adding a second timer to a phone in a park.
  useVisibleInterval(() => setTick((t) => t + 1), REFRESH_MS);

  const ref = session?.ref ?? "";
  const path = useMemo(
    () => (ref ? `/api/qsos?${activationCountQuery(ref, new Date())}` : null),
    // `tick` re-pins the UTC day bounds as well as refreshing the count, so an activation
    // running across UTC midnight lands on the new day within one poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ref, tick],
  );
  const { data } = useApi<ListResponse<Qso>>(path);
  const progress = activationProgress(data?.total ?? 0);

  if (!session) return null;

  return (
    <Card
      title="Activation in progress"
      actions={<Source>from your log</Source>}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={progress.qualifies ? "ok" : "accent"}>
          {progress.count}/{ACTIVATION_MINIMUM}
        </Badge>
        <span className="font-display text-lg tracking-wide tnum">{session.ref}</span>
        <span className="text-sm text-fg-muted">
          {progress.qualifies
            ? "This activation counts."
            : `${progress.remaining} more contact${progress.remaining === 1 ? "" : "s"} needed.`}
        </span>
        <span className="text-xs text-fg-subtle tnum">
          {session.sig} · UTC day {utcDayKey(new Date())}
          {session.startedAt ? ` · started ${formatAgo(session.startedAt)} ago` : ""}
        </span>
        <Link href="/qsos/new" className="ml-auto">
          <Button variant="primary">Log a contact</Button>
        </Link>
      </div>
      {/* The grid is the field POTA and LoTW read to place the activation, and it is the
          one an operator forgets, because the station's home grid is right every other
          day of the year. Named here while it can still be fixed. */}
      <p className="mt-3 text-xs text-fg-subtle">
        {session.grid
          ? `Exporting MY_GRIDSQUARE ${session.grid}.`
          : "No portable grid set — the export will use the station's home grid. Set “My grid” on the QSO form if you are not at home."}
      </p>
    </Card>
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
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void run(true)} loading={busy}>
            Preview
          </Button>
          {report?.dryRun && report.updates > 0 && (
            <Button variant="primary" onClick={() => void run(false)} disabled={busy}>
              Apply {plural(report.referencesToAdd, "reference")}
            </Button>
          )}
        </div>
      }
    >
      <p className="text-sm text-fg-muted">
        POTA knows every park you have ever hunted; this log only knows the ones recorded
        since park references were added. This fills in the rest by matching POTA&apos;s
        logbook against contacts already here — it never creates QSOs, and it never
        adds a reference to a contact whose parks have nothing in common with POTA&apos;s.
      </p>
      <p className="mt-2 text-sm text-fg-subtle">
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
                Applied — {plural(report.referencesWritten, "reference")} written across{" "}
                {plural(report.applied, "contact")}.
              </span>
            )}
          </p>

          {/* The meanings were hover tooltips, which a phone never shows. */}
          <ul className="mt-2 flex flex-col gap-1">
            {Object.entries(report.counts)
              .filter(([, n]) => n > 0)
              .map(([outcome, n]) => (
                <li key={outcome} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={OUTCOME_TONE[outcome] ?? "neutral"}>
                    {outcome} {n.toLocaleString()}
                  </Badge>
                  {OUTCOME_MEANING[outcome] && (
                    <span className="text-fg-subtle">{OUTCOME_MEANING[outcome]}</span>
                  )}
                </li>
              ))}
          </ul>

          {report.sample.length > 0 && (
            <div className="mt-3 max-h-80 overflow-auto rounded-sm border border-line">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-surface-2">
                  <tr className="text-left">
                    <Th size="sm">Outcome</Th>
                    <Th size="sm">Callsign</Th>
                    <Th size="sm">Park</Th>
                    <Th size="sm">POTA time</Th>
                    <Th size="sm">Why</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {report.sample.map((s, i) => (
                    <tr key={`${s.callsign}-${s.references.join()}-${i}`}>
                      <Td size="sm">
                        <Badge size="sm" tone={OUTCOME_TONE[s.outcome] ?? "neutral"}>
                          {s.outcome}
                        </Badge>
                      </Td>
                      <Td size="sm" className="font-display tracking-wide">
                        {s.callsign}
                      </Td>
                      <Td size="sm" className="tnum">
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
                      </Td>
                      <Td size="sm" className="whitespace-nowrap tnum text-fg-subtle">
                        {s.at ? formatUtc(s.at) : "—"}
                      </Td>
                      <Td size="sm" className="text-fg-subtle">
                        {s.outcome === "conflict"
                          ? `log says ${s.existing.join(", ")}`
                          : s.adding.length > 0 && s.adding.length < s.references.length
                            ? `adding ${s.adding.join(", ")}`
                            : (s.detail ?? "")}
                      </Td>
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

  // An error with nothing loaded is the whole page. An error on a REFRESH is not: this
  // polls every minute, and one failed poll used to replace a perfectly good spot list
  // with a red box until the next one succeeded.
  if (!data) {
    return (
      <>
        <PageHeader title="POTA" subtitle="Parks on the Air" />
        {error ? (
          <ErrorBanner>{error.message} Retrying on its own.</ErrorBanner>
        ) : (
          <Loading>Asking pota.app and the log…</Loading>
        )}
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
          <span className="text-xs text-fg-subtle tnum">
            updated {formatAgo(data.fetchedAt)} ago
          </span>
        }
      />

      <div className="flex flex-col gap-6">
        {error && (
          <ErrorBanner>
            The last refresh failed ({error.message}) — showing what loaded{" "}
            {formatAgo(data.fetchedAt)} ago.
          </ErrorBanner>
        )}

        {data.profileError && (
          <Notice>
            {data.profileError}. Spots and your own park contacts below still work — POTA
            only has a profile once you have logged something with them.
          </Notice>
        )}

        {/* First, above POTA's own totals, because it is the only thing here the
            operator can still act on. Renders nothing without an activation running. */}
        <ActivationInProgress />

        {p && (
          <Section
            title="Your POTA record"
            description="From pota.app — every park you have ever worked, including before this log existed."
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Parks hunted" value={p.hunter.parks} tone="accent" />
              <Stat label="Hunter QSOs" value={p.hunter.qsos} />
              <Stat
                label="Activations"
                value={p.activator.activations}
                tone="accent"
                hint={
                  p.attempts.activations > p.activator.activations
                    ? `of ${plural(p.attempts.activations, "attempt")}`
                    : undefined
                }
              />
              <Stat label="Parks activated" value={p.activator.parks} />
              <Stat label="Activator QSOs" value={p.activator.qsos} />
            </div>
            {/* The local figure is separate and smaller on purpose. It is not a
                correction of POTA's number — it is a different, narrower fact. */}
            <p className="text-sm text-fg-subtle">
              This log has {plural(data.local.parkQsos, "park contact")} across{" "}
              {plural(data.local.parks, "reference")}. Park references are only recorded from
              the version that added them, so POTA&apos;s totals are the history.
              {p.attempts.activations > p.activator.activations &&
                " An activation needs ten contacts; attempts that fell short are not counted as activations."}
            </p>
          </Section>
        )}

        <Card
          title={`Live spots${data.spotsError ? "" : ` (${spots.length})`}`}
          actions={
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                value={modeFilter}
                onChange={setModeFilter}
                label="Spot mode"
                options={[
                  { value: "all", label: "All" },
                  { value: "FT8", label: "FT8" },
                  { value: "FT4", label: "FT4" },
                ]}
              />
              <label className="flex cursor-pointer items-center gap-1.5 text-sm text-fg-muted">
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
            <EmptyState title="Nothing to chase" className="py-8">
              {newOnly
                ? "Every digital activator on the air right now is already in the log."
                : modeFilter === "all"
                  ? "No FT8 or FT4 activators spotted at the moment."
                  : `No ${modeFilter} activators spotted at the moment.`}
            </EmptyState>
          ) : (
            <CardTable label="POTA activators spotted on FT8 and FT4">
              <thead>
                <tr className="bg-surface-2 text-left">
                  <Th>Activator</Th>
                  <Th>Park</Th>
                  <Th className="text-right">Freq</Th>
                  <Th>Mode</Th>
                  <Th className="hidden md:table-cell">Where</Th>
                  <Th>Spotted</Th>
                  <Th>In the log</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {spots.map((s) => (
                  <tr key={s.spotId} className="hover:bg-surface-2">
                    <Td>
                      <Link
                        href={`/qsos?q=${encodeURIComponent(s.activator)}`}
                        className="font-display text-base tracking-wide hover:text-accent-bright"
                      >
                        {s.activator}
                      </Link>
                    </Td>
                    <Td>
                      <span className="tnum text-fg-muted">{s.reference}</span>
                      {s.parkName && (
                        <span className="block max-w-56 truncate text-xs text-fg-subtle">
                          {s.parkName}
                        </span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-right tnum">
                      {(s.freqHz / 1e6).toFixed(3)}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {/* Neutral: the mode is a label on every row, not news. */}
                      <Badge size="sm">{s.mode}</Badge>
                      {s.band && <span className="ml-1 text-xs text-fg-subtle">{s.band}</span>}
                    </Td>
                    <Td className="hidden text-xs text-fg-muted md:table-cell">
                      {s.location ?? "—"}
                    </Td>
                    <Td className="whitespace-nowrap text-xs tnum text-fg-subtle">
                      {formatAgo(s.spottedAt)} ago
                    </Td>
                    <Td>
                      {/* Three different answers, and they matter differently. Worked
                          TODAY almost certainly means this same activation — a dupe.
                          The park being in the log is an award fact. The activator
                          being known is neither, just context. */}
                      {s.workedToday ? (
                        <Badge size="sm" tone="warn">Today</Badge>
                      ) : s.workedPark ? (
                        <Badge size="sm">Park worked</Badge>
                      ) : s.workedActivator ? (
                        <Badge size="sm">Call worked</Badge>
                      ) : (
                        <Badge size="sm" tone="ok">New</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </CardTable>
          )}
        </Card>

        {p && p.awards.length > 0 && (
          <Card
            title={`POTA awards (${p.awardCount})`}
            actions={<Source>{plural(p.endorsementCount, "endorsement")}</Source>}
          >
            {/* Endorsements are most of what a POTA award says. "Bronze Hunter" alone is
                one line; "Bronze Hunter, endorsed on eleven bands and three modes" is the
                actual achievement, so they are all shown rather than counted. */}
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {p.awards.map((a) => (
                <li key={a.name} className="rounded-sm border border-line bg-surface-2 p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-display text-base tracking-wide">{a.name}</span>
                    {a.granted && (
                      <span className="whitespace-nowrap text-xs tnum text-fg-subtle">
                        {formatUtcDate(a.granted)}
                      </span>
                    )}
                  </div>
                  {a.endorsements.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {a.endorsements.map((e) => (
                        <Badge key={e} size="sm">
                          {e}
                        </Badge>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          {p && p.recentActivations.length > 0 && (
            <Card title="Your recent activations" actions={<Source>from pota.app</Source>}>
              <CardTable>
                <thead>
                  <tr className="bg-surface-2 text-left">
                    <Th>Date</Th>
                    <Th>Park</Th>
                    <Th className="text-right">CW</Th>
                    <Th className="text-right">Data</Th>
                    <Th className="text-right">Phone</Th>
                    <Th className="text-right">Total</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {p.recentActivations.map((a) => (
                    <tr key={`${a.date}-${a.reference}`}>
                      <Td className="whitespace-nowrap tnum text-fg-muted">{a.date}</Td>
                      <Td>
                        <span className="tnum">{a.reference}</span>
                        {a.park && (
                          <span className="block max-w-48 truncate text-xs text-fg-subtle">
                            {a.park}
                          </span>
                        )}
                      </Td>
                      <Td className="text-right tnum text-fg-subtle">{a.cw || "—"}</Td>
                      <Td className="text-right tnum text-fg-subtle">{a.data || "—"}</Td>
                      <Td className="text-right tnum text-fg-subtle">{a.phone || "—"}</Td>
                      {/* Ten is the threshold for a valid activation. */}
                      <Td
                        className={cn(
                          "text-right tnum",
                          a.total >= ACTIVATION_MINIMUM ? "text-ok" : "text-warn",
                        )}
                      >
                        {a.total}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </CardTable>
            </Card>
          )}

          <Card title="Park contacts in this log" actions={<Source>from your log</Source>}>
            {data.local.recent.length === 0 ? (
              <EmptyState title="None yet" className="py-8">
                Park references are recorded on contacts made from now on — by the POTA
                chase and hunt modes automatically, and by hand on any QSO. Your history
                before that lives in POTA&apos;s own totals.
              </EmptyState>
            ) : (
              <CardTable>
                <thead>
                  <tr className="bg-surface-2 text-left">
                    <Th>Time (UTC)</Th>
                    <Th>Callsign</Th>
                    <Th>Park</Th>
                    <Th>Band</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.local.recent.map((q) => (
                    <tr key={q.id} className="hover:bg-surface-2">
                      <Td className="whitespace-nowrap tnum text-fg-muted">
                        {formatUtc(q.startTime)}
                      </Td>
                      <Td>
                        <Link
                          href={`/qsos/${q.id}`}
                          className="font-display text-base tracking-wide hover:text-accent-bright"
                        >
                          {q.callsign}
                        </Link>
                      </Td>
                      <Td className="tnum text-fg-muted">
                        {/* Every park, not just the first. A two-fer showing one park
                            would read as a complete record and quietly under-count. */}
                        {q.references.length > 0 ? (
                          q.references.join(", ")
                        ) : (
                          <span className="text-fg-subtle">unknown</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-fg-subtle">
                        {q.band} {q.mode}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </CardTable>
            )}
          </Card>
        </div>

        <ImportPanel onDone={() => void reload()} />

        {p && (p.name || p.qth || p.grid) && (
          <p className="text-xs text-fg-subtle">
            POTA profile: {[p.name, p.qth, p.grid].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
    </>
  );
}


export const getServerSideProps = withPageAuth({ role: "VIEWER" });
