// Which mail service does what: one choice for sending, one for receiving.
//
// Not everyone's station mail is Microsoft 365. Sending has always been SMTP and stays SMTP
// unless the operator switches it — an upgrade must not move anybody's mail. Receiving (the
// card importer) is off until switched on, and then reads either Microsoft 365 through the
// app registration or any IMAP mailbox, Gmail included.
//
// The Microsoft 365 credentials are ONE set, in their own settings group, used by whichever
// direction is pointed at Microsoft 365. Two copies of a client secret is two places for it
// to expire.
//
// The parsers are pure so check:qsl-inbound can pin the defaults without a database.

import type { GraphConfig } from "@/lib/mail/graph";
import { graphConfigProblem } from "@/lib/mail/graph";
import { getBooleanSetting, getNumberSetting, getSetting } from "@/lib/settings";

export type SendProvider = "smtp" | "graph";
/** "gmail" is IMAP with Google's server filled in — a preset, not a different protocol. */
export type ReceiveProvider = "graph" | "imap" | "gmail";

export const SEND_PROVIDER_KEY = "mail.sendProvider";
export const RECEIVE_PROVIDER_KEY = "qsl.inbound.provider";

/** Anything but an explicit "graph" is SMTP — the behaviour every install had before this. */
export function parseSendProvider(raw: string | null | undefined): SendProvider {
  return raw?.trim().toLowerCase() === "graph" ? "graph" : "smtp";
}

/** Microsoft 365 unless IMAP or Gmail is chosen; the importer is off by its own switch either way. */
export function parseReceiveProvider(raw: string | null | undefined): ReceiveProvider {
  const v = raw?.trim().toLowerCase();
  return v === "imap" || v === "gmail" ? v : "graph";
}

/** Google's IMAP server. Fixed by the Gmail preset, whatever the IMAP fields say. */
export const GMAIL_IMAP = { host: "imap.gmail.com", port: 993, tls: true } as const;

export async function getSendProvider(): Promise<SendProvider> {
  return parseSendProvider(await getSetting(SEND_PROVIDER_KEY));
}

export async function getReceiveProvider(): Promise<ReceiveProvider> {
  return parseReceiveProvider(await getSetting(RECEIVE_PROVIDER_KEY));
}

/** The shared Microsoft 365 app registration, or what is missing from it. */
export async function loadGraphConfig(): Promise<
  { ok: true; config: GraphConfig } | { ok: false; reason: string }
> {
  const config = {
    tenantId: (await getSetting("ms365.tenantId"))?.trim() ?? "",
    clientId: (await getSetting("ms365.clientId"))?.trim() ?? "",
    clientSecret: (await getSetting("ms365.clientSecret")) ?? "",
    mailbox: (await getSetting("ms365.mailbox"))?.trim() ?? "",
  };
  const problem = graphConfigProblem(config);
  return problem ? { ok: false, reason: problem } : { ok: true, config };
}

export interface ImapConfig {
  host: string;
  port: number;
  /** True: TLS from the first byte (993). False: plain connect, then STARTTLS — never cleartext. */
  tls: boolean;
  user: string;
  password: string;
  /** One or more folders, comma-separated in the setting. */
  folders: string[];
}

export function parseFolders(raw: string | null | undefined): string[] {
  const list = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ["INBOX"];
}

export async function loadImapConfig(): Promise<
  { ok: true; config: ImapConfig } | { ok: false; reason: string }
> {
  const host = (await getSetting("imap.host"))?.trim() ?? "";
  const user = (await getSetting("imap.user"))?.trim() ?? "";
  const password = (await getSetting("imap.password")) ?? "";
  if (!host) return { ok: false, reason: "The IMAP server is not set (Settings → QSL → Received cards)." };
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return { ok: false, reason: `"${host}" is not a server name.` };
  if (!user) return { ok: false, reason: "The IMAP username is not set." };
  if (!password) return { ok: false, reason: "The IMAP password is not set." };
  return {
    ok: true,
    config: {
      host,
      port: await getNumberSetting("imap.port", 993),
      tls: await getBooleanSetting("imap.tls", true),
      user,
      password,
      folders: parseFolders(await getSetting("imap.folder")),
    },
  };
}
