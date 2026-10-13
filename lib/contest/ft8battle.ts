
const BAND_BONUS = new Set(["6M", "10M"]);

const MODE_BONUS = new Set(["FT4", "FT2"]);

export const BASE_POINTS = 1;
export const POTA_BONUS = 2;
export const FIRST_CONTACT_BONUS = 4;

export const HAPPY_HOURS_UTC = [7, 17];

export function isHappyHour(at: Date): boolean {
  return HAPPY_HOURS_UTC.includes(at.getUTCHours());
}

export interface ScoreInput {
  band: string;
  mode: string;
  at: Date;
  pota?: boolean;
  alreadyWorkedToday?: boolean;
}

export interface Score {
  min: number;
  max: number;
  penalty: number;
  multiplier: number;
  reasons: string[];
}

export function scoreContact(input: ScoreInput): Score {
  const band = input.band.toUpperCase();
  const mode = input.mode.toUpperCase();
  const reasons: string[] = [];

  const bandMult = BAND_BONUS.has(band) ? 1.5 : 1;
  const modeMult = MODE_BONUS.has(mode) ? 2 : 1;
  const happy = isHappyHour(input.at);
  const happyMult = happy ? 2 : 1;
  const multiplier = bandMult * modeMult * happyMult;

  const flat = BASE_POINTS + (input.pota ? POTA_BONUS : 0);

  const min = Math.round(flat * multiplier);
  const max = Math.round((flat + FIRST_CONTACT_BONUS) * multiplier);

  if (input.pota) reasons.push(`POTA +${POTA_BONUS}`);
  if (bandMult > 1) reasons.push(`${band} x1.5`);
  if (modeMult > 1) reasons.push(`${mode} x2`);
  if (happy) reasons.push("Happy Hour x2");

  if (input.alreadyWorkedToday) {
    reasons.unshift("DUPLICATE");
    return { min: 0, max: 0, penalty: -2 * min, multiplier, reasons };
  }

  return { min, max, penalty: 0, multiplier, reasons };
}

export function rankByPoints<T>(
  items: T[],
  score: (item: T) => Score,
): { item: T; score: Score }[] {
  return items
    .map((item) => ({ item, score: score(item) }))
    .sort((a, b) => {
      const ap = a.score.penalty < 0 ? 1 : 0;
      const bp = b.score.penalty < 0 ? 1 : 0;
      if (ap !== bp) return ap - bp;
      if (b.score.min !== a.score.min) return b.score.min - a.score.min;
      return b.score.max - a.score.max;
    });
}
