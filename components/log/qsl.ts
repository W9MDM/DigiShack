// Where a contact stands with each confirmation channel, in one place, so the log table,
// the phone cards, the contact page and the callsign page cannot disagree.

export type QslChannelKey = "lotw" | "eqsl" | "card" | "email" | "qrz";
export type QslChannelState = "confirmed" | "sent" | "none";

export interface QslFlags {
  qslSent?: string;
  qslRcvd: string;
  lotwSent?: boolean;
  lotwRcvd: boolean;
  eqslSent?: boolean;
  eqslRcvd: boolean;
  emailQslSent?: boolean;
  /** They emailed US a card or answered ours. Not award credit; see Qso.emailQslRcvd. */
  emailQslRcvd?: boolean;
  /** They answered our emailed card without a card of their own. Not a QSL. */
  emailReplyRcvd?: boolean;
  qrzSent?: boolean;
  qrzRcvd?: boolean;
}

export interface QslChannel {
  key: QslChannelKey;
  /** Badge text. */
  label: string;
  state: QslChannelState;
  /** The state in words, e.g. "Uploaded". */
  word: string;
  /** Spoken and hovered: "LoTW: confirmed". */
  description: string;
}

/**
 * Confirmed by card, LoTW or eQSL — the log's display meaning and its "Confirmed" filter.
 * QRZ is excluded on purpose: a QRZ match is not award credit.
 */
export function isConfirmed(q: Pick<QslFlags, "qslRcvd" | "lotwRcvd" | "eqslRcvd">): boolean {
  return q.qslRcvd === "CONFIRMED" || q.lotwRcvd || q.eqslRcvd;
}

function service(
  key: QslChannelKey,
  label: string,
  rcvd: boolean | undefined,
  sent: boolean | undefined,
): QslChannel {
  const state: QslChannelState = rcvd ? "confirmed" : sent ? "sent" : "none";
  const word = state === "confirmed" ? "Confirmed" : state === "sent" ? "Uploaded" : "Not sent";
  const description =
    state === "confirmed"
      ? `${label}: confirmed`
      : state === "sent"
        ? `${label}: uploaded, not yet confirmed`
        : `${label}: not sent`;
  return { key, label, state, word, description };
}

/** LoTW, eQSL, paper card and emailed card, always in that order; QRZ on request. */
export function qslChannels(q: QslFlags, opts: { includeQrz?: boolean } = {}): QslChannel[] {
  const cardState: QslChannelState =
    q.qslRcvd === "CONFIRMED" ? "confirmed" : q.qslSent === "SENT" ? "sent" : "none";
  const out: QslChannel[] = [
    service("lotw", "LoTW", q.lotwRcvd, q.lotwSent),
    service("eqsl", "eQSL", q.eqslRcvd, q.eqslSent),
    {
      key: "card",
      label: "Card",
      state: cardState,
      word: cardState === "confirmed" ? "Received" : cardState === "sent" ? "Sent" : "None",
      description:
        cardState === "confirmed"
          ? "Paper card: received"
          : cardState === "sent"
            ? "Paper card: sent"
            : "Paper card: none",
    },
    // Received outranks sent, as it does for every other channel. It is NOT counted by
    // isConfirmed above: an emailed picture is not award credit, so the log's Confirmed
    // filter and the awards page stay exactly as they were.
    // A reply without their card sits between: more than sent, less than a card. It keeps
    // the "sent" look and says "Replied", so a glance still separates who sent a card back.
    {
      key: "email",
      label: "Email",
      state: q.emailQslRcvd ? "confirmed" : q.emailQslSent || q.emailReplyRcvd ? "sent" : "none",
      word: q.emailQslRcvd ? "Received" : q.emailReplyRcvd ? "Replied" : q.emailQslSent ? "Sent" : "Not sent",
      description: q.emailQslRcvd
        ? "Emailed card: received"
        : q.emailReplyRcvd
          ? "Emailed card: they replied, without a card of their own"
          : q.emailQslSent
            ? "Card image emailed"
            : "No card image emailed",
    },
  ];
  if (opts.includeQrz) {
    const qrz = service("qrz", "QRZ", q.qrzRcvd, q.qrzSent);
    // A QRZ match means both logs agree; it is not a confirmation that counts for awards.
    if (qrz.state === "confirmed") {
      qrz.word = "Matched";
      qrz.description = "QRZ: both logs match (not award credit)";
    }
    out.push(qrz);
  }
  return out;
}
