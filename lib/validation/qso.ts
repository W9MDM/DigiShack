import { z } from "zod";

import { freqInBand, freqToBand, isBandName } from "@/lib/ham/bands";
import { isLoggableMode } from "@/lib/ham/modes";

// Callsign rule is deliberately permissive. Real logbooks have to accept
// compound and portable forms — VP2E/K9XYZ, K9XYZ/P, DL/K9XYZ/M, 3DA0RS — and a
// tight prefix/suffix regex rejects legitimate DX. So: uppercase alphanumerics
// and slashes only, length-bounded, at least one digit somewhere. That catches
// typos and junk without arguing with the ITU.
const CALLSIGN = z
  .string()
  .trim()
  .toUpperCase()
  .min(3, "Callsign is too short")
  .max(32, "Callsign is too long")
  .regex(
    /^[A-Z0-9/]+$/,
    "Callsign may contain only letters, digits and '/'",
  )
  .regex(/\d/, "Callsign must contain at least one digit");

// Maidenhead locator: field pair, optional square pair, optional subsquare pair,
// optional extended square. 2/4/6/8 characters.
const GRID = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-R]{2}(\d{2}([A-X]{2}(\d{2})?)?)?$/,
    "Not a valid Maidenhead grid (e.g. EN61, EN61bx)",
  );

const BAND = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isBandName, "Unknown band — must be an ADIF band name (e.g. 20M)");

const MODE = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isLoggableMode, "Unknown mode");

// Frequency arrives in Hz. Lower bound is the 2190m allocation; upper is the
// 1mm band. Anything outside is a unit mistake, not a real QSO.
const FREQ_HZ = z
  .number()
  .int("Frequency must be a whole number of Hz")
  .min(135_000, "Frequency is below the lowest amateur allocation")
  .max(250_000_000_000, "Frequency is above the highest amateur allocation");

const QSL_STATUS = z.enum(["NONE", "REQUESTED", "SENT", "CONFIRMED"]);

const RST = z.string().trim().max(12, "Report is too long");

const baseQso = z.object({
  callsign: CALLSIGN,
  freqHz: FREQ_HZ,
  // Optional on input: derived from freqHz when omitted. When supplied it must
  // actually contain freqHz — a band/frequency mismatch silently corrupts
  // per-band award tracking, so it's rejected rather than guessed at.
  band: BAND.optional(),
  mode: MODE,
  startTime: z.coerce.date(),
  endTime: z.coerce.date().nullish(),
  rstSent: RST.nullish(),
  rstRcvd: RST.nullish(),
  gridSquare: GRID.nullish(),
  // Not upper-cased, unlike the award fields: these are a person's name and the
  // place they said they were, and they get printed on a QSL card.
  name: z.string().trim().max(64).nullish(),
  qth: z.string().trim().max(96).nullish(),
  dxcc: z
    .number()
    .int()
    .min(0, "DXCC entity code cannot be negative")
    .max(1000, "DXCC entity code is out of range")
    .nullish(),
  // Award fields (ADIF STATE/CNTY/CQZ/ITUZ/IOTA/CONT). Kept permissive: STATE
  // holds non-US subdivisions too, and rejecting those would refuse valid logs.
  state: z.string().trim().toUpperCase().max(16).nullish(),
  county: z.string().trim().max(64).nullish(),
  cqZone: z.number().int().min(1).max(40, "CQ zones run 1–40").nullish(),
  ituZone: z.number().int().min(1).max(90, "ITU zones run 1–90").nullish(),
  iota: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(AF|AN|AS|EU|NA|OC|SA)-\d{3}$/, "IOTA looks like NA-001")
    .nullish(),
  continent: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(NA|SA|EU|AF|AS|OC|AN)$/, "Not a continent code")
    .nullish(),
  // ADIF SIG / SIG_INFO. Deliberately not restricted to POTA or to any reference
  // format: the same pair carries SOTA (W9/IN-001), WWFF (KFF-1234), IOTA islands
  // and every national programme, and a regex tuned to POTA's US-1234 would refuse
  // valid logs from all of them.
  sig: z.string().trim().toUpperCase().max(32).nullish(),
  sigInfo: z.string().trim().toUpperCase().max(32).nullish(),
  /**
   * Every reference on the contact.
   *
   * A contact can be several parks at once — nested and overlapping parks are
   * ordinary — so this is a list and `sigInfo` is only the primary. When both are
   * given the list wins and the primary is its first entry.
   */
  sigRefs: z.array(z.string().trim().toUpperCase().max(32)).max(16).optional(),
  qslSent: QSL_STATUS.default("NONE"),
  qslRcvd: QSL_STATUS.default("NONE"),
  qslSentAt: z.coerce.date().nullish(),
  qslRcvdAt: z.coerce.date().nullish(),
  lotwSent: z.boolean().default(false),
  lotwRcvd: z.boolean().default(false),
  /**
   * QRZ Logbook has this contact, and QRZ shows it as confirmed.
   *
   * Editable like the others so the operator can correct them, but ordinarily these are
   * written by the QRZ sync: `qrzSent` when a download proves QRZ has the contact, which
   * is what stops the uploader offering it again, and `qrzRcvd` when QRZ reports both
   * operators logged it.
   */
  qrzSent: z.boolean().default(false),
  qrzRcvd: z.boolean().default(false),
  eqslSent: z.boolean().default(false),
  /**
   * An emailed card image. Separate from `qslSent`, which means paper.
   *
   * Editable so the operator can correct it — for instance after emailing a card
   * by hand from their own client.
   */
  emailQslSent: z.boolean().default(false),
  eqslRcvd: z.boolean().default(false),
  notes: z.string().max(20_000, "Notes are too long").nullish(),
  stationId: z.string().min(1, "A station is required"),
  operatorId: z.string().min(1).nullish(),
});

