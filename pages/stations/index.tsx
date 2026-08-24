import { useState } from "react";
import { ToolTabs } from "@/components/settings/ToolTabs";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiDelete, apiPatch, apiPost, useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import type { ListResponse, Station } from "@/lib/types";
import {
  ROLES,
} from "@/lib/validation/station";

export default function StationsPage() {
  const canEdit = useCan("OPERATOR");
  const canAdmin = useCan("ADMIN");
  const { data, error, reload } = useApi<ListResponse<Station>>("/api/stations");
  const [formError, setFormError] = useState<ApiError | null>(null);

  const stations = data?.rows ?? [];

  function handle(err: unknown) {
    setFormError(
      err instanceof ApiError ? err : new ApiError(0, "Request failed"),
    );
  }

  return (
    <>
      <ToolTabs />
      <PageHeader
        title="Stations"
        subtitle="Licensed stations and their operators"
      />

      {error && (
        <ErrorBanner>
          {error.status === 503
            ? "Can't reach the database. Check DATABASE_URL and that MySQL is running, then run `npm run db:deploy`."
            : error.message}
        </ErrorBanner>
      )}

      {formError && (
        <div className="mb-4">
          <ErrorBanner>
            {formError.message}
            {formError.details && (
              <ul className="mt-1 list-disc list-inside">
                {Object.entries(formError.details).map(([field, msgs]) => (
                  <li key={field}>
                    <span className="font-medium">{field}</span>: {msgs.join(". ")}
                  </li>
                ))}
              </ul>
            )}
          </ErrorBanner>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          {stations.length === 0 && data ? (
            <Card>
              <EmptyState title="No stations yet">
                Add one on the right. A station is the licensed callsign and grid
                that QSOs are logged under.
              </EmptyState>
            </Card>
          ) : (
            stations.map((station) => (
              <StationCard
                key={station.id}
                station={station}
                onChanged={reload}
                onError={handle}
                canEdit={canEdit}
                canAdmin={canAdmin}
              />
            ))
          )}
        </div>

        <div>
          {canEdit ? (
            <NewStationCard onCreated={reload} onError={handle} />
          ) : (
            <Card title="Add station">
              <p className="text-sm text-fg-subtle">
                Your account is read-only. Ask an admin for the OPERATOR role to
                manage stations.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function StationCard({
  station,
  onChanged,
  onError,
  canEdit,
  canAdmin,
}: {
  station: Station;
  onChanged: () => void;
  onError: (e: unknown) => void;
  canEdit: boolean;
  canAdmin: boolean;
}) {
  const qsoCount = station._count?.qsos ?? 0;

  const [editing, setEditing] = useState(false);
  const [callsign, setCallsign] = useState(station.callsign);
  const [grid, setGrid] = useState(station.grid);
  const [saving, setSaving] = useState(false);

  async function deleteStation() {
    if (!window.confirm(`Delete station ${station.callsign}?`)) return;
    try {
      await apiDelete(`/api/stations/${station.id}`);
      onChanged();
    } catch (err) {
      onError(err);
    }
  }

  async function save() {
    setSaving(true);
    try {
      await apiPatch(`/api/stations/${station.id}`, { callsign, grid });
      setEditing(false);
      onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    // Reset to what the server has, so cancelling twice can't leave stale edits
    // sitting in the fields.
    setCallsign(station.callsign);
    setGrid(station.grid);
    setEditing(false);
  }

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <h2 className="font-display text-lg tracking-wide">
            {station.callsign}
          </h2>
          <Badge tone="accent">{station.grid}</Badge>
          <span className="text-xs text-fg-subtle tnum">
            {qsoCount.toLocaleString()} QSO{qsoCount === 1 ? "" : "s"}
          </span>
        </div>
      }
      actions={
        <div className="flex items-center gap-2">
          {canEdit && !editing && (
            <Button onClick={() => setEditing(true)}>Edit</Button>
          )}
          {/* Station deletion cascades operators, so it's ADMIN-only —
              matching the role required by DELETE /api/stations/[id]. */}
          {/* DISABLED when the station holds contacts, rather than merely explained in a
              tooltip. The API refuses this with a 409 — deleting a station cascades its
              operators and would orphan the log — so an enabled button here is a button
              that cannot work, and the only way to discover that was to press it and read
              an error. A tooltip nobody hovers is not a guard. */}
          {canAdmin && (
            <Button
              variant="danger"
              disabled={qsoCount > 0}
              onClick={() => void deleteStation()}
              title={
                qsoCount > 0
                  ? `${qsoCount.toLocaleString()} logged contacts belong to this station, so it cannot be deleted. Move or delete them first.`
                  : "Delete this station and its operators"
              }
            >
              Delete
            </Button>
          )}
        </div>
      }
    >
      {editing && (
        <form
          className="mb-5 pb-5 border-b border-line grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label="Callsign" htmlFor={`edit-call-${station.id}`}>
            <Input
              id={`edit-call-${station.id}`}
              value={callsign}
              onChange={(e) => setCallsign(e.target.value.toUpperCase())}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Grid square"
            htmlFor={`edit-grid-${station.id}`}
            hint="Maidenhead, e.g. EN61 or EN61jj"
          >
            <Input
              id={`edit-grid-${station.id}`}
              value={grid}
              onChange={(e) => setGrid(e.target.value.toUpperCase())}
              autoComplete="off"
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button type="button" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <h3 className="text-xs uppercase tracking-wide text-fg-muted mb-2">
            Operators
          </h3>
          {station.operators.length === 0 ? (
            <p className="text-sm text-fg-subtle mb-3">None yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line mb-3">
              {station.operators.map((op) => (
                <li
                  key={op.id}
                  className="flex items-center gap-2 py-1.5 text-sm"
                >
                  <span className="font-display tracking-wide">
                    {op.callsign}
                  </span>
                  <span className="text-fg-muted">{op.name}</span>
                  <Badge
                    tone={op.role === "ADMIN" ? "accent" : "neutral"}
                    className="ml-auto"
                  >
                    {op.role}
                  </Badge>
                  {canAdmin && (
                    <button
                      type="button"
                      // A bare ✕ in the subtlest colour available, with no accessible
                      // name — invisible to a screen reader and nearly so to everyone
                      // else. The seeded sample operators sat here unnoticed long enough
                      // to be reported as stations that could not be removed.
                      aria-label={`Remove operator ${op.callsign}`}
                      title={`Remove operator ${op.callsign} from this station`}
                      className="text-fg-muted hover:text-danger text-xs px-1 rounded-sm focus-visible:outline-2 focus-visible:outline-accent-bright"
                      onClick={async () => {
                        if (!window.confirm(`Remove operator ${op.callsign}?`))
                          return;
                        try {
                          await apiDelete(`/api/operators/${op.id}`);
                          onChanged();
                        } catch (err) {
                          onError(err);
                        }
                      }}
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <NewOperatorForm
              stationId={station.id}
              onCreated={onChanged}
              onError={onError}
            />
          )}
        </div>

      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function NewStationCard({
  onCreated,
  onError,
}: {
  onCreated: () => void;
  onError: (e: unknown) => void;
}) {
  const [callsign, setCallsign] = useState("");
  const [grid, setGrid] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Card title="Add station">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await apiPost("/api/stations", { callsign, grid });
            setCallsign("");
            setGrid("");
            onCreated();
          } catch (err) {
            onError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Callsign" htmlFor="new-station-call" required>
          <Input
            id="new-station-call"
            value={callsign}
            onChange={(e) => setCallsign(e.target.value.toUpperCase())}
            placeholder="K9XYZ"
            spellCheck={false}
            className="font-display tracking-wide"
          />
        </Field>
        <Field
          label="Grid square"
          htmlFor="new-station-grid"
          required
          hint="Maidenhead, 4 or 6 characters"
        >
          <Input
            id="new-station-grid"
            value={grid}
            onChange={(e) => setGrid(e.target.value.toUpperCase())}
            placeholder="EN61"
            spellCheck={false}
            className="tnum"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Adding…" : "Add station"}
        </Button>
      </form>
    </Card>
  );
}

function NewOperatorForm({
  stationId,
  onCreated,
  onError,
}: {
  stationId: string;
  onCreated: () => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [callsign, setCallsign] = useState("");
  const [role, setRole] = useState<string>("OPERATOR");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await apiPost("/api/operators", { name, callsign, role, stationId });
          setName("");
          setCallsign("");
          onCreated();
        } catch (err) {
          onError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input
        value={callsign}
        onChange={(e) => setCallsign(e.target.value.toUpperCase())}
        placeholder="Callsign"
        spellCheck={false}
        className="w-28"
      />
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        className="w-32"
      />
      <Select
        value={role}
        onChange={(e) => setRole(e.target.value)}
        className="w-28"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </Select>
      <Button type="submit" disabled={busy}>
        Add op
      </Button>
    </form>
  );
}

// THIS WAS MISSING, and had been since the page was written.
//
// Without it the page has no `getServerSideProps`, so Next serves it with no props: no
// session reaches the client, `useUser()` returns null, and the page renders as though
// nobody is signed in — reported as "when I click on station the page doesn't recognise my
// login like it's a public page", which is exactly what was happening. `withPageAuth` was
// imported at the top and never called.
//
// No data was exposed: every endpoint this page calls is guarded server-side on its own, so
// an unauthenticated visitor got a shell with empty tables. What was broken is the session,
// and with it every control gated on `useCan`.
export const getServerSideProps = withPageAuth({ role: "OPERATOR" });
