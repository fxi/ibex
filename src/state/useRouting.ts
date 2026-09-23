import { useEffect, useRef, useState } from "react";
import { acceptResult, type TrackCollection, type Track } from "../tracks";
import { selectedRoute } from "../routing/selection";
import {
  LegCache,
  assembleLegs,
  legKeys,
  missingLegs,
} from "../routing/legCache";
import type { LegComparison } from "../routing/legs";
import type { Comparison, RouteResult } from "../routing/types";
import type { Installed } from "../offline/store";
import type { Catalogue } from "../offline/catalogue";
import { GENERATION } from "../offline/version";
import RoutingWorker from "../workers/route.worker.ts?worker&inline";

export type RoutingState = ReturnType<typeof useRouting>;

/** Shared by every track: a leg's key already says everything its result depends on. */
const legs = new LegCache<LegComparison>();

/**
 * Owns route computation. An idle worker retains bounded decoded data between edits;
 * cancelling active work terminates it. A stale result cannot land on an edited track: every
 * message is checked against the generation, track id and revision it was started for.
 *
 * Only legs missing from the cache are sent to the worker. Legs are cached as they arrive,
 * before that check, because a finished leg stays correct whatever happened to the track.
 */
export function useRouting({
  latest,
  updateTrack,
  catalogue,
  routableCells,
  setError,
  setStatus,
  onMissingCells,
}: {
  latest: React.RefObject<TrackCollection | undefined>;
  updateTrack: (id: string, fn: (track: Track) => Track) => void;
  catalogue: Catalogue | undefined;
  routableCells: Installed[];
  setError: (message: string) => void;
  setStatus: (message: string) => void;
  onMissingCells: (ids: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [comparison, setComparison] = useState<{
    trackId: string;
    revision: number;
    value: Comparison;
  }>();
  const routeWorker = useRef<Worker | undefined>(undefined);
  const generation = useRef(0);
  const running = useRef(false);
  // Resolves the run in flight, so a caller awaiting it is released when it is cancelled.
  const settle = useRef<(result?: RouteResult) => void>(undefined);

  function cancel() {
    settle.current?.();
    settle.current = undefined;
    generation.current++;
    if (running.current) {
      routeWorker.current?.terminate();
      routeWorker.current = undefined;
    }
    running.current = false;
    setBusy(false);
  }

  useEffect(() => () => routeWorker.current?.terminate(), []);

  /**
   * Route the active track. `kept` holds legs a local edit already knows, numbered
   * one-based: they are cached under their own keys, so they are not routed again.
   *
   * Resolves with the route once it lands on the track, or with nothing when it failed or
   * was overtaken; errors are reported here either way.
   */
  function compute(
    kept?: ReadonlyMap<number, RouteResult>,
  ): Promise<RouteResult | undefined> {
    const current = latest.current;
    const active = current?.tracks.find((t) => t.id === current.activeId);
    if (!active || active.anchors.length < 2) return Promise.resolve(undefined);
    const cellPacks = routableCells;
    if (!cellPacks.length || !catalogue) return Promise.resolve(undefined);
    cancel();
    let resolve: (result?: RouteResult) => void = () => {};
    const settled = new Promise<RouteResult | undefined>((r) => (resolve = r));
    settle.current = resolve;
    const id = ++generation.current,
      trackId = active.id,
      revision = active.revision;
    const request = {
      anchors: active.anchors,
      profile: active.profile,
    };
    const keys = legKeys(request, GENERATION, cellPacks, catalogue.cells);
    // Room for this route and the one it was edited from, whose legs may come back.
    legs.reserve(keys.length * 2);
    for (const [leg, route] of kept ?? []) {
      const key = keys[leg - 1];
      if (key && !legs.has(key))
        legs.set(key, {
          reference: route,
          corridor: route,
          selected: route,
          fieldView: { type: "FeatureCollection", features: [] },
          relativeCost: null,
        });
    }
    const missing = missingLegs(keys, legs);
    const routed = new Map<number, LegComparison>();

    const current_ = () => {
      const track = latest.current?.tracks.find((t) => t.id === trackId);
      return (
        id === generation.current &&
        track?.revision === revision &&
        latest.current?.activeId === trackId
      );
    };

    const finish = (value: Comparison) => {
      const result = selectedRoute(value);
      setComparison({ trackId, revision, value });
      if (result?.status === "ok") {
        const version = `${GENERATION}:${cellPacks.length}`;
        updateTrack(trackId, (t) => acceptResult(t, revision, result, version));
        const reused = keys.length - missing.length;
        setStatus(
          reused && keys.length > 1
            ? `Route ready · ${reused} of ${keys.length} legs reused`
            : "Route ready",
        );
      } else if (result?.status === "missing-cells") {
        const needed = result.missingCells ?? [];
        onMissingCells(needed);
        setError(
          needed.length
            ? `This route needs ${needed.length} more map ${
                needed.length === 1 ? "area" : "areas"
              }. Open the Data tab to add ${
                needed.length === 1 ? "it" : "them"
              }.`
            : "This route needs map areas that are not downloaded.",
        );
      } else
        setError(
          result?.status === "outside-coverage"
            ? "A waypoint is outside the downloaded region."
            : result?.status === "snap-failed"
              ? "No suitable connection within 250 m. Move a waypoint onto a suitable road."
              : result?.status === "budget-exceeded"
                ? "Search budget reached. Simplify the route or review terrain limits."
                : "No route connects these waypoints under this model. Review terrain and access limits.",
        );
      setBusy(false);
      running.current = false;
      resolve(result?.status === "ok" ? result : undefined);
    };

    setError("");
    if (!missing.length) {
      finish(assembleLegs(keys, request.anchors, legs, routed)!);
      return settled;
    }

    const worker = routeWorker.current ?? new RoutingWorker();
    routeWorker.current = worker;
    running.current = true;
    setBusy(true);
    setStatus("Preparing local data…");
    worker.onmessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === "leg") {
        routed.set(data.leg, data.value);
        if (data.value.selected.status === "ok")
          legs.set(keys[data.leg - 1], data.value);
      }
      // Even for a track no longer on screen, the worker is idle again and keeps its cache.
      if (data.type === "done") running.current = false;
      if (!current_()) {
        resolve();
        return;
      }
      if (data.type === "progress") setStatus(data.label);
      if (data.type === "result") {
        // Refused before any leg ran: a waypoint off the installed data.
        finish(data.comparison);
      }
      if (data.type === "done") {
        const value = assembleLegs(keys, request.anchors, legs, routed);
        if (value) finish(value);
        else {
          setError("Routing stopped before every leg was routed.");
          setBusy(false);
          resolve();
        }
        running.current = false;
      }
      if (data.type === "error") {
        setError(data.error);
        resolve();
        setBusy(false);
        worker.terminate();
        routeWorker.current = undefined;
        running.current = false;
      }
    };
    worker.onerror = (e) => {
      if (id === generation.current) {
        setError(`Routing stopped. ${e.message || "Try a shorter route."}`);
        resolve();
        setBusy(false);
        worker.terminate();
        routeWorker.current = undefined;
        running.current = false;
      }
    };
    worker.postMessage({
      id,
      release: GENERATION,
      packs: cellPacks,
      published: catalogue.cells.map((c) => ({ id: c.id, bbox: c.bbox })),
      request,
      legs: missing,
    });
    return settled;
  }

  return {
    busy,
    comparison,
    // Buttons pass their click event; only a local edit hands over kept legs.
    compute: () => compute(),
    computeKeeping: compute,
    cancel,
  };
}
