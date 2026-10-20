// The shapes that cross from the bridge to the browser.
//
// Types only, so a page can import them without dragging node:net or Prisma into the
// client bundle — the telnet client and the log queries live in sibling modules that
// only the bridge imports.

/** How the mode-slot badge groups modes: the three ways a DXCC entity is usually chased. */
export type ModeCategory = "CW" | "PHONE" | "DIGITAL";

/**
 * Where a spot's mode came from. A comment or a skimmer STATES it; a frequency only
 * suggests it, and the page marks those with a question mark.
 */
export type ModeSource = "comment" | "frequency" | "band-plan";

export interface SpotEntity {
  adif: number;
  name: string;
  prefix: string;
  continent: string | null;
  cqZone: number | null;
}

/** Each flag answers its own question; a new entity is usually new on the band and mode too. */
export interface SpotNeeded {
  /** No contact with this DXCC entity anywhere in the log. */
  entity: boolean;
  /** No contact with this entity on this band. */
  band: boolean;
  /** No contact with this entity in this mode category. False when the mode is unknown. */
  mode: boolean;
}

export interface ClusterSpot {
  id: string;
  /** `CALL|BAND` — the dedupe key. A later spot with the same key replaces this one. */
  key: string;
  dx: string;
  freqHz: number;
  /** ADIF band name. Spots outside every amateur band are dropped before this exists. */
  band: string;
  /** The spotter's call with any SSID and skimmer marker removed. */
  spotter: string;
  /** A Reverse Beacon Network skimmer (or another machine), not a person. */
  skimmer: boolean;
  comment: string;
  /** When the spotter says it was heard (their HHMMZ, resolved to a date), epoch ms. */
  at: number;
  /** When the bridge received the line, epoch ms. */
  receivedAt: number;
  /** The spot time of the most recent repeat inside the dedupe window. Starts equal to `at`. */
  lastSeenAt: number;
  /** How many times it was spotted inside the dedupe window, this one included. */
  count: number;
  /** The SPOTTER's locator, when the node appends one after the time. */
  spotterGrid: string | null;
  snrDb: number | null;
  /** CW speed, from a skimmer. */
  wpm: number | null;
  mode: string | null;
  modeCategory: ModeCategory | null;
  modeSource: ModeSource | null;
  /** Null when the cty data is not loaded, or the call resolves to nothing. */
  entity: SpotEntity | null;
  /** Null when there is no entity to judge, or the log could not be read. */
  needed: SpotNeeded | null;
}

/**
 * The link to the node.
 *
 *   off         cluster.enabled is false
 *   no-login    enabled, but there is no callsign to log in with
 *   connecting  opening the TCP connection
 *   login       connected, waiting for the node's login prompt
 *   connected   logged in and listening
 *   waiting     the link dropped; a reconnect is scheduled (see nextRetryAt)
 */
export type ClusterLinkState = "off" | "no-login" | "connecting" | "login" | "connected" | "waiting";

export interface ClusterStatus {
  enabled: boolean;
  state: ClusterLinkState;
  host: string;
  port: number;
  login: string | null;
  /** When the current login happened, epoch ms. */
  connectedAt: number | null;
  /** Last byte of anything from the node, epoch ms. */
  lastLineAt: number | null;
  lastError: string | null;
  nextRetryAt: number | null;
  /** Failed connection attempts since the last connection that held. */
  attempt: number;
  counts: { lines: number; spots: number; dupes: number; ignored: number };
  /** True once a DXCC lookup reported that no cty data is loaded. */
  dxccMissing: boolean;
}

export interface ClusterSnapshot extends ClusterStatus {
  /** Newest first. */
  spots: ClusterSpot[];
}

/** What GET /api/cluster/spots answers. */
export interface ClusterApiResponse {
  /** The bridge answered at all. */
  running: boolean;
  reason?: string;
  /** cluster.enabled as the web tier reads it — ahead of the bridge by up to one poll. */
  settingEnabled: boolean;
  /** Null when the bridge is down, or too old to serve the cluster. */
  cluster: ClusterSnapshot | null;
}
