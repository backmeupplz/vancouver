# The seawalls: Vancouver's seawall (Stanley Park, Coal Harbour, English Bay, Sunset Beach, False Creek, Kits, Vanier)
# and every other waterfront promenade on a hard edge (Canada Place, Lonsdale Quay, West Van's seawalk, New West's
# quay...). Found, not listed: a stretch of OSM coastline is a seawall where a paved walk (footway, cycleway,
# pedestrian street, paved path) runs along it on the land side within a few metres, the LiDAR ground at that walk
# stands well over the sea and comes right up to the edge, and no beach lies between. Each run along the coastline
# gets: the walk's height on top (the LiDAR ground at its paths, smoothed along the run, no steeper than a ramp), how
# far inland the walk reaches (the coastline to the far edge of the last path beside it: the walk and the separate
# bike lane where there is one), and whether a railing stands on it (an OSM fence or handrail along the edge).
# Also the beach things OSM maps by the beaches and walks (amenities(): picnic tables, bins, fountains, washrooms, stands).
# Writes data/seawalls.npz: per point x, north, top, reach, rail, foot, the runs' starts (ro), the things (kit); tiles.py bakes them into the
# detail tiles' SEAW section, the page (core/util.js wallHeight) puts the ground on top of the wall's walk up to its
# edge and the water at its foot, and draws the stone face (core/tile-worker.js seawalls()).
# Run: uv run --with numpy,scipy,shapely,osmium python3 tools/seawall.py   (... check: the height rule on a made-up wall)
import glob, math, os, pickle, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import densify, hr_lookup, line_kind, hnum, latlon, xy

OUT = 'data/seawalls.npz'
STEP = 2.0  # metres between a run's points
REACH = 18.0  # the furthest from the coastline a path may start and still be the seawall's walk
GAP = 7.0  # metres of grass, planting or bench strip between two paths of one walk (the walk and its bike lane)
FIRST = 14.0  # metres of paving or lawn between the edge and the first path (a plaza along the edge: Olympic Village)
GRADE = 0.06  # the steepest the top climbs along a run
TOP_MAX = 9.0  # metres: a walk higher over the sea is on a deck or a plaza, not on a seawall
STEP_UP = 0.8  # metres the walk's ground may change from one point to the next before the run is split there
EDGE = 7.0  # the furthest in the walk is drawn at the wall's top (past it the terrain, which is the LiDAR's, takes over)
B_IN, B_END = 10.0, 20.0  # metres the top blends into the ground past its reach inland, and past a run's ends
LOW, LOW_B = 2.0, 8.0  # the water at the wall's foot: flat this far out, back to the ground's over the next LOW_B
SLIT = 0.2  # metres out from the line the walk's ground still is (tiles.py cuts the ground there: the face covers the cut)
FADE = 3.0  # metres over which the nearest of two walls takes over from the other
FOOT = 0.0  # the sea, as the tiles draw it (tiles.py flat_water)
WALK = {'footway': 2.2, 'cycleway': 2.6, 'pedestrian': 7.0, 'path': 1.6}  # tiles.py road_shape's widths
PAVED = {'asphalt', 'concrete', 'paved', 'paving_stones', 'concrete:plates', 'sett', 'compacted', 'fine_gravel'}  # a path, not a trail
RAILS = {'fence', 'handrail', 'guard_rail', 'railing'}


def gather():
    """the coastline, the at-grade walks, the beaches and the railings of the whole map, each way once"""
    coast, paths, sand, rails, builds = {}, {}, {}, {}, {}
    for f in sorted(glob.glob('data/feat/*.pkl')):
        with open(f, 'rb') as fh: d = pickle.load(fh)
        for wid, pts, refs, t in d.get('lines', []):
            if len(pts) < 2: continue
            if t.get('natural') == 'coastline': coast[wid] = pts
            k = line_kind(t)
            if k in WALK and t.get('bridge', 'no') == 'no' and t.get('tunnel', 'no') == 'no' and t.get('man_made') != 'pier' and t.get('area') != 'yes' \
                    and (k != 'path' or t.get('surface') in PAVED or t.get('bicycle') == 'designated'):
                paths[wid] = (pts, hnum(t.get('width')) or WALK[k])
            if t.get('barrier') in RAILS: rails[wid] = pts
        for wid, prs, t in d.get('areas', []):
            if t.get('natural') in ('beach', 'sand') or t.get('leisure') == 'beach_resort': sand[wid] = prs
        for b in d.get('buildings', []): builds[b[0]] = b[1][0][0]
    return coast, paths, sand, rails, builds


