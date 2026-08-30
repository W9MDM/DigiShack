/**
 * Guards the PWA and the mobile navigation.
 *
 * Everything here failed at least once during 1.118.0, or is a thing that fails
 * silently and so cannot be left to a manual check. A broken manifest does not throw:
 * the install prompt simply never appears, and there is nothing on screen to tell you
 * why. Same for the nav — the fault this release fixes was links that were PRESENT in
 * the DOM and zero pixels wide, which no smoke test would have caught.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let failed = 0;
let passed = 0;

function ok(what: string) {
  passed++;
  console.log(`  ok    ${what}`);
}

function bad(what: string, detail: string) {
  failed++;
  console.log(`  FAIL  ${what}\n        ${detail}`);
}

function check(what: string, cond: boolean, detail: string) {
  if (cond) ok(what);
  else bad(what, detail);
}

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

// ---------------------------------------------------------------- manifest

console.log("manifest");

const manifestPath = "public/manifest.webmanifest";
if (!existsSync(join(root, manifestPath))) {
  bad("manifest exists", `${manifestPath} is missing`);
} else {
  ok("manifest exists");

  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(read(manifestPath)) as Record<string, unknown>;
    ok("manifest is valid JSON");
  } catch (e) {
    bad("manifest is valid JSON", String(e));
  }

  for (const key of [
    "name",
    "short_name",
    "start_url",
    "scope",
    "display",
    "background_color",
    "theme_color",
    "icons",
  ]) {
    check(`manifest has ${key}`, manifest[key] !== undefined, `${key} is absent`);
  }

  check(
    "display is standalone",
    manifest.display === "standalone",
    `display is ${JSON.stringify(manifest.display)} — anything else opens in a browser tab`,
  );

  const icons = (manifest.icons ?? []) as {
    src?: string;
    sizes?: string;
    purpose?: string;
  }[];

  // The install prompt requires a 192 and a 512. Chrome will not say so; it just
  // declines to offer the install.
  for (const size of ["192x192", "512x512"]) {
    check(
      `has a ${size} icon`,
      icons.some((i) => i.sizes === size),
      `no icon declares sizes ${size}, and the install prompt requires both 192 and 512`,
    );
  }

  // A maskable icon is not optional in practice: without one, Android puts the
  // any-purpose icon on a white plate, which on a dark icon looks like a bug.
  check(
    "has a maskable icon",
    icons.some((i) => i.purpose === "maskable"),
    "no icon declares purpose maskable",
  );

  // ...and it must be a DIFFERENT file from the any-purpose one. Declaring one image
  // as both is the specific mistake that gets an icon cropped: maskable art needs a
  // ~20% bleed that the any-purpose icon should not have.
  const anySrcs = new Set(
    icons.filter((i) => i.purpose === "any").map((i) => i.src),
  );
  const maskSrcs = icons.filter((i) => i.purpose === "maskable").map((i) => i.src);
  check(
    "maskable icons are separate files",
    maskSrcs.length > 0 && maskSrcs.every((s) => !anySrcs.has(s)),
    "the same file is declared both any and maskable; the maskable one needs its own safe-zone bleed",
  );

  // Every referenced file must actually be on disk. A 404 icon is a manifest error
  // that only shows up in the install prompt not appearing.
  for (const icon of icons) {
    const src = icon.src ?? "";
    check(
      `icon file exists: ${src}`,
      src.startsWith("/") && existsSync(join(root, "public", src.slice(1))),
      `public${src} is missing`,
    );
  }

  const shortcuts = (manifest.shortcuts ?? []) as { url?: string }[];
  for (const s of shortcuts) {
    const url = s.url ?? "";
    // Shortcut targets must be real pages. A shortcut to a 404 is worse than none.
    const candidates = [
      `pages${url}.tsx`,
      `pages${url}/index.tsx`,
      url === "/" ? "pages/index.tsx" : "",
    ].filter(Boolean);
    check(
      `shortcut target exists: ${url}`,
      candidates.some((c) => existsSync(join(root, c))),
      `no page backs ${url}`,
    );
  }
}

// ------------------------------------------------------------ document head

console.log("\ndocument head");

const doc = read("pages/_document.tsx");
check(
  "manifest is linked",
  /rel="manifest"/.test(doc),
  "_document.tsx has no <link rel=\"manifest\">, so nothing is installable",
);
check(
  "apple-touch-icon is linked",
  /rel="apple-touch-icon"/.test(doc),
  "iOS reads only this, not the manifest icon list",
);
check(
  "apple-mobile-web-app-capable is present",
  /name="apple-mobile-web-app-capable"/.test(doc),
  "without the deprecated spelling, an iOS install opens in a browser tab",
);

const app = read("pages/_app.tsx");
check(
  "viewport-fit=cover is set",
  /viewport-fit=cover/.test(app),
  "a standalone install will letterbox around the notch",
);
check(
  "theme-color is set",
  /name="theme-color"/.test(app) || /name="theme-color"/.test(doc),
  "the system chrome will not match the app",
);
check(
  "the service worker is registered",
  /registerServiceWorker/.test(app),
  "_app.tsx never calls registerServiceWorker",
);

// --------------------------------------------------------- service worker

console.log("\nservice worker");

const swPath = "public/sw.js";
if (!existsSync(join(root, swPath))) {
  bad("sw.js exists", `${swPath} is missing`);
} else {
  ok("sw.js exists");
  const sw = read(swPath);

  /*
   * The load-bearing assertion in this file.
   *
   * This app's screens are live radio state. A worker that serves /api/ from a cache
   * shows an operator a decode list, an SWR reading or a rig state that is minutes
   * old, with no indication it is stale — a worse failure than being offline, because
   * it looks like it is working. So the bypass is a test, not a comment.
   */
  check(
    "API requests bypass the cache",
    /pathname\.startsWith\("\/api\/"\)/.test(sw),
    "sw.js does not exempt /api/ — live radio state would be served stale",
  );
  check(
    "WebSocket requests bypass the cache",
    /pathname\.startsWith\("\/ws"\)/.test(sw),
    "sw.js does not exempt /ws",
  );
  check(
    "non-GET requests bypass the cache",
    /method !== "GET"/.test(sw),
    "sw.js does not exempt mutations",
  );
  check(
    "navigations are network-first",
    /request\.mode === "navigate"/.test(sw) && /await fetch\(request\)/.test(sw),
    "HTML must come from the network when the network is there",
  );
  check(
    "the cache name is version-scoped",
    /digishack-\$\{VERSION\}/.test(sw),
    "without the version in the cache name a release cannot invalidate the old cache",
  );
  check(
    "stale caches are deleted on activate",
    /caches\.delete/.test(sw),
    "old caches would accumulate forever",
  );

  const offline = "public/offline.html";
  check(
    "offline fallback exists",
    existsSync(join(root, offline)),
    `${offline} is missing but sw.js serves it`,
  );
  if (existsSync(join(root, offline))) {
    const html = read(offline);
    // It is served precisely when the network is unavailable, so a reference to any
    // external file is a reference that will not resolve.
    check(
      "offline page is self-contained",
      !/<link[^>]+stylesheet/.test(html) && !/<script[^>]+src=/.test(html),
      "the offline page references an external asset it cannot fetch while offline",
    );
  }

  const reg = read("lib/client/service-worker.ts");
  check(
    "registration is version-keyed",
    /sw\.js\?v=/.test(reg),
    "a new release would reuse the installed worker",
  );
  check(
    "registration checks for a secure context",
    /isSecureContext/.test(reg),
    "registration would throw on a plain-HTTP LAN address instead of degrading",
  );
}

