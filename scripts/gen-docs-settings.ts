/* eslint-disable no-console */
// Generate docs/settings.md from the settings registry.
//
// Hand-written settings documentation is wrong within a month. There are sixty-odd
// keys and they change every time a feature lands, so the reference is generated from
// the same array the Settings page renders — which makes drift impossible rather than
// merely discouraged.
//
//   npx tsx scripts/gen-docs-settings.ts          write the file
//   npx tsx scripts/gen-docs-settings.ts --check  fail if it is out of date
//
// The --check form runs in `npm run check`, so a new setting with no documentation
// fails the build rather than being noticed a year later by someone reading the code
// to find out what a checkbox does.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { SETTINGS, SETTING_GROUPS } from "@/lib/settings/registry";

const OUT = path.join(process.cwd(), "docs", "settings.md");

const TYPE_LABEL: Record<string, string> = {
  string: "text",
  secret: "secret",
  number: "number",
  boolean: "on/off",
  text: "multi-line text",
};

function escapeCell(s: string): string {
  // Pipes would break the table; newlines would break the row.
  return s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function build(): string {
  const out: string[] = [
    "# Settings reference",
    "",
    "Everything configurable, from **Settings** in the nav (ADMIN only).",
    "",
    "> Generated from `lib/settings/registry.ts` by `scripts/gen-docs-settings.ts`.",
    "> Do not edit by hand — `npm run check` fails when this file and the registry",
    "> disagree.",
    "",
    "Values live in the database, not in `.env`. Secrets are encrypted with",
    "`SETTINGS_KEY`, which stays in `.env` and is **not** part of a database backup —",
    "see [Backup and moving an installation](backup-and-moving.md).",
    "",
    "Three keys can never be settings, because they are needed before the database can",
    "be read: `DATABASE_URL`, `SETTINGS_KEY` and `PORT`.",
    "",
  ];

  // Groups in registry order; the page renders them the same way.
  const byGroup = new Map<string, typeof SETTINGS>();
  for (const s of SETTINGS) {
    const list = byGroup.get(s.group) ?? [];
    list.push(s);
    byGroup.set(s.group, list);
  }

  out.push("## Contents", "");
  for (const g of SETTING_GROUPS) {
    const n = byGroup.get(g.id)?.length ?? 0;
    if (n === 0) continue;
    const anchor = g.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    out.push(`- [${g.title}](#${anchor}) — ${n} setting${n === 1 ? "" : "s"}`);
  }
  out.push("");

  for (const g of SETTING_GROUPS) {
    const list = byGroup.get(g.id);
    if (!list || list.length === 0) continue;

    out.push(`## ${g.title}`, "");
    if (g.blurb) out.push(g.blurb, "");

    out.push("| Setting | Key | Type | Default | What it does |");
    out.push("|---|---|---|---|---|");
    for (const s of list) {
      const def =
        s.default !== undefined && s.default !== ""
          ? `\`${s.default}\``
          : s.envFallback
            ? `from \`${s.envFallback}\``
            : "—";
      const help = s.help ? escapeCell(s.help) : "";
      out.push(
        `| ${escapeCell(s.label)} | \`${s.key}\` | ${TYPE_LABEL[s.type] ?? s.type} | ${def} | ${help} |`,
      );
    }
    out.push("");
  }

  // Anything with an env fallback is a migration path, and worth listing separately —
  // it is the answer to "why is this still working after I emptied the settings table?"
  const fallbacks = SETTINGS.filter((s) => s.envFallback);
  if (fallbacks.length > 0) {
    out.push(
      "## Environment fallbacks",
      "",
      "These read an environment variable **only when the database has no value**, so an",
      "older `.env`-based install keeps working after an upgrade. Setting the value in the",
      "UI takes precedence from then on.",
      "",
      "| Key | Environment variable |",
      "|---|---|",
      ...fallbacks.map((s) => `| \`${s.key}\` | \`${s.envFallback}\` |`),
      "",
    );
  }

  // Renamed keys. Anyone with a documented `.env`, a script, or a memory of the old
  // name needs to be able to find where it went.
  const renamed = SETTINGS.filter((s) => (s.legacyKeys ?? []).length > 0);
  if (renamed.length > 0) {
    out.push(
      "## Renamed keys",
      "",
      "These settings have been renamed. The old key is still **read** when the new one",
      "has no value, so an install that has not run the migration — or one restored from",
      "an older database — keeps working. Nothing writes to an old key.",
      "",
      "| Was | Is now |",
      "|---|---|",
      ...renamed.flatMap((s) =>
        (s.legacyKeys ?? []).map((old) => `| \`${old}\` | \`${s.key}\` |`),
      ),
      "",
    );
  }

  out.push(
    "## Secrets",
    "",
    "Stored encrypted with `SETTINGS_KEY`. The API never returns them — the Settings",
    "page shows whether one is set, not what it is.",
    "",
    ...SETTINGS.filter((s) => s.type === "secret").map((s) => `- \`${s.key}\` — ${s.label}`),
    "",
  );

  return out.join("\n");
}

/**
 * Registry invariants, checked here because this script already walks it.
 *
 * `pskreporter.contact` was defined twice — same key, two labels, two help texts —
 * which renders as two identical fields on the Settings page editing one value. It
 * survived because nothing ever looked at the array as a whole, and this generator is
 * the only thing that does.
 */
function validateRegistry(): string[] {
  const problems: string[] = [];

  const counts = new Map<string, number>();
  for (const s of SETTINGS) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  for (const [key, n] of counts) {
    if (n > 1) problems.push(`duplicate key "${key}" defined ${n} times`);
  }

  const groups = new Set(SETTING_GROUPS.map((g) => g.id));
  for (const s of SETTINGS) {
    // A setting in an unknown group renders nowhere: the page iterates groups, so
    // the field silently does not exist in the UI.
    if (!groups.has(s.group)) problems.push(`"${s.key}" is in unknown group "${s.group}"`);
    if (!s.label.trim()) problems.push(`"${s.key}" has no label`);
  }

  for (const g of SETTING_GROUPS) {
    if (!SETTINGS.some((s) => s.group === g.id)) {
      problems.push(`group "${g.id}" has no settings — it renders as an empty heading`);
    }
  }

  // Renamed keys.
  //
  // Two ways to get this wrong, and both are silent. A legacy key that is also a live
  // key means one setting reads another's value; two settings claiming the same legacy
  // key means whichever is asked first wins, which is not a property anybody should
  // have to know.
  const claimed = new Map<string, string>();
  for (const s of SETTINGS) {
    for (const old of s.legacyKeys ?? []) {
      if (counts.has(old)) {
        problems.push(`"${s.key}" lists "${old}" as a legacy key, but that key is still live`);
      }
      const other = claimed.get(old);
      if (other) {
        problems.push(`"${old}" is claimed as a legacy key by both "${other}" and "${s.key}"`);
      }
      claimed.set(old, s.key);
    }
  }

  return problems;
}

async function main(): Promise<void> {
  const problems = validateRegistry();
  if (problems.length > 0) {
    for (const p of problems) console.log(`  FAIL  ${p}`);
    process.exit(1);
  }
  console.log(`  ok    registry: ${SETTINGS.length} settings, no duplicates or orphans`);

  const content = build();
  const check = process.argv.includes("--check");

  if (check) {
    let existing: string | null = null;
    try {
      existing = await readFile(OUT, "utf8");
    } catch {
      /* not generated yet */
    }
    if (existing === content) {
      console.log(`  ok    docs/settings.md matches the registry (${SETTINGS.length} settings)`);
      return;
    }
    console.log("  FAIL  docs/settings.md is out of date");
    console.log("        run: npx tsx scripts/gen-docs-settings.ts");
    process.exit(1);
  }

  await writeFile(OUT, content, "utf8");
  console.log(`wrote docs/settings.md — ${SETTINGS.length} settings in ${SETTING_GROUPS.length} groups`);
}

void main();
