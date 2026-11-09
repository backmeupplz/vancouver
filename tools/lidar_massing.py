# Building massing from the City of Vancouver's 2022 LiDAR (about 50 points/m2, walls included; class 6 building,
# 2 ground), into data/massing22.npz, which tools/tiles.py uses where it has a building (else the HRDEM's 2 m levels).
# Per OSM footprint (as tiles.py builds them: buildings, and parts that start on the ground) the building is sliced
# every metre up: at each height its cross-section is the cells (0.5 m) whose top is at least that high, unless the
# wall points at that height close round a smaller outline (an overhang above: Harbour Centre's lookout, Vancouver
# House's widening top, a canopy), when that outline is it. Runs of slices that keep their shape (IoU) become one
# part (podium, tower, setbacks, penthouse, crown; a twist steps every few floors), each with its own outline fitted
# to the cells (the OSM footprint where they agree, a rectangle where they nearly fill one, else the traced outline:
# chamfers, curves, ovals), its foot (min height) and top refined to the roof cells it ends at. Thin peaks above the
# top (spires, masts) become a pointed cap. Heights are above the footprint's own ground (the ground returns round it),
# so tiles.py stacks them on its HRDEM base.
# Cells are owned by the nearest footprint within 3 m of it (overhangs past an OSM outline stay with their building).
# Each wall of the footprint and of the parts that stand back from it gets its look too (tools/lidar_walls.py).
# The LAS files (data/lidar2022/urls.json, zips by hand into data/lidar2022/, read one at a time out of their zip, or
# from las/ where unzipped) are first cut down to their building and ground points (with their intensity), sorted
# into 4 m cells (data/lidar2022/cache/, about an eighth of the size).
# Run: uv run --with numpy,scipy,shapely,pyproj,rasterio python3 tools/lidar_massing.py [procs [tile names to add]]
#      ... tools/lidar_massing.py check          (self-test on a synthetic tower)
#      ... tools/lidar_massing.py tile IN.laz OUT.npz | merge [DIR [OUT]]   (other LiDAR: tools/lidar_stream.py; needs laspy[lazrs])
import glob, math, os, shutil, sys, time
from multiprocessing import Pool
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import xy, latlon, L1, save_rings, load_feat, all_tiles, hnum, cpu_slot
from lidar_walls import walls_of

OUT = os.environ.get('MASSING', 'data/massing22.npz')  # (MASSING=<file>: a test bake beside the shared one)
OUT_LM = os.environ.get('MASSING_LM', 'data/massing_lm.npz')  # the rest of the Lower Mainland, merged from data/massing_lm/<tile>.npz
LAS = 'data/lidar2022/las'
CACHE = 'data/lidar2022/cache'
RES = 0.5        # m, raster cell
STEP = 1.0       # m between slices
MIN_TOP = 10.0   # m: lower buildings keep tiles.py's own shapes (pitched roofs fitted to the HRDEM)
REACH = 3.0      # m past its outline a footprint owns the cells nearer to it than to any other
KEEP = 0.9       # IoU with a run's first slice under which a new part starts
I_REF = 125.0    # the median intensity of the building returns in the City's downtown 2022 flights
MIN_CELLS = 16   # 4 m2: smaller bits of a slice are dropped (a spire is caught separately)
K = lambda n: max(1, round(n * 0.5 / RES))  # morphology radii are given in 0.5 m cells


def tune(dens):
    """points/m2 of a tile -> the raster cell and ground thinning (6-10 pts/m2 regional sets need 1 m cells to fill them)"""
    global RES, MIN_CELLS
    RES = 0.5 if dens >= 15 else 1.0
    MIN_CELLS = int(4 / RES ** 2)
    return 4 if dens >= 20 else 1  # keep every n-th ground point


# ---------------------------------------------------------------- the point cache
def las_header(path):
    import struct
    b = open(path, 'rb').read(375)
    off = struct.unpack('<I', b[96:100])[0]; pf = b[104] & 63; rl = struct.unpack('<H', b[105:107])[0]
    sc = struct.unpack('<3d', b[131:155]); of = struct.unpack('<3d', b[155:179])
    v = struct.unpack('<6d', b[179:227])
    return off, pf, rl, sc, of, v[1::2], v[0::2]  # ..., min (x, y, z), max


