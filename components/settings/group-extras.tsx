import type { ReactNode } from "react";

import { DoNotCallList } from "@/components/digital/DoNotCallList";
import { LotwCertificate } from "@/components/settings/LotwCertificate";
import { MailTest } from "@/components/settings/MailTest";
import { QslCardDesigner } from "@/components/settings/QslCardDesigner";
import {
  PaCooldownField,
  RangeEditor,
  ScheduleEditor,
} from "@/components/settings/ScheduleEditor";
import { Schedules } from "@/components/settings/Schedules";
import { LicenceLookupButton } from "@/components/settings/SettingControls";
import type { SettingsEditor } from "@/components/settings/types";
import { UdpBroadcastPreview } from "@/components/settings/UdpBroadcastPreview";
import { YouTubeConnect } from "@/components/settings/YouTubeConnect";
import { Badge, Card } from "@/components/ui/primitives";

// Everything on the settings page that is not one plain field per setting, in one place.
//
// These used to be `group.id === "qsl" && …` lines scattered through the page's render,
// which meant finding out what a group shows required reading all of it, and adding a
// panel meant another condition in the middle of the JSX. Now a group's extras are an
// entry in a table, and the card renders whatever the table says.

export interface ExtraContext {
  editor: SettingsEditor;
  /** The variables that stay in .env, from GET /api/settings. */
  envOnly: readonly string[];
}

/**
 * Panels a group shows under its settings that are not settings themselves.
 *
 * Hidden while searching: a search lists settings, and a certificate upload or a broadcast
 * preview among the results would be noise. "Open group" from a result shows them.
 */
export const GROUP_EXTRAS: Record<string, (ctx: ExtraContext) => ReactNode> = {
  // The do-not-call list, under the automatic-operating limits it belongs with. It is a
  // LIST rather than a setting, so it lives in a component of its own — but it is
  // unambiguously configuration, and putting it on the Digital page pushed the decode
  // table out of view on the one page used for live operating.
  auto: () => <DoNotCallList />,
  // The card designer, under the QSL settings it previews. It reads the page's UNSAVED
  // values, so the preview shows what Save would produce rather than what is stored.
  qsl: ({ editor }) => <QslCardDesigner draft={editor.values} />,
  lotw: () => <LotwCertificate />,
  // Test buttons beside the mail settings they test.
  smtp: ({ editor }) => <MailTest editor={editor} />,
  youtube: () => <YouTubeConnect />,
  ft8battle: () => <UdpBroadcastPreview target="br" />,
  udplog: () => <UdpBroadcastPreview target="udp" />,
};

/**
 * Panels at the top of a category that belong to no single group.
 *
 * The crontab sits at the top of System rather than under any one group: the timers it
 * lists are configured from settings scattered across Logbook sync, QSL, Automation and
 * Radio, and filing it under one of them would put it where only part of it applies.
 * Asked for as "a crontab showing all the schedules".
 */
export const CATEGORY_EXTRAS: Record<string, (ctx: ExtraContext) => ReactNode> = {
  system: ({ envOnly }) => (
    <>
      <Card title="Kept in .env">
        <p className="text-sm text-fg-muted">
          These stay in the environment file permanently and are not editable here. Settings
          live in the database, so the database credentials cannot come from it — and the key
          that decrypts the secrets cannot itself be encrypted.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {envOnly.map((k) => (
            <Badge key={k}>{k}</Badge>
          ))}
        </div>
      </Card>
      <Card title="Schedules">
        <Schedules />
      </Card>
    </>
  ),
};

export interface CustomControlProps {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  editor: SettingsEditor;
}

/**
 * Settings drawn by an editor of their own instead of a text box.
 *
 * These carry their own Remove and Clear affordances, so the field's red "Clear" is not
 * shown beside them — a second one next to the day strip reads as "clear the strip".
 */
export const CUSTOM_CONTROLS: Record<string, (p: CustomControlProps) => ReactNode> = {
  // The strip draws the sleeping hours over the schedule, so it reads the sleep setting's
  // UNSAVED value too.
  "schedule.hours": ({ value, onChange, disabled, editor }) => (
    <ScheduleEditor
      value={value}
      onChange={onChange}
      sleepSpec={editor.value("schedule.sleep")}
      disabled={disabled}
    />
  ),
  "schedule.sleep": ({ value, onChange, disabled }) => (
    <RangeEditor value={value} onChange={onChange} disabled={disabled} />
  ),
};

/** Controls that sit beside a setting's own field. */
export const FIELD_ACCESSORIES: Record<string, (p: CustomControlProps) => ReactNode> = {
  // The licence class decides where SSTV may be sent, and a US callsign no longer encodes
  // it, so this fills it from a HamDB lookup instead of making the operator type
  // "us-general" exactly.
  "station.licenceClass": ({ onChange, disabled }) => (
    <LicenceLookupButton onChange={onChange} disabled={disabled} />
  ),
};

/** Several settings shown as one control, in the position of the first of them. */
export interface CompositeField {
  id: string;
  keys: readonly string[];
  label: string;
  help: string;
  render: (editor: SettingsEditor) => ReactNode;
}

export const COMPOSITE_FIELDS: readonly CompositeField[] = [
  {
    // Two number fields — "PA cooldown after" and "PA cooldown rest" — that a grid dealt
    // onto opposite sides of the page with unrelated fields between them. Two halves of
    // one sentence, so one control.
    id: "pa-cooldown",
    keys: ["schedule.paAfterMinutes", "schedule.paRestMinutes"],
    label: "PA cooldown",
    help: "A duty-cycle limit for the finals, independent of the schedule.",
    render: (editor) => (
      <PaCooldownField
        afterMinutes={editor.value("schedule.paAfterMinutes")}
        restMinutes={editor.value("schedule.paRestMinutes")}
        onChangeAfter={(v) => editor.setValue("schedule.paAfterMinutes", v)}
        onChangeRest={(v) => editor.setValue("schedule.paRestMinutes", v)}
      />
    ),
  },
];

const COMPOSITE_OF: ReadonlyMap<string, CompositeField> = new Map(
  COMPOSITE_FIELDS.flatMap((c) => c.keys.map((k) => [k, c] as const)),
);

export function compositeFor(key: string): CompositeField | undefined {
  return COMPOSITE_OF.get(key);
}
