# Geometry rules: what the map must not draw (a building hanging in the air, one sunk into the ground, ...), each a
# check over a tile and, where it can, its automatic fix. tools/tiles.py runs every rule on each 4 km cell it bakes
# (the fix, then the check: what is left) and prints the counts; over baked tiles (what the page draws):
#   uv run --with numpy,scipy,shapely,pillow,rasterio python3 tools/geom_rules.py <tiles dir> [procs] [i_j ...]
# prints the counts and the worst of each with a view hash, and writes <tiles dir>/rules.json (worst first).
# Rule(name, check, fix=None): check(tile) -> [issue dicts: kind, x, y, score, hash, ...]; fix(tile) -> how many it
# fixed, in place. A tile: dict(builds=[parts as tiles.py's buildings() makes them: ring, base, mn, h, ridge;
# tagmn for a mapped min height, lid for one stood on a tunnel's box], decks=[(points, deck heights, width)], ground=f(x, y) -> the
# drawn ground under numpy arrays of points).
import json, os, sys
from collections import namedtuple
import numpy as np
import shapely
from shapely.geometry import Polygon
from shapely.strtree import STRtree
sys.path.insert(0, os.path.dirname(__file__))
from common import densify

Rule = namedtuple('Rule', 'name check fix', defaults=(None,))


def view_hash(x, y, h, zoom=0.3):  # main.js setView, as tools/audit_elev.py site_hash
    return f'#{round(x * 6 + 23551.5)},{round(9727.5 - (y * 0.5 + h * 0.866) * 6)},{zoom}'


def _polys(tile):
    if '_polys' not in tile:
        P = []
        for b in tile['builds']:
            p = Polygon(b['ring']) if len(b['ring']) >= 3 else Polygon()
            P.append(p if p.is_valid else p.buffer(0))
        tile['_polys'] = P
        tile['_tree'] = STRtree(P)
    return tile['_polys'], tile['_tree']


def _rec(b, P, kind, score, **kw):
    c = P.representative_point()
    foot = b['base'] + (b['mn'] or 0)
    return dict(kind=kind, x=round(c.x, 1), y=round(c.y, 1), base=round(b['base'], 1), foot=round(foot, 2), area=round(P.area),
                score=round(float(score), 1), hash=view_hash(c.x, c.y, foot), **kw)


# ---------------------------------------------------------------- buildings: their feet on the ground
def _outline_ground(tile, b):
    r = list(map(tuple, b['ring']))
    e = np.array(densify(r + [r[0]], 1.5), float)
    g = tile['ground'](e[:, 0], e[:, 1])
    return g[np.isfinite(g)]


def slope_check(tile):
    """a part standing on the ground (no min height) whose walls' foot is more than 0.5 m over the drawn ground somewhere
    along its outline: one base for a footprint on a slope, or a base off the drawn ground. Drawn closed: the page
    carries such walls down, windowless, to the lowest drawn ground along the outline (tile-worker.js, the plinth),
    so this counts the plinths, not gaps on screen"""
    P, _ = _polys(tile)
    out = []
    for b, p in zip(tile['builds'], P):
        if (b['mn'] or 0) >= 0.5 or p.area < 4: continue
        g = _outline_ground(tile, b)
        if len(g) and b['base'] - g.min() > 0.5:
            gap = b['base'] - g.min()
            out.append(_rec(b, p, 'slope', gap * p.length * (b['base'] - g > 0.5).mean(), gap=round(float(gap), 2)))
    return out


def sunk_check(tile):
    """a part standing on the ground whose foot is more than 2 m under the drawn ground all the way round (its lower
    storeys buried: a base from a hollow, a yard below the street)"""
    P, _ = _polys(tile)
    out = []
    for b, p in zip(tile['builds'], P):
        if (b['mn'] or 0) >= 0.5 or p.area < 4: continue
        g = _outline_ground(tile, b)
        if len(g) and g.min() - b['base'] > 2: out.append(_rec(b, p, 'sunk', (g.min() - b['base']) * p.length, depth=round(float(g.min() - b['base']), 2)))
    return out


