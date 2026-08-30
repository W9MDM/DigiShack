import { useState } from "react";

import { ToolTabs } from "@/components/settings/ToolTabs";

import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
  Td,
  Th,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { ApiError, apiDelete, apiPatch, apiPost, useApi } from "@/lib/client/api";
import { useUser } from "@/lib/client/session";
import { formatUtc } from "@/lib/time";
import type { ListResponse, Role, User } from "@/lib/types";
import { ROLES } from "@/lib/validation/station";

const ROLE_HELP: Record<Role, string> = {
  VIEWER: "Read-only — can browse the log but change nothing",
  OPERATOR: "Can log and edit QSOs, stations and operators",
  ADMIN: "Everything, including user management",
};

export default function UsersPage() {
  const me = useUser();
  const { data, error, reload } = useApi<ListResponse<User>>("/api/users");
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const users = data?.rows ?? [];

  function handle(err: unknown) {
    setActionError(
      err instanceof ApiError ? err : new ApiError(0, "Request failed"),
    );
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setActionError(null);
    try {
      await apiPatch(`/api/users/${id}`, body);
      reload();
    } catch (err) {
      handle(err);
    }
  }

  return (
    <>
      <ToolTabs />

      <PageHeader
        title="Users"
        subtitle="Login accounts and their roles"
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}

      {actionError && (
        <div className="mb-4">
          <ErrorBanner>
            {actionError.message}
            {actionError.details && (
              <ul className="mt-1 list-disc list-inside">
                {Object.entries(actionError.details).map(([f, msgs]) => (
                  <li key={f}>
                    <span className="font-medium">{f}</span>: {msgs.join(". ")}
                  </li>
                ))}
              </ul>
            )}
          </ErrorBanner>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 border border-line rounded-md overflow-x-auto bg-surface">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-surface-2 text-left">
                {["User", "Email", "Role", "Status", "Last login", "Sessions", ""].map(
                  (h) => (
                    <Th key={h} size="lg">
                      {h}
                    </Th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((u) => {
                const isMe = u.id === me?.id;
                return (
                  <tr key={u.id} className={u.active ? "" : "opacity-55"}>
                    <Td size="lg">
                      <div className="flex items-center gap-2">
                        {u.callsign && (
                          <span className="font-display tracking-wide">
                            {u.callsign}
                          </span>
                        )}
                        <span className="text-fg-muted">{u.name}</span>
                        {isMe && <Badge tone="info">You</Badge>}
                      </div>
                    </Td>
                    <Td size="lg" className="text-fg-muted">{u.email}</Td>
                    <Td size="lg">
                      <Select
                        value={u.role}
                        title={ROLE_HELP[u.role]}
                        onChange={(e) => void patch(u.id, { role: e.target.value })}
                        className="w-32"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td size="lg">
                      {u.active ? (
                        <Badge tone="ok">Active</Badge>
                      ) : (
                        <Badge tone="danger">Disabled</Badge>
                      )}
                    </Td>
                    <Td size="lg" className="tnum text-fg-subtle whitespace-nowrap">
                      {u.lastLoginAt ? formatUtc(u.lastLoginAt) : "never"}
                    </Td>
                    <Td size="lg" className="tnum text-fg-subtle">
                      {u._count?.sessions ?? 0}
                    </Td>
                    <Td size="lg">
                      <div className="flex items-center gap-1.5 justify-end">
                        <button
                          type="button"
                          className="text-xs text-fg-subtle hover:text-accent-bright"
                          onClick={() => {
                            const pw = window.prompt(
                              `New password for ${u.email} (min ${MIN_PASSWORD_LENGTH} characters).\n\nThis signs them out of every device.`,
                            );
                            if (pw) void patch(u.id, { password: pw });
                          }}
                        >
                          Reset password
                        </button>
                        <button
                          type="button"
                          className="text-xs text-fg-subtle hover:text-warn"
                          onClick={() => {
                            const next = !u.active;
                            if (
                              !next &&
                              !window.confirm(
                                `Disable ${u.email}? They'll be signed out immediately.`,
                              )
                            ) {
                              return;
                            }
                            void patch(u.id, { active: next });
                          }}
                        >
                          {u.active ? "Disable" : "Enable"}
                        </button>
                        {!isMe && (
                          <button
                            type="button"
                            className="text-xs text-fg-subtle hover:text-danger"
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  `Delete ${u.email}? Their logged QSOs are kept.`,
                                )
                              ) {
                                return;
                              }
                              setActionError(null);
                              try {
                                await apiDelete(`/api/users/${u.id}`);
                                reload();
                              } catch (err) {
                                handle(err);
                              }
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div>
          <NewUserCard onCreated={reload} onError={handle} />
        </div>
      </div>
    </>
  );
}

function NewUserCard({
  onCreated,
  onError,
}: {
  onCreated: () => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [callsign, setCallsign] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<string>("OPERATOR");
  const [busy, setBusy] = useState(false);

  return (
    <Card title="Add user">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await apiPost("/api/users", {
              name,
              callsign: callsign || undefined,
              email,
              password,
              role,
            });
            setName("");
            setCallsign("");
            setEmail("");
            setPassword("");
            onCreated();
          } catch (err) {
            onError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name" htmlFor="nu-name" required>
          <Input
            id="nu-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="Callsign" htmlFor="nu-call" hint="Optional">
          <Input
            id="nu-call"
            value={callsign}
            onChange={(e) => setCallsign(e.target.value.toUpperCase())}
            spellCheck={false}
            className="font-display tracking-wide"
          />
        </Field>
        <Field label="Email" htmlFor="nu-email" required>
          <Input
            id="nu-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            required
          />
        </Field>
        <Field
          label="Password"
          htmlFor="nu-pw"
          required
          hint={`At least ${MIN_PASSWORD_LENGTH} characters`}
        >
          <Input
            id="nu-pw"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
        </Field>
        <Field label="Role" htmlFor="nu-role" hint={ROLE_HELP[role as Role]}>
          <Select
            id="nu-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Creating…" : "Create user"}
        </Button>
      </form>
    </Card>
  );
}

export const getServerSideProps = withPageAuth({ role: "ADMIN" });
