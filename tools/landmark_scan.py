# Landmark meshes from the City of Vancouver's 2022 LiDAR (about 30-50 points/m2, classified; Open Government Licence -
# Vancouver), for the landmarks plugin: one small binary per landmark under public/plugins/landmarks/data/ plus
# scans.json (where each stands, its footprints for the building masks, its far massing).
# Per landmark: its points (building class, plus unclassified ones for spires, masts and sculptures where asked) are
# turned in the footprint's own axes (so the main walls run along the grid and stay straight) into a 0.5 m height
# raster; that is sliced every 0.5 m up as tools/lidar_massing.py does (an overhang's outline from its wall points),
# each slice a layer of a volume whose top layer is fractional (the roof between slices), marching cubes makes it a
# closed surface and quadric decimation cuts it to a few hundred to a few thousand triangles (flat planes collapse,
# creases stay). Colours come from the palette in LOOKS below by height (walls and roofs apart; the LiDAR's own point
# colours clip white in the sun and go navy in the shade, even on roofs); walls carry the facade pattern for materials.js.
# Far off the plugin draws the footprint massing (data/massing22.npz) instead and loads the mesh when the camera nears.
# Points: the City of Vancouver 2022 tiles (data/lidar2022: las/, else one zip at a time), outside the City the best
# open set's few tiles round each landmark (data/lidar_lm/urls.json), fetched, read and deleted.
# Run: uv run --with numpy,scipy,shapely,pyproj,rasterio,scikit-image,fast-simplification,laspy[lazrs] python3 tools/landmark_scan.py [ids]
#      ... tools/landmark_scan.py check          (self-test on a synthetic tower with a dome)
import glob, json, math, os, re, struct, subprocess, sys, time
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import xy, latlon, L1, load_feat

LAS = 'data/lidar2022/las'
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'plugins', 'landmarks', 'data')
RES, DZ = 0.5, 0.5   # m: raster cell, slice step
REACH = 2.0          # m past its outline a landmark owns the points nearer to it than to another building
BELOW = 2.0          # m the mesh goes on under the ground (the map's ground is a smoothed DEM)
Q = 0.02             # m: position quantum in the binary

