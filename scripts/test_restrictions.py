import unittest

from match_tracks import restriction_checker


class RestrictionTests(unittest.TestCase):
    def test_only_prefixes_and_unrelated_arrivals(self):
        allowed = restriction_checker([{"ways": ["a", "v1", "v2", "b"], "only": True}])
        previous = {"from": 1, "to": 2}
        for history, required in [(('a',), 'v1'), (('a','v1'), 'v2'), (('a','v1','v2'), 'b')]:
            self.assertFalse(allowed(history, previous, {"way": "exit", "to": 9}))
            self.assertTrue(allowed(history, previous, {"way": required, "to": 9}))
            self.assertTrue(allowed(history, previous, {"way": history[-1], "to": 9}))
        self.assertTrue(allowed(('other','v1'), previous, {"way": "exit", "to": 9}))

    def test_uturns(self):
        previous = {"from": 1, "to": 2}
        for rule, history, way in [
            ({"ways": ["a", "b"], "via": 2}, ('a',), 'b'),
            ({"ways": ["a", "v", "b"]}, ('a','v'), 'b'),
        ]:
            allowed = restriction_checker([{**rule, "only": False, "uTurn": True}])
            self.assertFalse(allowed(history, previous, {"way": way, "to": 3}))
        allowed = restriction_checker([{"ways": ["a", "a"], "via": 2, "only": False, "uTurn": True}])
        self.assertFalse(allowed(('a',), previous, {"way": "a", "to": 1}))
        self.assertTrue(allowed(('a',), previous, {"way": "a", "to": 3}))
