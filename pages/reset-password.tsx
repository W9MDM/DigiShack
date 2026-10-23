import { useRouter } from "next/router";
import { useEffect, useState } from "react";

import { AuthLayout, AuthLink } from "@/components/auth/AuthLayout";
import { authErrorMessage, focusField } from "@/components/auth/form";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { Button, ErrorBanner, Field } from "@/components/ui/primitives";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { apiPost } from "@/lib/client/api";

/** The page an emailed reset link opens: choose the new password, twice. */
export default function ResetPasswordPage() {
  const router = useRouter();
  const token = typeof router.query.token === "string" ? router.query.token : "";
  // This page is statically rendered, so the query is empty until hydration. Judging the
  // link before then flashed "this page needs the link" at everyone who had it.
  const missingToken = router.isReady && !token;

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (done) document.getElementById("reset-done")?.focus();
  }, [done]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      focusField("confirm", true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/auth/reset", { token, password });
      setDone(true);
    } catch (err) {
      setError(authErrorMessage(err, "The reset failed. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={done ? "Password changed" : "Choose a new password"}
      links={
        done ? undefined : (
          <>
            <AuthLink href="/login">Back to sign in</AuthLink>
            <AuthLink href="/forgot">Request a new link</AuthLink>
          </>
        )
      }
    >
      {done ? (
        <div
          id="reset-done"
          tabIndex={-1}
          role="status"
          className="flex flex-col gap-3 text-sm focus:outline-none"
        >
          <p>Your password is changed, and every device that was signed in has been signed out.</p>
          <p>
            <AuthLink href="/login">Sign in with the new password</AuthLink>
          </p>
        </div>
      ) : missingToken ? (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            This page needs the link from the reset email — it carries a one-time token.
          </p>
          <p>
            <AuthLink href="/forgot">Request a reset link</AuthLink>
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <Field
            label="New password"
            htmlFor="password"
            hint={`At least ${MIN_PASSWORD_LENGTH} characters. A passphrase is fine — no symbols or capitals required.`}
          >
            <PasswordInput
              id="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setMismatch(false);
              }}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              autoFocus
              required
            />
          </Field>
          <Field
            label="New password, again"
            htmlFor="confirm"
            errors={mismatch ? ["The two passwords don't match"] : undefined}
          >
            <PasswordInput
              id="confirm"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setMismatch(false);
              }}
              autoComplete="new-password"
              required
            />
          </Field>
          <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
            Set new password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

// Rendered per request, not prebuilt, so the page carries this request's CSP nonce
// (proxy.ts, lib/security/csp.ts); a prebuilt page has none and its scripts would not run.
export function getServerSideProps() {
  return { props: {} };
}
