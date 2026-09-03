/* eslint-disable no-console */
// Checks the YouTube OAuth handshake's pure parts.
// Run: npm run check:youtube-oauth
//
// WHAT THIS IS PROTECTING. A refresh token for a YouTube channel is a standing grant to act
// as that channel until it is revoked. Two things must hold before one is ever stored:
//
//   * The consent URL must ASK for a refresh token. `access_type=offline` and
//     `prompt=consent` are what do that, and without them Google returns an access token
//     that works for an hour and then stops — a fault that surfaces long after the change
//     that caused it, looking like an outage rather than a mistake.
//   * The callback must accept a code ONLY for a handshake this station started. Without a
//     state check, anyone able to reach the callback could hand it a code from a different
//     Google account and have this station store a token for a channel its operator does
//     not own.
//
// Neither needs a network, so neither is assumed.

import {
  consentUrl,
  redirectUri,
  expiryFrom,
  tokenUsable,
  describeAuthFailure,
  renderTemplate,
  renderTitle,
  TITLE_MAX,
  YOUTUBE_SCOPE,
} from "../lib/integrations/youtube-api";
import { issueState, consumeState, baseUrlFrom } from "../pages/api/youtube/connect";
import {
  pickBroadcast,
  transitionPlan,
  type Broadcast,
} from "../lib/integrations/youtube-broadcast";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, what: string): void {
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}

