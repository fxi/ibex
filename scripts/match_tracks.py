"""Conservative spatial matching, confidence audit, and leakage-resistant groups.

This is a reference-data audit, not a claim to reconstruct every recorded ride.
Ambiguous samples and unexplained graph transitions exclude portions from calibration.
"""

import argparse
import hashlib
import heapq
import json
import math
from collections import defaultdict
from pathlib import Path

from prepare_tracks import distance
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

COS = math.cos(math.radians(46.2))
SCALE = math.pi * 6371000 / 180


def xy(p):
    return (p[0] * SCALE * COS, p[1] * SCALE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=80)
    parser.add_argument("--graph", default="data/build/geneva/graph.json")
    parser.add_argument("--tracks", default="data/derived/tracks.geojson")
    args = parser.parse_args()
    graph = json.loads(Path(args.graph).read_bytes())
    tracks = json.loads(Path(args.tracks).read_bytes())["features"]
    # One geometry per physical segment; access direction is checked by transitions below.
    groups = {}
    for edge in graph["edges"]:
        key = (
            edge["way"],
            min(edge["from"], edge["to"]),
            max(edge["from"], edge["to"]),
        )
        groups.setdefault(key, edge)
    edges = list(groups.values())
    lines = [LineString([xy(p) for p in e["geometry"]]) for e in edges]
    tree = STRtree(lines)
    adjacent = defaultdict(list)
    by_id = {e["id"]: e for e in graph["edges"]}
    directed = {(e["way"], e["from"], e["to"]): e for e in graph["edges"]}
    for e in graph["edges"]:
        adjacent[e["from"]].append(e)
    restriction_index = defaultdict(list)
    for rule in graph["restrictions"]:
        restriction_index[rule["ways"][-2]].append(rule)
    history_size = max([1] + [len(r["ways"]) - 1 for r in graph["restrictions"]])

    def allowed(history, previous, next_edge):
        for rule in restriction_index[history[-1]]:
            if "via" in rule and rule["via"] != previous["to"]:
                continue
            prefix = rule["ways"][:-1]
            if list(history[-len(prefix) :]) != prefix:
                continue
            if "via" not in rule and next_edge["way"] == history[-1]:
                continue
            matches = next_edge["way"] == rule["ways"][-1] and (
                not rule.get("uTurn") or next_edge["to"] == previous["from"]
            )
            if (rule["only"] and not matches) or (not rule["only"] and matches):
                return False
        return True

    def transition(previous, target, history, limit):
        initial = (previous["id"], history)
        queue = [(0, initial)]
        best = {initial: 0}
        parents = {}
        settled = 0
        while queue:
            cost, state = heapq.heappop(queue)
            if cost != best[state]:
                continue
            prev = by_id[state[0]]
            hist = state[1]
            if prev["to"] == target["from"] and allowed(hist, prev, target):
                final_history = (
                    hist
                    if hist[-1] == target["way"]
                    else (*hist, target["way"])[-history_size:]
                )
                path = [target["id"]]
                while state != initial:
                    path.append(state[0])
                    state = parents[state]
                return path[::-1], final_history
            settled += 1
            if settled > 1500:
                return None
            for edge in adjacent[prev["to"]]:
                if not allowed(hist, prev, edge):
                    continue
                next_history = (
                    hist
                    if hist[-1] == edge["way"]
                    else (*hist, edge["way"])[-history_size:]
                )
                next_state = (edge["id"], next_history)
                new = cost + edge["length"]
                if new <= limit and new < best.get(next_state, math.inf):
                    best[next_state] = new
                    parents[next_state] = state
                    heapq.heappush(queue, (new, next_state))
        return None

    # Conservative matching ignores uncertain restrictions only for audit connectivity;
    # quantitative route validation must still use the runtime restriction-aware router.
    def connected(a, b, limit):
        queue = [(0, a)]
        cost = {a: 0}
        settled = 0
        while queue:
            d, n = heapq.heappop(queue)
            if d != cost[n]:
                continue
            if n == b:
                return True
            settled += 1
            if settled > 1000:
                return False
            for edge in adjacent[n]:
                target, length = edge["to"], edge["length"]
                nd = d + length
                if nd <= limit and nd < cost.get(target, math.inf):
                    cost[target] = nd
                    heapq.heappush(queue, (nd, target))
        return False

    # Deterministic selection across the complete time range, not the first 80 recent rides.
    tracks.sort(
        key=lambda f: hashlib.sha256(f["properties"]["portionId"].encode()).hexdigest()
    )
    selected = tracks[: args.limit] if args.limit else tracks
    rows = []
    for count, feature in enumerate(selected, 1):
        coords = feature["geometry"]["coordinates"]
        samples = [coords[0]]
        since = 0
        for a, b in zip(coords, coords[1:]):
            since += distance(a, b)
            if since >= 150:
                samples.append(b)
                since = 0
        if distance(samples[-1], coords[-1]) > 20:
            samples.append(coords[-1])
        matched = []
        ambiguous = 0
        gaps = []
        for p in samples:
            point = Point(xy(p))
            indices = tree.query(point.buffer(40))
            candidates = sorted(
                (lines[int(i)].distance(point), int(i)) for i in indices
            )
            if not candidates or candidates[0][0] > 30:
                matched.append(None)
                continue
            gap, index = candidates[0]
            gaps.append(gap)
            if (
                len(candidates) > 1
                and candidates[1][0] - gap < 5
                and edges[candidates[1][1]]["way"] != edges[index]["way"]
            ):
                ambiguous += 1
                matched.append(None)
            else:
                matched.append(index)
        transitions = 0
        failed = 0
        for i, (a, b) in enumerate(zip(matched, matched[1:])):
            if a is None or b is None or a == b:
                continue
            transitions += 1
            ea, eb = edges[a], edges[b]
            if not any(
                connected(x, y, max(400, distance(samples[i], samples[i + 1]) * 2.5))
                for x in [ea["from"], ea["to"]]
                for y in [eb["from"], eb["to"]]
            ):
                failed += 1
        valid = sum(i is not None for i in matched)
        confidence = valid / max(1, len(samples)) * (1 - failed / max(1, transitions))
        edge_keys = sorted(
            {
                f"{edges[i]['way']}:{min(edges[i]['from'], edges[i]['to'])}:{max(edges[i]['from'], edges[i]['to'])}"
                for i in matched
                if i is not None
            }
        )
        legal_edges = []
        legal_failures = 0
        history = ()
        previous = None
        previous_sample = None
        for i, index in enumerate(matched):
            if index is None:
                continue
            edge = edges[index]
            before = Point(xy(samples[max(0, i - 1)]))
            after = Point(xy(samples[min(len(samples) - 1, i + 1)]))
            if lines[index].project(after) < lines[index].project(before):
                edge = directed.get((edge["way"], edge["to"], edge["from"]))
            if edge is None:
                legal_failures += 1
                continue
            if previous and edge["id"] == previous["id"]:
                continue
            if previous:
                match = transition(
                    previous,
                    edge,
                    history,
                    max(500, distance(previous_sample, samples[i]) * 2.5),
                )
                if match is None:
                    legal_failures += 1
                    break
                path, history = match
                legal_edges.extend(path)
            else:
                history = (edge["way"],)
                legal_edges.append(edge["id"])
            previous = edge
            previous_sample = samples[i]
        eligible = (
            confidence >= 0.85
            and failed == 0
            and legal_failures == 0
            and len(legal_edges) > 1
        )
        row = {
            **feature["properties"],
            "samples": len(samples),
            "matchedFraction": round(valid / len(samples), 3),
            "ambiguousSamples": ambiguous,
            "failedTransitions": failed,
            "confidence": round(confidence, 3),
            "spatiallyEligible": confidence >= 0.85 and failed == 0,
            "quantitativelyEligible": eligible,
            "legalTransitionFailures": legal_failures,
            "matchedEdgeIds": legal_edges if eligible else [],
            "edgeKeys": edge_keys,
            "anchors": [samples[0], samples[len(samples) // 2], samples[-1]],
        }
        rows.append(row)
        if count % 20 == 0:
            print(f"Audited {count}/{len(selected)} portions", flush=True)
    # Connected components under substantial overlap, including all portions of one activity.
    parent = list(range(len(rows)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    sets = [set(r["edgeKeys"]) for r in rows]
    for i in range(len(rows)):
        for j in range(i):
            overlap = len(sets[i] & sets[j]) / max(1, min(len(sets[i]), len(sets[j])))
            if rows[i]["activityId"] == rows[j]["activityId"] or overlap >= 0.6:
                parent[root(i)] = root(j)
    for i, row in enumerate(rows):
        members = sorted(
            rows[j]["portionId"] for j in range(len(rows)) if root(i) == root(j)
        )
        key = hashlib.sha256("|".join(members).encode()).hexdigest()
        row["group"] = key[:12]
        row["split"] = "evaluation" if int(key[:8], 16) % 5 == 0 else "calibration"
    output = Path("data/derived/matching-report.json")
    output.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "method": "conservative-spatial-audit",
                "sampleSpacingM": 150,
                "maximumGapM": 30,
                "rows": rows,
            },
            separators=(",", ":"),
        )
    )
    print(
        json.dumps(
            {
                "audited": len(rows),
                "spatiallyEligible": sum(r["spatiallyEligible"] for r in rows),
                "quantitativelyEligible": sum(
                    r["quantitativelyEligible"] for r in rows
                ),
                "groups": len({r["group"] for r in rows}),
                "report": str(output),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
