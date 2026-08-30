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
import { ApiError, apiDelete, apiPatch, apiPost, useApi } from "@/lib/client/api";
import { formatUtc } from "@/lib/time";
import type { ListResponse, Role } from "@/lib/types";

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  role: Role;
  active: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const ROLE_HELP: Record<string, string> = {
  VIEWER: "Read-only: list QSOs, stats, awards, DXCC lookups",
  OPERATOR: "Read plus log QSOs and ingest ADIF",
};

export default function ApiKeysPage() {
  const { data, error, reload } = useApi<ListResponse<ApiKeyRow>>("/api/api-keys");
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function fail(err: unknown) {
    setActionError(
      err instanceof ApiError ? err : new ApiError(0, "Request failed"),
    );
  }

  const keys = data?.rows ?? [];

  return (
    <>
      <ToolTabs />
      <PageHeader
        title="API keys"
        subtitle="Bearer tokens for the public /api/v1 surface"
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {actionError && (
        <div className="mb-4">
          <ErrorBanner>{actionError.message}</ErrorBanner>
        </div>
      )}

      {newToken && (
        <div className="mb-6 border border-accent/50 bg-accent/10 rounded-md p-4">
          <p className="font-display text-base uppercase tracking-wide text-accent-bright mb-1">
            Copy this token now
          </p>
          <p className="text-sm text-fg-muted mb-3">
            It is stored only as a SHA-256 hash and cannot be shown again. If you
            lose it, delete the key and create another.
          </p>
          <div className="flex gap-2">
            <code className="flex-1 bg-bg border border-line rounded-sm px-2 py-1.5 font-mono text-xs break-all">
              {newToken}
            </code>
            <Button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(newToken);
                  setCopied(true);
                } catch {
                  // Clipboard is unavailable over plain HTTP on some browsers —
                  // the token is on screen either way.
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button variant="ghost" onClick={() => setNewToken(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 border border-line rounded-md overflow-x-auto bg-surface">
          {keys.length === 0 ? (
            <p className="p-4 text-sm text-fg-subtle">
              No keys yet. Create one to let a third-party client reach the API.
            </p>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-surface-2 text-left">
                  {["Name", "Token", "Role", "Status", "Last used", "Expires", ""].map(
                    (h) => (
                      <Th key={h} size="lg">
                        {h}
                      </Th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {keys.map((k) => {
                  const expired =
                    k.expiresAt !== null && new Date(k.expiresAt) <= new Date();
                  return (
                    <tr key={k.id} className={k.active && !expired ? "" : "opacity-55"}>
                      <Td size="lg">{k.name}</Td>
                      <Td size="lg" className="font-mono text-xs text-fg-subtle">
                        {k.prefix}…
                      </Td>
                      <Td size="lg">
                        <Select
                          value={k.role}
                          aria-label={`Role for the API key ${k.name}`}
                          title={ROLE_HELP[k.role]}
                          onChange={async (e) => {
                            setActionError(null);
                            try {
                              await apiPatch(`/api/api-keys/${k.id}`, {
                                role: e.target.value,
                              });
                              reload();
                            } catch (err) {
                              fail(err);
                            }
                          }}
                          className="w-32"
                        >
                          {["VIEWER", "OPERATOR"].map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      </Td>
                      <Td size="lg">
                        {expired ? (
                          <Badge tone="warn">Expired</Badge>
                        ) : k.active ? (
                          <Badge tone="ok">Active</Badge>
                        ) : (
                          <Badge tone="danger">Revoked</Badge>
                        )}
                      </Td>
                      <Td size="lg" className="tnum text-fg-subtle whitespace-nowrap">
                        {k.lastUsedAt ? formatUtc(k.lastUsedAt) : "never"}
                      </Td>
                      <Td size="lg" className="tnum text-fg-subtle whitespace-nowrap">
                        {k.expiresAt ? formatUtc(k.expiresAt) : "—"}
                      </Td>
                      <Td size="lg">
                        <div className="flex gap-2 justify-end">
                          <button
                            type="button"
                            className="text-xs text-fg-subtle hover:text-warn"
                            onClick={async () => {
                              setActionError(null);
                              try {
                                await apiPatch(`/api/api-keys/${k.id}`, {
                                  active: !k.active,
                                });
                                reload();
                              } catch (err) {
                                fail(err);
                              }
                            }}
                          >
                            {k.active ? "Revoke" : "Re-enable"}
                          </button>
                          <button
                            type="button"
                            className="text-xs text-fg-subtle hover:text-danger"
                            onClick={async () => {
                              if (!window.confirm(`Delete key "${k.name}"?`)) return;
                              setActionError(null);
                              try {
                                await apiDelete(`/api/api-keys/${k.id}`);
                                reload();
                              } catch (err) {
                                fail(err);
                              }
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <NewKeyCard
            onCreated={(token) => {
              setNewToken(token);
              setCopied(false);
              reload();
            }}
            onError={fail}
          />

          <Card title="Using a key">
            <p className="text-sm text-fg-muted mb-2">
              Send it as a bearer token:
            </p>
            <pre className="bg-bg border border-line rounded-sm p-2 font-mono text-[11px] overflow-x-auto text-fg-muted">
{`curl -H 'Authorization: Bearer dsk_…' \\
  https://host/api/v1/qsos?take=5

# Ingest ADIF
curl -X POST \\
  -H 'Authorization: Bearer dsk_…' \\
  -H 'Content-Type: text/plain' \\
  --data-binary @log.adi \\
  'https://host/api/v1/adif?stationId=…'`}
            </pre>
            <p className="text-xs text-fg-subtle mt-2">
              <code>GET /api/v1</code> returns a machine-readable list of every
              endpoint. Keys cannot hold ADMIN, so they can never reach user
              management, settings or the updater.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

function NewKeyCard({
  onCreated,
  onError,
}: {
  onCreated: (token: string) => void;
  onError: (e: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("VIEWER");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Card title="Create a key">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const res = await apiPost<{ token: string }>("/api/api-keys", {
              name,
              role,
              expiresInDays: expires ? Number(expires) : null,
            });
            setName("");
            setExpires("");
            onCreated(res.token);
          } catch (err) {
            onError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name" htmlFor="k-name" required hint="What will use this key">
          <Input
            id="k-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="GridTracker on shack PC"
            required
          />
        </Field>
        <Field label="Role" htmlFor="k-role" hint={ROLE_HELP[role]}>
          <Select
            id="k-role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="VIEWER">VIEWER</option>
            <option value="OPERATOR">OPERATOR</option>
          </Select>
        </Field>
        <Field
          label="Expires in (days)"
          htmlFor="k-exp"
          hint="Leave blank for no expiry"
        >
          <Input
            id="k-exp"
            value={expires}
            onChange={(e) => setExpires(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            className="tnum"
            placeholder="365"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Creating…" : "Create key"}
        </Button>
      </form>
    </Card>
  );
}

export const getServerSideProps = withPageAuth({ role: "ADMIN" });
