// The band on a world map, GridTracker-style — live, self-contained, no tiles.
//
// Three populations on one map, each answering a different question:
//   * LIVE DECODES (websocket) — who is on the air right now, placed by the grid
//     square their message carried. CQs ring green: those are the clickable ones.
//   * CONTACTS (the log) — where this station has actually been heard back from,
//     coloured by band with the shared palette.
//   * HEARD BY (PSKReporter) — receivers that heard US in the last hour: the
//     transmit answer to the decode list's receive answer.
//
// The basemap is vendored Natural Earth coastlines (see lib/geo/land.ts) drawn in
// an equirectangular projection — one multiplication per coordinate, and grid
// squares are rectangles on it, which is the whole reason maidenhead exists.
//
// Live stations expire after 15 minutes and fade as they age, so the map shows the
// band as it is, not as it was an hour ago.
//
// EVERY LIVE MARKER ON THIS MAP ARRIVES OVER ONE WEBSOCKET from the radio service. When that
// socket is not connected the map is not quiet, it is blind — and the two look identical.
// See the Calling CQ card at the bottom for the sentence that used to conflate them.

import Link from "next/link";
import type { GetServerSidePropsContext } from "next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Card, PageHeader, Select } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { bridgeWsUrl } from "@/lib/bridge/ws-url";
import { useApi } from "@/lib/client/api";
import { LAND_RINGS } from "@/lib/geo/land";
import { dragDelta, panView, zoomView, type ViewBounds } from "@/lib/geo/viewport";
import { colourFor } from "@/lib/ham/band-colours";
import { gridFromMessage } from "@/lib/ham/grid-message";
import { cn } from "@/lib/utils";

import { useVisibleInterval } from "@/lib/client/use-visible-interval";
interface Props extends Record<string, unknown> {
  wsUrl: string;
}

/** A station heard on the air, placed on the map. */
interface LiveStation {
  callsign: string;
  grid: string;
  lat: number;
  lon: number;
  snr: number;
  at: number;
  isCq: boolean;
  message: string;
}

interface QsoPoint {
  lat: number;
  lon: number;
  band: string;
  mode: string;
  callsign: string;
  km: number;
}

interface PskReceiver {
  receiverCall: string;
  receiverGrid: string | null;
  bestSnr: number | null;
  km: number | null;
}

/** How long a heard station stays on the map. FT8 memory, not history. */
const LIVE_TTL_MS = 15 * 60_000;

// ------------------------------------------------------------------ projection
//
// Plate carrée: x is longitude, y is latitude, both linear. Distances lie toward
// the poles, but nobody measures distance off this map — the polar Coverage plot
// answers that — and it makes every maidenhead square an axis-aligned rectangle.

const W = 1440;
const H = 720;
/** The projected extent, handed to the viewport maths so it owns no constants of its own. */
const BOUNDS: ViewBounds = { width: W, height: H };

function project(lat: number, lon: number): { x: number; y: number } {
  return { x: ((lon + 180) / 360) * W, y: ((90 - lat) / 180) * H };
}

/** Centre of a 4-character grid square. */
function gridCentre(grid: string): { lat: number; lon: number } | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}\d{2}$/.test(g)) return null;
  // RR73 is a real square in the Arctic Ocean that nobody calls from — which is why
  // the protocol uses it as an acknowledgement. gridFromMessage refuses it upstream,
  // but this refuses too: whatever future caller arrives here, an RR73 must never
  // become a dot on the map.
  if (g === "RR73") return null;
  const lon = (g.charCodeAt(0) - 65) * 20 - 180 + Number(g[2]) * 2 + 1;
  const lat = (g.charCodeAt(1) - 65) * 10 - 90 + Number(g[3]) * 1 + 0.5;
  return { lat, lon };
}

