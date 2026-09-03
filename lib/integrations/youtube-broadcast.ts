// Finding, and renaming, the broadcast THIS station is feeding.
//
// THE HAZARD, found the first time this listed a real channel. The account already runs
// another stream — a railway camera — and its broadcast sat "ready" on the same channel:
//
//     yJDsxYEbKDM | live     | Live FT8 & FT4 ... K9XYZ ... EN61 Indiana
//     i67OTNgwaVQ | ready    | LIVE: CPKC Holiday Train Passes Through Northwest Indiana!
//
// "Rename the active broadcast" would eventually have renamed the train. A channel is not a
// stream, an operator may run several, and the only safe identification is the one that
// cannot be coincidence: the broadcast BOUND TO THE STREAM WE ARE PUSHING TO.
//
// So this resolves the stream key to a stream id, then finds the broadcast bound to that
// id, and touches nothing else. If the binding cannot be established it does NOTHING rather
// than guessing, because the failure mode of guessing is renaming somebody's other stream.

import { youtubeApi } from "@/lib/integrations/youtube-api";

/** A broadcast, reduced to what identification needs. */
export interface Broadcast {
  id: string;
  title: string;
  lifeCycleStatus: string;
  boundStreamId: string | null;
}

/**
 * Which broadcast belongs to this stream.
 *
 * PURE, so the rule that stops us renaming the wrong stream can be asserted exhaustively —
 * it is the whole safety property and it must not depend on a network to test.
 *
 * A broadcast is ours only if it is bound to our stream id. Among those, a live one wins
 * over a ready one: mid-broadcast is when a title matters, and an old completed broadcast
 * bound to the same reusable stream key must never be picked.
 */
export function pickBroadcast(all: Broadcast[], ourStreamId: string | null): Broadcast | null {
  if (!ourStreamId) return null;
  const ours = all.filter((b) => b.boundStreamId === ourStreamId);
  if (ours.length === 0) return null;
  const rank = (s: string): number =>
    s === "live" ? 3 : s === "testing" ? 2 : s === "ready" || s === "created" ? 1 : 0;
  // COMPLETED AND REVOKED SCORE ZERO and are dropped entirely rather than used as a
  // fallback. A reusable stream key accumulates finished broadcasts, and renaming one of
  // those changes the title of a video somebody may already have linked to.
  const usable = ours.filter((b) => rank(b.lifeCycleStatus) > 0);
  if (usable.length === 0) return null;
  return usable.sort((a, b) => rank(b.lifeCycleStatus) - rank(a.lifeCycleStatus))[0]!;
}

/** Our stream's id, resolved from the key we are pushing to. */
export async function streamIdForKey(streamKey: string): Promise<string | null> {
  if (!streamKey.trim()) return null;
  const r = await youtubeApi<{
    items?: { id: string; cdn?: { ingestionInfo?: { streamName?: string } } }[];
  }>("/liveStreams", { query: { part: "id,cdn", mine: "true", maxResults: "50" } });
  const match = (r.items ?? []).find(
    (s) => s.cdn?.ingestionInfo?.streamName === streamKey.trim(),
  );
  return match?.id ?? null;
}

/** Every broadcast on the channel, reduced. */
export async function listBroadcasts(): Promise<Broadcast[]> {
  // `broadcastStatus` and `mine` are MUTUALLY EXCLUSIVE on this endpoint — sending both is
  // a 400 naming neither, which cost one debugging round. `all` implies the caller's own.
  const r = await youtubeApi<{
    items?: {
      id: string;
      snippet?: { title?: string };
      status?: { lifeCycleStatus?: string };
      contentDetails?: { boundStreamId?: string };
    }[];
  }>("/liveBroadcasts", {
    query: { part: "snippet,status,contentDetails", broadcastStatus: "all", maxResults: "50" },
  });
  return (r.items ?? []).map((b) => ({
    id: b.id,
    title: b.snippet?.title ?? "",
    lifeCycleStatus: b.status?.lifeCycleStatus ?? "unknown",
    boundStreamId: b.contentDetails?.boundStreamId ?? null,
  }));
}

/**
 * Rename the broadcast this station is feeding.
 *
 * `liveBroadcasts.update` REPLACES the whole snippet part it is given, so the existing
 * title and description are read first and only the fields being changed are overwritten.
 * Sending a snippet without `scheduledStartTime` on a scheduled broadcast is the documented
 * way to lose it, which is why the read is not an optimisation.
 *
 * Returns what it did, so a caller can log it without a second request.
 */
