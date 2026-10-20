/* eslint-disable no-console */
/**
 * The logbook pages' pure pieces: the URL <-> state round trip, the API request built from
 * it, the QSL channel reading, and the band x mode pivot.
 *
 * The log's filters moved from React state into the page URL. The request to /api/qsos and
 * the ADIF export link must not have moved with them, so both are compared here against a
 * verbatim copy of the inline code the page used before (`legacyPath`, `legacyExport`).
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { pivotSlices } from "@/components/log/BandModeGrid";
import {
  DEFAULT_LOG_QUERY,
  activeFilterCount,
  formatRange,
  isFiltered,
  logApiPath,
  logExportHref,
  logQuerySearch,
  parseLogQuery,
  type LogQuery,
} from "@/components/log/log-query";
import { isConfirmed, qslChannels } from "@/components/log/qsl";
import { QslBadges } from "@/components/log/QslBadges";
import { formatDistance, gridDistanceKm } from "@/lib/geo/distance";
import * as propagation from "@/lib/propagation";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail: unknown = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail !== "" ? `\n        ${JSON.stringify(detail)}` : ""}`);
  }
}

// --- verbatim from pages/qsos/index.tsx before the move -----------------------------------
function legacyPath(s: {
  debouncedQ: string; band: string; mode: string; confirmed: string;
  from: string; to: string; sort: string; dir: string; page: number;
}): string {
  const params = new URLSearchParams({
    take: String(50),
    skip: String(s.page * 50),
    sort: s.sort,
    dir: s.dir,
    confirmed: s.confirmed,
  });
  if (s.debouncedQ.trim()) params.set("q", s.debouncedQ.trim());
  if (s.band) params.set("band", s.band);
  if (s.mode) params.set("mode", s.mode);
  if (s.from) params.set("from", `${s.from}T00:00:00.000Z`);
  if (s.to) params.set("to", `${s.to}T23:59:59.999Z`);
  return `/api/qsos?${params}`;
}
function legacyExport(s: {
  debouncedQ: string; band: string; mode: string; confirmed: string; from: string; to: string;
}): string {
  return `/api/adif/export?${new URLSearchParams({
    ...(s.debouncedQ.trim() ? { q: s.debouncedQ.trim() } : {}),
    ...(s.band ? { band: s.band } : {}),
    ...(s.mode ? { mode: s.mode } : {}),
    ...(s.from ? { from: `${s.from}T00:00:00.000Z` } : {}),
    ...(s.to ? { to: `${s.to}T23:59:59.999Z` } : {}),
    ...(s.confirmed !== "any" ? { confirmed: s.confirmed } : {}),
  }).toString()}`;
}
// -------------------------------------------------------------------------------------------

console.log("\nthe request is unchanged");
const cases: LogQuery[] = [
  DEFAULT_LOG_QUERY,
  { ...DEFAULT_LOG_QUERY, q: "  w1aw ", page: 3 },
  { ...DEFAULT_LOG_QUERY, band: "20M", mode: "FT8", confirmed: "yes", sort: "callsign", dir: "asc" },
  { ...DEFAULT_LOG_QUERY, from: "2026-01-01", to: "2026-02-28", confirmed: "no", q: "EN61" },
  { ...DEFAULT_LOG_QUERY, q: "K1ABC/P", band: "40M", sort: "mode", dir: "desc", page: 760 },
];
for (const c of cases) {
  const legacy = { ...c, debouncedQ: c.q };
  ok(logApiPath(c) === legacyPath(legacy), `list path for ${JSON.stringify(c)}`, [logApiPath(c), legacyPath(legacy)]);
  ok(logExportHref(c) === legacyExport(legacy), `export link for ${JSON.stringify(c)}`, [logExportHref(c), legacyExport(legacy)]);
}

console.log("\nthe page URL round-trips");
for (const c of cases) {
  const back = parseLogQuery(Object.fromEntries(new URLSearchParams(logQuerySearch(c))));
  ok(
    JSON.stringify(back) === JSON.stringify({ ...c, q: c.q.trim() }),
    `round trip ${logQuerySearch(c) || "(empty)"}`,
    back,
  );
}
ok(logQuerySearch(DEFAULT_LOG_QUERY) === "", "the default view has a bare URL");
ok(parseLogQuery({ page: "3" }).page === 2, "the URL page is one-based");
ok(parseLogQuery({ q: "W1AW" }).q === "W1AW", "an existing /qsos?q= link still filters");

console.log("\nnonsense in the URL falls back, never throws");
const junk = parseLogQuery({
  band: "99M", mode: "TELEPATHY", from: "2026-13-45", to: "yesterday",
  confirmed: "maybe", sort: "password", dir: "sideways", page: "-4",
});
ok(JSON.stringify(junk) === JSON.stringify(DEFAULT_LOG_QUERY), "every bad field is the default", junk);
ok(parseLogQuery({ band: "20m", mode: "ft8" }).band === "20M", "band is case-insensitive");
ok(parseLogQuery({ band: ["40M", "20M"] }).band === "40M", "a repeated param takes the first");

console.log("\nfilter accounting");
ok(activeFilterCount(DEFAULT_LOG_QUERY) === 0 && !isFiltered(DEFAULT_LOG_QUERY), "the default is unfiltered");
ok(isFiltered({ ...DEFAULT_LOG_QUERY, q: "W1AW" }), "a search alone counts as filtered");
ok(!isFiltered({ ...DEFAULT_LOG_QUERY, q: "   " }), "whitespace is not a search");
ok(activeFilterCount({ ...DEFAULT_LOG_QUERY, band: "20M", confirmed: "yes" }) === 2, "the phone badge counts filters");
ok(formatRange(1, 120) === "51–100 of 120", "range text", formatRange(1, 120));
ok(formatRange(2, 120) === "101–120 of 120", "the last page stops at the total");

console.log("\nQSL channels");
const none = { qslSent: "NONE", qslRcvd: "NONE", lotwSent: false, lotwRcvd: false, eqslSent: false, eqslRcvd: false, emailQslSent: false };
ok(!isConfirmed(none), "nothing is not confirmed");
ok(isConfirmed({ ...none, eqslRcvd: true }), "eQSL confirms for display");
ok(isConfirmed({ ...none, qslRcvd: "CONFIRMED" }), "a paper card confirms");
ok(!isConfirmed({ ...none, qrzRcvd: true } as typeof none), "a QRZ match is not a confirmation");
const ch = qslChannels({ ...none, lotwSent: true, lotwRcvd: true, eqslSent: true, qslSent: "SENT", emailQslSent: true });
ok(ch.map((c) => `${c.key}:${c.state}`).join(",") === "lotw:confirmed,eqsl:sent,card:sent,email:sent", "states and fixed order", ch);
ok(qslChannels(none, { includeQrz: true }).at(-1)?.key === "qrz", "QRZ only when asked for");

const quiet = renderToStaticMarkup(createElement(QslBadges, { qso: none }));
ok(quiet.includes("No QSL sent or received") && quiet.includes('aria-hidden="true">—'), "an empty QSL cell is spoken, the dash is not", quiet);
const busy = renderToStaticMarkup(createElement(QslBadges, { qso: { ...none, lotwRcvd: true, eqslSent: true } }));
ok(busy.includes("LoTW: confirmed") && busy.includes("eQSL: uploaded, not yet confirmed"), "each badge says its state in words", busy);
ok(!busy.includes("Card") && !busy.includes("Email"), "channels with nothing are not drawn in the dense form");

console.log("\nband x mode pivot");
const p = pivotSlices([
  { band: "20M", mode: "FT8", qsos: 5, confirmed: true, lastWorked: "2026-01-01T00:00:00Z" },
  { band: "160M", mode: "CW", qsos: 1, confirmed: false, lastWorked: "2026-01-01T00:00:00Z" },
  { band: "40M", mode: "FT8", qsos: 2, confirmed: false, lastWorked: "2026-01-01T00:00:00Z" },
  { band: "40M", mode: "SSB", qsos: 1, confirmed: true, lastWorked: "2026-01-01T00:00:00Z" },
]);
ok(p.bands.join(",") === "160M,40M,20M", "bands in frequency order, not alphabetical", p.bands);
ok(p.modes[0] === "FT8", "the most-used mode leads", p.modes);
ok(p.cell("40M", "SSB")?.confirmed === true && p.cell("20M", "CW") === undefined, "cells look up by band and mode");

console.log("\nclient-safe distance matches lib/propagation");
for (const [a, b] of [["EN61", "JN58"], ["EN61bx", "PM95"], ["FN31", "FN31"]] as const) {
  ok(gridDistanceKm(a, b) === propagation.gridDistanceKm(a, b), `${a} -> ${b}`);
}
ok(gridDistanceKm("EN61", null) === null && gridDistanceKm("??", "EN61") === null, "missing or bad grids give null");
ok(formatDistance(1000, "mi") === propagation.formatDistance(1000, "mi"), "same miles text");

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