// ------------------------------------------------------------- mobile nav

console.log("\nmobile navigation");

const shell = read("components/layout/Shell.tsx");

/*
 * The reported fault: "the menu isnt visible when mobile".
 *
 * The desktop nav row is allowed to keep `min-w-0` — it needs it, because it shares a
 * flex line and must be permitted to shrink and scroll. What it must NOT do is be the
 * only nav, because `min-w-0` means "may shrink to zero" and on a phone that is
 * exactly what it did.
 */
check(
  "the desktop nav is hidden on small screens",
  /"hidden md:flex items-center gap-0\.5 overflow-x-auto/.test(shell),
  "the dense horizontal nav is still rendered below md, where it collapses to zero width",
);
check(
  "a menu button exists below md",
  /md:hidden/.test(shell) && /aria-controls="mobile-nav"/.test(shell),
  "there is no hamburger button, so the nav is unreachable on a phone",
);
check(
  "the drawer nav exists",
  /id="mobile-nav"/.test(shell),
  "no mobile drawer is rendered",
);
check(
  "the menu button reports its state",
  /aria-expanded=\{menuOpen\}/.test(shell),
  "aria-expanded is missing, so a screen reader cannot tell the menu is collapsed",
);
check(
  "the drawer closes on navigation",
  /useEffect\(\(\) => \{\s*setMenuOpen\(false\);\s*\}, \[pathname\]\)/.test(shell),
  "the drawer would stay open over the page it just navigated to",
);
check(
  "the drawer closes on Escape",
  /e\.key === "Escape"/.test(shell),
  "Escape does not dismiss the drawer",
);
check(
  "the closed drawer is out of the tab order",
  /tabIndex=\{menuOpen \? undefined : -1\}/.test(shell),
  "an offscreen drawer would still be tabbable",
);
check(
  "the drawer is inert while closed",
  /pointer-events-none/.test(shell) && /invisible/.test(shell),
  "an offscreen panel could still intercept taps",
);
check(
  "safe-area insets are honoured",
  /env\(safe-area-inset-top\)/.test(shell),
  "with viewport-fit=cover the header would sit under the status bar",
);
check(
  "sign out is reachable on a phone",
  /Sign out/.test(shell) &&
    shell.split("Sign out").length - 1 >= 2,
  "sign out appears only in the desktop-only cluster",
);

