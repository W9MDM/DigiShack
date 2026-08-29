import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { getLotwLastRun, testLotw } from "@/lib/integrations/lotw";
import { testQrzLogbook } from "@/lib/integrations/qrz-logbook";
import { testCloudlog } from "@/lib/integrations/cloudlog";
import { testN3fjp } from "@/lib/integrations/n3fjp";
import { lotwCertInfo } from "@/lib/integrations/lotw-cert";
import { getSetting } from "@/lib/settings";

// Read-only credential checks.
//
// Every probe here READS. Nothing uploads, nothing modifies a remote logbook — so
// this is safe to run against live accounts, which is the point: an operator
// should be able to confirm their credentials without risking a stray QSO
// appearing in their public log.
//
// Services with no read-only endpoint are reported as "configured, untested"
// rather than being probed with a write.

interface ServiceStatus {
  id: string;
  label: string;
  configured: boolean;
  /** null when there is no safe way to verify without writing. */
  ok: boolean | null;
  detail: string;
  capabilities: string[];
}

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const [
    qrzKey,
    qrzUser,
    lotwUser,
    lotwCert,
    eqslUser,
    clublogEmail,
    hrdlogCall,
  ] = await Promise.all([
    getSetting("qrz.logbookApiKey"),
    getSetting("qrz.username"),
    getSetting("lotw.username"),
    lotwCertInfo(),
    getSetting("eqsl.username"),
    getSetting("clublog.email"),
    getSetting("hrdlog.callsign"),
  ]);

  // Cloudlog/Wavelog and N3FJP were BOTH missing from this page while being two of the
  // six things the upload sweep actually pushes to. An integrations page that lists five
  // of seven services is worse than one that lists none: the two absent ones read as "not
  // supported" rather than "not shown", and the operator goes looking for a feature that
  // is already there.
  const [cloudlogUrl, n3fjpHost] = await Promise.all([
    getSetting("cloudlog.url"),
    getSetting("n3fjp.host"),
  ]);

  const services: ServiceStatus[] = [];

  // --- QRZ logbook: STATUS is read-only ---
  if (qrzKey) {
    const t = await testQrzLogbook();
    services.push({
      id: "qrz",
      label: "QRZ Logbook",
      configured: true,
      ok: t.ok,
      detail: t.detail,
      capabilities: ["upload", "fetch"],
    });
  } else {
    services.push({
      id: "qrz",
      label: "QRZ Logbook",
      configured: false,
      ok: null,
      detail: qrzUser
        ? "XML login is set but qrz.logbookApiKey is missing — the Logbook key is separate and per-logbook."
        : "Not configured",
      capabilities: [],
    });
  }

  // --- LoTW: the report query is read-only ---
  if (lotwUser) {
    const t = await testLotw();
    services.push({
      id: "lotw",
      label: "Logbook of the World",
      configured: true,
      ok: t.ok,
      detail: t.ok
        ? `${t.detail}. ${
            lotwCert
              ? `Uploads are signed with the ${lotwCert.callsign} certificate, valid to ${lotwCert.validTo.toISOString().slice(0, 10)}.`
              : "Download works; uploading needs a callsign certificate uploaded below."
          }`
        : t.detail,
      capabilities: lotwCert ? ["download", "upload"] : ["download"],
    });
  } else {
    services.push({
      id: "lotw",
      label: "Logbook of the World",
      configured: false,
      ok: null,
      detail: "Not configured",
      capabilities: [],
    });
  }

  // --- eQSL: no documented read-only probe, so it is not probed ---
  services.push({
    id: "eqsl",
    label: "eQSL.cc",
    configured: Boolean(eqslUser),
    ok: null,
    detail: eqslUser
      ? "Configured. Not verified — eQSL has no read-only probe that doesn't touch the log."
      : "Not configured",
    capabilities: [],
  });

  // --- ClubLog ---
  const clublogEmailLooksWrong =
    Boolean(clublogEmail) && !clublogEmail!.includes("@");
  services.push({
    id: "clublog",
    label: "ClubLog",
    configured: Boolean(clublogEmail),
    ok: clublogEmailLooksWrong ? false : null,
    detail: clublogEmailLooksWrong
      ? `clublog.email is "${clublogEmail}", which is not an email address. ClubLog authenticates by registered email, not callsign.`
      : clublogEmail
        ? "Configured. Downloads work; uploads from this installation are refused at the server."
        : "Not configured",
    capabilities: [],
  });

  // --- Cloudlog / Wavelog: `/api/auth/<key>` validates the key and reads nothing else ---
  if (cloudlogUrl) {
    const t = await testCloudlog();
    services.push({
      id: "cloudlog",
      label: "Cloudlog / Wavelog",
      configured: true,
      ok: t.ok,
      detail: t.detail,
      capabilities: ["upload"],
    });
  } else {
    services.push({
      id: "cloudlog",
      label: "Cloudlog / Wavelog",
      configured: false,
      ok: null,
      detail: "Not configured",
      capabilities: [],
    });
  }

  // --- N3FJP Amateur Contact Log ---
  //
  // The probe opens a TCP connection and closes it without sending anything. That is as
  // far as a read-only check can go here: the API has no status query, so asking it
  // anything would mean writing a contact to the operator's log to light a status dot.
  if (n3fjpHost) {
    const t = await testN3fjp();
    services.push({
      id: "n3fjp",
      label: "N3FJP Amateur Contact Log",
      configured: true,
      ok: t.ok,
      detail: t.detail,
      capabilities: ["upload"],
    });
  } else {
    services.push({
      id: "n3fjp",
      label: "N3FJP Amateur Contact Log",
      configured: false,
      ok: null,
      detail: "Not configured",
      capabilities: [],
    });
  }

  // --- HRDLOG ---
  services.push({
    id: "hrdlog",
    label: "HRDLOG.net",
    configured: Boolean(hrdlogCall),
    ok: null,
    detail: hrdlogCall ? "Configured. Not verified." : "Not configured",
    capabilities: [],
  });

  sendJson(res, 200, {
    services,
    // When the LoTW sync last ran and how far it has fetched. The marker is the
    // integration's memory, and an empty one is the clearest sign it has never
    // completed a run — which was true here for the whole life of the feature.
    lotw: await getLotwLastRun(),
    note: "Every check here is read-only. Nothing on this page writes to a remote logbook.",
  });
}

export default authedRoute({ GET: { role: "ADMIN", handler: get } });
