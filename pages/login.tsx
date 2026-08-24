import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { useState } from "react";

import {
  Button,
  ErrorBanner,
  Field,
  Input,
} from "@/components/ui/primitives";
import { getAuth, needsSetup } from "@/lib/auth/session";
import { ApiError, apiPost } from "@/lib/client/api";

interface Props {
  dbError: boolean;
}

export default function LoginPage({ dbError }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/auth/login", { email, password });
      // `next` comes from withPageAuth's redirect. Only relative paths are
      // followed — an absolute URL here would be an open redirect.
      const next = typeof router.query.next === "string" ? router.query.next : "/";
      const safe = next.startsWith("/") && !next.startsWith("//") ? next : "/";
      window.location.href = safe;
    } catch (err) {
      setError(
        err instanceof ApiError ? err : new ApiError(0, "Could not sign in"),
      );
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <div className="flex items-baseline gap-1.5 justify-center mb-1">
        <span className="font-display text-3xl uppercase tracking-wider">
          Digi
        </span>
        <span className="font-display text-3xl uppercase tracking-wider text-accent-bright">
          Shack
        </span>
      </div>
      <p className="text-center text-sm text-fg-subtle mb-6">Sign in to continue</p>

      {dbError && (
        <div className="mb-4">
          <ErrorBanner>
            Can&apos;t reach the database. Check <code>DATABASE_URL</code> and that
            MySQL is running.
          </ErrorBanner>
        </div>
      )}

      {error && (
        <div className="mb-4">
          <ErrorBanner>{error.message}</ErrorBanner>
        </div>
      )}

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

        <Field label="Password" htmlFor="password" required>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>

        <p className="text-center text-xs text-fg-subtle -mt-1">
          <Link href="/forgot" className="hover:text-accent-bright underline">
            Forgot password?
          </Link>
        </p>
      </form>

      {error?.details && "needsSetup" in error.details && (
        <p className="text-center text-sm text-fg-subtle mt-4">
          <Link href="/setup" className="text-accent-bright underline">
            Run first-time setup
          </Link>
        </p>
      )}
    </div>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  // Already signed in — no reason to show the form.
  try {
    if (await getAuth(ctx.req)) {
      return { redirect: { destination: "/", permanent: false } };
    }
    if (await needsSetup()) {
      return { redirect: { destination: "/setup", permanent: false } };
    }
  } catch {
    // Surface a DB outage on the page rather than looping through redirects.
    return { props: { dbError: true } };
  }

  return { props: { dbError: ctx.query.error === "database" } };
};
