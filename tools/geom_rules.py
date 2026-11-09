# Geometry rules: what the map must not draw (a building hanging in the air, one sunk into the ground, ...), each a
# check over a tile and, where it can, its automatic fix. tools/tiles.py runs every rule on each 4 km cell it bakes
# (the fix, then the check: what is left) and prints the counts; over baked tiles (what the page draws):
#   uv run --with numpy,scipy,shapely,pillow,rasterio python3 tools/geom_rules.py <tiles dir> [procs] [i_j ...]
# prints the counts and the worst of each with a view hash, and writes <tiles dir>/rules.json (worst first).
# Rule(name, check, fix=None): check(tile) -> [issue dicts: kind, x, y, score, hash, ...]; fix(tile) -> how many it
# fixed, in place. A tile: dict(builds=[parts as tiles.py's buildings() makes them: ring, base, mn, h, ridge;
# tagmn for a mapped min height, lid for one stood on a tunnel's box], decks=[(points, deck heights, width)], ground=f(x, y) -> the
# drawn ground under numpy arrays of points), lines=[road pieces as tiles.py's road_pieces() makes them] when baking.
import json, os, sys
from collections import namedtuple
import numpy as np
import shapely
import shapely.ops
from shapely.geometry import Polygon
from shapely.strtree import STRtree
sys.path.insert(0, os.path.dirname(__file__))
from common import densify, KINDS, L0
KIND_I = {k: i for i, k in enumerate(KINDS)}



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


REACH = 16.0  # metres past its detail tile's edge the page has the ground under a building (TERM: tiles.py MARGIN 8 m rows)


def slope_check(tile):
    """a part standing on the ground whose outline reaches more than REACH past the detail tile that draws it (the one
    of its outline's mean point), where the page has no ground to carry its walls down to: on a slope its plinth
    stops short. (Within reach the page carries the walls of a part on a slope down to the lowest drawn ground along
    its outline, tile-worker.js buildings(): a plinth, closed.)"""
    P, _ = _polys(tile)
    out = []
    for b, p in zip(tile['builds'], P):
        if (b['mn'] or 0) >= 0.5 or p.area < 4: continue
        r = np.asarray(b['ring'], float); c = r.mean(0); o = np.floor(c / L0) * L0
        if 'cell' in tile and not (tile['cell'][0] <= c[0] < tile['cell'][0] + 4 * L0 and tile['cell'][1] <= c[1] < tile['cell'][1] + 4 * L0): continue  # (the next cell draws it)
        past = np.maximum(np.maximum(o - r, r - (o + L0)), 0).max()
        if past > REACH:
            g = _outline_ground(tile, b)
            if len(g) and b['base'] - g.min() > 0.3: rp = p.representative_point(); out.append(_rec(b, p, 'slope', past, past=round(float(past), 1), _rp=(rp.x, rp.y)))
    return out


def slope_fix(tile):
    """such a part cut along the detail tiles' edges, each piece drawn by the tile it is in (its walls on that tile's ground)"""
    P, _ = _polys(tile)
    B, add, drop = tile['builds'], [], set()
    for f in slope_check(tile):
        k = next(i for i, p in enumerate(P) if p.representative_point().x == f['_rp'][0] and p.representative_point().y == f['_rp'][1])
        p, b = P[k], B[k]
        x0, y0, x1, y1 = p.bounds
        for i in range(int(np.floor(x0 / L0)), int(np.floor(x1 / L0)) + 1):
            for j in range(int(np.floor(y0 / L0)), int(np.floor(y1 / L0)) + 1):
                g = p.intersection(shapely.box(i * L0, j * L0, (i + 1) * L0, (j + 1) * L0))
                for q in getattr(g, 'geoms', [g]):
                    if q.geom_type != 'Polygon' or q.area < 1: continue
                    c = dict(b, ring=[tuple(v) for v in q.exterior.coords[:-1]], a=q.area, units=[u for u in b.get('units') or [] if q.contains(shapely.Point(u[0], u[1]))] if b.get('units') is not None else None)
                    for f_ in ('centre', 'fd'): c.pop(f_, None)
                    add.append(c)
        drop.add(k)
    B[:] = [b for i, b in enumerate(B) if i not in drop] + add
    tile.pop('_polys', None); tile.pop('_tree', None)
    return len(drop)


SINK = 1.0  # metres a part's foot may be under the lowest drawn ground along its outline (its walls start in the ground)


def sunk_check(tile):
    """a part standing on the ground whose foot is more than SINK under the drawn ground all the way round (its lower
    storeys buried: a base from a hollow, a yard below the street)"""
    P, _ = _polys(tile)
    out = []
    for b, p in zip(tile['builds'], P):
        if (b['mn'] or 0) >= 0.5 or p.area < 4: continue
        g = _outline_ground(tile, b)
        if len(g) and g.min() - b['base'] > SINK: out.append(_rec(b, p, 'sunk', (g.min() - b['base']) * p.length, depth=round(float(g.min() - b['base']), 2)))
    return out


def sunk_fix(tile):
    """the building (all its parts) up onto the lowest drawn ground along the sunk part's outline, its roofs where they were"""
    P, _ = _polys(tile)
    n, groups = 0, {}
    for b in tile['builds']: groups.setdefault(b.get('gid', id(b)), []).append(b)
    for b, p in zip(tile['builds'], P):
        if (b['mn'] or 0) >= 0.5 or p.area < 4: continue
        g = _outline_ground(tile, b)
        if not len(g) or g.min() - b['base'] <= SINK: continue
        d, b0 = float(g.min()) - b['base'], b['base']
        for q in groups[b.get('gid', id(b))]:
            if abs(q['base'] - b0) > 1e-6: continue  # (a part already moved)
            q['base'] += d; q['h'] = max(0.5, q['h'] - d)
            if q.get('ridge'): q['ridge'] = max(q['h'], q['ridge'] - d)
            q['mn'] = max(0.0, (q['mn'] or 0) - d)
        n += 1
    return n




def _support(tile, k, Q=None):
    """a part up in the air (min height): points over it (or Q) and, under each, the highest thing at or below its foot
    (the drawn ground, another part's roof, a bridge deck)"""
    P, tree = _polys(tile)
    b, p = tile['builds'][k], P[k]
    foot = b['base'] + b['mn']
    if Q is None:
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


HELD = 0.05  # share of a part with a min height that must rest on something (a core, columns, the part below): less floats


def _attached(tile, k):
    """is the part beside another (of any building) that stands through its foot (a wing off a tower's wall, a
    skybridge between two towers): along at least 2 m of its outline"""
    P, tree = _polys(tile)
    b, p = tile['builds'][k], P[k]
    foot = b['base'] + b['mn']
    for q in tree.query(p.buffer(0.5), predicate='intersects'):
        o = tile['builds'][q]
        if q == k or o['base'] + (o['mn'] or 0) > foot + 0.3 or o['base'] + max(o['h'], o.get('ridge') or 0) < foot + 1.0: continue
        if p.boundary.intersection(P[q].buffer(0.5)).length >= 2: return True
    return False


def _posts(tile, k):
    """does a part (a core, a column, a post) stand under it up to its foot"""
    P, tree = _polys(tile)
    b = tile['builds'][k]; foot = b['base'] + b['mn']
    return any(q != k and tile['builds'][q]['base'] + (tile['builds'][q]['mn'] or 0) < foot - 0.5 and abs(tile['builds'][q]['base'] + tile['builds'][q]['h'] - foot) < 1
               and P[q].intersection(P[k]).area > 0.2 for q in tree.query(P[k], predicate='intersects'))


