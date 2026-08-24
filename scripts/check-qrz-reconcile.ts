/* eslint-disable no-console */
// Reconciling pasted QRZ card requests against the log and the incomplete exchanges.
//
// THE CATEGORY THAT MUST NOT COLLAPSE is `wrong-date`. Of one real batch of 134 requests, 37
// were stations already in the QRZ log on OTHER dates — an operator with nine contacts with us
// can easily cite the wrong one, and treating those as promotable invents contacts and uploads
// them to LoTW as claims against somebody else's log. Doing that by hand is what established
// these four verdicts; this is what stops them blurring.

import { reconcileRequests, tally, type ReconcileLookups } from "@/lib/qrz/reconcile";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}
function eq(got: unknown, want: unknown, label: string): void {
  const good = got === want;
  if (!good) {
    console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  }
  ok(good, label);
}

const req = (qsoDate: string, callsign: string) => ({ requestedAt: null, qsoDate, callsign });

function lookups(opts: {
  qsos?: Record<string, { at: string; band?: string; mode?: string; qrzSent?: boolean }[]>;
  incomplete?: Record<
    string,
    { at: string; sent?: string; rcvd?: string; promoted?: boolean; dismissed?: boolean }[]
  >;
}): ReconcileLookups {
  return {
    qsosFor: async (call) =>
      (opts.qsos?.[call] ?? []).map((q, i) => ({
        id: `q${i}`,
        startTime: new Date(q.at),
        band: q.band ?? "20M",
        mode: q.mode ?? "FT8",
        qrzSent: q.qrzSent ?? true,
      })),
    incompleteFor: async (call) =>
      (opts.incomplete?.[call] ?? []).map((x, i) => ({
        id: `i${i}`,
        startedAt: new Date(x.at),
        band: "20M",
        mode: "FT8",
        reportSent: x.sent ?? "-12",
        reportRcvd: x.rcvd ?? "+04",
        promotedQsoId: x.promoted ? "already" : null,
        dismissedAt: x.dismissed ? new Date("2026-01-01T00:00:00Z") : null,
      })),
  };
}

