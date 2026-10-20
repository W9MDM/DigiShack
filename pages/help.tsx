import { useRouter } from "next/router";

import { HelpBrowser } from "@/components/help/HelpBrowser";
import { Card, PageHeader } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";

import { version } from "@/package.json";

// The answers themselves live in components/help/faq.tsx.

export default function HelpPage() {
  const router = useRouter();
  // `/help?q=transmit` opens with that search, so another page can link to its answer set.
  const initialQuery = typeof router.query.q === "string" ? router.query.q : "";

  return (
    <>
      <PageHeader
        title="Help"
        subtitle="Why things behave the way they do, and what to check when they do not"
      />
      <HelpBrowser initialQuery={initialQuery} footer={<About />} />
    </>
  );
}

/* The source, the version, and the licence — on the Help page and NOT in a QSL email.
   A QSL is a confirmation of a contact; anything else in it is advertising, and an
   unsolicited email that advertises is the thing people unsubscribe from. This is seen
   only by somebody already running the software, which is the audience for it. */
function About() {
  return (
    <Card title="About this software">
      <div className="flex flex-col gap-2 text-sm">
        <p>
          DigiShack <span className="tnum">{version}</span>. The source is at{" "}
          <a
            href="https://github.com/W9MDM/DigiShack"
            target="_blank"
            rel="noreferrer"
            className="text-accent-bright underline underline-offset-2 hover:no-underline"
          >
            github.com/W9MDM/DigiShack
          </a>
          , which is where to report something that behaves badly — a bridge log line is worth
          more than a description.
        </p>
        <p className="text-fg-muted">
          FT8 and FT4 decoding builds on the work of the WSJT-X project and K1JT; DXCC resolution
          uses AD1C&apos;s country file. Neither is affiliated with this software.
        </p>
      </div>
    </Card>
  );
}

export const getServerSideProps = withPageAuth({ role: "VIEWER" });
