#!/usr/bin/env python3
"""Calibrate DCP map pictures to real coordinates, so the app can draw a property on them.

    python scripts/calibrate_maps.py <overlay_dir> [map_id,map_id,...]   (only those maps; others kept from the last run)

Writes src/lib/server/dcp_maps.json: for each map, an affine transform from (lon, lat) to pixel on the rendered page
(data/hornsby/pages/pNNNN.png, 150 dpi):  x = ax * lon + cx,   y = by * lat + dy   (north up, no rotation).

Two methods:
  outline   the map draws an area whose boundary NSW publishes (heritage conservation areas). The NSW polygon is fitted
            onto the coloured outline in the picture by searching scale and position for the best overlap.
  points    the boundary exists only in the DCP. The transform is fitted (least squares) to control points: pixel
            positions of street intersections read off the picture, paired with intersection coordinates computed from
            NSW road centrelines.

For every map it also writes <overlay_dir>/pNNNN_<id>.png: the picture with NSW road centrelines drawn over it in blue,
so a person can check by eye that the calibration is right (roads must run along the streets).

Needs Pillow. Uses the NSW ArcGIS services over HTTPS (no key).
"""
import json
import math
import os
import sys
import urllib.parse
import urllib.request

from PIL import Image, ImageChops, ImageDraw, ImageFilter

PAGES = 'data/hornsby/pages'
OUT = 'src/lib/server/dcp_maps.json'
EPI0 = 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/EPI_Primary_Planning_Layers/MapServer/0/query'
ROADS = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Transport_Theme/FeatureServer/5/query'
M_PER_DEG_LAT = 110574.0


