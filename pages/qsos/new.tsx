import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";

import {
  QsoForm,
  type QsoFormValues,
  emptyValues,
  toRequestBody,
} from "@/components/qso/QsoForm";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import type { ListResponse, Qso, Station } from "@/lib/types";

export default function NewQsoPage() {
  const router = useRouter();
  const { data: stationsData, error: stationsError } =
    useApi<ListResponse<Station>>("/api/stations");

  const [values, setValues] = useState<QsoFormValues>(emptyValues);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [lastLogged, setLastLogged] = useState<Qso | null>(null);

  const stations = stationsData?.rows ?? [];

  // Preselect when there's only one station — the common single-op case.
  useEffect(() => {
    if (!values.stationId && stations.length === 1 && stations[0]) {
      setValues((v) => ({ ...v, stationId: stations[0]!.id }));
    }
  }, [stations, values.stationId]);

  async function submit(thenGoToLog: boolean) {
    setSubmitting(true);
    setError(null);
    try {
      const created = await apiPost<Qso>("/api/qsos", toRequestBody(values));
      if (thenGoToLog) {
        await router.push("/qsos");
        return;
      }
      // Stay put for run-style logging: keep station, operator, band, freq and
      // mode, clear the per-contact fields. This is the behaviour that makes a
      // logger usable during a run.
      setLastLogged(created);
      setValues((v) => ({
        ...emptyValues(),
        stationId: v.stationId,
        operatorId: v.operatorId,
        freqMHz: v.freqMHz,
        band: v.band,
        mode: v.mode,
        // rstSent/rstRcvd deliberately NOT carried over. Station, band and mode are
        // properties of the session; a signal report belongs to one contact, and
        // inheriting the last one is how a log quietly fills with wrong numbers.
      }));

      // Put the cursor back where the next contact starts. Without this every
      // logged QSO costs a mouse trip to the top of a 21-field form, which is the
      // whole difference between a logger you can run a pileup with and one you
      // cannot.
      requestAnimationFrame(() => document.getElementById("callsign")?.focus());
    } catch (err) {
      setError(
        err instanceof ApiError ? err : new ApiError(0, "Failed to save QSO"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (stationsError) {
    return (
      <>
        <PageHeader title="New QSO" />
        <ErrorBanner>
          {stationsError.status === 503
            ? "Can't reach the database. Check DATABASE_URL and that MySQL is running, then run `npm run db:deploy`."
            : stationsError.message}
        </ErrorBanner>
      </>
    );
  }

  if (stationsData && stations.length === 0) {
    return (
      <>
        <PageHeader title="New QSO" />
        <Card>
          <EmptyState title="No station configured">
            Every QSO is attributed to a station, so create one first.
            <div className="mt-3">
              <Link href="/stations">
                <Button variant="primary">Set up a station</Button>
              </Link>
            </div>
          </EmptyState>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="New QSO"
        subtitle="Times are UTC"
        actions={
          <Link href="/qsos">
            <Button>Back to log</Button>
          </Link>
        }
      />

      {lastLogged && (
        <div className="mb-4 flex items-center gap-2 border border-ok/40 bg-ok/10 text-ok text-sm px-3 py-2 rounded-sm">
          Logged{" "}
          <Link href={`/qsos/${lastLogged.id}`} className="underline font-medium">
            {lastLogged.callsign}
          </Link>{" "}
          on {lastLogged.band} {lastLogged.mode}. Ready for the next one.
        </div>
      )}

      <Card>
        <QsoForm
          values={values}
          onChange={setValues}
          stations={stations}
          submitting={submitting}
          error={error}
          onSubmit={() => void submit(false)}
          submitLabel="Log QSO"
          secondaryAction={
            <Button disabled={submitting} onClick={() => void submit(true)}>
              Log &amp; view log
            </Button>
          }
        />
      </Card>
    </>
  );
}

// Logging requires OPERATOR; a VIEWER is bounced to the dashboard.
export const getServerSideProps = withPageAuth({ role: "OPERATOR" });
