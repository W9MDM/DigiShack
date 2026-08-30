import { useRef, useState } from "react";
import { ToolTabs } from "@/components/settings/ToolTabs";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiGet, useApi } from "@/lib/client/api";
import { formatUtc } from "@/lib/time";

// Backup and restore — for moving an installation to another machine.
//
// The page exists because the engine without a button is a feature nobody uses. Two
// things it insists on, both learned the hard way:
//
//   * A backup is a BUNDLE by default, not just SQL. The QSL artwork lives on disk
//     and is deliberately not in git; a database-only restore renders every card
//     against a missing background, and that is discovered weeks later.
//   * The settings key is called out on screen rather than left in documentation.
//     Move the database without it and QRZ, LoTW, eQSL, Club Log and SMTP all
//     restore as unreadable ciphertext — the failure is silent, and it looks like
//     the services broke rather than like a missing line in .env.

interface BackupFile {
  name: string;
  bytes: number;
  createdAt: string;
}

interface Listing {
  files: BackupFile[];
  settingsKeyWarning: string;
}

interface MadeBackup {
  kind: "bundle" | "sql";
  file: string;
  bytes: number;
  tables: number;
  rows: number;
  files?: { name: string; bytes: number }[];
  skipped?: { name: string; bytes: number; reason: string }[];
  includesSettingsKey?: boolean;
  schemaVersion?: string | null;
}

