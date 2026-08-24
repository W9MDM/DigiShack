import { gunzipSync } from "node:zlib";

// Parser for Club Log's cty.xml.
//
// Schema: https://cdn.clublog.org/cty.xsd
// Download: https://cdn.clublog.org/cty.php?api=APIKEY (gzipped, updated daily)
//
// Structure, per the XSD:
//   <clublog date="...">
//     <entities>          <entity>  adif name prefix deleted [cqz cont long lat start end
//                                   whitelist whitelist_start whitelist_end]
//     <exceptions>        <exception record="n">  call entity adif [cqz cont long lat start end]
//     <prefixes>          <prefix record="n">     call entity adif [cqz cont long lat start end]
//     <invalid_operations><invalid record="n">    call [start end]
//     <satellites>        <satellite record="n">  [satid] name description
//     <zone_exceptions>   <zone_exception record="n"> call zone [start end]
//
// Hand-rolled rather than pulling in an XML library: the document is flat, has no
// namespaces, no mixed content, and no attributes we need beyond the root date.
// It is also several megabytes, so a scanning parse beats building a DOM.

export interface CtyEntity {
  adif: number;
  name: string;
  prefix: string;
  deleted: boolean;
  cqZone: number | null;
  continent: string | null;
  latitude: number | null;
  longitude: number | null;
  validFrom: Date | null;
  validTo: Date | null;
}

export interface CtyPrefix {
  call: string;
  entity: string;
  adif: number;
  cqZone: number | null;
  continent: string | null;
  latitude: number | null;
  longitude: number | null;
  validFrom: Date | null;
  validTo: Date | null;
}

export interface CtyFile {
  /** The `date` attribute on <clublog> — when Club Log generated the file. */
  fileDate: Date | null;
  entities: CtyEntity[];
  /** From <prefixes>: matched by prefix. */
  prefixes: CtyPrefix[];
  /** From <exceptions>: matched as a complete callsign, ahead of any prefix. */
  exceptions: CtyPrefix[];
  /** Non-fatal problems, so a slightly odd file still imports. */
  problems: string[];
}

/** Gunzip if needed — the Club Log endpoint serves a GZIP archive. */
export function decompressIfNeeded(input: Buffer): Buffer {
  // GZIP magic number.
  if (input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b) {
    return gunzipSync(input);
  }
  return input;
}

const FIELD_CACHE = new Map<string, RegExp>();

function field(block: string, name: string): string | null {
  let re = FIELD_CACHE.get(name);
  if (!re) {
    re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i");
    FIELD_CACHE.set(name, re);
  }
  const m = re.exec(block);
  if (!m || m[1] === undefined) return null;
  const raw = m[1].trim();
  return raw === "" ? null : decodeEntities(raw);
}

function decodeEntities(s: string): string {
  // cty.xml contains entity names with ampersands; the rest are rare but cheap
  // to handle. No numeric-reference handling — the file is plain ASCII/UTF-8.
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function num(block: string, name: string): number | null {
  const raw = field(block, name);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function date(block: string, name: string): Date | null {
  const raw = field(block, name);
  if (raw === null) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function bool(block: string, name: string): boolean {
  const raw = field(block, name);
  if (raw === null) return false;
  return /^(true|1|yes)$/i.test(raw);
}

/** Iterate <tag>…</tag> blocks without building an array of the whole file. */
function* blocks(xml: string, tag: string): Generator<string> {
  // Not /g on a shared regex — a fresh one per call keeps lastIndex local.
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) yield m[1];
  }
}

/** Narrow to one section so <prefix> inside <entity> isn't mistaken for a record. */
function section(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(xml);
  return m?.[1] ?? "";
}

export function parseCtyXml(input: Buffer | string): CtyFile {
  const xml =
    typeof input === "string"
      ? input
      : decompressIfNeeded(input).toString("utf8");

  const problems: string[] = [];

  if (!/<clublog[\s>]/i.test(xml)) {
    throw new Error(
      "This does not look like a Club Log cty.xml file (no <clublog> root element).",
    );
  }

  const dateAttr = /<clublog[^>]*\bdate="([^"]+)"/i.exec(xml)?.[1] ?? null;
  const parsedDate = dateAttr ? new Date(dateAttr) : null;
  const fileDate =
    parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null;

  // --- entities ---
  const entities: CtyEntity[] = [];
  for (const b of blocks(section(xml, "entities"), "entity")) {
    const adif = num(b, "adif");
    const name = field(b, "name");
    const prefix = field(b, "prefix");

    if (adif === null || name === null || prefix === null) {
      problems.push(
        `Skipped an <entity> missing adif/name/prefix (adif=${adif ?? "?"})`,
      );
      continue;
    }

    entities.push({
      adif,
      name,
      prefix,
      deleted: bool(b, "deleted"),
      cqZone: num(b, "cqz"),
      continent: field(b, "cont"),
      latitude: num(b, "lat"),
      longitude: num(b, "long"),
      validFrom: date(b, "start"),
      validTo: date(b, "end"),
    });
  }

  // --- prefixes and exceptions (identical record shape) ---
  const readRecords = (sectionTag: string, recordTag: string): CtyPrefix[] => {
    const out: CtyPrefix[] = [];
    for (const b of blocks(section(xml, sectionTag), recordTag)) {
      const call = field(b, "call");
      const adif = num(b, "adif");
      if (call === null || adif === null) {
        problems.push(`Skipped a <${recordTag}> missing call/adif`);
        continue;
      }
      out.push({
        call: call.toUpperCase(),
        entity: field(b, "entity") ?? "",
        adif,
        cqZone: num(b, "cqz"),
        continent: field(b, "cont"),
        latitude: num(b, "lat"),
        longitude: num(b, "long"),
        validFrom: date(b, "start"),
        validTo: date(b, "end"),
      });
    }
    return out;
  };

  const prefixes = readRecords("prefixes", "prefix");
  const exceptions = readRecords("exceptions", "exception");

  if (entities.length === 0) {
    throw new Error(
      "Parsed no <entity> records — the file is empty, truncated, or not cty.xml.",
    );
  }

  return { fileDate, entities, prefixes, exceptions, problems };
}
