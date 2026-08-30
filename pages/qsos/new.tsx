import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";

import {
  QsoForm,
  type QsoFormValues,
  clearDraft,
  draftFailureMessage,
  emptyValues,
  hasContactContent,
  newClientId,
  readDraft,
  toRequestBody,
  writeDraft,
} from "@/components/qso/QsoForm";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiPost, isNetworkFailure, useApi } from "@/lib/client/api";
import { formatUtc } from "@/lib/time";
import type { ListResponse, Qso, Station } from "@/lib/types";

export default function NewQsoPage() {
  const router = useRouter();
  const { data: stationsData, error: stationsError } =
    useApi<ListResponse<Station>>("/api/stations");

  const [values, setValues] = useState<QsoFormValues>(emptyValues);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [lastLogged, setLastLogged] = useState<Qso | null>(null);

  /**
   * The idempotency key this contact will be logged under.
   *
   * Minted once per CONTACT, not once per attempt: a retry after a lost response has to
   * carry the same key or it creates a second QSO, which is the failure this exists to
   * stop. Rotated on a successful save, and restored alongside a draft so that a contact
   * recovered after the tab was discarded still cannot duplicate the one the server may
   * already hold.
   */
  const [clientId, setClientId] = useState<string>(newClientId);

  /**
   * The restore attempt has happened. The persist effect below must not run before it,
   * or the pristine mount-time form would clear the very draft we are about to read.
   */
  const [draftReady, setDraftReady] = useState(false);

  /** Did the last draft write actually land? Governs what the failure message claims. */
  const [draftSaved, setDraftSaved] = useState(false);

  /** `savedAt` of a draft recovered on this mount, so the page can say what it did. */
  const [restoredAt, setRestoredAt] = useState<string | null>(null);

  const stations = stationsData?.rows ?? [];

  // Preselect when there's only one station — the common single-op case.
  useEffect(() => {
    if (!values.stationId && stations.length === 1 && stations[0]) {
      setValues((v) => ({ ...v, stationId: stations[0]!.id }));
    }
  }, [stations, values.stationId]);

  // Recover a contact left behind by a previous visit.
  //
  // Runs once, and only into a form with nothing to lose: `hasContactContent(values)`
  // reads the mount-time state, which is the only moment at which "has the operator
  // typed anything" can be answered without racing them. If they have, the draft is
  // left on disk untouched rather than overwriting live work — the recovery path must
  // never itself destroy a contact.
  //
  // It cannot be a lazy `useState` initialiser, which is where this wants to live:
  // localStorage does not exist during the server render, and reading it during the
  // client render would hand React two different trees to reconcile.
  useEffect(() => {
    const draft = readDraft();
    if (draft && hasContactContent(draft.values) && !hasContactContent(values)) {
      setValues(draft.values);
      setClientId(draft.clientId);
      setRestoredAt(draft.savedAt || null);
      setDraftSaved(true);
    }
    setDraftReady(true);
    // Mount only. `values` is read deliberately as its mount-time snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on every change.
  //
  // Cheap enough to do synchronously and without debouncing: the payload is a few
  // hundred bytes of strings and `setItem` on it is microseconds. A debounce would open
  // a window — the last word typed before the phone locks — in which the contact is
  // once again only in React state, which is the entire bug.
  //
  // A form holding nothing but the session (station, frequency, band, mode) writes
  // nothing and clears anything stale, so opening this page does not leave a draft
  // behind and a save does not immediately re-create the one it just cleared.
  useEffect(() => {
    if (!draftReady) return;
    if (!hasContactContent(values)) {
      clearDraft();
      setDraftSaved(false);
      return;
    }
    setDraftSaved(writeDraft(values, clientId));
  }, [values, clientId, draftReady]);

  async function submit(thenGoToLog: boolean) {
    setSubmitting(true);
    setError(null);
    try {
      const created = await apiPost<Qso>("/api/qsos", {
        ...toRequestBody(values),
        clientId,
      });

      // The contact is on the server. Drop the draft BEFORE anything else can fail or
      // navigate: a draft that outlives its save is offered back on the next visit as
      // an unlogged contact, and the operator logs it twice.
      clearDraft();
      setDraftSaved(false);
      setRestoredAt(null);
      // A fresh key for the next contact. Reusing this one would make the next QSO
      // collide with the one just saved and quietly return it instead of logging it.
      setClientId(newClientId());

      // Keep station, operator, band, freq and mode, clear the per-contact fields. This
      // is the behaviour that makes a logger usable during a run.
      //
      // Done on BOTH paths, including the one that navigates away. The persist effect
      // still runs on the way out, and leaving the logged contact in `values` would write
      // it straight back to storage under the key just minted — so the next visit to this
      // page would offer an already-logged contact for recovery, under a key that would
      // not stop it being logged a second time.
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

      if (thenGoToLog) {
        await router.push("/qsos");
        return;
      }
      setLastLogged(created);

      // Put the cursor back where the next contact starts. Without this every
      // logged QSO costs a mouse trip to the top of a 21-field form, which is the
      // whole difference between a logger you can run a pileup with and one you
      // cannot.
      requestAnimationFrame(() => document.getElementById("callsign")?.focus());
    } catch (err) {
      const failure =
        err instanceof ApiError ? err : new ApiError(0, "Failed to save QSO");

      if (isNetworkFailure(failure)) {
        // Write the draft again here, on the failure path itself, and let its RESULT
        // decide the wording. The message is a promise about the operator's contact,
        // and it is not one to make on the strength of a `draftSaved` flag set by an
        // effect that ran some renders ago.
        const kept = writeDraft(values, clientId);
        setDraftSaved(kept);
        setError(new ApiError(0, draftFailureMessage(failure.message, kept)));
      } else {
        // A real answer from the server — a validation refusal, a missing station, a
        // 503. Its message and field errors are the useful ones and are passed through
        // untouched. The draft stays on disk regardless: the contact is still unlogged.
        setError(failure);
      }
    } finally {
      setSubmitting(false);
    }
  }

  /** Throw away a recovered draft and start clean, keeping the operating session. */
  function discardDraft() {
    clearDraft();
    setValues((v) => ({
      ...emptyValues(),
      stationId: v.stationId,
      operatorId: v.operatorId,
      freqMHz: v.freqMHz,
      band: v.band,
      mode: v.mode,
    }));
    setClientId(newClientId());
    setRestoredAt(null);
    setDraftSaved(false);
    setError(null);
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

  const offline = error !== null && isNetworkFailure(error);

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

      {/* A form that fills itself in is alarming unless it says why. This also gives the
          operator the way out — a recovered contact they no longer want is otherwise
          cleared field by field. */}
      {restoredAt !== null && (
        <div className="mb-4 flex flex-wrap items-center gap-2 border border-warn/40 bg-warn/10 text-warn text-sm px-3 py-2 rounded-sm">
          <span>
            Unlogged contact recovered from {formatUtc(restoredAt)} — it was never
            saved to the log.
          </span>
          <Button onClick={discardDraft}>Discard</Button>
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
          submitFooter={
            offline ? (
              <div className="flex flex-wrap items-center gap-2 border border-warn/40 bg-warn/10 text-warn text-sm px-3 py-2 rounded-sm">
                <span>
                  {draftSaved
                    ? "Not logged — no answer from the server. The contact is held on this device."
                    : "Not logged — no answer from the server, and this browser is blocking storage. Keep this page open."}
                </span>
                <Button
                  variant="primary"
                  disabled={submitting}
                  onClick={() => void submit(false)}
                >
                  {submitting ? "Retrying…" : "Retry"}
                </Button>
              </div>
            ) : null
          }
        />
      </Card>
    </>
  );
}

// Logging requires OPERATOR; a VIEWER is bounced to the dashboard.
export const getServerSideProps = withPageAuth({ role: "OPERATOR" });
