import { useState } from "react";

import { apiGet } from "@/lib/client/api";

// Connect the station's YouTube account.
//
// STREAMING NEEDS NONE OF THIS. A stream key is enough to broadcast, and that is the setting
// directly above. This is for the two things that act AS the channel — renaming the day's
// broadcast, and reading live chat — which Google only permits against an OAuth token. An
// API key cannot do either, which is the first thing every operator tries.
//
// The button does not connect anything itself: it asks the server for a consent URL and
// sends the operator to Google. The refresh token comes back to /api/youtube/callback and
// is written there, so it never passes through this component or any other browser code.

export function YouTubeConnect(): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redirect, setRedirect] = useState<string | null>(null);

  return (
    <div className="mt-4 rounded-sm border border-line bg-surface-2 p-3">
      <div className="text-[10px] uppercase tracking-wide text-fg-muted mb-1">
        Broadcast control and live chat
      </div>
      <p className="text-sm text-fg-muted mb-3">
        Optional. Streaming works with the stream key alone. Connect an account to let
        DigiShack rename the day&rsquo;s broadcast and read live chat, so viewers can post a
        callsign to be worked.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void apiGet<{ url: string; redirectUri: string }>("/api/youtube/connect")
              .then((r) => {
                setRedirect(r.redirectUri);
                // A full navigation, not a popup: Google refuses to render its consent
                // screen inside a frame, and a blocked popup is a dead button with no
                // explanation.
                window.location.href = r.url;
              })
              .catch((e: Error) => {
                setError(e.message);
                setBusy(false);
              });
          }}
          className="px-2 py-1 text-xs rounded-sm border border-accent text-accent-bright hover:border-accent-bright"
        >
          {busy ? "Opening Google…" : "Connect to YouTube"}
        </button>
        <span className="text-xs text-fg-subtle">
          Save the client ID and secret first.
        </span>
      </div>

      {/* THE REDIRECT URI, shown because Google compares it as an exact string and its
          error for a mismatch names nothing useful. Copying it out of here is faster than
          reconstructing it, and it is the single most common reason a first attempt
          fails. */}
      {redirect && (
        <p className="mt-3 text-xs text-fg-muted">
          Authorised redirect URI: <code className="text-fg">{redirect}</code>
        </p>
      )}

      {error && <p className="mt-3 text-xs text-danger">{error}</p>}

      <p className="mt-3 text-xs text-fg-subtle">
        Publish the OAuth consent screen in Google Cloud Console rather than leaving it in
        Testing — Google expires refresh tokens from a testing app after seven days, and the
        connection would then fail weekly with nothing to say why.
      </p>
    </div>
  );
}
