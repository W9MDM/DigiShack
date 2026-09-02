// The operating layer: guards, the QSO controller, the auto operator.
//
// Everything here used to be built inline inside `startFlexSource()`, which is why the
// Icom could decode, draw a waterfall and transmit a CQ by hand but could not operate by
// itself — Auto Hunt, Auto CQ, Hunt POTA, Chase POTA and the Call button all answered
// "digital.source must be flex". Not because any of this was FlexRadio-specific. It was
// simply in a function that only a FlexRadio could reach.
//
// It never was radio-specific. `QsoController` and `AutoOperator` are typed against
// `DigitalSource` and `DigitalTransmitter`, and between them they read `source.periodMs`
// and call `tx.transmit` and `tx.unkey`. That is the entire surface.
//
// WHAT ACTUALLY DIFFERS PER RADIO, and therefore all that is injected:
//
//   retune(band, mode)   Flex: `slice tune`, plus `atu start` when asked for.
//                        Icom: setFrequencyHz to the band's calling frequency.
//   tuneHz(hz)           the same two, without the band lookup.
//
// That is the whole list, and `npm run check:operating` runs an identical session
// through both shapes to keep it true.
//
// The settings reader and the data lookups are injected too, with database-backed
// defaults. Not for the sake of abstraction — it is what lets the characterisation test
// drive a full session with no database, which is the only reason this file could be
// moved out of a 2,100-line service safely.

import { prisma } from "@/lib/db/prisma";
import {
  DEFAULT_GUARDS,
  OperatingGuards,
  parseMessage,
  type AbandonedExchange,
  type QsoLogData,
} from "@/lib/digital/qso";
import { buildWorkedIndex, invalidateWorkedIndex } from "@/lib/digital/worked-index";
import { doNotCallKind } from "@/lib/digital/do-not-call";
import { fetchPskActivity } from "@/lib/propagation";
import { TxPowerTracker } from "@/lib/radio/power";
import type { WorkedIndex } from "@/lib/digital/worth";
import { resolveDxcc } from "@/lib/dxcc/resolve";
import { freqToBand } from "@/lib/ham/bands";
import { DIGITAL_FREQUENCIES, type DigitalMode } from "@/lib/ham/digital-freqs";
import { runUploads } from "@/lib/integrations/upload-runner";
import { linkWindow, sentByEither } from "@/lib/digital/decode-link";
import { setSigRefs } from "@/lib/pota/refs";
import { fetchPotaSpots } from "@/lib/pota/spots";
import { PskReporterUploader } from "@/lib/pskreporter/upload";
import type { DigitalSource, DigitalTransmitter } from "@/lib/radio/types";
import type { RadioKind } from "@/lib/radio/transmit-gate";
import { getBooleanSetting, getNumberSetting, getSetting } from "@/lib/settings";
import { AutoOperator } from "./auto-operator";
import { QsoController, type QsoLogContext } from "./qso-controller";

/** Settings, behind an interface so the characterisation test needs no database. */
export interface SettingsReader {
  getString(key: string): Promise<string | null>;
  getNumber(key: string, fallback: number): Promise<number>;
  getBoolean(key: string, fallback: boolean): Promise<boolean>;
}

export const databaseSettings: SettingsReader = {
  getString: (key) => getSetting(key),
  getNumber: (key, fallback) => getNumberSetting(key, fallback),
  getBoolean: (key, fallback) => getBooleanSetting(key, fallback),
};

export interface DxccEntity {
  adif: number;
  name: string;
  cqZone: number | null;
  continent: string | null;
}

export interface PotaSpot {
  activator: string;
  freqHz: number;
  band: string | null;
  mode: string;
  reference: string;
  parkName: string | null;
}

