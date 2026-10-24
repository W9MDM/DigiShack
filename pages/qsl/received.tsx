import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";

import { Notice, plural } from "@/components/qsl/controls";
import { QslSectionNav, StatusTabs, tabId, tabPanelId } from "@/components/qsl/QslNav";
import {
  AssignPanel,
  CardThumb,
  KIND_LABEL,
  MatchBadge,
  qsoLine,
  SafeLink,
  UnlinkButton,
  type ReceivedRow,
} from "@/components/qsl/ReceivedCards";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { formatUtc, formatUtcDate } from "@/lib/time";

// QSL cards OTHER operators emailed us, imported from the station mailbox.
//
// Five slices, because they need five different things from the operator: cards to look at,
// replies that confirm without a picture, items the importer could not place (a person picks
// the contact), notices whose card is behind a link, and bounces of our own cards. The import
// report sits above them, because "no cards" means nothing until it says whether anything
// looked.

type View = "cards" | "replies" | "review" | "notices" | "bounces";

const TABS: { id: View; label: string; tone?: "warn" }[] = [
  { id: "cards", label: "Cards" },
  { id: "replies", label: "Replies" },
  { id: "review", label: "To review", tone: "warn" },
  { id: "notices", label: "Notices" },
  { id: "bounces", label: "Bounces" },
];

const TAB_IDS = "qsl-received";

interface ImportReport {
  source: string;
  startedAt: string;
  finishedAt: string;
  scanned: number;
  alreadySeen: number;
  own: number;
  ignored: number;
  cards: number;
  replies: number;
  notices: number;
  bounces: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  images: number;
  rejected: string[];
  bounceList: { callsign: string | null; subject: string; at: string; note: string }[];
  ignoredSamples: string[];
  errors: string[];
  complete: boolean;
  error?: string;
}

interface Status {
  enabled: boolean;
  configProblem: string | null;
  running: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  detail: string;
  receiveProvider: string;
  sendProvider: string;
  lastReport: ImportReport | null;
}

interface ListResponse {
  view: View;
  rows: ReceivedRow[];
  counts: Record<View, number>;
  limit: number;
  status: Status;
}

function parseView(raw: string | string[] | undefined): View {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return TABS.some((t) => t.id === v) ? (v as View) : "cards";
}

const PROVIDER_LABEL: Record<string, string> = {
  graph: "Microsoft 365",
  imap: "IMAP (coming next)",
  gmail: "Gmail (coming next)",
};

