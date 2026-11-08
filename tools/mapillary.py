# Wall colours from Mapillary street photos (CC BY-SA 4.0), into data/mapillary/walls.npz, which tools/facades.py
# folds into data/facades.npz. For each photo (recent, not a panorama, posed by Mapillary's own reconstruction:
# computed_geometry + computed_rotation) and each building wall 8-60 m away that faces it and that no other building
# hides, a grid of points on the wall (3-9 m up, above the shop fronts) is projected into the 1024 px thumbnail; the
# pixels there, white-balanced on the photo's own greys, leaves and sky dropped, give that photo's colour of the wall.
# A wall colour is the median over its photos (2 or more), kept with their image ids for credit.
# API responses and thumbnails are cached in data/mapillary/ (not committed). The client token comes in as $MLY
# (never printed, sent only as a header):
#   node ~/.openclaw/bin/openclaw-vaultwarden-exec.mjs --item 'Mapillary token' --field 'access token' --env MLY -- \
#     uv run --with numpy,shapely,pillow python3 tools/mapillary.py [area ...]     (areas: AREAS keys or s,w,n,e)
#   ... tools/mapillary.py check   (self-test of the camera models, no network)
import json, math, os, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import xy, save_rings, retry
from roofs import srgb_lab, lab_srgb

DIR = 'data/mapillary'
OUT = f'{DIR}/walls.npz'
API = 'https://graph.mapillary.com'
FIELDS = 'id,computed_geometry,computed_rotation,camera_type,camera_parameters,width,height,captured_at,is_pano,thumb_1024_url'
SINCE = 2018         # older photos: many walls repainted or rebuilt since
CELL = 0.003         # API query box, degrees (~330 x 220 m)
PER_CELL = 120       # photos kept per box: the newest per 12 m square
CAM_H = 1.8          # camera height above the street, metres (dashcams and phones)
NEUTRAL = (0.0, 2.0)  # a*, b* the photo's greys are pulled to (grey paving and concrete are a touch warm)
GREY_L = 62.0         # L* of the street's greys in daylight: photos expose for the sky, walls come out dark. Calibration knob.
L_RANGE = (40, 94)    # walls under bridges, awnings and deep shade read too dark; few real walls are darker than L* 40
AREAS = {  # s, w, n, e
    'downtown': (49.2725, -123.1360, 49.2900, -123.1040),
    'westend': (49.2820, -123.1480, 49.2930, -123.1300),
    'kitsilano': (49.2640, -123.1700, 49.2720, -123.1500),
}


# ---------------------------------------------------------------- the API (cached)
def api(path, cache):
    if os.path.exists(cache): return json.load(open(cache))
    tok = os.environ.get('MLY')
    if not tok: sys.exit('no $MLY: run through openclaw-vaultwarden-exec (see the top of this file)')
    d = retry(lambda: json.load(urllib.request.urlopen(urllib.request.Request(API + path, headers={'Authorization': 'OAuth ' + tok}), timeout=60)), 5, 3)
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    json.dump(d, open(cache, 'w'))
    time.sleep(0.2)  # polite
    return d


def photos(s, w, n, e):
    """the kept photos in a box: newest per 12 m square, posed, not panoramas, since SINCE"""
    out = []
    for la in np.arange(s, n, CELL):
        for lo in np.arange(w, e, CELL):
            b = f'{lo:.4f},{la:.4f},{min(lo + CELL, e):.4f},{min(la + CELL, n):.4f}'
            d = api(f'/images?fields={FIELDS}&bbox={b}&limit=2000', f'{DIR}/api/{b}.json')
            best = {}
            for p in d.get('data', []):
                if p.get('is_pano') or not p.get('computed_rotation') or not p.get('computed_geometry') or p.get('camera_type') not in ('perspective', 'fisheye'): continue
                if p['captured_at'] < (SINCE - 1970) * 365.25 * 86400e3: continue
                x, y = xy(p['computed_geometry']['coordinates'][1], p['computed_geometry']['coordinates'][0])
                k = (round(x / 12), round(y / 12), round(np.degrees(np.linalg.norm(p['computed_rotation'])) / 30))  # one per square and heading
                if k not in best or p['captured_at'] > best[k]['captured_at']: best[k] = p
            out += sorted(best.values(), key=lambda p: -p['captured_at'])[:PER_CELL]
    return {p['id']: p for p in out}


def thumb(p):
    f = f'{DIR}/thumbs/{p["id"]}.jpg'
    if not os.path.exists(f):
        os.makedirs(os.path.dirname(f), exist_ok=True)
        try: data = retry(lambda: urllib.request.urlopen(p['thumb_1024_url'], timeout=60).read(), 3, 2)
        except Exception: return None
        open(f, 'wb').write(data)
    return f


