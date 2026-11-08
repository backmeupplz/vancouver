# Wall colours from Mapillary street photos (CC BY-SA 4.0), into data/mapillary/walls.npz, which tools/facades.py
# folds into data/facades.npz. For each daylight photo (posed by Mapillary's own reconstruction: computed_geometry +
# computed_rotation; not panoramas, not taken inside a building) and each building wall 6-45 m away that faces it and
# that no other footprint hides, a grid of points on the wall (2.5 m up to 6 m or 75% of its HRDEM height) is projected
# into the 1024 px thumbnail. Only the points where Mapillary's own segmentation of the photo sees a building count (so
# not the car, hedge, fence, tree or sky in front of it); leaves, sky and deep shadow dropped, the brighter part (the
# wall, not its windows) gives that photo's raw colour of the wall, kept with the photo's own greys. A wall's colour is
# the weighted mean of its photos that agree (AGREE), each exposed and white-balanced on its photo's greys.
# The map goes 4 km bucket by bucket (the City of Vancouver first, then outwards); in each, photos are taken newest
# first only while they show a wall (of 40 m2 or more) that has fewer than NEED photos, so most are never downloaded.
# Everything is cached in data/mapillary/ (not committed): API answers, thumbnails, segmentations, per bucket the raw samples
# (b/<i>_<j>.npz), so a stopped run resumes and `assemble` re-tunes the colours without the network. The client token
# comes in as $MLY (never printed, sent only as a header):
#   node ~/.openclaw/bin/openclaw-vaultwarden-exec.mjs --item 'Mapillary token' --field 'access token' --env MLY -- \
#     uv run --with numpy,shapely,pillow,mapbox-vector-tile python3 tools/mapillary.py [procs]
#   ... tools/mapillary.py assemble        (walls.npz from the buckets done so far, no network)
#   ... tools/mapillary.py sheet [n] [seed] [i_j]   (n random walls: photo beside colour, data/mapillary/sheet-<seed>.jpg)
#   ... tools/mapillary.py check           (self-test of the camera models, no network)
import glob, json, math, multiprocessing, os, sys, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import xy, latlon, L1, save_rings, retry, hr_tile
from roofs import srgb_lab, lab_srgb

DIR = 'data/mapillary'
OUT = f'{DIR}/walls.npz'
API = 'https://graph.mapillary.com'
FIELDS = 'id,computed_geometry,computed_rotation,camera_type,camera_parameters,width,height,captured_at,is_pano,thumb_1024_url'
SINCE = 2015         # older photos: too many walls repainted or rebuilt since
CELL = 0.012         # first API query box, degrees; split in four while a box returns the API's 2000 maximum
NEED = 4             # photos wanted per wall (2 must agree; some fail the checks)
MIN_AREA = 40        # m2: sheds and garages are not worth a photo
CAM_H = 1.8          # camera height above the street, metres (dashcams and phones)
NEUTRAL = (0.0, 2.0)  # a*, b* the photo's greys are pulled to (grey paving and concrete are a touch warm)
GREY_L = 68.0         # L* of the street's greys in daylight: photos expose for the sky, walls come out dark. Calibration knob.
L_RANGE = (45, 94)    # walls under bridges, awnings and deep shade read too dark; few real walls are darker than L* 40
CHROMA = 1.35         # a*, b* gain (calibration knob: the median of a wall's pixels is a little greyer than the wall)
WB_MAX = 4.0          # at most this much white balance (a*, b*): a sunny street's warm greys turned white walls lavender
AGREE = 12            # L*a*b* distance within which two photos agree on a wall
MIN_AGREE = 2         # photos that must agree
MIN_DAYS = 1          # ... taken on this many different days
MIN_H = 0.0           # m: lower buildings hide behind fences, hedges and parked cars
PALETTE_DE = 0        # a colour this close to one the palette has anyway is no gain: dropped
CITY = (-3, 1, -3, 0)  # the City of Vancouver's 4 km buckets go first


