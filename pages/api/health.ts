import type { NextApiRequest, NextApiResponse } from "next";

import { prisma } from "@/lib/db/prisma";
import pkg from "@/package.json";

// GET /api/health — is this installation actually working?
//
// Unauthenticated on purpose, and therefore deliberately dull: version, uptime, and
// whether each dependency answers. No counts, no callsign, no configuration. A health
// check that needs a session cannot be used by the thing that restarts the process
// when it stops answering, and one that leaks the station's details to the internet
// is a different kind of problem.
//
// The distinction that makes it worth having: "the web server responds" and "the
// application works" are not the same, and only the second is useful. Next.js will
// happily serve pages with a dead database — every one of them an error, and the
// process looking perfectly healthy to anything watching the port.

export interface Health {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  time: string;
  checks: {
    database: { ok: boolean; latencyMs: number | null; error?: string };
    /** The radio bridge, if it is reachable. Absent is not unhealthy. */
    bridge: { ok: boolean; running: boolean; latencyMs: number | null };
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; error?: string }> {
  const started = Date.now();
  try {
    await fn();
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : "failed",
    };
  }
}

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const db = await timed(() => prisma.$queryRawUnsafe("SELECT 1"));

  // The bridge is optional: a logbook with no radio attached is a perfectly healthy
  // installation, so a missing bridge is reported rather than counted as a failure.
  let bridgeOk = false;
  let bridgeMs: number | null = null;
  let bridgeRunning = false;
  try {
    const port = process.env.BRIDGE_PORT ?? "3101";
    const started = Date.now();
    const r = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    bridgeRunning = true;
    bridgeOk = r.ok;
    bridgeMs = Date.now() - started;
  } catch {
    /* not running, which is allowed */
  }

  const body: Health = {
    ok: db.ok,
    version: pkg.version,
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
    checks: {
      database: { ok: db.ok, latencyMs: db.ok ? db.ms : null, ...(db.error ? { error: db.error } : {}) },
      bridge: { ok: bridgeOk, running: bridgeRunning, latencyMs: bridgeMs },
    },
  };

  // 503 when the database is down, so a monitor or a process manager can act on the
  // status code alone without parsing anything.
  res.status(body.ok ? 200 : 503).json(body);
}
