import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";

import { Button, ErrorBanner, Field, Input } from "@/components/ui/primitives";
import { ApiError, apiPost } from "@/lib/client/api";

/** The page an emailed reset link opens: choose the new password, twice. */
export default function ResetPasswordPage() {
  const router = useRouter();
  const token = typeof router.query.token === "string" ? router.query.token : "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/auth/reset", { token, password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Reset failed");
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
      <p className="text-center text-sm text-fg-subtle mb-6">Choose a new password</p>

      {error && (
        <div className="mb-4">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}

      {done ? (
        <div className="bg-surface border border-line rounded-md p-5 text-sm">
          <p>Password changed, and every signed-in device has been signed out.</p>
          <p className="mt-3">
            <Link href="/login" className="text-accent-bright underline">
              Sign in with the new password
            </Link>
          </p>
        </div>
      ) : !token ? (
        <div className="bg-surface border border-line rounded-md p-5 text-sm">
          <p>
            This page needs the link from the reset email — it carries a one-time
            token.
          </p>
          <p className="mt-3">
            <Link href="/forgot" className="text-accent-bright underline">
              Request a reset link
            </Link>
          </p>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="flex flex-col gap-4 bg-surface border border-line rounded-md p-5"
        >
          <Field label="New password" htmlFor="password" required>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
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
            {busy ? "Saving…" : "Set new password"}
          </Button>
        </form>
      )}
    </div>
  );
}
