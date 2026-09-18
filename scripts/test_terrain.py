import unittest

from PIL import Image
from prepare_tracks import distance
from terrain_profile import (
    CLAMP,
    bilinear_height,
    slice_profile,
    structure_grade,
    way_profile,
)


class TerrainTests(unittest.TestCase):
    def test_interpolates_pixel_height(self):
        image = Image.new('RGB',(2,2))
        for x in range(2):
            for y in range(2):
                image.putpixel((x,y),(128,100*x,0))
        self.assertAlmostEqual(bilinear_height(image,1,1),50)

    def test_short_split_edges_do_not_create_grade_spikes(self):
        ids=list(range(21))
        positions={i:[6+i*.0001,46] for i in ids}
        step=distance(positions[0],positions[1])
        # Stairs in nearest-pixel DEM data on a uniformly rising road.
        elevations={i:round(i*step*.1/2)*2 for i in ids}
        offsets,samples=way_profile(ids,positions,elevations)
        self.assertTrue(all(.07 < grade < .13 for _,_,grade in samples))
        sliced=[v for i in range(20) for v in slice_profile(samples,offsets[i],offsets[i+1])]
        self.assertAlmostEqual(sum(m for m,g in sliced), offsets[-1], places=1)
        self.assertLess(max(g for m,g in sliced),.13)

    def test_short_way_spreads_its_rise_over_the_smoothing_window(self):
        # D518 just past the Rousset tunnel's north portal: a 12 m way reading a 3.75 m drop.
        positions={0:[5.4054252,44.8403589],1:[5.405566,44.8403991]}
        _,samples=way_profile([0,1],positions,{0:1252.72,1:1248.97})
        self.assertTrue(all(-.05 < g < 0 for a,b,g in samples))

    def test_steep_terrain_is_never_discarded_as_flat(self):
        positions={0:[6,46],1:[6.001,46]}
        _,samples=way_profile([0,1],positions,{0:0,1:100})
        self.assertTrue(all(g==.45 for a,b,g in samples))
        _,missing=way_profile([0,1],positions,{})
        self.assertIsNone(missing)
        _,incline=way_profile([0,1],positions,{},'-15%')
        self.assertEqual(incline[0][2],-.15)

    def test_sampled_terrain_outranks_a_mis_signed_incline(self):
        # Chemin des Voirons drops 158 m in the way's node order, despite incline=20%.
        positions={0:[6.3513801,46.2076049],1:[6.3486891,46.2117206]}
        _,samples=way_profile([0,1],positions,{0:1380.5,1:1222.6},'20%')
        self.assertTrue(all(g < 0 for _,_,g in samples))
        rise=sum((b-a)*g for a,b,g in samples)
        self.assertAlmostEqual(rise,-157.9,delta=8)

    def test_incline_still_fills_a_terrain_hole(self):
        positions={0:[6,46],1:[6.001,46]}
        _,samples=way_profile([0,1],positions,{0:100},'12%')
        self.assertEqual(samples,[(0.0,distance(positions[0],positions[1]),.12)])

class StructureTests(unittest.TestCase):
    def test_untagged_structure_is_flat(self):
        self.assertEqual(structure_grade(), 0)
        self.assertEqual(structure_grade("unknown"), 0)

    def test_numeric_incline_describes_the_structure(self):
        self.assertAlmostEqual(structure_grade("-6%"), -.06)
        self.assertEqual(structure_grade("100%"), CLAMP)
