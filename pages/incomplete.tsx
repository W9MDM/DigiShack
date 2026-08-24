import { useCallback, useEffect, useState } from "react";

import { ToolTabs } from "@/components/settings/ToolTabs";
import { HelpTip } from "@/components/ui/HelpTip";
import { Badge, Button, Card, ErrorBanner, PageHeader, Textarea } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { useCan } from "@/lib/client/session";
import { formatFreqMHz } from "@/lib/ham/bands";
import { formatUtc } from "@/lib/time";

// Exchanges the sequencer gave up on, and the QRZ requests that corroborate them.
//
// These are NOT contacts. Each one reached the point where we sent the final roger and heard
// nothing back — which fits both a contact the far station kept and one they abandoned too, so
// nothing is promoted without a person saying so. What makes the difference is a second record:
// a card request, an eQSL confirmation, an email. The paste box is how the QRZ one gets in,
// because QRZ has no API for that queue.

interface Row {
  id: string;
  callsign: string;
  band: string;
  mode: string;
  freqHz: number | null;
  startedAt: string;
  endedAt: string;
  stage: string;
  reportSent: string | null;
  reportRcvd: string | null;
  gridSquare: string | null;
  reason: string;
  transcript: string | null;
  promotedQsoId: string | null;
  dismissedAt: string | null;
}

type Verdict = "in-log" | "promotable" | "wrong-date" | "unknown";

interface Reconciled {
  request: { requestedAt: string | null; qsoDate: string; callsign: string };
  verdict: Verdict;
  qso?: { id: string; startTime: string; band: string; mode: string; qrzSent: boolean };
  incomplete?: { id: string; startedAt: string; band: string; mode: string; reportSent: string | null; reportRcvd: string | null };
  workedAt?: string;
  note: string;
}

const TONE: Record<Verdict, "ok" | "info" | "warn" | "danger"> = {
  "in-log": "ok",
  promotable: "info",
  "wrong-date": "warn",
  unknown: "danger",
};

const LABEL: Record<Verdict, string> = {
  "in-log": "already logged",
  promotable: "can be promoted",
  "wrong-date": "date does not match",
  unknown: "no record",
};

