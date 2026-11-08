# Driftwood on the beaches. Vancouver's beaches have rows of big weathered logs along them (the Park Board lines them up
# parallel to the shore). Inside the City of Vancouver 2022 orthophoto each log is found in the photo itself: the beach
# areas are cut from the 7.5 cm ECW tiles at 12.5 cm (podman GDAL, tools/ortho.Dockerfile, into data/ortho/beach/),
# and on the dry sand (OSM natural=beach and sand, land side of the coastline) long straight blobs that stand out
# from the sand (the grey log and its shadow) are fitted: centre, direction, length, width. Elsewhere (the North Shore,
# White Rock, Crescent Beach, Belcarra...) logs are laid procedurally in rows along the shore on every OSM beach. Plus
# lifeguard towers on the lifeguarded beaches and nets on the beach volleyball courts.
# Writes data/beachlogs.npz: logs (x, north, angle, length, diameter, shape) and things (x, north, angle, kind, length)
# in world metres; tiles.py bakes them into the detail tiles' LOGS section.
# Run: uv run --with numpy,scipy,pillow,shapely,rasterio,scikit-image python3 tools/beachlogs.py [procs]
#      ... tools/beachlogs.py preview [kits|english|spanish|lat,lon]  (detections over the photo, data/ortho/beach/preview-*.jpg)
#      ... tools/beachlogs.py check  (detect() on a synthetic beach)
import math, os, random, subprocess, sys, time
from multiprocessing import Pool
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import xy, latlon, all_tiles, load_feat

OUT = 'data/beachlogs.npz'
DIR = 'data/ortho/beach'
RES = 0.125  # metres per pixel of the crops
SEA = np.load('data/sea.npz')
SEA_M, SEA_X0, SEA_Y1, SEA_C = SEA['sea'].astype(bool), float(SEA['x0']), float(SEA['y1']), float(SEA['cell'])
TOWER, NET = 1, 2  # things
# the beaches the Vancouver Park Board guards in summer (OSM maps their towers nowhere, and tags a few beaches lifeguard=*)
GUARDED = ('English Bay', 'Kitsilano', 'Jericho', 'Locarno', 'Spanish Banks', 'Second Beach', 'Third Beach', 'Sunset Beach')
AREAS = {'kits': (49.2745, -123.1545), 'english': (49.2868, -123.1425), 'spanish': (49.2770, -123.2150)}  # previews (inside the photo)


# ---------------------------------------------------------------- beaches
def near_sea(p, d):
    """does the sea mask come within d metres of polygon p"""
    import shapely
    x0, y0, x1, y1 = p.buffer(d).bounds
    c0, c1 = int((x0 - SEA_X0) / SEA_C), int((x1 - SEA_X0) / SEA_C) + 1
    r0, r1 = int((SEA_Y1 - y1) / SEA_C), int((SEA_Y1 - y0) / SEA_C) + 1
    sub = SEA_M[max(0, r0):max(0, r1), max(0, c0):max(0, c1)]
    if not sub.any(): return False
    rr, cc = np.nonzero(sub)
    return bool(shapely.dwithin(p, shapely.points(SEA_X0 + (cc + max(0, c0) + 0.5) * SEA_C, SEA_Y1 - (rr + max(0, r0) + 0.5) * SEA_C), d).any())


def beaches():
    """the dry sand by the sea: OSM beaches (any surface) and sand by the shore, merged -> [(Polygon, name, guarded)]"""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    import shapely
    src = []
    for i, j in all_tiles():
        for oid, prs, t in load_feat(i, j).get('areas', []):
            beach = t.get('natural') == 'beach'
            if not (beach or t.get('natural') in ('sand', 'dune') and not t.get('golf') and t.get('leisure') not in ('pitch', 'playground')): continue
            for outer, inners in prs:
                if len(outer) < 4: continue
                p = Polygon(outer, [h for h in inners if len(h) >= 4]).buffer(0)
                if p.area < 150 or not near_sea(p, 6 if beach else 3): continue
                src.append((p, t.get('name', ''), t.get('lifeguard', 'no') != 'no'))
    seen = {}  # the same area in two feature buckets: once
    for p, nm, g in src: seen.setdefault((round(p.centroid.x), round(p.centroid.y), round(p.area)), (p, nm, g))
    src = list(seen.values())
    u = unary_union([p for p, _, _ in src])
    tree = shapely.STRtree([p for p, _, _ in src])
    out = []
    for part in (u.geoms if hasattr(u, 'geoms') else [u]):
        hits = sorted(tree.query(part, predicate='intersects'), key=lambda k: -src[k][0].area)
        nm = next((src[k][1] for k in hits if src[k][1]), '')
        out.append((part, nm, any(src[k][2] for k in hits) or any(g in nm for g in GUARDED)))
    return out


