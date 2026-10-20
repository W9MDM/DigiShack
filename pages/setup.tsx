import type { GetServerSideProps } from "next";
import { useState } from "react";

import { AuthLayout, AuthLink } from "@/components/auth/AuthLayout";
import { authErrorMessage, focusField } from "@/components/auth/form";
import { PasswordInput, TOUCH_TEXT } from "@/components/auth/PasswordInput";
import { Button, ErrorBanner, Field, Input } from "@/components/ui/primitives";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { needsSetup } from "@/lib/auth/session";
import { ApiError, apiPost } from "@/lib/client/api";

interface Props {
  minPasswordLength: number;
}

/** Field ids in page order, so a failed submit can put the cursor on the first bad one. */
const FIELDS = [
  "name",
  "callsign",
  "email",
  "password",
  "confirm",
  "stationCallsign",
  "stationGrid",
] as const;
type FieldId = (typeof FIELDS)[number];
type FieldErrors = Partial<Record<FieldId, string[]>>;

export default function SetupPage({ minPasswordLength }: Props) {
  const [name, setName] = useState("");
  const [callsign, setCallsign] = useState("");
  // THE STATION identity — what the radio puts on the air. Distinct from the operator's
  // own callsign, which is only a label on this account.
  const [stationCallsign, setStationCallsign] = useState("");
  const [stationGrid, setStationGrid] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [alreadySetUp, setAlreadySetUp] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  /** Set a field and drop its stale error — it was about the old value. */
  const edit = (field: FieldId, set: (v: string) => void) => (v: string) => {
    set(v);
    setErrors((x) => {
      if (!x[field] && !(field === "password" && x.confirm)) return x;
      const next = { ...x };
      delete next[field];
      // A changed password makes the "don't match" verdict stale too.
      if (field === "password") delete next.confirm;
      return next;
    });
  };

  const confirmMismatch = (): boolean => confirm.length > 0 && password !== confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    setAlreadySetUp(false);
    if (confirmMismatch()) {
      setErrors((x) => ({ ...x, confirm: ["The two passwords don't match"] }));
      focusField("confirm", true);
      return;
    }
    setBusy(true);
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
      return;
    } catch (err) {
      const found: FieldErrors = {};
      if (err instanceof ApiError && err.details) {
        for (const f of FIELDS) {
          const msgs = err.fieldErrors(f);
          if (msgs?.length) found[f] = msgs;
        }
      }
      const first = FIELDS.find((f) => found[f]);
      if (first) {
        setErrors(found);
        setBanner("Some details need another look — see the highlighted fields.");
        focusField(first);
      } else {
        setBanner(authErrorMessage(err, "Could not complete setup. Try again."));
        setAlreadySetUp(err instanceof ApiError && err.status === 409);
      }
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Set up DigiShack"
      wide
      description="Create the admin account and name your station. This page closes for good once it is done; further accounts are added by an admin from the Users page."
    >
      <form onSubmit={submit} className="flex flex-col gap-6">
        {banner && (
          <ErrorBanner>
            {banner}
            {alreadySetUp && (
              <>
                {" "}
                <AuthLink href="/login">Go to sign in</AuthLink>
              </>
            )}
          </ErrorBanner>
        )}

        {/* min-w-0: a fieldset defaults to min-content width and would push a phone
            screen sideways. */}
        <fieldset className="min-w-0">
          <legend className="font-display text-base text-fg">Admin account</legend>
          <div className="mt-3 flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Your name" htmlFor="name" errors={errors.name}>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => edit("name", setName)(e.target.value)}
                  autoComplete="name"
                  autoFocus
                  required
                  className={TOUCH_TEXT}
                />
              </Field>
              <Field
                label="Your callsign"
                htmlFor="callsign"
                errors={errors.callsign}
                hint="Optional — a label on your account"
              >
                <Input
                  id="callsign"
                  value={callsign}
                  onChange={(e) => edit("callsign", setCallsign)(e.target.value.toUpperCase())}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className={`font-display tracking-wide ${TOUCH_TEXT}`}
                />
              </Field>
            </div>

            <Field label="Email" htmlFor="email" errors={errors.email} hint="You sign in with this">
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => edit("email", setEmail)(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                className={TOUCH_TEXT}
              />
            </Field>

            <Field
              label="Password"
              htmlFor="password"
              errors={errors.password}
              hint={`At least ${minPasswordLength} characters — a passphrase beats a short complex one`}
            >
              <PasswordInput
                id="password"
                value={password}
                onChange={(e) => edit("password", setPassword)(e.target.value)}
                autoComplete="new-password"
                minLength={minPasswordLength}
                required
              />
            </Field>

            <Field label="Confirm password" htmlFor="confirm" errors={errors.confirm}>
              <PasswordInput
                id="confirm"
                value={confirm}
                onChange={(e) => edit("confirm", setConfirm)(e.target.value)}
                onBlur={() => {
                  if (confirmMismatch()) {
                    setErrors((x) => ({ ...x, confirm: ["The two passwords don't match"] }));
                  }
                }}
                autoComplete="new-password"
                required
              />
            </Field>
          </div>
        </fieldset>

        {/* THE STATION. Asked here because there is no safe default and the radio needs
            one before it will start.

            This used to come from the optional seed script, which hardcoded a real
            operator's callsign — so anyone who ran the sample data would have transmitted
            under somebody else's identity. That is not a bad default, it is unidentified
            operation, and the fix is to ask rather than to guess. */}
        <fieldset className="min-w-0 rounded-sm border border-line bg-bg-raised/40 p-4">
          <legend className="px-1 font-display text-base text-fg">Your station</legend>
          <p className="text-sm text-fg-muted">
            What the radio transmits. There is no default for this and there never will be —
            transmitting under a callsign that is not yours is illegal, so DigiShack refuses
            to start the transmitter until this is set.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field
              label="Station callsign"
              htmlFor="stationCallsign"
              errors={errors.stationCallsign}
              hint="Goes on the air"
            >
              <Input
                id="stationCallsign"
                value={stationCallsign}
                onChange={(e) =>
                  edit("stationCallsign", setStationCallsign)(e.target.value.toUpperCase())
                }
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                required
                className={`font-display tracking-wide ${TOUCH_TEXT}`}
              />
            </Field>
            <Field
              label="Grid square"
              htmlFor="stationGrid"
              errors={errors.stationGrid}
              hint="4 or 6 characters, e.g. FN31 or FN31pr"
            >
              <Input
                id="stationGrid"
                value={stationGrid}
                onChange={(e) => edit("stationGrid", setStationGrid)(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                className={`font-display tracking-wide ${TOUCH_TEXT}`}
              />
            </Field>
          </div>
        </fieldset>

        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Create admin account
        </Button>
      </form>
    </AuthLayout>
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
