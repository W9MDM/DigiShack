// Received cards from any IMAP mailbox — Gmail (imap.gmail.com:993 with an app password),
// Fastmail, a club's own server.
//
// The same two-step shape as the Graph source: headers first for every message, which is all
// the classifier needs, and the whole message only for the ones it wants. IMAP has no
// attachment-by-attachment download, so a wanted message is fetched once, parsed, and its
// pictures served from that parse.

import { ImapClient, type ImapConnectOptions } from "@/lib/mail/imap";
import { parseMime, type ParsedMessage } from "@/lib/mail/mime";
import type { ImapConfig } from "@/lib/mail/providers";
import { attachmentKey, messageKey, type MailSource, type SourceAttachment, type SourceMessage } from "@/lib/qsl/inbound/source";

/** Largest message downloaded whole. A 10 MB card is about 14 MB as base64. */
const MESSAGE_MAX_BYTES = 20 * 1024 * 1024;
const HEADER_BATCH = 100;
const DAY = 86_400_000;

interface Meta {
  folder: string;
  uid: number;
  size: number;
}

export class ImapMailSource implements MailSource {
  private client: ImapClient | null = null;
  private open: string | null = null;
  private readonly meta = new Map<string, Meta>();
  private cached: { key: string; parsed: ParsedMessage | null } | null = null;

  constructor(
    private readonly config: ImapConfig,
    /** For the check: a recorded server in place of the network. */
    private readonly connectOptions?: Partial<ImapConnectOptions>,
  ) {}

  get label(): string {
    return `IMAP (${this.config.user} at ${this.config.host})`;
  }

  folders(): string[] {
    return this.config.folders;
  }

  private async connection(): Promise<ImapClient> {
    if (this.client) return this.client;
    const c = new ImapClient();
    await c.connect(
      { host: this.config.host, port: this.config.port, tls: this.config.tls, ...this.connectOptions },
      this.config.user,
      this.config.password,
    );
    this.client = c;
    return c;
  }

  private async examine(folder: string): Promise<{ exists: number; uidValidity: string }> {
    const c = await this.connection();
    const r = await c.examine(folder);
    this.open = folder;
    return r;
  }

  async *list(folder: string, since: Date): AsyncIterable<SourceMessage> {
    const { uidValidity } = await this.examine(folder);
    const c = await this.connection();
    // SINCE is a calendar date in the server's zone, so ask from the day before and filter
    // on the exact arrival time below.
    const uids = await c.searchSince(new Date(since.getTime() - DAY));
    for (let i = 0; i < uids.length; i += HEADER_BATCH) {
      if (this.open !== folder) await this.examine(folder);
      const batch = await c.fetchHeaders(uids.slice(i, i + HEADER_BATCH));
      for (const h of batch) {
        const parsed = parseMime(Buffer.concat([h.header, Buffer.from("\r\n")]));
        const receivedAt = h.internalDate ?? parsed.date ?? new Date(0);
        if (receivedAt.getTime() < since.getTime()) continue;
        const key = messageKey(parsed.messageId, `imap:${folder}:${uidValidity}:${h.uid}`);
        this.meta.set(key, { folder, uid: h.uid, size: h.size });
        yield {
          key,
          folder,
          receivedAt,
          summary: {
            from: parsed.from.address,
            fromName: parsed.from.name,
            subject: parsed.subject,
            preview: "",
            // multipart/alternative is text and HTML of the same body; anything else
            // multipart (mixed, related) may carry a picture.
            hasAttachments: parsed.contentType.startsWith("multipart/") && parsed.contentType !== "multipart/alternative",
          },
        };
      }
    }
  }

  private async whole(m: SourceMessage): Promise<ParsedMessage | null> {
    if (this.cached?.key === m.key) return this.cached.parsed;
    const meta = this.meta.get(m.key);
    if (!meta) throw new Error("message was not listed in this run");
    let parsed: ParsedMessage | null = null;
    if (meta.size <= MESSAGE_MAX_BYTES) {
      if (this.open !== meta.folder) await this.examine(meta.folder);
      const raw = await (await this.connection()).fetchMessage(meta.uid);
      parsed = raw ? parseMime(raw) : null;
    }
    this.cached = { key: m.key, parsed };
    return parsed;
  }

  async body(m: SourceMessage): Promise<string> {
    const p = await this.whole(m);
    return (p?.html || p?.text || "").slice(0, 512 * 1024);
  }

  async attachments(m: SourceMessage): Promise<SourceAttachment[]> {
    const p = await this.whole(m);
    if (!p) return [];
    const seen = new Map<string, number>();
    const out: SourceAttachment[] = [];
    for (const leaf of p.leaves) {
      if (leaf.contentType.startsWith("text/") && !leaf.filename) continue;
      if (leaf.contentType.startsWith("multipart/")) continue;
      const name = leaf.filename ?? `${leaf.contentType.replace("/", ".")}`;
      const nth = seen.get(name.toLowerCase()) ?? 0;
      seen.set(name.toLowerCase(), nth + 1);
      out.push({
        key: attachmentKey(name, nth),
        name,
        contentType: leaf.contentType,
        size: leaf.body.length,
        inline: leaf.disposition === "inline" || (leaf.disposition === null && leaf.contentId !== null),
      });
    }
    return out;
  }

  async attachmentBytes(m: SourceMessage, a: SourceAttachment, max: number): Promise<Uint8Array | null> {
    const p = await this.whole(m);
    if (!p) return null;
    const list = await this.attachments(m);
    const idx = list.findIndex((x) => x.key === a.key);
    // attachments() skips the text leaves, so walk the same filter to find the leaf.
    const leaves = p.leaves.filter((l) => !(l.contentType.startsWith("text/") && !l.filename) && !l.contentType.startsWith("multipart/"));
    const leaf = idx >= 0 ? leaves[idx] : undefined;
    if (!leaf) return null;
    return leaf.body.length > max ? null : new Uint8Array(leaf.body);
  }

  async close(): Promise<void> {
    await this.client?.logout();
    this.client = null;
  }
}

/** Test connection: sign in and open the first folder read-only. */
export async function testImapMailbox(config: ImapConfig, connectOptions?: Partial<ImapConnectOptions>): Promise<string> {
  const c = new ImapClient();
  try {
    await c.connect({ host: config.host, port: config.port, tls: config.tls, ...connectOptions }, config.user, config.password);
    const folder = config.folders[0] ?? "INBOX";
    const { exists } = await c.examine(folder);
    return `Signed in to ${config.host} as ${config.user}: ${folder} holds ${exists.toLocaleString("en-US")} message(s).`;
  } finally {
    await c.logout();
  }
}