GAP = 3.0  # m a part may hang over what is under it and be taken down onto it (a slice's step in the massing)
LOW = 8.0  # m: a part from the LiDAR this low over nothing stands on the ground (walls it missed, a recessed ground floor)


def _support(tile, k):
    """a part up in the air (min height): points over it and, under each, the highest thing at or below its foot (the
    drawn ground, another part's roof, a bridge deck)"""
    P, tree = _polys(tile)
    b, p = tile['builds'][k], P[k]
    foot = b['base'] + b['mn']
    x0, y0, x1, y1 = p.bounds
    s = max(1.0, np.sqrt(p.area / 60))
    gx, gy = np.meshgrid(np.arange(x0 + s / 2, x1, s), np.arange(y0 + s / 2, y1, s))
    Q = np.c_[gx.ravel(), gy.ravel()]
    Q = Q[shapely.contains_xy(p, Q[:, 0], Q[:, 1])]
    if not len(Q): c = p.representative_point(); Q = np.array([[c.x, c.y]])
    sup = tile['ground'](Q[:, 0], Q[:, 1])
    sup = np.where(np.isfinite(sup), sup, -1e9)
    for q in tree.query(p, predicate='intersects'):
        o = tile['builds'][q]
        if q == k or o['base'] + (o['mn'] or 0) >= foot - 0.3: continue
        top = min(o['base'] + o['h'], foot)  # (the eaves: a roof's slope is under the part over it; one going on up holds it)
        sup = np.where(shapely.contains_xy(P[q], Q[:, 0], Q[:, 1]), np.maximum(sup, top), sup)
    if '_decks' not in tile:
        dk = [(shapely.LineString(D), float(np.max(z)) + 1.5, w) for D, z, w in tile['decks'] if len(D) >= 2]
        tile['_decks'] = dk, STRtree([d[0] for d in dk])
    dk, dt = tile['_decks']
    for q in dt.query(p, predicate='dwithin', distance=30):  # on a bridge deck
        line, zt, w = dk[q]
        near = shapely.distance(line, shapely.points(Q)) < w / 2 + 1
        sup = np.where(near, np.maximum(sup, min(zt, foot)), sup)
    return foot, sup


def air_check(tile):
    """a part with a min height that nothing holds up: no roof, deck or ground within 1 m under half of it (an
    overhang, a canopy, a skybridge are real; a missing podium, a massing slice over the roof it stands on are not)"""
    P, _ = _polys(tile)
    out = []
    for k, (b, p) in enumerate(zip(tile['builds'], P)):
        if (b['mn'] or 0) < 0.5 or p.area < 4 or b['mn'] >= max(b['h'], b.get('ridge') or 0) - 0.3: continue
        foot, sup = _support(tile, k)
        held = (sup > foot - 1).mean()
        if held < 0.5:
            out.append(_rec(b, p, 'air', p.area * (1 - held) * min(10, max(0.5, foot - np.median(sup))), mn=round(b['mn'], 1), held=round(float(held), 2)))
    return out


def air_fix(tile):
    """down onto what is under it: a part hanging up to GAP over the roofs (or ground) under half of it, and one up to
    LOW over its base whose height came from the LiDAR (not a mapped min height: a real arcade, a canopy over a plaza)"""
    P, _ = _polys(tile)
    n = 0
    for k, (b, p) in enumerate(zip(tile['builds'], P)):
        if (b['mn'] or 0) < 0.5 or p.area < 4 or b.get('lid'): continue
        foot, sup = _support(tile, k)
        if (sup > foot - 1).mean() >= 0.5: continue
        to = float(np.median(sup))  # what's under half of it
        if foot - to <= GAP or not b.get('tagmn') and b['mn'] <= LOW:
            b['mn'] = max(0.0, to - b['base']) if to > -1e8 else 0.0
            n += 1
    return n