# Landmarks: `at` = points (lat, lon) inside the buildings that make it (the OSM building there, not its parts) or
# `ids` (OSM ways; `near` (lat, lon) where they are, if not downtown); `box` = (lat, lon, half size m) for something that isn't a mapped building (a sculpture). Optional:
# tris (target triangles), wall (0xRRGGBB, or [(from height m, colour[, pattern]), ...] up the building), pattern (materials.js:
# 1 punched windows, 2 curtain wall, 3 glass balconies, 9 glass condo, 10 window bands, -1 none), storey (m),
# roof (a colour, or bands as wall), extra (other LiDAR classes, 1 unclassified), use (1 homes, 2 work).
LOOKS = {
    'suntower': dict(name='Sun Tower', ids=[299782896], wall=[(0, 0x8f7a6c), (66, 0x7cc4b0, -1)], pattern=1, storey=3.6, extra=(1,), roof=[(0, 0x8e9294), (64, 0x7cc4b0)]),
    'dominion': dict(name='Dominion Building', ids=[264975353], wall=[(0, 0xd8b277), (12, 0xb8604a), (43, 0xa4513c, -1)], pattern=1, storey=3.6, extra=(1,), roof=0xa4513c),
    'woodwards': dict(name="Woodward's W", ids=[139571559], wall=0xb4553e, pattern=3, storey=2.9, use=1),
    'hoteleurope': dict(name='Hotel Europe', ids=[363651940], wall=[(0, 0x9e9a86), (5, 0xa45a3e)], pattern=1, storey=3.4, roof=0x7c7f80),
    'waterfront': dict(name='Waterfront Station', ids=[78393326], wall=0xa5483a, pattern=1, storey=4.5, roof=0x8c8f8c),
    'artgallery': dict(name='Vancouver Art Gallery', ids=[69701736], wall=0xb9b5aa, pattern=1, storey=5.0, roof=[(0, 0xa9aaa6), (24, 0x9aa3a0)]),
    'library': dict(name='Library Square', ids=[37111640], wall=0xc8b49b, pattern=10, storey=4.0, tris=5000, roof=0xb9bbb8),
    'orpheum': dict(name='Orpheum', ids=[301875556], wall=0xc6b49a, pattern=1, storey=4.0),
    'commodore': dict(name='Commodore Ballroom', ids=[301876706], wall=0xd2c3a6, pattern=1, storey=4.0),
    'scotia': dict(name='Scotia Tower', ids=[51185380], wall=0x7a6b5a, pattern=10, storey=3.9),
    'telusgarden': dict(name='Telus Garden', ids=[301874785], wall=0xb7c6c9, pattern=2, storey=4.0, extra=(1,)),
    'parkplace': dict(name='Park Place', ids=[260069760], wall=0x5d4a43, pattern=2, storey=3.9),
    'bentall5': dict(name='Bentall 5', ids=[615645365], wall=0x7c8b95, pattern=2, storey=3.9),
    'jameson': dict(name='Jameson House', ids=[360437746], wall=0x7f9aa6, pattern=2, storey=3.2, use=1),
    'fairmontpr': dict(name='Fairmont Pacific Rim', at=[(49.28824, -123.11710)], wall=0xdfe3e2, pattern=9, storey=3.2),
    'trump': dict(name='Paradox Hotel', ids=[362187535], wall=0x6e8796, pattern=2, storey=3.2, tris=4000),
    'qube': dict(name='The Qube', ids=[311573634], wall=0x5e6d73, pattern=10, storey=3.0, use=1),
    'onewall': dict(name='One Wall Centre', ids=[91998089], wall=0x5c7a8c, pattern=2, storey=3.2, extra=(1,)),
    'electra': dict(name='The Electra', ids=[175917283], wall=0x88a7b1, pattern=10, storey=3.6, use=1),
    'sylvia': dict(name='Sylvia Hotel', ids=[316424818], wall=0x9b4e38, pattern=1, storey=3.2, use=1, roof=0x6f6a66),
    'roundhouse': dict(name='Roundhouse', ids=[1058680978], wall=0xa6553d, pattern=1, storey=4.5, roof=0x7f8584),
    'hotelvancouver': dict(name='Hotel Vancouver', ids=[139571554], wall=[(0, 0xc9c7bf), (78, 0x7cc4b0, -1)], pattern=1, storey=3.4, tris=5000, extra=(1,), roof=[(0, 0x8d8b86), (60, 0x7cc4b0)]),
    'marine': dict(name='Marine Building', ids=[125579375], wall=[(0, 0xc4a27e), (88, 0x8fbfa8, -1)], pattern=1, storey=3.6, extra=(1,), roof=[(0, 0x8f7e70), (85, 0x8fbfa8)]),
    'harbourcentre': dict(name='Harbour Centre', ids=[1371268997], wall=[(0, 0x9c4a38), (28, 0x6b5a4c), (127, 0xf2f2ee, -1), (134, 0x34495c, 2), (143, 0xf2f2ee, -1), (148, 0x5d656c, -1)], pattern=1, storey=3.8, tris=4000, extra=(1,), roof=0xd6d6d2),
    'orca': dict(name='Digital Orca', box=(49.28982, -123.11671, 9), wall=0x23262a, pattern=-1, roof=0x23262a, extra=(1,), tris=600),
}


# ---------------------------------------------------------------- footprints (data/feat, world metres)
_FEAT = {}


def buildings(i, j):
    if (i, j) not in _FEAT: _FEAT[(i, j)] = load_feat(i, j).get('buildings', [])
    return _FEAT[(i, j)]


