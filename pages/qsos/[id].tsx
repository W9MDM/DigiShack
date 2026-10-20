import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";

import { LinkButton, qrzUrl } from "@/components/log/links";
import { lastLogUrl } from "@/components/log/log-query";
import { QsoSummary } from "@/components/log/QsoSummary";
import { Destinations } from "@/components/qso/Destinations";
import {
  QsoForm,
  type QsoFormValues,
  toRequestBody,
  valuesFromQso,
} from "@/components/qso/QsoForm";
import { Badge, Button, Card, ErrorBanner, PageHeader } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiDelete, apiPatch, useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { formatUtc, formatUtcTime } from "@/lib/time";
import type { ListResponse, QsoDetail, Station } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function QsoDetailPage() {
  const router = useRouter();
  const canEdit = useCan("OPERATOR");
  const id = typeof router.query.id === "string" ? router.query.id : null;

  const { data: qso, error, reload } = useApi<QsoDetail>(id ? `/api/qsos/${id}` : null);
  const { data: stationsData } = useApi<ListResponse<Station>>("/api/stations");

  const [values, setValues] = useState<QsoFormValues | null>(null);

  // The most recent QSL email that actually went out. A FAILED or PENDING row is
  // not "sent to", and showing one as though it were would be worse than nothing.
  const sentEmail = qso?.qslEmails?.find((e) => e.status === "SENT") ?? null;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  /** Back to the log as it was left — same filter, same page. */
  const [logHref, setLogHref] = useState("/qsos");
  useEffect(() => setLogHref(lastLogUrl()), []);

  useEffect(() => {
    if (qso) setValues(valuesFromQso(qso));
  }, [qso]);

  const pristine = useMemo(() => (qso ? JSON.stringify(valuesFromQso(qso)) : null), [qso]);
  const dirty = values !== null && pristine !== null && JSON.stringify(values) !== pristine;

  function change(v: QsoFormValues) {
    setValues(v);
    setSaved(false);
  }

  async function save() {
    if (!id || !values) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      await apiPatch(`/api/qsos/${id}`, toRequestBody(values));
      setSaved(true);
      await reload();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err : new ApiError(0, "Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!id) return;
    if (!window.confirm("Delete this QSO permanently? Linked reception reports go with it.")) {
      return;
    }
    try {
      await apiDelete(`/api/qsos/${id}`);
      await router.push(logHref);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err : new ApiError(0, "Failed to delete"));
    }
  }

  const back = (
    <LinkButton href={logHref} variant="ghost">
      <span aria-hidden="true">←</span> Back to log
    </LinkButton>
  );

  // Full-page states only before there is a record to show. A refetch after Save used to
  // swap the whole page for "Loading…", unmounting the form and losing the scroll.
  if (!qso || !values) {
    return (
      <>
        <PageHeader title="QSO" actions={back} />
        {error ? (
          <ErrorBanner>{error.status === 404 ? "That QSO doesn't exist." : error.message}</ErrorBanner>
        ) : (
          <p role="status" className="text-sm text-fg-subtle">
            Loading…
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={qso.callsign}
        actions={
          <>
            {/* "Have I worked them before, on what, and is it confirmed" is asked from here
                more than from anywhere else. */}
            <LinkButton href={`/calls/${encodeURIComponent(qso.callsign)}`}>
              History with {qso.callsign}
            </LinkButton>
            <LinkButton href={qrzUrl(qso.callsign)} kind="external" variant="ghost">
              QRZ
            </LinkButton>
            {back}
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorBanner>Could not refresh this contact: {error.message}</ErrorBanner>
        </div>
      )}

      <QsoSummary qso={qso} className="mb-4 sm:mb-6" />

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
        <Card title={canEdit ? "Edit QSO" : "QSO details"} className="xl:col-span-2">
          <QsoForm
            values={values}
            onChange={change}
            stations={stationsData?.rows ?? []}
            submitting={saving}
            error={saveError}
            onSubmit={() => void save()}
            submitLabel="Save changes"
            qsoId={qso.id}
            emailedTo={sentEmail?.toAddress ?? null}
            emailedAt={
              // Was toLocaleString(), which rendered in the browser's zone — the one
              // genuinely wrong time in the application.
              sentEmail?.sentAt ? formatUtc(sentEmail.sentAt) : null
            }
            readOnly={!canEdit}
            secondaryAction={
              <>
                {/* Always mounted, so the change to "Saved" is announced. */}
                <span
                  role="status"
                  className={cn("text-sm", saved ? "text-ok" : "text-fg-subtle")}
                >
                  {saved ? "Saved" : dirty ? "Unsaved changes" : ""}
                </span>
                {canEdit && (
                  <Button variant="danger" className="ml-auto" onClick={() => void remove()}>
                    Delete QSO
                  </Button>
                )}
              </>
            }
          />
        </Card>

        <div className="flex flex-col gap-4 sm:gap-6">
          <Destinations qsoId={qso.id} canEdit={canEdit} />

          <Card
            title="Heard by"
            actions={qso.spots.length > 0 ? <Badge size="sm">{qso.spots.length}</Badge> : undefined}
          >
            {qso.spots.length === 0 ? (
              <p className="text-sm text-fg-subtle">
                No reception reports. These arrive from PSKReporter a few minutes after a
                contact, and only if a receiver heard us and uploaded it — turn on{" "}
                <strong>Collect reception reports</strong> in settings.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {qso.spots.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 py-1.5 text-sm">
                    <span className="font-display tracking-wide">{s.receiverCall}</span>
                    {s.receiverGrid && <span className="tnum text-fg-subtle">{s.receiverGrid}</span>}
                    {s.snr !== null && (
                      <Badge size="sm" tone={s.snr >= 0 ? "ok" : "neutral"}>
                        {s.snr > 0 ? `+${s.snr}` : s.snr} dB
                      </Badge>
                    )}
                    <span className="tnum text-xs text-fg-subtle ml-auto">
                      {formatUtc(s.reportedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* The exchange itself, above the source decodes: those are every signal heard
              nearby, this is the conversation — the one wanted when a contact is doubted. */}
          <Card title="Exchange">
            {qso.transcript ? (
              <pre className="font-mono text-xs text-fg whitespace-pre overflow-x-auto">
                {qso.transcript}
              </pre>
            ) : (
              <p className="text-sm text-fg-subtle">
                No transcript. Recorded for contacts made by DigiShack&rsquo;s own FT8/FT4
                path — a manual entry, an imported contact or one logged through an
                external decoder never saw the messages.
              </p>
            )}
          </Card>

          <Card title="Source decodes">
            {qso.decodes.length === 0 ? (
              <p className="text-sm text-fg-subtle">
                No linked decodes. Contacts made by DigiShack&apos;s own decoder keep theirs;
                imported and externally-decoded contacts have none to keep.
              </p>
            ) : (
              <ul className="flex flex-col gap-1 overflow-x-auto font-mono text-xs">
                {qso.decodes.map((d) => (
                  <li key={d.id} className="flex items-center gap-2 whitespace-nowrap">
                    <span className="text-fg-subtle tnum">{formatUtcTime(d.timestamp)}</span>
                    <span className="tnum text-fg-muted w-10 text-right">
                      {d.snr > 0 ? `+${d.snr}` : d.snr}
                    </span>
                    <span className="tnum text-fg-subtle w-12 text-right">{d.freqOffset}</span>
                    <span className="text-fg">{d.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Record">
            <dl className="flex flex-col gap-1.5 text-sm">
              <Row label="QSO id" value={qso.id} mono />
              <Row label="Station" value={qso.station.callsign} />
              <Row label="Radio" value={qso.radio ?? "—"} />
              <Row label="TX power" value={qso.txPowerW != null ? `${qso.txPowerW} W` : "—"} />
              <Row
                label="Operator"
                value={qso.operator ? `${qso.operator.callsign} — ${qso.operator.name}` : "—"}
              />
              <Row label="Logged" value={formatUtc(qso.createdAt)} />
              <Row label="Updated" value={formatUtc(qso.updatedAt)} />
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-fg-subtle">{label}</dt>
      <dd
        className={cn(
          "min-w-0 break-all text-right",
          mono ? "font-mono text-xs self-center" : "text-fg-muted tnum",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export const getServerSideProps = withPageAuth();
