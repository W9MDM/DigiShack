/* eslint-disable no-console */
// Nothing the browser loads may reach a Node builtin.
//
// THE FAULT THIS EXISTS FOR. `pages/users.tsx` imported `MIN_PASSWORD_LENGTH` from
// `lib/auth/password.ts` to label a form field. That module opens with
//
//     import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
//
// so Next bundled node:crypto into the client, the module threw as it evaluated, and the
// page rendered as:
//
//     Application error: a client-side exception has occurred
//
// with NOTHING in the server logs, because nothing had gone wrong on the server. Typecheck
// passed, the build passed, and the page was broken. That combination is why this is a
// check rather than a code review note.
//
// IT HAS TO MODEL WHAT NEXT ACTUALLY STRIPS, or it is useless. Nearly every page in this
// application ends with
//
//     export const getServerSideProps = withPageAuth();
//
// and `lib/auth/guard.ts` imports Prisma. Those pages work: Next removes
// `getServerSideProps` and any import used only by it from the client bundle. A version of
// this check that ignored that reported 26 failures alongside the one real one, which is the
// same as reporting none — so an import counts as client-reachable only when one of the
// names it binds is used OUTSIDE the getServerSideProps declaration.
//
// That is also what made the original bug so confusing: `pages/setup.tsx` imports the same
// constant from the same module and is fine, because it only uses it inside
// getServerSideProps. The identical import is fatal in one file and harmless in the next,
// and nothing in the source says which.
//
// Type-only imports are skipped too. `import type { Qso } from "@/lib/types"` is erased by
// the compiler and never reaches any bundle.

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** A newline, as a constant, because heredoc-authored escapes in this file kept breaking. */
const NL = String.fromCharCode(10);

let pass = 0;
let fail = 0;

/** Anything that cannot exist in a browser. */
const FORBIDDEN_PREFIXES = ["node:"];
const FORBIDDEN_PACKAGES = [
  "@prisma/client",
  "nodemailer",
  "sharp",
  "ws",
  "ioredis",
  "bullmq",
  "child_process",
  "worker_threads",
  "fs",
  "path",
  "os",
  "zlib",
  "crypto",
  "net",
  "dgram",
  "tls",
  "http",
  "https",
];

interface Imp {
  spec: string;
  /** Value bindings this import introduces. Empty for a side-effect or type-only import. */
  idents: string[];
  /** True when nothing is bound, so usage cannot be reasoned about: always followed. */
  unconditional: boolean;
}

const CLAUSE_RE = /(?:^|\n)\s*import\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const REEXPORT_RE = /(?:^|\n)\s*export\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']/g;
const REQUIRE_RE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

/** Value names bound by an import clause, dropping inline `type` members. */
function bindings(clause: string): string[] {
  const out: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const raw of braces[1]!.split(",")) {
      const m = raw.trim();
      if (!m || /^type\s/.test(m)) continue;
      out.push(m.split(/\s+as\s+/).pop()!.trim());
    }
  }
  // Default and namespace bindings sit outside the braces.
  const outside = clause.replace(/\{[^}]*\}/g, "").replace(/,/g, " ");
  const ns = /\*\s+as\s+(\w+)/.exec(outside);
  if (ns) out.push(ns[1]!);
  else {
    for (const w of outside.trim().split(/\s+/)) if (/^\w+$/.test(w)) out.push(w);
  }
  return out.filter(Boolean);
}

function parseImports(src: string): Imp[] {
  const out: Imp[] = [];
  for (const re of [CLAUSE_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      if (m[1]) continue; // `import type ... from` — erased by the compiler
      const idents = bindings(m[2] ?? "");
      out.push({ spec: m[3]!, idents, unconditional: idents.length === 0 });
    }
  }
  for (const re of [SIDE_EFFECT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      out.push({ spec: m[1]!, idents: [], unconditional: true });
    }
  }
  REEXPORT_RE.lastIndex = 0;
  for (let m = REEXPORT_RE.exec(src); m; m = REEXPORT_RE.exec(src)) {
    if (m[1]) continue;
    // A re-export is reachable whenever the module is, and binds no local name to reason
    // about — so it is always followed.
    out.push({ spec: m[2]!, idents: [], unconditional: true });
  }
  return out;
}

/**
 * The part of a page that runs in the browser: everything except the getServerSideProps
 * declaration and whatever follows it.
 *
 * By convention in this repo that export is the last thing in the file, which makes a cut
 * at it accurate. The failure mode if that convention were broken is a FALSE ALARM, not a
 * missed fault — code after the cut would be treated as server-only — and a false alarm is
 * the safe direction for this particular check.
 */
function clientPart(src: string): string {
  const cut = src.search(
    /export\s+(?:const|async\s+function|function|default\s+async\s+function)\s+getServerSideProps/,
  );
  const body = cut < 0 ? src : src.slice(0, cut);
  return (
    body
      // Comments go first. Prose naming an identifier is not a use of it, and the note
      // above stations/index.tsx's own `getServerSideProps` — which explains that
      // `withPageAuth` had been imported and never called — was enough to report that page
      // as broken immediately after it was fixed.
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(?:^|\n)\s*\/\/[^\n]*/g, NL)
      // Import statements go, so an import is not mistaken for a use of what it binds.
      .replace(/(?:^|\n)\s*import\s+[^;]*?from\s*["'][^"']+["'];?/g, NL)
      .replace(/(?:^|\n)\s*import\s*["'][^"']+["'];?/g, NL)
      // And so do single-line string literals. pages/login.tsx reads
      // `"needsSetup" in error.details`, and matching the imported `needsSetup` against the
      // contents of that string reported the login page as broken when it is not. Template
      // literals are left alone, because `${...}` inside one can hold a real use.
      .replace(/"[^"\n]*"/g, '""')
      .replace(/'[^'\n]*'/g, "''")
  );
}

