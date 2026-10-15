// Listening to the receiver in the browser, as a hook: the Rig page and the Decodes page
// both offer it, and two copies of this would drift the first time either was fixed.
// Lifted from pages/rig.tsx, where every comment below was earned.

import { useCallback, useEffect, useRef, useState } from "react";

import { ReceiverAudio } from "@/lib/client/audio-player";

export interface ReceiverAudioInfo {
  rate: number;
  packets: number;
  context: string;
  bufferedMs: number;
  underruns: number;
}

export interface UseReceiverAudio {
  listening: boolean;
  volume: number;
  setVolume: (v: number) => void;
  /** What the player reports, once a second while listening: proof audio is arriving. */
  info: ReceiverAudioInfo | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggle: () => void;
}

/** `wsUrl` is the page's decodes socket URL; the audio socket sits beside it at /ws/audio. */
export function useReceiverAudio(wsUrl: string): UseReceiverAudio {
  // The player and its socket live in refs, not state: the scheduling cursor inside the
  // player must survive re-renders untouched, and these pages re-render constantly from
  // status and decode traffic. Audio that stutters on every render would be worse than none.
  const playerRef = useRef<ReceiverAudio | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /**
   * Marks the next socket close as deliberate, so `onclose` can tell a stop from a
   * failure. A ref for the same reason the socket is: it is read inside a socket callback
   * that closed over an older render.
   */
  const closeIntentRef = useRef<(() => void) | null>(null);
  const [listening, setListening] = useState(false);
  const [volume, setVolumeState] = useState(0.8);
  const volumeRef = useRef(0.8);
  const [info, setInfo] = useState<ReceiverAudioInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stop on the way out, always. A page left for another one would otherwise keep an audio
  // device open and a socket pulling 96 kB/s from the bridge for as long as the tab lived.
  useEffect(() => {
    return () => {
      closeIntentRef.current?.();
      socketRef.current?.close();
      void playerRef.current?.stop();
    };
  }, []);

  const setVolume = useCallback((v: number) => {
    volumeRef.current = v;
    setVolumeState(v);
    playerRef.current?.setVolume(v);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    // The AudioContext is created HERE, in the click, before the socket is opened. Every
    // browser blocks audio started outside a user gesture, and the failure is silent: a
    // context created when the first message arrives exists, has packets scheduled on it,
    // and plays nothing.
    const player = new ReceiverAudio();
    try {
      await player.start(volumeRef.current);
    } catch {
      setError("The browser would not start audio. Click Listen again.");
      return;
    }
    playerRef.current = player;

    try {
      const url = wsUrl.replace(/\/ws\/decodes$/, "/ws/audio");
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      socketRef.current = ws;
      // A socket that opens and closes again without a hello is a bridge that went away
      // mid-connect; without this the button flicks to Listening and back with nothing said.
      let gotHello = false;
      let closingOnPurpose = false;
      closeIntentRef.current = () => {
        closingOnPurpose = true;
      };

      ws.onopen = () => setListening(true);
      ws.onmessage = (ev) => {
        // The first frame is JSON with the sample rate; everything after it is PCM. The Icom
        // streams 48 kHz and the FlexRadio 24, and the wrong one sounds like fast forward.
        if (typeof ev.data === "string") {
          try {
            const hello = JSON.parse(ev.data) as { sampleRate?: number };
            const rate = hello.sampleRate ?? 0;
            if (!rate) {
              setError("The bridge has no radio audio to send — the source is an external decoder.");
              ws.close();
              return;
            }
            gotHello = true;
            player.setSampleRate(rate);
            setInfo({ rate, packets: 0, context: player.state.contextState, bufferedMs: 0, underruns: 0 });
          } catch {
            setError("Could not read the audio stream's format");
          }
          return;
        }
        player.push(ev.data as ArrayBuffer);
      };
      ws.onerror = () =>
        setError(
          `Could not reach the audio stream at ${url}. The bridge listens on loopback only, ` +
            "so a browser on another machine needs bridge.wsUrl pointing at a proxy.",
        );
      ws.onclose = () => {
        setListening(false);
        void playerRef.current?.stop();
        playerRef.current = null;
        if (!closingOnPurpose && !gotHello) {
          setError(
            `The audio stream at ${url} closed before sending anything. The bridge is ` +
              "probably not running — start it with `npm run bridge`.",
          );
        }
      };
    } catch {
      setError("Could not open the audio connection");
      await player.stop();
      playerRef.current = null;
    }
  }, [wsUrl]);

  const stop = useCallback(async () => {
    // Tell the socket's own onclose that this was deliberate, BEFORE closing it.
    closeIntentRef.current?.();
    socketRef.current?.close();
    socketRef.current = null;
    await playerRef.current?.stop();
    playerRef.current = null;
    setListening(false);
    // A stopped listener has no diagnostics: a stale packet count implies audio still
    // arriving, and a stale error implies the stop failed.
    setInfo(null);
    setError(null);
  }, []);

  // A counter that proves audio is arriving, rather than a button that merely looks pressed.
  useEffect(() => {
    if (!listening) return;
    const id = setInterval(() => {
      const st = playerRef.current?.state;
      if (st) {
        setInfo({
          rate: st.sampleRate,
          packets: st.packets,
          context: st.contextState,
          bufferedMs: st.bufferedMs,
          underruns: st.underruns,
        });
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [listening]);

  const toggle = useCallback(() => {
    void (listening ? stop() : start());
  }, [listening, start, stop]);

  return { listening, volume, setVolume, info, error, start, stop, toggle };
}
