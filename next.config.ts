import { readFileSync } from "node:fs";

import type { NextConfig } from "next";

import { contentSecurityPolicy } from "./lib/security/csp";

// The running version, read once at build time and handed to the client.
// The service worker registration uses it as its cache key (see
// lib/client/service-worker.ts), so it has to be reachable from the browser —
// and importing package.json into client code would bundle the whole file,
// dependency list and all.
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

// The static form of the Content Security Policy, for responses proxy.ts does not see
// (static assets, API JSON): no nonce, so no inline script at all. Pages get the same policy
// with a per-request nonce from proxy.ts. Reasoning in lib/security/csp.ts.
const CSP = contentSecurityPolicy();

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
  serverExternalPackages: ["@prisma/client", "prisma"],

  // The backup route walks data/ and backups/ at runtime. The bundler reads a
  // directory walk under process.cwd() as a possible dynamic import and pulls the
  // whole project into the deployment trace — including a 14 MB QSL card image.
  // These are runtime data paths, never modules.
  outputFileTracingExcludes: {
    "/api/backup": ["./data/**", "./backups/**", "./.next/**", "./node_modules/**"],
  },
};

export default nextConfig;
