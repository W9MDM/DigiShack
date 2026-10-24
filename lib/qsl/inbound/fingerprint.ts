// Is this picture OUR card? Decided from the picture, not its name.
//
// Mail programs quote our card back in a reply under whatever name they like — Outlook calls
// it image001.jpg — so a filename rule (isOwnCardFile) cannot catch every copy. Every card we
// send is drawn on one piece of artwork (qsl.card.baseImage), with only the QSO table in the
// bottom corner changing, so the top of any copy of it looks like the top of the artwork.
//
// A difference hash of that top part: shrink to 17×16 in grey, and record whether each pixel
// is brighter than its right-hand neighbour — 256 bits that survive resizing and JPEG
// recompression. Measured on the operator's mail (October 2026): two of our cards quoted back
// as image001.jpg were 5 and 11 bits from the artwork; three other stations' card art 109 to
// 138. The limit sits well between.

import sharp from "sharp";

/** Bits that may differ for a picture still to be our artwork. */
export const OWN_CARD_MAX_DISTANCE = 40;

/** How much of the card, from the top, is artwork rather than the QSO table. */
const ART_FRACTION = 0.6;

/** The picture's fingerprint, or null when it cannot be read as an image. */
export async function cardHash(bytes: Uint8Array): Promise<bigint | null> {
  try {
    const meta = await sharp(bytes).metadata();
    if (!meta.width || !meta.height) return null;
    const raw = await sharp(bytes)
      .extract({ left: 0, top: 0, width: meta.width, height: Math.max(1, Math.round(meta.height * ART_FRACTION)) })
      .grayscale()
      .resize(17, 16, { fit: "fill" })
      .raw()
      .toBuffer();
    let bits = 0n;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) bits = (bits << 1n) | (raw[y * 17 + x]! > raw[y * 17 + x + 1]! ? 1n : 0n);
    }
    return bits;
  } catch {
    return null;
  }
}

export function hashDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/**
 * A test for "this is our card", from the artwork's bytes. Null without artwork — then there
 * is nothing to compare against and only the filename rule applies.
 */
export async function ownCardTest(artwork: Uint8Array | null): Promise<((bytes: Uint8Array) => Promise<boolean>) | null> {
  const art = artwork ? await cardHash(artwork) : null;
  if (art === null) return null;
  return async (bytes) => {
    const h = await cardHash(bytes);
    return h !== null && hashDistance(h, art) <= OWN_CARD_MAX_DISTANCE;
  };
}
