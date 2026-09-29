// Who a request actually came from.
//
// WHY THIS FILE EXISTS, established by looking at real rows rather than by reading code.
// Four places recorded a client address — the session, the login throttle, the reset
// throttle and the forgot-password throttle — and all four read ONLY `x-real-ip`, which is
// an nginx convention. This station is published through a Cloudflare tunnel, and
// `cloudflared` does not set that header. So every one of them fell through to
// `req.socket.remoteAddress`, which is the tunnel process on the same machine:
//
//     ip                       n   newest
//     ::1                      3   2026-08-07
//     ::ffff:<a LAN address>   1   2026-08-05
//     ::ffff:127.0.0.1         1   2026-08-05
//
// Every session in the database, recorded as loopback. Not one real visitor. The operator
// asked for reset requests logged "and the ip they came from", and on the previous helper
// that view would have shown `::1` for every row — a feature that appears to work and
// answers nothing.
//
// TRUST BOUNDARY, stated because it is a real one. Both headers used here are set by the
// proxy in front of the app and overwrite anything the client sent — but a client that can
// reach the app DIRECTLY, bypassing the proxy, can forge them.
// Cloudflare overwrites `CF-Connecting-IP` on every request it proxies, so it cannot be
// forged from the internet — but a host on the LAN talking to port 3000 can send anything
// it likes. That is acceptable for an audit trail, which records what was claimed; it is
// worth knowing before anything makes a SECURITY decision on the result.

/** The subset of a request this needs. Keeps the function pure and testable. */
export interface IpSource {
  headers: Record<string, string | string[] | undefined>;
  socketAddress?: string | null;
}

/**
 * IPv4-mapped IPv6 addresses read as noise in a UI.
 *
 * Node reports an IPv4 peer on a dual-stack socket as `::ffff:198.51.100.23`. That is the
 * same address as `198.51.100.23` and an operator scanning a list should not have to
 * translate it — nor should two spellings of one address count as two attackers.
 */
export function normaliseIp(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  // Strip the IPv4-mapped prefix in either of its spellings.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) return mapped[1]!;
  // A bracketed address with a port, as some proxies emit: [2001:db8::1]:443
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d+)?$/i.exec(s);
  if (bracketed) return bracketed[1]!;
  // An IPv4 address with a port. NOT applied to bare IPv6, whose colons are structural.
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (withPort) return withPort[1]!;
  return s;
}

/** Take one header value, whether the framework gave us a string or a list. */
function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t || undefined;
}

/**
 * The client's address, best available.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY:
 *
 *   1. `cf-connecting-ip` — Cloudflare's own, a single address, overwritten by Cloudflare on
 *      every proxied request. This is the one that actually works here, and its absence is
 *      why every stored address was loopback.
 *   2. `x-real-ip` — the nginx convention, kept because it is what the previous helper used
 *      and a future reverse proxy may well set it.
 *   3. the socket, which is correct for a direct LAN connection and is the honest answer
 *      when nothing else is available.
 *
 * `x-forwarded-for` is NOT in that list, on purpose. See the note at the fallback below:
 * under nginx's `$proxy_add_x_forwarded_for` the first element is whatever the CLIENT sent,
 * so a table built to show where a request came from would show what the requester claimed.
 *
 * Returns null rather than a placeholder when there is genuinely nothing: a row saying
 * "unknown" is a row that looks recorded and is not, and `null` renders as "—" instead of
 * inviting someone to search for a host called unknown.
 */
export function clientIp(src: IpSource): string | null {
  const h = src.headers ?? {};

  const cf = first(h["cf-connecting-ip"]);
  if (cf) return capped(normaliseIp(cf));

  const real = first(h["x-real-ip"]);
  if (real) return capped(normaliseIp(real));

  // X-FORWARDED-FOR IS DELIBERATELY NOT CONSULTED, and this is the one decision in the file
  // worth arguing. The first version of it took the first hop, on the textbook grounds that
  // the chain reads client-first. `lib/auth/session.ts` had already worked out why that is
  // wrong HERE, and the reasoning was nearly deleted along with the code:
  //
  //     "the shipped config sets `$proxy_add_x_forwarded_for`, which APPENDS the real
  //      address to whatever the client sent, making element 0 attacker-controlled. This
  //      value is recorded on Session rows, so trusting it meant an attacker could write
  //      whatever origin they liked into the audit trail."
  //
  // Exactly so. Under that directive a client sending `X-Forwarded-For: 1.2.3.4` gets
  // `1.2.3.4, <their real address>` — so the first hop is whatever they typed, and a table
  // built to show where requests came from would show what the requester chose to claim.
  // Taking the LAST hop would be trustworthy under that specific config and wrong under any
  // proxy that does not append, so it trades one silent misreading for another.
  //
  // The two headers above are both set BY the proxy and overwrite anything the client sent,
  // which is the property that matters. Anything else falls through to the socket, which
  // cannot be forged at all.

  const sock = src.socketAddress?.trim();
  if (sock) return capped(normaliseIp(sock));

  return null;
}

/**
 * Bounded, because the value is caller-supplied and lands in a database column.
 *
 * 45 characters is the longest possible textual IPv6 address (an IPv4-mapped one with a
 * zone: 39 + a little). A header can carry a kilobyte of anything at all.
 */
export function capped(value: string): string | null {
  const v = value.slice(0, 45).trim();
  return v || null;
}
