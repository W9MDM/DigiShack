import { useState } from "react";

import { Badge, Button, ErrorBanner, Td, Th } from "@/components/ui/primitives";
import { useApi } from "@/lib/client/api";
import { PROTECTED_FIELDS } from "@/lib/logging/broadcast-fields";

/**
 * Exactly what a UDP broadcast puts on the network, field by field.
 *
 * "i want to see every field its sending" — and that is the right thing to ask of a feature
 * that takes the station's log and sprays it onto a LAN. A settings card that says "broadcast
 * contacts" and shows nothing is asking for trust it has not earned.
 *
 * FROM THE REAL SEND PATH. The server builds this with the same `adifDatagramBody` the sender
 * calls, with the operator's own settings, against their most recent contact — so what is
 * shown here cannot drift from what is sent. A preview assembled separately would be a second
 * implementation and would eventually disagree with the first, which is worse than no preview.
 *
 * ONE PANEL PER BROADCAST. `target="br"` shows what Battle Royale receives, `target="udp"`
 * what the program on the desk receives; they have different identities, destinations and
 * switches, so one panel could be right for at most one of them.
 *
 * Their own callsigns and their own grid, rather than an example: a worked example can hide a
 * field that happens to be empty on this station, which is exactly the thing somebody opens
 * this panel to check.
 */
export function UdpBroadcastPreview({ target }: { target: "br" | "udp" }) {
  const { data, error, reload } = useApi<{
    target: "br" | "udp";
    enabled: boolean;
    datagram: string | null;
    detail?: string;
    fields?: { name: string; value: string }[];
    refused?: { input: string; reason: string }[];
    mentionsDigishack?: boolean;
    destination?: { host: string; port: number; raw: string };
    problem?: string | null;
    forQso?: { callsign: string; band: string; at: string };
  }>(`/api/digital/udp-preview?target=${target}`);

  const [raw, setRaw] = useState(false);
  const receiver = target === "br" ? "Battle Royale" : "the receiving program";

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h4 className="text-sm font-medium">What {receiver} gets</h4>
        <div className="flex gap-3">
          <button
            type="button"
            className="text-xs text-fg-subtle hover:text-accent-bright"
            onClick={() => setRaw((r) => !r)}
          >
            {raw ? "Show fields" : "Show raw"}
          </button>
          <button
            type="button"
            className="text-xs text-fg-subtle hover:text-accent-bright"
            onClick={reload}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && <ErrorBanner>{error.message}</ErrorBanner>}

      {/* WHETHER IT IS ON AT ALL comes before where it goes: a destination shown with no
          hint that nothing is being sent to it is how an operator spends an evening
          checking a firewall. */}
      {data && !data.enabled && (
        <p className="mb-3 text-xs text-fg-subtle">
          {target === "br"
            ? "BR mode is off, so nothing is sent here. Switch it on above or on the decodes page."
            : "Off, so nothing is sent. Switch it on above or with the UDP button on the decodes page."}
        </p>
      )}

      {/* THE DESTINATION NEXT, because a perfectly formed record sent nowhere is the
          failure that actually happened — a pasted URL, failing once per contact, in a log
          the operator had no reason to read. */}
      {data?.problem && (
        <div className="mb-3 border border-danger/50 bg-danger/10 text-danger text-sm px-3 py-2 rounded-sm">
          {data.problem}
        </div>
      )}
      {data?.destination && !data.problem && (
        <p className="mb-3 text-xs text-fg-subtle">
          {data.enabled ? "Sending to" : "Would send to"}{" "}
          <code className="font-mono text-fg-muted">
            {data.destination.host}:{data.destination.port}
          </code>
          {data.destination.raw !== data.destination.host && (
            <> — tidied from &ldquo;{data.destination.raw}&rdquo;</>
          )}
        </p>
      )}

      {data?.datagram === null && (
        <p className="text-sm text-fg-muted">{data.detail}</p>
      )}

      {/* REFUSED LINES FIRST, because a setting that silently dropped half its content is the
          failure this panel exists to prevent. Each one says which line and why. */}
      {data?.refused && data.refused.length > 0 && (
        <div className="mb-3 border border-warn/40 bg-warn/10 text-warn text-xs px-3 py-2 rounded-sm">
          <strong>Not sent:</strong>
          <ul className="mt-1 space-y-0.5">
            {data.refused.map((r) => (
              <li key={r.input}>
                <code className="font-mono">{r.input}</code> — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data?.mentionsDigishack && (
        <div className="mb-3 border border-warn/40 bg-warn/10 text-warn text-xs px-3 py-2 rounded-sm">
          Something in this record names DigiShack. If you are sending to a contest or scoring
          site that expects a WSJT-X log, check the program id and the comment above.
        </div>
      )}

      {data?.datagram && !raw && data.fields && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-surface-2 text-left">
                  {["Field", "Value", ""].map((h) => (
                    <Th key={h}>{h}</Th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.fields.map((f) => {
                  // THE SAME SET THE PARSER ENFORCES, imported rather than restated. A second
                  // copy here would eventually disagree with the one that actually refuses,
                  // and the disagreement would show an operator a field as editable that is
                  // not — which is the most annoying possible way to be wrong.
                  const fromContact = PROTECTED_FIELDS.has(f.name);
                  return (
                    <tr key={f.name}>
                      <Td className="font-mono whitespace-nowrap">{f.name}</Td>
                      <Td className="font-mono break-all text-fg-muted">{f.value}</Td>
                      <Td className="whitespace-nowrap">
                        {fromContact ? (
                          <Badge tone="neutral">from the contact</Badge>
                        ) : (
                          <Badge tone="info">yours</Badge>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-fg-subtle">
            {data.forQso && (
              <>
                Built from your most recent contact — {data.forQso.callsign} on{" "}
                {data.forQso.band}.{" "}
              </>
            )}
            Fields marked <em>from the contact</em> are what the radio measured and cannot be
            changed here; the rest come from the settings above, and you can add more with{" "}
            <strong>Extra ADIF fields</strong>.
          </p>
        </>
      )}

      {data?.datagram && raw && (
        <pre className="overflow-x-auto text-xs font-mono bg-surface-2 p-3 rounded-sm whitespace-pre-wrap break-all">
          {data.datagram}
        </pre>
      )}
    </div>
  );
}
