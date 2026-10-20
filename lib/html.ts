// HTML/XML entity escaping and unescaping, once.
//
// There were six copies of these between them, and one was wrong: the LoTW reply reader
// decoded `&amp;` FIRST, so `&amp;lt;` — the text "&lt;" as the page meant it — came out
// as "<". Decoding `&amp;` last is what keeps an escaped ampersand from being read as the
// start of a second entity, and it is the reason this is one function rather than a
// pattern each caller retypes.
//
// No dependencies, so it is safe to import from the browser and the bridge alike.

/**
 * Escape text for HTML or XML: element content and DOUBLE-quoted attribute values.
 *
 * The four characters only. A single quote is left alone, so this is not safe inside a
 * single-quoted attribute; nothing here writes one. Byte-identical to the copies it
 * replaces, which matters for the QSL card and email output they produce.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Decode the five XML entities plus `&#39;`/`&#039;`, case-insensitively.
 *
 * Deliberately not a general decoder: no other named or numeric references are touched,
 * because every caller is reading a payload whose escaping was measured to be exactly this
 * (QRZ's ADIF, cty.xml, LoTW's reply page), and inventing characters the source never sent
 * would change byte counts an ADIF length prefix depends on.
 *
 * `&amp;` is decoded LAST, so `&amp;lt;` becomes the literal text `&lt;`, not `<`.
 */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}
