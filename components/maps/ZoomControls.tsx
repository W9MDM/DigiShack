import { Button } from "@/components/ui/primitives";

/**
 * The strip above a map: how to drive it, and buttons for anyone without a wheel or a
 * second finger. Above the map rather than floating on it, so on a phone nothing covers the
 * map — at coarse-pointer sizes three 44 px buttons would hide a third of it.
 */
export function ZoomControls({
  zoomed,
  onZoom,
  onReset,
  hint,
  touchHint,
}: {
  zoomed: boolean;
  onZoom: (factor: number) => void;
  onReset: () => void;
  hint: string;
  touchHint: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 border-b border-line">
      <p className="text-xs text-fg-subtle">
        <span className="[@media(pointer:coarse)]:hidden">{hint}</span>
        <span className="hidden [@media(pointer:coarse)]:inline">{touchHint}</span>
      </p>
      {/* The coarse-pointer rule in globals.css makes these 44px tall on a phone but leaves
          the width alone, so − and + were 44 by 32: a narrow target for a thumb, sat right
          next to each other. Squared up there; the mouse size is unchanged. */}
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label="Zoom out"
          className="w-8 [@media(pointer:coarse)]:w-11"
          onClick={() => onZoom(1 / 0.7)}
        >
          −
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Zoom in"
          className="w-8 [@media(pointer:coarse)]:w-11"
          onClick={() => onZoom(0.7)}
        >
          +
        </Button>
        <Button size="sm" variant="ghost" disabled={!zoomed} onClick={onReset}>
          Reset view
        </Button>
      </div>
    </div>
  );
}
