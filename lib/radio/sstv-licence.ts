// May this station send SSTV here? The US phone sub-bands, by licence class.
//
// SSTV is an image mode, and in the US image emissions share the phone sub-bands
// (47 CFR 97.305), which differ by class: 14.230 needs General or above, 7.171 needs
// Advanced or Extra (General's 40 m phone starts at 7.175), and a Technician has only
// 28.300 to 28.500 on HF. The check is on the signal's whole occupied width - 1100 to
// 2300 Hz from the dial, on whichever side the sideband puts it - not the dial alone.
//
// "other" is a station licensed outside the US: its own rules apply and this does not
// pretend to know them. An unset class refuses, with the reason: sending two minutes of
// carrier is not something to guess about.

export type LicenceClass = "us-technician" | "us-general" | "us-advanced" | "us-extra" | "other";

export const LICENCE_CLASSES: readonly LicenceClass[] = ["us-technician", "us-general", "us-advanced", "us-extra", "other"];

/** Phone and image sub-bands, MHz, per class. HF only; 60 m channels left out. */
const PHONE: Record<Exclude<LicenceClass, "other">, [number, number][]> = {
  "us-extra": [[1.8, 2.0], [3.6, 4.0], [7.125, 7.3], [14.15, 14.35], [18.11, 18.168], [21.2, 21.45], [24.93, 24.99], [28.3, 29.7], [50.1, 54.0]],
  "us-advanced": [[1.8, 2.0], [3.7, 4.0], [7.125, 7.3], [14.175, 14.35], [18.11, 18.168], [21.225, 21.45], [24.93, 24.99], [28.3, 29.7], [50.1, 54.0]],
  "us-general": [[1.8, 2.0], [3.8, 4.0], [7.175, 7.3], [14.225, 14.35], [18.11, 18.168], [21.275, 21.45], [24.93, 24.99], [28.3, 29.7], [50.1, 54.0]],
  "us-technician": [[28.3, 28.5], [50.1, 54.0]],
};

const LABEL: Record<LicenceClass, string> = {
  "us-technician": "a US Technician",
  "us-general": "a US General",
  "us-advanced": "a US Advanced",
  "us-extra": "a US Extra",
  other: "a non-US",
};

export function parseLicenceClass(raw: string | null | undefined): LicenceClass | null {
  const v = (raw ?? "").trim().toLowerCase();
  return (LICENCE_CLASSES as readonly string[]).includes(v) ? (v as LicenceClass) : null;
}

/**
 * Null when this class may send an SSTV signal on this dial and sideband; otherwise why
 * not, in words for the operator.
 */
export function sstvTransmitRefusal(cls: LicenceClass | null, dialHz: number, sideband: "USB" | "LSB"): string | null {
  if (!cls) {
    return "Set your licence class in Settings (General) before sending SSTV: it decides where an image mode may be sent";
  }
  if (cls === "other") return null;
  const lo = sideband === "USB" ? dialHz + 1100 : dialHz - 2300;
  const hi = sideband === "USB" ? dialHz + 2300 : dialHz - 1100;
  const ok = PHONE[cls].some(([a, b]) => lo >= a * 1e6 && hi <= b * 1e6);
  if (ok) return null;
  const mhz = (dialHz / 1e6).toFixed(3);
  return `${LABEL[cls]} licence does not include image modes at ${mhz} MHz ${sideband}: the signal would sit at ${(lo / 1e6).toFixed(4)}-${(hi / 1e6).toFixed(4)} MHz, outside that class's phone sub-band`;
}
