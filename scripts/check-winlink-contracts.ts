/* eslint-disable no-console */
// Pat engine API contract check (offline). Asserts the fixtures captured from the
// pinned Pat binary (lib/winlink/fixtures/pat-1.0.0/) still parse against the types
// in lib/winlink/types.ts. No network: a Pat version bump that changes the wire
// format should fail HERE, before the adapter silently misreads a mailbox.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  PatBandwidths,
  PatConfig,
  PatConnectAliases,
  PatFormCatalog,
  PatMessage,
  PatRmsNode,
  PatStatus,
} from "@/lib/winlink/types";

const DIR = fileURLToPath(new URL("../lib/winlink/fixtures/pat-1.0.0/", import.meta.url));

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}
const read = <T>(file: string): T => JSON.parse(readFileSync(DIR + file, "utf8")) as T;

console.log("\nconfig");
const config = read<PatConfig>("config.json");
ok("mycall is a string", typeof config.mycall === "string");
ok("has CMS telnet connect alias", typeof config.connect_aliases.telnet === "string");
ok("CMS alias targets cms.winlink.org", (config.connect_aliases.telnet ?? "").includes("cms.winlink.org"));
ok("ardop modem addr present", typeof config.ardop.addr === "string");
ok("vara hf modem addr present", typeof config.varahf.addr === "string");

console.log("\nstatus");
const status = read<PatStatus>("status.json");
ok("connected is boolean", typeof status.connected === "boolean");
ok("config_hash is a string", typeof status.config_hash === "string");
ok("active_listeners is an array", Array.isArray(status.active_listeners));

console.log("\nmailbox");
const list = read<PatMessage[]>("mailbox_out_sample.json");
const first = list[0];
ok("outbox list is an array", Array.isArray(list));
ok("list entry has a MID", !!first && typeof first.MID === "string");
ok("list entry Body is empty (summary only)", !!first && first.Body === "");
ok("empty box fixture is []", Array.isArray(read<PatMessage[]>("mailbox_in.json")));

const msg = read<PatMessage>("message_detail_sample.json");
ok("detail MID matches list", msg.MID === first?.MID);
ok("detail From.Addr present", typeof msg.From.Addr === "string" && msg.From.Addr.length > 0);
ok("detail To is a non-empty array", Array.isArray(msg.To) && msg.To.length > 0);
ok("detail Body is populated", msg.Body.length > 0);
ok("detail Files is an array", Array.isArray(msg.Files));
ok("detail Unread is boolean", typeof msg.Unread === "boolean");

console.log("\nconnect aliases");
const aliases = read<PatConnectAliases>("connect_aliases.json");
ok("telnet alias present", typeof aliases.telnet === "string");

console.log("\nrmslist");
const rms = read<PatRmsNode[]>("ep_rmslist_sample.json");
const node = rms[0];
ok("rmslist is an array", Array.isArray(rms));
ok("node has callsign", !!node && typeof node.callsign === "string");
ok("node has numeric distance + azimuth", !!node && typeof node.distance === "number" && typeof node.azimuth === "number");
ok("node freq.hz is numeric", !!node && typeof node.freq.hz === "number");
ok("node has a transport url", !!node && typeof node.url === "string");

console.log("\nbandwidths + forms");
const bw = read<PatBandwidths>("ep_bandwidths.json");
ok("bandwidths.bandwidths is an array", Array.isArray(bw.bandwidths));
const forms = read<PatFormCatalog>("ep_formcatalog.json");
ok("formcatalog.form_count is numeric", typeof forms.form_count === "number");
ok("formcatalog.forms is an array", Array.isArray(forms.forms));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