def _floats(tile, k):
    b = tile['builds'][k]
    if (b['mn'] or 0) < 0.5 or b['mn'] >= max(b['h'], b.get('ridge') or 0) - 0.3 or _polys(tile)[0][k].area < 4 or b.get('lid'): return None  # (lid: on a tunnel's box)
    foot, sup = _support(tile, k)
    held = (sup > foot - 1).mean()
    if held >= HELD or _posts(tile, k) or _attached(tile, k): return None
    return foot, sup, held


def air_check(tile):
    """a part with a min height that nothing holds up: under HELD of it rests on a roof, a deck or the ground (within
    1 m) and no part beside it stands through its foot. An overhang on its core, a canopy on its columns, a skybridge
    between towers hold; a missing podium, a massing slice over the roof it stands on do not"""
    P, _ = _polys(tile)
    out = []
    for k, (b, p) in enumerate(zip(tile['builds'], P)):
        f = _floats(tile, k)
        if f: foot, sup, held = f; out.append(_rec(b, p, 'air', p.area * min(10, max(0.5, foot - np.median(sup))), mn=round(b['mn'], 1), held=round(float(held), 2)))
    return out


def air_fix(tile):
    """a floating part down onto what is under it (a slice over its roof, a podium the LiDAR missed: it stands on the
    ground); a mapped one (a min height in OpenStreetMap: a canopy, a roof on posts) on posts down to what is under its
    corners. A part on a tunnel's box (lid) stands on that."""
    P, _ = _polys(tile)
    n = 0
    for k in range(len(tile['builds'])):
        b, p = tile['builds'][k], P[k]
        if b.get('lid'): continue
        f = _floats(tile, k)
        if not f: continue
        foot, sup, held = f
        if b.get('tagmn'):
            with np.errstate(all='ignore'): r = shapely.minimum_rotated_rectangle(p)
            inner = p.buffer(-0.6)  # its corners, as near as they are inside it (a round or an L-shaped part)
            pts = [tuple(shapely.ops.nearest_points(inner, shapely.Point(c))[0].coords[0]) for c in r.exterior.coords[:4]] if inner.area > 4 else [tuple(p.representative_point().coords[0])]
            _, under = _support(tile, k, np.array(pts, float))  # each post down to what is under it (a roof, the ground)
            for (x, y), g in zip(pts, under):
                post = dict(b, ring=[(x - 0.25, y - 0.25), (x + 0.25, y - 0.25), (x + 0.25, y + 0.25), (x - 0.25, y + 0.25)], mn=max(0.0, float(g) - b['base']), h=b['mn'], ridge=0, roof=0, units=[], a=0.25, tagmn=False, post=True)
                post.pop('centre', None)
                tile['builds'].append(post)
        else:
            to = float(np.median(sup))
            b['mn'] = max(0.0, to - b['base']) if to > -1e8 else 0.0
        n += 1
    tile.pop('_polys', None); tile.pop('_tree', None)
    return n


# ---------------------------------------------------------------- buildings: one building's walls not through another's
def _part(b):  # a mapped building:part (or the outline over its parts): one building with the others it stands in
    t = b.get('info', {}).get('t', {})
    return 'building:part' in t or b.get('cap')


def _clashes(tile):
    """parts of different buildings overlapping (more than 0.5 m2) at heights both stand at: [(k, q, area)]"""
    P, tree = _polys(tile)
    B, out = tile['builds'], []
    for k, p in enumerate(P):
        for q in tree.query(p, predicate='intersects'):
            if q <= k or B[q].get('gid', -1 - q) == B[k].get('gid', -2 - k) or _part(B[k]) or _part(B[q]): continue
            lo = max(B[k]['base'] + (B[k]['mn'] or 0), B[q]['base'] + (B[q]['mn'] or 0))
            hi = min(B[k]['base'] + max(B[k]['h'], B[k].get('ridge') or 0), B[q]['base'] + max(B[q]['h'], B[q].get('ridge') or 0))
            if hi - lo < 0.3: continue
            a = p.intersection(P[q]).area
            if a > 0.5: out.append((k, q, a))
    return out


def overlap_check(tile):
    P, _ = _polys(tile)
    return [_rec(tile['builds'][k], P[k].intersection(P[q]), 'overlap', a) for k, q, a in _clashes(tile)]


def overlap_fix(tile):
    """the smaller of two overlapping buildings' parts cut back to the other's wall (gone if under a quarter of it, or 4 m2, is left)"""
    n = 0
    for _ in range(8):
        todo = _clashes(tile)
        if not todo: break
        P, _ = _polys(tile)
        B, drop = tile['builds'], set()
        for k, q, a in todo:
            if k in drop or q in drop: continue
            lo_, hi_ = (k, q) if B[k]['base'] + (B[k]['mn'] or 0) <= B[q]['base'] + (B[q]['mn'] or 0) else (q, k)
            top = lambda b: b['base'] + max(b['h'], b.get('ridge') or 0)
            flat = (B[lo_].get('ridge') or 0) <= B[lo_]['h'] + 0.5  # (on a pitched roof's ridge it would hang over its slopes: bldg-air takes it back down)
            if flat and (B[hi_]['mn'] or 0) >= 0.5 and B[hi_]['base'] + B[hi_]['mn'] > B[lo_]['base'] + (B[lo_]['mn'] or 0) + 0.5 and top(B[hi_]) > top(B[lo_]) + 0.5:
                B[hi_]['mn'] = top(B[lo_]) - B[hi_]['base']  # stacked (a slice mapped from a little below the roof it stands on): on it
                n += 1; continue
            small, big = (k, q) if P[k].area <= P[q].area else (q, k)
            rest = P[small].difference(P[big].buffer(0.05, join_style='mitre'))
            rest = max(_simple(rest), key=lambda g: g.area, default=shapely.Polygon())  # (one wholly inside: opened, not a hole)
            if rest.is_empty or rest.geom_type != 'Polygon' or rest.area < max(4, 0.25 * P[small].area): drop.add(small)  # (mostly the other: a duplicate)
            else:
                b = B[small]; b['ring'] = [tuple(c) for c in rest.exterior.coords[:-1]]; b['a'] = rest.area
                for f in ('centre', 'fd'): b.pop(f, None)
                if b.get('units'): b['units'] = [u for u in b['units'] if rest.contains(shapely.Point(u[0], u[1]))]
                P[small] = rest
            n += 1
        tile['builds'][:] = [b for i, b in enumerate(B) if i not in drop]
        tile.pop('_polys', None); tile.pop('_tree', None)
    return n


# ---------------------------------------------------------------- roads through buildings
PASS = 3.5  # metres of headroom a road passing through a building gets (a building passage, a parkade's ramp in)


