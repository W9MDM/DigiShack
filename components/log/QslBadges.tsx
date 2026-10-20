import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

import { isConfirmed, qslChannels, type QslChannel, type QslFlags } from "./qsl";

function tone(c: QslChannel): "ok" | "info" | "neutral" {
  if (c.key === "qrz" && c.state === "confirmed") return "info";
  return c.state === "confirmed" ? "ok" : c.state === "sent" ? "info" : "neutral";
}

/**
 * The dense form, for table rows and cards: only channels with activity, in a fixed order.
 * Green with a tick is confirmed through that channel; blue is sent and waiting.
 */
export function QslBadges({ qso, className }: { qso: QslFlags; className?: string }) {
  const shown = qslChannels(qso).filter((c) => c.state !== "none");
  if (shown.length === 0) {
    return (
      <span className={cn("text-fg-subtle", className)}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">No QSL sent or received</span>
      </span>
    );
  }
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {shown.map((c) => (
        <span key={c.key} title={c.description}>
          <span aria-hidden="true">
            <Badge size="sm" tone={tone(c)} className="normal-case">
              {c.label}
              {c.state === "confirmed" ? " ✓" : ""}
            </Badge>
          </span>
          <span className="sr-only">{c.description}</span>
        </span>
      ))}
    </span>
  );
}

/** The full form, for the contact page: every channel, including the ones with nothing. */
export function QslStatusList({ qso, className }: { qso: QslFlags; className?: string }) {
  const confirmed = isConfirmed(qso);
  return (
    <div className={cn("flex flex-wrap items-center gap-x-5 gap-y-2", className)}>
      <Badge tone={confirmed ? "ok" : "neutral"}>{confirmed ? "Confirmed" : "Not confirmed"}</Badge>
      <dl className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {qslChannels(qso, { includeQrz: true }).map((c) => (
          <div key={c.key} className="flex items-center gap-1.5" title={c.description}>
            <dt className="text-fg-subtle">{c.key === "card" ? "Paper card" : c.label}</dt>
            <dd>
              <Badge size="sm" tone={tone(c)} className="normal-case">
                {c.state === "confirmed" && c.key !== "qrz" ? `✓ ${c.word}` : c.word}
              </Badge>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
