import Link from "next/link";
import { formatUtc } from "@/lib/time";
import { useMemo, useState } from "react";

import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import { formatFreqMHz } from "@/lib/ham/bands";
import { cn } from "@/lib/utils";

// Physical QSL cards: who is owed one, marking batches in and out, and a
// print-ready label sheet.
//
// Batch-oriented rather than per-contact, because that is how cards are actually
// worked — a stack gets written, posted via the bureau, and the whole batch is
// recorded at once.

type Route = "BUREAU" | "DIRECT" | "MANAGER";

interface CardQso {
  id: string;
  callsign: string;
  band: string;
  mode: string;
  startTime: string;
  freqHz: number;
  rstSent: string | null;
  rstRcvd: string | null;
  gridSquare: string | null;
  qslSent: string;
  qslRcvd: string;
  qslSentVia: Route | null;
  qslRcvdVia: Route | null;
  qslSentAt: string | null;
  station: { callsign: string; grid: string } | null;
}

export default function QslCardsPage() {
  const [which, setWhich] = useState<"owed" | "sent" | "received">("owed");
  const { data, error, reload } = useApi<{ qsos: CardQso[]; counts: Record<string, number> }>(
    `/api/qsl/cards?which=${which}`,
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [route, setRoute] = useState<Route>("BUREAU");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  const qsos = data?.qsos ?? [];
  const chosen = useMemo(() => qsos.filter((q) => selected.has(q.id)), [qsos, selected]);

  async function act(action: string) {
    if (selected.size === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiPost("/api/qsl/cards", {
        action,
        qsoIds: [...selected],
        ...(action === "mark-requested" ? {} : { via: route }),
      });
      setSelected(new Set());
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function toggleAll() {
    setSelected((s) => (s.size === qsos.length ? new Set() : new Set(qsos.map((q) => q.id))));
  }

  // The print sheet is rendered in the page and shown only for printing, so it
  // inherits the same data with no second request and no popup blocker to fight.
  if (printing) {
    return (
      <>
        <style>{`
          @media print {
            .no-print { display: none !important; }
            @page { margin: 10mm; }
          }
          .labels { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6mm; }
          .label {
            border: 1px solid #999; padding: 4mm; font-family: monospace;
            font-size: 10pt; color: #000; background: #fff; break-inside: avoid;
          }
        `}</style>
        <div className="no-print mb-4 flex gap-2">
          <Button variant="primary" onClick={() => window.print()}>
            Print
          </Button>
          <Button onClick={() => setPrinting(false)}>Back</Button>
          <span className="text-sm text-fg-subtle self-center">
            {chosen.length} card{chosen.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="labels bg-white p-4">
          {chosen.map((q) => (
            <div key={q.id} className="label">
              <div style={{ fontWeight: "bold", fontSize: "13pt" }}>{q.callsign}</div>
              <div>
                {formatUtc(q.startTime)}
              </div>
              <div>
                {q.band} · {q.mode} · {formatFreqMHz(q.freqHz)} MHz
              </div>
              <div>
                RST sent {q.rstSent ?? "—"}
                {q.rstRcvd ? ` · rcvd ${q.rstRcvd}` : ""}
              </div>
              {q.gridSquare && <div>Grid {q.gridSquare}</div>}
              <div style={{ marginTop: "2mm", borderTop: "1px solid #ccc", paddingTop: "1mm" }}>
                Confirming QSO with {q.station?.callsign ?? ""}
                {q.station?.grid ? ` (${q.station.grid})` : ""} · TNX 73
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="QSL cards"
        subtitle="Paper cards: who is owed one, and recording batches in and out"
        actions={
          <Link href="/qsl" className="text-sm text-accent-bright hover:underline">
            ← Email queue
          </Link>
        }
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {actionError && (
        <div className="mb-4">
          <ErrorBanner>{actionError}</ErrorBanner>
        </div>
      )}

      <Card
        title={`${which === "owed" ? "Owed a card" : which === "sent" ? "Cards sent" : "Cards received"} (${qsos.length})`}
        actions={
          <div className="flex flex-wrap gap-2 items-center">
            <Select
              value={which}
              onChange={(e) => {
                setWhich(e.target.value as typeof which);
                setSelected(new Set());
              }}
              className="w-40"
            >
              <option value="owed">Owed a card</option>
              <option value="sent">Sent</option>
              <option value="received">Received</option>
            </Select>
            <Select value={route} onChange={(e) => setRoute(e.target.value as Route)} className="w-32">
              <option value="BUREAU">Bureau</option>
              <option value="DIRECT">Direct</option>
              <option value="MANAGER">Manager</option>
            </Select>
            <Button
              variant="primary"
              disabled={busy || selected.size === 0}
              onClick={() => void act("mark-sent")}
            >
              Mark sent
            </Button>
            <Button
              disabled={busy || selected.size === 0}
              onClick={() => void act("mark-received")}
            >
              Mark received
            </Button>
            <Button
              disabled={busy || selected.size === 0}
              onClick={() => setPrinting(true)}
            >
              Labels ({selected.size})
            </Button>
          </div>
        }
      >
        {qsos.length === 0 ? (
          <p className="text-sm text-fg-subtle">
            {which === "owed"
              ? "Nothing owed. A contact lands here when their card arrives, or when you mark one as requested."
              : "Nothing here yet."}
          </p>
        ) : (
          <div className="overflow-auto -mx-4 max-h-[32rem]">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-surface-2">
                <tr className="text-left">
                  <th className="px-3 py-1.5 w-8">
                    <input
                      type="checkbox"
                      checked={selected.size === qsos.length && qsos.length > 0}
                      onChange={toggleAll}
                      className="accent-accent"
                    />
                  </th>
                  {["Call", "UTC", "Band", "Mode", "Sent", "Rcvd"].map((h) => (
                    <th
                      key={h}
                      className="px-2 py-1.5 font-medium text-fg-muted text-xs uppercase tracking-wide"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line font-mono text-xs">
                {qsos.map((q) => (
                  <tr
                    key={q.id}
                    className={cn("hover:bg-surface-2", selected.has(q.id) && "bg-accent/10")}
                  >
                    <td className="px-3 py-1">
                      <input
                        type="checkbox"
                        checked={selected.has(q.id)}
                        onChange={() =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (n.has(q.id)) n.delete(q.id);
                            else n.add(q.id);
                            return n;
                          })
                        }
                        className="accent-accent"
                      />
                    </td>
                    <td className="px-2 py-1">{q.callsign}</td>
                    <td className="px-2 py-1 tnum text-fg-subtle whitespace-nowrap">
                      {formatUtc(q.startTime)}
                    </td>
                    <td className="px-2 py-1 tnum">{q.band}</td>
                    <td className="px-2 py-1 text-fg-muted">{q.mode}</td>
                    <td className="px-2 py-1">
                      {q.qslSent === "NONE" ? (
                        <span className="text-fg-subtle">—</span>
                      ) : (
                        <Badge tone={q.qslSent === "SENT" ? "ok" : "accent"}>
                          {q.qslSentVia ? q.qslSentVia[0] : q.qslSent[0]}
                        </Badge>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      {q.qslRcvd === "NONE" ? (
                        <span className="text-fg-subtle">—</span>
                      ) : (
                        <Badge tone="ok">{q.qslRcvdVia ? q.qslRcvdVia[0] : "Y"}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-[10px] text-fg-subtle">
          The route (bureau, direct, manager) is stored as ADIF QSL_SENT_VIA and
          QSL_RCVD_VIA, so it survives export. An inbound card is recorded as
          CONFIRMED — that is what the awards page counts.
        </p>
      </Card>
    </>
  );
}

export const getServerSideProps = withPageAuth({ role: "OPERATOR" });
