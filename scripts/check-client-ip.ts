/* eslint-disable no-console */
// Assertions on who a request came from.
// Run: npm run check:client-ip
//
// WHY THIS EXISTS, and it was found in the database rather than in the code. Four places
// recorded a client address — the session, and the login, reset and forgot-password
// throttles — and all four read ONLY `x-real-ip`, which is an nginx convention. This
// station is published through a Cloudflare tunnel, and `cloudflared` does not set it. So
// every one fell through to the socket, which is the tunnel process on the same machine:
//
//     ip                       n   newest
//     ::1                      3   2026-08-07
//     ::ffff:<a LAN address>   1   2026-08-05
//     ::ffff:127.0.0.1         1   2026-08-05
//
// Every session ever recorded, as loopback. Not one real visitor. The operator asked for
// reset requests logged "and the ip they came from", and on the old helper that column
// would have read `::1` for every row — a feature that appears to work and answers nothing.
//
// So these assertions are about the PRECEDENCE and the PARSING, because those are the two
// things that were wrong and neither shows up as an error.

import { clientIp, normaliseIp, capped } from "../lib/auth/client-ip";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, what: string): void {
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}

// ---------------------------------------------------------------------------
console.log("Cloudflare's header wins, because it is the one that is actually set here");
// ---------------------------------------------------------------------------

eq(
  clientIp({ headers: { "cf-connecting-ip": "203.0.113.7" }, socketAddress: "127.0.0.1" }),
  "203.0.113.7",
  "cf-connecting-ip beats the socket",
);
eq(
  clientIp({
    headers: { "cf-connecting-ip": "203.0.113.7", "x-real-ip": "198.51.100.1" },
    socketAddress: "127.0.0.1",
  }),
  "203.0.113.7",
  "and beats x-real-ip",
);
// THE REGRESSION GUARD. With no Cloudflare header the old behaviour must still work, or
// fixing the tunnel would break a future nginx in front of it.
eq(
  clientIp({ headers: { "x-real-ip": "198.51.100.1" }, socketAddress: "127.0.0.1" }),
  "198.51.100.1",
  "x-real-ip still works when it is the only one present",
);

// ---------------------------------------------------------------------------
console.log("x-forwarded-for is IGNORED, and that is a security property");
// ---------------------------------------------------------------------------

// THE ASSERTION THAT WOULD HAVE CAUGHT MY OWN REGRESSION. The first version of the helper
// took the first hop of the chain, on the textbook grounds that it reads client-first.
// lib/auth/session.ts had already established why that is wrong for this deployment:
//
//     "the shipped config sets `$proxy_add_x_forwarded_for`, which APPENDS the real
//      address to whatever the client sent, making element 0 attacker-controlled."
//
// So under nginx a client sending `X-Forwarded-For: 1.2.3.4` produces
// `1.2.3.4, <their real address>`, and a table built to show where a request came from
// would faithfully display what the requester chose to claim. These assertions pin the
// header OUT rather than in.
eq(
  clientIp({ headers: { "x-forwarded-for": "1.2.3.4" }, socketAddress: "10.0.0.1" }),
  "10.0.0.1",
  "a forged X-Forwarded-For is ignored in favour of the socket",
);
eq(
  clientIp({
    headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.7" },
    socketAddress: "127.0.0.1",
  }),
  "127.0.0.1",
  "and so is a whole chain, however plausible it looks",
);
// AND IT DOES NOT OVERRIDE A TRUSTED HEADER. If it did, an attacker could displace the
// value Cloudflare set simply by adding a header of their own.
eq(
  clientIp({
    headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" },
    socketAddress: "127.0.0.1",
  }),
  "203.0.113.7",
  "a forged chain cannot displace what Cloudflare set",
);
eq(
  clientIp({
    headers: { "x-real-ip": "198.51.100.1", "x-forwarded-for": "1.2.3.4" },
    socketAddress: "127.0.0.1",
  }),
  "198.51.100.1",
  "nor what the reverse proxy set",
);

