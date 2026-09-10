import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from build_region import build
from prepare_tracks import distance
from profile_features import cycling_memberships, duration_seconds, ferry_ways, on_cycling_network, urban_fraction, urban_index


def way(id, nodes, coords, tags):
    return {"type": "way", "id": id, "nodes": nodes, "geometry": [{"lon": x, "lat": y} for x, y in coords], "tags": tags}


class ProfileFeaturesTests(unittest.TestCase):
    def test_urban_polygons_and_village_fallback(self):
        area = way(1, [1, 2, 3, 4, 1], [(6, 46), (6.01, 46), (6.01, 46.01), (6, 46.01), (6, 46)], {"landuse": "residential"})
        index = urban_index([area, {"type": "node", "id": 8, "lon": 6.05, "lat": 46.05, "tags": {"place": "village"}}])
        self.assertEqual(urban_fraction([(6.001, 46.005), (6.009, 46.005)], {}, index), 1)
        self.assertEqual(urban_fraction([(6.02, 46.02), (6.03, 46.02)], {}, index), 0)
        self.assertGreater(urban_fraction([(6.049, 46.05), (6.051, 46.05)], {}, index), 0.9)

    def test_network_roles_and_proposals(self):
        relation = {"type": "relation", "id": 2, "tags": {"type": "route", "route": "bicycle", "network": "rcn"}, "members": [{"type": "way", "ref": 3, "role": "forward"}]}
        memberships = cycling_memberships([relation])
        road = {"id": 3, "tags": {}}
        self.assertEqual(on_cycling_network(road, "forward", memberships), 1)
        self.assertEqual(on_cycling_network(road, "backward", memberships), 0)
        relation["tags"]["state"] = "proposed"
        self.assertFalse(cycling_memberships([relation])[3])

    def test_ferry_duration_and_access_inheritance(self):
        water = way(1, [1, 2], [(6, 46), (6.01, 46)], {})
        approach = way(2, [2, 3], [(6.01, 46), (6.02, 46)], {"highway": "service"})
        relation = {"type": "relation", "id": 9, "tags": {"route": "ferry", "bicycle": "yes", "duration": "00:10"}, "members": [{"type": "way", "ref": id, "role": ""} for id in [1, 2]]}
        ferries = ferry_ways([water, approach, relation], distance)
        self.assertEqual(ferries[1][0]["bicycle"], "yes")
        self.assertEqual(ferries[1][2], 600)
        self.assertNotIn(2, ferries)
        self.assertEqual(duration_seconds("10"), 600)
        self.assertEqual(duration_seconds("1:15"), 4500)
        self.assertIsNone(duration_seconds("unknown"))

    def test_builder_preserves_connected_steps_ferry_and_features(self):
        coords = [(6.1, 46.1), (6.101, 46.1), (6.102, 46.1), (6.103, 46.1)]
        elements = [
            way(1, [1, 2], coords[:2], {"highway": "residential", "surface": "asphalt"}),
            way(2, [2, 3], coords[1:3], {"highway": "steps"}),
            way(3, [3, 4], coords[2:], {"route": "ferry", "bicycle": "yes", "duration": "00:05"}),
            {"type": "relation", "id": 10, "tags": {"type": "route", "route": "bicycle", "network": "lcn"}, "members": [{"type": "way", "ref": 1, "role": ""}]},
        ]
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            source, output = Path(tmp) / "source.json", Path(tmp) / "build"
            source.write_text(json.dumps({"elements": elements}))
            build(source, output, terrain=False)
            graph = json.loads((output / "graph.json").read_text())
            manifest = json.loads((output / "manifest.json").read_text())
        self.assertEqual(manifest["costModelVersion"], 4)
        self.assertEqual(len(graph["edges"]), 6)
        road = next(e for e in graph["edges"] if e["way"] == "1")
        stair = next(e for e in graph["edges"] if e["way"] == "2")
        ferry = next(e for e in graph["edges"] if e["way"] == "3")
        self.assertEqual(road["to"], stair["from"])
        self.assertEqual(stair["to"], ferry["from"])
        self.assertEqual(road["urban"], 1)
        self.assertEqual(road["cyclingNetwork"], 1)
        self.assertEqual(ferry["highway"], "ferry")
        self.assertIsNone(ferry["grades"])
        self.assertAlmostEqual(ferry["ferrySeconds"], 300, places=2)


if __name__ == "__main__":
    unittest.main()
