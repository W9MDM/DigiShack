// Received cards from a Microsoft 365 mailbox, through Graph.
//
// GET only. The list is filtered and ordered by receivedDateTime so a run can stop anywhere
// and the next one resume from the newest message it finished; $select keeps each page to
// the handful of fields the classifier reads. Bodies and attachments are fetched only for
// messages the classifier wants — of 300-odd QSL-ish messages in the probed mailbox, 259
// were our own cards and never needed more than their subject.

import { attachmentKey, messageKey, readCapped, type MailSource, type SourceAttachment, type SourceMessage } from "@/lib/qsl/inbound/source";
import { GraphClient } from "@/lib/mail/graph";

interface GraphMessage {
  id: string;
  internetMessageId?: string | null;
  subject?: string | null;
  from?: { emailAddress?: { address?: string | null; name?: string | null } | null } | null;
  receivedDateTime: string;
  hasAttachments?: boolean;
  bodyPreview?: string | null;
}

interface GraphPage<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

interface GraphAttachment {
  "@odata.type"?: string;
  id: string;
  name?: string | null;
  contentType?: string | null;
  size?: number;
  isInline?: boolean;
}

/** Inbox and Junk: a card from a stranger with a JPEG attached is junk-shaped mail. */
export const GRAPH_FOLDERS = ["inbox", "junkemail"];

/** Largest body read for a notice's link. Notices are small; a newsletter is not a notice. */
const BODY_MAX_BYTES = 2 * 1024 * 1024;

export class GraphMailSource implements MailSource {
  /** Graph's own id, by our key, for the follow-up requests. */
  private readonly ids = new Map<string, string>();
  private readonly attachmentIds = new Map<string, string>();

  constructor(private readonly client: GraphClient) {}

  get label(): string {
    return `Microsoft 365 (${this.client.config.mailbox})`;
  }

  folders(): string[] {
    return GRAPH_FOLDERS;
  }

  async *list(folder: string, since: Date): AsyncIterable<SourceMessage> {
    // Encoded by hand: URLSearchParams writes a space as "+", which OData does not promise to
    // read as a space.
    const q = [
      ["$filter", `receivedDateTime ge ${since.toISOString()}`],
      ["$orderby", "receivedDateTime asc"],
      ["$select", "id,internetMessageId,subject,from,receivedDateTime,hasAttachments,bodyPreview"],
      ["$top", "50"],
    ]
      .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
      .join("&");
    let url: string | undefined = `${this.client.userPath}/mailFolders/${encodeURIComponent(folder)}/messages?${q}`;
    while (url) {
      const page: GraphPage<GraphMessage> = await this.client.json<GraphPage<GraphMessage>>(url);
      for (const m of page.value ?? []) {
        const key = messageKey(m.internetMessageId, `graph:${m.id}`);
        this.ids.set(key, m.id);
        yield {
          key,
          folder,
          receivedAt: new Date(m.receivedDateTime),
          summary: {
            from: (m.from?.emailAddress?.address ?? "").toLowerCase(),
            fromName: m.from?.emailAddress?.name ?? "",
            subject: m.subject ?? "",
            preview: m.bodyPreview ?? "",
            hasAttachments: Boolean(m.hasAttachments),
          },
        };
      }
      // GraphClient.request refuses any nextLink that is not on graph.microsoft.com.
      url = page["@odata.nextLink"];
    }
  }

  private graphId(m: SourceMessage): string {
    const id = this.ids.get(m.key);
    if (!id) throw new Error("message was not listed in this run");
    return encodeURIComponent(id);
  }

  async body(m: SourceMessage): Promise<string> {
    // Read capped: only notices and unclear bounces get here, but a body is whatever the sender
    // made it, and a 30 MB HTML newsletter should cost nothing to decline.
    const res = await this.client.request(`${this.client.userPath}/messages/${this.graphId(m)}?$select=body`);
    const bytes = await readCapped(res, BODY_MAX_BYTES);
    if (!bytes) return "";
    try {
      const j = JSON.parse(new TextDecoder().decode(bytes)) as { body?: { content?: string } };
      return j.body?.content ?? "";
    } catch {
      return "";
    }
  }

  async attachments(m: SourceMessage): Promise<SourceAttachment[]> {
    const j = await this.client.json<GraphPage<GraphAttachment>>(
      `${this.client.userPath}/messages/${this.graphId(m)}/attachments?$select=id,name,contentType,size,isInline`,
    );
    const seen = new Map<string, number>();
    const out: SourceAttachment[] = [];
    for (const a of j.value ?? []) {
      // Item attachments (a forwarded email) and reference attachments (a OneDrive link)
      // have no bytes to read here.
      if (a["@odata.type"] && a["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;
      const name = a.name ?? "attachment";
      const nth = seen.get(name.toLowerCase()) ?? 0;
      seen.set(name.toLowerCase(), nth + 1);
      const key = attachmentKey(name, nth);
      this.attachmentIds.set(`${m.key}\u0000${key}`, a.id);
      out.push({ key, name, contentType: a.contentType ?? "", size: a.size ?? 0, inline: Boolean(a.isInline) });
    }
    return out;
  }

  async attachmentBytes(m: SourceMessage, a: SourceAttachment, max: number): Promise<Uint8Array | null> {
    const aid = this.attachmentIds.get(`${m.key}\u0000${a.key}`);
    if (!aid) return null;
    const res = await this.client.request(
      `${this.client.userPath}/messages/${this.graphId(m)}/attachments/${encodeURIComponent(aid)}/$value`,
    );
    return readCapped(res, max);
  }
}

/** Test connection: sign in, then read the Inbox's counts — proof Mail.Read works on this mailbox. */
export async function testGraphMailbox(client: GraphClient): Promise<string> {
  const j = await client.json<{ totalItemCount?: number; unreadItemCount?: number }>(
    `${client.userPath}/mailFolders/inbox?$select=totalItemCount,unreadItemCount`,
  );
  return (
    `Signed in and read ${client.config.mailbox}: the Inbox holds ` +
    `${(j.totalItemCount ?? 0).toLocaleString("en-US")} message(s), ${(j.unreadItemCount ?? 0).toLocaleString("en-US")} unread.`
  );
}