export default function IncompletePage() {
  const isAdmin = useCan("ADMIN");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [outstanding, setOutstanding] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [paste, setPaste] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{
    requests: Reconciled[];
    unread: string[];
    duplicates: number;
    tally: Record<Verdict, number>;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/incomplete");
      const b = (await r.json()) as { rows: Row[]; outstanding: number; total: number };
      setRows(b.rows);
      setOutstanding(b.outstanding);
      setTotal(b.total);
    } catch {
      setError("Could not read the exchanges");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: "promote" | "dismiss" | "restore", because?: string) {
    setBusy(id);
    setError(null);
    try {
      const r = await fetch(`/api/incomplete/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, because }),
      });
      const b = (await r.json().catch(() => null)) as { error?: string } | null;
      if (!r.ok) {
        setError(b?.error ?? `Failed (${r.status})`);
        return;
      }
      await load();
      // The comparison is now stale — a promoted exchange changes its verdict.
      if (result) void check();
    } finally {
      setBusy(null);
    }
  }

  async function check() {
    setChecking(true);
    setError(null);
    try {
      const r = await fetch("/api/qrz/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paste }),
      });
      const b = (await r.json().catch(() => null)) as typeof result | { error?: string } | null;
      if (!r.ok) {
        setError((b as { error?: string })?.error ?? `Failed (${r.status})`);
        return;
      }
      setResult(b as typeof result);
    } catch {
      setError("Could not run the comparison");
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <ToolTabs />
      <PageHeader
        title="Incomplete exchanges"
        subtitle={
          rows
            ? `${outstanding} outstanding of ${total} recorded`
            : "Exchanges the sequencer gave up on"
        }
      />

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="flex flex-col gap-6">
        <Card title="Compare against QRZ card requests">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm text-fg-muted">
              Paste the incoming-QSL-request table from QRZ. Nothing is changed by comparing.
            </span>
            <HelpTip label="About the comparison">
              QRZ has no API for this queue — <code>REQUESTS</code>, <code>QSLREQ</code> and{" "}
              <code>INCOMING</code> all answer &quot;unrecognized command&quot; — so the list has
              to be pasted out of the browser. Select the table on the QRZ page and paste it
              whole; the row numbers and header are ignored.
              <br />
              <br />
              The <strong>QSO Date</strong> column is what gets matched, not Request Received.
              They are routinely months apart: one real row has a contact on 2025-10-25 against a
              request filed 2026-04-20.
              <br />
              <br />
              A request whose date matches no contact and no exchange is left alone rather than
              guessed at. If you have worked that station on other dates, either their date or
              ours is wrong, and nothing in the data says which.
            </HelpTip>
          </div>
          <Textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={6}
            placeholder={"1\t2026-01-08 19:59:53\t2026-01-05\tK9XYZ de EA8ATE"}
            className="font-mono text-xs"
          />
          <div className="flex items-center gap-3 mt-2">
            <Button
              variant="primary"
              disabled={checking || paste.trim() === ""}
              onClick={() => void check()}
            >
              {checking ? "Comparing…" : "Compare"}
            </Button>
            {result && (
              <span className="text-sm text-fg-muted">
                {result.requests.length} request{result.requests.length === 1 ? "" : "s"} read
                {result.duplicates > 0 ? `, ${result.duplicates} duplicate rows collapsed` : ""}
              </span>
            )}
          </div>
          {result && result.unread.length > 0 && (
            // Surfaced rather than dropped: a paste that lost rows must not look complete.
            <div className="mt-2 text-xs text-warn">
              {result.unread.length} line{result.unread.length === 1 ? "" : "s"} could not be
              read: <span className="font-mono">{result.unread.slice(0, 3).join(" | ")}</span>
            </div>
          )}
        </Card>

        {result && result.requests.length > 0 && (
          <Card
            title="Comparison"
            actions={
              <div className="flex gap-2 text-xs">
                {(Object.keys(LABEL) as Verdict[]).map((v) => (
                  <Badge key={v} tone={TONE[v]}>
                    {result.tally[v]} {LABEL[v]}
                  </Badge>
                ))}
              </div>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left">
                    {["QSO date", "Callsign", "Verdict", "What we hold", ""].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-2 font-medium text-fg-muted text-xs uppercase tracking-wide"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.requests.map((r, i) => (
                    <tr key={`${r.request.qsoDate}|${r.request.callsign}|${i}`}>
                      <td className="px-3 py-1.5 tnum whitespace-nowrap">{r.request.qsoDate}</td>
                      <td className="px-3 py-1.5 font-display tracking-wide">
                        {r.request.callsign}
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge tone={TONE[r.verdict]}>{LABEL[r.verdict]}</Badge>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-fg-muted">{r.note}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {/* Only a promotable row gets a button. A wrong-date row deliberately
                            has none: acting on it would be guessing whose date is wrong. */}
                        {r.verdict === "promotable" && r.incomplete && isAdmin && (
                          <Button
                            disabled={busy === r.incomplete.id}
                            onClick={() =>
                              void act(
                                r.incomplete!.id,
                                "promote",
                                `QRZ card request for ${r.request.qsoDate}`,
                              )
                            }
                          >
                            {busy === r.incomplete.id ? "Adding…" : "Add to log"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card title="Every recorded exchange">
          <p className="text-xs text-fg-subtle mb-3">
            Reports went both ways and no acknowledgement was decoded. The far station may have
            logged the contact; we cannot tell from here, which is why nothing is promoted
            automatically.
          </p>
          {rows === null ? (
            <p className="text-sm text-fg-subtle">Reading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-fg-subtle">
              Nothing outstanding. The bridge records these as they happen, so an empty list
              means every exchange since it started either completed or was dealt with.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left">
                    {["When", "Callsign", "Band", "Mode", "Sent", "Rcvd", "Stage", ""].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-2 font-medium text-fg-muted text-xs uppercase tracking-wide"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((x) => (
                    <tr key={x.id}>
                      <td className="px-3 py-1.5 tnum whitespace-nowrap" title={x.reason}>
                        {formatUtc(x.startedAt)}
                      </td>
                      <td className="px-3 py-1.5 font-display tracking-wide">{x.callsign}</td>
                      <td className="px-3 py-1.5 font-mono">{x.band}</td>
                      <td className="px-3 py-1.5 font-mono">{x.mode}</td>
                      <td className="px-3 py-1.5 tnum">{x.reportSent ?? "—"}</td>
                      <td className="px-3 py-1.5 tnum">{x.reportRcvd ?? "—"}</td>
                      <td className="px-3 py-1.5 text-xs text-fg-subtle">
                        {x.stage}
                        {x.freqHz ? ` · ${formatFreqMHz(x.freqHz)}` : ""}
                      </td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {isAdmin && (
                          <div className="flex gap-2">
                            <Button
                              disabled={busy === x.id}
                              onClick={() => void act(x.id, "promote")}
                            >
                              Add to log
                            </Button>
                            <button
                              type="button"
                              disabled={busy === x.id}
                              onClick={() => void act(x.id, "dismiss")}
                              className="text-xs text-fg-subtle hover:text-warn disabled:opacity-50"
                            >
                              Not a contact
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

export const getServerSideProps = withPageAuth({ role: "OPERATOR" });