def runs_of(ok, gap, least):
    """the runs of True in ok (gaps of up to gap False closed, runs shorter than least dropped) as (start, end) slices"""
    k = np.flatnonzero(ok)
    if not len(k): return []
    cut = np.flatnonzero(np.diff(k) > gap + 1)
    out = []
    for a, b in zip(np.r_[k[0], k[cut + 1]], np.r_[k[cut], k[-1]]):
        if b - a + 1 >= least: out.append((int(a), int(b) + 1))
    return out


def grade(z, d):
    """z no steeper than d from one point to the next: a peak cut down, a dip filled (both ways)"""
    z = z.copy()
    for k in range(1, len(z)): z[k] = min(max(z[k], z[k - 1] - d), z[k - 1] + d)
    for k in range(len(z) - 2, -1, -1): z[k] = min(max(z[k], z[k + 1] - d), z[k + 1] + d)
    return z


def smooth_top(z, grade, step):
    """a run's top: a running median (no lamp post or bench in the LiDAR ground), then no steeper than grade"""
    from scipy.ndimage import median_filter, uniform_filter1d
    z = uniform_filter1d(median_filter(z, 9, mode='nearest'), 5, mode='nearest')
    d = grade * step
    for _ in range(2):  # both ways: a peak cut down, a dip filled
        for k in range(1, len(z)): z[k] = min(max(z[k], z[k - 1] - d), z[k - 1] + d)
        for k in range(len(z) - 2, -1, -1): z[k] = min(max(z[k], z[k + 1] - d), z[k + 1] + d)
    return z


BAND = 0.95  # metres the walk's top may sit off the LiDAR ground on it (tools/geom_rules.py SW_LIDAR, less a margin)
CLEAR = 0.3  # metres between the edge of a path along a wall and its line
WALK_GRADE = 0.1  # the steepest a walk's top climbs along it where the ground lets it (tools/geom_rules.py SW_STEP: 0.2)
SHIFT = 2.0  # metres a path along a wall may be mapped out past its edge (OSM against the LiDAR): moved in onto the walk