def arcgis(url, params):
    q = urllib.parse.urlencode({'f': 'json', **params})
    req = urllib.request.Request(url, data=q.encode(), headers={'content-type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    if 'error' in d:
        raise RuntimeError(f'{url}: {d["error"]}')
    return d


def hca_rings(hids):
    ids = ','.join(f"'{h}'" for h in hids)
    d = arcgis(EPI0, {'where': f"EPI_NAME='Hornsby Local Environmental Plan 2013' AND H_ID IN ({ids}) AND LAY_CLASS LIKE 'Conservation Area%'",
                      'outFields': 'H_NAME', 'returnGeometry': 'true', 'outSR': 4326})
    rings = [ring for f in d['features'] for ring in f['geometry']['rings']]
    if not rings:
        raise RuntimeError(f'no NSW polygon for {hids}')
    return rings, sorted({f['attributes']['H_NAME'] for f in d['features']})


def roads_in(bbox):
    lon0, lat0, lon1, lat1 = bbox
    d = arcgis(ROADS, {'where': '1=1', 'geometry': f'{lon0},{lat0},{lon1},{lat1}', 'geometryType': 'esriGeometryEnvelope',
                       'inSR': 4326, 'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'roadnamebase,roadnametype',
                       'returnGeometry': 'true', 'outSR': 4326, 'resultRecordCount': 2000})
    return [p for f in d['features'] for p in f['geometry']['paths']]


LOTS = 'https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Land_Parcel_Property_Theme_multiCRS/FeatureServer/8/query'


def lots_in(bbox):
    lon0, lat0, lon1, lat1 = bbox
    rings, offset = [], 0
    while True:
        d = arcgis(LOTS, {'where': '1=1', 'geometry': f'{lon0},{lat0},{lon1},{lat1}', 'geometryType': 'esriGeometryEnvelope',
                          'inSR': 4326, 'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'objectid', 'returnGeometry': 'true',
                          'outSR': 4326, 'resultOffset': offset, 'resultRecordCount': 1000})
        rings += [r for f in d['features'] for r in f['geometry'].get('rings', [])]
        if not d.get('exceededTransferLimit') or not d['features']:
            return rings
        offset += len(d['features'])


def road_paths(name, kind, near, radius_deg=0.02):
    lon, lat = near
    kind_sql = f"roadnametype='{kind}'" if kind else 'roadnametype IS NULL'
    d = arcgis(ROADS, {'where': f"roadnamebase='{name}' AND {kind_sql}",
                       'geometry': f'{lon - radius_deg},{lat - radius_deg},{lon + radius_deg},{lat + radius_deg}',
                       'geometryType': 'esriGeometryEnvelope', 'inSR': 4326, 'spatialRel': 'esriSpatialRelIntersects',
                       'outFields': 'roadnamebase', 'returnGeometry': 'true', 'outSR': 4326})
    paths = [p for f in d['features'] for p in f['geometry']['paths']]
    if not paths:
        raise RuntimeError(f'no road {name} {kind} near {near}')
    return paths


def intersection(a, b, near, radius_deg=0.02):
    """Coordinates where two named roads meet: the closest pair of vertices (roads share a vertex at a junction)."""
    pa = [pt for p in road_paths(*a, near, radius_deg) for pt in p]
    pb = [pt for p in road_paths(*b, near, radius_deg) for pt in p]
    k = math.cos(math.radians(near[1]))
    best = min(((x, y) for x in pa for y in pb), key=lambda xy: ((xy[0][0] - xy[1][0]) * k) ** 2 + (xy[0][1] - xy[1][1]) ** 2)
    gap_m = math.hypot((best[0][0] - best[1][0]) * k * 111320, (best[0][1] - best[1][1]) * M_PER_DEG_LAT)
    if gap_m > 15:
        raise RuntimeError(f'{a} and {b} do not meet near {near} (closest {gap_m:.0f} m)')
    return ((best[0][0] + best[1][0]) / 2, (best[0][1] + best[1][1]) / 2)


def transform_from(s, tx, ty, lonc, latc):
    """pixel = s * metres from (lonc, latc), north up; returns the lon/lat affine form."""
    ax = s * 111320 * math.cos(math.radians(latc))
    by = -s * M_PER_DEG_LAT
    return {'ax': ax, 'cx': tx - ax * lonc, 'by': by, 'dy': ty - by * latc}


def to_px(t, lon, lat):
    """General affine; bx and ay are 0 for north-up maps and only present for rotated ones."""
    return t['ax'] * lon + t.get('bx', 0) * lat + t['cx'], t.get('ay', 0) * lon + t['by'] * lat + t['dy']


def from_px(t, x, y):
    a, b, c, d = t['ax'], t.get('bx', 0), t.get('ay', 0), t['by']
    det = a * d - b * c
    u, v = x - t['cx'], y - t['dy']
    return (d * u - b * v) / det, (-c * u + a * v) / det


def densify(rings, step_deg):
    pts = []
    for ring in rings:
        for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
            n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step_deg))
            pts += [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n)]
    return pts


def colour_mask(img, frame, colour, exclude=()):
    """Pixels of the outline colour inside the map frame (minus legend boxes), thickened by 2 px for line width."""
    x0, y0, x1, y1 = frame
    m = Image.new('L', img.size, 0)
    px, mp = img.load(), m.load()
    for y in range(y0, y1):
        for x in range(x0, x1):
            if any(e[0] <= x < e[2] and e[1] <= y < e[3] for e in exclude):
                continue
            r, g, b = px[x, y]
            if (colour == 'red' and r > 140 and r - max(g, b) > 60) or (colour == 'black' and max(r, g, b) < 80)                     or (colour == 'black_or_blue' and (max(r, g, b) < 80 or (b > 150 and b - max(r, g) > 70))):
                mp[x, y] = 255
    return m.filter(ImageFilter.MaxFilter(5))


