import { getSetting } from "@/lib/settings";

// What tells this install apart from the others running the same callsign: the
// operator-set location and description, plus the station's callsign. Read by
// the header and by /api/v1, so a club system sees the same label as the shack.

export interface StationLabel {
  location: string | null;
  description: string | null;
}

export async function stationLabel(): Promise<StationLabel> {
  const [location, description] = await Promise.all([getSetting("station.location"), getSetting("station.description")]);
  return {
    location: location?.trim() || null,
    description: description?.trim() || null,
  };
}

