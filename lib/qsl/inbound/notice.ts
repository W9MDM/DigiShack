// Fetching the card behind a "you have a QSL card waiting" notice.
//
// The link in a notice is chosen by whoever sent the email, so following it is a request to
// a URL a stranger wrote. That is only done under narrow rules:
//
//   * https, the default port, and a host that IS digiqsl.com or qslworld.com (or a
//     subdomain of one). Nothing else is fetched at all — not another site, not an IP
//     address, not a name that merely contains one of those words.
//   * Redirects are followed by hand, at most three, and every hop must pass the same test,
//     so a link on an allowed host cannot bounce the request to an internal address.
//   * The page is read to 1 MB at most and the image to the card limit, both with timeouts.
//   * The image is accepted only if its bytes are an image (sniffImage), like any attachment.
//
// eQSL is deliberately absent. Its cards are behind the operator's eQSL login, which this
// importer does not hold; the existing eQSL inbox sync is what reads them. A digiqsl or
// qslworld page that needs a login simply yields no image, and the notice keeps its link.
//
// UNVERIFIED: neither site's page structure was available to test against. The image is
// looked for as og:image first, then an <img> whose address mentions a card. If that guess
// is wrong the cost is a notice without a picture, which is what it was before.

import { MAX_IMAGE_BYTES, sniffImage, type ImageCheck } from "@/lib/qsl/inbound/classify";
import { readCapped } from "@/lib/qsl/inbound/source";
import type { FetchLike } from "@/lib/mail/graph";

const ALLOWED = ["digiqsl.com", "qslworld.com"];
const PAGE_MAX_BYTES = 1024 * 1024;

/** May this URL be fetched at all? */
export function allowedNoticeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  return ALLOWED.some((d) => host === d || host.endsWith(`.${d}`)) ? u : null;
}

async function fetchAllowed(fetchImpl: FetchLike, start: URL, max: number): Promise<{ url: URL; bytes: Uint8Array; type: string } | null> {
  let url = start;
  for (let hop = 0; hop <= 3; hop++) {
    const res = await fetchImpl(url.href, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: { "User-Agent": "DigiShack QSL importer" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      const next = loc ? allowedNoticeUrl(new URL(loc, url).href) : null;
      if (!next) return null;
      url = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readCapped(res, max);
    return bytes ? { url, bytes, type: res.headers.get("content-type") ?? "" } : null;
  }
  return null;
}

/** The card image's address in a card site's page, or null. Pure, for the check. */
export function findCardImage(html: string, page: URL): URL | null {
  const candidates: string[] = [];
  const og = /<meta[^>]+property\s*=\s*["']og:image["'][^>]*>/i.exec(html)?.[0];
  const ogContent = og ? /content\s*=\s*["']([^"']+)["']/i.exec(og)?.[1] : undefined;
  if (ogContent) candidates.push(ogContent);
  for (const m of html.matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
    if (m[1] && /qsl|card/i.test(m[1]) && !/logo|icon|avatar|banner/i.test(m[1])) candidates.push(m[1]);
  }
  for (const c of candidates) {
    try {
      const u = allowedNoticeUrl(new URL(c.replace(/&amp;/g, "&"), page).href);
      if (u) return u;
    } catch {
      /* not a URL */
    }
  }
  return null;
}

export type NoticeImageResult = { ok: true; bytes: Uint8Array; check: Extract<ImageCheck, { ok: true }> } | { ok: false; reason: string };

/** Try to fetch the card behind a notice link. Never throws. */
export async function fetchNoticeImage(link: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<NoticeImageResult> {
  const start = allowedNoticeUrl(link);
  if (!start) return { ok: false, reason: "the link is not on digiqsl.com or qslworld.com over https" };
  try {
    const page = await fetchAllowed(fetchImpl, start, PAGE_MAX_BYTES);
    if (!page) return { ok: false, reason: "the card page could not be read (it may need a login)" };
    // The link may go straight to the picture.
    const direct = sniffImage(page.bytes);
    if (direct.ok) return { ok: true, bytes: page.bytes, check: direct };
    const img = findCardImage(new TextDecoder().decode(page.bytes), page.url);
    if (!img) return { ok: false, reason: "no card picture on the page (it may need a login)" };
    const got = await fetchAllowed(fetchImpl, img, MAX_IMAGE_BYTES);
    if (!got) return { ok: false, reason: "the card picture could not be downloaded" };
    const check = sniffImage(got.bytes);
    return check.ok ? { ok: true, bytes: got.bytes, check } : { ok: false, reason: `the picture is ${check.reason}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "fetch failed" };
  }
}
