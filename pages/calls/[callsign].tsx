import Link from "next/link";
import { useRouter } from "next/router";

import { HelpTip } from "@/components/ui/HelpTip";
import { Badge, Button, Card, ErrorBanner, PageHeader } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { formatFreqMHz } from "@/lib/ham/bands";
import { formatUtc } from "@/lib/time";

// One station's history with us.
//
// The log can already be filtered to a callsign, and it answers this question badly: rows in
// date order, leaving the operator to work out from twenty of them whether 20 m is already
// confirmed. What is wanted is per band and mode, because that is the unit awards are counted
// in and the unit a decision to call is made in.

interface Slice {
  band: string;
  mode: string;
  qsos: number;
  confirmed: boolean;
  lastWorked: string;
}

interface History {
  callsign: string;
  worked: boolean;
  qsos: number;
  firstWorked: string | null;
  lastWorked: string | null;
  bands: string[];
  modes: string[];
  confirmedQsos: number;
  slices: Slice[];
  name: string | null;
  qth: string | null;
  gridSquare: string | null;
  dxcc: number | null;
  state: string | null;
  doNotCall: boolean;
  qslOptOut: boolean;
  recent: {
    id: string;
    startTime: string;
    band: string;
    mode: string;
    freqHz: number | null;
    rstSent: string | null;
    rstRcvd: string | null;
    confirmed: boolean;
    lotwRcvd: boolean;
    eqslRcvd: boolean;
    qslRcvd: string;
  }[];
}

export default function CallsignPage() {
  const router = useRouter();
  const call = typeof router.query.callsign === "string" ? router.query.callsign : "";
  const { data, error } = useApi<History>(
    call ? `/api/callsign/${encodeURIComponent(call)}` : null,
  );

  return (
    <>
      <PageHeader
        title={call.toUpperCase()}
        subtitle={
          data
            ? data.worked
              ? `${data.qsos} contact${data.qsos === 1 ? "" : "s"}, ${data.confirmedQsos} confirmed`
              : "Never worked"
            : undefined
        }
        actions={
          <>
            <Link href={`/qsos?q=${encodeURIComponent(call)}`}>
              <Button>Open in log</Button>
            </Link>
            <Link href="/stats">
              <Button>Statistics</Button>
            </Link>
          </>
        }
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {!data && !error && <p className="text-sm text-fg-subtle">Reading the log…</p>}

      {data && (
        <div className="flex flex-col gap-6">
          {/* The two flags that change what an operator should DO, above everything else.
              Buried further down they would be read after the decision was made. */}
          {data.doNotCall && (
            <div className="border border-danger/40 bg-danger/10 text-danger text-sm px-3 py-2 rounded-sm">
              <strong>On the do-not-call list.</strong> Automatic operating will not call them,
              and neither should you without a reason to think the entry is wrong.
            </div>
          )}
          {data.qslOptOut && (
            <div className="border border-warn/40 bg-warn/10 text-warn text-sm px-3 py-2 rounded-sm">
              <strong>Has asked not to receive QSL email.</strong> Contacts are fine; cards are
              not.
            </div>
          )}

          {!data.worked ? (
            <Card title="Not in the log">
              <p className="text-sm text-fg-muted">
                No contact with {data.callsign} has ever been logged here. That is the answer
                the decodes page needs before calling someone, so it is reported rather than
                treated as a missing page.
              </p>
            </Card>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Card title="First worked">
                  <div className="text-sm tnum">{formatUtc(data.firstWorked!)}</div>
                </Card>
                <Card title="Last worked">
                  <div className="text-sm tnum">{formatUtc(data.lastWorked!)}</div>
                </Card>
                <Card title="Bands">
                  <div className="text-sm font-mono">{data.bands.join(", ")}</div>
                </Card>
                <Card title="Modes">
                  <div className="text-sm font-mono">{data.modes.join(", ")}</div>
                </Card>
              </div>

              {(data.name || data.qth || data.gridSquare || data.state) && (
                <Card title="From the log">
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    {data.name && (
                      <span>
                        <span className="text-fg-subtle">Name</span> {data.name}
                      </span>
                    )}
                    {data.qth && (
                      <span>
                        <span className="text-fg-subtle">QTH</span> {data.qth}
                      </span>
                    )}
                    {data.gridSquare && (
                      <span>
                        <span className="text-fg-subtle">Grid</span>{" "}
                        <span className="font-mono">{data.gridSquare}</span>
                      </span>
                    )}
                    {data.state && (
                      <span>
                        <span className="text-fg-subtle">State</span> {data.state}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-fg-subtle mt-2">
                    The most recent contact that recorded each field. A blank on a newer
                    contact does not erase what an older one knew.
                  </p>
                </Card>
              )}
              <Card title="Band and mode">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs text-fg-subtle">
                    Every band and mode this station has been worked on, and whether it is
                    confirmed.
                  </span>
                  <HelpTip label="About band and mode">
                    This is the unit that matters. A station confirmed on 20 m FT8 and merely
                    worked on 40 m FT8 is two different situations, and a single
                    &quot;confirmed&quot; flag on the callsign hides that — which is exactly why
                    filtering the log to a callsign answers the question badly.
                    <br />
                    <br />
                    Any confirmed contact confirms the slice. A later unconfirmed contact on the
                    same band and mode does not undo an earlier credit.
                  </HelpTip>
                </div>
                <div className="flex flex-wrap gap-2">
                  {data.slices.map((s) => (
                    <div
                      key={`${s.band}|${s.mode}`}
                      className={`rounded border px-2 py-1 text-xs ${
                        s.confirmed
                          ? "border-ok/50 bg-ok/10"
                          : "border-line bg-bg-subtle/40"
                      }`}
                      title={`Last worked ${formatUtc(s.lastWorked)}`}
                    >
                      <div className="font-mono font-medium">
                        {s.band} {s.mode}
                      </div>
                      <div className="text-fg-subtle tnum">
                        {s.qsos}×{s.confirmed ? " · confirmed" : " · unconfirmed"}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card title={`Contacts (${data.recent.length} of ${data.qsos})`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="text-left">
                        {["When", "Band", "Mode", "Frequency", "Sent", "Rcvd", "QSL"].map((h) => (
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
                      {data.recent.map((q) => (
                        <tr key={q.id}>
                          <td className="px-3 py-1.5 tnum whitespace-nowrap">
                            <Link
                              href={`/qsos/${q.id}`}
                              className="hover:text-accent-bright"
                            >
                              {formatUtc(q.startTime)}
                            </Link>
                          </td>
                          <td className="px-3 py-1.5 font-mono">{q.band}</td>
                          <td className="px-3 py-1.5 font-mono">{q.mode}</td>
                          <td className="px-3 py-1.5 tnum text-fg-muted">
                            {q.freqHz ? formatFreqMHz(q.freqHz) : "—"}
                          </td>
                          <td className="px-3 py-1.5 tnum text-fg-muted">{q.rstSent ?? "—"}</td>
                          <td className="px-3 py-1.5 tnum text-fg-muted">{q.rstRcvd ?? "—"}</td>
                          <td className="px-3 py-1.5">
                            <div className="flex gap-1">
                              {q.lotwRcvd && <Badge tone="ok">L</Badge>}
                              {q.eqslRcvd && <Badge tone="ok">e</Badge>}
                              {q.qslRcvd === "CONFIRMED" && <Badge tone="ok">Card</Badge>}
                              {!q.confirmed && <span className="text-fg-subtle">—</span>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>
      )}
    </>
  );
}

export const getServerSideProps = withPageAuth();
