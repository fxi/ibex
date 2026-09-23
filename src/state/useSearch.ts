import { useEffect, useRef, useState } from "react";
import type { Point } from "../routing/types";

export type SearchState = ReturnType<typeof useSearch>;

/**
 * Place lookup through Photon (komoot), which needs no key. Online-only, and the only part
 * of the app that geocodes.
 */
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
      if (!online)
        throw new Error("Place search needs an internet connection.");
      const response = await fetch(photonURL(query), { signal: abort.signal });
      if (!response.ok) throw new Error("Place search is unavailable.");
      const data = await response.json();
      if (id === generation.current) {
        setPlaces(data.features.map(photonPlace));
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

/** Photon speaks a handful of languages and answers in local names otherwise. */
const PHOTON_LANGUAGES = new Set(["de", "en", "fr", "it"]);

export function photonURL(query: string, locale = navigator.language): string {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query.trim());
  url.searchParams.set("limit", "5");
  const lang = locale.split("-")[0].toLowerCase();
  if (PHOTON_LANGUAGES.has(lang)) url.searchParams.set("lang", lang);
  return url.href;
}

type PhotonFeature = {
  geometry: { coordinates: Point };
  properties: Partial<
    Record<"name" | "street" | "housenumber" | "city" | "state" | "country", string>
  >;
};

/** A readable one-line label: the name, then the place and country it is in. */
export function photonPlace(f: PhotonFeature): { name: string; point: Point } {
  const p = f.properties;
  const street = [p.street, p.housenumber].filter(Boolean).join(" ");
  const parts = [p.name ?? street, p.city, p.state, p.country].filter(
    (part, i, all): part is string => !!part && all.indexOf(part) === i,
  );
  return { name: parts.join(", "), point: f.geometry.coordinates };
}
