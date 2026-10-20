import { useEffect, useMemo, useState } from "react";

import { Checkbox } from "@/components/log/Checkbox";
import { Badge, Button, Card, ErrorBanner } from "@/components/ui/primitives";
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import { formatUtc } from "@/lib/time";
import { cn } from "@/lib/utils";

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
      <Card title="Uploads">
        <ErrorBanner>{error.message}</ErrorBanner>
      </Card>
    );
  }

  const sentCount = rows.filter((d) => d.sent).length;
  const labelOf = (service: string) => rows.find((d) => d.service === service)?.label ?? service;
  const reprocessLabel =
    chosen.length === 1
      ? `Reprocess to ${chosen[0]!.label}`
      : chosen.length > 1
        ? `Reprocess to ${chosen.length} services`
        : "Reprocess";

  return (
    <Card
      title="Uploads"
      actions={
        rows.length > 0 ? (
          <Badge size="sm" tone={sentCount === rows.length ? "ok" : "neutral"}>
            {sentCount} of {rows.length} sent
          </Badge>
        ) : undefined
      }
    >
      {!data ? (
        <p role="status" className="text-sm text-fg-subtle">
          Checking where this contact has been sent…
        </p>
      ) : (
        <>
          {canEdit && (
            <p className="mb-2 text-sm text-fg-subtle">
              Tick anywhere it needs to go again. A service that already has it answers
              &ldquo;duplicate&rdquo; — harmless, and proof that it is there.
            </p>
          )}

          <ul className="flex flex-col divide-y divide-line">
            {rows.map((d) => {
              // The flag on the contact comes first: a contact QRZ already holds is
              // "Sent" even if the QRZ key has since been removed.
              const status = d.sent ? "Sent" : !d.configured ? "Not set up" : "Not sent";
              const tone = d.sent ? "ok" : !d.configured ? "neutral" : "warn";
              return (
                <li key={d.service} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    {canEdit ? (
                      <Checkbox
                        id={`dest-${d.service}`}
                        label={
                          <span className={d.configured ? "text-fg" : "text-fg-subtle"}>
                            {d.label}
                          </span>
                        }
                        checked={picked[d.service] ?? false}
                        disabled={!d.configured || sending}
                        onChange={(v) => setPicked((p) => ({ ...p, [d.service]: v }))}
                      />
                    ) : (
                      <span className="text-sm text-fg">{d.label}</span>
                    )}
                    {d.sentAt && (
                      <div className={cn("text-xs text-fg-subtle tnum", canEdit && "pl-6")}>
                        {formatUtc(d.sentAt)}
                      </div>
                    )}
                  </div>
                  <Badge size="sm" tone={tone}>
                    {status}
                  </Badge>
                </li>
              );
            })}
          </ul>

          {rows.some((d) => !d.configured) && (
            <p className="mt-3 text-xs text-fg-subtle">
              <strong>Not set up</strong> means no credentials yet — LoTW needs a callsign
              certificate, the rest a key or a login. Settings &rarr; Uploads.
            </p>
          )}

          {canEdit && (
            <div className="mt-4 flex flex-col items-start gap-1.5">
              <Button
                variant="primary"
                loading={sending}
                disabled={chosen.length === 0}
                disabledReason="Tick at least one service first."
                onClick={() => void reprocess()}
              >
                {reprocessLabel}
              </Button>
              <span className="text-xs text-fg-subtle">
                Sends now, without waiting for a sweep, whether or not automatic uploading
                is on.
              </span>
            </div>
          )}
        </>
      )}

      {sendError && (
        <div className="mt-3">
          <ErrorBanner>{sendError.message}</ErrorBanner>
        </div>
      )}

      {result && (
        <ul role="status" className="mt-3 flex flex-col gap-1 text-sm">
          {result.services.map((s) => (
            <li key={s.service} className="flex items-start gap-2">
              <span className="w-24 shrink-0 text-fg-muted">{labelOf(s.service)}</span>
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
