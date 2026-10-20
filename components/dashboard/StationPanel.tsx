import { Badge, Card } from "@/components/ui/primitives";
import { useApi } from "@/lib/client/api";
import { useVisibleInterval } from "@/lib/client/use-visible-interval";
import { formatFreqDial } from "@/lib/ham/bands";
import type { AutoMode } from "@/lib/radio/auto-mode";
import { cn } from "@/lib/utils";

// What the station is doing, for the landing page.
//
// Read-only on purpose. Transmit is armed from the header, and a second set of radio
// controls on the dashboard would be a second place for the station to be left keyed.
//
// Polled, not socketed: the decode socket carries every decode and spectrum frame, which
// is a lot to open for one line of status. The bridge answers /status from memory and the
// proxy is local, so a 10 s poll is cheap — and it stops while the tab is hidden.

/** The slice of the bridge's /status this panel reads. The full shape is in services/radio/index.ts. */
interface BridgeSnapshot {
  running: boolean;
  reason?: string;
  status: {
    connected: boolean;
    commandChannel?: boolean;
    dialFrequency: number | null;
    band: string | null;
    mode: string | null;
    subMode: string | null;
    source?: "flex" | "icom" | "wsjtx";
    radio?: { vendor: string; model: string; host: string } | null;
    connectionError?: string | null;
    connectAttempt?: number;
    ft0?: boolean;
    voice?: { active: boolean; mode: string | null } | null;
  } | null;
  auto?: { mode: AutoMode; pausedReason: string | null } | null;
  qso?: { active: boolean; theirCall: string | null } | null;
}

const POLL_MS = 10_000;

// The Digital page's own names for these, so the two pages agree.
const AUTO_LABEL: Record<AutoMode, string> = {
  off: "Off",
  cq: "Auto CQ",
  hunt: "Auto Hunt",
  "hunt-pota": "Hunt POTA",
  "pota-chase": "Chase POTA",
};

const SOURCE_LABEL: Record<"flex" | "icom" | "wsjtx", string> = {
  flex: "FlexRadio",
  icom: "Icom",
  wsjtx: "External decoder",
};

type Health = { tone: "ok" | "warn" | "neutral"; label: string };

function healthOf(data: BridgeSnapshot | null): Health | null {
  if (!data) return null;
  if (!data.running) return { tone: "neutral", label: "Bridge offline" };
  const s = data.status;
  if (!s) return { tone: "neutral", label: "Starting" };
  if (s.ft0) return { tone: "warn", label: "FT-0" };
  if (!s.connected) return { tone: "warn", label: "No radio" };
  if (s.commandChannel === false) return { tone: "warn", label: "No rig control" };
  return { tone: "ok", label: "Radio connected" };
}

export function StationPanel({ className }: { className?: string }) {
  const { data, error, reload } = useApi<BridgeSnapshot>("/api/bridge/status");
  useVisibleInterval(() => void reload(), POLL_MS);

  const health = healthOf(data);

  return (
    <Card
      title="Station"
      className={className}
      actions={health && <Badge tone={health.tone}>{health.label}</Badge>}
    >
      {!data ? (
        error ? (
          <p className="text-sm text-fg-muted">
            Station status is unavailable: {error.message}. Retrying on its own.
          </p>
        ) : (
          <p role="status" className="text-sm text-fg-subtle">
            Checking the station…
          </p>
        )
      ) : (
        <>
          <StationBody data={data} />
          {/* The poll failed after a good read: say the figures above are old rather
              than let them pass for live. */}
          {error && (
            <p className="mt-3 text-xs text-warn">
              Lost touch with the bridge ({error.message}) — this is the last reading.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function StationBody({ data }: { data: BridgeSnapshot }) {
  const s = data.status;

  if (!data.running) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-fg-muted">
          The radio bridge is not running, so there is no live station status. The log
          and everything below still work.
        </p>
        {data.reason && <p className="text-xs text-fg-subtle">{data.reason}</p>}
      </div>
    );
  }

  if (!s) {
    return <p className="text-sm text-fg-subtle">The bridge is starting up…</p>;
  }

  if (s.ft0) {
    return (
      <p className="text-sm text-fg-muted">
        FT-0 is engaged: everything is stopped, transmit is off and the radio has been
        released. Resume it from FT-0 in the header.
      </p>
    );
  }

  if (!s.connected) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-fg-muted">
          The bridge is running but no radio is connected
          {s.source ? ` (${SOURCE_LABEL[s.source]} selected)` : ""}.
        </p>
        {s.connectionError && (
          <p className="text-xs text-fg-subtle break-words">
            Last error: {s.connectionError}
            {s.connectAttempt ? ` — attempt ${s.connectAttempt}` : ""}
          </p>
        )}
      </div>
    );
  }

  const voice = s.voice?.active === true;
  // `subMode` is what is being decoded; `mode` alone is the slice's modulation on a Flex.
  const mode = voice ? (s.voice?.mode ?? "Voice") : (s.subMode ?? s.mode);
  const auto = data.auto ?? null;
  const working = data.qso?.active && data.qso.theirCall ? data.qso.theirCall : null;
  const radio = s.radio?.model ?? (s.source ? SOURCE_LABEL[s.source] : null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <span className="flex items-baseline gap-1.5">
          <span className="font-display text-3xl leading-none tnum">
            {s.dialFrequency ? formatFreqDial(s.dialFrequency) : "—"}
          </span>
          <span className="text-xs text-fg-subtle">MHz</span>
        </span>
        <span className="flex items-center gap-1.5">
          {s.band && <Badge>{s.band}</Badge>}
          {mode && <Badge>{mode}</Badge>}
          {voice && <Badge tone="warn">Voice</Badge>}
        </span>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {radio && (
          <>
            <dt className="text-fg-subtle">Radio</dt>
            <dd className="text-fg-muted truncate">{radio}</dd>
          </>
        )}
        <dt className="text-fg-subtle">Auto operate</dt>
        <dd className={cn(auto && auto.mode !== "off" ? "text-fg" : "text-fg-muted")}>
          {auto ? AUTO_LABEL[auto.mode] : "Off"}
          {auto?.pausedReason && (
            <span className="text-warn"> — paused: {auto.pausedReason}</span>
          )}
        </dd>
        <dt className="text-fg-subtle">Working</dt>
        <dd>
          {working ? (
            <span className="font-display tracking-wide text-accent-bright">{working}</span>
          ) : (
            <span className="text-fg-muted">Nobody right now</span>
          )}
        </dd>
      </dl>
    </div>
  );
}