# ---------------------------------------------------------------- cameras (OpenSfM's models)
def rotation(aa):
    """angle-axis -> matrix (world east-north-up -> camera: x right, y down, z ahead)"""
    aa = np.asarray(aa, float); t = np.linalg.norm(aa)
    if t < 1e-12: return np.eye(3)
    k = aa / t; K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + math.sin(t) * K + (1 - math.cos(t)) * K @ K


def project(p, pts, W, H):
    """world-xy+up points (n, 3) relative to the camera -> pixel (n, 2) in a W x H image, and in front (n,)"""
    c = pts @ rotation(p['computed_rotation']).T
    f, k1, k2 = (list(p['camera_parameters']) + [0, 0])[:3]
    z = c[:, 2]
    if p['camera_type'] == 'fisheye':
        l = np.hypot(c[:, 0], c[:, 1]) + 1e-9; th = np.arctan2(l, z)
        d = th * (1 + k1 * th ** 2 + k2 * th ** 4)
        u, v = f * d * c[:, 0] / l, f * d * c[:, 1] / l
        ok = th < np.radians(80)
    else:
        xn, yn = c[:, 0] / np.maximum(z, 1e-6), c[:, 1] / np.maximum(z, 1e-6)
        r2 = xn ** 2 + yn ** 2; d = 1 + k1 * r2 + k2 * r2 ** 2
        u, v = f * d * xn, f * d * yn
        ok = z > 0.5
    s = max(W, H)
    px = np.c_[u * s + W / 2, v * s + H / 2]
    return px, ok & (px[:, 0] >= 0) & (px[:, 0] < W) & (px[:, 1] >= 0) & (px[:, 1] < H)


# ---------------------------------------------------------------- walls
def wall_samples(p, fps, tree, polys, img):
    """{footprint index: lab pixels} this photo sees"""
    import shapely
    from shapely.geometry import LineString
    lo, la = p['computed_geometry']['coordinates']
    cx, cy = xy(la, lo)
    H, W = img.shape[:2]
    lab = None
    out = {}
    for k in tree.query(shapely.Point(cx, cy).buffer(60)):
        r = fps[k]
        n = len(r)
        s = 1 if 0.5 * sum(r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1] for i in range(n)) > 0 else -1
        for i in range(n):
            (ax, ay), (bx, by) = r[i], r[(i + 1) % n]
            L = math.hypot(bx - ax, by - ay)
            if L < 4: continue
            ux, uy = (bx - ax) / L, (by - ay) / L; nx, ny = s * uy, -s * ux
            mx, my = (ax + bx) / 2, (ay + by) / 2
            dist = (cx - mx) * nx + (cy - my) * ny  # in front of the wall, facing it
            if not 8 < dist < 60 or math.hypot(cx - mx, cy - my) > 60: continue
            ts = np.linspace(0.15, 0.85, 8)
            ends = [(ax + (bx - ax) * t + nx * 0.3, ay + (by - ay) * t + ny * 0.3) for t in (0.15, 0.5, 0.85)]
            if any(len(set(tree.query(LineString([(cx, cy), e]), predicate='intersects')) - {k}) for e in ends): continue  # hidden
            zs = np.linspace(3, 9, 6)
            g = np.array([(ax + (bx - ax) * t - cx, ay + (by - ay) * t - cy, z - CAM_H) for t in ts for z in zs])
            px, ok = project(p, g, W, H)
            if ok.sum() < 12: continue
            if lab is None: lab = srgb_lab(img.reshape(-1, 3)).reshape(H, W, 3)
            q = px[ok].astype(int)
            out.setdefault(k, []).append(lab[q[:, 1], q[:, 0]])
    return {k: np.concatenate(v) for k, v in out.items()}


def balance(img):
    """the photo's greys (low chroma, mid lightness: paving, concrete) -> their median L*, a*, b* (exposure and white
    balance to undo), or None"""
    lab = srgb_lab(img[::8, ::8].reshape(-1, 3))
    g = lab[(np.hypot(lab[:, 1], lab[:, 2]) < 12) & (lab[:, 0] > 15) & (lab[:, 0] < 90)]
    return np.median(g, 0) if len(g) > 200 else None


