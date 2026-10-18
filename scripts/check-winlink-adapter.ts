/* eslint-disable no-console */
// Pat engine adapter check (offline, stub engine). Drives lib/winlink/engine/pat.ts with an
// injected fetch that serves the captured fixtures, so the read surface, domain normalization,
// secret redaction and failure classification are all verified without a live Pat.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PatEngine,
  PatError,
  type PatErrorKind,
  redactConfig,
  toGateway,
  toMessageSummary,
} from "@/lib/winlink/engine/pat";
import type { PatConfig } from "@/lib/winlink/types";

const DIR = fileURLToPath(new URL("../lib/winlink/fixtures/pat-1.0.0/", import.meta.url));

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}

/** A stub Pat: map a request path to a fixture file, else 404. */
function fixtureFetch(map: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    for (const [key, file] of Object.entries(map)) {
      if (path === key || path.startsWith(`${key}?`)) {
        return new Response(readFileSync(DIR + file, "utf8"), { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const ROUTES: Record<string, string> = {
  "/api/status": "status.json",
  "/api/config": "config.json",
  "/api/connect_aliases": "connect_aliases.json",
  "/api/mailbox/in": "mailbox_in.json",
  "/api/mailbox/out": "mailbox_out_sample.json",
  "/api/mailbox/out/JT2ELSWANWRQ": "message_detail_sample.json",
  "/api/rmslist": "ep_rmslist_sample.json",
  "/api/formcatalog": "ep_formcatalog.json",
  "/api/bandwidths": "ep_bandwidths.json",
};

async function expectError(kind: PatErrorKind, fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
    ok(`${label} (expected ${kind}, got success)`, false);
  } catch (e) {
    ok(`${label} -> ${kind}`, e instanceof PatError && e.kind === kind);
  }
}

async function main(): Promise<void> {
  const pat = new PatEngine({ baseUrl: "http://stub:8049", fetchImpl: fixtureFetch(ROUTES) });

  console.log("\nread surface");
  const status = await pat.status();
  ok("status.connected is boolean", typeof status.connected === "boolean");

  const aliases = await pat.connectAliases();
  ok("telnet alias is the CMS path", (aliases.telnet ?? "").includes("cms.winlink.org"));

  const outbox = await pat.mailbox("out");
  const first = outbox[0];
  ok("outbox is a non-empty array", Array.isArray(outbox) && !!first);
  ok("empty folder returns []", (await pat.mailbox("in")).length === 0);

  const msg = await pat.message("out", "JT2ELSWANWRQ");
  ok("message detail has a body", msg.Body.length > 0);
  ok("message From.Addr is K9XYZ", msg.From.Addr === "K9XYZ");

  const gws = await pat.gateways();
  const gw = gws[0];
  ok("gateways is a non-empty array", Array.isArray(gws) && !!gw);

  const forms = await pat.formCatalog();
  ok("formcatalog.form_count is numeric", typeof forms.form_count === "number");

  const bw = await pat.bandwidths("ARDOP");
  ok("bandwidths.bandwidths is an array", Array.isArray(bw.bandwidths));

  console.log("\ndomain normalization");
  const summary = toMessageSummary(msg);
  ok("summary.from flattened to string", summary.from === "K9XYZ");
  ok("summary.to is a string[]", Array.isArray(summary.to) && summary.to.every((x) => typeof x === "string"));
  ok("summary.attachmentCount matches Files", summary.attachmentCount === msg.Files.length);
  if (gw) {
    const g = toGateway(gw);
    ok("gateway.distanceKm is numeric", typeof g.distanceKm === "number");
    ok("gateway.dialKHz is numeric", typeof g.dialKHz === "number");
  }

  console.log("\nsecret redaction");
  const redacted = redactConfig({ secure_login_password: "hunter2" } as unknown as PatConfig);
  ok("non-empty secret -> ***", redacted.secure_login_password === "***");
  ok("config() redacts via the adapter", (await pat.config()).secure_login_password !== "hunter2");

  console.log("\nfailure classification");
  const http503 = new PatEngine({
    baseUrl: "http://stub:8049",
    fetchImpl: (async () => new Response("down", { status: 503 })) as typeof fetch,
  });
  await expectError("http", () => http503.status(), "HTTP 503");

  const badJson = new PatEngine({
    baseUrl: "http://stub:8049",
    fetchImpl: (async () => new Response("not json", { status: 200 })) as typeof fetch,
  });
  await expectError("parse", () => badJson.status(), "non-JSON body");

  const offline = new PatEngine({
    baseUrl: "http://stub:8049",
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
  });
  await expectError("unavailable", () => offline.status(), "connection refused");

  const aborted = new PatEngine({
    baseUrl: "http://stub:8049",
    fetchImpl: (async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as typeof fetch,
  });
  await expectError("timeout", () => aborted.status(), "aborted request");

  const tiny = new PatEngine({
    baseUrl: "http://stub:8049",
    maxBytes: 5,
    fetchImpl: (async () => new Response('{"connected":false}', { status: 200 })) as typeof fetch,
  });
  await expectError("too-large", () => tiny.status(), "oversized body");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
