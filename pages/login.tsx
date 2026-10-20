import type { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { useState } from "react";

import { AuthLayout, AuthLink } from "@/components/auth/AuthLayout";
import { authErrorMessage, focusField } from "@/components/auth/form";
import { PasswordInput, TOUCH_TEXT } from "@/components/auth/PasswordInput";
import { Button, ErrorBanner, Field, Input } from "@/components/ui/primitives";
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
  const [error, setError] = useState<string | null>(null);
  const [offerSetup, setOfferSetup] = useState(false);

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
      // `busy` stays on: the navigation is the rest of this sign-in.
      window.location.href = safe;
    } catch (err) {
      setError(authErrorMessage(err, "Could not sign in"));
      setOfferSetup(
        err instanceof ApiError && Boolean(err.details && "needsSetup" in err.details),
      );
      setBusy(false);
      // Selected, so retyping replaces it.
      focusField("password", true);
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      links={<AuthLink href="/forgot">Forgot password?</AuthLink>}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {dbError && (
          <ErrorBanner>
            Can&apos;t reach the database. Check <code>DATABASE_URL</code> and that MySQL
            is running.
          </ErrorBanner>
        )}
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

        <Field label="Password" htmlFor="password">
          <PasswordInput
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
          Sign in
        </Button>

        {offerSetup && (
          <p className="text-center text-sm">
            <AuthLink href="/setup">Run first-time setup</AuthLink>
          </p>
        )}
      </form>
    </AuthLayout>
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
