/**
 * Traffic ground truth: what the rider said about a road, against what the graph says.
 *
 *   node --import tsx scripts/traffic_truth.ts draft <gpx…> [--cells <dir>] [--out <json>]
 *   node --import tsx scripts/traffic_truth.ts eval [--truth <json>] [--cells <dir>]
 *
 * `draft` reads ridden GPX tracks whose waypoints are the rider's notes, placed just
 * before the stretch they describe. Each note gets the track from its waypoint to the next
 * one (at most MAX_SPAN_M), simplified, and the graph's reading of it: the ways it rides
 * and their stress. It writes `.cache/traffic-truth-draft.json` to be labelled by hand
 * with an LTS level (1 quiet … 4 hostile) and saved as `tests/fixtures/traffic-truth.json`.
 *
 * `eval` re-matches every labelled stretch against the cells and reports how well the
 * graph's stress ranks them (Spearman), and every pair it gets the wrong way round. A
 * traffic model change has to beat the baseline this prints.
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CELLS, openLocalProvider } from "./local_cells";
import { searchArea, type CellGraphProvider } from "../src/routing/provider";
import { distance } from "../src/geo/distance";
import { project } from "../src/geo/project";
import {
  TRAFFIC_WHY_TAG,
  type Edge,
  type Graph,
  type Point,
} from "../src/routing/types";

/** A note speaks for the stretch after it, but not for ever. */
const MAX_SPAN_M = 3000;
/** How far a track point may sit from a way and still be on it: GPS and drawn geometry. */
const MATCH_M = 25;
/** Track sampling for matching. */
const STEP_M = 20;
/** Simplification tolerance for the stored line, which keeps the fixture small. */
const SIMPLIFY_M = 8;

export type TruthEntry = {
  id: string;
  note: string;
  /** 1 quiet, 2 some traffic, 3 busy, 4 hostile; absent while unlabelled. */
  lts?: number;
  /** Why the label, where the note alone does not say. */
  comment?: string;
} & (
  | { line: Point[] }
  /** A road judged as a whole rather than ridden: its OSM ways, both directions, near `at`. */
  | { ways: string[]; at: Point }
);

type Match = {
  /** Metres of the line matched to a way. */
  matched: number;
  length: number;
  /** Length-weighted mean and maximum stress over the matched part. */
  stress: number;
  maxStress: number;
  ways: {
    way: string;
    name: string;
    highway: string;
    stress: number;
    m: number;
    why?: string;
  }[];
};

function args(argv: string[]) {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else rest.push(argv[i]);
  }
  return { flags, rest };
}

function parseGpx(xml: string) {
  const attr = (tag: string, name: string) =>
    Number(new RegExp(`${name}="([^"]+)"`).exec(tag)![1]);
  const decode = (s: string) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const waypoints = [...xml.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/g)].map(
    (m) => ({
      p: [attr(m[1], "lon"), attr(m[1], "lat")] as Point,
      name: decode(/<name>([\s\S]*?)<\/name>/.exec(m[2])?.[1]?.trim() ?? ""),
    }),
  );
  const track = [...xml.matchAll(/<trkpt\b([^>]*?)\/?>/g)].map(
    (m) => [attr(m[1], "lon"), attr(m[1], "lat")] as Point,
  );
  return { waypoints, track };
}

function simplify(line: Point[], tolerance: number): Point[] {
  if (line.length < 3) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1,
      at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = project(line[i], line[a], line[b]).distance;
      if (d > worst) [worst, at] = [d, i];
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

const round = (p: Point): Point => [+p[0].toFixed(5), +p[1].toFixed(5)];

/** Points every `step` metres along a line, each with the heading it is ridden in. */
function samples(line: Point[], step: number) {
  const out: { p: Point; dx: number; dy: number }[] = [];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const d = distance(a, b);
    if (d === 0) continue;
    const cos = Math.cos((a[1] * Math.PI) / 180);
    const dx = ((b[0] - a[0]) * cos) / d,
      dy = (b[1] - a[1]) / d;
    for (let s = carry; s < d; s += step) {
      const t = s / d;
      out.push({
        p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
        dx,
        dy,
      });
    }
    carry = (carry - d) % step;
    if (carry < 0) carry += step;
  }
  return out;
}

