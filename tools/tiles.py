# Step 3: the map tiles. For every 4096 m tile with data, writes sixteen 1024 m detail tiles (public/tiles/0/)
# and one 4096 m medium tile (public/tiles/1/), each a small gzipped binary the page streams in as you look
# around. Format: see public/core/tile-format.md. Inputs: data/feat (osm_split.py), data/hr (hrdem.py),
# data/sea.npz (sea.py), City of Vancouver trees + 2009 LiDAR sections, MRDEM where HRDEM has no data.
# Run: uv run --with numpy,scipy,pillow,shapely,mapbox-earcut,rasterio python3 tools/tiles.py [procs] [i_j ...]
import csv, gzip, json, math, os, pickle, random, struct, sys, time
from multiprocessing import Pool
import numpy as np
import shapely
from shapely.geometry import Polygon, MultiPolygon, box, LineString
from shapely.ops import unary_union
from PIL import Image, ImageDraw
from scipy import ndimage
import mapbox_earcut as earcut
sys.path.insert(0, os.path.dirname(__file__))
from world import xy, latlon, extent, L0, L1, KX, KY, LAT_O, LON_O

OUT = os.environ.get('OUT', 'public/tiles')
HR = 2.0  # HRDEM cell, metres
VERSION = 2

# ---------------------------------------------------------------- ground classes (draw order = list order)
GROUND = ['land', 'residential', 'commercial', 'industrial', 'farmland', 'grass', 'golf', 'scrub', 'wetland', 'forest', 'sand',
          'rock', 'construction', 'apron', 'parking', 'plaza', 'playground', 'pitch', 'track', 'water', 'pier', 'pool', 'snow',
          'trail', 'walk', 'cycle', 'ballast', 'sidewalk', 'blvd', 'road', 'arterial']  # streets last: they win where things overlap
GI = {k: i for i, k in enumerate(GROUND)}


def ground_class(t):
    g = lambda k: t.get(k, '')
    if g('natural') == 'water' or g('waterway') in ('riverbank', 'dock') or 'water' in t and g('natural') != 'coastline' and g('water') != '' and g('natural') in ('', 'water'):
        return 'water'
    if g('leisure') == 'swimming_pool' or g('amenity') == 'swimming_pool': return 'pool'
    if g('man_made') in ('pier', 'breakwater', 'groyne') or g('leisure') == 'marina' and False: return 'pier'
    if g('leisure') == 'pitch': return 'pitch'
    if g('leisure') == 'track' or g('highway') == 'raceway': return 'track'
    if g('leisure') == 'playground': return 'playground'
    if g('amenity') == 'parking' and g('parking') not in ('underground', 'multi-storey', 'rooftop'): return 'parking'
    if g('highway') == 'pedestrian' or g('area:highway') in ('pedestrian', 'footway') or g('place') == 'square' or g('amenity') in ('marketplace',): return 'plaza'
    if g('aeroway') in ('apron', 'runway', 'taxiway', 'helipad'): return 'apron'
    if g('landuse') in ('construction', 'brownfield', 'landfill', 'quarry'): return 'construction'
    if g('natural') in ('bare_rock', 'scree', 'cliff', 'shingle', 'stone'): return 'rock'
    if g('natural') == 'glacier': return 'snow'
    if g('natural') in ('beach', 'sand', 'dune') or g('golf') == 'bunker' or g('surface') == 'sand' and g('leisure') != 'pitch': return 'sand'
    if g('natural') in ('wood',) or g('landuse') == 'forest': return 'forest'
    if g('natural') == 'wetland' or g('landuse') == 'salt_pond': return 'wetland'
    if g('natural') in ('scrub', 'heath') : return 'scrub'
    if g('leisure') == 'golf_course' or g('golf') in ('fairway', 'green', 'tee', 'rough'): return 'golf'
    if g('leisure') in ('park', 'garden', 'nature_reserve', 'common', 'dog_park', 'recreation_ground') or g('landuse') in ('grass', 'recreation_ground', 'village_green', 'cemetery', 'meadow') \
            or g('natural') in ('grassland',) or g('amenity') == 'grave_yard': return 'grass'
    if g('landuse') in ('farmland', 'orchard', 'vineyard', 'allotments', 'greenhouse_horticulture', 'plant_nursery', 'farmyard', 'animal_keeping'): return 'farmland'
    if g('landuse') in ('industrial', 'railway', 'port', 'military', 'depot') or g('industrial'): return 'industrial'
    if g('landuse') in ('commercial', 'retail') or g('amenity') in ('school', 'university', 'college', 'hospital') and g('landuse') == '': return 'commercial'
    if g('landuse') in ('residential',): return 'residential'
    return None


# ---------------------------------------------------------------- roads and other lines
# kind ids shared with the page (public/core/kinds.js)
KINDS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living', 'pedestrian', 'footway', 'cycleway',
         'path', 'steps', 'track', 'rail', 'lightrail', 'runway', 'taxiway']
KI = {k: i for i, k in enumerate(KINDS)}
DRIVE = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living'}


def line_kind(t):
    h = t.get('highway', ''); r = t.get('railway', ''); a = t.get('aeroway', '')
    if h:
        h = h.replace('_link', '')
        if h in ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'pedestrian', 'footway', 'cycleway', 'path', 'steps', 'track'): return h
        if h in ('unclassified', 'road'): return 'residential'
        if h == 'living_street': return 'living'
        if h in ('bridleway', 'corridor'): return 'path'
        return None
    if r in ('rail', 'preserved', 'narrow_gauge') and t.get('usage') != 'industrial' or r == 'rail': return 'rail'
    if r in ('light_rail', 'subway', 'tram', 'monorail'): return 'lightrail'
    if a in ('runway', 'taxiway'): return a
    return None


def hnum(v):
    try: return float(str(v).split(';')[0].replace('m', '').replace(',', '.').strip())
    except (ValueError, TypeError): return None


