/* eslint-disable no-console */
// Received QSL cards: what is a card, whose it is, which contact it confirms — and the mail
// plumbing underneath (Microsoft Graph for reading and sending, the SMTP path left as it was).
// Run: npm run check:qsl-inbound
//
// No network, no tenant, no database. Microsoft is a fake `fetch`; the database is the
// in-memory model in scripts/fake-db.ts; the mailbox is a list of messages shaped like the
// ones the live probe of the operator's mailbox found — with every callsign and address
// swapped for a neutral one, because this file is published.
//
// THE SHAPES, from that probe, and the reason each assertion exists:
//   * our own outgoing cards were 259 of the "QSL" messages, from Exchange's internal
//     "/o=ExchangeLabs/..." address; importing one would credit a contact with OUR card;
//   * bounces of those ("Undeliverable: QSL Confirmation for …", "Mail Delivery failure.");
//   * received cards, the picture sometimes typed application/octet-stream;
//   * replies to our card, including through Winlink ("Re: //WL2K R/…");
//   * notices of a card waiting on digiqsl, qslworld or eQSL;
//   * a newsletter that a naive "QSL" search also matched.

import type { InboundStore, NewReceived } from "@/lib/qsl/inbound/import";
import type { MailSource, SourceAttachment, SourceMessage } from "@/lib/qsl/inbound/source";
import type { ImapResponse } from "@/lib/mail/imap";

import { FakeDb } from "./fake-db";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}
function eq(got: unknown, want: unknown, label: string): void {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(same, label, same ? undefined : { got, want });
}

process.env.SETTINGS_KEY = process.env.SETTINGS_KEY ?? "check-qsl-inbound-key";

// The fake database goes in BEFORE anything that imports lib/db/prisma, which is why every
// application import below is dynamic.
const db = new FakeDb();
db.install();

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20_000, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64, 1)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 1), Buffer.from("WEBP"), Buffer.alloc(64, 1)]);
const PDF = Buffer.from("%PDF-1.7\n% not a card at all\n");

const OUR = "K9XYZ";
const MAILBOX = "station@example.com";

