/**
 * How stressful a way is to ride in traffic, 0..1, from the evidence OSM carries.
 *
 * Road class alone was the whole model once, and it read a 90 km/h secondary on a signed
 * route as quiet and a trunk open to bikes as quieter than a housing estate. What every
 * mature router adds is speed: GraphHopper avoids anything signed at 71 km/h or more,
 * Valhalla penalises fast high classes by edge speed, and the Level of Traffic Stress
 * method (Mekuria/Furth) grades mixed traffic by speed and lanes first. Where a road has no
 * `maxspeed`, all of them infer one from country, class and whether it is built up; so does
 * this, from the OSM wiki's table (`legal-speeds.json`, `scripts/legal_speeds.ts`).
 *
 * The result is a class base, calmed or not, held above a *floor* that speed, lanes and
 * lorries set. A signed cycle route calms the base — someone chose it for bikes — but never
 * the floor: no sign makes a 90 km/h road quiet. A separated track takes the rider out of
 * the traffic altogether, floor included.
 *
 * Stress maps onto the lens and the hazard through `trafficLevel` and `ENGINE.traffic_from`
 * (0.55): quiet at or below it, then 0.7 and 0.9. The floors are placed on those steps.
 */
import type { OsmTags } from "./osm/pbf";
import legal from "./legal-speeds.json";

/** How stressful each road class is to ride before speed, lanes or infrastructure. */
export const STRESS_BY_HIGHWAY: Record<string, number> = {
  motorway: 1,
  motorway_link: 1,
  trunk: 1,
  trunk_link: 1,
  primary: 0.95,
  primary_link: 0.95,
  secondary: 0.8,
  secondary_link: 0.8,
  tertiary: 0.55,
  tertiary_link: 0.55,
  residential: 0.2,
  service: 0.15,
  unclassified: 0.3,
  living_street: 0.05,
  cycleway: 0.02,
};
const STRESS_DEFAULT = 0.08;

/** Roads cars drive at speed on; below these, speed is not what makes a way stressful. */
const MAIN_ROADS = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
  "secondary", "secondary_link", "tertiary", "tertiary_link",
]);
/** Roads a car can use at all, and so the ones a speed limit applies to. */
const MOTOR_ROADS = new Set([
  ...MAIN_ROADS, "unclassified", "residential", "living_street", "service", "road",
]);

/** A cycle track alongside takes the rider out of the traffic. */
const SEPARATED_CYCLEWAY = new Set(["track", "separate", "protected_lane"]);
/** Paint beside the traffic: a help at town speeds, none at 80 (LTS, GraphHopper). */
const PAINTED_CYCLEWAY = new Set(["lane", "shoulder", "share_busway"]);
const CYCLEWAY_KEYS = ["cycleway", "cycleway:left", "cycleway:right", "cycleway:both"];

/** Stress steps, as `trafficLevel` reads them. */
const SOME = 0.6;
const BUSY = 0.8;
const HARD = 0.92;

/** Anything this far into a built-up area is ridden at town speed. */
const URBAN_FROM = 0.5;
/** Where neither the tags nor the table say, the commonest European defaults. */
const FALLBACK = { urban: 50, rural: 80 } as const;

type LegalType =
  | "default" | "urban" | "rural" | "rural_multilane" | "rural_dual"
  | "motorroad" | "motorway" | "living_street";
const LEGAL = legal.countries as Record<string, Partial<Record<LegalType, number>>>;

export type StressContext = {
  /** Share of the way inside built-up land, 0..1 (`urbanFraction`). */
  urban: number;
  /** ISO 3166-1 alpha-2, where the builder knows it. */
  country?: string;
};

export type SpeedSource = "tagged" | "zone" | "legal";
export type Speed = { kmh: number; source: SpeedSource };

export type Stress = {
  /** Class base with speed and paint applied; what a signed route may calm. */
  base: number;
  /** What nothing but a separated track may take it below. */
  floor: number;
  /** Separated from the traffic: the whole value is scaled, floor and all. */
  separated: boolean;
  speed?: Speed;
};

