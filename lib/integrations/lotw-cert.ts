import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { decryptSecret, encryptSecret } from "@/lib/settings/crypto";

// The LoTW callsign certificate: reading it, storing it, and describing it.
//
// This exists because `lotw.tqslPath` was the wrong design. The setting pointed at a TQSL
// binary that is not installed on the deploy target and never will be — it is a desktop GUI
// application — so the upload path could not run at all, which is why nothing has been
// uploaded since August 1st despite the sync being switched on.
//
// TQSL IS NOT REQUIRED. Verified by reading Cloudlog, which demonstrably uploads to LoTW
// and never invokes it: the whole job is PKCS#12 extraction plus an RSA-SHA1 signature, and
// Node has the second natively. See docs/lotw-upload.md.
//
// WHY A SUBPROCESS FOR THE FIRST PART: `node:crypto` cannot read PKCS#12. There is no
// KeyObject import for it and no plan to add one, so the choice was a pure-JS ASN.1
// dependency or the openssl binary that is already on the box (3.0.20, checked). The binary
// won — a new dependency to parse the operator's private key is a larger surface than a
// subprocess whose input and output are both under our control.
//
// HANDLING OF THE OPERATOR'S IDENTITY, stated plainly because it is a licence:
//
//   - the .p12 is never written to disk. It goes to openssl on stdin.
//   - the password goes through the environment, never argv, so it cannot be read out of
//     `ps` by any other user on the machine.
//   - the extracted private key is stored encrypted under SETTINGS_KEY, in a 0600 file
//     outside the database. A database dump alone does not carry it.
//
// Cloudlog re-exports the key under the hardcoded passphrase "cloudlog" and stores that in
// a MySQL column. Same effect as plaintext, since the passphrase is in the source. Rejected.

const DIR = "data/lotw";
const FILE = join(DIR, "cert.json");

/** OIDs LoTW puts its own metadata in. Registered under ARRL's arc, 1.3.6.1.4.1.12348.1. */
const OID_QSO_FIRST = "1.3.6.1.4.1.12348.1.2";
const OID_QSO_END = "1.3.6.1.4.1.12348.1.3";
const OID_DXCC = "1.3.6.1.4.1.12348.1.4";
/** The callsign, in the subject rather than an extension. Has no registered short name. */
const OID_CALLSIGN = "1.3.6.1.4.1.12348.1.1";

export interface LotwCertInfo {
  /** The callsign the certificate was issued to. Not necessarily the station's. */
  callsign: string;
  name: string | null;
  dxcc: number | null;
  validFrom: Date;
  validTo: Date;
  /**
   * The contact-date window the certificate covers, which is NOT the same as its own
   * validity. A 1998 contact is signable by a certificate issued last week, because the
   * window goes back to the start of the licence. LoTW rejects a signature over a contact
   * outside it, so this has to filter before signing rather than after being told no.
   */
  qsoStart: Date | null;
  qsoEnd: Date | null;
}

export interface LotwCert extends LotwCertInfo {
  certPem: string;
  keyPem: string;
}

export class LotwCertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LotwCertError";
  }
}

function run(
  args: string[],
  input: Buffer,
  env: Record<string, string>,
): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("openssl", args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", (e) =>
      reject(
        new LotwCertError(
          `openssl could not be run (${e.message}). It is needed to read the certificate file; install it with \`apt install openssl\`.`,
        ),
      ),
    );
    child.on("close", (code) =>
      resolve({ code: code ?? -1, out: Buffer.concat(out), err: err.trim() }),
    );
    child.stdin.on("error", () => {
      /* openssl exiting early on a bad password closes stdin; the exit code is the signal */
    });
    child.stdin.end(input);
  });
}

/**
 * Split a `.p12` into its certificate and private key.
 *
 * The `-legacy` retry is not defensive padding. TQSL writes PKCS#12 with 40-bit RC2 for the
 * certificate bag, and OpenSSL 3 moved RC2 into the legacy provider — so a stock `openssl
 * pkcs12` on a current distribution fails on a file TQSL just produced, with an error
 * ("unsupported", or "Algorithm ... not found") that says nothing about what to do. Anyone
 * who has hit this knows the flag; nobody should have to.
 */
