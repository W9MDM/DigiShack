import type { MouseEvent } from "react";

import type { ClientSetting } from "@/components/settings/types";
import { settingsHref } from "@/lib/settings/tabs";

/**
 * The stored values that will not decrypt, at the top of the page, each a link to its field.
 *
 * Since 1.226.0 such a value is not quietly replaced by an older one or by .env — the
 * service using it is OFF until it is re-entered. That is the safe behaviour and also an
 * invisible one unless the page says so where it cannot be missed: the field itself may be
 * three categories away, behind a disclosure.
 */
export function UnreadableBanner({
  settings,
  groupTitle,
  onJump,
}: {
  settings: readonly ClientSetting[];
  groupTitle: (id: string) => string;
  onJump: (setting: string) => void;
}) {
  const problems = settings.filter((s) => s.unreadable || s.problem !== null);
  if (problems.length === 0) return null;
  const one = problems.length === 1;
  const go = (key: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    // A plain click stays on the page; a middle-click or a copied link still works.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onJump(key);
  };
  return (
    <div
      role="alert"
      data-settings-problems
      className="mb-4 rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-fg"
    >
      <p>
        <strong className="font-medium text-warn">
          {one ? "A stored value can't be decrypted" : `${problems.length} stored values can't be decrypted`}
        </strong>{" "}
        — re-enter {one ? "it" : "each one"}. Until then {one ? "it is" : "they are"} not used, and
        nothing falls back to an older value or to .env.
      </p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {problems.map((s) => (
          <li key={s.key}>
            <a
              href={settingsHref({ setting: s.key })}
              onClick={go(s.key)}
              className="text-accent-bright underline underline-offset-2"
            >
              {groupTitle(s.group)} → {s.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
