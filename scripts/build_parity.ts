/**
 * Diff two cell builds. The suite asserts routing *relationships*, so nothing else in the
 * repo can tell a faithful port from one that quietly moved an edge; this does, by
 * comparing the graphs themselves.
 *
 * Identity is exact and everything else has a tolerance, because the two things being
 * compared are expected to differ in the last bits of a float and nowhere else. An id that
 * exists on one side only, or an edge whose extent changed, is a defect however small the
 * numbers are.
 *
 *   node --import tsx scripts/build_parity.ts <a> <b> [--epsilon 1e-6] [--limit 20]
 *
 * Each side is a cell build directory or a graph.json. Exits 1 on any divergence.
 *
 * Dense cells hold a few hundred MB of JSON per side; run it under
 * `node --max-old-space-size=8000 --import tsx` for those, as packaging already does.
 */
import fs from 'node:fs';

type Point = [number, number];
type Grade = [number, number];
type Edge = {
  id: number; way: string; from: number; to: number;
  length: number; surface: string; highway: string; name: string; tile: string;
  tags: Record<string, string>;
  stress: number; uncertainty: number; utility: number; urban: number;
  quality: number; forest: number; junction: number; reward: number;
  cyclingNetwork: number; bridge: boolean; tunnel: boolean;
  ferryService?: string; ferrySeconds?: number;
  geometry: Point[]; grades: Grade[] | null;
};
type Node = { id: number; p: Point; elevation: number | null };
type Restriction = { ways: string[]; only: boolean; uTurn: boolean; via?: number };
type Graph = { bbox: number[]; nodes: Node[]; edges: Edge[]; restrictions: Restriction[] };

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const option = (name: string, fallback: number) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.slice(name.length + 3)) : fallback;
};
const epsilon = option('epsilon', 1e-6);
const limit = option('limit', 20);
if (positional.length !== 2) {
  console.error('usage: build_parity.ts <a> <b> [--epsilon=1e-6] [--limit=20]');
  process.exit(2);
}

const read = (path: string): Graph => {
  const file = fs.statSync(path).isDirectory() ? `${path}/graph.json` : path;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Graph;
};
const [a, b] = positional.map(read);
const [nameA, nameB] = positional;

const problems: string[] = [];
let shown = 0;
/** Collect rather than throw: one run should report the shape of a divergence, not its first byte. */
const report = (what: string) => {
  problems.push(what);
  if (shown++ < limit) console.log(`  ${what}`);
};

const near = (x: number, y: number) => Math.abs(x - y) <= epsilon * Math.max(1, Math.abs(x), Math.abs(y));

/** Set difference on ids, reported as counts plus a sample: a missing cluster is one cause. */
function compareIds(kind: string, left: Set<number | string>, right: Set<number | string>) {
  const onlyA = [...left].filter((id) => !right.has(id));
  const onlyB = [...right].filter((id) => !left.has(id));
  if (onlyA.length) report(`${kind}: ${onlyA.length} only in ${nameA}, e.g. ${onlyA.slice(0, 5).join(', ')}`);
  if (onlyB.length) report(`${kind}: ${onlyB.length} only in ${nameB}, e.g. ${onlyB.slice(0, 5).join(', ')}`);
  return { onlyA, onlyB };
}

console.log(`bbox`);
a.bbox.forEach((v, i) => {
  if (!near(v, b.bbox[i])) report(`bbox[${i}]: ${v} vs ${b.bbox[i]}`);
});

console.log(`nodes: ${a.nodes.length} vs ${b.nodes.length}`);
const nodesA = new Map(a.nodes.map((n) => [n.id, n]));
const nodesB = new Map(b.nodes.map((n) => [n.id, n]));
compareIds('nodes', new Set(nodesA.keys()), new Set(nodesB.keys()));
for (const [id, left] of nodesA) {
  const right = nodesB.get(id);
  if (!right) continue;
  if (!near(left.p[0], right.p[0]) || !near(left.p[1], right.p[1]))
    report(`node ${id} position: ${left.p} vs ${right.p}`);
  if ((left.elevation === null) !== (right.elevation === null))
    report(`node ${id} elevation: ${left.elevation} vs ${right.elevation}`);
  else if (left.elevation !== null && right.elevation !== null && !near(left.elevation, right.elevation))
    report(`node ${id} elevation: ${left.elevation} vs ${right.elevation}`);
}

