import type { NextApiRequest, NextApiResponse } from "next";

import { authedRoute } from "@/lib/auth/guard";
import { loadCardSettings, renderQslCard, type CardSettings } from "@/lib/qsl/card";
import { prisma } from "@/lib/db/prisma";

// Render a sample card, optionally with UNSAVED settings.
//
// The card is built by compositing a table over artwork using a dozen numbers — table
// position, width, font scale, four colours. Tuning those by editing a setting, saving,
// sending a QSL to yourself and opening the attachment is not a feedback loop anybody will
// run twice, which is why the defaults had never been changed.
//
// Every geometry and colour setting can be overridden per request, so the page can preview
// a draft before it is saved. Nothing here writes: the overrides are applied to a copy of
// the loaded settings and thrown away with the response.

/** A real contact if the log has one, so the preview shows real field widths. */
async function sampleQso() {
  const q = await prisma.qso.findFirst({
    orderBy: { startTime: "desc" },
    include: { station: true },
  });
  if (q) {
    return {
      qso: {
        callsign: q.callsign,
        band: q.band,
        mode: q.mode,
        startTime: q.startTime,
        freqHz: q.freqHz === null ? null : Number(q.freqHz),
        rstSent: q.rstSent,
        rstRcvd: q.rstRcvd,
        gridSquare: q.gridSquare,
      },
      station: { callsign: q.station.callsign, grid: q.station.grid },
    };
  }
  // An empty log still needs a preview, and inventing one is better than refusing: the
  // point is the layout, not the contact. Deliberately obvious as a sample.
  return {
    qso: {
      callsign: "K1ABC",
      band: "20M",
      mode: "FT8",
      startTime: new Date(),
      freqHz: 14_074_000,
      rstSent: "-12",
      rstRcvd: "-09",
      gridSquare: "FN31",
    },
    station: { callsign: "SAMPLE", grid: "FN31pr" },
  };
}

const NUMERIC: (keyof CardSettings)[] = [
  "width",
  "tableRight",
  "tableBottom",
  "tableWidth",
  "fontScale",
  "quality",
];
const COLOUR: (keyof CardSettings)[] = [
  "textColor",
  "headingBg",
  "cellBg",
  "borderColor",
];

async function get(req: NextApiRequest, res: NextApiResponse) {
  const cfg = await loadCardSettings();

  // Apply only the keys the caller actually sent, and only if they parse. A bad value
  // falls back to the saved one rather than rendering something misleading — a preview
  // that silently ignores a typo teaches the wrong thing about the setting.
  for (const key of NUMERIC) {
    const raw = req.query[key];
    if (typeof raw !== "string") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) (cfg[key] as number) = n;
  }
  for (const key of COLOUR) {
    const raw = req.query[key];
    if (typeof raw === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw)) {
      (cfg[key] as string) = raw;
    }
  }
  if (typeof req.query.columns === "string" && req.query.columns.trim()) {
    // Reuse the saved parser's shape by handing it the raw string; an unparseable list
    // falls back inside loadCardSettings' own rules rather than being validated twice.
    (cfg as { columns: CardSettings["columns"] }).columns = req.query.columns
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter((c): c is CardSettings["columns"][number] => c.length > 0);
    if (cfg.columns.length === 0) (await loadCardSettings()).columns.forEach((c) => cfg.columns.push(c));
  }
  // Previews are shown on screen at a few hundred pixels, so rendering 1600 wide costs
  // time and bandwidth for detail nobody sees. Capped unless explicitly asked otherwise.
  if (typeof req.query.width !== "string") cfg.width = Math.min(cfg.width, 900);

  const { qso, station } = await sampleQso();
  try {
    const card = await renderQslCard(qso, station, cfg);
    // NEVER cached: the whole purpose is to reflect the settings in this request.
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(card.jpeg);
  } catch (err) {
    // Most often "artwork not found", which is a configuration state rather than a crash,
    // and the message names the setting to change. Returned as TEXT so the page can show
    // it instead of a broken image icon.
    res.status(422).setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(err instanceof Error ? err.message : "The card could not be rendered");
  }
}

export default authedRoute({ GET: { role: "OPERATOR", handler: get } });