def cache_tile(path):
    """one LAS (or its zip as downloaded: unzipped beside the cache and deleted once read, so the LAS never pile up) ->
    its building points and every 4th ground point, as x, y (from the tile's corner), z, class, intensity, sorted into
    4 m cells (start: where each cell begins) in CACHE/<name>/"""
    name = os.path.basename(path)[:-4]
    d = f'{CACHE}/{name}'
    if os.path.exists(f'{d}/i.npy'): return name  # (a cache from before the intensity is made again)
    if path.endswith('.zip'):
        import tempfile, zipfile
        with zipfile.ZipFile(path) as z, tempfile.TemporaryDirectory(dir=CACHE) as t:
            las = [m for m in z.namelist() if m.lower().endswith('.las')]
            if not las: return name
            return cache_tile(z.extract(las[0], t))  # (named as its zip)
    off, pf, rl, sc, of, mn, mx = las_header(path)
    dt = np.dtype(dict(names=['x', 'y', 'z', 'i', 'cls'], formats=['<i4', '<i4', '<i4', '<u2', 'u1'], offsets=[0, 4, 8, 12, 16 if pf >= 6 else 15], itemsize=rl))
    p = np.memmap(path, dt, 'r', offset=off)
    cls = np.asarray(p['cls']) & 31
    keep = (cls == 6) | (cls == 2) & (np.arange(len(cls)) % 4 == 0)
    x0, y0 = math.floor(mn[0]), math.floor(mn[1])
    x = (p['x'][keep] * sc[0] + of[0] - x0).astype(np.float32); y = (p['y'][keep] * sc[1] + of[1] - y0).astype(np.float32)
    z = (p['z'][keep] * sc[2] + of[2]).astype(np.float32); cls = cls[keep]
    write_cache(d, x, y, z, cls, x0, y0, int((mx[0] - x0) // 4) + 1, int((mx[1] - y0) // 4) + 1, np.asarray(p['i'][keep]))
    return name


def write_cache(d, x, y, z, cls, x0, y0, nx, ny, inten=None):
    """points (x, y from the corner x0, y0; z; class; intensity, 0s where the set has none) -> d/, sorted into nx x ny
    4 m cells"""
    if inten is None: inten = np.zeros(len(x), np.uint16)
    key = np.clip(y // 4, 0, ny - 1).astype(np.int64) * nx + np.clip(x // 4, 0, nx - 1).astype(np.int64)
    o = np.argsort(key, kind='stable')
    os.makedirs(d + '.tmp', exist_ok=True)
    for k, v in (('x', x[o]), ('y', y[o]), ('z', z[o]), ('cls', cls[o]), ('i', inten[o])): np.save(f'{d}.tmp/{k}.npy', v)
    np.save(f'{d}.tmp/meta.npy', np.array([x0, y0, nx, ny], np.float64))
    np.save(f'{d}.tmp/start.npy', np.searchsorted(key[o], np.arange(nx * ny + 1)).astype(np.int64))
    if os.path.exists(d): shutil.rmtree(d)
    os.replace(d + '.tmp', d)


class Cloud:
    """the cached tiles, opened lazily (memory-mapped): box(e0, n0, e1, n1) -> UTM x, y, z, class, intensity arrays"""
    def __init__(self, cache=CACHE):
        self.t = {}
        for d in sorted(glob.glob(f'{cache}/*/meta.npy')):
            x0, y0, nx, ny = np.load(d)
            self.t[os.path.dirname(d)] = (x0, y0, int(nx), int(ny), None)

    def covers(self, e, n):
        return any(x0 <= e < x0 + nx * 4 and y0 <= n < y0 + ny * 4 for x0, y0, nx, ny, _ in self.t.values())

    def box(self, e0, n0, e1, n1):
        out = []
        for d, (x0, y0, nx, ny, a) in self.t.items():
            if e1 < x0 or e0 >= x0 + nx * 4 or n1 < y0 or n0 >= y0 + ny * 4: continue
            if a is None:
                a = {k: np.load(f'{d}/{k}.npy', mmap_mode='r') for k in ('x', 'y', 'z', 'cls', 'i', 'start')}
                # intensity on one scale: each flight's (and sensor's) gain differs, so the tile's building returns are
                # brought to the median of the City's downtown flights (0 where the set has no intensity)
                c, i = np.asarray(a['cls'][::97]), np.asarray(a['i'][::97])
                med = float(np.median(i[c == 6])) if (c == 6).sum() > 100 else 0.0
                a['k'] = I_REF / med if med > 0 else 0.0
                self.t[d] = (x0, y0, nx, ny, a)
            i0, i1 = max(0, int((e0 - x0) // 4)), min(nx - 1, int((e1 - x0) // 4))
            for j in range(max(0, int((n0 - y0) // 4)), min(ny - 1, int((n1 - y0) // 4)) + 1):
                s, t = a['start'][j * nx + i0], a['start'][j * nx + i1 + 1]
                if t > s: out.append((a['x'][s:t] + x0, a['y'][s:t] + y0, a['z'][s:t], a['cls'][s:t], a['i'][s:t] * np.float32(a['k'])))
        if not out: return [np.zeros(0)] * 5
        return [np.concatenate([o[k] for o in out]) for k in range(5)]


# ---------------------------------------------------------------- footprints (as tiles.py's buildings() takes them)
def footprints(cloud, tr):
    """[(osm id, world ring, UTM ring, tags)] of the buildings and ground-standing parts over the cached tiles"""
    import shapely
    from shapely.geometry import Polygon
    out = []
    ext = [(x0, y0, x0 + nx * 4, y0 + ny * 4) for x0, y0, nx, ny, _ in cloud.t.values()]
    tiles = set()
    for e0, n0, e1, n1 in ext:  # the 4 km tiles over the LiDAR
        for e, n in ((e0, n0), (e1, n0), (e0, n1), (e1, n1)):
            lo, la = tr.transform(e, n, direction='INVERSE')
            x, y = xy(la, lo)
            tiles.add((int(x // L1), int(y // L1)))
    for i, j in sorted(tiles):
        items = load_feat(i, j).get('buildings', [])
        parts_c = np.array([np.mean(o[:-1], axis=0) for _, prs, t in items if 'building:part' in t and 'building' not in t for o, _ in prs]).reshape(-1, 2)
        seen = set()
        for oid, prs, t in items:
            is_part = 'building:part' in t and 'building' not in t
            if is_part and (hnum(t.get('min_height')) or hnum(t.get('building:min_level'))): continue
            for outer, _ in prs:
                r = outer[:-1] if outer[0] == outer[-1] else outer
                if len(r) < 3 or len(r) > 400: continue
                c = np.mean(r, axis=0)
                if not (i * L1 <= c[0] < (i + 1) * L1 and j * L1 <= c[1] < (j + 1) * L1): continue
                key = (round(c[0] * 2), round(c[1] * 2))
                if key in seen: continue
                seen.add(key)
                if not is_part and len(parts_c):
                    xs, ys = [p[0] for p in r], [p[1] for p in r]
                    sel = parts_c[(parts_c[:, 0] > min(xs)) & (parts_c[:, 0] < max(xs)) & (parts_c[:, 1] > min(ys)) & (parts_c[:, 1] < max(ys))]
                    if len(sel) and shapely.contains_xy(Polygon(r), sel[:20, 0], sel[:20, 1]).any(): continue
                la, lo = latlon(np.array([p[0] for p in r]), np.array([p[1] for p in r]))
                e, n = tr.transform(lo, la)
                if not cloud.covers(float(np.mean(e)), float(np.mean(n))): continue
                out.append((oid, [tuple(p) for p in r], np.c_[e, n], t))
    return out


# ---------------------------------------------------------------- one building
def raster(polys, x0, y1, nx, ny):
    from rasterio.features import rasterize
    from rasterio.transform import Affine
    if not polys: return np.zeros((ny, nx), bool)
    return rasterize([(p, 1) for p in polys], out_shape=(ny, nx), transform=Affine(RES, 0, x0, 0, -RES, y1), dtype=np.uint8).astype(bool)


def slices(own, dsm, Z, ix, iy, zs):
    """the building's cross-section at each height zs: the cells whose top reaches it, or the outline the wall points
    there close round where that is clearly smaller (an overhang above)"""
    from scipy import ndimage
    o = np.argsort(Z); Z, ix, iy = Z[o], ix[o], iy[o]
    regs, wallish = [], []
    for z in zs:
        top = own & (dsm >= z)
        n = int(top.sum())
        reg = top
        if n >= MIN_CELLS:
            a, b = np.searchsorted(Z, [z - 0.75, z + 0.75])
            occ = np.zeros_like(own); occ[iy[a:b], ix[a:b]] = True
            occ &= ndimage.binary_dilation(own, iterations=K(2))
            ring = ndimage.binary_closing(occ, iterations=K(3))
            fill = ndimage.binary_fill_holes(ring) & top
            k = int(fill.sum())
            if 0.2 * n < k < 0.85 * n and k > 2 * int((occ & top).sum()): reg = fill
        regs.append(reg); wallish.append(reg is not top)
    # a lone slice that goes its own way is noise: keep the overhang outline only where its neighbours agree
    for k in range(1, len(zs) - 1):
        if wallish[k] and not wallish[k - 1] and not wallish[k + 1]: regs[k] = own & (dsm >= zs[k])
    return regs


def ledge(a, b):
    """do two outlines differ by more than jitter along their edges: a band of change at least 1.5 m deep somewhere"""
    from scipy import ndimage
    return ndimage.binary_erosion(a ^ b, iterations=1, structure=np.ones((3, 3))).sum() >= 12


def comps(m):
    from scipy import ndimage
    lab, n = ndimage.label(m)
    if not n: return []
    cnt = np.bincount(lab.ravel())
    return [lab == k for k in range(1, n + 1) if cnt[k] >= MIN_CELLS]


def runs(regs, zs, dsm):
    """slices -> parts [(mask, foot, top)]: runs of slices that keep their shape (each connected piece its own run)"""
    parts, active = [], []  # active: [mask at the run's start, foot, slice index of the run's start, last mask]
    def roof_at(m, nxt, k):  # the top of a part ending after slice k: its roof cells, between this slice and the next
        cells = m & ~nxt if nxt is not None else m
        lo, hi = zs[k], zs[k] + STEP
        if cells.sum() < 4: return lo + STEP / 2
        return float(np.clip(np.median(dsm[cells]), lo, hi))
    for k in range(len(zs)):
        cs = comps(regs[k])
        claimed = [False] * len(cs)
        still = []
        for run in active:
            ref, foot, k0, last = run
            mine = [i for i, c in enumerate(cs) if (c & last).any()]
            if len(mine) == 1:
                c = cs[mine[0]]
                shared = sum(1 for r in active if (c & r[3]).any())
                inter = (c & ref).sum(); iou = inter / ((c | ref).sum() or 1)
                if shared == 1 and (iou >= KEEP or not ledge(c, ref)):
                    run[3] = c; claimed[mine[0]] = True; still.append(run); continue
            top = roof_at(last, regs[k], k - 1)
            parts.append((ref, foot, top))
            for i in mine:
                if not claimed[i]:
                    claimed[i] = True; still.append([cs[i], top, k, cs[i]])
        for i, c in enumerate(cs):
            if not claimed[i]: still.append([c, 0.0 if k == 0 else zs[k] - STEP / 2, k, c])  # a new piece: on the ground, or an overhang's underside
        active = still
    for ref, foot, k0, last in active:
        parts.append((ref, foot, roof_at(last, None, len(zs) - 1)))
    return [(m, f, t) for m, f, t in parts if t - f >= 0.4]


def spire(dsm, part_mask, top):
    """a thin peak (spire, mast, a crown's point) standing over the top part: (row, col, height) or None"""
    from scipy import ndimage
    hi = part_mask & (dsm > top + 3)
    if not hi.any() or hi.sum() > 40: return None
    k = np.argmax(np.where(hi, dsm, -1))
    r, c = divmod(int(k), dsm.shape[1])
    near = ndimage.binary_dilation(hi, iterations=K(2))
    if (near & (dsm > top + 1)).sum() > 60: return None  # a plant room, not a point
    return r, c, float(dsm[r, c])


def mass(job):
    """one footprint -> (ground, [(UTM ring, foot, top, roof, ridge)]) or None"""
    import shapely
    from shapely.geometry import Polygon
    from rasterio.features import shapes
    from rasterio.transform import Affine
    from scipy import ndimage
    poly, others, cloud = job
    e0, n0, e1, n1 = poly.bounds
    M = REACH + 2
    x0, y1 = math.floor((e0 - M) / RES) * RES, math.ceil((n1 + M) / RES) * RES
    nx, ny = int(math.ceil((e1 + M - x0) / RES)), int(math.ceil((y1 - (n0 - M)) / RES))
    X, Y, Z, C, I = cloud.box(x0 - 8, y1 - ny * RES - 8, x0 + nx * RES + 8, y1 + 8)
    g = C == 2
    ring_d = shapely.distance(poly.boundary, shapely.points(X[g], Y[g])) if g.sum() else np.zeros(0)
    gz = Z[g][ring_d < 10] if g.sum() else np.zeros(0)
    if len(gz) < 10: return None
    ground = float(np.percentile(gz, 10))
    b = (C == 6) & (X >= x0) & (X < x0 + nx * RES) & (Y > y1 - ny * RES) & (Y <= y1)
    X, Y, Z, I = X[b], Y[b], Z[b] - ground, I[b]
    if len(Z) < 200: return None
    ix = ((X - x0) / RES).astype(int).clip(0, nx - 1); iy = ((y1 - Y) / RES).astype(int).clip(0, ny - 1)
    inside = raster([poly], x0, y1, nx, ny)
    other = raster(others, x0, y1, nx, ny)
    d_in = ndimage.distance_transform_edt(~inside) * RES
    d_ot = ndimage.distance_transform_edt(~other) * RES if other.any() else np.full(inside.shape, 1e9)
    own = inside & ~other | inside & (d_ot > 0) | ~inside & ~other & (d_in <= REACH) & (d_in < d_ot)
    own |= inside & ~ndimage.binary_erosion(other, iterations=1)  # a shared edge
    dsm = np.full((ny, nx), -99.0, np.float32)
    np.maximum.at(dsm, (iy, ix), Z)
    cnt = np.bincount(iy * nx + ix, minlength=nx * ny).reshape(ny, nx)
    dsm[cnt < 2] = -99
    # small dropouts (a dark roof, a skylight): the cell takes its neighbours' height
    gap = (dsm < -50) & own
    if gap.any():
        f = ndimage.grey_closing(dsm, size=3)
        dsm[gap] = np.where(f[gap] > -50, f[gap], -99)
    on = own & (dsm > 2)
    if inside.sum() < 16 or (on & inside).sum() < 0.5 * inside.sum(): return None  # not built yet when it flew, or gone
    top = float(np.percentile(dsm[on], 99.5))
    fr = np.array(poly.exterior.coords)[:-1]
    # the footprint's walls (tools/lidar_walls.py), with the roof's returns a m2: the set's density here
    roof = inside[iy, ix] & (Z > dsm[iy, ix] - 1.0)
    pd = roof.sum() / max(1.0, (inside & on).sum() * RES * RES)
    walls = [(a, b, 0.0, top, d) for a, b, d in walls_of(fr, X, Y, Z, I, top, pd)]
    if top < MIN_TOP: return (ground, [], walls) if walls else None
    zs = np.arange(1.0, top, STEP)
    regs = slices(own, dsm, Z, ix, iy, zs)
    parts = tidy(runs(regs, zs, dsm))
    if not parts: return (ground, [], walls) if walls else None
    tr = Affine(RES, 0, x0, 0, -RES, y1)
    out = []
    for q in sorted(parts, key=lambda q: q['foot']):
        m = q['mask']
        geo = shapely.unary_union([shapely.geometry.shape(s) for s, _ in shapes(m.astype(np.uint8), mask=m, transform=tr)]).buffer(0)
        geo = max(geo.geoms, key=lambda g: g.area) if hasattr(geo, 'geoms') else geo
        if geo.geom_type != 'Polygon' or geo.is_empty: continue
        geo = Polygon(geo.exterior)
        if q['unit']:  # rooftop plant, a lift overrun: a box (its rectangle) on the part below
            out.append((np.array(geo.minimum_rotated_rectangle.exterior.coords)[:-1], q['foot'], q['top'], UNIT, 0.0))
        else:
            r = fit(geo, poly)
            u = next((i for i, o in enumerate(out) if o[3] == 0 and abs(o[2] - q['foot']) < 0.75 and len(o[0]) == len(r) and np.allclose(o[0], r)), None)
            if u is not None: q['foot'] = out.pop(u)[1]  # fitted to the same outline as the part below: one part
            out.append((r, q['foot'], q['top'], q['roof'], q['ridge']))
    # a spire or mast over the highest part: a slender pointed cap
    hi = max((q for q in parts if not q['unit']), key=lambda q: q['ridge'] or q['top'])
    s = spire(dsm, hi['mask'], hi['ridge'] or hi['top'])
    if s:
        r, c, h = s
        ce, cn = x0 + (c + 0.5) * RES, y1 - (r + 0.5) * RES
        w, ht = 0.9, hi['ridge'] or hi['top']
        out.append((np.array([(ce - w, cn - w), (ce + w, cn - w), (ce + w, cn + w), (ce - w, cn + w)]), ht, ht + 0.3, 3, h))
    # the walls of the parts that stand back from the footprint (towers over podiums, setbacks): their own looks
    for r, f, t, rf, _ in out:
        if rf == UNIT or t - f < 6 or len(r) == len(fr) and np.allclose(r, fr): continue
        sel = (Z > f - 0.5) & (Z < t + 0.5)
        walls += [(a, b, f, t, d) for a, b, d in walls_of(r, X[sel], Y[sel], Z[sel] - f, I[sel], t - f, pd)]
    return ground, out, walls


UNIT = 255  # a part that is rooftop plant: tiles.py puts it on the part under it as a box


def tidy(raw):
    """the runs, cleaned up: a thin slab over most of the part below (a parapet, a raised roof edge) raises its roof; a
    stack of thin shrinking slabs (a dome, a pyramid, a sloped top) becomes that part's roof; a stack of small pieces
    (a mast, an elevator tower) one piece; small low pieces on a roof its plant; specks in the air dropped"""
    P = [dict(mask=m, foot=f, top=t, n=int(m.sum()), roof=0, ridge=0.0, unit=False, up=None, dead=False) for m, f, t in raw]
    def drop(c): c['dead'] = True
    live = lambda: [c for c in P if not c['dead']]
    def parent(c):
        best, bo = None, 0
        for p in live():
            if p is c or abs(p['top'] - c['foot']) > 0.75: continue
            o = int((p['mask'] & c['mask']).sum())
            if o >= 0.6 * c['n'] and o > bo: best, bo = p, o
        return best
    def kids(p): return [c for c in live() if c['up'] is p]
    for c in P: c['up'] = parent(c)
    A = RES * RES
    # parapets and raised edges: a thin slab over most of its parent
    for c in sorted(live(), key=lambda c: c['foot']):
        p = c['up']
        if p is None or c['top'] - c['foot'] >= 1.5: continue
        inter = (p['mask'] & c['mask']).sum()
        if inter / ((p['mask'] | c['mask']).sum() or 1) >= 0.7:
            p['top'] = c['top']
            for k in kids(c): k['up'] = p
            drop(c)
    # masts and lift towers: a stack of small pieces is one piece (the spire test caps it)
    for c in sorted(live(), key=lambda c: c['foot']):
        if c['dead'] or c['n'] * A >= 60: continue
        while True:
            ks = kids(c)
            if len(ks) != 1 or ks[0]['n'] * A >= 60: break
            k = ks[0]; c['top'] = k['top']
            for g in kids(k): g['up'] = c
            drop(k)
    # domes, pyramids and sloped tops: a chain of thin, shrinking slabs over a part is its roof
    for b in sorted(live(), key=lambda c: c['foot']):
        if b['dead'] or b['unit']: continue
        chain, cur = [], b
        while True:
            ks = kids(cur)
            if len(ks) != 1: break
            k = ks[0]
            if k['top'] - k['foot'] >= 2.2 or k['n'] > 0.95 * cur['n'] or k['n'] * A < 6: break
            chain.append(k); cur = k
        if len(chain) < 2 or chain[-1]['top'] - b['top'] < 1.5: continue
        b['ridge'] = chain[-1]['top']
        b['roof'] = shape_of(b['mask'])
        for k in kids(chain[-1]): k['up'] = b
        for k in chain: drop(k)
    # plant on the roofs, specks in the air
    for c in live():
        if c['n'] * A < 40 and c['top'] - c['foot'] < 6 and c['up'] is not None and not kids(c) and not c['roof']: c['unit'] = True
        elif c['up'] is None and c['foot'] > 2.5 and (c['n'] * A < 80 or c['top'] - c['foot'] < 3): drop(c)  # a canopy, a tree over it: not drawn in the air
    us = sorted((c for c in live() if c['unit']), key=lambda c: -c['n'])
    for c in us[24:]: drop(c)
    return live()


def shape_of(m):
    """the roof a stack of shrinking slabs makes over this outline: 4 a dome over a round one, 3 a pyramid over a
    squarish one, 2 hipped over a long one"""
    rr, cc = np.nonzero(m)
    pts = np.c_[cc, rr].astype(float)
    c = pts.mean(0); d = np.hypot(*(pts - c).T)
    if len(pts) / (math.pi * max(d.max(), 1) ** 2) > 0.72: return 4
    ev = np.linalg.eigvalsh(np.cov(pts.T))
    return 3 if ev[1] < 1.7 * ev[0] else 2


def fit(p, foot):
    """a traced outline, regularised: the OSM footprint where they agree, its rectangle where it nearly fills one,
    else simplified (keeping chamfers and curves) with its straight edges squared to its main axis"""
    from shapely.geometry import Polygon
    inter = p.intersection(foot).area
    if inter / (p.area + foot.area - inter) > 0.88: return np.array(foot.exterior.coords)[:-1]
    mrr = p.minimum_rotated_rectangle
    if p.area > 0.9 * mrr.area: return np.array(mrr.exterior.coords)[:-1]
    q = p.simplify(0.7)
    if q.geom_type != 'Polygon' or q.is_empty or len(q.exterior.coords) < 4: q = p
    pts = np.array(q.exterior.coords)[:-1]
    d = np.roll(pts, -1, 0) - pts; L = np.hypot(*d.T)
    ang = np.arctan2(d[:, 1], d[:, 0]) % (math.pi / 2)  # the main axis: the length-weighted mean edge direction (mod 90)
    ax = math.atan2((L * np.sin(4 * ang)).sum(), (L * np.cos(4 * ang)).sum()) / 4
    pts = clean(snap(pts, ax, math.radians(10)))
    r = Polygon(pts)
    if not r.is_valid or r.intersection(p).area < 0.85 * max(r.area, p.area): pts = np.array(p.simplify(0.5).exterior.coords)[:-1]
    if len(pts) > 64: pts = np.array(Polygon(pts).simplify(1.2).exterior.coords)[:-1]
    return pts


def clean(pts):
    """drop vertices that sit on a straight line (under 8 degrees of turn) or less than 0.6 m from the last kept"""
    keep = list(pts)
    changed = True
    while changed and len(keep) > 3:
        changed = False
        for i in range(len(keep)):
            a, b, c = np.array(keep[i - 1]), np.array(keep[i]), np.array(keep[(i + 1) % len(keep)])
            u, v = b - a, c - b
            lu, lv = np.hypot(*u), np.hypot(*v)
            if lu < 0.6 or lv < 1e-6 or abs(math.atan2(u[0] * v[1] - u[1] * v[0], u @ v)) < math.radians(8):
                del keep[i]; changed = True; break
    return np.array(keep)


def snap(pts, ax, tol=math.radians(6)):
    """straighten edges that run within tol of the axis ax (or square to it): rotate into the axis frame, set each such
    edge's ends to its mean coordinate across it"""
    n = len(pts)
    if n < 4: return pts
    ca, sa = math.cos(ax), math.sin(ax)
    u = pts @ np.array([[ca, -sa], [sa, ca]])  # u[:, 0] along the axis, u[:, 1] across
    for k in range(n):
        a, b = u[k], u[(k + 1) % n]
        dx, dy = b - a
        if math.hypot(dx, dy) < 2.0: continue
        ang = math.atan2(dy, dx) % math.pi
        if min(ang, math.pi - ang) < tol: m = (a[1] + b[1]) / 2; u[k, 1] = u[(k + 1) % n, 1] = m
        elif abs(ang - math.pi / 2) < tol: m = (a[0] + b[0]) / 2; u[k, 0] = u[(k + 1) % n, 0] = m
    return u @ np.array([[ca, sa], [-sa, ca]])


# ---------------------------------------------------------------- the whole map
_CL = None


def work(chunk):
    import shapely
    from shapely.geometry import Polygon
    global _CL
    if _CL is None: _CL = Cloud()
    out = []
    with cpu_slot():  # shared with the map bake and the LiDAR stream (common.py)
        for k, ring, others in chunk:
            try: r = mass((Polygon(ring).buffer(0), [Polygon(o).buffer(0) for o in others], _CL))
            except Exception as e: print('failed', k, e, flush=True); r = None
            if r: out.append((k, r))
    return out


def bake(procs, only=()):
    """only: tile names (e.g. 488000_5457000) to cache this time, of the LAS and zips not cached yet (all by default)"""
    import shapely
    from shapely.geometry import Polygon
    from pyproj import Transformer
    t0 = time.time()
    os.environ['PROCS'] = str(procs)  # cpu_slot's cap, in the workers too
    las = {os.path.basename(f)[:-4]: f for f in glob.glob(f'{os.path.dirname(LAS)}/*.zip')}
    las.update({os.path.basename(f)[:-4]: f for f in glob.glob(f'{LAS}/*.las')})  # an unzipped LAS over its zip
    files = sorted(f for k, f in las.items() if not only or k in only or os.path.exists(f'{CACHE}/{k}/i.npy'))
    os.makedirs(CACHE, exist_ok=True)
    with Pool(min(procs, 4)) as pool:  # each holds a LAS tile's points (about 2 GB)
        for nm in pool.imap_unordered(cache_tile, files): print('cached', nm, f'{time.time() - t0:.0f}s', flush=True)
    tr = Transformer.from_crs('EPSG:4326', 'EPSG:3157', always_xy=True)  # NAD83(CSRS) UTM 10, the survey's frame
    cloud = Cloud()
    fps = footprints(cloud, tr)
    print(len(fps), 'footprints over the LiDAR', f'{time.time() - t0:.0f}s', flush=True)
    polys = [Polygon(u).buffer(0) for _, _, u, _ in fps]
    tree = shapely.STRtree(polys)
    jobs = []
    for k, p in enumerate(polys):
        near = [int(i) for i in tree.query(p.buffer(REACH + 2)) if i != k]
        jobs.append((k, fps[k][2], [fps[i][2] for i in near]))
    jobs.sort(key=lambda j: (j[1][:, 0].mean() // 200, j[1][:, 1].mean() // 200))  # neighbours together: their points stay paged in
    chunks = [jobs[i:i + 40] for i in range(0, len(jobs), 40)]
    res = {}
    with Pool(procs) as pool:
        for n, r in enumerate(pool.imap_unordered(work, chunks)):
            res.update(r)
            if n % 50 == 0: print(f'{n}/{len(chunks)} chunks, {len(res)} buildings', f'{time.time() - t0:.0f}s', flush=True)
    save(res, fps, OUT, t0)


def save(res, fps, out, t0=None):
    from pyproj import Transformer
    inv = Transformer.from_crs('EPSG:3157', 'EPSG:4326', always_xy=True)
    keys = sorted(res)
    prc, pro, foot, top, roof, ridge, po = [], [0], [], [], [], [], [0]
    wseg, wdesc = [], []
    w2xy = lambda p: xy(*inv.transform(p[0], p[1])[::-1])
    for k in keys:
        ground, parts, walls = res[k]
        for ring, f, t, rf, rd in parts:
            lo, la = inv.transform(ring[:, 0], ring[:, 1])
            x, y = xy(la, lo)
            prc += list(zip(x, y)); pro.append(len(prc))
            foot.append(f); top.append(t); roof.append(rf); ridge.append(rd)
        po.append(len(foot))
        for a, b, f, t, d in walls:
            wseg.append((*w2xy(a), *w2xy(b), f, t)); wdesc.append(d)
    save_rings(out, [fps[k][1] for k in keys], po=np.array(po[:-1], np.int32), pn=np.diff(po).astype(np.int16),
               wseg=np.array(wseg, np.float32).reshape(-1, 6), wdesc=np.array(wdesc, np.uint8).reshape(-1, 4),
               prc=np.array(prc, np.float32).reshape(-1, 2), pro=np.array(pro, np.int32), pfoot=np.array(foot, np.float32), ptop=np.array(top, np.float32),
               proof=np.array(roof, np.uint8), pridge=np.array(ridge, np.float32), osm=np.array([fps[k][0] for k in keys], np.int64))
    print(f'{len(keys)} of {len(fps)} footprints, {len(foot)} parts, {len(wseg)} walls ->', out, f'{os.path.getsize(out) / 1e6:.1f} MB', flush=True)


# ---------------------------------------------------------------- other regions: one LAZ/COPC/LAS tile at a time
def read_points(path, near=None):
    """a LAZ/COPC/LAS (any point format, any CRS) -> its building and ground points in NAD83(CSRS) UTM 10 (x, y, z, class,
    intensity), the tile's density (pts/m2). Ground is thinned by density. Open sets rarely classify buildings (class 6): then the
    unclassified points (class 1) that near(x, y) says are by a footprint stand in for them, less the tree canopy
    (canopy())."""
    import laspy
    from pyproj import Transformer
    with laspy.open(path) as f:
        h = f.header; crs = h.parse_crs()
        to = None if crs is None or crs.to_epsg() == 3157 else Transformer.from_crs(crs, 'EPSG:3157', always_xy=True)
        area = max((h.maxs[0] - h.mins[0]) * (h.maxs[1] - h.mins[1]), 1.0)
        dens = h.point_count / area; step = tune(dens)
        gnd, bld, unc, g = [], [], [], 0
        for c in f.chunk_iterator(4_000_000):
            cl = np.asarray(c.classification)
            gi = np.flatnonzero(cl == 2); gi = gi[(np.arange(len(gi)) + g) % step == 0]; g += int((cl == 2).sum())
            x, y, z, it = np.asarray(c.x), np.asarray(c.y), np.asarray(c.z).astype(np.float32), np.asarray(c.intensity).astype(np.uint16)
            if to: x, y = to.transform(x, y)
            def pick(i): return x[i], y[i], z[i], it[i]
            gnd.append(pick(gi)); bld.append(pick(np.flatnonzero(cl == 6)))
            if near is not None:
                u = np.flatnonzero(cl == 1); u = u[near(x[u], y[u])]; unc.append(pick(u) + (np.asarray(c.number_of_returns)[u] > 1,))
    use = bld if sum(len(a[0]) for a in bld) >= 500 else unc  # a classified tile, or an unclassified one
    if use is unc and unc:
        x, y, z, it, split = (np.concatenate([a[k] for a in unc]) for k in range(5))
        keep = ~canopy(x, y, z, split); use = [(x[keep], y[keep], z[keep], it[keep])]
    parts = [(a, 2) for a in gnd] + [(a, 6) for a in use]
    x, y, z, it = (np.concatenate([a[k] for a, _ in parts]) for k in range(4))
    cl = np.concatenate([np.full(len(a[0]), k, np.uint8) for a, k in parts])
    return x, y, z, cl, it, dens


def canopy(x, y, z, split):
    """points (split: the pulse had more than one return) -> the ones to drop as tree canopy, so a house beside or
    under a tall tree doesn't take its height. Roofs are found rather than trees: 1 m cells whose top returns (the
    half metre under the cell's highest) are mostly whole pulses (under SPLIT of them split: a crown's leaves and
    needles let light through to more returns below, a roof doesn't but at its edges), in patches at least OPEN m
    across. A point stays when it is no more than LIFT over its nearest roof cell, that within REACH_ROOF (eaves,
    ridges, walls, a tower's glass-railed top floors, the roof under a crown's edge), the rest goes (canopy, a lone
    tree; rooftop plant and spires over LIFT too: ponytail, a cap from the classified sets only). The roof under a
    whole crown goes too: a dropout mass() fills when small, or a footprint it no longer masses (tiles.py's own
    shape). The nearest roof, not the highest near: a tree over a house beside a taller block stays the house's."""
    from scipy import ndimage
    if not len(x): return np.zeros(0, bool)
    i, j = (x - x.min()).astype(int), (y - y.min()).astype(int)
    nx, ny = i.max() + 1, j.max() + 1
    k = j * nx + i
    top = np.full(nx * ny, -np.inf); np.maximum.at(top, k, z)
    up = z > top[k] - 0.5
    n = np.bincount(k[up], minlength=nx * ny); sp = np.bincount(k[up], split[up], nx * ny)
    top = top.reshape(ny, nx)
    roof = ndimage.binary_opening(((n >= 2) & (sp < SPLIT * n)).reshape(ny, nx), np.ones((OPEN, OPEN)))
    if not roof.any(): return np.ones(len(x), bool)
    d, (rj, ri) = ndimage.distance_transform_edt(~roof, return_indices=True)  # each cell's nearest roof cell
    near = np.where(d <= REACH_ROOF, top[rj, ri], -np.inf)
    return z > near[j, i] + LIFT


SPLIT, OPEN, LIFT, REACH_ROOF = 0.5, 5, 1.0, 8  # share, m, m, m: roof cells, their least width, what may stand over them, how far from them (canopy())


def tile(path, out, tmp):
    """one point-cloud file -> out (.npz, like massing22.npz) for the footprints wholly inside it (those on its edge
    would see half a building: they keep tiles.py's own shapes). tmp: a scratch folder"""
    import shutil, laspy, shapely
    from pyproj import Transformer
    from shapely.geometry import Polygon
    t0 = time.time()
    with laspy.open(path) as f: mn, mx, crs = f.header.mins, f.header.maxs, f.header.parse_crs()
    if crs is not None and crs.to_epsg() != 3157:
        (mn[0], mn[1]), (mx[0], mx[1]) = [Transformer.from_crs(crs, 'EPSG:3157', always_xy=True).transform(*q) for q in (mn[:2], mx[:2])]
    class Ext:  # the tile's extent where footprints() wants a Cloud
        t = {'tile': (mn[0], mn[1], int((mx[0] - mn[0]) // 4) + 1, int((mx[1] - mn[1]) // 4) + 1, None)}
        def covers(self, e, n): return mn[0] <= e < mx[0] and mn[1] <= n < mx[1]
    m = REACH + 2
    fps = [f for f in footprints(Ext(), Transformer.from_crs('EPSG:4326', 'EPSG:3157', always_xy=True))
           if f[2][:, 0].min() > mn[0] + m and f[2][:, 0].max() < mx[0] - m and f[2][:, 1].min() > mn[1] + m and f[2][:, 1].max() < mx[1] - m]
    polys = [Polygon(u).buffer(0) for _, _, u, _ in fps]
    nx, ny = int(mx[0] - mn[0]) + 2, int(mx[1] - mn[1]) + 2  # 1 m mask of the cells by a footprint
    from rasterio.features import rasterize
    from rasterio.transform import Affine
    mask = rasterize([(p.buffer(REACH + 0.5), 1) for p in polys], out_shape=(ny, nx), transform=Affine(1, 0, mn[0], 0, -1, mn[1] + ny), dtype=np.uint8).astype(bool) if polys else np.zeros((ny, nx), bool)
    def near(x, y):
        i, j = (x - mn[0]).astype(int), (mn[1] + ny - y).astype(int)
        ok = (i >= 0) & (i < nx) & (j >= 0) & (j < ny)
        return ok & mask[j.clip(0, ny - 1), i.clip(0, nx - 1)]
    x, y, z, cl, it, dens = read_points(path, near)
    if not len(x): return save({}, [], out)
    x0, y0 = math.floor(x.min()), math.floor(y.min())
    d = f'{tmp}/c'; shutil.rmtree(d, ignore_errors=True)
    write_cache(d, (x - x0).astype(np.float32), (y - y0).astype(np.float32), z, cl, x0, y0, int((x.max() - x0) // 4) + 1, int((y.max() - y0) // 4) + 1, it)
    cloud = Cloud(tmp)
    tree = shapely.STRtree(polys); res = {}
    for k, p in enumerate(polys):
        near_ = [polys[int(i)] for i in tree.query(p.buffer(REACH + 2)) if i != k]
        try: r = mass((p, near_, cloud))
        except Exception as e: print('failed', k, e, flush=True); r = None
        if r: res[k] = r
    shutil.rmtree(d, ignore_errors=True)
    save(res, fps, out)
    print(f'{os.path.basename(path)}: {dens:.0f} pts/m2, {len(fps)} footprints, {len(res)} massed, {time.time() - t0:.0f}s', flush=True)


def merge(src='data/massing_lm', out=OUT_LM):
    """every <tile>.npz in src -> one file (a building on two tiles' edges is kept once)"""
    # streaming: each file's arrays are read once (d[k] decompresses the whole array on every access) and only
    # the kept buildings' compact numpy slices are held (per-point python lists once grew past 200 GB)
    rings, po, pn, osm, seen, wseg, wdesc, nparts, npts = [], [], [], [], set(), [], [], 0, 0
    keys = ('pfoot', 'ptop', 'proof', 'pridge')
    cols, prcs, pros = {k: [] for k in keys}, [], []
    for f in sorted(glob.glob(f'{src}/*.npz')):
        with np.load(f) as z: d = {k: z[k] for k in z.files}
        if 'wseg' in d: wseg.append(d['wseg']); wdesc.append(d['wdesc'])  # each wall's look (tools/lidar_walls.py)
        parts = []  # this file's kept part indices
        for i in range(len(d['osm'])):
            r = d['rc'][d['ro'][i]:d['ro'][i + 1]]
            key = (int(d['osm'][i]), round(float(r[0][0]) * 2), round(float(r[0][1]) * 2))
            if key in seen: continue
            seen.add(key); rings.append(r.copy()); osm.append(key[0]); po.append(nparts); pn.append(int(d['pn'][i]))
            nparts += int(d['pn'][i]); parts += range(int(d['po'][i]), int(d['po'][i]) + int(d['pn'][i]))
        if not parts: continue
        parts = np.array(parts)
        for k in keys: cols[k].append(d[k][parts])
        lo, hi = d['pro'][parts], d['pro'][parts + 1]
        prcs.append(np.concatenate([d['prc'][a:b] for a, b in zip(lo, hi)]).astype(np.float32))
        pros.append(npts + np.cumsum(hi - lo)); npts += int((hi - lo).sum())
    cat = lambda v, dt, shp=(0,): np.concatenate(v).astype(dt) if v else np.zeros(shp, dt)
    save_rings(out, rings, po=np.array(po, np.int32), pn=np.array(pn, np.int16), osm=np.array(osm, np.int64),
               prc=cat(prcs, np.float32, (0, 2)), pro=np.concatenate([[0]] + pros).astype(np.int32),
               wseg=np.concatenate(wseg) if wseg else np.zeros((0, 6), np.float32), wdesc=np.concatenate(wdesc) if wdesc else np.zeros((0, 4), np.uint8),
               **{k: cat(v, np.float32 if k in ('pfoot', 'ptop', 'pridge') else np.uint8) for k, v in cols.items()})
    print(len(rings), 'buildings ->', out, f'{os.path.getsize(out) / 1e6:.1f} MB')


# ---------------------------------------------------------------- lookup (tiles.py)
_DB = None
PER = ('po', 'pn', 'osm')


def massing_lookup(ring):
    """ring: a world-xy footprint -> [dict(ring, mn, h, roof, ridge, units)] (heights above its ground) or None where the
    2022 LiDAR has no massing for it (not covered, low, rebuilt since)"""
    global _DB
    import shapely
    from shapely.geometry import Polygon
    if _DB is None:
        from roofs import ring_db
        _DB = []
        for f in (OUT, OUT_LM):  # the City's 2022 massing first, then the rest of the Lower Mainland
            db = ring_db(f)
            if db:  # the part arrays are not per footprint: keep them aside
                d = np.load(f)
                db['parts'] = {k: d[k] for k in ('prc', 'pro', 'pfoot', 'ptop', 'proof', 'pridge')}
                db['parts']['clip'] = f == OUT_LM  # (in parts: tiles.py db_rows keys the tile on the per-footprint fields)
                _DB.append(db)
    from roofs import valid_poly
    q = valid_poly(tuple(map(tuple, ring)))
    for db in _DB:
        r = _lookup(db, q)
        if r: return r
    return None


def _lookup(db, q):
    import shapely
    from shapely.geometry import Polygon
    _DB = db
    hits = _DB['tree'].query(q, predicate='intersects')
    if not len(hits): return None
    inter = shapely.area(shapely.intersection(_DB['polys'][hits], q))
    iou = inter / (shapely.area(_DB['polys'][hits]) + q.area - inter)
    k = int(np.argmax(iou))
    if iou[k] < 0.9: return None
    h = int(hits[k]); P = _DB['parts']
    out, units = [], []
    for i in range(int(_DB['po'][h]), int(_DB['po'][h]) + int(_DB['pn'][h])):
        r = [tuple(map(float, p)) for p in P['prc'][P['pro'][i]:P['pro'][i + 1]]]
        if P['proof'][i] == UNIT: units.append((r, float(P['pfoot'][i]), float(P['ptop'][i])))
        else:
            if P['clip']:  # the regional sets: a part kept to its footprint (#554)
                r = _clip(r, q)
                if r is None: continue
            out.append(dict(ring=r, mn=float(P['pfoot'][i]), h=float(P['ptop'][i]), roof=int(P['proof'][i]), ridge=float(P['pridge'][i]), units=[]))
    for r, f, t in units:  # plant: a box on the roof it stands on (tiles.py's units: centre, along, across, height, angle)
        (ax, ay), (bx, by), (cx, cy) = r[0], r[1], r[2]
        mx, my = (ax + cx) / 2, (ay + cy) / 2
        on = [p for p in out if abs(p['h'] - f) < 1.0 and not p['roof'] and shapely.contains_xy(Polygon(p['ring']), mx, my)]
        if on and t - on[0]['h'] > 0.4: on[0]['units'].append((mx, my, min(25.0, math.hypot(bx - ax, by - ay)), min(25.0, math.hypot(cx - bx, cy - by)), min(12.0, t - on[0]['h']), math.atan2(by - ay, bx - ax)))
    return out


def _clip(r, q):
    """a part's ring cut to its footprint q (the largest piece; None under 2 m2 left). The regional sets classify few
    buildings: the unclassified returns by a footprint stand in, so a tree's crown or a neighbour's eave within REACH
    of it widened a part past its walls, over the street and the house next door (the City's own overhangs, a lookout
    or a widening top, are real and keep their outline)"""
    import shapely
    from shapely.geometry import Polygon
    p = Polygon(r)
    if not p.is_valid: p = p.buffer(0)
    if q.buffer(0.05).contains(p): return r
    g = p.intersection(q)
    g = max(getattr(g, 'geoms', [g]), key=lambda h: h.area if h.geom_type == 'Polygon' else 0)
    if g.geom_type != 'Polygon' or g.area < 2: return None
    return [tuple(map(float, c)) for c in shapely.simplify(g, 0.05).exterior.coords[:-1]]


_WT = None


def walls_near(ring):
    """the measured walls (tools/lidar_walls.py) within 3 m of a world-xy ring's box, whichever footprint they were
    measured on (an outline with parts, a part over a podium: the walls are where they are): [(x0, y0, x1, y1, foot,
    top, (d0, d1, d2, d3))]"""
    global _WT
    import shapely
    if _WT is None:  # the City's 2022 walls and the rest of the Lower Mainland's (tools/lidar_stream.py)
        ds = [d for d in (np.load(f) for f in (OUT, OUT_LM) if os.path.exists(f)) if 'wseg' in d.files and len(d['wseg'])]
        seg = np.concatenate([d['wseg'] for d in ds]) if ds else None
        _WT = seg is not None and (shapely.STRtree(shapely.linestrings(seg[:, :4].reshape(-1, 2, 2))), seg, np.concatenate([d['wdesc'] for d in ds]))
    if not _WT: return []
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    tree, seg, desc = _WT
    return [(*map(float, seg[i]), tuple(int(v) for v in desc[i])) for i in tree.query(shapely.box(min(xs) - 3, min(ys) - 3, max(xs) + 3, max(ys) + 3))]


# ---------------------------------------------------------------- self-test
def check():
    """a synthetic tower on a podium with a wider lookout disc on top: three parts, the disc over a thinner shaft"""
    import shapely
    from shapely.geometry import Polygon
    rng = np.random.default_rng(1)
    pts = []
    def walls(poly, z0, z1, n):
        b = poly.boundary
        t = rng.uniform(0, b.length, n)
        p = np.array([b.interpolate(s).coords[0] for s in t])
        pts.append(np.c_[p, rng.uniform(z0, z1, n), np.full(n, 6)])
    def roof(poly, z, n):
        x0, y0, x1, y1 = poly.bounds
        p = rng.uniform((x0, y0), (x1, y1), (n * 3, 2)); p = p[shapely.contains_xy(poly, p[:, 0], p[:, 1])][:n]
        pts.append(np.c_[p, np.full(len(p), z), np.full(len(p), 6)])
    pod = Polygon([(0, 0), (40, 0), (40, 30), (0, 30)])
    shaft = Polygon([(15, 10), (25, 10), (25, 20), (15, 20)])
    disc = shapely.Point(20, 15).buffer(9, 16)
    walls(pod, 0, 12, 6000); roof(pod.difference(shaft.buffer(0)), 12, 20000)
    walls(shaft, 12, 60, 30000)
    walls(disc, 60, 66, 4000); roof(disc, 66, 6000)
    g = rng.uniform(-10, 50, (4000, 2)); pts.append(np.c_[g, np.zeros(4000), np.full(4000, 2)])
    a = np.concatenate(pts)
    class C:
        def box(self, *b): return a[:, 0] + 1000, a[:, 1] + 5000, a[:, 2].astype(np.float32), a[:, 3].astype(np.uint8), np.full(len(a), 150, np.uint16)
    foot = shapely.affinity.translate(pod, 1000, 5000)
    ground, parts, walls = mass((foot, [], C()))
    parts.sort(key=lambda p: p[1])
    got = [(round(f), round(t), round(Polygon(r).area)) for r, f, t, *_ in parts]
    print(got)
    assert len(parts) == 3, got
    assert abs(parts[0][2] - 12) < 1 and abs(Polygon(parts[0][0]).area - 1200) < 60  # the podium: the OSM footprint
    assert abs(parts[1][1] - 12) < 1.5 and 55 < parts[1][2] < 61 and Polygon(parts[1][0]).area < 160  # the shaft, not as wide as the disc
    assert abs(parts[2][2] - 66) < 1 and Polygon(parts[2][0]).area > 200  # the lookout
    try: import laspy
    except ImportError: print('no laspy: skipped the LAZ read test'); return
    import tempfile
    h = laspy.LasHeader(point_format=6, version='1.4'); h.scales = (0.001,) * 3; h.offsets = (500000, 5450000, 0)
    from pyproj import CRS
    h.add_crs(CRS.from_epsg(26910))
    las = laspy.LasData(h); n = 3000
    las.x = 500000 + rng.uniform(0, 100, n); las.y = 5450000 + rng.uniform(0, 100, n); las.z = rng.uniform(0, 20, n)
    las.classification = rng.choice([1, 2, 6], n)
    with tempfile.TemporaryDirectory() as t:
        las.write(f'{t}/a.laz')
        x, y, z, c, it, dens = read_points(f'{t}/a.laz')
    want = int(((las.classification == 6) | (las.classification == 2)).sum())
    assert set(np.unique(c)) <= {2, 6} and want * 0.99 <= len(x) <= want and abs(dens - 0.3) < 0.01 and RES == 1.0, (len(x), want, dens)
    assert abs(x.mean() - 500050) < 2 and abs(y.mean() - 5450050) < 2  # 26910 -> 3157: same frame to a metre
    # canopy(): a 12 m square flat roof at 6 m (whole pulses) with a 20 m tree beside it, its crown over the roof's corner
    g = np.mgrid[0:12:0.2, 0:12:0.2].reshape(2, -1).T + 500000
    tx, ty, tr = rng.uniform(-6, 6, 6000), rng.uniform(-6, 6, 6000), rng.uniform(0, 1, 6000)
    keep = np.hypot(tx, ty) < 6 * (1 - tr) + 0.5  # a cone, wide at 8 m, its tip at 20 m
    tree = np.c_[500013 + tx[keep], 500013 + ty[keep], 8 + 12 * tr[keep]]
    x, y = np.r_[g[:, 0], tree[:, 0]], np.r_[g[:, 1], tree[:, 1]]
    z = np.r_[6 + rng.normal(0, 0.03, len(g)), tree[:, 2]]
    drop = canopy(x, y, z, np.r_[np.zeros(len(g), bool), rng.uniform(size=len(tree)) < 0.8])
    assert drop[:len(g)].mean() < 0.02 and drop[len(g):][tree[:, 2] > 7.5].mean() > 0.95, (drop[:len(g)].mean(), drop[len(g):].mean())
    print('massing check ok')


if __name__ == '__main__':
    a = sys.argv[1:]
    if a == ['check']: check()
    elif a[:1] == ['tile']:
        import tempfile
        with tempfile.TemporaryDirectory() as t: tile(a[1], a[2], t)
    elif a[:1] == ['merge']: merge(*a[1:])
    else: bake(int(a[0]) if a else os.cpu_count(), a[1:])
