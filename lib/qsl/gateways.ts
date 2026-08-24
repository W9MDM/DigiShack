// Addresses that are not ordinary mailboxes.
//
// Three separate problems, all of which silently cost QSLs:
//
//   1. WINLINK (@winlink.org) is email carried over amateur radio, and it is not
//      an open mailbox. Every message arriving from the internet is REJECTED unless
//      the sender is on the recipient's ACCEPTLIST, or the subject carries the
//      `//WL2K` precedence key — the documented bypass for people who are not on
//      the list. A QSL to a Winlink address without it does not go to spam; it
//      bounces. https://winlink.org/HELP
//
//      Everything else about Winlink follows from it being RADIO: a 120 kB ceiling
//      on the whole message, attachment-type filters, and a link that may be a few
//      hundred baud. HTML alongside the text roughly doubles a message that is
//      mostly boilerplate, and a QSL card JPEG is out of the question.
//
//   2. ARRL.NET (@arrl.net) is a forwarding alias, not a mailbox — mail is relayed
//      on to the member's real address, with spam filtering and virus scanning in
//      between. Forwarding breaks SPF alignment by design: the receiving server
//      checks OUR domain's SPF record against ARRL's relay IP and does not find it.
//      DKIM survives forwarding, so a DKIM-signed message still authenticates —
//      which is why the UI warns when DKIM is not configured. What this layer can
//      do is keep the message small and plain, because an unsolicited HTML mail
//      with a JPEG attached, arriving via a relay with SPF already failed, is the
//      likeliest thing a filter drops on the second hop.
//
//   3. PLACEHOLDER ADDRESSES. Operators publish `mycall@wia.org.au` on QRZ meaning
//      "my callsign, at this domain" — an anti-harvesting convention a human reads
//      through and a mail server does not. Observed as a real bounce:
//      "mycall wasn't found at wia.org.au."
//
// Pure and separately tested. Every rule here is a claim about someone else's mail
// system, and the cost of getting one wrong is silent: the QSL is accepted by our
// own SMTP server and disappears somewhere downstream.

export type QslGateway = "winlink" | "arrl";

/** What a gateway needs done differently. */
export interface GatewayRules {
  gateway: QslGateway | null;
  /** Send text/plain only — no HTML alternative part. */
  plainTextOnly: boolean;
  /** Leave the card image off entirely. */
  dropCard: boolean;
  /** Why, in words an operator can act on. Empty for an ordinary mailbox. */
  notes: string[];
}

/** The Winlink ACCEPTLIST bypass. `R` is Routine — the correct precedence for a QSL. */
export const WL2K_PREFIX = "//WL2K R/";

export function detectGateway(address: string | null | undefined): QslGateway | null {
  const domain = (address ?? "").trim().toLowerCase().split("@")[1] ?? "";
  if (!domain) return null;
  // Subdomain-aware: winlink.org and anything under it, but NOT "notwinlink.org".
  if (domain === "winlink.org" || domain.endsWith(".winlink.org")) return "winlink";
  if (domain === "arrl.net" || domain.endsWith(".arrl.net")) return "arrl";
  return null;
}

export function rulesFor(address: string | null | undefined): GatewayRules {
  const gateway = detectGateway(address);
  if (gateway === "winlink") {
    return {
      gateway,
      plainTextOnly: true,
      dropCard: true,
      notes: [
        "Winlink is carried over radio: plain text only, and a LINK to the card rather " +
          "than the image itself — a 200 kB attachment over an HF link is antisocial. " +
          "The subject carries the //WL2K key so the message is not rejected for being " +
          "off the recipient's ACCEPTLIST.",
      ],
    };
  }
  if (gateway === "arrl") {
    return {
      gateway,
      plainTextOnly: true,
      // THE CARD GOES. arrl.net used to drop it, on the theory that an attachment through
      // a forwarder would be filtered. Measured in practice, it is not: arrl.net members
      // receive the image, and withholding it meant sending a QSL email with no QSL in it
      // to a large fraction of US operators.
      //
      // Still plain text, which is a separate question and unchanged: forwarding breaks
      // SPF and a DKIM signature is what carries the message through, so the fewer parts
      // the better. The card travels as an ATTACHMENT rather than an inline image, which
      // needs no HTML.
      dropCard: false,
      notes: [
        "arrl.net forwards to the member's real address, so this goes as plain text with " +
          "the card attached rather than embedded — forwarding already breaks SPF, and " +
          "the fewer parts the message has the better it survives the relay.",
      ],
    };
  }
  return { gateway: null, plainTextOnly: false, dropCard: false, notes: [] };
}

