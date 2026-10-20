import type { ReactNode } from "react";

import { CUSTOM_CONTROLS, FIELD_ACCESSORIES } from "@/components/settings/group-extras";
import { HelpText, Highlight } from "@/components/settings/HelpText";
import { selectChoices } from "@/components/settings/select-choices";
import { LimitField, Toggle } from "@/components/settings/SettingControls";
import type { DisplayItem } from "@/components/settings/display";
import type { ClientSetting, SettingsEditor } from "@/components/settings/types";
import { UNREADABLE_PLACEHOLDER, unreadableNotice } from "@/components/settings/visibility";
import { HelpTip } from "@/components/ui/HelpTip";
import { Badge, Button, Input, Select, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/** Values an env file or an older build may hold for a boolean, read the way the server reads them. */
const TRUE_VALUES = new Set(["true", "1", "yes"]);

interface RowChrome {
  /** Anchor id for deep links and search jumps. */
  id: string;
  label: ReactNode;
  /** The control the label names, when there is a single one. */
  labelFor?: string;
  badges?: ReactNode;
  meta?: ReactNode;
  control: ReactNode;
  /** Control under the text instead of beside it. */
  wide: boolean;
  safety: boolean;
  dirty: boolean;
  flash: boolean;
}

/**
 * The layout every setting shares: what it is on the left, the control on the right.
 *
 * Replaces a two-column grid of label-over-control fields, which dealt related settings
 * onto opposite sides of the page and left every row as tall as its longest help text.
 * One setting per row reads top to bottom, and the control lines up down the right edge
 * where the eye can scan for it.
 */
function SettingRow({ id, label, labelFor, badges, meta, control, wide, safety, dirty, flash }: RowChrome) {
  return (
    <div
      id={id}
      tabIndex={-1}
      className={cn(
        "-mx-4 grid scroll-mt-24 gap-x-6 gap-y-2.5 px-4 py-4 outline-none transition-colors",
        !wide && "lg:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)]",
        // A stripe that cannot be missed and does not move the content: these rows key a
        // transmitter, or switch off a protection, and should look like it.
        safety && "shadow-[inset_3px_0_0_var(--color-warn)]",
        dirty && "bg-info/5",
        flash && "ring-2 ring-inset ring-accent-bright/60",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {labelFor ? (
            <label htmlFor={labelFor} className="text-sm font-medium text-fg">
              {label}
            </label>
          ) : (
            <span className="text-sm font-medium text-fg">{label}</span>
          )}
          {badges}
        </div>
        {meta}
      </div>
      <div className="min-w-0">{control}</div>
    </div>
  );
}

function SafetyBadge({ kind }: { kind: ClientSetting["safety"] }) {
  if (!kind) return null;
  return (
    <Badge tone="warn" size="sm">
      {kind === "transmit" ? "Transmit gate" : "Protection"}
    </Badge>
  );
}

function UnreadableBadge() {
  return (
    <Badge tone="warn" size="sm">
      Can&rsquo;t decrypt
    </Badge>
  );
}

function UnsavedBadge() {
  return (
    <Badge tone="info" size="sm">
      Unsaved
    </Badge>
  );
}

/** A value the way the control shows it, for "Default: …". */
function describeValue(s: ClientSetting, v: string | null | undefined): string {
  const raw = (v ?? "").trim();
  if (raw === "") return "";
  switch (s.type) {
    case "boolean":
      return TRUE_VALUES.has(raw) ? "On" : "Off";
    case "limit": {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? raw : "Off";
    }
    case "select":
      return s.options?.find((o) => o.value === raw)?.label ?? raw;
    default:
      return raw;
  }
}

/**
 * The line under the help that says where the value comes from.
 *
 * Kept from the old field hint, word for word where it could be, because each sentence
 * answers a question an operator asked: whether a cleared password has gone yet, which
 * credential is stored, whether .env is still in charge. It now sits UNDER the help
 * rather than replacing it — a stored secret used to lose its explanation entirely.
 */
function statusLine(s: ClientSetting, cleared: boolean): { text: string; warn: boolean } | null {
  // Says the value is still there, not just that it is going. Naming Undo is the
  // difference between a warning and an instruction.
  if (cleared) return { text: "Still stored. It goes when you save — Undo keeps it.", warn: true };
  // A stored value that will not decrypt is not "Currently ••••1234": nothing uses it, and
  // nothing falls back past it, so the service is off until it is typed in again.
  const unreadable = unreadableNotice(s);
  if (unreadable) return { text: unreadable, warn: true };
  if (s.type === "secret" && s.configured) {
    return {
      text: s.fromEnv
        ? `Currently ${s.masked} from ${s.envFallback} — saving a value here moves it into the database, encrypted.`
        : `Currently ${s.masked}. Leave blank to keep it.`,
      warn: false,
    };
  }
  if (s.fromEnv) {
    return { text: `Currently from ${s.envFallback}. Saving here moves it into the database.`, warn: false };
  }
  if (s.type === "text") {
    if (s.source === "default") return { text: "Using the default text.", warn: false };
    if (s.customised && s.defaultValue) return { text: "Changed from the default text — Clear restores it.", warn: false };
    return null;
  }
  // The default is said even while it is in use — "transmit power says default 0" is how
  // an operator learns that 0 means "leave the rig's power alone".
  if (s.source === "default") {
    const d = describeValue(s, s.value);
    return d ? { text: `Using the default: ${d}`, warn: false } : null;
  }
  if (s.customised && s.defaultValue !== undefined) {
    const d = describeValue(s, s.defaultValue);
    return d ? { text: `Default: ${d}`, warn: false } : null;
  }
  return null;
}

/** The fallback a limit's checkbox restores: the stored number, else the default. */
function limitFallback(s: ClientSetting): string {
  for (const v of [s.value, s.defaultValue]) {
    const n = Number(v);
    if (v && Number.isFinite(n) && n > 0) return v;
  }
  return "";
}

function ClearControl({ setting: s, cleared, onToggle }: { setting: ClientSetting; cleared: boolean; onToggle: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button variant={cleared ? "secondary" : "danger"} onClick={onToggle}>
        {cleared ? "Undo" : "Clear"}
        <span className="sr-only"> {s.label}</span>
      </Button>
      {/* Nothing is deleted on the click, and that has to be knowable BEFORE the click —
          a red Clear beside a saved API key otherwise reads as "destroy it now". A title
          attribute said so once, and a title does not exist on a touch screen. */}
      <HelpTip align="right" label={`What Clear does to ${s.label}`}>
        Nothing is deleted yet. Clear only marks the value to be removed the next time you
        press <strong className="font-medium text-fg">Save changes</strong> — until then it
        stays exactly as it is, and Undo puts it back.
        {s.type === "secret" && (
          <>
            {" "}
            Saving it cleared is final, though: the stored secret is not recoverable
            afterwards. To REPLACE one, type the new value instead — you do not have to clear
            it first.
          </>
        )}
      </HelpTip>
    </div>
  );
}

export interface FieldOptions {
  /** Search terms to mark. */
  terms?: readonly string[];
  /** Prefixed to every DOM id, so a search result and the hidden category view never share one. */
  idPrefix?: string;
  /** Show the setting's key under its label — on in search results, where it explains a match. */
  showKey?: boolean;
  /** Mark advanced settings, where they appear outside their disclosure. */
  showAdvanced?: boolean;
  flash?: boolean;
}

/** One setting: label, help, where its value comes from, and the control that edits it. */
export function SettingField({
  setting: s,
  editor,
  terms = [],
  idPrefix = "",
  showKey = false,
  showAdvanced = false,
  flash = false,
}: { setting: ClientSetting; editor: SettingsEditor } & FieldOptions) {
  const controlId = `${idPrefix}${s.key}`;
  const helpId = `${controlId}-help`;
  const statusId = `${controlId}-status`;
  const value = editor.value(s.key);
  const cleared = editor.isCleared(s.key);
  const dirty = editor.isDirty(s.key);
  const onChange = (v: string) => editor.setValue(s.key, v);
  const status = statusLine(s, cleared);
  const unreadable = s.unreadable || s.problem !== null;
  const describedBy = [s.help ? helpId : null, status ? statusId : null].filter(Boolean).join(" ") || undefined;

  const custom = CUSTOM_CONTROLS[s.key];
  const accessory = FIELD_ACCESSORIES[s.key];
  // These carry their own off switch or their own Clear, so the generic one would be a second.
  const ownsClear = s.type === "limit" || custom !== undefined;

  let control: ReactNode;
  let grows = true;
  if (custom) {
    control = custom({ value, onChange, disabled: cleared, editor });
  } else if (s.type === "limit") {
    control = (
      <LimitField
        id={controlId}
        label={s.label}
        value={value}
        fallback={limitFallback(s)}
        onChange={onChange}
        disabled={cleared}
        describedBy={describedBy}
      />
    );
  } else if (s.type === "boolean") {
    grows = false;
    control = (
      <Toggle
        id={controlId}
        checked={TRUE_VALUES.has(value.trim())}
        onChange={(on) => onChange(on ? "true" : "false")}
        disabled={cleared}
        describedBy={describedBy}
      />
    );
  } else if (s.type === "text") {
    control = (
      <Textarea
        id={controlId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={cleared}
        rows={8}
        spellCheck={false}
        placeholder={s.placeholder ?? undefined}
        aria-describedby={describedBy}
        // Monospace: these are templates with {PLACEHOLDER} tokens, and proportional type
        // makes it hard to see leading spaces or a token typed with the wrong case.
        className="font-mono text-xs leading-relaxed"
      />
    );
  } else if (s.type === "select") {
    control = (
      <Select
        id={controlId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={cleared}
        aria-describedby={describedBy}
      >
        {/* A saved value that is not one of the choices is kept and shown rather than
            silently snapped to the first option: a card configured before the picker
            existed may legitimately name a font installed on the server. See selectChoices. */}
        {selectChoices(s.options, value).map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  } else {
    control = (
      <Input
        id={controlId}
        type={s.type === "secret" ? "password" : s.type === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          unreadable
            ? UNREADABLE_PLACEHOLDER
            : s.type === "secret" && s.configured
              ? "unchanged"
              : (s.placeholder ?? "")
        }
        aria-invalid={unreadable && !dirty ? true : undefined}
        autoComplete={s.type === "secret" ? "new-password" : "off"}
        spellCheck={false}
        disabled={cleared}
        aria-describedby={describedBy}
        className={s.type === "secret" || s.type === "number" ? "tnum" : undefined}
      />
    );
  }

  return (
    <SettingRow
      id={`${idPrefix}setting-${s.key}`}
      label={<Highlight text={s.label} terms={terms} />}
      labelFor={custom ? undefined : controlId}
      wide={s.wide}
      safety={s.safety !== null || unreadable}
      dirty={dirty}
      flash={flash}
      badges={
        <>
          <SafetyBadge kind={s.safety} />
          {unreadable && <UnreadableBadge />}
          {dirty && <UnsavedBadge />}
          {showAdvanced && s.advanced && <Badge size="sm">Advanced</Badge>}
        </>
      }
      meta={
        <>
          {showKey && (
            <code className="break-all font-mono text-xs text-fg-subtle">
              <Highlight text={s.key} terms={terms} />
            </code>
          )}
          {s.help && (
            <HelpText
              id={helpId}
              text={s.help}
              terms={terms}
              subject={s.label}
              // A transmit gate's consequences are never one click away.
              full={s.safety !== null}
            />
          )}
          {status && (
            <p id={statusId} className={cn("text-sm", status.warn ? "text-warn" : "text-fg-subtle")}>
              {status.text}
            </p>
          )}
        </>
      }
      control={
        <div className="flex flex-wrap items-start gap-1.5">
          {/* A long stored value (the band-hop list, a URL) gets the whole row below sm,
              with Clear under it, rather than about 160px of it and the rest cut off.
              Keyed on the stored value, not the draft, so the row does not jump mid-typing. */}
          <div
            className={cn(
              "min-w-0",
              grows && "min-w-40 flex-1",
              grows && s.type === "string" && (s.value ?? "").length > 16 && "max-sm:basis-full",
            )}
          >
            {control}
          </div>
          {s.configured && !ownsClear && (
            <ClearControl setting={s} cleared={cleared} onToggle={() => editor.toggleClear(s.key)} />
          )}
          {accessory?.({ value, onChange, disabled: cleared, editor })}
        </div>
      }
    />
  );
}

/** Several settings drawn as one control — see COMPOSITE_FIELDS. */
export function CompositeFieldRow({
  item,
  editor,
  terms = [],
  idPrefix = "",
  showKey = false,
  showAdvanced = false,
  flash = false,
}: { item: Extract<DisplayItem, { kind: "composite" }>; editor: SettingsEditor } & FieldOptions) {
  const dirty = item.settings.some((s) => editor.isDirty(s.key));
  return (
    <SettingRow
      id={`${idPrefix}${item.id}`}
      label={<Highlight text={item.composite.label} terms={terms} />}
      wide
      safety={false}
      dirty={dirty}
      flash={flash}
      badges={
        <>
          {dirty && <UnsavedBadge />}
          {showAdvanced && item.advanced && <Badge size="sm">Advanced</Badge>}
        </>
      }
      meta={
        <>
          {showKey && (
            <code className="break-all font-mono text-xs text-fg-subtle">
              <Highlight text={item.settings.map((s) => s.key).join(", ")} terms={terms} />
            </code>
          )}
          <HelpText text={item.composite.help} terms={terms} subject={item.composite.label} />
        </>
      }
      control={item.composite.render(editor)}
    />
  );
}

/** Whichever of the two a row is. */
export function DisplayRow({
  item,
  editor,
  ...opts
}: { item: DisplayItem; editor: SettingsEditor } & FieldOptions) {
  return item.kind === "setting" ? (
    <SettingField setting={item.setting} editor={editor} {...opts} />
  ) : (
    <CompositeFieldRow item={item} editor={editor} {...opts} />
  );
}
