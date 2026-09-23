import type { Point } from "../routing/types";

/** What a found place offers a rider; a manual note is whatever the rider wrote. */
export type PlaceKind = "water" | "food" | "supermarket";
export type NoteKind = "manual" | PlaceKind;

/**
 * An extra point along a track. Only the position is kept: the distance along the route is
 * read from the route as it stands, so a re-route never leaves a stale kilometre behind.
 */
export type Note = {
  id: string;
  kind: NoteKind;
  point: Point;
  /** The rider's text, or the place's name. */
  text: string;
  /** `node/123`, for a place found in OpenStreetMap. */
  osm?: string;
  /** OSM `opening_hours`, as tagged. */
  hours?: string;
};

/** Cool and neutral hues only: warm ones are reserved for how hard or busy a stretch is. */
export const NOTE_COLORS: Record<NoteKind, string> = {
  manual: "#7c3aed",
  water: "#0284c7",
  food: "#8d6e63",
  supermarket: "#15803d",
};

export const NOTE_LABELS: Record<NoteKind, string> = {
  manual: "Note",
  water: "Drinking water",
  food: "Bakery or food",
  supermarket: "Supermarket",
};
