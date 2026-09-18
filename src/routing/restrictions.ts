/**
 * Turn restrictions, compiled for the search.
 *
 * Two things are needed from a rule set. `compileRestrictions` indexes the rules by the way
 * a turn departs from, and works out how much of the path a state has to remember: only
 * prefixes of a restriction can affect a future turn, so remembering arbitrary previous
 * roads would multiply equivalent search states across the whole region.
 * `restrictionAllows` then answers, for one candidate edge, whether the rules permit it.
 */
import type { Edge, Graph } from "./types";

/**
 * Rules keyed by the way a restricted turn departs from, plus the history a state must
 * carry. Every rule has at least two ways (`from`, `to`) — the pack schema enforces it, so
 * `ways[length - 2]` is always a real way and never an undefined key.
 */
export function compileRestrictions(rules: Graph["restrictions"]) {
  const prefixes = new Set<string>();
  let historyLength = 1;
  for (const rule of rules) {
    for (let length = 1; length < rule.ways.length; length++)
      prefixes.add(JSON.stringify(rule.ways.slice(0, length)));
    historyLength = Math.max(historyLength, rule.ways.length - 1);
  }
  const byWay = new Map<string, Graph["restrictions"]>();
  for (const rule of rules) {
    const keys =
      rule.only && rule.via === undefined
        ? rule.ways.slice(0, -1)
        : [rule.ways[rule.ways.length - 2]];
    for (const key of new Set(keys)) {
      const list = byWay.get(key) ?? [];
      list.push(rule);
      byWay.set(key, list);
    }
  }
  /** The shortest history that still distinguishes this path for the rules that exist. */
  const nextHistory = (previous: string[], way: string): string[] => {
    if (previous.at(-1) === way) return previous;
    const candidate = [...previous, way].slice(-historyLength);
    for (let start = 0; start < candidate.length - 1; start++) {
      const suffix = candidate.slice(start);
      if (prefixes.has(JSON.stringify(suffix))) return suffix;
    }
    return [way];
  };
  return { byWay, nextHistory, historyLength };
}

export function restrictionAllows(
  rules: Graph["restrictions"],
  history: string[],
  at: number,
  next: Edge,
  previous?: Edge,
): boolean {
  for (const rule of rules) {
    if (rule.via !== undefined && rule.via !== at) continue;
    // Via-way only restrictions constrain every departure in the sequence,
    // not just the final turn. History retains progress across split edges.
    if (rule.only && rule.via === undefined) {
      for (let length = 1; length < rule.ways.length; length++) {
        if (
          history.length < length ||
          !rule.ways
            .slice(0, length)
            .every((way, i) => history[history.length - length + i] === way)
        )
          continue;
        if (next.way !== history.at(-1) && next.way !== rule.ways[length])
          return false;
      }
      continue;
    }
    const prefix = rule.ways.slice(0, -1);
    if (
      history.length < prefix.length ||
      !prefix.every((w, i) => history[history.length - prefix.length + i] === w)
    )
      continue;
    if (rule.via === undefined && next.way === history.at(-1)) continue;
    const matches =
      next.way === rule.ways.at(-1) &&
      (!(
        rule.uTurn &&
        rule.via !== undefined &&
        rule.ways.length === 2 &&
        rule.ways[0] === rule.ways[1]
      ) ||
        previous?.from === next.to);
    if (rule.only ? !matches : matches) return false;
  }
  return true;
}