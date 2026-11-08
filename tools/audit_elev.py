# Audit of road, rail and bridge heights in baked tiles (what the page draws) against the HRDEM 2 m LiDAR:
#  grade    at-grade pieces drawn more than 1.5 m off the bare-earth DTM (on the terrain grid the page drapes them over)
#  untagged at-grade pieces with layer >= 1 where the LiDAR surface stands well above the ground (a deck drawn on the ground)
#  under    at-grade pieces under a bridge deck drawn within 3 m of its underside (or above it)
#  clash    bridge decks running through a building's volume (or a building poking through a deck)
#  step     bridge ends more than 1 m off the road they meet (cliffs at abutments), joints between decks that don't meet
#  steep    deck stretches steeper than 12% (paths 25%, stairs any)
#  buried   deck stretches the ground rises through (more than 1 m above the deck top)
#  tunnel   tunnels (tunnel=*, covered=yes, layer < 0 under something) drawn on the surface
# Run: uv run --with numpy,scipy,pillow,shapely,rasterio python3 tools/audit_elev.py <tiles dir> [procs] [i_j ...]
# Writes <tiles dir>/audit.json (every finding, worst first) and prints counts and the worst of each kind with a view
# hash for the site (#X,Y,zoom; main.js setView: X = E*6 + 23551.5, Y = 9727.5 - (N*0.5 + h*0.866)*6).
import gzip, json, os, struct, sys
from multiprocessing import Pool
import numpy as np
import shapely
from shapely.geometry import LineString, Polygon
from shapely.strtree import STRtree
sys.path.insert(0, os.path.dirname(__file__))
from common import latlon, L0, KINDS, line_kind, hnum, hr_lookup, densify, all_tiles, tile_args, load_feat

DIR = sys.argv[1] if len(sys.argv) > 1 else 'public/tiles'
TUNNEL = ('yes', 'building_passage', 'culvert')


def parse(path):
    """a baked tile -> (ox, oy, size, terrain n x n, lines [dict], buildings [dict])"""
    b = gzip.decompress(open(path, 'rb').read())
    ox, oy, size = struct.unpack_from('<fff', b, 8)
    k = (2 * size) / 32766
    sec, o = {}, 20
    while o < len(b):
        tag = b[o:o + 4].decode(); n = struct.unpack_from('<I', b, o + 4)[0]; sec[tag] = (o + 8, n); o += 8 + n

    def ring(o):
        n = struct.unpack_from('<I', b, o)[0]
        d = np.frombuffer(b, '<i2', 2 * n, o + 4).reshape(-1, 2).astype(np.int64).cumsum(0)
        return d * k + (ox, oy), o + 4 + 4 * n
    o = sec['TERR'][0]; n = struct.unpack_from('<H', b, o)[0]
    terr = np.frombuffer(b, '<i2', n * n, o + 2).reshape(n, n) / 10.0
    lines = []
    if 'LINE' in sec:
        o = sec['LINE'][0]
        nn = struct.unpack_from('<I', b, o)[0]; nodes = np.frombuffer(b, '<u8', nn, o + 4); o += 4 + 8 * nn
        cnt = struct.unpack_from('<I', b, o)[0]; o += 4
        for _ in range(cnt):
            kind, lanes, flags, layer, w, a, bb = struct.unpack_from('<BBBbHII', b, o); o += 14
            pts, o = ring(o)
            z = None
            if flags & 4: z = np.frombuffer(b, '<i2', len(pts), o) / 10.0; o += 2 * len(pts)
            if flags & 32: nf = b[o]; o += 1 + nf; nb = b[o]; o += 1 + nb
            lines.append(dict(kind=kind, layer=layer, w=w / 100, band=bool(flags & 2), a=int(nodes[a]), b=int(nodes[bb]), pts=pts, z=z))
    blds = []
    if 'BLDG' in sec:
        o = sec['BLDG'][0]; cnt = struct.unpack_from('<I', b, o)[0]; o += 4
        for _ in range(cnt):
            fl, style, base, h = struct.unpack_from('<BBhH', b, o); o += 6
            mn = ridge = 0.0
            if fl & 1: mn = struct.unpack_from('<H', b, o)[0] / 10; o += 2
            if fl & 2: ridge = struct.unpack_from('<H', b, o + 1)[0] / 10; o += 3
            if fl & 4: o += 4
            if fl & 8: o += 4
            if fl & 16: o += 6
            if fl & 32: o += 2
            if fl & 64: o += 1 + 8 * b[o]
            pts, o = ring(o)
            blds.append(dict(base=base / 10, bot=base / 10 + mn, top=base / 10 + max(h / 10, ridge), ring=pts))
    return ox, oy, size, terr, lines, blds


