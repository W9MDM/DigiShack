// Assertions on the alert gate — the pure debounce deciding which emails go out.
//
// The property that matters: a fault repeating every 48 seconds all night produces
// ONE email (plus cooldown repeats), and a recovery is announced only for a fault
// that was. `now` is a parameter throughout, so no clocks and no waiting.

import { AlertGate } from "@/lib/alerts";

let failed = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const ok = Object.is(actual, expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok   " : "FAIL "} ${what}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
}

const HOUR = 3_600_000;

console.log("one email per fault");
{
  const g = new AlertGate();
  eq(g.raise("radio-down", 0, 6 * HOUR), true, "the first raise goes out");
  eq(g.raise("radio-down", 48_000, 6 * HOUR), false, "48s later it does not");
  eq(g.raise("radio-down", 5 * HOUR, 6 * HOUR), false, "five hours of retries stay silent");
  eq(g.raise("radio-down", 7 * HOUR, 6 * HOUR), true, "past the cooldown it reminds once");
  eq(g.raise("radio-down", 7 * HOUR + 1, 6 * HOUR), false, "and only once");
}

console.log("\nrecovery only for announced faults");
{
  const g = new AlertGate();
  eq(g.clear("radio-down"), false, "clearing a fault never raised owes no email");
  g.raise("radio-down", 0, HOUR);
  eq(g.clear("radio-down"), true, "clearing an announced fault owes one");
  eq(g.clear("radio-down"), false, "but not twice");
}

console.log("\na fault that clears and returns is news again");
{
  const g = new AlertGate();
  g.raise("radio-down", 0, 6 * HOUR);
  g.clear("radio-down");
  eq(
    g.raise("radio-down", 60_000, 6 * HOUR),
    true,
    "re-raised a minute after recovery — no cooldown, this is a NEW incident",
  );
}

console.log("\nkeys are independent");
{
  const g = new AlertGate();
  g.raise("radio-down", 0, 6 * HOUR);
  eq(g.raise("uploads-qrz", 1, 6 * HOUR), true, "a different fault is not debounced by the first");
  eq(g.clear("uploads-qrz"), true, "and clears independently");
  eq(g.clear("radio-down"), true, "leaving the first still owed its recovery");
}

console.log(failed === 0 ? "\nall alert assertions passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
