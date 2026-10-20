// The Radio card: signal, power, radio health, the settled-once readouts, the source
// picker and a per-viewer Debug box. Reference material, so it goes below the decode
// list on a phone.

import Link from "next/link";
import { useState } from "react";

import { DetailRow } from "@/components/decodes/controls";
import type { RigStatus, SMeterReading, Telemetry } from "@/components/decodes/types";
import { SourcePicker } from "@/components/radio/SourcePicker";
import { Badge, Card } from "@/components/ui/primitives";
import { apiPost } from "@/lib/client/api";
import { linkLabel } from "@/lib/client/socket-retry";
import { formatFreqMHz } from "@/lib/ham/bands";
import { cn } from "@/lib/utils";

/** Labels on this card's meters. */
const METER_LABEL = "text-xs text-fg-muted";
/** Scale ticks under a meter: the one place type goes below 12px. */
const SCALE = "flex justify-between text-[10px] text-fg-subtle mt-0.5 tnum";

export interface LinkStats {
  msgAt: number;
  counts: Record<string, number>;
  parseErrors: number;
}

export function RadioCard({
  className,
  status,
  smeter,
  telemetry,
  now,
  compact,
  decodingAs,
  connected,
  attempts,
  linkStats,
  debug,
  onDebug,
}: {
  className?: string;
  status: RigStatus | null;
  smeter: SMeterReading | null;
  telemetry: Telemetry | null;
  now: number;
  compact: boolean;
  decodingAs: string;
  connected: boolean;
  attempts: number;
  linkStats: LinkStats;
  debug: boolean;
  onDebug: (on: boolean) => void;
}) {
  return (
    <Card title="Radio" className={className}>
      <SMeter reading={smeter} now={now} />
      <PowerSlider current={status?.rfPower ?? null} />
      <RadioHealth telemetry={telemetry} transmitting={status?.transmitting ?? false} />
      {status ? (
        <>
          {/* Folded below `lg`. `lg:contents` gives the <details> no box above the
              breakpoint, and `open={!compact}` is required too: a closed details hides its
              content inside the UA shadow tree, which `display: contents` cannot reach. */}
          <details className="lg:contents" open={!compact}>
            <summary className="lg:hidden cursor-pointer select-none text-xs text-fg-muted">
              Radio detail — dial, band, mode, grid
            </summary>
            <dl className="text-sm flex flex-col gap-1.5 mt-1.5 lg:mt-0">
              <DetailRow
                label="Radio"
                value={
                  status.radio
                    ? `${status.radio.model} · ${status.radio.host}`
                    : status.source === "wsjtx"
                      ? "external decoder"
                      : "not connected"
                }
              />
              <DetailRow
                label="Dial"
                value={status.dialFrequency ? `${formatFreqMHz(status.dialFrequency)} MHz` : "—"}
                tnum
              />
              <DetailRow label="Band" value={status.band ?? "—"} />
              <DetailRow label="Slice mode" value={status.mode ?? "—"} />
              <DetailRow label="Decoding as" value={decodingAs} />
              <DetailRow label="My call" value={status.deCall ?? "—"} />
              <DetailRow label="Grid" value={status.deGrid ?? "—"} />
              <DetailRow label="RX offset" value={status.rxDF !== null ? `${status.rxDF} Hz` : "—"} tnum />
              {status.link && (
                <DetailRow
                  label="Radio link"
                  value={status.link.oneWayMs > 0 ? `${status.link.rttMs} ms · corrected` : `${status.link.rttMs} ms`}
                  tnum
                />
              )}
            </dl>
          </details>
          {/* Outside the fold: these are why anyone looks at this card. Transmitting is the
              header's red TX badge and this card's TX power meter, so it is not repeated. */}
          <div className="flex gap-1.5 mt-2.5 flex-wrap">
            {status.connected ? <Badge tone="ok">Radio up</Badge> : <Badge tone="warn">No radio</Badge>}
            {/* Audio is UDP and keeps flowing when the command channel dies, so a dead
                channel cannot be inferred from decodes still arriving. */}
            {status.connected && !status.commandChannel && <Badge tone="warn">No rig control</Badge>}
          </div>
        </>
      ) : (
        <p className="text-sm text-fg-subtle">Waiting for the bridge…</p>
      )}

      <SourcePicker source={status?.source ?? null} />

      {/* The bridge's own connection diagnostics, and this browser's socket to the bridge,
          which is a different link that fails differently. Per viewer, off by default. */}
      <label className="mt-4 pt-3 border-t border-line flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer select-none">
        <input type="checkbox" checked={debug} onChange={(e) => onDebug(e.target.checked)} />
        Debug — connection diagnostics
      </label>

      {debug && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs font-mono tabular-nums text-fg-muted">
          <dt className="text-fg-subtle">source</dt>
          <dd>{status?.source ?? "—"}</dd>

          <dt className="text-fg-subtle">radio → bridge</dt>
          <dd>
            {status?.connected ? "connected" : "down"}
            {status?.connected && !status.commandChannel ? " · no CAT" : ""}
          </dd>

          {!status?.connected && (status?.connectionError || status?.connectAttempt) ? (
            <>
              <dt className="text-warn">last error</dt>
              <dd className="text-warn break-words">
                {status?.connectionError ?? "—"}
                {status?.connectAttempt ? ` (attempt ${status.connectAttempt})` : ""}
              </dd>
            </>
          ) : null}

          <dt className="text-fg-subtle">last heartbeat</dt>
          <dd>
            {status?.lastHeartbeat ? `${Math.max(0, Math.round((now - status.lastHeartbeat) / 1000))}s ago` : "—"}
          </dd>

          {status?.link ? (
            <>
              <dt className="text-fg-subtle">radio link</dt>
              <dd>
                {status.link.rttMs} ms
                {status.link.oneWayMs > 0 ? " · corrected" : ""}
              </dd>
            </>
          ) : null}

          <dt className="text-fg-subtle">browser → bridge</dt>
          <dd>{connected ? "open" : linkLabel(connected, attempts)}</dd>

          <dt className="text-fg-subtle">last message</dt>
          <dd>{linkStats.msgAt ? `${Math.max(0, Math.round((now - linkStats.msgAt) / 1000))}s ago` : "—"}</dd>

          <dt className="text-fg-subtle">frames</dt>
          <dd className="break-words">
            {Object.keys(linkStats.counts).length
              ? Object.entries(linkStats.counts)
                  .map(([k, n]) => `${k}:${n}`)
                  .join("  ")
              : "none yet"}
            {linkStats.parseErrors ? `  parseErr:${linkStats.parseErrors}` : ""}
          </dd>
        </dl>
      )}

      <p className="mt-4 pt-3 border-t border-line text-xs">
        <Link href="/settings?tab=modes&group=digital" className="text-accent-bright hover:underline">
          Decode source settings →
        </Link>
      </p>
    </Card>
  );
}