/** Edge spans bucketed on a small grid, so matching a sample is a local lookup. */
class EdgeIndex {
  private cells = new Map<string, { edge: Edge; i: number }[]>();
  private static readonly SIZE = 0.002;
  constructor(graph: Graph) {
    for (const edge of graph.edges)
      for (let i = 1; i < edge.geometry.length; i++) {
        const [a, b] = [edge.geometry[i - 1], edge.geometry[i]];
        const x0 = Math.floor(Math.min(a[0], b[0]) / EdgeIndex.SIZE),
          x1 = Math.floor(Math.max(a[0], b[0]) / EdgeIndex.SIZE),
          y0 = Math.floor(Math.min(a[1], b[1]) / EdgeIndex.SIZE),
          y1 = Math.floor(Math.max(a[1], b[1]) / EdgeIndex.SIZE);
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) {
            const key = `${x}:${y}`;
            let list = this.cells.get(key);
            if (!list) this.cells.set(key, (list = []));
            list.push({ edge, i });
          }
      }
  }
  /** The edge ridden at `p` in the given heading: nearest, then the one pointing that way. */
  match(p: Point, dx: number, dy: number): Edge | undefined {
    const cx = Math.floor(p[0] / EdgeIndex.SIZE),
      cy = Math.floor(p[1] / EdgeIndex.SIZE);
    let best: { edge: Edge; score: number } | undefined;
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let y = cy - 1; y <= cy + 1; y++)
        for (const { edge, i } of this.cells.get(`${x}:${y}`) ?? []) {
          const [a, b] = [edge.geometry[i - 1], edge.geometry[i]];
          const hit = project(p, a, b);
          if (hit.distance > MATCH_M) continue;
          const d = distance(a, b) || 1;
          const cos = Math.cos((a[1] * Math.PI) / 180);
          const along =
            (((b[0] - a[0]) * cos) / d) * dx + ((b[1] - a[1]) / d) * dy;
          // A reverse edge lies on the same line: the heading is what tells them apart,
          // and a crossing way at right angles should lose to the one being ridden.
          const score = hit.distance + (1 - along) * MATCH_M;
          if (!best || score < best.score) best = { edge, score };
        }
    return best?.edge;
  }
}

async function graphFor(provider: CellGraphProvider, line: Point[]) {
  return provider.load(searchArea([line[0], line.at(-1)!], 2));
}

async function matchLine(
  provider: CellGraphProvider,
  line: Point[],
): Promise<Match> {
  const index = new EdgeIndex(await graphFor(provider, line));
  const byWay = new Map<string, Match["ways"][number]>();
  let matched = 0,
    weighted = 0,
    maxStress = 0;
  const all = samples(line, STEP_M);
  for (const s of all) {
    const edge = index.match(s.p, s.dx, s.dy);
    if (!edge) continue;
    matched += STEP_M;
    weighted += edge.stress * STEP_M;
    maxStress = Math.max(maxStress, edge.stress);
    const key = `${edge.way}:${edge.stress}`;
    const entry = byWay.get(key) ?? {
      way: edge.way,
      name: edge.name,
      highway: edge.highway,
      stress: edge.stress,
      m: 0,
      ...(edge.tags?.[TRAFFIC_WHY_TAG]
        ? { why: edge.tags[TRAFFIC_WHY_TAG] }
        : {}),
    };
    entry.m += STEP_M;
    byWay.set(key, entry);
  }
  return {
    matched,
    length: all.length * STEP_M,
    stress: matched ? weighted / matched : 0,
    maxStress,
    ways: [...byWay.values()].sort((a, b) => b.m - a.m),
  };
}

