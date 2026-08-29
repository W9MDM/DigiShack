import { useState } from "react";

import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { ApiError, apiPost } from "@/lib/client/api";
import { useUser } from "@/lib/client/session";

/**
 * The signed-in user's own account. Every role gets here — operators and viewers
 * have no Users page, and before this existed their only route to a new password
 * was asking an admin.
 */
export default function AccountPage() {
  const user = useUser();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setError("The two new passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await apiPost<{ revokedSessions: number }>("/api/users/me/password", {
        currentPassword: current,
        newPassword: next,
      });
      setDone(
        `Password changed. ${r.revokedSessions} signed-in device(s) were signed out; this one stays in.`,
      );
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Change failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Account"
        subtitle={user ? `Signed in as ${user.callsign ?? user.name} — ${user.email}` : ""}
      />

      <div className="max-w-md">
        <Card title="Change password">
          {error && (
            <div className="mb-4">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          {done && <p className="mb-4 text-sm text-ok">{done}</p>}

          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Current password" htmlFor="current" required>
              <Input
                id="current"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
            {/* The rule, BEFORE it is broken.
                
                Twelve characters and nothing else — no character classes, because length
                beats composition and a passphrase is both stronger and easier to
                remember. It was written down only in the schema, so the first an operator
                heard of it was a red box saying "Validation failed", which does not name
                a length or a rule or anything at all. */}
            <Field
              label="New password"
              htmlFor="next"
              required
              hint={`At least ${MIN_PASSWORD_LENGTH} characters. No capitals, digits or symbols required — a passphrase like "hebron clock tower" is fine, and stronger than a short one with punctuation in it.`}
            >
              <Input
                id="next"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>
            <Field label="New password, again" htmlFor="confirm" required>
              <Input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Changing…" : "Change password"}
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}

// VIEWER: the least-privileged role that exists — everyone signed in may manage
// their own credential.
export const getServerSideProps = withPageAuth({ role: "VIEWER" });
