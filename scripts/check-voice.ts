// Voice mode, which is mostly about what must STOP.
//
// The dangerous state here is not a missing feature. It is an auto operator answering a CQ
// while an operator is talking — the same radio keyed from two places, with no arbitration
// between them and none wanted. Only one of the two may own the transmitter, and these
// assertions are about the rules that decide which.

import {
  conventionalSideband,
  idleVoiceState,
  isVoiceCapableMode,
  VOICE_REFUSAL,
} from "@/lib/radio/voice";

let pass = 0;
let fail = 0;

function ok(cond: boolean, what: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${what}`);
  } else {
    fail++;
    console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(got: unknown, want: unknown, what: string): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, what, a === b ? "" : `got ${a}, want ${b}`);
}

console.log("\nwhich sideband");
{
  // The convention every other station on the band is using. A voice contact on the wrong
  // sideband is not unconventional, it is inaudible.
  eq(conventionalSideband(3_800_000), "LSB", "80m is lower sideband");
  eq(conventionalSideband(7_200_000), "LSB", "40m too");
  eq(conventionalSideband(14_250_000), "USB", "20m is upper");
  eq(conventionalSideband(28_400_000), "USB", "and 10m");
  // The boundary is 10 MHz by convention, and 30m has no voice at all — it is a CW and
  // data band by international agreement, so either answer is arbitrary. Upper is chosen
  // because everything above the line is upper.
  eq(conventionalSideband(10_100_000), "USB", "just above the line is upper");
  eq(conventionalSideband(9_999_999), "LSB", "just below is lower");
  // A radio that has not reported its dial yet. Guessing LSB would put an operator on the
  // wrong sideband on 20m, which is where this station spends its time.
  eq(conventionalSideband(null), "USB", "an unknown dial defaults to upper");
}

console.log("\nmodes a microphone actually works in");
{
  ok(isVoiceCapableMode("USB"), "USB carries a microphone");
  ok(isVoiceCapableMode("LSB"), "LSB does");
  ok(isVoiceCapableMode("FM"), "FM does");
  ok(isVoiceCapableMode("AM"), "AM does");

  // THE point of the function. Every one of these keys the transmitter and takes its
  // modulation from somewhere that is not the microphone, so an operator holding the PTT
  // sees the radio key, sees power, and transmits silence — the same fault as `MOD Input`
  // being wrong, reached from software instead of a menu.
  ok(!isVoiceCapableMode("USB-D"), "USB-D does NOT — data mode ignores the microphone");
  ok(!isVoiceCapableMode("DIGU"), "nor DIGU");
  ok(!isVoiceCapableMode("DIGL"), "nor DIGL");
  ok(!isVoiceCapableMode("PKTUSB"), "nor PKTUSB");
  ok(!isVoiceCapableMode("DATA-U"), "nor anything beginning DATA");
  ok(!isVoiceCapableMode("CW"), "and CW has no microphone at all");
  ok(!isVoiceCapableMode("RTTY"), "nor RTTY");

  ok(!isVoiceCapableMode(null), "an unknown mode is not assumed to be voice");
  ok(!isVoiceCapableMode(""), "nor an empty one");
  ok(isVoiceCapableMode("usb"), "and case does not matter");
}

console.log("\nthe idle state");
{
  const s = idleVoiceState();
  ok(!s.active, "starts off");
  eq(s.restoreTo, null, "with nothing to restore");
  eq(s.mode, null, "and no sideband");

  // Runtime state, never stored. A restart must come back as a digital station: the radio
  // returns in whatever mode this process last set, and resuming "voice" on a radio nobody
  // has looked at, for a browser that is no longer connected, is a state with nothing good
  // in it.
  ok(
    !("persist" in (s as unknown as Record<string, unknown>)),
    "and nothing that would survive a restart",
  );
}

console.log("\nthe refusal an operator will actually read");
{
  // "Transmit is disabled in settings" once sent an operator to the wrong page for an hour.
  // Voice mode is a state they can see and undo in one click, so the message has to say
  // that rather than blame the settings.
  ok(/voice mode/i.test(VOICE_REFUSAL), "names voice mode");
  ok(!/setting/i.test(VOICE_REFUSAL), "and does NOT send them to Settings");
  ok(/turn it off/i.test(VOICE_REFUSAL), "and says what to do about it");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
