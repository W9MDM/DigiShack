/**
 * Content Security Policy, built in one place for both of the places that send it.
 *
 * MEASURED AGAINST THE BUILT OUTPUT rather than assumed, because a CSP that is wrong fails
 * silently in someone else's browser. The served HTML was read and every directive below
 * corresponds to something that is actually in it.
 *
 * SCRIPTS. Next.js 16.4 with Turbopack puts a small bootstrap script inline in every page
 * (`globalThis["TURBOPACK"].push(...)`), and _document has the theme script that has to run
 * before first paint. Both are inline and both differ per page or per build, so no hash can
 * name them. On 2026-10-23 the 16.2.9 -> 16.4.2 security upgrade shipped with plain
 * `script-src 'self'` and every page on both installs downloaded its code and never ran it:
 * the browser refuses inline scripts silently, and no check here loads a page in a browser.
 *
 * So pages get a NONCE: proxy.ts mints one per request, sends it in this policy, and
 * _document stamps it on Next's scripts and the theme script. An injected `<script>` still
 * cannot run, because it cannot know this request's nonce, which is the whole point of
 * script-src. Responses the proxy does not see (static assets, API JSON) carry the same
 * policy with no nonce, which admits no inline script at all. Neither form ever carries
 * 'unsafe-inline' or 'unsafe-eval'; anything that would need them (an inline handler, a
 * third-party snippet, a library that evals) should be rejected rather than accommodated.
 *
 * `style-src` DOES need 'unsafe-inline': React `style={{...}}` props and one `<style>` block
 * in the QSL card page. Inline styles are a far smaller weapon than inline scripts, and
 * removing them would mean rewriting dynamic sizing (the waterfall height, the award
 * progress bars) as CSS custom properties for no security gain worth the churn.
 *
 * `connect-src` carries `ws:` and `wss:` as a deliberate loosening: `bridge.publicWsUrl` is a
 * documented setting that points the decode and audio sockets at another origin, and the
 * static form of this header is built at BUILD time and cannot read a runtime setting.
 *
 * NO `upgrade-insecure-requests`, on purpose. LAN visitors reach this over plain http by
 * design (see docs/exposure.md); upgrading their requests would break them.
 */
export function contentSecurityPolicy(nonce?: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    nonce ? `script-src 'self' 'nonce-${nonce}'` : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join("; ");
}

/** The request header proxy.ts hands the nonce to the page render on. */
export const NONCE_HEADER = "x-nonce";

/** 128 random bits, base64: the CSP spec asks for at least 128 and an unguessable value. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
