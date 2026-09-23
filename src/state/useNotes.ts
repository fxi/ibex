import { useMemo, useRef, useState } from "react";
import { circleSpans, type Span } from "../notes/corridor";
import { RouteIndex } from "../notes/routeIndex";
import { findPlaces, mergePlaces } from "../notes/search";
import type { Note } from "../notes/types";
import { freshResult, trackId, type Track } from "../tracks";
import { LIMITS } from "../offline/validate";
import type { Point } from "../routing/types";
import type { TracksState } from "./useTracks";

export type NotesState = ReturnType<typeof useNotes>;
export type SearchArea = { center: Point; radiusM: number };
export const MAX_RADIUS_M = 10_000;

/** One route index per result: building one walks every vertex, reading one is cheap. */
const indexes = new WeakMap<object, RouteIndex>();
export function routeIndex(track: Track | undefined): RouteIndex | undefined {
  const result = track && freshResult(track);
  if (!result || result.geometry.length < 2) return;
  let index = indexes.get(result);
  if (!index) {
    index = new RouteIndex(result.geometry, result.distanceM);
    indexes.set(result, index);
  }
  return index;
}

/**
 * The active track's notes, and the searches that fill them. A search belongs to the track
 * and route it started on: switching track does not stop it, and a result that no longer
 * matches its route is dropped rather than placed on the wrong line.
 */
export function useNotes({
  tracks,
  online,
  setError,
  setTab,
}: {
  tracks: TracksState;
  online: boolean;
  setError: (message: string) => void;
  setTab: (tab: string) => void;
}) {
  const [bufferM, setBufferM] = useState(500);
  const [area, setArea] = useState<SearchArea>();
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  // The note whose text field should take focus once the Notes tab shows it.
  const [focusId, setFocusId] = useState<string>();
  const abort = useRef<AbortController | undefined>(undefined);

  const { active } = tracks;
  const index = routeIndex(active);
  const notes = active?.notes ?? [];

  const setNotes = (id: string, fn: (notes: Note[]) => Note[]) =>
    tracks.updateTrack(id, (t) => ({
      ...t,
      notes: fn(t.notes).slice(0, LIMITS.notesMax),
    }));

  const areaSpans = useMemo(
    () => (index && area ? circleSpans(index, area.center, area.radiusM) : []),
    [index, area],
  );

  async function search(scope: "route" | "area") {
    const track = active;
    if (!track || !index || progress) return;
    if (!online) return setError("Finding places needs a connection.");
    const spans: Span[] =
      scope === "route"
        ? [[0, index.lengthM]]
        : circleSpans(index, area!.center, area!.radiusM, bufferM);
    if (!spans.length)
      return setError("The search area does not cross the route.");
    const controller = new AbortController();
    abort.current = controller;
    const result = track.result;
    try {
      const { places, covered, failed } = await findPlaces({
        index,
        spans,
        bufferM,
        signal: controller.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      const current = tracks.latest.current?.tracks.find(
        (t) => t.id === track.id,
      );
      if (current?.result !== result)
        return setError("The route changed during the search; run it again.");
      setNotes(track.id, (notes) =>
        mergePlaces(notes, places, index, covered, bufferM),
      );
      if (failed)
        setError(
          `The map server did not answer for ${failed} stretch${failed > 1 ? "es" : ""} of the route; search again to fill ${failed > 1 ? "them" : "it"}.`,
        );
    } catch (e) {
      if (!controller.signal.aborted)
        setError(`Places could not be found: ${String(e)}`);
    } finally {
      abort.current = undefined;
      setProgress(undefined);
    }
  }

  /** A note of the rider's own at `point`, its text field ready for typing. */
  function addNote(point: Point) {
    if (!active) return setError("Select a track to add a note to.");
    const id = trackId();
    setNotes(active.id, (notes) => [
      ...notes,
      { id, kind: "manual", point, text: "" },
    ]);
    setFocusId(id);
    setTab("notes");
  }

  function findAround(center: Point) {
    setArea({ center, radiusM: area?.radiusM ?? 5000 });
    setTab("notes");
  }

  return {
    notes,
    index,
    bufferM,
    setBufferM,
    area,
    setArea,
    areaSpans,
    progress,
    focusId,
    setFocusId,
    search,
    cancel: () => abort.current?.abort(),
    addNote,
    findAround,
    edit: (id: string, text: string) =>
      active &&
      setNotes(active.id, (notes) =>
        notes.map((n) => (n.id === id ? { ...n, text } : n)),
      ),
    remove: (id: string) =>
      active &&
      setNotes(active.id, (notes) => notes.filter((n) => n.id !== id)),
    clearPlaces: () =>
      active &&
      setNotes(active.id, (notes) => notes.filter((n) => n.kind === "manual")),
  };
}
