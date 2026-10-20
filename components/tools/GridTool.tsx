import { useId, useState } from "react";

import { Button, Field, Input } from "@/components/ui/primitives";
import { Problem, Readout, Readouts, Segmented, SubHead, ToolSection } from "@/components/tools/shared";
import { useDistanceUnit } from "@/lib/client/use-distance-unit";
import {
  antipode,
  compassPoint,
  formatDms,
  formatLat,
  formatLon,
  greatCircle,
  kmToMiles,
  latLonToGrid,
  parseGrid,
  parseLatitude,
  parseLongitude,
  squareSizeKm,
} from "@/lib/ham/tools/grid";
import { fmt } from "@/lib/ham/tools/number";

/** Distance in the preferred unit, with the other one beneath it. */
function distance(km: number, unit: "km" | "mi"): { value: string; sub: string } {
  const kmText = `${fmt(km, 0)} km`;
  const miText = `${fmt(kmToMiles(km), 0)} mi`;
  return unit === "km" ? { value: kmText, sub: miText } : { value: miText, sub: kmText };
}

function heading(deg: number | null): string {
  return deg === null ? "—" : `${fmt(deg, 1)}° ${compassPoint(deg)}`;
}

export function GridTool({ myGrid }: { myGrid: string | null }) {
  const [unit, setUnit] = useDistanceUnit();
  const mine = myGrid ? parseGrid(myGrid) : null;
  const myCentre = mine?.ok ? mine.value.centre : null;

  const [gridText, setGridText] = useState(mine?.ok ? mine.value.grid : "");
  const [latText, setLatText] = useState(myCentre ? myCentre.lat.toFixed(4) : "");
  const [lonText, setLonText] = useState(myCentre ? myCentre.lon.toFixed(4) : "");
  const [fromText, setFromText] = useState(mine?.ok ? mine.value.grid : "");
  const [toText, setToText] = useState("");
  const ids = useId();

  const grid = parseGrid(gridText);
  const lat = parseLatitude(latText);
  const lon = parseLongitude(lonText);
  const from = parseGrid(fromText);
  const to = parseGrid(toText);
  const path = from.ok && to.ok ? greatCircle(from.value.centre, to.value.centre) : null;

  return (
    <ToolSection
      id="grid"
      title="Grid locator"
      actions={
        <Segmented
          label="Distance units"
          options={[
            { value: "mi", label: "mi" },
            { value: "km", label: "km" },
          ]}
          value={unit}
          onChange={setUnit}
        />
      }
    >
      <div className="flex flex-col gap-5">
        <section>
          <SubHead>Locator to position</SubHead>
          <Field
            label="Locator"
            htmlFor={`${ids}-grid`}
            errors={gridText.trim() && !grid.ok ? [grid.error] : undefined}
            hint="4, 6 or 8 characters: EN61, EN61aa, EN61aa45"
          >
            <Input
              id={`${ids}-grid`}
              value={gridText}
              onChange={(e) => setGridText(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono uppercase"
              placeholder={myGrid ?? "EN61aa"}
            />
          </Field>
          {grid.ok ? (
            (() => {
              const sq = grid.value;
              const size = squareSizeKm(sq);
              const anti = antipode(sq.centre);
              return (
                <Readouts className="mt-2">
                  <Readout
                    label="Centre"
                    value={`${formatLat(sq.centre.lat)}, ${formatLon(sq.centre.lon)}`}
                    sub={`${formatDms(sq.centre.lat, "lat")}, ${formatDms(sq.centre.lon, "lon")}`}
                  />
                  <Readout
                    label="Square"
                    value={`${fmt(sq.south, 4)}° to ${fmt(sq.north, 4)}° lat`}
                    sub={`${fmt(sq.west, 4)}° to ${fmt(sq.east, 4)}° lon`}
                  />
                  <Readout
                    label="Size"
                    value={
                      unit === "km"
                        ? `≈ ${fmt(size.widthKm, size.widthKm < 10 ? 2 : 0)} × ${fmt(size.heightKm, size.heightKm < 10 ? 2 : 0)} km`
                        : `≈ ${fmt(kmToMiles(size.widthKm), size.widthKm < 10 ? 2 : 0)} × ${fmt(kmToMiles(size.heightKm), size.heightKm < 10 ? 2 : 0)} mi`
                    }
                  />
                  <Readout
                    label="Antipode"
                    value={latLonToGrid(anti, 6)}
                    sub={`${formatLat(anti.lat)}, ${formatLon(anti.lon)}`}
                  />
                </Readouts>
              );
            })()
          ) : !gridText.trim() ? (
            <Problem>Type a locator to see where it is.</Problem>
          ) : null}
        </section>

        <section>
          <SubHead>Position to locator</SubHead>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field
              label="Latitude"
              htmlFor={`${ids}-lat`}
              errors={latText.trim() && !lat.ok ? [lat.error] : undefined}
            >
              <Input
                id={`${ids}-lat`}
                value={latText}
                onChange={(e) => setLatText(e.target.value)}
                inputMode="text"
                autoComplete="off"
                placeholder="41.7148 or 41.7148 N"
                className="tnum"
              />
            </Field>
            <Field
              label="Longitude"
              htmlFor={`${ids}-lon`}
              errors={lonText.trim() && !lon.ok ? [lon.error] : undefined}
            >
              <Input
                id={`${ids}-lon`}
                value={lonText}
                onChange={(e) => setLonText(e.target.value)}
                inputMode="text"
                autoComplete="off"
                placeholder="-72.7273 or 72.7273 W"
                className="tnum"
              />
            </Field>
          </div>
          {lat.ok && lon.ok ? (
            <Readouts className="mt-2">
              <Readout label="4 characters" value={<span className="font-mono">{latLonToGrid({ lat: lat.value, lon: lon.value }, 4)}</span>} />
              <Readout label="6 characters" value={<span className="font-mono">{latLonToGrid({ lat: lat.value, lon: lon.value }, 6)}</span>} />
              <Readout label="8 characters" value={<span className="font-mono">{latLonToGrid({ lat: lat.value, lon: lon.value }, 8)}</span>} />
            </Readouts>
          ) : !latText.trim() || !lonText.trim() ? (
            <Problem>Decimal degrees; south and west are negative, or write S or W.</Problem>
          ) : null}
        </section>

        <section>
          <SubHead>Distance and beam heading</SubHead>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-3 items-end">
            <Field
              label="From"
              htmlFor={`${ids}-from`}
              errors={fromText.trim() && !from.ok ? [from.error] : undefined}
            >
              <Input
                id={`${ids}-from`}
                value={fromText}
                onChange={(e) => setFromText(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono uppercase"
                placeholder={myGrid ?? "EN61aa"}
              />
            </Field>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Swap from and to"
              onClick={() => {
                setFromText(toText);
                setToText(fromText);
              }}
              className="justify-self-start sm:mb-1"
            >
              ⇄ Swap
            </Button>
            <Field
              label="To"
              htmlFor={`${ids}-to`}
              errors={toText.trim() && !to.ok ? [to.error] : undefined}
            >
              <Input
                id={`${ids}-to`}
                value={toText}
                onChange={(e) => setToText(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono uppercase"
                placeholder="IO91wm"
              />
            </Field>
          </div>
          {!myGrid && (
            <p className="mt-1 text-xs text-fg-subtle">No station grid is set, so From starts empty.</p>
          )}
          {path ? (
            <Readouts className="mt-2">
              <Readout label="Short path" {...distance(path.km, unit)} />
              <Readout label="Beam heading" value={heading(path.bearing)} sub="degrees true, from the first locator" />
              <Readout label="Long path" {...distance(path.longKm, unit)} />
              <Readout label="Long-path heading" value={heading(path.longBearing)} />
              {path.km === 0 && <Problem>Both locators are the same square: there is no heading.</Problem>}
              {path.antipodal && <Problem>These are antipodes: every heading is a great circle to the other.</Problem>}
            </Readouts>
          ) : (
            (!fromText.trim() || !toText.trim()) && (
              <Problem>Enter both locators. Distances are between square centres.</Problem>
            )
          )}
        </section>
      </div>
    </ToolSection>
  );
}
