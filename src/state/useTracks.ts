import { useEffect, useRef, useState } from "react";
import {
  loadTracks,
  saveTracks,
  editTrack,
  newTrack,
  trackId,
  type Track,
  type TrackCollection,
} from "../tracks";

export type TracksState = ReturnType<typeof useTracks>;

/**
 * Owns the persisted track collection and the debounced save queue.
 *
 * `latest` mirrors `collection` during render so async callbacks — the routing worker,
 * dropdown menu items, the install queue — can read the current value without being
 * recreated on every commit. Removing it reintroduces stale-closure bugs.
 */
export function useTracks({
  onError,
  beforeChange,
}: {
  onError: (message: string) => void;
  /** Invalidates any in-flight route before the collection changes. */
  beforeChange: () => void;
}) {
  const [collection, setCollection] = useState<TrackCollection>();
  const latest = useRef(collection);
  latest.current = collection;
  const [saving, setSaving] = useState(false);
  const saveRevision = useRef(0);
  const saveQueue = useRef(Promise.resolve());

  const active = collection?.tracks.find((t) => t.id === collection.activeId);

  function commit(next: TrackCollection) {
    latest.current = next;
    setSaving(true);
    saveRevision.current++;
    setCollection(next);
  }

  function updateTrack(id: string, fn: (track: Track) => Track) {
    const current = latest.current;
    if (current)
      commit({
        ...current,
        tracks: current.tracks.map((t) => (t.id === id ? fn(t) : t)),
      });
  }

  function edit(changes: Parameters<typeof editTrack>[1]) {
    const current = latest.current;
    const track = current?.tracks.find((t) => t.id === current.activeId);
    if (!track) return;
    beforeChange();
    updateTrack(track.id, (t) => editTrack(t, changes));
  }

  function select(id: string) {
    beforeChange();
    if (latest.current) commit({ ...latest.current, activeId: id });
  }

  function add() {
    const current = latest.current;
    const source = current?.tracks.find((t) => t.id === current.activeId);
    if (!current || !source) return;
    beforeChange();
    const track = newTrack(current.tracks.length, source.profile);
    commit({
      ...current,
      activeId: track.id,
      tracks: [...current.tracks, track],
    });
  }

  /** Copies any track, not only the active one — the track menu duplicates in place. */
  function duplicate(id: string) {
    const current = latest.current;
    const source = current?.tracks.find((t) => t.id === id);
    if (!current || !source) return;
    beforeChange();
    const copy = {
      ...structuredClone(source),
      id: trackId(),
      name: `${source.name} copy`,
      color: newTrack(current.tracks.length).color,
    };
    commit({
      ...current,
      activeId: copy.id,
      tracks: [...current.tracks, copy],
    });
  }

  function remove(id: string) {
    const current = latest.current;
    if (!current) return;
    beforeChange();
    let tracks = current.tracks.filter((t) => t.id !== id);
    if (!tracks.length) tracks = [newTrack()];
    commit({
      ...current,
      tracks,
      activeId: current.activeId === id ? tracks[0].id : current.activeId,
    });
  }

  useEffect(() => {
    let disposed = false;
    loadTracks()
      .then((v) => {
        if (!disposed) commit(v);
      })
      .catch((e) => {
        if (!disposed) onError(`Unable to restore tracks: ${String(e)}`);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!collection) return;
    const revision = saveRevision.current;
    saveQueue.current = saveQueue.current
      .then(() => saveTracks(collection))
      .then(() => {
        if (revision === saveRevision.current) setSaving(false);
      })
      .catch(() =>
        onError("Tracks could not be saved. Check available browser storage."),
      );
  }, [collection]);

  useEffect(() => {
    if (!saving) return;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [saving]);

  return {
    collection,
    latest,
    active,
    saving,
    commit,
    updateTrack,
    edit,
    select,
    add,
    duplicate,
    remove,
  };
}
