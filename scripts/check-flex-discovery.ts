/* eslint-disable no-console */
// Which discovered FlexRadio a bridge connects to.
// Run: npm run check:flex-discovery
//
// THE FAULT. startFlexSource used `found[0]`, whichever radio answered first. With two Flexes
// on the LAN that was a coin toss per restart, and the losing toss keyed a transmitter under a
// callsign that does not belong to it. See lib/radio/identity.ts.

import type { FlexRadioInfo } from "../lib/flex/discovery";
import { pickDiscoveredFlex } from "../lib/radio/identity";
import { makeReporter } from "./fake-prisma";

const { ok, eq, section, finish } = makeReporter();

const radio = (serial: string, ip: string): FlexRadioInfo => ({
  address: ip, model: "FLEX-6600", nickname: null, callsign: null, serial, version: null, ip, port: 4992,
  status: null, maxSlices: null, availableSlices: null, guiClientIps: [], raw: {}, seenAt: "",
});
const A = radio("1111-AAAA", "192.0.2.50");
const B = radio("2222-BBBB", "192.0.2.51");

section("unpinned");
{
  const one = pickDiscoveredFlex([A], null);
  ok(one.ok && one.radio === A, "exactly one answer is used");
  const none = pickDiscoveredFlex([], null);
  ok(!none.ok, "no answer is an error");
  const two = pickDiscoveredFlex([A, B], null);
  ok(!two.ok, "two answers are REFUSED, not found[0]");
  ok(!two.ok && two.error.includes("1111-AAAA") && two.error.includes("2222-BBBB"), "and the refusal names both serials");
}

section("pinned by serial");
{
  const b = pickDiscoveredFlex([A, B], "2222-bbbb");
  ok(b.ok && b.radio === B, "the pinned serial wins among several, case-insensitively");
  const missing = pickDiscoveredFlex([A], "2222-BBBB");
  ok(!missing.ok, "a pinned serial that did not answer is an error...");
  ok(!missing.ok && missing.error.includes("1111-AAAA"), "...naming what answered instead, never connecting to it");
  eq(pickDiscoveredFlex([A], "  ").ok, true, "a blank pin is no pin");
}

finish();
