import { useEffect, useRef, useState } from "react";
import type { Point } from "../routing/types";

export type SearchState = ReturnType<typeof useSearch>;

/** MapTiler place lookup. Online-only, and the only part of the app that geocodes. */
export function useSearch({
  online,
  setError,
}: {
  online: boolean;
  setError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<{ name: string; point: Point }[]>([]);
  const [searching, setSearching] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => controller.current?.abort(), []);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const id = ++generation.current;
    setSearching(true);
    setError("");
    setPlaces([]);
    try {
      const key = import.meta.env.VITE_MAPTILER_API_KEY;
      if (!key || !online)
        throw new Error(
          "Place search needs an internet connection and map access key.",
        );
      const response = await fetch(
        `https://api.maptiler.com/geocoding/${encodeURIComponent(query.trim())}.json?key=${encodeURIComponent(key)}&limit=5`,
        { signal: abort.signal },
      );
      if (!response.ok) throw new Error("Place search is unavailable.");
      const data = await response.json();
      if (id === generation.current) {
        setPlaces(
          data.features.map((f: { place_name: string; center: Point }) => ({
            name: f.place_name,
            point: f.center,
          })),
        );
        if (!data.features.length) setError("No places found.");
      }
    } catch (e) {
      if (!abort.signal.aborted) setError(String(e));
    } finally {
      if (id === generation.current) setSearching(false);
    }
  }

  return { open, setOpen, query, setQuery, places, searching, search };
}
