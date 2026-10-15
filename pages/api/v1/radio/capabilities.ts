import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { MAX_DELTA_HZ, RADIO_API_VERSION, RADIO_COMMANDS, type BridgeStatusPayload } from "@/lib/radio/api";
import { bridgeStatus } from "@/lib/radio/bridge-client";
import { radioCapabilities, type RadioSourceName } from "@/lib/radio/capabilities";
import { MODULATIONS } from "@/lib/radio/modes";

// What a client may ask of the active radio, from the capability model the rig page
// already uses - so the dial offers the same controls the page does and no more. Read
// once at connect and again after the source changes; the state says when it has.

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const answer = await bridgeStatus();
  const st = answer.reachable ? ((answer.body as BridgeStatusPayload).status ?? null) : null;
  const source = (st?.source ?? null) as RadioSourceName;
  const caps = radioCapabilities(source);
  sendJson(res, 200, {
    api: RADIO_API_VERSION,
    target: {
      source,
      radio: st?.radio ? { vendor: st.radio.vendor, model: st.radio.model } : null,
      label: caps.label,
    },
    // One receiver, the one the bridge drives. Named so a later contract can add more
    // without a client assuming this one was ever more than one.
    receivers: ["active"],
    commands: RADIO_COMMANDS,
    tuning: {
      lowHz: Number.isFinite(caps.tuneLowHz) ? caps.tuneLowHz : null,
      highHz: Number.isFinite(caps.tuneHighHz) ? caps.tuneHighHz : null,
      maxDeltaHz: MAX_DELTA_HZ,
      unit: "Hz",
    },
    modulations: MODULATIONS,
    agc: caps.agc,
    filterEdgesHz: caps.filterEdgesHz,
    notes: [caps.filterNote, caps.panadapterNote].filter((n): n is string => Boolean(n)),
  });
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get, allowApiKey: true },
});
