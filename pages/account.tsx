import Link from "next/link";
import { useState } from "react";

import { focusField, authErrorMessage } from "@/components/auth/form";
import { PasswordInput } from "@/components/auth/PasswordInput";
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { ApiError, apiPost } from "@/lib/client/api";
import { useUser, type SessionUser } from "@/lib/client/session";
import type { Role } from "@/lib/types";

const ROLE_SUMMARY: Record<Role, string> = {
  ADMIN: "Everything, including Settings and user accounts.",
  OPERATOR: "Logs contacts and operates the radio.",
  VIEWER: "Read-only — can look, cannot change anything.",
};

/**
 * The signed-in user's own account. Every role gets here — operators and viewers
 * have no Users page, and before this existed their only route to a new password
 * was asking an admin.
 */
export default function AccountPage() {
  const user = useUser();

  return (
    <>
      <PageHeader title="Account" subtitle="Who you are signed in as, and your password" />
      <div className="flex max-w-xl flex-col gap-4">
        {user && <Identity user={user} />}
        <ChangePassword email={user?.email ?? null} />
      </div>
    </>
  );
}

function Identity({ user }: { user: SessionUser }) {
  return (
    <Card title="Signed in as">
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-4 gap-y-3 text-sm">
        <dt className="text-fg-muted">Callsign</dt>
        <dd>
          {user.callsign ? (
            <span className="font-display text-base tracking-wide">{user.callsign}</span>
          ) : (
            <span className="text-fg-subtle">Not set</span>
          )}
        </dd>
        <dt className="text-fg-muted">Name</dt>
        <dd className="break-words">{user.name}</dd>
        <dt className="text-fg-muted">Email</dt>
        <dd className="break-all">{user.email}</dd>
        <dt className="text-fg-muted">Role</dt>
        <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge>{user.role}</Badge>
          <span className="text-fg-muted">{ROLE_SUMMARY[user.role]}</span>
        </dd>
      </dl>
      <p className="mt-4 text-sm text-fg-subtle">
        {user.role === "ADMIN" ? (
          <>
            Change these on the{" "}
            <Link href="/users" className="text-accent-bright underline underline-offset-2 hover:no-underline">
              Users
            </Link>{" "}
            page.
          </>
        ) : (
          "Only an admin can change these."
        )}
      </p>
    </Card>
  );
}

type PasswordField = "current" | "next" | "confirm";

function ChangePassword({ email }: { email: string | null }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<PasswordField, string[]>>>({});

  const clear = (field: PasswordField) =>
    setFieldErrors((x) => (x[field] ? { ...x, [field]: undefined } : x));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone("");
    if (next !== confirm) {
      setFieldErrors({ confirm: ["The two new passwords don't match"] });
      focusField("confirm", true);
      return;
    }
    setBusy(true);
    setFieldErrors({});
    try {
      const r = await apiPost<{ revokedSessions: number }>("/api/users/me/password", {
        currentPassword: current,
        newPassword: next,
      });
      // Every session is revoked, this one included, and this browser is then given a
      // fresh one — so the others are the count less one.
      const others = Math.max(0, r.revokedSessions - 1);
      setDone(
        others === 0
          ? "Password changed. You stay signed in here."
          : `Password changed. ${others} other device${others === 1 ? " was" : "s were"} signed out; this one stays signed in.`,
      );
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setFieldErrors({ current: [err.message] });
        focusField("current", true);
      } else if (err instanceof ApiError && err.fieldErrors("newPassword")?.length) {
        setFieldErrors({ next: err.fieldErrors("newPassword") });
        focusField("next", true);
      } else {
        setError(authErrorMessage(err, "The change failed. Try again."));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Change password">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {/* Tells a password manager which saved login the new password belongs to. */}
        {email && (
          <input type="email" autoComplete="username" value={email} readOnly hidden />
        )}
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {/* Always mounted, so the success sentence is announced when it arrives. */}
        <p role="status" className={done ? "text-sm text-ok" : "sr-only"}>
          {done}
        </p>

        <Field label="Current password" htmlFor="current" errors={fieldErrors.current}>
          <PasswordInput
            id="current"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
              clear("current");
            }}
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
          errors={fieldErrors.next}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. No capitals, digits or symbols required — a passphrase like "hebron clock tower" is fine, and stronger than a short one with punctuation in it.`}
        >
          <PasswordInput
            id="next"
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              clear("next");
              clear("confirm");
            }}
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            required
          />
        </Field>
        <Field label="New password, again" htmlFor="confirm" errors={fieldErrors.confirm}>
          <PasswordInput
            id="confirm"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              clear("confirm");
            }}
            autoComplete="new-password"
            required
          />
        </Field>
        <div>
          <Button type="submit" variant="primary" loading={busy}>
            Change password
          </Button>
        </div>
        <p className="text-sm text-fg-subtle">
          Changing it signs out every other device; this one stays signed in.
        </p>
      </form>
    </Card>
  );
}

// VIEWER: the least-privileged role that exists — everyone signed in may manage
// their own credential.
export const getServerSideProps = withPageAuth({ role: "VIEWER" });