export async function setBroadcastDetails(
  streamKey: string,
  title: string,
  description: string | null,
): Promise<{ ok: boolean; id: string | null; detail: string }> {
  const streamId = await streamIdForKey(streamKey);
  if (!streamId) {
    return {
      ok: false,
      id: null,
      detail:
        "No YouTube stream matches this stream key, so there is no way to tell which " +
        "broadcast is ours. Nothing was renamed.",
    };
  }
  const target = pickBroadcast(await listBroadcasts(), streamId);
  if (!target) {
    return {
      ok: false,
      id: null,
      detail: "No live or ready broadcast is bound to this stream key. Nothing was renamed.",
    };
  }

  const current = await youtubeApi<{
    items?: { snippet?: Record<string, unknown> }[];
  }>("/liveBroadcasts", { query: { part: "snippet", id: target.id } });
  const snippet = { ...(current.items?.[0]?.snippet ?? {}) };
  snippet.title = title;
  // AN EMPTY DESCRIPTION KEEPS THE EXISTING ONE. Overwriting a good description with
  // nothing is a worse default than doing nothing, and the setting's help says so.
  if (description && description.trim()) snippet.description = description;

  await youtubeApi("/liveBroadcasts", {
    method: "PUT",
    query: { part: "snippet" },
    body: { id: target.id, snippet },
  });
  return { ok: true, id: target.id, detail: `Renamed ${target.id} to "${title}"` };
}

/**
 * The live chat id for the broadcast we are feeding, or null.
 *
 * Costs one list call. Cached by the caller rather than here: a chat id is stable for the
 * life of a broadcast, and re-resolving it every poll would double the quota this feature
 * spends for no new information.
 */
export async function liveChatIdForStream(streamKey: string): Promise<string | null> {
  const streamId = await streamIdForKey(streamKey);
  const target = pickBroadcast(await listBroadcasts(), streamId);
  if (!target) return null;
  const r = await youtubeApi<{ items?: { snippet?: { liveChatId?: string } }[] }>(
    "/liveBroadcasts",
    { query: { part: "snippet", id: target.id } },
  );
  return r.items?.[0]?.snippet?.liveChatId ?? null;
}

export interface ChatPage {
  messages: { text: string; author: string; at: number }[];
  nextPageToken: string | null;
  pollingIntervalMillis: number | null;
}

/** One page of live chat. */
export async function fetchChatPage(
  liveChatId: string,
  pageToken: string | null,
): Promise<ChatPage> {
  const r = await youtubeApi<{
    items?: {
      snippet?: { displayMessage?: string; publishedAt?: string };
      authorDetails?: { displayName?: string };
    }[];
    nextPageToken?: string;
    pollingIntervalMillis?: number;
  }>("/liveChat/messages", {
    query: {
      liveChatId,
      part: "snippet,authorDetails",
      maxResults: "200",
      ...(pageToken ? { pageToken } : {}),
    },
  });
  return {
    messages: (r.items ?? []).map((m) => ({
      text: m.snippet?.displayMessage ?? "",
      author: m.authorDetails?.displayName ?? "",
      at: Date.parse(m.snippet?.publishedAt ?? "") || Date.now(),
    })),
    nextPageToken: r.nextPageToken ?? null,
    pollingIntervalMillis: r.pollingIntervalMillis ?? null,
  };
}

/**
 * Whether YouTube is actually receiving our video, and whether it likes it.
 *
 * `streamStatus` is the one that gates a transition: a broadcast cannot go live against an
 * inactive stream, and asking it to fails with `errorStreamInactive`.
 */
export async function streamHealth(
  streamId: string,
): Promise<{ active: boolean; health: string | null }> {
  const r = await youtubeApi<{
    items?: { status?: { streamStatus?: string; healthStatus?: { status?: string } } }[];
  }>("/liveStreams", { query: { part: "status", id: streamId } });
  const st = r.items?.[0]?.status;
  return {
    active: st?.streamStatus === "active",
    health: st?.healthStatus?.status ?? null,
  };
}

/** What `transitionPlan` decided to do. */
export interface TransitionPlan {
  /** The statuses to POST, in order. Empty means do nothing. */
  steps: ("testing" | "live")[];
  /** True when the broadcast is already live and nothing is needed. */
  alreadyLive: boolean;
  /** Why, for the caller's log and for the operator. */
  reason: string;
}

/**
 * Decide what to transition, WITHOUT touching the network.
 *
 * PURE for the same reason `pickBroadcast` is: this is the rule that decides whether to put
 * a channel on air, and the ways it can be wrong are all silent. Asking for `live` on a
 * broadcast whose monitor stream is enabled fails with `errorStreamInactive` — an error that
 * reads like the radio being off rather than a state machine being skipped — and asking for
 * `testing` on a broadcast already live would take a running broadcast OFF air.
 *
 * It also has to be exhaustive over statuses we do not expect, because YouTube's lifecycle
 * has more of them than the happy path uses and a `default` that guesses is how a completed
 * broadcast gets a transition posted at it.
 */