def near_buildings(x, y, r):
    """[(osm id, outer ring, is_part)] of the buildings and parts with a point within r m of (x, y)"""
    out = []
    for i in range(int((x - r) // L1), int((x + r) // L1) + 1):
        for j in range(int((y - r) // L1), int((y + r) // L1) + 1):
            for oid, prs, t in buildings(i, j):
                part = 'building:part' in t and 'building' not in t
                for outer, _ in prs:
                    o = outer[:-1] if outer[0] == outer[-1] else outer
                    if len(o) >= 3 and any(abs(px - x) < r and abs(py - y) < r for px, py in o): out.append((oid, o, part))
    return out


def footprint(spec):
    """the landmark's outlines (world xy rings) and its OSM ids"""
    from shapely.geometry import Polygon, Point
    if 'box' in spec:
        la, lo, h = spec['box']; x, y = xy(la, lo)
        return [[(x - h, y - h), (x + h, y - h), (x + h, y + h), (x - h, y + h)]], []
    rings, ids = [], []
    for oid in spec.get('ids', []):
        ci, cj = (int(v // L1) for v in xy(*spec['near'])) if 'near' in spec else (0, 0)
        hit = [o for i in range(ci - 2, ci + 2) for j in range(cj - 2, cj + 2) for k, prs, _ in buildings(i, j) if k == oid for o, _ in prs]
        if not hit: raise SystemExit(f'{spec["name"]}: no way {oid}')
        rings.append(hit[0][:-1] if hit[0][0] == hit[0][-1] else hit[0]); ids.append(oid)
    for la, lo in spec.get('at', []):
        x, y = xy(la, lo)
        hits = [(oid, o, part) for oid, o, part in near_buildings(x, y, 400) if Polygon(o).buffer(0).contains(Point(x, y))]
        hits.sort(key=lambda h: (h[2], -Polygon(h[1]).area))  # the building, not its parts; the biggest
        if not hits: raise SystemExit(f'{spec["name"]}: no building at {la}, {lo}')
        rings.append(hits[0][1]); ids.append(hits[0][0])
    return rings, ids


# ---------------------------------------------------------------- points (straight from the LAS tiles)
def read_las(path, boxes, got):
    """the points of one City LAS tile (memory-mapped) in each of the boxes it touches, into got[key]"""
    from lidar_massing import las_header
    off, pf, rl, sc, of, mn, mx = las_header(path)
    mine = {k: b for k, b in boxes.items() if b[2] >= mn[0] and b[0] <= mx[0] and b[3] >= mn[1] and b[1] <= mx[1]}
    if not mine: return
    dt = np.dtype(dict(names=['x', 'y', 'z', 'cls'], formats=['<i4'] * 3 + ['u1'], offsets=[0, 4, 8, 16 if pf >= 6 else 15], itemsize=rl))
    p = np.memmap(path, dt, 'r', offset=off)
    X, Y = np.asarray(p['x']), np.asarray(p['y'])
    for k, (e0, n0, e1, n1) in mine.items():
        i = np.nonzero((X >= (e0 - of[0]) / sc[0]) & (X <= (e1 - of[0]) / sc[0]) & (Y >= (n0 - of[1]) / sc[1]) & (Y <= (n1 - of[1]) / sc[1]))[0]
        q = p[i]
        got[k].append((q['x'] * sc[0] + of[0], q['y'] * sc[1] + of[1], q['z'] * sc[2] + of[2], q['cls'] & 31))


def read_laz(path, boxes, got):
    """the same for any LAZ/COPC/LAS tile (laspy), in whatever CRS it is"""
    import laspy
    from pyproj import Transformer
    with laspy.open(path) as f:
        crs = f.header.parse_crs()
        to = None if crs is None or crs.to_epsg() == 3157 else Transformer.from_crs(crs, 'EPSG:3157', always_xy=True)
        for c in f.chunk_iterator(4_000_000):
            x, y = np.asarray(c.x), np.asarray(c.y)
            if to: x, y = to.transform(x, y)
            for k, (e0, n0, e1, n1) in boxes.items():
                i = np.flatnonzero((x >= e0) & (x <= e1) & (y >= n0) & (y <= n1))
                if len(i): got[k].append((x[i], y[i], np.asarray(c.z)[i], np.asarray(c.classification)[i].astype(np.uint8)))


def city_points(boxes, got, tmp):
    """the City of Vancouver 2022 tiles: unzipped ones in LAS, the rest one zip at a time (unzipped to tmp, deleted)"""
    have = set()
    for path in sorted(glob.glob(f'{LAS}/*.las')):
        read_las(path, boxes, got); have.add(os.path.basename(path)[:-4])
    for z in sorted(glob.glob(f'{os.path.dirname(LAS)}/*.zip')):
        name = os.path.basename(z)[:-4]
        if name in have: continue
        e, n = map(int, name.split('_'))
        mine = {k: b for k, b in boxes.items() if b[2] >= e and b[0] <= e + 1000 and b[3] >= n and b[1] <= n + 1000}
        if not mine: continue
        subprocess.run(['unzip', '-j', '-o', '-q', z, '*.las', '-d', tmp], check=True)
        for f in glob.glob(f'{tmp}/*.las'):
            read_las(f, mine, got); os.remove(f)


# Lower Mainland sets outside the City (data/lidar_lm/urls.json, tools/lidar_stream.py streams them all for the
# massing): the best source first, as data/lidar_lm/sources.md ranks them
RANK = ['Coquitlam 2026', 'LidarBC 2025', 'LidarBC 2024', 'MetroVan Watershed 2024', 'LidarBC 2023', 'CanElevation FHIMP_PICAI_BC_South_West_UTM10_2023', 'MetroVan 2022']
EXTENTS = 'data/lidar_lm/extents.json'


def lm_entries():
    u = json.load(open('data/lidar_lm/urls.json'))['sources']
    return [(src, dict(url=e) if isinstance(e, str) else e) for src in RANK for e in u.get(src, [])]


def curl(e, dest, head=False):
    """an entry of urls.json (a URL, or a byte range in a big zip, maybe raw-deflated) -> dest (just its header: head)"""
    rng = e.get('range')
    if rng:
        a, b = map(int, rng.split('-'))
        rng = f'{a}-{min(b, a + 374) if head else b}'
    elif head: rng = '0-374'
    cmd = ['curl', '-sSfL', '--retry', '3', '-o', dest + ('.z' if e.get('deflate') else ''), e['url']] + (['-r', rng] if rng else [])
    subprocess.run(cmd, check=True)
    if e.get('deflate'):
        import zlib
        d = zlib.decompressobj(-15)
        with open(dest + '.z', 'rb') as fi, open(dest, 'wb') as fo:
            for blk in iter(lambda: fi.read(1 << 24), b''): fo.write(d.decompress(blk))
        os.remove(dest + '.z')


def lm_extents():
    """every Lower Mainland tile's extent (UTM; read from its header, cached in EXTENTS)"""
    if os.path.exists(EXTENTS): return json.load(open(EXTENTS))
    import tempfile
    from concurrent.futures import ThreadPoolExecutor
    tmp = tempfile.mkdtemp()
    def one(k):
        src, e = lm_entries()[k]
        if e.get('deflate'):  # its header is compressed: the name is its 1.5 km tile's corner
            x, y = map(float, re.findall(r'\d+', e['name'])[:2]); return [x, y, x + 1500, y + 1500]
        f = f'{tmp}/{k}'
        try: curl(e, f, head=True); b = open(f, 'rb').read(); os.remove(f)
        except Exception: return None
        xmax, xmin, ymax, ymin = struct.unpack('<4d', b[179:211])
        return [xmin, ymin, xmax, ymax] if 3e5 < xmin < 7e5 and 5.3e6 < ymin < 5.6e6 else None
    with ThreadPoolExecutor(12) as ex: ext = list(ex.map(one, range(len(lm_entries()))))
    json.dump(ext, open(EXTENTS, 'w'))
    return ext


def region_points(boxes, got, tmp):
    """boxes outside the City: for each, the best source whose tiles cover it; each tile fetched once, read, deleted"""
    import shapely
    from shapely.geometry import box as sbox
    ents, ext = lm_entries(), lm_extents()
    want = {}
    for k, b in boxes.items():
        B = sbox(*b)
        for src in RANK:
            ts = [i for i, (s_, _) in enumerate(ents) if s_ == src and ext[i] and sbox(*ext[i]).intersects(B)]
            if ts and shapely.union_all([sbox(*ext[i]) for i in ts]).buffer(1).contains(B):
                for i in ts: want.setdefault(i, {})[k] = b
                break
    for i, mine in want.items():
        f = f'{tmp}/t{i}' + os.path.splitext(ents[i][1].get('name') or ents[i][1]['url'])[1]
        print('fetching', ents[i][0], os.path.basename(ents[i][1].get('name') or ents[i][1]['url']), flush=True)
        curl(ents[i][1], f)
        try: read_laz(f, mine, got)
        finally: os.remove(f)


def points(boxes):
    """boxes: {key: (e0, n0, e1, n1)} in UTM -> {key: (x, y, z, class)}: every point in each box"""
    import tempfile, shutil
    got = {k: [] for k in boxes}
    tmp = tempfile.mkdtemp(dir='data')  # the big tiles land on the data disk
    try:
        city_points(boxes, got, tmp)
        region_points({k: b for k, b in boxes.items() if not got[k]}, got, tmp)
    finally: shutil.rmtree(tmp, ignore_errors=True)
    return {k: tuple(np.concatenate([g[i] for g in v]) for i in range(4)) if v else None for k, v in got.items()}


# ---------------------------------------------------------------- the volume and its surface
def raster(polys, x0, y1, nx, ny):
    from lidar_massing import raster as r
    return r(polys, x0, y1, nx, ny)


def surface(X, Y, Z, own_poly, other_polys, sculpture=False):
    """points in the landmark's frame (metres, Z above its ground) -> (verts, faces, top colour raster, grid) of a
    closed surface; own_poly: its outline, other_polys: the neighbours' (their points are theirs)"""
    from scipy import ndimage
    from skimage.measure import marching_cubes
    from lidar_massing import slices
    e0, n0, e1, n1 = own_poly.bounds
    M = REACH + 2
    x0, y1 = math.floor((e0 - M) / RES) * RES, math.ceil((n1 + M) / RES) * RES
    nx, ny = int(math.ceil((e1 + M - x0) / RES)), int(math.ceil((y1 - (n0 - M)) / RES))
    ix = ((X - x0) / RES).astype(int); iy = ((y1 - Y) / RES).astype(int)
    k = (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny)
    X, Y, Z, ix, iy = X[k], Y[k], Z[k], ix[k], iy[k]
    inside = raster([own_poly], x0, y1, nx, ny)
    if sculpture: own = inside
    else:
        other = raster(other_polys, x0, y1, nx, ny)
        d_in = ndimage.distance_transform_edt(~inside) * RES
        d_ot = ndimage.distance_transform_edt(~other) * RES if other.any() else np.full(inside.shape, 1e9)
        own = inside & ~other | inside & (d_ot > 0) | ~inside & ~other & (d_in <= REACH) & (d_in < d_ot)
        own |= inside & ~ndimage.binary_erosion(other, iterations=1)
    dsm = np.full((ny, nx), -99.0, np.float32)
    np.maximum.at(dsm, (iy, ix), Z)
    cnt = np.bincount(iy * nx + ix, minlength=nx * ny).reshape(ny, nx)
    dsm[cnt < (1 if sculpture else 2)] = -99
    gap = (dsm < -50) & own
    if gap.any():
        f = ndimage.grey_closing(dsm, size=3)
        dsm[gap] = np.where(f[gap] > -50, f[gap], -99)
    lo = 0.3 if sculpture else 2.0  # under this it's the ground, a car, a planter
    on = own & (dsm > lo)
    if not sculpture: on = ndimage.binary_opening(on, iterations=1) | on & (dsm > 6)  # a lamp post's speck goes
    lab, n = ndimage.label(on)
    if n > 1:  # pieces that don't touch the landmark's outline are something else (a tree in a planter, a parked truck)
        keep = np.unique(lab[on & ndimage.binary_dilation(inside, iterations=2)])
        on &= np.isin(lab, keep[keep > 0])
    dsm[~on] = -99
    top = float(np.percentile(dsm[on], 99.9)) + 1 if on.any() else 0
    zs = np.arange(DZ / 2, top + DZ, DZ)
    regs = slices(on, dsm, Z, ix, iy, zs) if not sculpture else [on & (dsm >= z) for z in zs]
    if not sculpture and len(zs) > 21:  # an overhang's outline holds for metres: a slice or two that differ are jitter
        cut = np.stack([(on & (dsm >= z)) & ~r for z, r in zip(zs, regs)])
        cut = ndimage.median_filter(cut, size=(21, 1, 1))
        regs = [(on & (dsm >= z)) & ~c for z, c in zip(zs, cut)]
    nb = int(round(BELOW / DZ))
    sm = np.where(on, ndimage.median_filter(dsm, size=3), dsm) if not sculpture else dsm  # roof speckle
    def field(d):
        F = np.zeros((nb + len(zs), ny, nx), np.float32)
        F[:nb] = on & (d >= DZ)
        for kk, z in enumerate(zs):
            f = np.clip((d - z) / DZ + 0.5, 0, 1) * on
            t = on & (d >= z)
            if (regs[kk] ^ t).any(): f[t & ~regs[kk]] = 0  # an overhang over this height: its outline, not the top
            F[nb + kk] = f
        return F
    F = field(sm)
    if not sculpture:
        # smoothed, so slanted and curved walls come out straight and round instead of stepped on the 0.5 m grid, and
        # the slices' jitter doesn't band the walls; thin things (masts, spires, a sign) the blur would lose stay as
        # they are
        raw = field(dsm) > 0.5
        thin = raw & (ndimage.uniform_filter(raw.astype(np.float32), size=(1, 5, 5)) < 0.3)
        F = np.maximum(ndimage.gaussian_filter(F, sigma=(1.2, 1.0, 1.0)), thin)
    lab, n = ndimage.label(F > 0.5)
    if n > 1:  # what floats free of the ground (a neighbour's balcony past the outline, a bird) goes
        F[~np.isin(lab, np.unique(lab[0][lab[0] > 0]))] = 0
    F = np.pad(F, ((0, 1), (1, 1), (1, 1)))
    F = np.concatenate([F[:1], F], 0)  # the bottom layer open (cut off below)
    v, faces, _, _ = marching_cubes(F, 0.5, spacing=(DZ, RES, RES))
    z = v[:, 0] - DZ - BELOW + DZ / 2
    u = x0 + v[:, 2] - RES / 2
    w = y1 - (v[:, 1] - RES / 2)
    return np.c_[u, w, z], faces[:, ::-1].copy(), (x0, y1, nx, ny)  # (z, row, col) -> (x, y, z) mirrors: wind back out


def build(key, spec, pts, tr, inv):
    """one landmark -> (manifest entry, binary, a quarter as many triangles for the middle distance)"""
    import shapely
    from shapely import affinity
    from shapely.geometry import Polygon
    import fast_simplification
    rings, ids = footprint(spec)
    sculpture = 'box' in spec
    def utm(r):
        la, lo = latlon(np.array([p[0] for p in r]), np.array([p[1] for p in r]))
        e, n = tr.transform(lo, la)
        return np.c_[e, n]
    own = shapely.union_all([Polygon(utm(r)).buffer(0) for r in rings])
    X, Y, Z, C = pts
    # ground: the ground returns round the outline
    g = C == 2
    d = shapely.distance(own.boundary, shapely.points(X[g], Y[g])) if g.any() else np.zeros(0)
    gz = Z[g][d < 10]
    if len(gz) < 10: raise SystemExit(f'{key}: no ground round it (outside the LiDAR?)')
    ground = float(np.percentile(gz, 10))
    near = shapely.contains_xy(own.buffer(REACH), X, Y)
    if (C[near] == 6).sum() < 300: C = np.where((C == 1) & near, 6, C)  # an open set that doesn't classify buildings
    cls = (6,) + tuple(spec.get('extra', ()))
    keep = np.isin(C, cls) & (Z > ground + (0.3 if sculpture else 1.0))
    if spec.get('extra'):  # unclassified points only inside the outline (cranes and wires round it are not it)
        ins = shapely.contains_xy(own.buffer(0.5), X, Y)
        keep &= (C == 6) | ins
    X, Y, Z = X[keep], Y[keep], Z[keep] - ground
    # the frame: the outline's long axis along x
    rect = own.minimum_rotated_rectangle
    c = np.array(rect.exterior.coords)[:4]
    ed = [c[(i + 1) % 4] - c[i] for i in range(2)]
    ax = ed[0] if np.hypot(*ed[0]) >= np.hypot(*ed[1]) else ed[1]
    ang = math.atan2(ax[1], ax[0])
    cx, cy = own.centroid.x, own.centroid.y
    ca, sa = math.cos(-ang), math.sin(-ang)
    rot = lambda e, n: ((e - cx) * ca - (n - cy) * sa, (e - cx) * sa + (n - cy) * ca)
    U, W = rot(X, Y)
    own_r = affinity.rotate(affinity.translate(own, -cx, -cy), -ang, origin=(0, 0), use_radians=True)
    others = []
    if not sculpture:
        x, y = xy(*latlon(*np.mean(rings[0], 0)))
        rad = max(math.hypot(*np.ptp(np.array(r), 0)) for r in rings) + 20
        mine = set(ids)
        for oid, o, part in near_buildings(x, y, rad):
            if part or oid in mine: continue
            p = Polygon(utm(o)).buffer(0)
            if p.is_empty or own.contains(p.representative_point()): continue
            others.append(affinity.rotate(affinity.translate(p, -cx, -cy), -ang, origin=(0, 0), use_radians=True))
    V, faces, (x0, y1, nx, ny) = surface(U, W, Z, own_r, others, sculpture)
    n0 = len(faces)
    alat, alon = inv.transform(cx, cy)[::-1]
    ax_, ay_ = (round(float(v), 1) for v in xy(alat, alon))  # the anchor: the outline's centre
    alat, alon = latlon(ax_, ay_)
    cb, sb = math.cos(ang), math.sin(ang)
    st = spec.get('storey', 3.4)
    fq = max(1, min(31, round((st - 2.4) / 0.15)))
    bands = lambda v, d: v if isinstance(v, list) else [(0, v if v is not None else d)]

    def pack(V, faces, target):
        """decimated to target triangles, coloured, in the map's frame -> (bytes, face colours, areas, up, world x, y, z)"""
        if len(faces) > target:
            V, faces = fast_simplification.simplify(V.astype(np.float64), faces.astype(np.int32), target_count=target)
        # drop the buried bottom and anything that collapsed
        P = V[faces]
        nrm = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
        area = np.linalg.norm(nrm, axis=1)
        ok = (area > 1e-6) & ~(P[:, :, 2].max(1) < -BELOW + 0.6)
        faces, nrm, area = faces[ok], nrm[ok], area[ok]
        nrm = nrm / area[:, None]
        used = np.unique(faces)
        remap = np.full(len(V), -1); remap[used] = np.arange(len(used))
        V, faces = V[used], remap[faces]
        cz = V[faces][:, :, 2].mean(1)
        up = nrm[:, 2] > 0.35
        face_rgb = np.zeros((len(faces), 3), np.float32)
        for z0, h in bands(spec.get('roof'), 0xa4a6a4): face_rgb[up & (cz >= z0 - 0.01)] = hexrgb(h)
        style = np.where(up, 0, spec.get('pattern', 1)).astype(np.int8)
        for z0, h, *pt in bands(spec.get('wall'), 0x9a9a96):
            m = ~up & (cz >= z0 - 0.01)
            face_rgb[m] = hexrgb(h)
            if pt: style[m] = pt[0]
        # back to the map's frame: world metres from the anchor, y up
        E, N = cx + V[:, 0] * cb - V[:, 1] * sb, cy + V[:, 0] * sb + V[:, 1] * cb
        lo, la = inv.transform(E, N)
        wx, wy = xy(la, lo)
        pos = np.round(np.c_[wx - ax_, V[:, 2], -(wy - ay_)] / Q).astype(np.int16)
        head = struct.pack('<4sIIf', b'LMS1', len(pos), len(faces), Q)
        body = pos.tobytes() + faces.astype(np.uint16 if len(pos) < 65536 else np.uint32).tobytes()
        body += np.clip(face_rgb, 0, 255).astype(np.uint8).tobytes() + style.tobytes()
        body += b'\0' * (-len(body) % 4)
        return head + body, face_rgb, area, up, wx, wy, V[:, 2]

    target = spec.get('tris', 3000)
    hi, face_rgb, area, up, wx, wy, z = pack(V, faces, target)
    lo_, *_ = pack(V, faces, max(250, target // 4))
    ent = dict(name=spec['name'], wall=main_colour(face_rgb, area, ~up), roof=main_colour(face_rgb, area, up), pattern=spec.get('pattern', 1),
               at=[round(alat, 7), round(alon, 7)], tris=len(area), h=round(float(z.max()), 1),
               r=round(float(np.hypot(wx - ax_, wy - ay_).max()), 1), storey=fq, use=spec.get('use', 2),
               rings=[[round(v, 6) for p in r for v in latlon(*p)] for r in rings], osm=ids, far=far_of(rings, z.max()))
    print(f'{key}: {n0} -> {len(area)} triangles ({len(hi)} + {len(lo_)} bytes), top {ent["h"]} m, ground {ground:.1f}', flush=True)
    return ent, hi, lo_


def far_of(rings, top):
    """the footprint massing (tools/lidar_massing.py) for far off: [[foot, top, lat, lon, ...], ...]"""
    from lidar_massing import massing_lookup
    out = []
    for r in rings:
        parts = massing_lookup(r) or [dict(ring=r, mn=0.0, h=float(top))]
        for p in parts: out.append([round(p['mn'], 1), round(p['h'], 1)] + [round(v, 6) for q in p['ring'] for v in latlon(*q)])
    return out


def main_colour(rgb, area, m):
    """the colour that covers most of the faces m, as 0xRRGGBB"""
    if not m.any(): return 0x9a9a96
    c, k = np.unique(rgb[m].astype(int), axis=0, return_inverse=True)
    r, g, b = c[np.argmax(np.bincount(k.ravel(), weights=area[m]))]
    return int(r) << 16 | int(g) << 8 | int(b)


def hexrgb(h): return np.array([(h >> 16) & 255, (h >> 8) & 255, h & 255], np.float32)


def main(keys):
    from pyproj import Transformer
    from shapely.geometry import Polygon
    t0 = time.time()
    tr = Transformer.from_crs('EPSG:4326', 'EPSG:3157', always_xy=True)
    inv = Transformer.from_crs('EPSG:3157', 'EPSG:4326', always_xy=True)
    boxes = {}
    for k in list(keys):
        try: rings, _ = footprint(LOOKS[k])
        except SystemExit as e: print(e); keys.remove(k); continue
        la, lo = latlon(np.array([p[0] for r in rings for p in r]), np.array([p[1] for r in rings for p in r]))
        e, n = tr.transform(lo, la)
        m = REACH + 12
        boxes[k] = (e.min() - m, n.min() - m, e.max() + m, n.max() + m)
    pts = points(boxes)
    print(f'points read {time.time() - t0:.0f}s', flush=True)
    os.makedirs(OUT, exist_ok=True)
    man_path = f'{OUT}/scans.json'
    man = json.load(open(man_path)) if os.path.exists(man_path) else {}
    for k in keys:
        if pts[k] is None: print(k, 'outside the LiDAR'); continue
        try: ent, hi, lo = build(k, LOOKS[k], pts[k], tr, inv)
        except SystemExit as e: print(e); continue
        open(f'{OUT}/{k}.bin', 'wb').write(hi); open(f'{OUT}/{k}.lo.bin', 'wb').write(lo)
        man[k] = ent
    man = {k: man[k] for k in LOOKS if k in man}
    with open(man_path, 'w') as f: json.dump(man, f, separators=(',', ':'))
    print(len(man), 'landmarks ->', man_path, f'{time.time() - t0:.0f}s')


def check():
    """a synthetic 30 m tower with a 6 m dome on a wider 8 m podium: closed, about the right size, dome on top"""
    from shapely.geometry import box
    import fast_simplification
    rng = np.random.default_rng(1)
    def fill(n, f):
        p = rng.uniform(-20, 20, (n, 2)); z = f(p[:, 0], p[:, 1]); k = z > 0
        return p[k, 0], p[k, 1], z[k]
    def h(x, y):
        z = np.where((abs(x) < 15) & (abs(y) < 10), 8.0, 0)
        z = np.where((abs(x) < 6) & (abs(y) < 6), 30.0, z)
        r = np.hypot(x, y)
        return np.where(r < 5, 30 + np.sqrt(np.maximum(0, 36 - r * r)), z)
    X, Y, Z = fill(200000, h)
    V, f, *_ = surface(X, Y, Z, box(-15, -10, 15, 10), [])
    assert abs(V[:, 2].max() - 36) < 0.8, V[:, 2].max()
    assert abs(V[:, 0].max() - 15) < 0.8 and abs(V[:, 1].min() + 10) < 0.8
    V2, f2 = fast_simplification.simplify(V, f.astype(np.int32), target_count=600)
    assert len(f2) <= 650 and abs(V2[:, 2].max() - 36) < 1.0
    # outward normals: the top face of the podium looks up
    P = V[f]; n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]); c = P.mean(1)
    k = (abs(c[:, 2] - 8) < 0.3) & (abs(c[:, 0]) > 9)
    assert (n[k, 2] > 0).mean() > 0.9, (n[k, 2] > 0).mean()
    print('ok', len(f), '->', len(f2))


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['check']: check()
    else: main(a or list(LOOKS))
