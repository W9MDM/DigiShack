import type { GetServerSideProps } from "next";
import { useState } from "react";

import {
  Button,
  ErrorBanner,
  Field,
  Input,
} from "@/components/ui/primitives";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { needsSetup } from "@/lib/auth/session";
import { ApiError, apiPost } from "@/lib/client/api";

interface Props {
  minPasswordLength: number;
}

export default function SetupPage({ minPasswordLength }: Props) {
  const [name, setName] = useState("");
  const [callsign, setCallsign] = useState("");
  // THE STATION identity — what the radio puts on the air. Distinct from the operator's
  // own callsign above, which is only a label on this account.
  const [stationCallsign, setStationCallsign] = useState("");
  const [stationGrid, setStationGrid] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/auth/setup", {
        name,
        callsign: callsign || undefined,
        stationCallsign,
        stationGrid,
        email,
        password,
      });
      // The setup response signs you in, so go straight to the dashboard.
      window.location.href = "/";
    } catch (err) {
      setError(
        err instanceof ApiError ? err : new ApiError(0, "Could not complete setup"),
      );
      setBusy(false);
    }
  }

  const fieldErrors = (f: string) => error?.fieldErrors(f);

  return (
    <div className="w-full max-w-md">
      <div className="flex items-baseline gap-1.5 justify-center mb-1">
        <span className="font-display text-3xl uppercase tracking-wider">
          Digi
        </span>
        <span className="font-display text-3xl uppercase tracking-wider text-accent-bright">
          Shack
        </span>
      </div>
      <p className="text-center text-sm text-fg-subtle mb-6">
        First-time setup — create the admin account
      </p>

      {error && !error.details && (
        <div className="mb-4">
          <ErrorBanner>{error.message}</ErrorBanner>
        </div>
      )}

      <form
        onSubmit={submit}
        className="flex flex-col gap-4 bg-surface border border-line rounded-md p-5"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="name" required errors={fieldErrors("name")}>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </Field>

          <Field
            label="Callsign"
            htmlFor="callsign"
            errors={fieldErrors("callsign")}
            hint="Optional"
          >
            <Input
              id="callsign"
              value={callsign}
              onChange={(e) => setCallsign(e.target.value.toUpperCase())}
              spellCheck={false}
              className="font-display tracking-wide"
            />
          </Field>
        </div>

        {/* THE STATION. Asked here because there is no safe default and the radio needs
            one before it will start.

            This used to come from the optional seed script, which hardcoded a real
            operator's callsign — so anyone who ran the sample data would have transmitted
            under somebody else's identity. That is not a bad default, it is unidentified
            operation, and the fix is to ask rather than to guess. */}
        <div className="rounded-sm border border-line bg-bg-raised/40 p-3 flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-medium">Your station</h2>
            <p className="text-xs text-fg-subtle mt-0.5">
              What the radio transmits. There is no default for this and there never will
              be — transmitting under a callsign that is not yours is illegal, so DigiShack
              refuses to start the transmitter until this is set.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Station callsign"
              htmlFor="stationCallsign"
              required
              errors={fieldErrors("stationCallsign")}
              hint="Goes on the air"
            >
              <Input
                id="stationCallsign"
                value={stationCallsign}
                onChange={(e) => setStationCallsign(e.target.value.toUpperCase())}
                spellCheck={false}
                autoComplete="off"
                className="font-display tracking-wide"
              />
            </Field>
            <Field
              label="Grid square"
              htmlFor="stationGrid"
              required
              errors={fieldErrors("stationGrid")}
              hint="4 or 6 characters, e.g. FN31 or FN31pr"
            >
              <Input
                id="stationGrid"
                value={stationGrid}
                onChange={(e) => setStationGrid(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                className="font-display tracking-wide"
              />
            </Field>
          </div>
        </div>

        <Field label="Email" htmlFor="email" required errors={fieldErrors("email")}>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          required
          errors={fieldErrors("password")}
          hint={`At least ${minPasswordLength} characters — a passphrase beats a short complex one`}
        >
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={minPasswordLength}
            required
          />
        </Field>

        <Field
          label="Confirm password"
          htmlFor="confirm"
          required
          errors={mismatch ? ["Passwords don't match"] : undefined}
        >
          <Input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            aria-invalid={mismatch}
            required
          />
        </Field>

        <Button type="submit" variant="primary" disabled={busy || mismatch}>
          {busy ? "Creating…" : "Create admin account"}
        </Button>

        <p className="text-xs text-fg-subtle">
          This page closes itself permanently once an account exists. Further
          accounts are created by an admin from the Users page.
        </p>
      </form>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async () => {
  try {
    if (!(await needsSetup())) {
      // Setup is a one-shot. Anything else would be an open account-creation
      // endpoint on a web-facing install.
      return { redirect: { destination: "/login", permanent: false } };
    }
  } catch {
    return { redirect: { destination: "/login?error=database", permanent: false } };
  }

  return { props: { minPasswordLength: MIN_PASSWORD_LENGTH } };
};
