import Link from "next/link";
import { useMemo, useState } from "react";

import {
  Badge,
  Card,
  ErrorBanner,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { useApi } from "@/lib/client/api";
import { BAND_NAMES } from "@/lib/ham/bands";
import { LOGGABLE_MODES } from "@/lib/ham/modes";
import type { ListResponse, Station } from "@/lib/types";

interface AwardSlice {
  worked: number;
  confirmed: number;
}

interface AwardProgress {
  id: string;
  label: string;
  unit: string;
  total: number | null;
  worked: number;
  confirmed: number;
  /** Codes still needed, with names where the dimension has them. */
  missing: { code: string; name?: string }[] | null;
  totalUnreliable: boolean;
  entries: { code: string; label?: string; confirmed: boolean; count: number }[];
  byBand: Record<string, AwardSlice>;
  byMode: Record<string, AwardSlice>;
}

interface AwardsResult {
  qsoCount: number;
  confirmedQsoCount: number;
  dxccTotal: number | null;
  awards: AwardProgress[];
  generatedAt: string;
}

export default function AwardsPage() {
  const [stationId, setStationId] = useState("");
  const [band, setBand] = useState("");
  const [mode, setMode] = useState("");

  const path = useMemo(() => {
    const p = new URLSearchParams();
    if (stationId) p.set("stationId", stationId);
    if (band) p.set("band", band);
    if (mode) p.set("mode", mode);
    const qs = p.toString();
    return `/api/awards${qs ? `?${qs}` : ""}`;
  }, [stationId, band, mode]);

  const { data, error, loading } = useApi<AwardsResult>(path);
  const { data: stationsData } = useApi<ListResponse<Station>>("/api/stations");

  return (
    <>
      <PageHeader
        title="Awards"
        subtitle={
          data
            ? `${data.qsoCount.toLocaleString()} QSOs · ${data.confirmedQsoCount.toLocaleString()} confirmed by card, LoTW or eQSL`
            : undefined
        }
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}

      <Card className="mb-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            value={stationId}
            onChange={(e) => setStationId(e.target.value)}
            aria-label="Show awards for which station"
          >
            <option value="">All stations</option>
            {(stationsData?.rows ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.callsign}
              </option>
            ))}
          </Select>
          <Select
            value={band}
            onChange={(e) => setBand(e.target.value)}
            aria-label="Show award progress for which band"
          >
            <option value="">All bands</option>
            {BAND_NAMES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
          <Select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">All modes</option>
            {LOGGABLE_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {loading && !data && <p className="text-sm text-fg-subtle">Loading…</p>}

      {data && data.dxccTotal === null && (
        <div className="mb-6">
          <ErrorBanner>
            No DXCC reference data loaded, so DXCC progress has no denominator.{" "}
            <Link href="/dxcc" className="underline">
              Load cty.xml
            </Link>
            .
          </ErrorBanner>
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-6">
          {data.awards.map((award) => (
            <AwardCard key={award.id} award={award} />
          ))}
        </div>
      )}
    </>
  );
}

