import { useState } from "react";

import { SourcePicker } from "@/components/radio/SourcePicker";
import { Button } from "@/components/ui/primitives";
import { ApiError, apiPost } from "@/lib/client/api";

/**
 * The page-level actions: about the station and the radio service, not the dial.
 *
 * In the page header so they stop crowding the dial line, where five unlike buttons sat
 * between the meters and the frequency.
 */
export function StationActions({
  source,
  streaming,
  onError,
  onChanged,
}: {
  source: "flex" | "icom" | "wsjtx" | null;
  streaming: boolean;
  onError: (message: string | null) => void;
  onChanged: () => void;
}) {
  const [streamBusy, setStreamBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);

  return (
    <>
      {/* YOUTUBE LIVE: the waterfall and the receiver audio, pushed to the operator's
          channel. Confirmed on the way ON only — going live is the irreversible half, and
          stopping a stream is always safe. The bridge holds the key; this says start or
          stop. */}
      <Button
        size="sm"
        variant={streaming ? "danger" : "secondary"}
        disabled={restarting}
        loading={streamBusy}
        onClick={() => {
          if (
            !streaming &&
            !window.confirm(
              "Go live on YouTube? The waterfall and the receiver audio start " +
                "broadcasting to your channel, and anything heard on the air goes out " +
                "with them. YouTube takes about 20 seconds to show it.",
            )
          ) {
            return;
          }
          setStreamBusy(true);
          onError(null);
          void apiPost("/api/bridge/control", { action: "stream", enable: !streaming })
            .catch((e: unknown) =>
              onError(e instanceof ApiError || e instanceof Error ? e.message : "Stream failed"),
            )
            .finally(() => {
              setStreamBusy(false);
              onChanged();
            });
        }}
        title={
          streaming
            ? "Stop the YouTube stream."
            : "Stream the waterfall and the receiver audio to YouTube Live. Needs a stream key in Settings → YouTube Live."
        }
      >
        {streaming ? "● Live — stop" : "Go live"}
      </Button>

      {/* RESTART THE RADIO SERVICE. The bridge owns the radio, the decoders and the
          transmit path, so restarting it is a real diagnostic step that used to need a
          shell. Confirmed, because it drops any contact in flight; not red, because it is
          what somebody reaches for when things are already wrong. */}
      <Button
        size="sm"
        variant="ghost"
        disabled={streamBusy}
        loading={restarting}
        onClick={() => {
          if (
            !window.confirm(
              "Restart the radio service? Any contact in progress is dropped and the " +
                "station is off the air for about 20 seconds while it reconnects. " +
                "The web page itself keeps running.",
            )
          ) {
            return;
          }
          setRestarting(true);
          void apiPost("/api/bridge/control", { action: "restart" })
            .catch(() => {})
            // The bridge is gone for ~20 s; the socket reconnects on its own.
            .finally(() => setTimeout(() => setRestarting(false), 25_000));
        }}
        title="Restart the radio service (the bridge). Drops any contact in progress and reconnects to the radio, about 20 seconds. Use it when the radio link is stuck or decoding has stopped."
      >
        {restarting ? "Restarting…" : "Restart service"}
      </Button>

      <SourcePicker source={source} variant="inline" />
    </>
  );
}