/**
 * Radio health from the meter stream. SWR only while transmitting and just after — it
 * reads nothing meaningful on receive. Past 3:1 or 75 °C, unattended transmission stops.
 */
function RadioHealth({ telemetry, transmitting }: { telemetry: Telemetry | null; transmitting: boolean }) {
  if (!telemetry) return null;
  const swrFresh = transmitting || Date.now() - telemetry.at < 3_000;
  const swr = swrFresh ? telemetry.swr : null;

  const items: { label: string; value: string; tone?: string }[] = [];
  if (telemetry.paTempC !== null) {
    items.push({
      label: "PA",
      value: `${telemetry.paTempC.toFixed(0)}°C`,
      tone: telemetry.paTempC > 75 ? "text-danger" : telemetry.paTempC > 60 ? "text-warn" : undefined,
    });
  }
  if (swr !== null && swr > 0) {
    items.push({
      label: "SWR",
      value: `${swr.toFixed(1)}:1`,
      tone: swr > 3 ? "text-danger" : swr > 2 ? "text-warn" : "text-ok",
    });
  }
  if (telemetry.voltsPa !== null) {
    items.push({
      label: "V",
      value: `${telemetry.voltsPa.toFixed(1)}`,
      tone: telemetry.voltsPa < 12 ? "text-warn" : undefined,
    });
  }
  if (telemetry.fanRpm !== null && telemetry.fanRpm > 0) {
    items.push({ label: "Fan", value: `${telemetry.fanRpm}` });
  }
  if (items.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-xs border-t border-line pt-2">
      {items.map((i) => (
        <span key={i.label} className="tnum">
          <span className="text-fg-subtle">{i.label} </span>
          <span className={i.tone ?? "text-fg"}>{i.value}</span>
        </span>
      ))}
    </div>
  );
}

