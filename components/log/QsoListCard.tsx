import Link from "next/link";

import { ResendQslButton } from "@/components/qsl/ResendQslButton";
import { Badge } from "@/components/ui/primitives";
import { formatDistance, gridDistanceKm, type DistanceUnit } from "@/lib/ham/grid-geometry";
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
 * The card's frequency: MHz to the kHz, "14.075". The full-precision value, which on a
 * digital contact is dial plus audio offset ("14.075208"), is ragged from row to row and
 * long enough to push the details line onto a second row at phone width. The kHz is what
 * a reader scans a list for; the contact page and the hover title carry every Hz.
 */
function cardFreq(hz: number): string {
  return Number.isFinite(hz) && hz > 0 ? (hz / 1_000_000).toFixed(3) : "—";
}

/**
 * One contact as a card, for widths where the table would scroll sideways. The callsign
 * link is stretched over the whole card; QRZ and re-send sit above it with `z-10`.
 *
 * Two lines, not three. The QSL badges and re-send ride in the top row, before the time,
 * so the details line under the call carries only radio data and fits a phone's width.
 * At the end of the details line they dropped to a third row on most contacts that had a
 * grid. If a long call and several badges do not fit, the right-hand group wraps under
 * the call, still right-aligned, rather than truncating the call.
 *
 * `dateless`: the list shows a date heading where the day changes, so the card shows the
 * time alone. Only when the list is in time order; sorted by call or band, every card
 * keeps its full date because neighbouring cards can be years apart.
 */
export function QsoListCard({
  qso,
  unit,
  dateless = false,
}: {
  qso: Qso;
  unit: DistanceUnit;
  dateless?: boolean;
}) {
  const distance = qsoDistance(qso, unit);
  const sig = sigSummary(qso);
  const stamp = formatUtc(qso.startTime);
  return (
    <article className="relative rounded-md border border-line bg-surface px-3 py-2 shadow-panel transition-colors hover:bg-surface-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <Link
            href={`/qsos/${qso.id}`}
            className="truncate font-display text-lg tracking-wide text-fg after:absolute after:inset-0 after:rounded-md"
          >
            {qso.callsign}
          </Link>
          {/* `-m-2 p-2` grows what a thumb can hit without moving the text: a miss here
              lands on the card's own link and opens the contact instead of QRZ. */}
          <a
            href={qrzUrl(qso.callsign)}
            target="_blank"
            rel="noopener noreferrer"
            className="tap-inline relative z-10 -m-2 p-2 text-xs text-fg-subtle hover:text-fg"
          >
            QRZ<span aria-hidden="true">↗</span>
            <span className="sr-only">, {qso.callsign} on QRZ.com (opens in a new tab)</span>
          </a>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <QslBadges qso={qso} />
          <span className="relative z-10">
            <ResendQslButton qsoId={qso.id} callsign={qso.callsign} />
          </span>
          <time dateTime={qso.startTime} title={stamp} className="tnum text-xs text-fg-muted">
            {dateless && stamp.length > 11 ? stamp.slice(11) : stamp}
          </time>
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
        <Badge size="sm">{qso.band}</Badge>
        <Badge size="sm">{qso.mode}</Badge>
        <span className="tnum" title={`${formatFreqMHz(qso.freqHz)} MHz`}>
          {cardFreq(qso.freqHz)}
        </span>
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
        {sig && (
          <span className="tnum text-xs text-fg-subtle" title={sig.title}>
            {sig.text}
            {sig.extra > 0 && ` +${sig.extra}`}
          </span>
        )}
      </div>
    </article>
  );
}
