import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Error thrown by the api* helpers. `details` carries the field-keyed messages
 * that lib/api/respond.ts produces from a ZodError, so forms can render inline
 * validation without a second round of parsing.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly details?: Record<string, string[]>;

  constructor(
    status: number,
    message: string,
    details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }

  /** Messages for one form field, if the server reported any. */
  fieldErrors(field: string): string[] | undefined {
    return this.details?.[field];
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  // Without a deadline a stalled connection leaves the UI on "Loading…" forever,
  // with no error and no way to retry short of a reload. Thirty seconds is long
  // enough for an ADIF import preview over a slow link and short enough to be a
  // usable answer.
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(0, "The server did not answer within 30 seconds. It may be busy or unreachable.");
    }
    throw new ApiError(0, err instanceof Error ? err.message : "Network error");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body — usually an NGINX or Next error page.
      if (!res.ok) throw new ApiError(res.status, text.slice(0, 200));
      throw new ApiError(res.status, "Malformed JSON in response");
    }
  }

  if (!res.ok) {
    const payload = parsed as { error?: string; details?: unknown } | undefined;
    throw new ApiError(
      res.status,
      payload?.error ?? `Request failed (${res.status})`,
      isFieldErrors(payload?.details) ? payload.details : undefined,
    );
  }

  return parsed as T;
}

function isFieldErrors(v: unknown): v is Record<string, string[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every(
    (x) => Array.isArray(x) && x.every((s) => typeof s === "string"),
  );
}

export const apiGet = <T,>(path: string) => request<T>("GET", path);
export const apiPost = <T,>(path: string, body: unknown) =>
  request<T>("POST", path, body);
export const apiPatch = <T,>(path: string, body: unknown) =>
  request<T>("PATCH", path, body);
export const apiDelete = <T,>(path: string) => request<T>("DELETE", path);

/** Backoff for a panel whose fetch failed: 3 s, 6 s, 12 s, 24 s, then every 30 s. */
const RETRY_STEPS_MS = [3_000, 6_000, 12_000, 24_000, 30_000];

/**
 * Minimal data-fetching hook. Deliberately not SWR/React Query — Phase 1 has a
 * handful of screens, and the live-updating surfaces in Phase 4 will be driven
 * by the bridge's WebSocket rather than by polling.
 *
 * Pass `null` as the path to skip fetching (e.g. while a dependency is unknown).
 *
 * IT RETRIES, and that is not a nicety. This used to fetch exactly once per mount: on
 * failure it set `error` and stopped forever, so the only cure was reloading the page.
 * Reported as "I had to refresh the page 5 times to get everything to show" after the
 * radio came back from a four-day outage — every panel had failed independently while the
 * bridge was down, and each needed its own lucky reload. A station that recovers on its
 * own should not need a human clicking refresh until the dice come up right.
 *
 * Two triggers beyond the first attempt:
 *
 *   * BACKOFF after a failure, so a panel that failed heals itself once whatever it
 *     depends on returns. It stops as soon as a request succeeds.
 *   * FOCUS AND ONLINE, so coming back to a tab that was open through an outage shows
 *     current data rather than whatever was on screen when it broke. This is the case
 *     that matters most in a shack: the page is left open on a spare monitor for days.
 *
 * Deliberately NOT a poll on success. The live surfaces are driven by the bridge's
 * WebSocket, and turning every panel into a timer would put the whole UI back on polling
 * to fix a failure path.
 */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);

  // Guards against a slow earlier request overwriting a newer one's result.
  const requestId = useRef(0);
  /** Consecutive failures, for the backoff. Reset by any success. */
  const failures = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    if (path === null) {
      setData(null);
      setLoading(false);
      return;
    }

    // A retry that is already pending is superseded by this attempt, whatever started it.
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }

    const id = ++requestId.current;
    setLoading(true);
    try {
      const result = await apiGet<T>(path);
      if (id === requestId.current) {
        setData(result);
        setError(null);
        failures.current = 0;
      }
    } catch (err) {
      if (id === requestId.current) {
        setError(
          err instanceof ApiError
            ? err
            : new ApiError(0, err instanceof Error ? err.message : "Network error"),
        );
        // Heal without a human. A 4xx will keep failing and keep retrying at the 30 s
        // ceiling, which is cheap and is the honest behaviour: this hook cannot tell a
        // permanently bad request from a dependency that has not come back yet, and
        // guessing wrong in the other direction is what produced the five refreshes.
        const wait =
          RETRY_STEPS_MS[Math.min(failures.current, RETRY_STEPS_MS.length - 1)]!;
        failures.current++;
        retryTimer.current = setTimeout(() => void reload(), wait);
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      // Any in-flight response belongs to a dead render and must not land in state.
      requestId.current++;
    };
  }, [reload]);

  // Coming back to a tab, or back onto the network, refetches anything that is broken.
  //
  // Only when there IS an error: a healthy panel is either static or fed by the bridge
  // socket, and refetching every panel on every tab switch would be a poll wearing a
  // different hat.
  useEffect(() => {
    if (path === null) return;
    const onWake = (): void => {
      if (error !== null) void reload();
    };
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
    };
  }, [path, error, reload]);

  return { data, error, loading, reload };
}
