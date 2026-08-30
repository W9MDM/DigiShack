/* eslint-disable no-console */
// The per-radio transmit gate.
//
// This decides whether a radio may key. It used to be one setting shared by both, so
// arming a FlexRadio on a real antenna also armed an IC-7300 that might be on a dummy
// load. The rules below are the whole safety contract: each radio arms on its own key,
// inherits nothing from the other, and defaults to off.
//
// It writes real settings, so it refuses to run while the station is operating.

import {
  digitalTransmitHeld,
  isTransmitArmed,
  setDigitalTransmitHold,
  transmitGate,
  transmitGateKey,
} from "@/lib/radio/transmit-gate";
import { prisma } from "@/lib/db/prisma";
import { skipWithoutDatabase } from "./needs-db";
import { getSetting, writeSettings } from "@/lib/settings";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(a === b, label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

async function main(): Promise<void> {
  // A missing database is a skip, not a crash. See scripts/needs-db.ts.
  if (await skipWithoutDatabase("check:transmit-gate")) return;
  eq(transmitGateKey("flex"), "flex.allowTransmit", "the Flex key is unchanged");
  eq(transmitGateKey("icom"), "icom.allowTransmit", "the Icom has its own key");

  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  if (!admin) {
    console.log("\n  (no admin user — skipping the database-backed cases)");
    console.log(`\n${pass} passed, ${fail} failed\n`);
    return;
  }

  // Refuse to run against a station that is currently operating.
  //
  // The cases below write the real transmit gate, disarming and rearming it several
  // times. Doing that while an automatic mode is mid-QSO could abort a transmission
  // half-sent. The first version of this test had no such guard and was run against a
  // live station hunting at 90% — it happened to fall between transmissions, which is
  // luck rather than a property of the test.
  try {
    const tok = await getSetting("bridge.token");
    const port = (await getSetting("bridge.port")) ?? "3101";
    if (tok) {
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { "X-Bridge-Token": tok },
        signal: AbortSignal.timeout(2_000),
      });
      const s = (await res.json()) as { auto?: { mode?: string }; status?: { transmitting?: boolean } };
      const mode = s.auto?.mode ?? "off";
      if (mode !== "off" || s.status?.transmitting) {
        console.log(
          `\n  SKIPPED the database-backed cases: the bridge is operating (auto=${mode}` +
            `${s.status?.transmitting ? ", transmitting" : ""}).\n` +
            "  This test writes the live transmit gate and must not interrupt a QSO.\n" +
            "  Stop automatic operation, or the bridge, and run it again.",
        );
        console.log(`\n${pass} passed, ${fail} failed\n`);
        await prisma.$disconnect();
        return;
      }
    }
  } catch {
    // No bridge reachable, which is the normal case in CI. Carry on.
  }

  // Snapshot and restore. This test writes real settings on a live station, and
  // leaving the transmit gate in the wrong state would be a genuinely bad outcome.
  const before = await prisma.setting.findMany({
    where: { key: { in: ["flex.allowTransmit", "icom.allowTransmit"] } },
    select: { key: true, value: true },
  });
  const restore = async () => {
    await prisma.setting.deleteMany({
      where: { key: { in: ["flex.allowTransmit", "icom.allowTransmit"] } },
    });
    for (const r of before) {
      await writeSettings([{ key: r.key, value: r.value }], admin.id);
    }
  };

  try {
    const set = async (k: string, v: string) => writeSettings([{ key: k, value: v }], admin.id);
    // Through writeSettings, so the settings cache is invalidated. A raw
    // prisma.setting.deleteMany leaves the cache holding the old value, and the test
    // then measures nothing at all — which is exactly how an earlier version of this
    // reported the opposite of the truth.
    const clear = async (k: string) => writeSettings([{ key: k, value: null }], admin.id);

    console.log("\nthe radios are independent");
    await set("flex.allowTransmit", "true");
    await set("icom.allowTransmit", "false");
    eq(await isTransmitArmed("flex"), true, "the Flex is armed");
    eq(await isTransmitArmed("icom"), false, "and the Icom is NOT, despite the Flex being on");

    await set("flex.allowTransmit", "false");
    await set("icom.allowTransmit", "true");
    eq(await isTransmitArmed("flex"), false, "the Flex is off");
    eq(await isTransmitArmed("icom"), true, "and the Icom is on — the reverse also holds");

    console.log("\nno inheritance, in either direction");
    // An earlier draft had the Icom fall back to the Flex's setting when its own had
    // never been touched. It was dropped for two reasons, and the second is why this
    // test exists at all: it guarded a state that cannot occur — no install has ever
    // had an armed Icom, the radio is new — and `getSetting` returns the registry
    // default rather than null for an unset key, so the "has this been set?" check it
    // relied on could never have been true. It would have been dead code that read
    // like a safety feature.
    await set("flex.allowTransmit", "true");
    await set("icom.allowTransmit", "false");
    eq(await isTransmitArmed("icom"), false, "an armed Flex does not arm the Icom");

    await set("flex.allowTransmit", "false");
    await set("icom.allowTransmit", "true");
    eq(await isTransmitArmed("flex"), false, "and an armed Icom does not arm the Flex");

    console.log("\ndefault is off");
    await clear("flex.allowTransmit");
    await clear("icom.allowTransmit");
    eq(await isTransmitArmed("flex"), false, "unset means off for the Flex");
    eq(await isTransmitArmed("icom"), false, "unset means off for the Icom");

    console.log("\nthe gate is re-read, not snapshotted");
    // Snapshotting was a real bug once: setAllowTransmit had no callers, so flipping
    // the setting did nothing until a restart while its help text promised otherwise.
    const gate = transmitGate("icom");
    await set("icom.allowTransmit", "true");
    eq(await gate(), true, "the closure sees a change made after it was created");
    await set("icom.allowTransmit", "false");
    eq(await gate(), false, "and sees it change back");

    console.log("\nthe digital hold, which voice mode uses");
    // THE bug this exists for. Voice mode was enforced in the radio service's own wrapper
    // around isTransmitArmed. That closed every ENDPOINT — auto, tune, ATU — and left the one
    // path that matters open: the transmitters take their gate from `transmitGate` and never
    // touch the wrapper. So switching to voice stopped anything new from starting while a QSO
    // already in flight carried on keying the radio and sending FT8, which is exactly the
    // collision voice mode exists to prevent. Reported from the operating position.
    //
    // The hold has to sit where the TRANSMITTERS read, so these assertions go through the same
    // closure they are handed rather than through the direct call.
    const flexGate = transmitGate("flex");
    const icomGate = transmitGate("icom");
    await set("flex.allowTransmit", "true");
    await set("icom.allowTransmit", "true");
    eq(await flexGate(), true, "setting on, no hold: the Flex gate is open");
    eq(await icomGate(), true, "and the Icom's");

    setDigitalTransmitHold(true);
    eq(await flexGate(), false, "the hold closes the gate the FlexRadio TRANSMITTER reads");
    eq(await icomGate(), false, "and the one the Icom transmitter reads");
    eq(await isTransmitArmed("icom"), false, "and the direct call the endpoints use");
    eq(digitalTransmitHeld(), true, "and it reports itself, so a message can say why");

    setDigitalTransmitHold(false);
    eq(await flexGate(), true, "releasing it reopens both");
    eq(await icomGate(), true, "on both radios");
    eq(digitalTransmitHeld(), false, "and reports clear");

    // The hold must never touch the operator's own setting: their configuration should not be
    // altered by a mode switch, and a crash mid-voice must not leave a station that refuses to
    // transmit for a reason nobody can find.
    await set("icom.allowTransmit", "false");
    setDigitalTransmitHold(true);
    eq(await icomGate(), false, "held and disabled is closed");
    setDigitalTransmitHold(false);
    eq(
      await icomGate(),
      false,
      "and releasing the hold does not arm a radio the operator had disabled",
    );
  } finally {
    await restore();
    const f = await isTransmitArmed("flex");
    const i = await isTransmitArmed("icom");
    console.log(`\n  (restored: flex armed=${f}, icom armed=${i})`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

void main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
