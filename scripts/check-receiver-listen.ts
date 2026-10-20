/* eslint-disable no-console */
// Listen has one owner at a time: double clicks, late closes and unmounts cannot cross wires.
// Run: npx tsx scripts/check-receiver-listen.ts
//
// THE FAULT (code review R17). The Listen button had no starting state and `listening` became
// true only when the socket opened, so a second click during startup built a second player and
// socket. The refs kept only the newest pair, and every socket's close handler stopped
// `playerRef.current` — the newest player, not its own — so a late close from an old socket
// silenced a newer Listen. Leaving the page while the worklet loaded leaked the player.
//
// Also the hook's half of R08: a hello mid-stream (the bridge switching radios) restarts the
// player at the new rate, and one announcing no audio (a switch to WSJT-X) ends the Listen
// with a reason rather than leaving a silent "Listening".
//
// No browser and no React: ReceiverListener, which the hook binds, is driven directly with a
// fake socket and a fake player.

import type { AudioPlayerState } from "../lib/client/audio-player";
import { ReceiverListener, type ListenerPlayer } from "../lib/client/use-receiver-audio";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

class FakePlayer implements ListenerPlayer {
  starts = 0;
  stops = 0;
  pushed = 0;
  volume = -1;
  readonly rates: number[] = [];
  private release: { resolve: () => void; reject: (e: Error) => void } | null = null;
  constructor(private readonly mode: "ok" | "gated" | Error = "ok") {}
  start(volume = 0.8): Promise<void> {
    this.starts++;
    this.volume = volume;
    if (this.mode instanceof Error) return Promise.reject(this.mode);
    if (this.mode === "gated") return new Promise((resolve, reject) => (this.release = { resolve, reject }));
    return Promise.resolve();
  }
  finishStart(err?: Error): void {
    if (err) this.release?.reject(err);
    else this.release?.resolve();
  }
  async stop(): Promise<void> {
    this.stops++;
  }
  setVolume(v: number): void {
    this.volume = v;
  }
  setSampleRate(rate: number): void {
    this.rates.push(rate);
  }
  push(): void {
    this.pushed++;
  }
  get state(): AudioPlayerState {
    return {
      playing: this.stops === 0,
      sampleRate: this.rates[this.rates.length - 1] ?? 0,
      packets: this.pushed,
      bufferedMs: 150,
      underruns: 0,
      starvedMs: 0,
      waiting: false,
      contextState: "running",
    };
  }
}

