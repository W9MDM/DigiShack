import { useState } from "react";

import { HelpTip } from "@/components/ui/HelpTip";
import { ApiError, apiDelete, apiPost, useApi } from "@/lib/client/api";

// The "do not contact again" list, on the page where the decodes are.
//
// Placed here rather than buried in settings on purpose: the moment somebody asks not to
// be worked again is the moment you are looking at their callsign in a decode list, and a
// courtesy that takes four clicks and a page change to record is a courtesy that does not
// get recorded.
//
// It is the only control in this application that restricts operating on somebody ELSE'S
// behalf, so it says out loud what it does and does not do — an operator who believes this
// gags them entirely will stop trusting it the first time a manual call goes out.

type Kind = "NEVER" | "NO_DUPES";

interface Entry {
  callsign: string;
  reason: string | null;
  addedBy: string | null;
  kind: Kind;
  createdAt: string;
}

export function DoNotCallList() {
  const { data, error, loading, reload } = useApi<{ entries: Entry[] }>("/api/do-not-call");
  const [call, setCall] = useState("");
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState<Kind>("NO_DUPES");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const entries = data?.entries ?? [];

  async function add() {
    const trimmed = call.trim();
    if (!trimmed) return;
    setBusy(true);
    setProblem(null);
    try {
      await apiPost("/api/do-not-call", {
        callsign: trimmed,
        reason: reason.trim() || null,
        kind,
      });
      setCall("");
      setReason("");
      await reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not add that callsign");
    } finally {
      setBusy(false);
    }
  }

  async function remove(callsign: string) {
    setBusy(true);
    setProblem(null);
    try {
      await apiDelete(`/api/do-not-call?callsign=${encodeURIComponent(callsign)}`);
      await reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not remove that callsign");
    } finally {
      setBusy(false);
    }
  }

  return (
    // No Card of its own: the settings group already provides one, and a frame inside a
    // frame reads as a layout mistake — the same note spectrum-canvas carries.
    <div className="flex flex-col gap-2 pt-1 border-t border-line/60">
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-xs uppercase tracking-wide text-fg-subtle">
            Do not call
          </span>
          <HelpTip label="About the do-not-call list">
            Per callsign, because people ask for different things. Someone asking not to be
            worked TWICE on a band and mode is not asking never to be worked again, and
            recording the stronger request costs them contacts they wanted. Neither kind
            stops you calling by hand.
          </HelpTip>
          <span className="text-xs text-fg-muted tnum">({entries.length})</span>
        </div>
        <p className="text-xs text-fg-subtle">
          Per callsign, because people ask for different things.{" "}
          <span className="text-fg-muted">No duplicates</span> still lets the automatic
          modes work them on a band and mode not already in the log;{" "}
          <span className="text-fg-muted">Never</span> stops them entirely. Manual calls
          are unaffected either way — this records a request, it does not lock the radio.
        </p>

        <div className="flex flex-wrap gap-1.5 items-start">
          <input
            value={call}
            onChange={(e) => setCall(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            placeholder="CALLSIGN"
            aria-label="Callsign to never call"
            className="w-28 rounded-sm border border-line bg-bg-raised px-2 py-1 text-xs tnum text-fg focus:border-accent-bright"
          />
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            placeholder="Why (optional, but read it back in a year)"
            aria-label="Reason"
            className="flex-1 min-w-40 rounded-sm border border-line bg-bg-raised px-2 py-1 text-xs text-fg focus:border-accent-bright"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            aria-label="How much to restrict"
            className="rounded-sm border border-line bg-bg-raised px-1.5 py-1 text-xs text-fg focus:border-accent-bright"
          >
            <option value="NO_DUPES">No duplicates</option>
            <option value="NEVER">Never call</option>
          </select>
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || !call.trim()}
            className="px-2 py-1 text-xs rounded-sm border border-line text-fg-muted hover:text-fg hover:border-fg-muted disabled:opacity-40"
          >
            Add
          </button>
        </div>

        {problem && <p className="text-xs text-danger">{problem}</p>}
        {/* A list that failed to load must not look like an empty list — an operator would
            reasonably conclude nobody is on it and start calling. */}
        {error && (
          <p className="text-xs text-danger">
            Could not load the list — {error.message}. Retrying.
          </p>
        )}

        {!error && entries.length === 0 && !loading && (
          <p className="text-xs text-fg-subtle">Nobody on the list.</p>
        )}

        {entries.length > 0 && (
          <ul className="flex flex-col divide-y divide-line/60 text-sm">
            {entries.map((e) => (
              <li key={e.callsign} className="flex items-baseline gap-2 py-1.5">
                <span className="tnum font-medium">{e.callsign}</span>
                <span
                  className={
                    "rounded-sm px-1 text-[10px] uppercase tracking-wide " +
                    (e.kind === "NEVER"
                      ? "bg-danger/20 text-danger"
                      : "bg-warn/20 text-warn")
                  }
                  title={
                    e.kind === "NEVER"
                      ? "Never called by the automatic modes"
                      : "Only called for a band and mode not already in the log"
                  }
                >
                  {e.kind === "NEVER" ? "never" : "no dupes"}
                </span>
                <span className="flex-1 min-w-0 truncate text-xs text-fg-subtle">
                  {e.reason || "no reason recorded"}
                  {e.addedBy ? ` · ${e.addedBy}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(e.callsign)}
                  disabled={busy}
                  title={`Allow the automatic modes to call ${e.callsign} again`}
                  className="text-xs text-fg-muted hover:text-danger disabled:opacity-40"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