def _through(tile):
    """streets the traffic drives (at grade: carriageways, rail) and every deck, through a building's walls: [(part
    index, the street's strip in it, its highest drawn surface there)]"""
    P, tree = _polys(tile)
    B, out = tile['builds'], []
    for L in [*tile.get('lines', ()), *tile.get('over', ())]:  # (over: the next cells' decks reaching over this one's buildings)
        if L.get('tube') or len(L['pts']) < 2 or L.get('roof'): continue
        deck = bool(L['z'])
        if not deck and not (L.get('drive') and L['kind'] in ROADS or L['kind'] in ('rail', 'lightrail')) or L.get('crossing'): continue
        Q = np.array(densify(L['pts'], 4), float)
        ls = shapely.LineString(Q); strip = ls.buffer(L['w'] / 2 + (DECK_SIDE + (2 if L.get('band') else 0) if deck else 0), cap_style='flat')
        if deck:
            s, z = _sz(L); sq = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(Q, axis=0).T))]); h = np.interp(sq, s, z) + DECK_TOP
        else: h = tile['ground'](Q[:, 0], Q[:, 1]) + 0.02
        for k in tree.query(strip, predicate='intersects'):
            b = B[k]
            if b.get('post'): continue
            inter = P[k].intersection(strip)
            if inter.area < 1: continue
            inside = shapely.contains_xy(P[k].buffer(L['w'] / 2), Q[:, 0], Q[:, 1])
            if not inside.any(): continue
            hs = float(h[inside].max()); lo = float(h[inside].min())
            foot, top = b['base'] + (b['mn'] or 0), b['base'] + max(b['h'], b.get('ridge') or 0)
            under = lo + 0.3 if not deck else lo - DECK_TOP - (1.6 if KIND_I[L['kind']] <= KIND_I['tertiary'] else 0.9) + 0.4  # (a deck's girders under it)
            if top < under or foot > hs + PASS - 0.05: continue  # under the street (a deck over a low roof), or the street under it with headroom
            out.append((k, inter, hs))
    return out


def through_check(tile):
    P, _ = _polys(tile)
    return [_rec(tile['builds'][k], g if not g.is_empty else P[k], 'through', g.area, top=round(h, 1)) for k, g, h in _through(tile)]


def through_fix(tile):
    """a passage: the part over the street lifted to PASS over it (gone if that leaves under 1 m of it, or if there is
    no rest of the part to hang it from), the rest of the part round it as it was"""
    n = 0
    for _ in range(4):
        todo = _through(tile)
        if not todo: break
        P, _ = _polys(tile)
        B, cut, add = tile['builds'], {}, []
        for k, g, h in todo: cut.setdefault(k, []).append((g, h))
        for k, gs in cut.items():
            b, p = B[k], P[k]
            hole = shapely.union_all([g.buffer(0.3, join_style='mitre') for g, _ in gs]).intersection(p)
            hmax = max(h for _, h in gs)
            rest = [q for q in _simple(p.difference(hole)) if q.area >= 1]
            add += [_piece(b, q) for q in rest]
            mn = hmax + PASS - b['base']
            if mn < max(b['h'], b.get('ridge') or 0) - 1 and sum(q.area for q in rest) >= 4:  # (all on the street: nothing to hang it from, bldg-air takes it back down)
                for q in getattr(hole, 'geoms', [hole]):
                    if q.geom_type == 'Polygon' and q.area >= 1: add.append(dict(_piece(b, q), mn=mn, tagmn=False, roof=0 if b.get('roof') else 0))
        B[:] = [b for i, b in enumerate(B) if i not in cut] + add
        tile.pop('_polys', None); tile.pop('_tree', None)
        n += len(cut)
    return n


def _simple(g):
    """the polygons of g without holes (a part's outline has none): each hole opened to the outside by a 0.6 m slit"""
    out, todo = [], [q for q in getattr(g, 'geoms', [g]) if q.geom_type == 'Polygon']
    for _ in range(500):
        if not todo: break
        q = todo.pop()
        if not q.interiors: out.append(q); continue
        cut = shapely.shortest_line(shapely.LinearRing(q.interiors[0]), q.exterior).buffer(0.3)
        rest = [r for r in getattr(q.difference(cut), 'geoms', [q.difference(cut)]) if r.geom_type == 'Polygon' and r.area > 0.01]
        if sum(len(r.interiors) for r in rest) >= len(q.interiors): rest = [shapely.Polygon(q.exterior)]  # (a slit that cuts nothing: filled)
        todo += rest
    return out + [shapely.Polygon(q.exterior) for q in todo]


def _piece(b, q):
    """a part cut down to polygon q"""
    c = dict(b, ring=[tuple(v) for v in q.exterior.coords[:-1]], a=q.area)
    if b.get('units'): c['units'] = [u for u in b['units'] if q.contains(shapely.Point(u[0], u[1]))]
    for f in ('centre', 'fd'): c.pop(f, None)
    return c


# ---------------------------------------------------------------- trees and beach things: not in a building, a street or each other
MINW = [0.5, 0.18, 0.75, 0.6, 0.22, 0.3, 0.4, 0.35, 0.65]  # public/core/tiles.js: a crown's width over its height, by form
MAXW = [1.3, 0.42, 1.7, 1.3, 0.45, 0.6, 0.95, 0.8, 1.5]
ASPECT = [1.25, 3, 0.95, 1.2, 2.8, 2.2, 1.5, 1.8, 1.05]  # public/core/treeforms.js


def crown(t):
    """a tree's (x, y, shape, colour byte, height) crown width as the page draws it (tiles.js, before its street pruning)"""
    _, _, shape, col, h = t[:5]
    h, fm, cq = max(3.0, h), min(8, shape), col >> 4
    w = min(max(2 + cq * 1.4, h * MINW[fm]), h * MAXW[fm]) if cq else h / ASPECT[fm]
    return min(30.0, max(1.2, w))


def _tree_hits(tile):
    """trees whose trunk stands on a carriageway or in a building, or whose crown (85% of its radius: leaves are not a
    solid disc) reaches into a building standing through its height: [(index, what, depth)]"""
    T = tile.get('trees') or []
    if not T: return []
    P, tree = _polys(tile)
    B = tile['builds']
    carr = tile.get('carr')
    if carr is not None and '_carr' not in tile: tile['_carr'] = shapely.union_all(carr) if carr else shapely.Polygon(); shapely.prepare(tile['_carr'])
    xy = np.array([(t[0], t[1]) for t in T]); g = tile['ground'](xy[:, 0], xy[:, 1])
    out = []
    for i, t in enumerate(T):
        pt = shapely.Point(t[0], t[1]); r = crown(t) / 2 * 0.85
        if carr is not None and tile['_carr'].contains(pt): out.append((i, 'street', 1.0)); continue
        lo, hi = g[i] + min(2.5, 0.3 * t[4]), g[i] + t[4]
        for q in tree.query(pt.buffer(r), predicate='intersects'):
            b = B[q]
            if b['base'] + (b['mn'] or 0) > hi or b['base'] + max(b['h'], b.get('ridge') or 0) < lo: continue
            d = P[q].distance(pt)
            if d < r: out.append((i, 'building', r - d)); break
    return out


def tree_check(tile):
    T = tile.get('trees') or []
    return [dict(kind='tree', x=round(T[i][0], 1), y=round(T[i][1], 1), score=round(d, 2), hash=view_hash(T[i][0], T[i][1], 0), what=w) for i, w, d in _tree_hits(tile)]


def tree_fix(tile):
    """a tree in a building or a street stepped out of it, away from the nearest wall until its crown clears (up to 6 m,
    not onto a street or into another building), else gone"""
    T = tile.get('trees')
    hits = _tree_hits(tile)
    if not hits: return 0
    P, tree = _polys(tile)
    B, carr = tile['builds'], tile.get('_carr')
    drop = set()
    for i, w, d in hits:
        t = T[i]; r = crown(t) / 2 * 0.85 + 0.2
        x, y = t[0], t[1]
        g = float(tile['ground'](np.array([x]), np.array([y]))[0]); lo, hi = g + min(2.5, 0.3 * t[4]), g + t[4]
        ok = False
        for _ in range(4):
            pt = shapely.Point(x, y)
            near = [q for q in tree.query(pt, predicate='dwithin', distance=r) if B[q]['base'] + (B[q]['mn'] or 0) <= hi and B[q]['base'] + max(B[q]['h'], B[q].get('ridge') or 0) >= lo]
            if not near: ok = True; break
            q = min(near, key=lambda q: P[q].distance(pt))
            e = shapely.ops.nearest_points(P[q].boundary, pt)[0]
            v = np.array([x - e.x, y - e.y]); L = np.hypot(*v)
            if P[q].contains(pt) or L < 1e-6: c = P[q].centroid; v = np.array([e.x - c.x, e.y - c.y]); L = np.hypot(*v) or 1.0
            x, y = e.x + v[0] / L * (r + 0.1), e.y + v[1] / L * (r + 0.1)
        if not ok or np.hypot(x - t[0], y - t[1]) > 6 or carr is not None and not carr.is_empty and carr.distance(shapely.Point(x, y)) < 0.6: drop.add(i); continue
        T[i] = (x, y, *t[2:])
    T[:] = [t for i, t in enumerate(T) if i not in drop]
    return len(hits)