class Ground:
    """the terrain as drawn: bilinear on each detail tile's grid (tile-worker.js heightAt)"""
    def __init__(self, tiles): self.t = tiles

    def __call__(self, x, y):
        x, y = np.atleast_1d(np.asarray(x, float)), np.atleast_1d(np.asarray(y, float))
        out = np.full(x.shape, np.nan)
        ti, tj = np.floor(x / L0).astype(int), np.floor(y / L0).astype(int)
        for key in set(zip(ti.tolist(), tj.tolist())):
            T = self.t.get(key)
            if T is None: continue
            sel = (ti == key[0]) & (tj == key[1])
            ox, oy, size, h = T[0], T[1], T[2], T[3]
            n = h.shape[0]; c = size / (n - 1)
            fx = np.clip((x[sel] - ox) / c, 0, n - 1.0001); fy = np.clip((size - (y[sel] - oy)) / c, 0, n - 1.0001)
            i, j = fx.astype(int), fy.astype(int); u, v = fx - i, fy - j
            out[sel] = h[j, i] * (1 - u) * (1 - v) + h[j, i + 1] * u * (1 - v) + h[j + 1, i] * (1 - u) * v + h[j + 1, i + 1] * u * v
        return out


def site_hash(x, y, h, zoom=1.6):
    return f'#{round(x * 6 + 23551.5)},{round(9727.5 - (y * 0.5 + h * 0.866) * 6)},{zoom}'


def runs(mask):
    """(start, end) index pairs of the True runs"""
    d = np.diff(np.concatenate([[0], mask.astype(int), [0]]))
    return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]))


