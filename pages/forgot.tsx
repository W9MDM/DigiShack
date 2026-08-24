import Link from "next/link";
import { useState } from "react";

import { Button, ErrorBanner, Field, Input } from "@/components/ui/primitives";
import { ApiError, apiPost } from "@/lib/client/api";

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
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ detail: string }>("/api/auth/forgot", { email });
      setSent(r.detail);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Request failed"));
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="flex items-baseline gap-1.5 justify-center mb-1">
        <span className="font-display text-3xl uppercase tracking-wider">Digi</span>
        <span className="font-display text-3xl uppercase tracking-wider text-accent-bright">
          Shack
        </span>
      </div>
      <p className="text-center text-sm text-fg-subtle mb-6">Reset your password</p>

      {error && (
        <div className="mb-4">
          <ErrorBanner>{error.message}</ErrorBanner>
        </div>
      )}

      {sent ? (
        <div className="bg-surface border border-line rounded-md p-5 text-sm">
          <p>{sent}</p>
          <p className="mt-3 text-fg-subtle">
            No email after a few minutes? Check spam, or ask an admin to reset it from
            the Users page.
          </p>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 bg-surface border border-line rounded-md p-5"
        >
          <Field label="Email" htmlFor="email" required>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </Field>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Sending…" : "Email me a reset link"}
          </Button>
        </form>
      )}

      <p className="text-center text-sm text-fg-subtle mt-4">
        <Link href="/login" className="text-accent-bright underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
