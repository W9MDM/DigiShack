import { ToolTabs } from "@/components/settings/ToolTabs";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { ApiError, apiPatch, useApi } from "@/lib/client/api";
import {
  PaCooldownField,
  RangeEditor,
  ScheduleEditor,
} from "@/components/settings/ScheduleEditor";
import { HelpTip } from "@/components/ui/HelpTip";
import { DoNotCallList } from "@/components/digital/DoNotCallList";
import { LotwCertificate } from "@/components/settings/LotwCertificate";
import { Schedules } from "@/components/settings/Schedules";
import { QslCardDesigner } from "@/components/settings/QslCardDesigner";
import { SETTINGS_TABS, settingsTabFor } from "@/lib/settings/tabs";

interface SettingView {
  key: string;
  label: string;
  type: "string" | "secret" | "number" | "boolean" | "text" | "limit" | "select";
  wide?: boolean;
  group: string;
  help?: string;
  placeholder?: string;
  /** Choices, for a `select`. Written as the same plain string a text field would write. */
  options?: { value: string; label: string }[];
  source: "database" | "env" | "default" | "unset";
  value: string | null;
  masked: string | null;
  configured: boolean;
  fromEnv: boolean;
  envFallback?: string;
}

interface SettingsResponse {
  groups: {
    id: string;
    title: string;
    blurb?: string;
    /** Document in docs/ that explains this group, without the .md. */
    doc?: string;
    /** What the reader will find there, for the icon's tooltip. */
    docLabel?: string;
  }[];
  settings: SettingView[];
  keyProblem: string | null;
  envOnly: string[];
}

interface PatchResponse extends SettingsResponse {
  updated: string[];
  cleared: string[];
  unchanged: string[];
  rejected: { key: string; reason: string }[];
}

