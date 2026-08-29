import { useCallback, useEffect, useRef, useState } from "react";
import { ToolTabs } from "@/components/settings/ToolTabs";

import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiGet, apiPatch, apiPost } from "@/lib/client/api";
import { formatUtc } from "@/lib/time";

interface UpdateCheck {
  allowed: boolean;
  branch: string | null;
  localSha: string | null;
  remoteSha: string | null;
  behind: number;
  ahead: number;
  dirty: boolean;
  dirtyFiles: string[];
  version: string;
  incoming: string[];
  error: string | null;
  /** Host `origin` points at, so nothing here has to name a particular forge. */
  remoteHost: string;
  /** The fetch got through with no credential — a public repository needs none. */
  anonymousOk: boolean;
  /** What each incoming version does, newest first. */
  changes: { version: string; summary: string }[];
}

interface UpdateStep {
  name: string;
  status: "pending" | "running" | "ok" | "failed" | "skipped";
  detail?: string;
  ms?: number;
}

interface UpdateState {
  phase: "idle" | "running" | "reloading" | "done" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  triggeredBy: string | null;
  versionBefore: string | null;
  versionAfter: string | null;
  steps: UpdateStep[];
  log: string[];
  error: string | null;
}

const STEP_TONE = {
  ok: "ok",
  failed: "danger",
  running: "info",
  skipped: "neutral",
  pending: "neutral",
} as const;