/** The four things the operating layer asks the outside world. */
export interface OperatingData {
  wasWorked(call: string, band: string, mode: string, sinceMs: number): Promise<boolean>;
  /** Ever worked on this band, any mode — the band-slot question. */
  workedOnBandEver(call: string, band: string): Promise<boolean>;
  /**
   * What the do-not-call list says about this callsign — "NEVER", "NO_DUPES" or null.
   *
   * On the injectable data layer rather than imported straight into the wiring below, for
   * the same reason `wasWorked` is: this is a database question, and the operating layer
   * is built in tests that have no database. Reaching for Prisma here made every call
   * attempt in the harness await a connection that would never come, and three POTA
   * chase assertions failed with empty results — a fault in the test rig caused entirely
   * by a shortcut in production wiring.
   */
  listedAs(call: string): Promise<"NEVER" | "NO_DUPES" | null>;
  /** Persist a completed QSO and push it to the log-hosting services. */
  logQso(log: QsoLogData, ctx: QsoLogContext): Promise<void>;
  /**
   * Persist an exchange that swapped reports and was never acknowledged.
   *
   * NOT a QSO, and deliberately a separate method rather than a flag on `logQso`: nothing this
   * records is uploaded anywhere or counted for an award. It exists because discarding it loses
   * a contact the far station has — they heard our final roger and logged it — and the only
   * previous trace was a decode row with a null qsoId.
   */
  recordIncomplete(x: AbandonedExchange, ctx: QsoLogContext): Promise<void>;
  workedIndex(band: string | null): Promise<WorkedIndex>;
  resolveEntity(call: string): Promise<DxccEntity | null>;
  potaSpots(): Promise<PotaSpot[]>;
}

export interface OperatingDeps {
  /** Which radio this is. Only affects log lines and the band-hop warning. */
  kind: RadioKind;
  /**
   * Override how long the auto operator listens before judging a band, ms.
   *
   * For the bench only. Production leaves it unset and gets the measured 90 seconds; a
   * fixture that would otherwise have to feed ninety seconds of simulated windows to reach
   * the behaviour it is actually testing can shorten it.
   */
  warmupMs?: number;
  source: DigitalSource & { readonly mode: DigitalMode };
  tx: DigitalTransmitter;
  station: { id: string; callsign: string; grid: string };
  /** Where the radio is tuned, read at transmit time rather than captured. */
  dialHz: () => number | null;
  /**
   * What the radio calls itself — "FLEX-6400", "IC-7300MK2" — recorded on the contact.
   *
   * A function rather than a value because the Flex only learns its own model once
   * `info` comes back, which is after the operating layer is built.
   */
  radio: () => string | null;
  /**
   * The radio's transmit-filter ceiling in Hz, or null when it does not report one.
   *
   * Optional because only the FlexRadio answers it. An IC-7300 selects its transmit
   * passband in a menu CI-V cannot read, so it keeps the conservative default.
   */
  txFilterHiHz?: () => number | null;
  /** Receive noise floor in dBm, for judging whether a band is worth sitting on. */
  noiseDbm?: () => number | null;
  /**
   * The clock the QSO scheduler works against. Defaults to the corrected wall clock.
   *
   * Only a test supplies this. See `now` on QsoControllerOptions for why it exists.
   */
  now?: () => number;
  /** Move to a band's calling frequency. The FlexRadio also runs its ATU here. */
  retune: (band: string, mode: DigitalMode) => Promise<boolean>;
  /** Move to an exact frequency — POTA activators are off the calling frequency. */
  tuneHz: (hz: number) => Promise<boolean>;
  broadcast: (event: unknown) => void;
  /** Already prefixed by the caller, e.g. `[radio] `. */
  log: (line: string) => void;
  /**
   * Write out any decodes still buffered, before they are looked for in the database.
   *
   * The bridge batches decode inserts on a one-second timer, and a contact is logged the
   * instant the last message of the exchange arrives — so the row for that message is
   * usually still in the buffer. Without this the final decode of every contact goes
   * unlinked, which is exactly the one an operator would look for.
   */
  flushDecodes?: () => Promise<void>;
  settings?: SettingsReader;
  data?: OperatingData;
}