/** Resolve an import specifier to a file in this repo, or null if it is external. */
function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = resolve(spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;

  for (const cand of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    base,
  ]) {
    // isFile(), not a test against `join(cand, ".")`. The first version of this excluded
    // directories by asking whether `cand/.` existed — the same path normalised, and so true
    // for every real file. Every local import resolved to null, the walk never left the entry
    // file, and the check passed cleanly on the exact bug it was written for.
    if (!existsSync(cand)) continue;
    if (!statSync(cand).isFile()) continue;
    if (!/\.tsx?$/.test(cand)) continue;
    return cand;
  }
  return null;
}

function forbidden(spec: string): string | null {
  if (FORBIDDEN_PREFIXES.some((p) => spec.startsWith(p))) return spec;
  const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  return FORBIDDEN_PACKAGES.includes(pkg) ? pkg : null;
}

function rel(p: string): string {
  const slashed = p.split("\\").join("/");
  const cwd = process.cwd().split("\\").join("/");
  return slashed.startsWith(`${cwd}/`) ? slashed.slice(cwd.length + 1) : slashed;
}

/**
 * Walk out from one entry file and report the first path to something server-only.
 *
 * The PATH is reported rather than just the offending module: "node:crypto is in the client
 * bundle" is not actionable, while "users.tsx → lib/auth/password.ts → node:crypto" names
 * the import to change.
 */
function findPath(entry: string, forcePage = false): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; trail: string[]; isEntry: boolean }[] = [
    { file: entry, trail: [entry], isEntry: true },
  ];

  while (stack.length > 0) {
    const { file, trail, isEntry } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const src = readFileSync(file, "utf8");
    // The getServerSideProps carve-out applies at the PAGE only. Once inside a library
    // module every import is real: a page cannot make `lib/db/prisma` server-only by
    // wishing it, and a module reached from render is reached in full.
    const body =
      isEntry && (forcePage || rel(file).startsWith("pages/")) ? clientPart(src) : null;

    for (const imp of parseImports(src)) {
      if (body !== null && !imp.unconditional) {
        const used = imp.idents.some((id) => new RegExp(`\\b${id}\\b`).test(body));
        if (!used) continue;
      }
      const bad = forbidden(imp.spec);
      if (bad) return [...trail, bad];
      const next = resolveLocal(imp.spec, file);
      if (next) stack.push({ file: next, trail: [...trail, rel(next)], isEntry: false });
    }
  }
  return null;
}

/**
 * A throwaway page that imports a server-only module, used to prove the detector fires.
 *
 * `serverPropsOnly` moves the single use of the imported name below getServerSideProps,
 * which is the difference the walk is supposed to notice — so the two runs together check
 * both that it catches the fault and that it does not cry wolf on the pattern nearly every
 * page in this application uses.
 */
function writeProbe(path: string, serverPropsOnly = false): void {
  const lines = serverPropsOnly
    ? [
        'import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";',
        "export default function Probe() {",
        "  return <p>probe</p>;",
        "}",
        "export const getServerSideProps = async () => ({",
        "  props: { n: MIN_PASSWORD_LENGTH },",
        "});",
        "",
      ]
    : [
        'import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";',
        "export default function Probe() {",
        "  return <p>{MIN_PASSWORD_LENGTH}</p>;",
        "}",
        "",
      ];
  writeFileSync(path, lines.join(NL));
}

function rmProbe(path: string): void {
  rmSync(path, { force: true });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Entry points the browser really loads: every page except the API, and every component. */
const entries = [...walk("pages"), ...walk("components")]
  .map((f) => rel(f))
  .filter((f) => !f.startsWith("pages/api/"))
  .sort();

console.log(`walking ${entries.length} client entry points`);

const problems: string[][] = [];
for (const entry of entries) {
  const path = findPath(entry);
  if (path) problems.push(path);
}

if (problems.length === 0) {
  pass++;
  console.log("  ok    nothing the browser loads reaches a Node builtin or a server-only package");
} else {
  for (const p of problems) {
    fail++;
    console.log(`  FAIL  ${p.map(rel).join("\n          -> ")}`);
  }
  console.log(
    "\n  A page importing one of these builds and typechecks cleanly, then throws\n" +
      '  "Application error: a client-side exception has occurred" with nothing in the\n' +
      "  server log. Move the value the page needs into a module with no server imports;\n" +
      "  lib/auth/password-policy.ts exists for exactly that reason.",
  );
}

// The check has to be able to FAIL, and this one silently could not: with the resolver
// broken it walked no further than each entry file and reported everything clean. So the
// detector is pointed at a known-bad graph on every run.
console.log("\nthe check can still detect the fault it was written for");
{
  const tmp = "scripts/.client-bundle-probe.tsx";
  try {
    writeProbe(tmp);
    const found = findPath(tmp, true);
    if (found && found[found.length - 1] === "node:crypto") {
      pass++;
      console.log("  ok    a page using a server-only import at render time is caught");
    } else {
      fail++;
      console.log(`  FAIL  the probe was NOT caught (${found ? found.join(" -> ") : "no path"})`);
    }

    writeProbe(tmp, true);
    const skipped = findPath(tmp, true);
    if (skipped === null) {
      pass++;
      console.log("  ok    and the same import used only in getServerSideProps is not");
    } else {
      fail++;
      console.log(`  FAIL  a server-props-only import was flagged (${skipped.join(" -> ")})`);
    }
  } finally {
    rmProbe(tmp);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
