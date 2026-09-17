import unittest

from PIL import Image
from prepare_tracks import distance
from terrain_profile import bilinear_height, slice_profile, structure_grade, way_profile


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

class StructureTests(unittest.TestCase):
    def test_portal_rise_becomes_the_deck_grade(self):
        # A 100 m viaduct climbing 8 m is an 8% deck, sampled across rather than along.
        self.assertAlmostEqual(structure_grade([0,1],{0:400,1:408},100),.08)

    def test_short_deck_spreads_its_rise_over_the_smoothing_window(self):
        # Nine metres of bridge between portals a metre apart is not a 1-in-9 wall; the
        # rise belongs to the approach ramps, so it is damped the way every way is.
        self.assertAlmostEqual(structure_grade([0,1],{0:400,1:401},9),1/80)
        self.assertLess(structure_grade([0,1],{0:400,1:403},5),.05)

    def test_tagged_incline_outranks_the_terrain_model(self):
        self.assertAlmostEqual(structure_grade([0,1],{0:400,1:408},100,'-6%'),-.06)

    def test_unknown_portal_height_reports_no_grade(self):
        self.assertIsNone(structure_grade([0,1],{0:400},100))
        self.assertIsNone(structure_grade([0,1],{},100))
        self.assertIsNone(structure_grade([0,1],{0:400,1:401},0))

    def test_grade_stays_within_the_shared_clamp(self):
        self.assertEqual(structure_grade([0,1],{0:0,1:1000},100),.45)
        self.assertEqual(structure_grade([0,1],{0:1000,1:0},100),-.45)
