import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";

import {
  QsoForm,
  type QsoFormValues,
  toRequestBody,
  valuesFromQso,
} from "@/components/qso/QsoForm";
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiDelete, apiPatch, useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { formatFreqMHz } from "@/lib/ham/bands";
import { formatUtc, formatUtcTime } from "@/lib/time";
import type { ListResponse, QsoDetail, Station } from "@/lib/types";

export default function QsoDetailPage() {
  const router = useRouter();
  const canEdit = useCan("OPERATOR");
  const id = typeof router.query.id === "string" ? router.query.id : null;

  const { data: qso, error, loading, reload } = useApi<QsoDetail>(
    id ? `/api/qsos/${id}` : null,
  );
  const { data: stationsData } = useApi<ListResponse<Station>>("/api/stations");

  const [values, setValues] = useState<QsoFormValues | null>(null);

  // The most recent QSL email that actually went out. A FAILED or PENDING row is
  // not "sent to", and showing one as though it were would be worse than nothing.
  const sentEmail = qso?.qslEmails?.find((e) => e.status === "SENT") ?? null;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (qso) setValues(valuesFromQso(qso));
  }, [qso]);

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
      setSaveError(
        err instanceof ApiError ? err : new ApiError(0, "Failed to save"),
      );
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!id) return;
    if (
      !window.confirm(
        "Delete this QSO permanently? Linked reception reports go with it.",
      )
    ) {
      return;
    }
    try {
      await apiDelete(`/api/qsos/${id}`);
      await router.push("/qsos");
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? err : new ApiError(0, "Failed to delete"),
      );
    }
  }

  if (error) {
    return (
      <>
        <PageHeader title="QSO" />
        <ErrorBanner>
          {error.status === 404 ? "That QSO doesn't exist." : error.message}
        </ErrorBanner>
        <div className="mt-3">
          <Link href="/qsos">
            <Button>Back to log</Button>
          </Link>
        </div>
      </>
    );
  }

  if (loading || !qso || !values) {
    return (
      <>
        <PageHeader title="QSO" />
        <p className="text-sm text-fg-subtle">Loading…</p>
      </>
    );
  }

  const confirmed =
    qso.qslRcvd === "CONFIRMED" || qso.lotwRcvd || qso.eqslRcvd;

  return (
    <>
      <PageHeader
        title={qso.callsign}
        subtitle={`${qso.band} · ${qso.mode} · ${formatFreqMHz(qso.freqHz)} MHz · ${formatUtc(qso.startTime)}`}
        actions={
          <>
            {confirmed && <Badge tone="ok">Confirmed</Badge>}
            {/* "Have I worked them before, on what, and is it confirmed" — asked from here
                more than from anywhere else, and previously answerable only by filtering the
                log and reading the rows. */}
            <Link href={`/calls/${encodeURIComponent(qso.callsign)}`}>
              <Button>History with {qso.callsign}</Button>
            </Link>
            <Link href="/qsos">
              <Button>Back to log</Button>
            </Link>
            {canEdit && (
              <Button variant="danger" onClick={() => void remove()}>
                Delete
              </Button>
            )}
          </>
        }
      />

      {saved && !saveError && (
        <div className="mb-4 border border-ok/40 bg-ok/10 text-ok text-sm px-3 py-2 rounded-sm">
          Saved.
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="Edit QSO" className="xl:col-span-2">
          <QsoForm
            values={values}
            onChange={setValues}
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
          />
        </Card>

        <div className="flex flex-col gap-6">
          <Card title="Heard by">
            {qso.spots.length === 0 ? (
              <p className="text-sm text-fg-subtle">
                No reception reports. These arrive from PSKReporter a few minutes after a
                contact, and only if a receiver heard us and uploaded it — turn on{" "}
                <strong>Collect reception reports</strong> in settings.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {qso.spots.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 py-1.5 text-sm"
                  >
                    <span className="font-display tracking-wide">
                      {s.receiverCall}
                    </span>
                    {s.receiverGrid && (
                      <span className="tnum text-fg-subtle">
                        {s.receiverGrid}
                      </span>
                    )}
                    {s.snr !== null && (
                      <Badge tone={s.snr >= 0 ? "ok" : "neutral"}>
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

          {/*
            The exchange itself, as it happened.

            Above "Source decodes" deliberately: those are every signal the receiver
            heard in the neighbourhood, this is the conversation. The one an operator
            wants when they doubt a contact is this one.
          */}
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
                No linked decodes. Contacts made by DigiShack&apos;s own decoder keep theirs; imported and externally-decoded contacts have none to keep.
              </p>
            ) : (
              <ul className="flex flex-col gap-1 font-mono text-xs">
                {qso.decodes.map((d) => (
                  <li key={d.id} className="flex items-center gap-2">
                    <span className="text-fg-subtle tnum">
                      {formatUtcTime(d.timestamp)}
                    </span>
                    <span className="tnum text-fg-muted w-10 text-right">
                      {d.snr > 0 ? `+${d.snr}` : d.snr}
                    </span>
                    <span className="tnum text-fg-subtle w-12 text-right">
                      {d.freqOffset}
                    </span>
                    <span className="text-fg">{d.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Record">
            <dl className="text-sm flex flex-col gap-1.5">
              <Row label="QSO id" value={qso.id} mono />
              <Row label="Station" value={`${qso.station.callsign}`} />
              <Row label="Radio" value={qso.radio ?? "—"} />
              <Row
                label="TX power"
                value={qso.txPowerW != null ? `${qso.txPowerW} W` : "—"}
              />
              <Row
                label="Operator"
                value={
                  qso.operator
                    ? `${qso.operator.callsign} — ${qso.operator.name}`
                    : "—"
                }
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

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className={mono ? "font-mono text-xs self-center" : "text-fg-muted"}>
        {value}
      </dd>
    </div>
  );
}

export const getServerSideProps = withPageAuth();
