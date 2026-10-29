import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/primitives";
import { apiDelete, apiPost, useApi } from "@/lib/client/api";
import { useUser } from "@/lib/client/session";
import { cn } from "@/lib/utils";

interface ShiftView {
  signedOn: boolean;
  operator: { id: string; name: string; callsign: string; stationCallsign: string } | null;
  since: string | null;
  signedOnBy: string | null;
}

/**
 * Who is at the radio, from every page: sign on, sign off. See lib/operators/shift.ts.
 *
 * Every contact the station logs while someone is signed on carries them as its operator, so
 * on a shared club station this is the difference between a log that says who worked whom and
 * one that says only that the club did. Any operator can sign on or off; a viewer only sees.
 */
export function OperatorButton() {
  const user = useUser();
  const { data, reload } = useApi<ShiftView>(user ? "/api/operators/current" : null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  // Somebody else may sign on at another screen; the panel shows the truth when opened.
  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  if (!user || !data) return null;

  const canChange = user.role !== "VIEWER";
  const op = data.operator;
  const mine = op !== null && !!user.callsign && op.callsign.toUpperCase() === user.callsign.toUpperCase();
  const since = data.since ? new Date(data.since).toISOString().slice(11, 16) + "Z" : "";

  const act = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (on) await apiPost("/api/operators/current", {});
      else await apiDelete("/api/operators/current");
      await reload();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The server did not answer");
    } finally {
      setBusy(false);
    }
  };

  const title = op
    ? `${op.name} (${op.callsign}) is signed on at ${op.stationCallsign} since ${since}: contacts are logged as theirs.`
    : "Nobody is signed on: contacts are logged with no operator.";

  return (
    <div ref={wrapRef} className="relative hidden sm:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs font-medium tracking-wide whitespace-nowrap transition-colors",
          op
            ? "border-line-strong text-fg hover:bg-surface-2"
            : "border-dashed border-line text-fg-muted hover:text-fg hover:border-line-strong",
        )}
      >
        <span className="text-fg-subtle">OP</span>
        <span>{op ? op.callsign : "—"}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Operator at the radio"
          className="absolute right-0 top-full mt-2 w-72 z-40 rounded-md border border-line-strong bg-surface p-3 text-sm shadow-pop"
        >
          {op ? (
            <>
              <p className="font-medium text-fg">
                {op.name} · {op.callsign}
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                Signed on at {op.stationCallsign} since {since}
                {data.signedOnBy && data.signedOnBy !== op.callsign ? ` by ${data.signedOnBy}` : ""}. Every
                contact logged until sign-off is theirs.
              </p>
            </>
          ) : (
            <p className="text-xs text-fg-muted">
              Nobody is signed on, so contacts are logged with no operator.
              {canChange ? " Sign on to have them logged as yours." : ""}
            </p>
          )}
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
          {canChange && (
            <div className="mt-3 flex justify-end gap-2">
              {op && (
                <Button size="sm" variant="ghost" loading={busy} onClick={() => void act(false)}>
                  Sign off
                </Button>
              )}
              {!mine && (
                <Button size="sm" loading={busy} onClick={() => void act(true)}>
                  {op ? "Sign me on instead" : "Sign on"}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