class FakeSocket {
  binaryType = "blob";
  readyState = 0;
  closes = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {}
  close(): void {
    this.closes++;
    this.readyState = 2;
  }
  // The far end, driven by the test.
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  hello(sampleRate: number): void {
    this.onmessage?.({ data: JSON.stringify({ kind: "audio-hello", sampleRate, format: "s16le", channels: 1 }) });
  }
  frame(): void {
    this.onmessage?.({ data: new ArrayBuffer(256) });
  }
  fail(): void {
    this.onerror?.({});
  }
  closed(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** A listener whose players come from `plan`, in order, and whose sockets are recorded. */
function harness(plan: Array<FakePlayer> = [], startTimeoutMs = 5_000) {
  const players: FakePlayer[] = [];
  const sockets: FakeSocket[] = [];
  let notifications = 0;
  const listener = new ReceiverListener({
    url: () => "ws://bridge.invalid/ws/audio",
    createPlayer: () => {
      const p = plan[players.length] ?? new FakePlayer();
      players.push(p);
      return p;
    },
    openSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s as unknown as WebSocket;
    },
    startTimeoutMs,
    pollMs: 10_000,
  });
  listener.subscribe(() => notifications++);
  return {
    listener,
    players,
    sockets,
    get status() {
      return listener.getSnapshot().status;
    },
    get error() {
      return listener.getSnapshot().error;
    },
    get notifications() {
      return notifications;
    },
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Start and bring the stream up to playing at `rate`. */
async function playing(h: ReturnType<typeof harness>, rate = 24_000): Promise<FakeSocket> {
  void h.listener.start();
  await settle();
  const s = h.sockets[h.sockets.length - 1]!;
  s.open();
  s.hello(rate);
  return s;
}

async function main(): Promise<void> {
  console.log("1. the user gesture: the player starts inside the click");
  {
    const h = harness();
    void h.listener.start();
    check("player.start() ran before start() returned", h.players[0]?.starts === 1, h.players[0]?.starts);
    check("and the state says starting at once", h.status === "starting", h.status);
    await h.listener.stop();
  }

  console.log("");
  console.log("2. a double-click is one Listen");
  {
    const h = harness();
    void h.listener.start();
    void h.listener.start();
    h.listener.toggle(); // the button's second click, while starting
    await settle();
    check("one player", h.players.length === 1, h.players.length);
    check("one socket", h.sockets.length === 1, h.sockets.length);
    check("and the second click did not cancel it", h.status === "starting" && h.players[0]?.stops === 0, h.status);
    h.sockets[0]!.open();
    h.sockets[0]!.hello(24_000);
    check("it plays", h.status === "playing", h.status);
    await h.listener.stop();
  }

  console.log("");
  console.log("3. stop, start again, and THEN the old socket's close arrives");
  {
    const h = harness();
    const old = await playing(h);
    await h.listener.stop();
    check("stop closes its own socket and player", old.closes === 1 && h.players[0]?.stops === 1);
    const fresh = await playing(h, 48_000);
    check("the new Listen plays", h.status === "playing" && fresh !== old, h.status);
    old.closed(1000);
    old.frame();
    check("the old close does not stop the NEW player", h.players[1]?.stops === 0, h.players[1]?.stops);
    check("nor change what the page shows", h.status === "playing" && h.error === null, { status: h.status, error: h.error });
    check("and the old socket's late audio goes nowhere", h.players[1]?.pushed === 0 && h.players[0]?.pushed === 0);
    await h.listener.stop();
  }

  console.log("");
  console.log("4. leaving the page while the worklet is still loading");
  {
    const gated = new FakePlayer("gated");
    const h = harness([gated]);
    void h.listener.start();
    const before = h.notifications;
    h.listener.dispose();
    check("the loading player is stopped at once", gated.stops === 1, gated.stops);
    gated.finishStart();
    await settle();
    check("no socket is opened when the load finishes", h.sockets.length === 0, h.sockets.length);
    check("nothing is published to an unmounted page", h.notifications === before, h.notifications - before);
    void h.listener.start();
    check("and a start after unmount is refused", h.players.length === 1, h.players.length);
  }

  console.log("");
  console.log("5. an old start that fails AFTER a newer Listen began cannot touch it");
  {
    const gated = new FakePlayer("gated");
    const h = harness([gated]);
    void h.listener.start();
    await h.listener.stop();
    await playing(h);
    gated.finishStart(new Error("late synthetic failure"));
    await settle();
    check("the newer Listen still plays, with no error", h.status === "playing" && h.error === null, { status: h.status, error: h.error });
    check("and the old attempt opened no socket", h.sockets.length === 1, h.sockets.length);
    await h.listener.stop();
  }

  console.log("");
  console.log("6. a failure keeps its own reason");
  {
    const h = harness([new FakePlayer(new Error("synthetic worklet failure"))]);
    await h.listener.start();
    check("status is error", h.status === "error", h.status);
    check("with the browser's own words in it", (h.error ?? "").includes("synthetic worklet failure"), h.error);
    check("no socket was opened", h.sockets.length === 0);
    check("and the player was released", h.players[0]?.stops === 1);
    await playing(h);
    check("Listen works again afterwards, and clears the error", h.status === "playing" && h.error === null, h.status);
    await h.listener.stop();
  }

  console.log("");
  console.log("7. sockets that never get going say why");
  {
    const h = harness([], 60);
    void h.listener.start();
    await tick(120);
    check("a socket left CONNECTING times out", h.status === "error" && (h.error ?? "").includes("did not answer"), h.error);
    check("and is closed, its player released", h.sockets[0]?.closes === 1 && h.players[0]?.stops === 1);

    const r = harness();
    void r.listener.start();
    await settle();
    r.sockets[0]!.fail();
    r.sockets[0]!.closed(1006);
    check("refused before opening: could not reach", (r.error ?? "").includes("Could not reach"), r.error);

    const q = harness();
    void q.listener.start();
    await settle();
    q.sockets[0]!.closed(1008, "not signed in");
    check("the bridge's own close reason is shown", (q.error ?? "").includes("not signed in"), q.error);

    const n = harness();
    void n.listener.start();
    await settle();
    n.sockets[0]!.open();
    n.sockets[0]!.closed(1006);
    check("open, then closed with no hello: closed before sending anything", (n.error ?? "").includes("before sending anything"), n.error);
  }

  console.log("");
  console.log("8. the stream dropping after it played is an error, not a silent reset");
  {
    const h = harness();
    const s = await playing(h);
    s.closed(1006);
    check("status error with a reason", h.status === "error" && (h.error ?? "").includes("stopped"), { status: h.status, error: h.error });
    check("its player released", h.players[0]?.stops === 1);
  }

  console.log("");
  console.log("9. R08: the bridge switching radios while Listen stays on");
  {
    const h = harness();
    const s = await playing(h, 24_000);
    s.frame();
    s.hello(48_000); // Flex -> Icom
    check("the player is restarted at the new rate", h.players[0]?.rates.join() === "24000,48000", h.players[0]?.rates);
    check("the page shows it", h.listener.getSnapshot().info?.rate === 48_000, h.listener.getSnapshot().info);
    s.hello(24_000); // and back
    check("and back again", h.players[0]?.rates.join() === "24000,48000,24000" && h.status === "playing", h.players[0]?.rates);
    s.hello(0); // to WSJT-X, which has no audio
    check("a switch to the external decoder ends the Listen with a reason", h.status === "error" && (h.error ?? "").includes("external decoder"), h.error);
    check("and releases socket and player", s.closes === 1 && h.players[0]?.stops === 1);
  }

  console.log("");
  console.log("10. volume belongs to the listener, not one player");
  {
    const h = harness();
    await playing(h);
    h.listener.setVolume(0.3);
    check("applied to the live player", h.players[0]?.volume === 0.3, h.players[0]?.volume);
    await h.listener.stop();
    await playing(h);
    check("and used by the next one", h.players[1]?.volume === 0.3, h.players[1]?.volume);
    await h.listener.stop();
    check("stop leaves idle with nothing stale", h.status === "idle" && h.listener.getSnapshot().info === null && h.error === null);
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.log("  FAIL threw:", err);
  process.exit(1);
});
