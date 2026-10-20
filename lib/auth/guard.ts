import type { Role } from "@prisma/client";
import type {
  GetServerSideProps,
  GetServerSidePropsContext,
  GetServerSidePropsResult,
} from "next";
import type { NextApiRequest, NextApiResponse } from "next";
import type { ServerResponse } from "node:http";

import { sendError } from "@/lib/api/respond";
import { getBooleanSetting } from "@/lib/settings";
import { getApiKeyIdentity } from "@/lib/auth/apikey";
import {
  type AuthContext,
  type AuthUser,
  getAuth,
  hasRole,
  needsSetup,
} from "@/lib/auth/session";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

import { flattenZodError } from "@/lib/api/respond";

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

export type AuthedHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
  auth: AuthContext,
) => Promise<void> | void;

export interface MethodSpec {
  /** Minimum role. VIEWER means "any signed-in user". */
  role: Role;
  handler: AuthedHandler;
  /**
   * Accept an API key bearer token as well as a session cookie. Only the public
   * /api/v1 surface sets this — the app's own admin routes stay cookie-only, so a
   * leaked key can never reach user management or the updater.
   */
  allowApiKey?: boolean;
}

/**
 * Like `route()` from lib/api/respond, but every method requires a session.
 *
 * Roles are a ladder — VIEWER < OPERATOR < ADMIN — so a GET marked VIEWER is
 * reachable by all three, and a DELETE marked ADMIN by admins only. Read methods
 * should be VIEWER and mutations OPERATOR, which is what makes VIEWER a genuinely
 * read-only account rather than one enforced by convention.
 */
export function authedRoute(
  handlers: Partial<Record<string, MethodSpec>>,
): (req: NextApiRequest, res: NextApiResponse) => Promise<void> {
  const allowed = Object.keys(handlers);

  return async (req, res) => {
    const spec = req.method ? handlers[req.method] : undefined;

    if (!spec) {
      res.setHeader("Allow", allowed.join(", "));
      sendError(res, 405, `Method ${req.method ?? "?"} not allowed`);
      return;
    }

    try {
      let auth: AuthContext | null;
      try {
        auth = await getAuth(req);
      } catch (err) {
        // The database not answering says nothing about whether this visitor is signed
        // in, so it must not come back as a 401. Refused all the same, and told to retry.
        console.error("[api-auth] session lookup failed:", err);
        sendSessionUnavailable(res);
        return;
      }

      // Fall back to an API key where the route allows one. Session first, so a
      // browser request is never charged to a key that happens to be present.
      if (!auth && spec.allowApiKey) {
        const key = await getApiKeyIdentity(req);
        if (key) {
          auth = {
            sessionId: `apikey:${key.id}`,
            user: {
              id: `apikey:${key.id}`,
              email: `${key.name} (API key)`,
              name: key.name,
              callsign: null,
              role: key.role,
            },
          };
        }
      }

      if (!auth) {
        if (spec.allowApiKey) {
          // A machine client gets a machine-readable answer, and the header it
          // should be using.
          res.setHeader("WWW-Authenticate", 'Bearer realm="DigiShack"');
          sendError(
            res,
            401,
            "Missing or invalid credentials. Send an API key as `Authorization: Bearer dsk_…` or `X-API-Key`.",
          );
          return;
        }

        // Tell the client whether the instance has ever been set up, so the UI
        // can send a first-run visitor to /setup instead of a useless login form.
        const setup = await needsSetup();
        sendError(
          res,
          401,
          setup ? "DigiShack has not been set up yet" : "Not signed in",
          { needsSetup: setup },
        );
        return;
      }

      if (!hasRole(auth.user, spec.role)) {
        sendError(
          res,
          403,
          `This action requires the ${spec.role} role or higher`,
          { role: auth.user.role, required: spec.role },
        );
        return;
      }

      await spec.handler(req, res, auth);
    } catch (err) {
      handleError(res, err);
    }
  };
}

/** Seconds a client is told to wait before asking again after a failed session lookup. */
export const SESSION_RETRY_AFTER_S = 5;

/** The API answer when a session could not be checked: refused, and not "signed out". */
function sendSessionUnavailable(res: NextApiResponse): void {
  res.setHeader("Retry-After", String(SESSION_RETRY_AFTER_S));
  res.setHeader("Cache-Control", "no-store");
  sendError(res, 503, "Could not check your session just now. Try again in a few seconds.", {
    retryable: true,
  });
}

