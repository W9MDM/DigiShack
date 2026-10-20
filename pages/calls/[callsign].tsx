import Link from "next/link";
import { useRouter } from "next/router";
import type { MouseEvent, ReactNode } from "react";

import { BandModeGrid } from "@/components/log/BandModeGrid";
import { LinkButton, TextLink, qrzUrl } from "@/components/log/links";
import { Notice } from "@/components/log/Notice";
import { QslBadges } from "@/components/log/QslBadges";
import { HelpTip } from "@/components/ui/HelpTip";
import { Badge, Card, EmptyState, ErrorBanner, PageHeader, Td, Th } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { formatFreqMHz } from "@/lib/ham/bands";
import { formatUtc, formatUtcDate } from "@/lib/time";
import { cn } from "@/lib/utils";

// One station's history with us.
//
// The log can already be filtered to a callsign, and it answers this question badly: rows in
// date order, leaving the operator to work out from twenty of them whether 20 m is already
// confirmed. What is wanted is per band and mode, because that is the unit awards are counted
// in and the unit a decision to call is made in.

// A contact row is the way into that contact, and at the table's `sm` density it is about
// 28px tall: short of a thumb, with the next contact a few pixels away. Taller on a phone
// only; from sm up the cells are back to `py-1`.
const ROW_PAD = "py-2.5 sm:py-1";

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

  // The row opens the contact; its own link keeps its click.
  function openRow(e: MouseEvent<HTMLTableRowElement>, id: string) {
    if ((e.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    void router.push(`/qsos/${id}`);
  }

  const details: [string, string][] = [];
  if (data) {
    const all: [string, string | null][] = [
      ["Name", data.name],
      ["QTH", data.qth],
      ["Grid", data.gridSquare],
      ["State", data.state],
      ["DXCC", data.dxcc !== null ? String(data.dxcc) : null],
    ];
    for (const [label, value] of all) if (value) details.push([label, value]);
  }

  return (
    <>
      <PageHeader
        title={call.toUpperCase()}
        subtitle={
          data
            ? data.worked
              ? `${data.qsos.toLocaleString()} contact${data.qsos === 1 ? "" : "s"}, ${data.confirmedQsos.toLocaleString()} confirmed`
              : "Never worked"
            : undefined
        }
        actions={
          <>
            <LinkButton href={`/qsos?q=${encodeURIComponent(call)}`}>Open in log</LinkButton>
            {call && (
              <LinkButton href={qrzUrl(call)} kind="external" variant="ghost">
                QRZ
              </LinkButton>
            )}
            <LinkButton href="/stats" variant="ghost">
              Statistics
            </LinkButton>
          </>
        }
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {!data && !error && (
        <p role="status" className="text-sm text-fg-subtle">
          Reading the log…
        </p>
      )}

      {data && (
        <div className="flex flex-col gap-4 sm:gap-6">
          {/* The two flags that change what an operator should DO, above everything else.
              Further down they would be read after the decision was made. */}
          {data.doNotCall && (
            <Notice tone="danger">
              <span>
                <strong>On the do-not-call list.</strong> Automatic operating will not call
                them, and neither should you without a reason to think the entry is wrong.
              </span>
            </Notice>
          )}
          {data.qslOptOut && (
            <Notice tone="warn">
              <span>
                <strong>Has asked not to receive QSL email.</strong> Contacts are fine; cards
                are not.
              </span>
            </Notice>
          )}

          {!data.worked ? (
            <Card>
              <EmptyState title="Not in the log">
                No contact with {data.callsign} has ever been logged here — the answer the
                decodes page needs before calling someone.
              </EmptyState>
            </Card>
          ) : (
            <>
              <Card>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                  <SummaryItem label="Contacts">
                    <span className="font-display text-2xl">{data.qsos.toLocaleString()}</span>
                  </SummaryItem>
                  <SummaryItem label="Confirmed">
                    <span className="font-display text-2xl">
                      {data.confirmedQsos.toLocaleString()}
                    </span>
                    <span className="text-sm text-fg-muted"> of {data.qsos.toLocaleString()}</span>
                  </SummaryItem>
                  <SummaryItem label="First worked">{formatUtc(data.firstWorked)}</SummaryItem>
                  <SummaryItem label="Last worked">{formatUtc(data.lastWorked)}</SummaryItem>
                </dl>
                {details.length > 0 && (
                  <div className="mt-4 border-t border-line pt-3">
                    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                      {details.map(([label, value]) => (
                        <div key={label} className="flex gap-1.5">
                          <dt className="text-fg-subtle">{label}</dt>
                          <dd className="text-fg tnum">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-2 text-sm text-fg-subtle sm:text-xs">
                      From the most recent contact that recorded each field. A blank on a
                      newer contact does not erase what an older one knew.
                    </p>
                  </div>
                )}
              </Card>

              <Card
                title="Band and mode"
                actions={
                  <HelpTip label="About band and mode" align="right">
                    This is the unit that matters. A station confirmed on 20 m FT8 and merely
                    worked on 40 m FT8 is two different situations, and a single
                    &quot;confirmed&quot; flag on the callsign hides that.
                    <br />
                    <br />
                    Any confirmed contact confirms the slice. A later unconfirmed contact on the
                    same band and mode does not undo an earlier credit.
                  </HelpTip>
                }
              >
                <BandModeGrid slices={data.slices} />
                {/* On a phone, only the keys the grid uses: a sample chip for a state no
                    cell is in read as if this station had a contact in it. From sm up the
                    legend is unchanged, both keys always. */}
                <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-subtle">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5",
                      !data.slices.some((s) => s.confirmed) && "max-sm:hidden",
                    )}
                  >
                    <Badge size="sm" tone="ok">
                      ✓ 2
                    </Badge>
                    confirmed
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5",
                      !data.slices.some((s) => !s.confirmed) && "max-sm:hidden",
                    )}
                  >
                    <Badge size="sm">2</Badge>
                    worked, not confirmed
                  </span>
                  <span>Numbers are contacts.</span>
                </p>
              </Card>

              <Card
                title="Contacts"
                actions={
                  <span className="text-xs text-fg-subtle tnum">
                    {data.recent.length < data.qsos
                      ? `Latest ${data.recent.length} of ${data.qsos.toLocaleString()}`
                      : `All ${data.qsos.toLocaleString()}`}
                  </span>
                }
              >
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="text-left">
                        <Th size="sm">When (UTC)</Th>
                        <Th size="sm">Band</Th>
                        <Th size="sm">Mode</Th>
                        <Th size="sm" className="hidden sm:table-cell">
                          Frequency
                        </Th>
                        <Th size="sm" className="hidden sm:table-cell">
                          Sent
                        </Th>
                        <Th size="sm" className="hidden sm:table-cell">
                          Rcvd
                        </Th>
                        <Th size="sm">QSL</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.recent.map((q) => (
                        <tr
                          key={q.id}
                          className="cursor-pointer hover:bg-surface-2 focus-within:bg-surface-2"
                          onClick={(e) => openRow(e, q.id)}
                        >
                          <Td size="sm" className={cn(ROW_PAD, "tnum")}>
                            <Link
                              href={`/qsos/${q.id}`}
                              className="text-fg underline-offset-2 hover:underline"
                            >
                              {/* The date alone on a phone; the column is the narrowest there. */}
                              <span className="sm:hidden">{formatUtcDate(q.startTime)}</span>
                              <span className="hidden sm:inline">{formatUtc(q.startTime)}</span>
                            </Link>
                          </Td>
                          <Td size="sm" className={ROW_PAD}>
                            <Badge size="sm">{q.band}</Badge>
                          </Td>
                          <Td size="sm" className={ROW_PAD}>
                            <Badge size="sm">{q.mode}</Badge>
                          </Td>
                          <Td size="sm" className="hidden tnum text-fg-muted sm:table-cell">
                            {q.freqHz ? formatFreqMHz(q.freqHz) : "—"}
                          </Td>
                          <Td size="sm" className="hidden tnum text-fg-muted sm:table-cell">
                            {q.rstSent ?? "—"}
                          </Td>
                          <Td size="sm" className="hidden tnum text-fg-muted sm:table-cell">
                            {q.rstRcvd ?? "—"}
                          </Td>
                          <Td size="sm" className={ROW_PAD}>
                            <QslBadges qso={q} />
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.recent.length < data.qsos && (
                  <div className="mt-3">
                    <TextLink href={`/qsos?q=${encodeURIComponent(data.callsign)}`} className="text-sm">
                      See all {data.qsos.toLocaleString()} in the log
                    </TextLink>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      )}
    </>
  );
}

function SummaryItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm text-fg tnum">{children}</dd>
    </div>
  );
}

export const getServerSideProps = withPageAuth();
