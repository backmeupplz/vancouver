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
# The LAS files (data/lidar2022/urls.json, by hand into data/lidar2022/, `unzip -j -o '*.zip' '*.las' -d las`) are
# first cut down to their building and ground points, sorted into 4 m cells (data/lidar2022/cache/, about a quarter
# of the size).
# Run: uv run --with numpy,scipy,shapely,pyproj,rasterio python3 tools/lidar_massing.py [procs]
#      ... tools/lidar_massing.py check          (self-test on a synthetic tower)
import glob, math, os, sys, time
from multiprocessing import Pool
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import xy, latlon, L1, save_rings, load_feat, all_tiles, hnum
from lidar_walls import walls_of

OUT = 'data/massing22.npz'
LAS = 'data/lidar2022/las'
CACHE = 'data/lidar2022/cache'
RES = 0.5        # m, raster cell
STEP = 1.0       # m between slices
MIN_TOP = 10.0   # m: lower buildings keep tiles.py's own shapes (pitched roofs fitted to the HRDEM)
REACH = 3.0      # m past its outline a footprint owns the cells nearer to it than to any other
KEEP = 0.9       # IoU with a run's first slice under which a new part starts
MIN_CELLS = 16   # 4 m2: smaller bits of a slice are dropped (a spire is caught separately)


# ---------------------------------------------------------------- the point cache
def las_header(path):
    import struct
    b = open(path, 'rb').read(375)
    off = struct.unpack('<I', b[96:100])[0]; pf = b[104] & 63; rl = struct.unpack('<H', b[105:107])[0]
    sc = struct.unpack('<3d', b[131:155]); of = struct.unpack('<3d', b[155:179])
    v = struct.unpack('<6d', b[179:227])
    return off, pf, rl, sc, of, v[1::2], v[0::2]  # ..., min (x, y, z), max