RULES = [
    Rule('bldg-slope', slope_check),
    Rule('bldg-sunk', sunk_check),
    Rule('bldg-air', air_check, air_fix),
]


def apply_rules(tile, fix=True):
    """every rule's fix (when fix), then its check: {name: (fixed, [issues left])}"""
    n = {r.name: r.fix(tile) if fix and r.fix else 0 for r in RULES}  # (a fix can leave work for another rule's check)
    return {r.name: (n[r.name], r.check(tile)) for r in RULES}


# ---------------------------------------------------------------- over baked tiles
def baked(ij, d):
    """a 4 km cell of baked detail tiles as a rule's tile (the ground: each detail tile's drawn grid, neighbours included)"""
    from audit_elev import parse, Ground
    i, j = ij
    tiles = {}
    for a in range(-1, 5):
        for b in range(-1, 5):
            p = f'{d}/0/{4 * i + a}_{4 * j + b}.bin'
            if os.path.exists(p): tiles[(4 * i + a, 4 * j + b)] = parse(p)
    builds, decks = [], []
    for (ti, tj), (ox, oy, size, terr, lines, blds) in tiles.items():
        if not (4 * i <= ti < 4 * i + 4 and 4 * j <= tj < 4 * j + 4): continue
        builds += [dict(ring=np.asarray(B['ring'], float), base=B['base'], mn=B['bot'] - B['base'], h=B['top'] - B['base'], ridge=0) for B in blds]
        decks += [(np.asarray(L['pts'], float), L['z'], L['w']) for L in lines if L['z'] is not None and not L['tunnel']]
    return dict(builds=builds, decks=decks, ground=Ground(tiles))


def _check_baked(job):
    ij, d = job
    t = baked(ij, d)
    return [f | dict(rule=n) for n, (_, f_) in apply_rules(t, fix=False).items() for f in f_] if t['builds'] else []


def selftest():
    """a podium on a slope, a tower slice hanging 2 m over it, a LiDAR part 5 m over nothing, a mapped arcade"""
    sq = lambda x, y, w: [(x, y), (x + w, y), (x + w, y + w), (x, y + w)]
    B = [dict(ring=sq(0, 0, 40), base=10.0, mn=0, h=12, ridge=0), dict(ring=sq(10, 10, 20), base=10.0, mn=14, h=60, ridge=0),
         dict(ring=sq(100, 0, 20), base=10.0, mn=5, h=20, ridge=0), dict(ring=sq(200, 0, 20), base=10.0, mn=5, h=20, ridge=0, tagmn=True)]
    t = dict(builds=B, decks=[], ground=lambda x, y: 10.0 - 0.1 * np.asarray(x, float))  # the ground falls 1 m in 10 to the east
    r = apply_rules(t)
    assert r['bldg-air'][0] == 2 and B[1]['mn'] == 12 and B[2]['mn'] == 0 and B[3]['mn'] == 5, (r, B)
    assert [f['area'] for f in r['bldg-air'][1]] == [400] and len(r['bldg-slope'][1]) >= 2 and not r['bldg-sunk'][1], r
    print('geom_rules selftest ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['selftest']: selftest(); sys.exit()
    from multiprocessing import Pool
    from common import all_tiles, tile_args
    d = sys.argv[1] if len(sys.argv) > 1 else 'public/tiles'
    procs = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    want = tile_args(sys.argv[3:]) or all_tiles()
    with Pool(procs) as p:
        found = [f for r in p.imap_unordered(_check_baked, [(ij, d) for ij in want]) for f in r]
    found.sort(key=lambda f: -f['score'])
    json.dump(found, open(f'{d}/rules.json', 'w'), indent=0)
    print('counts', {r.name: sum(1 for f in found if f['rule'] == r.name) for r in RULES})
    for r in RULES:
        top = [f for f in found if f['rule'] == r.name][:6]
        if top: print(f'--- {r.name}')
        for f in top: print({a: v for a, v in f.items() if a not in ('rule', 'kind')})