def land(p, margin):
    """the part of p at least margin metres from the sea mask (4 m cells, so a margin of 4+ keeps clear of the drawn water)"""
    from shapely.ops import unary_union
    x0, y0, x1, y1 = p.bounds
    c0, c1 = max(0, int((x0 - margin - SEA_X0) / SEA_C)), int((x1 + margin - SEA_X0) / SEA_C) + 1
    r0, r1 = max(0, int((SEA_Y1 - y1 - margin) / SEA_C)), int((SEA_Y1 - y0 + margin) / SEA_C) + 1
    sub = SEA_M[r0:r1, c0:c1]
    if not sub.any(): return p
    import rasterio.features as rf
    from rasterio.transform import Affine
    from shapely.geometry import shape
    tr = Affine(SEA_C, 0, SEA_X0 + c0 * SEA_C, 0, -SEA_C, SEA_Y1 - r0 * SEA_C)
    sea = unary_union([shape(g) for g, v in rf.shapes(sub.astype(np.uint8), mask=sub, transform=tr) if v])
    return p.difference(sea.buffer(margin, quad_segs=2))


# ---------------------------------------------------------------- the photo
def to_utm(x, y):
    from rasterio.warp import transform
    lat, lon = latlon(np.asarray(x, float), np.asarray(y, float))
    e, n = transform('EPSG:4326', 'EPSG:3157', np.atleast_1d(lon).tolist(), np.atleast_1d(lat).tolist())
    return np.array(e), np.array(n)


def from_utm(e, n):
    from rasterio.warp import transform
    lon, lat = transform('EPSG:3157', 'EPSG:4326', np.atleast_1d(e).tolist(), np.atleast_1d(n).tolist())
    return xy(np.array(lat), np.array(lon))


def coverage():
    """the 2022 photo's footprint in UTM (union of the ECW tiles' boxes, from the 0.5 m tifs)"""
    import glob, rasterio
    from shapely.geometry import box
    from shapely.ops import unary_union
    bs = []
    for f in sorted(glob.glob('data/ortho/tif/*.tif')):
        with rasterio.open(f) as s: bs.append(box(*s.bounds))
    return unary_union(bs)


def crop_jobs(bs, cover):
    """([(k, utm polygon of its dry sand, (e0, n0, e1, n1) of the whole beach)], {k inside the photo})"""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    jobs, inside = [], set()
    utm = lambda g: Polygon(zip(*to_utm(*np.array(g.exterior.coords).T)), [list(zip(*to_utm(*np.array(h.coords).T))) for h in g.interiors]).buffer(0)
    for k, (p, _, _) in enumerate(bs):
        up = utm(p)
        if up.intersection(cover).area < 0.9 * up.area: continue
        inside.add(k)
        e0, n0, e1, n1 = up.bounds
        # OSM beaches reach down to low tide, the logs lie well above the high-water line (and its line of washed-up
        # weed); and they often lie just past the beach as mapped, against the grass or the path behind it
        dry = land(p, 5)
        dry = dry.buffer(3).difference(p.difference(dry))
        dry = unary_union([utm(g) for g in (dry.geoms if hasattr(dry, 'geoms') else [dry]) if g.geom_type == 'Polygon' and g.area > 20])
        if not dry.is_empty: jobs.append((k, dry, (math.floor(e0 - 4), math.floor(n0 - 4), math.ceil(e1 + 4), math.ceil(n1 + 4))))
    return jobs, inside


