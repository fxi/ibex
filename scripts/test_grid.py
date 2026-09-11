"""Assert scripts/grid.py matches src/geo/grid.ts via the shared vector fixture."""

import json
import math
import unittest
from pathlib import Path

from grid import (
    cell_bbox,
    cell_id,
    cell_size_m,
    cells_in_bbox,
    child_cells,
    lat_of_mercator,
    lon_of_mercator,
    mercator_x,
    mercator_y,
    parent_cell,
    parse_cell_id,
    tile_of,
    union_bbox,
)

VECTORS = json.loads(
    (Path(__file__).resolve().parent.parent / "tests/fixtures/grid-vectors.json").read_text()
)


class TestSharedVectors(unittest.TestCase):
    """The TypeScript implementation is canonical; these vectors are generated from it."""

    def test_mercator_projection_matches(self):
        for case in VECTORS["mercator"]:
            lon, lat = case["point"]
            self.assertAlmostEqual(mercator_x(lon), case["x"], places=12)
            self.assertAlmostEqual(mercator_y(lat), case["y"], places=12)
            self.assertAlmostEqual(lon_of_mercator(mercator_x(lon)), case["lon"], places=10)
            self.assertAlmostEqual(lat_of_mercator(mercator_y(lat)), case["lat"], places=10)

    def test_tile_lookup_matches(self):
        for case in VECTORS["tileOf"]:
            x, y = tile_of(case["point"], case["zoom"])
            self.assertEqual(cell_id(case["zoom"], x, y), case["id"], case)

    def test_cell_bounds_match(self):
        for case in VECTORS["bounds"]:
            zoom, x, y = parse_cell_id(case["id"])
            for got, want in zip(cell_bbox(zoom, x, y), case["bbox"]):
                self.assertAlmostEqual(got, want, places=10)
            self.assertAlmostEqual(cell_size_m(zoom, x, y), case["sizeM"], places=3)

    def test_bbox_coverage_matches(self):
        for case in VECTORS["cellsInBBox"]:
            cells = cells_in_bbox(case["bbox"], case["zoom"])
            if "ids" in case:
                self.assertEqual(
                    [cell_id(case["zoom"], x, y) for x, y in cells], case["ids"], case
                )
            else:
                self.assertEqual(len(cells), case["count"], case)

    def test_release_window_matches(self):
        bbox = union_bbox([cell_bbox(*parse_cell_id(i)) for i in VECTORS["release"]["ids"]])
        cells = cells_in_bbox(bbox, 9)
        self.assertEqual([cell_id(9, x, y) for x, y in cells], VECTORS["release"]["ids"])
        self.assertEqual(len(cells), 16)

    def test_hierarchy_matches(self):
        for case in VECTORS["hierarchy"]:
            zoom, x, y = parse_cell_id(case["id"])
            blocks = child_cells(zoom, x, y, case["blockZoom"])
            self.assertEqual(len(blocks), case["blockCount"])
            self.assertEqual(cell_id(case["blockZoom"], *blocks[0]), case["firstBlock"])
            self.assertEqual(cell_id(case["blockZoom"], *blocks[-1]), case["lastBlock"])
            self.assertEqual(
                cell_id(case["parentZoom"], *parent_cell(case["blockZoom"], *blocks[0], zoom)),
                case["parentOfFirstBlock"],
            )

    def test_neighbours_match(self):
        for case in VECTORS["neighbours"]:
            zoom, x, y = parse_cell_id(case["id"])
            got = []
            n = 2**zoom
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if not dx and not dy:
                        continue
                    ny = y + dy
                    if 0 <= ny < n:
                        got.append(cell_id(zoom, (x + dx) % n, ny))
            self.assertEqual(got, case["ids"], case)


class TestInvariants(unittest.TestCase):
    def test_cell_ids_satisfy_the_manifest_id_pattern(self):
        for case in VECTORS["release"]["ids"]:
            self.assertRegex(case, r"^[a-z0-9-]+$")

    def test_rejects_malformed_ids(self):
        for bad in ["", "9/264/181", "9-264", "a-b-c", "9-264-181-2", "2-4-0"]:
            with self.assertRaises(ValueError):
                parse_cell_id(bad)

    def test_refuses_an_inverted_hierarchy(self):
        with self.assertRaises(ValueError):
            child_cells(13, 0, 0, 9)
        with self.assertRaises(ValueError):
            parent_cell(9, 0, 0, 13)

    def test_latitude_is_clamped_at_the_mercator_cut_off(self):
        self.assertTrue(math.isfinite(mercator_y(90)))
        self.assertEqual(tile_of([0, 89.9], 9)[1], 0)
        self.assertEqual(tile_of([0, -89.9], 9)[1], 2**9 - 1)

    def test_a_cell_bbox_maps_back_to_exactly_that_cell(self):
        """The floating-point boundary case that a naive floor/ceil gets wrong."""
        for zoom, x, y in [(9, 263, 180), (9, 266, 183), (13, 4235, 2907)]:
            self.assertEqual(cells_in_bbox(cell_bbox(zoom, x, y), zoom), [(x, y)])


if __name__ == "__main__":
    unittest.main()