def fit(P, n, z, w, pw, plines, ptree):
    """a run's wall fitted to the LiDAR ground and its walk's paths (P its points on the coastline, n their normals to
    the land, z its top so far, w its walk's reach): the top the smoothest line that stays within BAND of the ground at
    the paths along it and across the walk (to 4 m in, or its reach), the reach in as far as the ground stays so, the
    line in to where the ground comes up to the top (the coastline is often drawn out at the foot of the rocks below
    it) but out past every path along the walk -> (the line's offset in from P, top, reach from the line)"""
    from scipy.ndimage import maximum_filter1d, median_filter, minimum_filter1d, uniform_filter1d
    from scipy.spatial import cKDTree
    from shapely.geometry import LineString
    m = len(P)
    t = np.stack([n[:, 1], -n[:, 0]], 1)
    off = np.arange(-3, REACH + 0.01, 0.5)
    D = np.stack([hr_lookup(P[:, 0] + o * n[:, 0], P[:, 1] + o * n[:, 1], 1) for o in off], 1)
    # the paths along the run (not across it: stairs, ramps), every metre: (its point, offset in, LiDAR ground, half width)
    near = cKDTree(P)
    S = []
    for q in ptree.query(LineString(P).buffer(REACH + 4)):
        Q = np.array(densify(list(plines[q].coords), 1.0))
        if len(Q) < 2: continue
        d = np.gradient(Q, axis=0); d /= np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-9)[:, None]
        _, k = near.query(Q)
        o = ((Q - P[k]) * n[k]).sum(1); a = ((Q - P[k]) * t[k]).sum(1)
        sel = (np.abs((d * t[k]).sum(1)) > 0.7) & (np.abs(a) <= STEP) & (o > -4) & (o < REACH + 2)
        if sel.any(): S.append(np.c_[k[sel], o[sel], hr_lookup(Q[sel, 0], Q[sel, 1], 1), np.full(sel.sum(), pw[q][1] / 2)])
    S = np.concatenate(S) if S else np.zeros((0, 4))
    S = S[np.isfinite(S[:, 2])]
    by = [S[S[:, 0] == k] for k in range(m)]
    # (to start: the ground a metre to 4 m in, the walk's paths' own LiDAR read low where one is mapped out over the edge)
    plateau = np.nanmedian(np.where((off >= 2) & (off <= 5), D, np.nan), 1)
    T = smooth_top(np.where(np.isfinite(plateau), np.fmax(plateau, z), z), GRADE, STEP); W = np.minimum(w, EDGE)
    for _ in range(3):
        # the line where the ground comes up to the walk (a 2 m cell's uncertainty out), but never in past the inner edge
        # of the walk's first path by more than SHIFT (one mapped out over the edge is moved in onto the walk: tools/tiles.py off_walls)
        ed = np.zeros(m); bound = np.full(m, 9.0)
        for k in range(m):
            s = by[k][by[k][:, 1] > -3]  # (the walk's: not a path out at the rocks' foot)
            up = np.flatnonzero((off >= -1) & (D[k] >= T[k] - BAND))
            ed[k] = off[up[0]] - 0.25 if len(up) else 0.0
            if len(s): bound[k] = (s[:, 1] + s[:, 3]).min() + SHIFT
        ed = np.minimum(uniform_filter1d(median_filter(ed, 7, mode='nearest'), 5, mode='nearest'), bound)
        lo = np.full(m, -np.inf); hi = np.full(m, np.inf); ext = np.minimum(w - ed, EDGE)
        for k in range(m):
            # what the walk stands on from its edge in: its paths (but those moved in), the ground to 4 m in; as far as one top fits them
            s = by[k][by[k][:, 1] - by[k][:, 3] >= ed[k] + CLEAR]
            j = (off >= ed[k] + 0.5) & (off <= ed[k] + min(ext[k], 4.0)) & np.isfinite(D[k])
            v = np.r_[np.c_[s[:, 1] - s[:, 3], s[:, 2], np.ones(len(s))], np.c_[off[j], D[k][j], np.zeros(j.sum())]]
            v = v[np.argsort(v[:, 0])]
            if not len(v): continue
            run_lo, run_hi = np.maximum.accumulate(v[:, 1]), np.minimum.accumulate(v[:, 1])
            keep = int(np.argmax(run_lo - run_hi > 2 * BAND)) if (run_lo - run_hi > 2 * BAND).any() else len(v)
            keep = max(keep, 1)
            if keep < len(v): ext[k] = min(ext[k], max(v[keep, 0] - ed[k] - 0.5, 1.0))  # (the ground climbing off the walk: it reaches less far)
            # the band: the paths on it, and the ground where the walk's width is measured (min(reach, 4) in: geom_rules
            # seawall-lidar); the ground between is the 2 m LiDAR's smear of kerbs, planters, benches
            u = v[:keep]; u = u[(u[:, 2] == 1) | (np.abs(u[:, 0] - ed[k] - min(ext[k], 4.0)) <= 0.5)]
            if len(u): lo[k], hi[k] = u[:, 1].max() - BAND, u[:, 1].min() + BAND
        # the top moved only where it must, and smoothly: down by the most it is over a band within 6 m, up likewise
        env = lambda v: uniform_filter1d(maximum_filter1d(np.nan_to_num(np.maximum(v, 0), posinf=0), 7, mode='nearest'), 7, mode='nearest')
        T = smooth_top(T, GRADE, STEP)  # (no bump a walker would feel: then moved into the band where it must)
        for _ in range(4): T = T - env(T - hi); T = T + env(lo - T)
        hi_ = np.maximum(lo, hi)
        for _ in range(20): T = grade(np.clip(T, lo, hi_), WALK_GRADE * STEP)  # (into the band, and no steeper than a walk)
        T = np.clip(T, lo, hi_)
        W = ext
    W = np.maximum(uniform_filter1d(minimum_filter1d(np.minimum(w - ed, W), 5, mode='nearest'), 5, mode='nearest'), 1.0)
    return ed, T, W


def unfold(P, Q):
    """which points of Q (P's points, each moved along its normal) to keep so that no segment of the line through them
    runs against the way P runs there (a fold: a spike in the wall's face)"""
    keep = np.ones(len(P), bool)
    for _ in range(len(P)):
        k = np.flatnonzero(keep)
        if len(k) < 3: break
        dq, dp = np.diff(Q[k], axis=0), np.diff(P[k], axis=0)
        bad = (dq * dp).sum(1) < 0.5 * np.hypot(*dq.T) * np.hypot(*dp.T)
        if not bad.any(): break
        j = int(np.flatnonzero(bad)[0])
        keep[k[j + 1] if j + 1 < len(k) - 1 else k[j]] = False
    return keep