// Same translation table as lib/api/respond's route(). Kept here rather than
// exported from there because authedRoute needs it inside its own try block.
function handleError(res: NextApiResponse, err: unknown): void {
  if (err instanceof ZodError) {
    sendError(res, 400, "Validation failed", flattenZodError(err));
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case "P2002":
        sendError(res, 409, "A record with these values already exists", {
          target: err.meta?.target,
        });
        return;
      case "P2003":
      case "P2025":
        sendError(res, 404, "Referenced record not found", {
          cause: err.meta?.cause ?? err.meta?.field_name,
        });
        return;
      case "P2000":
        sendError(res, 400, "A value is too long for its column", {
          column: err.meta?.column_name,
        });
        return;
    }
  }

  if (err instanceof Prisma.PrismaClientInitializationError) {
    console.error("[api] database unavailable:", err.message);
    sendError(
      res,
      503,
      "Database unavailable — check DATABASE_URL and that MySQL is running",
    );
    return;
  }

  console.error("[api] unhandled error:", err);
  sendError(res, 500, "Internal server error");
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface AuthPageProps {
  user: AuthUser;
  /**
   * UI feature flags, read server-side and handed to every guarded page.
   *
   * Injected here rather than fetched by the shell because the navigation is rendered on
   * the first paint: a client fetch would flash the Rig link in and out on every page load,
   * or hide it briefly on a station that has it switched on. Neither is acceptable for a
   * menu.
   *
   * They are SETTINGS, not environment variables — an operator turns the experimental page
   * on from the Settings screen, not by editing a file and restarting.
   */
  uiFlags: UiFlags;
}

export interface UiFlags {
  /** Show the experimental Rig page in the navigation. */
  rig: boolean;
}

/**
 * Read the UI flags. Defaults are the safe answer to "what should a fresh install show".
 *
 * A failure to read them must not blank the page: an unreachable database is already answered
 * by the retry page below, and anything subtler than that should degrade to the defaults
 * rather than throw inside a layout.
 */
async function readUiFlags(): Promise<UiFlags> {
  try {
    return { rig: await getBooleanSetting("ui.experimental.rig", false) };
  } catch {
    return { rig: false };
  }
}

/**
 * The page a guarded route serves when the session could not be checked.
 *
 * Self-contained HTML rather than a React page, because the thing that failed is the database
 * every page's props come from. It refreshes itself, so a blip clears without the operator
 * doing anything, and it sets no cookie. A client-side navigation's /_next/data request gets
 * the same 503; Next's router answers that with a full load of the URL, which lands here.
 */
function sendSessionUnavailablePage(res: ServerResponse): void {
  if (res.headersSent) return;
  res.statusCode = 503;
  res.setHeader("Retry-After", String(SESSION_RETRY_AFTER_S));
  // Not only for caches: Next's pages handler sets its own Cache-Control after props come
  // back unless one is already there, and setting a header on a finished response throws.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(SESSION_UNAVAILABLE_HTML);
}

const SESSION_UNAVAILABLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${SESSION_RETRY_AFTER_S}">
<title>Retrying · DigiShack</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font:16px/1.5 system-ui,sans-serif;background:#0b0b0d;color:#e8e8ea;padding:16px;box-sizing:border-box}
main{max-width:28rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0 0 1rem;color:#a8a8b0}
a{color:#ff6a4d}
</style></head><body><main>
<h1>Could not check your sign-in</h1>
<p>DigiShack did not get an answer from its database. You have not been signed out; this page
tries again in ${SESSION_RETRY_AFTER_S} seconds.</p>
<p><a href="">Try again now</a></p>
</main></body></html>
`;

/**
 * getServerSideProps guard. Redirects an unauthenticated visitor to /login (or
 * /setup on a fresh install), and bounces insufficient roles to the dashboard.
 *
 * Doing this server-side rather than in the browser means protected pages never
 * render, even for a moment, without a valid session.
 */
export function withPageAuth<P extends Record<string, unknown>>(
  opts: {
    role?: Role;
    inner?: (
      ctx: GetServerSidePropsContext,
      auth: AuthContext,
    ) => Promise<GetServerSidePropsResult<P>>;
  } = {},
): GetServerSideProps<P & AuthPageProps> {
  return async (ctx) => {
    let auth: AuthContext | null;
    try {
      auth = await getAuth(ctx.req);
    } catch (err) {
      // This used to redirect to /login?error=database, which is a sign-out as far as the
      // operator can tell: one slow query and they are looking at the sign-in form with
      // their session still perfectly valid. Answer in place instead, with a 503 that
      // retries the same URL — still refused (nothing of the page is rendered), and the
      // cookie is left alone.
      console.error("[page-auth] session lookup failed:", err);
      sendSessionUnavailablePage(ctx.res);
      // Next sends nothing more for a response that is already finished.
      return { props: {} as P & AuthPageProps };
    }

    if (!auth) {
      if (await needsSetup().catch(() => false)) {
        return { redirect: { destination: "/setup", permanent: false } };
      }
      const next = encodeURIComponent(ctx.resolvedUrl || "/");
      return {
        redirect: { destination: `/login?next=${next}`, permanent: false },
      };
    }

    if (opts.role && !hasRole(auth.user, opts.role)) {
      return { redirect: { destination: "/", permanent: false } };
    }

    const uiFlags = await readUiFlags();

    if (!opts.inner) {
      return { props: { user: auth.user, uiFlags } as P & AuthPageProps };
    }

    const result = await opts.inner(ctx, auth);
    if ("props" in result) {
      const props = await result.props;
      return { props: { ...props, user: auth.user, uiFlags } as P & AuthPageProps };
    }
    return result as GetServerSidePropsResult<P & AuthPageProps>;
  };
}
