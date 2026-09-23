import type { Point } from "../routing/types";
import type { Profile } from "../routing/profiles";
import type { TracksState } from "../state/useTracks";
import type { CatalogueState } from "../state/useCatalogue";
import type { RoutingState } from "../state/useRouting";
import type { ConvertState } from "../state/useConvert";
import type { NotesState } from "../state/useNotes";

/**
 * Everything the four tabs draw from. Passing one bag keeps the panels' signatures short
 * while the state itself stays owned by the hooks in `src/state`.
 */
export type PanelContext = {
  tracks: TracksState;
  data: CatalogueState;
  routing: RoutingState;
  convert: ConvertState;
  notes: NotesState;
  online: boolean;
  /** Enough data and at least two waypoints, with no run already in flight. */
  canCompute: boolean;
  status: string;
  /** Moves the map to fit the given points. */
  fit: (points: Point[]) => void;
  /**
   * Marks one point on the map and brings it into view without changing the zoom, so
   * pointing at a section of the route never costs the rider their overview. No argument
   * clears the mark.
   */
  locate: (point?: Point) => void;
  setError: (message: string) => void;
  setStatus: (message: string) => void;
  setTab: (tab: string) => void;
  debug: boolean;
  setDebug: (value: boolean) => void;
  history: boolean;
  setHistory: (value: boolean) => void;
  models: Profile[];
  reloadModels: () => void;
};