def detect(coast, paths, sand, rails, why=None):
    import shapely
    from shapely.geometry import LineString, Polygon
    from shapely.strtree import STRtree
    pw = list(paths.values())
    plines = [LineString(p) for p, _ in pw]
    widths = np.array([w for _, w in pw])
    ptree = STRtree(plines)
    sp = []
    for prs in sand.values():
        for o, ins in prs:
            if len(o) >= 4:
                g = Polygon(o, [h for h in ins if len(h) >= 4])
                sp.append(g if g.is_valid else g.buffer(0))
    stree = STRtree(sp) if sp else None
    rl = [LineString(p) for p in rails.values()]
    rtree = STRtree(rl) if rl else None
    # the coastline whole: OSM splits it into ways anywhere, and a run ending at each split blends its walk down there
    from shapely.ops import linemerge
    first = {tuple(np.round(p[0], 3)): wid for wid, p in coast.items()}
    merged = linemerge([LineString(p) for p in coast.values()], directed=True)
    edges = [(first.get(tuple(np.round(g.coords[0], 3)), k), [tuple(c) for c in g.coords], False) for k, g in enumerate(getattr(merged, 'geoms', [merged]))]
    # a beach's landward edge: the walk behind the beach up on its wall (English Bay, Second Beach), the sand at its
    # foot; its ring turned so the sand lies on the right as the sea does of a coastline
    for k, g in enumerate(sp):
        for poly in getattr(g, 'geoms', [g]):
            r = np.asarray(poly.exterior.coords)
            if len(r) >= 4: edges.append((-1 - k, (r if poly.exterior.is_ccw else r[::-1])[::-1].tolist(), True))
    out = []
    taken = None  # the coastline's walls, once found: a beach's edge along one is that wall, not a second one over it
    for wid, pts, beach in edges:
        if beach and taken is None: taken = STRtree([LineString(r[1]) for r in out]) if out else False
        P = np.array(densify(pts, STEP), float)
        if len(P) < 6: continue
        t = np.gradient(P, axis=0); t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
        n = np.stack([-t[:, 1], t[:, 0]], 1)  # the land side: OSM coastlines have the land on their left
        rays = shapely.linestrings(np.stack([P - 2 * n, P + (REACH + 2) * n], 1))
        a, b = ptree.query(rays, predicate='intersects')
        hits = [[] for _ in range(len(P))]
        if len(a):
            X = shapely.intersection(rays[a], np.array(plines, object)[b])
            for r, q, g in zip(a, b, X):
                for c in shapely.get_coordinates(g):
                    hits[r].append((float(np.dot(c - P[r], n[r])), widths[q], c))
        W = np.full(len(P), np.nan); Z = np.full(len(P), np.nan); W0 = np.full(len(P), np.nan)  # (W0: where the first path's edge is)
        for r, hs in enumerate(hits):
            edge, zs = 0.0, []
            for d, w, c in sorted(hs, key=lambda h: h[0]):
                if d - w / 2 > edge + (GAP if zs else FIRST) or d > REACH: break
                if not zs: W0[r] = d - w / 2
                edge = max(edge, d + w / 2); zs.append(c)
            if zs: W[r] = edge + 0.5; Z[r] = np.nanmedian(hr_lookup([c[0] for c in zs], [c[1] for c in zs], 1))
        # the ground comes up to the walk's height within a few metres of the edge (the coastline is often drawn at the
        # wall's foot, a few metres out from its top's edge as the 2 m LiDAR ground sees it)
        near = np.nanmax(np.stack([hr_lookup(P[:, 0] + o * n[:, 0], P[:, 1] + o * n[:, 1], 1) for o in range(1, 6)]), 0)
        # and the walk a few metres in is at its paths' height (not a bank sloping up to a walk along its top)
        k4 = np.minimum(np.nan_to_num(W, nan=4.0), 4.0)[:, None]
        flat = np.abs(hr_lookup(P[:, 0] + k4[:, 0] * n[:, 0], P[:, 1] + k4[:, 0] * n[:, 1], 1) - Z) < 1.0
        if beach:  # the sand at the foot: its ground a few metres out, and the walk well over it
            foot = np.nanmedian(np.stack([hr_lookup(P[:, 0] - o * n[:, 0], P[:, 1] - o * n[:, 1], 1) for o in (2, 3, 4)]), 0)
            ok = np.isfinite(W) & np.isfinite(Z) & np.isfinite(foot) & (Z > foot + 1.0) & (near > Z - 0.8) & (W < 16) & flat
        else:
            foot = np.full(len(P), FOOT)
            # and the water really is low out there: not a coastline drawn under a deck or a plaza built over the water
            # (Canada Place, the convention centre: the LiDAR ground goes on at the walk's height)
            out_ = np.nanmin(np.stack([hr_lookup(P[:, 0] - o * n[:, 0], P[:, 1] - o * n[:, 1], 1) for o in (2, 4, 6)]), 0)
            ok = np.isfinite(W) & np.isfinite(Z) & (Z > 1.8) & (Z < TOP_MAX) & (near > Z - 1.2) & ~(out_ > Z - 1.2) & flat
        if stree is not None and ok.any():  # a beach between the walk and the water: a shore, not a wall
            k = np.flatnonzero(ok)
            ins = shapely.linestrings(np.stack([P[k] + 0.5 * n[k], P[k] + np.minimum(W[k], 8)[:, None] * n[k]], 1))
            ra, sb = stree.query(ins, predicate='intersects')
            if len(ra):
                frac = np.zeros(len(k))
                np.add.at(frac, ra, shapely.length(shapely.intersection(ins[ra], np.array(sp, object)[sb])))
                ok[k[frac > 1.0]] = False
        if beach and taken and ok.any():
            k = np.flatnonzero(ok)
            ok[k[np.unique(taken.query(shapely.points(P[k]), predicate='dwithin', distance=4.0)[0])]] = False
        if why is not None: why.append((P, np.isfinite(W), Z, near, ok, W))
        # a run splits where its walk steps (stairs down from a raised plaza, Canada Place's deck): one top each side,
        # not one ramp smoothed over the stairs
        from scipy.ndimage import median_filter as _mf
        zf = _mf(np.where(np.isfinite(Z), Z, -99.0), 5, mode='nearest')
        step = np.r_[False, np.abs(np.diff(zf)) > STEP_UP]
        # (a path across it, stairs or a ramp down to the sand or the water, is cut at its edge: tools/tiles.py off_walls)
        spans = [(a + s0, b + s0) for s0, e0 in runs_of(ok, gap=int(10 / STEP), least=int(24 / STEP))
                 for a, b in runs_of(~step[s0:e0] | (np.arange(e0 - s0) == 0), 0, int(24 / STEP))]
        for s, e in spans:
            z = Z[s:e].copy(); w = W[s:e].copy(); f = foot[s:e].copy()
            for v in (z, w, f):  # the gaps closed: carried over from both sides
                bad = ~np.isfinite(v)
                if bad.any(): v[bad] = np.interp(np.flatnonzero(bad), np.flatnonzero(~bad), v[~bad])
            from scipy.ndimage import maximum_filter1d, median_filter, uniform_filter1d
            z = smooth_top(z, GRADE, STEP)
            w = np.minimum(uniform_filter1d(maximum_filter1d(w, 7), 7), EDGE)
            ed, z, w = fit(P[s:e], n[s:e], z, w, pw, plines, ptree)
            f = np.minimum(uniform_filter1d(median_filter(f, 9, mode='nearest'), 5, mode='nearest'), z - 0.8)
            Pw = P[s:e] + n[s:e] * ed[:, None]
            rail = np.zeros(e - s, bool)
            if rtree is not None:
                ra, rb = rtree.query(shapely.points(Pw + 0.6 * n[s:e]), predicate='dwithin', distance=2.0)
                rail[ra] = True
                rail = uniform_filter1d(rail.astype(float), 5) > 0.5
            keep = unfold(P[s:e], Pw)  # (moved in round a tight bend the line folds over itself: those points go)
            if keep.sum() >= 2: out.append((wid, Pw[keep], z[keep], w[keep], rail[keep], f[keep]))
    return out