def extract(jobs):
    """cut each beach from the ECW tiles at RES into DIR/<k>.tif (one podman run; crops already there are kept)"""
    os.makedirs(DIR, exist_ok=True)
    todo = [(k, b) for k, _, b in jobs if not os.path.exists(f'{DIR}/{k}.tif')]
    if not todo: return
    with open(f'{DIR}/jobs.txt', 'w') as f:
        for k, (e0, n0, e1, n1) in todo: f.write(f'{k} {e0} {n1} {e1} {n0}\n')
    subprocess.run(['sh', '-c', 'podman image exists vancouver-ortho || podman build -t vancouver-ortho -f tools/ortho.Dockerfile tools'], check=True)
    # ponytail: one VRT over all the ECW tiles, rebuilt when missing; delete data/ortho/all.vrt after adding tiles
    subprocess.run(['podman', 'run', '--rm', '-v', f'{os.path.abspath("data/ortho")}:/o', '-w', '/o', 'vancouver-ortho', 'sh', '-c',
                    f'[ -s all.vrt ] || {{ ls *.ecw > /tmp/l && gdalbuildvrt -q -a_srs EPSG:3157 -input_file_list /tmp/l all.vrt; }}; '
                    f'xargs -P 2 -L 1 sh -c \'gdal_translate -q --config GDAL_CACHEMAX 200 -projwin $1 $2 $3 $4 -tr {RES} {RES} -r average -co COMPRESS=DEFLATE -co TILED=YES '
                    f'all.vrt beach/$0.tmp.tif && mv beach/$0.tmp.tif beach/$0.tif\' < beach/jobs.txt 2>&1 | grep -v crs.not.found || true'], check=True)  # 2 at a time: the podman VM has 2 GB


WIN, PAD = 2048, 160  # detection window and its margin (20 m), pixels


def windows(jobs):
    """one detection job per WIN x WIN pixels of each crop that has dry sand in it"""
    import rasterio
    out = []
    for k, up, _ in jobs:
        with rasterio.open(f'{DIR}/{k}.tif') as s: W, H, e0, n1 = s.width, s.height, s.transform.c, s.transform.f
        for r0 in range(0, H, WIN):
            for c0 in range(0, W, WIN):
                from shapely.geometry import box
                if up.intersects(box(e0 + c0 * RES, n1 - (r0 + WIN) * RES, e0 + (c0 + WIN) * RES, n1 - r0 * RES)): out.append((k, up.wkb, c0, r0))
    return out


def find(job):
    """one window -> logs in UTM [(e, n, angle, length)], those whose centre is in the window's core"""
    import rasterio, shapely
    from PIL import Image, ImageDraw
    k, wkb, c0, r0 = job
    up = shapely.from_wkb(wkb)
    with rasterio.open(f'{DIR}/{k}.tif') as s:
        a0, b0 = max(0, c0 - PAD), max(0, r0 - PAD)
        w, h = min(s.width, c0 + WIN + PAD) - a0, min(s.height, r0 + WIN + PAD) - b0
        img = np.moveaxis(s.read(window=rasterio.windows.Window(a0, b0, w, h))[:3], 0, -1)
        e0, n1 = s.transform.c + a0 * RES, s.transform.f - b0 * RES
    m = Image.new('L', (w, h), 0); d = ImageDraw.Draw(m)
    pix = lambda cs: [((e - e0) / RES, (n1 - n) / RES) for e, n in cs]
    for g in (up.geoms if hasattr(up, 'geoms') else [up]):
        d.polygon(pix(g.exterior.coords), fill=1)
        for hole in g.interiors: d.polygon(pix(hole.coords), fill=0)
    mask = np.array(m, bool) & img.any(-1)
    if not mask.any(): return []
    return [(e0 + (c + 0.5) * RES, n1 - (r + 0.5) * RES, ang, ln) for c, r, ang, ln in detect(img, mask)
            if c0 <= a0 + c < c0 + WIN and r0 <= b0 + r < r0 + WIN]


