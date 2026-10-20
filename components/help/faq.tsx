import Link from "next/link";
import type { ReactNode } from "react";

// The help page's answers.
//
// Written to answer the questions this software actually generates, which are mostly not
// "where is the button". They are "why did it not call that station", "why is the
// waterfall dark", "why did nothing transmit" - questions about behaviour that is
// deliberate and invisible. A tour of the navigation would answer none of them.
//
// Ordered by how likely a question is to arrive, not by how the code is arranged. Every
// answer was checked against the code it describes; when that code changes, so must this.
// The search reads the answer text itself, so `keywords` is only for words a reader might
// type that the answer does not use.

export interface FaqItem {
  /** The anchor: /help#<id>. Keep stable — people link to these. */
  id: string;
  q: string;
  keywords?: string;
  a: ReactNode;
}

export interface FaqSection {
  id: string;
  title: string;
  items: FaqItem[];
}

const LINK = "text-accent-bright underline underline-offset-2 hover:no-underline";

function To({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={LINK}>
      {children}
    </Link>
  );
}

function List({ children }: { children: ReactNode }) {
  return <ul className="ml-5 flex list-disc flex-col gap-1">{children}</ul>;
}

export const FAQ: FaqSection[] = [
  {
    id: "finding-your-way",
    title: "Finding your way",
    items: [
      {
        id: "where-pages-went",
        q: "Where did the pages go?",
        keywords: "menu menus nav navigation moved missing find bookmark drawer hamburger",
        a: (
          <>
            <p>
              Into four menus along the top — <strong>Operate</strong> (Digital, Grid map,
              Spectrum, DX cluster, Rig control), <strong>Log</strong> (Logbook, New QSO, QSL,
              POTA), <strong>Analyze</strong> (Statistics, Awards, Coverage) and{" "}
              <strong>Tools</strong> — between Dashboard on the left and Settings and Help on the
              right. Pages kept their addresses, so bookmarks still work. When the window is
              narrow the bar shrinks, then folds into one menu button; on a phone the same menus
              open from the menu button at the top left.
            </p>
            <p>
              Rig control appears only once an admin switches on{" "}
              <em>Show the experimental Rig page</em> (Settings → Station). The configuration
              pages — Stations, Users, ADIF, DXCC data, API keys, Backup, Updates and the rest — are
              in the sidebar on the Settings page, under the setting categories.
            </p>
          </>
        ),
      },
      {
        id: "go-to-palette",
        q: "Is there a quick way to jump to a page?",
        keywords: "ctrl k cmd command palette keyboard shortcut search goto jump",
        a: (
          <p>
            Press <strong>Ctrl+K</strong> (<strong>⌘K</strong> on a Mac) on any page and type part
            of a page&apos;s name — &quot;nq&quot; finds New QSO. It lists every page your role can
            open, including ones with no menu entry such as Account, QSL cards, Users and Backup.
            Arrow keys move, Enter opens, Escape closes.
          </p>
        ),
      },
      {
        id: "new-pages",
        q: "What are the Spectrum, Tools and DX cluster pages?",
        keywords: "spectrogram 3d waterfall toolkit calculator maidenhead dx spots bandmap new",
        a: (
          <List>
            <li>
              <To href="/spectrum">Spectrum</To> — a spectrogram and a 3D waterfall, of either the
              audio passband or the radio&apos;s RF panadapter. Receive only.
            </li>
            <li>
              <To href="/tools">Tools</To> — the ham toolkit: grid squares, band privileges,
              antenna, dB and SWR calculators, and reference tables. Each tool has its own link,
              such as <code>/tools#swr</code>.
            </li>
            <li>
              <To href="/cluster">DX cluster</To> — DX cluster spots, and a band map that places
              them on the band. Clicking a spot only tunes the receiver; nothing transmits.
            </li>
          </List>
        ),
      },
      {
        id: "cluster-off",
        q: "The DX cluster page says it is off.",
        keywords: "cluster spots empty enable telnet node dxspider login",
        a: (
          <>
            <p>
              It is off on a new install, because it logs in to somebody else&apos;s server. An
              admin switches it on under Settings → System → <strong>DX cluster</strong> →{" "}
              <em>Connect to a DX cluster</em>; the radio service picks the change up within about
              15 seconds, with no restart.
            </p>
            <p>
              The default node is <code>dxc.hamserve.uk</code> on port 7300, and it logs in with
              the station callsign unless you set a login. Add an SSID (such as{" "}
              <code>-2</code>) if another logging program is already on the same node with your
              plain callsign, or the two sessions keep throwing each other off. Nothing is sent to
              the node except the login, an occasional empty line to keep the link alive, and BYE.
            </p>
          </>
        ),
      },
      {
        id: "spectrum-links",
        q: "Can I link straight to a Spectrum view?",
        keywords: "spectrum url query view source 3d split spectrogram rf audio bookmark deep link",
        a: (
          <>
            <p>
              Yes. <code>/spectrum?view=</code> takes <code>spectrogram</code>, <code>3d</code> or{" "}
              <code>split</code> (both at once), and <code>?source=</code> takes{" "}
              <code>audio</code> (the receiver&apos;s passband) or <code>rf</code> (the FlexRadio&apos;s
              panadapter). They combine:{" "}
              <code>/spectrum?view=split&amp;source=rf</code>. The RF view needs panadapter frames
              from the FlexRadio; until they arrive the page shows the audio passband.
            </p>
            <p>
              Without them the page opens the way you last left it in this browser; a link&apos;s
              choice is then remembered the same way.
            </p>
          </>
        ),
      },
      {
        id: "night-mode",
        q: "Is there a red night mode?",
        keywords: "night red dark theme dark adaptation colours colors moon",
        a: (
          <p>
            Yes — the <strong>Night</strong> button with the moon, in the header next to FT-0. It
            turns the whole interface red and amber on black, for operating in a dark shack, and
            pressing it again goes back. It is remembered per browser, so the shack PC and a phone
            can differ. The waterfall, spectrum and SSTV pictures keep their own colours.
          </p>
        ),
      },
      {
        id: "install-app",
        q: "Can I install it as an app?",
        keywords: "pwa home screen install offline",
        a: (
          <p>
            Yes. When the browser offers it, an <strong>Install DigiShack</strong> button appears at
            the foot of the page. Browsers only offer it over <strong>https</strong>, so on a plain
            http:// LAN address the button explains that instead. On an iPhone or iPad, use{" "}
            <strong>Share → Add to Home Screen</strong> in Safari.
          </p>
        ),
      },
    ],
  },
  {
    id: "transmitting",
    title: "Transmitting",
    items: [
      {
        id: "arm-transmit",
        q: "How do I turn transmit on?",
        keywords: "tx arm armed enable allow transmit switch key keying ptt header",
        a: (
          <>
            <p>
              Arm it with the <strong>TX</strong> control in the header, next to FT-0. It is off on
              a new install, and FT-0 turns it off again. While it is off nothing keys the radio —
              not the automatic modes, not a call from the decode list, not the tuner. Only an admin
              can arm it, and it asks first, showing the radio and its RF power. It cannot be armed
              while FT-0 is engaged: resume the radio first.
            </p>
            <p>
              It is the same switch as <strong>Allow transmit</strong> under Settings → Radio, and
              it belongs to one radio: arming the FlexRadio arms nothing on the Icom, which has its
              own. It is read again before every transmission, so switching it off stops the next
              one.
            </p>
          </>
        ),
      },
      {
        id: "disarm-from-header",
        q: "What happens when I disarm from the header?",
        keywords: "disarm tx armed on air stop pause auto resume header button",
        a: (
          <>
            <p>
              Clicking <strong>TX ARMED</strong> or <strong>ON AIR</strong> disarms at once, with no
              question — any operator may, because it only makes the station safer. It halts the
              contact in progress, pauses the automatic mode, and cancels a transmission that was
              still waiting for its window, so nothing goes out when that window arrives.
            </p>
            <p>
              Arming from the header again <strong>resumes the automatic mode that the disarm
              paused</strong> — the same one, and nothing else. Arming from Settings → Radio
              resumes nothing.
            </p>
          </>
        ),
      },
      {
        id: "nothing-transmits",
        q: "Nothing transmits. Why?",
        keywords: "tx wont not transmitting refused blocked blocker gate why silent",
        a: (
          <>
            <p>
              Transmit is off until you arm it, and even then several things can hold it. The
              refusal names which; these are the usual ones:
            </p>
            <List>
              <li>
                <strong>Not armed</strong> for the radio in use — the TX control in the header.
              </li>
              <li>
                <strong>FT-0 was pressed.</strong> Resuming reconnects the radio but leaves transmit
                off on purpose.
              </li>
              <li>
                <strong>A guard paused it.</strong> The reason shows beside the automatic-mode
                buttons on the Digital page, with a <strong>Re-arm</strong> button. Until you
                re-arm, a call by hand is refused too.
              </li>
              <li>
                <strong>Voice mode is on</strong> (Rig page). Digital transmit waits while the
                microphone owns the transmitter.
              </li>
              <li>
                <strong>The schedule</strong>, if you follow one: the automatic modes run only in
                your working hours, never in sleeping hours or a PA rest. The schedule line on the
                Digital page says what it is doing.
              </li>
              <li>
                <strong>No station callsign</strong>, or a placeholder — the radio service will not
                start without a real one.
              </li>
              <li>
                <strong>The radio itself refuses</strong>: transmit inhibited, DAX not selected as
                the transmit source, another program holding the transmitter. For a FlexRadio the
                Rig page lists these under <em>The radio will not transmit</em>.
              </li>
            </List>
          </>
        ),
      },
      {
        id: "stopped-on-its-own",
        q: "It stopped transmitting on its own.",
        keywords:
          "guard guards pause paused stopped halted swr temperature deaf silent limit rearm run minutes unanswered",
        a: (
          <>
            <p>
              A guard tripped. Each one exists to stop an unattended station being a nuisance or
              damaging itself. With the default limits:
            </p>
            <List>
              <li>SWR above 3:1 while transmitting.</li>
              <li>PA temperature above 75 °C.</li>
              <li>
                Four receive periods in a row that decoded nothing and carried no audio — the radio
                cannot hear, and a station that cannot hear must not transmit.
              </li>
              <li>20 transmissions in a row without you.</li>
              <li>
                15 CQs in a row that nobody answered — the band may be dead. With band hopping on,
                this is the one pause that moves to another band instead of stopping.
              </li>
              <li>A run longer than four hours, or 100 QSOs in one run.</li>
            </List>
            <p>
              The reason shows beside the automatic-mode buttons on the Digital page. Press{" "}
              <strong>Re-arm</strong> to carry on. That also starts a new run, and it is the only
              thing that resets the time and QSO limits — deliberately, because those two are what
              stop a station that keeps making contacts from transmitting indefinitely.
            </p>
            <p>
              SWR, PA temperature and a deaf receiver are faults: changing band does not fix them,
              so look at the station before re-arming. The limits are under Settings → Automation.
            </p>
          </>
        ),
      },
      {
        id: "placeholder-callsign",
        q: "Why will it not start with a placeholder callsign?",
        keywords: "n0call nocall mycall identity",
        a: (
          <p>
            Because transmitting under a callsign that is not yours is illegal, and{" "}
            <code>N0CALL</code>, <code>MYCALL</code> and friends are exactly what people type to get
            past a required field. The radio service refuses to start without a real station
            callsign, and there is no default callsign anywhere in this software. Set yours on the{" "}
            <To href="/stations">Stations</To> page.
          </p>
        ),
      },
      {
        id: "ft0",
        q: "What does FT-0 do?",
        keywords: "ft0 stop kill emergency panic resume",
        a: (
          <>
            <p>
              Stops everything: unkeys the radio, stops the automatic modes, switches transmit off
              so a restart cannot resume, then releases the radio. <strong>Resume</strong>{" "}
              reconnects but leaves transmit off — arm it again yourself when you are ready.
            </p>
            <p>
              The name is borrowed from the joke mode at ft-0.com: 0 baud, 0 Hz bandwidth, and a
              100% success rate.
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: "automatic-operating",
    title: "Automatic operating",
    items: [
      {
        id: "skipped-station",
        q: "Why did it skip a station I wanted to work?",
        keywords: "skip skipped ignored didnt call dupe duplicate snr cooldown hunt",
        a: (
          <>
            <p>The bridge log line says which of these it was:</p>
            <List>
              <li>
                Already worked on this band and mode today, or inside the dupe window (24 hours by
                default).
              </li>
              <li>On the do-not-call list.</li>
              <li>
                A band you already have them on, if <em>Never re-work a station on a band already
                worked</em> is on.
              </li>
              <li>
                Weaker than the Hunt minimum SNR (−22 dB by default), or nothing new while{" "}
                <em>Hunt only new ones</em> is on.
              </li>
              <li>
                Cooling down after an attempt that went nowhere — 30 minutes by default. Skip starts
                the same cooldown.
              </li>
              <li>In the middle of a contact with somebody else.</li>
            </List>
            <p>
              The do-not-call list and the band rule only restrict the automatic modes. The dupe
              window and the cooldown apply to a call by hand as well.
            </p>
          </>
        ),
      },
      {
        id: "dupe-window",
        q: "Dupe window or duplicate rules — what is the difference?",
        keywords: "dupe duplicate once per day utc",
        a: (
          <>
            <p>
              The <strong>dupe window</strong> asks whether you worked them <em>recently</em> on
              this band and mode — at most once per UTC day, and never sooner than the window — and
              exists to stop one contact repeating inside a session. The <strong>duplicate</strong>{" "}
              rules ask whether you have <em>ever</em> worked them, which is a different question
              and the one an operator who asks you to stop is asking about.
            </p>
            <p>
              Duplicates are prevented per callsign, from the do-not-call list. The station-wide
              switch, <em>Never make a duplicate contact, with EVERYONE</em>, exists but is off:
              one operator&apos;s preference is not a policy for everybody you work.
            </p>
          </>
        ),
      },
      {
        id: "do-not-call",
        q: "Somebody asked me not to contact them again.",
        keywords: "do not call dnc block list never request complaint",
        a: (
          <>
            <p>
              Add them under Settings → Automation → <strong>Do not call</strong>. Two kinds:{" "}
              <strong>No duplicates</strong> still lets the automatic modes work them on a band and
              mode not already in your log, and <strong>Never call</strong> stops the automatic
              modes calling them at all. Pick the one they actually asked for — most people asking
              about duplicates are happy to be worked on a new band.
            </p>
            <p>Neither affects calling them by hand. It records a request; it does not lock the radio.</p>
          </>
        ),
      },
    ],
  },
  {
    id: "decoding-and-displays",
    title: "Decoding and the displays",
    items: [
      {
        id: "no-decodes",
        q: "No decodes.",
        keywords: "nothing decoding clock time dt sync ntp audio dax digu quiet",
        a: (
          <>
            <p>
              <strong>Check the clock first.</strong> A clock more than a second or so out produces
              a screen of nothing that looks exactly like a dead band. The Digital page warns when
              yours looks wrong — judged from other stations&apos; timing once there are enough
              decodes, and from a time server even on a quiet band. <strong>Sync now</strong>{" "}
              measures it again; DigiShack corrects for the difference itself rather than changing
              the computer&apos;s clock.
            </p>
            <p>
              Then check that audio is arriving. <em>Waiting for receiver audio…</em> on the Digital
              page&apos;s waterfall means nothing is reaching it from the bridge. For a FlexRadio:
              the slice in DIGU on a digital frequency, DAX enabled, and no other program holding
              the DAX channel.
            </p>
            <p>
              If the receiver goes quiet, the bridge restarts itself — after 90 seconds without
              audio from a FlexRadio, or about two minutes on FT8 without a decode window from
              either radio — and emails you each time if <em>Email me when something goes wrong</em>{" "}
              is on in Settings.
            </p>
          </>
        ),
      },
      {
        id: "waterfall-dark",
        q: "The waterfall is dark, or not moving.",
        keywords: "black blank empty frozen stuck spectrum gain brightness proxy nginx websocket",
        a: (
          <>
            <p>
              <strong>Mostly dark blue is normal.</strong> The colour scale keeps noise dark so
              real signals stand out in green, yellow and red. The <strong>Gain</strong> slider
              under the Digital page&apos;s waterfall brightens it.
            </p>
            <p>
              <strong>Nothing at all</strong>, with <em>Waiting for receiver audio…</em> on it,
              means no spectrum is reaching the page: the bridge is not running (the page says so),
              the radio is not connected, or — behind a reverse proxy — <code>/ws/decodes</code>{" "}
              and <code>/ws/audio</code> are not routed to the bridge. The shipped{" "}
              <code>deploy/nginx/digishack.conf</code> has both. The live feed also needs you to be
              signed in: a proxy that drops the <code>Host</code> header or serves the socket from
              another host gets it refused.
            </p>
            <p>
              <strong>Still scrolling but blank</strong>, with <em>No new spectrum — check receiver
              audio</em>, means reception stopped. The waterfall keeps moving through an outage on
              purpose, so the gap is visible instead of a frozen picture that looks live.
            </p>
          </>
        ),
      },
      {
        id: "several-waterfalls",
        q: "Why are there several waterfalls, and why do they look different?",
        keywords: "panadapter spectrum rf audio passband two",
        a: (
          <p>
            They show different things. The Digital page&apos;s waterfall is the{" "}
            <strong>audio passband</strong> — the few kHz of audio the receiver is demodulating,
            where decode offsets are marked. The Rig page&apos;s panadapter is <strong>RF</strong>:
            tens of kHz of the band with every station on it. The <To href="/spectrum">Spectrum</To>{" "}
            page draws either of those as a spectrogram or a 3D waterfall. No setting makes the
            audio and RF views match.
          </p>
        ),
      },
      {
        id: "panadapter-db",
        q: "Can I trust the dB numbers on the panadapter?",
        keywords: "dbm calibrated s-meter signal strength accurate",
        a: (
          <p>
            No — treat them as relative. The panadapter&apos;s dBm window is not calibrated, and the
            Rig page says so. Signal reports from the decoder are real; the panadapter&apos;s
            vertical scale is for comparing signals with each other.
          </p>
        ),
      },
    ],
  },
  {
    id: "your-account",
    title: "Your account",
    items: [
      {
        id: "change-password",
        q: "How do I change my password?",
        keywords: "password change account",
        a: (
          <p>
            On the <To href="/account">Account</To> page. You need your current password. Changing
            it signs out every other device; the one you are using stays signed in.
          </p>
        ),
      },
      {
        id: "forgot-password",
        q: "I forgot my password.",
        keywords: "reset locked out lockout email smtp admin",
        a: (
          <>
            <p>
              Use <strong>Forgot password?</strong> on the sign-in page. The emailed link works once
              and expires after 30 minutes. It needs outgoing email (SMTP, under Settings → QSL &amp;
              email → Outgoing email) to be set up.
            </p>
            <p>
              Without email, an admin can set a new password from the Users page. If nobody can
              sign in at all, run <code>npm run reset-password -- you@example.com</code> on the
              server; it prints a new password.
            </p>
          </>
        ),
      },
      {
        id: "roles",
        q: "What can each role do?",
        keywords: "viewer operator admin permission access",
        a: (
          <>
            <List>
              <li>
                <strong>Viewer</strong> — read-only: can look, cannot change anything.
              </li>
              <li>
                <strong>Operator</strong> — logs contacts and operates the radio.
              </li>
              <li>
                <strong>Admin</strong> — everything, including Settings and user accounts.
              </li>
            </List>
            <p>
              Yours is on the <To href="/account">Account</To> page. An admin changes roles on the
              Users page.
            </p>
          </>
        ),
      },
    ],
  },
  {
    id: "qsl-and-uploads",
    title: "QSL and uploads",
    items: [
      {
        id: "qsl-email-not-sent",
        q: "Why did a QSL email not send?",
        keywords: "eqsl qrz address opt out optout daily limit",
        a: (
          <p>
            Most often there is no published address at QRZ, which is an ordinary outcome. Others:
            the recipient has opted out; their QRZ QSL route carries <code>NOQSOCC</code> or{" "}
            <code>NOEQSL</code>; the daily ceiling is reached; or no <strong>Public base URL</strong>{" "}
            is set (Settings → Station) — without one there is no unsubscribe link to include, and
            DigiShack will not send unsolicited mail with no way out.
          </p>
        ),
      },
      {
        id: "unsubscribe",
        q: "Somebody replied asking to be unsubscribed.",
        keywords: "unsubscribe opt out complaint email",
        a: (
          <p>
            Every message carries a one-click link and the headers that make a mail client show its
            own Unsubscribe button, so this should be rare. If it happens, the queue records who was
            mailed and when, and adding them to the opt-out list also cancels anything already
            queued for them.
          </p>
        ),
      },
    ],
  },
  {
    id: "when-something-is-wrong",
    title: "When something is plainly wrong",
    items: [
      {
        id: "empty-panel",
        q: "A panel is empty and I do not know if that is real.",
        keywords: "blank empty loading error broken",
        a: (
          <p>
            Empty and broken look different on purpose. A panel that could not load says so and
            retries by itself; a panel that loaded and found nothing says that instead. If you see
            neither, reload — and if a reload fixes it, that is worth reporting, because it should
            not have been necessary.
          </p>
        ),
      },
      {
        id: "stale-page",
        q: "The page is stale after the radio came back.",
        keywords: "stale old refresh reload reconnect reconnecting outage",
        a: (
          <p>
            It should heal on its own within about half a minute, and refetch when you come back to
            the tab. The live panels come from the bridge&apos;s WebSocket, so a bridge restart
            briefly empties them before they refill.
          </p>
        ),
      },
      {
        id: "bridge-log",
        q: "Where do I look first?",
        keywords: "log logs pm2 debug troubleshoot error",
        a: (
          <p>
            The bridge log, which is the only place that sees the radio:{" "}
            <code>pm2 logs digishack-bridge</code> on the server, or the files under{" "}
            <code>logs/</code> in the install directory. Almost every silent failure in this
            software leaves a line there.
          </p>
        ),
      },
    ],
  },
];
