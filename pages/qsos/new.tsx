import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";

import {
  QsoForm,
  type QsoFormValues,
  activationFromValues,
  applyActivation,
  carrySession,
  clearActivation,
  clearDraft,
  draftFailureMessage,
  emptyValues,
  hasContactContent,
  newClientId,
  readActivation,
  readDraft,
  toRequestBody,
  writeActivation,
  writeDraft,
} from "@/components/qso/QsoForm";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiPost, isNetworkFailure, useApi } from "@/lib/client/api";
import {
  ACTIVATION_MINIMUM,
  activationCountQuery,
  activationProgress,
  utcDayKey,
} from "@/lib/pota/activation";
import { formatUtc } from "@/lib/time";
import type { ListResponse, Qso, Station } from "@/lib/types";
import { cn } from "@/lib/utils";

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

  /**
   * Bumped on every successful save, purely to re-ask the server for the activation
   * count. It is not rendered.
   *
   * A counter for an activation IN PROGRESS is only interesting at one moment — just
   * after logging a contact — so this is the whole refresh policy. No polling: the
   * number cannot change unless this page changes it, and a timer would be an LTE
   * wake-up a minute from a phone in a park for a value that is already correct.
   */
  const [savedTick, setSavedTick] = useState(0);

  const stations = stationsData?.rows ?? [];

  /** The activation in progress, or "". The form is the live copy; storage is the backup. */
  const activationRef = values.mySigInfo.trim().toUpperCase();

  /**
   * The count query, held stable across renders.
   *
   * `new Date()` sits INSIDE the memo deliberately. `useApi` re-fetches whenever its path
   * changes, so computing the UTC day bounds during render would produce a new path every
   * render and a request loop — the day bounds must be pinned to something that only
   * moves when the answer can. That is the reference changing, or a contact being logged.
   *
   * The consequence, stated rather than hidden: an activation running across UTC midnight
   * shows the previous day's window until the next contact is logged, at which point the
   * query is rebuilt and the count correctly restarts near zero. That is the right moment
   * to notice, and `activationCountQuery` bounds BOTH ends of the day so the stale window
   * is a window on the old day rather than a running total across two.
   */
  const activationPath = useMemo(
    () =>
      activationRef
        ? `/api/qsos?${activationCountQuery(activationRef, new Date())}`
        : null,
    // `savedTick` is the refresh trigger and is deliberately not read in the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activationRef, savedTick],
  );

  // `total` is the whole answer — the endpoint returns the count beside the rows, and
  // `take=1` keeps the page it does not need down to one contact.
  const { data: activationData } = useApi<ListResponse<Qso>>(activationPath);
  const activation = activationProgress(activationData?.total ?? 0);

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

    // The activation, restored on top of whatever the draft brought back.
    //
    // Applied UNCONDITIONALLY, unlike the draft, and the asymmetry is the point. The
    // draft is one contact and must never overwrite typed work; the activation is where
    // the operator IS, it is not typed per contact, and the form has just mounted with it
    // blank. The stored session is the authority — it survives the saves that clear
    // drafts, so a draft carrying an older reference must not win over it.
    //
    // THE CASE THIS IS FOR: Android discards the tab mid-activation, the operator reopens
    // the app, and without this the rest of the activation logs as ordinary contacts with
    // nothing on the page looking wrong.
    //
    // With NO stored session, a recovered draft keeps whatever reference it carries and
    // the persist effect below writes it back. That is deliberate: the only way to hold a
    // draft after ending an activation is for the last contact of that activation to have
    // failed to save, and that contact really was made in the park. Recovering it and
    // being back in the session is the right end state, not an accident.
    const session = readActivation();
    if (session) setValues((v) => applyActivation(v, session));

    setDraftReady(true);
    // Mount only. `values` is read deliberately as its mount-time snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the activation whenever it changes.
  //
  // Separate from the draft effect below because the two have opposite lifetimes: the
  // draft is cleared by every successful save, and the activation has to outlive forty of
  // them. Clearing the reference clears the stored session, so "end the activation" needs
  // no second path — emptying the field is ending it.
  //
  // Gated on `draftReady` for the same reason the draft effect is: running before the
  // restore attempt would write a blank over the session it is about to read.
  useEffect(() => {
    if (!draftReady) return;
    const session = activationFromValues(values);
    if (!session) {
      clearActivation();
      return;
    }
    // Keep the original start time while the reference is unchanged. `activationFromValues`
    // stamps `startedAt` as now, and writing that back on every keystroke would make an
    // activation started four hours ago claim to have started this second — the one thing
    // the field is there to say. A NEW reference is a new activation and does restart it.
    const existing = readActivation();
    writeActivation(
      existing && existing.ref === session.ref
        ? { ...session, startedAt: existing.startedAt || session.startedAt }
        : session,
    );
    // Only the three activation fields. Deliberately not `values`: this has no business
    // running on every keystroke in the callsign box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftReady, values.mySig, values.mySigInfo, values.myGridSquare]);

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
      // Keep station, operator, band, freq, mode and the activation; clear the
      // per-contact fields. `carrySession` owns that list — see the note on it for why
      // the reports are excluded and why this is one function rather than two copies.
      setValues(carrySession);

      // Re-ask the log how many contacts this activation now has. After the save, so the
      // contact just logged is counted.
      setSavedTick((t) => t + 1);

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
    // The activation survives this: discarding one caller's half-typed record is not
    // leaving the park.
    setValues(carrySession);
    setClientId(newClientId());
    setRestoredAt(null);
    setDraftSaved(false);
    setError(null);
  }

  /**
   * Leave the park. Clears the three activation fields, which the persist effect above
   * turns into a cleared session — one path, so the form and storage cannot disagree.
   *
   * Contacts already logged keep their MY_SIG_INFO. This ends the session, it does not
   * retract an activation.
   */
  function endActivation() {
    setValues((v) => ({ ...v, mySig: "", mySigInfo: "", myGridSquare: "" }));
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

      {/* The activation in progress, and the only number an activator is tracking.
          POTA credits an activation at ten contacts from one reference in one UTC day;
          below ten it is an attempt, and the whole point of showing it live is that the
          operator can still do something about it while the radio is on.

          Rendered only once a reference is set, which is after the mount effect — so it
          is client-only and carries no hydration risk from the clock read below. */}
      {activationRef && (
        <div
          className={cn(
            "mb-4 flex flex-wrap items-center gap-2 border text-sm px-3 py-2 rounded-sm",
            activation.qualifies
              ? "border-ok/40 bg-ok/10 text-ok"
              : "border-accent/40 bg-accent/10 text-accent-bright",
          )}
        >
          <Badge tone={activation.qualifies ? "ok" : "accent"}>
            {activation.count}/{ACTIVATION_MINIMUM}
          </Badge>
          <span>
            Activating <span className="tnum font-medium">{activationRef}</span>
            {" — "}
            {activation.qualifies
              ? `${activation.count} contacts, this activation counts.`
              : `${activation.remaining} more contact${activation.remaining === 1 ? "" : "s"} for a valid activation.`}
          </span>
          {/* The day is named, not implied. POTA's boundary is UTC midnight, which in the
              US falls in the EVENING — mid-activation — and an operator who does not know
              which day they are being counted for cannot make sense of a total that
              restarts at what feels like teatime. */}
          <span className="text-fg-subtle text-xs tnum">
            UTC day {utcDayKey(new Date())}
          </span>
          <Button onClick={endActivation}>End activation</Button>
        </div>
      )}

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
