// A link to the QSL card, for recipients who cannot receive the image.
//
// Winlink is carried over amateur radio and arrl.net forwards through a relay that breaks
// SPF, so `rulesFor` drops the card image for both — correctly, because a 200 kB JPEG over
// a radio link is antisocial and an attachment through a forwarder is what gets a message
// filtered. The consequence, until now, was that those operators got a QSL email with no
// QSL in it and no way to see one.
//
// A link costs nothing on either path: forty characters of text, fetched later over the
// recipient's ordinary internet connection rather than over the constrained channel the
// message arrived on.
//
// The token is an HMAC of the contact id under SETTINGS_KEY, the same construction the
// unsubscribe link uses and for the same reasons: nothing to store, nothing to expire, and
// it works from a message somebody kept for a year. What it authorises is viewing a card for
// a contact that recipient was part of, which is not information worth guarding harder than
// this — but it does mean the id cannot be enumerated, which an unsigned /card/<id> would
// allow.

import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  const k = process.env.SETTINGS_KEY;
  if (!k) throw new Error("SETTINGS_KEY is not set, so card links cannot be signed");
  return k;
}

export function cardToken(qsoId: string): string {
  return createHmac("sha256", secret())
    .update(`qsl-card:${qsoId}`)
    .digest("base64url")
    .slice(0, 32);
}

export function cardTokenValid(qsoId: string, token: string): boolean {
  try {
    const want = Buffer.from(cardToken(qsoId));
    const got = Buffer.from(token ?? "");
    return want.length === got.length && timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

/** The link that goes in an email. `base` is the public URL of this instance. */
export function cardUrl(base: string, qsoId: string): string {
  const root = base.replace(/\/+$/, "");
  return `${root}/api/qsl/card/${encodeURIComponent(qsoId)}?t=${cardToken(qsoId)}`;
}