async function main(): Promise<void> {
  console.log("a contact already in the log");
  {
    const r = await reconcileRequests(
      [req("2026-02-08", "KQ4NAA")],
      lookups({ qsos: { KQ4NAA: [{ at: "2026-02-08T21:02:00Z" }] } }),
    );
    eq(r[0]?.verdict, "in-log", "the contact is found");
    ok(/uploaded to QRZ/i.test(r[0]!.note), "and the note says QRZ is not matching it");

    // Not yet uploaded reads differently: that one resolves itself.
    const pending = await reconcileRequests(
      [req("2026-02-08", "KQ4NAA")],
      lookups({ qsos: { KQ4NAA: [{ at: "2026-02-08T21:02:00Z", qrzSent: false }] } }),
    );
    ok(/not yet uploaded/i.test(pending[0]!.note), "an un-uploaded contact says so instead");
  }

  console.log("\nthe 36-hour window");
  {
    // A contact near UTC midnight is routinely filed on the adjacent date, so a day either
    // side still counts as the same contact.
    const dayBefore = await reconcileRequests(
      [req("2026-02-08", "K8NWN")],
      lookups({ qsos: { K8NWN: [{ at: "2026-02-07T23:50:00Z" }] } }),
    );
    eq(dayBefore[0]?.verdict, "in-log", "ten minutes before midnight is the same contact");

    const dayAfter = await reconcileRequests(
      [req("2026-02-08", "K8NWN")],
      lookups({ qsos: { K8NWN: [{ at: "2026-02-09T08:00:00Z" }] } }),
    );
    eq(dayAfter[0]?.verdict, "in-log", "and so is the following morning");

    // Three days out is not.
    const far = await reconcileRequests(
      [req("2026-02-08", "K8NWN")],
      lookups({ qsos: { K8NWN: [{ at: "2026-02-11T08:00:00Z" }] } }),
    );
    eq(far[0]?.verdict, "wrong-date", "three days out is a different contact");
  }

  console.log("\npromotable: reports both ways, no acknowledgement");
  {
    const r = await reconcileRequests(
      [req("2026-08-06", "K5PYT")],
      lookups({ incomplete: { K5PYT: [{ at: "2026-08-06T01:36:00Z", sent: "-12", rcvd: "+25" }] } }),
    );
    eq(r[0]?.verdict, "promotable", "the exchange is offered");
    eq(r[0]?.incomplete?.reportRcvd, "+25", "with the report they sent us");
    ok(/second record/i.test(r[0]!.note), "and the note explains why the request matters");

    // One already promoted must not be offered again.
    const done = await reconcileRequests(
      [req("2026-08-06", "K5PYT")],
      lookups({ incomplete: { K5PYT: [{ at: "2026-08-06T01:36:00Z", promoted: true }] } }),
    );
    eq(done[0]?.verdict, "unknown", "an already-promoted exchange is not offered twice");

    // Nor one the operator has dismissed.
    const gone = await reconcileRequests(
      [req("2026-08-06", "K5PYT")],
      lookups({ incomplete: { K5PYT: [{ at: "2026-08-06T01:36:00Z", dismissed: true }] } }),
    );
    eq(gone[0]?.verdict, "unknown", "nor a dismissed one");
  }

  console.log("\nwrong-date is never promotable");
  {
    // THE CASE THAT MATTERS. We have worked them repeatedly, and there is an incomplete
    // exchange too — but the request date matches NEITHER. Nothing distinguishes whose date is
    // wrong, so this must not be actioned.
    const r = await reconcileRequests(
      [req("2026-01-18", "AE0DC")],
      lookups({
        qsos: {
          AE0DC: [
            { at: "2025-10-10T12:00:00Z" },
            { at: "2026-01-13T12:00:00Z" },
            { at: "2026-08-20T12:00:00Z" },
          ],
        },
        incomplete: { AE0DC: [{ at: "2025-11-02T12:00:00Z" }] },
      }),
    );
    eq(r[0]?.verdict, "wrong-date", "a station worked on other dates is not promotable");
    // The NEAREST contact is named, not an arbitrary one — the operator judges by the gap.
    eq(
      r[0]?.workedAt?.toISOString().slice(0, 10),
      "2026-01-13",
      "and the nearest contact is the one reported",
    );
    // 4, not 5: the gap is 4.5 days and Math.round(-4.5) is -4 in JavaScript, which rounds
    // toward positive infinity on a tie rather than away from zero.
    ok(/4 days earlier/.test(r[0]!.note), `the gap is stated (${r[0]!.note.slice(0, 40)})`);
    ok(/nothing here says which/i.test(r[0]!.note), "and the ambiguity is stated outright");
  }

  console.log("\nnever worked at all");
  {
    const r = await reconcileRequests([req("2026-08-22", "VA3EWV")], lookups({}));
    eq(r[0]?.verdict, "unknown", "no contact and no exchange");
    ok(/on record/i.test(r[0]!.note), "and it says so plainly");
  }

  console.log("\nthe summary");
  {
    const r = await reconcileRequests(
      [
        req("2026-02-08", "KQ4NAA"),
        req("2026-08-06", "K5PYT"),
        req("2026-01-18", "AE0DC"),
        req("2026-08-22", "VA3EWV"),
      ],
      lookups({
        qsos: { KQ4NAA: [{ at: "2026-02-08T21:02:00Z" }], AE0DC: [{ at: "2026-01-13T12:00:00Z" }] },
        incomplete: { K5PYT: [{ at: "2026-08-06T01:36:00Z" }] },
      }),
    );
    const t = tally(r);
    eq(t["in-log"], 1, "one already logged");
    eq(t.promotable, 1, "one promotable");
    eq(t["wrong-date"], 1, "one with a date that matches nothing");
    eq(t.unknown, 1, "one unknown");
    eq(r.length, 4, "and every request gets exactly one verdict");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
