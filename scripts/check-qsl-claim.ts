/* eslint-disable no-console */
// R07: sending approved QSLs claims each row before mailing it.
//
// The web process (Send) and the bridge (the automatic run) both call sendApprovedQsls. Each
// used to read the APPROVED rows, mail them, then mark them SENT — so the two could mail the
// same stranger twice — and an opt-out that cancelled a row after the batch was read was
// mailed anyway and then overwritten SKIPPED → SENT.
//
// Runs the real lib/qsl/queue.ts — loaded TWICE, as two separate module instances standing in
// for the two processes, so nothing process-local can be what makes it pass — against the
// in-memory database model in scripts/fake-db.ts. SMTP is a fake nodemailer transport; the
// configured host is under .invalid, so even a failed patch could not deliver anything.

import nodemailer from "nodemailer";

import { FakeDb, type Row } from "./fake-db";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${!cond && detail ? ` — ${detail}` : ""}`);
}

process.env.SETTINGS_KEY = process.env.SETTINGS_KEY ?? "check-qsl-claim-key";

const db = new FakeDb();
db.install();

// Every message "handed to the mail server", by recipient.
const mailed: string[] = [];
let onSend: ((to: string) => Promise<void>) | null = null;
let afterAccept: ((to: string) => void) | null = null;
(nodemailer as unknown as { createTransport: unknown }).createTransport = () => ({
  async sendMail(msg: { to: string }) {
    if (onSend) await onSend(msg.to);
    await new Promise((r) => setTimeout(r, 20));
    mailed.push(msg.to);
    afterAccept?.(msg.to);
    return { messageId: `<fake-${mailed.length}@example.invalid>` };
  },
  async verify() {
    return true;
  },
  close() {},
});

const timesMailed = (call: string) => mailed.filter((to) => to === `${call.toLowerCase()}@example.invalid`).length;
const row = (id: string): Row | undefined => db.rows("qslEmail").find((r) => r.id === id);

function seed(calls: string[]): void {
  db.reset();
  mailed.length = 0;
  onSend = null;
  afterAccept = null;
  db.seed("setting", [
    { key: "smtp.host", value: "smtp.example.invalid", encrypted: false },
    { key: "smtp.from", value: "station@example.invalid", encrypted: false },
    { key: "app.baseUrl", value: "https://shack.example.invalid", encrypted: false },
    { key: "qsl.card.enabled", value: "false", encrypted: false },
  ]);
  const t0 = Date.now() - 3_600_000;
  calls.forEach((call, i) => {
    db.seed("qso", [{ id: `qso-${call}`, callsign: call, emailQslSent: false, emailQslSentAt: null }]);
    db.seed("qslEmail", [
      {
        id: `q-${call}`,
        qsoId: `qso-${call}`,
        callsign: call,
        toAddress: `${call.toLowerCase()}@example.invalid`,
        subject: `QSL ${call}`,
        bodyText: "73",
        bodyHtml: "<p>73</p>",
        status: "APPROVED",
        error: null,
        approvedAt: new Date(t0 + i * 1000),
        sentAt: null,
        createdAt: new Date(t0),
      },
    ]);
  });
}

type Queue = typeof import("@/lib/qsl/queue");

async function main() {
  const queuePath = require.resolve("@/lib/qsl/queue");
  const web = (await import("@/lib/qsl/queue")) as Queue;
  delete require.cache[queuePath];
  const bridge = require(queuePath) as Queue;
  ok(web !== bridge, "two independent instances of lib/qsl/queue.ts are loaded, one per 'process'");
  const { optOut } = await import("@/lib/qsl/opt-out");
  const { sentInLastDay } = await import("@/lib/qsl/auto");

  console.log("\ntwo senders at once — the Send button and the bridge's timer");
  {
    const calls = ["K1AAA", "K2BBB", "K3CCC", "K4DDD"];
    seed(calls);
    const [a, b] = await Promise.all([web.sendApprovedQsls({ limit: 10 }), bridge.sendApprovedQsls({ limit: 10 })]);
    ok(calls.every((c) => timesMailed(c) === 1), "every recipient is mailed exactly once", JSON.stringify(calls.map((c) => [c, timesMailed(c)])));
    ok(a.sent + b.sent === calls.length, "and the two runs' sent counts add up to the queue, not twice it", `${a.sent} + ${b.sent}`);
    const lost = ((a as { contended?: number }).contended ?? 0) + ((b as { contended?: number }).contended ?? 0);
    ok(lost === calls.length, "both runs read the whole batch, so each row was lost by exactly one of them", String(lost));
    ok(
      calls.every((c) => row(`q-${c}`)?.status === "SENT" && row(`q-${c}`)?.error === null),
      "every row ends SENT with its claim cleared",
    );
    ok(db.rows("qso").every((q) => q.emailQslSent === true), "and every QSO is flagged emailQslSent");
  }

  console.log("\nan opt-out arriving after the batch was read");
  {
    seed(["K1AAA", "K2XYZ", "K3CCC"]);
    onSend = async (to) => {
      if (to.startsWith("k1aaa")) await optOut("K2XYZ", "LINK", "clicked mid-run");
    };
    await web.sendApprovedQsls({ limit: 10 });
    ok(timesMailed("K2XYZ") === 0, "the operator who clicked is not mailed", `${timesMailed("K2XYZ")} messages`);
    ok(row("q-K2XYZ")?.status === "SKIPPED", "and their row stays SKIPPED, not overwritten with SENT", String(row("q-K2XYZ")?.status));
    ok(timesMailed("K3CCC") === 1, "the rest of the batch still goes");
  }

  console.log("\nan opt-out recorded but not yet cancelled (the gap between optOut's two writes)");
  {
    seed(["K1AAA", "K2BBB"]);
    db.seed("qslOptOut", [{ id: "oo-1", callsign: "K2BBB", source: "MANUAL", note: null }]);
    const r = await web.sendApprovedQsls({ limit: 10 });
    ok(timesMailed("K2BBB") === 0, "the per-row check before SMTP catches it", `${timesMailed("K2BBB")} messages`);
    ok(row("q-K2BBB")?.status === "SKIPPED", "and marks the row SKIPPED", String(row("q-K2BBB")?.status));
    ok((r as { skipped?: number }).skipped === 1 && r.attempted === 1, "reported as skipped, not attempted", JSON.stringify(r));
  }

  console.log("\na row replaced while its message was in flight");
  {
    seed(["K5EEE"]);
    onSend = async () => {
      // What a gateway re-queue does to the row, then the recipient opting out of it.
      await db.poke("qslEmail", "q-K5EEE", { status: "PENDING", error: null });
      await optOut("K5EEE", "LINK", "clicked mid-send");
    };
    await web.sendApprovedQsls({ limit: 10 });
    ok(row("q-K5EEE")?.status === "SKIPPED", "the SKIPPED row is not overwritten with SENT when the send finishes", String(row("q-K5EEE")?.status));
  }

  console.log("\nthe daily cap sees a send that is still in flight");
  {
    seed(["K6FFF"]);
    let during = -1;
    onSend = async () => {
      during = await sentInLastDay();
    };
    await web.sendApprovedQsls({ limit: 10 });
    ok(during === 1, "sentInLastDay counts the claimed row while SMTP is busy with it", String(during));
  }

  console.log("\na crash between SMTP accepting the message and recording it — at most once");
  {
    seed(["K7GGG"]);
    afterAccept = () => {
      db.failWrites = new Error("simulated: connection to the database lost");
    };
    const first = await web.sendApprovedQsls({ limit: 10 }).then(
      () => "returned",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    db.failWrites = null;
    afterAccept = null;
    ok(first.includes("connection to the database lost"), "the first run fails when it cannot record the result", first);
    await bridge.sendApprovedQsls({ limit: 10 });
    ok(timesMailed("K7GGG") === 1, "a later run does NOT mail it again", `${timesMailed("K7GGG")} messages`);
    const r = row("q-K7GGG");
    const unconfirmed = (web as Partial<Queue>).isUnconfirmedSend;
    ok(
      typeof unconfirmed === "function" && !!r && unconfirmed({ status: String(r.status), error: (r.error as string | null) ?? null }),
      "and the row reads as an unconfirmed send (SENT, claim still in error)",
      JSON.stringify({ status: r?.status, error: r?.error }),
    );
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