# ---------------------------------------------------------------- the API (cached)
def api(path, cache):
    if os.path.exists(cache): return json.load(open(cache))
    tok = os.environ.get('MLY')
    if not tok: sys.exit('no $MLY: run through openclaw-vaultwarden-exec (see the top of this file)')
    def get():
        try: return json.load(urllib.request.urlopen(urllib.request.Request(API + path, headers={'Authorization': 'OAuth ' + tok}), timeout=90))
        except urllib.error.HTTPError as err:
            if err.code >= 500: return err  # the box is too heavy for the API: not worth retrying, the caller quarters it
            raise
    d = retry(get)
    if isinstance(d, Exception): raise d
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    json.dump(d, open(cache, 'w'))
    time.sleep(0.25)  # polite
    return d


def query(w, s, e, n):
    """every image in a lon/lat box: split in four while the API returns its maximum"""
    b = f'{w:.4f},{s:.4f},{e:.4f},{n:.4f}'
    try: d = api(f'/images?fields={FIELDS}&bbox={b}&limit=2000', f'{DIR}/api/{b}.json').get('data', [])
    except urllib.error.HTTPError as err:  # the API times out on its densest boxes: ask for quarters
        if err.code < 500 or e - w < 0.0015: print('skipped box', b, err.code, flush=True); return []
        d = [None] * 2000
    if len(d) < 2000 or e - w < 0.0015: return d
    mx, my = (w + e) / 2, (s + n) / 2
    return query(w, s, mx, my) + query(mx, s, e, my) + query(w, my, mx, n) + query(mx, my, e, n)


def candidates(ij, cent):
    """the bucket's posed photos since SINCE, newest per 12 m square and heading, in boxes that hold buildings"""
    i, j = ij
    s, w = latlon(i * L1, j * L1); n, e = latlon((i + 1) * L1, (j + 1) * L1)
    boxes = []
    for la in np.arange(s, n, CELL):
        for lo in np.arange(w, e, CELL):
            x0, y0 = xy(la, lo); x1, y1 = xy(min(la + CELL, n), min(lo + CELL, e))
            if ((cent[:, 0] > x0) & (cent[:, 0] < x1) & (cent[:, 1] > y0) & (cent[:, 1] < y1)).sum() >= 3: boxes.append((lo, la, min(lo + CELL, e), min(la + CELL, n)))
    best = {}
    with ThreadPoolExecutor(4) as ex:  # 4 requests at a time, each followed by a pause
        for got in ex.map(lambda b: query(*b), boxes):
            for p in got:
                if not p.get('computed_rotation') or not p.get('computed_geometry') or not p.get('width') \
                        or p.get('camera_type') not in ('perspective', 'fisheye', 'spherical', 'equirectangular') or p['captured_at'] < (SINCE - 1970) * 365.25 * 86400e3 \
                        or not 8 <= (time.gmtime(p['captured_at'] / 1000).tm_hour - 8) % 24 <= 18: continue  # daylight (Pacific time)
                x, y = xy(p['computed_geometry']['coordinates'][1], p['computed_geometry']['coordinates'][0])
                k = (round(x / 12), round(y / 12), round(np.degrees(np.linalg.norm(p['computed_rotation'])) / 30))
                if k not in best or p['captured_at'] > best[k]['captured_at']: best[k] = p
    return sorted(best.values(), key=lambda p: -p['captured_at'])


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
    if p['camera_type'] in ('spherical', 'equirectangular'):  # a panorama: longitude across, latitude down
        lon, lat = np.arctan2(c[:, 0], c[:, 2]), np.arctan2(c[:, 1], np.hypot(c[:, 0], c[:, 2]))
        px = np.c_[(lon / (2 * np.pi) + 0.5) * W, (lat / np.pi + 0.5) * H]
        return px, (px[:, 0] >= 0) & (px[:, 0] < W) & (px[:, 1] >= 0) & (px[:, 1] < H)
    f, k1, k2 = (list(p.get('camera_parameters') or [0.8]) + [0, 0])[:3]
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
G = {}  # the footprints and their tree, set before the workers fork


