// Pat Winlink engine API contracts (pinned: Pat v1.0.0, build 2e6a8d1, go1.26.2).
//
// These mirror the JSON Pat's loopback HTTP API returns, captured from the pinned
// binary into lib/winlink/fixtures/pat-1.0.0/. scripts/check-winlink-contracts.ts
// asserts the fixtures still parse against these shapes, so a Pat version bump that
// changes the wire format fails loudly instead of silently breaking the adapter.
//
// These are the ENGINE-facing wire shapes only. They must not leak past the adapter
// (lib/winlink/engine/pat.ts) into DigiShack's own product types; an arbitrary
// upstream snapshot is not an API guarantee, so re-capture and re-verify on a bump.

/** A Winlink address: a callsign or an email, with an optional protocol tag. */
export interface PatAddress {
  /** Protocol prefix (e.g. "smtp"); empty for a bare Winlink callsign. */
  Proto: string;
  Addr: string;
}

/** Attachment metadata on a message. Shape inferred from Pat's api.go; the captured
 *  fixtures carry none yet (Files: []), so this is unverified by the contract check. */
export interface PatAttachment {
  Name: string;
  Size: number;
}

/** A message as Pat returns it. On the list route (/api/mailbox/{box}) Body and
 *  BodyHTML are empty; they are populated only on the detail route
 *  (/api/mailbox/{box}/{MID}). */
export interface PatMessage {
  MID: string;
  /** RFC3339 timestamp with offset, e.g. "2026-10-16T21:50:00-05:00". */
  Date: string;
  From: PatAddress;
  To: PatAddress[];
  Cc: PatAddress[] | null;
  Subject: string;
  Body: string;
  BodyHTML: string;
  Files: PatAttachment[];
  P2POnly: boolean;
  Unread: boolean;
}

/** The mailbox folders Pat exposes as array routes. "trash" is not one of them
 *  (that route 404s on v1.0.0). */
export type PatMailbox = "in" | "out" | "sent" | "archive";

/** /api/status */
export interface PatStatus {
  active_listeners: string[];
  connected: boolean;
  dialing: boolean;
  remote_addr: string;
  http_clients: string[];
  config_hash: string;
}

/** A frequency as Pat reports it (three renderings of one value). */
export interface PatFrequency {
  hz: number;
  khz: number;
  desc: string;
}

/** An entry from /api/rmslist — the cached RMS gateway directory, already scored
 *  with distance (km) and azimuth (deg) from the station locator. */
export interface PatRmsNode {
  callsign: string;
  gridsquare: string;
  distance: number;
  azimuth: number;
  modes: string;
  freq: PatFrequency;
  dial: PatFrequency;
  url: string;
  prediction: unknown | null;
}

/** /api/bandwidths?mode=… */
export interface PatBandwidths {
  mode: string;
  bandwidths: string[];
}

/** /api/formcatalog */
export interface PatFormCatalog {
  name: string;
  path: string;
  version: string;
  form_count: number;
  forms: unknown[];
  folders: unknown[];
}

/** /api/connect_aliases — alias name -> transport URL template (with {mycall}). */
export type PatConnectAliases = Record<string, string>;

/** ARDOP modem sub-config from /api/config (the first RF modem target). */
export interface PatArdopConfig {
  addr: string;
  arq_bandwidth: { Forced: boolean; Max: number };
  connect_requests: number;
  rig: string;
  ptt_ctrl: boolean;
  beacon_interval: number;
  cwid_enabled: boolean;
}

/** VARA HF/FM modem sub-config from /api/config (a later transport). */
export interface PatVaraConfig {
  addr: string;
  bandwidth?: number;
  rig: string;
  ptt_ctrl: boolean;
}

/** /api/config — Pat's full configuration. Typed for the fields DigiShack touches;
 *  Pat carries more (ax25, agwpe, serial-tnc, pactor, gpsd, …) left as unknown.
 *  secure_login_password is a secret and must never be surfaced to the browser. */
export interface PatConfig {
  mycall: string;
  secure_login_password: string;
  auxiliary_addresses: string[];
  locator: string;
  auto_download_size_limit: number;
  service_codes: string[];
  http_addr: string;
  motd: string[];
  connect_aliases: PatConnectAliases;
  listen: string[];
  ardop: PatArdopConfig;
  varahf: PatVaraConfig;
  varafm: PatVaraConfig;
  [key: string]: unknown;
}
