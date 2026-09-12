import type { Point } from "../routing/types";
import type { Profile } from "../routing/profiles";
import type { TracksState } from "../state/useTracks";
import type { CatalogueState } from "../state/useCatalogue";
import type { RoutingState } from "../state/useRouting";

/**
 * Everything the four tabs draw from. Passing one bag keeps the panels' signatures short
 * while the state itself stays owned by the hooks in `src/state`.
 */
export type PanelContext = {
  tracks: TracksState;
  data: CatalogueState;
  routing: RoutingState;
  online: boolean;
  /** Enough data and at least two waypoints, with no run already in flight. */
  canCompute: boolean;
  status: string;
  /** Moves the map to fit the given points. */
  fit: (points: Point[]) => void;
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
