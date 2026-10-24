// Filing imported QSL mail into a folder of its own, in Microsoft 365.
//
// The one write the importer makes, and kept out of MailSource on purpose (see source.ts):
// the reader still cannot move anything, and this cannot read a card. It runs only when a
// folder is named in qsl.inbound.fileToFolder, and needs Mail.ReadWrite on the app, which
// reading never did — without it, the mail stays where it is and the report says why.
//
// Messages are found again by their Message-ID, not by Graph's item id: the import may have
// happened runs ago, and Graph's id is the one thing that changes when mail is moved. Only
// copies in the folders the importer reads (Inbox, Junk) are moved — never one the operator
// has already filed somewhere else by hand.

import { GraphClient, GraphError } from "@/lib/mail/graph";
import { GRAPH_FOLDERS } from "@/lib/qsl/inbound/graph-source";

export interface FileAwayResult {
  /** Messages moved into the folder this run. */
  moved: number;
  /** Message keys handled for good: moved, already filed, or no longer in Inbox / Junk. */
  done: string[];
  /** Messages that failed and will be tried again next run. */
  failed: number;
  /** Set when filing could not proceed at all; nothing further was tried. */
  error?: string;
}

/** Most messages filed in one run; the rest wait for the next. */
export const FILE_AWAY_MAX_PER_RUN = 200;

/** A folder name that is safe to put in an OData string and sensible as a folder. */
export function folderNameProblem(name: string): string | null {
  if (!name.trim()) return "No folder named.";
  if (name.length > 100) return "Folder names are limited to 100 characters here.";
  if (/[\\/\u0000-\u001f]/.test(name)) return "A folder name cannot contain a slash or a control character.";
  return null;
}

/** OData string literal: a single quote is doubled. */
function odataString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const NEEDS_READWRITE =
  "Moving mail needs the Mail.ReadWrite application permission on the Microsoft 365 app, with " +
  "admin consent (Entra → App registrations → the app → API permissions). Nothing was moved; " +
  "the cards were imported as usual.";

function isRefusal(err: unknown): boolean {
  return err instanceof GraphError && (err.status === 403 || err.status === 401);
}

/** The folder's id, creating it at the top of the mailbox when there is none by that name. */
export async function findOrCreateFolder(client: GraphClient, name: string): Promise<string> {
  const filter = encodeURIComponent(`displayName eq ${odataString(name)}`);
  const found = await client.json<{ value?: { id: string; displayName?: string }[] }>(
    `${client.userPath}/mailFolders?$filter=${filter}&$select=id,displayName`,
  );
  const hit = found.value?.find((f) => (f.displayName ?? "").toLowerCase() === name.toLowerCase());
  if (hit) return hit.id;
  const res = await client.request(`${client.userPath}/mailFolders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: name }),
  });
  const made = (await res.json()) as { id?: string };
  if (!made.id) throw new GraphError(res.status, `Microsoft 365 did not return the new folder "${name}".`);
  return made.id;
}

/**
 * Move the messages with these keys (ReceivedQsl.messageId) into `folderName`.
 *
 * A key that cannot be looked up — a hashed over-long Message-ID — is reported done, since no
 * later run could find it either.
 */
export async function fileAway(client: GraphClient, folderName: string, keys: string[]): Promise<FileAwayResult> {
  const out: FileAwayResult = { moved: 0, done: [], failed: 0 };
  const problem = folderNameProblem(folderName);
  if (problem) return { ...out, error: problem };

  let dest: string;
  const from = new Set<string>();
  try {
    dest = await findOrCreateFolder(client, folderName.trim());
    for (const f of GRAPH_FOLDERS) {
      const j = await client.json<{ id: string }>(`${client.userPath}/mailFolders/${encodeURIComponent(f)}?$select=id`);
      from.add(j.id);
    }
  } catch (err) {
    return { ...out, error: isRefusal(err) ? NEEDS_READWRITE : err instanceof Error ? err.message : String(err) };
  }

  for (const key of keys.slice(0, FILE_AWAY_MAX_PER_RUN)) {
    try {
      let copies: { id: string; parentFolderId?: string }[];
      if (key.startsWith("sha256:")) {
        out.done.push(key);
        continue;
      } else if (key.startsWith("graph:")) {
        // No Message-ID on the original; Graph's own id, which holds until the mail is moved.
        try {
          copies = [await client.json<{ id: string; parentFolderId?: string }>(`${client.userPath}/messages/${encodeURIComponent(key.slice(6))}?$select=id,parentFolderId`)];
        } catch (err) {
          if (err instanceof GraphError && err.status === 404) copies = [];
          else throw err;
        }
      } else {
        const filter = encodeURIComponent(`internetMessageId eq ${odataString(key)}`);
        const j = await client.json<{ value?: { id: string; parentFolderId?: string }[] }>(
          `${client.userPath}/messages?$filter=${filter}&$select=id,parentFolderId`,
        );
        copies = j.value ?? [];
      }
      for (const c of copies) {
        if (!c.parentFolderId || !from.has(c.parentFolderId)) continue;
        await client.request(`${client.userPath}/messages/${encodeURIComponent(c.id)}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ destinationId: dest }),
        });
        out.moved++;
      }
      out.done.push(key);
    } catch (err) {
      if (isRefusal(err)) return { ...out, error: NEEDS_READWRITE };
      out.failed++;
    }
  }
  return out;
}
