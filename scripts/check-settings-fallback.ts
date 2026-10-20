/* eslint-disable no-console */
// R12: a stored setting that cannot be decrypted is UNAVAILABLE, not absent.
//
// THE FAULT (code review 2026-10-14, reproduced). readRow() returned null both for "no row"
// and for "a row that will not decrypt", and getSetting() then walked on to legacy keys and
// the .env fallback in both cases. A corrupt saved qrz.password therefore made the app
// log in with whatever QRZ_PASSWORD an old .env still held: a different credential from
// the one the operator saved, used silently, contrary to readRow's own comment.
//
// Only an ABSENT value falls back now. An unreadable one resolves to null for callers that
// just want a usable value (so nothing starts throwing), to an explicit "unreadable" state
// for those that ask, and to a field the settings page can show.
//
// Uses invented values only and prints none. SETTINGS_KEY is a throwaway generated here.
//
// Run: npx tsx scripts/check-settings-fallback.ts

import { randomBytes } from "node:crypto";

import { installFakePrisma, makeReporter } from "./fake-prisma";

const fake = installFakePrisma(["setting"]);
const { ok, eq, section, finish } = makeReporter();

interface Row {
  key: string;
  value: string;
  encrypted: boolean;
}
let rows: Row[] = [];
fake.setting.findMany = async () => rows.map((r) => ({ ...r }));

