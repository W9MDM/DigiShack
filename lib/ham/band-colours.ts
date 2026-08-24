// One palette for "which band was that", shared by every page that plots contacts.
//
// Warm for the low bands, cool for the high ones — chosen so a single band still
// reads against the background and a mixed plot separates without a legend lookup
// per dot. Extracted from the Coverage page when the grid map became the second
// consumer; two palettes is how the same band ends up two colours on two pages.

export const BAND_COLOUR: Record<string, string> = {
  "160M": "#f0714a",
  "80M": "#f0904a",
  "60M": "#f0b04a",
  "40M": "#e8d24a",
  "30M": "#a8d24a",
  "20M": "#4ad27a",
  "17M": "#4ad2c0",
  "15M": "#4ab4e8",
  "12M": "#6a8ce8",
  "10M": "#9a7ae8",
  "6M": "#d07ae8",
  "2M": "#e87ab4",
};

export function colourFor(band: string): string {
  return BAND_COLOUR[band.toUpperCase()] ?? "#8a8f98";
}