def road_shape(kind, t):
    """(lanes total, width m, oneway, sidewalk band)"""
    ow = t.get('oneway') in ('yes', '1', '-1', 'true') or t.get('junction') == 'roundabout' or kind == 'motorway' and t.get('oneway') != 'no'
    lanes = hnum(t.get('lanes'))
    default = {'motorway': 4, 'trunk': 4, 'primary': 4, 'secondary': 2, 'tertiary': 2, 'residential': 2, 'service': 1, 'living': 1}.get(kind)
    if lanes is None and default: lanes = default if not ow else max(1, default // 2)
    w = hnum(t.get('width'))
    if not w:
        w = {'motorway': 3.7, 'trunk': 3.6, 'primary': 3.4, 'secondary': 3.3, 'tertiary': 3.3, 'residential': 4.0, 'service': 4.5, 'living': 5.0}.get(kind, 0) * (lanes or 1)
        w = w or {'pedestrian': 7, 'footway': 2.2, 'cycleway': 2.6, 'path': 1.6, 'steps': 2.2, 'track': 3.2, 'rail': 3.4, 'lightrail': 3.4, 'runway': 45, 'taxiway': 23}.get(kind, 3)
        if kind in ('motorway', 'trunk', 'primary') : w += 1.5  # shoulders
    sw = t.get('sidewalk', '')
    band = kind in ('primary', 'secondary', 'tertiary', 'residential', 'living') and sw not in ('no', 'none', 'separate') and t.get('sidewalk:both') != 'separate' \
        and not (t.get('sidewalk:left') == 'separate' and t.get('sidewalk:right') == 'separate')
    return int(lanes or 0), w, ow, band


# ---------------------------------------------------------------- binary writer
class Out:
    def __init__(self, ox, oy, size):
        self.ox, self.oy, self.k = ox, oy, 32766 / (2 * size)  # int16 units per metre: ±2 tile sizes (long pieces reach out), far edge exactly 16383 (must match tile-worker.js)
        self.b = bytearray()
        self.b += b'VTL2' + struct.pack('<HHff', VERSION, 0, ox, oy) + struct.pack('<f', size)

    def q(self, x, y):
        return (max(-32768, min(32767, int(round((x - self.ox) * self.k)))), max(-32768, min(32767, int(round((y - self.oy) * self.k)))))

    def section(self, tag, payload):
        self.b += tag.encode() + struct.pack('<I', len(payload)) + payload

    def bytes(self):
        return gzip.compress(bytes(self.b), 7)


def tri_poly(poly):
    """earcut a shapely Polygon -> (verts Nx2 float, idx)"""
    rings = [np.asarray(poly.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in poly.interiors]
    rings = [r for r in rings if len(r) >= 3]
    if not rings: return None, None
    v = np.concatenate(rings).astype(np.float64)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    idx = earcut.triangulate_float64(v, ends)
    return v, idx


# ---------------------------------------------------------------- shared inputs (loaded in the parent; children fork)
EX = extent()
SEA = np.load('data/sea.npz')
SEA_M, SEA_X0, SEA_Y1, SEA_C = SEA['sea'].astype(bool), float(SEA['x0']), float(SEA['y1']), float(SEA['cell'])


def mrdem_grid():
    """MRDEM 30 m for the whole map, sampled on a 32 m world grid (fallback where HRDEM has no data)"""
    path = 'data/mrdem32.npz'
    if os.path.exists(path):
        d = np.load(path); return d['z'], float(d['x0']), float(d['y1'])
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import Affine
    x0, y0, x1, y1 = EX; c = 32.0
    w, h = int((x1 - x0) / c) + 2, int((y1 - y0) / c) + 2
    tr = Affine((c / KX), 0, LON_O + x0 / KX, 0, -(c / KY), LAT_O + y1 / KY)
    z = np.full((h, w), np.nan, np.float32)
    with rasterio.open('/vsicurl/https://canelevation-dem.s3.ca-central-1.amazonaws.com/mrdem-30/mrdem-30-dtm.tif') as src:
        reproject(rasterio.band(src, 1), z, src_nodata=src.nodata, dst_transform=tr, dst_crs='EPSG:4326', dst_nodata=np.nan, resampling=Resampling.bilinear)
    np.savez_compressed(path, z=z, x0=x0, y1=y1)
    return z, x0, y1


MR, MR_X0, MR_Y1 = mrdem_grid()


def city_trees():
    """City of Vancouver public trees: (x, y, genus, species, height)"""
    out = []
    with open('data/trees.csv', encoding='utf-8-sig') as fh:
        for row in csv.DictReader(fh, delimiter=';'):
            try: lat, lon = map(float, row['geo_point_2d'].split(','))
            except ValueError: continue
            x, y = xy(lat, lon)
            out.append((x, y, row['genus_name'], row['common_name'], float(row['height_m'] or 0) or 8.0))
    return out


def lidar_sections():
    out = []
    for f in json.load(open('data/bf2009.geojson'))['features']:
        p = f['properties']; geo = f['geometry']
        polys = geo['coordinates'] if geo['type'] == 'MultiPolygon' else [geo['coordinates']] if geo['type'] == 'Polygon' else []
        for poly in polys:
            r = [xy(b, a) for a, b in poly[0]]
            if len(r) >= 4 and (p.get('hgt_agl') or 0) >= 2: out.append((r, p['hgt_agl'], (p.get('rooftype') or '').lower()))
    return out


TREES = city_trees()
SECTIONS = lidar_sections()
print('inputs ready', len(TREES), 'city trees', len(SECTIONS), 'lidar sections', flush=True)


# ---------------------------------------------------------------- tree species -> shape and autumn colour
# shapes: 0 round, 1 columnar, 2 spreading, 3 weeping, 4 fir, 5 cedar, 6 pine, 7 palm
SHAPE = {
    'ACER': 0, 'PRUNUS': 2, 'MALUS': 2, 'TILIA': 1, 'FRAXINUS': 0, 'QUERCUS': 2, 'CARPINUS': 1, 'BETULA': 3, 'SALIX': 3, 'ULMUS': 2,
    'AESCULUS': 2, 'FAGUS': 2, 'PLATANUS': 2, 'LIQUIDAMBAR': 1, 'GLEDITSIA': 2, 'GINKGO': 1, 'POPULUS': 1, 'CERCIDIPHYLLUM': 0,
    'PYRUS': 1, 'SORBUS': 0, 'CORNUS': 0, 'MAGNOLIA': 0, 'STYRAX': 0, 'PARROTIA': 0, 'NYSSA': 1, 'ZELKOVA': 2, 'CATALPA': 2,
    'THUJA': 5, 'CHAMAECYPARIS': 5, 'CALOCEDRUS': 5, 'CUPRESSOCYPARIS': 5, 'SEQUOIADENDRON': 4, 'SEQUOIA': 4, 'METASEQUOIA': 4,
    'PSEUDOTSUGA': 4, 'PICEA': 4, 'ABIES': 4, 'TSUGA': 4, 'TAXODIUM': 4, 'CEDRUS': 6, 'PINUS': 6, 'ARAUCARIA': 6, 'TAXUS': 5,
    'TRACHYCARPUS': 7, 'ARBUTUS': 2,
}
# colour families (indices into the page's palette, see public/core/trees.js): 0 green, 1 yellow, 2 orange, 3 red, 4 brown,
# 5 dark conifer, 6 blue-green conifer, 7 forest green, 8 bare-ish (late)
AUTUMN = {
    'ACER': (3, 2, 1), 'PRUNUS': (2, 3), 'MALUS': (1, 0), 'TILIA': (1, 0), 'FRAXINUS': (1, 8), 'QUERCUS': (4, 0), 'CARPINUS': (1, 0),
    'BETULA': (1,), 'SALIX': (0, 1), 'ULMUS': (1, 0), 'AESCULUS': (4, 2), 'FAGUS': (4, 2), 'PLATANUS': (4, 1), 'LIQUIDAMBAR': (3, 2),
    'GLEDITSIA': (1,), 'GINKGO': (1,), 'POPULUS': (1,), 'CERCIDIPHYLLUM': (2, 1), 'PYRUS': (3, 2), 'SORBUS': (2, 3), 'CORNUS': (3,),
    'PARROTIA': (2, 3), 'NYSSA': (3,), 'ZELKOVA': (2, 4), 'STYRAX': (1,), 'MAGNOLIA': (0, 4), 'ARBUTUS': (0,),
}


def tree_look(genus, rnd):
    g = (genus or '').upper()
    shape = SHAPE.get(g)
    if shape is None: shape = 0
    if shape >= 4:
        return shape, 6 if g in ('PICEA', 'CEDRUS') else 5
    fam = AUTUMN.get(g)
    if fam is None: return shape, 0 if rnd.random() < 0.6 else rnd.choice((1, 2, 4))
    return shape, fam[0] if rnd.random() < 0.7 else rnd.choice(fam + (0,))


# ---------------------------------------------------------------- per 4096 m tile
def build(ij):
    i, j = ij
    t0 = time.time()
    rnd = random.Random(i * 7919 + j)
    fpath = f'data/feat/{i}_{j}.pkl'
    feat = pickle.load(open(fpath, 'rb')) if os.path.exists(fpath) else {}
    X0, Y0 = i * L1, j * L1
    # rasters on the tile's 2 m grid (row 0 = north)
    N = int(L1 / HR)
    hp = f'data/hr/{i}_{j}.npz'
    dsm = dtm = None
    if os.path.exists(hp):
        d = np.load(hp)
        if 'dtm' in d: dsm, dtm = d['dsm'], d['dtm']
    gx = X0 + (np.arange(N) + 0.5) * HR; gy = Y0 + L1 - (np.arange(N) + 0.5) * HR
    # MRDEM fallback, bilinear from the 32 m grid
    fx = (gx - MR_X0) / 32 - 0.5; fy = (MR_Y1 - gy) / 32 - 0.5
    mr = ndimage.map_coordinates(np.nan_to_num(MR, nan=0.0), np.meshgrid(fy, fx, indexing='ij'), order=1, mode='nearest').astype(np.float32)
    if dtm is None: dtm = mr.copy(); dsm = None
    else:
        hole = np.isnan(dtm)
        dtm = np.where(hole, mr, dtm)
        if dsm is not None: dsm = np.where(np.isnan(dsm), dtm, dsm)
    # sea on the tile's grid
    sr = ((SEA_Y1 - gy) / SEA_C).astype(int).clip(0, SEA_M.shape[0] - 1); sc = ((gx - SEA_X0) / SEA_C).astype(int).clip(0, SEA_M.shape[1] - 1)
    sea = SEA_M[np.ix_(sr, sc)]
    if sea.all() and not feat.get('lines') and not feat.get('buildings'): return ij, 'sea', 0
    pix = lambda x, y: ((x - X0) / HR, (Y0 + L1 - y) / HR)

    # ---- water polygons (OSM lakes, rivers) to flatten the terrain and to draw
    areas = feat.get('areas', [])
    polys = {}  # class -> list of shapely polygons (world metres)
    for oid, prs, t in areas:
        k = ground_class(t)
        if not k: continue
        for outer, inners in prs:
            if len(outer) < 4: continue
            try:
                pg = Polygon(outer, [h for h in inners if len(h) >= 4])
                if not pg.is_valid: pg = pg.buffer(0)
            except Exception: continue
            if pg.is_empty: continue
            polys.setdefault(k, []).append(pg)
    # sea polygons from the mask (vectorized at 4 m inside this tile, smoothed)
    import rasterio.features as rf
    from rasterio.transform import Affine
    r0, c0 = int((SEA_Y1 - (Y0 + L1)) / SEA_C) - 2, int((X0 - SEA_X0) / SEA_C) - 2
    n4 = int(L1 / SEA_C) + 4
    sub = np.zeros((n4, n4), np.uint8)
    rs, cs = max(0, r0), max(0, c0)
    re, ce = min(SEA_M.shape[0], r0 + n4), min(SEA_M.shape[1], c0 + n4)
    if re > rs and ce > cs: sub[rs - r0:re - r0, cs - c0:ce - c0] = SEA_M[rs:re, cs:ce]
    if sub.any():
        # exact shorelines: cut the tile by the OSM coastlines and keep the pieces the sea mask says are water
        tb_ = box(X0 - 8, Y0 - 8, X0 + L1 + 8, Y0 + L1 + 8)
        coast = [LineString(c) for _, c, _, t in feat.get('lines', []) if t.get('natural') == 'coastline' and len(c) > 1]
        seap = []
        if coast:
            cut = unary_union([g.intersection(tb_) for g in coast] + [tb_.exterior])
            for face in shapely.polygonize(list(cut.geoms) if hasattr(cut, 'geoms') else [cut]).geoms:
                pnt = face.representative_point()
                r_, c_ = int((SEA_Y1 - pnt.y) / SEA_C), int((pnt.x - SEA_X0) / SEA_C)
                if 0 <= r_ < SEA_M.shape[0] and 0 <= c_ < SEA_M.shape[1] and SEA_M[r_, c_]: seap.append(face)
        if not seap and sub.mean() > 0.5: seap = [tb_]
        polys.setdefault('water', []).extend(seap)
    # flatten water surfaces: sea at 0 m, lakes/rivers at their shore level
    water_r = np.zeros((N, N), bool)
    if polys.get('water'):
        img = Image.new('L', (N, N), 0); dr = ImageDraw.Draw(img)
        for p in polys['water']:
            for g in (p.geoms if hasattr(p, 'geoms') else [p]):
                dr.polygon([pix(*c) for c in g.exterior.coords], fill=1)
                for h in g.interiors: dr.polygon([pix(*c) for c in h.coords], fill=0)
        water_r = np.array(img, bool)
    water_r |= sea
    lowwater = water_r & ndimage.binary_erosion(water_r, iterations=2)
    dtm = np.where(sea & ndimage.binary_erosion(sea, iterations=1), 0.0, dtm)  # the sea is flat at 0 m, so neighbouring tiles meet exactly
    if lowwater.any():
        lab, nl = ndimage.label(lowwater)
        lvl = ndimage.percentile(dtm, lab, np.arange(1, nl + 1), 10) if hasattr(ndimage, 'percentile') else ndimage.minimum(dtm, lab, np.arange(1, nl + 1))
        lvl = np.concatenate([[0], np.asarray(lvl)])
        dtm = np.where(lowwater, np.minimum(dtm, lvl[lab]), dtm)

    def height_at(x, y):  # bilinear on the 2 m DTM
        fx_, fy_ = (x - X0) / HR - 0.5, (Y0 + L1 - y) / HR - 0.5
        return float(ndimage.map_coordinates(dtm, [[fy_], [fx_]], order=1, mode='nearest')[0])

    # ---- canopy as forest: where the LiDAR sees trees over 6 m in a sizeable patch, the ground is woods (most of the
    # North Shore, Pacific Spirit, Stanley Park and every big back-yard grove is mapped only partly in OSM)
    if dsm is not None:
        import rasterio.features as rf
        from rasterio.transform import Affine
        chm = ndimage.uniform_filter(np.nan_to_num(dsm - dtm), 5)
        wood = ndimage.binary_opening(chm > 6, iterations=2) & ~water_r
        lab, nl = ndimage.label(wood)
        if nl:
            sizes = ndimage.sum(wood, lab, range(nl + 1)) * HR * HR
            wood = (sizes[lab] > 2500) & wood
            tr = Affine(HR, 0, X0, 0, -HR, Y0 + L1)
            for g, v in rf.shapes(wood.astype(np.uint8), mask=wood, transform=tr):
                p = shapely.geometry.shape(g).simplify(3).buffer(2, join_style=1).buffer(-2, join_style=1)
                if not p.is_empty and p.area > 2500: polys.setdefault('forest', []).append(p)
    else:  # no LiDAR here: high ground that OSM leaves blank is forest
        hi = ndimage.binary_opening((dtm > 250) & ~water_r, iterations=3)
        if hi.any():
            import rasterio.features as rf
            from rasterio.transform import Affine
            tr = Affine(HR, 0, X0, 0, -HR, Y0 + L1)
            for g, v in rf.shapes(hi.astype(np.uint8), mask=hi, transform=tr):
                p = shapely.geometry.shape(g).simplify(8)
                if p.area > 20000: polys.setdefault('forest', []).append(p)
    # built-up places and sports fields keep their own look: cut them out of the canopy forest
    if polys.get('forest'):
        keep = unary_union([p for k in ('pitch', 'track', 'parking', 'water', 'pool', 'golf', 'apron', 'construction', 'sand') for p in polys.get(k, [])] or [Polygon()])
        if not keep.is_empty: polys['forest'] = [f.difference(keep) for f in polys['forest']]

    # ---- buildings
    builds = buildings(feat.get('buildings', []), dsm, dtm, X0, Y0, rnd)
    fp = Image.new('L', (N, N), 0); dfp = ImageDraw.Draw(fp)
    for b in builds:
        dfp.polygon([pix(*c) for c in b['ring']], fill=1)
    fp = np.array(fp, bool)

    # ---- lines
    lines = road_pieces(feat.get('lines', []), dsm, dtm, X0, Y0)
    # streets as ground: carriageways, sidewalks and boulevards, paths and rail beds, unioned per class so junctions
    # are clean (bridges are raised decks, drawn from the lines)
    for L in lines:
        if L['z'] or len(L['pts']) < 2: continue
        k = L['kind']; ls = LineString(L['pts'])
        cls = {'motorway': 'arterial', 'trunk': 'arterial', 'primary': 'arterial', 'secondary': 'arterial', 'tertiary': 'road', 'residential': 'road',
               'service': 'road', 'living': 'road', 'pedestrian': 'walk', 'footway': 'walk', 'steps': 'walk', 'path': 'trail', 'track': 'trail',
               'cycleway': 'cycle', 'rail': 'ballast', 'lightrail': 'ballast', 'runway': 'apron', 'taxiway': 'apron'}.get(k)
        if not cls or L.get('crossing'): continue  # a crossing's footway lies on the road: the road wins, the zebra is paint
        w = L['w'] if cls != 'ballast' else 3.4
        polys.setdefault(cls, []).append(ls.buffer(w / 2, quad_segs=3, cap_style='round' if cls in ('road', 'arterial', 'walk') else 'flat'))
        if L['band']:
            blvd = 2.2 if k in ('residential', 'tertiary') else 0.0
            walk = 3.0 if k in ('primary', 'secondary', 'trunk') else 2.0
            outer = ls.buffer(w / 2 + blvd + walk, quad_segs=3, cap_style='flat')
            polys.setdefault('sidewalk', []).append(outer)
            if blvd: polys.setdefault('blvd', []).append(ls.buffer(w / 2 + blvd, quad_segs=3, cap_style='flat'))

    # ---- where no trunk may stand: carriageways (as drawn), rail, pitches, tracks, courts, car parks, beaches, pools
    nogo = Image.new('L', (N, N), 0); dn = ImageDraw.Draw(nogo)
    for L in lines:
        if L['kind'] in ('footway', 'path', 'steps', 'track', 'cycleway') or L['z']: continue
        dn.line([pix(*c) for c in L['pts']], fill=1, width=max(1, int(round((L['w'] + 0.6) / HR))), joint='curve')
    for k in ('pitch', 'track', 'parking', 'sand', 'pool', 'apron', 'plaza', 'playground', 'construction'):
        for p in polys.get(k, []):
            for g in (p.geoms if hasattr(p, 'geoms') else [p]):
                if g.geom_type == 'Polygon': dn.polygon([pix(*c) for c in g.exterior.coords], fill=1)
    nogo = np.array(nogo, bool)

    # ---- trees from the canopy
    trees = canopy_trees(dsm, dtm, fp, water_r, X0, Y0, rnd, polys, nogo)

    # ---- points the simulation uses: signals, crossings, stops, street lamps, benches, transit stops
    POI = {'traffic_signals': 0, 'crossing': 1, 'stop': 2, 'street_lamp': 3, 'bench': 4, 'bus_stop': 5, 'give_way': 6}
    pois = []
    for nid, (x, y), t in feat.get('nodes', []):
        k = t.get('highway') if t.get('highway') in POI else 'bench' if t.get('amenity') == 'bench' else 'bus_stop' if t.get('public_transport') == 'platform' and t.get('bus') == 'yes' else None
        if k and X0 <= x < X0 + L1 and Y0 <= y < Y0 + L1: pois.append((POI[k], nid, x, y))

    # ---- write the 16 detail tiles and the medium tile
    n = 0
    for a in range(4):
        for b in range(4):
            tx, ty = X0 + a * L0, Y0 + b * L0
            out = Out(tx, ty, L0)
            ti_, tj_ = i * 4 + a, j * 4 + b
            terr = terrain_grid(dtm, a * L0, (3 - b) * L0, L0, 65)
            if not write_tile(out, tx, ty, L0, terr, polys, lines, builds, trees, detail=True, pois=pois, water_only=sea[(3 - b) * 512:(4 - b) * 512, a * 512:(a + 1) * 512].all()):
                continue
            os.makedirs(f'{OUT}/0', exist_ok=True)
            open(f'{OUT}/0/{ti_}_{tj_}.bin', 'wb').write(out.bytes()); n += 1
    out = Out(X0, Y0, L1)
    terr = terrain_grid(dtm, 0, 0, L1, 65)
    write_tile(out, X0, Y0, L1, terr, polys, lines, builds, trees, detail=False, water_only=sea.all(), pois=[])
    os.makedirs(f'{OUT}/1', exist_ok=True)
    open(f'{OUT}/1/{i}_{j}.bin', 'wb').write(out.bytes())
    return ij, 'ok', round(time.time() - t0, 1), n, len(builds), len(trees)


def terrain_grid(dtm, ox, oy, size, n):
    """n x n heights (row 0 = south edge... no: row 0 = north) over size metres starting at raster offset (ox, oy) metres from the NW corner"""
    step = size / (n - 1)
    xs = (ox + np.arange(n) * step) / HR - 0.5
    ys = (oy + np.arange(n) * step) / HR - 0.5
    return ndimage.map_coordinates(dtm, np.meshgrid(ys, xs, indexing='ij'), order=1, mode='nearest').astype(np.float32)


# ---------------------------------------------------------------- buildings
STYLE = {  # 0 house, 1 apartments, 2 office/glass, 3 brick/heritage, 4 commercial/industrial, 5 civic/white
    'house': 0, 'detached': 0, 'semidetached_house': 0, 'bungalow': 0, 'cabin': 0, 'garage': 0, 'shed': 0, 'terrace': 0,
    'apartments': 1, 'residential': 1, 'dormitory': 1, 'hotel': 1,
    'office': 2, 'commercial': 4, 'retail': 4, 'industrial': 4, 'warehouse': 4, 'supermarket': 4, 'hangar': 4, 'service': 4,
    'school': 5, 'university': 5, 'college': 5, 'hospital': 5, 'church': 3, 'public': 5, 'civic': 5, 'government': 5, 'train_station': 5, 'stadium': 5,
}
ROOF = {'flat': 0, 'gabled': 1, 'hipped': 2, 'pyramidal': 3, 'dome': 4, 'skillion': 5, 'round': 6, 'half-hipped': 2, 'gambrel': 1, 'mansard': 2, 'onion': 4}
COLOURS = {'white': 0xf2f0ea, 'black': 0x303236, 'grey': 0x9a9c9e, 'gray': 0x9a9c9e, 'red': 0xb04a3a, 'brown': 0x7a5a48, 'beige': 0xd8c8a8, 'yellow': 0xe0c060,
           'blue': 0x5a80b0, 'green': 0x5a8a5a, 'silver': 0xc0c4c8, 'tan': 0xc8b090, 'cream': 0xeee4cc, 'orange': 0xd08040, 'darkgrey': 0x5a5c60,
           'lightgrey': 0xc8cacc, 'maroon': 0x7a2a2a, 'pink': 0xe0a8a8, 'teal': 0x4a9a9a}


def colour(v):
    if not v: return 0
    v = v.strip().lower().replace(' ', '')
    if v.startswith('#') and len(v) in (4, 7):
        h = v[1:]
        if len(h) == 3: h = ''.join(c * 2 for c in h)
        try: return int(h, 16) | 0x1000000
        except ValueError: return 0
    return (COLOURS[v] | 0x1000000) if v in COLOURS else 0


def obb(r):
    best = None
    for a_ in range(len(r)):
        (x1, y1), (x2, y2) = r[a_ - 1], r[a_]
        ang = math.atan2(y2 - y1, x2 - x1); ca, sa = math.cos(ang), math.sin(ang)
        us = [x * ca + y * sa for x, y in r]; vs = [-x * sa + y * ca for x, y in r]
        ar = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or ar < best[0]: best = (ar, ang, min(us), max(us), min(vs), max(vs))
    ar, ang, u0, u1, v0, v1 = best
    uc, vc = (u0 + u1) / 2, (v0 + v1) / 2
    cx, cy = uc * math.cos(ang) - vc * math.sin(ang), uc * math.sin(ang) + vc * math.cos(ang)
    hl, hw = (u1 - u0) / 2, (v1 - v0) / 2
    if hw > hl: ang += math.pi / 2; hl, hw = hw, hl
    return cx, cy, ang, hl, hw, ar


def ring_area(r):
    return abs(sum(r[k][0] * r[k - 1][1] - r[k - 1][0] * r[k][1] for k in range(len(r)))) / 2


def inset(r, d):
    s = 1 if sum(r[k - 1][0] * r[k][1] - r[k][0] * r[k - 1][1] for k in range(len(r))) > 0 else -1
    out = []
    for k in range(len(r)):
        (x0, y0), (x1, y1), (x2, y2) = r[k - 1], r[k], r[(k + 1) % len(r)]
        def nrm(ax, ay, bx, by):
            l = math.hypot(bx - ax, by - ay) or 1
            return (-(by - ay) / l * s, (bx - ax) / l * s)
        n1, n2 = nrm(x0, y0, x1, y1), nrm(x1, y1, x2, y2)
        mx, my = n1[0] + n2[0], n1[1] + n2[1]; ml = math.hypot(mx, my)
        if ml < 1e-6: out.append((x1, y1)); continue
        kk = min(3 * d, d / max(0.2, (mx * n1[0] + my * n1[1]) / ml))
        out.append((x1 + mx / ml * kk, y1 + my / ml * kk))
    return out


def buildings(items, dsm, dtm, X0, Y0, rnd):
    N = dtm.shape[0]
    pix = lambda x, y: ((x - X0) / HR, (Y0 + L1 - y) / HR)
    own = lambda c: X0 <= c[0] < X0 + L1 and Y0 <= c[1] < Y0 + L1
    rows = []
    parts_c = []
    for oid, prs, t in items:
        if 'building:part' in t and 'building' not in t:
            for outer, _ in prs: parts_c.append(np.mean(outer[:-1], axis=0))
    parts_c = np.array(parts_c) if parts_c else np.zeros((0, 2))
    seen = set()
    for oid, prs, t in items:
        for outer, inners in prs:
            r = outer[:-1] if outer[0] == outer[-1] else outer
            if len(r) < 3 or len(r) > 400: continue
            c = (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r))
            if not own(c): continue
            a = ring_area(r)
            if a < 4: continue
            is_part = 'building:part' in t and 'building' not in t
            if not is_part and len(parts_c):
                xs = [p[0] for p in r]; ys = [p[1] for p in r]
                sel = parts_c[(parts_c[:, 0] > min(xs)) & (parts_c[:, 0] < max(xs)) & (parts_c[:, 1] > min(ys)) & (parts_c[:, 1] < max(ys))]
                if len(sel) and any(Polygon(r).contains(shapely.geometry.Point(p)) for p in sel[:20]): continue  # parts carry the shape
            key = (round(c[0] * 2), round(c[1] * 2), round(a / 4))
            if key in seen: continue
            seen.add(key)
            rows.append((r, t, a, c, is_part))
    out = []
    for r, t, a, c, is_part in rows:
        # what the LiDAR saw inside the footprint
        img = Image.new('L', (N, N), 0)
        xs = [pix(*p) for p in r]
        bx0, by0 = max(0, int(min(p[0] for p in xs)) - 1), max(0, int(min(p[1] for p in xs)) - 1)
        bx1, by1 = min(N, int(max(p[0] for p in xs)) + 2), min(N, int(max(p[1] for p in xs)) + 2)
        if bx1 <= bx0 or by1 <= by0: continue
        m = Image.new('L', (bx1 - bx0, by1 - by0), 0)
        ImageDraw.Draw(m).polygon([(x - bx0, y - by0) for x, y in xs], fill=1)
        m = np.array(m, bool)
        if m.sum() > 12: m2 = ndimage.binary_erosion(m); m = m2 if m2.sum() > 4 else m
        ground = dtm[by0:by1, bx0:bx1][m] if m.any() else np.array([height_fallback(dtm, xs)])
        base = float(np.percentile(ground, 10)) if len(ground) else 0.0
        chm = (dsm[by0:by1, bx0:bx1][m] - base) if (dsm is not None and m.any()) else None
        tag_h = hnum(t.get('height')); lv = hnum(t.get('building:levels'))
        mn = hnum(t.get('min_height')) or (hnum(t.get('building:min_level')) or 0) * 3.1
        shape = t.get('roof:shape', '')
        btype = t.get('building', t.get('building:part', 'yes'))
        h, ridge = None, None
        if tag_h: h = tag_h
        elif chm is not None and len(chm) >= 3 and np.percentile(chm, 90) > 2.2:
            p90 = float(np.percentile(chm, 90)); p97 = float(np.percentile(chm, 97)); p25 = float(np.percentile(chm, 25)); p10 = float(np.percentile(chm, 10))
            h = p90
            if not shape and a < 450 and p97 < 16 and 1.4 < p97 - p25 < 6 and p25 > 2.2:  # a house's pitched roof, not a small tower
                shape = 'gabled' if rnd.random() < 0.6 else 'hipped'
                h, ridge = max(2.4, p25 + 0.3), p97
            elif not shape and a >= 450 and p90 - p10 > 8 and not is_part and len(chm) > 120:
                # tower on a podium: split by height and keep both parts
                secs = split_sections(r, dsm, base, bx0, by0, m, X0, Y0)
                if secs:
                    gid = rnd.randrange(1, 1 << 30)
                    for sr, sh in secs:
                        out.append(dict(ring=sr, base=base, h=sh + rnd.random() * 0.15, mn=0, roof=0, ridge=0, style=style_of(btype, sh, t, rnd), wall=colour(t.get('building:colour')),
                                        roofc=colour(t.get('roof:colour')), gid=gid, gh=p97, a=ring_area(sr)))
                    continue
        elif lv: h = lv * 3.1 + 1.0
        if h is None: h = 3.0 if btype in ('garage', 'shed', 'carport', 'roof') else (rnd.uniform(5, 8) if btype in ('house', 'detached') else 7.0)
        if lv and not tag_h and (chm is None or len(chm) < 3): h = lv * 3.1 + 1
        rf = ROOF.get(shape, 0) if shape else 0
        if rf and not ridge:
            rh = hnum(t.get('roof:height')) or (hnum(t.get('roof:levels')) or 0) * 2.8 or min(4.0, math.sqrt(a) * 0.25)
            ridge, h = h, max(2.4, h - rh)
        out.append(dict(ring=r, base=base, h=h + rnd.random() * 0.15, mn=mn, roof=rf, ridge=ridge or 0, style=style_of(btype, h, t, rnd),
                        wall=colour(t.get('building:colour')), roofc=colour(t.get('roof:colour')), gid=rnd.randrange(1, 1 << 30), gh=ridge or h, a=a))
    # City of Vancouver 2009 LiDAR sections are vector-exact: where they agree with today's heights, they win
    if SECTIONS:
        apply_sections(out, X0, Y0, rnd)
    for b in out: b['ring'] = inset(b['ring'], rnd.uniform(0.03, 0.3))
    return out


def height_fallback(dtm, xs):
    x, y = xs[0]
    return float(dtm[int(min(dtm.shape[0] - 1, max(0, y))), int(min(dtm.shape[1] - 1, max(0, x)))])


def style_of(btype, h, t, rnd):
    s = STYLE.get(btype)
    if s is None: s = 0 if h < 9 else 1 if h > 14 else 4
    if s == 1 and h > 40 and rnd.random() < 0.3: s = 2
    if t.get('building:material') in ('brick',) : s = 3
    if t.get('building:material') in ('glass',) : s = 2
    return s


def split_sections(r, dsm, base, bx0, by0, m, X0, Y0):
    import rasterio.features as rf
    from rasterio.transform import Affine
    z = dsm[by0:by0 + m.shape[0], bx0:bx0 + m.shape[1]] - base
    v = z[m]
    lo, hi = np.percentile(v, 25), np.percentile(v, 95)
    cut = (lo + hi) / 2
    top = m & (z > cut)
    top = ndimage.binary_opening(top, iterations=1)
    if top.sum() < 25 or (m & ~top).sum() < 25: return None
    tr = Affine(HR, 0, X0 + bx0 * HR, 0, -HR, Y0 + L1 - by0 * HR)
    secs = [(r, float(np.percentile(z[m & ~top], 75)))]
    for g, val in rf.shapes(top.astype(np.uint8), mask=top, transform=tr):
        p = shapely.geometry.shape(g).simplify(1.2)
        if p.area < 60: continue
        _, _, _, _, _, ar = obb(list(p.exterior.coords)[:-1])
        if p.area / ar > 0.82: p = p.minimum_rotated_rectangle
        if p.geom_type != 'Polygon': continue
        ring = list(p.exterior.coords)[:-1]
        inside = np.zeros_like(m)
        secs.append((ring, float(np.percentile(z[top], 85))))
    return secs if len(secs) > 1 else None


SEC_INDEX = None


def apply_sections(out, X0, Y0, rnd):
    global SEC_INDEX
    if SEC_INDEX is None:
        SEC_INDEX = {}
        for r, hg, rt in SECTIONS:
            cx, cy = sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)
            SEC_INDEX.setdefault((int(cx // L1), int(cy // L1)), []).append((r, hg, rt, cx, cy))
    secs = SEC_INDEX.get((int(X0 // L1), int(Y0 // L1)), [])
    if not secs: return
    from shapely.strtree import STRtree
    polys = [Polygon(b['ring']).buffer(0) for b in out]
    tree = STRtree(polys)
    by_b = {}
    for r, hg, rt, cx, cy in secs:
        hits = tree.query(shapely.geometry.Point(cx, cy), predicate='within')
        if len(hits): by_b.setdefault(int(hits[0]), []).append((r, hg, rt))
    new = []
    drop = set()
    for k, segs in by_b.items():
        b = out[k]
        cov = sum(ring_area(s[0]) for s in segs) / max(1.0, b['a'])
        top = max(s[1] for s in segs)
        if cov < 0.6 or b['mn'] > 0 or abs(top - b['gh']) > max(6, 0.3 * b['gh']): continue  # rebuilt since 2009, or a mismatch
        drop.add(k)
        for r, hg, rt in segs:
            rf_, ridge, hh = 0, 0, hg
            if rt == 'pitched' and hg < 16:
                cx, cy, ang, hl, hw, ar = obb(r)
                if ring_area(r) / ar > 0.75 and hw > 2: rf_, ridge, hh = (1 if hl / hw > 1.15 else 2), hg, max(2.6, hg - min(hw * 0.9, 3.5))
            new.append(dict(b, ring=r, h=hh + rnd.random() * 0.15, roof=rf_, ridge=ridge, a=ring_area(r)))
    out[:] = [b for k, b in enumerate(out) if k not in drop] + new


# ---------------------------------------------------------------- trees
def canopy_trees(dsm, dtm, fp, water, X0, Y0, rnd, polys, nogo):
    if dsm is None: return []
    N = dtm.shape[0]
    chm = ndimage.gaussian_filter(np.nan_to_num(dsm - dtm), 0.7)
    blocked = ndimage.binary_dilation(fp, iterations=1) | water | nogo
    ok = (chm > 3.0) & ~(ndimage.binary_dilation(fp, iterations=1) | water)
    d_free, (fi, fj) = ndimage.distance_transform_edt(blocked, return_indices=True)
    mx = ndimage.maximum_filter(chm, size=5)
    peaks = ok & (chm >= mx - 1e-3)
    ys, xs = np.nonzero(peaks)
    hs = chm[ys, xs]
    # thin crowded peaks: keep the tallest within the crown radius
    order = np.argsort(-hs)
    taken = np.zeros((N // 2 + 2, N // 2 + 2), np.int32) - 1
    keep = []
    for k in order:
        y, x, h = ys[k], xs[k], hs[k]
        rad = max(1.5, min(7.5, 0.22 * h + 1.0)) * 0.7 / HR
        y0, x0 = max(0, int(y - rad)), max(0, int(x - rad))
        if peaks[y0:int(y + rad) + 1, x0:int(x + rad) + 1].sum() > 1:
            ring = peaks[y0:int(y + rad) + 1, x0:int(x + rad) + 1]
        cy, cx = y // 2, x // 2
        if taken[max(0, cy - 1):cy + 2, max(0, cx - 1):cx + 2].max() >= 0 and h < 12: continue
        if blocked[y, x]:  # a crown over the road: its trunk stands on the nearest kerb, if one is close
            if d_free[y, x] * HR > 5: continue
            y, x = fi[y, x], fj[y, x]
        taken[cy, cx] = len(keep)
        keep.append((X0 + (x + 0.5) * HR, Y0 + L1 - (y + 0.5) * HR, float(h)))
    # species: the city's inventory where it has the tree, else a guess from the crown and the land cover
    near = {}
    for x, y, genus, common, h in TREES:
        if X0 - 5 <= x < X0 + L1 + 5 and Y0 - 5 <= y < Y0 + L1 + 5: near.setdefault((int(x // 4), int(y // 4)), []).append((x, y, genus, h))
    forest = unary_union(polys.get('forest', [])) if polys.get('forest') else None
    out = []
    used = set()
    for x, y, h in keep:
        g = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for c in near.get((int(x // 4) + dx, int(y // 4) + dy), []):
                    if math.hypot(c[0] - x, c[1] - y) < 4.5 and id(c) not in used: g = c; break
                if g: break
            if g: break
        if g:
            used.add(id(g)); shape, col = tree_look(g[2], rnd)
        else:
            py, px_ = int((Y0 + L1 - y) / HR), int((x - X0) / HR)
            ring = chm[max(0, py - 2):py + 3, max(0, px_ - 2):px_ + 3]
            peaky = (h - ring.mean()) / max(1, h)
            conifer = h > 24 or peaky > 0.22 or h > 14 and rnd.random() < 0.5
            if conifer: shape, col = rnd.choice((4, 4, 4, 5, 5, 6)), rnd.choice((5, 5, 7, 6))
            else: shape, col = rnd.choice((0, 0, 0, 2, 1, 3)), rnd.choice((0, 0, 0, 0, 7, 1, 2, 4))
        out.append((x, y, shape, col, min(63.0, h)))
    # young street trees the LiDAR can't see yet
    for cell, lst in near.items():
        for c in lst:
            if id(c) in used or c[3] > 9: continue
            if not (X0 <= c[0] < X0 + L1 and Y0 <= c[1] < Y0 + L1): continue
            py, px_ = int((Y0 + L1 - c[1]) / HR), int((c[0] - X0) / HR)
            if 0 <= py < N and 0 <= px_ < N and blocked[py, px_]: continue
            shape, col = tree_look(c[2], rnd)
            out.append((c[0], c[1], shape, col, c[3]))
    return out


# ---------------------------------------------------------------- roads, paths, rail
def road_pieces(items, dsm, dtm, X0, Y0):
    """pieces split at junctions: dict(kind, pts [(x,y)], z [..] or None, lanes, width, oneway, band, layer, a, b (node ids), name)"""
    use = {}
    ways = []
    for wid, coords, refs, t in items:
        k = line_kind(t)
        if not k: continue
        if t.get('tunnel') in ('yes', 'building_passage', 'culvert') or t.get('covered') == 'yes' and k in ('rail', 'lightrail'): continue
        if t.get('area') == 'yes': continue
        ways.append((wid, coords, refs, t, k))
        for r in refs: use[r] = use.get(r, 0) + 1
        use[refs[0]] += 1; use[refs[-1]] += 1
    out = []
    N = dtm.shape[0]
    for wid, coords, refs, t, k in ways:
        lanes, w, ow, band = road_shape(k, t)
        if t.get('oneway') == '-1': coords, refs = coords[::-1], refs[::-1]
        bridge = t.get('bridge') not in (None, 'no')
        cut = [0] + [n for n in range(1, len(refs) - 1) if use.get(refs[n], 0) >= 2] + [len(refs) - 1]
        for a, b in zip(cut, cut[1:]):
            pts = coords[a:b + 1]
            mid = pts[len(pts) // 2]
            if not (X0 <= mid[0] < X0 + L1 and Y0 <= mid[1] < Y0 + L1): continue
            z = None
            if bridge or k == 'lightrail' and t.get('bridge'):
                pts = densify(pts, 25)  # a long straight span needs points along it to carry its arch
                z = deck_heights(pts, dsm, dtm, X0, Y0)
            out.append(dict(own=mid, kind=k, pts=pts, z=z, lanes=lanes, w=w, ow=ow, band=band, layer=int(hnum(t.get('layer')) or 0), a=refs[a], b=refs[b],
                            name=t.get('name', ''), drive=k in DRIVE and t.get('access') not in ('private', 'no'),
                            crossing=k in ('footway', 'cycleway', 'path') and (t.get('footway') == 'crossing' or t.get('cycleway') == 'crossing') and t.get('crossing') not in ('unmarked', 'no')))
    return out


HR_CACHE = {}


def dsm_at(x, y):
    """the LiDAR surface at a world point, from whichever 4 km HRDEM tile has it (a bridge can span several)"""
    i, j = int(x // L1), int(y // L1)
    if (i, j) not in HR_CACHE:
        p = f'data/hr/{i}_{j}.npz'
        d = np.load(p) if os.path.exists(p) else None
        HR_CACHE[(i, j)] = d['dsm'] if d is not None and 'dsm' in d else None
        if len(HR_CACHE) > 12: HR_CACHE.pop(next(iter(HR_CACHE)))
    a = HR_CACHE.get((i, j))
    if a is None: return None
    r, c = int((( j + 1) * L1 - y) / HR), int((x - i * L1) / HR)
    win = a[max(0, r - 1):r + 2, max(0, c - 1):c + 2]
    win = win[np.isfinite(win)]
    return float(np.percentile(win, 30)) if win.size else None


def deck_heights(pts, dsm, dtm, X0, Y0):
    """a bridge deck's height along its centre line from the LiDAR surface (low percentile: cables, cars and towers
    sit above it), median-filtered; None if there is no LiDAR"""
    dpts = densify(pts, 4)
    zs = [dsm_at(x, y) for x, y in dpts]
    if all(z is None for z in zs): return None
    good = [z for z in zs if z is not None]
    zs = np.array([z if z is not None else float(np.median(good)) for z in zs])
    zs = ndimage.median_filter(zs, size=9, mode='nearest')
    s = np.cumsum([0] + [math.dist(dpts[k], dpts[k - 1]) for k in range(1, len(dpts))])
    vs = np.cumsum([0] + [math.dist(pts[k], pts[k - 1]) for k in range(1, len(pts))])
    return [float(np.interp(v, s, zs)) for v in vs]


def deck_heights_old(pts, dsm, dtm, X0, Y0):
    """a bridge deck's height along its centre line from the LiDAR surface (lower values: cables, cars and towers sit above)"""
    if dsm is None: return None
    N = dsm.shape[0]
    zs = []
    for x, y in densify(pts, 4):
        px_, py = (x - X0) / HR, (Y0 + L1 - y) / HR
        r, c = int(py), int(px_)
        win = dsm[max(0, r - 1):min(N, r + 2), max(0, c - 1):min(N, c + 2)]
        zs.append(float(np.percentile(win, 30)) if win.size else 0.0)
    zs = ndimage.median_filter(np.array(zs), size=5, mode='nearest')
    # back onto the original vertices
    dpts = densify(pts, 4); s = np.cumsum([0] + [math.dist(dpts[k], dpts[k - 1]) for k in range(1, len(dpts))])
    vs = np.cumsum([0] + [math.dist(pts[k], pts[k - 1]) for k in range(1, len(pts))])
    return [float(np.interp(v, s, zs)) for v in vs]


def densify(pts, step):
    out = [pts[0]]
    for p, q in zip(pts, pts[1:]):
        L = math.dist(p, q); n = max(1, int(L / step))
        for k in range(1, n + 1): out.append((p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n))
    return out


# ---------------------------------------------------------------- tile writer
def pack_ring(out, ring):
    """ring -> count + delta-encoded int16 points (first absolute)"""
    q = [out.q(x, y) for x, y in ring]
    b = bytearray(struct.pack('<I', len(q)))
    px_, py_ = 0, 0
    for x, y in q:
        dx, dy = x - px_, y - py_
        b += struct.pack('<hh', max(-32768, min(32767, dx)), max(-32768, min(32767, dy)))
        px_, py_ = x, y
    return b


def write_tile(out, tx, ty, size, terr, polys, lines, builds, trees, detail, water_only, pois=()):
    tb = box(tx, ty, tx + size, ty + size)
    n = terr.shape[0]
    out.section('TERR', struct.pack('<H', n) + np.clip(np.round(terr * 10), -32768, 32767).astype('<i2').tobytes())
    # ground: per class, the union clipped to the tile, as polygons (rings); the page triangulates and drapes them
    gb = bytearray(); runs = 0
    tol, min_area = (0.25, 4) if detail else (4.0, 600)
    wat = [p for p in polys.get('water', []) if p.intersects(tb)]
    water_u = unary_union(wat) if wat else None
    land_base = tb.difference(water_u) if wat else tb  # land and water meet edge to edge, never overlap
    # per class: the union clipped to the tile and simplified, small bits dropped (the class below fills in)
    per = {}
    for k in GROUND:
        src = [land_base] if k == 'land' else polys.get(k, [])
        cand = [p for p in src if p.intersects(tb)]
        if not cand: continue
        try: g = unary_union(cand).intersection(tb)
        except Exception: g = unary_union([c.buffer(0) for c in cand]).intersection(tb)
        if wat and k not in ('water', 'pier', 'land') and k not in ('road', 'arterial', 'sidewalk', 'blvd', 'walk', 'cycle', 'trail', 'ballast'): g = g.difference(water_u)
        g = g.simplify(tol)
        if k != 'land':
            parts = [p for p in (g.geoms if hasattr(g, 'geoms') else [g]) if p.geom_type == 'Polygon' and p.area >= min_area]
            if not parts: continue
            g = unary_union(parts)
        per[k] = g
    # one non-overlapping layer: each class keeps what no class above it covers (no z-fighting anywhere)
    covered = None
    for k in reversed(GROUND):
        if k not in per: continue
        g = per[k]
        mine = g if covered is None else g.difference(covered)
        covered = g if covered is None else covered.union(g)
        per[k] = mine
    for k in GROUND:
        if k not in per: continue
        g = per[k]
        geoms = [p for p in (g.geoms if hasattr(g, 'geoms') else [g]) if p.geom_type == 'Polygon' and p.area >= 0.01]
        if not geoms: continue
        body = bytearray()
        for p in geoms:
            rings = [list(p.exterior.coords)[:-1]] + [list(r.coords)[:-1] for r in p.interiors]
            rings = [r for r in rings if len(r) >= 3]
            body += struct.pack('<H', len(rings))
            for r in rings: body += pack_ring(out, r)
        gb += struct.pack('<BI', GI[k], len(geoms)) + body
        runs += 1
    out.section('GRND', struct.pack('<H', runs) + bytes(gb))
    # lines, with a node table so pieces can join across tiles
    sel = []
    for L in lines:
        if not detail and (KI[L['kind']] >= KI['service'] and L['kind'] not in ('rail', 'lightrail', 'runway', 'taxiway')): continue
        mid = L['own']  # the point that decided which 4 km tile owns the piece
        if tx <= mid[0] < tx + size and ty <= mid[1] < ty + size: sel.append(L)
    nodes = {}
    for L in sel:
        for nid in (L['a'], L['b']): nodes.setdefault(nid, len(nodes))
    lb = bytearray(struct.pack('<I', len(nodes)))
    for nid in nodes: lb += struct.pack('<Q', nid)
    lb += struct.pack('<I', len(sel))
    for L in sel:
        pts = L['pts'] if detail or len(L['pts']) <= 2 else list(LineString(L['pts']).simplify(1.5).coords)
        z = L['z'] if detail and L['z'] and len(pts) == len(L['pts']) else None
        flags = (1 if L['ow'] else 0) | (2 if L['band'] else 0) | (4 if z else 0) | (8 if L['drive'] else 0) | (16 if L.get('crossing') else 0)
        lb += struct.pack('<BBBbHII', KI[L['kind']], min(255, L['lanes']), flags, max(-8, min(7, L['layer'])), int(min(655, L['w']) * 100), nodes[L['a']], nodes[L['b']])
        lb += pack_ring(out, pts)
        if z: lb += np.round(np.array(z) * 10).astype('<i2').tobytes()
    out.section('LINE', bytes(lb))
    # buildings: compact header, optional fields behind flags
    bb = bytearray(); nb = 0
    for b in builds:
        r = b['ring']
        c = (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r))
        if not (tx <= c[0] < tx + size and ty <= c[1] < ty + size): continue
        if not detail:
            if b['a'] < 60 and b['gh'] < 12: continue
            p = Polygon(r)
            if len(r) > 4:
                _, _, _, _, _, ar = obb(r)
                if p.area / ar > 0.86: r = list(p.minimum_rotated_rectangle.exterior.coords)[:-1]
                else:
                    sp = p.simplify(1.5)
                    if sp.geom_type == 'Polygon' and len(sp.exterior.coords) > 3: r = list(sp.exterior.coords)[:-1]
        b['mn'] = max(0.0, b['mn'] or 0.0); b['h'] = max(0.5, b['h'])
        fl = (1 if b['mn'] else 0) | (2 if b['roof'] else 0) | (4 if b['wall'] else 0) | (8 if b['roofc'] else 0) | (16 if abs(b['gh'] - b['h']) > 0.5 else 0)
        bb += struct.pack('<BBhH', fl, b['style'], int(round(b['base'] * 10)), int(min(6000, b['h'] * 10)))
        if fl & 1: bb += struct.pack('<H', int(max(0, min(6000, b['mn'] * 10))))
        if fl & 2: bb += struct.pack('<BH', b['roof'], int(min(6000, b['ridge'] * 10)))
        if fl & 4: bb += struct.pack('<I', b['wall'] & 0xffffff)
        if fl & 8: bb += struct.pack('<I', b['roofc'] & 0xffffff)
        if fl & 16: bb += struct.pack('<HI', int(min(6000, b['gh'] * 10)), b['gid'])
        bb += pack_ring(out, r)
        nb += 1
    out.section('BLDG', struct.pack('<I', nb) + bytes(bb))
    tr_ = bytearray(); nt = 0
    for x, y, shape, col, h in trees:
        if not (tx <= x < tx + size and ty <= y < ty + size): continue
        if not detail and (h < 9 or (hash((round(x), round(y))) & 3)): continue
        tr_ += struct.pack('<hhBBB', *out.q(x, y), shape, col, int(min(63, h) * 4)); nt += 1
    out.section('TREE', struct.pack('<I', nt) + bytes(tr_))
    pb = bytearray(); npo = 0
    for k, nid, x, y in pois:
        if tx <= x < tx + size and ty <= y < ty + size: pb += struct.pack('<BQhh', k, nid, *out.q(x, y)); npo += 1
    out.section('POIS', struct.pack('<I', npo) + bytes(pb))
    return runs > 0 or nb > 0 or len(sel) > 0


def safe_build(ij):
    import traceback
    try: return build(ij)
    except Exception: return ij, 'FAILED', traceback.format_exc().splitlines()[-1]


def all_tiles():
    x0, y0, x1, y1 = EX
    return [(i, j) for i in range(int(x0 // L1), int(x1 // L1) + 1) for j in range(int(y0 // L1), int(y1 // L1) + 1)]


def write_index():
    ls = lambda lv: sorted(f[:-4] for f in os.listdir(f'{OUT}/{lv}') if f.endswith('.bin')) if os.path.isdir(f'{OUT}/{lv}') else []
    json.dump({'version': VERSION, 'origin': [LAT_O, LON_O], 'k': [KX, KY], 'extent': EX, 'sizes': [L0, L1], 'ground': GROUND, 'kinds': KINDS,
               'l0': ls(0), 'l1': ls(1), 'built': int(time.time())}, open(f'{OUT}/index.json', 'w'))

if __name__ == '__main__':
    procs = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    want = [tuple(map(int, a.split('_'))) for a in sys.argv[2:]] or all_tiles()
    t0 = time.time()
    if procs == 1:
        for ij in want: print(safe_build(ij), flush=True)
    else:
        with Pool(procs) as p:
            for r in p.imap_unordered(safe_build, want): print(r, round(time.time() - t0), 's', flush=True)
    write_index()