def _log_box(b):
    x, y, a, ln, d, k = b
    if k >= 18:  # a picnic table, a bin, a stand, a washroom, a fountain (tools/seawall.py amenities)
        import seawall
        return seawall.kit_box(x, y, a, k)
    if k == 16: ln, d = 2.6, 2.6  # a lifeguard tower's footprint
    elif k == 17: d = 0.3  # a volleyball net: its posts and the net between
    c, s_ = np.cos(a), np.sin(a)
    return shapely.Polygon([(x + c * u - s_ * v, y + s_ * u + c * v) for u, v in ((-ln / 2, -d / 2), (ln / 2, -d / 2), (ln / 2, d / 2), (-ln / 2, d / 2))])


LOG_CLEAR = 0.05  # metres between two beach things (the tile's 6 cm grid moves each up to 4.4 cm: tools/tiles.py beach_bits)


def _log_hits(tile):
    """beach things (logs, towers, nets) inside one another or a building: [(index, other index or -1)]"""
    L = tile.get('beach') or []
    if not L: return []
    boxes = [_log_box(b) for b in L]; t = STRtree(boxes); P, bt = _polys(tile)
    out = []
    for i, p in enumerate(boxes):
        if len(bt.query(p, predicate='intersects')): out.append((i, -1)); continue
        for q in t.query(p, predicate='intersects'):
            if q > i and p.distance(boxes[q]) < LOG_CLEAR: out.append((i, int(q)))
    return out


def log_check(tile):
    L = tile.get('beach') or []
    return [dict(kind='beach', x=round(L[i][0], 1), y=round(L[i][1], 1), score=1, hash=view_hash(L[i][0], L[i][1], 0)) for i, q in _log_hits(tile)]


def log_fix(tile):
    """of two beach things in one another the smaller goes (logs heaped through each other), one in a building goes"""
    L = tile.get('beach')
    n = 0
    for _ in range(4):
        hits = _log_hits(tile)
        if not hits: break
        drop = set()
        for i, q in hits:
            if i in drop or q in drop: continue
            drop.add(i if q < 0 or L[i][3] * L[i][4] <= L[q][3] * L[q][4] else q)
        L[:] = [b for k, b in enumerate(L) if k not in drop]
        n += len(drop)
    return n


# ---------------------------------------------------------------- decks: one height for the deck, its paint, its traffic
# A deck piece's z is the one height its drawn deck, the paint on it (drawn on the deck by its shader), the cars on it
# (the life worker's lanes) and the van (drive surface()) all take; tools/deck_check.mjs measures them on baked tiles.
# An at-grade piece going on from a deck end up in the air (OpenStreetMap's bridge tag ends before the structure does: a
# crossover between a bridge's carriageways, a ramp the approaches() search turned down) is drawn on the ground, its
# paint and cars there, from a node in the air; and pieces meeting at a node at different heights step there. The bake
# solves every structure's heights at once (tools/tiles.py deck_solve); these rules check what it left.
DECK_TOP = 0.38  # a deck's drawn road over its z (tiles.py DECK_TOP)
DECK_SIDE = 0.6  # metres: a deck's structure past its strip's edge (tools/audit_elev.py 'clash')
AIR = 1.0  # metres: a deck end this far over the ground is in the air (a step at the abutment: tools/audit_elev.py 'step')
ROADS = ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living')


def _lift_ground(tile, P):  # z of a deck whose drawn top is on the drawn ground (terrain + 0.02) at points P
    return tile['ground'](P[:, 0], P[:, 1]) + 0.02 - DECK_TOP


def _air(tile):
    """the at-grade pieces with an end at a deck's end up in the air: [(piece, height at a or None, at b or None)]"""
    top = {}
    for L in [*tile.get('lines', ()), *tile.get('next', ())]:  # (next: the next cells' pieces meeting this cell's at its seams)
        if L['z'] and not L.get('tube'):
            for n, h in ((L['a'], L['z'][0]), (L['b'], L['z'][-1])): top[n] = max(top.get(n, -1e9), h)
    out = []
    for L in tile.get('lines', ()):
        if L['z'] or len(L['pts']) < 2: continue
        g = _lift_ground(tile, np.array([L['pts'][0], L['pts'][-1]], float))
        ha, hb = (h if h is not None and h - gg > AIR else None for h, gg in ((top.get(L['a']), g[0]), (top.get(L['b']), g[1])))
        if ha is not None or hb is not None: out.append((L, ha, hb))
    return out


def _low(tile):
    """deck ends more than AIR under the ground where a street goes on from them at grade (the LiDAR's deck dropping
    off at an abutment): [(deck piece, end index, the ground's height for its drawn top)]"""
    at = {}
    for L in [*tile.get('lines', ()), *tile.get('next', ())]:
        if not L['z'] and len(L['pts']) > 1 and not L.get('tube'): at[L['a']] = at[L['b']] = True
    out = []
    for L in tile.get('lines', ()):
        if not L['z'] or L.get('tube') or len(L['pts']) < 2: continue
        for e, nd in ((0, L['a']), (-1, L['b'])):
            if nd not in at: continue
            g = float(_lift_ground(tile, np.array([L['pts'][e]], float))[0])
            if g - L['z'][e] > AIR: out.append((L, e, g))
    return out


def deck_air_check(tile):
    out = [dict(kind='deck-low', x=round(L['pts'][e][0], 1), y=round(L['pts'][e][1], 1), score=round(g - L['z'][e], 1), hash=view_hash(*L['pts'][e], g), piece=f"{L['kind']} {L['a']}-{L['b']}") for L, e, g in _low(tile)]
    for L, ha, hb in _air(tile):
        (x, y), h = (L['pts'][0], ha) if ha is not None else (L['pts'][-1], hb)
        g = float(_lift_ground(tile, np.array([[x, y]], float))[0])
        out.append(dict(kind='deck-air', x=round(x, 1), y=round(y, 1), score=round(h - g, 1), hash=view_hash(x, y, h), piece=f"{L['kind']} {L['a']}-{L['b']}"))
    return out


def _joints(tile, tol=0.15):
    """-> {node: (target height, [(piece, end index)])} where the raised pieces ending there disagree by more than tol"""
    at = {}
    for L in tile.get('lines', ()):
        if L['z'] and not L.get('tube') and len(L['pts']) > 1:
            for e, n in ((0, L['a']), (-1, L['b'])): at.setdefault(n, []).append((L, e))
    out = {}
    for n, ends in at.items():
        hs = [L['z'][e] for L, e in ends]
        if len(hs) < 2 or max(hs) - min(hs) <= tol: continue
        lidar = [L['z'][e] for L, e in ends if L.get('src', 'deck') == 'deck']  # the LiDAR decks' heights hold, the rest meet them
        out[n] = (float(np.mean(lidar)) if lidar else float(np.mean(hs)), ends)  # (the mean, as deck-stack meets them)
    return out


