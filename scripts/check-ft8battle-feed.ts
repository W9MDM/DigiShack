/* eslint-disable no-console */
// Assertions on reading the FT8 Battle Royale feed.
// Run: npm run check:ft8battle-feed
//
// THE FIXTURES ARE REAL. Three entries from data/activity.json and the head of the steal
// predictor's `recentContacts` literal, captured 2026-10-14 15:28 UTC. The feed has no
// schema document; these are what it actually sends, and a parser that handles them handles
// the feed. If the site changes shape, these will not notice - the tracker logs its first
// failure, and the fixtures here should then be replaced with whatever it sends next.

import {
  bandKey,
  claimKey,
  deriveClaims,
  extractJsLiteral,
  modeFromBreakdown,
  normaliseBand,
  parseActivityJson,
  parseFeedTimestamp,
  parsePredictorHtml,
  stealEstimate,
  type FeedEvent,
} from "../lib/contest/ft8battle-feed";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, what: string): void {
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}

const ACTIVITY = JSON.stringify({
  activities: [
    {
      timestamp: "2026-10-14 15:25:08",
      activity_type: "qso",
      station: "SP9JMZ",
      contact: "F1MWV",
      contact_is_player: false,
      band: "20m",
      points: 10,
      reason: "first_contact",
      message: "SP9JMZ worked F1MWV on 20m for +10 pts (first contact bonus!)",
      breakdown: [
        "Base QSO: +1 points",
        "First contact bonus: +4 points",
        "Mode multiplier (FT4): x2",
        "After multipliers: 5 x 2 = 10 points",
        "💰 TOTAL: 10 points",
      ],
    },
    {
      timestamp: "2026-10-14 14:26:16",
      activity_type: "qso",
      station: "SP9JMZ",
      contact: "IK4LZH",
      contact_is_player: false,
      band: "20m",
      points: 2,
      reason: null,
      message: "SP9JMZ worked IK4LZH on 20m for +2 pts",
      breakdown: [
        "Base QSO: +1 points",
        "Mode multiplier (FT4): x2",
        "After multipliers: 1 x 2 = 2 points",
        "💰 TOTAL: 2 points",
      ],
    },
    {
      timestamp: "2026-10-14 14:30:15",
      activity_type: "steal",
      station: "KC3LVG",
      contact: "W0EOR",
      contact_is_player: false,
      band: "30m",
      points: 6,
      victim: "KJ5IEL",
      stolen_points: 5,
      base_points: 1,
      message: "🔥 KC3LVG STOLE W0EOR on 30m from KJ5IEL! +6 pts (1 base + 5 stolen)",
      breakdown: ["Base QSO: +1 points", "💥 STOLE 5 points from 1 player(s)!", "💰 TOTAL: 6 points"],
    },
    {
      timestamp: "2026-10-14 14:40:00",
      activity_type: "qso",
      station: "KC3LVG",
      contact: "W0EOR",
      band: "30m",
      points: -12,
      reason: "duplicate",
      message: "KC3LVG worked W0EOR on 30m again: -12 pts (DUP)",
      breakdown: ["Duplicate QSO penalty: -12 points"],
    },
    { timestamp: "yesterday", station: "X", contact: "Y", band: "20m" },
    { timestamp: "2026-10-14 14:41:00", station: "", contact: "Y", band: "20m" },
  ],
});

const PREDICTOR_HTML =
  "<html><script>\nconst propagationData = {\"solar\":{\"sfi\":136}};\n" +
  "const recentContacts = [{\"contact\":\"F1MWV\",\"gridsquare\":\"IN95lp\",\"band\":\"20m\",\"mode\":\"FT4\"," +
  "\"last_worked\":\"2026-10-14 15:25:08\",\"worked_by\":\"SP9JMZ\",\"psk_confirmed\":true,\"psk_last_heard\":\"2026-10-14 15:25:45\",\"psk_snr\":4,\"psk_grid\":\"IN95lp\"}," +
  "{\"contact\":\"DL2MIJ\",\"gridsquare\":\"JN58\",\"band\":\"10m\",\"mode\":\"FT8\",\"last_worked\":\"2026-10-14 15:24:00\",\"worked_by\":\"W8FSM\",\"psk_confirmed\":true,\"psk_last_heard\":\"2026-10-14 15:26:27\",\"psk_snr\":-19,\"psk_grid\":\"JN58di\"}];\n" +
  "const workedToday = {\"AA1ABC\":true,\"AC5UV\":true};\n</script></html>";

const NOW = new Date("2026-10-14T15:30:00Z");

console.log("their timestamps are UTC and their bands are lower case");
{
  eq(parseFeedTimestamp("2026-10-14 15:25:08")?.toISOString(), "2026-10-14T15:25:08.000Z", "a feed timestamp parses as UTC");
  eq(parseFeedTimestamp("yesterday"), null, "and anything else is null, not Invalid Date");
  eq(parseFeedTimestamp(undefined), null, "including a missing one");
  eq(normaliseBand("20m"), "20M", "20m becomes 20M, the spelling the rest of the project uses");
  eq(modeFromBreakdown(["Base QSO: +1 points", "Mode multiplier (FT4): x2"]), "FT4", "the mode is read from the breakdown");
  eq(modeFromBreakdown(["Base QSO: +1 points"]), "FT8", "and no multiplier line means FT8");
  eq(modeFromBreakdown(undefined), "FT8", "as does no breakdown at all");
}

