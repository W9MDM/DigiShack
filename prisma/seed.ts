// Development seed data.
//
//   npm run db:seed
//
// Creates a station, three operators and ~60 QSOs spread across bands,
// modes, years and QSL states, so the dashboard, log filters, sorting and ADIF
// export all have something realistic to chew on immediately after a fresh
// migration.
//
// Deliberately does NOT create a user account. Logins come from the one-time
// /setup page — seeding an admin with a known password would put a working
// credential in version control, which is exactly the footgun the setup flow
// exists to avoid.
//
// Refuses to run against NODE_ENV=production unless --force is passed.

import { PrismaClient, type Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const FORCE = process.argv.includes("--force");

// NO HARDCODED CALLSIGN. Not a placeholder, not an example, not one at all.
//
// This file used to define one, and anybody who ran the optional sample data inherited it
// — while the transmit path reads the Station record, so the radio would have called CQ
// under somebody else's callsign. That is an illegal transmission, not a bad default.
//
// The station is created by first-run setup at /setup, which asks for it, because there is
// no sensible default and pretending otherwise was the entire fault. This script now
// REQUIRES one to exist and refuses to invent it.
const STATION_CALL = null;

interface OpSeed {
  name: string;
  callsign: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
}

// Operator labels only — these never reach the air. Fictional on purpose.
const OPERATORS: OpSeed[] = [
  { name: "Primary Op", callsign: "N0CALL", role: "ADMIN" },
  { name: "Club Op", callsign: "N0CALL", role: "OPERATOR" },
  { name: "Visitor", callsign: "N0CALL", role: "VIEWER" },
];

/**
 * Representative dial frequencies. Digital modes use the real FT8/FT4 watering
 * holes so that band derivation and the ADIF round-trip get exercised against
 * values that actually occur.
 */
const SLOTS: { band: string; freqHz: number; mode: string }[] = [
  { band: "160M", freqHz: 1_840_000, mode: "FT8" },
  { band: "80M", freqHz: 3_573_000, mode: "FT8" },
  { band: "80M", freqHz: 3_800_000, mode: "SSB" },
  { band: "40M", freqHz: 7_074_000, mode: "FT8" },
  { band: "40M", freqHz: 7_047_500, mode: "FT4" },
  { band: "40M", freqHz: 7_030_000, mode: "CW" },
  { band: "30M", freqHz: 10_136_000, mode: "FT8" },
  { band: "30M", freqHz: 10_140_000, mode: "FT4" },
  { band: "20M", freqHz: 14_074_000, mode: "FT8" },
  { band: "20M", freqHz: 14_080_000, mode: "FT4" },
  { band: "20M", freqHz: 14_250_000, mode: "SSB" },
  { band: "20M", freqHz: 14_035_000, mode: "CW" },
  { band: "17M", freqHz: 18_100_000, mode: "FT8" },
  { band: "15M", freqHz: 21_074_000, mode: "FT8" },
  { band: "15M", freqHz: 21_300_000, mode: "SSB" },
  { band: "12M", freqHz: 24_915_000, mode: "FT8" },
  { band: "10M", freqHz: 28_074_000, mode: "FT8" },
  { band: "10M", freqHz: 28_400_000, mode: "SSB" },
  { band: "6M", freqHz: 50_313_000, mode: "FT8" },
  { band: "2M", freqHz: 144_174_000, mode: "FT8" },
  { band: "70CM", freqHz: 432_174_000, mode: "FT8" },
];

/**
 * Continent and CQ zone per DXCC entity, so the WAC and WAZ award views have
 * something real to show. Approximate but plausible zones — this is sample data.
 */
const ENTITY_META: Record<number, { cont: string; cqz: number }> = {
  291: { cont: "NA", cqz: 4 },
  1: { cont: "NA", cqz: 5 },
  223: { cont: "EU", cqz: 14 },
  230: { cont: "EU", cqz: 14 },
  227: { cont: "EU", cqz: 14 },
  281: { cont: "EU", cqz: 14 },
  248: { cont: "EU", cqz: 15 },
  284: { cont: "EU", cqz: 14 },
  224: { cont: "EU", cqz: 15 },
  266: { cont: "EU", cqz: 14 },
  339: { cont: "AS", cqz: 25 },
  150: { cont: "OC", cqz: 30 },
  170: { cont: "OC", cqz: 32 },
  108: { cont: "SA", cqz: 11 },
  100: { cont: "SA", cqz: 13 },
  462: { cont: "AF", cqz: 38 },
  336: { cont: "AS", cqz: 20 },
  342: { cont: "AS", cqz: 20 },
  381: { cont: "AS", cqz: 28 },
  386: { cont: "AS", cqz: 24 },
  137: { cont: "AS", cqz: 25 },
  324: { cont: "AS", cqz: 22 },
  376: { cont: "AS", cqz: 21 },
};

/** US states assigned round-robin to the US contacts, for WAS progress. */
const US_STATES = ["IN", "IL", "OH", "MI", "TX", "CA", "NY", "FL", "WA", "CO"];

/** IOTA references sprinkled onto island entities. */
const IOTA_BY_DXCC: Record<number, string> = {
  110: "OC-019",
  202: "NA-099",
  339: "AS-007",
  150: "OC-001",
  170: "OC-134",
  381: "AS-019",
  386: "AS-020",
};

/** call, grid, dxcc entity code. */
const CONTACTS: [string, string, number][] = [
  ["W1AW", "FN31", 291],
  ["K0ABC", "EM28", 291],
  ["N5XYZ", "EM12", 291],
  ["VE3ABC", "FN03", 1],
  ["VE7QQQ", "CN89", 1],
  ["G0XYZ", "IO91", 223],
  ["G4ABC", "IO83", 223],
  ["DL1ABC", "JO31", 230],
  ["DK5ZZ", "JN58", 230],
  ["F5ABC", "JN18", 227],
  ["EA3ABC", "JN01", 281],
  ["I2ABC", "JN45", 248],
  ["SM5ABC", "JO89", 284],
  ["OH2ABC", "KP20", 224],
  ["LA5ABC", "JO28", 266],
  ["JA1ZZZ", "PM95", 339],
  ["JA7ABC", "QM08", 339],
  ["VK2QQQ", "QF56", 150],
  ["VK6ABC", "OF78", 150],
  ["ZL2ABC", "RE78", 170],
  ["PY2ABC", "GG66", 108],
  ["LU1ABC", "GF05", 100],
  ["ZS6ABC", "KG44", 462],
  ["4X4ABC", "KM72", 336],
  ["JY9ABC", "KM71", 342],
  ["9V1ABC", "OJ11", 381],
  ["BV1ABC", "PL05", 386],
  ["HL1ABC", "PM37", 137],
  ["VU2ABC", "MK82", 324],
  ["A71ABC", "LL55", 376],
];

async function main() {
  if (process.env.NODE_ENV === "production" && !FORCE) {
    console.error(
      "Refusing to seed with NODE_ENV=production. Pass --force if you really mean it.",
    );
    process.exit(1);
  }

  const existingQsos = await prisma.qso.count();
  if (existingQsos > 0) {
    console.log(
      `Log already contains ${existingQsos} QSO(s). Seeding anyway — this ADDS data, it does not reset.`,
    );
  }

  // USE THE STATION SETUP CREATED. Never invent one.
  //
  // Sample contacts have to be logged against a station, and the only correct station is
  // the operator's own. Creating one here is what put a hardcoded callsign in this file in
  // the first place, so this refuses instead — and refusing is cheap, because /setup asks
  // for the callsign before anything else can happen.
  const station = await prisma.station.findFirst({ include: { operators: true } });
  if (!station) {
    console.error("No station exists yet. Visit /setup first — it asks for the callsign");
    console.error("and grid the radio will transmit. This script will not invent one: a");
    console.error("program that ships a default callsign transmits under somebody else's.");
    process.exit(1);
  }
  console.log(`Logging sample contacts against ${station.callsign} (${station.grid})`);
  if (station.operators.length === 0) {
    await prisma.operator.createMany({
      data: OPERATORS.map((o) => ({ ...o, stationId: station.id })),
    });
    console.log(`Added ${OPERATORS.length} operator label(s)`);
  }

  const operatorIds = station.operators.map((o) => o.id);

  // Fixed anchor rather than "now", so re-seeding produces identical timestamps
  // and the ADIF importer's duplicate detection has something to catch.
  //
  // QSOs are spread BACKWARD from the anchor. Spreading forward put sample
  // contacts up to two years in the future, which is nonsense in a logbook and
  // pollutes any "recent activity" view.
  const anchor = Date.UTC(2026, 5, 1, 14, 0, 0);
  const SPACING_MS = 13 * 24 * 3600_000;

  const rows: Prisma.QsoCreateManyInput[] = [];

  CONTACTS.forEach(([call, grid, dxcc], ci) => {
    // Two QSOs per contact, on different band/mode slots.
    for (let k = 0; k < 2; k++) {
      const slot = SLOTS[(ci * 2 + k) % SLOTS.length]!;
      const digital = slot.mode === "FT8" || slot.mode === "FT4";

      // Spread back across ~2 years so year-over-year views have data.
      const startTime = new Date(
        anchor - (ci * 2 + k) * SPACING_MS + k * 3600_000,
      );

      // Vary confirmation state deterministically: roughly half confirmed by
      // some method, so worked-vs-confirmed filters show a real split.
      const n = ci * 2 + k;
      const lotwRcvd = n % 3 === 0;
      const eqslRcvd = n % 5 === 0;
      const cardRcvd = n % 7 === 0;

      const snr = -22 + ((n * 7) % 30);

      rows.push({
        callsign: call,
        band: slot.band,
        freqHz: BigInt(slot.freqHz),
        mode: slot.mode,
        startTime,
        endTime: new Date(startTime.getTime() + (digital ? 120_000 : 420_000)),
        rstSent: digital ? String(snr) : slot.mode === "CW" ? "599" : "59",
        rstRcvd: digital
          ? String(-20 + ((n * 11) % 28))
          : slot.mode === "CW"
            ? "579"
            : "57",
        gridSquare: grid,
        dxcc,
        // Award fields. US contacts get a state (WAS); everyone gets a continent
        // and CQ zone where known (WAC, WAZ); island entities get an IOTA ref.
        state:
          dxcc === 291 ? (US_STATES[ci % US_STATES.length] ?? null) : null,
        county: dxcc === 291 && ci % 4 === 0 ? "Porter" : null,
        cqZone: ENTITY_META[dxcc]?.cqz ?? null,
        ituZone: null,
        iota: IOTA_BY_DXCC[dxcc] ?? null,
        continent: ENTITY_META[dxcc]?.cont ?? null,
        qslSent: n % 4 === 0 ? "SENT" : "NONE",
        qslRcvd: cardRcvd ? "CONFIRMED" : "NONE",
        qslSentAt: n % 4 === 0 ? new Date(startTime.getTime() + 86_400_000) : null,
        qslRcvdAt: cardRcvd ? new Date(startTime.getTime() + 30 * 86_400_000) : null,
        lotwSent: true,
        lotwRcvd,
        eqslSent: digital,
        eqslRcvd,
        notes:
          n % 9 === 0
            ? `Seed data — ${slot.mode} on ${slot.band}, ${digital ? "decoded" : "worked"} at ${snr} dB`
            : null,
        stationId: station!.id,
        operatorId: operatorIds[n % operatorIds.length] ?? null,
      });
    }
  });

  const { count } = await prisma.qso.createMany({ data: rows });
  console.log(`Created ${count} QSOs across ${new Set(rows.map((r) => r.band)).size} bands`);

  const total = await prisma.qso.count();
  console.log(`\nLog now holds ${total} QSO(s).`);
  console.log("No user account was created — visit /setup to make the first admin.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
