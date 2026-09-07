import type { Comparison, RouteResult } from "./types";

/** Display/export the cheaper successful result; the corridor is only a candidate. */
export function selectedRoute(
  comparison?: Comparison,
  partial?: RouteResult,
): RouteResult | undefined {
  if (!comparison) return partial;
  const { reference, corridor } = comparison;
  if (
    reference.status === "ok" &&
    (corridor.status !== "ok" || reference.cost <= corridor.cost)
  )
    return reference;
  return corridor;
}
