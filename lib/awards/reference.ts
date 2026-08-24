// Static reference data for award targets.
//
// Everything here is a short, stable, factual list — the 50 US states, the 40 CQ
// zones, the continents — so it is written out rather than fetched. That is the
// opposite of the DXCC entity list, which is long, changes regularly and is
// maintained upstream (see lib/dxcc/).
//
// IOTA is deliberately absent: the island-group reference runs to ~1,200 entries
// and is maintained by the RSGB IOTA programme. Progress is reported as "groups
// worked" rather than "N of M", because inventing a denominator would be worse
// than not having one.

/** ARRL Worked All States: 50 states. DC is not a WAS entity. */
export const WAS_STATES: readonly { code: string; name: string }[] = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
];

export const WAS_STATE_CODES: readonly string[] = WAS_STATES.map((s) => s.code);

/** CQ Worked All Zones: zones 1–40. */
export const CQ_ZONES: readonly number[] = Array.from(
  { length: 40 },
  (_, i) => i + 1,
);

/** Worked All Continents. AN (Antarctica) counts for WAC. */
export const CONTINENTS: readonly { code: string; name: string }[] = [
  { code: "NA", name: "North America" },
  { code: "SA", name: "South America" },
  { code: "EU", name: "Europe" },
  { code: "AF", name: "Africa" },
  { code: "AS", name: "Asia" },
  { code: "OC", name: "Oceania" },
  { code: "AN", name: "Antarctica" },
];

export const CONTINENT_CODES: readonly string[] = CONTINENTS.map((c) => c.code);

export function stateName(code: string): string | undefined {
  return WAS_STATES.find((s) => s.code === code.toUpperCase())?.name;
}

/** Maidenhead field+square, e.g. "EN61bx" -> "EN61". Grid awards count squares. */
export function gridSquare4(grid: string): string | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}\d{2}/.test(g)) return null;
  return g.slice(0, 4);
}
