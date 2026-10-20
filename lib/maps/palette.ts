// Colours for the map canvases.
//
// A canvas cannot take a Tailwind class, so the design tokens it needs are mirrored here from
// the @theme block in styles/globals.css; scripts/check-gridmap.ts reads that file and fails
// if any of these drift from it. Every map colour is a token or a mix of two.
//
// TWO SETS, one per theme. TOKENS mirrors @theme (dark); NIGHT_TOKENS mirrors the
// `:root[data-theme="night"]` block, and check:gridmap holds both to the stylesheet. The
// map's colours are the same recipe over either set (mapColoursFor), so at night the sea,
// land, rings and labels are the night theme's reds and ambers — no blue, no white.

export const TOKENS = {
  bg: "#0a0a0b",
  surface: "#17171c",
  surface2: "#22222a",
  surface3: "#2e2e38",
  line: "#34343f",
  lineStrong: "#787890",
  fg: "#f2f2f4",
  fgMuted: "#babac5",
  fgSubtle: "#9797a4",
  ok: "#3fb950",
  warn: "#d29922",
  info: "#58a6ff",
  accentBright: "#ff6744",
} as const;

/** The night theme's values for the same tokens (styles/globals.css, the night block). */
export const NIGHT_TOKENS: Record<keyof typeof TOKENS, string> = {
  bg: "#000000",
  surface: "#120402",
  surface2: "#1a0603",
  surface3: "#230804",
  line: "#4a1206",
  lineStrong: "#cc1e00",
  fg: "#ff8c1c",
  fgMuted: "#ff5e14",
  fgSubtle: "#f23c00",
  ok: "#a87c00",
  warn: "#d8a000",
  info: "#ff7000",
  accentBright: "#ff2c10",
};

export type MapTheme = "dark" | "night";

/** The CSS custom property each token mirrors, for the drift check. */
export const TOKEN_VARS: Record<keyof typeof TOKENS, string> = {
  bg: "--color-bg",
  surface: "--color-surface",
  surface2: "--color-surface-2",
  surface3: "--color-surface-3",
  line: "--color-line",
  lineStrong: "--color-line-strong",
  fg: "--color-fg",
  fgMuted: "--color-fg-muted",
  fgSubtle: "--color-fg-subtle",
  ok: "--color-ok",
  warn: "--color-warn",
  info: "--color-info",
  accentBright: "--color-accent-bright",
};

function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** `a` blended toward `b` by `t`, as a hex colour. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return `#${x
    .map((c, i) => Math.round(c + (y[i]! - c) * t).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** A hex colour at an opacity, for canvas fill and stroke styles. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export function rgbOf(hex: string): [number, number, number] {
  return rgb(hex);
}

/**
 * What each layer is drawn in. Shared by the map and its legend chips so the swatch beside
 * "Heard by" is the colour of the rings on the map.
 */
function mapColoursFrom(t: Record<keyof typeof TOKENS, string>) {
  return {
    // A whisper of `info` in the sea so land and water read apart in a monochrome UI.
    ocean: mix(t.bg, t.info, 0.07),
    land: t.surface2,
    coast: t.line,
    gridLine: alpha(t.line, 0.75),
    squareLine: alpha(t.line, 0.45),
    label: alpha(t.fgSubtle, 0.45),
    halo: t.bg,
    worked: t.info,
    live: t.fgMuted,
    cq: t.ok,
    cqRing: mix(t.ok, t.fg, 0.45),
    // Where our own transmission landed — the transmit colour.
    heard: t.accentBright,
    home: t.fg,
    path: t.fg,
    selected: t.fg,
    day: t.fg,
    night: t.bg,
    terminator: t.warn,
  } as const;
}

export type MapColours = ReturnType<typeof mapColoursFrom>;

export const MAP_COLOURS: MapColours = mapColoursFrom(TOKENS);

/** The same layers in the night theme's tokens. */
export const NIGHT_MAP_COLOURS: MapColours = mapColoursFrom(NIGHT_TOKENS);

export function mapColoursFor(theme: MapTheme): MapColours {
  return theme === "night" ? NIGHT_MAP_COLOURS : MAP_COLOURS;
}

/**
 * Any colour, moved onto the night theme's red-to-amber line: full red at the colour's own
 * brightest channel, green from its hue, blue zero.
 *
 * For colours the map is HANDED rather than owns — the band colours of logged contacts
 * (lib/ham/band-colours.ts) are a rainbow, half of it blue and violet. Hue is kept as an
 * ordering: the warm low bands come out red, the high bands progressively more amber, so a
 * mixed plot still separates (less than by day; at night the legend is the arbiter).
 * Unparseable input is returned unchanged.
 */
export function nightSafe(colour: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(colour)) return colour;
  const [r, g, b] = rgb(colour);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) hue = ((g - b) / d + 6) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  const green = Math.round(max * (0.08 + 0.5 * (hue / 360)));
  return `#${[max, green, 0].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const DARK_TO_NIGHT = new Map<string, string>(
  (Object.keys(MAP_COLOURS) as (keyof MapColours)[]).map((k) => [MAP_COLOURS[k], NIGHT_MAP_COLOURS[k]]),
);

/**
 * A colour as the given theme draws it. A map layer's own colour becomes that layer's night
 * colour; anything else goes through nightSafe. Used by the legend swatches and the canvas
 * alike, so a swatch is always the colour of what it labels.
 */
export function mapColourFor(colour: string, theme: MapTheme): string {
  if (theme !== "night") return colour;
  return DARK_TO_NIGHT.get(colour) ?? nightSafe(colour);
}
