/* eslint-disable no-console */
// Checks the security response headers.
// Run: npm run check:headers
//
// THE FAULT THESE GUARD. A sweep of the live install (docs/exposure.md) enumerated all 62
// API routes, proved every guarded one answered 401, and confirmed that .env, the Prisma
// schema, the LoTW certificate and .git/config were all refused. It never looked at
// response headers, and there were none: no CSP, no HSTS, no nosniff, no frame-ancestors,
// and `X-Powered-By: Next.js` on every response.
//
// These import the REAL next.config and call its `headers()`. Asserting a copy of the
// policy would be worthless — check-dxcc.ts spent a long time doing exactly that.
//
// Most of what follows asserts the REASONING rather than the presence of a header, because
// presence is the easy half. A CSP with `script-src 'self' 'unsafe-inline'` is present,
// scores well in a scanner, and gives up most of what CSP is for.

import config from "../next.config";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

async function main(): Promise<void> {
  if (typeof config.headers !== "function") {
    console.log("FAIL next.config exports no headers() function");
    process.exit(1);
  }

  const rules = await config.headers();
  const all = rules.flatMap((r) => r.headers.map((h) => [h.key, h.value] as const));
  const get = (k: string): string | undefined =>
    all.find(([key]) => key.toLowerCase() === k.toLowerCase())?.[1];

  const csp = get("Content-Security-Policy") ?? "";
  const directive = (name: string): string => {
    const found = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `) || d === name);
    return found ?? "";
  };

  console.log("1. every response carries the headers");
  {
    check("one rule matching all paths", rules.some((r) => r.source === "/:path*"), rules.map((r) => r.source));
    for (const h of [
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
    ]) {
      check(`${h} is set`, (get(h) ?? "").length > 0);
    }
    check("X-Content-Type-Options is nosniff", get("X-Content-Type-Options") === "nosniff");
    check("X-Frame-Options is DENY", get("X-Frame-Options") === "DENY");
  }

  console.log("");
  console.log("2. THE LOAD-BEARING DIRECTIVE: script-src admits nothing inline");
  {
    // This is the difference between a CSP that stops an injected script and one that only
    // looks like it does. The built output was read to establish it holds: the sole inline
    // <script> is __NEXT_DATA__ with type="application/json", which is not executable.
    check("script-src is present", directive("script-src").length > 0, csp);
    check("script-src allows 'self'", /script-src[^;]*'self'/.test(csp), directive("script-src"));
    check(
      "script-src has NO 'unsafe-inline'",
      !/script-src[^;]*'unsafe-inline'/.test(csp),
      directive("script-src"),
    );
    check(
      "script-src has NO 'unsafe-eval'",
      !/script-src[^;]*'unsafe-eval'/.test(csp),
      directive("script-src"),
    );
    check(
      "and no wildcard host",
      !/script-src[^;]*(\s\*|https:(?!\/))/.test(directive("script-src")),
      directive("script-src"),
    );
  }

  console.log("");
  console.log("3. the rest of the policy");
  {
    check("default-src is 'self'", directive("default-src") === "default-src 'self'", directive("default-src"));
    check("object-src is 'none'", directive("object-src") === "object-src 'none'", directive("object-src"));
    check("frame-ancestors is 'none'", directive("frame-ancestors") === "frame-ancestors 'none'");
    check("base-uri is 'self'", directive("base-uri") === "base-uri 'self'");
    check("form-action is 'self'", directive("form-action") === "form-action 'self'");
    // Needed and accepted: 34 React style={{...}} props plus one <style> block. A far
    // smaller weapon than inline script, and the alternative is rewriting dynamic sizing for
    // no security gain.
    check("style-src permits 'unsafe-inline'", /style-src[^;]*'unsafe-inline'/.test(csp));
    check("connect-src is present", directive("connect-src").length > 0);
  }

  console.log("");
  console.log("4. deliberate omissions, so they are not 'fixed' by mistake");
  {
    // Each of these would break something real. They are asserted ABSENT so that a later
    // pass tightening the policy has to read why first.

    // LAN visitors reach this over plain http by design (docs/exposure.md).
    check(
      "no upgrade-insecure-requests — it would break LAN http access",
      !/upgrade-insecure-requests/.test(csp),
    );
    // Preload is effectively irreversible and belongs to whoever owns the apex domain.
    check("HSTS carries no preload", !/preload/i.test(get("Strict-Transport-Security") ?? ""));
    check(
      "HSTS carries no includeSubDomains — sibling hosts are not ours to bind",
      !/includeSubDomains/i.test(get("Strict-Transport-Security") ?? ""),
    );
    check(
      "HSTS max-age is at least a year",
      Number(/max-age=(\d+)/.exec(get("Strict-Transport-Security") ?? "")?.[1] ?? 0) >= 31_536_000,
      get("Strict-Transport-Security"),
    );
    // The API keys page copies a token with navigator.clipboard. Denying this breaks that
    // button with no error the operator could act on.
    check(
      "Permissions-Policy does NOT deny clipboard-write",
      !/clipboard-write=\(\)/.test(get("Permissions-Policy") ?? ""),
      get("Permissions-Policy"),
    );
    // Receiver audio plays without a user gesture.
    check(
      "Permissions-Policy does NOT deny autoplay",
      !/autoplay=\(\)/.test(get("Permissions-Policy") ?? ""),
      get("Permissions-Policy"),
    );
  }

  console.log("");
  console.log("5. what IS denied is what nothing here uses");
  {
    // Verified against the source: no getUserMedia, no mediaDevices, no geolocation.
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb", "display-capture"]) {
      check(`${feature} is denied`, new RegExp(`${feature}=\\(\\)`).test(get("Permissions-Policy") ?? ""));
    }
  }

  console.log("");
  console.log("6. the stack is not advertised");
  {
    check("poweredByHeader is off", config.poweredByHeader === false, config.poweredByHeader);
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
}

void main();
