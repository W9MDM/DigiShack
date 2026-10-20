import { useEffect, useMemo, useState } from "react";

import { HelpTip } from "@/components/ui/HelpTip";
import { cn } from "@/lib/utils";
import { helpPreview, highlightSegments, matchesAllTerms } from "@/lib/settings/search";

/** Text with the search terms marked. */
export function Highlight({ text, terms }: { text: string; terms: readonly string[] }) {
  if (terms.length === 0) return <>{text}</>;
  return (
    <>
      {highlightSegments(text, terms).map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="rounded-sm bg-warn/25 px-px text-fg">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Help that shows its first sentence, with the rest behind the ? icon, once it runs long.
 *
 * Every field on the page used to print its whole explanation — some of them 900
 * characters — so the page was mostly paragraphs with the controls lost between them. The
 * explanations are good and the reason the page is usable at all, so none is cut: the
 * first sentence stays in view and the rest is one tap away, in the same ? popover used
 * across the app (a "More" link on every field read as clutter).
 *
 * `full` turns the toggle off, for the safety settings, whose consequences should never
 * be behind a click. A search hit in the hidden part opens it, so a match is never
 * highlighted where nobody can see it.
 */
export function HelpText({
  id,
  text,
  terms = [],
  full = false,
  subject,
  className,
}: {
  id?: string;
  text: string;
  terms?: readonly string[];
  full?: boolean;
  /** What the help is about, so a screen reader's list of buttons is not forty identical ones. */
  subject?: string;
  className?: string;
}) {
  const { preview, truncated } = useMemo(() => helpPreview(text), [text]);
  const hiddenHit = useMemo(
    () =>
      truncated &&
      terms.some(
        (t) => matchesAllTerms([text], [t]) && !matchesAllTerms([preview], [t]),
      ),
    [truncated, terms, text, preview],
  );
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (hiddenHit) setOpen(true);
  }, [hiddenHit]);

  const showAll = full || !truncated || open;
  return (
    <p id={id} className={cn("text-sm leading-relaxed text-fg-subtle", className)}>
      <Highlight text={showAll ? text : preview} terms={terms} />
      {truncated && !showAll && (
        <>
          {" "}
          <HelpTip label={subject ? `More about ${subject}` : "The full explanation"}>{text}</HelpTip>
        </>
      )}
    </p>
  );
}