def walls_seen(p):
    """{footprint index: (n, 2) points in the photo, as fractions of its width and height} for the walls it shows"""
    import shapely
    from shapely.geometry import LineString
    fps, tree = G['rings'], G['tree']
    lo, la = p['computed_geometry']['coordinates']
    cx, cy = xy(la, lo)
    if len(tree.query(shapely.Point(cx, cy), predicate='within')): return {}  # inside a building: a parkade, a mall
    W, H = p['width'], p['height']
    ts = np.linspace(0.15, 0.85, 8)
    out = {}
    for k in tree.query(shapely.Point(cx, cy).buffer(60)):
        if not G['target'][k]: continue
        zs = np.linspace(2.5, min(6.0, 0.75 * G['h'][k]), 6)  # up the wall, never into the sky above it
        r = fps[k]; n = len(r)
        s = G['orient'][k]
        for i in range(n):
            (ax, ay), (bx, by) = r[i], r[(i + 1) % n]
            L = math.hypot(bx - ax, by - ay)
            if L < 4: continue
            ux, uy = (bx - ax) / L, (by - ay) / L; nx, ny = s * uy, -s * ux
            mx, my = (ax + bx) / 2, (ay + by) / 2
            dist = (cx - mx) * nx + (cy - my) * ny  # in front of the wall, facing it
            far = math.hypot(cx - mx, cy - my)
            if not 6 < dist < 45 or far > 50 or dist < 0.4 * far: continue  # near, and seen within 66 degrees of head-on
            g = np.array([(ax + (bx - ax) * t - cx, ay + (by - ay) * t - cy, z - CAM_H) for t in ts for z in zs])
            px, ok = project(p, g, W, H)
            if ok.sum() < 12: continue
            ends = [(ax + (bx - ax) * t + nx * 0.3, ay + (by - ay) * t + ny * 0.3) for t in (0.15, 0.5, 0.85)]
            if any(len(set(tree.query(LineString([(cx, cy), e]), predicate='intersects')) - {k}) for e in ends): continue  # hidden
            out.setdefault(int(k), []).append(px[ok] / (W, H))
    return {k: np.concatenate(v) for k, v in out.items()}


def balance(img):
    """the photo's greys (low chroma, mid lightness: paving, concrete) -> their median L*, a*, b* (exposure and white
    balance to undo), or None"""
    lab = srgb_lab(img[::8, ::8].reshape(-1, 3))
    g = lab[(np.hypot(lab[:, 1], lab[:, 2]) < 12) & (lab[:, 0] > 15) & (lab[:, 0] < 90)]
    return np.median(g, 0) if len(g) > 200 else None


BUILDING = 'construction--structure--building'
DET_LOCK = threading.Semaphore(4)  # segmentation requests at a time


def building_mask(pid, W, H):
    """Mapillary's own segmentation of the photo: True where it sees a building (cached as data/mapillary/det/<id>.json,
    the building polygons only), or None when it has none"""
    import base64
    from PIL import Image, ImageDraw
    import mapbox_vector_tile
    f = f'{DIR}/det/{pid}.json'
    if not os.path.exists(f):
        with DET_LOCK:
            try: d = api(f'/{pid}/detections?fields=value,geometry', f + '.tmp')
            except Exception: return None
        json.dump([x['geometry'] for x in d.get('data', []) if x.get('value') == BUILDING], open(f, 'w'))
        os.remove(f + '.tmp')
    m = Image.new('L', (W, H), 0); dr = ImageDraw.Draw(m)
    for g in json.load(open(f)):
        for layer in mapbox_vector_tile.decode(base64.b64decode(g)).values():
            ext = layer.get('extent', 4096)
            for ft in layer['features']:
                geom = ft['geometry']
                for poly in ([geom['coordinates']] if geom['type'] == 'Polygon' else geom['coordinates']):
                    for n, ring in enumerate(poly):  # outer ring, then holes
                        dr.polygon([(x / ext * W, (1 - y / ext) * H) for x, y in ring], fill=0 if n else 1)
    a = np.array(m, bool)
    return a if a.any() else None