# ---------------------------------------------------------------- a day at the beach: what OSM maps on the beaches and walks
KIT = {'table': 18, 'bin': 19, 'stand': 20, 'washroom': 21, 'fountain': 22}  # LOGS kinds (the page's core/tiles.js BEACH_KIT)
KIT_SIZE = {18: (1.8, 1.7), 19: (0.66, 0.66), 20: (4.4, 5.0), 21: (4.4, 6.4), 22: (0.4, 0.4)}  # footprint along, across (m)


def kit_box(x, y, a, k):
    """a beach thing's footprint (KIT_SIZE, along its angle)"""
    import shapely
    ln, d = KIT_SIZE[int(k)]; c, s_ = math.cos(a), math.sin(a)
    return shapely.Polygon([(x + c * u - s_ * v, y + s_ * u + c * v) for u, v in ((-ln / 2, -d / 2), (ln / 2, -d / 2), (ln / 2, d / 2), (-ln / 2, d / 2))])


def kit_kind(t):
    a = t.get('amenity')
    if t.get('leisure') == 'picnic_table' or a == 'picnic_table': return KIT['table']
    if a == 'waste_basket': return KIT['bin']
    if a in ('drinking_water', 'water_point'): return KIT['fountain']
    if a == 'toilets': return KIT['washroom']
    if a in ('fast_food', 'ice_cream', 'cafe') or t.get('shop') == 'kiosk': return KIT['stand']
    return None


