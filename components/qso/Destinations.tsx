import { useEffect, useMemo, useState } from "react";

import { Badge, Button, Card, ErrorBanner } from "@/components/ui/primitives";
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import { formatUtc } from "@/lib/time";

// Where a contact went, and a way to send it again.
//
// > "need a way on a contact in the log to reprocess, like if it didnt hit any logs so if
// >  they open the contact and hit reprocess they pick which logging softwares or
// >  integrations to send it to again"
//
// The upload flags have always been on the QSO row and nothing ever showed them, so a
// contact that reached nothing looked exactly like one that reached everything. The only
// remedy was an upload sweep — which skips whatever is already marked sent and therefore
// cannot fix the case where the MARK is what is wrong.
//
// The checkboxes start on the services that are configured and show nothing sent, because
// that is the reported case. Anything already sent starts unticked and has to be ticked
// deliberately: sending a duplicate is harmless at every one of these services, but it is
// still somebody else's log and it should be a decision rather than a default.

interface Destination {
  service: string;
  label: string;
  sent: boolean;
  sentAt: string | null;
  configured: boolean;
  enabled: boolean;
}

interface ServiceOutcome {
  service: string;
  attempted: number;
  uploaded: number;
  duplicates: number;
  failed: number;
  skipped: string | null;
  errors: string[];
  detail?: string | null;
}

interface RunResult {
  ran: boolean;
  reason: string | null;
  services: ServiceOutcome[];
  destinations: Destination[];
}

export function Destinations({ qsoId, canEdit }: { qsoId: string; canEdit: boolean }) {
  const { data, error, reload } = useApi<{ destinations: Destination[] }>(
    `/api/qsos/${qsoId}/destinations`,
  );
  const rows = useMemo(() => data?.destinations ?? [], [data]);

  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [sendError, setSendError] = useState<ApiError | null>(null);

  useEffect(() => {
    // Only seed once per load. Re-seeding on every render would fight the operator's
    // ticks, and re-seeding after a send would silently untick what just succeeded.
    if (rows.length === 0) return;
    setPicked(Object.fromEntries(rows.map((d) => [d.service, d.configured && !d.sent])));
  }, [rows]);

  const chosen = rows.filter((d) => picked[d.service]);

  async function reprocess() {
    if (chosen.length === 0) return;
    setSending(true);
    setSendError(null);
    setResult(null);
    try {
      const out = await apiPost<RunResult>(`/api/qsos/${qsoId}/destinations`, {
        services: chosen.map((d) => d.service),
      });
      setResult(out);
      await reload();
    } catch (err) {
      setSendError(err instanceof ApiError ? err : new ApiError(0, "Reprocess failed"));
    } finally {
      setSending(false);
    }
  }

  if (error) {
    return (
      <Card title="Destinations">
        <ErrorBanner>{error.message}</ErrorBanner>
      </Card>
    );
  }

  return (
    <Card title="Destinations">
      <p className="text-sm text-fg-subtle mb-3">
        Where this contact has been sent. Tick anywhere it needs to go again — a service
        that already has it answers &ldquo;duplicate&rdquo;, which is harmless and is also
        the answer that proves it is there.
      </p>

      <ul className="flex flex-col divide-y divide-line">
        {rows.map((d) => (
          <li key={d.service} className="flex items-center gap-2 py-1.5 text-sm">
            <input
              id={`dest-${d.service}`}
              type="checkbox"
              checked={picked[d.service] ?? false}
              disabled={!canEdit || !d.configured || sending}
              onChange={(e) =>
                setPicked((p) => ({ ...p, [d.service]: e.target.checked }))
              }
              className="accent-accent size-3.5"
            />
            <label
              htmlFor={`dest-${d.service}`}
              className={d.configured ? "text-fg-muted" : "text-fg-subtle"}
            >
              {d.label}
            </label>
            <span className="ml-auto flex items-center gap-2">
              {d.sentAt && (
                <span className="tnum text-xs text-fg-subtle">{formatUtc(d.sentAt)}</span>
              )}
              {!d.configured ? (
                <Badge tone="neutral">Not set up</Badge>
              ) : d.sent ? (
                <Badge tone="ok">Sent</Badge>
              ) : (
                <Badge tone="warn">Not sent</Badge>
              )}
            </span>
          </li>
        ))}
      </ul>

      {rows.some((d) => !d.configured) && (
        <p className="text-xs text-fg-subtle mt-3">
          A service marked <strong>Not set up</strong> has no credentials yet — LoTW needs a
          callsign certificate, the rest need a key or a login. Settings &rarr; Uploads.
        </p>
      )}

      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="primary"
            disabled={chosen.length === 0 || sending}
            onClick={() => void reprocess()}
          >
            {sending ? "Sending…" : `Reprocess to ${chosen.length || "…"}`}
          </Button>
          <span className="text-xs text-fg-subtle">
            Sends now, without waiting for a sweep and whether or not automatic uploading is
            on.
          </span>
        </div>
      )}

      {sendError && (
        <div className="mt-3">
          <ErrorBanner>{sendError.message}</ErrorBanner>
        </div>
      )}

      {result && (
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {result.services.map((s) => (
            <li key={s.service} className="flex items-start gap-2">
              <span className="text-fg-muted w-28 shrink-0">{s.service}</span>
              <span
                className={
                  s.failed > 0 || s.skipped
                    ? "text-warn"
                    : s.uploaded > 0 || s.duplicates > 0
                      ? "text-ok"
                      : "text-fg-subtle"
                }
              >
                {describe(s)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * One line per service, saying what actually happened.
 *
 * A duplicate is reported as its own outcome rather than folded into success or failure.
 * It is neither: the upload did not add anything, and the contact IS at the service —
 * which for somebody reprocessing a contact they doubt is the most useful answer of the
 * three.
 */
function describe(s: ServiceOutcome): string {
  if (s.skipped) return `Skipped — ${s.skipped}`;
  if (s.failed > 0) return s.errors[0] ?? "Failed";
  if (s.duplicates > 0) return "Already there — the service reported it as a duplicate";
  if (s.uploaded > 0) return s.detail ? `Sent — ${s.detail}` : "Sent";
  return "Nothing to send";
}