def raw_colour(img, uv, sky_lab=None, mask=None):
    """the wall's raw L*a*b* at these points (fractions) of the photo, only where Mapillary's segmentation sees a
    building (mask): leaves, sky and black dropped, the brighter part (the wall, not its windows); None where leaves or
    sky fill much of it (a tree in front, the wall missed) or the segmentation sees little building there"""
    H, W = img.shape[:2]
    q = np.minimum((uv * (W, H)).astype(int), (W - 1, H - 1))
    if mask is not None:
        inb = mask[q[:, 1], q[:, 0]]
        if inb.sum() < max(12, 0.5 * len(q)): return None  # a car, a hedge, a tree or the sky in front of it
        q = q[inb]
    lab = srgb_lab(img[q[:, 1], q[:, 0]])
    leaf = (lab[:, 1] < -3) & (lab[:, 2] > 3)
    sky = (lab[:, 0] > 90) | (lab[:, 2] < -12) & (lab[:, 0] > 50)  # overcast white, blue
    if sky_lab is not None: sky |= np.linalg.norm(lab - sky_lab, axis=1) < 8  # this photo's own sky
    if leaf.mean() > 0.65 or sky.mean() > 0.35: return None
    lab = lab[~leaf & ~sky & (lab[:, 0] > 22)]  # and deep shadow
    if len(lab) < 15: return None
    return np.median(lab[lab[:, 0] >= np.percentile(lab[:, 0], 25)], 0)


