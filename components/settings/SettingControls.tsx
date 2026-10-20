import { useState } from "react";

import { Button, Input } from "@/components/ui/primitives";
import { ApiError, apiGet } from "@/lib/client/api";
import { cn } from "@/lib/utils";

/**
 * An on/off setting.
 *
 * A switch rather than the Off/On dropdown it replaces: a dropdown for a yes/no question
 * takes two taps and hides the current answer behind a chevron. The words stay — "On" or
 * "Off" sits beside the switch — because a coloured pill alone does not say which way
 * round it is to someone who has not used one before.
 *
 * The whole control is the button, so on a touch screen the 44px target covers the words
 * as well as the pill.
 */
export function Toggle({
  id,
  checked,
  onChange,
  disabled,
  describedBy,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 rounded-sm text-sm text-fg disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
          checked ? "border-accent bg-accent" : "border-line-strong bg-surface-3",
        )}
      >
        <span
          className={cn(
            "inline-block size-3.5 rounded-full bg-fg transition-transform",
            checked ? "translate-x-[1.125rem]" : "translate-x-0.5",
          )}
        />
      </span>
      <span className="min-w-7 text-left">{checked ? "On" : "Off"}</span>
    </button>
  );
}

/**
 * A limit with an on/off checkbox.
 *
 * Off is stored as 0, which every guard reads as "no limit" — see `limitOn` in
 * lib/digital/qso.ts. Before this, switching a limit off meant typing 0 and hoping, and
 * for several of them 0 actually meant "trip on the first transmission", which is the
 * opposite of what anyone typing it intended.
 *
 * Turning it back on restores the number you had: the one typed before switching off in
 * this visit, otherwise the stored value, otherwise the default. `fallback` carries the
 * last two in from the page, because this component unmounts whenever you change category
 * or search, and a limit that came back as 1 after a detour would be a trap.
 */
export function LimitField({
  id,
  label,
  value,
  fallback,
  onChange,
  disabled,
  describedBy,
}: {
  id: string;
  label: string;
  value: string;
  fallback: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  const n = Number(value);
  const on = Number.isFinite(n) && n > 0;
  const [remembered, setRemembered] = useState<string>(on ? value : fallback);

  return (
    <div className="flex items-center gap-2">
      <input
        id={`${id}-on`}
        type="checkbox"
        checked={on}
        disabled={disabled}
        aria-label={`Enforce: ${label}`}
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
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        className="tnum max-w-32"
      />
      {!on && <span className="text-sm text-fg-muted">Off</span>}
    </div>
  );
}

/**
 * Fill the licence class from the operator's callsign via HamDB.
 *
 * A US callsign no longer encodes the class (vanity calls), so this is a lookup, not a
 * parse. It fills the field optimistically and leaves the operator to Save — a suggestion,
 * never an automatic write, and a non-US/club/unlisted call simply says so and is set by
 * hand. The server reads the station's own callsign; nothing here transmits.
 */
export function LicenceLookupButton({
  onChange,
  disabled,
}: {
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null);
  const look = () => {
    setBusy(true);
    setNote(null);
    void apiGet<{ found: boolean; call?: string; licenceClass?: string; name?: string | null }>(
      "/api/station/licence-lookup",
    )
      .then((r) => {
        if (r.found && r.licenceClass) {
          onChange(r.licenceClass);
          setNote({
            text: `HamDB: ${r.call}${r.name ? ` (${r.name})` : ""} → ${r.licenceClass}. Press Save to keep it.`,
            warn: false,
          });
        } else {
          setNote({
            text: `${r.call ?? "That callsign"} isn't in HamDB — set it by hand (non-US and club calls aren't listed).`,
            warn: true,
          });
        }
      })
      .catch((e) => setNote({ text: e instanceof ApiError ? e.message : "Lookup failed.", warn: true }))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex shrink-0 flex-col items-start gap-1">
      <Button variant="secondary" onClick={look} disabled={disabled} loading={busy}>
        Look up from callsign
      </Button>
      {note && (
        <span role="status" className={`text-xs ${note.warn ? "text-warn" : "text-fg-muted"}`}>
          {note.text}
        </span>
      )}
    </div>
  );
}
