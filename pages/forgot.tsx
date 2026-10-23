import { useEffect, useState } from "react";

import { AuthLayout, AuthLink } from "@/components/auth/AuthLayout";
import { authErrorMessage } from "@/components/auth/form";
import { TOUCH_TEXT } from "@/components/auth/PasswordInput";
import { Button, ErrorBanner, Field, Input } from "@/components/ui/primitives";
import { apiPost } from "@/lib/client/api";

/**
 * "Forgot password" — ask for a reset link by email.
 *
 * The confirmation is the same whatever was typed, because the API's answer is: an
 * endpoint that says "sent!" only for real addresses is an account directory.
 */
export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The form, and the button that had focus, are gone once this appears.
  useEffect(() => {
    if (sent) document.getElementById("forgot-sent")?.focus();
  }, [sent]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ detail: string }>("/api/auth/forgot", { email });
      setSent(r.detail);
    } catch (err) {
      setError(authErrorMessage(err, "The request failed. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      description={
        sent ? undefined : "Enter the address you sign in with and a reset link will be emailed to it."
      }
      links={<AuthLink href="/login">Back to sign in</AuthLink>}
    >
      {sent ? (
        <div
          id="forgot-sent"
          tabIndex={-1}
          role="status"
          className="flex flex-col gap-3 text-sm focus:outline-none"
        >
          <p>{sent}</p>
          <p className="text-fg-muted">
            No email after a few minutes? Check spam, or ask an admin to reset it from the
            Users page.
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4">
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              required
              className={TOUCH_TEXT}
            />
          </Field>
          <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
            Email me a reset link
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
