// Colour maps for the spectrum views, as 256-entry lookup tables.
//
// The views keep history as dB and colour it at draw time, so every table here is applied
// to ALL of the history at once: switching map, or moving the floor and range, recolours
// minutes of waterfall instantly. That is why the tables live here as data rather than in
// the components, and why they are plain bytes a WebGL texture can take directly.
//
// Sources:
//   * DigiShack: the stops of PALETTE in components/digital/spectrum-canvas.tsx. Copied
//     rather than imported so lib/ does not depend on a component; check:spectrum-view
//     asserts the generated table is byte-identical to PALETTE, so they cannot drift.
//   * Viridis, inferno, magma: matplotlib's maps (van der Walt & Smith, CC0), sampled
//     every 16th entry of the published 256-entry tables (as d3-scale-chromatic ships
//     them) and interpolated linearly in sRGB. Each sampled entry is the published value;
//     the in-between error is under 2 levels per channel.
//   * Turbo: Google's published polynomial approximation (Mikhailov 2019, Apache-2.0),
//     with the coefficients d3-scale-chromatic uses.
//   * Grayscale: black to white.

export type ColormapId = "digishack" | "viridis" | "inferno" | "magma" | "turbo" | "grayscale";

export interface ColormapInfo {
  id: ColormapId;
  label: string;
}

export const COLORMAPS: readonly ColormapInfo[] = [
  { id: "digishack", label: "DigiShack" },
  { id: "viridis", label: "Viridis" },
  { id: "inferno", label: "Inferno" },
  { id: "magma", label: "Magma" },
  { id: "turbo", label: "Turbo" },
  { id: "grayscale", label: "Grayscale" },
];

export const DEFAULT_COLORMAP: ColormapId = "digishack";

export function isColormapId(value: unknown): value is ColormapId {
  return typeof value === "string" && COLORMAPS.some((c) => c.id === value);
}

/** [position 0..1, r, g, b] */
export type ColorStop = readonly [number, number, number, number];

/** Same stops as PALETTE in components/digital/spectrum-canvas.tsx. */
export const DIGISHACK_STOPS: readonly ColorStop[] = [
  [0.0, 0, 0, 6],
  [0.12, 0, 4, 40],
  [0.28, 0, 16, 110],
  [0.44, 0, 92, 178],
  [0.58, 0, 178, 170],
  [0.7, 40, 224, 72],
  [0.82, 214, 232, 40],
  [0.92, 255, 150, 24],
  [1.0, 255, 48, 40],
];

const at = (i: number): number => i / 255;

export const VIRIDIS_STOPS: readonly ColorStop[] = [
  [at(0), 68, 1, 84], // #440154
  [at(16), 72, 24, 106], // #48186a
  [at(32), 71, 45, 123], // #472d7b
  [at(48), 66, 64, 134], // #424086
  [at(64), 59, 82, 139], // #3b528b
  [at(80), 51, 99, 141], // #33638d
  [at(96), 44, 114, 142], // #2c728e
  [at(112), 38, 130, 142], // #26828e
  [at(128), 33, 145, 140], // #21918c
  [at(144), 31, 160, 136], // #1fa088
  [at(160), 40, 174, 128], // #28ae80
  [at(176), 63, 188, 115], // #3fbc73
  [at(192), 94, 201, 98], // #5ec962
  [at(208), 132, 212, 75], // #84d44b
  [at(224), 173, 220, 48], // #addc30
  [at(240), 216, 226, 25], // #d8e219
  [at(255), 253, 231, 37], // #fde725
];

export const INFERNO_STOPS: readonly ColorStop[] = [
  [at(0), 0, 0, 4], // #000004
  [at(16), 11, 7, 36], // #0b0724
  [at(32), 33, 12, 74], // #210c4a
  [at(48), 61, 9, 101], // #3d0965
  [at(64), 87, 16, 110], // #57106e
  [at(80), 113, 25, 110], // #71196e
  [at(96), 138, 34, 106], // #8a226a
  [at(112), 163, 44, 97], // #a32c61
  [at(128), 188, 55, 84], // #bc3754
  [at(144), 210, 70, 68], // #d24644
  [at(160), 228, 90, 49], // #e45a31
  [at(176), 241, 115, 29], // #f1731d
  [at(192), 249, 142, 9], // #f98e09
  [at(208), 252, 172, 17], // #fcac11
  [at(224), 249, 203, 53], // #f9cb35
  [at(240), 242, 234, 105], // #f2ea69
  [at(255), 252, 255, 164], // #fcffa4
];

