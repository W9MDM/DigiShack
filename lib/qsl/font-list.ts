// The fonts DigiShack ships, in a module the BROWSER can load.
//
// Split from `lib/qsl/fonts.ts` for the same reason `lib/auth/password-policy.ts` was
// split from the hashing code: that module opens with
//
//     import { existsSync, mkdirSync, writeFileSync } from "node:fs";
//
// and the settings registry needs this list to build the font picker. The registry is
// imported by `pages/settings.tsx`, so Next would bundle `node:fs` into the client, where
// the import cannot resolve and the module throws as it evaluates — a blank page with
// nothing in the server logs, because nothing went wrong on the server.
//
// No server-only imports may be added here, and `scripts/check-client-bundle.ts` is what
// catches it if one is.

export interface BundledFont {
  /** The family name, exactly as the font file declares it. */
  family: string;
  /** What the operator sees in the picker. */
  label: string;
  /** Files providing it, relative to assets/fonts. Regular and bold only. */
  files: string[];
}

/**
 * Chosen for what a QSL card actually wants rather than for variety, and all three are
 * SIL Open Font License 1.1 with the licence text shipped beside them.
 */
export const BUNDLED_FONTS: BundledFont[] = [
  {
    // Arial Narrow is what the old hardcoded stack asked for; this is the free
    // equivalent. Condensed, so a six-column QSO table fits across the artwork without
    // shrinking the type.
    family: "PT Sans Narrow",
    label: "PT Sans Narrow — condensed, the classic QSL table",
    files: ["PTSansNarrow-Regular.ttf", "PTSansNarrow-Bold.ttf"],
  },
  {
    family: "Lato",
    label: "Lato — a wider humanist sans",
    files: ["Lato-Regular.ttf", "Lato-Bold.ttf"],
  },
  {
    family: "PT Serif",
    label: "PT Serif — serif, for a more formal card",
    files: ["PTSerif-Regular.ttf", "PTSerif-Bold.ttf"],
  },
];

export const DEFAULT_CARD_FONT = "PT Sans Narrow";
