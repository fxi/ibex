import fs from 'node:fs';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { catalogueSchema } from '../src/offline/catalogue';
import { decodeIndex } from '../src/offline/ibex/index';
import { decodeBlock } from '../src/offline/ibex/block';
import { CellGraphProvider, searchArea } from '../src/routing/provider';
import { route } from '../src/routing/engine';
import { ROAD } from '../tests/helpers';
import { cellId, tileOf } from '../src/geo/grid';
import type { Installed } from '../src/offline/store';
import type { Point } from '../src/routing/types';
import { DEFAULT_RELEASE } from './local_release';

const dir = process.argv[2] ?? DEFAULT_RELEASE;
const catalogue = catalogueSchema.parse(JSON.parse(fs.readFileSync(`${dir}/catalogue.json`, 'utf8')));
const cities: Record<string, Point> = {
  Geneva: [6.143, 46.204], Lyon: [4.8357, 45.764], Valence: [4.891, 44.933],
  Avignon: [4.805, 43.949], Arles: [4.627, 43.677], Marseille: [5.37, 43.296],
  Grenoble: [5.7245, 45.1885], Briancon: [6.643, 44.899],
  Barcelonnette: [6.651, 44.387], Nice: [7.262, 43.7], Toulon: [5.929, 43.125],
};
for (const [city, point] of Object.entries(cities)) {
  const id = cellId(tileOf(point, 9));
  assert(catalogue.cells.some(c => c.id === id), `${city} missing ${id}`);
}
let blocks = 0, edges = 0;
for (const cell of catalogue.cells) {
  const index = decodeIndex(new Uint8Array(fs.readFileSync(`${dir}/${cell.id}/index.ibx`)), { release: catalogue.release });
  const graph = fs.readFileSync(`${dir}/${cell.id}/graph.ibx`);
  let count = 0;
  for (const ref of index.blocks) {
    const raw = new Uint8Array(inflateRawSync(graph.subarray(ref.offset, ref.offset + ref.length)));
    assert.equal(raw.length, ref.rawLength);
    const decoded = decodeBlock(raw, index.strings, { releaseTag: index.releaseTag, block: {x:ref.x,y:ref.y}, crc: ref.crc });
    assert.equal(decoded.edges.length, ref.edges);
    assert.equal(decoded.nodes.length, ref.nodes);
    count += decoded.edges.length;
    blocks++;
  }
  assert.equal(count, cell.edges);
  edges += count;
  console.log(`${cell.id}: ${count} edges decoded`);
}
console.log(JSON.stringify({ release: catalogue.release, cells: catalogue.cells.length, blocks, edges, coveredCities: Object.keys(cities) }));
// Exercise new southern packs through the application's real provider and router.
const ids = ['9-263-187', '9-264-187'];
const packs = ids.map(id => ({manifest: JSON.parse(fs.readFileSync(`${dir}/${id}/manifest.json`, 'utf8')), installedAt:'2026-09-13', directory:id, backend:'idb'}) as Installed);
const reader = {
  async readFile(pack: Installed, path: string) { return Uint8Array.from(fs.readFileSync(`${dir}/${pack.manifest.id}/${path}`)).buffer; },
  async readRange(pack: Installed, path: string, offset: number, length: number) { const f = fs.openSync(`${dir}/${pack.manifest.id}/${path}`, 'r'); const data = new Uint8Array(length); try { assert.equal(fs.readSync(f,data,0,length,offset),length); return data.buffer; } finally { fs.closeSync(f); } },
};
const provider = new CellGraphProvider(packs, catalogue.release, catalogue.cells.map(c => ({id:c.id,bbox:c.bbox})),reader);
await provider.open();
const anchors: Point[] = [[5.37,43.296],[5.929,43.125]];
const graph = await provider.load(searchArea(anchors));
const result = route(graph, { anchors, profile: ROAD }, 'reference');
console.log(JSON.stringify({check:'Marseille to Toulon',status:result.status,distanceM:result.distanceM,ascentM:result.ascentM,seamConflicts:provider.stats.seamConflicts}));
assert.equal(result.status, 'ok');
assert.equal(provider.stats.seamConflicts, 0);
console.log('REGIONAL VALIDATION PASSED');