export default function UpdatePage() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  const running = state?.phase === "running" || state?.phase === "reloading";

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet<{ state: UpdateState }>("/api/update");
      setState(res.state);
    } catch {
      // A poll failing mid-reload is expected — the server is restarting.
    }
  }, []);

  const doCheck = useCallback(async () => {
    setBusy("check");
    setError(null);
    try {
      const res = await apiPost<{ check: UpdateCheck; state: UpdateState }>(
        "/api/update?action=check",
        {},
      );
      setCheck(res.check);
      setState(res.state);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Check failed"));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void doCheck();
  }, [doCheck]);

  // Poll while a run is in flight. Keeps going through the reload, which is when
  // the connection drops and comes back.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [running, refresh]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [state?.log]);

  async function enableUpdates() {
    setBusy("enable");
    setError(null);
    try {
      await apiPatch("/api/settings", {
        updates: [{ key: "update.allowFromUi", value: "true" }],
      });
      await doCheck();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Could not enable"));
    } finally {
      setBusy(null);
    }
  }


  async function runUpdate() {
    if (!check) return;
    const summary = check.incoming.slice(0, 5).join("\n");
    if (
      !window.confirm(
        `Deploy ${check.behind} commit(s) from origin/${check.branch}?\n\n${summary}\n\nThis installs dependencies, migrates the database, rebuilds and reloads the app.`,
      )
    ) {
      return;
    }

    setBusy("run");
    setError(null);
    try {
      await apiPost("/api/update?action=run", {});
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Could not start"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <ToolTabs />
      <PageHeader
        title="Updates"
        subtitle={check ? `Running version ${check.version}` : undefined}
        actions={
          <Button disabled={busy !== null || running} onClick={() => void doCheck()}>
            {busy === "check" ? "Checking…" : "Check again"}
          </Button>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorBanner>{error.message}</ErrorBanner>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="Status"
          actions={
            check?.behind ? (
              <Badge tone="accent">{check.behind} behind</Badge>
            ) : check ? (
              <Badge tone="ok">Up to date</Badge>
            ) : null
          }
        >
          {check ? (
            <div className="flex flex-col gap-4">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-fg-subtle">Version</dt>
                <dd className="text-right tnum">{check.version}</dd>
                <dt className="text-fg-subtle">Branch</dt>
                <dd className="text-right">{check.branch ?? "—"}</dd>
                <dt className="text-fg-subtle">Local</dt>
                <dd className="text-right font-mono text-xs self-center">
                  {check.localSha ?? "—"}
                </dd>
                <dt className="text-fg-subtle">Remote</dt>
                <dd className="text-right font-mono text-xs self-center">
                  {check.remoteSha ?? "—"}
                </dd>
              </dl>

              {check.error && <ErrorBanner>{check.error}</ErrorBanner>}

              {check.dirty && (
                <div className="border border-warn/40 bg-warn/10 text-warn text-sm px-3 py-2 rounded-sm">
                  <p className="font-medium">
                    Uncommitted changes in the working tree
                  </p>
                  <p className="text-xs mt-1">
                    Updating is refused so local edits aren&apos;t clobbered.
                    Commit or stash them first.
                  </p>
                  <ul className="mt-1.5 font-mono text-xs">
                    {check.dirtyFiles.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}

              {check.ahead > 0 && (
                <p className="text-xs text-fg-subtle">
                  This checkout is also {check.ahead} commit(s) ahead of the
                  remote. Only a fast-forward is attempted, so a diverged branch
                  will be refused rather than merged.
                </p>
              )}

              {/* The fetch failed. There is no token box to send anyone to any more —
                  DigiShack fetches a PUBLIC repository anonymously, and a fork that needs
                  authentication configures a git credential helper on the server, where
                  a secret belongs. So this says what happened and gets out of the way;
                  the error itself is printed above. */}
              {check.error && !check.anonymousOk && (
                <p className="text-sm text-fg-muted">
                  The fetch did not get through. This repository is public and needs no
                  credential — if you are running a private fork, configure a git
                  credential helper for{" "}
                  <span className="text-fg tnum">{check.remoteHost || "the remote"}</span>{" "}
                  on the server.
                </p>
              )}

              {/* NOT gated on a token any more.
                  
                  This box is the only way to turn UI updating on, and requiring a token
                  first meant a public install — which needs no token — could never enable
                  it, so the Update button below could never appear. Reported as "the auto
                  update is supposed to be hitting the public repo and have an update
                  button if it sees an update"; it could not, by construction. */}
              {!check.allowed && (
                <div className="border border-line rounded-sm p-3">
                  <p className="text-sm text-fg-muted">
                    Updating from the UI is turned off. Enabling it means an admin
                    account can deploy code to this server, so it is off by
                    default rather than silently switched on by an upgrade.
                  </p>
                  <Button
                    variant="primary"
                    className="mt-2"
                    disabled={busy !== null}
                    onClick={() => void enableUpdates()}
                  >
                    {busy === "enable" ? "Enabling…" : "Enable UI updates"}
                  </Button>
                </div>
              )}

              {check.allowed && check.behind > 0 && !check.dirty && (
                <Button
                  variant="primary"
                  disabled={busy !== null || running}
                  onClick={() => void runUpdate()}
                >
                  {running
                    ? "Updating…"
                    : `Update to ${check.remoteSha ?? "latest"}`}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-fg-subtle">Checking…</p>
          )}
        </Card>

        <Card title="What's new">
          {/* WHAT THE UPDATE DOES, not what it is called.
              
              This card listed commit subjects, and on the public mirror those are
              "DigiShack 1.129.0" — a version number twice over, next to a version number.
              So the one question anyone has before pressing Update, "what changes if I do
              this", had no answer on the page that asks them to press it.
              
              The summaries come from the mirror's CHANGELOG, which the publish generates
              from the private repository's commit subjects — that convention means every
              release already has a written one-line description, it simply never reached
              anywhere a reader could see it. */}
          {check?.changes?.length ? (
            <ul className="flex flex-col gap-2">
              {check.changes.map((c) => (
                <li key={c.version} className="flex gap-2 items-baseline">
                  <span className="tnum text-xs text-accent-bright shrink-0">
                    {c.version}
                  </span>
                  <span className="text-sm text-fg">{c.summary}</span>
                </li>
              ))}
            </ul>
          ) : check?.incoming.length ? (
            // Fallback for a remote with no generated changelog — an older mirror, or a
            // private fork. Better than an empty card, and honest about being raw.
            <ul className="flex flex-col gap-1 font-mono text-xs">
              {check.incoming.map((c) => (
                <li key={c} className="text-fg-muted">
                  {c}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-subtle">
              {check?.behind === 0
                ? "Nothing to pull."
                : "Run a check to see what would be deployed."}
            </p>
          )}
        </Card>


        {state && state.phase !== "idle" && (
          <Card
            title="Last run"
            className="lg:col-span-2"
            actions={
              <Badge
                tone={
                  state.phase === "done"
                    ? "ok"
                    : state.phase === "failed"
                      ? "danger"
                      : "info"
                }
              >
                {state.phase}
              </Badge>
            }
          >
            <div className="flex flex-col gap-3">
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-sm">
                <dt className="text-fg-subtle">Started</dt>
                <dd className="tnum">{formatUtc(state.startedAt)}</dd>
                <dt className="text-fg-subtle">Finished</dt>
                <dd className="tnum">{formatUtc(state.finishedAt)}</dd>
                <dt className="text-fg-subtle">Triggered by</dt>
                <dd className="truncate">{state.triggeredBy ?? "—"}</dd>
                <dt className="text-fg-subtle">Version</dt>
                <dd className="tnum">
                  {state.versionBefore ?? "?"}
                  {state.versionAfter && state.versionAfter !== state.versionBefore
                    ? ` → ${state.versionAfter}`
                    : ""}
                </dd>
              </dl>

              {state.error && <ErrorBanner>{state.error}</ErrorBanner>}

              {state.phase === "reloading" && (
                <p className="text-sm text-info">
                  The app is reloading. This page may briefly fail to load — that
                  is the update being applied.
                </p>
              )}

              <ul className="flex flex-col gap-1">
                {state.steps.map((s, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    <Badge tone={STEP_TONE[s.status]}>{s.status}</Badge>
                    <span className="font-mono text-xs">{s.name}</span>
                    {s.detail && (
                      <span className="text-fg-subtle text-xs">{s.detail}</span>
                    )}
                    {s.ms !== undefined && (
                      <span className="text-fg-subtle text-xs tnum ml-auto">
                        {(s.ms / 1000).toFixed(1)}s
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              {state.log.length > 0 && (
                <details open={state.phase === "failed"}>
                  <summary className="cursor-pointer text-sm text-fg-muted">
                    Output ({state.log.length} lines)
                  </summary>
                  <pre
                    ref={logRef}
                    className="mt-2 max-h-80 overflow-auto bg-bg border border-line rounded-sm p-2 font-mono text-[11px] leading-relaxed text-fg-muted whitespace-pre-wrap"
                  >
                    {state.log.join("\n")}
                  </pre>
                </details>
              )}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

export const getServerSideProps = withPageAuth({ role: "ADMIN" });