def audit(ij):
    i, j = ij
    tiles = {}
    for a in range(-1, 5):
        for b in range(-1, 5):
            p = f'{DIR}/0/{4 * i + a}_{4 * j + b}.bin'
            if os.path.exists(p): tiles[(4 * i + a, 4 * j + b)] = parse(p)
    own = [(k, T) for k, T in tiles.items() if 4 * i <= k[0] < 4 * i + 4 and 4 * j <= k[1] < 4 * j + 4]
    if not own: return []
    G = Ground(tiles)
    feat = load_feat(i, j)
    ways = [w for w in feat.get('lines', []) if line_kind(w[3])]
    # stations, parkades and covered bridges are built around their tracks and ramps: a deck inside them is real
    held = [Polygon(o) for _, prs, t in feat.get('buildings', []) for o, _ in prs if len(o) >= 4 and (
        t.get('building', t.get('building:part')) in ('train_station', 'transportation', 'parking', 'bridge') or t.get('amenity') == 'parking'
        or t.get('public_transport') == 'station' or t.get('railway') == 'station')]
    held = STRtree([h.buffer(0) for h in held]) if held else None
    byref = {}
    for n_, (wid, c, refs, t) in enumerate(ways):
        for r in refs: byref.setdefault(r, set()).add(n_)

    def tags(L):
        c = byref.get(L['a'], set()) & byref.get(L['b'], set())
        return ways[min(c)] if c else None
    lines = [L for _, T in tiles.items() for L in T[4]]
    mine = [L for _, T in own for L in T[4]]
    decks = [L for L in lines if L['z'] is not None]
    seen_b, blds = set(), []
    for _, T in tiles.items():
        for B in T[5]:
            key = (round(B['ring'][0][0], 1), round(B['ring'][0][1], 1), B['top'])
            if key not in seen_b: seen_b.add(key); blds.append(B)
    out = []

    def add(kind, score, x, y, h, L, w, **kw):
        lat, lon = latlon(x, y)
        out.append(dict(kind=kind, score=round(float(score), 1), x=round(float(x), 1), y=round(float(y), 1), lat=round(lat, 6), lon=round(lon, 6),
                        hash=site_hash(x, y, h), what=KINDS[L['kind']], name=(w[3].get('name', '') if w else ''), way=w[0] if w else None,
                        **{k: (round(float(v), 2) if isinstance(v, (float, np.floating)) else v) for k, v in kw.items()}))
    # deck segments: (polygon, z0, z1, piece) for under/clash checks
    segs, sp = [], []
    for L in decks:
        P, z = L['pts'], L['z']
        half = L['w'] / 2 + (2.5 if L['band'] else 0.6)
        th = 1.6 if L['kind'] <= KINDS.index('tertiary') else 0.9
        for k in range(len(P) - 1):
            ls = LineString([P[k], P[k + 1]])
            if ls.length < 0.1: continue
            segs.append((ls, z[k], z[k + 1], th, L)); sp.append(ls.buffer(half, cap_style='flat'))
    seg_tree = STRtree(sp) if sp else None

    def deck_at(x, y):
        """[(deck top, deck bottom, piece)] of decks overhead at a point"""
        if seg_tree is None: return []
        res = []
        for q in seg_tree.query(shapely.points(x, y), predicate='intersects'):
            ls, z0, z1, th, L = segs[q]
            f = ls.project(shapely.points(x, y), normalized=True)
            zz = z0 + (z1 - z0) * f
            res.append((zz + 0.35, zz - th, L))
        return res

    for L in mine:
        P = L['pts']
        if len(P) < 2: continue
        w = tags(L)
        t = w[3] if w else {}
        if L['z'] is None:
            if L['kind'] >= KINDS.index('runway') or t.get('indoor') in ('yes', 'corridor') or t.get('highway') == 'corridor': continue
            Q = np.array(densify([tuple(p) for p in P], 4.0))
            if len(Q) < 3: continue
            drawn = G(Q[:, 0], Q[:, 1])
            ref = hr_lookup(Q[:, 0], Q[:, 1], 1); surf = hr_lookup(Q[:, 0], Q[:, 1], 0)
            dev = drawn - ref
            ok = np.isfinite(dev)
            if t.get('tunnel') in TUNNEL or t.get('covered') == 'yes' and L['kind'] >= KINDS.index('rail'):
                add('tunnel', 10 * len(Q), *Q[len(Q) // 2], drawn[len(Q) // 2], L, w, note='tunnel drawn on the surface')
                continue
            bad = ok & (np.abs(dev) > 1.5)
            # under a deck: the road below must clear it
            for r0, r1 in runs(bad):
                if r1 - r0 < 2: continue
                m = r0 + int(np.nanargmax(np.abs(dev[r0:r1])))
                add('grade', (r1 - r0) * 4 * min(abs(dev[m]), 10), *Q[m], drawn[m], L, w, dev=dev[m], drawn=drawn[m], dtm=ref[m], length=(r1 - r0) * 4,
                    layer=int(hnum(t.get('layer')) or 0))
            lay = hnum(t.get('layer')) or 0
            if lay >= 1 and t.get('bridge') in (None, 'no'):
                free = np.array([not deck_at(*q) for q in Q])  # not a road under a bridge
                hi = free & np.isfinite(surf) & (surf - drawn > 3.5) & (surf - drawn < 15)
                if hi.mean() > 0.5 and len(Q) * 4 > 20:
                    m = len(Q) // 2
                    add('untagged', len(Q) * 4 * float(np.nanmedian((surf - drawn)[hi])), *Q[m], drawn[m], L, w, lidar_above=float(np.nanmedian((surf - drawn)[hi])), length=len(Q) * 4)
            if lay < 0 and t.get('tunnel') in (None, 'no'):
                cov = np.isfinite(surf) & (surf - drawn > 4)
                if cov.mean() > 0.7 and len(Q) * 4 > 40:
                    m = len(Q) // 2
                    add('tunnel', len(Q) * 4, *Q[m], drawn[m], L, w, note='layer<0 under a structure, drawn at grade', lidar_above=float(np.nanmedian((surf - drawn)[cov])))
            # under decks (only those of a higher layer, or any deck if this piece is at layer 0 or below)
            if seg_tree is not None:
                worst = None
                for k_ in range(len(Q)):
                    for top, bot, D in deck_at(*Q[k_]):
                        if D['layer'] < L['layer'] or D is L or min(np.hypot(*(D['pts'][0] - Q[k_])), np.hypot(*(D['pts'][-1] - Q[k_]))) < 12: continue
                        clear = bot - drawn[k_]
                        if clear < 3.0 and (worst is None or clear < worst[0]): worst = (clear, k_, top, D)
                if worst:
                    clear, k_, top, D = worst
                    add('under', (3.0 - clear) * 10, *Q[k_], drawn[k_], L, w, clearance=clear, drawn=drawn[k_], dtm=ref[k_], deck_top=top)
        else:
            z = np.asarray(L['z'], float)
            s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
            # steep
            ds = np.diff(s); g = np.abs(np.diff(z)) / np.maximum(ds, 1e-6)
            lim = 9 if L['kind'] == KINDS.index('steps') else 0.25 if KINDS[L['kind']] in ('footway', 'path', 'cycleway', 'pedestrian', 'track') else 0.12
            st = (g > lim + 0.005) & (ds >= 2)
            if st.any():
                k_ = int(np.argmax(np.where(st, g, 0)))
                add('steep', float(g[k_] * 100 * min(ds[k_], 30)), *P[k_], z[k_], L, w, grade=g[k_] * 100, length=ds[k_])
            # buried: the ground above the deck top away from its ends
            Q = np.array(densify([tuple(p) for p in P], 4.0)); sq = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(Q, axis=0).T))])
            zq = np.interp(sq, s, z); gq = G(Q[:, 0], Q[:, 1])
            inner = (sq > 12) & (sq < sq[-1] - 12)
            bur = inner & (gq > zq + 0.35 + 1.0)
            for r0, r1 in runs(bur):
                if r1 - r0 < 2: continue
                m = r0 + int(np.argmax((gq - zq)[r0:r1]))
                add('buried', (r1 - r0) * 4 * min(gq[m] - zq[m], 10), *Q[m], gq[m], L, w, ground_above=gq[m] - zq[m] - 0.35, length=(r1 - r0) * 4)
    # deck ends: against the road (or deck) they meet
    ends = {}
    for L in lines:
        ends.setdefault(L['a'], []).append((L, 0)); ends.setdefault(L['b'], []).append((L, -1))
    for L in mine:
        if L['z'] is None: continue
        w = tags(L)
        for e in (0, -1):
            node = L['a'] if e == 0 else L['b']
            x, y = L['pts'][e]; zd = float(L['z'][e])
            other = [(M, f) for M, f in ends.get(node, []) if M is not L]
            if not other: continue
            gr = [M for M, f in other if M['z'] is None and M['layer'] <= L['layer']]
            dk = [float(M['z'][f]) for M, f in other if M['z'] is not None]
            if dk and abs(np.mean(dk) - zd) > 0.5:
                add('step', abs(np.mean(dk) - zd) * 10, x, y, zd, L, w, step=zd - np.mean(dk), note='deck joint')
            elif gr and not dk:
                gh = float(G(x, y)[0])
                if abs(zd - gh) > 1.0: add('step', abs(zd - gh) * 10, x, y, zd, L, w, step=zd - gh, deck=zd, ground=gh, note='abutment')
    # decks through buildings
    deck_nodes = {}
    for D in decks:
        for nd in (D['a'], D['b']): deck_nodes[nd] = deck_nodes.get(nd, 0) + 1
    deck_nodes = {nd for nd, c in deck_nodes.items() if c > 1}  # joints inside a deck chain
    if blds and mine:
        bt = STRtree([Polygon(B['ring']).buffer(0) for B in blds])
        for L in mine:
            if L['z'] is None: continue
            w = tags(L)
            P, z = L['pts'], L['z']
            half = L['w'] / 2 + (2.5 if L['band'] else 0.6)
            th = 1.6 if L['kind'] <= KINDS.index('tertiary') else 0.9
            worst = None
            for k in range(len(P) - 1):
                ls = LineString([P[k], P[k + 1]])
                if ls.length < 0.1: continue
                q = ls.buffer(half, cap_style='flat')
                for bi in bt.query(q, predicate='intersects'):
                    B = blds[bi]; poly = bt.geometries[bi]
                    if held is not None and len(held.query(poly.representative_point(), predicate='within')): continue
                    inter = q.intersection(poly)
                    if inter.area < 2: continue
                    f = ls.project(inter.centroid, normalized=True); zz = z[k] + (z[k + 1] - z[k]) * f
                    top, bot = zz + 0.35, zz - th
                    pen = min(B['top'] - bot, top - B['bot'])
                    near_end = any(np.hypot(*(np.array(inter.centroid.coords[0]) - L['pts'][e])) < 8 for e, nd in ((0, L['a']), (-1, L['b'])) if nd not in deck_nodes)
                    if pen > 0.5 and not near_end:
                        sc = inter.area * min(pen, 10)
                        if worst is None or sc > worst[0]: worst = (sc, inter.centroid, zz, B, inter.area, pen)
            if worst:
                sc, c, zz, B, ar, pen = worst
                add('clash', sc, c.x, c.y, zz, L, w, deck=zz, bld_bot=B['bot'], bld_top=B['top'], overlap=ar, depth=pen)
    return out


if __name__ == '__main__':
    procs = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    want = tile_args(sys.argv[3:]) or all_tiles()
    with Pool(procs) as p:
        found = [f for r in p.imap_unordered(audit, want) for f in r]
    uniq = {}
    for f in found: uniq.setdefault((f['kind'], round(f['x']), round(f['y'])), f)
    found = sorted(uniq.values(), key=lambda f: -f['score'])
    json.dump(found, open(f'{DIR}/audit.json', 'w'), indent=0, default=lambda o: o.item())
    kinds = ['grade', 'untagged', 'under', 'clash', 'step', 'steep', 'buried', 'tunnel']
    print('counts', {k: sum(1 for f in found if f['kind'] == k) for k in kinds}, 'total', len(found))
    print('big', {k: sum(1 for f in found if f['kind'] == k and f['score'] >= 50) for k in kinds}, '(score >= 50)')
    for k in kinds:
        top = [f for f in found if f['kind'] == k][:8]
        if top: print(f'--- {k}')
        for f in top: print({a: v for a, v in f.items() if a not in ('kind', 'lat', 'lon')})
