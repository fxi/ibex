"""Continuous way profiles: short topology edges must not become DEM pixel steps."""
import math
from bisect import bisect_right

from prepare_tracks import distance


def bilinear_height(image, px, py):
    # Terrarium RGB values encode height; interpolate decoded heights, not colors.
    x = max(0, min(image.width - 1, px - 0.5))
    y = max(0, min(image.height - 1, py - 0.5))
    x0, y0 = int(x), int(y)
    def height(a, b):
        red, green, blue = image.getpixel((a, b))
        return red * 256 + green + blue / 256 - 32768
    dx, dy = x - x0, y - y0
    x1, y1 = min(x0 + 1, image.width - 1), min(y0 + 1, image.height - 1)
    return ((1-dy) * ((1-dx)*height(x0,y0) + dx*height(x1,y0))
            + dy * ((1-dx)*height(x0,y1) + dx*height(x1,y1)))


# Grades are smoothed over this window so DEM pixel noise does not become a wall.
WINDOW = 80
CLAMP = 0.45


def numeric_incline(incline):
    """The OSM incline tag as a grade, in the way's coordinate direction, or None."""
    try:
        text = (incline or "").strip()
        grade = math.tan(math.radians(float(text[:-1]))) if text.endswith("°") else float(text.rstrip("%")) / 100
    except ValueError:
        return None
    return max(-CLAMP, min(CLAMP, grade)) if math.isfinite(grade) else None


def structure_grade(incline=None):
    """One constant grade across a bridge or tunnel.

    A DEM sees the valley below a bridge and the mountain above a tunnel, including at
    portals that fall inside the same coarse terrain pixel. Only an explicit numeric OSM
    incline can describe the structure itself; without one, flat is the safe routing
    model.
    """
    tagged = numeric_incline(incline)
    return tagged if tagged is not None else 0.0


def way_profile(ids, positions, elevations, incline=None):
    offsets = [0.0]
    for a, b in zip(ids, ids[1:]):
        offsets.append(offsets[-1] + distance(positions[a], positions[b]))
    length = offsets[-1]
    if length < 0.1:
        return offsets, None
    # Numeric incline tags are often unsigned steepness in practice. Where the DEM can
    # describe the road, prefer its direction and shape; keep the tag only as a fallback
    # for missing terrain.
    if any(node not in elevations for node in ids):
        tagged = numeric_incline(incline)
        return offsets, [(0.0, length, tagged)] if tagged is not None else None

    def height(at):
        index = min(len(ids)-2, max(0, bisect_right(offsets, at)-1))
        span = offsets[index+1]-offsets[index]
        t = (at-offsets[index])/span if span else 0
        return elevations[ids[index]]*(1-t) + elevations[ids[index+1]]*t

    samples = []
    start = 0.0
    while start < length:
        end = min(length, start+20)
        middle = (start+end)/2
        # Shift the full window at way ends instead of creating a tiny tail.
        low = max(0, min(length-WINDOW, middle-WINDOW/2))
        high = min(length, low+WINDOW)
        # A way shorter than the window spreads its rise over the window, as a structure
        # does: dividing 4 m of DEM noise at a tunnel portal by a 12 m way invented a 31%
        # wall that, on a `foot=no` road, deleted the edge and closed the Col de Rousset.
        grade = (height(high)-height(low))/max(high-low, WINDOW)
        samples.append((start, end, max(-CLAMP, min(CLAMP, grade))))
        start = end
    return offsets, samples


def slice_profile(samples, start, end):
    if samples is None:
        return None
    # Start near the selected edge, avoiding a scan of every sample on long ways.
    first = max(0, bisect_right(samples, (start, float('inf'), float('inf')))-1)
    result = []
    for a, b, grade in samples[first:]:
        if a >= end:
            break
        meters = min(end,b)-max(start,a)
        if meters > 0.001:
            result.append([round(meters, 3), round(grade, 5)])
    return result or None