export interface Operating {
  guards: OperatingGuards;
  qsoController: QsoController;
  autoOperator: AutoOperator;
  /** Non-null when `pskreporter.upload` is on. The caller feeds it decodes. */
  pskUploader: PskReporterUploader | null;
  /**
   * Measured transmit power for the contact in progress.
   *
   * Owned here and exposed so the caller can feed it the radio's forward-power
   * meter: only the source knows how to read one, and only this layer knows when a
   * contact begins and ends.
   */
  txPower: TxPowerTracker;
}

/**
 * The real data lookups: the log, the DXCC file and the POTA spot feed.
 *
 * Distinct-value queries rather than loading rows for the worked index: at 26 k QSOs the
 * difference is a few milliseconds against a few hundred, and the auto operator asks for
 * it whenever the cache expires.
 */
/** Who sent a message, or null when it cannot be read from it. */
function senderOf(message: string): string | null {
  const p = parseMessage(message);
  return p.kind === "cq" || p.kind === "directed" ? p.from : null;
}

export function databaseOperatingData(opts: {
  /** The callsign is needed as well as the id: linking a contact's decodes has to tell
   * our own transmissions from theirs, and only the message's sender field says which. */
  station: { id: string; callsign: string };
  log: (line: string) => void;
  /** See OperatingDeps.flushDecodes — needed before a contact's decodes are looked up. */
  flushDecodes?: () => Promise<void>;
}): OperatingData {
  const { station, log } = opts;
  return {
    wasWorked: async (call, band, mode, sinceMs) => {
      const hit = await prisma.qso.findFirst({
        where: {
          callsign: call.toUpperCase(),
          band,
          mode,
          startTime: { gte: new Date(sinceMs) },
        },
        select: { id: true },
      });
      return hit !== null;
    },

    // Have we EVER worked them on this band, in any mode?
    //
    // Deliberately not `wasWorked` with sinceMs=0: that one is band AND mode, and a band
    // slot does not care which digital mode filled it. Somebody worked on 20 m FT4 is not
    // a new 20 m contact because today it happens to be FT8.
    //
    // Indexed by [callsign, band, mode] — the existing dupe-check index — which serves a
    // callsign+band lookup on its leading columns, so this adds a query but no schema.
    workedOnBandEver: async (call, band) => {
      const hit = await prisma.qso.findFirst({
        where: { callsign: call.toUpperCase(), band },
        select: { id: true },
      });
      return hit !== null;
    },

    listedAs: (call) => doNotCallKind(call),

    recordIncomplete: async (x, ctx) => {
      // A row, not a QSO. Nothing here is uploaded or counted; it is kept so an exchange the
      // far station logged does not vanish from this side, and so an operator can promote it
      // once something corroborates it — a card request, an eQSL confirmation, a direct email.
      //
      // Failing soft on purpose. This is bookkeeping for something that already did not
      // happen, and throwing here would take down the operating loop over it.
      try {
        await prisma.incompleteExchange.create({
          data: {
            callsign: x.theirCall,
            band: ctx.band ?? "?",
            mode: ctx.mode,
            freqHz: ctx.freqHz === null ? null : BigInt(ctx.freqHz),
            startedAt: new Date(x.startedAt),
            endedAt: new Date(x.endedAt),
            stage: x.stage,
            reportSent: x.reportSent,
            reportRcvd: x.reportRcvd,
            gridSquare: x.theirGrid,
            reason: "No acknowledgement decoded before the sequence gave up",
            transcript: ctx.transcript ?? null,
            stationId: opts.station.id,
          },
        });
      } catch (err) {
        console.error(
          `[qso] could not record the incomplete exchange with ${x.theirCall}: ` +
            (err instanceof Error ? err.message : "unknown"),
        );
      }
    },

    logQso: async (logData, ctx) => {
      // Resolve the entity AT LOG TIME.
      //
      // Every QSO this station logged itself was missing dxcc, cqZone and continent
      // — 70 of them, and 70 of the only 71 in a 26,238-contact log without an
      // entity. So not one native contact counted toward DXCC, WAZ or WAC, while
      // every imported one did. The resolver was already wired into this process
      // for award-aware hunt ranking; the logging path simply never called it.
      //
      // Failing soft: no cty data loaded means a contact with no entity, which is
      // what the DXCC page's backfill is for. Refusing to log a QSO because a
      // reference file is missing would be much worse.
      let entity: { adif: number; cqZone: number | null; continent: string | null } | null = null;
      try {
        const r = await resolveDxcc(logData.theirCall);
        if (r.status === "found") {
          entity = {
            adif: r.match.adif,
            cqZone: r.match.cqZone,
            continent: r.match.continent,
          };
        }
      } catch {
        /* no cty data — the contact is still worth logging */
      }
      const created = await prisma.qso.create({
        data: {
          callsign: logData.theirCall,
          band: ctx.band ?? "?",
          freqHz: BigInt(ctx.freqHz ?? 0),
          mode: ctx.mode,
          startTime: new Date(logData.startedAt || logData.completedAt),
          endTime: new Date(logData.completedAt),
          rstSent: logData.reportSent,
          rstRcvd: logData.reportRcvd,
          gridSquare: logData.theirGrid,
          dxcc: entity?.adif ?? null,
          cqZone: entity?.cqZone ?? null,
          continent: entity?.continent ?? null,
          sig: ctx.sig,
          sigInfo: ctx.sigInfo,
          radio: ctx.radio,
          // Measured, not the slider setting. Null when the radio has no
          // forward-power meter — a QSL then falls back to the station constant.
          txPowerW: ctx.txPowerW,
          // The exchange itself, every message of it. See lib/digital/transcript.ts.
          transcript: ctx.transcript,
          notes: "DigiShack native FT8/FT4",
          stationId: station.id,
        },
      });
      // The mirrored columns above are written by the create; the reference row
      // that makes them queryable has to follow. Going through setSigRefs rather
      // than inserting directly keeps the primary flag and the mirror consistent
      // with every other writer.
      if (created.sig && created.sigInfo) {
        await setSigRefs(prisma, created.id, created.sig, [created.sigInfo]);
      }

      // Attach the decodes of this contact to it.
      //
      // Nothing ever set DigitalDecode.qsoId, so the panel on the contact page said
      // "Populated by the bridge in Phase 4a" for every contact ever logged — and the
      // retention sweep's exception for decodes attached to a contact protected nothing,
      // so the raw decodes of real contacts were pruned at thirty days with the noise.
      //
      // Failure here must not unmake the contact: it is already logged and already
      // uploaded, and losing a display link is not worth an exception on the path that
      // returns to the transmit window.
      try {
        await opts.flushDecodes?.();
        const window = linkWindow(created);
        const candidates = await prisma.digitalDecode.findMany({
          where: {
            timestamp: { gte: window.from, lte: window.to },
            band: created.band,
            mode: created.mode,
            qsoId: null,
          },
          select: { id: true, message: true },
        });
        // Filtered in code rather than with a LIKE, for two reasons. A callsign has to
        // match as a whole token — LIKE '%K1AB%' matches K1ABC — and what belongs to a
        // contact is what the two stations SENT, not every message naming them. See
        // sentByEither: a third station calling ours is a different conversation.
        const mine = candidates
          .filter((d) => sentByEither(d.message, senderOf, created.callsign, opts.station.callsign))
          .map((d) => d.id);
        if (mine.length > 0) {
          await prisma.digitalDecode.updateMany({
            where: { id: { in: mine } },
            data: { qsoId: created.id },
          });
        }
      } catch (err) {
        log(`could not link decodes to the contact: ${err instanceof Error ? err.message : err}`);
      }
      log(`logged ${logData.theirCall} (${logData.reportSent}/${logData.reportRcvd ?? "?"})`);

      // Push it to the log-hosting services.
      //
      // Fire and forget: an upload is a request to somebody else's server and must
      // never delay the next transmit window, and a service being down is not a
      // reason for the contact to be any less logged. Anything missed here is
      // picked up by the sweep.
      void runUploads()
        .then((r) => {
          for (const s of r.services) {
            if (s.uploaded > 0 || s.duplicates > 0) {
              console.log(
                `[upload] ${s.service}: ${s.uploaded} sent` +
                  (s.duplicates ? `, ${s.duplicates} already there` : ""),
              );
            }
            if (s.failed > 0) {
              console.error(`[upload] ${s.service}: ${s.failed} failed — ${s.errors[0] ?? ""}`);
            }
          }
        })
        .catch((err) => console.error(`[upload] ${err instanceof Error ? err.message : err}`));
    },

    workedIndex: async (band) => buildWorkedIndex(band),

    resolveEntity: async (call) => {
      try {
        const r = await resolveDxcc(call);
        if (r.status !== "found") return null;
        return {
          adif: r.match.adif,
          name: r.match.name,
          cqZone: r.match.cqZone,
          continent: r.match.continent,
        };
      } catch {
        // No cty data loaded: hunting still works, just without award ranking.
        return null;
      }
    },

    potaSpots: async () => {
      const spots = await fetchPotaSpots();
      return spots.map((s) => ({
        activator: s.activator,
        freqHz: s.freqHz,
        band: s.band,
        mode: s.mode,
        reference: s.reference,
        parkName: s.parkName,
      }));
    },
  };
}