def per_photo(job):
    from PIL import Image
    p, fps_near = job
    f = thumb(p)
    if not f: return p['id'], {}
    try: img = np.asarray(Image.open(f).convert('RGB'))
    except Exception: return p['id'], {}
    import shapely
    keys = list(fps_near)
    polys = shapely.make_valid(np.array([shapely.Polygon(fps_near[k]) for k in keys]))
    tree = shapely.STRtree(polys)
    sm = wall_samples(p, [fps_near[k] for k in keys], tree, polys, img)
    grey = balance(img)
    if grey is None: return p['id'], {}
    res = {}
    for i, lab in sm.items():
        keep = ~((lab[:, 1] < -6) & (lab[:, 2] > 0)) & ~((lab[:, 2] < -14) & (lab[:, 0] > 55)) & (lab[:, 0] > 8)  # leaves, sky, black
        lab = lab[keep]
        if len(lab) < 15: continue
        lab = lab[lab[:, 0] >= np.percentile(lab[:, 0], 40)]  # the wall, not its (darker) windows
        c = np.median(lab, 0)
        c[0] = min(100, c[0] * GREY_L / max(grey[0], 20))  # exposed as if the street's greys were GREY_L
        c[1:] += np.array(NEUTRAL) - grey[1:]
        res[keys[i]] = c
    return p['id'], res


def bake(areas, procs=8):
    from facades import footprints
    t0 = time.time()
    fps = footprints()
    rings = [np.array(r, float) for _, r, _ in fps]
    cent = np.array([r.mean(0) for r in rings])
    ph = {}
    for a in areas:
        s, w, n, e = AREAS[a] if a in AREAS else map(float, a.split(','))
        ph.update(photos(s, w, n, e))
    print(len(ph), 'photos', f'{time.time() - t0:.0f}s', flush=True)
    jobs = []
    for p in ph.values():
        lo, la = p['computed_geometry']['coordinates']
        cx, cy = xy(la, lo)
        near = np.flatnonzero(np.hypot(cent[:, 0] - cx, cent[:, 1] - cy) < 120)
        if len(near): jobs.append((p, {int(k): rings[k] for k in near}))
    seen = {}
    with ThreadPoolExecutor(procs) as ex:
        for n_, (pid, res) in enumerate(ex.map(per_photo, jobs)):
            for k, lab in res.items(): seen.setdefault(k, []).append((pid, lab))
            if n_ % 500 == 0: print(n_, '/', len(jobs), 'photos,', len(seen), 'walls seen', f'{time.time() - t0:.0f}s', flush=True)
    rows = []
    for k, v in seen.items():
        if len(v) < 2: continue
        labs = np.array([l for _, l in v])
        med = np.median(labs, 0)
        good = np.linalg.norm(labs - med, axis=1) < 18  # photos that agree
        if good.sum() < 2: continue
        c = np.median(labs[good], 0); c[0] = np.clip(c[0], *L_RANGE)
        rows.append((k, lab_srgb(c), [pid for (pid, _), g in zip(v, good) if g][:3], int(good.sum())))
    ids = np.array([(i + ['0', '0', '0'])[:3] for _, _, i, _ in rows], dtype='U20').reshape(-1, 3)
    save_rings(OUT, [rings[k] for k, *_ in rows], rgb=np.array([c for _, c, _, _ in rows], np.uint8).reshape(-1, 3), images=ids,
                        n=np.array([n for *_, n in rows], np.uint16))
    print(len(rows), 'wall colours ->', OUT, f'{time.time() - t0:.0f}s', flush=True)


def check():
    # a camera at the origin looking north, level: east-north-up -> camera (x right = east, y down = -up, z ahead = north)
    aa = np.array([math.pi / 2, 0, 0])  # rotates up (z) onto -y and north (y) onto z
    p = dict(computed_rotation=aa, camera_type='perspective', camera_parameters=[0.8, 0, 0])
    px, ok = project(p, np.array([[0, 20, 0], [5, 20, 5], [0, -20, 0]], float), 1024, 768)
    assert ok[0] and ok[1] and not ok[2], ok
    assert abs(px[0][0] - 512) < 1e-6 and abs(px[0][1] - 384) < 1e-6, px[0]
    assert px[1][0] > 512 and px[1][1] < 384, px[1]  # east is right, up is up
    p['camera_type'] = 'fisheye'; p['camera_parameters'] = [0.45, 0, 0]
    px, ok = project(p, np.array([[0, 20, 0], [20, 20, 0]], float), 1024, 576)
    assert ok.all() and abs(px[1][0] - 512 - 0.45 * math.pi / 4 * 1024) < 1e-6, px
    img = np.full((200, 200, 3), (150, 142, 132), np.uint8)
    assert np.abs(balance(img) - srgb_lab(np.array([[150, 142, 132]], np.uint8))[0]).max() < 0.5
    print('mapillary check ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['check']: check()
    else: bake(sys.argv[1:] or list(AREAS))
