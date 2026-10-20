// Colours for the map canvases.
//
// A canvas cannot take a Tailwind class, so the design tokens it needs are mirrored here from
// the @theme block in styles/globals.css; scripts/check-gridmap.ts reads that file and fails
// if any of these drift from it. Every map colour is a token or a mix of two.

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
export const MAP_COLOURS = {
  // A whisper of `info` in the sea so land and water read apart in a monochrome UI.
  ocean: mix(TOKENS.bg, TOKENS.info, 0.07),
  land: TOKENS.surface2,
  coast: TOKENS.line,
  gridLine: alpha(TOKENS.line, 0.75),
  squareLine: alpha(TOKENS.line, 0.45),
  label: alpha(TOKENS.fgSubtle, 0.45),
  halo: TOKENS.bg,
  worked: TOKENS.info,
  live: TOKENS.fgMuted,
  cq: TOKENS.ok,
  cqRing: mix(TOKENS.ok, TOKENS.fg, 0.45),
  // Where our own transmission landed — the transmit colour.
  heard: TOKENS.accentBright,
  home: TOKENS.fg,
  path: TOKENS.fg,
  selected: TOKENS.fg,
  day: TOKENS.fg,
  night: TOKENS.bg,
  terminator: TOKENS.warn,
} as const;