function ReportCard({ status, onRan }: { status: Status | undefined; onRan: () => void }) {
  const isAdmin = useCan("ADMIN");
  const [busy, setBusy] = useState<"import" | "test" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const r = status?.lastReport ?? null;

  async function run(action: "import" | "test") {
    setBusy(action);
    setResult(null);
    try {
      if (action === "test") {
        const t = await apiPost<{ ok: boolean; detail: string }>("/api/qsl/received/run", { action });
        setResult({ ok: t.ok, text: t.detail });
      } else {
        const t = await apiPost<{ ran: boolean; reason: string | null; summary: string | null; error: string | null }>(
          "/api/qsl/received/run",
          { action },
        );
        setResult(
          !t.ran
            ? { ok: false, text: t.reason ?? "Nothing ran." }
            : t.error
              ? { ok: false, text: t.error }
              : { ok: true, text: t.summary ?? "Done." },
        );
        onRan();
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof ApiError ? err.message : "Request failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title="Import"
      className="mb-4"
      actions={
        isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={busy === "test"} disabled={busy !== null} onClick={() => void run("test")}>
              Test connection
            </Button>
            <Button size="sm" variant="primary" loading={busy === "import"} disabled={busy !== null} onClick={() => void run("import")}>
              Import now
            </Button>
          </div>
        ) : undefined
      }
    >
      {!status ? (
        <p className="text-sm text-fg-subtle">Checking…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-fg-subtle">Mailbox</dt>
            <dd className="text-right sm:text-left">{PROVIDER_LABEL[status.receiveProvider] ?? status.receiveProvider}</dd>
            <dt className="text-fg-subtle">Schedule</dt>
            <dd className="text-right sm:text-left">{status.enabled ? `every ${status.intervalMinutes} min` : "off"}</dd>
            <dt className="text-fg-subtle">Last run</dt>
            <dd className="tnum text-right sm:text-left">{status.lastRunAt ? formatUtc(status.lastRunAt) : "never"}</dd>
          </dl>

          {status.detail !== "" && (
            <p className={status.lastRunAt ? "text-sm text-warn" : "text-sm text-fg-muted"}>{status.detail}</p>
          )}
          {result && <p className={`text-sm ${result.ok ? "text-ok" : "text-danger"}`}>{result.text}</p>}

          {r && (
            <div className="rounded-sm border border-line bg-surface-2 px-3 py-2 text-sm">
              {r.error ? (
                <p className="text-danger">Last run failed: {r.error}</p>
              ) : (
                <dl className="grid grid-cols-2 gap-x-4 text-xs sm:grid-cols-4">
                  <dt className="text-fg-subtle">Messages read</dt>
                  <dd className="tnum text-right">{r.scanned}</dd>
                  <dt className="text-fg-subtle">Our own cards</dt>
                  <dd className="tnum text-right">{r.own}</dd>
                  <dt className="text-fg-subtle">New cards</dt>
                  <dd className="tnum text-right">{r.cards}</dd>
                  <dt className="text-fg-subtle">Replies</dt>
                  <dd className="tnum text-right">{r.replies}</dd>
                  <dt className="text-fg-subtle">Notices</dt>
                  <dd className="tnum text-right">{r.notices}</dd>
                  <dt className="text-fg-subtle">Matched</dt>
                  <dd className="tnum text-right text-ok">{r.matched}</dd>
                  <dt className="text-fg-subtle">To review</dt>
                  <dd className="tnum text-right">{r.ambiguous + r.unmatched}</dd>
                  <dt className="text-fg-subtle">Bounces</dt>
                  <dd className="tnum text-right">{r.bounces}</dd>
                  <dt className="text-fg-subtle">Not about a QSL</dt>
                  <dd className="tnum text-right">{r.ignored}</dd>
                  <dt className="text-fg-subtle">Already imported</dt>
                  <dd className="tnum text-right">{r.alreadySeen}</dd>
                </dl>
              )}
              {!r.complete && !r.error && <p className="mt-2 text-xs text-fg-subtle">More to read — the next run carries on.</p>}
              {r.errors.length > 0 && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-danger">{plural(r.errors.length, "error")}</summary>
                  <ul className="mt-1 list-disc pl-4 text-fg-muted">
                    {r.errors.map((e, i) => (
                      <li key={i} className="break-words">{e}</li>
                    ))}
                  </ul>
                </details>
              )}
              {r.rejected.length > 0 && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-fg-muted">{plural(r.rejected.length, "attachment")} not used as a card</summary>
                  <ul className="mt-1 list-disc pl-4 text-fg-muted">
                    {r.rejected.map((e, i) => (
                      <li key={i} className="break-all">{e}</li>
                    ))}
                  </ul>
                </details>
              )}
              {r.ignoredSamples.length > 0 && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-fg-muted">Examples of mail that was not a card</summary>
                  <ul className="mt-1 list-disc pl-4 text-fg-muted">
                    {r.ignoredSamples.map((e, i) => (
                      <li key={i} className="break-words">{e}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          <p className="text-xs text-fg-subtle">
            Read only — nothing in the mailbox is marked, moved or deleted. Settings live under{" "}
            <Link href="/settings?tab=qsl&group=qslinbound" className="text-accent-bright hover:underline">
              Settings → QSL
            </Link>
            . An emailed card is recorded on the contact as an emailed card, not as a paper card or
            LoTW confirmation, so it does not change award credit or anything uploaded.
          </p>
        </div>
      )}
    </Card>
  );
}

function Gallery({ rows, onChanged }: { rows: ReceivedRow[]; onChanged: () => void }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {rows.map((r) => (
        <li key={r.id} className="flex min-w-0 flex-col gap-1.5">
          <CardThumb row={r} />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-display tracking-wide">{r.callsign || "?"}</span>
            {r.matchStatus !== "MATCHED" && <MatchBadge status={r.matchStatus} />}
          </div>
          <span className="tnum text-xs text-fg-subtle">Received {formatUtcDate(r.receivedAt)}</span>
          {r.qso ? (
            <Link href={`/qsos/${r.qso.id}`} className="text-xs text-accent-bright hover:underline">
              {qsoLine(r.qso)}
            </Link>
          ) : (
            <span className="text-xs text-fg-subtle">Not linked to a contact — see To review</span>
          )}
          <UnlinkButton row={r} onChanged={onChanged} />
        </li>
      ))}
    </ul>
  );
}

function RowList({ rows, view, onChanged }: { rows: ReceivedRow[]; view: View; onChanged: () => void }) {
  return (
    <ul className="flex flex-col divide-y divide-line">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
          {r.imageUrl && <CardThumb row={r} className="sm:w-40 sm:shrink-0" />}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display tracking-wide">{r.callsign || "Unknown station"}</span>
              <Badge size="sm">{KIND_LABEL[r.kind]}</Badge>
              {view !== "bounces" && <MatchBadge status={r.matchStatus} />}
              <span className="tnum text-xs text-fg-subtle">{formatUtc(r.receivedAt)}</span>
            </div>
            <p className="break-words text-sm text-fg-muted">{r.subject}</p>
            <p className="break-all text-xs text-fg-subtle">From {r.sender}</p>
            {r.link && (
              <p className="text-sm">
                <SafeLink href={r.link}>{r.link}</SafeLink>
              </p>
            )}
            {r.matchNote && <p className="text-xs text-fg-subtle">{r.matchNote}</p>}
            {r.qso && (
              <Link href={`/qsos/${r.qso.id}`} className="text-sm text-accent-bright hover:underline">
                {r.qso.callsign} · {qsoLine(r.qso)}
              </Link>
            )}
            {view === "review" || (view === "notices" && r.matchStatus !== "MATCHED") ? (
              <AssignPanel row={r} onChanged={onChanged} />
            ) : (
              <div>
                <UnlinkButton row={r} onChanged={onChanged} />
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

const EMPTY: Record<View, { title: string; body: string }> = {
  cards: { title: "No cards yet", body: "Pictures of cards other operators email you appear here once imported." },
  replies: { title: "No replies yet", body: "Replies to the cards you email, and cards sent as text, appear here once matched." },
  review: { title: "Nothing to review", body: "Every imported card is linked to a contact or dismissed." },
  notices: { title: "No notices", body: "Emails saying a card is waiting on digiqsl, qslworld or eQSL appear here with their link." },
  bounces: { title: "No bounces", body: "When one of your emailed cards bounces, the bounce is listed here against the contact." },
};

export default function QslReceivedPage() {
  const router = useRouter();
  const view = parseView(router.query.tab);
  const api = useApi<ListResponse>(`/api/qsl/received?view=${view}`);
  const [notice, setNotice] = useState<string | null>(null);
  const fresh = api.data?.view === view ? api.data : null;
  const rows = fresh?.rows ?? [];

  function select(id: View) {
    if (id === view) {
      void api.reload();
      return;
    }
    void router.replace({ pathname: router.pathname, query: id === "cards" ? {} : { tab: id } }, undefined, {
      shallow: true,
      scroll: false,
    });
  }

  const changed = () => {
    setNotice("Saved.");
    void api.reload();
  };

  return (
    <>
      <PageHeader
        title="QSL cards received"
        subtitle="Cards other operators emailed you, matched to the log"
        actions={<QslSectionNav active="received" />}
      />

      <div className="mb-4 flex flex-col gap-2 empty:hidden">
        {api.error && <ErrorBanner>Could not load received cards ({api.error.message}). Trying again automatically.</ErrorBanner>}
        {notice && (
          <Notice tone="ok" onDismiss={() => setNotice(null)}>
            {notice}
          </Notice>
        )}
      </div>

      <ReportCard status={api.data?.status} onRan={() => void api.reload()} />

      <Card>
        <StatusTabs
          tabs={TABS.map((t) => ({ id: t.id, label: t.label, tone: t.tone, count: api.data?.counts?.[t.id] ?? null }))}
          active={view}
          onSelect={select}
          label="Which received items"
          idBase={TAB_IDS}
          className="-mx-4 -mt-1 px-2"
        />
        <div role="tabpanel" id={tabPanelId(TAB_IDS)} aria-labelledby={tabId(TAB_IDS, view)} className="pt-3">
          {!fresh ? (
            <p className="py-6 text-sm text-fg-subtle">{api.error ? "This list could not be loaded." : "Loading…"}</p>
          ) : rows.length === 0 ? (
            <EmptyState className="py-8" title={EMPTY[view].title}>
              {/* "Nothing yet" is only true once something has looked. */}
              {fresh.status.lastRunAt ? EMPTY[view].body : "No import has run yet, so this says nothing about your mailbox."}
            </EmptyState>
          ) : view === "cards" ? (
            <Gallery rows={rows} onChanged={changed} />
          ) : (
            <RowList rows={rows} view={view} onChanged={changed} />
          )}
          {fresh && rows.length >= fresh.limit && (
            <p className="mt-3 text-xs text-fg-subtle">Showing the newest {fresh.limit}.</p>
          )}
        </div>
      </Card>
    </>
  );
}

export const getServerSideProps = withPageAuth();
