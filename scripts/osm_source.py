"""Read a clipped pbf into the element shape the build already understands.

build_region.py was written against Overpass `out geom;` output: a flat list of elements
where ways carry parallel `nodes` and `geometry` arrays and relation members carry their own
`geometry`. This adapter reproduces exactly that shape from a pbf, so the graph construction,
profile features, and restriction handling stay untouched.

Reading is bounded by the caller: `osmium extract --strategy=complete_ways` cuts one cell
plus its halo first, so a file handled here covers roughly the area the pre-grid Geneva build
already managed, rather than the whole release.
"""

import osmium

# Overpass omitted untagged nodes from `out geom` output; only tagged ones were elements.
# Way geometry still needs every node, so locations are resolved separately.


def _tags(obj):
    return {tag.k: tag.v for tag in obj.tags}


def load_elements(path, keep_untagged_nodes=False):
    """Return Overpass-shaped elements: nodes, ways with geometry, relations with members.

    Two passes over the file: the first resolves way geometry from node locations, the
    second attaches way geometry to relation members so multipolygons can be assembled.
    """
    path = str(path)
    nodes = []
    ways = {}
    way_order = []

    processor = osmium.FileProcessor(path).with_locations()
    for obj in processor:
        if obj.is_node():
            tags = _tags(obj)
            if tags or keep_untagged_nodes:
                nodes.append(
                    {
                        "type": "node",
                        "id": obj.id,
                        "lat": obj.location.lat,
                        "lon": obj.location.lon,
                        "tags": tags,
                    }
                )
        elif obj.is_way():
            ids = []
            geometry = []
            for node in obj.nodes:
                ids.append(node.ref)
                # complete_ways should supply every location; mirror Overpass's behaviour of
                # emitting a placeholder rather than dropping the way when one is missing.
                if node.location.valid():
                    geometry.append({"lon": node.location.lon, "lat": node.location.lat})
                else:
                    geometry.append({})
            ways[obj.id] = {
                "type": "way",
                "id": obj.id,
                "tags": _tags(obj),
                "nodes": ids,
                "geometry": geometry,
            }
            way_order.append(obj.id)

    relations = []
    for obj in osmium.FileProcessor(path).with_filter(osmium.filter.EntityFilter(osmium.osm.RELATION)):
        members = []
        for member in obj.members:
            entry = {
                "type": {"n": "node", "w": "way", "r": "relation"}[member.type],
                "ref": member.ref,
                "role": member.role,
            }
            if entry["type"] == "way" and member.ref in ways:
                entry["geometry"] = ways[member.ref]["geometry"]
            members.append(entry)
        relations.append(
            {
                "type": "relation",
                "id": obj.id,
                "tags": _tags(obj),
                "members": members,
            }
        )

    return nodes + [ways[i] for i in way_order] + relations


def counts(elements):
    total = {"node": 0, "way": 0, "relation": 0}
    for element in elements:
        total[element["type"]] += 1
    return total
