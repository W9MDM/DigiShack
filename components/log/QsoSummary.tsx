import type { ReactNode } from "react";

import { Badge, Card } from "@/components/ui/primitives";
import { useDistanceUnit } from "@/lib/client/use-distance-unit";
import { formatFreqMHz } from "@/lib/ham/bands";
import { formatUtc, formatUtcDate } from "@/lib/time";
import type { Qso } from "@/lib/types";

import { QslStatusList } from "./QslBadges";
import { qsoDistance } from "./QsoListCard";

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="truncate text-sm text-fg tnum">{children}</dd>
    </div>
  );
}

/** The saved record at a glance, above the edit form: what, when, how far, confirmed. */
export function QsoSummary({ qso, className }: { qso: Qso; className?: string }) {
  const [unit] = useDistanceUnit();
  const distance = qsoDistance(qso, unit);
  const refs = qso.sigRefs?.length
    ? [...qso.sigRefs].sort((a, b) => Number(b.primary) - Number(a.primary)).map((r) => r.sigInfo)
    : qso.sigInfo
      ? [qso.sigInfo]
      : [];
  // Same UTC day: the end only needs its time.
  const end = qso.endTime
    ? formatUtcDate(qso.endTime) === formatUtcDate(qso.startTime)
      ? formatUtc(qso.endTime).slice(11)
      : formatUtc(qso.endTime)
    : null;
  const entity = [
    qso.dxcc !== null ? String(qso.dxcc) : null,
    qso.continent,
    qso.cqZone !== null ? `CQ ${qso.cqZone}` : null,
  ].filter(Boolean);

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge>{qso.band}</Badge>
        <Badge>{qso.mode}</Badge>
        <span className="font-display text-xl tnum">
          {formatFreqMHz(qso.freqHz)} <span className="text-sm text-fg-muted">MHz</span>
        </span>
        <span className="text-sm text-fg-muted tnum">
          <time dateTime={qso.startTime}>{formatUtc(qso.startTime)}</time>
          {end && qso.endTime && (
            <>
              {" – "}
              <time dateTime={qso.endTime}>{end}</time>
            </>
          )}
        </span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 xl:grid-cols-6">
        <Item label="RST sent / rcvd">
          {qso.rstSent ?? "—"} / {qso.rstRcvd ?? "—"}
        </Item>
        <Item label="Grid">{qso.gridSquare ?? "—"}</Item>
        <Item label="Distance">{distance ?? "—"}</Item>
        <Item label="Station">
          {qso.station.callsign}
          {qso.operator && <span className="text-fg-muted"> / {qso.operator.callsign}</span>}
        </Item>
        {qso.name && <Item label="Name">{qso.name}</Item>}
        {qso.qth && <Item label="QTH">{qso.qth}</Item>}
        {qso.state && <Item label="State">{qso.state}</Item>}
        {entity.length > 0 && <Item label="DXCC">{entity.join(" · ")}</Item>}
        {qso.iota && <Item label="IOTA">{qso.iota}</Item>}
        {qso.sig && (
          <Item label="Their park">
            {qso.sig} {refs.join(", ")}
          </Item>
        )}
        {qso.mySigInfo && (
          <Item label="Your activation">
            {qso.mySig ?? "POTA"} {qso.mySigInfo}
          </Item>
        )}
      </dl>

      <div className="mt-4 border-t border-line pt-3">
        <h2 className="sr-only">Confirmations</h2>
        <QslStatusList qso={qso} />
      </div>
    </Card>
  );
}