interface RestoreOutcome {
  kind: "bundle" | "sql";
  statements: number;
  filesWritten?: { name: string; bytes: number }[];
  settingsKeyPresent?: boolean;
  warnings?: string[];
  detail: string;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function BackupPage() {
  const { data, error, reload } = useApi<Listing>("/api/backup");
  const [busy, setBusy] = useState<string | null>(null);
  const [made, setMade] = useState<MadeBackup | null>(null);
  const [restored, setRestored] = useState<RestoreOutcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [includeKey, setIncludeKey] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const make = async (sqlOnly: boolean) => {
    setBusy(sqlOnly ? "sql" : "bundle");
    setProblem(null);
    setRestored(null);
    try {
      const q = new URLSearchParams();
      if (sqlOnly) q.set("sql", "1");
      else if (includeKey) q.set("key", "1");
      const res = await fetch(`/api/backup?${q.toString()}`, { method: "POST" });
      const body = (await res.json()) as MadeBackup & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Backup failed");
      setMade(body);
      await reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Backup failed");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Delete ${name}?`)) return;
    setBusy(name);
    setProblem(null);
    try {
      await fetch(`/api/backup?file=${encodeURIComponent(name)}`, { method: "DELETE" });
      await reload();
    } finally {
      setBusy(null);
    }
  };

  /**
   * Upload and restore.
   *
   * Two confirmations, and the second has to be typed. This replaces every table the
   * dump covers, and the QSOs that vanish are precisely the ones nobody exported.
   */
  const restore = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setProblem("Choose a backup file first");
      return;
    }
    if (
      !confirm(
        `Restore from ${file.name}?\n\nThis REPLACES the entire database — every QSO, ` +
          `setting and user currently here is destroyed and replaced by what is in that file.`,
      )
    ) {
      return;
    }
    if (prompt('Type REPLACE to confirm, or cancel.')?.trim().toUpperCase() !== "REPLACE") {
      return;
    }

    setBusy("restore");
    setProblem(null);
    setMade(null);
    try {
      const res = await fetch(
        `/api/backup?confirm=replace-everything&name=${encodeURIComponent(file.name)}`,
        { method: "PUT", body: file },
      );
      const body = (await res.json()) as RestoreOutcome & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Restore failed");
      setRestored(body);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Restore failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <ToolTabs />
      <PageHeader
        title="Backup"
        subtitle="Move this installation, or keep a copy of everything"
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {problem && (
        <div className="mb-4">
          <ErrorBanner>{problem}</ErrorBanner>
        </div>
      )}

      <Card title="Make a backup" className="mb-4">
        <p className="text-sm text-fg-muted">
          A <strong>bundle</strong> contains everything customised about this
          installation: the whole database — log, settings, users, stations, DXCC
          reference data, the QSL queue — plus the files that live on disk, which means
          your QSL card artwork. It is an ordinary gzipped tar with a{" "}
          <code className="text-fg">RESTORE.md</code> inside, so it can be unpacked by
          hand if this application is not available.
        </p>

        {/* The one thing a database dump cannot carry, said on the page rather than
            hidden in documentation: the failure mode is silent and looks like the
            remote services broke. */}
        <div className="mt-3 border border-warn/40 bg-warn/10 rounded-sm px-3 py-2 text-sm">
          <strong className="text-warn">The settings key does not live in the database.</strong>{" "}
          Service credentials — QRZ, LoTW, eQSL, Club Log, SMTP — are stored encrypted,
          and the key is <code>SETTINGS_KEY</code> in <code>.env</code>. Move the
          database without it and every one of them restores as unreadable ciphertext,
          which you find out days later when something quietly stops working.
        </div>

        <label className="mt-3 flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={includeKey}
            onChange={(e) => setIncludeKey(e.target.checked)}
            className="accent-accent mt-0.5"
          />
          <span>
            <span className="text-fg">Include the settings key in the bundle</span>
            <span className="block text-xs text-fg-subtle">
              Makes the restore complete with nothing to copy by hand — and makes this
              one file enough to act as your station on every service it uses. Treat it
              like a password: not in email, not in a shared folder, not in git.
            </span>
          </span>
        </label>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => void make(false)} disabled={busy !== null}>
            {busy === "bundle" ? "Working…" : "Back up everything"}
          </Button>
          <Button onClick={() => void make(true)} disabled={busy !== null}>
            {busy === "sql" ? "Working…" : "Database only (.sql.gz)"}
          </Button>
        </div>

        {made && (
          <div className="mt-4 border border-ok/40 bg-ok/10 rounded-sm px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="ok">{made.kind === "bundle" ? "Bundle" : "SQL only"}</Badge>
              <code className="text-fg">{made.file}</code>
              <span className="text-fg-muted tnum">{size(made.bytes)}</span>
            </div>
            <p className="mt-1.5 text-fg-muted">
              {made.tables} tables, {made.rows.toLocaleString()} rows
              {made.files?.length ? `, ${made.files.length} file(s)` : ""}
              {made.schemaVersion ? ` · schema ${made.schemaVersion}` : ""}
            </p>
            {made.files?.length ? (
              <ul className="mt-1 text-xs text-fg-subtle">
                {made.files.map((f) => (
                  <li key={f.name} className="tnum">
                    {f.name} — {size(f.bytes)}
                  </li>
                ))}
              </ul>
            ) : made.kind === "bundle" ? (
              <p className="mt-1 text-xs text-warn">
                No files on disk were found to include. If you have set a QSL card image,
                check that it is under <code>data/</code>.
              </p>
            ) : null}
            {made.skipped?.length ? (
              <p className="mt-1 text-xs text-warn">
                Left out: {made.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}
              </p>
            ) : null}
            {made.kind === "bundle" && (
              <p className="mt-1 text-xs">
                {made.includesSettingsKey ? (
                  <span className="text-warn">
                    The settings key IS in this file. Treat it as a password.
                  </span>
                ) : (
                  <span className="text-fg-subtle">
                    No settings key — copy the <code>SETTINGS_KEY=</code> line from{" "}
                    <code>.env</code> separately.
                  </span>
                )}
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title="On this machine" className="mb-4">
        {!data ? (
          <p className="text-sm text-fg-muted">Loading…</p>
        ) : data.files.length === 0 ? (
          <EmptyState title="No backups yet">
            Nothing has been backed up on this machine.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-fg-muted">
                  <th className="py-1.5 font-medium">File</th>
                  <th className="py-1.5 font-medium">Kind</th>
                  <th className="py-1.5 font-medium text-right">Size</th>
                  <th className="py-1.5 font-medium">Made (UTC)</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.files.map((f) => (
                  <tr key={f.name}>
                    <td className="py-1.5">
                      <a
                        href={`/api/backup?file=${encodeURIComponent(f.name)}`}
                        className="hover:text-accent-bright break-all"
                      >
                        {f.name}
                      </a>
                    </td>
                    <td className="py-1.5">
                      {f.name.includes(".bundle.") ? (
                        <Badge tone="neutral">Bundle</Badge>
                      ) : (
                        <Badge>SQL</Badge>
                      )}
                    </td>
                    <td className="py-1.5 tnum text-right text-fg-muted">{size(f.bytes)}</td>
                    <td className="py-1.5 tnum text-fg-muted whitespace-nowrap">
                      {formatUtc(f.createdAt)}
                    </td>
                    <td className="py-1.5 text-right">
                      <Button
                        variant="danger"
                        onClick={() => void remove(f.name)}
                        disabled={busy !== null}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-fg-subtle">
          These sit in <code>backups/</code>, which is excluded from git — a dump holds
          every credential and the whole log. Copy them somewhere off this machine;
          a backup that only exists on the computer it came from is not a backup.
        </p>
      </Card>

      <Card title="Restore">
        <p className="text-sm text-fg-muted">
          Upload a bundle or a plain <code>.sql.gz</code> dump. Which one it is is
          detected from the file itself, so a renamed download still works.
        </p>
        <p className="mt-2 text-sm text-danger">
          This <strong>replaces</strong> the entire database. Every QSO, setting and user
          here now is destroyed. There is no undo.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept=".gz,.tgz,.tar.gz,application/gzip"
            className="text-sm text-fg-muted file:mr-2 file:border file:border-line-strong file:bg-surface-2 file:text-fg file:rounded-sm file:px-2 file:py-1 file:text-sm"
          />
          <Button variant="danger" onClick={() => void restore()} disabled={busy !== null}>
            {busy === "restore" ? "Restoring…" : "Restore"}
          </Button>
        </div>

        {restored && (
          <div className="mt-4 border border-ok/40 bg-ok/10 rounded-sm px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge tone="ok">{restored.kind === "bundle" ? "Bundle" : "SQL only"}</Badge>
              <span className="text-fg">
                {restored.statements.toLocaleString()} statements applied
              </span>
            </div>
            {restored.filesWritten?.length ? (
              <p className="mt-1.5 text-fg-muted">
                {restored.filesWritten.length} file(s) written back:{" "}
                <span className="text-xs">
                  {restored.filesWritten.map((f) => f.name).join(", ")}
                </span>
              </p>
            ) : null}
            {restored.warnings?.map((w) => (
              <p key={w} className="mt-1.5 text-warn text-xs">
                {w}
              </p>
            ))}
            <p className="mt-2 text-fg">{restored.detail}</p>
          </div>
        )}
      </Card>
    </>
  );
}

export const getServerSideProps = withPageAuth({ role: "ADMIN" });
