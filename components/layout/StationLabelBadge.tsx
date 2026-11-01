import { useApi } from "@/lib/client/api";
import { useUser } from "@/lib/client/session";

/**
 * Which station this is, beside the logo: "Trailer - Flex 6600".
 *
 * At a special event six installs can all be K9PC in six browser tabs, and
 * every one of them looks identical without this. Nothing is shown when the
 * location and description are both blank, so a single home station's header
 * is unchanged. Desktop only: the phone header has no width to spare.
 */
export function StationLabelBadge() {
  const user = useUser();
  const { data } = useApi<{ location: string | null; description: string | null }>(user ? "/api/station/label" : null);
  const line = [data?.location, data?.description].filter(Boolean).join(" - ");
  if (!line) return null;
  return (
    <span
      className="hidden lg:inline-block max-w-[18rem] truncate rounded-sm border border-line px-2 py-0.5 text-xs text-fg-muted"
      title={line}
    >
      {line}
    </span>
  );
}
