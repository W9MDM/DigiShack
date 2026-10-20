import type { GetServerSidePropsContext } from "next";

import { AntennaTool } from "@/components/tools/AntennaTool";
import { FeedlineTool } from "@/components/tools/FeedlineTool";
import { GridTool } from "@/components/tools/GridTool";
import { PowerTool } from "@/components/tools/PowerTool";
import { PrivilegesTool, type LicenceDefault } from "@/components/tools/PrivilegesTool";
import { ReferenceTool } from "@/components/tools/ReferenceTool";
import { SwrTool } from "@/components/tools/SwrTool";
import { TimeTool } from "@/components/tools/TimeTool";
import { WavelengthTool } from "@/components/tools/WavelengthTool";
import { PageHeader } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { classFromSetting } from "@/lib/ham/tools/privileges";
import { getSetting } from "@/lib/settings";

// The ham toolkit: calculators and references, all computed in the browser and none of it
// needing the radio, the bridge or the internet. The station's grid and licence class are
// read once, server-side, as defaults; every tool also works with whatever is typed.

interface Props extends Record<string, unknown> {
  myGrid: string | null;
  licence: LicenceDefault;
}

/** In page order. The ids are the deep links: /tools#privileges. */
const INDEX: readonly { id: string; label: string }[] = [
  { id: "grid", label: "Grid locator" },
  { id: "time", label: "Time" },
  { id: "privileges", label: "Where can I operate?" },
  { id: "antenna", label: "Antennas" },
  { id: "feedline", label: "Feedline" },
  { id: "power", label: "Power and dB" },
  { id: "swr", label: "SWR" },
  { id: "wavelength", label: "Wavelength" },
  { id: "reference", label: "References" },
];

export default function ToolsPage({ myGrid, licence }: Props) {
  return (
    <>
      <PageHeader title="Tools" subtitle="Calculators and references for the shack. Everything here works offline." />
      <nav aria-label="Tools on this page" className="mb-4 flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
        {INDEX.map((t) => (
          <a
            key={t.id}
            href={`#${t.id}`}
            className="text-fg-muted hover:text-accent-bright underline-offset-2 hover:underline"
          >
            {t.label}
          </a>
        ))}
      </nav>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <GridTool myGrid={myGrid} />
        <TimeTool />
        <PrivilegesTool licence={licence} />
        <AntennaTool />
        <FeedlineTool />
        <PowerTool />
        <SwrTool />
        <WavelengthTool />
        <ReferenceTool />
      </div>
    </>
  );
}

export const getServerSideProps = withPageAuth<Props>({
  role: "VIEWER",
  inner: async (_ctx: GetServerSidePropsContext) => {
    // Defaults only: a failure to read either leaves the tool blank, never the page.
    let myGrid: string | null = null;
    let licence: LicenceDefault = { cls: null, status: "unset" };
    try {
      const station = await prisma.station.findFirst({
        orderBy: { createdAt: "asc" },
        select: { grid: true },
      });
      myGrid = station?.grid?.trim() || null;
    } catch {
      /* no station */
    }
    try {
      licence = classFromSetting(await getSetting("station.licenceClass"));
    } catch {
      /* unset */
    }
    return { props: { myGrid, licence } };
  },
});
