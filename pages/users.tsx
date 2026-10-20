import { useState } from "react";

import { SettingsLayout } from "@/components/settings/SettingsLayout";

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
import type { ListResponse, ResetAttempt, Role, User } from "@/lib/types";
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
    <SettingsLayout>
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

      {/* Reset requests, under the accounts they are about. Full width rather than beside
          the form: the IP and user-agent columns are the point and they need the room. */}
      <div className="mt-5">
        <ResetAttemptsCard />
      </div>
    </SettingsLayout>
  );
}

/**
 * Every "forgot password" request, and where it came from.
 *
 * "in the admin UI log password reset requests and the ip they came from" — asked after an
 * afternoon spent establishing over SSH, through pm2, that four requests had reached the
 * server that day and all four were mine. That evidence should have been this table.
 *
 * WHY IT SHOWS THE OUTCOME AND NOT JUST THE REQUEST. The endpoint's HTTP response is
 * identical for every case by design, so that nobody can use the login page to discover
 * which addresses have accounts. That makes the server the only place the truth exists, and
 * the four outcomes are four completely different faults:
 *
 *   sent         the mail left the building — if it did not arrive, look at the mailbox
 *   no-account   the address does not match an active account, so nothing was ever sent
 *   throttled    eight attempts spent the budget; nothing was sent and nothing used to
 *                be logged either, which is what made this take an afternoon
 *   send-failed  SMTP refused it, and `detail` says what it said
 *
 * The IP is here because "my clicks do nothing" and "somebody is probing us" look identical
 * in a list of email addresses and completely different once you can see where they came
 * from. The user agent is here for the same reason: a browser fault is invisible from the
 * server except as the absence of a row, and a row with a strange agent is a clue.
 */
function ResetAttemptsCard() {
  const { data, error, reload } = useApi<ListResponse<ResetAttempt>>(
    "/api/auth/reset-attempts?limit=100",
  );
  const rows = data?.rows ?? [];

  const TONE: Record<string, "ok" | "warn" | "danger" | "info"> = {
    sent: "ok",
    "no-account": "info",
    throttled: "warn",
    "send-failed": "danger",
  };

  return (
    <Card
      title="Password reset requests"
      // The count is the first thing worth knowing: an empty table answers "did my click
      // reach the server at all", which was the actual question.
      actions={
        <button type="button" className="text-xs text-fg-subtle hover:text-accent-bright" onClick={reload}>
          Refresh
        </button>
      }
    >
      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {!error && rows.length === 0 && (
        <p className="text-sm text-fg-muted">
          No reset requests recorded. If someone has just used the &ldquo;Forgot
          password?&rdquo; link and nothing appears here, the request never reached the
          server &mdash; look at the browser rather than at the mail.
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-surface-2 text-left">
                {["When", "Address", "From", "Outcome", "Detail"].map((h) => (
                  <Th key={h}>{h}</Th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td className="tnum whitespace-nowrap text-fg-subtle">
                    {formatUtc(r.createdAt)}
                  </Td>
                  <Td className="text-fg-muted break-all">{r.email}</Td>
                  {/* tnum so a column of addresses lines up, break-all because IPv6 is long
                      and must not widen the table past a phone. Em dash rather than
                      "unknown": nothing upstream told us, and a word invites someone to
                      search for a host by that name. */}
                  <Td className="tnum whitespace-nowrap">
                    {r.ip ?? <span className="text-fg-subtle">&mdash;</span>}
                  </Td>
                  <Td>
                    <Badge tone={TONE[r.outcome] ?? "info"}>{r.outcome}</Badge>
                  </Td>
                  <Td className="text-fg-subtle break-all" title={r.userAgent ?? undefined}>
                    {r.detail ?? <span>&mdash;</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-fg-subtle">
        Kept for 30 days, newest 5,000. The response the caller sees never varies between
        these outcomes &mdash; that is deliberate, so the login page cannot be used to find
        out which addresses have accounts. This table is the only place the difference
        exists, which is why it is admin-only.
      </p>
    </Card>
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
