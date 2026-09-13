import type { Comparison, RouteResult } from "./types";

/** Exploration has already compared its candidates with the full-graph baseline. */
export function selectedRoute(
  comparison?: Comparison,
  partial?: RouteResult,
): RouteResult | undefined {
  if (!comparison) return partial;
  const { reference, corridor } = comparison;
  if (comparison.exploration?.status === "ok") return comparison.exploration;
  if (
    reference.status === "ok" &&
    (corridor.status !== "ok" || reference.cost <= corridor.cost)
  )
    return reference;
  return corridor;
}