export default function SettingsPage() {
  const { data, error, reload } = useApi<SettingsResponse>("/api/settings");

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [report, setReport] = useState<PatchResponse | null>(null);

  // The active tab lives in the URL. A settings page that always reopens on the first
  // tab is infuriating when you are iterating on one radio setting, and it means a
  // support answer can link straight to the right place.
  const router = useRouter();
  const active =
    SETTINGS_TABS.find((t) => t.id === router.query.tab)?.id ?? SETTINGS_TABS[0]!.id;
  const selectTab = (id: string) =>
    void router.replace({ query: { ...router.query, tab: id } }, undefined, {
      shallow: true,
    });

  // Which groups have unsaved edits, so a tab can show that it is hiding one. Without
  // this an edit made on another tab is invisible while the Save button stays lit,
  // which reads as a bug.
  const dirtyTabs = useMemo(() => {
    const out = new Set<string>();
    if (!data) return out;
    for (const st of data.settings) {
      const changed =
        cleared.has(st.key) ||
        (st.type !== "secret" && (draft[st.key] ?? "") !== (st.value ?? "")) ||
        (st.type === "secret" && (draft[st.key] ?? "") !== "");
      if (changed) out.add(settingsTabFor(st.group).id);
    }
    return out;
  }, [data, draft, cleared]);

  // Seed the draft from non-secret values whenever the server data changes.
  // Secrets are never seeded — the browser is never sent one.
  useEffect(() => {
    if (!data) return;
    const next: Record<string, string> = {};
    for (const s of data.settings) {
      if (s.type !== "secret") next[s.key] = s.value ?? "";
    }
    setDraft(next);
    setCleared(new Set());
  }, [data]);

  const dirty =
    cleared.size > 0 ||
    (data
      ? data.settings.some((s) => {
          const d = draft[s.key];
          if (d === undefined) return false;
          if (s.type === "secret") return d !== "";
          return d !== (s.value ?? "");
        })
      : false);

  /**
   * A save the server refused until the operator agrees to the consequence.
   *
   * Holds the exact updates that were refused, so accepting re-sends THOSE rather than
   * whatever the form happens to contain by then. The page stays interactive while this is
   * open, and a field edited in the meantime would otherwise be written under an
   * acknowledgement given for something else.
   */
  const [confirming, setConfirming] = useState<{
    updates: { key: string; value: string | null }[];
    items: { key: string; message: string }[];
  } | null>(null);

  async function save() {
    if (!data) return;
    setSaving(true);
    setSaveError(null);
    setReport(null);

    const updates: { key: string; value: string | null }[] = [];

    for (const s of data.settings) {
      if (cleared.has(s.key)) {
        updates.push({ key: s.key, value: null });
        continue;
      }
      const d = draft[s.key];
      if (d === undefined) continue;

      if (s.type === "secret") {
        // Blank means "not retyped" — skip it rather than blanking the stored
        // credential.
        if (d !== "") updates.push({ key: s.key, value: d });
      } else if (d !== (s.value ?? "")) {
        updates.push({ key: s.key, value: d });
      }
    }

    if (updates.length === 0) {
      setSaving(false);
      return;
    }

    await send(updates);
  }

  /**
   * The PATCH itself, shared by the ordinary save and the confirmed one.
   *
   * `acknowledge` names the keys whose consequence has been accepted. It is sent per key
   * rather than as a blanket flag so that agreeing to one dangerous setting cannot carry
   * consent to another that happened to be in the same save.
   */
  async function send(
    updates: { key: string; value: string | null }[],
    acknowledge?: string[],
  ): Promise<void> {
    setSaving(true);
    try {
      const res = await apiPatch<PatchResponse>("/api/settings", {
        updates,
        ...(acknowledge ? { acknowledge } : {}),
      });
      setConfirming(null);
      setReport(res);
      reload();
    } catch (err) {
      // 409 with per-key details is the server asking rather than refusing. Nothing was
      // written — see the route — so there is no half-applied save to reconcile.
      if (err instanceof ApiError && err.status === 409 && err.details) {
        setConfirming({
          updates,
          items: Object.entries(err.details).map(([key, msgs]) => ({
            key,
            message: msgs.join(" "),
          })),
        });
        setSaving(false);
        return;
      }
      setSaveError(
        err instanceof ApiError ? err : new ApiError(0, "Could not save settings"),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ToolTabs />
      <PageHeader
        title="Settings"
        subtitle="Service credentials, stored encrypted in the database"
        actions={
          <Button
            variant="primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        }
      />

      {error && <ErrorBanner>{error.message}</ErrorBanner>}
      {saveError && (
        <div className="mb-4">
          <ErrorBanner>{saveError.message}</ErrorBanner>
        </div>
      )}

      <SettingsTabBar active={active} dirtyTabs={dirtyTabs} onSelect={selectTab} />

      {data?.keyProblem && (
        <div className="mb-4">
          <ErrorBanner>
            <strong>Secrets cannot be stored.</strong> {data.keyProblem}
          </ErrorBanner>
        </div>
      )}

      {report && (
        <div className="mb-4 border border-line rounded-sm px-3 py-2 text-sm flex flex-wrap gap-x-4 gap-y-1">
          {report.updated.length > 0 && (
            <span className="text-ok">
              {report.updated.length} saved
            </span>
          )}
          {report.cleared.length > 0 && (
            <span className="text-warn">{report.cleared.length} cleared</span>
          )}
          {report.rejected.length > 0 && (
            <span className="text-danger">
              {report.rejected.length} rejected:{" "}
              {report.rejected.map((r) => `${r.key} (${r.reason})`).join("; ")}
            </span>
          )}
        </div>
      )}

      {data && (
        <>
          {active === "system" && (
          <Card title="Kept in .env" className="mb-6">
            <p className="text-sm text-fg-muted">
              These three stay in the environment file permanently and are not
              editable here. Settings live in the database, so the database
              credentials cannot come from it — and the key that decrypts the
              secrets below cannot itself be encrypted.
            </p>
            <div className="flex gap-2 mt-2">
              {data.envOnly.map((k) => (
                <Badge key={k}>{k}</Badge>
              ))}
            </div>
          </Card>
          )}

          <div className="flex flex-col gap-6">
            {/* The crontab, at the top of System rather than hung off a setting group.
                Nothing here belongs to one group — the timers it lists are configured from
                settings scattered across Logbooks, QSL, Automation and Radio — and hanging
                it under any one of them would file it where only part of it applies.
                Asked for as "a crontab showing all the schedules". */}
            {active === "system" && (
              <Card title="Schedules">
                <Schedules />
              </Card>
            )}

            {data.groups.map((group) => {
              if (settingsTabFor(group.id).id !== active) return null;
              const items = data.settings.filter((s) => s.group === group.id);
              if (items.length === 0) return null;

              return (
                <Card
                  key={group.id}
                  title={
                    <div className="flex items-center gap-2">
                      <span>{group.title}</span>
                      {/* Where to read more about this group.

                          Set only where a document genuinely covers the settings under it —
                          a link to a page that turns out not to discuss them is worse than
                          no link, because the reader pays a click to find that out. The
                          click is meant to be an informed one.

                          Points at the public repository rather than an in-app viewer:
                          rendering markdown would mean a new dependency for one icon. The
                          same files are on disk in `docs/` for a shack with no internet,
                          which is worth naming for exactly that shack.

                          THE FAULT: everything above was delivered by `title=` on a bare "i"
                          — so on a tablet the entire informing half was missing and what
                          remained was an unlabelled circle that navigated somewhere off-site
                          when touched. The one control on the page whose only job was to
                          explain was the one that could not. The link now lives INSIDE the
                          explanation instead of behind it, which costs a mouse user a click
                          and gives a touch user the sentence they never had. */}
                      {group.doc && (
                        <HelpTip label={`Help for ${group.title}`}>
                          {group.docLabel ?? "Documentation"} for these settings.{" "}
                          <a
                            href={`https://github.com/W9MDM/DigiShack/blob/main/docs/${group.doc}.md`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-accent-bright underline underline-offset-2"
                          >
                            Read it on GitHub
                          </a>
                          , or open{" "}
                          <span className="font-mono">docs/{group.doc}.md</span> on the
                          server if the shack has no internet.
                        </HelpTip>
                      )}
                    </div>
                  }
                >
                  {group.blurb && (
                    <p className="text-sm text-fg-muted mb-4">{group.blurb}</p>
                  )}

                  <div className="grid gap-4 md:grid-cols-2">
                    {items
                      // Rendered together below as a single control: they are two halves
                      // of one sentence, and the grid was dealing them onto opposite
                      // sides of the page with unrelated fields in between.
                      .filter(
                        (s) =>
                          s.key !== "schedule.paAfterMinutes" &&
                          s.key !== "schedule.paRestMinutes",
                      )
                      .map((s) => (
                      <SettingField
                        key={s.key}
                        wide={s.wide}
                        setting={s}
                        value={draft[s.key] ?? ""}
                        sleepSpec={draft["schedule.sleep"] ?? ""}
                        cleared={cleared.has(s.key)}
                        onChange={(v) =>
                          setDraft((d) => ({ ...d, [s.key]: v }))
                        }
                        onToggleClear={() =>
                          setCleared((c) => {
                            const next = new Set(c);
                            if (next.has(s.key)) next.delete(s.key);
                            else next.add(s.key);
                            return next;
                          })
                        }
                      />
                      ))}

                    {/* The do-not-call list, under the automatic-operating limits it
                        belongs with. It is a LIST rather than a setting, so it lives in a
                        component of its own — but it is unambiguously configuration, and
                        it was briefly put on the Digital page beside the decodes on the
                        theory that a courtesy should be one click from the callsign that
                        prompted it. That was wrong twice over: it pushed the decode table
                        out of view on the one page used for live operating, and a list of
                        callsigns to never call is something you set up, not something you
                        watch. */}
                    {group.id === "auto" && <DoNotCallList />}

                    {/* The card designer, under the QSL settings it previews. `draft` is
                        the page's unsaved state, so the preview shows what Save would
                        produce rather than what is currently stored — which is the whole
                        point: the geometry settings had no feedback loop at all, and the
                        only way to judge a change was to email yourself a QSL. */}
                    {group.id === "qsl" && <QslCardDesigner draft={draft} />}
                    {group.id === "lotw" && <LotwCertificate />}

                    {group.id === "schedule" && (
                      <Field
                        label="PA cooldown"
                        hint="A duty-cycle limit for the finals, independent of the schedule."
                      >
                        <PaCooldownField
                          afterMinutes={draft["schedule.paAfterMinutes"] ?? "0"}
                          restMinutes={draft["schedule.paRestMinutes"] ?? "10"}
                          onChangeAfter={(v) =>
                            setDraft((d) => ({ ...d, "schedule.paAfterMinutes": v }))
                          }
                          onChangeRest={(v) =>
                            setDraft((d) => ({ ...d, "schedule.paRestMinutes": v }))
                          }
                        />
                      </Field>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/*
        THE CONFIRMATION, for the handful of settings whose off position removes a
        protection rather than changing a preference.

        The server decides this, not the page — see the PATCH route. Nothing was written
        when it answered, so dismissing this leaves the stored settings exactly as they
        were and there is no half-applied save to explain.

        It re-sends the SAME updates the server refused, held in `confirming`, rather than
        rebuilding them from the form. The page stays interactive underneath, and a field
        edited while this is open would otherwise be written under an acknowledgement the
        operator gave for something else.
      */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          onClick={() => setConfirming(null)}
        >
          <div
            className="bg-surface border border-line rounded-md shadow-panel max-w-lg w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="confirm-title" className="font-display text-base text-fg mb-3">
              {confirming.items.length === 1
                ? "This turns off a protection"
                : "These turn off protections"}
            </h2>
            <div className="flex flex-col gap-3 mb-5">
              {confirming.items.map((c) => (
                <p key={c.key} className="text-sm text-muted leading-relaxed">
                  {c.message}
                </p>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirming(null)} disabled={saving}>
                Cancel
              </Button>
              {/*
                The label says what it does, not "OK". An operator reading only the buttons
                should still learn the consequence.
              */}
              <Button
                variant="danger"
                disabled={saving}
                onClick={() =>
                  void send(
                    confirming.updates,
                    confirming.items.map((c) => c.key),
                  )
                }
              >
                {saving ? "Saving…" : "Turn it off anyway"}
              </Button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}

/**
 * The tab bar.
 *
 * Setting tabs switch in place; tool tabs navigate to pages that keep their own routes.
 * Both are in one strip because to an operator they are one thing — "the place you go to
 * configure the station" — and splitting them across a tab bar and a sixteen-item nav
 * menu is what made this hard to use in the first place.
 *
 * No role filtering: this page is ADMIN-only, so everyone who can see the bar can open
 * every tab on it.
 */
function SettingsTabBar({
  active,
  dirtyTabs,
  onSelect,
}: {
  active: string;
  dirtyTabs: Set<string>;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="mb-6 border-b border-line">
      {/* Horizontal scroll rather than wrap: on a phone a wrapping tab bar pushes the
          content off the screen, and the whole point of this change was the phone. */}
      <div className="flex gap-1 overflow-x-auto pb-px" role="tablist">
        {SETTINGS_TABS.map((t) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onSelect(t.id)}
              className={`shrink-0 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                on
                  ? "border-accent text-fg"
                  : "border-transparent text-fg-muted hover:text-fg"
              }`}
            >
              {t.label}
              {/* An edit on another tab is otherwise invisible while Save stays lit,
                  which reads as a bug rather than as unsaved work. */}
              {dirtyTabs.has(t.id) && !on && (
                <span className="ml-1.5 text-warn" aria-label="unsaved changes">
                  •
                </span>
              )}
            </button>
          );
        })}

      </div>
    </div>
  );
}

/**
 * A limit with an on/off checkbox.
 *
 * Off is stored as 0, which every guard now reads as "no limit" — see `limitOn` in
 * lib/digital/qso.ts. Before this, switching a limit off meant typing 0 and hoping, and
 * for several of them 0 actually meant "trip on the first transmission", which is the
 * opposite of what anyone typing it intended.
 *
 * The previous value is remembered while the box is unchecked, so turning a limit off to
 * try something and back on again does not lose the number you had tuned.
 */
function LimitField({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const n = Number(value);
  const on = Number.isFinite(n) && n > 0;
  const [remembered, setRemembered] = useState<string>(on ? value : "");

  return (
    <div className="flex items-center gap-2">
      <input
        id={`${id}-on`}
        type="checkbox"
        checked={on}
        disabled={disabled}
        aria-label="Enforce this limit"
        onChange={(e) => {
          if (e.target.checked) onChange(remembered || "1");
          else {
            if (on) setRemembered(value);
            onChange("0");
          }
        }}
        className="h-4 w-4 shrink-0 accent-accent"
      />
      <Input
        id={id}
        type="number"
        value={on ? value : ""}
        placeholder={on ? "" : "no limit"}
        disabled={disabled || !on}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-32"
      />
      {!on && <span className="text-sm text-fg-muted">Off</span>}
    </div>
  );
}

function SettingField({
  setting,
  value,
  wide,
  sleepSpec,
  cleared,
  onChange,
  onToggleClear,
}: {
  setting: SettingView;
  value: string;
  wide?: boolean;
  /** Sleeping hours, so the schedule strip can draw the override where it applies. */
  sleepSpec?: string;
  cleared: boolean;
  onChange: (v: string) => void;
  onToggleClear: () => void;
}) {
  const s = setting;
  const usesCustomEditor =
    s.type === "limit" || s.key === "schedule.hours" || s.key === "schedule.sleep";

  const hint = (() => {
    // Says the value is still there, not just that it is going. "Will be cleared when you
    // save" left the operator to work out for themselves whether the stored password had
    // already gone; naming Undo is the difference between a warning and an instruction.
    if (cleared) return "Still stored. It goes when you save — Undo keeps it.";
    if (s.type === "secret" && s.configured) {
      return s.fromEnv
        ? `Currently ${s.masked} from ${s.envFallback} — saving a value here moves it into the database, encrypted`
        : `Currently ${s.masked}. Leave blank to keep it.`;
    }
    if (s.fromEnv) {
      return `Currently from ${s.envFallback}. Saving here moves it into the database.`;
    }
    if (s.source === "default") return `Default: ${s.value ?? "—"}`;
    return s.help;
  })();

  return (
    <Field
      label={s.label}
      htmlFor={s.key}
      hint={hint ?? s.help}
      className={[wide ? "md:col-span-2" : "", cleared ? "opacity-60" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex gap-1.5 items-start">
        {s.type === "limit" ? (
          <LimitField id={s.key} value={value} onChange={onChange} disabled={cleared} />
        ) : s.key === "schedule.hours" ? (
          <ScheduleEditor
            value={value}
            onChange={onChange}
            sleepSpec={sleepSpec}
            disabled={cleared}
          />
        ) : s.key === "schedule.sleep" ? (
          <RangeEditor value={value} onChange={onChange} disabled={cleared} />
        ) : s.type === "text" ? (
          <textarea
            id={s.key}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={cleared}
            rows={8}
            spellCheck={false}
            placeholder={s.placeholder ?? undefined}
            // Monospace: these are templates with {PLACEHOLDER} tokens, and
            // proportional type makes it hard to see leading spaces or a token
            // typed with the wrong case.
            className="w-full rounded-sm border border-line bg-bg-raised px-2 py-1.5 font-mono text-xs leading-relaxed text-fg focus:border-accent-bright focus-visible:outline-2 focus-visible:outline-accent-bright focus-visible:outline-offset-1"
          />
        ) : s.type === "select" ? (
          /* A fixed list of valid values gets a list.
             
             The card font shipped with three typefaces and a free-text box, so the only
             route to a working value was reading the help and typing the family name
             exactly — "theres no drop down to pick the font, how is someone supposed to
             know what fonts loaded". They could not.
             
             A value already saved that is NOT one of the choices is kept and shown rather
             than silently snapped to the first option: a card configured before this
             existed may legitimately name a font installed on the server. */
          <Select
            id={s.key}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={cleared}
          >
            {value !== "" && !(s.options ?? []).some((o) => o.value === value) && (
              <option value={value}>{value} (not one of the bundled fonts)</option>
            )}
            {(s.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        ) : s.type === "boolean" ? (
          <Select
            id={s.key}
            value={value === "true" ? "true" : "false"}
            onChange={(e) => onChange(e.target.value)}
            disabled={cleared}
          >
            <option value="false">Off</option>
            <option value="true">On</option>
          </Select>
        ) : (
          <Input
            id={s.key}
            type={s.type === "secret" ? "password" : s.type === "number" ? "number" : "text"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={
              s.type === "secret" && s.configured
                ? "unchanged"
                : (s.placeholder ?? "")
            }
            autoComplete={s.type === "secret" ? "new-password" : "off"}
            spellCheck={false}
            disabled={cleared}
            className={s.type === "secret" || s.type === "number" ? "tnum" : undefined}
          />
        )}

        {/* The schedule editors carry their own Remove and Clear affordances, and a
            second red "Clear" beside the day strip reads as "clear the strip". The
            limit checkbox is likewise its own off switch. */}
        {s.configured && !usesCustomEditor && (
          <div className="flex shrink-0 items-center gap-1">
            <Button variant={cleared ? "secondary" : "danger"} onClick={onToggleClear}>
              {cleared ? "Undo" : "Clear"}
            </Button>
            {/* THE FAULT: `title="Clear this value on save"` was the ONLY statement anywhere
                that this button does not delete anything yet — and a title attribute does not
                exist on a touch screen. What the tablet showed was a red Clear sitting beside
                a saved API key or a QRZ password, with nothing at all to say whether pressing
                it would destroy the credential on the spot. That is a question an operator has
                to answer BEFORE the click, so putting the answer in the hint that appears
                AFTER it is not a fix; the popover is reachable while the value is still safe.

                `align="right"` because this sits at the right-hand edge of a two-column grid
                and a left-anchored panel would open past the card. */}
            <HelpTip align="right" label={`What Clear does to ${s.label}`}>
              Nothing is deleted yet. Clear only marks the value to be removed the next time
              you press <strong className="font-medium text-fg">Save changes</strong> — until
              then it stays exactly as it is, and Undo puts it back.
              {s.type === "secret" && (
                <>
                  {" "}
                  Saving it cleared is final, though: the stored secret is not recoverable
                  afterwards. To REPLACE one, type the new value instead — you do not have
                  to clear it first.
                </>
              )}
            </HelpTip>
          </div>
        )}
      </div>
    </Field>
  );
}

export const getServerSideProps = withPageAuth({ role: "ADMIN" });