console.log("the consent URL asks for what we actually need");
{
  const url = consentUrl("client-123.apps.googleusercontent.com", "https://digishack.example", "st8");
  const u = new URL(url);
  eq(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth", "it points at Google");

  // THE TWO PARAMETERS THAT MATTER. Without `access_type=offline` there is no refresh
  // token at all; without `prompt=consent` a second connection for an account that has
  // already approved returns none either, and the connection dies an hour later.
  eq(u.searchParams.get("access_type"), "offline", "offline access, or there is no refresh token");
  eq(u.searchParams.get("prompt"), "consent", "and consent forced, or a re-connect returns none");
  eq(u.searchParams.get("response_type"), "code", "the authorisation-code flow");
  eq(u.searchParams.get("state"), "st8", "the state is carried");
  eq(u.searchParams.get("client_id"), "client-123.apps.googleusercontent.com", "and the client");

  // ONE SCOPE, and it must be the writing one. `youtube.readonly` cannot rename a
  // broadcast, and there is no narrower scope for live chat.
  eq(u.searchParams.get("scope"), YOUTUBE_SCOPE, "the force-ssl scope");
  ok(!YOUTUBE_SCOPE.includes("readonly"), "which is not the read-only scope");

  // Google compares the redirect URI as a STRING. A trailing slash on the base is the
  // classic way to earn `redirect_uri_mismatch`, which names nothing useful.
  eq(
    u.searchParams.get("redirect_uri"),
    "https://digishack.example/api/youtube/callback",
    "the redirect matches what Google was told",
  );
  eq(
    redirectUri("https://digishack.example/"),
    redirectUri("https://digishack.example"),
    "a trailing slash on the base does not change it",
  );
  eq(
    redirectUri("https://digishack.example///"),
    "https://digishack.example/api/youtube/callback",
    "and neither do several",
  );
}

console.log("");
console.log("the state is one-use and expires");
{
  const now = 1_800_000_000_000;
  const a = issueState(now);
  const b = issueState(now);
  ok(a !== b, "two requests get different states");
  ok(a.length >= 20, "and they are long enough not to be guessed", a.length);

  ok(consumeState(a, now), "a fresh state is accepted");
  ok(!consumeState(a, now), "and CANNOT be used twice");
  ok(!consumeState("never-issued", now), "a state we never issued is refused");

  // Ten minutes is plenty for a consent screen and short enough that a link left in a
  // history does not stay usable.
  const c = issueState(now);
  ok(!consumeState(c, now + 11 * 60_000), "an expired state is refused");
  const d = issueState(now);
  ok(consumeState(d, now + 9 * 60_000), "but nine minutes is still fine");
}

console.log("");
console.log("token expiry leaves a margin");
{
  const now = 1_800_000_000_000;
  // SIXTY SECONDS EARLY. A token that expires between the check and the request fails the
  // request, and that request might be the title change at the start of a broadcast.
  eq(expiryFrom(3600, now), now + 3540_000, "an hour becomes 59 minutes");
  eq(expiryFrom(30, now), now, "a short life does not go negative");
  eq(expiryFrom(0, now), now, "nor does none at all");

  ok(!tokenUsable(null, now), "no token is not usable");
  ok(!tokenUsable({ accessToken: "", expiresAt: now + 1e6 }, now), "an empty token is not usable");
  ok(!tokenUsable({ accessToken: "t", expiresAt: now - 1 }, now), "an expired one is not");
  ok(tokenUsable({ accessToken: "t", expiresAt: now + 1 }, now), "a live one is");
}

console.log("");
console.log("failures are explained, not echoed");
{
  // THE SEVEN-DAY TRAP. Google expires refresh tokens from an app still in Testing after a
  // week, and reports it as `invalid_grant` — the same code as a revoked token. An operator
  // reading "invalid_grant" has nothing to act on; naming the rule is the whole value.
  const g = describeAuthFailure(400, '{"error":"invalid_grant"}');
  ok(g.includes("7 days") || g.includes("seven"), "invalid_grant names the testing-mode expiry", g);
  ok(g.toLowerCase().includes("publish"), "and says what to do about it", g);

  const c = describeAuthFailure(401, '{"error":"invalid_client"}');
  ok(c.toLowerCase().includes("client"), "invalid_client points at the ID and secret", c);

  const q = describeAuthFailure(403, '{"error":{"message":"quota exceeded"}}');
  ok(q.toLowerCase().includes("quota"), "a quota failure names the quota", q);
  ok(q.toLowerCase().includes("chat"), "and the thing most likely to be spending it", q);

  // Whatever else arrives must still say something rather than nothing.
  const u = describeAuthFailure(500, "upstream exploded");
  ok(u.includes("500"), "an unknown failure still carries its status", u);
}

console.log("");
console.log("the redirect base is taken from the request, behind a proxy");
{
  // Behind Cloudflare the origin speaks plain HTTP, so `req.headers.host` and the socket
  // both lie about the scheme. The forwarded headers are the only honest source, and a
  // wrong scheme here fails with `redirect_uri_mismatch`.
  const asReq = (h: Record<string, string>) => ({ headers: h }) as never;
  eq(
    baseUrlFrom(asReq({ "x-forwarded-host": "digishack.example.com", "x-forwarded-proto": "https" })),
    "https://digishack.example.com",
    "the forwarded host and proto win",
  );
  eq(
    baseUrlFrom(asReq({ host: "127.0.0.1:3000", "x-forwarded-proto": "http" })),
    "http://127.0.0.1:3000",
    "a direct local request works too",
  );
  // Proxies chain these, and only the first is ours.
  eq(
    baseUrlFrom(asReq({ "x-forwarded-host": "digishack.example.com, inner", "x-forwarded-proto": "https, http" })),
    "https://digishack.example.com",
    "a chained forwarded header takes the first hop only",
  );
}

console.log("");
console.log("the day's title");
{
  const facts = {
    callsign: "K9XYZ",
    grid: "EN61AA",
    band: "20M",
    mode: "FT8",
    qsos: 146,
    date: new Date(Date.UTC(2026, 8, 3, 1, 30)),
  };
  eq(
    renderTitle("Live {mode} — {callsign} {grid} — {date}", facts),
    "Live FT8 — K9XYZ EN61AA — 2026-09-03",
    "every placeholder is filled",
  );
  eq(renderTemplate("{qsos} contacts", facts), "146 contacts", "the count is a number, not a gap");

  // UTC, so a title set at 23:50 local names the day the log will file the contacts under
  // rather than the one the operator's clock shows.
  eq(
    renderTemplate("{date}", { ...facts, date: new Date(Date.UTC(2026, 8, 3, 4, 0)) }),
    "2026-09-03",
    "the date is UTC, matching the log",
  );

  // A TYPO MUST SURVIVE VISIBLY. Blanking an unknown placeholder produces a title that
  // reads as the station having no callsign, with nothing to trace it back to.
  eq(
    renderTemplate("{callsgin} on {band}", facts),
    "{callsgin} on 20M",
    "an unknown placeholder is left alone so the typo is visible",
  );

  // Absent is not the same as empty, on a title as much as on the overlay.
  eq(
    renderTemplate("{band} {mode}", { ...facts, band: null, mode: null }),
    "-- --",
    "a radio that has not reported yet renders as dashes",
  );

  // YouTube truncates past 100 without saying so; better to do it deliberately.
  const long = renderTitle("x".repeat(200), facts);
  ok(long.length <= TITLE_MAX, `a long title is cut to ${long.length}, not refused`);
  ok(long.endsWith("…"), "and ends in an ellipsis so the cut reads as deliberate");
  const short = renderTitle("Live FT8", facts);
  ok(!short.endsWith("…"), "a short one is left alone");
}

console.log("");
console.log("WE ONLY EVER RENAME OUR OWN BROADCAST");
{
  // THE HAZARD, found the first time this listed a real channel. The account already runs
  // a railway camera, and its broadcast sat "ready" on the same channel beside ours:
  //
  //     yJDsxYEbKDM | live  | Live FT8 & FT4 ... K9XYZ ...
  //     i67OTNgwaVQ | ready | LIVE: CPKC Holiday Train Passes Through Northwest Indiana!
  //
  // "Rename the active broadcast" would have renamed the train. A channel is not a stream.
  const ours = "STREAM-OURS";
  const theirs = "STREAM-TRAIN";
  const all: Broadcast[] = [
    { id: "train-live", title: "Holiday Train", lifeCycleStatus: "live", boundStreamId: theirs },
    { id: "ours-ready", title: "FT8", lifeCycleStatus: "ready", boundStreamId: ours },
  ];
  const picked = pickBroadcast(all, ours);
  eq(picked?.id, "ours-ready", "a live broadcast on ANOTHER stream is never picked");

  // Ours live beats ours ready: mid-broadcast is when a title matters.
  const both: Broadcast[] = [
    { id: "ours-ready", title: "", lifeCycleStatus: "ready", boundStreamId: ours },
    { id: "ours-live", title: "", lifeCycleStatus: "live", boundStreamId: ours },
  ];
  eq(pickBroadcast(both, ours)?.id, "ours-live", "live outranks ready");

  // A REUSABLE STREAM KEY ACCUMULATES FINISHED BROADCASTS. Renaming one of those changes
  // the title of a video somebody may already have linked to.
  const finished: Broadcast[] = [
    { id: "old-1", title: "", lifeCycleStatus: "complete", boundStreamId: ours },
    { id: "old-2", title: "", lifeCycleStatus: "revoked", boundStreamId: ours },
  ];
  eq(pickBroadcast(finished, ours), null, "completed and revoked broadcasts are never renamed");

  // Nothing bound, nothing known, nothing done. Guessing here renames a stranger's stream.
  eq(pickBroadcast(all, null), null, "an unknown stream id renames nothing");
  eq(pickBroadcast(all, "STREAM-MISSING"), null, "a stream with no broadcast renames nothing");
  eq(pickBroadcast([], ours), null, "an empty channel renames nothing");
  eq(
    pickBroadcast(
      [{ id: "unbound", title: "", lifeCycleStatus: "live", boundStreamId: null }],
      ours,
    ),
    null,
    "a broadcast bound to no stream is not assumed to be ours",
  );
}

console.log("");
console.log("PUTTING THE BROADCAST ON AIR");
{
  // THE FAULT THIS FIXES, reported as "i dont see it in studio" while the encoder was
  // running, CBR was correct and YouTube's own dashboard said the stream was active:
  //
  //     0ssC_QvaTk8 | ready     <- ours, receiving video, INVISIBLE
  //     yJDsxYEbKDM | complete  <- yesterday's, finished for good
  //
  // Pushing video to the RTMP ingest makes YouTube RECEIVE it. It does not make anything
  // WATCHABLE. A broadcast sits in `ready` until something transitions it, and nothing did.
  // So a station streaming on a schedule has to transition EVERY DAY, not once ever.
  const ours = "STREAM-OURS";
  const b = (lifeCycleStatus: string, id = "ours"): Broadcast => ({
    id,
    title: "",
    lifeCycleStatus,
    boundStreamId: ours,
  });

  // The happy path, and the ORDER matters: a broadcast with a monitor stream — which is the
  // default — must go ready -> testing -> live. Asking for `live` directly fails with
  // errorStreamInactive, which reads like the radio being off rather than a state machine
  // being skipped.
  {
    const p = transitionPlan({ streamActive: true, broadcast: b("ready"), monitorStream: true });
    eq(p.steps.join(","), "testing,live", "ready with a monitor stream goes via testing");
    ok(!p.alreadyLive, "and is not reported as already live");
  }
  eq(
    transitionPlan({ streamActive: true, broadcast: b("created"), monitorStream: true })
      .steps.join(","),
    "testing,live",
    "so does `created`, which is what a freshly made broadcast is",
  );
  eq(
    transitionPlan({ streamActive: true, broadcast: b("ready"), monitorStream: false })
      .steps.join(","),
    "live",
    "without a monitor stream it goes straight to live",
  );

  // ALREADY IN THE MONITOR STAGE. It needs `live` and must NOT be sent back to `testing`.
  eq(
    transitionPlan({ streamActive: true, broadcast: b("testing"), monitorStream: true })
      .steps.join(","),
    "live",
    "a testing broadcast is advanced, not restarted",
  );

  // THE WORST THING THIS FUNCTION COULD DO is post `testing` at a broadcast that is already
  // live, because that takes a running broadcast OFF AIR. Mid-broadcast is exactly when
  // this gets called again — the schedule hook fires on every decision tick.
  {
    const p = transitionPlan({ streamActive: true, broadcast: b("live"), monitorStream: true });
    ok(p.alreadyLive, "a live broadcast is recognised as already live");
    eq(p.steps.length, 0, "and NOTHING is posted at it — no transition can take it off air");
  }

  // A REUSABLE STREAM KEY ACCUMULATES FINISHED BROADCASTS, and yesterday's is `complete` by
  // the time today's schedule opens. `pickBroadcast` drops those, so reaching here means
  // the two disagreed; refuse rather than post a transition at a finished video.
  for (const dead of ["complete", "revoked", "someFutureStatus"]) {
    const p = transitionPlan({ streamActive: true, broadcast: b(dead), monitorStream: true });
    eq(p.steps.length, 0, `a ${dead} broadcast is never transitioned`);
    ok(!p.alreadyLive, `and a ${dead} broadcast is not mistaken for live`);
  }

  // THE STREAM GATE. A transition against an inactive stream fails, and this is the state
  // for the first few seconds after ffmpeg connects — so it must be a retryable "not yet",
  // not an error.
  {
    const p = transitionPlan({ streamActive: false, broadcast: b("ready"), monitorStream: true });
    eq(p.steps.length, 0, "nothing is transitioned while YouTube is not receiving video");
    ok(
      /not receiving/i.test(p.reason),
      "and the reason names the stream, so a retry is obviously the right response",
      p.reason,
    );
  }

  // NO BROADCAST AT ALL. This is the case that will come up tomorrow if YouTube does not
  // create a fresh one for the reusable key, and the message has to send the operator to
  // the right place — Studio, not ffmpeg.
  {
    const p = transitionPlan({ streamActive: true, broadcast: null, monitorStream: true });
    eq(p.steps.length, 0, "no bound broadcast means nothing is transitioned");
    ok(
      /Studio/.test(p.reason) && /cannot be reused/.test(p.reason),
      "and the operator is told where to make one and why the old one will not do",
      p.reason,
    );
  }
  // ORDER OF THE TWO GATES. With neither a broadcast nor an active stream, the message must
  // name the MISSING BROADCAST: "YouTube is not receiving the stream" would send the
  // operator to look at an encoder that is working.
  {
    const p = transitionPlan({ streamActive: false, broadcast: null, monitorStream: true });
    ok(
      /Studio/.test(p.reason),
      "with both missing, the broadcast is the fault reported — not the stream",
      p.reason,
    );
  }

  // AND THE COMPOSITION WITH pickBroadcast, which is what actually protects the train. The
  // planner never sees another stream's broadcast because the picker never returns one.
  {
    const theirs = "STREAM-TRAIN";
    const channel: Broadcast[] = [
      { id: "train-live", title: "Holiday Train", lifeCycleStatus: "live", boundStreamId: theirs },
      { id: "train-ready", title: "Holiday Train", lifeCycleStatus: "ready", boundStreamId: theirs },
    ];
    const picked = pickBroadcast(channel, ours);
    eq(picked, null, "a channel of somebody else's broadcasts yields none of ours");
    const p = transitionPlan({ streamActive: true, broadcast: picked, monitorStream: true });
    eq(p.steps.length, 0, "so nothing is put on air — the train is never transitioned");
  }
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all YouTube OAuth assertions passed");