export async function readP12(
  p12: Buffer,
  password: string,
): Promise<{ certPem: string; keyPem: string }> {
  if (p12.length === 0) throw new LotwCertError("The certificate file is empty.");

  // No `-in`: openssl reads stdin by default, and naming `/dev/stdin` explicitly fails on
  // Windows, where the path does not exist. The point of stdin is that the operator's .p12
  // never lands on disk.
  const base = ["pkcs12", "-nodes", "-passin", "env:P12PASS"];
  const env = { P12PASS: password };

  let res = await run(base, p12, env);
  if (res.code !== 0 && /legacy|unsupported|not found|RC2|digital envelope/i.test(res.err)) {
    res = await run([...base, "-legacy"], p12, env);
  }

  if (res.code !== 0) {
    const why = res.err.toLowerCase();
    if (/mac verify|invalid password|wrong password/.test(why)) {
      throw new LotwCertError(
        password
          ? "That password does not open the certificate file."
          : "The certificate file is password-protected. Enter the password you set when exporting it from TQSL.",
      );
    }
    if (/not.*(pkcs12|asn1)|header too long|unable to load/.test(why)) {
      throw new LotwCertError(
        "That is not a .p12 certificate file. In TQSL, choose Callsign Certificates, right-click yours and Export — a .tq6 or .p12 request file is not the same thing.",
      );
    }
    throw new LotwCertError(`openssl could not read the certificate: ${res.err || "no detail"}`);
  }

  const text = res.out.toString("utf8");
  const certPem = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(text)?.[0];
  const keyPem = /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/.exec(
    text,
  )?.[0];

  if (!certPem) throw new LotwCertError("The file holds no certificate.");
  if (!keyPem) {
    throw new LotwCertError(
      "The file holds a certificate but no private key, so it cannot sign anything. Export again from TQSL with the private key included.",
    );
  }
  return { certPem, keyPem };
}

/** An OID in dotted form, as the DER bytes of its OBJECT IDENTIFIER contents. */
function oidBytes(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new LotwCertError(`Not an OID: ${dotted}`);
  }
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const n of parts.slice(2)) {
    const chunk: number[] = [n & 0x7f];
    let v = n >>> 7;
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(...chunk);
  }
  return Buffer.from(out);
}

/** Length of a DER TLV's value, and where that value starts. */
function derLength(buf: Buffer, at: number): { len: number; start: number } | null {
  if (at >= buf.length) return null;
  const first = buf[at]!;
  if (first < 0x80) return { len: first, start: at + 1 };
  const n = first & 0x7f;
  if (n === 0 || n > 4 || at + 1 + n > buf.length) return null;
  let len = 0;
  for (let i = 0; i < n; i++) len = (len << 8) | buf[at + 1 + i]!;
  return { len, start: at + 1 + n };
}

/**
 * Read one certificate extension's value as text, by finding its OID in the DER.
 *
 * A search rather than a walk down the certificate structure. Walking is more principled
 * and about four times the code; the encoded form of `1.3.6.1.4.1.12348.1.4` is eleven
 * specific bytes, and the chance of those appearing by accident inside a 1 kB certificate --
 * and being followed by a well-formed OCTET STRING wrapping a well-formed string -- is not
 * a risk worth writing an ASN.1 parser to avoid.
 *
 * The inner TLV header is stripped. `extnValue` is an OCTET STRING wrapping the real value,
 * so the raw octets begin with something like `13 03` before "291". Cloudlog does NOT strip
 * it: it hands `"\x13\x03291"` to MySQL and relies on an INT column coercing it to 291,
 * which works right up until the value is used anywhere other than a lenient database.
 */
export function certExtensionText(der: Buffer, dotted: string): string | null {
  const needle = oidBytes(dotted);
  const oidTlv = Buffer.concat([Buffer.from([0x06, needle.length]), needle]);
  const at = der.indexOf(oidTlv);
  if (at < 0) return null;

  let p = at + oidTlv.length;
  // Optional `critical` BOOLEAN between the OID and the value.
  if (der[p] === 0x01) {
    const b = derLength(der, p + 1);
    if (!b) return null;
    p = b.start + b.len;
  }
  if (der[p] !== 0x04) return null; // extnValue is always an OCTET STRING
  const outer = derLength(der, p + 1);
  if (!outer) return null;

  const inner = der.subarray(outer.start, outer.start + outer.len);
  const innerLen = derLength(inner, 1);
  if (!innerLen || innerLen.start + innerLen.len > inner.length) {
    // Not a wrapped TLV: take the octets as they are rather than returning nothing.
    return inner.toString("utf8").trim() || null;
  }
  return (
    inner
      .subarray(innerLen.start, innerLen.start + innerLen.len)
      .toString("utf8")
      .trim() || null
  );
}

/**
 * A date out of one of LoTW's own extensions.
 *
 * Formats accepted rather than assumed: these are strings inside a vendor extension, not a
 * standard ASN.1 time, and the shape is not documented anywhere ARRL publishes. An
 * unparseable value returns null and the caller declines to filter on it -- better to
 * attempt an upload LoTW might refuse than to silently drop the operator's whole back
 * catalogue because a date came back in an unexpected shape.
 */
function parseCertDate(raw: string | null): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ]?(\d{2}):?(\d{2}):?(\d{2}))?Z?$/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
    ),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A field out of the certificate subject.
 *
 * LoTW puts the callsign in an OID with no registered short name, which is why PHP surfaces
 * it as `subject.undefined` and why Node renders the line as `1.3.6.1.4.1.12348.1.1=K9XYZ`.
 * Both are the same field seen through different libraries. commonName is the operator's
 * NAME, not their call, so reading that instead produces a tSTATION record for "Sam Example"
 * and an upload LoTW refuses.
 */
