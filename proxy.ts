// A fresh CSP nonce for every page render. See lib/security/csp.ts for why pages need one:
// Next 16.4 inlines a per-page Turbopack bootstrap script, and without a nonce the policy
// either blocks it (no page starts) or has to fall back to 'unsafe-inline'.
//
// The nonce travels to the render on a request header, where pages/_document.tsx reads it
// and stamps it on Next's scripts and the theme script; the same value goes out in this
// response's Content-Security-Policy. Static assets and API routes are left out by the
// matcher and keep next.config's no-nonce policy, which admits no inline script at all.

import { NextResponse, type NextRequest } from "next/server";

import { NONCE_HEADER, contentSecurityPolicy, newNonce } from "./lib/security/csp";

export default function proxy(req: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce);
  const headers = new Headers(req.headers);
  headers.set(NONCE_HEADER, nonce);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [
    {
      // Pages only. `_next/data` is the JSON a client-side navigation fetches: no script in
      // it, and the page it belongs to already has its nonce.
      source:
        "/((?!api/|_next/static/|_next/image|_next/data/|icons/|sw\\.js|offline\\.html|manifest\\.webmanifest|favicon|robots\\.txt).*)",
      // A prefetch never renders scripts the browser runs.
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
