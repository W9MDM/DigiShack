// The world's coastlines, vendored.
//
// `land-rings.json` is the outer rings of Natural Earth's 110m land polygons
// (naturalearthdata.com, public domain), quantized to 0.1° — under half a pixel at
// the scale any browser draws a whole world, and 61 kB on disk. Vendored rather than
// fetched because this application's rule is no cloud dependencies: a map that needs
// a tile server is a map that stops working when the shack loses its uplink, which
// is precisely when an operator stares hardest at their own station.
//
// Regenerate (rarely — coastlines move slowly) by re-running the quantizer against a
// fresh ne_110m_land.geojson; the 1.58.0 CHANGELOG entry records the recipe.

import rings from "@/lib/geo/land-rings.json";

/** [lon, lat] pairs per ring, outer rings only. */
export const LAND_RINGS = rings as [number, number][][];