// ---------------------------------------------------------------------------
console.log("the socket is the honest answer when nothing else is available");
// ---------------------------------------------------------------------------

eq(
  clientIp({ headers: {}, socketAddress: "198.51.100.50" }),
  "198.51.100.50",
  "a direct LAN connection reports its real address",
);
// NULL, NOT "unknown". A row saying "unknown" looks recorded and is not, and it invites
// somebody to search for a host by that name.
eq(clientIp({ headers: {} }), null, "nothing at all yields null rather than a placeholder");
eq(clientIp({ headers: {}, socketAddress: "" }), null, "and an empty socket address is null");
eq(clientIp({ headers: {}, socketAddress: null }), null, "as is a null one");

// ---------------------------------------------------------------------------
console.log("IPv4-mapped IPv6 is normalised, because it is the same address twice");
// ---------------------------------------------------------------------------

// This is the shape the database held - a mapped LAN address. Two spellings of one
// address would count as two visitors in a list an operator is scanning for a pattern.
eq(normaliseIp("::ffff:198.51.100.23"), "198.51.100.23", "the mapped prefix is stripped");
eq(normaliseIp("::FFFF:10.0.0.1"), "10.0.0.1", "case-insensitively");
eq(
  clientIp({ headers: {}, socketAddress: "::ffff:127.0.0.1" }),
  "127.0.0.1",
  "and the normalisation applies through clientIp",
);

// REAL IPv6 IS LEFT ALONE. Its colons are structural, and stripping a "port" off the end
// of one would corrupt the address.
eq(normaliseIp("2001:db8::1"), "2001:db8::1", "a real IPv6 address is untouched");
eq(normaliseIp("::1"), "::1", "loopback is untouched");
eq(normaliseIp("fe80::be24:11ff:fe88:f920"), "fe80::be24:11ff:fe88:f920", "so is link-local");

// Bracketed and ported forms, which some proxies emit.
eq(normaliseIp("[2001:db8::1]:443"), "2001:db8::1", "a bracketed address loses its brackets");
eq(normaliseIp("[2001:db8::1]"), "2001:db8::1", "with or without a port");
eq(normaliseIp("203.0.113.7:5555"), "203.0.113.7", "an IPv4 address loses its port");
eq(normaliseIp(""), "", "an empty string stays empty");
eq(normaliseIp("   "), "", "as does whitespace");

// ---------------------------------------------------------------------------
console.log("the value is bounded, because it is caller-supplied and lands in a column");
// ---------------------------------------------------------------------------

{
  // The column is VARCHAR(45) — the longest textual IPv6 address. A header can carry a
  // kilobyte of anything, and an unbounded write is a truncation error at best.
  const huge = "9".repeat(5000);
  const got = clientIp({ headers: { "cf-connecting-ip": huge }, socketAddress: "127.0.0.1" });
  ok(got !== null && got.length <= 45, `a 5000-character header is capped (${got?.length})`);
  eq(capped("x".repeat(100))?.length, 45, "capped() cuts at 45");
  eq(capped(""), null, "and an empty value is null rather than an empty string");
  eq(capped("   "), null, "as is whitespace");

  // The longest real address must survive intact — a cap that truncated a legitimate
  // IPv6 address would corrupt the very rows this exists to record.
  const longest = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
  eq(capped(longest), longest, `the longest normal IPv6 address fits (${longest.length} chars)`);
}

// ---------------------------------------------------------------------------
console.log("header arrays are handled, because the framework may give either");
// ---------------------------------------------------------------------------

eq(
  clientIp({ headers: { "cf-connecting-ip": ["203.0.113.7", "198.51.100.1"] } }),
  "203.0.113.7",
  "a repeated header takes the first value",
);
eq(
  clientIp({ headers: { "cf-connecting-ip": [] }, socketAddress: "10.0.0.1" }),
  "10.0.0.1",
  "an empty array falls through rather than returning undefined",
);
eq(
  clientIp({ headers: { "cf-connecting-ip": "" }, socketAddress: "10.0.0.1" }),
  "10.0.0.1",
  "an empty header value falls through",
);

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all client-ip assertions passed");
