import unittest
from PIL import Image
from terrain_profile import bilinear_height, way_profile, slice_profile
from prepare_tracks import distance

class TerrainTests(unittest.TestCase):
    def test_interpolates_pixel_height(self):
        image = Image.new('RGB',(2,2))
        for x in range(2):
            for y in range(2): image.putpixel((x,y),(128,100*x,0))
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

    def test_steep_terrain_is_never_discarded_as_flat(self):
        positions={0:[6,46],1:[6.001,46]}
        _,samples=way_profile([0,1],positions,{0:0,1:100})
        self.assertTrue(all(g==.45 for a,b,g in samples))
        _,missing=way_profile([0,1],positions,{})
        self.assertIsNone(missing)
        _,incline=way_profile([0,1],positions,{},'-15%')
        self.assertEqual(incline[0][2],-.15)