/** The vendored coastlines as one SVG path, computed once per module load. */
const LAND_PATH = LAND_RINGS.map((ring) =>
  ring
    .map(([lon, lat], i) => {
      const p = project(lat, lon);
      return `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join("") + "Z",
).join("");

/**
 * South-west corner of a 4-character square, for shading it as a rectangle.
 *
 * A square is 2° of longitude by 1° of latitude — the whole reason this map is
 * equirectangular is that these come out as axis-aligned rectangles, every one the
 * same 8×4 units at world scale.
 */
function squareSW(grid: string): { lat: number; lon: number } | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}\d{2}$/.test(g)) return null;
  return {
    lon: (g.charCodeAt(0) - 65) * 20 - 180 + Number(g[2]) * 2,
    lat: (g.charCodeAt(1) - 65) * 10 - 90 + Number(g[3]) * 1,
  };
}

const SQUARE_W = (2 / 360) * W;
const SQUARE_H = (1 / 180) * H;

/** Field lines and labels (AA…RR), also constant. */
const FIELDS = (() => {
  const labels: { x: number; y: number; text: string }[] = [];
  for (let fx = 0; fx < 18; fx++) {
    for (let fy = 0; fy < 18; fy++) {
      const lon = fx * 20 - 180 + 10;
      const lat = fy * 10 - 90 + 5;
      const p = project(lat, lon);
      labels.push({
        x: p.x,
        y: p.y,
        text: String.fromCharCode(65 + fx) + String.fromCharCode(65 + fy),
      });
    }
  }
  return labels;
})();

export default function GridMapPage({ wsUrl }: Props) {
  const [live, setLive] = useState<Map<string, LiveStation>>(new Map());
  const [connected, setConnected] = useState(false);
  const [band, setBand] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);

  const [showLive, setShowLive] = useState(true);
  const [showGrids, setShowGrids] = useState(true);
  const [showContacts, setShowContacts] = useState(false);
  const [showHeardBy, setShowHeardBy] = useState(false);
  const [contactDays, setContactDays] = useState("30");

  // View window in projected coordinates, for wheel-zoom and drag-pan.
  const [view, setView] = useState({ x: 0, y: 0, w: W, h: H });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);

  const { data: contacts } = useApi<{ points: QsoPoint[] }>(
    showContacts ? `/api/qso-map?days=${contactDays}` : null,
  );
  // The whole log, slim: only the per-grid aggregate comes back. Worked-ness is a
  // career fact, so no period filter — a square worked once in 2022 stays shaded.
  const { data: workedGrids } = useApi<{ byGrid: { grid: string; count: number }[] }>(
    showGrids ? "/api/qso-map?days=0&slim=1" : null,
  );
  const { data: heardBy } = useApi<{ receivers: PskReceiver[] }>(
    showHeardBy ? "/api/psk-spots?minutes=60&limit=200" : null,
  );

  // Ages drive the fade; once a second is plenty for a 15-minute decay.
  // Stopped while hidden: the fade is a rendering concern and nothing is being rendered.
  useVisibleInterval(() => setNow(Date.now()), 1_000);

  // The same reconnecting-socket shape as the decodes page, for the same reasons —
  // including the socket held OUTSIDE connect() so cleanup can actually close it.
  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1_000;
    let socket: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        retry = setTimeout(connect, backoff);
        return;
      }
      socket = ws;
      ws.onopen = () => {
        setConnected(true);
        backoff = 1_000;
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.kind === "status" && msg.status?.band !== undefined) {
            setBand(msg.status.band);
          }
          const decodes =
            msg.kind === "decode"
              ? [msg]
              : msg.kind === "backlog" && Array.isArray(msg.decodes)
                ? msg.decodes
                : [];
          if (decodes.length === 0) return;
          setLive((prev) => {
            const next = new Map(prev);
            for (const d of decodes) {
              if (!d.callsign) continue;
              const grid = gridFromMessage(d.message ?? "");
              const at = Date.parse(d.timestamp) || Date.now();
              const existing = next.get(d.callsign);
              // A station whose new message has no grid keeps its old position —
              // a report doesn't mean they moved, it means FT8 messages are short.
              const centre = grid ? gridCentre(grid) : null;
              if (!centre && !existing) continue;
              next.set(d.callsign, {
                callsign: d.callsign,
                grid: grid ?? existing!.grid,
                lat: centre?.lat ?? existing!.lat,
                lon: centre?.lon ?? existing!.lon,
                snr: d.snr,
                at,
                isCq: /^CQ\b/i.test(d.message ?? ""),
                message: d.message ?? "",
              });
            }
            return next;
          });
        } catch {
          /* not JSON — not ours */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15_000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [wsUrl]);

  // Expire quietly rather than on render: a Map rebuilt every second is churn the
  // page feels; once a minute keeps it bounded.
  // Left running deliberately, unlike the others on this page. This one BOUNDS MEMORY
  // rather than driving a display: a hidden tab still receives decodes over the socket, so
  // suspending the expiry would let the Map grow for as long as the page is in the
  // background. Once a minute against a Map of a few hundred entries is not a battery
  // concern; an unbounded Map is a correctness one.
  useEffect(() => {
    const id = setInterval(() => {
      setLive((prev) => {
        const cutoff = Date.now() - LIVE_TTL_MS;
        if (![...prev.values()].some((s) => s.at < cutoff)) return prev;
        return new Map([...prev].filter(([, s]) => s.at >= cutoff));
      });
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // ---------------------------------------------------------------- interaction

  /** Pointer position in projected coordinates, from a mouse event. */
  const toMap = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: view.x + ((e.clientX - rect.left) / rect.width) * view.w,
        y: view.y + ((e.clientY - rect.top) / rect.height) * view.h,
      };
    },
    [view],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      const at = toMap(e);
      // `at` is a local const, so this updater was already safe — unlike the pan one it
      // sits beside. Routed through the same module anyway so both share one clamp and one
      // set of assertions, rather than two copies that can drift apart.
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      setView((v) => zoomView(v, at, factor, BOUNDS));
    },
    [toMap],
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    // READ THE REF ONCE, INTO A LOCAL, and never inside the updater below.
    //
    // This crashed /gridmap to a blank screen: the old code guarded `if (!drag.current)`
    // and then read `drag.current!.vx` from inside the `setView` updater. React runs the
    // updater when it processes the update, not when this handler returns — and by then
    // `onPointerUp` has set the ref to null. "Cannot read properties of null (reading
    // 'vx')". The guard was real, it just protected the wrong instant.
    //
    // `anchor` is a value. The updater closes over the value, so releasing the pointer
    // mid-update can no longer pull the anchor out from under it.
    const anchor = drag.current;
    if (!anchor) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const { dx, dy } = dragDelta(anchor, e.clientX, e.clientY, rect, view);
    setView((v) => panView(anchor, v, dx, dy, BOUNDS));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  // POINTER CANCEL, which was missing and is not the same event as up.
  //
  // A touch interrupted by a browser gesture, a pen leaving range, or the window losing
  // the capture fires `pointercancel` or `lostpointercapture` and NEVER `pointerup`. The
  // anchor then stayed set, so the map kept panning against a finger that was no longer
  // there until the next press.
  const onPointerCancel = onPointerUp;

  // ------------------------------------------------------------------- derived

  const liveList = useMemo(() => {
    const cutoff = now - LIVE_TTL_MS;
    return [...live.values()].filter((s) => s.at >= cutoff).sort((a, b) => b.at - a.at);
  }, [live, now]);

  const cqs = useMemo(() => liveList.filter((s) => s.isCq), [liveList]);
  const zoom = W / view.w;
  const sel = selected ? (live.get(selected) ?? null) : null;

  return (
    <>
      <PageHeader
        title="Grid map"
        subtitle={`The band on the world — live decodes placed by their grid square${band ? ` · ${band}` : ""}`}
      />

      <div className="flex flex-wrap items-center gap-4 mb-3 text-sm">
        <Toggle on={showLive} onClick={() => setShowLive(!showLive)} swatch="#4ad27a">
          Live decodes ({liveList.length})
        </Toggle>
        <Toggle on={showGrids} onClick={() => setShowGrids(!showGrids)} swatch="#4ab4e8">
          Worked squares{workedGrids ? ` (${workedGrids.byGrid.length})` : ""}
        </Toggle>
        <Toggle on={showContacts} onClick={() => setShowContacts(!showContacts)} swatch="#4ab4e8">
          Contacts
        </Toggle>
        {showContacts && (
          <Select
            value={contactDays}
            onChange={(e) => setContactDays(e.target.value)}
            className="w-36"
          >
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="365">Last year</option>
          </Select>
        )}
        <Toggle on={showHeardBy} onClick={() => setShowHeardBy(!showHeardBy)} swatch="#e87ab4">
          Heard by (PSKReporter)
        </Toggle>
        <span className="ml-auto text-xs text-fg-subtle">
          {connected ? "live" : "reconnecting…"} · scroll to zoom, drag to pan
          {zoom > 1.01 && (
            <button
              type="button"
              className="ml-2 text-accent-bright hover:underline"
              onClick={() => setView({ x: 0, y: 0, w: W, h: H })}
            >
              reset view
            </button>
          )}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="border border-line rounded-md overflow-hidden bg-surface">
          <svg
            ref={svgRef}
            viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
            className="w-full block select-none touch-none cursor-grab active:cursor-grabbing"
            style={{ aspectRatio: `${W} / ${H}`, background: "#0b1020" }}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onLostPointerCapture={onPointerCancel}
            role="img"
            aria-label="World map of live decodes, contacts and reception reports"
          >
            {/* Land. One path, precomputed. */}
            <path d={LAND_PATH} fill="#1c2740" stroke="#31405f" strokeWidth={1 / zoom} />

            {/* Where this station has been: every 4-character square ever worked,
                shaded — denser with more contacts, on a log scale so one contact is
                visible and four hundred is not a white block. Under everything live,
                because it is history and the markers are now. */}
            {showGrids &&
              workedGrids?.byGrid.map(({ grid, count }) => {
                const sw = squareSW(grid);
                if (!sw) return null;
                const p = project(sw.lat + 1, sw.lon); // NW corner: y comes from the top
                return (
                  <rect
                    key={grid}
                    x={p.x}
                    y={p.y}
                    width={SQUARE_W}
                    height={SQUARE_H}
                    fill="#4ab4e8"
                    opacity={Math.min(0.5, 0.14 + Math.log10(count) * 0.14)}
                  >
                    <title>{`${grid} · worked ${count} time${count === 1 ? "" : "s"}`}</title>
                  </rect>
                );
              })}

            {/* Maidenhead fields: 20°×10° rectangles with their letters. */}
            {Array.from({ length: 17 }, (_, i) => (
              <line
                key={`vx${i}`}
                x1={((i + 1) * W) / 18}
                y1={0}
                x2={((i + 1) * W) / 18}
                y2={H}
                stroke="#2a3450"
                strokeWidth={0.75 / zoom}
              />
            ))}
            {Array.from({ length: 17 }, (_, i) => (
              <line
                key={`hz${i}`}
                x1={0}
                y1={((i + 1) * H) / 18}
                x2={W}
                y2={((i + 1) * H) / 18}
                stroke="#2a3450"
                strokeWidth={0.75 / zoom}
              />
            ))}
            {/* The finer mesh: 2°×1° square lines, drawn only inside the current
                view — the full world is 16,200 squares and nobody is looking at
                more than a few hundred of them at a zoom where they mean anything. */}
            {zoom >= 5 && (
              <g stroke="#2a3450" strokeWidth={0.4 / zoom} opacity={0.8}>
                {Array.from(
                  { length: Math.ceil(view.w / SQUARE_W) + 1 },
                  (_, i) => Math.floor(view.x / SQUARE_W + i) * SQUARE_W,
                ).map((x) => (
                  <line key={`sv${x}`} x1={x} y1={view.y} x2={x} y2={view.y + view.h} />
                ))}
                {Array.from(
                  { length: Math.ceil(view.h / SQUARE_H) + 1 },
                  (_, i) => Math.floor(view.y / SQUARE_H + i) * SQUARE_H,
                ).map((y) => (
                  <line key={`sh${y}`} x1={view.x} y1={y} x2={view.x + view.w} y2={y} />
                ))}
              </g>
            )}

            {zoom >= 1.8 &&
              FIELDS.map((f) => (
                <text
                  key={f.text}
                  x={f.x}
                  y={f.y}
                  textAnchor="middle"
                  fontSize={14 / zoom}
                  fill="#3d4a6b"
                  className="font-display"
                >
                  {f.text}
                </text>
              ))}

            {/* Logged contacts, under the live traffic. */}
            {showContacts &&
              contacts?.points.map((p, i) => {
                const pt = project(p.lat, p.lon);
                return (
                  <circle
                    key={`c${i}`}
                    cx={pt.x}
                    cy={pt.y}
                    r={2.5 / zoom}
                    fill={colourFor(p.band)}
                    opacity={0.55}
                  >
                    <title>{`${p.callsign} · ${p.band} ${p.mode} · ${p.km.toLocaleString()} km (logged)`}</title>
                  </circle>
                );
              })}

            {/* Who heard us. Hollow, so they read as ears rather than voices. */}
            {showHeardBy &&
              heardBy?.receivers.map((r) => {
                const centre = r.receiverGrid ? gridCentre(r.receiverGrid.slice(0, 4)) : null;
                if (!centre) return null;
                const pt = project(centre.lat, centre.lon);
                return (
                  <circle
                    key={`h${r.receiverCall}`}
                    cx={pt.x}
                    cy={pt.y}
                    r={4 / zoom}
                    fill="none"
                    stroke="#e87ab4"
                    strokeWidth={1.5 / zoom}
                    opacity={0.9}
                  >
                    <title>{`${r.receiverCall} heard us${r.bestSnr !== null ? ` at ${r.bestSnr} dB` : ""}${r.km ? ` · ${r.km.toLocaleString()} km` : ""}`}</title>
                  </circle>
                );
              })}

            {/* The living band. CQs ring green and sit on top. */}
            {showLive &&
              liveList
                .slice()
                .reverse()
                .map((s) => {
                  const pt = project(s.lat, s.lon);
                  const age = (now - s.at) / LIVE_TTL_MS;
                  const opacity = Math.max(0.25, 1 - age);
                  const isSel = s.callsign === selected;
                  return (
                    <g
                      key={s.callsign}
                      opacity={opacity}
                      onClick={() => setSelected(isSel ? null : s.callsign)}
                      className="cursor-pointer"
                    >
                      <circle
                        cx={pt.x}
                        cy={pt.y}
                        r={(s.isCq ? 5 : 3.5) / zoom}
                        fill={s.isCq ? "#4ad27a" : "#c8cede"}
                        stroke={isSel ? "#ffffff" : s.isCq ? "#8af0b0" : "none"}
                        strokeWidth={(isSel ? 2 : 1) / zoom}
                      />
                      {(zoom >= 2.5 || isSel) && (
                        <text
                          x={pt.x}
                          y={pt.y - 7 / zoom}
                          textAnchor="middle"
                          fontSize={12 / zoom}
                          fill="#e6e9f2"
                          className="font-display"
                          paintOrder="stroke"
                          stroke="#0b1020"
                          strokeWidth={3 / zoom}
                        >
                          {s.callsign}
                        </text>
                      )}
                      <title>{`${s.callsign} · ${s.grid} · ${s.snr > 0 ? "+" : ""}${s.snr} dB · ${s.message}`}</title>
                    </g>
                  );
                })}
          </svg>
        </div>

        <div className="flex flex-col gap-4 min-w-0">
          {sel && (
            <Card title={sel.callsign}>
              <dl className="text-sm flex flex-col gap-1.5">
                <MapRow label="Grid" value={sel.grid} />
                <MapRow label="Signal" value={`${sel.snr > 0 ? "+" : ""}${sel.snr} dB`} />
                <MapRow label="Heard" value={`${Math.round((now - sel.at) / 1000)}s ago`} />
                <MapRow label="Message" value={sel.message} />
              </dl>
              {sel.isCq && (
                <p className="mt-3 pt-3 border-t border-line text-sm">
                  <Link href="/decodes" className="text-accent-bright hover:underline">
                    Calling CQ — work them from the Digital page →
                  </Link>
                </p>
              )}
            </Card>
          )}

          <Card title={`Calling CQ (${cqs.length})`}>
            {cqs.length === 0 ? (
              // AN EMPTY LIST HAS THREE CAUSES AND ONLY ONE OF THEM IS THE BAND.
              //
              // "Nobody in the last 15 minutes. CQs appear here the moment they decode." was
              // said in all three, and it is a claim about the air — the one an operator acts
              // on, by going to look at an antenna. It is true only when decodes are actually
              // arriving and none of them is a CQ.
              //
              // Ordered by what to fix first, the same rule as `collectorState` in
              // pages/api/psk-spots.ts: a closed socket outranks a silent one, because a
              // silent socket cannot be diagnosed until there is a socket.
              !connected ? (
                <p className="text-sm text-warn">
                  Not connected to the radio service, so nothing is arriving — this list stays
                  empty however busy the band is, and so does the map. It fills in on its own
                  when the connection comes back.
                </p>
              ) : liveList.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  Connected, and nothing at all has decoded in the last 15 minutes — not just
                  no CQs. That is as likely to be a receiver that is not decoding as a quiet
                  band; the{" "}
                  <Link href="/decodes" className="text-accent-bright hover:underline">
                    Digital page
                  </Link>{" "}
                  says which.
                </p>
              ) : (
                <p className="text-sm text-fg-subtle">
                  Nobody calling CQ in the last 15 minutes — but {liveList.length} station
                  {liveList.length === 1 ? " has" : "s have"} decoded in that time, so this
                  one is a fact about the band and not about the receiver.
                </p>
              )
            ) : (
              <ul className="flex flex-col divide-y divide-line -mx-4 max-h-[24rem] overflow-auto">
                {cqs.map((s) => (
                  <li key={s.callsign}>
                    <button
                      type="button"
                      onClick={() => setSelected(s.callsign === selected ? null : s.callsign)}
                      className={cn(
                        "w-full flex items-center gap-2 px-4 py-1 text-sm text-left hover:bg-surface-2",
                        s.callsign === selected && "bg-surface-2",
                      )}
                    >
                      <span className="font-display tracking-wide">{s.callsign}</span>
                      <span className="text-xs text-fg-subtle">{s.grid}</span>
                      <span className="tnum ml-auto text-fg-muted">
                        {s.snr > 0 ? `+${s.snr}` : s.snr} dB
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Toggle({
  on,
  onClick,
  swatch,
  children,
}: {
  on: boolean;
  onClick: () => void;
  swatch: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 rounded-sm border transition-colors",
        on
          ? "border-line-strong text-fg"
          : "border-line text-fg-subtle hover:text-fg-muted",
      )}
    >
      <span
        className="inline-block w-2.5 h-2.5 rounded-full"
        style={{ background: on ? swatch : "transparent", border: `1px solid ${swatch}` }}
      />
      {children}
    </button>
  );
}

function MapRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="text-fg-subtle shrink-0">{label}</dt>
      <dd className="ml-auto text-right break-all">{value}</dd>
    </div>
  );
}

export const getServerSideProps = withPageAuth<Props>({
  inner: async (ctx: GetServerSidePropsContext) => {
    const { wsUrl } = await bridgeWsUrl(ctx.req.headers);
    return { props: { wsUrl } };
  },
});
