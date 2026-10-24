import { useState } from "react";

import type { SettingsEditor } from "@/components/settings/types";
import { Button } from "@/components/ui/primitives";
import { ApiError, apiGet, apiPost } from "@/lib/client/api";

// Test buttons under Outgoing email, where the settings they test are. They were only on the
// Integrations page, which is not where anyone changing their mail server is looking.
//
// Both test the SAVED settings — the server reads them, not this form — so with unsaved
// changes they say to save first rather than quietly testing the old ones.

const MAIL_KEYS = [
  "mail.sendProvider",
  "smtp.host",
  "smtp.port",
  "smtp.secure",
  "smtp.user",
  "smtp.password",
  "smtp.from",
];

export function MailTest({ editor }: { editor: SettingsEditor }) {
  const [busy, setBusy] = useState<"connect" | "send" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  // The connection test is an SMTP sign-in; for Microsoft 365 the Received tab tests the app.
  const smtp = editor.value("mail.sendProvider") !== "graph";
  const unsaved = MAIL_KEYS.some(
    (k) => editor.isDirty(k) || editor.isCleared(k),
  );

  async function connect() {
    setBusy("connect");
    setResult(null);
    try {
      const r = (await apiGet("/api/qsl/email")) as {
        ok?: boolean;
        detail?: string;
      };
      setResult({
        ok: r.ok !== false,
        text: r.detail ?? "Connected and signed in.",
      });
    } catch (e) {
      setResult({
        ok: false,
        text:
          e instanceof ApiError ? e.message : "Could not reach the mail server",
      });
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    setBusy("send");
    setResult(null);
    try {
      const r = (await apiPost("/api/mail/test-send", {})) as {
        ok?: boolean;
        detail?: string;
      };
      setResult({ ok: r.ok === true, text: r.detail ?? "No answer." });
    } catch (e) {
      setResult({
        ok: false,
        text: e instanceof ApiError ? e.message : "The test could not be sent",
      });
    } finally {
      setBusy(null);
    }
  }

  const why = unsaved
    ? "Save first: the test uses the saved settings"
    : undefined;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap gap-2">
        {smtp && (
          <Button
            size="sm"
            loading={busy === "connect"}
            disabled={busy !== null || unsaved}
            disabledReason={why}
            onClick={() => void connect()}
          >
            Test connection
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          loading={busy === "send"}
          disabled={busy !== null || unsaved}
          disabledReason={why}
          onClick={() => void send()}
        >
          Send a test message
        </Button>
      </div>
      <p className="text-xs text-fg-subtle">
        The test message goes to the station itself (the alerts address, or the
        From address), never to anyone else.
      </p>
      {result && (
        <p
          className={`text-sm break-words ${result.ok ? "text-ok" : "text-danger"}`}
        >
          {result.text}
        </p>
      )}
    </div>
  );
}
