import { useCallback, useEffect, useState } from "react";

import { ToolTabs } from "@/components/settings/ToolTabs";
import { HelpTip } from "@/components/ui/HelpTip";
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  PageHeader,
  Td,
  Textarea,
  Th,
} from "@/components/ui/primitives";
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
//
// NOTHING HERE IS RECORDED BY THE WEB TIER. Every row is written by the sequencer inside the
// radio service, which is why this page also has to say whether that service is answering —
// see EmptyQueueNote at the bottom for the sentence that used to get this wrong.

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

  // THE EVIDENCE, without which this page cannot honestly describe an empty list.
  //
  // `bridge` stays null while unknown and is never assumed: "we have not asked yet" and "it
  // is not running" call for different sentences, and collapsing them would put the wrong
  // one on screen for the first second of every visit.
  const [bridge, setBridge] = useState<{ running: boolean; reason?: string } | null>(null);
  /** Newest exchange EVER recorded, promoted and dismissed included. undefined = not looked up. */
  const [lastRecordedAt, setLastRecordedAt] = useState<string | null | undefined>(undefined);

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

      // WHEN THE SEQUENCER LAST WROTE ONE — asked for only when the queue is empty.
      //
      // The default query returns outstanding rows only, so on an empty queue it carries no
      // date at all; `?all=1` includes the promoted and dismissed ones and is ordered newest
      // first. Fetched conditionally because it is up to 500 rows and is needed in exactly
      // one situation: the one where this page would otherwise have to guess.
      if (b.rows.length === 0 && b.total > 0) {
        try {
          const ra = await fetch("/api/incomplete?all=1");
          const ba = (await ra.json()) as { rows: Row[] };
          setLastRecordedAt(ba.rows[0]?.startedAt ?? null);
        } catch {
          // Not worth an error banner. The note falls back to a count — weaker evidence,
          // but still evidence, rather than back to the old unqualified claim.
          setLastRecordedAt(null);
        }
      }
    } catch {
      setError("Could not read the exchanges");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Is the radio service answering? It is the only thing that writes these rows, and
  // /api/bridge/status answers 200 with running:false rather than failing when it is not.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await fetch("/api/bridge/status");
        const b = (await r.json()) as { running?: boolean; reason?: string };
        if (live) setBridge({ running: b.running === true, reason: b.reason });
      } catch {
        // A failed request is not the same evidence as a bridge that answered "not running",
        // so it says which happened instead of borrowing the other one's wording.
        if (live) {
          setBridge({
            running: false,
            reason: "The status request itself failed, so this may be the page rather than the radio service.",
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);

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
              /* The button was off from the moment the page loaded and said nothing about
                 why. The box above it is empty and unlabelled apart from a placeholder,
                 so "greyed out" was the only signal, and greyed out reads as broken.
                 Not shown while `checking`, where the label already says "Comparing…". */
              disabledReason={
                paste.trim() === ""
                  ? "Paste the QRZ request table into the box above first."
                  : undefined
              }
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
                      <Th key={h}>{h}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.requests.map((r, i) => (
                    <tr key={`${r.request.qsoDate}|${r.request.callsign}|${i}`}>
                      <Td className="tnum whitespace-nowrap">{r.request.qsoDate}</Td>
                      <Td className="font-display tracking-wide">
                        {r.request.callsign}
                      </Td>
                      <Td>
                        <Badge tone={TONE[r.verdict]}>{LABEL[r.verdict]}</Badge>
                      </Td>
                      <Td className="text-xs text-fg-muted">{r.note}</Td>
                      <Td className="whitespace-nowrap">
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
                      </Td>
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
            <EmptyQueueNote bridge={bridge} total={total} lastRecordedAt={lastRecordedAt} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-left">
                    {["When", "Callsign", "Band", "Mode", "Sent", "Rcvd", "Stage", ""].map((h) => (
                      <Th key={h}>{h}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((x) => (
                    <tr key={x.id}>
                      <Td className="tnum whitespace-nowrap" title={x.reason}>
                        {formatUtc(x.startedAt)}
                      </Td>
                      <Td className="font-display tracking-wide">{x.callsign}</Td>
                      <Td className="font-mono">{x.band}</Td>
                      <Td className="font-mono">{x.mode}</Td>
                      <Td className="tnum">{x.reportSent ?? "—"}</Td>
                      <Td className="tnum">{x.reportRcvd ?? "—"}</Td>
                      <Td className="text-xs text-fg-subtle">
                        {x.stage}
                        {x.freqHz ? ` · ${formatFreqMHz(x.freqHz)}` : ""}
                      </Td>
                      <Td className="whitespace-nowrap">
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
                      </Td>
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

/**
 * What an empty queue actually means.
 *
 * THE FAULT. This card used to say, unconditionally:
 *
 *     "Nothing outstanding. The bridge records these as they happen, so an empty list means
 *      every exchange since it started either completed or was dealt with."
 *
 * The sentence names its own dependency and then draws the opposite conclusion from it. If
 * the bridge has never run, an empty list means nothing whatsoever — and the reading it
 * asserted is exactly the one an operator acts on: concluding the station has no failed
 * exchanges, when in truth nothing was watching for any.
 *
 * The same shape as the Uploads card (pages/api/uploads/index.ts) and the Heard-by panel
 * (pages/api/psk-spots.ts): a job that runs ONLY inside the radio service, and a page that
 * reports the absence of its output as a finding about the air.
 *
 * So the claim is made only where the evidence for it is on the page — the radio service
 * answering, and a date on which it last wrote one.
 *
 * ORDERED BY WHAT TO FIX FIRST, the same rule as `collectorState`: "nothing is recording"
 * outranks "none has ever been recorded", because the second is a consequence of the first
 * and sends the reader somewhere useless.
 */
function EmptyQueueNote({
  bridge,
  total,
  lastRecordedAt,
}: {
  bridge: { running: boolean; reason?: string } | null;
  total: number;
  lastRecordedAt: string | null | undefined;
}) {
  if (bridge === null) {
    return (
      <p className="text-sm text-fg-subtle">
        Nothing outstanding — checking whether anything is recording these…
      </p>
    );
  }

  if (!bridge.running) {
    return (
      <p className="text-sm text-danger">
        Nothing outstanding, <strong>and nothing is recording either</strong>. These rows are
        written by the sequencer inside the radio service as an exchange fails.{" "}
        {/* The bridge status route already answers with a full sentence naming the port and
            how to start it, so this prints it rather than paraphrasing it badly. */}
        {bridge.reason ?? "It is not answering."} Until it is running, an empty list here is a
        fact about this installation and not about the air.
        {total > 0 && lastRecordedAt
          ? ` The most recent one it ever wrote was ${formatUtc(lastRecordedAt)}.`
          : total > 0
            ? ` ${total} have been recorded in the past.`
            : " None has ever been recorded."}
      </p>
    );
  }

  if (total === 0) {
    return (
      <p className="text-sm text-fg-muted">
        Nothing outstanding, and none has ever been recorded. The radio service is answering,
        so from here on it writes a row whenever an exchange swaps reports and the final
        acknowledgement never decodes — but it has had no cause to yet, and nothing on this
        page covers the time before it was running.
      </p>
    );
  }

  return (
    <p className="text-sm text-fg-subtle">
      Nothing outstanding. The radio service is answering and{" "}
      {lastRecordedAt
        ? `last recorded one at ${formatUtc(lastRecordedAt)}`
        : `has recorded ${total} in all`}
      , so every exchange it has seen either completed or was dealt with.
    </p>
  );
}

export const getServerSideProps = withPageAuth({ role: "OPERATOR" });
