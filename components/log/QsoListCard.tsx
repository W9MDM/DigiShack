import Link from "next/link";

import { ResendQslButton } from "@/components/qsl/ResendQslButton";
import { Badge } from "@/components/ui/primitives";
import { formatDistance, gridDistanceKm, type DistanceUnit } from "@/lib/geo/distance";
import { formatFreqMHz } from "@/lib/ham/bands";
import { formatUtc } from "@/lib/time";
import type { Qso } from "@/lib/types";

import { qrzUrl } from "./links";
import { QslBadges } from "./QslBadges";

/** Distance from where we actually were — a portable contact's MY_GRIDSQUARE, else home. */
export function qsoDistance(qso: Qso, unit: DistanceUnit): string | null {
  const km = gridDistanceKm(qso.myGridSquare || qso.station.grid, qso.gridSquare);
  return km === null ? null : formatDistance(km, unit);
}

/** The park(s) they were in, compactly: "US-0765 +1", or the bare programme name. */
export function sigSummary(qso: Qso): { text: string; extra: number; title: string } | null {
  if (!qso.sig) return null;
  const refs = qso.sigRefs ?? [];
  return {
    text: qso.sigInfo ?? qso.sig,
    extra: Math.max(0, refs.length - 1),
    title: refs.length
      ? `${qso.sig} — ${refs.map((r) => r.sigInfo).join(", ")}`
      : qso.sigInfo
        ? `${qso.sig} — ${qso.sigInfo}`
        : `${qso.sig} — reference not known`,
  };
}

/**
 * One contact as a card, for widths where the table would scroll sideways. The callsign
 * link is stretched over the whole card; QRZ and re-send sit above it with `z-10`.
 */
export function QsoListCard({ qso, unit }: { qso: Qso; unit: DistanceUnit }) {
  const distance = qsoDistance(qso, unit);
  const sig = sigSummary(qso);
  return (
    <article className="relative rounded-md border border-line bg-surface px-3 py-2.5 shadow-panel transition-colors hover:bg-surface-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <Link
            href={`/qsos/${qso.id}`}
            className="truncate font-display text-lg tracking-wide text-fg after:absolute after:inset-0 after:rounded-md"
          >
            {qso.callsign}
          </Link>
          <a
            href={qrzUrl(qso.callsign)}
            target="_blank"
            rel="noopener noreferrer"
            className="tap-inline relative z-10 text-xs text-fg-subtle hover:text-fg"
          >
            QRZ<span aria-hidden="true">↗</span>
            <span className="sr-only">, {qso.callsign} on QRZ.com (opens in a new tab)</span>
          </a>
        </div>
        <time dateTime={qso.startTime} className="shrink-0 tnum text-xs text-fg-muted">
          {formatUtc(qso.startTime)}
        </time>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
        <Badge size="sm">{qso.band}</Badge>
        <Badge size="sm">{qso.mode}</Badge>
        <span className="tnum">{formatFreqMHz(qso.freqHz)}</span>
        {(qso.rstSent || qso.rstRcvd) && (
          <span className="tnum">
            {qso.rstSent ?? "—"}/{qso.rstRcvd ?? "—"}
          </span>
        )}
        {qso.gridSquare && (
          <span className="tnum">
            {qso.gridSquare}
            {distance && ` · ${distance}`}
          </span>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        {sig ? (
          <span className="tnum text-xs text-fg-subtle" title={sig.title}>
            {sig.text}
            {sig.extra > 0 && ` +${sig.extra}`}
          </span>
        ) : (
          <span />
        )}
        <span className="inline-flex items-center gap-1.5">
          <QslBadges qso={qso} />
          <span className="relative z-10">
            <ResendQslButton qsoId={qso.id} callsign={qso.callsign} />
          </span>
        </span>
      </div>
    </article>
  );
}