/** A whole road, both directions: the length-weighted stress of its ways' edges. */
async function matchWays(
  provider: CellGraphProvider,
  ways: string[],
  at: Point,
): Promise<Match> {
  const graph = await provider.load(searchArea([at], 6));
  const wanted = new Set(ways);
  const byWay = new Map<string, Match["ways"][number]>();
  let length = 0,
    weighted = 0,
    maxStress = 0;
  for (const edge of graph.edges) {
    if (!wanted.has(edge.way)) continue;
    length += edge.length;
    weighted += edge.stress * edge.length;
    maxStress = Math.max(maxStress, edge.stress);
    const key = `${edge.way}:${edge.stress}`;
    const entry = byWay.get(key) ?? {
      way: edge.way,
      name: edge.name,
      highway: edge.highway,
      stress: edge.stress,
      m: 0,
      ...(edge.tags?.[TRAFFIC_WHY_TAG]
        ? { why: edge.tags[TRAFFIC_WHY_TAG] }
        : {}),
    };
    entry.m += edge.length;
    byWay.set(key, entry);
  }
  return {
    matched: length,
    length,
    stress: length ? weighted / length : 0,
    maxStress,
    ways: [...byWay.values()].sort((a, b) => b.m - a.m),
  };
}

async function draft(files: string[], cells: string, out: string) {
  const provider = await openLocalProvider(cells);
  const entries: (TruthEntry & { line: Point[]; match: Match })[] = [];
  for (const file of files) {
    const day = path.basename(file, ".gpx");
    const { waypoints, track } = parseGpx(fs.readFileSync(file, "utf8"));
    // Where along the track each note sits; notes are not always in riding order.
    const placed = waypoints
      .map((w) => {
        let at = 0,
          best = Infinity;
        track.forEach((p, i) => {
          const d = distance(p, w.p);
          if (d < best) [best, at] = [d, i];
        });
        return { ...w, at, off: best };
      })
      .filter((w) => w.off < 300)
      .sort((a, b) => a.at - b.at);
    for (const [k, w] of placed.entries()) {
      const end = placed[k + 1]?.at ?? track.length - 1;
      const line: Point[] = [track[w.at]];
      let run = 0;
      for (let i = w.at + 1; i <= end && run < MAX_SPAN_M; i++) {
        run += distance(track[i - 1], track[i]);
        line.push(track[i]);
      }
      if (line.length < 2) continue;
      const stored = simplify(line, SIMPLIFY_M).map(round);
      entries.push({
        id: `${day}#${k + 1}`,
        note: w.name,
        line: stored,
        match: await matchLine(provider, stored),
      });
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(entries, null, 1));
  for (const e of entries)
    console.log(
      `${e.id.padEnd(24)} ${(e.match.length / 1000).toFixed(1).padStart(4)} km  stress ${e.match.stress.toFixed(2)}  ${e.match.ways
        .slice(0, 2)
        .map((w) => `${w.highway}:${w.name || w.way}`)
        .join(", ")
        .slice(0, 60)
        .padEnd(60)}  ${e.note.slice(0, 60)}`,
    );
  console.log(`\n${entries.length} stretches → ${out}`);
}

/** Spearman's rank correlation, with ties given their mean rank. */
export function spearman(x: number[], y: number[]): number {
  const rank = (v: number[]) => {
    const order = v
      .map((value, i) => ({ value, i }))
      .sort((a, b) => a.value - b.value);
    const r = new Array<number>(v.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
      for (let k = i; k <= j; k++) r[order[k].i] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const [rx, ry] = [rank(x), rank(y)];
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const [mx, my] = [mean(rx), mean(ry)];
  let num = 0,
    sx = 0,
    sy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    sx += (rx[i] - mx) ** 2;
    sy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(sx * sy || 1);
}

/**
 * A stretch's motor traffic from a flow estimate (`src/build/flow.ts`): the length-weighted
 * mean of log10(1 + trips) over its ways, a way the estimate does not know counting as
 * none. Undefined where it knows none of them, which means the stretch is outside it.
 */
function flowScore(m: Match, flow: Map<string, number>): number | undefined {
  let known = false,
    sum = 0,
    length = 0;
  for (const w of m.ways) {
    const trips = flow.get(w.way);
    if (trips !== undefined) known = true;
    sum += w.m * Math.log10(1 + (trips ?? 0));
    length += w.m;
  }
  return known && length ? sum / length : undefined;
}

/** Spearman and the pairs two or more levels apart that a score ranks the wrong way. */
function rankAgainst(rows: { id: string; lts: number; score: number }[]) {
  const rho = spearman(
    rows.map((r) => r.lts),
    rows.map((r) => r.score),
  );
  const inversions: string[] = [];
  for (const a of rows)
    for (const b of rows)
      if (b.lts - a.lts >= 2 && a.score >= b.score)
        inversions.push(
          `${a.id} (LTS ${a.lts}, ${a.score.toFixed(2)}) ≥ ${b.id} (LTS ${b.lts}, ${b.score.toFixed(2)})`,
        );
  return { rho, inversions };
}

async function evaluate(truthFile: string, cells: string, flowFile?: string) {
  const flow = flowFile
    ? new Map(Object.entries(JSON.parse(fs.readFileSync(flowFile, "utf8")) as Record<string, number>))
    : undefined;
  const provider = await openLocalProvider(cells);
  const truth = (
    JSON.parse(fs.readFileSync(truthFile, "utf8")) as TruthEntry[]
  ).filter((e) => e.lts !== undefined);
  const rows: { e: TruthEntry; m: Match }[] = [];
  for (const e of truth) {
    const m =
      "line" in e
        ? await matchLine(provider, e.line)
        : await matchWays(provider, e.ways, e.at);
    if (!m.length || m.matched < 0.5 * m.length) {
      console.log(
        `skip ${e.id}: only ${Math.round(m.matched)} of ${Math.round(m.length)} m matched`,
      );
      continue;
    }
    if (flow && flowScore(m, flow) === undefined) continue;
    rows.push({ e, m });
  }
  rows.sort((a, b) => a.e.lts! - b.e.lts! || a.m.stress - b.m.stress);
  for (const { e, m } of rows)
    console.log(
      `LTS ${e.lts}  stress ${m.stress.toFixed(2)} (max ${m.maxStress.toFixed(2)})  ${e.id.padEnd(24)} ${m.ways
        .slice(0, 2)
        .map((w) => `${w.highway}${w.why ? `[${w.why}]` : ""}`)
        .join(",")
        .padEnd(36)} ${flow ? `flow ${flowScore(m, flow)!.toFixed(2).padStart(5)}  ` : ""}${e.note.slice(0, 56)}`,
    );
  // Each pair labelled at least two levels apart whose score is the wrong way round.
  const report = (name: string, score: (m: Match) => number) => {
    const { rho, inversions } = rankAgainst(
      rows.map((r) => ({ id: r.e.id, lts: r.e.lts!, score: score(r.m) })),
    );
    console.log(
      `\n${name}: ${rows.length} stretches  Spearman ${rho.toFixed(3)}  inversions(≥2 levels) ${inversions.length}`,
    );
    for (const line of inversions) console.log(`  ${line}`);
  };
  report("stress", (m) => m.stress);
  if (flow) report("flow", (m) => flowScore(m, flow)!);
}

const [command, ...rest] = process.argv.slice(2);
const { flags, rest: files } = args(rest);
const cells = flags.cells ?? DEFAULT_CELLS;
if (command === "draft")
  await draft(files, cells, flags.out ?? ".cache/traffic-truth-draft.json");
else if (command === "eval")
  await evaluate(flags.truth ?? "tests/fixtures/traffic-truth.json", cells, flags.flow);
else {
  console.error(
    "usage: traffic_truth.ts draft <gpx…> | eval [--truth <json>] [--cells <dir>]",
  );
  process.exit(2);
}
