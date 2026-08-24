import { z } from "zod";

// Same permissive callsign rule as QSOs — see lib/validation/qso.ts.
const CALLSIGN = z
  .string()
  .trim()
  .toUpperCase()
  .min(3, "Callsign is too short")
  .max(32, "Callsign is too long")
  .regex(/^[A-Z0-9/]+$/, "Callsign may contain only letters, digits and '/'")
  .regex(/\d/, "Callsign must contain at least one digit");

const GRID = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-R]{2}(\d{2}([A-X]{2}(\d{2})?)?)?$/,
    "Not a valid Maidenhead grid (e.g. EN61, EN61bx)",
  );

// ---------------------------------------------------------------------------
// Station
// ---------------------------------------------------------------------------

const baseStation = z.object({
  callsign: CALLSIGN,
  // Required, matching the spec schema (`grid String`, not nullable). A station
  // profile without a grid can't do grid-based award tracking or distance calcs.
  grid: GRID,
});

export const createStationSchema = baseStation;
export const updateStationSchema = baseStation.partial();

export type CreateStationInput = z.infer<typeof createStationSchema>;

// ---------------------------------------------------------------------------
// Operator
// ---------------------------------------------------------------------------

export const ROLES = ["ADMIN", "OPERATOR", "VIEWER"] as const;

const baseOperator = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  callsign: CALLSIGN,
  stationId: z.string().min(1, "A station is required"),
  role: z.enum(ROLES).default("OPERATOR"),
});

export const createOperatorSchema = baseOperator;
export const updateOperatorSchema = baseOperator.partial();

export type CreateOperatorInput = z.infer<typeof createOperatorSchema>;

