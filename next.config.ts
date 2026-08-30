import { readFileSync } from "node:fs";

import type { NextConfig } from "next";

// The running version, read once at build time and handed to the client.
// The service worker registration uses it as its cache key (see
// lib/client/service-worker.ts), so it has to be reachable from the browser —
// and importing package.json into client code would bundle the whole file,
// dependency list and all.
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

/**
 * Content Security Policy.
 *
 * MEASURED AGAINST THE BUILT OUTPUT rather than assumed, because a CSP that is wrong fails
 * silently in someone else's browser. The served HTML was read and every directive below
 * corresponds to something that is actually in it:
 *
 *   - the ONLY inline `<script>` Next emits is `__NEXT_DATA__`, and it carries
 *     `type="application/json"`. That is not executable, so `script-src` never applies to
 *     it. Every other script is a `src=` under `/_next/static/`.
 *   - there is no `dangerouslySetInnerHTML` anywhere in `pages/` or `components/`, and no
 *     `eval` or `new Function` in client code.
 *
 * So `script-src 'self'` holds with NEITHER 'unsafe-inline' NOR 'unsafe-eval'. That is the
 * directive that does the real work: it means an injected `<script>` cannot run and an
 * attacker-hosted one cannot load, which is most of what CSP is for. It is worth keeping,
 * so anything that would force 'unsafe-inline' back — an inline handler, a third-party
 * snippet, a chart library that evals — should be rejected on that basis rather than
 * accommodated by loosening this line.
 *
 * `style-src` DOES need 'unsafe-inline': 34 React `style={{...}}` props and one `<style>`
 * block in the QSL card page. Inline styles are a far smaller weapon than inline scripts,
 * and removing them would mean rewriting dynamic sizing — the waterfall height, the award
 * progress bars — as CSS custom properties for no security gain worth the churn.
 *
 * `connect-src` carries `ws:` and `wss:` as a deliberate loosening. Same-origin sockets
 * would be covered by 'self' alone, but `bridge.publicWsUrl` is a documented setting that
 * points the decode and audio sockets at another origin, and this header is built at BUILD
 * time and cannot read a runtime setting. The choice was between a wildcard scheme and
 * silently breaking a shipped feature for anyone who uses it. The cost is bounded: with
 * `script-src 'self'` holding, there is no easy way to run the code that would abuse it.
 *
 * NO `upgrade-insecure-requests`, on purpose. LAN visitors reach this over plain http by
 * design (see docs/exposure.md); upgrading their requests would break them for a property
 * HSTS already provides to everyone arriving over the tunnel.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

/**
 * Permissions-Policy.
 *
 * DENIALS ONLY. An unlisted feature keeps its browser default, which is what makes this
 * safe to extend; enumerating allowances instead is how a policy quietly switches off a
 * feature nobody remembered was in use.
 *
 * Everything here was checked against the source first. `clipboard-write` is deliberately
 * ABSENT because the API keys page copies a token with it, and denying it would break that
 * button with no error the operator could act on. `autoplay` is absent because receiver
 * audio plays without a gesture. What is denied is what nothing in this application asks
 * for: there is no `getUserMedia`, no geolocation, no payment, no USB.
 */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "usb=()",
  "xr-spatial-tracking=()",
].join(", ");

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // `X-Powered-By: Next.js` on every response told anyone asking exactly what to look up
  // advisories for. It is not a vulnerability by itself and removing it is not a defence —
  // it is the free half of not volunteering the answer.
  poweredByHeader: false,

  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },

  /**
   * Security headers, on every response including API routes.
   *
   * Added after a sweep of the live install found NONE of them present — see
   * docs/exposure.md, which had verified authentication thoroughly and never looked at
   * response headers at all.
   *
   * HSTS carries no `preload` and no `includeSubDomains`. Preload is effectively
   * irreversible and belongs to whoever owns the apex domain, not to this application;
   * `includeSubDomains` would impose https on sibling hostnames this project knows nothing
   * about. Browsers ignore HSTS delivered over plain http, so LAN visitors are unaffected
   * either way.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Redundant with `frame-ancestors 'none'` for anything modern, and kept for the
          // browsers that honour only one of the two.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
          // A callsign in a path or query is not a secret, but it is a person, and it has
          // no business travelling to another origin in a Referer.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
        ],
      },
    ];
  },

  // Pages Router. Deliberate: the DigiShack spec targets Pages Router to match
  // the other self-hosted projects (Sidetone, Squelch, inode, HamHub). There is
  // no `app/` directory — do not add one.

  // Prisma must not be bundled into the serverless/edge trace; it needs its
  // generated native query engine at runtime.
  serverExternalPackages: ["@prisma/client", "prisma", "bullmq", "ioredis"],

  // The backup route walks data/ and backups/ at runtime. The bundler reads a
  // directory walk under process.cwd() as a possible dynamic import and pulls the
  // whole project into the deployment trace — including a 14 MB QSL card image.
  // These are runtime data paths, never modules.
  outputFileTracingExcludes: {
    "/api/backup": ["./data/**", "./backups/**", "./.next/**", "./node_modules/**"],
  },
};

export default nextConfig;