/** `50`, `30 mph`, `walk`; `none` and `signals` say nothing about a number. */
function parseKmh(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (value === "walk") return 6;
  const match = /^(\d+(?:\.\d+)?)\s*(mph|knots)?$/.exec(value.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  return Math.round(match[2] === "mph" ? n * 1.609 : match[2] === "knots" ? n * 1.852 : n);
}

/**
 * An implicit limit, `FR:urban`, `DE:zone30`, `DE:30`, `CH:rural`: the country's own table where it
 * names a road type, the digits where it names a zone.
 */
function implicitKmh(value: string | undefined, country: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^([A-Z]{2})(?:-[A-Z0-9]+)?:(.+)$/.exec(value.trim());
  if (!match) return undefined;
  const zone = /^(?:zone:?)?(\d+)$/.exec(match[2]);
  if (zone) return Number(zone[1]);
  const table = LEGAL[match[1]] ?? (country ? LEGAL[country] : undefined);
  const type = match[2].replace(/[^a-z]/g, "_") as LegalType;
  if (type === "living_street") return table?.living_street ?? 20;
  if (type === "urban") return table?.urban ?? FALLBACK.urban;
  if (type === "rural") return table?.rural ?? table?.default ?? FALLBACK.rural;
  if (type === "motorway" || type === "motorroad") return table?.[type] ?? table?.default;
  return undefined;
}

const lanesEachWay = (tags: OsmTags): number => {
  const oneway = tags.oneway === "yes" || tags.oneway === "-1" || tags.oneway === "1";
  const lanes = Number(tags.lanes);
  const forward = Number(tags["lanes:forward"]);
  if (Number.isFinite(forward) && forward > 0) return forward;
  if (!Number.isFinite(lanes) || lanes <= 0) return 1;
  return oneway ? lanes : lanes / 2;
};

/** The speed traffic is allowed on a road, tagged or implied, and where that came from. */
export function roadSpeed(
  highway: string,
  tags: OsmTags,
  ctx: StressContext,
): Speed | undefined {
  if (!MOTOR_ROADS.has(highway)) return undefined;
  const tagged =
    parseKmh(tags.maxspeed) ??
    Math.max(parseKmh(tags["maxspeed:forward"]) ?? 0, parseKmh(tags["maxspeed:backward"]) ?? 0);
  if (tagged) return { kmh: tagged, source: "tagged" };
  const implicit =
    implicitKmh(tags.maxspeed, ctx.country) ??
    implicitKmh(tags["maxspeed:type"], ctx.country) ??
    implicitKmh(tags["source:maxspeed"], ctx.country) ??
    implicitKmh(tags["zone:maxspeed"], ctx.country) ??
    implicitKmh(tags["zone:traffic"], ctx.country);
  if (implicit !== undefined) return { kmh: implicit, source: "zone" };

  const table = ctx.country ? LEGAL[ctx.country] : undefined;
  if (highway === "living_street")
    return { kmh: table?.living_street ?? 20, source: "legal" };
  if (highway === "motorway" || highway === "motorway_link")
    return { kmh: table?.motorway ?? table?.default ?? 120, source: "legal" };
  if (tags.motorroad === "yes")
    return { kmh: table?.motorroad ?? table?.default ?? 100, source: "legal" };
  if (ctx.urban >= URBAN_FROM)
    return { kmh: table?.urban ?? FALLBACK.urban, source: "legal" };
  const rural = table?.rural ?? table?.default ?? FALLBACK.rural;
  const dual = tags.dual_carriageway === "yes" && MAIN_ROADS.has(highway);
  if (dual) return { kmh: table?.rural_dual ?? rural, source: "legal" };
  if (lanesEachWay(tags) >= 2)
    return { kmh: table?.rural_multilane ?? rural, source: "legal" };
  return { kmh: rural, source: "legal" };
}

/**
 * The floor speed sets, by class.
 *
 * A main road at rural speed is at least busy, and at 90 or more hard. A minor road's speed
 * limit is the legal default far more often than a measure of its traffic — every lane in
 * rural France is signed 80 — so it sets no floor there; estimated volume is what should
 * tell a busy unclassified road from a quiet one, not its sign. A legal default on a
 * tertiary is the same guess, so it reads "some traffic" rather than busy: the quiet
 * departmental roads riders choose are tertiaries at 80, and the router is not to be sent
 * over the hills to avoid them on a guess (`vocabulary.ts`, `traffic_from`).
 */
function speedFloor(highway: string, speed: Speed | undefined): number {
  if (!speed || !MAIN_ROADS.has(highway) || speed.kmh < 70) return 0;
  const minor = highway === "tertiary" || highway === "tertiary_link";
  if (minor) return speed.source === "legal" || speed.kmh < 90 ? SOME : BUSY;
  return speed.kmh >= 90 ? HARD : BUSY;
}

export function roadStress(highway: string, tags: OsmTags, ctx: StressContext): Stress {
  let base = STRESS_BY_HIGHWAY[highway] ?? STRESS_DEFAULT;
  const speed = roadSpeed(highway, tags, ctx);
  const cycleways = CYCLEWAY_KEYS.map((key) => tags[key] ?? "");
  const separated = cycleways.some((v) => SEPARATED_CYCLEWAY.has(v));

  // Town speeds calm a road, and paint helps only there.
  if (speed && speed.kmh <= 30) base *= 0.6;
  if (speed && speed.kmh <= 50 && cycleways.some((v) => PAINTED_CYCLEWAY.has(v))) base *= 0.8;

  let floor = speedFloor(highway, speed);
  if (MAIN_ROADS.has(highway) && lanesEachWay(tags) >= 2) floor = Math.max(floor, HARD);
  if (highway.startsWith("trunk") || highway.startsWith("motorway")) floor = Math.max(floor, HARD);
  if (tags.hgv === "designated") floor = Math.max(floor, BUSY);

  return { base, floor, separated, ...(speed ? { speed } : {}) };
}

/** A separated track leaves this share of the road's stress. */
const SEPARATION = 0.35;

/**
 * Stress as ridden in one direction: the base calmed where that direction is on a signed
 * route, held at the floor, then scaled by separation.
 */
export function riddenStress(stress: Stress, calming: number | undefined): number {
  const value = Math.max(calming === undefined ? stress.base : stress.base * calming, stress.floor);
  return stress.separated ? value * SEPARATION : value;
}