def cache_tile(path):
    """one LAS -> its building points and every 4th ground point, as x, y (from the tile's corner), z, class, sorted
    into 4 m cells (start: where each cell begins) in CACHE/<name>/"""
    name = os.path.basename(path)[:-4]
    d = f'{CACHE}/{name}'
    if os.path.exists(f'{d}/start.npy'): return name
    off, pf, rl, sc, of, mn, mx = las_header(path)
    dt = np.dtype(dict(names=['x', 'y', 'z', 'cls'], formats=['<i4', '<i4', '<i4', 'u1'], offsets=[0, 4, 8, 16 if pf >= 6 else 15], itemsize=rl))
    p = np.memmap(path, dt, 'r', offset=off)
    cls = np.asarray(p['cls']) & 31
    keep = (cls == 6) | (cls == 2) & (np.arange(len(cls)) % 4 == 0)
    x0, y0 = math.floor(mn[0]), math.floor(mn[1])
    x = (p['x'][keep] * sc[0] + of[0] - x0).astype(np.float32); y = (p['y'][keep] * sc[1] + of[1] - y0).astype(np.float32)
    z = (p['z'][keep] * sc[2] + of[2]).astype(np.float32); cls = cls[keep]
    nx = int((mx[0] - x0) // 4) + 1; ny = int((mx[1] - y0) // 4) + 1
    key = np.clip(y // 4, 0, ny - 1).astype(np.int64) * nx + np.clip(x // 4, 0, nx - 1).astype(np.int64)
    o = np.argsort(key, kind='stable')
    os.makedirs(d + '.tmp', exist_ok=True)
    for k, v in (('x', x[o]), ('y', y[o]), ('z', z[o]), ('cls', cls[o])): np.save(f'{d}.tmp/{k}.npy', v)
    np.save(f'{d}.tmp/meta.npy', np.array([x0, y0, nx, ny], np.float64))
    np.save(f'{d}.tmp/start.npy', np.searchsorted(key[o], np.arange(nx * ny + 1)).astype(np.int64))
    os.replace(d + '.tmp', d)
    return name


class Cloud:
    """the cached tiles, opened lazily (memory-mapped): box(e0, n0, e1, n1) -> UTM x, y, z, class arrays"""
    def __init__(self):
        self.t = {}
        for d in sorted(glob.glob(f'{CACHE}/*/meta.npy')):
            x0, y0, nx, ny = np.load(d)
            self.t[os.path.dirname(d)] = (x0, y0, int(nx), int(ny), None)

    def covers(self, e, n):
        return any(x0 <= e < x0 + nx * 4 and y0 <= n < y0 + ny * 4 for x0, y0, nx, ny, _ in self.t.values())

    def box(self, e0, n0, e1, n1):
        out = []
        for d, (x0, y0, nx, ny, a) in self.t.items():
            if e1 < x0 or e0 >= x0 + nx * 4 or n1 < y0 or n0 >= y0 + ny * 4: continue
            if a is None:
                a = {k: np.load(f'{d}/{k}.npy', mmap_mode='r') for k in ('x', 'y', 'z', 'cls', 'start')}
                self.t[d] = (x0, y0, nx, ny, a)
            i0, i1 = max(0, int((e0 - x0) // 4)), min(nx - 1, int((e1 - x0) // 4))
            for j in range(max(0, int((n0 - y0) // 4)), min(ny - 1, int((n1 - y0) // 4)) + 1):
                s, t = a['start'][j * nx + i0], a['start'][j * nx + i1 + 1]
                if t > s: out.append((a['x'][s:t] + x0, a['y'][s:t] + y0, a['z'][s:t], a['cls'][s:t]))
        if not out: return [np.zeros(0)] * 4
        return [np.concatenate([o[k] for o in out]) for k in range(4)]


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
            occ &= ndimage.binary_dilation(own, iterations=2)
            ring = ndimage.binary_closing(occ, iterations=3)
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
    near = ndimage.binary_dilation(hi, iterations=2)
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
    X, Y, Z, C = cloud.box(x0 - 8, y1 - ny * RES - 8, x0 + nx * RES + 8, y1 + 8)
    g = C == 2
    ring_d = shapely.distance(poly.boundary, shapely.points(X[g], Y[g])) if g.sum() else np.zeros(0)
    gz = Z[g][ring_d < 10] if g.sum() else np.zeros(0)
    if len(gz) < 10: return None
    ground = float(np.percentile(gz, 10))
    b = (C == 6) & (X >= x0) & (X < x0 + nx * RES) & (Y > y1 - ny * RES) & (Y <= y1)
    X, Y, Z = X[b], Y[b], Z[b] - ground
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
    walls = [(a, b, 0.0, top, d) for a, b, d in walls_of(fr, X, Y, Z, top)]  # the footprint's walls (tools/lidar_walls.py)
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
        walls += [(a, b, f, t, (d[0] & 0x0f, d[1], d[2]) if f > 1 else d) for a, b, d in walls_of(r, X[sel], Y[sel], Z[sel] - f, t - f)]
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
    for k, ring, others in chunk:
        try: r = mass((Polygon(ring).buffer(0), [Polygon(o).buffer(0) for o in others], _CL))
        except Exception as e: print('failed', k, e, flush=True); r = None
        if r: out.append((k, r))
    return out


def bake(procs):
    import shapely
    from shapely.geometry import Polygon
    from pyproj import Transformer
    t0 = time.time()
    files = sorted(glob.glob(f'{LAS}/*.las'))
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
    inv = Transformer.from_crs('EPSG:3157', 'EPSG:4326', always_xy=True)
    keys = sorted(res)
    prc, pro, foot, top, roof, ridge, po = [], [0], [], [], [], [], [0]
    wseg, wdesc, wo = [], [], [0]
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
        wo.append(len(wseg))
    save_rings(OUT, [fps[k][1] for k in keys], po=np.array(po[:-1], np.int32), pn=np.diff(po).astype(np.int16),
               wo=np.array(wo[:-1], np.int32), wn=np.diff(wo).astype(np.int16), wseg=np.array(wseg, np.float32).reshape(-1, 6), wdesc=np.array(wdesc, np.uint8).reshape(-1, 3),
               prc=np.array(prc, np.float32).reshape(-1, 2), pro=np.array(pro, np.int32), pfoot=np.array(foot, np.float32), ptop=np.array(top, np.float32),
               proof=np.array(roof, np.uint8), pridge=np.array(ridge, np.float32), osm=np.array([fps[k][0] for k in keys], np.int64))
    print(f'{len(keys)} of {len(fps)} footprints, {len(foot)} parts, {len(wseg)} walls ->', OUT, f'{os.path.getsize(OUT) / 1e6:.1f} MB', f'{time.time() - t0:.0f}s', flush=True)


# ---------------------------------------------------------------- lookup (tiles.py)
_DB = None
PER = ('po', 'pn', 'osm')


def massing_lookup(ring):
    """ring: a world-xy footprint -> ([dict(ring, mn, h, roof, ridge, units)] (heights above its ground; empty where the
    2022 LiDAR has no massing for it: low, rebuilt since), [(x0, y0, x1, y1, foot, top, (d0, d1, d2))] its walls' looks
    (tools/lidar_walls.py)), or None where it has nothing (not covered)"""
    global _DB
    import shapely
    from shapely.geometry import Polygon
    if _DB is None:
        from roofs import ring_db
        _DB = ring_db(OUT)
        if _DB:  # the part arrays are not per footprint: keep them aside
            d = np.load(OUT)
            _DB['parts'] = {k: d[k] for k in ('prc', 'pro', 'pfoot', 'ptop', 'proof', 'pridge', 'wseg', 'wdesc')}
    if not _DB: return None
    q = shapely.make_valid(Polygon(ring))
    hits = _DB['tree'].query(q, predicate='intersects')
    if not len(hits): return None
    inter = shapely.area(shapely.intersection(_DB['polys'][hits], q))
    iou = inter / (shapely.area(_DB['polys'][hits]) + q.area - inter)
    k = int(np.argmax(iou))
    if iou[k] < 0.9: return None
    h = int(hits[k]); P = _DB['parts']
    walls = [(*map(float, P['wseg'][i]), tuple(int(v) for v in P['wdesc'][i])) for i in range(int(_DB['wo'][h]), int(_DB['wo'][h]) + int(_DB['wn'][h]))]
    out, units = [], []
    for i in range(int(_DB['po'][h]), int(_DB['po'][h]) + int(_DB['pn'][h])):
        r = [tuple(map(float, p)) for p in P['prc'][P['pro'][i]:P['pro'][i + 1]]]
        if P['proof'][i] == UNIT: units.append((r, float(P['pfoot'][i]), float(P['ptop'][i])))
        else: out.append(dict(ring=r, mn=float(P['pfoot'][i]), h=float(P['ptop'][i]), roof=int(P['proof'][i]), ridge=float(P['pridge'][i]), units=[]))
    for r, f, t in units:  # plant: a box on the roof it stands on (tiles.py's units: centre, along, across, height, angle)
        (ax, ay), (bx, by), (cx, cy) = r[0], r[1], r[2]
        mx, my = (ax + cx) / 2, (ay + cy) / 2
        on = [p for p in out if abs(p['h'] - f) < 1.0 and not p['roof'] and shapely.contains_xy(Polygon(p['ring']), mx, my)]
        if on and t - on[0]['h'] > 0.4: on[0]['units'].append((mx, my, min(25.0, math.hypot(bx - ax, by - ay)), min(25.0, math.hypot(cx - bx, cy - by)), min(12.0, t - on[0]['h']), math.atan2(by - ay, bx - ax)))
    return out, walls


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
        def box(self, *b): return a[:, 0] + 1000, a[:, 1] + 5000, a[:, 2].astype(np.float32), a[:, 3].astype(np.uint8)
    foot = shapely.affinity.translate(pod, 1000, 5000)
    ground, parts, walls = mass((foot, [], C()))
    parts.sort(key=lambda p: p[1])
    got = [(round(f), round(t), round(Polygon(r).area)) for r, f, t, *_ in parts]
    print(got)
    assert len(parts) == 3, got
    assert abs(parts[0][2] - 12) < 1 and abs(Polygon(parts[0][0]).area - 1200) < 60  # the podium: the OSM footprint
    assert abs(parts[1][1] - 12) < 1.5 and 55 < parts[1][2] < 61 and Polygon(parts[1][0]).area < 160  # the shaft, not as wide as the disc
    assert abs(parts[2][2] - 66) < 1 and Polygon(parts[2][0]).area > 200  # the lookout
    print('massing check ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['check']: check()
    else: bake(int(sys.argv[1]) if len(sys.argv) > 1 else os.cpu_count())