def detect(img, mask, thr=5.0, dbg=None):
    """logs in a 12.5 cm beach photo: [(col, row, angle (radians, from +col towards -row = north), length m)]
    A log's sun-bleached top is a bright stripe (in the 2022 photo barely 15 grey levels over the sand), its shadow a
    dark one beside it: across the line the Hessian finds there, the brightness falls away on both sides (the shadow,
    the sand, a path) by thr or more, or for the shadow rises on both sides by 2 thr. Ridge pixels make blobs; chains of logs laid end to end are cut in two until each
    piece is one straight log."""
    from scipy import ndimage
    f = img.astype(np.float32)
    L = f.mean(-1)
    green = (f[..., 1] > f[..., 0] + 4) & (f[..., 1] > f[..., 2] + 12)
    sand = mask & ~green
    if sand.sum() < 500: return []
    v = ndimage.gaussian_filter(L, 1.0)
    sg = 3.0
    hxx = ndimage.gaussian_filter(v, sg, order=(0, 2)); hyy = ndimage.gaussian_filter(v, sg, order=(2, 0)); hxy = ndimage.gaussian_filter(v, sg, order=(1, 1))
    root = np.sqrt(((hxx - hyy) / 2) ** 2 + hxy ** 2)
    lo, hi = (hxx + hyy) / 2 - root, (hxx + hyy) / 2 + root  # curvature across a bright line (lo < 0), a dark one (hi > 0)
    th = 0.5 * np.arctan2(2 * hxy, hxx - hyy)  # across a dark line (x = col, y = row); a bright one: + 90 degrees
    del hxx, hyy, hxy, root
    d = 0.6 / RES
    rr, cc = np.mgrid[0:v.shape[0], 0:v.shape[1]].astype(np.float32)
    def ridge(t, sgn):  # how far v stands out (sgn 1 above, -1 below) from both sides d away across the line
        nx, ny = np.cos(t) * d, np.sin(t) * d
        a = ndimage.map_coordinates(v, [rr + ny, cc + nx], order=1, mode='nearest'); b = ndimage.map_coordinates(v, [rr - ny, cc - nx], order=1, mode='nearest')
        return np.minimum(sgn * (v - a), sgn * (v - b))
    bright = np.where(lo < 0, ridge(th + np.pi / 2, 1), 0).clip(0, 40)
    del lo, hi, th
    # along the line: the mean ridge over 2.5 m, the best of 12 directions (speckle and wavering tracks average out)
    from scipy.signal import fftconvolve
    from PIL import Image, ImageDraw
    n = int(2.5 / RES) | 1
    best = np.zeros_like(v)
    for a in range(0, 180, 15):
        k = Image.new('L', (n, n), 0)
        dx, dy = math.cos(math.radians(a)) * (n - 1) / 2, math.sin(math.radians(a)) * (n - 1) / 2
        ImageDraw.Draw(k).line((n // 2 - dx, n // 2 - dy, n // 2 + dx, n // 2 + dy), fill=1, width=1)
        k = np.array(k, np.float32); k /= k.sum()
        np.maximum(best, fftconvolve(bright, k, mode='same'), out=best)
    on = (best > thr) & (bright > thr) & mask & ~green  # straight for 2.5 m, and on the stripe itself
    on = ndimage.binary_closing(on, iterations=1) & mask
    if dbg is not None: dbg.update(v=v, ridge=best, on=on)
    lab, n = ndimage.label(on)
    out = []

    def fit(r, c, depth=0):
        if len(r) < 0.15 / RES ** 2: return
        mc, mr = c.mean(), r.mean()
        ev, evec = np.linalg.eigh(np.cov(np.vstack([c - mc, r - mr])))
        ln, wd = math.sqrt(12 * max(ev[1], 0)) * RES, math.sqrt(12 * max(ev[0], 0)) * RES
        fill = len(r) * RES * RES / max(ln * wd, 1e-3)
        if (ln > 13 or ln > 3 and fill < 0.4 or wd > 1.6 and ln > 2 * wd) and depth < 8:  # a chain or a bend: in two at the middle
            u = (c - mc) * evec[0, 1] + (r - mr) * evec[1, 1]
            for part in (u < 0, u >= 0): fit(r[part], c[part], depth + 1)
            return
        if 1.8 <= ln <= 16 and 0.2 <= wd <= 1.6 and ln >= 2.5 * wd and fill >= 0.45:
            out.append((mc, mr, math.atan2(-evec[1, 1], evec[0, 1]), ln + 0.4))  # the ridge test fails over the rounded ends

    for k, sl in enumerate(ndimage.find_objects(lab)):
        if sl is None: continue
        r, c = np.nonzero(lab[sl] == k + 1)
        fit((r + sl[0].start).astype(np.float32), (c + sl[1].start).astype(np.float32))
    # a log lies on sand: beside it, on one side at least (the other may be a path or the grass), the beach's own sand
    # colour (dry grass, dirt and brush behind the beach make log-like streaks too)
    sm = ndimage.uniform_filter(f, (5, 5, 1))
    ref = np.median(f[sand][::7], axis=0); lref = ref.mean(); cref = ref / ref.sum()
    H, W = mask.shape
    def sandy(c, r, a, ln, side):
        ux, uy = math.cos(a), -math.sin(a)
        pts = [(c + ux * t * ln / 2 / RES - uy * side * 1.2 / RES, r + uy * t * ln / 2 / RES + ux * side * 1.2 / RES) for t in np.linspace(-0.8, 0.8, 7)]
        ok = 0
        for x, y in pts:
            xi, yi = int(x), int(y)
            if not (0 <= xi < W and 0 <= yi < H): continue
            q = sm[yi, xi]
            ok += abs(q.mean() - lref) < 30 and np.abs(q / (q.sum() + 1e-3) - cref).max() < 0.025
        return ok >= 4
    out = [l for l in join(out) for c, r, a, ln in [l] if sandy(c, r, a, ln, 1) or sandy(c, r, a, ln, -1)]
    # one log once: the shorter of two that lie on each other goes
    out.sort(key=lambda l: -l[3])
    keep = []
    for c, r, a, ln in out:
        ux, uy = math.cos(a), -math.sin(a)
        if any(abs((c - k[0]) * -uy + (r - k[1]) * ux) < 0.7 / RES and abs((c - k[0]) * ux + (r - k[1]) * uy) < (k[3] + ln) / 2 / RES * 0.8
               and abs(math.sin(a - k[2])) < 0.5 for k in keep): continue
        keep.append((c, r, a, ln))
    return keep


def join(logs, gap=1.2, off=0.45, most=13):
    """pieces of one log (its top broken by a knot, a shadow, sand on it) -> one log: in line (within off m of each other's
    axis, 9 degrees), at most gap m apart end to end, together no longer than most m. Pixel units in and out."""
    segs = [[c - math.cos(a) * ln / 2 / RES, r + math.sin(a) * ln / 2 / RES, c + math.cos(a) * ln / 2 / RES, r - math.sin(a) * ln / 2 / RES] for c, r, a, ln in logs]
    merged = True
    while merged:
        merged = False
        for i in range(len(segs)):
            for j in range(i + 1, len(segs)):
                a, b = segs[i], segs[j]
                ux, uy = a[2] - a[0], a[3] - a[1]; la = math.hypot(ux, uy) or 1; ux, uy = ux / la, uy / la
                vx, vy = b[2] - b[0], b[3] - b[1]; lb = math.hypot(vx, vy) or 1
                if abs(ux * vx + uy * vy) / lb < math.cos(math.radians(9)): continue
                ts = [(b[0] - a[0]) * ux + (b[1] - a[1]) * uy, (b[2] - a[0]) * ux + (b[3] - a[1]) * uy]
                if max(abs((b[k] - a[0]) * -uy + (b[k + 1] - a[1]) * ux) for k in (0, 2)) > off / RES: continue
                if min(ts) - la > gap / RES or -max(ts) > gap / RES: continue
                t0, t1 = min(0, *ts), max(la, *ts)
                if (t1 - t0) * RES > most: continue
                segs[i] = [a[0] + ux * t0, a[1] + uy * t0, a[0] + ux * t1, a[1] + uy * t1]
                segs.pop(j); merged = True; break
            if merged: break
    return [((x0 + x1) / 2, (y0 + y1) / 2, math.atan2(-(y1 - y0), x1 - x0), math.hypot(x1 - x0, y1 - y0) * RES) for x0, y0, x1, y1 in segs]


# ---------------------------------------------------------------- beyond the photo: rows along the shore
def shore(p, pad=50):
    """a 1 m grid over p: (distance to the sea in metres, smoothed; p's mask; x of column 0's west edge, y of row 0's north edge)"""
    from scipy import ndimage
    from PIL import Image, ImageDraw
    x0, y0, x1, y1 = p.bounds
    x0, y1 = math.floor(x0 - pad), math.ceil(y1 + pad)
    W, H = int(math.ceil(x1 + pad - x0)), int(math.ceil(y1 - (y0 - pad)))
    rr = ((SEA_Y1 - (y1 - np.arange(H) - 0.5)) / SEA_C).astype(int).clip(0, SEA_M.shape[0] - 1)
    cc = ((x0 + np.arange(W) + 0.5 - SEA_X0) / SEA_C).astype(int).clip(0, SEA_M.shape[1] - 1)
    sea = SEA_M[np.ix_(rr, cc)]
    dist = ndimage.gaussian_filter(ndimage.distance_transform_edt(~sea).astype(np.float32), 2.0)
    m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
    for g in (p.geoms if hasattr(p, 'geoms') else [p]):
        d.polygon([(x - x0, y1 - y) for x, y in g.exterior.coords], fill=1)
        for h in g.interiors: d.polygon([(x - x0, y1 - y) for x, y in h.coords], fill=0)
    return dist, np.array(m, bool), x0, y1


def contours(dist, mask, level, x0, y1):
    """the line at level metres from the sea inside mask -> [world polyline (n, 2)]"""
    from skimage.measure import find_contours
    return [np.column_stack([x0 + c[:, 1] + 0.5, y1 - c[:, 0] - 0.5]) for c in find_contours(dist, level, mask=mask) if len(c) > 3]


def along(line, s):
    """the point s metres along a polyline"""
    seg = np.hypot(*np.diff(line, axis=0).T); cum = np.concatenate([[0], np.cumsum(seg)])
    i = min(len(seg) - 1, max(0, int(np.searchsorted(cum, s) - 1)))
    f = (s - cum[i]) / (seg[i] or 1)
    return line[i] + (line[i + 1] - line[i]) * f, cum[-1]


def rows(p, rnd):
    """logs in rows parallel to the shore on beach p (no photo): from the back of the dry sand down to 4.5 m off the
    high-water line, a row every 4-6 m (at most 4), logs 4.5-11 m end to end with gaps, now and then a long one."""
    dist, mask, x0, y1 = shore(p)
    dry = mask & (dist > 4.5) & (dist < 45)
    if dry.sum() < 60: return []
    top = min(float(np.percentile(dist[dry], 97)), 44.0)
    out = []
    lv, n = top - 2.0, 0
    while lv > 4.5 and n < 4:
        for line in contours(dist, mask, lv, x0, y1):
            _, total = along(line, 0)
            s = rnd.uniform(0, 4)
            while True:
                ln = rnd.uniform(4.5, 11)
                if s + ln > total: break
                a, _ = along(line, s); b, _ = along(line, s + ln)
                if rnd.random() < 0.85:
                    ang = math.atan2(b[1] - a[1], b[0] - a[0]) + rnd.gauss(0, 0.06)
                    c = (a + b) / 2 + rnd.gauss(0, 0.3) * np.array([-math.sin(ang), math.cos(ang)])
                    out.append((float(c[0]), float(c[1]), ang, math.hypot(*(b - a))))
                s += ln + (rnd.uniform(0.3, 2.5) if rnd.random() < 0.7 else rnd.uniform(3, 10))
        lv -= rnd.uniform(4, 6); n += 1
    return out


# ---------------------------------------------------------------- lifeguard towers and volleyball nets
def towers(p):
    """lifeguard towers on a guarded beach: one per 250 m along the middle of the dry sand, facing the water"""
    dist, mask, x0, y1 = shore(p)
    dry = mask & (dist > 6)
    if dry.sum() < 100: return []
    lv = (6 + min(float(np.percentile(dist[dry], 90)), 40)) / 2
    gy, gx = np.gradient(dist)
    out = []
    for line in sorted(contours(dist, mask, lv, x0, y1), key=len, reverse=True)[:2]:
        _, total = along(line, 0)
        if total < 40: continue
        k = max(1, int(total // 250))
        for i in range(k):
            pt, _ = along(line, total * (i + 0.5) / k)
            r, c = int(y1 - pt[1]), int(pt[0] - x0)
            out.append((float(pt[0]), float(pt[1]), math.atan2(gy[r, c], -gx[r, c]), TOWER, 2.0))  # downhill in distance = seawards (rows run south)
    return out


def nets():
    """a net across the middle of every beach volleyball court OSM maps -> things, and the courts (no logs on them)"""
    from shapely.geometry import Polygon
    out, courts, seen = [], [], set()
    for i, j in all_tiles():
        for oid, prs, t in load_feat(i, j).get('areas', []):
            sp = t.get('sport', '')
            if t.get('leisure') != 'pitch' or not ('beachvolleyball' in sp or 'volleyball' in sp and t.get('surface') == 'sand') or oid in seen: continue
            if t.get('indoor') == 'yes' or t.get('covered') == 'yes': continue
            seen.add(oid)
            for outer, _ in prs:
                if len(outer) < 4: continue
                q = Polygon(outer).buffer(0)
                r = list(q.minimum_rotated_rectangle.exterior.coords)
                e1, e2 = np.subtract(r[1], r[0]), np.subtract(r[2], r[1])
                short = e1 if np.hypot(*e1) < np.hypot(*e2) else e2
                w = float(np.hypot(*short))
                if w < 4 or w > 20: continue
                c = q.centroid
                out.append((c.x, c.y, math.atan2(short[1], short[0]), NET, min(w + 1.0, 11.0)))
                courts.append(q)
    return out, courts


# ---------------------------------------------------------------- all of it
def looks(x, y, ln, rnd):
    """diameter (thicker when longer: these are trimmed trunks) and shape (0-2 one of three logs, +4 a root ball)"""
    dia = max(0.5, min(1.0, 0.42 + 0.045 * ln + rnd.gauss(0, 0.06)))
    return dia, rnd.randrange(3) | (4 if ln > 6 and rnd.random() < 0.18 else 0)


def bake(procs):
    import shapely
    from shapely.geometry import LineString
    t0 = time.time()
    bs = beaches()
    jobs, inside = crop_jobs(bs, coverage())
    print(len(bs), 'beaches,', len(inside), 'in the photo', f'{time.time() - t0:.0f}s', flush=True)
    extract(jobs)
    with Pool(procs) as pool: found = [l for ls in pool.map(find, windows(jobs), chunksize=1) for l in ls]
    print(len(found), 'logs found in the photo', f'{time.time() - t0:.0f}s', flush=True)
    logs = []
    if found:
        e, n, a, ln = np.array(found).T
        ex, ey = np.cos(a) * ln / 2, np.sin(a) * ln / 2
        ax, ay = from_utm(e - ex, n - ey); bx, by = from_utm(e + ex, n + ey)
        logs = [((ax[i] + bx[i]) / 2, (ay[i] + by[i]) / 2, math.atan2(by[i] - ay[i], bx[i] - ax[i]), math.hypot(bx[i] - ax[i], by[i] - ay[i]), 1) for i in range(len(found))]
    things, courts = nets()
    for k, (p, nm, guarded) in enumerate(bs):
        rnd = random.Random(k * 7919 + int(p.area))
        if k not in inside: logs += [l + (0,) for l in rows(p, rnd)]
        if guarded: things += towers(p)
    # nothing on the courts or round the towers
    segs = [LineString([(x - math.cos(a) * ln / 2, y - math.sin(a) * ln / 2), (x + math.cos(a) * ln / 2, y + math.sin(a) * ln / 2)]) for x, y, a, ln, _ in logs]
    block = shapely.unary_union([c.buffer(1.5) for c in courts] + [shapely.Point(t[0], t[1]).buffer(4) for t in things if t[3] == TOWER])
    ok = ~shapely.intersects(np.array(segs, dtype=object), block) if logs else []
    rows_ = []
    for (x, y, a, ln, photo), good in zip(logs, ok):
        if not good: continue
        rnd = random.Random(int(x * 10) * 31 + int(y * 10))
        dia, shape = looks(x, y, ln, rnd)
        rows_.append((x, y, a, ln, dia, shape))
    L = np.array(rows_, np.float32).reshape(-1, 6); T = np.array(things, np.float32).reshape(-1, 5)
    np.savez_compressed(OUT, logs=L, things=T, photo=np.array([l[4] for l, g in zip(logs, ok) if g], np.uint8))
    print(len(L), 'logs,', int((T[:, 3] == TOWER).sum()), 'towers,', int((T[:, 3] == NET).sum()), 'nets ->', OUT, f'{time.time() - t0:.0f}s', flush=True)


def preview(name, half=170):
    """the photo round a place with what was found (red) and laid (yellow) drawn over it -> DIR/preview-<name>.jpg"""
    import glob, rasterio
    from rasterio.merge import merge
    from PIL import Image, ImageDraw
    lat, lon = AREAS[name] if name in AREAS else map(float, name.split(','))
    (e,), (n,) = to_utm(*xy(lat, lon))
    e0, n0, e1, n1 = e - half, n - half, e + half, n + half
    res = 0.25
    srcs = []
    for f in glob.glob(f'{DIR}/[0-9]*.tif'):
        s = rasterio.open(f); b = s.bounds
        if b[0] < e1 and b[2] > e0 and b[1] < n1 and b[3] > n0 and not f.endswith('.tmp.tif'): srcs.append(s)
        else: s.close()
    if not srcs: sys.exit('no beach photo there')
    img, _ = merge(srcs, bounds=(e0, n0, e1, n1), res=res, nodata=0)
    im = Image.fromarray(np.moveaxis(img[:3], 0, -1)); d = ImageDraw.Draw(im)
    D = np.load(OUT)
    px = lambda x, y: [((u - e0) / res, (n1 - v) / res) for u, v in zip(*to_utm(np.atleast_1d(x), np.atleast_1d(y)))]
    for (x, y, a, ln, dia, shape), ph in zip(D['logs'], D['photo']):
        ux, uy = math.cos(a), math.sin(a)
        pts = px([x + ux * ln / 2 * p - uy * dia / 2 * q for p, q in ((1, 1), (-1, 1), (-1, -1), (1, -1))], [y + uy * ln / 2 * p + ux * dia / 2 * q for p, q in ((1, 1), (-1, 1), (-1, -1), (1, -1))])
        if all(0 <= u < im.width and 0 <= v < im.height for u, v in pts): d.polygon(pts, outline=(255, 30, 30) if ph else (255, 220, 0), width=1)
    for x, y, a, kind, ln in D['things']:
        (u, v), = px(x, y)
        if 0 <= u < im.width and 0 <= v < im.height:
            if kind == TOWER: d.rectangle((u - 6, v - 6, u + 6, v + 6), outline=(0, 160, 255), width=2)
            else:
                (a0, b0), (a1, b1) = px([x - math.cos(a) * ln / 2, x + math.cos(a) * ln / 2], [y - math.sin(a) * ln / 2, y + math.sin(a) * ln / 2])
                d.line((a0, b0, a1, b1), fill=(255, 0, 255), width=2)
    p = f'{DIR}/preview-{name}.jpg'
    im.save(p, quality=88)
    print(p, im.size)


def check():
    """a synthetic beach: sand with noise, a 6 m log at 30 degrees (silver top, shadow on one side) and a wavering dark
    track; detect() must find the log alone, about where, how long and which way it lies"""
    from PIL import Image, ImageDraw
    rng = np.random.default_rng(1)
    W = 400
    img = (np.array([190, 176, 149], np.float32) + rng.normal(0, 3, (W, W, 3))).astype(np.float32)
    im = Image.fromarray(img.clip(0, 255).astype(np.uint8)); d = ImageDraw.Draw(im)
    a, ln, c, r = math.radians(30), 6.0, 200, 200
    ux, uy = math.cos(a) * ln / 2 / RES, -math.sin(a) * ln / 2 / RES
    d.line((c - ux + 3, r - uy + 3, c + ux + 3, r + uy + 3), fill=(168, 152, 128), width=4)  # shadow
    d.line((c - ux, r - uy, c + ux, r + uy), fill=(208, 200, 184), width=5)  # top
    d.line([(20 + 5 * math.sin(i / 3), 40 + i * 4) for i in range(80)], fill=(160, 150, 125), width=2)
    found = detect(np.array(im), np.ones((W, W), bool))
    assert len(found) == 1, found
    fc, fr, fa, fl = found[0]
    assert math.hypot(fc - c, fr - r) < 4 and abs(math.sin(fa - a)) < 0.08 and abs(fl - ln) < 1.2, found
    print('ok', [round(v, 2) for v in found[0]])


if __name__ == '__main__':
    if sys.argv[1:2] == ['preview']: preview(sys.argv[2] if len(sys.argv) > 2 else 'kits')
    elif sys.argv[1:2] == ['check']: check()
    else: bake(int(sys.argv[1]) if len(sys.argv) > 1 else max(1, (os.cpu_count() or 4) - 2))
