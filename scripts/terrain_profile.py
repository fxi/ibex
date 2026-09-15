"""Continuous way profiles: short topology edges must not become DEM pixel steps."""
from bisect import bisect_right
import math
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


def structure_grade(ids, elevations, length, incline=None):
    """One constant grade across a bridge or tunnel.

    The DEM reads the ground under a deck and the mountain over a bore, so sampling along a
    structure is meaningless — but its portals stand on real ground, so the rise between
    them is the gradient a rider actually climbs. Spreading that rise over at least the
    same 80 m window `way_profile` smooths with is what keeps it honest: the median
    structure is 9 m long, and dividing a metre of DEM noise by 9 m invents a 1-in-9 wall.
    Anything longer than the window keeps its own gradient, so a viaduct stays a viaduct.
    """
    tagged = numeric_incline(incline)
    if tagged is not None:
        return tagged
    if length < 0.1 or any(node not in elevations for node in (ids[0], ids[-1])):
        return None
    rise = elevations[ids[-1]] - elevations[ids[0]]
    return max(-CLAMP, min(CLAMP, rise / max(length, WINDOW)))


def way_profile(ids, positions, elevations, incline=None):
    offsets = [0.0]
    for a, b in zip(ids, ids[1:]):
        offsets.append(offsets[-1] + distance(positions[a], positions[b]))
    length = offsets[-1]
    if length < 0.1:
        return offsets, None
    # Numeric OSM incline applies in the way's coordinate direction.
    tagged = numeric_incline(incline)
    if tagged is not None:
        return offsets, [(0.0, length, tagged)]
    if any(node not in elevations for node in ids):
        return offsets, None

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
