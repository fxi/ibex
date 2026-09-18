"""The per-edge enrichment passes: network utility, junction severity, reward potential.

These ran inside a 580-line `build()` and had no direct test — `test_profile_features.py`
calls `build()` end to end but asserts nothing about any of the three values. Extracting
them made each one statable on a graph small enough to reason about by hand.
"""

import math
import unittest

from build_region import junction_severity, network_utility, reward_potential


def edge(
    id,
    frm,
    to,
    length=100.0,
    highway="residential",
    stress=0.1,
    quality=0.0,
    forest=0.0,
    way=None,
):
    return {
        "id": id,
        "from": frm,
        "to": to,
        "way": str(way if way is not None else id),
        "length": length,
        "highway": highway,
        "stress": stress,
        "quality": quality,
        "forest": forest,
        "geometry": [[6.1, 46.1], [6.101, 46.1]],
    }


class NetworkUtility(unittest.TestCase):
    def test_an_isolated_node_reaches_nothing(self):
        self.assertEqual(network_utility([], {1}), {1: 0.0})

    def test_more_reachable_low_stress_length_scores_higher(self):
        # A chain of four 200 m ways against a single one, from the same origin.
        long_chain = [edge(i, i, i + 1, length=200.0) for i in range(1, 5)]
        short = [edge(1, 1, 2, length=200.0)]
        nodes = {1}
        self.assertGreater(
            network_utility(long_chain, nodes)[1], network_utility(short, nodes)[1]
        )

    def test_stressful_and_unrideable_ways_are_not_network(self):
        # Above the stress cut, and steps: neither counts towards a low-stress network.
        for variant in (
            [edge(1, 1, 2, stress=0.9)],
            [edge(1, 1, 2, highway="steps")],
            [edge(1, 1, 2, highway="ferry")],
        ):
            self.assertEqual(network_utility(variant, {1})[1], 0.0)

    def test_counts_one_segment_once_however_many_directions_it_has(self):
        """A two-way street is one piece of network, not two.

        The dedup key is (way, unordered node pair), so it is the physical *segment* that is
        counted once — segments of one long way each count on their own.
        """
        both = [
            edge(1, 1, 2, length=200.0, way=10),
            edge(2, 2, 1, length=200.0, way=10),
        ]
        one = [edge(1, 1, 2, length=200.0, way=10)]
        self.assertEqual(network_utility(both, {1})[1], network_utility(one, {1})[1])

    def test_stays_within_the_one_kilometre_bound(self):
        # 1.2 km of chain, of which only the first kilometre can count.
        near = [edge(i, i, i + 1, length=100.0) for i in range(1, 13)]
        far = near + [edge(i, i, i + 1, length=100.0) for i in range(13, 40)]
        self.assertEqual(network_utility(near, {1})[1], network_utility(far, {1})[1])


class JunctionSeverity(unittest.TestCase):
    def test_a_through_node_is_not_a_junction(self):
        # Two ways meeting is a way split, not an intersection.
        through = [edge(1, 1, 2), edge(2, 2, 3)]
        self.assertEqual(junction_severity(through, {2})[2], 0.0)

    def test_severity_rises_with_converging_ways(self):
        few = [edge(1, 1, 2), edge(2, 2, 3), edge(3, 4, 2)]
        many = few + [edge(4, 5, 2), edge(5, 6, 2), edge(6, 7, 2)]
        self.assertGreater(
            junction_severity(many, {2})[2], junction_severity(few, {2})[2]
        )

    def test_the_busiest_class_at_the_node_decides(self):
        def at(highway):
            edges = [edge(i, i, 2, highway=highway) for i in range(3, 8)]
            return junction_severity(edges, {2})[2]

        self.assertGreater(at("primary"), at("residential"))
        self.assertGreater(at("residential"), at("living_street"))
        # A cycleway crossing is not a traffic junction at all.
        self.assertEqual(at("cycleway"), 0.0)

    def test_never_leaves_the_unit_range(self):
        crowded = [edge(i, i, 2, highway="primary") for i in range(3, 30)]
        self.assertLessEqual(junction_severity(crowded, {2})[2], 1.0)


class RewardPotential(unittest.TestCase):
    def test_nothing_worth_riding_to_means_no_reward(self):
        self.assertEqual(reward_potential([edge(1, 1, 2)], {}), {})

    def test_an_attractor_rewards_the_nodes_that_lead_to_it(self):
        # Golden gravel at the far end of a chain, riding 1 -> 2 -> 3.
        edges = [edge(1, 1, 2), edge(2, 2, 3, quality=0.9)]
        reward = reward_potential(edges, {})
        self.assertGreater(reward[2], 0)
        # Decays with distance from the attractor, so earlier nodes are worth less.
        self.assertGreater(reward[2], reward[1])

    def test_a_stronger_source_is_worth_more_at_the_same_place(self):
        gravel = reward_potential([edge(1, 1, 2, quality=0.9)], {})
        forest = reward_potential([edge(1, 1, 2, forest=0.9)], {})
        self.assertGreater(gravel[1], forest[1])

    def test_rides_the_allowed_direction_only(self):
        """Reward flows backwards along legal travel, to nodes that can still reach it.

        Both ends of the attractor edge are seeded — standing on it, the reward is here —
        and from there it propagates over the reversed graph. So a node upstream of the
        source earns it, and a node only reachable *after* the source does not.
        """
        edges = [edge(1, 1, 2), edge(2, 2, 3, quality=0.9), edge(3, 3, 4)]
        reward = reward_potential(edges, {})
        self.assertIn(1, reward)
        self.assertNotIn(4, reward)

    def test_falls_away_past_the_horizon(self):
        # Far enough back that the decay drops below the floor the pass keeps.
        chain = [edge(i, i, i + 1, length=500.0) for i in range(1, 12)]
        chain.append(edge(99, 12, 13, quality=1.0))
        reward = reward_potential(chain, {})
        self.assertIn(12, reward)
        self.assertNotIn(1, reward)
        # Everything kept is a decayed strength, never above one.
        self.assertTrue(all(0 < v <= 1 for v in reward.values()))

    def test_decay_follows_the_documented_time_constant(self):
        edges = [edge(1, 1, 2, length=600.0), edge(2, 2, 3, quality=0.9)]
        reward = reward_potential(edges, {})
        # Golden gravel is a 0.7-strength source, and node 1 is one tau (600 m) behind it,
        # so the value is that strength decayed by e.
        self.assertAlmostEqual(reward[1], round(0.7 * math.exp(-1), 3), places=3)
        self.assertAlmostEqual(reward[2], 0.7, places=3)


if __name__ == "__main__":
    unittest.main()
