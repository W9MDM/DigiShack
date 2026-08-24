import dgram from "node:dgram";

// Passive FlexRadio discovery.
//
// SmartSDR radios broadcast a VITA-49 extension packet roughly once a second
// whose payload is a space-separated key=value ASCII string. Listening is
// entirely passive — nothing is sent to the radio — which makes discovery safe to
// run even while an operator has a SmartSDR session open.
//
// Verified against a FLEX-6400 running SmartSDR 4.2.18 (discovery protocol
// 3.1.0.4) broadcasting a 748-byte packet on UDP 4992.

/** 4992 is standard; 14992 is used by some SmartSDR versions. */
export const DISCOVERY_PORTS = [4992, 14992] as const;

export interface FlexRadioInfo {
  /** Source address the broadcast came from. */
  address: string;
  model: string;
  nickname: string | null;
  callsign: string | null;
  serial: string | null;
  version: string | null;
  /** The radio's own advertised address, which may differ from `address`. */
  ip: string | null;
  /** TCP command API port. */
  port: number;
  status: string | null;
  maxSlices: number | null;
  availableSlices: number | null;
  /** IPs of GUI clients already connected, so a UI can warn about contention. */
  guiClientIps: string[];
  /** Everything else, verbatim. */
  raw: Record<string, string>;
  seenAt: string;
}

/**
 * Pull the key=value payload out of a discovery datagram.
 *
 * The VITA-49 header length varies by protocol version, so rather than parsing it
 * the longest run of printable ASCII is taken — that is the payload. Cruder than
 * a real VITA-49 parse and considerably more robust across firmware revisions.
 */
export function parseDiscoveryPacket(buf: Buffer): Record<string, string> | null {
  const runs = buf.toString("latin1").match(/[\x20-\x7e]{40,}/g);
  if (!runs) return null;

  const body = runs.reduce((a, b) => (b.length > a.length ? b : a));
  if (!body.includes("=")) return null;

  const out: Record<string, string> = {};
  for (const token of body.trim().split(/\s+/)) {
    const i = token.indexOf("=");
    if (i > 0) out[token.slice(0, i)] = token.slice(i + 1);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function toInfo(address: string, kv: Record<string, string>): FlexRadioInfo {
  const num = (k: string) => {
    const n = Number(kv[k]);
    return Number.isFinite(n) ? n : null;
  };

  return {
    address,
    model: kv.model ?? "unknown",
    nickname: kv.nickname || null,
    callsign: kv.callsign || null,
    serial: kv.serial || null,
    version: kv.version || null,
    ip: kv.ip || null,
    port: num("port") ?? 4992,
    status: kv.status || null,
    maxSlices: num("max_slices"),
    availableSlices: num("available_slices"),
    guiClientIps: (kv.gui_client_ips ?? "").split(",").filter(Boolean),
    raw: kv,
    seenAt: new Date().toISOString(),
  };
}

/**
 * Listen for `timeoutMs` and return every distinct radio seen.
 *
 * Resolves early once `expect` radios have been found, so the common
 * single-radio case doesn't wait out the whole window.
 */
export function discoverRadios(
  { timeoutMs = 6_000, expect = 1 }: { timeoutMs?: number; expect?: number } = {},
): Promise<FlexRadioInfo[]> {
  return new Promise((resolve) => {
    const found = new Map<string, FlexRadioInfo>();
    const sockets: dgram.Socket[] = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          /* already closed */
        }
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(finish, timeoutMs);

    for (const port of DISCOVERY_PORTS) {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

      // A port already in use (another SmartSDR-aware app) must not fail the
      // whole discovery — the other port may still work.
      socket.on("error", () => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      });

      socket.on("message", (buf, rinfo) => {
        const kv = parseDiscoveryPacket(buf);
        if (!kv?.model) return;

        const key = kv.serial ?? rinfo.address;
        if (!found.has(key)) found.set(key, toInfo(rinfo.address, kv));
        if (found.size >= expect) finish();
      });

      try {
        socket.bind(port, "0.0.0.0");
        sockets.push(socket);
      } catch {
        /* port unavailable */
      }
    }
  });
}