def amenities(R, paths, sand, builds, src='data/lm.osm.pbf'):
    """the picnic tables, bins, drinking fountains, washrooms and concession stands OSM maps on or by a beach (60 m) or
    a seawall's walk (30 m): a washroom or stand only where no building is mapped round it (else the building is it),
    each moved off the path it stands on and facing the nearest -> [(x, north, angle, kind)]"""
    import osmium, shapely, shapely.ops
    from shapely.geometry import LineString, Polygon
    from shapely.strtree import STRtree
    near = [Polygon(o).buffer(0).buffer(60) for prs in sand.values() for o, _ in prs if len(o) >= 4] + [LineString(r[1]).buffer(30) for r in R]
    nt = STRtree(near)
    bt = STRtree([Polygon(r).buffer(0) for r in builds.values() if len(r) >= 4])
    pw = list(paths.values()); pl = [LineString(p) for p, _ in pw]; pt = STRtree(pl)
    out = []
    for o in osmium.FileProcessor(src, osmium.osm.NODE).with_filter(osmium.filter.KeyFilter('amenity', 'leisure', 'shop')):
        k = kit_kind(dict(o.tags))
        if k is None: continue
        x, y = xy(o.location.lat, o.location.lon); p = shapely.Point(x, y)
        if not len(nt.query(p, predicate='intersects')): continue
        if k in (KIT['stand'], KIT['washroom']) and len(bt.query(p.buffer(6), predicate='intersects')): continue
        a = 0.0
        q = pt.nearest(p)
        if q is not None:
            c = shapely.get_coordinates(shapely.ops.nearest_points(pl[q], p)[0])[0]; v = np.array([x, y]) - c; dv = float(np.hypot(*v))
            clear = pw[q][1] / 2 + max(KIT_SIZE[k]) / 2 + 0.3
            if dv < clear:  # on the path (a node of the way): off it, to the side it is on
                v = v / dv if dv > 1e-3 else np.array([1.0, 0.0]); x, y = c + v * clear
            a = math.atan2(-v[1], -v[0])  # +x towards the path
        out.append((float(x), float(y), a, k))
    return apart(out)


def apart(K, clear=0.15):
    """beach things clear of each other: one OSM maps by another (two picnic tables side by side) moved off it,
    away from it, a step at a time (geom_rules.py log_fix would drop it)"""
    K = list(K)
    for i in range(1, len(K)):
        for _ in range(40):
            x, y, a, k = K[i]; b = kit_box(x, y, a, k)
            hit = next((q for q in K[:i] if abs(q[0] - x) < 8 and abs(q[1] - y) < 8 and kit_box(*q).distance(b) < clear), None)
            if hit is None: break
            v = np.array([x - hit[0], y - hit[1]]); v = v / (np.hypot(*v) or 1.0) if np.hypot(*v) > 1e-6 else np.array([1.0, 0.0])
            K[i] = (x + v[0] * 0.1, y + v[1] * 0.1, a, k)
    return K