def deck_joint_check(tile):
    out = []
    for n, (h, ends) in _joints(tile).items():
        L, e = ends[0]
        (x, y), d = L['pts'][e], max(M['z'][f] for M, f in ends) - min(M['z'][f] for M, f in ends)
        out.append(dict(kind='deck-joint', x=round(x, 1), y=round(y, 1), score=round(d, 2), hash=view_hash(x, y, h), node=n))
    return out


# ---------------------------------------------------------------- over baked tiles: the old audits and what the page draws
# These rules look at the baked tiles (with their neighbours), as the page builds them; their fixes are in the bake
# (tools/tiles.py) or in the page code that draws the thing (named in each rule's fix note).
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


_CELL = {}


def _cell(ij, d, what):
    """one run of a whole-cell check (audit_elev's audit, the drawn check, the trunks) shared by the rules it feeds"""
    if (ij, d, what) not in _CELL:
        if len(_CELL) > 6: _CELL.clear()
        _CELL[(ij, d, what)] = {'elev': _elev, 'drawn': _drawn, 'trunk': _trunks, 'ground': _ground}[what](ij, d)
    return _CELL[(ij, d, what)]


def _elev(ij, d):
    import audit_elev
    audit_elev.DIR = d
    return audit_elev.audit(ij)


def _drawn(ij, d):
    import subprocess
    r = subprocess.run(['node', os.path.join(os.path.dirname(__file__), 'drawn_check.mjs'), d, '%d_%d' % ij], capture_output=True, text=True)
    if r.returncode: raise RuntimeError(r.stderr[-2000:])
    return [dict(f, score=f['v'], hash=view_hash(f['x'], f['y'], f['h'])) for f in json.loads(r.stdout)['issues']]


def _trunks(ij, d):
    from audit_trunks import on_streets
    i, j = ij
    out = []
    for a in range(4):
        for b in range(4):
            p = f'{d}/0/{4 * i + a}_{4 * j + b}.bin'
            if os.path.exists(p): out += [dict(x=round(x, 1), y=round(y, 1), score=1, hash=view_hash(x, y, 0)) for x, y in on_streets(p)]
    return out


def _ground(ij, d):
    """the drawn ground of a cell's detail tiles: one terrain along every edge two tiles share (no step: a crack the base
    map shows through), and its polygons one layer (none over another: they flicker)"""
    import struct
    from common import read_tile
    from audit_elev import parse
    i, j = ij
    out = []
    for a in range(4):
        for b in range(4):
            ti, tj = 4 * i + a, 4 * j + b
            p = f'{d}/0/{ti}_{tj}.bin'
            if not os.path.exists(p): continue
            T = parse(p)
            for (di, dj), mine, theirs in (((1, 0), lambda h: h[:, -1], lambda h: h[:, 0]), ((0, 1), lambda h: h[0, :], lambda h: h[-1, :])):
                q = f'{d}/0/{ti + di}_{tj + dj}.bin'
                if not os.path.exists(q): continue
                U = parse(q)
                if U[3].shape != T[3].shape: continue
                dz = np.abs(mine(T[3]) - theirs(U[3]))
                if dz.max() > 0.05:
                    k = int(np.argmax(dz)); x, y = (T[0] + L0, T[1] + L0 - k * L0 / (len(dz) - 1)) if di else (T[0] + k * L0 / (len(dz) - 1), T[1] + L0)
                    out.append(dict(kind='seam', x=round(x, 1), y=round(y, 1), score=round(float(dz.max()), 2), hash=view_hash(x, y, 0)))
            b_, ox, oy, size, sec, ring = read_tile(p)
            if 'GRND' not in sec: continue
            o = sec['GRND'][0]; runs = struct.unpack_from('<H', b_, o)[0]; o += 2
            polys = []
            for _ in range(runs):
                c, npoly = struct.unpack_from('<BI', b_, o); o += 5
                for _ in range(npoly):
                    nr = struct.unpack_from('<H', b_, o)[0]; o += 2
                    rings = []
                    for _ in range(nr): r, o = ring(o); rings.append(r)
                    # (less the 6 cm the tile's points are rounded to, which the page welds shut: tile-worker.js weld())
                    if len(rings[0]) >= 3: polys.append(Polygon(rings[0], [r for r in rings[1:] if len(r) >= 3]).buffer(-0.1, join_style='mitre'))
            t = STRtree(polys)
            A, B = t.query(polys, predicate='intersects')
            for u, v in zip(A, B):
                if u < v:
                    g = polys[u].intersection(polys[v])
                    if g.area > 0.1: c = g.representative_point(); out.append(dict(kind='ground-overlap', x=round(c.x, 1), y=round(c.y, 1), score=round(g.area, 1), hash=view_hash(c.x, c.y, 0)))
    return out


# ---------------------------------------------------------------- seawalls (tools/seawall.py): the walk on top, the wall
# standing on the ground. The page draws the ground on a wall's walk and the water or sand at its foot over the terrain
# (core/util.js wallHeight = seawall.height()), the stone face between (core/tile-worker.js seawalls())
SW_STEP = 0.2  # metres a walk near a seawall may rise or drop over 1 m along it more than the LiDAR ground under it does (a step)
SW_TOP = 0.1  # metres the wall's top (its coping) may sit off the walk beside it
SW_LIDAR = 1.0  # metres a walk on a seawall may be drawn off the LiDAR ground under it (floating, buried)
SW_PATHS = {KIND_I[k] for k in ('pedestrian', 'footway', 'cycleway', 'path', 'steps')}


def _seawall(ij, d):
    """a cell's detail tiles with seawalls: {(ti, tj): (parsed tile, pieces)}, and the drawn ground at points (each
    point on its own tile's terrain and seawalls, as the page draws it) -> f(x, y, low)"""
    from audit_elev import parse, walled
    i, j = ij
    tiles = {}
    for a in range(-1, 5):
        for b in range(-1, 5):
            p = f'{d}/0/{4 * i + a}_{4 * j + b}.bin'
            if os.path.exists(p): tiles[(4 * i + a, 4 * j + b)] = parse(p)
    walls, drawn = walled(tiles, d)
    own = {k: v for k, v in walls.items() if 4 * i <= k[0] < 4 * i + 4 and 4 * j <= k[1] < 4 * j + 4 and v}
    return tiles, own, drawn


def _wall_frames(P):
    t = np.gradient(P, axis=0); t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
    return np.stack([-t[:, 1], t[:, 0]], 1)  # the walk's side


def seawall_walk_check(ij, d):
    """the paths near a seawall (on its walk, blending off it) have no step: none rises or drops more than SW_STEP over
    a metre along it as drawn beyond what the LiDAR ground under it does, so a walker walks it end to end (where the
    wall changes the ground: the terrain's own slopes past its ends are the terrain's)"""
    import seawall
    from shapely.geometry import LineString, Point
    tiles, own, drawn = _seawall(ij, d)
    out = []
    for key, pieces in own.items():
        near = shapely.unary_union([LineString(P).buffer(float(reach.max()) + seawall.B_IN) for P, top, reach, *_ in pieces])
        for L in tiles[key][4]:
            if L['kind'] not in SW_PATHS or L['z'] is not None or len(L['pts']) < 2: continue
            Q = np.array(densify([tuple(p) for p in L['pts']], 1.0), float)
            Q = Q[shapely.contains_xy(near, Q[:, 0], Q[:, 1])]
            if len(Q) < 2: continue
            h = drawn(Q[:, 0], Q[:, 1]); mine = np.abs(h - drawn.terrain(Q[:, 0], Q[:, 1])) > 0.05
            from common import hr_lookup
            lid = hr_lookup(Q[:, 0], Q[:, 1], 1); lid = np.where(np.isfinite(lid), lid, h)
            s = np.hypot(*np.diff(Q, axis=0).T); dh = (np.abs(np.diff(h)) - np.abs(np.diff(lid))) / np.maximum(s, 0.5)
            ok = (s < 1.5) & (mine[1:] | mine[:-1])  # (consecutive samples of the walk, not the two sides of a gap where it leaves the wall)
            if ok.any() and dh[ok].max() > SW_STEP:
                k = int(np.argmax(np.where(ok, dh, 0)))
                out.append(dict(kind='seawall-walk', x=round(Q[k, 0], 1), y=round(Q[k, 1], 1), score=round(float(dh[k]), 2), hash=view_hash(Q[k, 0], Q[k, 1], h[k])))
    return out