def fit_outline(img, frame, rings, colour, exclude=(), points=None):
    """rings: NSW polygon rings. points: instead of rings, any (lon, lat) points that lie on the drawn outline."""
    mask = colour_mask(img, frame, colour, exclude)
    mp = mask.load()
    W, H = img.size
    lons = [p[0] for p in points] if points else [p[0] for r in rings for p in r]
    lats = [p[1] for p in points] if points else [p[1] for r in rings for p in r]
    lonc, latc = (min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2
    box = mask.getbbox()
    w_m = (max(lons) - min(lons)) * 111320 * math.cos(math.radians(latc))
    h_m = (max(lats) - min(lats)) * M_PER_DEG_LAT
    s0 = min((box[2] - box[0]) / w_m, (box[3] - box[1]) / h_m)
    cx0, cy0 = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2

    def score(pts, s, tx, ty):
        t = transform_from(s, tx, ty, lonc, latc)
        hit = 0
        for lon, lat in pts:
            x, y = to_px(t, lon, lat)
            if 0 <= x < W and 0 <= y < H and mp[int(x), int(y)]:
                hit += 1
        return hit / len(pts)

    if points:
        coarse, fine = points[::max(1, len(points) // 600)], points[::max(1, len(points) // 3000)]
    else:
        coarse = densify(rings, (max(lons) - min(lons) + max(lats) - min(lats)) / 400)[::2]
        fine = densify(rings, (max(lons) - min(lons) + max(lats) - min(lats)) / 1500)
    best = (-1, s0, cx0, cy0)
    for ks in [0.80 + 0.02 * i for i in range(26)]:
        for dx in range(-120, 121, 10):
            for dy in range(-120, 121, 10):
                sc = score(coarse, s0 * ks, cx0 + dx, cy0 + dy)
                if sc > best[0]:
                    best = (sc, s0 * ks, cx0 + dx, cy0 + dy)
    _, s1, tx1, ty1 = best
    best = (-1, s1, tx1, ty1)
    for ks in [0.97 + 0.003 * i for i in range(21)]:
        for dx in range(-12, 13, 2):
            for dy in range(-12, 13, 2):
                sc = score(fine, s1 * ks, tx1 + dx, ty1 + dy)
                if sc > best[0]:
                    best = (sc, s1 * ks, tx1 + dx, ty1 + dy)
    sc, s, tx, ty = best
    return transform_from(s, tx, ty, lonc, latc), {'outline_on_colour': round(sc, 3), 'metres_per_px': round(1 / s, 2)}


def outline_points_from(ref, ref_img):
    """(lon, lat) of the black outline pixels of an already calibrated map (e.g. the Town Centre site boundary)."""
    t = ref['transform']
    x0, y0, x1, y1 = ref['frame']
    px = ref_img.load()
    pts = []
    for y in range(y0, y1, 2):
        for x in range(x0, x1, 2):
            if any(e[0] <= x < e[2] and e[1] <= y < e[3] for e in ref.get('exclude', [])):
                continue
            if max(px[x, y]) < 60:
                pts.append(from_px(t, x, y))
    return pts


def fit_points(points):
    """Least squares for scale + translation (north up) from [(px, py, lon, lat), ...]."""
    latc = sum(p[3] for p in points) / len(points)
    lonc = sum(p[2] for p in points) / len(points)
    kx = 111320 * math.cos(math.radians(latc))
    X = [(p[2] - lonc) * kx for p in points]
    Y = [-(p[3] - latc) * M_PER_DEG_LAT for p in points]
    px = [p[0] for p in points]
    py = [p[1] for p in points]
    mx, my, mpx, mpy = sum(X) / len(X), sum(Y) / len(Y), sum(px) / len(px), sum(py) / len(py)
    num = sum((X[i] - mx) * (px[i] - mpx) + (Y[i] - my) * (py[i] - mpy) for i in range(len(X)))
    den = sum((X[i] - mx) ** 2 + (Y[i] - my) ** 2 for i in range(len(X)))
    s = num / den
    tx, ty = mpx - s * mx, mpy - s * my
    t = transform_from(s, tx, ty, lonc, latc)
    res = [math.hypot(to_px(t, p[2], p[3])[0] - p[0], to_px(t, p[2], p[3])[1] - p[1]) for p in points]
    return t, {'points': len(points), 'rms_px': round(math.sqrt(sum(r * r for r in res) / len(res)), 1),
               'max_px': round(max(res), 1), 'metres_per_px': round(1 / s, 2)}


def line_mask(img, frame, exclude=()):
    """Drawn lines (lot boundaries, outlines) inside the frame, by local contrast: a pixel at least 5 grey levels darker
    than the lightest pixel around it. Works for the very pale lot lines (about 247 on a 255 page) of some maps."""
    grey = img.convert('L')
    lines = ImageChops.subtract(grey.filter(ImageFilter.MaxFilter(5)), grey).point(lambda v: 255 if v >= 5 else 0)
    keep = Image.new('L', img.size, 0)
    d = ImageDraw.Draw(keep)
    d.rectangle(frame, fill=255)
    for e in exclude:
        d.rectangle(e, fill=0)
    return ImageChops.multiply(lines, keep).filter(ImageFilter.MaxFilter(3))


def refine_on_cadastre(img, frame, t0, exclude=()):
    """Start from a rough transform, then search scale and position so NSW lot boundaries land on the drawn lot lines."""
    mask = line_mask(img, frame, exclude)
    mp = mask.load()
    W, H = img.size
    bb = frame_bbox(t0, frame)
    pad_lon, pad_lat = (bb[2] - bb[0]) * 0.1, (bb[3] - bb[1]) * 0.1
    rings = lots_in((bb[0] - pad_lon, bb[1] - pad_lat, bb[2] + pad_lon, bb[3] + pad_lat))
    latc = (bb[1] + bb[3]) / 2
    lonc = (bb[0] + bb[2]) / 2
    s0 = t0['ax'] / (111320 * math.cos(math.radians(latc)))
    tx0, ty0 = to_px(t0, lonc, latc)
    step = 2.5 / (s0 * 111320)  # a sample every ~2.5 px along each lot edge
    pts = densify(rings, step)
    x0, y0, x1, y1 = frame

    def score(sample, s, tx, ty):
        t = transform_from(s, tx, ty, lonc, latc)
        hit = n = 0
        for lon, lat in sample:
            x, y = to_px(t, lon, lat)
            if x0 <= x < x1 and y0 <= y < y1:
                n += 1
                if mp[int(x), int(y)]:
                    hit += 1
        return hit / n if n > 50 else 0

    coarse = pts[::max(1, len(pts) // 2500)]
    best = (-1, s0, tx0, ty0)
    for ks in [0.90 + 0.01 * i for i in range(21)]:
        for dx in range(-40, 41, 4):
            for dy in range(-40, 41, 4):
                sc = score(coarse, s0 * ks, tx0 + dx, ty0 + dy)
                if sc > best[0]:
                    best = (sc, s0 * ks, tx0 + dx, ty0 + dy)
    _, s1, tx1, ty1 = best
    fine = pts[::max(1, len(pts) // 8000)]
    best = (-1, s1, tx1, ty1)
    for ks in [0.985 + 0.0025 * i for i in range(13)]:
        for dx in range(-5, 6):
            for dy in range(-5, 6):
                sc = score(fine, s1 * ks, tx1 + dx, ty1 + dy)
                if sc > best[0]:
                    best = (sc, s1 * ks, tx1 + dx, ty1 + dy)
    sc, s, tx, ty = best
    t = transform_from(s, tx, ty, lonc, latc)
    # how much better than chance: the same lot lines shifted by 25 px should score far lower
    off = score(fine, s, tx + 25, ty + 25)
    return t, {'lot_lines_on_drawn_lines': round(sc, 3), 'same_shifted_25px': round(off, 3), 'lots': len(rings),
               'metres_per_px': round(1 / s, 2)}


def fit_anchor(img, frame, anchor, apx, mpp_range, search_px=60, exclude=(), rotations=(0,)):
    """One known point (anchor lon/lat at roughly pixel apx) and a range of possible scales: search scale and position so
    NSW lot boundaries land on the drawn lot lines. Needs numpy (run in the WSL venv)."""
    import numpy as np
    mask = np.array(line_mask(img, frame, exclude)) > 0
    x0, y0, x1, y1 = frame
    lon_a, lat_a = anchor
    kx, ky = 111320 * math.cos(math.radians(lat_a)), M_PER_DEG_LAT
    lo, hi = mpp_range
    fx = max(apx[0] - x0, x1 - apx[0]) + search_px + 20
    fy = max(apx[1] - y0, y1 - apx[1]) + search_px + 20
    if any(rotations):
        fx = fy = max(fx, fy)
    rings = lots_in((lon_a - fx * hi / kx, lat_a - fy * hi / ky, lon_a + fx * hi / kx, lat_a + fy * hi / ky))
    pts = np.array(densify(rings, 1.5 * lo / ky))
    dX, dY = (pts[:, 0] - lon_a) * kx, -(pts[:, 1] - lat_a) * ky
    rng = np.random.default_rng(0)

    def evaluate(s, offsets, n, rot=0.0):
        c, sn = math.cos(math.radians(rot)), math.sin(math.radians(rot))
        px, py = apx[0] + s * (c * dX - sn * dY), apx[1] + s * (sn * dX + c * dY)
        inside = (px > x0 + search_px) & (px < x1 - search_px) & (py > y0 + search_px) & (py < y1 - search_px)
        idx = np.flatnonzero(inside)
        if len(idx) < 200:
            return []
        idx = rng.choice(idx, min(n, len(idx)), replace=False)
        xi, yi = px[idx].astype(int), py[idx].astype(int)
        return [(mask[yi + dy, xi + dx].mean(), dx, dy) for dx, dy in offsets]

    scales = [1 / (lo * (hi / lo) ** (i / 59)) for i in range(60)]
    step = 4 if len(rotations) == 1 else 8
    coarse = [(dx, dy) for dx in range(-search_px, search_px + 1, step) for dy in range(-search_px, search_px + 1, step)]
    best = (-1, None, 0, 0, 0)
    for rot in rotations:
        for s in scales:
            for sc, dx, dy in evaluate(s, coarse, 2000, rot):
                if sc > best[0]:
                    best = (sc, s, dx, dy, rot)
    _, s1, dx1, dy1, r1 = best
    best = (-1, s1, dx1, dy1, r1)
    fine = [(dx1 + a, dy1 + b) for a in range(-step, step + 1) for b in range(-step, step + 1)]
    rots = [r1] if len(rotations) == 1 else [r1 + 0.5 * k for k in range(-6, 7)]
    for rot in rots:
        for k in range(-12, 13):
            s = s1 * (1 + 0.0025 * k)
            for sc, dx, dy in evaluate(s, fine, 8000, rot):
                if sc > best[0]:
                    best = (sc, s, dx, dy, rot)
    sc, s, dx, dy, rot = best
    off = evaluate(s, [(dx + 25, dy + 25)], 12000, rot)[0][0]
    c, sn = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    ax, bx, ay, by = s * c * kx, s * sn * ky, s * sn * kx, -s * c * ky
    t = {'ax': ax, 'bx': bx, 'cx': apx[0] + dx - ax * lon_a - bx * lat_a, 'ay': ay, 'by': by, 'dy': apx[1] + dy - ay * lon_a - by * lat_a}
    if not rot:
        t = {k: t[k] for k in ('ax', 'cx', 'by', 'dy')}
    return t, {'lot_lines_on_drawn_lines': round(float(sc), 3), 'same_shifted_25px': round(float(off), 3), 'lots': len(rings),
               'metres_per_px': round(1 / s, 2), 'anchor_moved_px': [int(dx), int(dy)], 'rotation_deg': rot}


def frame_bbox(t, frame):
    x0, y0, x1, y1 = frame
    corners = [from_px(t, x, y) for x in (x0, x1) for y in (y0, y1)]
    return min(c[0] for c in corners), min(c[1] for c in corners), max(c[0] for c in corners), max(c[1] for c in corners)


def overlay(img, t, frame, path, extra_rings=()):
    o = img.copy()
    d = ImageDraw.Draw(o)
    for p in roads_in(frame_bbox(t, frame)):
        d.line([to_px(t, lon, lat) for lon, lat in p], fill=(0, 90, 255), width=2)
    for ring in extra_rings:
        pts = [to_px(t, lon, lat) for lon, lat in ring]
        d.line(pts + pts[:1], fill=(0, 200, 255), width=2)
    d.rectangle(frame, outline=(0, 160, 0), width=2)
    o.crop(frame).save(path)


def main():
    overlay_dir = sys.argv[1] if len(sys.argv) > 1 else 'map_overlays'
    os.makedirs(overlay_dir, exist_ok=True)
    only = set(sys.argv[2].split(',')) if len(sys.argv) > 2 else None
    spec = json.load(open('scripts/dcp_map_spec.json', encoding='utf-8'))
    previous = {}
    if only and os.path.exists(OUT):
        previous = {e['id']: e for e in json.load(open(OUT, encoding='utf-8'))['maps']}
    out = []
    for m in spec['maps']:
        if m.get('skip'):
            print(f"p{m['page']} {m['id']}: skipped ({m['skip']})")
            continue
        if only and m['id'] not in only:
            if m['id'] in previous:
                out.append(previous[m['id']])
            continue
        img = Image.open(f"{PAGES}/p{m['page']:04d}.png").convert('RGB')
        frame = tuple(m['frame'])
        extra = ()
        if m['method'] == 'anchor':
            # first anchor that resolves: a road junction, or coordinates given directly (e.g. a road over a railway)
            an = lonlat = None
            for an in ([m['anchor']] + m.get('fallback_anchors', [])):
                try:
                    lonlat = tuple(an['lonlat']) if 'lonlat' in an else intersection(tuple(an['a']), tuple(an['b']), tuple(m['near']), m.get('near_radius', 0.06))
                    break
                except RuntimeError as e:
                    print(f"p{m['page']} {m['id']}: anchor skipped: {e}")
            if lonlat is None:
                print(f"p{m['page']} {m['id']}: NOT CALIBRATED (no anchor resolved)")
                continue
            rot = m.get('rotation_deg', [0, 0, 1])
            rots = tuple(m['rotation_list']) if 'rotation_list' in m else tuple(range(rot[0], rot[1] + 1, rot[2]))
            t, fit = fit_anchor(img, frame, lonlat, tuple(an['px']), tuple(m['mpp']), m.get('search_px', 60),
                                [tuple(e) for e in m.get('exclude', [])], rots)
        elif m['method'] == 'outline_from':
            ref = next(e for e in out if e['id'] == m['ref'])
            ref_img = Image.open(f"{PAGES}/p{ref['page']:04d}.png").convert('RGB')
            pts = outline_points_from({**ref, 'exclude': next(x for x in spec['maps'] if x['id'] == m['ref']).get('exclude', [])}, ref_img)
            ex = [tuple(e) for e in m.get('exclude', [])]
            t, rough = fit_outline(img, frame, None, m.get('colour', 'black'), ex, points=pts)
            t, fit = refine_on_cadastre(img, frame, t, ex)
            fit['from_outline_of'] = m['ref']
            fit['outline_fit'] = rough
        elif m['method'] == 'outline':
            rings, names = hca_rings(m['hca_ids'])
            t, fit = fit_outline(img, frame, rings, m.get('colour', 'red'), [tuple(e) for e in m.get('exclude', [])])
            fit['nsw_areas'] = names
            extra = rings
        else:
            pts = []
            for cp in m['control_points']:
                lon, lat = intersection(tuple(cp['a']), tuple(cp['b']), tuple(m['near']))
                pts.append((cp['px'][0], cp['px'][1], lon, lat))
            t, fit = fit_points(pts)
            if m['method'] == 'cadastre':
                rough = fit
                t, fit = refine_on_cadastre(img, frame, t, [tuple(e) for e in m.get('exclude', [])])
                fit['rough_points'] = rough
        overlay(img, t, frame, f"{overlay_dir}/p{m['page']:04d}_{m['id']}.png", extra)
        entry = {k: m[k] for k in ('id', 'page', 'figure', 'title', 'group', 'method', 'frame') if k in m}
        entry.update({'transform': {k: round(v, 6) for k, v in t.items()}, 'fit': fit})
        for k in ('hca_ids', 'labels'):
            if k in m:
                entry[k] = m[k]
        out.append(entry)
        print(f"p{m['page']} {m['id']}: {fit}")
    json.dump({'source': 'scripts/calibrate_maps.py from scripts/dcp_map_spec.json', 'maps': out}, open(OUT, 'w'), indent=1)
    print(f'wrote {OUT} ({len(out)} maps)')


if __name__ == '__main__':
    main()