/** Cross-field rules shared by create and update. */
function refineQso<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .superRefine((val, ctx) => {
      const v = val as {
        band?: string;
        freqHz?: number;
        startTime?: Date;
        endTime?: Date | null;
      };

      if (v.band && v.freqHz !== undefined && !freqInBand(v.freqHz, v.band)) {
        ctx.addIssue({
          code: "custom",
          path: ["band"],
          message: `${(v.freqHz / 1e6).toFixed(6)} MHz is not inside ${v.band}`,
        });
      }

      if (v.startTime && v.endTime && v.endTime < v.startTime) {
        ctx.addIssue({
          code: "custom",
          path: ["endTime"],
          message: "End time is before start time",
        });
      }
    });
}

export const createQsoSchema = refineQso(baseQso);

// PATCH semantics: only the supplied keys change. `.partial()` drops the
// defaults too, so an omitted `qslSent` means "leave alone" rather than "reset
// to NONE" — which is what a partial update has to mean.
export const updateQsoSchema = refineQso(baseQso.partial());

export type CreateQsoInput = z.infer<typeof createQsoSchema>;
export type UpdateQsoInput = z.infer<typeof updateQsoSchema>;

/**
 * Fill in the band from the frequency when the caller didn't supply one.
 * Throws if the frequency sits in no allocation — better to reject than to
 * write a QSO with a band that doesn't match its frequency.
 */
export function resolveBand(freqHz: number, band?: string): string {
  if (band) return band;
  const derived = freqToBand(freqHz);
  if (!derived) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["freqHz"],
        message: `${(freqHz / 1e6).toFixed(6)} MHz falls outside every amateur band — supply a band explicitly if this is intentional`,
        input: freqHz,
      },
    ]);
  }
  return derived;
}

// ---------------------------------------------------------------------------
// List/filter query
// ---------------------------------------------------------------------------

export const qsoListQuerySchema = z.object({
  callsign: z.string().trim().toUpperCase().max(32).optional(),
  band: z.string().trim().toUpperCase().optional(),
  mode: z.string().trim().toUpperCase().optional(),
  stationId: z.string().optional(),
  operatorId: z.string().optional(),
  /** Free-text across callsign, grid and notes. */
  q: z.string().trim().max(64).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  confirmed: z.enum(["any", "yes", "no"]).default("any"),
  take: z.coerce.number().int().min(1).max(500).default(50),
  skip: z.coerce.number().int().min(0).default(0),
  sort: z.enum(["startTime", "callsign", "band", "mode"]).default("startTime"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

export type QsoListQuery = z.infer<typeof qsoListQuerySchema>;
