// Build an IcomSource from what the operator configured.
//
// Kept apart from rig.ts so the driver itself stays free of database access — that is
// what lets the whole of lib/icom be tested against a stub radio with no Prisma, no
// settings table and no environment.

import { IcomSource } from "@/lib/icom/rig";
import { getBooleanSetting, getNumberSetting, getSetting } from "@/lib/settings";

export interface IcomConfig {
  /** Send silence on the audio socket while idle. See the setting's help text. */
  audioKeepalive: boolean;
  host: string;
  username: string;
  password: string;
  controlPort: number;
  serialPort: number;
  audioPort: number;
  /** undefined means "use whatever the radio's model implies". */
  civAddress: number | undefined;
  silenceRms: number;
  depth: number;
  /** "auto" | "ft8" | "ft4" | "ft2" — auto infers from the dial frequency. */
  mode: string;
  /** Top of the audio passband: what the decoder searches and the waterfall draws. */
  passbandHz: number;
}

/**
 * Parse the CI-V address setting.
 *
 * Accepts `94`, `0x94` and `0X94`, because all three are what people write when a
 * manual prints it as "94h". Anything unparseable returns undefined rather than a
 * default, so the model-derived address wins instead of a wrong literal.
 */
export function parseCivAddress(raw: string | null | undefined): number | undefined {
  const t = (raw ?? "").trim();
  if (!t) return undefined;
  const v = Number.parseInt(t.replace(/^0x/i, ""), 16);
  if (!Number.isFinite(v) || v <= 0 || v > 0xff) return undefined;
  return v;
}

export async function getIcomConfig(): Promise<IcomConfig | null> {
  const host = (await getSetting("icom.host"))?.trim();
  const username = (await getSetting("icom.username"))?.trim();
  const password = (await getSetting("icom.password")) ?? "";
  if (!host || !username || !password) return null;

  return {
    host,
    username,
    password,
    controlPort: await getNumberSetting("icom.controlPort", 50_001),
    serialPort: await getNumberSetting("icom.serialPort", 50_002),
    audioPort: await getNumberSetting("icom.audioPort", 50_003),
    civAddress: parseCivAddress(await getSetting("icom.civAddress")),
    // Lower than the Flex default on purpose — see the setting's help text.
    silenceRms: await getNumberSetting("icom.silenceRms", 0.0008),
    depth: await getNumberSetting("icom.decodeDepth", 2),
    // Shared with the FlexRadio. "auto" means infer from the dial, which is what the
    // Flex path has always done and this one never did — it decoded FT8 wherever you
    // tuned it, and an FT4 frequency produced a screenful of nothing.
    mode: ((await getSetting("digital.mode")) ?? "auto").toLowerCase(),
    // Shared with the FlexRadio: the passband is a property of the operating
    // convention, not of the radio.
    passbandHz: await getNumberSetting("digital.passbandHz", 3_000),
    // Default ON, so turning it off is a deliberate experiment rather than drift.
    audioKeepalive: await getBooleanSetting("icom.audioKeepalive", true),
  };
}

export async function createIcomSource(): Promise<IcomSource | null> {
  const cfg = await getIcomConfig();
  if (!cfg) return null;
  return new IcomSource({
    host: cfg.host,
    username: cfg.username,
    password: cfg.password,
    controlPort: cfg.controlPort,
    serialPort: cfg.serialPort,
    audioPort: cfg.audioPort,
    civAddress: cfg.civAddress,
    // These three were read into the config and then dropped on the floor.
    //
    // `icom.silenceRms` and `icom.decodeDepth` are registered settings with help text
    // an operator can read and act on, and neither reached the source: the threshold
    // stayed at the constructor default and the depth at 2, whatever the Settings page
    // said. Passing configuration to the thing being configured is not a feature, but
    // it was missing.
    silenceRms: cfg.silenceRms,
    depth: cfg.depth,
    mode: cfg.mode === "ft4" ? "FT4" : cfg.mode === "ft2" ? "FT2" : "FT8",
    passbandHz: cfg.passbandHz,
    audioKeepalive: cfg.audioKeepalive,
  });
}