def seawall_wall_check(ij, d):
    """a seawall stands on the ground: its top (the coping) on the walk beside it, not over it or under it, and the walk
    on the LiDAR ground (within SW_LIDAR, a few metres in from the edge): the wall neither floats nor is buried"""
    from common import hr_lookup
    tiles, own, drawn = _seawall(ij, d)
    out = []
    for key, pieces in own.items():
        ox, oy = tiles[key][0], tiles[key][1]
        for P, top, reach, rail, foot, F, _ in pieces:
            m = (P[:, 0] >= ox) & (P[:, 0] < ox + L0) & (P[:, 1] >= oy) & (P[:, 1] < oy + L0) & (F > 0.5)  # (where the wall stands: not its ends, where it blends into the ground)
            if not m.any(): continue
            n = _wall_frames(P)[m]; P_ = P[m]
            edge = drawn(P_[:, 0], P_[:, 1], False); walk = drawn(P_[:, 0] + n[:, 0], P_[:, 1] + n[:, 1])
            k = int(np.argmax(np.abs(edge - walk)))
            if abs(edge[k] - walk[k]) > SW_TOP:
                out.append(dict(kind='seawall-top', x=round(P_[k, 0], 1), y=round(P_[k, 1], 1), score=round(float(abs(edge[k] - walk[k])), 2), hash=view_hash(P_[k, 0], P_[k, 1], walk[k])))
            o = np.minimum(reach[m], 4.0)[:, None] * n
            Q = P_ + o; lid = hr_lookup(Q[:, 0], Q[:, 1], 1); dz = np.where(np.isfinite(lid), drawn(Q[:, 0], Q[:, 1]) - lid, 0)
            k = int(np.argmax(np.abs(dz)))
            if abs(dz[k]) > SW_LIDAR:
                out.append(dict(kind='seawall-lidar', x=round(Q[k, 0], 1), y=round(Q[k, 1], 1), score=round(float(abs(dz[k])), 2), hash=view_hash(Q[k, 0], Q[k, 1], lid[k])))
    return out


def seawall_path_check(ij, d):
    """the paths on a seawall's walk (within its reach) on the LiDAR ground under them (within SW_LIDAR): the walk's top
    is the ground the walkers and the paths stand on, not a shelf over it"""
    from common import hr_lookup
    from shapely.geometry import LineString
    tiles, own, drawn = _seawall(ij, d)
    out = []
    for key, pieces in own.items():
        # (the walk: from the line in to its reach, point by point)
        zone = shapely.unary_union([shapely.Polygon(np.r_[P[k:k + 2], (P + _wall_frames(P) * reach[:, None])[k:k + 2][::-1]]).buffer(0)
                                    for P, top, reach, *_ in pieces for k in range(len(P) - 1)])
        for L in tiles[key][4]:
            if L['kind'] not in SW_PATHS or L['z'] is not None or len(L['pts']) < 2: continue
            Q = np.array(densify([tuple(p) for p in L['pts']], 2.0), float)
            Q = Q[shapely.contains_xy(zone, Q[:, 0], Q[:, 1])]
            if not len(Q): continue
            lid = hr_lookup(Q[:, 0], Q[:, 1], 1); dz = np.where(np.isfinite(lid), drawn(Q[:, 0], Q[:, 1]) - lid, 0)
            k = int(np.argmax(np.abs(dz)))
            if abs(dz[k]) > SW_LIDAR:
                out.append(dict(kind='seawall-path', x=round(Q[k, 0], 1), y=round(Q[k, 1], 1), score=round(float(abs(dz[k])), 2), hash=view_hash(Q[k, 0], Q[k, 1], lid[k])))
    return out


def seawall_selftest():
    """a wall along a straight shore: the walk's height on top to the edge, the sea at the foot, no step along the walk"""
    import seawall
    P = np.c_[np.arange(0, 201, 2.0), np.zeros(101)]
    R = [(P, np.full(101, 4.0), np.full(101, 8.0), np.zeros(101, bool), np.zeros(101))]
    x = np.arange(0, 201, 1.0)
    for y in (1.0, 5.0, 12.0):  # along the walk, past it, and over the blend: no step anywhere
        h = seawall.height(R, np.full(len(x), 2.0), x, np.full(len(x), y))
        assert np.abs(np.diff(h)).max() <= SW_STEP + 1e-9, y
    edge = seawall.height(R, [2.0], [100.0], [0.0], [False])[0]; walk = seawall.height(R, [2.0], [100.0], [1.0])[0]
    assert abs(edge - walk) <= SW_TOP and seawall.height(R, [1.0], [100.0], [-1.0], [True])[0] == 0.0
    print('seawall rules selftest ok')


ELEV = {'road-grade': 'grade', 'road-untagged': 'untagged', 'road-under': 'under', 'deck-clash': 'clash', 'deck-step': 'step',
        'deck-buried': 'buried', 'tunnel': 'tunnel'}  # ('steep' is the tile rule deck-steep)
elev_rule = lambda kind: lambda ij, d: [f for f in _cell(ij, d, 'elev') if f['kind'] == kind]
drawn_rule = lambda kind: lambda ij, d: [f for f in _cell(ij, d, 'drawn') if f['rule'] == kind]

# what tools/drawn_check.mjs measures on what the page draws -> where it is fixed
DRAWN = {'paint-ground': 'core/tile-worker.js roads()', 'paint-deck': 'core/tile-worker.js roads()', 'deck-gap': 'core/tile-worker.js roads()',
         'deck-overlap': 'tools/tiles.py', 'lane-surface': 'plugins/life/worker.js', 'crosswalk': 'core/tile-worker.js crosswalks()',
         'pole': 'core/tile-worker.js lights()', 'ground-crack': 'core/tile-worker.js ground() (T-junctions); tools/tiles.py (ground polygons sharing borders)',
         'object': 'core/tile-worker.js solids() (poles, parked cars); tools/tiles.py (beach logs)', 'deck-zfight': 'core/tile-worker.js unstack()'}

# Rule(name, check, fix, on): on 'tile' the check and fix run on the bake's tile (tools/tiles.py, every cell it bakes:
# fix, then check), their counts kept in OUT/manifest.json; on 'baked' the check runs over the baked tiles (check(ij,
# tiles dir)) and fix names where the bake or the page fixes it. An issue with 'allowed' (its reason) is not a defect.
Rule = namedtuple('Rule', 'name check fix on', defaults=(None, 'tile'))
DRAWN_DECK = ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living', 'pedestrian', 'footway', 'cycleway',
              'path', 'steps', 'track', 'rail', 'lightrail')  # the deck kinds the page draws a strip for (tile-worker.js roads())
CLEAR = 3.0  # metres: decks drawn over one another closer than this (and further apart than 0.15 m) are one surface stepping


def _top(L): return 0.36 + (18 - KIND_I[L['kind']]) * 0.004  # a deck strip over its z (tile-worker.js roads())