def sample(job):
    """one downloaded photo -> (id, greys, [(footprint, raw lab, uv box)])"""
    from PIL import Image
    p, seen = job
    f = thumb(p)
    if not f: return p['id'], None, []
    try: img = np.asarray(Image.open(f).convert('RGB'))
    except Exception: return p['id'], None, []
    grey = balance(img)
    if grey is None or grey[0] < 30: return p['id'], None, []  # dusk, night, a tunnel
    top = srgb_lab(img[:max(4, img.shape[0] // 12):4, ::8].reshape(-1, 3))
    sky = np.median(top, 0) if top[:, 0].mean() > 65 and top[:, 0].std() < 12 else None  # an open sky along the top
    mask = building_mask(p['id'], img.shape[1], img.shape[0])
    if mask is None: return p['id'], None, []
    out = []
    for k, uv in seen.items():
        c = raw_colour(img, uv, sky, mask)
        if c is not None: out.append((k, c, np.r_[uv.min(0), uv.max(0)]))
    return p['id'], grey, out


def do_bucket(ij, procs):
    """photos -> raw wall samples for the buckets's target footprints, into b/<i>_<j>.npz"""
    out = f'{DIR}/b/{ij[0]}_{ij[1]}.npz'
    if os.path.exists(out): return None
    cent, mine = G['cent'], G['bucket'] == G['bid'][ij]
    t0 = time.time()
    cands = candidates(ij, cent[mine])
    with multiprocessing.get_context('fork').Pool(procs) as pool:
        seen = pool.map(walls_seen, cands, chunksize=16)
    count, keep = {}, []
    for p, sn in zip(cands, seen):  # newest first: a photo is kept while it shows a wall that still wants photos
        sn = {k: v for k, v in sn.items() if mine[k]}
        if sn and any(count.get(k, 0) < NEED for k in sn):
            keep.append((p, sn))
            for k in sn: count[k] = count.get(k, 0) + 1
    rows = []
    with ThreadPoolExecutor(12) as ex:
        for pid, grey, res in ex.map(sample, keep):
            for k, c, box in res: rows.append((k, int(pid), *c, *grey, *box))
    pids = np.array([r[1] for r in rows], np.int64)  # ids pass 2^53: not through floats
    a = np.array(rows, float).reshape(-1, 12)
    ks = np.unique(a[:, 0]).astype(int) if len(a) else np.zeros(0, int)
    rc = np.array([q for k in ks for q in G['rings'][k]], np.float32).reshape(-1, 2)
    ro = np.cumsum([0] + [len(G['rings'][k]) for k in ks]).astype(np.int32)
    idx = np.searchsorted(ks, a[:, 0].astype(int)) if len(a) else np.zeros(0, int)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    np.savez_compressed(out, rc=rc, ro=ro, fp=idx.astype(np.int32), pid=pids, lab=a[:, 2:5].astype(np.float32),
                        grey=a[:, 5:8].astype(np.float32), box=a[:, 8:12].astype(np.float32))
    return len(cands), len(keep), len(ks), round(time.time() - t0)


def heights(rings, cent, bucket, ijs):
    """each footprint's height (m) in the HRDEM surface over terrain (data/hr, 2 m): the highest of its centre and
    points 60% of the way out to its corners; 0 where there is no HRDEM"""
    h = np.zeros(len(rings))
    for i, j in ijs:
        a = hr_tile(i, j)
        if a is None: continue
        z = a[0] - a[1]
        for k in np.flatnonzero(bucket == i * 1000 + j):
            pts = np.vstack([cent[k], cent[k] + 0.6 * (rings[k] - cent[k])])
            col = np.clip(((pts[:, 0] - i * L1) / 2).astype(int), 0, 2047); row = np.clip((((j + 1) * L1 - pts[:, 1]) / 2).astype(int), 0, 2047)
            v = z[row, col]
            h[k] = np.nanmax(v) if np.isfinite(v).any() else 0
    return h


def setup():
    """the footprints, their tree, heights and buckets into G; -> the buckets, the city's first"""
    import shapely
    from facades import footprints
    fps = footprints()
    rings = [np.array(r, float) for _, r, _ in fps]
    polys = shapely.make_valid(np.array([shapely.Polygon(r) for r in rings]))
    area = shapely.area(polys)
    cent = np.array([r.mean(0) for r in rings])
    bucket = (np.floor(cent[:, 0] / L1).astype(int) * 1000 + np.floor(cent[:, 1] / L1).astype(int))
    ijs = sorted({(int(math.floor(c[0] / L1)), int(math.floor(c[1] / L1))) for c in cent})
    h = heights(rings, cent, bucket, ijs)
    G.update(rings=rings, tree=shapely.STRtree(polys), cent=cent, target=(area >= MIN_AREA) & (h >= 3.5), bucket=bucket, h=h,
             orient=[1 if 0.5 * np.sum(r[:, 0] * np.roll(r[:, 1], -1) - np.roll(r[:, 0], -1) * r[:, 1]) > 0 else -1 for r in rings])
    G['bid'] = {ij: ij[0] * 1000 + ij[1] for ij in ijs}
    city = lambda ij: CITY[0] <= ij[0] <= CITY[1] and CITY[2] <= ij[1] <= CITY[3]
    ijs.sort(key=lambda ij: (not city(ij), math.hypot(ij[0] + 0.5, ij[1] + 0.5)))
    return ijs


def bake(procs):
    t0 = time.time()
    ijs = setup()
    print(len(G['rings']), 'footprints,', int(G['target'].sum()), 'worth a photo,', len(ijs), 'buckets', f'{time.time() - t0:.0f}s', flush=True)
    for ij in ijs:
        r = do_bucket(ij, procs)
        if r: print(ij, 'photos', r[0], 'kept', r[1], 'walls', r[2], f'{r[3]}s', f'total {time.time() - t0:.0f}s', flush=True)
    assemble()


# ---------------------------------------------------------------- colours
def exposed(lab, grey):
    """raw wall L*a*b* -> as if the photo's greys were GREY_L and NEUTRAL"""
    c = lab.copy()
    c[:, 0] = np.minimum(100, c[:, 0] * GREY_L / np.maximum(grey[:, 0], 20))
    c[:, 1:] = (c[:, 1:] + np.clip(np.array(NEUTRAL) - grey[:, 1:], -WB_MAX, WB_MAX)) * CHROMA
    return c


def days():
    """photo id -> the day it was taken (days since 1970; negative for panoramas), from the cached API answers
    (cached in days.npz)"""
    f = f'{DIR}/days.npz'
    api_files = glob.glob(f'{DIR}/api/*.json')
    if os.path.exists(f) and os.path.getmtime(f) >= max(os.path.getmtime(a) for a in api_files):
        d = np.load(f); return dict(zip(d['pid'].tolist(), d['day'].tolist()))
    out = {}
    for a in api_files:
        for p in json.load(open(a)).get('data', []):
            out[int(p['id'])] = int(p['captured_at'] // 86400000) * (-1 if p.get('camera_type') in ('spherical', 'equirectangular') else 1)
    np.savez(f, pid=np.array(list(out), np.int64), day=np.array(list(out.values()), np.int32))
    return out


def palette_lab():
    """L*a*b* of every wall colour the page's palettes can pick (public/core/tile-worker.js PALETTES, colours as seen)"""
    import re
    js = open(os.path.join(os.path.dirname(__file__), '..', 'public/core/tile-worker.js')).read()
    js = js[js.index('const PALETTES'):]
    js = js[:js.index('\n]')]
    hexes = [h for m in re.finditer(r'wall: \[([^\]]*)\]', js) for h in m.group(1).split(',')]
    return srgb_lab(np.array([[int(h, 16) >> 16 & 255, int(h, 16) >> 8 & 255, int(h, 16) & 255] for h in hexes], np.uint8))


def walls(buckets='*'):
    """every bucket's walls: [(ring, colour lab, photo ids, (bucket file, the rows that agree))]. A wall's photos agree
    when within AGREE of the one most of them are near; it needs MIN_AGREE of them, from MIN_DAYS different days, on a
    building of MIN_H or more. Closer photos (the wall bigger in them) weigh more. Sky-tinted and leaf-tinted results are
    dropped, and so is a colour within PALETTE_DE of one the page's palette has anyway (0: off; on, it cut the many
    right walls and kept the odd ones)."""
    out = []
    day, pal = days(), palette_lab()
    real = {int(float(i)): i for i in day}  # bucket files from before pids were kept as integers went through floats
    for f in sorted(glob.glob(f'{DIR}/b/{buckets}.npz')):
        d = dict(np.load(f))
        if not len(d['fp']): continue
        d['pid'] = np.array([real.get(int(i), int(i)) for i in d['pid']], np.int64)
        ok = np.array([day.get(int(i), 1) > 0 for i in d['pid']])  # panoramas' poses miss too often: not used
        lab = exposed(d['lab'], d['grey'])
        i, j = map(int, os.path.basename(f)[:-4].split('_'))
        rings = [d['rc'][d['ro'][k]:d['ro'][k + 1]] for k in range(len(d['ro']) - 1)]
        tall = heights(rings, np.array([r.mean(0) for r in rings]), np.full(len(rings), i * 1000 + j), [(i, j)]) >= MIN_H
        box = d['box']; wt = np.clip((box[:, 2] - box[:, 0]) * (box[:, 3] - box[:, 1]), 0.002, 0.2)
        order = np.argsort(d['fp'], kind='stable')
        ks, starts = np.unique(d['fp'][order], return_index=True)
        for k, rows in zip(ks, np.split(order, starts[1:])):
            if not tall[k]: continue  # houses: fences, hedges and parked cars stand in front of their walls
            rows = rows[ok[rows]]
            if len(rows) < 2: continue
            labs = lab[rows]
            near = np.linalg.norm(labs[:, None] - labs[None], axis=2) < AGREE
            best = max(range(len(rows)), key=lambda i: (near[i].sum(), wt[rows[i]]))
            good = near[best]
            n_days = len({day.get(int(pid), pid) for pid in d['pid'][rows][good]})
            if good.sum() < MIN_AGREE or n_days < MIN_DAYS: continue  # independent drives: one bad pose repeats within a drive
            w = wt[rows][good]
            c = (labs[good] * w[:, None]).sum(0) / w.sum(); c[0] = np.clip(c[0], *L_RANGE)
            if c[2] < -4 and c[1] > 2 or c[2] < -3 and c[0] > 78 or c[1] < -8: continue  # lavender, pale blue: the sky; green: leaves
            if np.linalg.norm(pal - c, axis=1).min() < PALETTE_DE: continue
            gr = rows[good][np.argsort(-w)]
            out.append((d['rc'][d['ro'][k]:d['ro'][k + 1]], c, [str(i) for i in d['pid'][gr][:3]], (f, gr)))
    return out


def assemble():
    t0 = time.time()
    ws = walls()
    ids = np.array([(w[2] + ['0', '0', '0'])[:3] for w in ws], dtype='U20').reshape(-1, 3)
    rgb = lab_srgb(np.array([w[1] for w in ws])).reshape(-1, 3) if ws else np.zeros((0, 3), np.uint8)
    save_rings(OUT, [w[0] for w in ws], rgb=rgb, images=ids, n=np.array([len(w[3][1]) for w in ws], np.uint16))
    print(len(ws), 'wall colours ->', OUT, f'{time.time() - t0:.0f}s', flush=True)


def sheet(n=30, seed=1, buckets='*'):
    """n random walls: two of their photos, cropped around the wall, beside the wall's colour"""
    from PIL import Image, ImageDraw
    ws = walls(buckets)
    rng = np.random.default_rng(seed)
    tiles = []
    for w in [ws[k] for k in rng.choice(len(ws), min(n, len(ws)), replace=False)]:
        f, rows = w[3]
        box = np.load(f)['box']
        t = Image.new('RGB', (440, 150), 'white')
        for m, (pid, r) in enumerate(list(zip(w[2], rows))[:2]):
            img = Image.open(f'{DIR}/thumbs/{pid}.jpg').convert('RGB')
            W, H = img.size
            x0, y0, x1, y1 = box[r] * (W, H, W, H)
            t.paste(img.crop((max(0, x0 - 30), max(0, y0 - 30), min(W, x1 + 30), min(H, y1 + 30))).resize((170, 150)), (m * 172, 0))
        ImageDraw.Draw(t).rectangle((346, 0, 440, 150), fill=tuple(int(v) for v in lab_srgb(w[1][None])[0]))
        tiles.append(t)
    cols = 3
    sh = Image.new('RGB', (cols * 444, ((len(tiles) + cols - 1) // cols) * 154), 'white')
    for k, t in enumerate(tiles): sh.paste(t, ((k % cols) * 444, (k // cols) * 154))
    out = f'{DIR}/sheet-{seed}.jpg'
    sh.save(out, quality=88)
    print(out)


def check():
    # a camera at the origin looking north, level: east-north-up -> camera (x right = east, y down = -up, z ahead = north)
    aa = np.array([math.pi / 2, 0, 0])  # rotates up (z) onto -y and north (y) onto z
    p = dict(computed_rotation=aa, camera_type='perspective', camera_parameters=[0.8, 0, 0])
    px, ok = project(p, np.array([[0, 20, 0], [5, 20, 5], [0, -20, 0]], float), 1024, 768)
    assert ok[0] and ok[1] and not ok[2], ok
    assert abs(px[0][0] - 512) < 1e-6 and abs(px[0][1] - 384) < 1e-6, px[0]
    assert px[1][0] > 512 and px[1][1] < 384, px[1]  # east is right, up is up
    p['camera_type'] = 'spherical'  # ahead is the middle, east a quarter turn right, up above the horizon
    px, ok = project(p, np.array([[0, 20, 0], [20, 0, 0], [0, 20, 5]], float), 2048, 1024)
    assert ok.all() and np.abs(px[0] - (1024, 512)).max() < 1e-6 and abs(px[1][0] - 1536) < 1e-6 and px[2][1] < 512, px
    p['camera_type'] = 'fisheye'; p['camera_parameters'] = [0.45, 0, 0]
    px, ok = project(p, np.array([[0, 20, 0], [20, 20, 0]], float), 1024, 576)
    assert ok.all() and abs(px[1][0] - 512 - 0.45 * math.pi / 4 * 1024) < 1e-6, px
    img = np.full((200, 200, 3), (150, 146, 140), np.uint8)
    grey = balance(img)
    assert np.abs(grey - srgb_lab(np.array([[150, 146, 140]], np.uint8))[0]).max() < 0.5
    # the photo's greys at GREY_L and NEUTRAL: a wall as bright as them comes out at GREY_L, neutral
    c = exposed(grey[None].astype(float), grey[None].astype(float))[0]
    assert abs(c[0] - GREY_L) < 1e-6 and np.abs(c[1:] - np.array(NEUTRAL) * CHROMA).max() < 1e-6, c
    print('mapillary check ok')


if __name__ == '__main__':
    a = sys.argv[1:]
    if a == ['check']: check()
    elif a == ['assemble']: assemble()
    elif a[:1] == ['sheet']: sheet(*map(int, a[1:3]), *a[3:])  # sheet [n] [seed] [bucket glob, e.g. 2_-1]
    else: bake(int(a[0]) if a else 6)