/**
 * The band's calling frequency for a mode.
 *
 * Both radios need this and neither owns it: `retune(band, mode)` is a band change on
 * the Flex and a frequency change on the Icom, but the frequency is the same one.
 */
export function callingFrequencyHz(band: string, mode: DigitalMode): number | null {
  return DIGITAL_FREQUENCIES.find((x) => x.band === band && x.mode === mode)?.hz ?? null;
}

export async function buildOperating(deps: OperatingDeps): Promise<Operating> {
  const { source, tx, station, broadcast, log } = deps;
  const s = deps.settings ?? databaseSettings;
  const data = deps.data ?? databaseOperatingData({ station, log, flushDecodes: deps.flushDecodes });

  // Guards from Settings, not the hardcoded defaults.
  //
  // `new OperatingGuards()` with no argument made all eight thresholds immutable
  // from the UI — including maxSwr and maxPaTempC, the two that protect hardware.
  const guards = new OperatingGuards({
    maxCallAttempts: await s.getNumber("auto.maxCallAttempts", DEFAULT_GUARDS.maxCallAttempts),
    failureCooldownMs:
      (await s.getNumber("auto.failureCooldownMin", DEFAULT_GUARDS.failureCooldownMs / 60_000)) *
      60_000,
    dupeWindowMs:
      (await s.getNumber("auto.dupeWindowHours", DEFAULT_GUARDS.dupeWindowMs / 3_600_000)) *
      3_600_000,
    skipWorkedOnBandModeEver: await s.getBoolean("auto.skipWorkedOnBandMode", true),
    skipWorkedOnBandEver: await s.getBoolean("auto.skipWorkedOnBand", false),
    maxUnansweredCqs: await s.getNumber("auto.maxUnansweredCqs", DEFAULT_GUARDS.maxUnansweredCqs),
    maxConsecutiveTx: await s.getNumber("auto.maxConsecutiveTx", DEFAULT_GUARDS.maxConsecutiveTx),
    deafWindowLimit: await s.getNumber("auto.deafWindowLimit", DEFAULT_GUARDS.deafWindowLimit),
    maxSwr: await s.getNumber("auto.maxSwr", DEFAULT_GUARDS.maxSwr),
    maxPaTempC: await s.getNumber("auto.maxPaTempC", DEFAULT_GUARDS.maxPaTempC),
    maxRunMinutes: await s.getNumber("auto.maxRunMinutes", DEFAULT_GUARDS.maxRunMinutes),
    maxQsosPerRun: await s.getNumber("auto.maxQsosPerRun", DEFAULT_GUARDS.maxQsosPerRun),
  });
  // unansweredCqs is in here because it is the guard that raises a QUIET pause, and a
  // quiet pause is the only thing that makes the radio change band. It was invisible, and
  // it was set to 0 — off — on this install, so band hopping could never have happened
  // however long the radio called into a dead band.
  log(
    `guards: run<=${guards.config.maxRunMinutes}min qsos<=${guards.config.maxQsosPerRun} ` +
      `swr<=${guards.config.maxSwr} pa<=${guards.config.maxPaTempC}C ` +
      `consecTx<=${guards.config.maxConsecutiveTx} unansweredCqs<=${guards.config.maxUnansweredCqs} ` +
      `deafWindows<=${guards.config.deafWindowLimit}`,
  );

  // Band hopping moves the dial on any radio, and a band the tuner has never seen means
  // fold-back to a few watts — unattended, on a band nobody is watching. Said once at
  // startup rather than discovered from a log the next morning.
  //
  // The Icom has had an ATU command since 1.19.0, so the warning is now about the
  // SETTING being off rather than about the radio being incapable. It said the latter
  // for several versions after it stopped being true.
  if (await s.getBoolean("auto.bandHop", false)) {
    if (deps.kind === "icom" && !(await s.getBoolean("icom.atuOnBandChange", false))) {
      log(
        "band hopping is on but icom.atuOnBandChange is off: the radio will change band " +
          "without running its tuner, so expect fold-back on a band it has not seen",
      );
    } else if (deps.kind !== "flex" && deps.kind !== "icom") {
      log(
        `band hopping is on: the ${deps.kind} will move the dial, but there is no ATU ` +
          `command for it, so expect fold-back on a band its tuner has not seen`,
      );
    }
  }

  // PSKReporter reporting, if enabled. Needs our callsign and grid, which is why it is
  // built here alongside the identity the operating layer already has.
  let pskUploader: PskReporterUploader | null = null;
  if (await s.getBoolean("pskreporter.upload", false)) {
    pskUploader = new PskReporterUploader({
      callsign: station.callsign,
      grid: station.grid,
      software: `DigiShack ${process.env.npm_package_version ?? ""}`.trim(),
      antenna: await s.getString("pskreporter.antenna"),
    });
    log(`PSKReporter reporting enabled as ${station.callsign}`);
  }

  const getBandMode = () => {
    const dialHz = deps.dialHz();
    return {
      band: dialHz !== null ? freqToBand(dialHz) : null,
      mode: source.mode,
      dialHz,
    };
  };
  // REFUSE TO TRANSMIT WITHOUT A REAL CALLSIGN OF OUR OWN.
  //
  // The last line of defence, and it is deliberately here rather than only at setup: this
  // is the value that goes on the air, and it must be checked where it is used and not
  // merely where it is entered. A station record can arrive from a restored backup, a
  // hand-edited row, an import, or a seed script — setup validation protects none of those
  // paths.
  //
  // `N0CALL` and friends are refused by name. They are the conventional placeholders, so
  // they are exactly what somebody types to get past a form, and transmitting one is both
  // unidentified operation and a lie about who is calling.
  const myCall = (station.callsign ?? "").trim().toUpperCase();
  const PLACEHOLDERS = ["N0CALL", "NOCALL", "MYCALL", "CALLSIGN", "XXXXX", "TEST"];
  if (!myCall || PLACEHOLDERS.includes(myCall)) {
    throw new Error(
      `The station callsign is ${myCall ? `a placeholder (${myCall})` : "not set"}, so this ` +
        "will not start: transmitting without a valid callsign of your own is unidentified " +
        "operation. Set it on the Stations page.",
    );
  }
  const identity = { myCall: station.callsign, myGrid: station.grid };

  let autoOperator: AutoOperator | null = null;
  const txPower = new TxPowerTracker();

  const qsoController = new QsoController({
    source,
    tx,
    guards,
    identity,
    getBandMode,
    // What the RADIO says its transmitter can reach, so a station at 2903 Hz on a rig
    // whose filter runs to 3100 is answerable instead of refused on a constant.
    txFilterHiHz: deps.txFilterHiHz,
    now: deps.now,
    radio: deps.radio,
    txPower,
    // Straight to the auto operator: it keeps the tally per band.
    onOutcome: (result) => autoOperator?.noteContactOutcome(result),
    wasWorked: data.wasWorked,
    onIncomplete: async (x, ctx) => {
      await data.recordIncomplete(x, ctx);
    },
    onLog: async (logData, ctx) => {
      // The worked index just changed.
      autoOperator?.invalidateWorked();
      // The web tier reads the same index for the decode-list badges.
      invalidateWorkedIndex();
      await data.logQso(logData, ctx);
    },
    broadcast,
    log,
  });

  autoOperator = new AutoOperator({
    source,
    tx,
    guards,
    warmupMs: deps.warmupMs,
    controller: qsoController,
    identity,
    getBandMode,
    wasWorked: data.wasWorked,
    // Resolved per call attempt, not captured once: the do-not-call list is edited while
    // the station operates, and an entry added mid-run must take effect on the next call
    // rather than at the next restart.
    callChecks: () => ({
      listedAs: data.listedAs,
      workedOnBandEver: data.workedOnBandEver,
    }),
    retune: deps.retune,
    bandHop: async () => ({
      enabled: await s.getBoolean("auto.bandHop", false),
      bands: ((await s.getString("auto.hopBands")) ?? "40M,20M,30M,80M")
        .split(",")
        .map((b) => b.trim().toUpperCase())
        .filter(Boolean),
      toBusiest: await s.getBoolean("auto.hopToBusiest", false),
      whenBetterRatio: await s.getNumber("auto.hopWhenBetterRatio", 2.5),
    }),
    // The same PSKReporter figures the decodes page's band strip shows. The fetcher
    // holds a five-minute cache and collapses concurrent callers, so asking on every
    // hop cannot turn into a rate-limit block — and it is only ever called when
    // hop-to-busiest is on and the operator is actually hopping.
    noiseDbm: () => deps.noiseDbm?.() ?? null,
    bandActivity: async () => {
      const contact =
        (await s.getString("pskreporter.contact")) ?? (await s.getString("smtp.from")) ?? "digishack";
      const { mode } = getBandMode();
      return fetchPskActivity({
        mode,
        contact,
        ourCallsign: identity.myCall || null,
      });
    },
    huntPrefs: async () => ({
      newOnly: await s.getBoolean("auto.huntNewOnly", false),
      minSnr: await s.getNumber("auto.huntMinSnr", -22),
      // HERE AND NOT IN THE GUARDS CONSTRUCTOR, deliberately. `huntPrefs` is awaited fresh
      // on every hunted window, so this takes effect within the settings cache TTL and
      // needs no bridge restart. A setting that changes who the transmitter calls — and
      // whose risk is doubling on a stranger's contact — is one an operator will want to
      // switch off mid-session and see obeyed on the next cycle.
      callFinished: await s.getBoolean("auto.callFinishedStations", false),
    }),
    resolveEntity: data.resolveEntity,
    workedIndex: data.workedIndex,
    potaPrefs: async () => {
      // Blank means "the band chase started on" — expressed as null so the
      // operator can tell it apart from an explicit list. "any" opts into
      // following spots anywhere, which is a choice rather than a default.
      const raw = ((await s.getString("pota.chaseBands")) ?? "").trim();
      const bands =
        raw === ""
          ? null
          : /^any$/i.test(raw)
            ? []
            : raw
                .split(",")
                .map((b) => b.trim().toUpperCase())
                .filter(Boolean);
      return {
        bands,
        giveUpMs: (await s.getNumber("pota.chaseGiveUpSec", 90)) * 1000,
        retryMs: (await s.getNumber("pota.chaseRetrySpotMin", 30)) * 60_000,
        workAudible: await s.getBoolean("pota.chaseWorkAudible", true),
        preferNew: await s.getBoolean("pota.chasePreferNew", true),
        returnToCalling: await s.getBoolean("pota.chaseReturnToCalling", true),
      };
    },
    potaSpots: data.potaSpots,
    tuneHz: deps.tuneHz,
    broadcast,
    log,
  });

  return { guards, qsoController, autoOperator, pskUploader, txPower };
}