/** RF power. Sent on release, not per drag step: each change is a radio command. */
function PowerSlider({ current }: { current: number | null }) {
  const [value, setValue] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = value ?? current ?? 0;

  async function commit(v: number) {
    setBusy(true);
    try {
      await apiPost("/api/bridge/control", { action: "power", percent: v });
    } finally {
      // Resync to what the radio reports either way: a refused change snapping back is the truth.
      setValue(null);
      setBusy(false);
    }
  }

  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between mb-1">
        <span className={METER_LABEL}>RF power</span>
        <span className="font-display text-sm leading-none tnum">
          {current === null && value === null ? "—" : `${shown}%`}
        </span>
      </div>
      <input
        type="range"
        min={1}
        max={100}
        step={1}
        value={shown}
        disabled={busy || current === null}
        onChange={(e) => setValue(Number(e.target.value))}
        onMouseUp={() => value !== null && void commit(value)}
        onTouchEnd={() => value !== null && void commit(value)}
        aria-label="RF power"
        className="w-full accent-accent"
      />
    </div>
  );
}

/**
 * S-meter from the slice level (dBm at the antenna): S9 is -73 dBm, 6 dB an S-unit, dB
 * over S9 above it. While transmitting, forward power takes the display.
 */
function SMeter({ reading, now }: { reading: SMeterReading | null; now: number }) {
  // Stale after a few seconds — the bridge stopped or the slice closed. Empty, not frozen.
  const live = reading !== null && now - reading.at < 5_000;
  const dbm = live ? reading.dbm : null;
  const fwd = live ? reading.fwdDbm : null;

  if (fwd !== null && fwd > 30) {
    const watts = Math.pow(10, (fwd - 30) / 10);
    const pct = Math.min(100, (watts / 100) * 100);
    return (
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1">
          <span className={METER_LABEL}>TX power</span>
          <span className="font-display text-lg leading-none tnum text-accent-bright">
            {watts >= 10 ? watts.toFixed(0) : watts.toFixed(1)} W
          </span>
        </div>
        <div className="h-2.5 bg-surface-2 rounded-[1px] overflow-hidden">
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <div className={SCALE}>
          <span>0</span>
          <span>25</span>
          <span>50</span>
          <span>75</span>
          <span>100 W</span>
        </div>
      </div>
    );
  }

  const sFloat = dbm === null ? 0 : Math.max(0, Math.min(9, (dbm + 127) / 6));
  const overDb = dbm === null ? 0 : Math.max(0, Math.round(dbm + 73));
  const label = dbm === null ? "—" : overDb > 0 ? `S9+${overDb}` : `S${Math.floor(sFloat)}`;

  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between mb-1">
        <span className={METER_LABEL}>Signal</span>
        <span className="font-display text-lg leading-none tnum">
          {label}
          {dbm !== null && <span className="text-xs text-fg-subtle ml-1.5">{dbm.toFixed(0)} dBm</span>}
        </span>
      </div>
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => (
          <div
            key={s}
            className={cn(
              "h-2.5 flex-1 rounded-[1px]",
              dbm !== null && sFloat >= s ? (s <= 6 ? "bg-ok/80" : "bg-warn/90") : "bg-surface-2",
            )}
          />
        ))}
        {/* +10/+20/+30 past S9, red like every meter's top end. */}
        {[10, 20, 30].map((step) => (
          <div
            key={`p${step}`}
            className={cn("h-2.5 flex-1 rounded-[1px]", overDb >= step ? "bg-accent" : "bg-surface-2")}
          />
        ))}
      </div>
      <div className={SCALE}>
        <span>S1</span>
        <span>S3</span>
        <span>S5</span>
        <span>S7</span>
        <span>S9</span>
        <span>+10</span>
        <span>+20</span>
        <span>+30</span>
      </div>
    </div>
  );
}