def _stack(tile, tol=0.15):
    """drivable deck lanes (every 4 m, at the middle and 35% out either side) under or over another deck strip by
    tol .. CLEAR: [(piece, s along it, other piece, s along that, drawn top here - drawn top there, x, y)]"""
    D = [L for L in tile.get('lines', ()) if L['z'] and not L.get('tube') and L['kind'] in DRAWN_DECK and len(L['pts']) > 1]
    if len(D) < 2: return []
    geo = [shapely.LineString(L['pts']) for L in D]
    tree = STRtree([g.buffer(L['w'] / 2, cap_style='flat') for g, L in zip(geo, D)])
    out = []
    for a, A in enumerate(D):
        if not (A.get('drive') and A['kind'] in ROADS): continue
        P = np.array(A['pts'], float); s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
        ss = np.arange(2.0, s[-1], 4.0)
        if not len(ss): continue
        X, Y = np.interp(ss, s, P[:, 0]), np.interp(ss, s, P[:, 1]); za = np.interp(ss, s, A['z']) + _top(A)
        t = np.gradient(np.c_[X, Y], axis=0) if len(ss) > 1 else np.array([[P[-1, 0] - P[0, 0], P[-1, 1] - P[0, 1]]])
        t /= np.maximum(np.hypot(*t.T), 1e-6)[:, None]
        for o in (-0.35, 0.0, 0.35):
            qx, qy = X - t[:, 1] * o * A['w'], Y + t[:, 0] * o * A['w']
            pts = shapely.points(qx, qy)
            for b in tree.query(shapely.MultiPoint(np.c_[qx, qy]), predicate='intersects'):
                if b == a: continue
                B = D[b]; inside = shapely.dwithin(geo[b], pts, B['w'] / 2)
                if not inside.any(): continue
                PB = np.array(B['pts'], float); sB = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(PB, axis=0).T))])
                pr = shapely.line_locate_point(geo[b], pts)
                dz = za - (np.interp(pr, sB, B['z']) + _top(B))
                for k in np.nonzero(inside & (np.abs(dz) > tol) & (np.abs(dz) < CLEAR))[0]: out.append((A, ss[k], B, pr[k], float(dz[k]), qx[k], qy[k]))
    return out


FOOTWAYS = ('footway', 'path', 'cycleway', 'pedestrian', 'track')


def _limit(L):  # the steepest a deck may climb (tools/audit_elev.py 'steep'): stairs any, paths 25%, the rest 12%
    return 9.0 if L['kind'] == 'steps' else 0.25 if L['kind'] in FOOTWAYS else 0.12


def _steep(tile):
    out = []
    for L in tile.get('lines', ()):
        if not L['z'] or L.get('tube') or len(L['pts']) < 2: continue
        s, z = _sz(L); ds = np.diff(s); g = np.abs(np.diff(z)) / np.maximum(ds, 1e-6)
        bad = (g > _limit(L) + 0.005) & (ds >= 2)
        if bad.any(): k = int(np.argmax(np.where(bad, g, 0))); out.append((L, k, float(g[k])))
    return out


def deck_steep_check(tile):
    return [dict(kind='deck-steep', x=round(L['pts'][k][0], 1), y=round(L['pts'][k][1], 1), score=round(g * 100, 1), hash=view_hash(*L['pts'][k], L['z'][k]), piece=f"{L['kind']} {L['a']}-{L['b']}")
            for L, k, g in _steep(tile)]


def deck_stack_check(tile):
    return [dict(kind='deck-stack', x=round(x, 1), y=round(y, 1), score=round(abs(dz), 2), hash=view_hash(x, y, float(np.interp(s, *_sz(A)))), piece=f"{A['a']}-{A['b']}/{B['a']}-{B['b']}")
            for A, s, B, sb, dz, x, y in _stack(tile)]


def _sz(L):
    P = np.array(L['pts'], float); return np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))]), L['z']


RULES = [
    # the decks' heights are one solve over the whole map in the bake (tools/tiles.py deck_solve): these only check it
    Rule('deck-air', deck_air_check),
    Rule('deck-stack', deck_stack_check),
    Rule('deck-joint', deck_joint_check),
    Rule('deck-steep', deck_steep_check),
    Rule('bldg-overlap', overlap_check, overlap_fix),  # (before the others: what is left of a part stands on its own)
    Rule('bldg-slope', slope_check, slope_fix),
    Rule('bldg-sunk', sunk_check, sunk_fix),
    Rule('bldg-road', through_check, through_fix),  # (after the parts are where they stand)
    Rule('bldg-air', air_check, air_fix),
    Rule('tree', tree_check, tree_fix),  # (after the buildings: where they end up)
    Rule('beach', log_check, log_fix),
    *[Rule(n, elev_rule(k), 'tools/tiles.py', 'baked') for n, k in ELEV.items()],  # tools/audit_elev.py
    Rule('trunk', lambda ij, d: _cell(ij, d, 'trunk'), 'tools/tiles.py off_streets', 'baked'),  # tools/audit_trunks.py
    Rule('ground-seam', lambda ij, d: [f for f in _cell(ij, d, 'ground') if f['kind'] == 'seam'], 'tools/tiles.py margins()', 'baked'),
    Rule('ground-overlap', lambda ij, d: [f for f in _cell(ij, d, 'ground') if f['kind'] == 'ground-overlap'], 'tools/tiles.py', 'baked'),
    *[Rule(n, drawn_rule(n), f, 'baked') for n, f in DRAWN.items()],  # tools/drawn_check.mjs
    Rule('seawall-walk', seawall_walk_check, 'tools/seawall.py (smooth_top, B_IN, B_END)', 'baked'),
    Rule('seawall-wall', seawall_wall_check, 'tools/seawall.py; core/util.js wallHeight', 'baked'),
    Rule('seawall-path', seawall_path_check, 'tools/seawall.py detect()', 'baked'),
]


def apply_rules(tile, fix=True):
    """every tile rule's fix (when fix), then its check: {name: (fixed, [issues left])}"""
    rules = [r for r in RULES if r.on == 'tile']
    n = {r.name: 0 for r in rules}
    for _ in range(2 if fix else 0):  # twice: a fix can leave work for a rule before it (a building raised onto a street)
        for r in rules: n[r.name] += r.fix(tile) if r.fix else 0
    return {r.name: (n[r.name], r.check(tile)) for r in rules}


def summary(left, top=5):
    """a cell's issues of one rule as the manifest keeps them: defects, allowed, the worst defects"""
    bad = sorted((f for f in left if not f.get('allowed')), key=lambda f: -f['score'])
    return dict(left=len(bad), allowed=len(left) - len(bad), top=[{k: v for k, v in f.items() if k in ('x', 'y', 'score', 'hash')} for f in bad[:top]])


def _check_baked(job):
    ij, d, names = job
    return [dict(f, rule=r.name, cell='%d_%d' % ij) for r in RULES if r.on == 'baked' and r.name in names for f in r.check(ij, d)]


