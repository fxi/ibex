import { useEffect, useRef, useState } from "react";
import { acceptResult, type TrackCollection, type Track } from "../tracks";
import { selectedRoute } from "../routing/selection";
import type { Comparison } from "../routing/types";
import type { Installed } from "../offline/store";
import type { Catalogue } from "../offline/catalogue";
import RoutingWorker from "../workers/route.worker.ts?worker&inline";

export type RoutingState = ReturnType<typeof useRouting>;

/**
 * Owns route computation. The worker is created per run and terminated on completion or
 * cancel, so a stale result can never land on a track the user has since edited: every
 * message is checked against the generation, track id and revision it was started for.
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

  function cancel() {
    generation.current++;
    routeWorker.current?.terminate();
    routeWorker.current = undefined;
    setBusy(false);
  }

  useEffect(() => () => routeWorker.current?.terminate(), []);

  function compute() {
    const current = latest.current;
    const active = current?.tracks.find((t) => t.id === current.activeId);
    if (!active || active.anchors.length < 2) return;
    const cellPacks = routableCells;
    if (!cellPacks.length) return;
    cancel();
    const id = ++generation.current,
      trackId = active.id,
      revision = active.revision;
    const worker = new RoutingWorker();
    routeWorker.current = worker;
    setBusy(true);
    setError("");
    setStatus("Preparing local data…");
    worker.onmessage = ({ data }) => {
      const track = latest.current?.tracks.find((t) => t.id === trackId);
      if (
        data.id !== generation.current ||
        track?.revision !== revision ||
        latest.current?.activeId !== trackId
      )
        return;
      if (data.type === "progress") setStatus(data.label);
      if (data.type === "result") {
        const result = selectedRoute(data.comparison);
        setComparison({ trackId, revision, value: data.comparison });
        if (result?.status === "ok") {
          const version = `${catalogue?.release ?? "cells"}:${cellPacks.length}`;
          updateTrack(trackId, (t) =>
            acceptResult(t, revision, result, version),
          );
          setStatus("Route ready");
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
        worker.terminate();
      }
      if (data.type === "error") {
        setError(data.error);
        setBusy(false);
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      if (id === generation.current) {
        setError(`Routing stopped. ${e.message || "Try a shorter route."}`);
        setBusy(false);
        worker.terminate();
      }
    };
    const request = {
      anchors: active.anchors,
      profile: active.profile,
    };
    worker.postMessage({
      id,
      release: catalogue!.release,
      packs: cellPacks,
      published: catalogue!.cells.map((c) => ({ id: c.id, bbox: c.bbox })),
      request,
    });
  }

  return { busy, comparison, compute, cancel };
}