/**
 * Put the Winlink precedence key on a subject, exactly once.
 *
 * Idempotent because subjects are stored on the queue and a re-queue must not
 * produce `//WL2K R///WL2K R/…`. Any existing precedence letter is accepted, so a
 * subject an operator has deliberately marked Priority is left as they wrote it.
 */
export function withWl2kPrefix(subject: string): string {
  if (/^\s*(re:\s*)?\/\/WL2K\s+[ZOPR]\//i.test(subject)) return subject;
  return `${WL2K_PREFIX}${subject}`;
}

/**
 * The base callsign, for substituting into a placeholder address.
 *
 * `VE2/F4MUZ` and `K9XYZ/P` both carry the operator's own call as the LONGEST
 * segment — the other part is a prefix or a suffix qualifier. That holds for the
 * portable forms actually seen on the air, and where it does not the result simply
 * fails the shape test below and no substitution happens.
 */
function baseCall(callsign: string): string | null {
  const segments = callsign
    .trim()
    .toUpperCase()
    .split("/")
    .filter((s) => /^[A-Z0-9]+$/.test(s));
  if (segments.length === 0) return null;
  const best = segments.reduce((a, b) => (b.length > a.length ? b : a));
  // A real call has at least one letter and one digit; this rejects "/P", "/QRP"
  // and anything else that would address a stranger.
  return best.length >= 3 && /[A-Z]/.test(best) && /[0-9]/.test(best) ? best : null;
}

/**
 * Local parts that mean "put my callsign here".
 *
 * Deliberately NOT including a bare `call`, which is a real mailbox at plenty of
 * companies. Everything listed is a phrase no mail system issues as an actual
 * address, so substituting cannot capture a working one.
 */
const PLACEHOLDERS = new Set([
  "mycall",
  "my-call",
  "my_call",
  "mycallsign",
  "my-callsign",
  "my_callsign",
  "callsign",
  "yourcall",
  "urcall",
]);

export interface AddressFix {
  address: string;
  /** True when the local part was a placeholder and has been substituted. */
  substituted: boolean;
  /** Set when it was a placeholder that could NOT be resolved — do not send. */
  unresolved: boolean;
}

/**
 * Replace a placeholder local part with the station's own callsign.
 *
 * The callsign used is the RECIPIENT's: `mycall@wia.org.au` is written from the
 * profile owner's point of view, so "my" is theirs.
 *
 * Brackets are tolerated (`<mycall>@`, `[mycall]@`) because that is how the
 * convention is usually typeset. When the placeholder is recognised but the
 * callsign cannot be reduced to something addressable, `unresolved` is set rather
 * than returning the original: sending to a literal `mycall@` is a guaranteed
 * bounce and a small dent in our sending reputation.
 */
export function resolvePlaceholderAddress(address: string, callsign: string): AddressFix {
  const at = address.lastIndexOf("@");
  if (at <= 0) return { address, substituted: false, unresolved: false };

  const local = address.slice(0, at).trim().toLowerCase().replace(/^[<[({]+|[>\])}]+$/g, "");
  const domain = address.slice(at + 1).trim();
  if (!PLACEHOLDERS.has(local)) return { address, substituted: false, unresolved: false };

  const call = baseCall(callsign);
  if (!call) return { address, substituted: false, unresolved: true };
  return { address: `${call.toLowerCase()}@${domain}`, substituted: true, unresolved: false };
}

/** Does this address still contain an unsubstituted placeholder? */
export function isPlaceholderAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const local = address.slice(0, at).trim().toLowerCase().replace(/^[<[({]+|[>\])}]+$/g, "");
  return PLACEHOLDERS.has(local);
}

/**
 * Everything that must change about one outbound QSL, in one call.
 *
 * Used at queue time so the operator approves what will actually be sent, and again
 * at send time so a row queued before these rules existed is still handled.
 */
export function prepareForGateway(opts: {
  address: string;
  subject: string;
  callsign: string;
}): {
  address: string;
  subject: string;
  substituted: boolean;
  unresolved: boolean;
} & GatewayRules {
  const fixed = resolvePlaceholderAddress(opts.address, opts.callsign);
  const rules = rulesFor(fixed.address);
  return {
    ...rules,
    address: fixed.address,
    subject: rules.gateway === "winlink" ? withWl2kPrefix(opts.subject) : opts.subject,
    substituted: fixed.substituted,
    unresolved: fixed.unresolved,
  };
}
