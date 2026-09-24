/**
 * The legal default speed limits the builder assumes where a road carries no `maxspeed`.
 *
 * Valhalla, GraphHopper and OSRM all infer an untagged road's speed from its country, class
 * and whether it is built up; the maintained source for that is westnordost's
 * osm-legal-default-speeds, which parses the OSM wiki's "Default speed limits" page. Its
 * road types are a filter language over tags; the builder needs only the handful every
 * country states (urban, rural, motorway, …), so this reduces the file to those, per ISO
 * code, as plain km/h.
 *
 *   node --import tsx scripts/legal_speeds.ts [source.json]
 *
 * Writes `src/build/legal-speeds.json`, the one table a script commits into `src/`. The
 * data is CC BY-SA 2.0 (OSM wiki); the table carries its source and licence.
 */
import fs from "node:fs/promises";

const SOURCE =
  "https://raw.githubusercontent.com/westnordost/osm-legal-default-speeds/master/demo/distribution/legal_default_speeds.json";
const OUT = "src/build/legal-speeds.json";

/** Generic road types, and the names the source uses for each, most specific first. */
const TYPES: Record<string, string[]> = {
  default: [""],
  urban: ["urban"],
  rural: ["rural"],
  rural_multilane: [
    "rural road with 2 or more lanes in each direction",
    "rural single carriageway with 2 or more lanes in each direction",
  ],
  rural_dual: [
    "rural dual carriageway",
    "rural dual carriageway with 2 or more lanes in each direction",
    "dual carriageway",
  ],
  motorroad: ["motorroad", "rural motorroad"],
  motorway: ["motorway", "rural motorway"],
  living_street: ["living street"],
};

type Entry = { name?: string; tags: Record<string, string> };
type Source = {
  meta: Record<string, string>;
  speedLimitsByCountryCode: Record<string, Entry[]>;
};

/** `50`, `30 mph`, `walk`; anything else (`none`, conditional-only) is not a default. */
function kmh(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (value === "walk") return 6;
  const match = /^(\d+(?:\.\d+)?)\s*(mph)?$/.exec(value.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  return Math.round(match[2] ? n * 1.609 : n);
}

const input = process.argv[2];
const source: Source = input
  ? JSON.parse(await fs.readFile(input, "utf8"))
  : await (await fetch(SOURCE)).json();

const countries: Record<string, Record<string, number>> = {};
for (const [code, entries] of Object.entries(source.speedLimitsByCountryCode)) {
  const speeds: Record<string, number> = {};
  for (const [type, names] of Object.entries(TYPES))
    for (const name of names) {
      const entry = entries.find((e) => (e.name ?? "") === name);
      // An autobahn has no limit, only an advisory speed; that is still how fast it is.
      const speed = kmh(entry?.tags.maxspeed) ?? kmh(entry?.tags["maxspeed:advisory"]);
      if (speed !== undefined) {
        speeds[type] = speed;
        break;
      }
    }
  if (Object.keys(speeds).length) countries[code] = speeds;
}

const table = {
  source: source.meta.source,
  revision: source.meta.revisionId,
  timestamp: source.meta.timestamp,
  license: source.meta.license,
  via: "https://github.com/westnordost/osm-legal-default-speeds",
  countries,
};
await fs.writeFile(OUT, `${JSON.stringify(table, null, 0).replace(/},"/g, '},\n"')}\n`);
console.log(`${OUT}: ${Object.keys(countries).length} countries`);
