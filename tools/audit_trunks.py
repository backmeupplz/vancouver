# Audit of tree trunks in baked tiles against the street surfaces the page draws (the ground partition): trunks on a
# carriageway or cycle track, and trunks in a sidewalk's walking zone (more than 1.2 m from the kerb, where tree pits
# are). Crowns may overhang a street; trunks may not (tools/tiles.py off_streets).
# Run: uv run --with numpy,shapely python3 tools/audit_trunks.py <tiles dir> [i_j ...]   (4096 m tiles; default all)
import os, struct, sys
import numpy as np
import shapely
from shapely.geometry import Polygon
from shapely.ops import unary_union
sys.path.insert(0, os.path.dirname(__file__))
from common import GI, read_tile, tile_args

CARR = {GI['road'], GI['arterial'], GI['cycle']}


def parse(path):
    """a baked tile -> (carriageway polygons, sidewalk polygons, trunks [x, north])"""
    b, ox, oy, size, sec, ring = read_tile(path)
    k = 2 * size / 32766
    carr, walk = [], []
    if 'GRND' in sec:
        o = sec['GRND'][0]; runs = struct.unpack_from('<H', b, o)[0]; o += 2
        for _ in range(runs):
            c, npoly = struct.unpack_from('<BI', b, o); o += 5
            for _ in range(npoly):
                nr = struct.unpack_from('<H', b, o)[0]; o += 2
                rings = []
                for _ in range(nr): r, o = ring(o); rings.append(r)
                if c in CARR or c == GI['sidewalk']:
                    (carr if c in CARR else walk).append(Polygon(rings[0], [r for r in rings[1:] if len(r) >= 3]).buffer(0))
    trees = np.zeros((0, 2))
    if 'TREE' in sec:
        o = sec['TREE'][0]; n = struct.unpack_from('<I', b, o)[0]
        t = np.frombuffer(b, np.dtype([('x', '<i2'), ('y', '<i2'), ('s', 'u1'), ('c', 'u1'), ('h', 'u1')]), n, o + 4)
        trees = np.stack([t['x'] * k + ox, t['y'] * k + oy], 1)
    return carr, walk, trees


def on_streets(path):
    """the trunks on a carriageway or cycle track: [(x, north)] (tools/geom_rules.py rule 'trunk')"""
    carr, _, trees = parse(path)
    if not len(trees) or not carr: return []
    C = unary_union(carr)
    shapely.prepare(C)
    return [tuple(p) for p in trees[shapely.contains_xy(C, trees[:, 0], trees[:, 1])]]


def count(path):
    carr, walk, trees = parse(path)
    if not len(trees): return 0, 0, 0
    C = unary_union(carr) if carr else Polygon()
    W = unary_union(walk).difference(C.buffer(1.2)) if walk else Polygon()
    shapely.prepare(C); shapely.prepare(W)
    return len(trees), int(shapely.contains_xy(C, trees[:, 0], trees[:, 1]).sum()), int(shapely.contains_xy(W, trees[:, 0], trees[:, 1]).sum())


if __name__ == '__main__':
    d = sys.argv[1]
    want = tile_args(sys.argv[2:])
    files = [f'{d}/0/{4 * i + a}_{4 * j + b}.bin' for i, j in want for a in range(4) for b in range(4)] if want else \
        [f'{d}/0/{f}' for f in os.listdir(f'{d}/0') if f.endswith('.bin')]
    tot = np.zeros(3, int)
    for f in files:
        if os.path.exists(f): tot += count(f)
    print(f'trees {tot[0]}, trunks on a carriageway or cycle track {tot[1]}, in a sidewalk walking zone {tot[2]}')
