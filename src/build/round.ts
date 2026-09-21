/**
 * Decimal rounding that matches Python's `round(value, digits)`.
 *
 * The builder rounds most stored values to three decimals, so a port that rounds
 * differently moves numbers the parity harness compares exactly.
 *
 * `toFixed` rounds the double's own decimal expansion, which is what CPython does, so the
 * two agree by construction. The tie-breaks differ — the spec picks the larger candidate,
 * Python the even one — but a tie cannot arise: it needs `value` to be an odd multiple of
 * 1/(2 · 10^digits), and for `digits >= 1` that has a factor of five in its denominator, so
 * it is not a dyadic rational and no double holds it exactly. At `digits = 0` ties are
 * ordinary and the two really do differ, which is why this takes no default.
 *
 * `Math.round(value * 10**digits) / 10**digits` happens to agree for everything this
 * builder stores, because scaling is exact below about 1e9; it starts to diverge above
 * that. Preferring `toFixed` means the range never has to be part of the argument.
 */
export function roundTo(value: number, digits: number): number {
  if (digits < 1) throw new Error("roundTo matches Python only for one or more digits");
  return Number(value.toFixed(digits));
}
