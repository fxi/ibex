import type { Comparison, RouteResult } from "./types";

/** A joined route carries each leg's own choice, which stands. */
export function selectedRoute(
  comparison?: Comparison,
  partial?: RouteResult,
): RouteResult | undefined {
  if (!comparison) return partial;
  const { reference, corridor } = comparison;
  if (comparison.selected?.status === "ok") return comparison.selected;
  if (
    reference.status === "ok" &&
    (corridor.status !== "ok" || reference.cost <= corridor.cost)
  )
    return reference;
  return corridor;
}
