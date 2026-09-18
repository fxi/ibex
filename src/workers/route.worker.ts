/// <reference lib="webworker" />
import { toCompiled } from "../routing/compile";
import type { Installed } from "../offline/store";
import { validateAnchors } from "../offline/validate";
import { emptyComponents } from "../routing/engine";
import { relativeCost, routeLeg, type LegGraphSource } from "../routing/legs";
import { CellGraphProvider, searchArea } from "../routing/provider";
import type { BBox } from "../geo/grid";
import type { Comparison, Point, RouteResult } from "../routing/types";
import type { RouteRequest } from "../routing/types";

function emptyResult(
  status: RouteResult["status"],
  anchors: Point[],
  extra: Partial<RouteResult> = {},
): RouteResult {
  return {
    status,
    mode: "corridor",
    geometry: [],
    anchors,
    cost: 0,
    components: emptyComponents(),
    distanceM: 0,
    hikeABikeM: 0,
    ferryM: 0,
    ascentM: null,
    descentM: null,
    elevationProfile: [],
    edgeIds: [],
    segments: [],
    surfaceM: {},
    uncertainM: 0,
    metrics: {
      durationMs: 0,
      explored: 0,
      expansions: 0,
      tiles: 0,
      loadedBytes: 0,
    },
    ...extra,
  };
}

function postComparison(id: number, value: Comparison) {
  self.postMessage({
    id,
    type: "result",
    comparison: {
      ...value,
      relativeCost: relativeCost(value.reference, value.corridor),
    },
  });
}

type CellInput = {
  id: number;
  release: string;
  packs: Installed[];
  published?: { id: string; bbox: BBox }[];
  request: RouteRequest;
  /** One-based legs to route; the caller already holds the rest. Every leg when absent. */
  legs?: number[];
};

// Keep one bounded block cache and one compiled policy while the worker is idle.
let heldProvider: { key: string; provider: CellGraphProvider } | undefined;
let heldProfile:
  { key: string; profile: ReturnType<typeof toCompiled> } | undefined;

async function routeCells(data: CellInput) {
  const { id, packs, release } = data;
  const profileKey = JSON.stringify(data.request.profile);
  if (heldProfile?.key !== profileKey)
    heldProfile = {
      key: profileKey,
      profile: toCompiled(data.request.profile),
    };
  const request = {
    ...data.request,
    profile: heldProfile!.profile,
  };
  validateAnchors(request.anchors);
  self.postMessage({ id, type: "progress", label: "Preparing your profile…" });

  const providerKey = JSON.stringify([release, packs, data.published ?? []]);
  if (heldProvider?.key !== providerKey) {
    const provider = new CellGraphProvider(
      packs,
      release,
      data.published ?? [],
    );
    await provider.open();
    heldProvider = { key: providerKey, provider };
  }
  const provider = heldProvider!.provider;
  const coverage = provider.envelope();
  const empty = { type: "FeatureCollection", features: [] } as const;
  if (!coverage) {
    postComparison(id, {
      fieldView: { ...empty, features: [] },
      reference: emptyResult("missing-cells", request.anchors, {
        missingCells: provider.missing(searchArea(request.anchors)),
      }),
      corridor: emptyResult("missing-cells", request.anchors),
      relativeCost: null,
    });
    return;
  }

  // An anchor on uninstalled-but-published ground is a download problem, not a routing
  // failure, and the two must not be reported the same way.
  for (const anchor of request.anchors) {
    if (provider.contains(anchor)) continue;
    const needed = provider.missing(searchArea([anchor], 2));
    const status = needed.length ? "missing-cells" : "outside-coverage";
    postComparison(id, {
      fieldView: { ...empty, features: [] },
      reference: emptyResult(status, request.anchors, {
        missingCells: needed.length ? needed : undefined,
      }),
      corridor: emptyResult(status, request.anchors),
      relativeCost: null,
    });
    return;
  }

  const source: LegGraphSource = {
    async load(bbox) {
      const graph = await provider.load(bbox);
      return graph;
    },
    missing: (bbox) => provider.missing(bbox),
    retain: (bbox) => provider.retain(bbox),
  };
  const legs = data.legs ?? request.anchors.slice(1).map((_, i) => i + 1);
  // Each leg is posted as it finishes, so its work survives a cancel or a later edit.
  for (const leg of legs) {
    const beforeBytes = provider.stats.storedBytes,
      beforeBlocks = provider.stats.blocks;
    const value = await routeLeg(source, request, leg, coverage, (label) =>
      self.postMessage({ id, type: "progress", label }),
    );
    const extras = {
      loadedBytes: provider.stats.storedBytes - beforeBytes,
      blocks: provider.stats.blocks - beforeBlocks,
      cells: provider.stats.cells,
    };
    for (const r of new Set([value.reference, value.corridor, value.selected]))
      Object.assign(r.metrics, extras);
    self.postMessage({ id, type: "leg", leg, value });
    if (value.selected.status !== "ok") break;
  }
  self.postMessage({ id, type: "done" });
}

self.onmessage = async (event: MessageEvent<CellInput>) => {
  const data = event.data;
  try {
    await routeCells(data);
  } catch (e) {
    self.postMessage({
      id: data.id,
      type: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
