import { ApiError, isNetworkFailure } from "@/lib/client/api";

/**
 * What to show when a request from a sign-in or password form fails.
 *
 * The server's sentences are written to be read and pass through. A request that never
 * reached the server carries the browser's own wording ("Failed to fetch"), which says
 * nothing about what to do next.
 */
export function authErrorMessage(err: unknown, fallback: string): string {
  if (isNetworkFailure(err)) {
    return "Could not reach DigiShack. Check the connection and try again.";
  }
  return err instanceof ApiError ? err.message : fallback;
}

/** Put the cursor back in a field after a failed submit, optionally selecting its text. */
export function focusField(id: string, select = false): void {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) return;
  el.focus();
  if (select) el.select();
}
