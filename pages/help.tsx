import { Card, PageHeader } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";

import { version } from "@/package.json";

// The help page.
//
// Written to answer the questions this software actually generates, which are mostly not
// "where is the button". They are "why did it not call that station", "why is the
// waterfall dark", "why did nothing transmit" - questions about behaviour that is
// deliberate and invisible. A tour of the navigation would answer none of them.
//
// Ordered by how likely a question is to arrive, not by how the code is arranged.

function Q({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line/60 pt-3 first:border-0 first:pt-0">
      <h3 className="text-sm font-medium mb-1">{q}</h3>
      <div className="text-sm text-fg-muted leading-relaxed flex flex-col gap-2">
        {children}
      </div>
    </div>
  );
}

export default function HelpPage() {
  return (
    <>
      <PageHeader
        title="Help"
        subtitle="Why things behave the way they do, and what to check when they do not"
      />

      <div className="flex flex-col gap-4">
        <Card title="Transmitting">
          <div className="flex flex-col gap-3">
            <Q q="Nothing transmits. Why?">
              <p>
                Transmit is off until you turn it on, and then it is gated several more
                times. In order: <strong>Allow transmit</strong> must be on in Settings, the
                station callsign must be set, the schedule must permit the current hour, and
                no guard may have tripped.
              </p>
              <p>
                The Rig page lists the live blockers and each one names itself. That list is
                the fastest answer, because it is the same list the transmitter consults.
              </p>
            </Q>
            <Q q="It stopped transmitting on its own.">
              <p>
                Something tripped a guard, and every one exists to stop an unattended station
                being a nuisance or destroying its own finals: SWR above the limit, PA
                temperature, a run longer than the wall-clock ceiling, too many QSOs in one
                run, too many consecutive transmissions with no operator input, or several
                receive periods that decoded nothing while carrying no audio - which means
                the radio cannot hear, and a station that cannot hear must not transmit.
              </p>
              <p>
                Guards that count events reset when you interact. The wall-clock limit does
                not, deliberately.
              </p>
            </Q>
            <Q q="Why does it refuse to start with a placeholder callsign?">
              <p>
                Because transmitting under a callsign that is not yours is illegal, and
                <code>N0CALL</code>, <code>MYCALL</code> and friends are exactly what people
                type to get past a required field. There is no default callsign anywhere in
                this software and there will not be one.
              </p>
            </Q>
          </div>
        </Card>

        <Card title="Automatic operating">
          <div className="flex flex-col gap-3">
            <Q q="Why did it skip a station I wanted to work?">
              <p>
                Several possible reasons, and the log line says which: already worked inside
                the dupe window, on the do-not-call list, a band slot already filled if you
                have that rule on, below the minimum SNR, or in a failure cooldown after not
                answering earlier.
              </p>
            </Q>
            <Q q="Dupe window or duplicate rules - what is the difference?">
              <p>
                The <strong>dupe window</strong> asks whether you worked them{" "}
                <em>recently</em> on this band and mode, and exists to stop one contact
                repeating inside a session. The <strong>duplicate</strong> rules ask whether
                you have <em>ever</em> worked them, which is a different question and the one
                an operator who asks you to stop is asking about.
              </p>
              <p>
                Duplicates are prevented per callsign from the do-not-call list. The
                station-wide switch exists but is off: one operator&apos;s preference is not a
                policy for everybody you work.
              </p>
            </Q>
            <Q q="Somebody asked me not to contact them again.">
              <p>
                Add them under Settings &rarr; Automation &rarr; <strong>Do not call</strong>.
                Two kinds: <strong>No duplicates</strong> still lets the automatic modes work
                them on a band and mode not already in your log, and <strong>Never</strong>{" "}
                stops them entirely. Pick the one they actually asked for - most people asking
                about duplicates are happy to be worked on a new band.
              </p>
              <p>Neither affects calling them by hand. It records a request.</p>
            </Q>
          </div>
        </Card>

        <Card title="Decoding and the displays">
          <div className="flex flex-col gap-3">
            <Q q="No decodes.">
              <p>
                Check the radio is connected and that audio is actually arriving. The Digital
                page shows a packet count, and zero packets with a connected radio means the
                audio path is broken rather than the band being quiet. The bridge restarts
                itself if audio stops for 90 seconds, and emails you when it does.
              </p>
            </Q>
            <Q q="Why are there two waterfalls, and why do they look nothing alike?">
              <p>
                They show different things. The one on the Digital page is the{" "}
                <strong>audio passband</strong> - 0 to 3 kHz of what the receiver is
                demodulating, which is one signal, and where decode offsets are marked. The
                one on the Rig page is the <strong>RF panadapter</strong>: tens of kHz of band
                with every station on it. No setting bridges them.
              </p>
            </Q>
            <Q q="Can I trust the dB numbers on the panadapter?">
              <p>
                No - treat them as relative. The dBm window is not calibrated and the Rig page
                says so at the top. Signal reports from the decoder are real; the
                panadapter&apos;s vertical scale is for comparing signals with each other.
              </p>
            </Q>
          </div>
        </Card>

        <Card title="QSL and uploads">
          <div className="flex flex-col gap-3">
            <Q q="Why did a QSL email not send?">
              <p>
                Most often there is no published address at QRZ, which is an ordinary outcome.
                Others: the recipient has opted out, their QRZ QSL route carries{" "}
                <code>NOQSOCC</code> or <code>NOEQSL</code>, the daily ceiling is reached, or
                no public URL is configured - without one there is no unsubscribe link to
                include, and this refuses to send unsolicited mail with no way out.
              </p>
            </Q>
            <Q q="Somebody replied asking to be unsubscribed.">
              <p>
                Every message carries a one-click link and the headers that make a mail client
                show its own Unsubscribe button, so this should be rare. If it happens, the
                queue records who was mailed and when, and adding them to the opt-out list
                also cancels anything already queued for them.
              </p>
            </Q>
          </div>
        </Card>

        <Card title="When something is plainly wrong">
          <div className="flex flex-col gap-3">
            <Q q="A panel is empty and I do not know if that is real.">
              <p>
                Empty and broken look different on purpose. A panel that could not load says
                so and retries by itself; a panel that loaded and found nothing says that
                instead. If you see neither, reload - and if a reload fixes it, that is worth
                reporting, because it should not have been necessary.
              </p>
            </Q>
            <Q q="The page is stale after the radio came back.">
              <p>
                It should heal on its own within about half a minute, and refetch when you
                focus the tab. The live panels come from the bridge&apos;s WebSocket, so a
                bridge restart briefly empties them before they refill.
              </p>
            </Q>
            <Q q="Where do I look first?">
              <p>
                The bridge log, which is the only place that sees the radio:{" "}
                <code>npx pm2 logs digishack-bridge</code>. Almost every silent failure in
                this software leaves a line there.
              </p>
            </Q>
          </div>
        </Card>

        {/* The source, the version, and the licence — on the Help page and NOT in a QSL email.
            A QSL is a confirmation of a contact; anything else in it is advertising, and an
            unsolicited email that advertises is the thing people unsubscribe from. This is seen
            only by somebody already running the software, which is the audience for it. */}
        <Card title="About this software">
          <div className="flex flex-col gap-2 text-sm">
            <p>
              DigiShack <span className="tnum">{version}</span>. The source is at{" "}
              <a
                href="https://github.com/W9MDM/DigiShack"
                target="_blank"
                rel="noreferrer"
                className="text-accent-bright hover:underline"
              >
                github.com/W9MDM/DigiShack
              </a>
              , which is where to report something that behaves badly — a bridge log line is
              worth more than a description.
            </p>
            <p className="text-fg-muted">
              FT8 and FT4 decoding builds on the work of the WSJT-X project and K1JT; DXCC
              resolution uses AD1C&apos;s country file. Neither is affiliated with this software.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}

export const getServerSideProps = withPageAuth({ role: "VIEWER" });