console.log(`edges: ${a.edges.length} vs ${b.edges.length}`);
const edgesA = new Map(a.edges.map((e) => [e.id, e]));
const edgesB = new Map(b.edges.map((e) => [e.id, e]));
const { onlyA, onlyB } = compareIds('edges', new Set(edgesA.keys()), new Set(edgesB.keys()));
/**
 * Way ids behind an id-level difference: a split that moved shows up as one way, not one
 * edge. Printed, never counted — it explains the difference above rather than adding one.
 */
const ways = (ids: (number | string)[], from: Map<number, Edge>) =>
  [...new Set(ids.map((id) => from.get(id as number)?.way))].filter(Boolean);
if (onlyA.length) console.log(`    ways affected in ${nameA}: ${ways(onlyA, edgesA).slice(0, 10).join(', ')}`);
if (onlyB.length) console.log(`    ways affected in ${nameB}: ${ways(onlyB, edgesB).slice(0, 10).join(', ')}`);

const EXACT = ['way', 'from', 'to', 'surface', 'highway', 'name', 'tile', 'bridge', 'tunnel', 'ferryService'] as const;
const APPROX = ['length', 'stress', 'uncertainty', 'utility', 'urban', 'quality', 'forest',
  'junction', 'reward', 'cyclingNetwork', 'ferrySeconds'] as const;

for (const [id, left] of edgesA) {
  const right = edgesB.get(id);
  if (!right) continue;
  for (const key of EXACT)
    if (left[key] !== right[key]) report(`edge ${id} (way ${left.way}) ${key}: ${left[key]} vs ${right[key]}`);
  for (const key of APPROX) {
    const x = left[key] ?? 0, y = right[key] ?? 0;
    if (!near(x, y)) report(`edge ${id} (way ${left.way}) ${key}: ${x} vs ${y}`);
  }
  if (JSON.stringify(left.tags) !== JSON.stringify(right.tags))
    report(`edge ${id} (way ${left.way}) tags: ${JSON.stringify(left.tags)} vs ${JSON.stringify(right.tags)}`);
  // Extent, not just shape: with ref-index ids a missed split keeps the id and lengthens
  // the edge, which is the one divergence a length tolerance would hide.
  if (left.geometry.length !== right.geometry.length)
    report(`edge ${id} (way ${left.way}) geometry points: ${left.geometry.length} vs ${right.geometry.length}`);
  else
    for (let i = 0; i < left.geometry.length; i++)
      if (!near(left.geometry[i][0], right.geometry[i][0]) || !near(left.geometry[i][1], right.geometry[i][1])) {
        report(`edge ${id} (way ${left.way}) geometry[${i}]: ${left.geometry[i]} vs ${right.geometry[i]}`);
        break;
      }
  if ((left.grades === null) !== (right.grades === null))
    report(`edge ${id} (way ${left.way}) grades: ${left.grades === null ? 'null' : 'set'} vs ${right.grades === null ? 'null' : 'set'}`);
  else if (left.grades && right.grades) {
    if (left.grades.length !== right.grades.length)
      report(`edge ${id} (way ${left.way}) grade samples: ${left.grades.length} vs ${right.grades.length}`);
    else
      for (let i = 0; i < left.grades.length; i++)
        if (!near(left.grades[i][0], right.grades[i][0]) || !near(left.grades[i][1], right.grades[i][1])) {
          report(`edge ${id} (way ${left.way}) grades[${i}]: ${left.grades[i]} vs ${right.grades[i]}`);
          break;
        }
  }
}

console.log(`restrictions: ${a.restrictions.length} vs ${b.restrictions.length}`);
/** Restrictions carry no id, so compare them as a set under a canonical key. */
const key = (r: Restriction) => `${r.ways.join('>')}|${r.only}|${r.uTurn}|${r.via ?? ''}`;
compareIds('restrictions', new Set(a.restrictions.map(key)), new Set(b.restrictions.map(key)));

if (problems.length > shown) console.log(`  ... ${problems.length - shown} more`);
console.log(problems.length ? `\nDIVERGENT: ${problems.length} difference(s)` : '\nIDENTICAL');
process.exit(problems.length ? 1 : 0);