export const MAGMA_STOPS: readonly ColorStop[] = [
  [at(0), 0, 0, 4], // #000004
  [at(16), 10, 8, 34], // #0a0822
  [at(32), 29, 17, 71], // #1d1147
  [at(48), 54, 16, 107], // #36106b
  [at(64), 81, 18, 124], // #51127c
  [at(80), 106, 28, 129], // #6a1c81
  [at(96), 131, 38, 129], // #832681
  [at(112), 156, 46, 127], // #9c2e7f
  [at(128), 183, 55, 121], // #b73779
  [at(144), 208, 65, 111], // #d0416f
  [at(160), 231, 82, 99], // #e75263
  [at(176), 245, 107, 92], // #f56b5c
  [at(192), 252, 137, 97], // #fc8961
  [at(208), 254, 167, 114], // #fea772
  [at(224), 254, 196, 136], // #fec488
  [at(240), 253, 226, 163], // #fde2a3
  [at(255), 252, 253, 191], // #fcfdbf
];

export const GRAYSCALE_STOPS: readonly ColorStop[] = [
  [0, 0, 0, 0],
  [1, 255, 255, 255],
];

/**
 * A 256 x RGB table from stops — the same walk and rounding PALETTE uses, so the DigiShack
 * map comes out byte-identical to the one the existing waterfalls draw.
 */
export function lutFromStops(stops: readonly ColorStop[]): Uint8Array {
  const table = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
    const [p0, r0, g0, b0] = stops[k]!;
    const [p1, r1, g1, b1] = stops[Math.min(k + 1, stops.length - 1)]!;
    const u = p1 === p0 ? 0 : Math.max(0, Math.min(1, (t - p0) / (p1 - p0)));
    table[i * 3] = Math.round(r0 + (r1 - r0) * u);
    table[i * 3 + 1] = Math.round(g0 + (g1 - g0) * u);
    table[i * 3 + 2] = Math.round(b0 + (b1 - b0) * u);
  }
  return table;
}

/** Google's Turbo approximation, 0..1 in, bytes out. */
export function turboRgb(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [
    ch(34.61 + x * (1172.33 - x * (10793.56 - x * (33300.12 - x * (38394.49 - x * 14825.05))))),
    ch(23.31 + x * (557.33 + x * (1225.33 - x * (3574.96 - x * (1073.77 + x * 707.56))))),
    ch(27.2 + x * (3211.1 - x * (15327.97 - x * (27814 - x * (22569.18 - x * 6838.66))))),
  ];
}

function turboLut(): Uint8Array {
  const table = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = turboRgb(i / 255);
    table[i * 3] = r;
    table[i * 3 + 1] = g;
    table[i * 3 + 2] = b;
  }
  return table;
}

const STOPS: Record<Exclude<ColormapId, "turbo">, readonly ColorStop[]> = {
  digishack: DIGISHACK_STOPS,
  viridis: VIRIDIS_STOPS,
  inferno: INFERNO_STOPS,
  magma: MAGMA_STOPS,
  grayscale: GRAYSCALE_STOPS,
};

const rgbCache = new Map<ColormapId, Uint8Array>();
const rgbaCache = new Map<ColormapId, Uint8Array>();

/** 256 x RGB. Cached: callers must not write to it. */
export function colormapRgb(id: ColormapId): Uint8Array {
  let lut = rgbCache.get(id);
  if (!lut) {
    lut = id === "turbo" ? turboLut() : lutFromStops(STOPS[id]);
    rgbCache.set(id, lut);
  }
  return lut;
}

/** 256 x RGBA, opaque, for a 256x1 texture. Cached: callers must not write to it. */
export function colormapRgba(id: ColormapId): Uint8Array {
  let lut = rgbaCache.get(id);
  if (!lut) {
    const rgb = colormapRgb(id);
    lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      lut[i * 4] = rgb[i * 3]!;
      lut[i * 4 + 1] = rgb[i * 3 + 1]!;
      lut[i * 4 + 2] = rgb[i * 3 + 2]!;
      lut[i * 4 + 3] = 255;
    }
    rgbaCache.set(id, lut);
  }
  return lut;
}

/**
 * The "no data" hatch: two dark greys drawn as diagonal stripes.
 *
 * A gap must not look like silence. Every map's bottom colour means "at or below the floor",
 * which is a measurement; a hatch is the absence of one — an outage, a dropped frame, or
 * history that has not been collected yet.
 */
export const GAP_RGB_A: readonly [number, number, number] = [20, 20, 26];
export const GAP_RGB_B: readonly [number, number, number] = [34, 34, 42];

/** The page background (--color-bg in styles/globals.css), for the 3D view's clear colour. */
export const BACKGROUND_RGB: readonly [number, number, number] = [10, 10, 11];

/** Cycle-boundary rule over the spectrogram: white at low alpha. */
export const CYCLE_LINE_RGBA: readonly [number, number, number, number] = [255, 255, 255, 0.2];

/** Relative luminance (WCAG) of a table entry, for the monotonicity checks. */
export function lutLuminance(lut: Uint8Array, index: number): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * lin(lut[index * 3]!) + 0.7152 * lin(lut[index * 3 + 1]!) + 0.0722 * lin(lut[index * 3 + 2]!)
  );
}