function subjectField(subject: string, key: string): string | null {
  for (const line of subject.split("\n")) {
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() === key) return line.slice(idx + 1).trim() || null;
  }
  return null;
}

export function certInfoFromPem(certPem: string): LotwCertInfo {
  let x: X509Certificate;
  try {
    x = new X509Certificate(certPem);
  } catch (err) {
    throw new LotwCertError(
      `The certificate could not be read: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  const callsign =
    subjectField(x.subject, OID_CALLSIGN) ?? subjectField(x.subject, "undefined");
  if (!callsign) {
    throw new LotwCertError(
      "That certificate carries no callsign, so it is not a LoTW callsign certificate. Export the one under Callsign Certificates in TQSL.",
    );
  }

  const der = x.raw;
  const dxccRaw = certExtensionText(der, OID_DXCC);

  return {
    callsign: callsign.toUpperCase(),
    name: subjectField(x.subject, "CN"),
    dxcc: dxccRaw && /^\d+$/.test(dxccRaw) ? Number(dxccRaw) : null,
    validFrom: new Date(x.validFrom),
    validTo: new Date(x.validTo),
    qsoStart: parseCertDate(certExtensionText(der, OID_QSO_FIRST)),
    qsoEnd: parseCertDate(certExtensionText(der, OID_QSO_END)),
  };
}

interface Stored {
  v: 1;
  certPem: string;
  /** The private key PEM, through `encryptSecret`. Never written in the clear. */
  keyEnc: string;
  info: {
    callsign: string;
    name: string | null;
    dxcc: number | null;
    validFrom: string;
    validTo: string;
    qsoStart: string | null;
    qsoEnd: string | null;
  };
  uploadedAt: string;
}

function toStoredInfo(i: LotwCertInfo): Stored["info"] {
  return {
    callsign: i.callsign,
    name: i.name,
    dxcc: i.dxcc,
    validFrom: i.validFrom.toISOString(),
    validTo: i.validTo.toISOString(),
    qsoStart: i.qsoStart?.toISOString() ?? null,
    qsoEnd: i.qsoEnd?.toISOString() ?? null,
  };
}

function fromStoredInfo(s: Stored["info"]): LotwCertInfo {
  return {
    callsign: s.callsign,
    name: s.name,
    dxcc: s.dxcc,
    validFrom: new Date(s.validFrom),
    validTo: new Date(s.validTo),
    qsoStart: s.qsoStart ? new Date(s.qsoStart) : null,
    qsoEnd: s.qsoEnd ? new Date(s.qsoEnd) : null,
  };
}

/** Store a certificate, replacing whatever was there. Returns what was read out of it. */
export async function saveLotwCert(
  p12: Buffer,
  password: string,
  now = new Date(),
): Promise<LotwCertInfo> {
  const { certPem, keyPem } = await readP12(p12, password);
  const info = certInfoFromPem(certPem);

  if (info.validTo.getTime() < now.getTime()) {
    throw new LotwCertError(
      `That certificate for ${info.callsign} expired on ${info.validTo.toISOString().slice(0, 10)}. LoTW refuses anything signed with it, so uploads would fail silently -- renew it in TQSL first.`,
    );
  }

  const stored: Stored = {
    v: 1,
    certPem,
    keyEnc: encryptSecret(keyPem),
    info: toStoredInfo(info),
    uploadedAt: now.toISOString(),
  };

  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
  // Explicit, because an existing file keeps its old mode through writeFile.
  await chmod(FILE, 0o600);
  return info;
}

async function read(): Promise<Stored | null> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Stored;
  } catch {
    return null;
  }
}

/** What is on file, without decrypting the key. Safe to hand to the UI. */
export async function lotwCertInfo(): Promise<(LotwCertInfo & { uploadedAt: Date }) | null> {
  const s = await read();
  if (!s?.info) return null;
  return { ...fromStoredInfo(s.info), uploadedAt: new Date(s.uploadedAt) };
}

/** The certificate AND the key, for signing. Only the uploader should call this. */
export async function loadLotwCert(): Promise<LotwCert | null> {
  const s = await read();
  if (!s?.certPem || !s.keyEnc) return null;
  // `decryptSecret` returns null on a bad key or a tampered ciphertext rather than
  // throwing, so this is the only place the failure is visible. Left un-caught would
  // hand a null key to the signer and produce an unhelpful crypto error instead.
  const keyPem = decryptSecret(s.keyEnc);
  if (keyPem === null) {
    throw new LotwCertError(
      "The stored LoTW private key cannot be decrypted, which means SETTINGS_KEY has changed since it was uploaded. Upload the certificate again.",
    );
  }
  return { ...fromStoredInfo(s.info), certPem: s.certPem, keyPem };
}

export async function deleteLotwCert(): Promise<boolean> {
  if (!(await read())) return false;
  await rm(FILE, { force: true });
  return true;
}
