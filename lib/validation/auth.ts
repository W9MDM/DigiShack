import { z } from "zod";

import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { ROLES } from "@/lib/validation/station";

const EMAIL = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(191)
  .email("Not a valid email address");

const PASSWORD = z
  .string()
  .min(
    MIN_PASSWORD_LENGTH,
    `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  )
  // Guards against a pathological input being fed to a memory-hard KDF.
  .max(1024, "Password is too long");

const CALLSIGN = z
  .string()
  .trim()
  .toUpperCase()
  .max(32)
  .regex(/^[A-Z0-9/]*$/, "Callsign may contain only letters, digits and '/'");

export const loginSchema = z.object({
  email: EMAIL,
  // Not PASSWORD: a length rule on login would leak the policy and reject
  // legacy passwords. Any non-empty string gets verified and fails normally.
  password: z.string().min(1, "Password is required").max(1024),
});

/** First-run only. The account created is always ADMIN. */
export const setupSchema = z.object({
  email: EMAIL,
  name: z.string().trim().min(1, "Name is required").max(120),
  callsign: CALLSIGN.optional(),
  password: PASSWORD,
  /**
   * THE STATION callsign and grid — what the radio will transmit.
   *
   * Required, and distinct from the operator's personal `callsign` above, which is only a
   * label on a user account. This one is put on the air.
   *
   * It is asked here because the alternative was worse: the station used to be created by
   * `prisma/seed.ts`, which hardcoded one. Anybody who ran the seed inherited somebody
   * else's callsign and would have transmitted under it — which is not a configuration
   * mistake but an illegal transmission. There is no sensible default for this field and
   * pretending otherwise is the whole problem, so there is none.
   */
  stationCallsign: CALLSIGN,
  stationGrid: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-R]{2}[0-9]{2}([A-X]{2})?$/i, "That is not a Maidenhead grid square")
    .transform((g) => g.slice(0, 4).toUpperCase() + g.slice(4).toLowerCase()),
});

export const createUserSchema = z.object({
  email: EMAIL,
  name: z.string().trim().min(1, "Name is required").max(120),
  callsign: CALLSIGN.optional(),
  password: PASSWORD,
  role: z.enum(ROLES).default("VIEWER"),
});

export const updateUserSchema = z.object({
  email: EMAIL.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  callsign: CALLSIGN.nullish(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  /** Setting this revokes every existing session for that user. */
  password: PASSWORD.optional(),
});

/** "Forgot password" request. Just the address; the response never varies with it. */
export const forgotSchema = z.object({
  email: EMAIL,
});

/** Redeeming an emailed reset link. */
export const resetSchema = z.object({
  token: z.string().min(20).max(128),
  password: PASSWORD,
});

/** A signed-in user changing their own password. */
export const changePasswordSchema = z.object({
  // Like login's password: no length rule, or a legacy short password could never
  // be rotated away — the one action that should always be possible.
  currentPassword: z.string().min(1, "Current password is required").max(1024),
  newPassword: PASSWORD,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type SetupInput = z.infer<typeof setupSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
