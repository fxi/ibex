"""Web Mercator XYZ grid maths, mirroring src/geo/grid.ts. Keep both in step."""

import math

# Web Mercator cannot represent the poles; this is the standard cut-off.
MAX_LATITUDE = 85.0511287798066
MAX_ZOOM = 24
EPSILON = 1e-9


def _check_zoom(zoom):
    if not isinstance(zoom, int) or zoom < 0 or zoom > MAX_ZOOM:
        raise ValueError(f"Invalid grid zoom: {zoom}")
    return zoom


def mercator_x(lon):
    return (lon + 180) / 360


def mercator_y(lat):
    clamped = max(-MAX_LATITUDE, min(MAX_LATITUDE, lat))
    return (1 - math.asinh(math.tan(math.radians(clamped))) / math.pi) / 2


def lon_of_mercator(x):
    return x * 360 - 180


def lat_of_mercator(y):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y))))


def _clamp_x(x, zoom):
    n = 2**zoom
    return int(math.floor(x)) % n


def _clamp_y(y, zoom):
    return max(0, min(2**zoom - 1, int(math.floor(y))))


def tile_of(point, zoom):
    """Cell containing a [lon, lat] point. Wraps in x, clamps in y."""
    n = 2 ** _check_zoom(zoom)
    return (
        _clamp_x(mercator_x(point[0]) * n, zoom),
        _clamp_y(mercator_y(point[1]) * n, zoom),
    )


def cell_id(zoom, x, y):
    """Hyphenated so ids satisfy the pack manifest id pattern."""
    return f"{_check_zoom(zoom)}-{x}-{y}"


def parse_cell_id(value):
    parts = value.split("-")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise ValueError(f"Invalid cell id: {value}")
    zoom, x, y = (int(p) for p in parts)
    _check_zoom(zoom)
    if x >= 2**zoom or y >= 2**zoom:
        raise ValueError(f"Cell outside zoom {zoom}: {value}")
    return zoom, x, y


def cell_bbox(zoom, x, y):
    """[west, south, east, north] for one cell."""
    n = 2 ** _check_zoom(zoom)
    return [
        lon_of_mercator(x / n),
        lat_of_mercator((y + 1) / n),
        lon_of_mercator((x + 1) / n),
        lat_of_mercator(y / n),
    ]


def cells_in_bbox(bbox, zoom):
    """A bbox edge on an exact tile boundary belongs to the tile it closes."""
    n = 2 ** _check_zoom(zoom)
    west, south, east, north = bbox
    x0 = _clamp_x(mercator_x(west) * n + EPSILON, zoom)
    y0 = _clamp_y(mercator_y(north) * n + EPSILON, zoom)
    x1 = max(x0, _clamp_x(math.ceil(mercator_x(east) * n - EPSILON) - 1, zoom))
    y1 = max(y0, _clamp_y(math.ceil(mercator_y(south) * n - EPSILON) - 1, zoom))
    return [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


def child_cells(zoom, x, y, child_zoom):
    if _check_zoom(child_zoom) < _check_zoom(zoom):
        raise ValueError(f"Zoom {child_zoom} is coarser than cell zoom {zoom}")
    factor = 2 ** (child_zoom - zoom)
    return [
        (x * factor + dx, y * factor + dy)
        for dy in range(factor)
        for dx in range(factor)
    ]


def parent_cell(zoom, x, y, parent_zoom):
    if _check_zoom(parent_zoom) > _check_zoom(zoom):
        raise ValueError(f"Zoom {parent_zoom} is finer than cell zoom {zoom}")
    factor = 2 ** (zoom - parent_zoom)
    return x // factor, y // factor


def union_bbox(boxes):
    if not boxes:
        raise ValueError("Cannot union an empty bbox list")
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def cell_size_m(zoom, x, y):
    """Nominal ground size at the cell's centre latitude, for size reporting."""
    _, south, _, north = cell_bbox(zoom, x, y)
    return 40075016.686 * math.cos(math.radians((south + north) / 2)) / 2**zoom