// ----------------------------------------------------- page-level overflow

console.log("\npage layout");

/*
 * The shared page header's action cluster must wrap.
 *
 * This one cost a whole-site horizontal scrollbar. PageHeader's outer row wraps, so on a
 * narrow screen the actions drop to their own line — and if that cluster cannot wrap
 * internally, its min-content width becomes the document width. On /decodes it was ~165px
 * wider than a 375px viewport, and because PageHeader is shared, EVERY page scrolled
 * sideways.
 */
const prim = read("components/ui/primitives.tsx");
check(
  "PageHeader actions wrap",
  /flex flex-wrap items-center justify-end gap-2/.test(prim),
  "the actions cluster cannot wrap; a page with several header actions will widen the document",
);

// Tables are the one element that cannot be made to fit a 360px viewport, so each one
// needs a scroll container. An unwrapped table pushes the whole document sideways and
// every page then scrolls horizontally, including its header.
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

const tsxFiles = [...walk("pages"), ...walk("components")];

const unwrapped: string[] = [];
for (const rel of tsxFiles) {
  const src = read(rel);
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (!line.includes("<table")) return;
    const before = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
    if (!/overflow-x-auto|overflow-auto|overflow-x-scroll/.test(before)) {
      unwrapped.push(`${rel}:${i + 1}`);
    }
  });
}
check(
  "every table has a horizontal scroll container",
  unwrapped.length === 0,
  `unwrapped: ${unwrapped.join(", ")}`,
);

// ------------------------------------------------------------------ the install button
//
// > "can we add the install button somewhere? maybe at the bottom?"
//
// A button that silently does nothing is worse than no button, and there are four separate
// reasons an install may be unavailable that are invisible from the page. These assert
// that each is HANDLED rather than assumed away - the same rule as the "Heard by" panel,
// where an empty answer was being reported as a fact about the world when it was a fact
// about the setup.

const install = read("components/layout/InstallButton.tsx");

check(
  "the install button is in the shell",
  read("components/layout/Shell.tsx").includes("<InstallButton />"),
  "nothing renders it, so it reaches nobody",
);
check(
  "it sits in a footer",
  /<footer[\s\S]{0,400}<InstallButton \/>/.test(read("components/layout/Shell.tsx")),
  "asked for at the bottom of the page",
);
check(
  "it keeps the beforeinstallprompt event",
  install.includes("beforeinstallprompt") && /setPrompt\(/.test(install),
  "after preventDefault this object is the ONLY way to open the dialog later",
);
check(
  "it calls preventDefault, so the browser does not raise its own bar instead",
  /preventDefault\(\)/.test(install),
  "",
);
check(
  "already-installed is detected and renders nothing",
  install.includes("display-mode: standalone") && install.includes("standalone"),
  "the prompt never fires again once installed, correctly",
);
check(
  "a non-secure context is EXPLAINED rather than silently omitted",
  install.includes("isSecureContext") && /https/i.test(install),
  "reaching the app by LAN address is the likeliest reason no install appears",
);
check(
  "iOS gets instructions, since it has no install event at all",
  /iPad|iPhone/.test(install) && /Add to Home Screen/i.test(install),
  "Safari installs from the Share menu and has never implemented beforeinstallprompt",
);
check(
  "the iPad-as-Mac user agent is covered",
  install.includes("maxTouchPoints"),
  "a touch iPad reports itself as Macintosh, so the UA alone misses it",
);
check(
  "the prompt is used once and dropped",
  /setPrompt\(null\)/.test(install),
  "firing a spent prompt throws",
);
check(
  "appinstalled is observed, so the button leaves after a successful install",
  install.includes("appinstalled"),
  "",
);
check(
  "listeners are removed on unmount",
  /removeEventListener\("beforeinstallprompt"/.test(install),
  "",
);
check(
  "the safe-area inset moved to the footer with it",
  /<footer[^>]*env\(safe-area-inset-bottom\)/.test(read("components/layout/Shell.tsx")),
  "on a phone it is the bottom of the page that must clear the home indicator",
);

// ------------------------------------------------------------------ result

console.log(
  `\n${passed} passed, ${failed} failed`,
);
if (failed > 0) process.exit(1);