def selftest():
    """a podium on a slope, a tower slice hanging 2 m over it, a LiDAR part 5 m over nothing, a mapped arcade"""
    sq = lambda x, y, w: [(x, y), (x + w, y), (x + w, y + w), (x, y + w)]
    B = [dict(ring=sq(0, 0, 40), base=10.0, mn=0, h=12, ridge=0), dict(ring=sq(10, 10, 20), base=10.0, mn=14, h=60, ridge=0),
         dict(ring=sq(100, 0, 20), base=10.0, mn=5, h=20, ridge=0), dict(ring=sq(200, 0, 20), base=10.0, mn=5, h=20, ridge=0, tagmn=True)]
    t = dict(builds=B, decks=[], ground=lambda x, y: 10.0 - 0.1 * np.asarray(x, float))  # the ground falls 1 m in 10 to the east
    r = apply_rules(t)
    assert r['bldg-air'][0] == 3 and B[1]['mn'] == 12 and B[2]['mn'] == 0 and B[3]['mn'] == 5, (r, B)
    assert sum(1 for b in B if b.get('post')) == 4 and not r['bldg-air'][1] and not r['bldg-slope'][1] and not r['bldg-sunk'][1], r
    t = dict(builds=[dict(ring=sq(0, 0, 10), base=2.0, mn=0, h=9, ridge=0, gid=1), dict(ring=sq(2, 2, 4), base=2.0, mn=6, h=12, ridge=0, gid=1)],
             decks=[], ground=lambda x, y: np.full(len(np.atleast_1d(x)), 6.0))  # sunk 4 m, the tower on it moves with it
    r = apply_rules(t)
    assert r['bldg-sunk'][0] == 1 and not r['bldg-sunk'][1] and t['builds'][0]['base'] == 6 and t['builds'][0]['h'] == 5 and t['builds'][1]['mn'] == 2, t['builds']
    t = dict(builds=[dict(ring=sq(0, 0, 10), base=0.0, mn=0, h=9, ridge=0)], decks=[], ground=lambda x, y: np.zeros(len(np.atleast_1d(x))),
             trees=[(5.0, 5.0, 0, 0, 8.0), (12.0, 5.0, 0, 0, 8.0)], beach=[(50, 0, 0, 6, 0.5, 0), (51, 0, 0.3, 4, 0.4, 0), (60, 0, 0, 4, 0.4, 0)], carr=[])
    r = apply_rules(t)  # a tree deep in the building gone, one whose crown reaches into it stepped out; two logs through each other
    assert not r['tree'][1] and len(t['trees']) == 1 and all(Polygon(sq(0, 0, 10)).distance(shapely.Point(tr[0], tr[1])) >= crown(tr) / 2 * 0.85 for tr in t['trees']), t['trees']
    assert not r['beach'][1] and len(t['beach']) == 2, t['beach']
    flat = lambda x, y: np.zeros(len(np.atleast_1d(x)))
    t = dict(builds=[dict(ring=sq(0, 0, 20), base=0.0, mn=0, h=10, ridge=0, gid=1)], decks=[], ground=flat,
             lines=[dict(kind='service', pts=[(-10, 10), (30, 10)], z=None, a=1, b=2, w=5, drive=True)])
    r = apply_rules(t)  # a lane into a building and out the other side: a passage
    assert r['bldg-road'][0] == 1 and not r['bldg-road'][1] and len(t['builds']) == 3 and sorted(round(b['mn'], 2) for b in t['builds']) == [0, 0, 3.52], t['builds']
    assert not r['bldg-air'][1], r['bldg-air']
    t = dict(builds=[dict(ring=sq(0, 0, 10), base=0.0, mn=0, h=5, ridge=8, gid=1), dict(ring=sq(0, 0, 10), base=0.0, mn=0, h=5, ridge=0, gid=2),
                     dict(ring=sq(5, 0, 20), base=0.0, mn=5, h=9, ridge=0, gid=2), dict(ring=sq(40, 0, 10), base=0.0, mn=0, h=6, ridge=0, gid=3)], decks=[], ground=flat,
             lines=[dict(kind='service', pts=[(30, 5), (60, 5)], z=None, a=1, b=2, w=12, drive=True)])
    r = apply_rules(t)  # a slice over the next house's pitched roof (not stood on its ridge: cut back); a hut wholly on a street (not lifted: gone)
    assert not r['bldg-overlap'][1] and not r['bldg-road'][1] and not r['bldg-air'][1] and max(b['ring'][0][0] for b in t['builds']) < 40, t['builds']
    deck_selftest()
    seawall_selftest()
    print('geom_rules selftest ok')


def deck_selftest():
    """the deck checks: a deck ending 12 m up with a street going on from it, two decks meeting 1 m apart, a 20% deck"""
    flat = lambda x, y: np.full(len(np.atleast_1d(x)), 3.0)
    deck = dict(kind='primary', pts=[(0, 0), (100, 0)], z=[3.0, 12.0], a=1, b=2, w=10)
    on = dict(kind='primary', pts=[(100, 0), (300, 0)], z=None, a=2, b=3, w=10)
    d2 = dict(kind='motorway', pts=[(0, 50), (100, 50)], z=[30.0, 30.0], a=4, b=5, w=10)
    d3 = dict(kind='motorway', pts=[(100, 50), (200, 50)], z=[31.0, 31.0], a=5, b=7, w=10)
    d4 = dict(kind='service', pts=[(0, 200), (50, 200)], z=[3.0, 13.0], a=10, b=11, w=5)
    r = apply_rules(dict(builds=[], decks=[], lines=[deck, on, d2, d3, d4], ground=flat), fix=False)
    assert [len(r[k][1]) for k in ('deck-air', 'deck-joint', 'deck-steep')] == [1, 1, 1], r


if __name__ == '__main__':
    # <tiles dir> [procs] [i_j ...] [--gate] [--only=rule,..]: the baked rules over the tiles, the tile rules from the
    # bake's manifest; writes <tiles dir>/rules.json; --gate exits 1 when any rule has a defect left
    if sys.argv[1:] == ['selftest']: selftest(); sys.exit()
    from multiprocessing import Pool
    from common import all_tiles, tile_args, manifest
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    only = next((a.split('=', 1)[1].split(',') for a in sys.argv if a.startswith('--only=')), [r.name for r in RULES])
    d = args[0] if args else 'public/tiles'
    procs = int(args[1]) if len(args) > 1 else 8
    want = tile_args(args[2:]) or all_tiles()
    want = [ij for ij in want if any(os.path.exists(f'{d}/0/{4 * ij[0] + a}_{4 * ij[1] + b}.bin') for a in range(4) for b in range(4))]
    with Pool(procs) as p:
        found = [f for r in p.imap_unordered(_check_baked, [(ij, d, only) for ij in want]) for f in r]
    counts = {r.name: [0, 0] for r in RULES if r.name in only}
    top = {}
    for f in found: counts[f['rule']][1 if f.get('allowed') else 0] += 1
    for f in sorted(found, key=lambda f: -f['score']):
        if not f.get('allowed') and len(top.setdefault(f['rule'], [])) < 5: top[f['rule']].append(f)
    man = manifest(d).get('issues', {})
    for ij in want:
        for name, s in man.get('%d_%d' % ij, {}).items():
            if name not in counts or not isinstance(s, dict): continue
            counts[name][0] += s['left']; counts[name][1] += s['allowed']
            top.setdefault(name, []).extend(dict(f, rule=name, cell='%d_%d' % ij) for f in s['top'])
    for k in top: top[k] = sorted(top[k], key=lambda f: -f['score'])[:5]
    found.sort(key=lambda f: -f['score'])
    json.dump(dict(counts=counts, issues=found), open(f'{d}/rules.json', 'w'), indent=0, default=float)
    print(f"{'rule':14} {'defects':>8}")
    bad = []
    for name, (n, _) in counts.items():
        print(f'{name:14} {n:8}')
        if n: bad.append(name)
    for name in bad:
        print(f'--- {name}: the worst:')
        for f in top.get(name, []): print('   ', {k: v for k, v in f.items() if k in ('cell', 'x', 'y', 'score', 'hash', 'what', 'kind')})
    if '--gate' in sys.argv and bad: print('GATE: geometry defects left:', ', '.join(bad)); sys.exit(1)