async function main(): Promise<void> {
  const C = await import("@/lib/qsl/inbound/classify");
  const M = await import("@/lib/qsl/inbound/match");
  const I = await import("@/lib/qsl/inbound/import");
  const S = await import("@/lib/qsl/inbound/source");
  const G = await import("@/lib/mail/graph");
  const GS = await import("@/lib/qsl/inbound/graph-source");
  const N = await import("@/lib/qsl/inbound/notice");
  const P = await import("@/lib/mail/providers");
  const ST = await import("@/lib/qsl/inbound/status");
  const RUN = await import("@/lib/qsl/inbound/run");
  const MIME = await import("@/lib/mail/mime");
  const IMAP = await import("@/lib/mail/imap");

  const ctx = { mailbox: MAILBOX, ownCalls: [OUR], ownAddresses: [MAILBOX, "station@qsl.example.org"] };
  const sum = (o: Partial<{ from: string; fromName: string; subject: string; preview: string; hasAttachments: boolean }>) => ({
    from: "",
    fromName: "",
    subject: "",
    preview: "",
    hasAttachments: false,
    ...o,
  });

  // -------------------------------------------------------------------------
  console.log("\n1. our own outgoing cards are never received cards");
  {
    const exchange = "/o=exchangelabs/ou=exchange administrative group (fydibohf23spdlt)/cn=recipients/cn=0a1b2c3d-station";
    eq(C.classifyMessage(sum({ from: exchange, subject: `QSL Confirmation for KK1XYZ / ${OUR} QSO`, hasAttachments: true }), ctx).kind, "own", "the mailbox's internal Exchange address");
    eq(C.classifyMessage(sum({ from: MAILBOX, subject: "anything" }), ctx).kind, "own", "the mailbox's own SMTP address");
    eq(C.classifyMessage(sum({ from: "station@qsl.example.org", subject: "QSL Contact - K1ABC" , hasAttachments: true }), ctx).kind, "own", "another address the station sends from (mail moved to a new domain)");
    eq(C.classifyMessage(sum({ from: "relay@elsewhere.example", subject: `QSL Confirmation for KK1XYZ / ${OUR} QSO`, hasAttachments: true }), ctx).kind, "own", "our card's subject, from an address we did not list");
    const theirs = C.classifyMessage(sum({ from: "w1aw@example.net", subject: `QSL Confirmation for ${OUR} / W1AW QSO`, hasAttachments: true }), ctx);
    eq(theirs.kind, "card", "the SAME template sent BY another station to us is their card, not ours");
  }

  // -------------------------------------------------------------------------
  console.log("\n2. bounces of our cards");
  {
    const a = C.classifyMessage(sum({ from: "microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@example.com", subject: `Undeliverable: QSL Confirmation for AA1XYZ / ${OUR} QSO` }), ctx);
    eq(a, { kind: "bounce", callsign: "AA1XYZ" }, "Exchange's Undeliverable, callsign from the quoted subject");
    const b = C.classifyMessage(sum({ from: "no-reply@bounces.improvmx.net", subject: "Mail Delivery failure.", preview: `Your message "QSL Confirmation for KK1ABC / ${OUR} QSO" could not be delivered` }), ctx);
    eq(b, { kind: "bounce", callsign: "KK1ABC" }, "a relay's 'Mail Delivery failure.' quoting our card");
    const c = C.classifyMessage(sum({ from: "no-reply@bounces.improvmx.net", subject: "Mail Delivery failure." }), ctx);
    eq(c.kind, "ignore", "a bounce whose preview does not mention a QSL waits for its body (the importer reads it)");
  }

  // -------------------------------------------------------------------------
  console.log("\n3. the other station's callsign, from every shape seen");
  {
    const card = (subject: string, from = "op@example.net", hasAttachments = true) => C.classifyMessage(sum({ from, subject, hasAttachments }), ctx);
    eq(card(`QSL Contact - ${OUR} DE K1ABC`), { kind: "card", callsign: "K1ABC" }, `"QSL Contact - ${OUR} DE K1ABC"`);
    eq(card("QSL Contact, KG1ABC", "kg1abc_qsl@example.net"), { kind: "card", callsign: "KG1ABC" }, `"QSL Contact, KG1ABC"`);
    eq(card(`eQSL — ${OUR} de F1ABC`), { kind: "card", callsign: "F1ABC" }, `"eQSL — ${OUR} de F1ABC" (lower-case de)`);
    eq(card("QSO Contact from K5ABC"), { kind: "card", callsign: "K5ABC" }, `"QSO Contact from K5ABC"`);
    eq(card(`QSL from K4ABC to ${OUR}`, "op@example.net", false), { kind: "card", callsign: "K4ABC" }, `"QSL from K4ABC to ${OUR}" with no attachment`);
    eq(
      C.classifyMessage(sum({ from: "wb1abc@example.net", subject: `Re: QSL Confirmation for WB1ABC / ${OUR} QSO` }), ctx),
      { kind: "reply", callsign: "WB1ABC" },
      "a reply to our card",
    );
    eq(
      C.classifyMessage(sum({ from: "kr1abc@winlink.org", subject: `Re: //WL2K R/QSL Confirmation for KR1ABC / ${OUR} QSO` }), ctx),
      { kind: "reply", callsign: "KR1ABC" },
      "a reply through Winlink, and WL2K is not a callsign",
    );
    eq(C.classifyMessage(sum({ from: "via@digiqsl.com", subject: "New QSL card from KK1ABC" }), ctx), { kind: "notice", callsign: "KK1ABC", site: "digiqsl" }, "digiqsl: New QSL card from …");
    eq(C.classifyMessage(sum({ from: "via@digiqsl.com", subject: "You have 4 QSL cards waiting" }), ctx), { kind: "notice", callsign: null, site: "digiqsl" }, "digiqsl: several waiting, no callsign");
    eq(C.classifyMessage(sum({ from: "postman@qslworld.com", subject: "K7ABC sent you a QSL card — QSO confirmation" }), ctx), { kind: "notice", callsign: "K7ABC", site: "qslworld" }, "qslworld: … sent you a QSL card");
    eq(C.classifyMessage(sum({ from: "op@w8abc.example", subject: "W8ABC sent you a QSL card — QSO confirmation" }), ctx), { kind: "notice", callsign: "W8ABC", site: "other" }, "the same words from a station's own domain");
    eq(C.classifyMessage(sum({ from: "themailroom@eqsl.cc", subject: "New QSL card arrived for you at eQSL.cc" }), ctx), { kind: "notice", callsign: null, site: "eqsl" }, "eQSL's notice");
    eq(C.classifyMessage(sum({ from: "news@club.example", subject: "The Monthly Newsletter — QSL bureau news", hasAttachments: true }), ctx).kind, "ignore", "a newsletter that mentions QSL");
    eq(C.classifyMessage(sum({ from: "friend@example.net", subject: "Lunch on Friday?" }), ctx).kind, "ignore", "ordinary mail");
    eq(C.callFromSubject(`QSL Contact - ${OUR} DE ${OUR}`, [OUR]), null, "our own call is never the other station");
    eq(C.callFromSubject(`QSL Contact - ${OUR}/P DE K1ABC`, [OUR]), "K1ABC", "nor is our call portable");
    eq(C.callFromAddress("wb1abc@example.net", [OUR]), "WB1ABC", "sender local part wb1abc@");
    eq(C.callFromAddress("kg1abc_qsl@example.net", [OUR]), "KG1ABC", "sender local part kg1abc_qsl@");
    eq(C.callFromAddress("k9xyz@example.net", [OUR]), null, "our own address's local part is not a station");
    eq(["WL2K", "FT8", "FT4", "20M", "QSL"].filter((w) => C.isCallsign(w)), [], "WL2K, FT8, FT4, 20M and QSL are not callsigns");
    eq(["K1ABC", "2E0ABC", "9A1AA", "VE3ABC/P"].every((w) => C.isCallsign(w)), true, "K1ABC, 2E0ABC, 9A1AA, VE3ABC/P are");
  }

  // -------------------------------------------------------------------------
  console.log("\n4. what a card's filename says");
  {
    eq(C.parseCardFilename(`${OUR}_20261023_1838_20M_FT4.jpg`), { date: "2026-10-23", time: "1838", band: "20M", mode: "FT4" }, "date, time, band and mode");
    eq(C.parseCardFilename(`${OUR}_20261023_2315_40m_FT4.jpg`), { date: "2026-10-23", time: "2315", band: "40M", mode: "FT4" }, "a lower-case band");
    eq(C.parseCardFilename(`${OUR}_20261023_1831.jpg`), { date: "2026-10-23", time: "1831" }, "date and time only");
    eq(C.parseCardFilename(`QSL-${OUR}-KK1XYZ-2026-10-22.jpg`), { date: "2026-10-22" }, "a dashed date");
    eq(C.parseCardFilename(`${OUR}_20261399_1838.jpg`), {}, "an impossible date is no date");
    eq(C.parseCardFilename("card.jpg"), {}, "nothing to say");
    eq(C.callsInFilename(`${OUR}_20261023_1838_20M_FT4.jpg`, [OUR]), [], "a filename with only our call names no station");
    eq(C.callsInFilename("K1ABC_QSL.jpg", [OUR]), ["K1ABC"], "one that names theirs");
  }

  // -------------------------------------------------------------------------
  console.log("\n5. matching a card to a contact");
  const at = (iso: string) => new Date(iso);
  const qsos = [
    { id: "q1", callsign: "K1ABC", band: "20M", mode: "FT4", startTime: at("2026-10-23T18:36:00Z") },
    { id: "q2", callsign: "K1ABC", band: "40M", mode: "FT8", startTime: at("2026-10-20T12:00:00Z") },
    { id: "q3", callsign: "KG1ABC", band: "40M", mode: "FT4", startTime: at("2026-10-23T23:15:00Z") },
    { id: "q4", callsign: "K5ABC", band: "20M", mode: "FT8", startTime: at("2026-10-21T10:00:00Z") },
    { id: "q5", callsign: "K5ABC", band: "15M", mode: "FT8", startTime: at("2026-10-21T14:00:00Z") },
    { id: "q6", callsign: "F1ABC", band: "20M", mode: "FT8", startTime: at("2025-01-01T09:00:00Z") },
    { id: "q7", callsign: "AA1XYZ", band: "20M", mode: "FT8", startTime: at("2026-10-22T09:00:00Z") },
    { id: "q8", callsign: "WB1ABC", band: "20M", mode: "FT8", startTime: at("2026-10-22T10:00:00Z") },
    { id: "q9", callsign: "K1ABC", band: "20M", mode: "FT4", startTime: at("2026-11-30T10:00:00Z") },
  ];
  const recv = at("2026-10-24T08:00:00Z");
  {
    const exact = M.matchQso({ callsign: "K1ABC", kind: "card", receivedAt: recv, hints: { date: "2026-10-23", time: "1838", band: "20M", mode: "FT4" } }, qsos);
    eq([exact.status, exact.qsoId], ["MATCHED", "q1"], "time within ten minutes, same band and mode");
    const wrongBand = M.matchQso({ callsign: "K1ABC", kind: "card", receivedAt: recv, hints: { date: "2026-10-23", time: "1838", band: "40M" } }, qsos);
    eq(wrongBand.status, "AMBIGUOUS", "right time, wrong band: a person decides, never a quiet match");
    const near = M.matchQso({ callsign: "K1ABC", kind: "card", receivedAt: recv, hints: { date: "2026-10-20" } }, qsos);
    eq([near.status, near.qsoId], ["MATCHED", "q2"], "a date only: the one contact near it");
    const two = M.matchQso({ callsign: "K5ABC", kind: "card", receivedAt: recv, hints: { date: "2026-10-21" } }, qsos);
    eq([two.status, [...two.candidateIds].sort()], ["AMBIGUOUS", ["q4", "q5"]], "two contacts that day: ambiguous, both named");
    const farDate = M.matchQso({ callsign: "K1ABC", kind: "card", receivedAt: recv, hints: { date: "2026-09-01" } }, qsos);
    eq(farDate.status, "UNMATCHED", "a dated card with no contact near its date is not credited elsewhere");
    eq(M.matchQso({ callsign: "K7ABC", kind: "card", receivedAt: recv, hints: {} }, qsos).status, "UNMATCHED", "a station not in the log");
    const only = M.matchQso({ callsign: "F1ABC", kind: "card", receivedAt: recv, hints: {} }, qsos);
    eq([only.status, only.qsoId], ["MATCHED", "q6"], "undated, and the only contact ever with them");
    eq(M.matchQso({ callsign: null, kind: "card", receivedAt: recv, hints: {} }, qsos).status, "UNMATCHED", "no callsign, no match");
    eq(M.matchQso({ callsign: "K1ABC", kind: "card", receivedAt: recv, hints: { date: "2026-11-30", time: "1000" } }, qsos).status, "UNMATCHED", "a contact made after the card arrived is never its match");
    const reply = M.matchQso({ callsign: "K1ABC", kind: "reply", receivedAt: recv, hints: {}, sentCards: [{ qsoId: "q2", at: at("2026-10-21T00:00:00Z") }] }, qsos);
    eq([reply.status, reply.qsoId], ["MATCHED", "q2"], "a reply goes to the contact our card was about");
    eq(M.matchQso({ callsign: "K1ABC/P", kind: "card", receivedAt: recv, hints: { date: "2026-10-20" } }, qsos).qsoId, "q2", "a portable call matches the home call's contacts");
  }

  // -------------------------------------------------------------------------
  console.log("\n6. is it really a picture?");
  {
    eq(C.sniffImage(JPEG), { ok: true, ext: "jpg", contentType: "image/jpeg" }, "JPEG by its bytes");
    eq(C.sniffImage(PNG).ok && C.sniffImage(GIF).ok && C.sniffImage(WEBP).ok, true, "PNG, GIF and WebP");
    eq(C.sniffImage(PDF).ok, false, "a PDF is refused");
    eq(C.sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>')).ok, false, "an SVG is refused (it can carry script)");
    const big = Buffer.concat([JPEG, Buffer.alloc(C.MAX_IMAGE_BYTES)]);
    eq(C.sniffImage(big).ok, false, "over 10 MB is refused even when it is a JPEG");
    eq(C.mightBeImage("K9XYZ_20261023_2315_40m_FT4.jpg", "application/octet-stream"), true, "octet-stream with an image name is worth sniffing");
    eq(C.mightBeImage("log.pdf", "application/pdf"), false, "a PDF is not downloaded");
  }

  // -------------------------------------------------------------------------
  console.log("\n7. the importer, end to end, and again");
  type Msg = SourceMessage;
  type Att = SourceAttachment;
  interface Fixture {
    msg: Msg;
    atts?: { att: Att; bytes: Buffer }[];
    body?: string;
    throwOnAttachments?: boolean;
  }
  const m = (key: string, iso: string, s: Partial<Msg["summary"]>): Msg => ({ key, folder: "inbox", receivedAt: at(iso), summary: sum(s) });
  const att = (name: string, contentType: string, bytes: Buffer, inline = false) => ({
    att: { key: S.attachmentKey(name, 0), name, contentType, size: bytes.length, inline },
    bytes,
  });
  const fixtures: Fixture[] = [
    { msg: m("<own@x>", "2026-10-22T10:00:00Z", { from: "/o=exchangelabs/ou=x/cn=recipients/cn=station", subject: `QSL Confirmation for KK1XYZ / ${OUR} QSO`, hasAttachments: true }), atts: [att(`QSL-${OUR}-KK1XYZ-2026-10-22.jpg`, "image/jpeg", JPEG)] },
    { msg: m("<bounce@x>", "2026-10-22T11:00:00Z", { from: "microsoftexchange329e71ec@example.com", subject: `Undeliverable: QSL Confirmation for AA1XYZ / ${OUR} QSO` }) },
    { msg: m("<card1@x>", "2026-10-23T19:00:00Z", { from: "k1abc@example.net", subject: `QSL Contact - ${OUR} DE K1ABC`, hasAttachments: true }), atts: [att(`${OUR}_20261023_1838_20M_FT4.jpg`, "image/jpeg", JPEG)] },
    { msg: m("<card2@x>", "2026-10-24T01:00:00Z", { from: "kg1abc_qsl@example.net", subject: "QSL Contact, KG1ABC", hasAttachments: true }), atts: [att(`${OUR}_20261023_2315_40m_FT4.jpg`, "application/octet-stream", JPEG)] },
    { msg: m("<card3@x>", "2026-10-24T02:00:00Z", { from: "k5abc@example.net", subject: "QSO Contact from K5ABC", hasAttachments: true }), atts: [att("log.pdf", "application/pdf", PDF), att("fake.jpg", "image/jpeg", PDF)] },
    { msg: m("<reply@x>", "2026-10-24T03:00:00Z", { from: "wb1abc@example.net", subject: `Re: QSL Confirmation for WB1ABC / ${OUR} QSO` }) },
    { msg: m("<notice@x>", "2026-10-24T04:00:00Z", { from: "via@digiqsl.com", subject: "New QSL card from KK1ABC" }), body: '<a href="https://www.digiqsl.com/unsubscribe">unsub</a> <a href="https://www.digiqsl.com/card/abc?x=1&amp;y=2">See your card</a>' },
    { msg: m("<eqsl@x>", "2026-10-24T04:30:00Z", { from: "themailroom@eqsl.cc", subject: "New QSL card arrived for you at eQSL.cc" }), body: '<a href="https://www.eqsl.cc/qslcard/InBox.cfm">Inbox</a>' },
    { msg: m("<news@x>", "2026-10-24T05:00:00Z", { from: "news@club.example", subject: "The Monthly Newsletter — QSL bureau news", hasAttachments: true }), atts: [att("banner.jpg", "image/jpeg", JPEG)] },
    { msg: m("<big@x>", "2026-10-24T06:00:00Z", { from: "k4abc@example.net", subject: `QSL from K4ABC to ${OUR}`, hasAttachments: true }), atts: [{ att: { key: S.attachmentKey("huge.jpg", 0), name: "huge.jpg", contentType: "image/jpeg", size: 11 * 1024 * 1024, inline: false }, bytes: JPEG }] },
    { msg: m("<moved@x>", "2026-10-24T07:00:00Z", { from: "station@qsl.example.org", subject: `QSL Confirmation for KK1XYZ / ${OUR} QSO`, hasAttachments: true }), atts: [att("ours.jpg", "image/jpeg", JPEG)] },
  ];

  const attachmentCalls: string[] = [];
  class FakeSource implements MailSource {
    label = "fixtures";
    constructor(private readonly list_: Fixture[]) {}
    folders() {
      return ["inbox"];
    }
    async *list(_folder: string, since: Date) {
      for (const f of this.list_) if (f.msg.receivedAt.getTime() >= since.getTime()) yield f.msg;
    }
    async body(msg: Msg) {
      return this.list_.find((f) => f.msg.key === msg.key)?.body ?? "";
    }
    async attachments(msg: Msg) {
      attachmentCalls.push(msg.key);
      const f = this.list_.find((x) => x.msg.key === msg.key);
      if (f?.throwOnAttachments) throw new Error("connection reset");
      return (f?.atts ?? []).map((a) => a.att);
    }
    async attachmentBytes(msg: Msg, a: Att, max: number) {
      const f = this.list_.find((x) => x.msg.key === msg.key);
      if (a.size > max) return null;
      return f?.atts?.find((x) => x.att.key === a.key)?.bytes ?? null;
    }
  }

  class MemStore implements InboundStore {
    rows: NewReceived[] = [];
    files = new Map<string, number>();
    deleted: string[] = [];
    saves = 0;
    flagged = new Set<string>();
    forceDuplicate = false;
    async hasMessage(id: string) {
      return !this.forceDuplicate && this.rows.some((r) => r.messageId === id);
    }
    async candidatesFor(call: string) {
      return qsos.filter((q) => C.baseCall(q.callsign) === C.baseCall(call));
    }
    async sentCardsFor(call: string) {
      return call === "WB1ABC" ? [{ qsoId: "q8", at: at("2026-10-22T12:00:00Z") }] : [];
    }
    async bouncedCard(call: string) {
      return call === "AA1XYZ" ? { qslEmailId: "e7", qsoId: "q7" } : null;
    }
    async saveImage(id: string, bytes: Uint8Array, ext: string) {
      this.saves++;
      const p = `data/qsl-received/${id}.${ext}`;
      this.files.set(p, bytes.length);
      return p;
    }
    async deleteImage(p: string) {
      this.deleted.push(p);
      this.files.delete(p);
    }
    async insert(row: NewReceived) {
      if (this.rows.some((r) => r.messageId === row.messageId && r.attachmentKey === row.attachmentKey)) return false;
      this.rows.push(row);
      if (row.confirms && row.qsoId && row.matchStatus === "MATCHED") this.flagged.add(row.qsoId);
      return true;
    }
  }

  const noticeFetches: string[] = [];
  const fakeNotice = async (link: string) => {
    noticeFetches.push(link);
    return { ok: true as const, bytes: JPEG, check: { ok: true as const, ext: "jpg" as const, contentType: "image/jpeg" } };
  };
  const store = new MemStore();
  const opts = { mailbox: MAILBOX, ownCalls: [OUR], ownAddresses: ["station@qsl.example.org"], since: { inbox: at("2026-10-01T00:00:00Z") }, maxMessages: 100 };
  const r1 = await I.importMailbox({ source: new FakeSource(fixtures), store, fetchNoticeImage: fakeNotice }, opts);
  {
    eq(r1.scanned, fixtures.length, "every message was looked at");
    eq(r1.own, 2, "our own two cards skipped — the Exchange one and the one from the new domain");
    ok(!attachmentCalls.includes("<own@x>") && !attachmentCalls.includes("<moved@x>"), "and their attachments were never downloaded");
    eq(r1.bounces, 1, "one bounce");
    const bounce = store.rows.find((r) => r.kind === "BOUNCE");
    eq([bounce?.callsign, bounce?.qsoId, bounce?.confirms], ["AA1XYZ", "q7", false], "the bounce is linked to the contact whose card bounced, and confirms nothing");
    eq(r1.bounceList.length, 1, "and listed in the report");
    const c1 = store.rows.find((r) => r.messageId === "<card1@x>");
    eq([c1?.callsign, c1?.qsoId, c1?.matchStatus, c1?.imageBytes], ["K1ABC", "q1", "MATCHED", JPEG.length], "a card with its picture, matched by the time in its filename");
    const c2 = store.rows.find((r) => r.messageId === "<card2@x>");
    eq([c2?.callsign, c2?.qsoId, c2?.imageContentType], ["KG1ABC", "q3", "image/jpeg"], "the application/octet-stream JPEG is accepted and typed from its bytes");
    const c3 = store.rows.find((r) => r.messageId === "<card3@x>");
    eq([c3?.imagePath, c3?.matchStatus], [null, "AMBIGUOUS"], "a PDF and a fake .jpg are not pictures; two contacts with K5ABC make it ambiguous");
    ok(r1.rejected.some((x) => x.startsWith("fake.jpg")), "the fake .jpg is reported as rejected", r1.rejected);
    const rep = store.rows.find((r) => r.kind === "REPLY");
    eq([rep?.callsign, rep?.qsoId, rep?.confirms], ["WB1ABC", "q8", true], "a reply with no picture confirms the contact our card was about");
    const notice = store.rows.find((r) => r.messageId === "<notice@x>");
    eq(notice?.link, "https://www.digiqsl.com/card/abc?x=1&y=2", "the notice keeps the card link, not the unsubscribe link");
    eq([notice?.imagePath !== null, notice?.confirms], [true, true], "and the card picture fetched from it");
    const eqslNotice = store.rows.find((r) => r.messageId === "<eqsl@x>");
    eq([eqslNotice?.kind, eqslNotice?.imagePath, eqslNotice?.confirms], ["NOTICE", null, false], "an eQSL notice stays a notice — no login, no fetch");
    eq(noticeFetches.length, 1, "only the digiqsl link was fetched");
    eq(r1.ignored, 1, "the newsletter is ignored");
    const big = store.rows.find((r) => r.messageId === "<big@x>");
    eq([big?.imagePath, big?.callsign], [null, "K4ABC"], "an 11 MB picture is refused; the card is still recorded without it");
    eq([...store.flagged].sort(), ["q1", "q3", "q8"], "exactly the matched cards and the reply mark their contacts");
    eq(r1.newest.inbox, "2026-10-24T07:00:00.000Z", "the folder's mark is the newest message handled");
  }
  {
    const before = store.rows.length;
    const saves = store.saves;
    attachmentCalls.length = 0;
    const r2 = await I.importMailbox({ source: new FakeSource(fixtures), store, fetchNoticeImage: fakeNotice }, opts);
    eq(store.rows.length, before, "a second run adds nothing");
    eq(store.saves, saves, "and saves no picture again");
    eq(r2.alreadySeen, store.rows.length > 0 ? new Set(store.rows.map((r) => r.messageId)).size : 0, "every imported message is recognised as seen");
    eq(attachmentCalls.length, 0, "and nothing already imported is downloaded again");
  }
  {
    // Two importers racing: the unique key refuses the second insert, and its picture goes.
    const racer = new MemStore();
    racer.rows = store.rows.map((r) => ({ ...r }));
    racer.forceDuplicate = true;
    await I.importMailbox({ source: new FakeSource(fixtures), store: racer, fetchNoticeImage: fakeNotice }, opts);
    eq(racer.rows.length, store.rows.length, "a racing run stores no duplicate");
    eq(racer.files.size, 0, "and deletes every picture it wrote for a row it could not insert");
  }
  {
    // A failure part way holds the mark at the last message fully handled.
    const broken = fixtures.map((f) => (f.msg.key === "<card2@x>" ? { ...f, throwOnAttachments: true } : f));
    const r3 = await I.importMailbox({ source: new FakeSource(broken), store: new MemStore(), fetchNoticeImage: fakeNotice }, opts);
    eq(r3.newest.inbox, "2026-10-23T19:00:00.000Z", "a message that failed holds the mark before it, so it is retried");
    eq([r3.complete, r3.errors.length], [false, 1], "the run says it is incomplete and why");
  }

  // -------------------------------------------------------------------------
  console.log("\n8. Microsoft Graph, against a fake Microsoft");
  const cfg = { tenantId: "contoso.onmicrosoft.com", clientId: "11111111-2222-3333-4444-555555555555", clientSecret: "s3cr3t-value-never-shown", mailbox: MAILBOX };
  type Call = { url: string; init?: RequestInit };
  function fakeFetch(handler: (c: Call, n: number) => Response | Promise<Response>) {
    const calls: Call[] = [];
    const f = async (url: string, init?: RequestInit) => {
      const c = { url, init };
      calls.push(c);
      return handler(c, calls.length);
    };
    return { calls, f };
  }
  const token = () => new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
  const json = (o: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  {
    const page2 = `${G.GRAPH_ROOT}/users/${encodeURIComponent(MAILBOX)}/mailFolders/inbox/messages?$skip=2`;
    const msg = (id: string, subject: string) => ({ id, internetMessageId: `<${id}@x>`, subject, from: { emailAddress: { address: "K1ABC@Example.net", name: "K1ABC" } }, receivedDateTime: "2026-10-23T19:00:00Z", hasAttachments: true, bodyPreview: "" });
    const { calls, f } = fakeFetch((c) => {
      if (c.url.startsWith("https://login.microsoftonline.com/")) return token();
      if (c.url.includes("$skip=2")) return json({ value: [msg("c", "three")] });
      return json({ value: [msg("a", "one"), msg("b", "two")], "@odata.nextLink": page2 });
    });
    const src = new GS.GraphMailSource(new G.GraphClient(cfg, { fetch: f, sleep }));
    const got: string[] = [];
    for await (const x of src.list("inbox", at("2026-10-22T00:00:00Z"))) got.push(x.summary.subject);
    eq(got, ["one", "two", "three"], "two pages, followed by nextLink");
    eq(calls.filter((c) => c.url.includes("login.microsoftonline.com")).length, 1, "one token for the whole run");
    const first = decodeURIComponent(calls[1]?.url ?? "");
    ok(first.includes("$filter=receivedDateTime ge 2026-10-22T00:00:00.000Z") && first.includes("$orderby=receivedDateTime asc") && first.includes("$select="), "filtered by date, oldest first, only the fields needed", first);
    const tokenBody = String(calls[0]?.init?.body ?? "");
    ok(tokenBody.includes("grant_type=client_credentials") && tokenBody.includes(encodeURIComponent("https://graph.microsoft.com/.default")), "client-credentials with the .default scope");
    ok(calls.every((c) => (c.init?.method ?? "GET") !== "PATCH" && (c.init?.method ?? "GET") !== "DELETE"), "nothing but GET against the mailbox (and the token POST)");
    ok(calls.slice(1).every((c) => (c.init?.method ?? "GET") === "GET"), "every mailbox request is a GET");
  }
  {
    const { f } = fakeFetch((c) => (c.url.includes("login.") ? token() : json({ value: [], "@odata.nextLink": "https://evil.example/steal" })));
    const src = new GS.GraphMailSource(new G.GraphClient(cfg, { fetch: f, sleep }));
    let err = "";
    try {
      for await (const _ of src.list("inbox", at("2026-10-22T00:00:00Z"))) void _;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    ok(/outside graph\.microsoft\.com/.test(err), "a nextLink off graph.microsoft.com is refused — the token never leaves", err);
  }
  {
    const { f } = fakeFetch((c) => (c.url.includes("login.") ? token() : json({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }, 403)));
    let err = "";
    try {
      await GS.testGraphMailbox(new G.GraphClient(cfg, { fetch: f, sleep }));
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    ok(/application access policy/.test(err) && err.includes(MAILBOX) && err.includes("(403)"), "403 is explained as the access policy, naming the mailbox", err);
  }
  {
    sleeps.length = 0;
    const { calls, f } = fakeFetch((c, n) => {
      if (c.url.includes("login.")) return token();
      return n === 2 ? json({ error: { code: "TooManyRequests" } }, 429, { "Retry-After": "2" }) : json({ totalItemCount: 1234, unreadItemCount: 5 });
    });
    const out = await GS.testGraphMailbox(new G.GraphClient(cfg, { fetch: f, sleep }));
    eq(sleeps, [2000], "429: waits the Retry-After it was given");
    ok(out.includes("1,234") && calls.length === 3, "and then succeeds", out);
  }
  {
    const { f } = fakeFetch(() => json({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x" }, 401));
    let err = "";
    try {
      await new G.GraphClient(cfg, { fetch: f, sleep }).accessToken();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    ok(/client secret/.test(err) && /AADSTS7000215/.test(err), "a refused sign-in says which setting to look at", err);
    ok(!err.includes(cfg.clientSecret), "and never repeats the secret");
  }
  {
    eq(G.graphConfigProblem({ ...cfg, tenantId: "evil.example/../x" }) !== null, true, "a tenant id that would change the URL is refused");
    eq(G.graphConfigProblem({ ...cfg, mailbox: "a@b.example/../../x" }) !== null, true, "so is a mailbox that would");
  }

  // -------------------------------------------------------------------------
  console.log("\n9. the send path: one choice, SMTP unchanged by default");
  {
    eq([P.parseSendProvider(null), P.parseSendProvider(""), P.parseSendProvider("junk"), P.parseSendProvider(" Graph ")], ["smtp", "smtp", "smtp", "graph"], "SMTP unless Microsoft 365 is chosen in so many words");
    eq([P.parseReceiveProvider(null), P.parseReceiveProvider("imap"), P.parseReceiveProvider("gmail")], ["graph", "imap", "gmail"], "receiving defaults to Microsoft 365 (and is off by its own switch)");
    const { SETTINGS } = await import("@/lib/settings/registry");
    eq(SETTINGS.find((s) => s.key === "mail.sendProvider")?.default, "smtp", "the registry default is SMTP, so an upgrade sends exactly as before");
    eq(SETTINGS.find((s) => s.key === "qsl.inbound.enabled")?.default, "false", "and importing is off until switched on");
    eq(SETTINGS.find((s) => s.key === "ms365.clientSecret")?.type, "secret", "the client secret is a secret setting (never sent to the browser)");
    const E = await import("@/lib/qsl/email");
    eq(E.graphFrom('"Station" <station@example.com>', "station@example.com"), '"Station" <station@example.com>', "From keeps its display name when it is the mailbox");
    eq(E.graphFrom("other@example.org", "station@example.com"), "station@example.com", "and is the mailbox when it is not");
  }

  const nodemailer = (await import("nodemailer")).default;
  const smtpSent: { from?: unknown; headers?: unknown; attachments?: unknown; to?: unknown }[] = [];
  (nodemailer as unknown as { createTransport: unknown }).createTransport = () => ({
    async sendMail(msg: { from?: unknown; headers?: unknown; attachments?: unknown; to?: unknown }) {
      smtpSent.push(msg);
      return { messageId: "<smtp@example.invalid>" };
    },
    async verify() {
      return true;
    },
    close() {},
  });
  const { invalidateSettingsCache } = await import("@/lib/settings");
  const E = await import("@/lib/qsl/email");
  const rendered = {
    subject: "QSL Confirmation for K1ABC / K9XYZ QSO",
    text: "73",
    html: '<p>73</p><img src="cid:card@x">',
    card: { jpeg: JPEG, filename: "QSL-K9XYZ-K1ABC-2026-10-23.jpg", cid: "card@x", disposition: "attachment" as const },
  };
  const qso = { callsign: "K1ABC", band: "20M", mode: "FT4", startTime: at("2026-10-23T18:36:00Z") };
  const sender = { callsign: OUR };
  function seedSettings(rows: Record<string, string>) {
    db.reset();
    db.seed("setting", Object.entries(rows).map(([key, value]) => ({ key, value, encrypted: false })));
    invalidateSettingsCache();
  }
  const realFetch = globalThis.fetch;
  {
    seedSettings({ "smtp.host": "smtp.example.invalid", "smtp.from": "Station <station@example.com>" });
    const graphCalls: string[] = [];
    globalThis.fetch = (async (u: string | URL | Request) => {
      graphCalls.push(String(u));
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const r = await E.sendQslEmail({ to: "k1abc@example.net", qso, sender, preRendered: rendered, unsubscribeUrl: "https://shack.example.invalid/u/abc" });
    globalThis.fetch = realFetch;
    eq(r.sent, true, "with no choice made, it sends");
    eq(smtpSent.length, 1, "through SMTP");
    eq(graphCalls.length, 0, "and Microsoft is never contacted");
    const m0 = smtpSent[0]!;
    eq(m0.from, "Station <station@example.com>", "From is smtp.from, as it always was");
    eq(m0.headers, { "List-Unsubscribe": "<https://shack.example.invalid/u/abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, "the unsubscribe headers, as they always were");
    ok(Array.isArray(m0.attachments) && (m0.attachments as { cid?: string }[])[0]?.cid === "card@x", "and the card, with its Content-ID");
  }
  {
    seedSettings({
      "mail.sendProvider": "graph",
      "smtp.from": "Station <station@example.com>",
      "ms365.tenantId": cfg.tenantId,
      "ms365.clientId": cfg.clientId,
      "ms365.clientSecret": cfg.clientSecret,
      "ms365.mailbox": MAILBOX,
    });
    smtpSent.length = 0;
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(u), init });
      if (String(u).includes("login.microsoftonline.com")) return token();
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const r = await E.sendQslEmail({ to: "k1abc@example.net", qso, sender, preRendered: rendered, unsubscribeUrl: "https://shack.example.invalid/u/abc" });
    const alert = await E.sendSystemEmail({ to: "op@example.net", subject: "[DigiShack] test", text: "hello" });
    globalThis.fetch = realFetch;
    eq([r.sent, alert.sent], [true, true], "with Microsoft 365 chosen, QSL cards and alerts both send");
    eq(smtpSent.length, 0, "and SMTP is not used");
    const send = calls.find((c) => c.url.endsWith("/sendMail"));
    eq(send?.url, `${G.GRAPH_ROOT}/users/${encodeURIComponent(MAILBOX)}/sendMail`, "POST /users/{mailbox}/sendMail");
    eq([send?.init?.method, (send?.init?.headers as Record<string, string>)?.["Content-Type"]], ["POST", "text/plain"], "as base64 MIME (text/plain), per Graph's MIME send");
    const mime = Buffer.from(String(send?.init?.body ?? ""), "base64").toString("latin1");
    ok(/^From: Station <station@example\.com>/m.test(mime), "From is the mailbox, display name kept", mime.slice(0, 300));
    ok(/^List-Unsubscribe: <https:\/\/shack\.example\.invalid\/u\/abc>/m.test(mime) && /^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m.test(mime), "List-Unsubscribe survives — the JSON form could not carry it");
    ok(mime.includes("QSL-K9XYZ-K1ABC-2026-10-23.jpg") && /Content-ID: <card@x>/i.test(mime) && /Content-Disposition: attachment/i.test(mime), "the card is attached with its Content-ID and an attachment disposition");
    const parsed = MIME.parseMime(Buffer.from(mime, "latin1"));
    const card = parsed.leaves.find((l) => l.contentType === "image/jpeg");
    ok(card !== undefined && card.body.equals(JPEG), "and the JPEG inside is byte-for-byte the card");
    ok(!calls.some((c) => String(c.init?.body ?? "").includes(cfg.clientSecret) && !c.url.includes("login.microsoftonline.com")), "the client secret goes only to the sign-in endpoint");
  }
  {
    seedSettings({ "mail.sendProvider": "graph", "ms365.tenantId": cfg.tenantId, "ms365.clientId": cfg.clientId, "ms365.clientSecret": cfg.clientSecret, "ms365.mailbox": MAILBOX });
    globalThis.fetch = (async (u: string | URL | Request) => (String(u).includes("login.") ? token() : new Response(null, { status: 202 }))) as typeof fetch;
    const huge = { ...rendered, card: { ...rendered.card, jpeg: Buffer.alloc(3 * 1024 * 1024, 1) } };
    const r = await E.sendQslEmail({ to: "k1abc@example.net", qso, sender, preRendered: huge });
    globalThis.fetch = realFetch;
    ok(!r.sent && /MB/.test(r.reason ?? "") && /SMTP/.test(r.reason ?? ""), "a message over Graph's size limit is refused in a sentence, not by a 413", r.reason);
    seedSettings({ "mail.sendProvider": "graph" });
    const missing = await E.sendSystemEmail({ to: "op@example.net", subject: "x", text: "y" });
    ok(!missing.sent && /tenant ID/.test(missing.reason ?? ""), "Microsoft 365 chosen but not set up: says what is missing", missing.reason);
  }

  // -------------------------------------------------------------------------
  console.log("\n10. notice links: only the card sites, only https, every hop checked");
  {
    eq(N.allowedNoticeUrl("https://www.digiqsl.com/card/1")?.hostname, "www.digiqsl.com", "a digiqsl page");
    eq(
      ["http://digiqsl.com/x", "https://digiqsl.com.evil.example/x", "https://qslworld.com:8443/x", "https://user@digiqsl.com/x", "https://169.254.169.254/latest", "https://eqsl.cc/x"].map((u) => N.allowedNoticeUrl(u)),
      [null, null, null, null, null, null],
      "plain http, look-alike hosts, other ports, credentials, IPs and eQSL are all refused",
    );
    const hops: string[] = [];
    const redirectAway = async (u: string) => {
      hops.push(u);
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    };
    const r = await N.fetchNoticeImage("https://www.digiqsl.com/card/1", redirectAway);
    eq([r.ok, hops.length], [false, 1], "a redirect off the allowed hosts is not followed");
    const page = '<html><meta property="og:image" content="https://cdn.qslworld.com/cards/77.jpg"></html>';
    const site = async (u: string) => {
      hops.push(u);
      return u.endsWith("77.jpg") ? new Response(JPEG, { status: 200 }) : new Response(page, { status: 200 });
    };
    hops.length = 0;
    const r2 = await N.fetchNoticeImage("https://qslworld.com/v/77", site);
    eq([r2.ok, hops], [true, ["https://qslworld.com/v/77", "https://cdn.qslworld.com/cards/77.jpg"]], "og:image on the same site is fetched and sniffed");
    eq(N.findCardImage('<meta property="og:image" content="https://evil.example/x.jpg">', new URL("https://qslworld.com/v/1")), null, "an og:image on another host is not");
  }

  // -------------------------------------------------------------------------
  console.log("\n11. stored image paths cannot name another file");
  {
    ok(RUN.imageFile("data/qsl-received/0123456789abcdef01234567.jpg")?.endsWith("0123456789abcdef01234567.jpg") === true, "the shape the importer writes");
    eq(
      ["data/qsl-received/../../.env", "/etc/passwd", "data/qsl-received/0123456789abcdef01234567.svg", "data/qsl/card-base.png", "data\\qsl-received\\0123456789abcdef01234567.jpg"].map((p) => RUN.imageFile(p)),
      [null, null, null, null, null],
      "traversal, absolute paths, other types and other directories are refused",
    );
    eq(RUN.parseStartDate("2026-01-15", at("2026-10-23T00:00:00Z")).toISOString(), "2026-01-15T00:00:00.000Z", "a start date");
    eq(RUN.parseStartDate(null, at("2026-10-23T00:00:00Z")).toISOString(), "2026-09-23T00:00:00.000Z", "none set: thirty days back");
  }

  // -------------------------------------------------------------------------
  console.log("\n12. the status sentence: the first missing link, and silence only when earned");
  {
    const healthy = { enabled: true, configProblem: null, provider: "graph" as const, running: true, intervalMinutes: 15, lastRunAt: "2026-10-23T00:00:00Z", port: 3101 };
    eq(ST.inboundDetail(healthy), "", "on, set up, running and has run: nothing to say");
    ok(/off/.test(ST.inboundDetail({ ...healthy, enabled: false, configProblem: "x", running: false, lastRunAt: null })), "off is said first, whatever else is wrong");
    ok(/not set up/.test(ST.inboundDetail({ ...healthy, configProblem: "tenant", running: false })), "then the missing settings, before the radio service");
    ok(/radio service/.test(ST.inboundDetail({ ...healthy, running: false, lastRunAt: null })), "then the radio service");
    ok(/no import has run/.test(ST.inboundDetail({ ...healthy, lastRunAt: null })), "then never having run");
    let wrong = 0;
    for (const enabled of [true, false]) for (const cp of [null, "x"]) for (const running of [true, false]) for (const last of [null, "t"]) {
      const d = ST.inboundDetail({ ...healthy, enabled, configProblem: cp, running, lastRunAt: last });
      if ((d === "") !== (enabled && cp === null && running && last !== null)) wrong++;
    }
    eq(wrong, 0, "over all sixteen states, empty if and only if everything is in place");
  }

  // -------------------------------------------------------------------------
  console.log("\n13. the IMAP pieces that ship ahead of IMAP (reader, MIME), on recorded data");
  {
    const responses: ImapResponse[] = [];
    const reader = new IMAP.ImapReader((r) => responses.push(r));
    const header = "From: =?UTF-8?Q?K1ABC_Op?= <k1abc@example.net>\r\nSubject: QSL\r\n\r\n";
    const wire = `* 3 FETCH (UID 77 INTERNALDATE "23-Oct-2026 19:00:00 +0000" RFC822.SIZE 4321 BODY[HEADER.FIELDS (FROM SUBJECT)] {${Buffer.byteLength(header)}}\r\n${header})\r\nD4 OK done\r\n`;
    // Split mid-literal, as a network does.
    reader.push(Buffer.from(wire.slice(0, 70)));
    reader.push(Buffer.from(wire.slice(70, 130)));
    reader.push(Buffer.from(wire.slice(130)));
    eq(responses.length, 2, "a literal split across reads is reassembled");
    const f = IMAP.parseFetch(responses[0]!);
    eq([f?.uid, f?.size, f?.internalDate?.toISOString(), f?.section?.toString()], [77, 4321, "2026-10-23T19:00:00.000Z", header], "the FETCH fields and the literal");
    eq(IMAP.imapDate(at("2026-10-02T00:00:00Z")), "2-Oct-2026", "SEARCH dates");
    let refused = "";
    try {
      (new IMAP.ImapClient() as unknown as { run: (c: string) => unknown }).run("UID STORE 1 +FLAGS (\\Seen)");
    } catch (e) {
      refused = e instanceof Error ? e.message : "";
    }
    ok(/read-only/.test(refused), "STORE is refused before it reaches the wire", refused);
    let peek = "";
    try {
      (new IMAP.ImapClient() as unknown as { run: (c: string) => unknown }).run("UID FETCH 1 (BODY[])");
    } catch (e) {
      peek = e instanceof Error ? e.message : "";
    }
    ok(/PEEK/.test(peek), "a fetch that would mark a message read is refused", peek);

    const b64 = JPEG.toString("base64").replace(/(.{76})/g, "$1\r\n");
    const gmail = [
      "MIME-Version: 1.0",
      "From: \"K1ABC\" <k1abc@example.net>",
      "Date: Fri, 23 Oct 2026 19:00:00 +0000",
      "Message-ID: <CAF=abc@mail.gmail.com>",
      "Subject: =?UTF-8?B?UVNMIENvbnRhY3Qg4oCUIEs5WFlaIERFIEsxQUJD?=",
      'Content-Type: multipart/mixed; boundary="000000000000aaaa"',
      "",
      "--000000000000aaaa",
      'Content-Type: multipart/alternative; boundary="000000000000bbbb"',
      "",
      "--000000000000bbbb",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Tnx fer the QSO =E2=80=94 73",
      "--000000000000bbbb",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      "<div>Tnx fer the QSO</div>",
      "--000000000000bbbb--",
      "--000000000000aaaa",
      'Content-Type: image/jpeg; name="=?UTF-8?B?SzlYWVpfMjAyNjEwMjNfMTgzOF8yME1fRlQ0LmpwZw==?="',
      'Content-Disposition: attachment; filename="=?UTF-8?B?SzlYWVpfMjAyNjEwMjNfMTgzOF8yME1fRlQ0LmpwZw==?="',
      "Content-Transfer-Encoding: base64",
      "Content-ID: <f_abc>",
      "",
      b64,
      "--000000000000aaaa--",
      "",
    ].join("\r\n");
    const p = MIME.parseMime(Buffer.from(gmail, "latin1"));
    eq(p.subject, "QSL Contact — K9XYZ DE K1ABC", "an RFC 2047 subject, UTF-8 dash and all");
    eq(p.from, { address: "k1abc@example.net", name: "K1ABC" }, "the sender");
    eq(p.text, "Tnx fer the QSO — 73", "quoted-printable text, decoded as UTF-8");
    const img = p.leaves.find((l) => l.contentType === "image/jpeg");
    eq(img?.filename, "K9XYZ_20261023_1838_20M_FT4.jpg", "an RFC 2047 attachment filename");
    ok(img !== undefined && img.body.equals(JPEG), "the base64 picture, byte for byte");
    eq(MIME.parseParams("attachment; filename*=UTF-8''QSL%20card%E2%80%94K1ABC.jpg").params.filename, "QSL card—K1ABC.jpg", "an RFC 2231 filename");
    eq(
      MIME.parseParams("attachment; filename*0*=UTF-8''part%20one; filename*1=-two.jpg").params.filename,
      "part one-two.jpg",
      "an RFC 2231 filename in continuations",
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
