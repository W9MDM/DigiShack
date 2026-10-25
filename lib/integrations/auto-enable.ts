// A logbook service set up is a logbook service switched on.
//
// Uploading has a master switch (`uploads.enabled`, off on a fresh install) and one per
// service. N9MMR added his QRZ key and nothing went: the per-service switch was on by default
// but the master was not, and nothing on the page said so. Saving the credentials that
// complete a service's setup now turns both on — unless the same save sets them itself.
//
// Club Log is left out: its uploads from this installation are refused upstream (see
// `uploads.clublog` in the registry), so switching it on would only produce failures.

import { isConfigured, type UploadableService } from "@/lib/integrations/upload-runner";
import { writeSettings } from "@/lib/settings";

const AUTO_ON: UploadableService[] = ["qrz", "cloudlog", "eqsl", "lotw", "n3fjp"];

/** The setting prefixes whose save can complete a service's setup. */
const CREDENTIAL_PREFIXES = ["qrz.", "cloudlog.", "eqsl.", "n3fjp."];

export function touchesCredentials(keys: string[]): boolean {
  return keys.some((k) => CREDENTIAL_PREFIXES.some((p) => k.startsWith(p)));
}

/** Which services are set up right now. Taken before a save, to compare with after. */
export async function configuredServices(): Promise<Set<UploadableService>> {
  const out = new Set<UploadableService>();
  for (const s of AUTO_ON) if (await isConfigured(s)) out.add(s);
  return out;
}

/**
 * Turn on the upload of every service set up since `before`, and the master switch with it.
 * `explicit` is the keys the save itself set — a choice made in the same save stands.
 * Returns the keys switched on.
 */
export async function switchOnNewlyConfigured(
  before: Set<UploadableService>,
  explicit: ReadonlySet<string>,
  updatedById: string,
): Promise<string[]> {
  const keys: string[] = [];
  for (const s of AUTO_ON) {
    if (before.has(s) || !(await isConfigured(s))) continue;
    if (!explicit.has(`uploads.${s}`)) keys.push(`uploads.${s}`);
    if (!explicit.has("uploads.enabled") && !keys.includes("uploads.enabled")) keys.push("uploads.enabled");
  }
  if (keys.length === 0) return [];
  const r = await writeSettings(keys.map((key) => ({ key, value: "true" })), updatedById);
  return r.updated;
}
