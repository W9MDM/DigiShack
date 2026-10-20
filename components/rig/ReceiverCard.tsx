import { HelpTip } from "@/components/ui/HelpTip";
import { Card, Select } from "@/components/ui/primitives";
import type { RadioCapabilities } from "@/lib/radio/capabilities";
import {
  filterEdgesFor,
  filterMatches,
  type ReceiverControls,
} from "@/lib/radio/receiver-controls";

import { ChoiceButton, ControlGrid, ControlRow, InlineError } from "./controls";
import type { RigSend } from "./types";

/** Written the way filters are spoken about (upper sideband); signed per mode on send. */
const FILTER_PRESETS = [
  { label: "DIG", lo: 0, hi: 3000, hint: "Digital 0–3000 Hz" },
  { label: "SSB", lo: 100, hi: 2800, hint: "SSB 100–2800 Hz" },
  { label: "NAR", lo: 300, hi: 2400, hint: "Narrow 300–2400 Hz" },
  { label: "CW", lo: -250, hi: 250, hint: "CW 500 Hz" },
] as const;

/**
 * The control API takes SmartSDR's AGC words (off/slow/med/fast) and refuses anything
 * else. The Icom reports and offers "mid", which the API rejected outright, so picking it
 * could only fail; the Icom path accepts "med" as its own "mid".
 */
function agcForApi(value: string): string {
  return value === "mid" ? "med" : value;
}

export function ReceiverCard({
  caps,
  receiver,
  radioMode,
  canControl,
  busy,
  send,
  error,
}: {
  caps: RadioCapabilities;
  receiver: ReceiverControls | undefined;
  radioMode: string | null;
  canControl: boolean;
  busy: string | null;
  send: RigSend;
  error: string | null;
}) {
  const agc = receiver?.agc ?? null;
  const filterLo = receiver?.filterLo ?? null;
  const filterHi = receiver?.filterHi ?? null;
  // Drawn from the ports THE RADIO listed, and only where there is a choice: a FLEX-6400
  // answers ANT1, ANT2, RX_A, XVTA, an IC-7300 has one socket and gets no picker. RX_A is
  // receive-only, which is why there are two lists.
  const antennaPickers = (
    [
      ["RX", "rxAnt", receiver?.antennas?.rx ?? [], receiver?.rxAnt ?? null],
      ["TX", "txAnt", receiver?.antennas?.tx ?? [], receiver?.txAnt ?? null],
    ] as const
  ).filter(([, , list]) => list.length > 1);

  return (
    <Card title="Receiver">
      <ControlGrid>
        <ControlRow
          label="Filter"
          help={
            <HelpTip label="About the filter">
              {caps.filterEdgesHz
                ? "These light from what the RADIO reports, not from your last click, so a change made on the front panel or by another client shows here. On lower sideband the receiver listens below the dial, so the same preset reads negative."
                : caps.filterNote}
            </HelpTip>
          }
        >
          {caps.filterEdgesHz ? (
            <>
              <div role="group" aria-label="Filter presets" className="flex flex-wrap gap-1">
                {FILTER_PRESETS.map((f) => {
                  // Against what the radio reports: a filter changed on the front panel,
                  // by a mode change or by another client must light the right preset.
                  const active = filterMatches(receiver, radioMode, f.lo, f.hi);
                  const edges = filterEdgesFor(radioMode, f.lo, f.hi);
                  return (
                    <ChoiceButton
                      key={f.label}
                      selected={active}
                      disabled={!canControl || busy === "filt"}
                      onClick={() =>
                        void send({ filterLo: edges.lo, filterHi: edges.hi }, "filt", "receiver")
                      }
                      title={active ? `${f.hint} — in force now` : f.hint}
                    >
                      {f.label}
                    </ChoiceButton>
                  );
                })}
              </div>
              {/* The measured passband, always: a radio on any width not offered above
                  lights nothing, and must not look like one that has not been read. */}
              <p className="mt-1.5 text-xs text-fg-subtle tnum">
                {filterLo !== null && filterHi !== null
                  ? `Radio: ${filterLo} to ${filterHi} Hz, ${Math.abs(filterHi - filterLo)} Hz wide`
                  : "The radio has not reported its filter yet"}
              </p>
            </>
          ) : (
            // The Icom selects FIL1/2/3 from its own menu: no honest mapping from Hz, so
            // no buttons that could only be refused.
            <p className="text-sm text-fg-muted">Set on the radio</p>
          )}
        </ControlRow>

        {caps.agc.length > 0 && (
          <ControlRow
            label="AGC"
            htmlFor="rig-agc"
            help={
              <HelpTip label="About AGC">
                As the radio reports it. &ldquo;Not reported&rdquo; means it has not said yet,
                which is not the same as off. Only the settings this radio&apos;s command set
                has are offered.
              </HelpTip>
            }
          >
            <Select
              id="rig-agc"
              // The radio's own answer, polled — never the last click.
              value={agc ?? ""}
              disabled={!canControl || busy === "agc"}
              onChange={(e) => void send({ agc: agcForApi(e.target.value) }, "agc", "receiver")}
              className="w-auto min-w-[8rem]"
            >
              <option value="" disabled>
                not reported
              </option>
              {agc !== null && !caps.agc.includes(agc) && (
                <option value={agc} disabled>
                  {agc}
                </option>
              )}
              {caps.agc.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </ControlRow>
        )}

        <ControlRow
          label="Noise"
          help={
            <HelpTip label="About the noise controls">
              Each shows the radio&apos;s state; a dashed outline means it has not been
              reported yet. A FlexRadio never broadcasts a change to its noise blanker, so
              that one is the panel&apos;s own record of a command the radio accepted,
              re-read whenever the radio service reconnects.
            </HelpTip>
          }
        >
          <div role="group" aria-label="Noise controls" className="flex flex-wrap gap-1">
            {(
              [
                ["NB", "nb", "noise blanker", receiver?.nb ?? null],
                ["NR", "nr", "noise reduction", receiver?.nr ?? null],
              ] as const
            ).map(([label, key, name, on]) => (
              <ChoiceButton
                key={key}
                selected={on}
                disabled={!canControl || busy === key}
                onClick={() => void send({ [key]: !on }, key, "receiver")}
                title={
                  on === null
                    ? `The radio has not reported its ${name} yet — click to turn it on`
                    : on
                      ? `${label} is on — click to turn it off`
                      : `${label} is off — click to turn it on`
                }
              >
                {label} {on === null ? "?" : on ? "on" : "off"}
              </ChoiceButton>
            ))}
          </div>
        </ControlRow>

        {antennaPickers.length > 0 && (
          <ControlRow
            label="Antenna"
            help={
              <HelpTip label="About the antenna ports">
                The sockets this radio says it has, and the one it says it is using.
                Changing the receive port moves the RF panadapter with it — a panadapter left
                on the old port draws a spectrum of the wrong aerial with correct labels.
              </HelpTip>
            }
          >
            <div className="flex flex-wrap gap-2">
              {antennaPickers.map(([label, field, list, current]) => (
                <label key={field} className="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
                  {label}
                  <Select
                    id={`rig-${field}`}
                    // The radio's own answer: the port can be changed in SmartSDR or on
                    // the radio's own screen.
                    value={current ?? ""}
                    disabled={!canControl || busy === field}
                    onChange={(e) => void send({ [field]: e.target.value }, field, "receiver")}
                    className="w-auto"
                  >
                    <option value="" disabled>
                      not reported
                    </option>
                    {list.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
          </ControlRow>
        )}
      </ControlGrid>

      {error && <InlineError>{error}</InlineError>}
    </Card>
  );
}
