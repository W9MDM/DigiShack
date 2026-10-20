// Who has heard THIS station lately — the other direction from the decode list, which
// only says who we can hear. A CQ heard 6,000 km away says the station works whether or
// not anybody came back.

import { DetailRow } from "@/components/decodes/controls";
import { Button, Card } from "@/components/ui/primitives";
import { useApi } from "@/lib/client/api";
import { formatUtcTime } from "@/lib/time";

// `className` goes on the Card because the Card is the grid item that stretches to the
// row height; a wrapper would take the stretch instead.
export function HeardBy({ className }: { className?: string }) {
  const { data, error, loading, reload } = useApi<{
    since: string;
    receivers: {
      receiverCall: string;
      receiverGrid: string | null;
      bestSnr: number | null;
      reports: number;
      km: number | null;
      band: string | null;
    }[];
    totalReceivers: number;
    totalReports: number;
    furthest: { receiverCall: string; km: number } | null;
    truncated: boolean;
    /** Whether anything is actually asking PSKReporter. */
    collector?: {
      enabled: boolean;
      hasCallsign: boolean;
      lastQueryAt: string | null;
      running: boolean;
      detail: string;
    };
  }>("/api/psk-spots?minutes=60&limit=12");

  return (
    <Card title="Heard by" className={className}>
      {/* A panel that could not load must not look like a quiet band: the false "nobody
          heard you" is the version an operator acts on. */}
      {error ? (
        <div className="text-sm flex flex-col gap-2 items-start">
          <p className="text-danger">Could not load reception reports — {error.message}</p>
          <p className="text-fg-subtle text-xs">
            Retrying on its own. This says nothing about whether anyone can hear you.
          </p>
          <Button size="sm" onClick={() => void reload()}>
            Retry now
          </Button>
        </div>
      ) : !data && loading ? (
        <p className="text-sm text-fg-subtle">Loading reception reports…</p>
      ) : !data || data.totalReceivers === 0 ? (
        // Empty can also mean collection is off, nothing is asking, or no callsign is set —
        // and only one of those is about propagation.
        <div className="text-sm flex flex-col gap-2">
          {data?.collector?.detail ? (
            <>
              <p className="text-warn">{data.collector.detail}</p>
              <p className="text-fg-subtle text-xs">
                Until that is fixed this panel says nothing about whether anyone can hear you.
              </p>
            </>
          ) : (
            <>
              <p className="text-fg-subtle">
                Nobody yet, in the last hour. Reports come from PSKReporter a few minutes behind
                the transmission, and only when a receiver heard us and uploaded it.
              </p>
              <p className="text-fg-subtle text-xs">
                Asking every five minutes
                {data?.collector?.lastQueryAt ? `, last at ${formatUtcTime(data.collector.lastQueryAt)}` : ""}.
                Nobody can hear a station that has not transmitted — check the transmit gate if
                this stays empty while you are calling.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <dl className="text-sm flex flex-col gap-1.5">
            <DetailRow label="Receivers" value={`${data.totalReceivers} in the last hour`} />
            <DetailRow label="Reports" value={data.totalReports.toLocaleString()} />
            {data.furthest && (
              <DetailRow
                label="Furthest"
                value={`${data.furthest.receiverCall} · ${data.furthest.km.toLocaleString()} km`}
              />
            )}
          </dl>

          <ul className="flex flex-col divide-y divide-line -mx-4">
            {data.receivers.map((r) => (
              <li key={r.receiverCall} className="flex items-center gap-2 px-4 py-1 text-sm">
                <span className="font-display tracking-wide">{r.receiverCall}</span>
                {r.km !== null && (
                  <span className="tnum text-xs text-fg-subtle">{r.km.toLocaleString()} km</span>
                )}
                {/* Their best report of us; a missing one is a gap, not 0 dB. */}
                <span className="tnum ml-auto text-fg-muted">
                  {r.bestSnr === null ? "—" : `${r.bestSnr > 0 ? "+" : ""}${r.bestSnr} dB`}
                </span>
                {r.reports > 1 && <span className="tnum text-xs text-fg-subtle w-8 text-right">x{r.reports}</span>}
              </li>
            ))}
          </ul>
          {data.truncated && (
            <p className="text-xs text-fg-subtle">
              Strongest {data.receivers.length} of {data.totalReceivers}.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
