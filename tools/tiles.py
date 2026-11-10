# Step 3: the map tiles. For every 4096 m tile with data, writes sixteen 1024 m detail tiles (public/tiles/0/)
# and one 4096 m medium tile (public/tiles/1/), each a small gzipped binary the page streams in as you look
# around. Format: Out below, read by parse() in public/core/tile-worker.js. Inputs: data/feat (osm_split.py), data/hr (hrdem.py),
# data/sea.npz (sea.py), City of Vancouver trees + 2009 LiDAR sections, MRDEM where HRDEM has no data.
# Run: uv run --with numpy,scipy,pillow,shapely,rasterio python3 tools/tiles.py [procs] [i_j ...]
import csv, gzip, json, math, os, pickle, random, struct, sys, time
from functools import lru_cache
from multiprocessing import Pool
import numpy as np
import shapely
from shapely.geometry import Polygon, box, LineString, Point
from shapely.ops import unary_union
from PIL import Image, ImageDraw
from scipy import ndimage
sys.path.insert(0, os.path.dirname(__file__))
from common import digest, file_digest, files_digest, code_key, code_data, cpu_slot, write_if_changed, manifest, save_manifest, write_index, VERSION, GROUND, GI, xy, extent, L0, L1, KX, KY, LAT_O, LON_O, HR, KINDS, KI, DRIVE, SHOP_AMENITY, line_kind, hnum, densify, all_tiles, HR_CACHE, hr_lookup, tile_args, load_feat, tube_h, SLAB, FINE, FB, fine_grid, under_reach
from roofs import roof_lookup, valid_poly
from facades import facade_lookup, NONE as B_NONE, GLASS as B_GLASS, SOLID as B_SOLID
from lidar_massing import massing_lookup, walls_near
from geom_rules import apply_rules, summary, selftest as rules_selftest

OUT = os.environ.get('OUT', 'public/tiles')



def ground_class(t):
    g = lambda k: t.get(k, '')
    if g('natural') == 'water' or g('waterway') in ('riverbank', 'dock') or 'water' in t and g('natural') != 'coastline' and g('water') != '' and g('natural') in ('', 'water'):
        return 'water'
    if (g('leisure') == 'swimming_pool' or g('amenity') == 'swimming_pool') and g('indoor') != 'yes' and g('covered') != 'yes' and g('location') not in ('indoor', 'underground'): return 'pool'
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


# ---------------------------------------------------------------- roads and other lines (kinds: common.py)
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
        return gzip.compress(bytes(self.b), 7, mtime=0)  # no time stamp: the same tile is the same bytes


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
    """City of Vancouver public trees: (x, y, genus, common name and cultivar, height)"""
    out = []
    with open('data/trees.csv', encoding='utf-8-sig') as fh:
        for row in csv.DictReader(fh, delimiter=';'):
            try: lat, lon = map(float, row['geo_point_2d'].split(','))
            except ValueError: continue
            x, y = xy(lat, lon)
            out.append((x, y, row['genus_name'], f"{row['common_name']} {row.get('cultivar_name') or ''}".upper(), float(row['height_m'] or 0) or 8.0))
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
BEACH = np.load('data/beachlogs.npz') if os.path.exists('data/beachlogs.npz') else None  # tools/beachlogs.py
import seawall
WALLS = [(P, top, foot, reach, seawall.ends(P), rail, gw) for (P, top, reach, rail, foot), gw in zip(seawall.runs(), seawall.walk_grounds())]  # tools/seawall.py, optional
KIT = np.load(seawall.OUT)['kit'] if os.path.exists(seawall.OUT) else np.zeros((0, 4))  # the beach things OSM maps (tools/seawall.py amenities)
print('inputs ready', len(TREES), 'city trees', len(SECTIONS), 'lidar sections', flush=True)


# ---------------------------------------------------------------- tree species -> form and autumn colour
# forms (public/core/treeforms.js): 0 round, 1 columnar, 2 spreading, 3 weeping, 4 fir, 5 cedar, 6 pine, 7 palm, 8 vase
SHAPE = {
    'ACER': 0, 'PRUNUS': 0, 'MALUS': 0, 'TILIA': 0, 'FRAXINUS': 0, 'QUERCUS': 2, 'CARPINUS': 0, 'BETULA': 3, 'SALIX': 3, 'ULMUS': 8,
    'AESCULUS': 2, 'FAGUS': 2, 'PLATANUS': 2, 'LIQUIDAMBAR': 0, 'GLEDITSIA': 8, 'GINKGO': 1, 'POPULUS': 1, 'CERCIDIPHYLLUM': 0,
    'PYRUS': 0, 'SORBUS': 0, 'CORNUS': 2, 'MAGNOLIA': 0, 'STYRAX': 2, 'PARROTIA': 2, 'NYSSA': 0, 'ZELKOVA': 8, 'CATALPA': 2,
    'CRATAEGUS': 0, 'ROBINIA': 2, 'LIRIODENDRON': 0, 'CERCIS': 2, 'ALNUS': 0, 'AMELANCHIER': 0, 'SYRINGA': 0, 'JUGLANS': 2,
    'THUJA': 5, 'CHAMAECYPARIS': 5, 'CALOCEDRUS': 5, 'CUPRESSOCYPARIS': 5, 'SEQUOIADENDRON': 4, 'SEQUOIA': 4, 'METASEQUOIA': 4,
    'PSEUDOTSUGA': 4, 'PICEA': 4, 'ABIES': 4, 'TSUGA': 5, 'TAXODIUM': 4, 'CEDRUS': 5, 'PINUS': 6, 'ARAUCARIA': 6, 'TAXUS': 5,
    'TRACHYCARPUS': 7, 'ARBUTUS': 2,
}
# the cultivar or common name says more than the genus: Pyramidal European hornbeams, columnar Norway maples, Dawyck
# beeches, Lombardy poplars; weeping cherries and willows; Kwanzan cherries grow as vases, globe maples as balls
LOOK_WORDS = ((1, ('FASTIGIAT', 'COLUMN', 'PYRAMIDAL', 'SENTINEL', 'DAWYCK', 'UPRIGHT', 'ITALICA', 'LOMBARDY', 'ARMSTRONG', 'BOWHALL', 'SKYROCKET', 'SPIRE', 'CHANTICLEER', 'SLENDER')),
              (3, ('WEEPING', 'PENDUL')), (8, ('KWANZAN',)), (0, ('GLOBE', 'GLOBOSUM', 'UMBRACULIFERA')))
# colour families (indices into the page's palette, see public/core/trees.js): 0 green, 1 yellow, 2 orange, 3 red, 4 brown,
# 5 dark conifer, 6 blue-green conifer, 7 forest green, 8 bare-ish (late), 9 cherry
AUTUMN = {
    'ACER': (3, 2, 1), 'PRUNUS': (2, 3), 'MALUS': (1, 0), 'TILIA': (1, 0), 'FRAXINUS': (1, 8), 'QUERCUS': (4, 0), 'CARPINUS': (1, 0),
    'BETULA': (1,), 'SALIX': (0, 1), 'ULMUS': (1, 0), 'AESCULUS': (4, 2), 'FAGUS': (4, 2), 'PLATANUS': (4, 1), 'LIQUIDAMBAR': (3, 2),
    'GLEDITSIA': (1,), 'GINKGO': (1,), 'POPULUS': (1,), 'CERCIDIPHYLLUM': (2, 1), 'PYRUS': (3, 2), 'SORBUS': (2, 3), 'CORNUS': (3,),
    'PARROTIA': (2, 3), 'NYSSA': (3,), 'ZELKOVA': (2, 4), 'STYRAX': (1,), 'MAGNOLIA': (0, 4), 'ARBUTUS': (0,),
    'CRATAEGUS': (3, 2), 'ROBINIA': (1,), 'LIRIODENDRON': (1, 2), 'CERCIS': (1,), 'AMELANCHIER': (3, 2), 'JUGLANS': (1, 4),
}


def tree_look(genus, rnd, name='', wh=None):
    """form and colour family of a tree of this genus (and common name + cultivar); wh: its crown's width / height
    from the LiDAR, which makes a broad round-headed tree spreading and a narrow spreading one round"""
    g = (genus or '').upper()
    shape = SHAPE.get(g)
    if shape is None: shape = 0
    for f, words in LOOK_WORDS:
        if shape < 4 and any(w in name for w in words): shape = f; break
    else:
        if wh is not None and shape == 0 and wh > 1.25: shape = 2
        elif wh is not None and shape == 2 and wh < 0.7: shape = 0
    if shape >= 4:
        return shape, 6 if g in ('PICEA', 'CEDRUS') else 5
    if g == 'PRUNUS': return shape, 9  # cherries and plums: autumn's red, blossom in spring (the page's palette)
    fam = AUTUMN.get(g)
    if fam is None: return shape, 0 if rnd.random() < 0.6 else rnd.choice((1, 2, 4))
    return shape, fam[0] if rnd.random() < 0.7 else rnd.choice(fam + (0,))


# ---------------------------------------------------------------- per 4096 m tile
def build(ij):
    i, j = ij
    t0 = time.time()
    rnd = random.Random(i * 7919 + j)
    feat = load_feat(i, j)
    deck_profiles()
    if feat.get('lines'): feat['lines'] = retunnel(feat['lines'])  # (the tunnels as far as their mouths)
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
    if sea.all() and not feat.get('lines') and not feat.get('buildings'):
        for p in [f'{OUT}/0/{i * 4 + a}_{j * 4 + b}.bin' for a in range(4) for b in range(4)] + [f'{OUT}/1/{i}_{j}.bin']:
            if os.path.exists(p): os.remove(p)  # baked before the sea took it
        return ij, 'sea', 0
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
    dtm = flat_water(dtm, sea, water_r)

    # bridge decks and viaducts overhead: the LiDAR surface there is the deck, so no roofs or tree crowns from it
    under = bridge_mask(feat.get('lines', []), areas, X0, Y0, N)
    if dsm is not None: dsm = np.where(under, dtm, dsm)

    def height_at(x, y):  # bilinear on the 2 m DTM
        fx_, fy_ = (x - X0) / HR - 0.5, (Y0 + L1 - y) / HR - 0.5
        return float(ndimage.map_coordinates(dtm, [[fy_], [fx_]], order=1, mode='nearest')[0])

    # ---- canopy as forest: where the LiDAR sees trees over 6 m in a sizeable patch, the ground is woods (most of the
    # North Shore, Pacific Spirit, Stanley Park and every big back-yard grove is mapped only partly in OSM)
    if dsm is not None:
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
    from shapely.strtree import STRtree
    sp = [p for _, p, t in feat.get('nodes', []) if 'shop' in t or 'office' in t or 'craft' in t or t.get('amenity') in SHOP_AMENITY]
    shops = STRtree(shapely.points(np.array(sp))) if sp else None
    ind = unary_union(polys['industrial']) if polys.get('industrial') else None
    if ind is not None: shapely.prepare(ind)
    sl = [LineString(c) for _, c, _, t in feat.get('lines', []) if line_kind(t) in ('residential', 'tertiary', 'secondary', 'primary', 'living') and len(c) > 1]
    # what stands on roofs: outdoor pools and solar panels (OSM generator:source=solar, as areas or points)
    sol = [Polygon(o) for _, prs, t in feat.get('areas', []) if t.get('generator:source') == 'solar' for o, _ in prs if len(o) >= 4] \
        + [shapely.geometry.Point(p) for _, p, t in feat.get('nodes', []) if t.get('generator:source') == 'solar']
    tops = (STRtree(polys['pool']) if polys.get('pool') else None, STRtree(sol) if sol else None)
    builds = buildings(feat.get('buildings', []), dsm, dtm, X0, Y0, rnd, under, shops, ind, STRtree(sl) if sl else None, tops)
    fp = Image.new('L', (N, N), 0); dfp = ImageDraw.Draw(fp)
    for b in builds:
        dfp.polygon([pix(*c) for c in b['ring']], fill=1)
    fp = np.array(fp, bool)

    # ---- lines
    lines = road_pieces(feat.get('lines', []), dsm, dtm, X0, Y0)
    # roads on roofs: the roof is their deck (its LiDAR height has the parked cars and lamps on it), so down to the deck
    rd = [L for L in lines if L.get('roof') and L['z']]
    if rd:
        tree = STRtree([LineString(L['pts']) for L in rd])
        for b in builds:
            P = Polygon(b['ring']); top = b['base'] + b['h']
            zs = []
            for q in tree.query(P, predicate='intersects'):
                Q = np.array(densify(rd[q]['pts'], 4)); line = LineString(rd[q]['pts'])
                s_ = np.array([line.project(shapely.geometry.Point(p)) for p in rd[q]['pts']]); sq = np.array([line.project(shapely.geometry.Point(p)) for p in Q])
                zs += list(np.interp(sq, s_, rd[q]['z'])[shapely.contains_xy(P, Q[:, 0], Q[:, 1])])
            if zs and top - 4 < min(zs) < top + 1 and not b['roof']: b['h'] = max(0.5, min(zs) - b['base']); b['units'] = []
    # streets as ground: carriageways, sidewalks and boulevards, paths and rail beds, unioned per class so junctions
    # are clean (bridges are raised decks, drawn from the lines)
    # every piece that touches this tile, not only those it owns: a street crossing the tile edge is paved on
    # both sides of it
    for L in road_pieces(feat.get('lines', []), dsm, dtm, X0, Y0, own=False):
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

    # ---- tunnel portals: where a tunnel's roof isn't under the ground the ground is cut and the page draws its box
    cuts, lids = [], []
    for wid, c, _, t in feat.get('lines', []):
        if wid not in TUNNELS: continue
        P, s, z, op = TUNNELS[wid]
        lids += [(x, y, h + tube_h(line_kind(t)) + SLAB) for (x, y), h in zip(P[op], z[op])]
        k = np.nonzero(op[:-1] & op[1:])[0]
        if len(k): cuts.append(shapely.MultiLineString([P[r[0]:r[-1] + 2] for r in np.split(k, np.nonzero(np.diff(k) > 1)[0] + 1)])
                                .buffer(road_shape(line_kind(t), t)[1] / 2 + 0.6 + SLAB, cap_style='flat', join_style='mitre'))
    holes = unary_union(cuts) if cuts else None
    if holes is not None:  # a building over a portal's box (a tunnel's control building) stands on its roof
        shapely.prepare(holes); L_ = np.array(lids)
        for b in builds:
            B = Polygon(b['ring'])
            if not holes.intersects(B) or holes.intersection(B.buffer(0)).area < 0.5 * B.area: continue  # mostly beside the box: on the ground (a mall, a parkade by a portal)
            on = L_[shapely.contains_xy(B.buffer(4), L_[:, 0], L_[:, 1])]
            if len(on): b['mn'] = max(b['mn'] or 0.0, float(on[:, 2].max()) - b['base']); b['lid'] = True
        builds = [b for b in builds if (b['mn'] or 0) < b['h'] - 1]

    # ---- docks: piers and floating docks mapped as lines (a marina's walkways and fingers) are decks on the water;
    # the boats berthed along them in marinas
    docks = []
    for _, c, _, t in feat.get('lines', []):
        if t.get('man_made') != 'pier' or len(c) < 2 or t.get('highway') and t['highway'] not in ('footway', 'path'): continue
        ls = LineString(c)
        w = hnum(t.get('width')) or (3.0 if ls.length > 60 else 2.0)
        docks.append((ls, w))
        polys.setdefault('pier', []).append(ls.buffer(w / 2, quad_segs=2, cap_style='flat', join_style='mitre'))
    for _, prs, t in areas:  # docks mapped as areas (a walkway and its fingers, the water between them holes): their edges
        if t.get('man_made') == 'pier':
            docks += [(LineString(r), 0.0) for o, ins in prs for r in [o, *ins] if len(r) >= 4]
    boats = berths(docks, polys, areas, X0, Y0, rnd) if docks else []

    # ---- where no trunk may stand: carriageways and paths (as drawn), rail, pitches, tracks, courts, car parks, beaches, pools
    # (crowns may still hang over a path; only the trunk is kept off it)
    nogo = Image.new('L', (N, N), 0); dn = ImageDraw.Draw(nogo)
    for L in lines:
        if L['z']: continue
        pad = 0.0 if L['kind'] in ('footway', 'path', 'steps', 'track', 'cycleway') else 0.6
        dn.line([pix(*c) for c in L['pts']], fill=1, width=max(1, int(round((L['w'] + pad) / HR))), joint='curve')
    for k in ('pitch', 'track', 'parking', 'sand', 'pool', 'apron', 'plaza', 'playground', 'construction'):
        for p in polys.get(k, []):
            for g in (p.geoms if hasattr(p, 'geoms') else [p]):
                if g.geom_type == 'Polygon': dn.polygon([pix(*c) for c in g.exterior.coords], fill=1)
    nogo = np.array(nogo, bool)

    # ---- trees from the canopy
    trees = canopy_trees(dsm, dtm, fp, water_r, X0, Y0, rnd, polys, nogo)
    trees, moved, dropped = off_streets(trees, polys, lambda x, y: fp[min(N - 1, max(0, int((Y0 + L1 - y) / HR))), min(N - 1, max(0, int((x - X0) / HR)))])
    if holes is not None and trees:  # none in a tunnel's open box (the banks of the cut it runs in, as the LiDAR has them)
        hb = holes.buffer(1.0); shapely.prepare(hb)
        trees = [t for t, o in zip(trees, shapely.contains_xy(hb, [t[0] for t in trees], [t[1] for t in trees])) if not o]

    # ---- points the simulation uses: signals, crossings, stops, street lamps, benches, transit stops; painted
    # crossings are their own kinds (7 bars, 8 two lines: the client draws their crosswalks)
    POI = {'traffic_signals': 0, 'crossing': 1, 'stop': 2, 'street_lamp': 3, 'bench': 4, 'bus_stop': 5, 'give_way': 6}
    pois = []
    for nid, (x, y), t in feat.get('nodes', []):
        k = t.get('highway') if t.get('highway') in POI else 'bench' if t.get('amenity') == 'bench' else 'bus_stop' if t.get('public_transport') == 'platform' and t.get('bus') == 'yes' else None
        paint = crossing_paint(t) if k == 'crossing' else 0
        if k and X0 <= x < X0 + L1 and Y0 <= y < Y0 + L1: pois.append((6 + paint if paint else POI[k], nid, x, y))

    # ---- named businesses for the storefront signs: (kind, x, y, name); kind 0 shop, 1 cafe, 2 food, 3 bar, 4 service, 5 office/craft
    shopn = []
    for nid, (x, y), t in feat.get('nodes', []):
        nm = (t.get('name') or '').strip().encode()[:40].decode(errors='ignore').encode()
        am = t.get('amenity')
        k = 1 if am == 'cafe' or t.get('shop') in ('coffee', 'bakery', 'tea') else 2 if am in ('restaurant', 'fast_food', 'ice_cream', 'food_court') else 3 if am in ('bar', 'pub', 'nightclub') else 0 if t.get('shop') else 4 if am in SHOP_AMENITY else 5 if 'office' in t or 'craft' in t else None
        if nm and k is not None and X0 <= x < X0 + L1 and Y0 <= y < Y0 + L1: shopn.append((k, x, y, nm))

    beach = beach_bits(X0, Y0, polys, builds)

    # ---- write the 16 detail tiles and the medium tile
    n = 0
    # the next cells' pieces from this cell's ways: their decks over this cell (a deck ending in the next cell, the
    # street under it here; a building here it passes through) and the pieces meeting this cell's at its seams
    nbr = [L for a in (-1, 0, 1) for b in (-1, 0, 1) if a or b for L in road_pieces(feat.get('lines', []), dsm, dtm, X0 + a * L1, Y0 + b * L1)]
    over = [L for L in nbr if L['z'] and any(X0 - 30 <= x < X0 + L1 + 30 and Y0 - 30 <= y < Y0 + L1 + 30 for x, y in L['pts'])]
    ground8, fine = road_ground(dtm, road_pieces(feat.get('lines', []), dsm, dtm, X0, Y0, own=False), X0, Y0, lines + over)  # 8 m, fitted to the streets; 2 m offsets over it
    # the geometry rules (tools/geom_rules.py): their fixes on this cell's buildings and road pieces, then what is left
    q8, qf = np.round(ground8 * 10) / 10, np.round(fine * 100) / 100  # (as drawn: decimetres, the offsets centimetres)
    g8 = lambda x, y: bilinear(q8, x, y, X0, Y0, 8) + bilinear(qf, x, y, X0, Y0, FINE)
    # the pieces of the next cells that meet this cell's at its seams (a deck ending at the seam, the street going on)
    seam = {n for L in lines for n in (L['a'], L['b'])}
    nxt = [L for L in nbr if L['a'] in seam or L['b'] in seam]
    rules = apply_rules(dict(cell=(X0, Y0), next=nxt, over=over, builds=builds, lines=lines, ground=g8, trees=trees, beach=beach, carr=polys.get('road', []) + polys.get('arterial', []) + polys.get('cycle', []), decks=[(np.asarray(L['pts'], float), np.asarray(L['z']), L['w']) for L in lines if L['z'] and not L.get('tube')]))
    rules = {k: dict(fixed=n, **summary(left)) for k, (n, left) in rules.items()}
    xdecks = [L for L in lines + over if L['z'] and not L.get('tube')]  # (every detail tile's neighbours' decks: XDCK)
    for a in range(4):
        for b in range(4):
            tx, ty = X0 + a * L0, Y0 + b * L0
            out = Out(tx, ty, L0)
            ti_, tj_ = i * 4 + a, j * 4 + b
            terr = ground8[(3 - b) * 128:(4 - b) * 128 + 1, a * 128:a * 128 + 129]  # 8 m: embankments, cuts and seawalls under the roads
            path = f'{OUT}/0/{ti_}_{tj_}.bin'
            if not write_tile(out, tx, ty, L0, terr, polys, lines, builds, trees, detail=True, pois=pois, shops=shopn, boats=boats, beach=beach, water_only=sea[(3 - b) * 512:(4 - b) * 512, a * 512:(a + 1) * 512].all(), holes=holes, foreign=xdecks):
                if os.path.exists(path): os.remove(path)  # an earlier bake's, now empty
                continue
            tf = fine_section(fine[(3 - b) * 512:(4 - b) * 512 + 1, a * 512:a * 512 + 513])
            if tf: out.section('TFIN', tf)
            os.makedirs(f'{OUT}/0', exist_ok=True)
            write_if_changed(path, out.bytes()); n += 1
    out = Out(X0, Y0, L1)
    terr = terrain_grid(dtm, 0, 0, L1, 65)
    write_tile(out, X0, Y0, L1, terr, polys, lines, builds, trees, detail=False, water_only=sea.all(), pois=[])
    os.makedirs(f'{OUT}/1', exist_ok=True)
    write_if_changed(f'{OUT}/1/{i}_{j}.bin', out.bytes())
    return ij, 'ok', round(time.time() - t0, 1), n, len(builds), len(trees), f'trunks off streets: {moved} moved, {dropped} dropped', rules


BEACH_OFF = ('water', 'pool', 'pier', 'road', 'arterial', 'sidewalk', 'blvd', 'walk', 'cycle', 'trail', 'parking', 'plaza', 'pitch', 'playground')


def beach_bits(X0, Y0, polys, builds):
    """the driftwood logs, lifeguard towers and volleyball nets (tools/beachlogs.py) in this 4 km tile, off the water,
    streets, paths and buildings as drawn -> [(x, y, angle, length, diameter, kind)]: kind 0-7 a log (shape bits, 4 a
    root ball), 16 a lifeguard tower (angle: the way it faces), 17 a net (angle: along it)"""
    if BEACH is None: return []
    from shapely.strtree import STRtree
    items = [(float(x), float(y), float(a), float(ln), float(d), int(k)) for x, y, a, ln, d, k in BEACH['logs'] if X0 <= x < X0 + L1 and Y0 <= y < Y0 + L1]
    items += [(float(x), float(y), float(a), float(ln), 0.0, 15 + int(k)) for x, y, a, k, ln in BEACH['things'] if X0 <= x < X0 + L1 and Y0 <= y < Y0 + L1]
    items += [(float(x), float(y), float(a), seawall.KIT_SIZE[int(k)][0], 0.0, int(k)) for x, y, a, k in KIT if X0 <= x < X0 + L1 and Y0 <= y < Y0 + L1]  # (tools/seawall.py amenities)
    if not items: return []
    off = [g for k in BEACH_OFF for g in polys.get(k, [])] + [Polygon(b['ring']) for b in builds if len(b['ring']) >= 3]
    tree = STRtree(off) if off else None
    out = []
    # as the LOGS section keeps them (1/256 turn, 1/10 m, 1/100 m): the rules (tools/geom_rules.py log_fix) see what the page draws
    items = [(x, y, round(a / (2 * math.pi) * 256) * 2 * math.pi / 256, min(25.5, round(ln * 10) / 10), min(2.55, round(d * 100) / 100), k) for x, y, a, ln, d, k in items]
    for x, y, a, ln, d, k in items:
        if k == 17: continue  # nets stand on their courts (pitches)
        ux, uy = math.cos(a) * ln / 2, math.sin(a) * ln / 2
        g = LineString([(x - ux, y - uy), (x + ux, y + uy)]) if k < 16 else shapely.Point(x, y).buffer(1.2) if k < 18 else seawall.kit_box(x, y, a, k)
        if tree is not None and len(tree.query(g, predicate='intersects')): continue
        out.append((x, y, a, ln, d, k))
    return out + [it for it in items if it[5] == 17]


def crossing_paint(t):
    """how a crossing (node) is painted: 0 not (or not known), 1 continental bars, 2 two lines (OSM crossing:markings)"""
    m, c = t.get('crossing:markings', ''), t.get('crossing')
    if m in ('no', 'surface') or c in ('unmarked', 'no', 'informal'): return 0
    if m and m not in ('yes', 'zebra', 'ladder', 'ladder:skewed', 'ladder:paired') and 'zebra' not in m: return 2  # lines, dashes, dots
    return 1 if m or c in ('traffic_signals', 'uncontrolled', 'marked', 'zebra') else 0


def flat_water(dtm, sea, water):
    """the sea flat at 0 m (so neighbouring tiles meet exactly), lakes and rivers at their shore level; piers, wharves
    and seawalls inside the water stand well above it and keep their height (Canada Place, the seawall walks)"""
    deck = ndimage.binary_opening(dtm > 2.5, iterations=2)
    dtm = np.where(sea & ndimage.binary_erosion(sea, iterations=1) & ~deck, 0.0, dtm)
    low = water & ndimage.binary_erosion(water, iterations=2)
    if low.any():
        lab, nl = ndimage.label(low)
        lvl = ndimage.percentile(dtm, lab, np.arange(1, nl + 1), 10) if hasattr(ndimage, 'percentile') else ndimage.minimum(dtm, lab, np.arange(1, nl + 1))
        lvl = np.concatenate([[0], np.asarray(lvl)])
        low &= ~ndimage.binary_opening(dtm > lvl[lab] + 2.5, iterations=2)
        dtm = np.where(low, np.minimum(dtm, lvl[lab]), dtm)
    return dtm


ITER, DAMP, HOLD = 60, 0.45, 0.3  # road_ground's fit: rounds, step, how hard a node holds its own height
CUT = 3.0  # metres: the deepest road_ground cuts a street down under a deck (deeper: one at the deck's level, meeting it near its end)
DECK_TOP = 0.38  # a deck's drawn road over its height, less the ground's (the page's tile-worker.js strip lift, drive surface())


