/* eslint-disable no-console */
// Station-scoped settings: each station's accounts are its own, and nothing borrows another's.
// Run: npm run check:station-scope
//
// THE FAULT THIS GUARDS. One install, two stations - K9XYZ and the club's K9PC. Before station
// profiles, QRZ, LoTW, eQSL, Club Log and Cloudlog each had one set of credentials for the
// install, so a K9PC contact uploaded to K9XYZ's QRZ logbook and was signed with K9XYZ's LoTW
// certificate. The rule now: inside withStation(K9PC) every account setting is K9PC's, or
// nothing. Never K9XYZ's, and never a .env value, which was put there for the home station.

import { readFileSync } from "node:fs";

import { installFakePrisma, makeReporter } from "./fake-prisma";

const fake = installFakePrisma(["setting", "station", "stationSetting"]);
const { ok, eq, section, finish } = makeReporter();

const HOME = "st-home";
const CLUB = "st-club";
const settings: { key: string; value: string; encrypted: boolean }[] = [];
const stationRows: { stationId: string; key: string; value: string; encrypted: boolean }[] = [
  { stationId: HOME, key: "qrz.logbookApiKey", value: "HOME-QRZ", encrypted: false },
  { stationId: HOME, key: "cloudlog.url", value: "https://home.example", encrypted: false },
];

fake.setting.findMany = async () => settings.map((r) => ({ ...r }));
fake.station.findFirst = async () => ({ id: HOME });
// No recorded station.homeId: home is the oldest, as on an install that predates the record.
fake.setting.findUnique = async () => null;
fake.stationSetting.findMany = async ({ where }: { where: { stationId: string } }) =>
  stationRows.filter((r) => r.stationId === where.stationId).map((r) => ({ ...r }));
fake.stationSetting.upsert = async ({ create }: { create: (typeof stationRows)[number] }) => {
  const i = stationRows.findIndex((r) => r.stationId === create.stationId && r.key === create.key);
  if (i >= 0) stationRows[i] = { ...create };
  else stationRows.push({ ...create });
  return create;
};

async function main(): Promise<void> {
  const { getSetting, writeSettings, invalidateSettingsCache } = await import("../lib/settings");
  const { withStation, STATION_SCOPED_KEYS, isStationScoped } = await import("../lib/station/scope");

  section("each station reads its own accounts");
  eq(await getSetting("qrz.logbookApiKey"), "HOME-QRZ", "outside any scope a scoped key means the home station");
  eq(await withStation(HOME, () => getSetting("qrz.logbookApiKey")), "HOME-QRZ", "the home station reads its own");
  eq(await withStation(CLUB, () => getSetting("qrz.logbookApiKey")), null, "K9PC with no key gets NOTHING, not K9XYZ's");
  eq(await withStation(CLUB, () => getSetting("cloudlog.url")), null, "nor K9XYZ's Cloudlog");

  section(".env belongs to the home station");
  process.env.QRZ_LOGBOOK_API_KEY = "FROM-ENV";
  stationRows.splice(stationRows.findIndex((r) => r.key === "qrz.logbookApiKey"), 1);
  invalidateSettingsCache();
  eq(await withStation(HOME, () => getSetting("qrz.logbookApiKey")), "FROM-ENV", "home still falls back to .env");
  eq(await withStation(CLUB, () => getSetting("qrz.logbookApiKey")), null, "K9PC never does");
  delete process.env.QRZ_LOGBOOK_API_KEY;

  section("writes go to the station in scope");
  await withStation(CLUB, () => writeSettings([{ key: "cloudlog.url", value: "https://example.com" }], "u1"));
  eq(stationRows.find((r) => r.stationId === CLUB && r.key === "cloudlog.url")?.value, "https://example.com", "K9PC's row written");
  eq(stationRows.find((r) => r.stationId === HOME && r.key === "cloudlog.url")?.value, "https://home.example", "K9XYZ's untouched");
  eq(await withStation(CLUB, () => getSetting("cloudlog.url")), "https://example.com", "and K9PC reads it back");
  eq(await getSetting("cloudlog.url"), "https://home.example", "while the home station still reads its own");

  section("install-wide settings stay install-wide");
  ok(!isStationScoped("uploads.enabled"), "the upload switches are not per station");
  ok(!isStationScoped("flex.host"), "nor the radio");

  section("the migration copies exactly the scoped keys");
  const sql = readFileSync("prisma/migrations/20261101130000_station_profiles/migration.sql", "utf8");
  const inList = sql.slice(sql.indexOf("WHERE s.`key` IN ("));
  const copied = new Set([...inList.slice(0, inList.indexOf(");")).matchAll(/'([^']+)'/g)].map((m) => m[1]));
  eq([...copied].sort().join(","), [...STATION_SCOPED_KEYS].sort().join(","), "migration key list matches STATION_SCOPED_KEYS");

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