export function transitionPlan(input: {
  streamActive: boolean;
  broadcast: Broadcast | null;
  /** Whether the broadcast has a monitor stream, which forces `testing` first. */
  monitorStream: boolean;
}): TransitionPlan {
  const { streamActive, broadcast, monitorStream } = input;
  if (!broadcast) {
    return {
      steps: [],
      alreadyLive: false,
      reason:
        "No broadcast is bound to this stream key and waiting to go live. Create one in " +
        "YouTube Studio (Go Live → Stream) — a completed broadcast cannot be reused.",
    };
  }
  // THE STREAM GATE COMES SECOND, not first, so the message names the more useful fault.
  // With no broadcast at all, "YouTube is not receiving the stream yet" would send the
  // operator to look at ffmpeg when the thing missing is a broadcast.
  if (!streamActive) {
    return {
      steps: [],
      alreadyLive: false,
      reason: "YouTube is not receiving the stream yet — nothing to put on air.",
    };
  }
  switch (broadcast.lifeCycleStatus) {
    case "live":
      // NOT a no-op for politeness — posting `testing` at a live broadcast would take it
      // off air, which is the worst thing this function could do.
      return { steps: [], alreadyLive: true, reason: `${broadcast.id} is already live` };
    case "testing":
      // Already in the monitor stage: it needs `live` and must NOT be sent back to testing.
      return { steps: ["live"], alreadyLive: false, reason: `${broadcast.id} testing → live` };
    case "ready":
    case "created":
      return monitorStream
        ? {
            steps: ["testing", "live"],
            alreadyLive: false,
            reason: `${broadcast.id} ready → testing → live`,
          }
        : { steps: ["live"], alreadyLive: false, reason: `${broadcast.id} ready → live` };
    default:
      // complete, revoked, or a status YouTube adds later. `pickBroadcast` already drops
      // these, so reaching here means the two disagreed — refuse rather than post at it.
      return {
        steps: [],
        alreadyLive: false,
        reason: `${broadcast.id} is ${broadcast.lifeCycleStatus} and cannot be put on air`,
      };
  }
}

/**
 * Put the broadcast on air.
 *
 * THE GAP THIS FILLS, and it is the reason a working stream showed nothing in Studio.
 * Pushing video to the RTMP ingest makes YouTube RECEIVE it; it does not make anything
 * WATCHABLE. A broadcast sits in `ready` until something transitions it, and the previous
 * day's broadcast has by then gone to `complete` and can never be reused:
 *
 *     0ssC_QvaTk8 | ready     <- ours, waiting, invisible
 *     yJDsxYEbKDM | complete  <- yesterday's, finished for good
 *
 * So a station that streams on a schedule has to transition every day, not once ever. This
 * is what makes "start the stream" mean "go live" rather than "send bytes into a void".
 *
 * TESTING FIRST, WHEN THE BROADCAST ASKS FOR IT. A broadcast with a monitor stream enabled
 * — which is the default — must go `ready` → `testing` → `live`; asking for `live` directly
 * fails with `errorStreamInactive` in a way that reads like the stream being down rather
 * than a state machine being skipped.
 */
export async function goLive(
  streamKey: string,
): Promise<{ ok: boolean; id: string | null; detail: string }> {
  const streamId = await streamIdForKey(streamKey);
  if (!streamId) {
    return { ok: false, id: null, detail: "No YouTube stream matches this stream key." };
  }

  const health = await streamHealth(streamId);
  const target = pickBroadcast(await listBroadcasts(), streamId);

  // Whether the broadcast has a monitor stream, which forces `testing` before `live`.
  // DEFAULTS TO TRUE on any failure to read it: assuming there is one costs an extra
  // transition that YouTube accepts as a no-op, while assuming there is not produces
  // `errorStreamInactive` and no broadcast.
  const monitorStream = target
    ? await youtubeApi<{
        items?: {
          contentDetails?: { monitorStream?: { enableMonitorStream?: boolean } };
        }[];
      }>("/liveBroadcasts", { query: { part: "contentDetails", id: target.id } }).then(
        (r) => r.items?.[0]?.contentDetails?.monitorStream?.enableMonitorStream !== false,
        () => true,
      )
    : true;

  const plan = transitionPlan({ streamActive: health.active, broadcast: target, monitorStream });
  if (plan.alreadyLive) return { ok: true, id: target?.id ?? null, detail: plan.reason };
  if (plan.steps.length === 0) {
    // Not always worth retrying hard — when the stream is merely not active yet, ffmpeg has
    // only just connected and YouTube takes a few seconds to notice. The caller retries.
    return { ok: false, id: target?.id ?? null, detail: plan.reason };
  }

  const id = target!.id;
  try {
    for (const to of plan.steps) {
      await youtubeApi("/liveBroadcasts/transition", {
        method: "POST",
        query: { broadcastStatus: to, id, part: "status" },
      });
    }
    return { ok: true, id, detail: `${id} is now live (${plan.reason})` };
  } catch (e) {
    return { ok: false, id, detail: (e as Error).message };
  }
}