/** Environment variables this check touches, restored at the end. */
const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function main(): Promise<void> {
  setEnv("SETTINGS_KEY", randomBytes(32).toString("hex"));
  const settings = await import("@/lib/settings");
  const { encryptSecret } = await import("@/lib/settings/crypto");
  const { SETTINGS } = await import("@/lib/settings/registry");

  // Discovered rather than named, so a registry tidy-up does not silently hollow this out.
  const secretWithEnv = SETTINGS.find((d) => d.type === "secret" && d.envFallback);
  const legacyWithEnv = SETTINGS.find((d) => (d.legacyKeys?.length ?? 0) > 0 && d.envFallback);
  const plainLegacy = SETTINGS.find(
    (d) => (d.legacyKeys?.length ?? 0) > 0 && !d.envFallback && d.type !== "secret" && d.default === undefined,
  );

  const use = (next: Row[]): void => {
    rows = next;
    settings.invalidateSettingsCache();
  };
  const corrupt = (key: string): Row => ({ key, value: "v1:AAAA:BBBB:CCCC", encrypted: true });
  const sealed = (key: string, plain: string): Row => ({ key, value: encryptSecret(plain), encrypted: true });
  const state = async (key: string): Promise<{ status?: string; storedKey?: string; source?: string; value?: string }> => {
    const fn = (settings as unknown as Record<string, unknown>).getSettingState;
    if (typeof fn !== "function") return { status: "getSettingState is not exported" };
    return (await (fn as (k: string) => Promise<Record<string, string>>)(key)) as never;
  };

  section("an unreadable stored secret does not revive the .env credential");
  if (!secretWithEnv) {
    console.log("  SKIP  the registry has no secret with an envFallback");
  } else {
    const key = secretWithEnv.key;
    const env = secretWithEnv.envFallback!;
    setEnv(env, "invented-old-environment-value");

    use([corrupt(key)]);
    eq(await settings.getSetting(key), null, `${key}: a corrupt stored value yields null, not ${env}`);
    const s = await state(key);
    ok(s.status === "unreadable" && s.storedKey === key, `${key}: and reports itself as unreadable`, JSON.stringify(s));
    let threw = false;
    try {
      await settings.getBooleanSetting(key, true);
      await settings.getNumberSetting(key, 7);
      await settings.getSettings([key]);
    } catch {
      threw = true;
    }
    ok(!threw, "no reader throws on an unreadable value");

    const views = await settings.describeSettings();
    const view = views.find((v) => v.key === key) as (typeof views)[number] & { unreadable?: boolean; problem?: string | null };
    ok(view?.unreadable === true, "the settings page is told the stored value is unreadable");
    ok(
      typeof view?.problem === "string" && /decrypt/i.test(view.problem) && /re-enter/i.test(view.problem),
      "with an instruction to re-enter it",
      String(view?.problem),
    );
    ok(view?.source === "database" && view.fromEnv === false && view.value === null, "it is the stored value being described, not the .env one");
    ok(Boolean(view?.masked && /decrypt/i.test(view.masked)), "and the existing mask slot says so", String(view?.masked));
    ok(!JSON.stringify(views).includes("invented-old-environment-value"), "no plaintext reaches the page");

    use([]);
    eq(await settings.getSetting(key), "invented-old-environment-value", `${key}: an ABSENT value still falls back to ${env}`);
    ok((await state(key)).source === "env", "reported as coming from the environment");

    use([sealed(key, "invented-saved-value")]);
    eq(await settings.getSetting(key), "invented-saved-value", `${key}: a readable stored value wins over ${env}`);
    ok((await state(key)).status === "value", "reported as a value");
  }

  section("legacy keys: only absence moves on to the next place");
  if (!legacyWithEnv) {
    console.log("  SKIP  the registry has no setting with both legacyKeys and an envFallback");
  } else {
    const key = legacyWithEnv.key;
    const legacy = legacyWithEnv.legacyKeys![0]!;
    const env = legacyWithEnv.envFallback!;
    setEnv(env, "4242");

    use([corrupt(legacy)]);
    eq(await settings.getSetting(key), null, `${key}: an unreadable ${legacy} row does not fall through to ${env}`);
    const s = await state(key);
    ok(s.status === "unreadable" && s.storedKey === legacy, "and names the legacy row as the unreadable one", JSON.stringify(s));
    const view = (await settings.describeSettings()).find((v) => v.key === key) as { unreadable?: boolean; problem?: string } | undefined;
    ok(view?.unreadable === true && Boolean(view.problem?.includes(legacy)), "the page says which key is unreadable", String(view?.problem));

    use([corrupt(key), sealed(legacy, "4343")]);
    eq(await settings.getSetting(key), null, `${key}: an unreadable current row does not revive the older ${legacy} value`);

    use([sealed(legacy, "4343")]);
    eq(await settings.getSetting(key), "4343", `${key}: an absent current row still reads ${legacy}`);
  }

  section("a blank plain row is still absent");
  if (!plainLegacy) {
    console.log("  SKIP  the registry has no plain setting with legacyKeys");
  } else {
    const legacy = plainLegacy.legacyKeys![0]!;
    use([
      { key: plainLegacy.key, value: "", encrypted: false },
      { key: legacy, value: "10.0.0.9", encrypted: false },
    ]);
    eq(await settings.getSetting(plainLegacy.key), "10.0.0.9", `${plainLegacy.key}: "" falls back to ${legacy}, as before`);
  }

  section("the page and the readers agree on every setting");
  {
    // Every registry key in one of four stored states, rotating.
    const fixture: Row[] = [];
    SETTINGS.forEach((d, i) => {
      if (i % 4 === 0) fixture.push(corrupt(d.key));
      else if (i % 4 === 1) fixture.push(sealed(d.key, `v${i}`));
      else if (i % 4 === 2) fixture.push({ key: d.key, value: "", encrypted: false });
    });
    use(fixture);
    const views = await settings.describeSettings();
    const disagree: string[] = [];
    for (const v of views) {
      const value = await settings.getSetting(v.key);
      const s = await state(v.key);
      const unreadable = (v as { unreadable?: boolean }).unreadable === true;
      if (unreadable !== (s.status === "unreadable")) disagree.push(`${v.key}: page unreadable=${unreadable}, state ${s.status}`);
      if (unreadable && value !== null) disagree.push(`${v.key}: unreadable on the page but getSetting returned a value`);
      if (!unreadable && v.source !== "unset" && v.source !== (s.source ?? "unset")) {
        disagree.push(`${v.key}: page source ${v.source}, state source ${String(s.source)}`);
      }
    }
    ok(disagree.length === 0, `describeSettings and getSetting agree for all ${views.length} settings`, disagree.slice(0, 5).join("; "));
  }

  section("no SETTINGS_KEY at all");
  if (secretWithEnv) {
    const key = secretWithEnv.key;
    const row = sealed(key, "invented-saved-value");
    setEnv("SETTINGS_KEY", undefined);
    use([row]);
    eq(await settings.getSetting(key), null, "a saved secret with the key gone is unavailable, not the .env value");
    const view = (await settings.describeSettings()).find((v) => v.key === key) as { problem?: string } | undefined;
    ok(Boolean(view?.problem?.includes("SETTINGS_KEY")), "and the page blames SETTINGS_KEY", String(view?.problem));
  }

  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