function AwardCard({ award }: { award: AwardProgress }) {
  const [tab, setTab] = useState<"worked" | "missing" | "bands">("worked");

  // Clamped: with stale or partial reference data the numerator can exceed the
  // denominator, and a bar wider than its track just looks broken.
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const pctWorked =
    award.total && award.total > 0
      ? clamp((award.worked / award.total) * 100)
      : null;
  const pctConfirmed =
    award.total && award.total > 0
      ? clamp((award.confirmed / award.total) * 100)
      : null;

  const bands = Object.entries(award.byBand).sort(
    (a, b) => b[1].worked - a[1].worked,
  );

  return (
    <Card
      title={
        <div className="flex items-baseline gap-2">
          <h2 className="font-display text-lg uppercase tracking-wide">
            {award.label}
          </h2>
          <span className="text-xs text-fg-subtle">{award.unit}</span>
        </div>
      }
      actions={
        <div className="flex items-center gap-2 text-sm">
          <span className="tnum">
            <span className="text-fg">{award.worked}</span>
            {award.total !== null && !award.totalUnreliable && (
              <span className="text-fg-subtle"> / {award.total}</span>
            )}
          </span>
          <Badge tone="ok">{award.confirmed} confirmed</Badge>
          {award.totalUnreliable && <Badge tone="warn">stale reference</Badge>}
        </div>
      }
    >
      {/* Two-tone bar: confirmed fills solid, worked-but-unconfirmed is muted, so
          the gap between "worked" and "credited" is visible at a glance. */}
      {award.totalUnreliable && (
        <p className="text-xs text-warn mb-3">
          {award.worked} worked exceeds the {award.total} in the reference data, so
          the target set is incomplete or out of date. Reload cty.xml on the{" "}
          <Link href="/dxcc" className="underline">
            DXCC page
          </Link>{" "}
          — the count above is still correct, only the denominator is not.
        </p>
      )}

      {pctWorked !== null ? (
        <div className="mb-3">
          <div className="h-4 bg-surface-2 rounded-sm overflow-hidden flex">
            <div
              className="h-full bg-ok"
              style={{ width: `${pctConfirmed ?? 0}%` }}
              title={`${award.confirmed} confirmed`}
            />
            <div
              className="h-full bg-accent/50"
              style={{ width: `${(pctWorked ?? 0) - (pctConfirmed ?? 0)}%` }}
              title={`${award.worked - award.confirmed} worked, unconfirmed`}
            />
          </div>
          <div className="flex justify-between text-xs text-fg-subtle mt-1 tnum">
            <span>{(pctConfirmed ?? 0).toFixed(1)}% confirmed</span>
            <span>{(pctWorked ?? 0).toFixed(1)}% worked</span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-fg-muted mb-3">
          {award.worked.toLocaleString()} {award.unit} worked,{" "}
          {award.confirmed.toLocaleString()} confirmed. No fixed target for this
          award, so there is no percentage to show.
        </p>
      )}

      <div className="flex gap-0.5 mb-3 border-b border-line">
        {(
          [
            ["worked", `Worked (${award.worked})`],
            ...(award.missing
              ? ([["missing", `Missing (${award.missing.length})`]] as const)
              : []),
            ["bands", `By band (${bands.length})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id as typeof tab)}
            className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${
              tab === id
                ? "text-fg border-accent"
                : "text-fg-muted border-transparent hover:text-fg"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "worked" &&
        (award.entries.length === 0 ? (
          <p className="text-sm text-fg-subtle">
            Nothing worked yet — QSOs need the underlying field populated.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {award.entries.map((e) => (
              <span
                key={e.code}
                title={`${e.label ?? e.code} — ${e.count} QSO${e.count === 1 ? "" : "s"}${e.confirmed ? ", confirmed" : ", not confirmed"}`}
                className={`inline-flex items-center gap-1 border px-1.5 py-0.5 rounded-sm text-xs ${
                  e.confirmed
                    ? "bg-ok/12 text-ok border-ok/35"
                    : "bg-surface-3 text-fg-muted border-line-strong"
                }`}
              >
                <span className="tnum">{e.code}</span>
                {e.label && (
                  <span className="opacity-70 max-w-40 truncate">{e.label}</span>
                )}
              </span>
            ))}
          </div>
        ))}

      {tab === "missing" && award.missing && (
        <div className="flex flex-wrap gap-1.5">
          {award.missing.length === 0 ? (
            <p className="text-sm text-ok">Complete — nothing missing.</p>
          ) : (
            award.missing.map((m) => (
              <span
                key={m.code}
                className="inline-flex items-center gap-1 border border-line-strong px-1.5 py-0.5 rounded-sm text-xs text-fg-subtle"
                title={m.name ? `${m.name} (${m.code})` : m.code}
              >
                <span className="tnum">{m.code}</span>
                {m.name && <span className="max-w-40 truncate">{m.name}</span>}
              </span>
            ))
          )}
        </div>
      )}

      {tab === "bands" &&
        (bands.length === 0 ? (
          <p className="text-sm text-fg-subtle">No data.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {bands.map(([b, slice]) => (
              <li key={b} className="flex items-center gap-3 text-sm">
                <span className="w-16 text-fg-muted shrink-0">{b}</span>
                <div className="flex-1 h-3 bg-surface-2 rounded-sm overflow-hidden flex">
                  <div
                    className="h-full bg-ok"
                    style={{
                      width: `${(slice.confirmed / Math.max(1, award.worked)) * 100}%`,
                    }}
                  />
                  <div
                    className="h-full bg-accent/50"
                    style={{
                      width: `${((slice.worked - slice.confirmed) / Math.max(1, award.worked)) * 100}%`,
                    }}
                  />
                </div>
                <span className="tnum w-20 text-right text-fg-muted">
                  {slice.worked} / {slice.confirmed}
                </span>
              </li>
            ))}
          </ul>
        ))}
    </Card>
  );
}

export const getServerSideProps = withPageAuth();
