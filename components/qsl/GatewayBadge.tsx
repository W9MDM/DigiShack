import { HelpTip } from "@/components/ui/HelpTip";
import { Badge } from "@/components/ui/primitives";
import { detectGateway, rulesFor } from "@/lib/qsl/gateways";
import { cn } from "@/lib/utils";

/**
 * Marks an address that is a radio gateway or a forwarder rather than a mailbox.
 *
 * The rules live in lib/qsl/gateways.ts and are applied server-side at queue and send
 * time; this only reports them, so the badge cannot disagree with what was sent.
 *
 * The note is a HelpTip, not a `title`: a title never appears on a touch screen, and the
 * badge means nothing without it. `align="right"` because callers put this at the right
 * end of its line — a left-anchored 256px panel opens off the edge of a phone.
 */
export function GatewayBadge({ address, className }: { address: string; className?: string }) {
  const gateway = detectGateway(address);
  if (!gateway) return null;
  const { notes } = rulesFor(address);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      <Badge tone="warn" size="sm">
        {gateway === "winlink" ? "Winlink" : "arrl.net"}
      </Badge>
      <HelpTip
        align="right"
        label={gateway === "winlink" ? "About Winlink addresses" : "About arrl.net addresses"}
      >
        {notes.join(" ")}
      </HelpTip>
    </span>
  );
}