console.log("the activity feed, as events");
const events = parseActivityJson(ACTIVITY);
{
  eq(events.length, 4, "four usable events; the two malformed ones are skipped, not thrown on");
  const first = events[0]!;
  eq(first.type, "qso", "a worked contact is a qso");
  eq(first.contact, "F1MWV", "with the station worked");
  eq(first.band, "20M", "the band in project spelling");
  eq(first.mode, "FT4", "the mode from the breakdown");
  eq(first.points, 10, "the points");
  eq(first.first, true, "and the First Contact flag from the reason");
  eq(events[1]!.first, false, "a plain contact is not a first contact");
  const steal = events[2]!;
  eq(steal.type, "steal", "a steal is a steal");
  eq(steal.victim, "KJ5IEL", "with the victim");
  eq(steal.stolen, 5, "how much was taken");
  eq(steal.points, 6, "and the total the thief now holds");
  eq(steal.mode, "FT8", "a breakdown with no mode line is FT8");
  eq(events[3]!.type, "penalty", "negative points are a duplicate penalty");
  eq(parseActivityJson("not json").length, 0, "garbage parses to nothing");
  eq(parseActivityJson("{}").length, 0, "as does a document with no activities");
}

console.log("the steal predictor's embedded list, as holdings");
{
  const lit = extractJsLiteral(PREDICTOR_HTML, "recentContacts");
  ok(Array.isArray(lit) && lit.length === 2, "the JS literal is found and parsed", lit);
  eq(extractJsLiteral(PREDICTOR_HTML, "nothingHere"), null, "a missing literal is null");
  const seeded = parsePredictorHtml(PREDICTOR_HTML);
  eq(seeded.length, 2, "two holdings");
  eq(seeded[0]!.station, "SP9JMZ", "held by the player who worked them");
  eq(seeded[0]!.mode, "FT4", "with the mode, which the feed itself lacks");
  eq(seeded[1]!.band, "10M", "and the band normalised");
  eq(seeded[0]!.points, null, "points are unknown from this source");
  eq(seeded[0]!.source, "predictor", "and the row says where it came from");
}

console.log("who holds what today: the LAST worker on a band and mode");
{
  const { claims, claimedBands } = deriveClaims(events, NOW);
  const w0eor = claims.get(claimKey("W0EOR", "30M", "FT8"));
  eq(w0eor?.holder, "KC3LVG", "after a steal the thief holds the station");
  eq(w0eor?.points, 6, "with the accumulated total, not just what was stolen");
  ok(claimedBands.has(bandKey("W0EOR", "30M")), "and the band is claimed: no First Contact there for anyone");
  ok(claimedBands.has(bandKey("F1MWV", "20M")), "a plain qso claims its band too");
  eq(claims.get(claimKey("F1MWV", "20M", "FT4"))?.holder, "SP9JMZ", "and is held by its worker");
  ok(!claims.has(claimKey("F1MWV", "20M", "FT8")), "a holding is per MODE: FT8 on the same band is open");

  eq(w0eor?.at.toISOString(), "2026-10-14T14:30:15.000Z", "the penalty at 14:40 did not change who holds it, or when");

  const stale: FeedEvent = { ...events[0]!, at: new Date("2026-10-13T15:25:08Z"), contact: "OLD1" };
  const { claims: c2 } = deriveClaims([...events, stale], NOW);
  ok(!c2.has(claimKey("OLD1", "20M", "FT4")), "an event from another UTC day is not a holding today");

  const seeded = parsePredictorHtml(PREDICTOR_HTML);
  const { claims: c3 } = deriveClaims([...seeded, ...events], NOW);
  eq(c3.get(claimKey("F1MWV", "20M", "FT4"))?.points, 10, "when both sources describe the same contact, the one with points wins");
  const { claims: c4 } = deriveClaims([...events, ...seeded], NOW);
  eq(c4.get(claimKey("F1MWV", "20M", "FT4"))?.points, 10, "in either order");
}

console.log("what a steal is worth: exact when known, a range when not");
{
  eq(stealEstimate({ band: "30M", mode: "FT8", points: 6 }).min, 6, "known points are the floor");
  eq(stealEstimate({ band: "30M", mode: "FT8", points: 6 }).max, 6, "and the ceiling");
  const r = stealEstimate({ band: "20M", mode: "FT8", points: null });
  eq(r.min, 1, "unknown on a plain band: at least their base");
  eq(r.max, 5, "at most base plus First Contact");
  const t = stealEstimate({ band: "10M", mode: "FT4", points: null });
  eq(t.min, 3, "unknown on 10 m FT4: base times 1.5 times 2");
  eq(t.max, 15, "up to (1 + 4) times 3");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all ft8battle-feed assertions passed");
