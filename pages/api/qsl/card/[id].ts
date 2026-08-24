import type { NextApiRequest, NextApiResponse } from "next";

import { renderQslCard } from "@/lib/qsl/card";
import { cardTokenValid } from "@/lib/qsl/card-link";
import { prisma } from "@/lib/db/prisma";

// Serve one QSL card image.
//
// UNAUTHENTICATED, like the unsubscribe endpoint and for the same reason: the visitor is
// the operator we worked, who has no account here and no reason to want one. The signed
// token in the query string is what stands in for a login, and it is scoped to a single
// contact — so a link cannot be walked to anybody else's card, which an unsigned
// /card/<id> would allow.
//
// This exists because Winlink and arrl.net recipients have the card DROPPED from their
// email: Winlink is carried over radio, and an attachment through arrl.net's forwarder is
// what gets a message filtered. They used to receive a QSL with no QSL in it.

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).end("Method not allowed");
    return;
  }

  const id = typeof req.query.id === "string" ? req.query.id : "";
  const token = typeof req.query.t === "string" ? req.query.t : "";
  if (!id || !cardTokenValid(id, token)) {
    // No detail. A stranger with a broken link needs a next step, not a diagnosis.
    res.status(404).setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("That card link is not valid. Reply to the email and it will be sent by hand.");
    return;
  }

  const qso = await prisma.qso.findUnique({
    where: { id },
    include: { station: true, operator: true },
  });
  if (!qso) {
    res.status(404).setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("That contact is no longer in the log.");
    return;
  }

  try {
    const card = await renderQslCard(
      {
        callsign: qso.callsign,
        band: qso.band,
        mode: qso.mode,
        startTime: qso.startTime,
        freqHz: qso.freqHz === null ? null : Number(qso.freqHz),
        rstSent: qso.rstSent,
        rstRcvd: qso.rstRcvd,
        gridSquare: qso.gridSquare,
      },
      { callsign: qso.station.callsign, grid: qso.station.grid },
    );
    // Cached hard: the card for a logged contact does not change, and a recipient who
    // opens the link twice should not re-render it. Not `immutable` — the artwork or the
    // table settings can change, and a year-old link should show the current design.
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="qsl-${qso.station.callsign}-${qso.callsign}.jpg"`,
    );
    res.status(200).end(card.jpeg);
  } catch (err) {
    // renderQslCard throws when the artwork is missing, which is a configuration fault
    // here and not the visitor's problem — so it says so without exposing a path.
    console.error("[qsl-card] render failed:", err instanceof Error ? err.message : err);
    res.status(503).setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("The card could not be generated just now. Please try again later.");
  }
}