def bake():
    t0 = time.time()
    coast, paths, sand, rails, builds = gather()
    print(len(coast), 'coastline ways', len(paths), 'walks', len(sand), 'beaches', len(rails), 'railings', f'{time.time() - t0:.0f}s', flush=True)
    R = detect(coast, paths, sand, rails)
    K = amenities(R, paths, sand, builds)
    R.sort(key=lambda r: r[0])
    ro = np.cumsum([0] + [len(r[1]) for r in R])
    pts = np.concatenate([r[1] for r in R]).astype(np.float32)
    np.savez_compressed(OUT, xy=pts, top=np.concatenate([r[2] for r in R]).astype(np.float32), reach=np.concatenate([r[3] for r in R]).astype(np.float32),
                        rail=np.concatenate([r[4] for r in R]).astype(bool), foot=np.concatenate([r[5] for r in R]).astype(np.float32), ro=ro.astype(np.int32),
                        kit=np.array(K, np.float32).reshape(-1, 4))
    km = sum(np.hypot(*np.diff(r[1], axis=0).T).sum() for r in R) / 1000
    print({k: sum(1 for q in K if q[3] == v) for k, v in KIT.items()}, 'beach things')
    print(len(R), 'runs', f'{km:.1f} km', f'{(np.concatenate([r[4] for r in R])).mean() * 100:.0f}% railed', '->', OUT, f'{time.time() - t0:.0f}s', flush=True)


# ---------------------------------------------------------------- the height rule (the page's core/util.js wallHeight)
def runs(path=OUT):
    """[(points (n, 2), top, reach, rail, foot)] from data/seawalls.npz"""
    if not os.path.exists(path): return []
    d = np.load(path)
    return [(d['xy'][a:b].astype(float), d['top'][a:b].astype(float), d['reach'][a:b].astype(float), d['rail'][a:b], d['foot'][a:b].astype(float))
            for a, b in zip(d['ro'][:-1], d['ro'][1:])]


def ends(P):
    """per point of a run: 0 at its ends, up to 1 B_END metres along from them (the top blends into the ground there)"""
    s = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    return np.clip(np.minimum(s, s[-1] - s) / B_END, 0, 1)


def vnormals(P):
    """per point of a run its normal to the walk's side: at a corner between its two segments' (the page's
    core/util.js wallGrid)"""
    t = np.diff(P, axis=0); t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
    n = np.stack([-t[:, 1], t[:, 0]], 1)
    v = np.r_[n[:1], n[:-1] + n[1:], n[-1:]]
    return v / np.maximum(np.hypot(v[:, 0], v[:, 1]), 1e-9)[:, None]


def height(R, g, x, y, low=None):
    """the drawn ground at points x, y (g: the terrain there) with the seawalls R: on the walk's side up to its reach
    the wall's top (blending into the ground over B_IN past it and B_END past a run's ends), on the water side the
    water or sand at its foot (LOW out, then back to the ground). low: per point, True for the ground classes at its
    foot (water, sand), False (or None) for the rest (the walk's to SLIT out over the line, where the ground is cut). R: runs (runs()), or a tile's pieces of them with their end weights (tile_walls())"""
    import shapely
    x, y, g = (np.asarray(v, float).ravel() for v in (x, y, g))
    R_ = REACH + 4 + B_IN  # the furthest a wall reaches (the page's WALL_R)
    d1 = np.full(len(x), R_); h1 = g.copy(); d2 = np.full(len(x), R_); h2 = g.copy()
    for P, top, reach, _, foot, *E in R:
        best = np.full(len(x), R_); hv = g.copy()  # this run's nearest segment
        f = E[0] if E else ends(P)  # (a tile's piece of a run carries the whole run's)
        gw = E[1] if len(E) > 1 else None  # the terrain on its walk (inland()): what the walk blends to at the run's ends
        a, b = P[:-1], P[1:]
        ab = b - a; L2 = np.maximum((ab ** 2).sum(1), 1e-9)
        N = vnormals(P)
        for k in range(len(a)):
            u = np.clip(((x - a[k, 0]) * ab[k, 0] + (y - a[k, 1]) * ab[k, 1]) / L2[k], 0, 1)
            qx, qy = a[k, 0] + ab[k, 0] * u, a[k, 1] + ab[k, 1] * u
            dist = np.hypot(x - qx, y - qy)
            m = dist < best
            if not m.any(): continue
            # + on the walk's side: off a segment's end, the side the corner's normal says (not the segment's line)
            sd = np.where(u <= 0, (x - a[k, 0]) * N[k, 0] + (y - a[k, 1]) * N[k, 1], np.where(u >= 1, (x - b[k, 0]) * N[k + 1, 0] + (y - b[k, 1]) * N[k + 1, 1],
                          ab[k, 0] * (y - a[k, 1]) - ab[k, 1] * (x - a[k, 0])))
            d = np.where(sd < 0, -dist, dist)
            T = top[k] + (top[k + 1] - top[k]) * u; Ft = foot[k] + (foot[k + 1] - foot[k]) * u; W = reach[k] + (reach[k + 1] - reach[k]) * u; F = f[k] + (f[k + 1] - f[k]) * u
            Gw = g if gw is None else g + (gw[k] + (gw[k + 1] - gw[k]) * u - g) * np.clip(2 * F, 0, 1)
            side = d > -SLIT if low is None else np.where(np.asarray(low, bool), d >= 0.4, d > -SLIT)
            w_in = np.clip(1 - (d - W) / B_IN, 0, 1); w_out = np.clip(1 - (-d - LOW) / LOW_B, 0, 1)
            # the walk's side: its top; toward a run's ends first the terrain on the walk (the same across it: the coping stays
            # on the walk while the wall stands, F > 0.5), then the terrain where it is; past its reach the terrain there.
            # the foot's: the water or sand, toward the ends the terrain
            h = np.where(side, g + (Gw + (T - Gw) * F - g) * w_in, g + (Ft - g) * w_out * F)
            best = np.where(m, dist, best); hv = np.where(m, h, hv)
        # the two nearest runs, cross-faded where they're about as near (a run ending by another, two at a corner)
        first = best < d1; second = ~first & (best < d2)
        d2, h2 = np.where(first, d1, np.where(second, best, d2)), np.where(first, h1, np.where(second, hv, h2))
        d1, h1 = np.where(first, best, d1), np.where(first, hv, h1)
    t = np.minimum(1, (d2 - d1) / FADE)
    return h1 + (h2 - h1) * 0.5 * (1 - t * t * (3 - 2 * t))