def road_ground(dtm, pieces, X0, Y0, decks=()):
    """the detail tiles' 8 m terrain grid over a whole 4 km tile (513 x 513 nodes, row 0 north), fitted to the at-grade
    roads, paths and rail (paths held half as hard): an 8 m node near a road can land in the cut, the ravine or the yard beside it and drag the street
    with it (a street beside the Grandview Cut, a ramp's foot beside a ravine, tilting the van). Where the drawn ground under a road (its
    centre line and its kerbs, level across at the middle of the three) strays from the LiDAR ground there, the nodes round it move to take it
    there (least squares, the 4 km tile's edge nodes fixed so the next tile still meets it); nodes nowhere near a road
    keep their height. decks: the tile's raised pieces; where one ends at the street's level (an abutment, a ramp's foot)
    the street takes the deck's drawn top for 12 m, so the van rolls off it rather than stepping down (the LiDAR's
    ground is often off right at an abutment, a gap interpolated under the bridge's end)"""
    G = terrain_grid(dtm, 0, 0, L1, 513)
    at = lambda P: ndimage.map_coordinates(dtm, [(Y0 + L1 - P[:, 1]) / HR - 0.5, (P[:, 0] - X0) / HR - 0.5], order=1, mode='nearest')
    S = []  # x, y, weight, the ground wanted there
    for L in pieces:
        if L['z'] is not None or KI[L['kind']] >= KI['runway'] or len(L['pts']) < 2: continue  # (paths too: tools/audit_elev.py 'grade')
        P = np.array(densify(L['pts'], 2.0), float)
        t = np.gradient(P, axis=0) if len(P) > 1 else np.array([[1.0, 0.0]]); t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-6)[:, None]
        n = np.stack([-t[:, 1], t[:, 0]], 1)
        e = max(0.0, L['w'] / 2 - 0.5)
        Q = [P] if e < 1 else [P, P + n * e, P - n * e]
        h = np.median([at(q) for q in Q], axis=0)  # level across, as a street is (a line drawn a metre or two off the street puts a kerb on the cut's or the embankment's slope)
        for q in Q: S.append(np.c_[q, np.full(len(q), 0.3 if L['kind'] in ('rail', 'lightrail') else 1.0 if L['kind'] in DRIVE else 0.5), h, np.full(len(q), L.get('a', -1)), np.full(len(q), L.get('b', -1))])
    if not S: return G, np.zeros((L1 // FINE + 1,) * 2, np.float32)
    S = np.concatenate(S)
    S = S[(S[:, 0] > X0 + 1) & (S[:, 0] < X0 + L1 - 1) & (S[:, 1] > Y0 + 1) & (S[:, 1] < Y0 + L1 - 1)]
    if not len(S): return G, np.zeros((L1 // FINE + 1,) * 2, np.float32)
    S, ab = S[:, :4], S[:, 4:].astype(np.int64)  # (each sample's piece's end nodes)
    want = S[:, 3].copy()
    # the decks' ends at the street's level (an abutment, a ramp's foot: the ground 15 m on past the end is near it;
    # not where the deck goes on: a joint, the cut at a tile's edge): the streets going on from them meet the deck's top
    use = {}
    for L in decks:
        if L['z'] and not L.get('tube'):
            for nd in (L['a'], L['b']): use[nd] = use.get(nd, 0) + 1
    ends = {}  # node -> (x, y, drawn top)
    for L in decks:
        if not L['z'] or L.get('tube') or L.get('roof') or len(L['pts']) < 2: continue
        for e, f, nd in ((0, 1, L['a']), (-1, -2, L['b'])):
            if use.get(nd, 0) > 1 or (3 << 51) <= nd < (1 << 53): continue
            p, q = np.array(L['pts'][e], float), np.array(L['pts'][f], float)
            d = (p - q) / max(math.dist(p, q), 1e-6)
            if abs(L['z'][e] + DECK_TOP - at((p + d * 15)[None])[0]) < 2.5: ends[nd] = (*p, L['z'][e] + DECK_TOP)
    for nd, (x, y, top) in ends.items():
        near = ((ab[:, 0] == nd) | (ab[:, 1] == nd)) & (np.hypot(S[:, 0] - x, S[:, 1] - y) < 12)
        f = np.hypot(S[near, 0] - x, S[near, 1] - y) / 12
        want[near] = top * (1 - f) + want[near] * f
        S[near, 2] *= 3  # held to it harder than the LiDAR elsewhere
    # under a deck: the street 3 m under its underside (tools/audit_elev.py 'under'; the LiDAR has no ground under a
    # bridge, its ground there is filled in from round it): a street drawn up into the deck is cut down, up to CUT
    dk = [(shapely.LineString(L['pts']), L) for L in decks if L['z'] and not L.get('tube') and len(L['pts']) > 1]
    if dk:
        from shapely.strtree import STRtree
        tree = STRtree([g.buffer(under_reach(L['w'], L.get('band')), cap_style='flat') for g, L in dk]); pts = shapely.points(S[:, :2])
        for si, q in zip(*tree.query(pts, predicate='intersects')):
            g, L = dk[q]; f = g.project(pts[si])
            if min(f, g.length - f) < 12: continue  # (at its ends it comes down to the street)
            P_ = np.array(L['pts'], float); s_ = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P_, axis=0).T))])
            under = float(np.interp(f, s_, L['z'])) - (1.6 if KI[L['kind']] <= KI['tertiary'] else 0.9) - 3.0
            if under < want[si] < under + CUT: want[si] = under; S[si, 2] *= 3
    k = S[:, 2:3]  # how much each counts: the streets, rail a little (a cut's floor where it shares a cell with the street above)
    fx, fy = (S[:, 0] - X0) / 8, (Y0 + L1 - S[:, 1]) / 8
    i, j = np.clip(np.floor(fx).astype(int), 0, 511), np.clip(np.floor(fy).astype(int), 0, 511)
    u, v = fx - i, fy - j
    idx = np.stack([j * 513 + i, j * 513 + i + 1, (j + 1) * 513 + i, (j + 1) * 513 + i + 1], 1)
    w = np.stack([(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v], 1)
    w2 = w * k
    g = G.ravel().astype(np.float64)
    g0 = g.copy()
    free = np.zeros((513, 513), bool); free[1:-1, 1:-1] = True; free = free.ravel()
    den = np.zeros(g.size); np.add.at(den, idx.ravel(), (w2 * w).ravel())
    for _ in range(ITER):  # damped Jacobi on the samples' misfit, held to the LiDAR's own node height (a node only a
        e = want - (g[idx] * w).sum(1)  # sample or two lean on stays near it, no overshoot where a cut meets a street)
        num = np.zeros(g.size); np.add.at(num, idx.ravel(), (w2 * e[:, None]).ravel())
        g += np.where(free, DAMP * (num - HOLD * (g - g0)) / (den + HOLD), 0.0)
    G = g.reshape(513, 513).astype(np.float32)
    return G, road_fine(S[:, :2], k[:, 0], want - bilinear(np.round(G * 10) / 10, S[:, 0], S[:, 1], X0, Y0, 8), X0, Y0)


FINE_MIN = 0.6  # metres: a street this far off the 8 m grid gets the fine lattice under it (nearer, it holds it level)
SMOOTH = 0.05  # how hard a fine node holds to its neighbours' mean, against a street sample's 1
FINE_DROP = 0.25  # metres: smaller offsets are left out
FINE_EDGE = 16.0  # metres: none of it this near a detail tile's edge (paint reaching past it lies on the next tile's 8 m grid, TERM)


def bilinear(G, x, y, X0, Y0, c):
    """grid G (row 0 north, c metres apart, its NW node at X0, Y0 + (rows - 1) c) at x, y"""
    return ndimage.map_coordinates(G, [(Y0 + (G.shape[0] - 1) * c - np.asarray(y)) / c, (np.asarray(x) - X0) / c], order=1, mode='nearest')


def road_fine(P, k, r, X0, Y0):
    """the 2 m offsets over the 8 m grid (2049 x 2049 nodes over the 4 km tile, row 0 north) that take the streets the rest
    of the way to their ground: P, k, r the street samples, their weights, how far the 8 m grid leaves them off. Fitted
    as road_ground's grid is (held to nothing where the streets are near it), then eased out 6 m round them so the
    banks stay walkable, nothing within FINE_EDGE of the detail tiles' edges (the next tile meets this one's 8 m grid there)"""
    n = L1 // FINE + 1
    F = np.zeros(n * n)
    on = np.abs(r) > FINE_MIN
    if not on.any(): return F.reshape(n, n).astype(np.float32)
    near = np.zeros(len(r), bool)  # (the samples round the ones off: held level, so the fix stays on the street that needs it)
    from scipy.spatial import cKDTree
    near[np.unique(np.concatenate([np.asarray(q, int) for q in cKDTree(P).query_ball_point(P[on], 6.0)]))] = True
    P, k, r = P[near], k[near], np.where(np.abs(r[near]) > FINE_MIN, r[near], 0.0)
    d = np.minimum(np.abs((P - [X0, Y0] + L0 / 2) % L0 - L0 / 2), L0).min(1)  # (metres to the nearest detail tile edge)
    r = r * np.clip((d - FINE_EDGE) / FINE_EDGE, 0, 1)  # none within FINE_EDGE of it, eased in over as much again
    fx, fy = (P[:, 0] - X0) / FINE, (Y0 + L1 - P[:, 1]) / FINE
    i, j = np.clip(np.floor(fx).astype(int), 0, n - 2), np.clip(np.floor(fy).astype(int), 0, n - 2)
    u, v = fx - i, fy - j
    idx = np.stack([j * n + i, j * n + i + 1, (j + 1) * n + i, (j + 1) * n + i + 1], 1)
    w = np.stack([(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v], 1); w2 = w * k[:, None]
    e_ = np.abs((np.arange(n) * FINE + L0 / 2) % L0 - L0 / 2) < FINE_EDGE; edge = (e_[:, None] | e_[None, :]).ravel()
    den = np.zeros(n * n); np.add.at(den, idx.ravel(), (w2 * w).ravel())
    held = den.reshape(n, n) > 0
    for _ in range(2 * ITER):  # (each node also pulled to its neighbours' mean, SMOOTH: a membrane, no spikes where streets disagree)
        e = r - (F[idx] * w).sum(1)
        num = np.zeros(n * n); np.add.at(num, idx.ravel(), (w2 * e[:, None]).ravel())
        G = F.reshape(n, n); lap = np.zeros((n, n)); lap[1:-1, 1:-1] = G[:-2, 1:-1] + G[2:, 1:-1] + G[1:-1, :-2] + G[1:-1, 2:] - 4 * G[1:-1, 1:-1]
        F += np.where(edge, 0.0, DAMP * (num + SMOOTH * lap.ravel() - 0.05 * F) / (den + 4 * SMOOTH + 0.05))
    F = F.reshape(n, n)
    for _ in range(3):  # (eased out: a node no street leans on half its neighbours' mean, three times)
        m = np.zeros_like(F); m[1:-1, 1:-1] = (F[:-2, 1:-1] + F[2:, 1:-1] + F[1:-1, :-2] + F[1:-1, 2:]) / 4
        F = np.where(held, F, 0.5 * m)
    F[edge.reshape(n, n)] = 0
    F[np.abs(F) < FINE_DROP] = 0  # (the fit's faint spread: the page would split the ground over it for nothing)
    return F.astype(np.float32)


def fine_section(F):
    """a detail tile's fine offsets (513 x 513, row 0 north) as section TFIN: u16 blocks, then each block's u16 index
    (row * 33 + column, FB x FB nodes from its NW one) and its FB x FB int16 centimetres; blocks that don't move are
    left out. None when none moves"""
    nb = -(-F.shape[0] // FB)
    Fp = np.zeros((nb * FB, nb * FB), np.float32); Fp[:F.shape[0], :F.shape[1]] = F
    B = np.round(Fp * 100).clip(-32768, 32767).astype('<i2').reshape(nb, FB, nb, FB).transpose(0, 2, 1, 3).reshape(nb * nb, FB * FB)
    keep = np.nonzero(np.abs(B).max(1) >= 3)[0]  # (3 cm)
    if not len(keep): return None
    return struct.pack('<H', len(keep)) + b''.join(struct.pack('<H', b) + B[b].tobytes() for b in keep)


def terrain_grid(dtm, ox, oy, size, n):
    """n x n heights (row 0 = south edge... no: row 0 = north) over size metres starting at raster offset (ox, oy) metres from the NW corner"""
    step = size / (n - 1)
    xs = (ox + np.arange(n) * step) / HR - 0.5
    ys = (oy + np.arange(n) * step) / HR - 0.5
    return ndimage.map_coordinates(dtm, np.meshgrid(ys, xs, indexing='ij'), order=1, mode='nearest').astype(np.float32)


# ---------------------------------------------------------------- buildings
# Shapes come from the LiDAR surface inside each OSM footprint: up to four roof levels (podium, tower, penthouse,
# terraces) extruded one on top of the other, pitched roofs fitted to the surface (gable, cross gable, hip, shed),
# rooftop plant where the surface shows it. Looks come from OSM tags (material, colours, heritage, shops) and from
# where in town the building stands.
# style ids: the page's palettes and facade patterns (public/core/tile-worker.js PALETTES)
HOUSE, APT, OFFICE, BRICK, COMM, CIVIC, GLASS, CONCRETE, SHED, BIGBOX, STONE, CHARACTER, SPECIAL = range(13)
STYLE = {
    'house': HOUSE, 'detached': HOUSE, 'semidetached_house': HOUSE, 'bungalow': HOUSE, 'cabin': HOUSE, 'garage': HOUSE, 'garages': HOUSE, 'shed': HOUSE, 'terrace': HOUSE,
    'apartments': APT, 'residential': APT, 'dormitory': APT, 'hotel': APT,
    'office': OFFICE, 'commercial': COMM, 'retail': COMM, 'kiosk': COMM, 'service': COMM, 'parking': CONCRETE,
    'industrial': SHED, 'warehouse': SHED, 'manufacture': SHED, 'hangar': SHED, 'storage': SHED, 'factory': SHED, 'barn': SHED, 'farm_auxiliary': SHED,
    'supermarket': BIGBOX, 'mall': BIGBOX,
    'school': CIVIC, 'university': CIVIC, 'college': CIVIC, 'hospital': CIVIC, 'public': CIVIC, 'civic': CIVIC, 'government': CIVIC, 'train_station': CIVIC,
    'stadium': CIVIC, 'transportation': CIVIC, 'temple': CIVIC, 'church': BRICK, 'chapel': BRICK, 'cathedral': STONE,
}
HOUSES = {'house', 'detached', 'semidetached_house', 'bungalow', 'cabin', 'terrace'}
RESID = {'apartments', 'residential', 'dormitory', 'yes'}
MATERIAL = {'brick': BRICK, 'masonry': BRICK, 'clay': BRICK, 'stone': STONE, 'granite': STONE, 'sandstone': STONE, 'limestone': STONE, 'marble': STONE,
            'concrete': CONCRETE, 'cement_block': CONCRETE, 'plaster': CONCRETE, 'stucco': CONCRETE, 'glass': OFFICE, 'mirror': OFFICE, 'concrete/glass': OFFICE,
            'concrete;glass': OFFICE, 'metal': SHED, 'steel': SHED, 'metal_plates': SHED, 'aluminium': SHED, 'wood': CHARACTER, 'timber_framing': CHARACTER,
            'vinyl_siding': CHARACTER}
ROOF_MAT = {'metal': 0xa8b0b4, 'tin': 0xa8b0b4, 'steel': 0xa8b0b4, 'copper': 0x5f9a84, 'roof_tiles': 0xa8583c, 'tile': 0xa8583c, 'tiles': 0xa8583c, 'slate': 0x4a5058,
            'asphalt': 0x50545a, 'asphalt_shingle': 0x585450, 'shingle': 0x585450, 'concrete': 0xc0c0bc, 'glass': 0x8ab4c8, 'grass': 0x6a9a50, 'plants': 0x6a9a50,
            'gravel': 0xa8a49c, 'tar_paper': 0x4a4c50, 'eternit': 0x8a8c8c, 'wood': 0x7a6048, 'thatch': 0xa08850}
ROOF = {'flat': 0, 'gabled': 1, 'hipped': 2, 'pyramidal': 3, 'dome': 4, 'skillion': 5, 'round': 6, 'half-hipped': 2, 'gambrel': 1, 'mansard': 2, 'onion': 4}
CROSS, FLIP = 16, 32  # roof byte bits: ridge along the footprint's short axis; a shed roof's high side on the other edge
COLOURS = {'white': 0xf2f0ea, 'black': 0x303236, 'grey': 0x9a9c9e, 'gray': 0x9a9c9e, 'red': 0xb04a3a, 'brown': 0x7a5a48, 'beige': 0xd8c8a8, 'yellow': 0xe0c060,
           'blue': 0x5a80b0, 'green': 0x5a8a5a, 'silver': 0xc0c4c8, 'tan': 0xc8b090, 'cream': 0xeee4cc, 'orange': 0xd08040, 'darkgrey': 0x5a5c60,
           'lightgrey': 0xc8cacc, 'maroon': 0x7a2a2a, 'pink': 0xe0a8a8, 'teal': 0x4a9a9a}
# rough outlines in world metres (common.py) of places whose building stock has a look of its own; first match wins
ZONES = [
    ('historic', Polygon([(-230, -60), (350, -60), (1300, -250), (1300, -560), (720, -560), (700, -1000), (250, -800), (-120, -480), (-300, -260)])),  # Gastown, Victory Sq, Chinatown, Railtown: 1890s-1920s brick
    ('historic', Polygon([(-629, -872), (-491, -988), (-871, -1448), (-1009, -1332)])),  # Yaletown's warehouse district
    ('granville', Polygon([(-2200, -1880), (-1450, -1880), (-1450, -1430), (-2200, -1430)])),  # Granville Island: tin sheds
    ('westend', Polygon([(-880, -182), (-1703, -1006), (-1803, -1115), (-2306, -408), (-2700, 200), (-2100, 950), (-1784, 825)])),  # 1960s-70s concrete towers
    ('core', Polygon([(-2900, 1300), (400, 300), (400, -500), (-200, -1400), (-1200, -1750), (-2700, -300)])),  # downtown, Coal Harbour, Yaletown: glass condos
]


def zone(c):
    for k, p in ZONES:
        if shapely.contains_xy(p, c[0], c[1]): return k
    return None


def colour(v):
    if not v: return 0
    v = v.strip().lower().replace(' ', '').replace('_', '')
    if v.startswith('#') and len(v) in (4, 7):
        h = v[1:]
        if len(h) == 3: h = ''.join(c * 2 for c in h)
        try: return int(h, 16) | 0x1000000
        except ValueError: return 0
    return (COLOURS[v] | 0x1000000) if v in COLOURS else 0


def obb(r):
    """the ring's smallest box over its edge directions: (cx, cy, angle, half length, half width, area)"""
    return _obb(tuple(map(tuple, r)))


@lru_cache(1 << 16)  # a footprint's box is asked for by several steps
def _obb(r):
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


def pct(v, q):
    """np.percentile(v, q) for one scalar q, to the bit (numpy's linear method: the same order statistics and the same
    lerp, in v's own type), without its overhead: it is called some 100 000 times in a downtown tile"""
    a = np.asarray(v).ravel()
    n = a.size
    vi = (n - 1) * np.true_divide(q, 100)
    lo = int(np.floor(vi))
    if vi >= n - 1: lo = hi = n - 1
    else: hi = lo + 1
    a = np.partition(a, (lo, hi) if hi != lo else lo)
    if a.dtype.kind == 'f' and np.isnan(a).any(): return a.dtype.type(np.nan)
    t = float(vi - lo) if vi < n - 1 else float(vi + 1)
    prev, nxt = a[lo], a[hi]
    d = nxt - prev
    return nxt - d * (1 - t) if t >= 0.5 else prev + d * t


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


def bridge_mask(lines, areas, X0, Y0, N):
    """where a bridge deck or viaduct is overhead (roads, rail, SkyTrain guideways, widened by a few metres): there the
    LiDAR surface is the deck, not a roof or a tree crown"""
    img = Image.new('L', (N, N), 0); d = ImageDraw.Draw(img)
    pix = lambda x, y: ((x - X0) / HR, (Y0 + L1 - y) / HR)
    for _, coords, _, t in lines:
        if t.get('bridge') in (None, 'no') or (hnum(t.get('layer')) or 0) < 0: continue
        k = line_kind(t)
        w = road_shape(k, t)[1] if k else 4.0
        d.line([pix(*c) for c in coords], fill=1, width=max(1, int(round((w + 8) / HR))), joint='curve')
    for _, prs, t in areas:
        if t.get('man_made') == 'bridge':
            for outer, _ in prs:
                if len(outer) >= 3: d.polygon([pix(*c) for c in outer], fill=1)
    return np.array(img, bool)


def height_levels(v):
    """1-4 roof heights inside a footprint (1D k-means of the LiDAR surface heights), lowest first"""
    best = np.array([float(pct(v, 60))])
    top = float(pct(v, 97))
    if len(v) < 30 or top - float(pct(v, 5)) < 3: return best
    prev = float(((v - np.median(v)) ** 2).sum())
    for k in (2, 3, 4):
        c = np.percentile(v, np.linspace(12, 94, k))
        for _ in range(10):
            lab = np.abs(v[:, None] - c[None]).argmin(1)
            c = np.array([np.median(v[lab == j]) if (lab == j).any() else c[j] for j in range(k)])
        c = np.sort(c)
        lab = np.abs(v[:, None] - c[None]).argmin(1)
        sse = float(((v - c[lab]) ** 2).sum())
        if np.bincount(lab, minlength=k).min() < 6 or np.diff(c).min() < max(2.5, 0.06 * top) or sse > 0.4 * prev: break
        best, prev = c, sse
    return best


def squared(g, ang):
    """a raster outline squared up: the building-aligned rectangle when it nearly fills it, else simplified"""
    g = g.buffer(0)
    if g.is_empty: return g
    from shapely import affinity
    rot = affinity.rotate(g, -ang, origin=(0, 0), use_radians=True)
    x0, y0, x1, y1 = rot.bounds
    if g.area > 0.78 * (x1 - x0) * (y1 - y0): return affinity.rotate(box(x0, y0, x1, y1), ang, origin=(0, 0), use_radians=True)
    mrr = g.minimum_rotated_rectangle
    if g.area > 0.82 * mrr.area: return mrr
    return g.simplify(1.2)


def polys_of(g, min_area):
    return [p for p in (g.geoms if hasattr(g, 'geoms') else [g]) if p.geom_type == 'Polygon' and p.area >= min_area]


def fit_roof(r, z, ok, fx, shape=''):
    """a pitched roof fitted to the LiDAR surface in the footprint's own frame: (roof byte, eaves, ridge, pitch) or None"""
    rr, cc = np.nonzero(ok)
    if len(rr) < 10: return None
    zz = z[rr, cc]
    cx, cy, ang, hl, hw, _ = obb(r)
    ang %= math.pi  # the page's frame (tile-worker.js roof): "+v" is the same side there
    if hw < 2: return None
    x = fx[0] + (cc + 0.5) * HR - cx; y = fx[1] - (rr + 0.5) * HR - cy
    ca, sa = math.cos(ang), math.sin(ang)
    u, v = x * ca + y * sa, -x * sa + y * ca
    sse0 = float(((zz - zz.mean()) ** 2).sum()) + 1e-6
    cand = {'gable': (np.abs(v), hw, 1, 0), 'cross': (np.abs(u), hl, 1, CROSS), 'hip': (np.maximum(np.abs(v), np.abs(u) - (hl - hw)), hw, 2, 0),
            'shed': (v, hw, 5, 0), 'shedx': (u, hl, 5, CROSS)}
    allow = {'gabled': ('gable', 'cross'), 'gambrel': ('gable', 'cross'), 'hipped': ('hip',), 'half-hipped': ('hip',), 'pyramidal': ('hip',),
             'skillion': ('shed', 'shedx')}.get(shape, tuple(cand))
    best = None
    for name in allow:
        f, run, code, bits = cand[name]
        (c0, k), *_ = np.linalg.lstsq(np.stack([np.ones_like(f), -f], 1), zz, rcond=None)
        if code != 5 and k <= 0: continue
        sse = float(((zz - (c0 - k * f)) ** 2).sum()) * (1.15 if bits else 1.0)  # across the short side: only when clearly better
        if best is None or sse < best[0]: best = (sse, c0, k, run, code, bits)
    if not best: return None
    sse, c0, k, run, code, bits = best
    rise = abs(k) * run * (2 if code == 5 else 1)
    spread = float(pct(zz, 95) - pct(zz, 10))
    # a clean fit, or a busy house roof (dormers, cross gables) that is still much more pitched than flat
    if not shape and (rise < 1.0 or sse > (0.85 if spread > 2.0 and hl * hw < 120 else 0.5) * sse0): return None
    if rise > 10: return None
    if code == 5:
        eaves, ridge = c0 - abs(k) * run, c0 + abs(k) * run
        if k < 0: bits |= FLIP  # higher towards +v (or +u)
    else: eaves, ridge = c0 - k * run, c0
    if eaves < 2.2: return None
    if code == 2 and hl / hw < 1.15: code = 3
    return code | bits, float(eaves), float(ridge), float(abs(k))


def roof_units(z, part, h, fx, ang, hidden):
    """rooftop plant, lift overruns and stair towers: small blobs standing 1-6 m proud of a flat roof, away from its
    edge (an overhanging tree crown touches the edge). -> [(x, y, along, across, height, angle)]"""
    m = part & ~hidden
    inner = ndimage.binary_erosion(m, iterations=1)
    res = np.where(inner, z - h, 0)
    blob = inner & (res > 1.0) & (res < 6)
    lab, n = ndimage.label(blob)
    if not n: return []
    edge = part & ~ndimage.binary_erosion(part, iterations=2)
    ca, sa = math.cos(ang), math.sin(ang)
    out = []
    for k, sl in enumerate(ndimage.find_objects(lab)):
        sel = lab[sl] == k + 1
        nb = int(sel.sum())
        if nb < 2 or nb > 40 or edge[sl][sel].any(): continue
        rr, cc = np.nonzero(sel)
        rr = rr + sl[0].start; cc = cc + sl[1].start
        x = fx[0] + (cc + 0.5) * HR; y = fx[1] - (rr + 0.5) * HR
        u, v = x * ca + y * sa, -x * sa + y * ca
        uc, vc = (u.max() + u.min()) / 2, (v.max() + v.min()) / 2
        out.append((nb, uc * ca - vc * sa, uc * sa + vc * ca, float(u.max() - u.min() + HR * 0.8), float(v.max() - v.min() + HR * 0.8),
                    float(np.clip(pct(res[rr, cc], 75), 0.8, 5.0)), ang))
    out.sort(key=lambda o: -o[0])
    return [o[1:] for o in out[:16]]


def from_lidar(r, a, z, ok, fx, shape, rnd, roofm):
    """parts of one building from the LiDAR surface (heights above its base): [dict(ring, h, mn, roof, ridge, pitch, units)]"""
    v = z[ok]
    p97 = float(pct(v, 97))
    # houses, sheds, halls: one pitched roof if the surface fits one (big ones only if the outline is near a rectangle)
    if p97 < 20 and (a < 700 or a < 5000 and a > 0.85 * obb(r)[5]) and shape in ('', 'gabled', 'hipped', 'skillion', 'pyramidal', 'half-hipped', 'gambrel'):
        f = fit_roof(r, z, roofm, fx, shape)
        if f: return [dict(ring=r, h=f[1], mn=0, roof=f[0], ridge=f[2], pitch=f[3], units=[])]
    if shape and shape != 'flat': return None  # the mapper's roof, on the old path
    c = height_levels(v)
    ang = obb(r)[2]
    foot = Polygon(r).buffer(0)
    import rasterio.features as rf
    from rasterio.transform import Affine
    tr = Affine(HR, 0, fx[0], 0, -HR, fx[1])
    th = [(c[i - 1] + c[i]) / 2 for i in range(1, len(c))]
    lvl_h = lambda sel, d: float(pct(z[sel], 70)) if sel.sum() >= 3 else float(d)
    open_ = False
    if c[0] < 2.5 and len(c) > 1:  # the lowest "roof" is the ground: a courtyard or a plaza inside the outline
        if (v < th[0]).mean() < 0.3: c, th = c[1:], th[1:]
        else: open_ = True
    elif c[0] < 2.2: return None
    sel0 = ok & (z < th[0]) if th else ok
    parts, parents = [], []
    if not open_:
        h0 = lvl_h(sel0, c[0])
        parts.append(dict(ring=r, h=h0, mn=0, roof=0, ridge=0, mask=ok))
        parents.append((foot, h0, ok))
    else: parents.append((foot, 0.0, ok))
    for i in range(1, len(c)):
        R = ok & (z > th[i - 1])
        if R.sum() > 40: R = ndimage.binary_opening(R)
        lab, n = ndimage.label(R)
        new = []
        for k, sl in enumerate(ndimage.find_objects(lab)):
            comp = lab == k + 1
            if comp[sl].sum() < 6: continue
            g = unary_union([shapely.geometry.shape(gg) for gg, _ in rf.shapes(comp.astype(np.uint8), mask=comp, transform=tr)])
            g = squared(g, ang)
            if g.is_empty: continue
            pt = g.representative_point()
            par = next((p for p in parents if p[0].contains(pt)), None) or max(parents, key=lambda p: p[0].intersection(g).area)
            pg, ph, _ = par
            # reach out to the outline below where the raster stopped short of it
            band = pg.difference(pg.buffer(-2.5, join_style=2))
            g = g.union(g.buffer(2.5, join_style=2).intersection(band)).intersection(pg)
            hi = th[i] if i < len(th) else np.inf
            h = lvl_h(comp & (z <= hi), c[i])
            if h - ph < 1.5: continue
            for p in polys_of(g, 20):
                p = p.simplify(0.3)
                parts.append(dict(ring=list(p.exterior.coords)[:-1], h=h, mn=ph if not open_ or i > 1 else 0.0, roof=0, ridge=0, mask=comp))
                new.append((p, h, comp))
        parents = new + parents
    if not parts: return None
    # rooftop plant on each flat roof, minus what the next level up covers
    for p in parts:
        hidden = np.zeros_like(ok)
        for q in parts:
            if q is not p and q['mn'] >= p['h'] - 0.5: hidden |= q['mask']
        p['units'] = roof_units(z, p['mask'], p['h'], fx, ang, hidden) if a >= 120 else []
        p['pitch'] = 0
        del p['mask']
    return parts


def house_kind(info, main):
    """Vancouver's two classic houses, told apart by their roofs: the character house (1900s-1930s, steep gables, wood
    siding, a porch) and the Vancouver Special (1965-85, two storeys, a shallow gable, stucco over a brick base)"""
    btype, a = info['btype'], info['a']
    if not (btype in HOUSES or btype == 'yes' and 60 < a < 400) or main['h'] > 11: return None
    year = info['year']
    if year and year < 1940: return CHARACTER
    if not main['roof']: return None
    pitch, rise = main['pitch'], (main['ridge'] or 0) - main['h']
    if pitch >= 0.45 and rise >= 1.8: return CHARACTER
    if pitch < 0.36 and main['h'] >= 4.6 and 110 < a < 330 and (main['roof'] & 15) in (1, 2): return SPECIAL
    return None


def start_year(t):
    s = str(t.get('start_date', ''))
    for k in range(len(s) - 3):
        if s[k:k + 4].isdigit(): return int(s[k:k + 4])
    return None


def style_of(info, h, rnd, kind):
    t, btype, a = info['t'], info['btype'], info['a']
    mat = (t.get('building:material') or '').strip().lower()
    year = info['year']  # OSM start_date, else the tax report's year built
    tower = h > 30 and btype in RESID | {'hotel'}
    zn = info['zone']
    if mat in MATERIAL:
        s = MATERIAL[mat]
        if s == OFFICE and tower and btype != 'hotel': return GLASS
        if s == CHARACTER and h > 12: return COMM
        return s
    if kind is not None: return kind
    heritage = t.get('heritage') or t.get('historic') in ('building', 'yes', 'church', 'monument', 'manor', 'house') or year and year < 1930 \
        or info['fac'].get('heritage') and (year or 0) < 1940  # on the city's register (it lists modernist ones too)
    if heritage and btype not in HOUSES and h < 45:
        return STONE if btype in ('civic', 'public', 'government', 'cathedral') or t.get('amenity') in ('bank', 'townhall', 'courthouse', 'place_of_worship') else BRICK
    if zn == 'historic' and h < 32 and btype not in HOUSES and rnd.random() < 0.8: return BRICK
    s = STYLE.get(btype)
    if zn == 'granville' and h < 16 and s in (None, COMM, SHED, BIGBOX): return SHED
    if s == SHED or info['ind'] and a > 300 and h < 20 and s in (None, COMM): return SHED
    if (btype in ('retail', 'commercial', 'supermarket') or t.get('shop') in ('mall', 'supermarket', 'department_store', 'doityourself', 'wholesale')) and a > 2500 and h < 16:
        return BIGBOX
    if s is None: s = HOUSE if h < 9 else APT if h > 14 else COMM
    if s == APT and h > 24 and btype != 'hotel':
        p = {'core': 0.9, 'westend': 0.2}.get(zn, 0.55)
        if year: p = 0.0 if year < 1985 else 1.0 if year >= 1995 else p
        return GLASS if rnd.random() < p else CONCRETE
    if s == OFFICE and year and year < 1975: return CONCRETE
    return s


FLOOR = {OFFICE: 3.9, BRICK: 3.8, COMM: 4.2, CIVIC: 4.2, STONE: 4.6, BIGBOX: 5.0, SHED: 5.0, CONCRETE: 2.9}


def floor_h(style, top, lv, shop):
    """storey height, so window rows line up with the real floors (OSM building:levels when mapped)"""
    if lv and lv >= 1 and top > 4:
        if shop and lv > 1: return float(np.clip((top - 4.5) / (lv - 1), 2.6, 6.0))
        return float(np.clip(top / lv, 2.6, 6.0))
    return FLOOR.get(style, 2.9)


def buildings(items, dsm, dtm, X0, Y0, rnd, under=None, shops=None, ind=None, streets=None, tops=(None, None)):
    """under: bridge decks overhead (bridge_mask); shops: STRtree of shop/office points; ind: industrial land;
    streets: STRtree of street lines (which way a house faces); tops: STRtrees of outdoor pools and solar panels (roof_bits)"""
    N = dtm.shape[0]
    pix = lambda x, y: ((x - X0) / HR, (Y0 + L1 - y) / HR)
    own = lambda c: X0 <= c[0] < X0 + L1 and Y0 <= c[1] < Y0 + L1
    rows = []
    parts_c, parts_p = [], []  # the parts' centres, and their outlines with their min heights
    for oid, prs, t in items:
        if 'building:part' in t and 'building' not in t:
            for outer, _ in prs:
                if len(outer) < 4: continue
                parts_c.append(np.mean(outer[:-1], axis=0))
                parts_p.append((Polygon(outer).buffer(0), hnum(t.get('min_height')) or (hnum(t.get('building:min_level')) or 0) * 3.1))
    parts_c = np.array(parts_c) if parts_c else np.zeros((0, 2))
    seen = set()
    for oid, prs, t in items:
        for outer, inners in prs:
            r = outer[:-1] if outer[0] == outer[-1] else outer
            if len(r) < 3 or len(r) > 400: continue
            c = (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r))
            if not own(c): continue
            if t.get('building') == 'tower' and under is not None:  # a bridge's pylon (stal̕əw̓asəm, Port Mann) is the bridge's
                cx_, cy_ = map(int, pix(*c))
                if under[max(0, cy_ - 10):cy_ + 11, max(0, cx_ - 10):cx_ + 11].any(): continue
            a = ring_area(r)
            if a < 4: continue
            is_part = 'building:part' in t and 'building' not in t
            cap = None
            if not is_part and len(parts_c):
                xs = [p[0] for p in r]; ys = [p[1] for p in r]
                sel = np.nonzero((parts_c[:, 0] > min(xs)) & (parts_c[:, 0] < max(xs)) & (parts_c[:, 1] > min(ys)) & (parts_c[:, 1] < max(ys)))[0]
                B = Polygon(r).buffer(0)
                sel = [k for k in sel if B.contains(shapely.geometry.Point(parts_c[k]))]
                if sel:  # parts carry the shape, unless some of them start up in the air over nothing the parts draw (a
                    # tower mapped as a part from the podium's roof up, the podium only as the outline): then the outline
                    # stands up to the lowest of them, round the parts that do stand on the ground
                    low = unary_union([parts_p[k][0] for k in sel if parts_p[k][1] < 1] or [Polygon()])
                    air = [parts_p[k] for k in sel if parts_p[k][1] >= 1]
                    bare = unary_union([q for q, _ in air] or [Polygon()]).difference(low.buffer(0.5)).intersection(B)
                    if bare.area < max(10, 0.2 * sum(q.area for q, _ in air)): continue
                    cap = min(m for _, m in air)
                    rest = B.difference(low)
                    for g in getattr(rest, 'geoms', [rest]):
                        if g.geom_type != 'Polygon' or g.area < 4: continue
                        rr = list(g.exterior.coords)[:-1]
                        rows.append((rr, t, g.area, tuple(np.mean(rr, axis=0)), False, cap))
                    continue
            key = (round(c[0] * 2), round(c[1] * 2), round(a / 4))
            if key in seen: continue
            seen.add(key)
            rows.append((r, t, a, c, is_part, cap))

    def measure(r):
        """the LiDAR inside a ring: (heights above base on the 2 m grid, usable cells, NW corner, base) or None"""
        xs = [pix(*p) for p in r]
        bx0, by0 = max(0, int(min(p[0] for p in xs)) - 1), max(0, int(min(p[1] for p in xs)) - 1)
        bx1, by1 = min(N, int(max(p[0] for p in xs)) + 2), min(N, int(max(p[1] for p in xs)) + 2)
        if bx1 <= bx0 or by1 <= by0: return None
        m = Image.new('L', (bx1 - bx0, by1 - by0), 0)
        ImageDraw.Draw(m).polygon([(x - bx0, y - by0) for x, y in xs], fill=1)
        m = full = np.array(m, bool)
        if m.sum() > 12: m2 = ndimage.binary_erosion(m); m = m2 if m2.sum() > 4 else m
        ground = dtm[by0:by1, bx0:bx1][m] if m.any() else np.array([height_fallback(dtm, xs)])
        base = float(pct(ground, 10)) if len(ground) else 0.0
        fx = (X0 + bx0 * HR, Y0 + L1 - by0 * HR)
        if dsm is None or not m.any(): return None, None, fx, base, None
        free = ~under[by0:by1, bx0:bx1] if under is not None else np.ones_like(m)
        ok = m & free
        if ok.sum() < max(3, 0.4 * m.sum()): return None, None, fx, base, None  # mostly under a bridge deck: the surface there is the deck
        z = dsm[by0:by1, bx0:bx1] - base
        return z, ok, fx, base, full & free & (z > 1.5)  # last: every roof cell, eaves included (for roof pitch fits)

    out = []
    for r, t, a, c, is_part, cap in rows:
        mz = measure(r)
        if mz is None: continue
        z, ok, fx, base, roofm = mz
        chm = z[ok] if z is not None else None
        tag_h = hnum(t.get('height')); lv = hnum(t.get('building:levels'))
        mn = hnum(t.get('min_height')) or (hnum(t.get('building:min_level')) or 0) * 3.1
        shape = t.get('roof:shape', '')
        btype = t.get('building', t.get('building:part', 'yes'))
        shop = bool(t.get('shop') or t.get('office') or t.get('amenity') in SHOP_AMENITY) or (shops is not None and len(shops.query(Polygon(r).buffer(3), predicate='intersects')) > 0)
        fac = facade_lookup(r) or {}  # tools/facades.py: year built, heritage, wall colour, storey, balconies
        info = dict(t=t, btype=btype, a=a, shop=shop, lv=lv, ind=ind is not None and shapely.contains_xy(ind, c[0], c[1]), zone=zone(c),
                    fac=fac, year=start_year(t) or fac.get('year') or None, ring=r)
        gid = rnd.randrange(1, 1 << 30)
        parts = [dict(ring=r, h=cap, mn=0, roof=0, ridge=0, pitch=0, units=None, cap=True)] if cap else None  # under its parts
        ms = massing_lookup(r) if not mn and not cap else None  # tools/lidar_massing.py: the 2022 LiDAR's own massing, where it has one
        if ms and not parts and not (tag_h and abs(tag_h - max(p['ridge'] or p['h'] for p in ms)) > max(6, 0.3 * tag_h)):
            parts = [dict(p, pitch=0, m22=True) for p in ms]
        if parts is None and chm is not None and not is_part and not mn and pct(chm, 90) > 2.2:
            p97 = float(pct(chm, 97))
            if not (tag_h and abs(tag_h - p97) > max(6, 0.3 * tag_h)):  # else rebuilt since the LiDAR flew: the tags win
                parts = from_lidar(r, a, z, ok, fx, shape, rnd, roofm)
        if parts is None:
            h, ridge = None, None
            if tag_h: h = tag_h
            elif chm is not None and len(chm) >= 3 and pct(chm, 90) > 2.2: h = float(pct(chm, 90))
            elif lv: h = lv * 3.1 + 1.0
            if h is None: h = 3.0 if btype in ('garage', 'shed', 'carport', 'roof') else (rnd.uniform(5, 8) if btype in ('house', 'detached') else 7.0)
            if lv and not tag_h and (chm is None or len(chm) < 3): h = lv * 3.1 + 1
            rf_ = ROOF.get(shape, 0) if shape else 0
            if rf_:
                rh = hnum(t.get('roof:height')) or (hnum(t.get('roof:levels')) or 0) * 2.8 or min(4.0, math.sqrt(a) * 0.25)
                ridge, h = h, max(2.4, h - rh)
                if z is not None and rf_ in (1, 2, 5):  # the mapper's roof shape, the LiDAR's ridge direction
                    f = fit_roof(r, z, roofm, fx, shape)
                    if f: rf_ = f[0]
            parts = [dict(ring=r, h=h, mn=mn, roof=rf_, ridge=ridge or 0, pitch=0, units=None, tagmn=bool(mn))]  # (a mapped min height: geom_rules leaves it up)
        for p in parts:
            if p['mn'] and p['mn'] >= max(p['h'], p['ridge'] or 0) - 0.3: continue  # its min height over its top (mistagged): nothing to draw
            p.update(base=base, gid=gid, info=info, a=ring_area(p['ring']))
            if p['units'] is None and z is not None and not p['roof']: p['units'] = []  # LiDAR here: no made-up plant
            out.append(p)
    # City of Vancouver 2009 LiDAR sections are vector-exact: where they agree with today's heights, they win
    if SECTIONS:
        apply_sections(out, X0, Y0, rnd, measure, under)
    groups = {}
    for p in out: groups.setdefault(p['gid'], []).append(p)
    for gid, ps in groups.items():
        main = max(ps, key=lambda p: p['a'])
        info, t = main['info'], main['info']['t']
        top = max(p['h'] for p in ps)
        kind = house_kind(info, main)
        style = style_of(info, top, rnd, kind)
        shop = info['shop'] and style not in (HOUSE, CHARACTER, SPECIAL, SHED) and top >= 5
        tagc = colour(t.get('roof:colour'))
        matc = ROOF_MAT.get((t.get('roof:material') or '').lower(), 0) and ROOF_MAT[t['roof:material'].lower()] | 0x1000000
        mainc = 0 if tagc else photo_roof(main)
        fac = info['fac']
        fh = fac.get('storey') or floor_h(style, top, info['lv'], shop)  # the LiDAR's storey rhythm, else levels, else the style's
        gh = max(p['ridge'] or p['h'] for p in ps)
        # walls: the mapper's colour, else a known building's, else the sunlit walls in the 2022 LiDAR (not on glass: that
        # is the sky in it), else the palette
        wall = colour(t.get('building:colour'))
        if not wall and fac.get('wall') and (fac['wsrc'] == 2 or style not in (GLASS, OFFICE)): wall = fac['wall'] | 0x1000000
        if not wall and info['zone'] == 'granville' and style == SHED:  # Granville Island's painted tin
            wall = rnd.choice((0xb84a3a, 0xd8a838, 0x3a6a9a, 0x4a7a5a, 0x8a8c8e, 0xc86a3a, 0x5a8aa0)) | 0x1000000
        res = info['btype'] != 'hotel' and (style in (APT, GLASS) or style == CONCRETE and info['btype'] in RESID and top > 24)
        fx = facade_fx(style, res, top, info['year'], info['btype'], fac, main['ring'])
        d = rnd.uniform(0.03, 0.3)
        if style == CHARACTER and streets is not None and main['roof'] and main['a'] < 300:
            ps.append(porch(main, streets))
        for p in ps:  # roof colour: the mapper's, else the 2022 photo's (this part's, else the building's), else the material's
            roofc = tagc or (photo_roof(p) if p is not main else mainc) or mainc or matc
            p['fd'] = edge_looks(p['ring'], p['mn'] or 0, p['h'], walls_near(p['ring']), fac.get('pattern'))  # each wall's look (tools/lidar_walls.py)
            p.update(style=style, wall=wall, roofc=roofc, fh=fh, shop=shop, res=res, gh=gh, fx=fx, rb=roof_bits(p, t, *tops), ring=inset(p['ring'], d), h=p['h'] + rnd.random() * 0.1)
            del p['info']
    return out


def edge_looks(ring, mn, h, walls, known=0):
    """each wall of a part -> the look the 2022 LiDAR saw on it (tools/lidar_walls.py: (d0, d1, d2, d3)), from the
    measured wall that runs along it (within 12 degrees, 2.5 m, over 40% of it, at its heights), else 0s; None if none.
    known: a well-known building's own pattern (tools/facades.py LOOKS), which keeps its glazing (the grid still comes)"""
    out, got = [], False
    turn = 1 if sum(ring[k - 1][0] * ring[k][1] - ring[k][0] * ring[k - 1][1] for k in range(len(ring))) > 0 else -1  # the walls run counter-clockwise
    for k in range(len(ring)):
        (ax, ay), (bx, by) = ring[k], ring[(k + 1) % len(ring)]
        L = math.hypot(bx - ax, by - ay)
        best = None
        if L >= 3:
            ux, uy = (bx - ax) / L, (by - ay) / L
            for x0, y0, x1, y1, f, t, d in walls:
                if t < mn + 2 or f > h - 2: continue
                M = math.hypot(x1 - x0, y1 - y0) or 1
                if abs(ux * (y1 - y0) / M - uy * (x1 - x0) / M) > 0.21 or turn * (ux * (x1 - x0) + uy * (y1 - y0)) < 0: continue  # (not the neighbour's side of a party wall)
                off = abs(((x0 + x1) / 2 - ax) * -uy + ((y0 + y1) / 2 - ay) * ux)  # the measured wall's middle, off this wall's line
                if off > 2.5: continue
                s0, s1 = sorted(((x0 - ax) * ux + (y0 - ay) * uy, (x1 - ax) * ux + (y1 - ay) * uy))
                ov = min(L, s1) - max(0, s0)
                if ov < 0.4 * L: continue
                if best is None or ov - off > best[0]: best = (ov - off, d)
        out.append((best[1][0] & ~7 if known else best[1][0], *best[1][1:]) if best else (0, 0, 0, 0))
        got |= best is not None
    return out if got else None


def octant(ang):
    """compass octant (0 east, 2 north, ...) of a direction in radians"""
    return round(ang / (math.pi / 4)) % 8


def facade_fx(style, res, top, year, btype, fac, ring):
    """(balcony kind, facade pattern, balcony facing octants) from the building's era unless facades.py knows better;
    0s leave it to the page's own rules (and old tiles carry none). Kinds and patterns: tools/facades.py LOOKS."""
    kind, pat, facing = fac.get('balc', 0), fac.get('pattern', 0), fac.get('facing', 0)
    if year and res and top > 9 and not kind:
        if year < 1950: kind = B_NONE  # walk-ups and old apartment blocks
        elif year < 1986:  # 1960s-80s concrete towers: solid-fronted balconies along the long sides
            kind = B_SOLID
            ang = obb(ring)[2] + math.pi / 2
            facing = (1 << octant(ang)) | (1 << octant(ang + math.pi))
        else: kind = B_GLASS  # Vancouverism: glass-railed balconies all round
    if year and not pat:
        if style == GLASS: pat = 3 if year < 2006 else 9  # green glass and balconies, then window walls
        elif style == APT and top > 20: pat = 1 if year < 1986 else 3
        elif style == CONCRETE and btype not in RESID and 1955 <= year < 1986: pat = 10  # window bands between concrete
    return kind, pat, facing


def roof_bits(p, t, pools, solar):
    """what a flat roof carries, as the client's rooftop() reads the facade byte: 4 planted (the orthophoto's green
    flag, OSM roof:garden, a garden or a grass roof), 8 a pool (an outdoor OSM pool mostly over it), 16 solar panels"""
    if p['roof']: return 0
    r, q, bits = roof_at(tuple(p['ring'])), valid_poly(tuple(map(tuple, p['ring']))), 0
    if r and r[3] & 1 or t.get('roof:garden') == 'yes' or t.get('leisure') == 'garden' or t.get('roof:material') in ('grass', 'plants', 'vegetation'): bits |= 4
    if pools is not None and any(g.intersection(q).area > 0.6 * g.area for g in pools.geometries[pools.query(q, predicate='intersects')]): bits |= 8
    if t.get('generator:source') == 'solar' or solar is not None and len(solar.query(q, predicate='intersects')): bits |= 16
    return bits


@lru_cache(1 << 16)
def roof_at(ring):
    """roof_lookup, once per footprint (photo_roof and roof_bits both ask)"""
    return roof_lookup(ring)


def photo_roof(p):
    """the roof's colour in the city's 2022 orthophoto (tools/roofs.py, data/roofs.npz), as a tagged colour, or 0"""
    r = roof_at(tuple(p['ring']))
    if not r or (p['roof'] and r[3] & 1): return 0  # green over a pitched roof is the garden's trees, not the roof
    return r[0] | 0x1000000


def porch(main, streets):
    """a character house's front porch: its roof on posts across the end that faces the street"""
    cx, cy, ang, hl, hw, _ = obb(main['ring'])
    st = streets.geometries[streets.nearest(shapely.geometry.Point(cx, cy))]
    q = st.interpolate(st.project(shapely.geometry.Point(cx, cy)))
    ca, sa = math.cos(ang), math.sin(ang)
    s = 1 if (q.x - cx) * ca + (q.y - cy) * sa > 0 else -1
    u0, u1, w = s * hl, s * (hl + 2.2), hw * 0.75
    ring = [(cx + u * ca - v * sa, cy + u * sa + v * ca) for u, v in ((u0, -w), (u1, -w), (u1, w), (u0, w))]
    return dict(main, ring=ring, h=min(3.2, main['h']), mn=min(3.2, main['h']) - 0.45, roof=0, ridge=0, pitch=0, units=[], a=ring_area(ring))


def height_fallback(dtm, xs):
    x, y = xs[0]
    return float(dtm[int(min(dtm.shape[0] - 1, max(0, y))), int(min(dtm.shape[1] - 1, max(0, x)))])


SEC_INDEX = None


def sections_at(X0, Y0):
    """the 2009 LiDAR sections whose centre is in the 4 km tile at X0, Y0: [(ring, height, roof type, cx, cy)]"""
    global SEC_INDEX
    if SEC_INDEX is None:
        SEC_INDEX = {}
        for r, hg, rt in SECTIONS:
            cx, cy = sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)
            SEC_INDEX.setdefault((int(cx // L1), int(cy // L1)), []).append((r, hg, rt, cx, cy))
    return SEC_INDEX.get((int(X0 // L1), int(Y0 // L1)), [])


def apply_sections(out, X0, Y0, rnd, measure, under):
    """swap a building's parts for the city's 2009 LiDAR roof sections when they still match it; today's LiDAR gives
    each section its height, roof pitch and plant"""
    secs = sections_at(X0, Y0)
    if not secs: return
    from shapely.strtree import STRtree
    groups = {}
    for p in out: groups.setdefault(p['gid'], []).append(p)
    gids = list(groups)
    bases = [max(groups[g], key=lambda p: p['a']) for g in gids]
    tree = STRtree([Polygon(b['ring']).buffer(0) for b in bases])
    N = L1 / HR
    by_g = {}
    for r, hg, rt, cx, cy in secs:
        if under is not None:
            i_, j_ = int((cx - X0) / HR), int((Y0 + L1 - cy) / HR)
            if 0 <= i_ < N and 0 <= j_ < N and under[j_, i_]: continue  # measured off a bridge deck
        hits = tree.query(shapely.geometry.Point(cx, cy), predicate='within')
        if len(hits): by_g.setdefault(int(hits[0]), []).append((r, hg, rt))
    drop, add = set(), []
    for k, segs in by_g.items():
        b = bases[k]
        if b.get('m22'): continue  # the 2022 LiDAR's massing is finer
        ps = groups[gids[k]]
        gh = max(p['ridge'] or p['h'] for p in ps)
        cov = sum(ring_area(s[0]) for s in segs) / max(1.0, b['a'])
        top = max(s[1] for s in segs)
        if cov < 0.6 or b['mn'] > 0 or abs(top - gh) > max(6, 0.3 * gh): continue  # rebuilt since 2009, or a mismatch
        new = []
        for r, hg, rt in segs:
            p = dict(b, ring=r, h=hg, roof=0, ridge=0, mn=0, pitch=0, units=b['units'] if b['units'] is None else [], a=ring_area(r))
            mz = measure(r)
            z, ok = (mz[0], mz[1]) if mz else (None, None)
            if z is not None and ok.sum() >= 3:
                v = z[ok]
                if rt == 'pitched' and hg < 18:
                    f = fit_roof(r, z, mz[4], mz[2])
                    if f: p.update(roof=f[0], h=f[1], ridge=f[2], pitch=f[3])
                if not p['roof']:
                    p['h'] = float(pct(v, 70)) if abs(pct(v, 70) - hg) < max(4, 0.25 * hg) else hg
                    if p['a'] >= 60: p['units'] = roof_units(z, ok, p['h'], mz[2], obb(r)[2], np.zeros_like(ok))
            elif rt == 'pitched' and hg < 16:
                cx, cy, ang, hl, hw, ar = obb(r)
                if ring_area(r) / ar > 0.75 and hw > 2: p.update(roof=1 if hl / hw > 1.15 else 2, ridge=hg, h=max(2.6, hg - min(hw * 0.9, 3.5)))
            new.append(p)
        drop |= {id(p) for p in ps}
        add += new
    out[:] = [p for p in out if id(p) not in drop] + add


# ---------------------------------------------------------------- trees
def off_streets(trees, polys, in_building):
    """no trunk on a carriageway, a cycle track or a sidewalk's walking zone, as the ground draws them (the streets'
    pieces above; within 0.5 m of a carriageway counts, as the drawn kerb runs within a few dm of these, tools/tiles.py
    ground_partition()): a street tree stands in its boulevard, else in the tree pits along the kerb; one that can't is
    dropped. Crowns may still overhang the street. -> (trees, moved, dropped)"""
    from shapely.strtree import STRtree
    from shapely.ops import nearest_points
    carr = polys.get('road', []) + polys.get('arterial', []) + polys.get('cycle', [])
    if not trees or not carr: return trees, 0, 0
    walk, blvd = polys.get('sidewalk', []), polys.get('blvd', [])
    C, Wk, Bv = STRtree(carr), STRtree(walk or [Polygon()]), STRtree(blvd or [Polygon()])
    pts = shapely.points(np.array([(t[0], t[1]) for t in trees]))
    hit = lambda T, **k: set(T.query(pts, **k)[0].tolist())
    on_road, on_walk, on_blvd, pit = hit(C, predicate='dwithin', distance=0.5), hit(Wk, predicate='intersects'), hit(Bv, predicate='intersects'), hit(C, predicate='dwithin', distance=1.2)
    out, moved, dropped = [], 0, 0
    for i, t in enumerate(trees):
        if i not in on_road and (i not in on_walk or i in on_blvd or i in pit):
            out.append(t); continue
        p = pts[i]
        roads = unary_union([carr[k] for k in C.query(p.buffer(14))])
        spot = None
        strips = [blvd[k] for k in Bv.query(p.buffer(8))] if blvd else []
        if strips:  # the planting strip between the kerb and the sidewalk
            g = unary_union(strips).difference(roads.buffer(0.5)).buffer(-0.4)
            if not g.is_empty: spot = nearest_points(g, p)[0]
        if spot is None or spot.distance(p) > 8:  # a tree pit by the kerb
            spot = nearest_points(roads.buffer(0.9).boundary, p)[0]
        if spot.distance(p) > 8 or roads.distance(spot) < 0.5 or in_building(spot.x, spot.y): dropped += 1; continue
        out.append((spot.x, spot.y, *t[2:])); moved += 1
    return out, moved, dropped


def crown_widths(chm, canopy, at, hs):
    """crown diameter (m) of each tree at grid cell at[k] (height hs[k]): the canopy cells nearer to it than to any other
    crown, within reach of its height, as a disc of the same area"""
    if not at: return []
    mark = np.zeros(chm.shape, np.int32)
    for k, (y, x) in enumerate(at): mark[y, x] = k + 1
    d, (iy, ix) = ndimage.distance_transform_edt(mark == 0, return_indices=True)
    own = mark[iy, ix] - 1
    reach = (0.45 * np.asarray(hs, np.float32) + 2.0).clip(3, 13) / HR
    mine = canopy & (d <= reach[own])
    area = np.bincount(own[mine], minlength=len(at)) * HR * HR
    return [float(min(max(2 * math.sqrt(a / math.pi), 0.35 * h + 1.5), 1.1 * h + 3)) for a, h in zip(area, hs)]  # (np.clip, minus its overhead)


def crown_q(cw):
    """a crown width in the high nibble of a tree's colour byte (0 = not known: the page sizes it by its height)"""
    return min(15, max(1, round((cw - 2.0) / 1.4)))


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
    keep, crown_at = [], []
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
        crown_at.append((ys[k], xs[k]))
    # crown widths: every canopy cell belongs to the nearest kept crown (within reach of its height), so neighbouring
    # crowns meet the way the canopy does and a street of trees reads as one green mass, not a row of lollipops
    cw = crown_widths(chm, (chm > 3.0) & ~fp & ~water, crown_at, [k[2] for k in keep])  # crowns may overhang roofs
    # species: the city's inventory where it has the tree, else a guess from the crown and the land cover
    near = {}
    for x, y, genus, name, h in TREES:
        if X0 - 5 <= x < X0 + L1 + 5 and Y0 - 5 <= y < Y0 + L1 + 5: near.setdefault((int(x // 4), int(y // 4)), []).append((x, y, genus, h, name))
    out = []
    used = set()
    for (x, y, h), w in zip(keep, cw):
        g = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for c in near.get((int(x // 4) + dx, int(y // 4) + dy), []):
                    if math.hypot(c[0] - x, c[1] - y) < 4.5 and id(c) not in used: g = c; break
                if g: break
            if g: break
        if g:
            used.add(id(g)); shape, col = tree_look(g[2], rnd, g[4], w / max(1.0, h))
        else:
            py, px_ = int((Y0 + L1 - y) / HR), int((x - X0) / HR)
            ring = chm[max(0, py - 2):py + 3, max(0, px_ - 2):px_ + 3]
            peaky = (h - ring.mean()) / max(1, h)
            conifer = h > 24 or peaky > 0.22 or h > 14 and rnd.random() < 0.5
            wh = w / max(1.0, h)  # the crown's shape picks among the likely forms: Douglas firs and cedars in the woods,
            if conifer: shape, col = rnd.choice((6, 6, 4, 5) if wh > 0.75 and h < 20 else (4, 4, 4, 5, 5, 5, 6)), rnd.choice((5, 5, 7, 6))
            else:  # broad crowns spread or vase out, narrow ones are often columns
                shape = rnd.choice((2, 2, 8, 0) if wh > 1.25 else (1, 0, 0) if wh < 0.6 else (0, 0, 0, 0, 2, 8, 1, 3))
                col = rnd.choice((0, 0, 0, 0, 7, 1, 2, 4))
        out.append((x, y, shape, col | crown_q(w) << 4, min(63.0, h)))
    # young street trees the LiDAR can't see yet
    for cell, lst in near.items():
        for c in lst:
            if id(c) in used or c[3] > 9: continue
            if not (X0 <= c[0] < X0 + L1 and Y0 <= c[1] < Y0 + L1): continue
            py, px_ = int((Y0 + L1 - c[1]) / HR), int((c[0] - X0) / HR)
            if 0 <= py < N and 0 <= px_ < N and blocked[py, px_]: continue
            shape, col = tree_look(c[2], rnd, c[4])
            out.append((c[0], c[1], shape, col | crown_q(0.45 * c[3] + 1.5) << 4, c[3]))
    return out


def berths(docks, polys, areas, X0, Y0, rnd):
    """boats alongside the docks of marinas: one each side of a finger, then along the walkways wherever one fits
    (never over a dock, another boat or the shore). -> [(x, y, heading, length, kind)]"""
    from shapely import affinity
    marina = [Polygon(o).buffer(40) for _, prs, t in areas if t.get('leisure') == 'marina' for o, _ in prs if len(o) >= 4]
    if not marina: return []
    marina = unary_union(marina)
    water = unary_union(polys.get('water', [])) if polys.get('water') else None
    if water is None: return []
    shapely.prepare(water); shapely.prepare(marina)
    deck = unary_union([d.buffer(w / 2 + 0.3, cap_style='flat') for d, w in docks])
    shapely.prepare(deck)
    out, placed = [], {}  # placed: 20 m cell -> hulls (with a gap round them)
    for ls, w in sorted(docks, key=lambda d: d[0].length):  # fingers first: they decide the berths
        if not marina.intersects(ls): continue
        cs = list(ls.coords)
        for (ax, ay), (bx, by) in zip(cs, cs[1:]):
            seg = math.hypot(bx - ax, by - ay)
            if seg < 5: continue
            ux, uy = (bx - ax) / seg, (by - ay) / seg
            step = seg if seg < 26 else 0  # a finger: one berth per side, the length of the finger; a walkway: a row
            for side in (1, -1):
                s0 = 0.0
                while s0 < seg - 4:
                    ln = min(seg * 0.9, rnd.uniform(7, 15)) if step else rnd.uniform(8, 16)
                    if step: s0 = (seg - ln) / 2
                    beam = 0.32 * ln
                    off = w / 2 + beam / 2 + 0.6
                    cx, cy = ax + ux * (s0 + ln / 2) - uy * off * side, ay + uy * (s0 + ln / 2) + ux * off * side
                    hull = affinity.rotate(box(-ln / 2, -beam / 2, ln / 2, beam / 2), math.atan2(uy, ux), use_radians=True, origin=(0, 0))
                    hull = affinity.translate(hull, cx, cy)
                    cell = (int(cx // 20), int(cy // 20))
                    near = [q for i in (-1, 0, 1) for j in (-1, 0, 1) for q in placed.get((cell[0] + i, cell[1] + j), ())]
                    if rnd.random() < 0.85 and water.contains(hull) and not deck.intersects(hull) and not any(hull.intersects(q) for q in near):
                        placed.setdefault(cell, []).append(hull.buffer(0.4))
                        sail = ln > 8.5 and rnd.random() < 0.5
                        col = 0 if rnd.random() < 0.8 else rnd.randrange(1, 4)  # white, navy, dark green, blue
                        out.append((cx, cy, math.atan2(uy, ux) % (2 * math.pi), ln, (1 if sail else 0) | col << 1))
                    if step: break
                    s0 += ln + 1.2
    return out


# ---------------------------------------------------------------- roads, paths, rail
TURN_BITS = {'left': 1, 'slight_left': 2, 'through': 4, 'slight_right': 8, 'right': 16, 'reverse': 32, 'merge_to_left': 64, 'merge_to_right': 64, 'sharp_left': 1, 'sharp_right': 16}


def turn_lanes(v):
    """OSM turn:lanes 'left|through;right|' -> one bitmask per lane (0 = unmarked), at most 8 lanes"""
    if not v: return []
    out = []
    for lane in v.split('|')[:8]:
        m = 0
        for d in lane.split(';'): m |= TURN_BITS.get(d.strip(), 0)
        out.append(m)
    return out if any(out) else []


def road_pieces(items, dsm, dtm, X0, Y0, own=True):
    """pieces split at junctions: dict(kind, pts [(x,y)], z [..] or None, lanes, width, oneway, band, layer, a, b (node ids), name)"""
    deck_profiles()  # APPROACH comes with it: a spawned worker (macOS) has not loaded it yet
    use = {}
    ways = []
    for wid, coords, refs, t in items:
        k = line_kind(t)
        if not k: continue
        if t.get('tunnel') in TUNNEL and wid not in TUNNELS: continue
        if t.get('tunnel') == 'building_passage' and (t.get('bridge') not in (None, 'no') or on_level(t)): continue  # a skywalk through a building
        if t.get('covered') == 'yes' and k in ('rail', 'lightrail') and not t.get('tunnel') or t.get('area') == 'yes': continue
        if k in FOOT and hidden_walk(coords, t): continue
        new = sorted((e[2] for e in APPROACH.get(wid, ()) if e[2]), key=lambda n: n[:2], reverse=True)
        if new:  # an approach touches down between two nodes: a node there
            coords, refs = list(coords), list(refs)
            for seg, f, x, y, nid in new: coords.insert(seg + 1, (x, y)); refs.insert(seg + 1, nid)
        ways.append((wid, coords, refs, t, k))
        for r in refs: use[r] = use.get(r, 0) + 1
        use[refs[0]] += 1; use[refs[-1]] += 1
    out = []
    for wid, coords, refs, t, k in ways:
        lanes, w, ow, band = road_shape(k, t)
        if t.get('oneway') == '-1': coords, refs = coords[::-1], refs[::-1]
        bridge = t.get('bridge') not in (None, 'no')
        turns = (turn_lanes(t.get('turn:lanes:forward') or (t.get('turn:lanes') if ow else None)), turn_lanes(t.get('turn:lanes:backward')))
        if t.get('oneway') == '-1': turns = (turn_lanes(t.get('turn:lanes')), [])
        sv = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(np.asarray(coords, float), axis=0).T))])  # along the way, as drawn
        ap = [(*sorted((refs.index(r0), refs.index(r1))), refs.index(r0), s, z) for r0, r1, _, P, s, z, _ in APPROACH.get(wid, ()) if r0 in refs and r1 in refs]
        stops = {e for lo, hi, *_ in ap for e in (lo, hi)}  # an approach is pieces of its own, raised
        cut = [0] + [n for n in range(1, len(refs) - 1) if use.get(refs[n], 0) >= 2 or n in stops] + [len(refs) - 1]
        for a, b in zip(cut, cut[1:]):
            pts = coords[a:b + 1]
            mid = pts[len(pts) // 2]
            long_ = own and (sum(math.dist(p, q) for p, q in zip(pts, pts[1:])) > LONG or reaches_out(pts))
            if own and not long_ and not (X0 <= mid[0] < X0 + L1 and Y0 <= mid[1] < Y0 + L1): continue
            z, tube, kind = None, None, k
            raised = any(lo <= a and b <= hi for lo, hi, *_ in ap)
            if not own:  # surfaces only: every piece touching the tile, bridges and tunnels just flagged
                z = [0.0] if bridge or raised or wid in DECKS or wid in TUNNELS else None
            elif wid in TUNNELS:
                pts = densify(pts, 8)
                z, tube = tunnel_heights(wid, pts)
                tube = [2 if o and (e == 0 and refs[a] in PORTALS or e == len(pts) - 1 and refs[b] in PORTALS) else int(o) for e, o in enumerate(tube)]
            elif wid in DECKS:  # bridges, roads on roofs (deck_solve), from where the piece starts along the way
                rev = t.get('oneway') == '-1'
                pts, z = profile_at(pts, sv[-1] - sv[a] if rev else sv[a], -1 if rev else 1, *DECKS[wid][1:])
            elif raised:
                lo, hi, k0, S, Z = next(e for e in ap if e[0] <= a and b <= e[1])
                da, db = abs(sv[a] - sv[k0]), abs(sv[b] - sv[k0])
                pts, z = profile_at(pts, da, 1 if db >= da else -1, S, Z)
            if z and tube is None and own and k in FOOT and max(abs(z1 - z0) / max(1e-6, math.dist(p0, p1)) for p0, p1, z0, z1 in zip(pts, pts[1:], z, z[1:])) > 0.3:
                kind = 'steps'  # stairs off a footbridge, a footbridge steeper than a ramp
            d = dict(turns=turns, own=mid, kind=kind, pts=pts, z=z, tube=tube, src='tunnel' if wid in TUNNELS else 'deck' if bridge or wid in DECKS else 'approach', roof=wid in ROOFS, lanes=lanes, w=w, ow=ow, band=band and tube is None, layer=int(hnum(t.get('layer')) or 0), a=refs[a], b=refs[b],
                     name=t.get('name', ''), drive=k in DRIVE and t.get('access') not in ('private', 'no') and t.get('highway') != 'busway',
                     crossing=k in ('footway', 'cycleway', 'path') and (t.get('footway') == 'crossing' or t.get('cycleway') == 'crossing') and t.get('crossing') not in ('unmarked', 'no'))
            for e in split_long(d, wid * 1024 + a) if long_ else [d]:
                if not own or X0 <= e['own'][0] < X0 + L1 and Y0 <= e['own'][1] < Y0 + L1: out.append(e)
    return out


def hidden_walk(coords, t):
    """a walkway OpenStreetMap layers off the ground without a bridge or a tunnel tag, where the LiDAR has a structure
    over the ground along it: up on a podium or a skywalk (layer >= 1, 3.5 to 15 m up along half of it), or under a
    building or a plaza (layer < 0, more than 4 m over it along 70%). Drawn on the ground it would run through or under
    the thing it is on or in: not drawn (tools/audit_elev.py 'untagged', 'tunnel')"""
    lay = hnum(t.get('layer')) or 0
    if not lay or t.get('bridge') not in (None, 'no') or t.get('tunnel') not in (None, 'no'): return False
    Q = np.array(densify([tuple(p) for p in coords], 4.0))
    if len(Q) * 4 < (20 if lay > 0 else 40): return False
    up = hr_lookup(Q[:, 0], Q[:, 1], 0) - hr_lookup(Q[:, 0], Q[:, 1], 1)
    with np.errstate(invalid='ignore'):
        return bool(((up > 3.5) & (up < 15)).mean() > 0.5) if lay > 0 else bool((up > 4).mean() > 0.7)


LONG = 500  # metres: a piece longer than this is cut at the detail tiles' edges, as is one reaching out of its tile


def reaches_out(pts, m=2.0):
    """does a piece reach more than m metres out of the detail tile of its middle? The page drapes a piece's paint and
    traffic on its own tile's terrain, held at the tile's edge past it (paint metres off the ground on a hillside)"""
    mid = pts[len(pts) // 2]
    x0, y0 = math.floor(mid[0] / L0) * L0, math.floor(mid[1] / L0) * L0
    return any(x < x0 - m or x > x0 + L0 + m or y < y0 - m or y > y0 + L0 + m for x, y in pts)


def halfway(pts):
    """the point half way along a polyline (the tile a piece cut at the tiles' edges lies in: the mean of its ends can be
    on the edge, or in the next tile when it leaves and comes back)"""
    return tuple(shapely.LineString(pts).interpolate(0.5, normalized=True).coords[0]) if len(pts) > 1 else tuple(pts[0])


def split_long(d, key):
    """a long piece (a bridge's span, a motorway between interchanges) cut where it crosses a detail tile's edge, each
    part in the tile it lies in (the page reads a tile's roads only near it, and loads tiles only near the view: the
    Lions Gate Bridge, one 1.5 km way, lived in the tile at its north end), joined by nodes of our own (below 2^53)"""
    P, Z, T = [d['pts'][0]], [d['z'][0]] if d['z'] else None, [d['tube'][0]] if d['tube'] else None
    cuts = []
    for n, (p, q) in enumerate(zip(d['pts'], d['pts'][1:])):
        ts = sorted({(e * L0 - p[c]) / (q[c] - p[c]) for c in (0, 1) if q[c] != p[c] for e in range(math.floor(min(p[c], q[c]) / L0) + 1, math.floor(max(p[c], q[c]) / L0) + 1)})
        for f in ts + [1.0]:
            if 1e-6 < f < 1 - 1e-6 or f == 1.0:
                P.append((p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f))
                if Z: Z.append(d['z'][n] + (d['z'][n + 1] - d['z'][n]) * f)
                if T: T.append(d['tube'][n + 1] if f == 1.0 else int(bool(d['tube'][n] or d['tube'][n + 1])))
                if f < 1.0: cuts.append(len(P) - 1)
    if not cuts: return [d]
    out, ends = [], [0] + cuts + [len(P) - 1]
    for c, (i, j) in enumerate(zip(ends, ends[1:])):
        pts = P[i:j + 1]
        out.append({**d, 'pts': pts, 'z': Z[i:j + 1] if Z else None, 'tube': T[i:j + 1] if T else None, 'own': halfway(pts),
                    'a': d['a'] if c == 0 else (3 << 51) + key * 64 + c - 1, 'b': d['b'] if j == len(P) - 1 else (3 << 51) + key * 64 + c})
    return out


# ---------------------------------------------------------------- bridge decks
# Every bridge's deck profile is worked out once for the whole map (so a bridge reads the same from every tile it
# crosses), from the LiDAR surface across the deck: a low percentile across its width (cars, railings, cables and
# trusses sit above the deck), samples far above the along-bridge profile dropped, the grade clamped, then smoothed.
# Sidewalks and cycle decks mapped beside a road deck take that deck's height; a long bridge the LiDAR does not have
# yet (stal̕əw̓asəm, 2024) or one under the trees spans between its abutments. Cached in data/decks.pkl, keyed on the
# deck code (code_key) and every data/feat and data/hr file's content: redone only when one of them changes.
DECK_CACHE = os.environ.get('DECK_CACHE', 'data/decks.pkl')
GRADE = 0.07  # steepest deck grade kept, rise per metre
STAIRS = 0.7  # rise per metre of the stairs down off a footbridge end where OpenStreetMap maps none
FOOT = {'footway', 'cycleway', 'path', 'pedestrian', 'steps', 'track'}
DECKS = None
APPROACH = {}  # at-grade way id -> [(deck end node, touchdown node, new node or None, points, distance along, height, {sample: node})]
TUNNEL = ('yes', 'culvert')  # underground (a building_passage runs at grade, under the building)
TUNNELS, PORTALS = {}, set()  # tunnel way id -> (points, along, height, open); nodes where a tunnel comes out
RETUN = {}  # at-grade way id -> {its end (0, -1): (metres of it from there in the tunnel it goes on from, the ground at that mouth)} (tunnel_mouths)
MOUTH = 250  # metres from a mapped portal its real mouth is looked for
MOUTH_OUT = 4  # metres the tube goes on past the foot of the portal's face (its mouth stands out of the bank)


def mouth_ids(wid, end):
    """the ids of the tunnel way cut off a way's end and of its node at the mouth: over every real one, under 2^53 for the page"""
    new = (1 << 33) + wid * 2 - end
    return new, (1 << 52) + new * 64
ROOFS = set()  # roads on roofs (decks the building carries)


def cut_way(coords, refs, s, nid):
    """a way's first s metres and the rest (s short of its length), a node (nid) where they part"""
    acc = 0.0
    for n, (p, q) in enumerate(zip(coords, coords[1:])):
        d = math.dist(p, q)
        if acc + d > s:
            f = (s - acc) / d; m = (p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f)
            return (list(coords[:n + 1]) + [m], list(refs[:n + 1]) + [nid]), ([m] + list(coords[n + 1:]), [nid] + list(refs[n + 1:]))
        acc += d


def retunnel(lines):
    """OpenStreetMap's lines with RETUN's stretches made tunnels: each cut off its way as a way of its own, the rest of
    the way at grade from the mouth"""
    if not any(L[0] in RETUN for L in lines): return lines
    out = []
    for wid, coords, refs, t in lines:
        for end, (s, _) in sorted(RETUN.get(wid, {}).items()):  # (its far end first)
            if end: coords, refs = coords[::-1], refs[::-1]
            new, nid = mouth_ids(wid, end)
            (c, r), (coords, refs) = cut_way(coords, refs, s, nid)
            if end: c, r, coords, refs = c[::-1], r[::-1], coords[::-1], refs[::-1]
            out.append((new, c, r, {**t, 'tunnel': 'yes', 'layer': t.get('layer') or '-1'}))
        out.append((wid, coords, refs, t))
    return out


def tunnel_mouths(files):
    """RETUN: where a road tunnel's mapped portal is short of its mouth. The one road going on from the portal at grade
    runs on the LiDAR's ground there, the tunnel's cover, and then drops off it (3.5 m in 12 m: the portal's face, no
    road is that steep) and stays down, a road in its cut: it is in the tunnel as far as the foot of that drop and
    MOUTH_OUT on, the tunnel's road at the LiDAR's ground there (level across, as road_ground takes the road outside). (The road looked at is the one way at the portal: a mouth further off than that way is long stays as mapped)"""
    ends, touch, cand = {}, {}, {}  # a road tunnel's end node -> the tunnels ending there, the other roads at it; road -> its line
    for f in files:
        for wid, coords, refs, t in pickle.load(open(f, 'rb')).get('lines', []):
            if t.get('tunnel') in TUNNEL and line_kind(t) in DRIVE and len(coords) > 1:
                for r in (refs[0], refs[-1]): ends.setdefault(r, set()).add(wid)
    for f in files:
        for wid, coords, refs, t in pickle.load(open(f, 'rb')).get('lines', []):
            k = line_kind(t)
            if k not in DRIVE or t.get('tunnel') in TUNNEL or len(coords) < 2 or not any(r in ends for r in refs): continue
            for r in refs:
                if r in ends: touch.setdefault(r, set()).add(wid)
            if t.get('bridge') in (None, 'no') and not t.get('tunnel') and t.get('covered') != 'yes' and t.get('area') != 'yes' and not on_level(t):
                cand[wid] = (coords, refs, road_shape(k, t)[1])
    out = {}
    for r in sorted(ends):
        if len(ends[r]) != 1 or len(touch.get(r, ())) != 1: continue  # (a joint of tunnels, a junction at the portal)
        wid = next(iter(touch[r]))
        if wid not in cand or r not in (cand[wid][1][0], cand[wid][1][-1]): continue
        coords, refs, w = cand[wid]
        end = 0 if refs[0] == r else -1
        P = np.array(densify(coords[::-1] if end else coords, 2)); s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
        g = level_across(P, w)
        near = np.nonzero(s <= MOUTH)[0]
        face = next((m for m in near if s[m] >= 24 and g[m] < np.interp(s[m] - 12, s, g) - 3.5), None)
        if face is None: continue
        foot = face + int(np.argmin(g[face:face + 7]))
        on = (s >= s[foot] + 16) & (s <= s[foot] + 40)  # the road on from the foot: still that far under the cover (not a dip it crosses)
        if s[-1] < s[foot] + 40 or np.median(g[on]) > np.interp(s[face] - 12, s, g) - 3.5: continue
        m = foot
        for j in np.nonzero((s > s[foot]) & (s <= s[foot] + 30))[0]:  # past what stands over the road just outside (a portal building): to where the road is down again
            if j > m and g[j] > g[foot] + 2:
                m = next((k for k in range(j, len(s)) if s[k] <= s[foot] + 30 and g[k] <= g[foot] + 1.5), m)
        cut = float(s[m]) + MOUTH_OUT
        out.setdefault(wid, {})[end] = (cut, float(np.interp(cut, s, g)))
    for wid in [w for w, d in out.items() if len(d) > 1]:  # (a tunnel at both ends: only if they leave road between them)
        if sum(c for c, _ in out[wid].values()) > sum(math.dist(p, q) for p, q in zip(cand[wid][0], cand[wid][0][1:])) - 6: del out[wid]
    return out


def level_across(P, w):
    """the LiDAR's ground along a road (points P, width w), level across: the middle of its centre line's and its
    kerbs', as road_ground takes a street's"""
    t = np.gradient(P, axis=0); t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-6)[:, None]
    n = np.stack([-t[:, 1], t[:, 0]], 1) * max(0.0, w / 2 - 0.5)
    return np.median(ground_at(*np.concatenate([P, P + n, P - n]).T).reshape(3, -1), axis=0)


def ground_at(x, y):
    """the LiDAR ground at world points, MRDEM where HRDEM has none"""
    x, y = np.asarray(x, float).ravel(), np.asarray(y, float).ravel()
    g = hr_lookup(x, y, 1)
    return np.where(np.isfinite(g), g, MR[((MR_Y1 - y) / 32).astype(int).clip(0, MR.shape[0] - 1), ((x - MR_X0) / 32).astype(int).clip(0, MR.shape[1] - 1)])


def drawn_ground(x, y):
    """the ground as the page draws it: bilinear on the detail tiles' 8 m terrain grid"""
    c = L0 / 128
    fx, fy = np.asarray(x, float).ravel() / c, np.asarray(y, float).ravel() / c
    i, j = np.floor(fx), np.floor(fy); u, v = fx - i, fy - j
    g = ground_at(np.concatenate([i, i + 1, i, i + 1]) * c, np.concatenate([j, j, j + 1, j + 1]) * c).reshape(4, -1)
    return g[0] * (1 - u) * (1 - v) + g[1] * u * (1 - v) + g[2] * (1 - u) * v + g[3] * u * v


def on_level(t):
    """a way OpenStreetMap puts above the ground floor (layer or level 1 and up), not inside a building"""
    lv = t.get('level', '')
    return not t.get('indoor') and ((hnum(t.get('layer')) or 0) >= 1 or ';' not in lv and (hnum(lv) or 0) >= 1)


def deck_samples(coords, w):
    """samples every 4 m along a way: (points, distance along, low surface across the deck, the lower of the ground
    25 m out to either side)"""
    P = np.array(densify(coords, 4), float)
    s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
    t = np.gradient(P, axis=0); t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-6)[:, None]
    n = np.stack([-t[:, 1], t[:, 0]], 1)
    half = max(1.5, w * 0.4)
    across = np.linspace(-half, half, max(3, int(half) + 1)); along = np.array([-2.0, 0.0, 2.0])
    q = P[:, None, None, :] + n[:, None, None, :] * across[None, :, None, None] + t[:, None, None, :] * along[None, None, :, None]
    v = hr_lookup(q[..., 0], q[..., 1], 0).reshape(len(P), -1)
    v[v < hr_lookup(q[..., 0], q[..., 1], 1).reshape(len(P), -1) - 2] = np.nan  # no deck below the ground (the survey's water glitches: -600 m)
    with np.errstate(all='ignore'):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            low = np.nanpercentile(v, 20, axis=1)
    off = w / 2 + 25
    side = np.fmin(hr_lookup(*(P + n * off).T, 1), hr_lookup(*(P - n * off).T, 1))
    return P, s, low, side


def guideway_deck(P, s, low):
    """a guideway's profile (SkyTrain: no trusses or cables over it). Its OpenStreetMap line is often metres off the
    structure (at stations, where the tracks fan out, on curves), so the LiDAR over the line sees the ground or the cut
    beside it: at each sample the structure's low edge up to 6 m to either side where it stands well over what the
    line sees, then the upper part of that along the way (gaps filled, a train on it ignored), the grade clamped"""
    g = hr_lookup(P[:, 0], P[:, 1], 1)
    ok = np.isfinite(low)
    if not ok.any(): return None
    lo = np.interp(s, s[ok], low[ok])
    t = np.gradient(P, axis=0) if len(P) > 1 else np.array([[1.0, 0.0]]); t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-6)[:, None]
    n = np.stack([-t[:, 1], t[:, 0]], 1)
    z = lo.copy()
    for o in np.arange(-6.0, 6.5, 1.0):
        q = P[:, None, :] + n[:, None, :] * (o + np.array([-1.5, 0.0, 1.5]))[None, :, None]
        v = hr_lookup(q[..., 0], q[..., 1], 0).reshape(len(P), 3)
        with np.errstate(all='ignore'):
            v = np.nanmin(np.where(v < g[:, None] - 2, np.nan, v), axis=1)  # the structure's low edge there
            z = np.where((lo - g < 4) & (v > lo + 3) & (v - g > 4) & (v > z), v, z)  # only where the line sees the ground
    if len(z) >= 5: z = ndimage.percentile_filter(z, 60, size=min(len(z), 9), mode='nearest')
    ds = np.diff(s)
    for k in range(1, len(z)): z[k] = max(z[k], z[k - 1] - GRADE * ds[k - 1])  # dips filled, then spikes cut
    for k in range(len(z) - 2, -1, -1): z[k] = max(z[k], z[k + 1] - GRADE * ds[k])
    for k in range(1, len(z)): z[k] = min(z[k], z[k - 1] + GRADE * ds[k - 1])
    for k in range(len(z) - 2, -1, -1): z[k] = min(z[k], z[k + 1] + GRADE * ds[k])
    return ndimage.uniform_filter1d(z, 5, mode='nearest') if len(z) >= 5 else z


def wooded(P, low, w):
    """a footbridge's LiDAR is the canopy over it: tall trees beside it, and the "deck" well above the ground at both
    of its ends (where a real one meets the path)"""
    t = np.gradient(P, axis=0) if len(P) > 1 else np.array([[1.0, 0.0]])
    t = t / np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-6)[:, None]; n = np.stack([-t[:, 1], t[:, 0]], 1) * (w / 2 + 6)
    side = np.concatenate([hr_lookup(*(P + n).T, 0) - hr_lookup(*(P + n).T, 1), hr_lookup(*(P - n).T, 0) - hr_lookup(*(P - n).T, 1)])
    gap = low[[0, -1]] - hr_lookup(P[[0, -1], 0], P[[0, -1], 1], 1)
    with np.errstate(all='ignore'):
        return bool(np.nanmedian(side) > 8 and np.all(gap > 3)) if np.isfinite(side).any() else False


def robust_deck(s, z):
    """drop what stands above the deck (trusses, stay cables, pylons), clamp the grade, smooth; None if no samples"""
    ok = np.isfinite(z)
    if not ok.any(): return None
    z = np.interp(s, s[ok], z[ok])
    if len(z) > 4:
        z = ndimage.median_filter(z, 5, mode='nearest')  # lone glitches (expansion joints, a gap) either way
        # a running fit along the deck (straight over ~200 m, then a curve over ~400 m, so crests and sags are kept);
        # what stands well above it (trusses, stay cables, pylons) is dropped, then again with a tighter margin
        keep = np.ones(len(z), bool)
        u = (s - s.mean()) / 1000.0
        for margin, win, deg in ((6.0, 51, 1), (3.0, 51, 1), (1.5, 51, 1), (1.5, 101, 2), (1.5, 101, 2)):
            f = lambda a: ndimage.uniform_filter1d(a, min(len(z), win), mode='nearest')
            w = keep.astype(float)
            M = np.stack([np.stack([f(w * u ** (i + j)) for j in range(deg + 1)], -1) for i in range(deg + 1)], -2)
            r = np.stack([f(w * z * u ** i) for i in range(deg + 1)], -1)
            ok_ = np.abs(np.linalg.det(M)) > 1e-12
            fit = z.copy()
            if ok_.any():
                c = np.linalg.solve(M[ok_], r[ok_][..., None])[..., 0]
                fit[ok_] = sum(c[:, i] * u[ok_] ** i for i in range(deg + 1))
            keep = (z < fit + margin) & (z > fit - 4)
            if keep.sum() < 2: break
        if keep.sum() >= 2: z = np.interp(s, s[keep], z[keep])
    ds = np.diff(s)
    for _ in range(2):  # lower envelope of slope GRADE (cuts spikes), then the upper one (fills dips)
        for k in range(1, len(z)): z[k] = min(z[k], z[k - 1] + GRADE * ds[k - 1])
        for k in range(len(z) - 2, -1, -1): z[k] = min(z[k], z[k + 1] + GRADE * ds[k])
    for k in range(1, len(z)): z[k] = max(z[k], z[k - 1] - GRADE * ds[k - 1])
    for k in range(len(z) - 2, -1, -1): z[k] = max(z[k], z[k + 1] - GRADE * ds[k])
    return ndimage.uniform_filter1d(z, 5, mode='nearest') if len(z) >= 5 else z


def deck_profiles():
    """{way id: (way coords, distance along of each sample, deck height)} for every bridge on the map"""
    global DECKS
    if DECKS is not None: return DECKS
    import glob
    files = sorted(glob.glob('data/feat/*.pkl'))
    key = digest(code_key(__file__, 'deck_profiles'), files_digest(files + sorted(glob.glob('data/hr/*.npz')) + ['data/sea.npz', 'data/mrdem32.npz']))
    if os.path.exists(DECK_CACHE):
        d = pickle.load(open(DECK_CACHE, 'rb'))
        if d.get('key') == key:
            DECKS = d['decks']; APPROACH.update(d['approach']); TUNNELS.update(d['tunnels']); PORTALS.update(d['portals']); ROOFS.update(d['roofs']); RETUN.update(d['retun'])
            return DECKS
    t0 = time.time()
    import common
    common.HR_KEEP = 10 ** 6  # every LiDAR tile stays loaded for the pass (reloading them was 3/4 of its time)
    ways, tun, roofs, water = {}, {}, ROOFS, []
    from shapely.strtree import STRtree
    RETUN.clear(); RETUN.update(tunnel_mouths(files))
    for f in files:
        d = pickle.load(open(f, 'rb'))
        tops, blds, here = {}, None, False
        lines = retunnel(d.get('lines', []))
        for wid, coords, refs, t in lines:
            k = line_kind(t)
            if not k or len(coords) < 2 or t.get('area') == 'yes': continue
            if t.get('tunnel') in TUNNEL:
                tun[wid] = (coords, refs, k, road_shape(k, t)[1]); here = True
            elif t.get('bridge') not in (None, 'no'):
                if t.get('tunnel') != 'building_passage': ways[wid] = (coords, refs, t, k)
            elif k in DRIVE and not t.get('tunnel') and t.get('covered') != 'yes' and on_level(t):
                # a road up on a building (a mall's rooftop parking, a parkade's top deck): a deck if it is mostly over
                # a footprint and the LiDAR sees it well above the ground (below: the low surface across it)
                if blds is None: blds = STRtree([Polygon(o).buffer(0) for _, prs, _ in d.get('buildings', []) for o, _ in prs if len(o) >= 4])
                P = np.array(densify(coords, 4))
                if len(blds.geometries) and len(np.unique(blds.query(shapely.points(P), predicate='within')[0])) > 0.5 * len(P):
                    ways[wid] = (coords, refs, t, k); roofs.add(wid)
        for wid, (coords, refs, k, w) in tun.items():  # where a tunnel meets a line that isn't one: its portal
            for r in (refs[0], refs[-1]): tops[r] = wid
        if here: water += [Polygon(o, [h for h in ins if len(h) >= 4]).buffer(0) for _, prs, t in d.get('areas', []) if ground_class(t) == 'water' for o, ins in prs if len(o) >= 4]
        for wid, coords, refs, t in lines:
            if wid not in tun and line_kind(t): PORTALS.update(r for r in refs if r in tops)
    raw = {}
    for wid, (coords, refs, t, k) in sorted(ways.items(), key=lambda kv: (int(kv[1][0][0][0] // L1), int(kv[1][0][0][1] // L1))):
        P, s, low, gnd = deck_samples(coords, road_shape(k, t)[1])
        if wid in roofs:
            up = low - hr_lookup(P[:, 0], P[:, 1], 1)
            with np.errstate(invalid='ignore'):
                if np.mean((up > 3) & (up < 25)) < 0.6: del ways[wid]; roofs.discard(wid); continue  # at grade after all (a car park beside it)
        raw[wid] = (P, s, low, gnd)
    layer = {wid: int(hnum(t.get('layer')) or 0) for wid, (c, r, t, k) in ways.items()}
    prof = {}
    missing, canopy = set(), set()
    for wid, (P, s, low, gnd) in raw.items():
        L = s[-1]
        mid = (s > 0.15 * L) & (s < 0.85 * L)
        g = np.nan_to_num(gnd, nan=0.0)
        if wid not in roofs and layer[wid] >= 1 and L > 80 and mid.any() and np.mean(~np.isfinite(low[mid]) | (low[mid] - g[mid] < 2)) > 0.6:
            missing.add(wid)  # the surface is no higher than the land and water beside it: the deck is newer than the survey
        elif wid not in roofs and ways[wid][3] in FOOT | {'service', 'residential', 'tertiary'} and L < 400 and wooded(P, low, road_shape(ways[wid][3], ways[wid][2])[1]):
            missing.add(wid); canopy.add(wid)  # a small bridge under the trees: the LiDAR sees their crowns, not the deck
        else:
            z = guideway_deck(P, s, low) if ways[wid][3] == 'lightrail' else robust_deck(s, low)
            if z is not None: prof[wid] = z
    # ends: a node shared by bridge ways gets one height
    ends = {}
    for wid, (coords, refs, t, k) in ways.items():
        for e, r in ((0, refs[0]), (-1, refs[-1])): ends.setdefault((r, layer[wid]), []).append((wid, e))
    # missing decks: from abutment to abutment (where they meet a deck we have, or the ground) with a gentle crest
    for wid in missing:
        coords, refs, t, k = ways[wid]
        P, s, low, gnd = raw[wid]
        hs = []
        for e, r in ((0, refs[0]), (-1, refs[-1])):
            nb = [prof[w][e2] for w, e2 in ends[(r, layer[wid])] if prof.get(w) is not None]
            hs.append(float(np.mean(nb)) if nb else float(np.nan_to_num(hr_lookup(P[e, :1], P[e, 1:], 1)[0], nan=0.0)))
        prof[wid] = None  # filled below, once neighbours along the same missing bridge are known
        ways[wid] = (coords, refs, t, k, hs)
    # chain the missing ways of one bridge (shared nodes) so the crest spans the whole river, not each way
    comp = {wid: wid for wid in missing}
    def root(a):
        while comp[a] != a: comp[a] = comp[comp[a]]; a = comp[a]
        return a
    for (r, lay), lst in ends.items():
        ms = [w for w, _ in lst if w in missing]
        for a, b in zip(ms, ms[1:]): comp[root(a)] = root(b)
    groups = {}
    for wid in missing: groups.setdefault(root(wid), []).append(wid)
    for g in list(groups.values()):
        pts = np.concatenate([raw[w][0] for w in g])
        wet = sum(4 * np.sum(~np.isfinite(raw[w][2]) | (raw[w][2] < 2.5)) for w in g)  # metres of it at water level
        if not canopy.intersection(g) and (np.ptp(pts[:, 0]) ** 2 + np.ptp(pts[:, 1]) ** 2 < 300 ** 2 or wet < 100):  # a new river crossing, not odd LiDAR
            for w in g:
                missing.discard(w); ways[w] = ways[w][:4]
                z = robust_deck(raw[w][1], raw[w][2].copy())
                if z is not None: prof[w] = z
                else: prof.pop(w, None)
            groups = {k: v for k, v in groups.items() if v is not g}
    for g in groups.values():
        pts = np.concatenate([raw[w][0] for w in g])
        # the bridge's axis: its two farthest-apart points; each end's height from the ways' outer ends nearest it
        a = pts[np.argmax(np.hypot(*(pts - pts.mean(0)).T))]; b = pts[np.argmax(np.hypot(*(pts - a).T))]
        ax = (b - a) / max(1e-6, np.hypot(*(b - a))); Lb = float(np.hypot(*(b - a)))
        ha, hb = [], []
        for w in g:
            coords, refs, t, k, hs = ways[w]
            for e, h in zip((0, -1), hs):
                if sum(1 for w2, _ in ends[(refs[e], layer[w])] if w2 in missing) > 1: continue  # inner joint, not an abutment
                (ha if np.dot(raw[w][0][e] - a, ax) < Lb / 2 else hb).append(h)
        h0 = float(np.mean(ha)) if ha else 0.0; h1 = float(np.mean(hb)) if hb else h0
        crest = 0.016 * Lb if not canopy.issuperset(g) else min(1.0, 0.016 * Lb)  # end grades about 6%; a footbridge barely arches
        for w in g:
            u = np.clip((raw[w][0] - a) @ ax / max(Lb, 1e-6), 0, 1)
            prof[w] = h0 + (h1 - h0) * u + crest * 4 * u * (1 - u)
    for wid in missing: ways[wid] = ways[wid][:4]
    # sidewalks and cycle decks beside a road deck (within 25 m, same layer) ride on it
    from shapely.strtree import STRtree
    roads = {}
    for wid, (coords, refs, t, k) in ways.items():
        if k in DRIVE and prof.get(wid) is not None: roads.setdefault(layer[wid], []).append(wid)
    trees = {lay: (STRtree([LineString(ways[w][0]) for w in ws]), ws) for lay, ws in roads.items()}
    for wid, (coords, refs, t, k) in ways.items():
        if k not in FOOT or layer[wid] not in trees or prof.get(wid) is None: continue
        tree, ws = trees[layer[wid]]
        P = raw[wid][0]
        pts = shapely.points(P)
        idx, dist = tree.query_nearest(pts, max_distance=25, return_distance=True, all_matches=False)
        if not len(idx[0]): continue
        z = prof[wid].copy()
        for i_, j_ in zip(*idx):
            rw = ws[j_]; line = LineString(ways[rw][0])
            z[i_] = np.interp(line.project(pts[i_]), raw[rw][1], prof[rw])
        z = robust_deck(raw[wid][1], z) if len(idx[0]) < len(P) else z
        prof[wid] = ndimage.uniform_filter1d(z, 9, mode='nearest') if len(z) >= 9 else z  # beside two decks: no hopping
    # the heights where decks meet, of their branches and their approaches: one solve over every structure (deck_solve)
    DECKS = {w: (np.asarray(ways[w][0], np.float64), raw[w][1].astype(np.float32), np.asarray(prof[w], np.float32)) for w in prof if prof[w] is not None}
    tops = {}
    for w, (c, s, z) in DECKS.items():
        sv = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(c, axis=0).T))])
        for r, x, y, h in zip(ways[w][1], c[:, 0], c[:, 1], np.interp(sv, s, z)): tops.setdefault(r, []).append((x, y, h))
    endn = {}
    for w in DECKS:
        for r in (ways[w][1][0], ways[w][1][-1]): endn[r] = endn.get(r, 0) + 1
    ap, grade = approaches(files, {r: np.mean(v, axis=0) for r, v in tops.items()}, {r for r, v in tops.items() if len(v) > 1 or r not in endn})
    APPROACH.clear(); APPROACH.update(ap)
    TUNNELS.update(tunnel_profiles(tun, STRtree(water) if water else None, {mouth_ids(w, e)[1]: h for w, d in RETUN.items() for e, (_, h) in d.items()}))
    deck_solve(ways, raw, grade, tun)
    for w, (P, s, z, op) in TUNNELS.items(): TUNNELS[w] = (P, s, z, tunnel_ground(P, tun[w][3]) < z + tube_h(tun[w][2]) + SLAB + 0.3)  # (open: as solved)
    HR_CACHE.clear(); common.HR_KEEP = 12
    try: pickle.dump({'key': key, 'decks': DECKS, 'approach': APPROACH, 'tunnels': TUNNELS, 'portals': PORTALS, 'roofs': ROOFS, 'retun': RETUN}, open(DECK_CACHE, 'wb'), protocol=5)
    except OSError: pass
    print('bridge decks', len(DECKS), 'of', len(ways), 'ways,', len(roofs), 'on roofs,', len(missing), 'not in the LiDAR,', len(APPROACH), 'approaches,',
          len(TUNNELS), 'tunnels', round(time.time() - t0), 's', flush=True)
    return DECKS


GAVE = []  # the rules deck_solve could not hold: (rule, x, y, by how much, structure)
MERGE = 3.0  # metres: decks drawn over each other within this of each other's height anywhere along their overlap are one surface there
SEP = 3.2  # metres: decks stacked further apart than MERGE keep their drawn tops this far apart (tools/geom_rules.py CLEAR)
DRAWN = DRIVE | FOOT | {'rail', 'lightrail'}  # the kinds the page draws a deck strip for (tile-worker.js roads())


def deck_limit(k):  # the steepest a deck may climb (tools/geom_rules.py _limit), a hair under
    return 8.9 if k == 'steps' else 0.245 if k in FOOT else 0.115


def deck_design(k):  # the grade a structure is built to, where its LiDAR doesn't say otherwise
    return {'rail': 0.03, 'lightrail': 0.06, 'steps': 0.8}.get(k, 0.10 if k in FOOT else 0.08)


MILP_NODES = 300  # branch-and-bound nodes a structure's MILP may take (a bound in nodes, not seconds: the same answer every run)
WINDOW = 32  # samples (4 m apart) out from a stretch drawn over another its MILP's window reaches in a structure over MILP_ROWS
WIN_ROWS = 2000  # rows of a window's MILP (a window's cost grows faster than its rows)
WIN_NODES = 100  # branch-and-bound nodes of a window's MILP
MILP_ROWS = 8000  # rows of the biggest structure the MILP is tried on (its root alone takes seconds over that)


def deck_program(rs, runs, W, M_=40.0, nodes=MILP_NODES):
    """deck_solve's LP over one structure's rows (runs: its stretches drawn over each other, {n: (one way?, [(var, other's
    var j, j + 1, fraction, sample)])}, each one surface or stacked either way up as the solve finds best, binaries: then
    a MILP, those stretches' own rows left out): ({var: height}, [(tag, sample, slack)], cost), or Nones.
    M_: metres, big enough for any two decks drawn over each other (the stretches more than 15 m apart are left out)"""
    from scipy.optimize import milp, LinearConstraint, Bounds
    from scipy.sparse import coo_matrix
    vs = sorted({v for r in rs for v, _ in r[1]} | {k for n in runs for t in runs[n][1] for k in t[:3]}); col = {v: n for n, v in enumerate(vs)}; nv = len(vs)
    A, lo_, hi_, cost, tags = ([], [], []), [], [], [0.0] * nv, []
    def con(terms, l, u):
        for v, a in terms: A[0].append(len(lo_)); A[1].append(v); A[2].append(a)
        lo_.append(l); hi_.append(u)
    h0 = float(np.median([r[2] for r in rs if r[4] and len(r[1]) == 1] or [0.0]))  # (heights about this one: better conditioned)
    for _, terms, rhs, cst, both, tag, at in rs:
        if isinstance(tag, tuple) and tag[1] in runs: continue
        rhs = 0.0 if cst is None else rhs - h0 * sum(a for _, a in terms)  # (ties: their terms sum to nothing)
        T = [(col[v], a) for v, a in terms]
        if cst is None: con(T, rhs, rhs); continue
        t_ = len(cost); cost.append(cst)
        if tag: tags.append((t_, tag, at))
        con(T + [(t_, -1.0)], -np.inf, rhs)
        if both: con(T + [(t_, 1.0)], rhs, np.inf)
    ints = []
    for n in sorted(runs):  # one surface (b0), or this one SEP over the other (b1) or under it (b2)
        same, sm = runs[n]
        b = [len(cost), len(cost) + 1, len(cost) + 2]; cost += [0.0, 0.0, 0.0]; ints += b
        con([(b[0], 1.0), (b[1], 1.0), (b[2], 1.0)], 1.0, 1.0)
        if same: con([(b[0], 1.0)], 1.0, 1.0)
        for v, j0, j1, f, q in sm:
            if v == j0 == j1: continue
            d = [(col[v], 1.0), (col[j0], -(1 - f)), (col[j1], -f)]
            t_ = len(cost); cost.append(W['tie']); tags.append((t_, ('ov', n), q))
            con(d + [(t_, -1.0), (b[0], M_)], -np.inf, M_)  # dz <= M (1 - b0) + slack
            con([(v_, -a) for v_, a in d] + [(t_, -1.0), (b[0], M_)], -np.inf, M_)
            con([(v_, -a) for v_, a in d] + [(t_, -1.0), (b[1], M_)], -np.inf, M_ - SEP)  # dz >= SEP - M (1 - b1) - slack
            con(d + [(t_, -1.0), (b[2], M_)], -np.inf, M_ - SEP)
    nt = len(cost)
    Am = coo_matrix((A[2], (A[0], A[1])), shape=(len(lo_), nt)).tocsr()
    lb = np.r_[np.full(nv, -np.inf), np.zeros(nt - nv)]; ub_ = np.full(nt, np.inf)
    integ = np.zeros(nt)
    if ints: integ[ints] = 1; ub_[ints] = 1
    r = None
    for pre in (True, False):  # (HiGHS's presolve trips over some: without it)
        r = milp(cost, integrality=integ, bounds=Bounds(lb, ub_), constraints=LinearConstraint(Am, lo_, hi_),
                 options=dict(presolve=pre, node_limit=nodes, random_seed=1, threads=1, mip_rel_gap=1e-3))
        if r.x is not None: break
    if r.x is None: return None, None, None
    return {v: r.x[n] + h0 for v, n in col.items()}, [(tag, at, float(r.x[t_])) for t_, tag, at in tags], float(r.fun)


def deck_chosen(rs, runs, W, choice):
    """a structure's rows with each chosen stretch's own rows as its choice: 0 one surface, 1 this one SEP over the
    other, -1 under it"""
    out = [r for r in rs if not (isinstance(r[5], tuple) and r[5][1] in choice)]
    for n, ch in sorted(choice.items()):
        for v, j0, j1, f, q in runs[n][1]:
            if v == j0 == j1: continue
            if ch == 0: out.append((rs[0][0], [(v, 1.0), (j0, -(1 - f)), (j1, -f)], 0.0, W['tie'], True, ('tie', n), q))
            else: out.append((rs[0][0], [(v, -ch), (j0, ch * (1 - f)), (j1, ch * f)], -SEP, W['sep'], False, ('sep', n), q))
    return out


def deck_structure(job):
    """one structure of deck_solve: its LP; where a stretch drawn over another can't be what the LiDAR says, each such
    stretch made what the solved heights make it (one surface, or SEP over or under; the rest stay as the LiDAR has
    them) and solved again while that gives less (a few LPs), then, on a structure small enough, a MILP deciding them
    all at once; the best of these: ({var: height}, [(tag, sample, slack)], decided by the rules?, seconds)"""
    import warnings
    warnings.filterwarnings('ignore', 'Unrecognized options')
    rs, runs, W = job
    t0 = time.time()
    hard = lambda sl: sum(v for t, at, v in sl if (t[0] if isinstance(t, tuple) else t) in ('tie', 'sep', 'ov', 'end', 'limit', 'low') and v > 0.05)
    low = lambda sl: sum(v for t, at, v in sl if t == 'low' and v > 0.05)
    zc, sl, fun = deck_program(rs, {}, W)
    if zc is None: return None, None, False, time.time() - t0
    best, decided, choice = hard(sl), False, {}
    bad = sorted({t[1] for t, at, v in sl if isinstance(t, tuple) and v > 0.05})
    for _ in range(4):
        new = dict(choice)
        for n in sorted({t[1] for t, at, v in sl if isinstance(t, tuple) and v > 0.05}):
            d = [zc[v] - (zc[j0] * (1 - f) + zc[j1] * f) for v, j0, j1, f, q in runs[n][1] if not v == j0 == j1]
            if not d: continue
            d, cur = float(np.median(d)), choice.get(n)
            new[n] = (0 if abs(d) < MERGE / 2 else 1 if d > 0 else -1) if cur is None else (1 if d > 0 else -1) if cur == 0 else 0
        if new == choice: break
        z2, sl2, _ = deck_program(deck_chosen(rs, runs, W, new), {}, W)
        if z2 is None or hard(sl2) >= best - 1e-6: break
        zc, sl, best, choice, decided = z2, sl2, hard(sl2), new, True
    if bad and best > 0.05 and len(rs) <= MILP_ROWS:
        z2, sl2, _ = deck_program(rs, {n: runs[n] for n in bad}, W)
        if z2 is not None and hard(sl2) < best - 1e-6: zc, sl, decided = z2, sl2, True
    elif bad and best > 0.05:  # too big for one MILP: one round each stretch that gives, then the whole structure once more as they chose
        give = sorted({t[1] for t, at, v in sl if isinstance(t, tuple) and v > 0.05})
        new = {**choice, **deck_windows(deck_chosen(rs, runs, W, choice), runs, W, zc, give, sorted(set(bad) | set(give)))}
        if new != choice:
            z2, sl2, _ = deck_program(deck_chosen(rs, runs, W, new), {}, W)
            if z2 is not None and hard(sl2) < best - 1e-6 and low(sl2) <= low(sl) + 2: zc, sl, decided = z2, sl2, True  # (a deck sunk onto the street under it, over 2 m in all, buys no tie)
    return zc, sl, decided, time.time() - t0


def deck_windows(rs, runs, W, zc, give, bad):
    """a structure too big for one MILP (rs: its rows as chosen so far, zc: its heights, give: the stretches that give,
    bad: those and the ones that gave at first): a MILP round each one that gives in turn, over the samples within
    WINDOW of it (nearer, while that is over WIN_ROWS), deciding it and the other bad stretches wholly among them, the
    heights further out held as they are, so a window's answer fits the structure round it and nothing parts at its
    edge; the next window starts from it. -> {stretch: its choice (deck_chosen's)}"""
    nb, at = {}, {}
    for n_, r in enumerate(rs):
        vs = [v for v, _ in r[1]]
        for v in vs: at.setdefault(v, []).append(n_)
        for v in vs[1:]: nb.setdefault(vs[0], set()).add(v); nb.setdefault(v, set()).add(vs[0])
    zc, own, out = dict(zc), {n: {k for t in runs[n][1] for k in t[:3]} for n in bad}, {}
    for n in give:
        if n in out: continue
        depth = WINDOW
        while True:  # the samples within `depth` rows of the stretch's own
            F = set(own[n]); edge = F
            for _ in range(depth):
                edge = {u for v in edge for u in nb.get(v, ())} - F
                F |= edge
            sub = sorted({k for v in F for k in at.get(v, ())})
            if len(sub) <= WIN_ROWS or depth <= 2: break
            depth //= 2
        if len(sub) > WIN_ROWS: continue
        ns = [m for m in bad if own[m] <= F]
        rows = []
        for k in sub:
            c, terms, rhs, cst, both, tag, q = rs[k]
            held = sum(a * zc[v] for v, a in terms if v not in F)
            rows.append((c, [(v, a) for v, a in terms if v in F], rhs - held, cst if cst is not None or not held else W['end'], both or cst is None, tag, q))
        z2, _, _ = deck_program(rows, {m: runs[m] for m in ns}, W, nodes=WIN_NODES)
        if z2 is None: continue
        zc.update(z2)
        for m in ns:
            d = [z2[v] - (z2[j0] * (1 - f) + z2[j1] * f) for v, j0, j1, f, q in runs[m][1] if not v == j0 == j1]
            if d: out[m] = 0 if abs(np.median(d)) < SEP / 2 else 1 if np.median(d) > 0 else -1
    return out


def deck_solve(ways, raw, grade, tun={}, ground=None, drawn=None):
    """Every raised way's heights (DECKS, APPROACH, and the tunnels drawn beside them: TUNNELS), one linear program per
    connected structure (ways meeting at nodes or drawn over each other), on their 4 m samples: as near their LiDAR
    profiles as the rules let them (L1, so a truss or a gap left in the profile moves only where it must), smooth, and
      - one height where ways meet (one variable per node), and one surface where two are drawn over each other and
        come within MERGE of each other anywhere along that stretch (a ferry terminal's holding lanes, a sidewalk beside
        its road deck, a ramp leaving the main line, one way approached from both its ends); further apart they are
        stacked, SEP apart at least
      - no steeper than their kind's design grade where they can, never than its limit
      - on the ground (its drawn top on the LiDAR ground) where a street goes on from it at grade, at an approach's
        foot, and at a road's or rail's dead end (cars and trains take no stairs)
      - not under the drawn ground (tools/audit_elev.py 'buried'), 3 m clear over the streets under them ('under')
    the rules held with weights far over the LiDAR's, so they give only where they contradict each other (a tie
    first: a deck whose LiDAR saw the viaduct over it comes down off it). Where a stretch drawn over another can't be
    what the LiDAR says (one surface, or stacked), a MILP over the structure decides which it is (one surface, or SEP
    over or under). Writes the heights back; what still gives is in GAVE.
    (ground, drawn: the LiDAR's and the drawn ground, for the selftest)"""
    ground, drawn = ground or ground_at, drawn or drawn_ground
    from scipy.optimize import linprog
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    from shapely.strtree import STRtree
    t0 = time.time()
    gw, gat = grade
    E, band = [], {}  # [key, points, along, wanted height, weight, kind, width, {sample: node}]; deck -> its sidewalk band?
    for w, (c, s, z) in DECKS.items():
        coords, refs, t, k = ways[w]
        vert = np.concatenate([[0], np.cumsum([max(1, int(math.dist(a, b) / 4)) for a, b in zip(coords, coords[1:])])])
        E.append([w, raw[w][0], np.asarray(s, float), np.asarray(z, float), 1.0, k, road_shape(k, t)[1], dict(zip(vert.tolist(), refs))]); band[w] = road_shape(k, t)[3]
    for w, lst in APPROACH.items():
        k, wd = gw[w][2], gw[w][3]
        for n, (r0, r1, ins, P, s, z, nodes) in enumerate(lst):
            s, z = np.asarray(s, float), np.asarray(z, float)
            if len(s) < 2: continue
            kk = 'steps' if k in FOOT and np.max(np.abs(np.diff(z)) / np.maximum(np.diff(s), 1e-6)) > 0.3 else k
            E.append([(w, n), np.asarray(P, float), s, z, 0.3, kk, wd, nodes])
    for w, (P, s, z, op) in TUNNELS.items():  # (a covered lane beside a deck is drawn with it: one surface)
        if len(s) > 1: E.append([(w, 't'), np.asarray(P, float), np.asarray(s, float), np.asarray(z, float), 3.0, tun[w][2], tun[w][3], {0: tun[w][1][0], len(s) - 1: tun[w][1][-1]}])
    off = np.concatenate([[0], np.cumsum([len(e[1]) for e in E])]); N = int(off[-1])
    P = np.concatenate([e[1] for e in E]); el = np.repeat(np.arange(len(E)), np.diff(off))
    tgt = np.concatenate([e[3] for e in E])
    # one variable per node: samples at the same node tied
    bynode = {}
    for i, e in enumerate(E):
        for k_, r in e[7].items(): bynode.setdefault(r, []).append(off[i] + k_)
    a_, b_ = [], []
    for vs in bynode.values(): a_ += vs[:1] * (len(vs) - 1); b_ += vs[1:]
    _, rep = connected_components(coo_matrix((np.ones(len(a_)), (a_, b_)), shape=(N, N)), directed=False)
    # drawn over each other: each drawn way's samples (middle and edges) on another's strip
    D = [i for i, e in enumerate(E) if e[5] in DRAWN]
    geo = [shapely.LineString(E[i][1]) for i in D]
    tree = STRtree([g.buffer(E[i][6] / 2, cap_style='flat') for g, i in zip(geo, D)])
    Q, qs = [], []
    for i in D:
        p = E[i][1]; t = np.gradient(p, axis=0); t /= np.maximum(np.hypot(*t.T), 1e-6)[:, None]
        for o in (-0.5, 0.0, 0.5): Q.append(p + np.c_[-t[:, 1], t[:, 0]] * o * E[i][6]); qs.append(np.arange(off[i], off[i + 1]))
    Q, qs = np.concatenate(Q), np.concatenate(qs)
    qi, ti = tree.query(shapely.points(Q), predicate='intersects')
    keep = el[qs[qi]] != np.array(D)[ti]
    qi, ti = qi[keep], ti[keep]
    sb = shapely.line_locate_point(np.array(geo, object)[ti], shapely.points(Q[qi]))
    way_of = lambda e: e[0][0] if isinstance(e[0], tuple) else e[0]
    tube = lambda e: isinstance(e[0], tuple) and e[0][1] == 't'
    ties, seps = [], []  # (sample, other's sample j, j + 1, fraction, [which is on top,] stretch)
    RUN = []  # the stretches: (one way?, [(sample, other's sample j, j + 1, fraction)])
    merged = set()
    pairs = {}  # (way, other way) -> [(sample, other's sample j, fraction, height apart)]
    for q, b, u in zip(qs[qi], np.array(D)[ti], sb):
        S = E[b][2]; j = int(np.clip(np.searchsorted(S, u) - 1, 0, len(S) - 2)); f = float(np.clip((u - S[j]) / max(S[j + 1] - S[j], 1e-6), 0, 1))
        f = 0.0 if f < 0.01 else 1.0 if f > 0.99 else f  # (at a sample: on it)
        pairs.setdefault((el[q], b), []).append((q, off[b] + j, f, tgt[q] - (E[b][3][j] * (1 - f) + E[b][3][j + 1] * f)))
    for (a, b), ps in pairs.items():  # each stretch of one drawn over the other: one surface if they meet anywhere along it
        ps.sort()
        for run in np.split(ps, np.nonzero(np.diff([p[0] for p in ps]) > 2)[0] + 1):
            same = way_of(E[a]) == way_of(E[b])  # (a ramp leaving the main line; one way approached from both ends)
            one = min(abs(p[3]) for p in run) < MERGE or same
            if not one and min(abs(p[3]) for p in run) >= 15: continue
            parts = [(one, run)]
            if not one:  # stacked by their LiDAR, yet they meet at a node: one surface as far from it as their grades take to part SEP, stacked from twice that
                nb = {rep[off[b] + k_] for k_ in E[b][7]}; meet = [E[a][2][k_] for k_ in E[a][7] if rep[off[a] + k_] in nb]
                if meet:
                    reach = SEP / (deck_design(E[a][5]) + deck_design(E[b][5]))
                    d = np.array([min(abs(E[a][2][int(p[0]) - off[a]] - m) for m in meet) for p in run])
                    parts = [(True, run[d < reach]), (False, run[d >= 2 * reach])]
            for one, run in parts:
                if not len(run): continue
                RUN.append((same, [(int(q), int(j), int(j) + 1, f) for q, j, f, dz in run]))
                for q, j, f, dz in run:
                    q, j = int(q), int(j)
                    if one: ties.append((q, j, j + 1, f, len(RUN) - 1)); merged.add(q)
                    else: seps.append((q, j, j + 1, f, 1.0 if dz > 0 else -1.0, len(RUN) - 1))
    # the ground: drawn under each sample, the LiDAR's at the ends
    gd = drawn(P[:, 0], P[:, 1])
    lo = np.full(N, -np.inf)  # the lowest each sample may be
    for i, e in enumerate(E):
        s = e[2]; inner = (s > 12) & (s < s[-1] - 12) & (not tube(e))  # (a tunnel is under the ground)
        lo[off[i]:off[i + 1]][inner] = gd[off[i]:off[i + 1]][inner] - 1.1
    # 3 m clear over the at-grade streets, paths and rail under a deck (not those meeting it, nor near its ends)
    G_ = [w for w, (c, r, k, wd) in gw.items() if w not in APPROACH and KI[k] < KI['runway']]
    if G_:
        gl = [shapely.LineString(gw[w][0]) for w in G_]; gt = STRtree(gl)
        for i, e in enumerate(E):
            s = e[2]; inner = np.nonzero((s > 12) & (s < s[-1] - 12) & (not tube(e)))[0]
            if not len(inner): continue
            pts = shapely.points(e[1][inner]); th = 1.6 if KI[e[5]] <= KI['tertiary'] else 0.9
            for a, b in zip(*gt.query(pts, predicate='dwithin', distance=under_reach(e[6], band.get(e[0])))):
                if set(gw[G_[b]][1]) & set(e[7].values()): continue  # (it meets the deck)
                c_ = shapely.line_interpolate_point(gl[b], shapely.line_locate_point(gl[b], pts[a]))
                k_ = off[i] + inner[a]
                lo[k_] = max(lo[k_], float(drawn(np.array([c_.x]), np.array([c_.y]))[0]) + 3.0 + th + 0.15)
    # on the ground: where a street goes on from a structure at grade (no approach raised it there), at an approach's
    # foot, and at a road's or rail's dead end (cars and trains take no stairs; a dead end on another deck is on it)
    raised = {(w, r) for w, lst in APPROACH.items() for e in lst for r in e[6].values()}
    decked = {int(el[a]) for t in ties + seps for a, b in ((t[0], t[1]), (t[1], t[0])) if tube(E[el[a]]) and not tube(E[el[b]])}  # tunnels drawn over a deck or an approach
    starts = {e[0] for lst in APPROACH.values() for e in lst} | {r for e in E if not isinstance(e[0], tuple) for r in e[7].values()}  # (not a foot)
    ends = {}  # sample -> the height it is held to
    for i, e in enumerate(E):
        n = len(e[1])
        for k_, r in e[7].items():
            q = off[i] + k_
            if tube(e):  # a tunnel's portal: on the ground, where tunnel_profiles put it; joined to what meets it there, or with the deck it is drawn with (a covered lane on a deck)
                if r in PORTALS and len(bynode[r]) == 1 and i not in decked: ends[q] = tgt[q]
                continue
            if any((w, r) not in raised and w not in DECKS for w, _ in gat.get(r, ())) or k_ in (0, n - 1) and len(bynode.get(r, ())) == 1 and (
                    isinstance(e[0], tuple) and k_ == n - 1 or e[5] not in FOOT and q not in merged) or isinstance(e[0], tuple) and k_ == n - 1 and r not in starts:
                ends[q] = float(ground(e[1][k_:k_ + 1, 0], e[1][k_:k_ + 1, 1])[0]) + 0.02 - DECK_TOP
    # the structures: samples joined along their ways, at nodes, over each other
    A = [np.arange(N - 1)[np.diff(el) == 0], np.array([t[0] for t in ties + seps], int), np.array([t[0] for t in ties + seps], int)]
    B = [np.arange(1, N)[np.diff(el) == 0], np.array([t[1] for t in ties + seps], int), np.array([t[2] for t in ties + seps], int)]
    A, B = rep[np.concatenate(A)], rep[np.concatenate(B)]
    nc, comp = connected_components(coo_matrix((np.ones(len(A)), (A, B)), shape=(N, N)), directed=False)
    # rows: (component, [(var, coef)], rhs, slack cost or None (an equality), second row sign or 0)
    rows, seen = [], set()
    def row(terms, rhs, cost, both=False, tag=None, at=None):  # sum <= rhs + slack (both: |sum - rhs| <= slack); cost None: sum == rhs
        t_ = {}
        for v, a in terms: t_[v] = t_.get(v, 0.0) + a
        terms = [(v, a) for v, a in t_.items() if abs(a) > 1e-4]  # (a node twice in a row: one term; a tie at a sample: none)
        if cost is None and terms:  # (ties scaled and once each: HiGHS fails on near-duplicate ones)
            m = max(abs(a) for _, a in terms); terms = [(v, a / m) for v, a in terms]
            k = tuple(sorted((v, round(a, 5)) for v, a in terms))
            if k in seen: return
            seen.add(k)
        if terms: rows.append((comp[terms[0][0]], terms, rhs, cost, both, tag, at))
    W = dict(data=1.0, bend=6.0, design=100.0, limit=1000.0, end=1000.0, low=150.0, sep=300.0, tie=300.0)  # (a tie gives before an end or a grade)
    for i, e in enumerate(E):
        s, n = e[2], len(e[1]); R = rep[off[i]:off[i + 1]]; Gd, Gl = deck_design(e[5]), deck_limit(e[5])
        for k_ in range(n):
            row([(R[k_], 1.0)], tgt[off[i] + k_], W['data'] * e[4], True)
        for k_ in range(n - 1):
            if R[k_] == R[k_ + 1]: continue
            ds = s[k_ + 1] - s[k_]
            if ds < 1e-3: row([(R[k_ + 1], 1.0), (R[k_], -1.0)], 0.0, W['limit'], True, 'limit', off[i] + k_); continue  # (a point twice)
            for sg in (1.0, -1.0):
                row([(R[k_ + 1], sg), (R[k_], -sg)], Gd * ds, W['design']); row([(R[k_ + 1], sg), (R[k_], -sg)], Gl * ds, W['limit'], tag='limit', at=off[i] + k_)
        for k_ in range(1, n - 1):
            row([(R[k_ - 1], 1.0), (R[k_], -2.0), (R[k_ + 1], 1.0)], 0.0, W['bend'], True)
    for q, h in ends.items(): row([(rep[q], 1.0)], h, W['end'], True, 'end', q)
    for q in np.nonzero(np.isfinite(lo))[0]: row([(rep[q], -1.0)], -lo[q], W['low'], tag='low', at=q)
    for q, j0, j1, f, n in ties:
        if rep[q] != rep[j0] or rep[q] != rep[j1]: row([(rep[q], 1.0), (rep[j0], -(1 - f)), (rep[j1], -f)], 0.0, W['tie'], True, ('tie', n), q)
    for q, j0, j1, f, sg, n in seps: row([(rep[q], -sg), (rep[j0], sg * (1 - f)), (rep[j1], sg * f)], -SEP, W['sep'], tag=('sep', n), at=q)
    # one program per structure, in parallel; each deterministic (HiGHS bounded by nodes, not seconds), so the bake is too
    rows.sort(key=lambda r: r[0])
    starts = np.searchsorted([r[0] for r in rows], np.arange(nc + 1))
    runs_of = {}  # structure -> {stretch: (one way?, [(sample, other's samples j, j + 1, fraction, sample index)] as variables)}
    for n, (same, sm) in enumerate(RUN): runs_of.setdefault(int(comp[rep[sm[0][0]]]), {})[n] = (same, [(int(rep[q]), int(rep[j0]), int(rep[j1]), f, q) for q, j0, j1, f in sm])
    jobs = [(rows[starts[c]:starts[c + 1]], runs_of.get(c, {}), W) for c in range(nc) if starts[c + 1] > starts[c]]
    order = sorted(range(len(jobs)), key=lambda n: -len(jobs[n][0]))  # (the biggest first: none left running alone at the end)
    procs = int(os.environ.get('PROCS', '8'))
    t1 = time.time()
    import multiprocessing as mp
    if procs > 1 and len(jobs) > 50:
        with mp.get_context('fork').Pool(procs) as pool: res = dict(zip(order, pool.imap(deck_structure, [jobs[n] for n in order], 4)))
    else: res = {n: deck_structure(jobs[n]) for n in order}
    print('deck solve: rows in', round(t1 - t0), 's, solved in', round(time.time() - t1), 's', flush=True)
    bad = nm = 0
    zr = {}
    for n, (rs, _, _) in enumerate(jobs):  # (in structure order)
        zc, sl, decided, secs = res[n]
        if zc is None: bad += 1; continue  # (left at their LiDAR profiles, one height at each node: below)
        if secs > 5: print('  deck solve: structure', rs[0][0], len(rs), 'rows', round(secs), 's', flush=True)
        nm += decided
        zr.update(zc)
        GAVE.extend((t[0] if isinstance(t, tuple) else t, float(P[at][0]), float(P[at][1]), v, int(rs[0][0])) for t, at, v in sl if v > 0.02)
    left = {}  # (a structure the solver failed on: each node at the mean of what its ways' LiDAR says there)
    for q in range(N):
        if rep[q] not in zr: left.setdefault(rep[q], []).append(tgt[q])
    zr.update({v: float(np.mean(h)) for v, h in left.items()})
    z = np.array([zr[rep[q]] for q in range(N)])
    for i, e in enumerate(E):
        zi = z[off[i]:off[i + 1]].astype(np.float32)
        if isinstance(e[0], tuple) and e[0][1] == 't':
            TUNNELS[e[0][0]] = (*TUNNELS[e[0][0]][:2], zi, TUNNELS[e[0][0]][3])
        elif isinstance(e[0], tuple):
            w, n = e[0]; APPROACH[w][n] = (*APPROACH[w][n][:5], zi, APPROACH[w][n][6])
        else:
            DECKS[e[0]] = (DECKS[e[0]][0], DECKS[e[0]][1], zi)
    print('deck solve: gave', {k: sum(1 for g in GAVE if g[0] == k) for k in ('end', 'limit', 'low', 'tie', 'sep', 'ov')}, nm, 'decided by the rules', flush=True)
    print('deck solve:', len(E), 'ways,', N, 'samples,', nc, 'structures,', len(ties), 'ties,', len(seps), 'stacked,', bad, 'failed', round(time.time() - t0), 's', flush=True)


def tunnel_ground(P, w):
    """the lowest drawn ground across a tunnel's box (its way's width w) at each of its points"""
    t = np.gradient(P, axis=0) if len(P) > 1 else np.array([[1.0, 0.0]]); t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-6)[:, None]
    n = np.stack([-t[:, 1], t[:, 0]], 1) * (w / 2 + 0.6 + SLAB)
    return drawn_ground(*np.concatenate([P, P + n, P - n]).T).reshape(3, -1).min(0)


def tunnel_profiles(ways, water=None, mouths={}):
    """ways {id: (coords, refs, kind, width)}, water: STRtree of OpenStreetMap's water areas near them -> {id: (points every
    4 m, distance along, height, open)}. A tunnel runs from portal to portal (PORTALS: its drawn road on the street's
    there, the LiDAR's ground level across; mouths: {node: that ground} where tunnel_mouths found it),
    straight where the ground is high over it, else under the ground with its roof 0.5 m down, no steeper than its
    kind's grade. Ways are joined at shared nodes, the joints' and dead ends' heights in between (Laplace: straight along
    a chain). Open: where the ground isn't 0.3 m over its roof, near the portals and where it can't get under a river
    by its bank (the bake cuts the ground and the water there, the page draws its box and portal face)"""
    use = {}
    for wid, (c, refs, k, w) in ways.items():
        for r in refs: use[r] = use.get(r, 0) + 1
    segs = []  # (way, first ref, last ref, points, along, ground, highest roof under the ground)
    for wid, (c, refs, k, w) in sorted(ways.items(), key=lambda kv: (int(kv[1][0][0][0] // L1), int(kv[1][0][0][1] // L1))):  # a LiDAR tile at a time
        cut = [0] + [n for n in range(1, len(refs) - 1) if use[refs[n]] > 1] + [len(refs) - 1]
        for a, b in zip(cut, cut[1:]):
            P = np.array(densify(c[a:b + 1], 4)); s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
            g = tunnel_ground(P, w)
            segs.append((wid, refs[a], refs[b], P, s, g, g - tube_h(k) - SLAB - 0.5))
    h, free = {}, {}
    for wid, ra, rb, P, s, g, u in segs:
        for r, e in ((ra, 0), (rb, -1)):
            if r in PORTALS: h[r] = (mouths[r] if r in mouths else float(level_across(P[:2] if e == 0 else P[-2:], ways[wid][3])[e]) if len(P) > 1 else float(ground_at(*P[e])[0])) + 0.02 - DECK_TOP  # (its road's top on the street's, as a deck's end)
            else: free.setdefault(r, []).append(float(u[e]))  # a joint, or a dead end (an underground station)
    for r, us in free.items(): h[r] = min(us)
    grade = lambda k: 0.035 if k == 'rail' else 0.05 if k == 'lightrail' else 0.10 if k in FOOT else 0.06
    for _ in range(200):  # joints: the mean of their neighbours by 1 / distance, never above the ground's limit there
        acc = {}  # nor further below a neighbour than the grade gets (a joint just inside a portal)
        for wid, ra, rb, P, s, g, u in segs:
            L = max(s[-1], 1.0)
            for r, o in ((ra, rb), (rb, ra)):
                if r in free: a = acc.setdefault(r, [0.0, 0.0, -np.inf]); a[0] += h[o] / L; a[1] += 1 / L; a[2] = max(a[2], h[o] - grade(ways[wid][2]) * L)
        for r, (num, den, lo) in acc.items(): h[r] = max(min(num / den, min(free[r])), lo)
    out = {}
    for wid, ra, rb, P, s, g, u in segs:
        k = ways[wid][2]
        G = grade(k)
        L = max(s[-1], 1e-6)
        # the ground's limit holds away from the portals (it can't get under the ground any faster): there it is open.
        # Under the sea or a river it holds right up to the bank, the tube coming down to it more steeply if it must
        X = (tube_h(k) + SLAB + 0.5) / G
        wet = SEA_M[((SEA_Y1 - P[:, 1]) / SEA_C).astype(int).clip(0, SEA_M.shape[0] - 1), ((P[:, 0] - SEA_X0) / SEA_C).astype(int).clip(0, SEA_M.shape[1] - 1)]
        if water is not None: wet[np.unique(water.query(shapely.points(P), predicate='within')[0])] = True  # rivers and lakes
        lim = np.where(((s < X) & (ra in PORTALS) | (L - s < X) & (rb in PORTALS)) & ~wet, np.inf, u)
        ds = np.diff(s)
        for m in range(1, len(lim)): lim[m] = min(lim[m], lim[m - 1] + G * ds[m - 1])  # no steeper than G (the lower envelope)
        for m in range(len(lim) - 2, -1, -1): lim[m] = min(lim[m], lim[m + 1] + G * ds[m])
        Gc = 2.5 * G if wet.any() else G
        z = np.maximum(np.minimum(h[ra] + (h[rb] - h[ra]) * s / L, lim), np.maximum(h[ra] - Gc * s, h[rb] - Gc * (L - s)))
        z[0], z[-1] = h[ra], h[rb]
        op = g < z + tube_h(k) + SLAB + 0.3  # (as solved: deck_profiles)
        if wid in out:  # the way's next stretch (split at a joint): on along it
            P0, s0, z0, o0 = out[wid]
            out[wid] = (np.concatenate([P0, P[1:]]), np.concatenate([s0, s0[-1] + s[1:]]), np.concatenate([z0, z[1:]]), np.concatenate([o0, op[1:]]))
        else: out[wid] = (P, s, z, op)
    return {w: (P, s.astype(np.float32), z.astype(np.float32), o) for w, (P, s, z, o) in out.items()}


def tunnel_heights(wid, pts):
    """a tunnel piece's height at each of its points and whether it is open there (or within 6 m of it)"""
    P, s, z, op = TUNNELS[wid]
    line = LineString(P)
    sp = np.array([line.project(shapely.geometry.Point(p)) for p in pts])
    c = np.concatenate([[0], np.cumsum(op)])
    lo, hi = np.searchsorted(s, sp - 6, 'left'), np.searchsorted(s, sp + 6, 'right')
    return [float(v) for v in np.interp(sp, s, z)], [bool(v) for v in c[hi] - c[lo] > 0]


def approaches(files, tops, held=()):
    """At-grade ways that go on from a deck's end well above the ground: the structure goes on past OpenStreetMap's
    bridge tag (a viaduct's last spans, a ramp on a retained fill, the guideway down to a tunnel portal, stairs off a
    footbridge, a connector across a bridge). From the deck's end they follow the low LiDAR surface along the way, no
    steeper than a ramp (a stair for steps), until they meet the ground; on into the next way if they don't, or to the
    deck at its far end. tops: deck end node -> (x, y, deck height). -> {way id: [(deck end node, touchdown node, the
    touchdown node to add to the way (segment, fraction along it, x, y, node id) or None, points, along, height)]},
    and the at-grade ways near the decks ({way id: (coords, refs, kind, width)}, {node: [(way id, ref index)]}). From a
    held node (a deck's middle, a joint: not one deck's end, which comes down to the ground instead) a way that is no
    ramp (into a building, a lift, too steep) comes straight down from it anyway, no steeper than its grade (into a
    building from any deck end: its stairs or ramp inside it)"""
    cell = 512
    near = {(int(x // cell) + a, int(y // cell) + b) for x, y, _ in tops.values() for a in (-1, 0, 1) for b in (-1, 0, 1)}
    tops = {r: h for r, (x, y, h) in tops.items()}
    at = {}  # node -> [(way id, ref index)] for at-grade ways near a deck end
    ways, blds, up = {}, [], set()
    for f in files:
        for wid, coords, refs, t in retunnel(pickle.load(open(f, 'rb')).get('lines', [])):
            if wid in ways or len(coords) < 2 or t.get('bridge') not in (None, 'no') or t.get('area') == 'yes': continue
            k = line_kind(t)
            if not k or t.get('tunnel') in TUNNEL or t.get('tunnel') == 'building_passage' and on_level(t) or t.get('covered') == 'yes' and k in ('rail', 'lightrail'): continue  # (what road_pieces draws at grade)
            if not any((int(x // cell), int(y // cell)) in near for x, y in coords[::4] + coords[-1:]): continue
            if k in FOOT and hidden_walk(coords, t): continue
            ways[wid] = (coords, refs, k, road_shape(k, t)[1])
            if on_level(t):
                if k in DRIVE and (k == 'service' or t.get('level')): del ways[wid]; continue  # (a parkade's aisle, inside it: drawn at grade, hidden in it)
                up.add(wid)  # (a walkway mapped up a level: it stays up as far as the LiDAR does)
            for n_, r in enumerate(refs): at.setdefault(r, []).append((wid, n_))
        for _, prs, t in pickle.load(open(f, 'rb')).get('buildings', []):
            if (hnum(t.get('building:min_level')) or 0) > 0 or (hnum(t.get('min_height')) or 0) > 2: continue  # up in the air: ways go on under it
            for outer, _ in prs:
                if len(outer) >= 4 and (int(outer[0][0] // cell), int(outer[0][1] // cell)) in near: blds.append(Polygon(outer).buffer(0))
    from shapely.strtree import STRtree
    blds = STRtree(blds)
    out, held, along = {}, set(held), set()
    seen = set()
    queue = [(r, h, 400.0) for r, h in tops.items() if r in at]
    while queue:
        r, h0, budget = queue.pop()
        for wid, k0 in at.get(r, []):
            if (r, wid) in along: continue  # (the way it branches off)
            coords, refs, kind, w = ways[wid]
            for order in (list(range(k0, len(refs))), list(range(k0, -1, -1))):  # on from the deck end, either way
                if len(order) < 2 or (wid, k0, order[1]) in seen: continue
                seen.add((wid, k0, order[1]))
                pts = [coords[n_] for n_ in order]
                P, s, low, _ = deck_samples(pts, w)
                g = hr_lookup(P[:, 0], P[:, 1], 1)
                g = np.where(np.isfinite(g), g, MR[((MR_Y1 - P[:, 1]) / 32).astype(int).clip(0, MR.shape[0] - 1), ((P[:, 0] - MR_X0) / 32).astype(int).clip(0, MR.shape[1] - 1)])
                if not np.isfinite(g[0]) or h0 - g[0] < 1.0: continue
                inside = len(blds.query(shapely.points(P[min(2, len(P) - 1)]), predicate='within')) > 0  # into a building (a skywalk, a station)
                vert = np.concatenate([[0], np.cumsum([max(1, int(math.dist(a, b) / 4)) for a, b in zip(pts, pts[1:])])])
                G = 0.8 if kind == 'steps' else 0.03 if kind == 'rail' else 0.06 if kind == 'lightrail' else 0.10 if kind in FOOT else 0.08
                far = tops.get(refs[order[-1]])
                if inside or far is not None and s[-1] < 150 and abs(far - h0) > (G if kind == 'steps' else 0.5 if kind in FOOT else 0.1) * s[-1]:
                    if r not in held and not inside: continue  # too steep for a ramp (or a stair): a lift
                    if inside and kind in FOOT: G = STAIRS  # (into a building: its stairs, inside it)
                    z = np.maximum(h0 - G * s, g); low_ = z - g < 0.3; down = int(np.argmax(low_)) if low_.any() else None  # (straight down)
                elif far is not None and s[-1] < 150:  # a connector between two decks: straight from one to the other
                    z, down = h0 + (far - h0) * s / max(s[-1], 1e-6), None
                else:  # a footway's surface beyond its bridge is a building or the trees as often as a ramp: it just comes down
                    z, down = ramp(s, low, g, h0, G, 0 if kind in FOOT and wid not in up else 300)
                    # the next node another way meets (a path down there: the ramp must be down by then)
                    jn = next((vert[n] for n in range(1, len(order)) if len(at.get(refs[order[n]], ())) > 1), None)
                    if down is not None and (down < 0 or s[down] < 6) or kind in FOOT and wid not in up and jn is not None and (down is None or down > jn):
                        if kind not in FOOT and r not in held: continue  # down at once: a lift, not a ramp
                        # a path on from a footbridge's end down on the ground (the stairs aren't mapped): stairs down along it,
                        # down by the next junction (steeper, up to a stair tower's 1.5, where OpenStreetMap leaves no room)
                        st = (STAIRS if jn is None else min(1.5, max(STAIRS, (h0 - g[jn]) / max(s[jn], 1e-6)))) if kind in FOOT else G
                        z = np.maximum(h0 - st * s, g); low_ = z - g < 0.3
                        down = int(np.argmax(low_)) if low_.any() else None
                end, ins, keep = refs[order[-1]], None, len(P)
                if down is not None:  # the approach ends where it touches down: at a node of the way, else at a new one there
                    vi = int(np.searchsorted(vert, down))
                    if vert[vi] - down <= 1: end, keep = refs[order[vi]], vert[vi] + 1; z[down + 1:keep] = g[down + 1:keep]
                    elif down - vert[vi - 1] <= 1: end, keep = refs[order[vi - 1]], vert[vi - 1] + 1
                    else:
                        seg = min(order[vi - 1], order[vi])
                        f = math.dist(coords[seg], P[down]) / max(1e-6, math.dist(coords[seg], coords[seg + 1]))
                        end, keep = (1 << 52) + wid * 64 + len(out.get(wid, ())), down + 1  # a node id of our own, below 2^53 for the page
                        ins = (seg, f, *P[down], end)
                if keep < 2: continue  # (down at the deck's end itself: the deck end comes down to the ground, deck_solve)
                nodes = {int(vert[n_]): refs[order[n_]] for n_ in range(len(order)) if vert[n_] < keep}; nodes[keep - 1] = end
                out.setdefault(wid, []).append((refs[order[0]], end, ins, P[:keep].copy(), s[:keep].astype(np.float32), z[:keep].astype(np.float32), nodes))
                if down is None and refs[order[-1]] not in tops and s[-1] < budget:
                    queue.append((refs[order[-1]], float(z[-1]), budget - s[-1])); held.add(refs[order[-1]])  # (up in the air: it goes on)
                for k_, r_ in nodes.items():  # the other ways branching off it up in the air go on from it too
                    if 0 < k_ < keep - 1 and r_ not in tops and len(at.get(r_, ())) > 1 and z[k_] - g[k_] > 1 and s[k_] < budget:
                        queue.append((r_, float(z[k_]), budget - s[k_])); held.add(r_); along.add((r_, wid))
    return out, (ways, at)


def ramp(s, low, g, h0, G, follow):
    """heights down from a deck end at h0 along samples s (low LiDAR surface, ground g; g's gaps are filled in place):
    on the surface while it goes on smoothly (up to `follow` metres), no steeper than G, never above the surface (the
    LiDAR would have seen it) nor below the ground -> (heights, NaN past the touchdown; index of the touchdown, None if it
    never does, -1 if the LiDAR sees open ground well below it: whatever holds the deck end up, it isn't a ramp)"""
    z = np.full(len(s), np.nan); z[0] = c = h0
    ok = np.isfinite(low)
    low = np.where(ok, ndimage.median_filter(np.where(ok, low, -1e4), 5, mode='nearest'), np.nan)  # a lone tree or sign over it
    for m in range(1, len(s)):
        ds = s[m] - s[m - 1]
        if not np.isfinite(g[m]): g[m] = g[m - 1] if np.isfinite(g[m - 1]) else c
        if s[m] > follow or not np.isfinite(low[m]) or abs(low[m] - low[m - 1]) > 1.5: follow = -1  # gone, or treetops: down from here
        c = np.clip(low[m], c - G * ds, c + 0.25 * G * ds) if follow > 0 else c - G * ds
        if np.isfinite(low[m]) and low[m] < c - 0.75 and low[m] < g[m] + 0.5:  # the LiDAR sees the open ground under it: no structure
            z[m] = g[m]
            if c - g[m] >= 3: return z, -1
            # down to it along the way so far, not in one step (no steeper than needed from the deck end)
            z[:m] = np.minimum(z[:m], g[m] + max(G, (h0 - g[m]) / max(s[m], 1e-6)) * (s[m] - s[:m]))
            return z, m
        c = max(c, g[m])
        z[m] = c
        if c - g[m] < 0.3: return z, m
    return z, None


def profile_at(pts, s0, sign, S, Z, tol=0.02):
    """a raised piece's points and heights from its way's profile (S, Z: heights along it), the piece starting s0 along
    the way and going sign (1, -1) along it: its own points and, between them, every 4 m point where the profile bends
    more than tol from the straight line (so pieces drawn over each other follow the one surface: two at 2 cm each and
    the tile's 10 cm rounding stay under tools/drawn_check.mjs's 15 cm)"""
    P = np.array(densify(pts, 4), float)
    u = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
    z = np.interp(s0 + sign * u, S, Z)
    own = np.concatenate([[0], np.cumsum([max(1, int(math.dist(p, q) / 4)) for p, q in zip(pts, pts[1:])])]).tolist()
    keep, todo = set(own), list(zip(own, own[1:]))
    while todo:  # (Douglas-Peucker along the way)
        i, j = todo.pop()
        if j - i < 2: continue
        k = np.arange(i + 1, j); e = np.abs(z[k] - (z[i] + (z[j] - z[i]) * (u[k] - u[i]) / max(u[j] - u[i], 1e-9)))
        m = int(np.argmax(e))
        if e[m] > tol: keep.add(i + 1 + m); todo += [(i, i + 1 + m), (i + 1 + m, j)]
    keep = sorted(keep)
    return [tuple(p) for p in P[keep]], [float(v) for v in z[keep]]


# ---------------------------------------------------------------- tile writer
def pack_ring(out, ring):
    """ring -> count + delta-encoded int16 points (first absolute); Out.q on every point at once (round half to even,
    as Python's round)"""
    q = np.clip(np.round((np.asarray(ring, np.float64).reshape(-1, 2) - (out.ox, out.oy)) * out.k), -32768, 32767).astype(np.int64)
    d = np.diff(q, axis=0, prepend=np.zeros((1, 2), np.int64))
    return struct.pack('<I', len(q)) + np.clip(d, -32768, 32767).astype('<i2').tobytes()


GROUND_SNAP = 3  # the partition's grid in the tile's int16 steps (18.75 cm in a detail tile): its points are further apart
# than the page welds (1.5 steps, tile-worker.js weld()), and it divides the tile's far edge (16383)


def ground_partition(per, tx, ty, k, holes=None, simp=2):
    """class -> overlapping polygons (later classes win) => class -> its polygons in one planar partition of the tile:
    every border two classes share runs through the same points on both sides (their triangles share edges on the page,
    no crack between them). All the borders are noded together, snap-rounded to GROUND_SNAP int16 steps of the tile,
    each face goes to the last class over it (none: a tunnel's open box, else land), and each class's faces are merged."""
    g = GROUND_SNAP / k
    loc = {c: shapely.transform(p, lambda a: a - (tx, ty)) for c, p in per.items()}  # (the grid from the tile's corner)
    # a border within two grid steps of the tile's edge is put on it (else a strip a step wide along the edge, hundreds of
    # metres long: the page can only make needles of it)
    size = 16383 / k
    rim = lambda a: np.where(a < 2 * g, 0.0, np.where(a > size - 2 * g, size, a))
    edges = shapely.unary_union([shapely.transform(shapely.boundary(p), rim) for p in loc.values()], grid_size=g)
    faces = shapely.get_parts(shapely.polygonize(shapely.get_parts(edges)))
    if not len(faces): return {}
    pt = shapely.get_coordinates(shapely.point_on_surface(faces))
    win = np.full(len(faces), GI['land'])
    for c, p in loc.items():
        shapely.prepare(p)
        win[shapely.contains_xy(p, pt[:, 0], pt[:, 1])] = GI[c]
    if holes is not None:
        h = shapely.transform(holes, lambda a: a - (tx, ty)); shapely.prepare(h)
        cov = np.zeros(len(faces), bool)
        for p in loc.values(): cov |= shapely.contains_xy(p, pt[:, 0], pt[:, 1])
        win[~cov & shapely.contains_xy(h, pt[:, 0], pt[:, 1])] = -1
    cls, parts = [], []
    for c in np.unique(win[win >= 0]):
        u = [p for p in shapely.get_parts(shapely.coverage_union_all(faces[win == c])) if p.geom_type == 'Polygon']
        cls += [GROUND[c]] * len(u); parts += u
    # the zigzag the grid puts in a straight border taken out, alike on both sides (a near-straight run of points makes
    # the page's triangulation slivers), the tile's edge kept
    parts = list(shapely.coverage_simplify(np.array(parts, object), simp * g, simplify_boundary=False)) if parts else []
    # a part under 30 cm across on the whole (a step-wide strip, or the wedge simplifying makes of one) joins the part
    # beside it along most of its border: the page can only triangulate it into needles
    thin = [i for i, p in enumerate(parts) if 2 * p.area < 0.3 * p.length]
    if thin:
        from shapely.strtree import STRtree
        T = STRtree(parts)
        for i in thin:
            nb = [n for n in T.query(parts[i], predicate='intersects') if n != i and not parts[n].is_empty and n not in thin]
            if not nb: continue
            n = max(nb, key=lambda n: parts[i].boundary.intersection(parts[n].boundary).length)
            parts[n], parts[i] = shapely.coverage_union(parts[n], parts[i]), Polygon()
    res = {}
    for c, p in zip(cls, parts):
        if not p.is_empty: res.setdefault(c, []).append(shapely.transform(p, lambda a: a + (tx, ty)))
    return res


def line_bytes(out, sel, detail):
    """pieces as section LINE: a node table (so pieces join across tiles), then each piece"""
    nodes = {}
    for L in sel:
        for nid in (L['a'], L['b']): nodes.setdefault(nid, len(nodes))
    lb = bytearray(struct.pack('<I', len(nodes)))
    for nid in nodes: lb += struct.pack('<Q', nid)
    lb += struct.pack('<I', len(sel))
    for L in sel:
        pts = L['pts'] if detail or L['z'] or len(L['pts']) <= 2 else list(LineString(L['pts']).simplify(1.5).coords)
        z = L['z'] if L['z'] and len(pts) == len(L['pts']) else None  # bridge decks in overview tiles too
        tf, tb_ = L.get('turns', ([], []))
        flags = (1 if L['ow'] else 0) | (2 if L['band'] else 0) | (4 if z else 0) | (8 if L['drive'] else 0) | (16 if L.get('crossing') else 0) | (32 if tf or tb_ else 0) \
            | (64 if z and L.get('tube') else 0) | (128 if z and L.get('roof') else 0)
        lb += struct.pack('<BBBbHII', KI[L['kind']], min(255, L['lanes']), flags, max(-8, min(7, L['layer'])), int(min(655, L['w']) * 100), nodes[L['a']], nodes[L['b']])
        lb += pack_ring(out, pts)
        if z: lb += np.round(np.array(z) * 10).astype('<i2').tobytes()
        if tf or tb_: lb += bytes([len(tf)] + tf + [len(tb_)] + tb_)  # turn lanes, left to right in each direction of travel
    return bytes(lb)


def write_tile(out, tx, ty, size, terr, polys, lines, builds, trees, detail, water_only, pois=(), boats=(), holes=None, shops=(), beach=(), foreign=()):
    tb = box(tx, ty, tx + size, ty + size)
    n = terr.shape[0]
    out.section('TERR', struct.pack('<H', n) + np.clip(np.round(terr * 10), -32768, 32767).astype('<i2').tobytes())
    # ground: per class, the union clipped to the tile, as polygons (rings); the page triangulates and drapes them
    gb = bytearray(); runs = 0
    tol, min_area = (0.25, 4) if detail else (4.0, 600)
    near = lambda ps: [ps[k] for k in np.flatnonzero(shapely.intersects(np.array(ps, object), tb))] if ps else []  # (one GEOS call)
    wat = near(polys.get('water', []))
    water_u = unary_union(wat) if wat else None
    # per class: the union clipped to the tile and simplified, small bits dropped (the class below fills in); land is
    # the whole tile, under every other class
    per = {}
    for k in GROUND:
        cand = [tb] if k == 'land' else near(polys.get(k, []))
        if not cand: continue
        try: g = unary_union(cand).intersection(tb)
        except Exception: g = unary_union([c.buffer(0) for c in cand]).intersection(tb)
        if wat and k not in ('water', 'pier', 'land') and k not in ('road', 'arterial', 'sidewalk', 'blvd', 'walk', 'cycle', 'trail', 'ballast'): g = g.difference(water_u)
        if detail and holes is not None and g.intersects(holes): g = g.difference(holes)  # tunnel portals: the page draws their boxes there
        g = g.simplify(tol)
        if k != 'land':
            parts = [p for p in (g.geoms if hasattr(g, 'geoms') else [g]) if p.geom_type == 'Polygon' and p.area >= min_area]
            if not parts: continue
            g = unary_union(parts)
        per[k] = g
    sw = seawalls_near(tx, ty, size) if detail else []
    if sw:  # the ground cut along each seawall's line (tools/seawall.py SLIT): the walk's edge on one side, the water or sand at its foot on the other, the face between
        # (where the page draws the face: tile-worker.js seawalls(), the wall at least 0.3 m over its foot)
        hi = [F * (top - foot) for P, top, foot, reach, F, *_ in sw]
        slit = unary_union([LineString(P[k:k + 2]).buffer(seawall.SLIT * 0.75, quad_segs=2) for (P, *_), d in zip(sw, hi) for k in range(len(P) - 1) if max(d[k], d[k + 1]) >= 0.3])
        slit = edge_square(slit, tb, cut=True)  # (a slit a step wide there is a part too thin to keep: it joined the walk in one tile, the water in the next)
        per = {k: g.difference(slit) for k, g in wall_sides(per, sw, hi, tb).items()}
    per = ground_partition(per, tx, ty, out.k, holes if detail else None)
    for k in GROUND:
        if k not in per: continue
        geoms = [q for p in per[k] for q in getattr(p, 'geoms', [p]) if q.geom_type == 'Polygon']  # (a part the partition left in pieces)
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
    if sw: lines = off_walls(lines, sw)
    for L in lines:
        if not detail and (KI[L['kind']] >= KI['service'] and L['kind'] not in ('rail', 'lightrail', 'runway', 'taxiway')): continue
        mid = L['own']  # the point that decided which 4 km tile owns the piece
        if tx <= mid[0] < tx + size and ty <= mid[1] < ty + size: sel.append(L)
    out.section('LINE', line_bytes(out, sel, detail))
    if detail:  # the next tiles' decks whose strips reach over this one (section XDCK, as LINE): the page draws none of them, it
        # leaves out what of this tile's strips they cover, as it does between its own (tile-worker.js unstack()), and no paint under them
        tb2 = box(tx, ty, tx + size, ty + size)
        xd = [L for L in foreign if L['z'] and not L.get('tube') and L['kind'] in DRAWN and len(L['pts']) > 1
              and not (tx <= L['own'][0] < tx + size and ty <= L['own'][1] < ty + size) and LineString(L['pts']).buffer(L['w'] / 2 + 2.5).intersects(tb2)]
        if xd: out.section('XDCK', line_bytes(out, xd, True))
    if detail:  # tunnels (flag 64): per point 0 underground, 1 open (the ground is cut: the page draws its box), 2 a portal
        tun = [(n, L['tube']) for n, L in enumerate(sel) if L.get('tube') and L['z']]
        out.section('TUNL', struct.pack('<I', len(tun)) + b''.join(struct.pack('<I', n) + bytes(c) for n, c in tun))
    # buildings: compact header, optional fields behind flags
    bb = bytearray(); nb = 0; fb = bytearray()
    for b in builds:
        r = b['ring']
        c = b.get('centre') or b.setdefault('centre', (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)))  # once, not per tile
        if not (tx <= c[0] < tx + size and ty <= c[1] < ty + size): continue
        if not detail:
            if b['a'] < 60 and b['gh'] < 12 or b['mn'] > 0 and b['a'] < 150: continue  # overview: no sheds, no penthouses
            p = Polygon(r)
            if len(r) > 4:
                _, _, _, _, _, ar = obb(r)
                if p.area / ar > 0.86: r = list(p.minimum_rotated_rectangle.exterior.coords)[:-1]
                else:
                    sp = p.simplify(1.5)
                    if sp.geom_type == 'Polygon' and len(sp.exterior.coords) > 3: r = list(sp.exterior.coords)[:-1]
        b['mn'] = max(0.0, b['mn'] or 0.0); b['h'] = max(0.5, b['h'])
        units = b.get('units') if detail else None
        fl = (1 if b['mn'] else 0) | (2 if b['roof'] else 0) | (4 if b['wall'] else 0) | (8 if b['roofc'] else 0) | (16 if abs(b['gh'] - b['h']) > 0.5 else 0) \
            | 32 | (64 if units is not None else 0) | (128 if any(b.get('fx', ())) else 0)
        bb += struct.pack('<BBhH', fl, b['style'], int(round(b['base'] * 10)), int(min(6000, b['h'] * 10)))
        if fl & 1: bb += struct.pack('<H', int(max(0, min(6000, b['mn'] * 10))))
        if fl & 2: bb += struct.pack('<BH', b['roof'], int(min(6000, b['ridge'] * 10)))
        if fl & 4: bb += struct.pack('<I', b['wall'] & 0xffffff)
        if fl & 8: bb += struct.pack('<I', b['roofc'] & 0xffffff)
        if fl & 16: bb += struct.pack('<HI', int(min(6000, b['gh'] * 10)), b['gid'])
        # facade: storey height (1/20 m) and bits (1 storefront ground floor, 2 homes: balconies allowed; on a flat roof
        # 4 planted, 8 a pool, 16 solar panels)
        bb += struct.pack('<BB', int(min(255, round(b['fh'] * 20))), (1 if b['shop'] else 0) | (2 if b['res'] else 0) | b.get('rb', 0))
        if fl & 128:  # facade looks (tools/facades.py): balcony kind | pattern << 4, balcony facing octants (0 = all round)
            kind, pat, facing = b['fx']
            bb += struct.pack('<BB', kind | pat << 4, facing)
        if fl & 64:  # rooftop plant the LiDAR saw (none = a clean roof): centre, size along/across, height, angle
            bb += struct.pack('<B', len(units))
            for x, y, su, sv, uh, ang in units:
                bb += struct.pack('<hhBBBB', *out.q(x, y), int(min(255, su * 10)), int(min(255, sv * 10)), int(min(255, uh * 20)), int((ang % math.pi) / math.pi * 256) & 255)
        bb += pack_ring(out, r)
        nb += 1
        # each wall's own look (tools/lidar_walls.py), in the FACD section: per building its wall count (0: none) and 4
        # bytes a wall, the ring counter-clockwise as the page draws it
        fd = b.get('fd') if detail and r is b['ring'] else None
        if fd and len(fd) == len(r):
            if sum(r[k - 1][0] * r[k][1] - r[k][0] * r[k - 1][1] for k in range(len(r))) < 0:  # clockwise: the page turns it, so turn the walls with it
                fd = [fd[(len(r) - 2 - i) % len(r)] for i in range(len(r))]
            fb += bytes([min(255, len(r))]) + b''.join(bytes(d) for d in fd) if len(r) <= 255 else b'\0'
        else: fb += b'\0'
    out.section('BLDG', struct.pack('<I', nb) + bytes(bb))
    if detail: out.section('FACD', bytes(fb))
    tr_ = bytearray(); nt = 0
    for x, y, shape, col, h in trees:
        if not (tx <= x < tx + size and ty <= y < ty + size): continue
        if not detail and (h < 9 or (hash((round(x), round(y))) & 3)): continue
        tr_ += struct.pack('<hhBBB', *out.q(x, y), shape, col, int(min(63, h) * 4)); nt += 1
    out.section('TREE', struct.pack('<I', nt) + bytes(tr_))
    if detail:  # boats at their berths: centre, heading (1/256 turn), length (1/10 m), kind (1 sail) | colour << 1
        bt = [b for b in boats if tx <= b[0] < tx + size and ty <= b[1] < ty + size]
        out.section('BOAT', struct.pack('<I', len(bt)) + b''.join(struct.pack('<hhBBB', *out.q(x, y), int(a / (2 * math.pi) * 256) & 255, int(min(255, ln * 10)), k) for x, y, a, ln, k in bt))
    pb = bytearray(); npo = 0
    for k, nid, x, y in pois:
        if tx <= x < tx + size and ty <= y < ty + size: pb += struct.pack('<BQhh', k, nid, *out.q(x, y)); npo += 1
    out.section('POIS', struct.pack('<I', npo) + bytes(pb))
    sb = [struct.pack('<BhhB', k, *out.q(x, y), len(nm)) + nm for k, x, y, nm in shops if tx <= x < tx + size and ty <= y < ty + size]
    if sb: out.section('SHOP', struct.pack('<I', len(sb)) + b''.join(sb))  # the page ignores tiles without it
    # beach things (beach_bits): centre, angle (1/256 turn), length (1/10 m), diameter (1/100 m), kind; old pages skip it
    lb = [struct.pack('<hhBBBB', *out.q(x, y), int(round(a / (2 * math.pi) * 256)) & 255, int(min(255, round(ln * 10))), int(min(255, round(d * 100))), k)
          for x, y, a, ln, d, k in beach if tx <= x < tx + size and ty <= y < ty + size]
    if lb: out.section('LOGS', struct.pack('<I', len(lb)) + b''.join(lb))
    if sw:
        out.section('SEAW', seawall_section(out, sw))
        out.section('SEAG', np.round(np.concatenate([w[6] for w in sw]) * 100).astype('<i2').tobytes())  # (the walks' ground, tools/seawall.py walk_ground: per point, 1/100 m)
    return runs > 0 or nb > 0 or len(sel) > 0


WALL_M = 60  # metres round a detail tile its seawalls are kept to (the page's core/util.js WALL_R, and the ground past its edge)


def seawalls_near(x0, y0, size, m=WALL_M):
    """the pieces of the seawalls (WALLS) within m of a tile: [(points, top, foot, reach, end weight, rail)], each piece
    a run's points in reach and one more each side (the end weight is the whole run's: a piece's cut is no end), and the
    walk's ground per point (seawall.walk_ground)"""
    out = []
    for R in WALLS:
        P = R[0]
        k = np.flatnonzero((P[:, 0] > x0 - m) & (P[:, 0] < x0 + size + m) & (P[:, 1] > y0 - m) & (P[:, 1] < y0 + size + m))
        if not len(k): continue
        for r in np.split(k, np.flatnonzero(np.diff(k) > 1) + 1):
            s_, e_ = max(0, r[0] - 1), min(len(P), r[-1] + 2)
            if e_ - s_ >= 2: out.append(tuple(v[s_:e_] for v in R))
    return out


def edge_square(g, tb, cut=False):
    """a seawall's shape (its walk, its foot, the slit along its line) squared to the tile's edges: within band of an
    edge it is what it is on the edge itself, carried straight in. ground_partition() puts every border within two grid
    steps of the tile's edge onto it; a wall's line crossing the edge at a low angle then reached it metres apart in
    the two tiles, the walk in one meeting the water at the foot in the other: a step as high as the wall in the ground
    across the edge. Squared, both tiles have the same borders at the same points of the edge"""
    if g.is_empty: return g
    x0, y0, x1, y1 = tb.bounds
    q = GROUND_SNAP * (x1 - x0) / 16383  # ground_partition()'s grid: the borders on its lines, where its rounding leaves them in both tiles
    sn = lambda c: (x0 + round((c[0] - x0) / q) * q, y0 + round((c[1] - y0) / q) * q)
    band = 3 * q  # (clear of the two steps that are put on the edge)
    for line, strip, rect in ((LineString([(x0, y0), (x1, y0)]), box(x0, y0, x1, y0 + band), lambda a, b: box(a[0], y0, b[0], y0 + band)),
                              (LineString([(x0, y1), (x1, y1)]), box(x0, y1 - band, x1, y1), lambda a, b: box(a[0], y1 - band, b[0], y1)),
                              (LineString([(x0, y0), (x0, y1)]), box(x0, y0, x0 + band, y1), lambda a, b: box(x0, a[1], x0 + band, b[1])),
                              (LineString([(x1, y0), (x1, y1)]), box(x1 - band, y0, x1, y1), lambda a, b: box(x1 - band, a[1], x1, b[1]))):
        if not g.intersects(strip): continue
        if cut: g = g.difference(strip); continue  # (the slit: none by the edge, where the walk and the foot meet on one line)
        on = g.intersection(line)
        rects = [rect(sn(p.coords[0]), sn(p.coords[-1])) for p in getattr(on, 'geoms', [on]) if p.geom_type == 'LineString' and p.length > 0]
        rects = [r for r in rects if r.area > 0]
        g = unary_union([g.difference(strip)] + rects)
    return g


def wall_sides(per, sw, hi, tb):
    """the ground classes each on its side of the seawalls (per: class -> geometry; hi: per piece how high it stands,
    as the slit's): OSM's beaches and coastline cross a wall's line by a metre here and there, the line itself is moved
    in to the ground's edge, and the page draws the sand and water at a wall's foot and the rest on its walk (core/
    util.js wallHeight), so a class on the wrong side is a spike of sand up the face, a pool on the walk, a wedge of
    lawn in the sea. Sand and water on a walk (to its reach) become its paving; at the foot (seawall.LOW out, where
    the ground is the foot's) everything but a pier becomes the water, or the sand where the wall stands on a beach"""
    walk, wet, dry = [], [], []
    for (P, top, foot, reach, *_), d in zip(sw, hi):
        N = seawall.vnormals(P)
        for k in range(len(P) - 1):
            if max(d[k], d[k + 1]) < 0.3: continue
            a, b, na, nb = P[k], P[k + 1], N[k], N[k + 1]
            walk.append(Polygon([a, b, b + nb * reach[k + 1], a + na * reach[k]]))
            (dry if min(foot[k], foot[k + 1]) > 0.05 else wet).append(Polygon([a, b, b - nb * seawall.LOW, a - na * seawall.LOW]))
    if not walk: return per
    U = lambda Q: unary_union([q if q.is_valid else q.buffer(0) for q in Q]) if Q else Polygon()
    walk = edge_square(U(walk), tb); dry = edge_square(U(dry), tb).difference(walk); wet = edge_square(U(wet), tb).difference(walk).difference(dry)
    out = dict(per); moved = {'walk': [], 'sand': [dry], 'water': [wet]}
    for k, g in per.items():
        if k in ('sand', 'water'):
            moved['walk'].append(g.intersection(walk)); g = g.difference(walk)
            g = g.difference(wet if k == 'sand' else dry)
        elif k != 'pier': g = g.difference(dry).difference(wet)
        else:  # (a pier over the line by a tile's edge: its walk's side the paving there, so it steps at the line in both tiles, not down a ramp each cuts its own way)
            rim = walk.intersection(tb.difference(tb.buffer(-3 * GROUND_SNAP * (tb.bounds[2] - tb.bounds[0]) / 16383)))
            moved['walk'].append(g.intersection(rim)); g = g.difference(rim)
        out[k] = g
    for k, add in moved.items():
        g = unary_union([out.get(k, Polygon())] + add)
        parts = [q for q in getattr(g, 'geoms', [g]) if q.geom_type == 'Polygon' and not q.is_empty]
        if parts: out[k] = unary_union(parts)
    return out


WALL_PATHS = ('pedestrian', 'footway', 'cycleway', 'path', 'steps')  # (tools/geom_rules.py SW_PATHS)


def off_walls(lines, sw, gap=0.75, out_=seawall.SHIFT + 1):
    """the paths on the ground by the seawalls: one along a wall mapped out over its
    edge (OSM's metre or two) moved in onto its walk (its edge seawall.CLEAR in from the line); one across it (stairs or
    a ramp down off the walk) cut there, ending at its edge and going on from its foot, not draped over the face (the
    page draws no stairs) -> lines, a cut piece in parts (its inner ends new nodes: dead ends)"""
    from shapely.strtree import STRtree
    seg = [(P[k], P[k + 1]) for P, *_ in sw for k in range(len(P) - 1)]  # (to the run's ends: the walk's side steps there too, the face fading)
    if not seg: return lines
    face = unary_union([LineString(ab) for ab in seg]); tree = STRtree([LineString(ab) for ab in seg])
    A, B = np.array([a for a, _ in seg]), np.array([b for _, b in seg])
    t = (B - A) / np.maximum(np.hypot(*(B - A).T), 1e-9)[:, None]; n = np.stack([-t[:, 1], t[:, 0]], 1)  # (the walk's side)
    cut = face.buffer(gap, cap_style='flat')
    out = []
    for L in lines:
        if L['z'] is not None or L['kind'] not in WALL_PATHS or len(L['pts']) < 2 or LineString(L['pts']).distance(face) > out_ + L['w'] / 2 + 1:
            out.append(L); continue
        Q = np.array(densify([tuple(p) for p in L['pts']], 2.0), float)
        q = tree.nearest(shapely.points(Q))
        sd = ((Q - A[q]) * n[q]).sum(1); d = np.gradient(Q, axis=0); d /= np.maximum(np.hypot(*d.T), 1e-9)[:, None]
        need = L['w'] / 2 + seawall.CLEAR - sd
        mv = (np.abs((d * t[q]).sum(1)) > 0.7) & (sd > -out_) & (need > 0)
        if mv.any(): Q[mv] += n[q[mv]] * need[mv, None]; L = dict(L, pts=[tuple(c) for c in Q])
        g = LineString(L['pts'])
        if not face.intersects(g): out.append(L); continue
        dd = g.difference(cut)
        parts = [p for p in getattr(dd, 'geoms', [dd]) if p.geom_type == 'LineString' and p.length >= 0.5]
        parts.sort(key=lambda p: g.project(Point(p.coords[0])))
        for k, p in enumerate(parts):
            a = L['a'] if k == 0 and g.project(Point(p.coords[0])) < 1e-6 else hash((L['a'], L['b'], k, 0)) & 0x7fffffffffffffff
            b = L['b'] if k == len(parts) - 1 and g.length - g.project(Point(p.coords[-1])) < 1e-6 else hash((L['a'], L['b'], k, 1)) & 0x7fffffffffffffff
            out.append(dict(L, pts=[tuple(c) for c in p.coords], a=a, b=b))
    return out


def seawall_section(out, sw):
    """the SEAW section (the page's tile-worker.js terrain()): per piece its point count, per point x, north (Out.q), top
    and foot (1/100 m), reach (1/10 m), end weight (1/255), rail (1 a railing on its edge)"""
    b = bytearray(struct.pack('<I', len(sw)))
    for P, top, foot, reach, f, rail, _ in sw:
        b += struct.pack('<I', len(P))
        for k in range(len(P)):
            b += struct.pack('<hhhhBBB', *out.q(*P[k]), int(round(top[k] * 100)), int(round(foot[k] * 100)), int(min(255, round(reach[k] * 10))), int(round(f[k] * 255)), int(rail[k]))
    return bytes(b)


# ---------------------------------------------------------------- incremental: a 4 km tile is baked again only when what it reads changed
MARGIN = 2  # 8 m rows of the next detail tiles' terrain kept round each one (section TERM): paint reaching past a tile's edge lies on them


def margins(procs):
    """after each bake, over every detail tile (a neighbour rebaked changes it): the edge rows two tiles share made one
    (the 4 km cells' road-fitted grids are each held to their own LiDAR at their edges, sampled half a pixel apart: a
    step of up to a metre along every cell seam), and each tile's ring of its neighbours' terrain (TERM: n, MARGIN,
    then the rows over it, under it, the columns left and right of it, int16 decimetres like TERR): the page drapes a
    decal reaching into the next tile on that tile's own ground (held at the edge, it floated or sank on a slope)
    -> how many tiles changed"""
    files = sorted(f for f in os.listdir(f'{OUT}/0') if f.endswith('.bin'))
    with Pool(procs) as p: H = dict(zip([tuple(map(int, f[:-4].split('_'))) for f in files], p.map(_terr, files, 32)))
    n = next(iter(H.values())).shape[0]
    S = {k: v.astype(np.int32) for k, v in H.items()}
    # shared edges: the mean of the tiles' own (a corner: of the up to four there)
    F = {k: v.astype(np.int32).copy() for k, v in H.items()}
    for (i, j), v in S.items():
        E = S.get((i + 1, j))
        if E is not None: F[(i, j)][:, -1] = F[(i + 1, j)][:, 0] = np.round((v[:, -1] + E[:, 0]) / 2)
        N = S.get((i, j + 1))
        if N is not None: F[(i, j)][0, :] = F[(i, j + 1)][-1, :] = np.round((v[0, :] + N[-1, :]) / 2)
    for (i, j) in S:  # the corner nodes, over all the tiles that have one
        c = [(k, r, q) for k, r, q in (((i, j), 0, -1), ((i + 1, j), 0, 0), ((i, j + 1), -1, -1), ((i + 1, j + 1), -1, 0)) if k in S]
        if len(c) > 1:
            m = np.round(np.mean([S[k][r, q] for k, r, q in c]))
            for k, r, q in c: F[k][r, q] = m
    M = MARGIN
    jobs = []
    for (i, j), own in F.items():
        E = np.pad(own, M, mode='edge')  # (no neighbour: the edge carried on)
        mid, lo, hi, first, last = slice(M, M + n), slice(0, M), slice(M + n, M + n + M), slice(1, 1 + M), slice(n - 1 - M, n - 1)
        for (a, b), rows, cols, sr, sc in (((1, 0), mid, hi, slice(None), first), ((-1, 0), mid, lo, slice(None), last), ((0, 1), lo, mid, last, slice(None)),
                                           ((0, -1), hi, mid, first, slice(None)), ((1, 1), lo, hi, last, first), ((-1, 1), lo, lo, last, last),
                                           ((1, -1), hi, hi, first, first), ((-1, -1), hi, lo, first, last)):
            if (i + a, j + b) in F: E[rows, cols] = F[(i + a, j + b)][sr, sc]
        ring = struct.pack('<HH', n, M) + np.concatenate([E[:M].ravel(), E[-M:].ravel(), E[M:-M, :M].ravel(), E[M:-M, -M:].ravel()]).astype('<i2').tobytes()
        jobs.append(('%d_%d.bin' % (i, j), own.astype('<i2').tobytes(), ring))
    with Pool(procs) as p: return sum(p.imap_unordered(_margin, jobs, 32))


def _terr(f):
    b = gzip.decompress(open(f'{OUT}/0/{f}', 'rb').read())
    o = 20
    while o < len(b):
        tag, n = b[o:o + 4], struct.unpack_from('<I', b, o + 4)[0]
        if tag == b'TERR': m = struct.unpack_from('<H', b, o + 8)[0]; return np.frombuffer(b, '<i2', m * m, o + 10).reshape(m, m).copy()
        o += 8 + n


def _margin(job):
    """a tile's terrain with its shared edges and its TERM ring, written if they changed it"""
    f, terr, ring = job
    path = f'{OUT}/0/{f}'
    b = gzip.decompress(open(path, 'rb').read())
    o, keep = 20, bytearray(b[:20])
    while o < len(b):
        n = struct.unpack_from('<I', b, o + 4)[0]
        if b[o:o + 4] == b'TERR': keep += b[o:o + 10] + terr
        elif b[o:o + 4] != b'TERM': keep += b[o:o + 8 + n]
        o += 8 + n
    keep += b'TERM' + struct.pack('<I', len(ring)) + ring
    return int(write_if_changed(path, gzip.compress(bytes(keep), 7, mtime=0)))


def canon(o):
    """o with its numpy arrays as bytes: a repr that is the whole value"""
    if isinstance(o, np.ndarray): return o.shape, o.dtype.str, o.tobytes()
    if isinstance(o, (tuple, list)): return tuple(canon(v) for v in o)
    return o


def window(a, ax0, ay1, c, X0, Y0, m):
    """the cells of a whole-map raster (west edge ax0, north edge ay1, cell c) over the 4 km tile at X0, Y0, m cells
    around it (at least the edge cells, which a tile off the raster reads)"""
    r0, c0, n = int((ay1 - Y0 - L1) / c) - m, int((X0 - ax0) / c) - m, int(L1 / c) + 2 * m
    cut = lambda k, N: slice(min(max(0, k), N - 1), max(min(N, k + n), min(max(0, k), N - 1) + 1))
    return a[cut(r0, a.shape[0]), cut(c0, a.shape[1])]


def lookup_dbs():
    """the footprint databases build() looks buildings up in (roofs, facades, the LiDAR massing), loaded, and the
    measured walls (walls_near: STRtree, segments, looks)"""
    import roofs, facades, lidar_massing
    for f in (roof_lookup, facade_lookup, massing_lookup, walls_near): f([(0, 0), (1, 0), (0, 1)])
    return [roofs._DB, facades._DB, *lidar_massing._DB], lidar_massing._WT


def db_rows(db, bounds):
    """a database's rows a building inside bounds can match: their footprints and fields (the massing's parts too)"""
    if not db: return ()
    k = np.sort(db['tree'].query(box(*bounds)))
    out = [shapely.to_wkb(db['polys'][k]).tolist()] + [db[c][k] for c in sorted(db) if c not in ('tree', 'polys', 'parts') and len(db[c]) == len(db['polys'])]
    if 'parts' in db:
        P = db['parts']; ii = [i for h in k for i in range(int(db['po'][h]), int(db['po'][h] + db['pn'][h]))]
        out += [P[c][ii] for c in ('pfoot', 'ptop', 'proof', 'pridge')] + [P['prc'][P['pro'][i]:P['pro'][i + 1]] for i in ii]
    return canon(out)


CODE = None
NARROWED = {'data/sea.npz', 'data/mrdem32.npz', 'data/trees.csv', 'data/bf2009.geojson', 'data/decks.pkl', 'data/roofs.npz', 'data/facades.npz',
            'data/massing22.npz', 'data/massing_lm.npz', 'data/seawalls.npz'}  # cell_key's own take on these: only what the tile reads of them


def code_version():
    """build()'s code (code_key) and libraries, and the data files it reads whole: computed before the workers fork, so
    they all read the same sources"""
    global CODE
    if CODE is None:
        import scipy, PIL, rasterio
        # a data file the code reads that is not narrowed to the tile below (a new input, say): the whole file, so a
        # change to it rebakes every tile until it is added here
        whole = sorted(f for f in code_data(__file__, 'safe_build') - NARROWED if os.path.isfile(f))
        CODE = digest(code_key(__file__, 'safe_build'), np.__version__, shapely.__version__, scipy.__version__, PIL.__version__, rasterio.__version__,
                      whole, [file_digest(f) for f in whole])
    return CODE


def cell_key(ij):
    """everything build(ij) reads, narrowed to the tile where it can be: its OSM bucket and HRDEM, the MRDEM and sea
    around it, the city trees and 2009 sections in it, the roof/facade/massing rows under its buildings, its ways' deck,
    approach and tunnel profiles, and the code (code_key: build and all it calls, the libraries' versions)"""
    i, j = ij
    X0, Y0 = i * L1, j * L1
    feat = load_feat(i, j)
    deck_profiles()
    lines = retunnel(feat.get('lines', []))
    wids = sorted({L[0] for L in lines})
    refs = {r for L in lines for r in L[2]}
    dbs, walls = lookup_dbs(); wt, seg, desc = walls or (None, None, None)
    ring_pts = np.array([p for _, prs, _ in feat.get('buildings', []) for o, _ in prs for p in o] or [(X0, Y0)])
    bounds = (*(ring_pts.min(0) - 20), *(ring_pts.max(0) + 20))  # a porch, a part: near its footprint
    return digest(code_version(), file_digest(f'data/feat/{i}_{j}.pkl'), file_digest(f'data/hr/{i}_{j}.npz'),
                  window(MR, MR_X0, MR_Y1, 32, X0, Y0, 3), window(SEA_M, SEA_X0, SEA_Y1, SEA_C, X0, Y0, 8), (SEA_X0, SEA_Y1, SEA_C),
                  [t for t in TREES if X0 - 5 <= t[0] < X0 + L1 + 5 and Y0 - 5 <= t[1] < Y0 + L1 + 5], sections_at(X0, Y0),
                  [db_rows(db, bounds) for db in dbs], canon([(seg[k], desc[k]) for k in np.sort(wt.query(box(*bounds)))] if walls else ()),
                  canon([(w, DECKS.get(w), APPROACH.get(w), TUNNELS.get(w), w in ROOFS, sorted(RETUN.get(w, {}).items())) for w in wids]), sorted(refs & PORTALS),
                  canon(seawalls_near(X0, Y0, L1)), KIT[(KIT[:, 0] >= X0) & (KIT[:, 0] < X0 + L1) & (KIT[:, 1] >= Y0) & (KIT[:, 1] < Y0 + L1)].tobytes())


def safe_build(job):
    """(i, j), the key it was last baked with -> build()'s result and the key now, or 'same' when they match"""
    import traceback
    ij, old = job
    try:
        key = cell_key(ij)
        if key == old: return ij, 'same', key
        with cpu_slot(): return (*build(ij), key)
    except Exception: return ij, 'FAILED', traceback.format_exc().splitlines()[-1]


def selftest():
    """synthetic LiDAR: a gable whose ridge runs across the footprint, a hip, a shed, and a tower on a podium; what
    stands on a roof"""
    from shapely.strtree import STRtree
    # the ground: one planar partition, later classes on top, every border the same points on both sides
    tx, ty, k = 2048.0, -1024.0, 32766 / 2048
    tb = box(tx, ty, tx + 1024, ty + 1024)
    road = LineString([(tx - 5, ty + 300.3), (tx + 1030, ty + 712.9)]).buffer(6, quad_segs=3)
    part = ground_partition({'land': tb, 'grass': Point(tx + 400, ty + 470).buffer(90), 'sidewalk': road.buffer(2.5).intersection(tb), 'road': road.intersection(tb)}, tx, ty, k)
    geoms = [p for ps in part.values() for p in ps]
    assert abs(sum(p.area for p in geoms) - tb.area) < 1e-3 and abs(shapely.union_all(geoms).area - tb.area) < 1e-3, 'overlap or gap'
    assert part['road'][0].contains(Point(tx + 400, ty + 459.5)) and any(p.contains(Point(tx + 400, ty + 520)) for p in part['grass'])
    seg = {}
    for p in geoms:
        for r in [p.exterior, *p.interiors]:
            c = np.round((np.asarray(r.coords) - (tx, ty)) * k / GROUND_SNAP).astype(int)
            for a, b in zip(map(tuple, c[:-1]), map(tuple, c[1:])): seg[min(a, b), max(a, b)] = seg.get((min(a, b), max(a, b)), 0) + 1
    E = 16383 // GROUND_SNAP
    assert all(n == 2 or (a[0] == b[0] and a[0] in (0, E)) or (a[1] == b[1] and a[1] in (0, E)) for (a, b), n in seg.items()), 'a border not shared'
    far = [(9e5, 9e5), (9e5 + 30, 9e5), (9e5 + 30, 9e5 + 20), (9e5, 9e5 + 20)]  # nowhere near the orthophoto
    pools, sun = STRtree([box(9e5 + 5, 9e5 + 5, 9e5 + 15, 9e5 + 9)]), STRtree([shapely.geometry.Point(9e5 + 20, 9e5 + 10)])
    assert roof_bits(dict(ring=far, roof=0), {'roof:garden': 'yes'}, pools, sun) == 4 | 8 | 16
    assert roof_bits(dict(ring=far, roof=1), {}, pools, sun) == 0  # pitched: nothing
    assert roof_bits(dict(ring=[(x + 100, y) for x, y in far], roof=0), {}, pools, sun) == 0
    ring = [(0, 0), (16, 0), (16, 10), (0, 10)]  # long axis along x; cells of the 2 m grid, NW corner at (0, 10)
    xs, ys = np.meshgrid((np.arange(8) + 0.5) * HR, 10 - (np.arange(5) + 0.5) * HR)
    ok = np.ones(xs.shape, bool)
    f = fit_roof(ring, 8 - 0.5 * np.abs(xs - 8), ok, (0, 10))  # ridge along y (the short side)
    assert f and f[0] & 15 == 1 and f[0] & CROSS and abs(f[2] - 8) < 0.3, f
    f = fit_roof(ring, 8 - 0.5 * np.maximum(np.abs(ys - 5), np.abs(xs - 8) - 3), ok, (0, 10))
    assert f and f[0] & 15 == 2, f
    f = fit_roof(ring, 4 + 0.4 * ys, ok, (0, 10))  # high side north: +v when the long axis points east
    assert f and f[0] & 15 == 5 and f[0] & FLIP, f
    z = np.full((20, 20), 12.0); z[5:12, 6:13] = 60.0; z[8:10, 8:10] = 64.0
    assert len(height_levels(z.ravel())) == 2, height_levels(z.ravel())
    # a deck cresting 30 m up (6% at the ends), stay cables 30-60 m above it near a pylon, an expansion-joint gap
    sd = np.arange(0, 2000, 4.0); deck = 10 + 30 * (1 - ((sd - 1000) / 1000) ** 2)
    seen = deck.copy(); seen[(sd > 900) & (sd < 1050)] += 30 + 30 * np.sin((sd[(sd > 900) & (sd < 1050)] - 900) / 50); seen[300] -= 8
    assert np.abs(robust_deck(sd, seen) - deck).max() < 1.5, np.abs(robust_deck(sd, seen) - deck).max()
    # elevation: a pier (4 m) in the sea keeps its height, the sea around it (wave noise) is flat at 0
    sea = np.ones((40, 40), bool); dt = np.random.default_rng(1).normal(0, 0.3, (40, 40)); dt[10:20, 5:35] = 4.0
    f = flat_water(dt, sea, sea)
    assert np.allclose(f[12:18, 8:32], 4.0) and np.all(f[25:38, 2:38] == 0), (f[12:18, 8:32].min(), np.abs(f[25:38]).max())
    # an approach: the viaduct goes on flat at 12 m for 40 m past the bridge tag, then a 5% ramp down to the ground
    # (a tree over it doesn't lift it); under the trees it comes down at its own grade; where the LiDAR sees only the
    # ground past the deck end there is no ramp (stairs, a lift)
    sa = np.arange(0, 400, 4.0); gr = np.full(len(sa), 2.0); lw = np.maximum(2.0, 12.0 - 0.05 * np.maximum(0, sa - 40)); lw[20] += 9
    z, down = ramp(sa, lw, gr.copy(), 12.0, 0.08, 300)
    assert down is not None and np.allclose(z[:11], 12, atol=0.01) and abs(sa[down] - 240) < 12 and np.nanmax(np.diff(z)) <= 1e-9, (down, z[:20])
    z, down = ramp(sa, np.full(len(sa), 30.0) + 5 * (np.arange(len(sa)) % 2), gr.copy(), 12.0, 0.08, 150)
    assert abs(sa[down] - 10 / 0.08) < 8, down
    z, down = ramp(sa, np.full(len(sa), 2.0), gr.copy(), 12.0, 0.08, 150)
    assert down == -1, down
    z, down = ramp(sa, np.full(len(sa), 2.0), gr.copy(), 4.0, 0.08, 150)  # a deck end a little high: down to the ground
    assert down == 1 and np.isfinite(z[:2]).all(), (down, z[:3])
    # the LiDAR follows a ramp down, then sees the open ground 2 m below it: down to it at the ramp's grade, not a step
    z, down = ramp(sa, np.where(sa <= 160, 12 - 0.05 * sa, 2.2), gr.copy(), 12.0, 0.08, 300)
    assert down == 41 and z[down] == 2.0 and np.max(-np.diff(z[:down + 1])) <= 0.08 * 4 + 1e-6, (down, z[35:42])
    # one solve over a structure: a footbridge 12 m up whose end a street goes on from (down to the ground at it), a second
    # deck drawn half over it 0.8 m higher (one surface with it), a third crossing 4 m over them (SEP over at least)
    global DECKS
    old = DECKS, dict(APPROACH)
    flat = lambda x, y: np.full(len(np.atleast_1d(x)), 3.0)
    def way(c, refs, k, z):
        P = np.array(densify(c, 4), float); s = np.concatenate([[0], np.cumsum(np.hypot(*np.diff(P, axis=0).T))])
        return (c, refs, {'highway': k}, k), (P, s, None, None), (np.array(c, float), s, np.interp(s, [0, s[-1]], z))
    W_ = {1: way([(0.0, 0.0), (200.0, 0.0)], [1, 2], 'footway', [12, 12]), 2: way([(0.0, 1.0), (200.0, 1.0)], [3, 4], 'cycleway', [12.8, 12.8]),
          3: way([(100.0, -60.0), (100.0, 60.0)], [5, 6], 'path', [17.0, 17.0])}  # (foot: their far ends left where they are)
    DECKS = {w: d for w, (_, _, d) in W_.items()}; APPROACH.clear()
    deck_solve({w: a for w, (a, _, _) in W_.items()}, {w: r for w, (_, r, _) in W_.items()}, ({}, {2: [(9, 0)], 4: [(9, 1)]}), ground=flat, drawn=flat)
    z1, z2, z3 = (DECKS[w][2] for w in (1, 2, 3))
    assert abs(z1[-1] - (3 + 0.02 - DECK_TOP)) < 0.05 and 11.7 < z1[0] < 13.1 and np.max(np.abs(np.diff(z1))) <= 0.10 * 4 + 1e-3, z1
    assert np.max(np.abs(z1 - z2)) < 0.05 and np.interp(60, DECKS[3][1], z3) - np.interp(100, DECKS[1][1], z1) >= SEP - 0.05, (z2 - z1, z3)
    DECKS = old[0]; APPROACH.update(old[1])
    # a structure too big for one MILP: a stretch that gives is decided in a window of its own (two decks held 3 m apart
    # by what they meet, drawn as one surface: stacked, which gives 0.2 m, not 3)
    Wt = dict(tie=300.0, sep=300.0, end=1000.0)
    rs = [(0, [(0, 1.0)], 10.0, Wt['end'], True, 'end', 0), (0, [(1, 1.0)], 13.0, Wt['end'], True, 'end', 1)]
    runs = {0: (False, [(1, 0, 0, 0.0, 1)])}
    assert deck_windows(deck_chosen(rs, runs, Wt, {0: 0}), runs, Wt, {0: 10.0, 1: 13.0}, [0], [0]) == {0: 1}
    # crowns: two 12 m trees in a 20 x 40 m patch of canopy share it, up to their reach; a lone tree in a small patch keeps a small crown
    can = np.zeros((40, 40), bool); can[10:20, 5:25] = True; can[30:33, 30:33] = True
    w = crown_widths(np.full((40, 40), 12.0), can, [(15, 10), (15, 20), (31, 31)], [12.0, 12.0, 6.0])
    assert 13 < w[0] < 17 and 13 < w[1] < 17 and w[2] < 7.5 and crown_q(w[0]) > crown_q(w[2]), w
    # forms: the cultivar over the genus, the LiDAR crown's shape for round-headed trees, conifers by genus
    r = random.Random(1)
    looks = [tree_look('CARPINUS', r, 'PYRAMIDAL EUROPEAN HORNBEAM FASTIGIATA')[0], tree_look('PRUNUS', r, 'KWANZAN FLOWERING CHERRY KWANZAN')[0],
             tree_look('ACER', r, 'NORWAY MAPLE NONE', 1.5)[0], tree_look('ACER', r, 'NORWAY MAPLE NONE', 1.0)[0], tree_look('THUJA', r, 'WESTERN RED CEDAR NONE')[0],
             tree_look('SALIX', r)[0], tree_look('ULMUS', r)[0], tree_look('PSEUDOTSUGA', r)[0], tree_look('TRACHYCARPUS', r)[0]]
    assert looks == [1, 8, 2, 0, 5, 3, 8, 4, 7], looks
    # a 1.5 km span (the Lions Gate: one way) cut at the detail tiles' edges, joined end to end, heights carried on
    parts = split_long(dict(pts=[(-2395.0, 2854.0), (-1592.0, 4182.0)], z=[51.0, 20.0], tube=None, own=(0, 0), a=1, b=2), 7 * 1024)
    assert len(parts) == 4 and parts[0]['a'] == 1 and parts[-1]['b'] == 2 and all(p['b'] == q['a'] < 2 ** 53 for p, q in zip(parts, parts[1:]))
    assert all(math.floor(p['own'][0] / L0) == math.floor(min(x for x, _ in p['pts']) / L0 + 1e-9) for p in parts) and parts[1]['z'][0] == parts[0]['z'][-1]
    # the 8 m grid under a street along a cut's lip: the street's ground there, the cut's floor away from it kept
    dtm = np.full((2048, 2048), 30.0, np.float32); dtm[:, 1003:1010] = 20.0  # a 14 m wide cut beside x = 2000
    street = [dict(z=None, kind='primary', w=12.0, pts=[(2026.0, -3000.0), (2026.0, -1000.0)])]
    G, F = road_ground(dtm, street, 0, -L1)
    gx = lambda x, y: ndimage.map_coordinates(G, [[(-y) / 8], [x / 8]], order=1)[0] + ndimage.map_coordinates(F, [[(-y) / FINE], [x / FINE]], order=1)[0]
    assert abs(gx(2026, -2000) - 30) < 0.8 and abs(gx(2021, -2000) - 30) < 1.0 and gx(2008, -2000) < 21, (gx(2026, -2000), gx(2021, -2000), gx(2008, -2000))
    # a path along a 4 m ditch 3 m deep, narrower than the 8 m grid: the fine lattice takes it down into it, the
    # fields beside it stay where they are; the tile's section gives back the same ground
    dtm = np.full((2048, 2048), 30.0, np.float32); dtm[:, 1001:1003] = 27.0
    G, F = road_ground(dtm, [dict(z=None, kind='footway', w=2.2, pts=[(2004.0, -3000.0), (2004.0, -1000.0)])], 0, -L1)
    assert abs(gx(2004, -2000) - 27) < 0.3 and abs(gx(2020, -2000) - 30) < 0.2 and np.abs(F[:8]).max() == 0 and np.abs(F[:, 504:521]).max() == 0, (gx(2004, -2000), gx(2020, -2000))
    T = G[3 * 128:4 * 128 + 1, 1 * 128:1 * 128 + 129]; Ft = F[3 * 512:4 * 512 + 1, 1 * 512:1 * 512 + 513]
    D = fine_grid(np.round(T * 10) / 10, fine_section(Ft))
    assert np.abs(D - (ndimage.zoom(np.round(T * 10) / 10, 4, order=1, grid_mode=False)[:513, :513] + Ft)).max() < 0.02
    # pct is np.percentile to the bit; a CPU slot is held while its job runs and given back after
    rng = np.random.default_rng(2)
    for n in (1, 2, 7, 100, 1001):
        for dt in (np.float32, np.float64):
            v = rng.normal(0, 20, n).astype(dt)
            for q in (0, 5, 10, 60, 70, 90, 97, 100):
                assert pct(v, q) == np.percentile(v, q) and type(pct(v, q)) == type(np.percentile(v, q)), (n, dt, q)
    import common, fcntl, tempfile
    with tempfile.TemporaryDirectory() as d:
        common.SLOTS = d
        def busy():
            fd = os.open(f'{d}/0', os.O_RDWR)
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); return False
            except OSError: return True
            finally: os.close(fd)
        with cpu_slot(2): assert busy()
        assert not busy() and common.spare_cores(0) <= common.cpus() + 1e-9
    # a tunnel's mouth further out than its mapped portal: that much of the road on from it is a tunnel way of its own
    RETUN[7] = {-1: (30.0, 0.0)}
    (a, c, r, t), (b, c2, r2, t2) = retunnel([(7, [(0.0, 0.0), (100.0, 0.0)], [1, 2], {'highway': 'primary'})])
    RETUN.clear()
    assert t['tunnel'] == 'yes' and c == [(70.0, 0.0), (100.0, 0.0)] and r[1] == 2 and r2 == [1, r[0]] and c2 == [(0.0, 0.0), (70.0, 0.0)] and b == 7 and a > 1 << 33 and r[0] < 1 << 53 and 'tunnel' not in t2
    rules_selftest()
    print('selftest ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['selftest']: selftest(); sys.exit()
    # [procs] [i_j ...]: procs caps the workers (cpu_slot runs fewer while the machine is busy); FORCE=1 bakes every tile
    procs = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    os.environ['PROCS'] = str(procs)  # cpu_slot's cap, in the workers too
    want = tile_args(sys.argv[2:]) or all_tiles()
    t0 = time.time()
    deck_profiles(); lookup_dbs(); code_version()  # once, before the workers fork (Linux): they share them
    size = lambda ij: os.path.getsize(f'data/feat/%d_%d.pkl' % ij) if os.path.exists(f'data/feat/%d_%d.pkl' % ij) else 0
    want.sort(key=lambda ij: -size(ij))  # the busiest (downtown, minutes each) first, so none is left running alone at the end
    man = manifest(OUT); cells = man.setdefault('cells', {})
    jobs = [(ij, None if os.environ.get('FORCE') == '1' else cells.get('%d_%d' % ij)) for ij in want]
    n = dict(same=0, ok=0, sea=0, FAILED=0)
    rules = {}  # geometry rules over the cells baked: name -> [fixed, left]
    with Pool(procs) as p:
        for r in p.imap_unordered(safe_build, jobs):
            n[r[1]] += 1
            if r[1] == 'ok':
                man.setdefault('issues', {})['%d_%d' % r[0]] = r[-2]  # what each rule fixed and left in the cell (tools/geom_rules.py gates on it)
                for k, v in r[-2].items(): rules[k] = [a + b for a, b in zip(rules.get(k, [0, 0, 0]), (v['fixed'], v['left'], v['allowed']))]
            if r[1] != 'FAILED': cells['%d_%d' % r[0]] = r[-1]; save_manifest(OUT, man)
            if r[1] != 'same': print((*r[:-2], {k: (v['fixed'], v['left'], v['allowed']) for k, v in r[-2].items()}) if r[1] == 'ok' else r, round(time.time() - t0), 's', flush=True)
    print(n, 'in', round(time.time() - t0), 's', flush=True)
    if rules: print('geometry rules (fixed, left, allowed):', rules, flush=True)
    if n['ok']: print('terrain margins:', margins(procs), 'tiles changed', flush=True)
    write_index(OUT)