def inland(P, reach, ground):
    """per point of a run its walk's terrain: ground (the drawn terrain, x, y -> z) min(reach, 4) m in from its line
    (the page's core/tile-worker.js terrain())"""
    Q = P + vnormals(P) * np.minimum(reach, 4.0)[:, None]
    z = np.asarray(ground(Q[:, 0], Q[:, 1]), float)
    return np.where(np.isfinite(z), z, np.asarray(ground(P[:, 0], P[:, 1]), float))  # (past the tiles there are: at the line)


def tile_walls(path):
    """a baked detail tile's seawall pieces (its SEAW section, tools/tiles.py seawall_section) as height() reads them:
    [(points, top, reach, rail, foot, end weight)]"""
    import struct
    from common import read_tile
    b, ox, oy, size, sec, ring = read_tile(path)
    if 'SEAW' not in sec: return []
    k = (2 * size) / 32766
    o = sec['SEAW'][0]; nr = struct.unpack_from('<I', b, o)[0]; o += 4
    out = []
    for _ in range(nr):
        n = struct.unpack_from('<I', b, o)[0]; o += 4
        a = np.frombuffer(b, np.dtype([('x', '<i2'), ('y', '<i2'), ('top', '<i2'), ('foot', '<i2'), ('reach', 'u1'), ('f', 'u1'), ('rail', 'u1')]), n, o); o += 11 * n
        out.append((np.c_[a['x'] * k + ox, a['y'] * k + oy], a['top'] / 100, a['reach'] / 10, a['rail'].astype(bool), a['foot'] / 100, a['f'] / 255))
    return out


def check():
    """a straight wall along y = 0 (land north), its top 4 m: the walk on it, the sea at its foot, the ground past it"""
    P = np.c_[np.arange(0, 101, STEP), np.zeros(51)]
    R = [(P, np.full(51, 4.0), np.full(51, 8.0), np.zeros(51, bool), np.full(51, FOOT))]
    h = lambda x, y, g, low=None: float(height(R, [g], [x], [y], None if low is None else [low])[0])
    assert h(50, 3, 2.0) == 4.0 and h(50, 8, 2.0) == 4.0  # on the walk
    assert h(50, 8 + B_IN + 1, 2.0) == 2.0  # past it: the ground
    assert abs(h(50, 8 + B_IN / 2, 2.0) - 3.0) < 1e-6  # blending
    assert h(50, -2, 1.5) == FOOT and h(50, -20, 1.5) == 1.5  # the water at its foot, the sea further out as it is
    assert h(50, 0.1, 1.5, low=True) == FOOT and h(50, -0.1, 1.5, low=False) == 4.0  # at the line: by class
    assert h(0, 3, 2.0) == 2.0 and abs(h(B_END / 2, 3, 2.0) - 3.0) < 1e-6  # a run's ends blend into the ground
    print('seawall check ok')


if __name__ == '__main__':
    check() if sys.argv[1:] == ['check'] else bake()
