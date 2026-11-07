# Bakes the downloaded data into the files the page draws, for two regions (central Vancouver and UBC):
#   public/ground-<region>.jpg   top-down ground texture (water, parks, beaches, streets)
#   public/city.bin              terrain, buildings, trees, boats, bridges and the road graph, packed
#   public/meta.json             regions, landmarks
# Coordinates are isoworld's (vancouver.isoworld.xyz) east-north-up metres, so the code and the
# illustrated tab share one camera: origin and scale fitted against their road network, heights
# against MRDEM (see FRAME below).
# Run: uv run --with numpy,pillow,scipy,rasterio python3 tools/bake.py
import csv, heapq, json, math, os, random, struct
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

random.seed(7)
np.random.seed(7)
# ---------- frame: isoworld's ENU, fitted (ICP on 4400 junctions, 2.9 m median; heights 1.5 m sd) ----------
LAT_O, LON_O, SC = 49.28606407, -123.10901045, 0.99744659
KX = 111320 * math.cos(math.radians(49.2845)) / SC
KY = 110574 / SC
ZC = (-19.0387, -3.697e-4, -1.2792e-4, -1.6638e-7)  # their z = DEM + c + aE + bN + d r^2
RES = 2.0  # metres per texture pixel
TILE, TRES = 512, 0.5  # detailed ground tiles: size in metres, metres per pixel
CW = {0: 15.2, 1: 13.3, 2: 11.4, 3: 9.5, 4: 7.6}  # carriageway width by road class, as the tiles draw it
SS = 2  # supersampling for the texture
HSTEP = 20.0  # terrain grid, metres
REGIONS = [
    dict(name='main', osm='data/osm.json', parking='data/parking.json', bbox=(49.232, -123.172, 49.318, -123.080),
         sea=(49.2855, -123.160), home=(49.28, -123.12)),
    dict(name='ubc', osm='data/osm-ubc.json', parking='data/parking-ubc.json', bbox=(49.240, -123.275, 49.282, -123.220),
         sea=(49.280, -123.245), home=(49.262, -123.248)),
]


def ll(lat, lon):  # lat/lon -> world metres (east, north)
    return ((lon - LON_O) * KX, (lat - LAT_O) * KY)


def xy(p):
    return ll(p['lat'], p['lon'])


def join_rings(lines):
    lines = [l[:] for l in lines if len(l) > 1]
    rings = []
    while lines:
        cur = lines.pop()
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, l in enumerate(lines):
                if l[0] == cur[-1]: cur += l[1:]
                elif l[-1] == cur[-1]: cur += l[::-1][1:]
                elif l[-1] == cur[0]: cur = l + cur[1:]
                elif l[0] == cur[0]: cur = l[::-1] + cur[1:]
                else: continue
                lines.pop(i); changed = True; break
        if len(cur) > 3: rings.append(cur)
    return rings


def shapes(e):
    """[(outer rings, inner rings)] in metres for a way or multipolygon."""
    if e['type'] == 'way' and 'geometry' in e:
        g = [xy(p) for p in e['geometry']]
        return [([g], [])] if len(g) > 3 and g[0] == g[-1] else []
    if e['type'] == 'relation':
        mem = [m for m in e.get('members', []) if m.get('type') == 'way' and 'geometry' in m]
        r = lambda role: join_rings([[(round(a, 2), round(b, 2)) for a, b in map(xy, m['geometry'])] for m in mem if m.get('role', 'outer') == role])
        o = r('outer')
        return [(o, r('inner'))] if o else []
    return []


def line(e):
    return [xy(p) for p in e.get('geometry', []) if p]


def inside(pt, poly):
    x, y = pt; c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c


def area(r):
    return abs(sum(r[i][0] * r[i - 1][1] - r[i - 1][0] * r[i][1] for i in range(len(r)))) / 2


def cent(r):
    return (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r))


def hnum(v):
    try: return float(str(v).split(';')[0].replace('m', '').strip())
    except ValueError: return None


def inset(r, d):
    """The ring with every edge moved d metres inwards (mitred, capped at 3d)."""
    sgn = 1 if sum(r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1] for i in range(len(r))) > 0 else -1  # +1: counter-clockwise
    out = []
    for i in range(len(r)):
        (x0, y0), (x1, y1), (x2, y2) = r[i - 1], r[i], r[(i + 1) % len(r)]
        def nrm(ax, ay, bx, by):
            l = math.hypot(bx - ax, by - ay) or 1
            return (-(by - ay) / l * sgn, (bx - ax) / l * sgn)  # inward normal
        n1, n2 = nrm(x0, y0, x1, y1), nrm(x1, y1, x2, y2)
        mx, my = n1[0] + n2[0], n1[1] + n2[1]; ml = math.hypot(mx, my)
        if ml < 1e-6: out.append((x1, y1)); continue
        k = min(3 * d, d / max(0.2, (mx * n1[0] + my * n1[1]) / ml))
        out.append((x1 + mx / ml * k, y1 + my / ml * k))
    return out


def obb(r):
    """Smallest rectangle around a ring: (cx, cy, angle, half-length, half-width), length >= width."""
    best = None
    for i in range(len(r)):
        (x1, y1), (x2, y2) = r[i - 1], r[i]
        a = math.atan2(y2 - y1, x2 - x1); ca, sa = math.cos(a), math.sin(a)
        us = [x * ca + y * sa for x, y in r]; vs = [-x * sa + y * ca for x, y in r]
        ar = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or ar < best[0]: best = (ar, a, min(us), max(us), min(vs), max(vs))
    ar, a, u0, u1, v0, v1 = best
    uc, vc = (u0 + u1) / 2, (v0 + v1) / 2
    cx, cy = uc * math.cos(a) - vc * math.sin(a), uc * math.sin(a) + vc * math.cos(a)
    hl, hw = (u1 - u0) / 2, (v1 - v0) / 2
    if hw > hl: a += math.pi / 2; hl, hw = hw, hl
    return cx, cy, a, hl, hw, ar


# ---------- terrain (MRDEM 30 m, NRCan, OGL-Canada) ----------
def terrain(x0, y0, nx, ny):
    import rasterio
    from rasterio.warp import transform
    xs = x0 + np.arange(nx) * HSTEP; ys = y0 + np.arange(ny) * HSTEP
    E, N = np.meshgrid(xs, ys)
    lon = LON_O + E / KX; lat = LAT_O + N / KY
    url = '/vsicurl/https://canelevation-dem.s3.ca-central-1.amazonaws.com/mrdem-30/mrdem-30-dtm.tif'
    with rasterio.open(url) as src:
        px_, py_ = transform('EPSG:4326', src.crs, lon.ravel().tolist(), lat.ravel().tolist())
        px_, py_ = np.array(px_), np.array(py_)
        win = rasterio.windows.from_bounds(px_.min() - 90, py_.min() - 90, px_.max() + 90, py_.max() + 90, src.transform)
        win = win.round_offsets().round_lengths()
        a = src.read(1, window=win).astype(np.float64)
        t = src.window_transform(win)
    c = (px_ - t.c) / t.a - 0.5; r = (py_ - t.f) / t.e - 0.5
    dem = ndimage.map_coordinates(np.nan_to_num(a, nan=0.0), [r, c], order=1, mode='nearest').reshape(ny, nx)
    return np.maximum(dem, 0), E, N


def zfit(dem, E, N):
    return dem + ZC[0] + ZC[1] * E + ZC[2] * N + ZC[3] * (E * E + N * N)


# ---------- classify ----------
AREA = {  # paint order, colour
    'residential': (0, (118, 152, 86)), 'commercial': (1, (162, 160, 152)), 'retail': (1, (165, 160, 150)),
    'industrial': (1, (150, 142, 128)), 'railway': (1, (140, 132, 120)), 'construction': (1, (176, 160, 130)),
    'brownfield': (1, (170, 155, 125)),
    'grass': (2, (114, 156, 74)), 'meadow': (2, (138, 172, 82)), 'recreation_ground': (2, (110, 154, 72)),
    'cemetery': (2, (118, 150, 84)), 'park': (2, (106, 150, 70)), 'garden': (3, (110, 156, 70)),
    'golf_course': (3, (126, 178, 80)), 'grassland': (2, (140, 170, 90)), 'scrub': (3, (98, 128, 66)),
    'playground': (4, (178, 160, 120)), 'pitch': (4, (98, 168, 70)), 'track': (5, (168, 142, 118)),
    'stadium': (4, (150, 150, 145)),
    'wood': (5, (36, 72, 48)), 'forest': (5, (36, 72, 48)), 'wetland': (5, (92, 124, 82)),
    'beach': (6, (226, 210, 168)), 'sand': (6, (222, 206, 164)),
    'marina': (-1, None), 'swimming_pool': (8, (96, 196, 222)),
}
ROAD = {'motorway': 8, 'trunk': 8, 'primary': 7, 'secondary': 6, 'tertiary': 5, 'trunk_link': 5, 'primary_link': 5,
        'secondary_link': 5, 'tertiary_link': 4, 'residential': 4, 'unclassified': 4, 'living_street': 3,
        'service': 2.4, 'pedestrian': 3, 'footway': 1.2, 'cycleway': 1.4, 'path': 1.1, 'track': 1.6, 'steps': 1.2}
# road class for traffic: 0 motorway/trunk, 1 primary, 2 secondary, 3 tertiary, 4 residential
DRIVE = {'motorway': 0, 'trunk': 0, 'motorway_link': 0, 'trunk_link': 1, 'primary': 1, 'primary_link': 1,
         'secondary': 2, 'secondary_link': 2, 'tertiary': 3, 'tertiary_link': 3, 'residential': 4, 'unclassified': 4,
         'living_street': 4}

# LiDAR footprints (City of Vancouver 2009): height above ground and roof type, indexed by centroid
lidar = {}
segments = []  # LiDAR roof sections (one per height level of a building): ring in world metres, height, roof type
for f in json.load(open('data/bf2009.geojson'))['features']:
    p = f['properties']; g = p.get('geo_point_2d')
    if not g or p.get('maxht_m') is None: continue
    x, y = ll(g['lat'], g['lon'])
    lidar.setdefault((int(x // 40), int(y // 40)), []).append((x, y, p))
    geo = f['geometry']; polys = geo['coordinates'] if geo['type'] == 'MultiPolygon' else [geo['coordinates']] if geo['type'] == 'Polygon' else []
    for poly in polys:
        r = [ll(b, a) for a, b in poly[0]]
        if r[0] == r[-1]: r = r[:-1]
        if len(r) >= 3 and (p.get('hgt_agl') or 0) >= 2 and area(r) >= 6: segments.append((r, p['hgt_agl'], (p.get('rooftype') or '').lower()))
print('lidar footprints', sum(map(len, lidar.values())))


def lidar_for(r):
    xs = [p[0] for p in r]; ys = [p[1] for p in r]; best = None
    for gx in range(int(min(xs) // 40), int(max(xs) // 40) + 1):
        for gy in range(int(min(ys) // 40), int(max(ys) // 40) + 1):
            for x, y, p in lidar.get((gx, gy), []):
                if inside((x, y), r) and (best is None or (p.get('area_m2') or 0) > (best.get('area_m2') or 0)): best = p
    return best


# public trees (City of Vancouver): genus decides the autumn colour class
FALLC = {  # 1 yellow, 2 orange, 3 red, 4 brown, 5 conifer; 0 stays green
    1: 'FRAXINUS TILIA BETULA GINKGO GLEDITSIA CERCIDIPHYLLUM ULMUS LIRIODENDRON ZELKOVA POPULUS SALIX CATALPA ROBINIA KOELREUTERIA',
    2: 'PRUNUS MALUS SORBUS PYRUS AMELANCHIER STEWARTIA PARROTIA CRATAEGUS METASEQUOIA TAXODIUM CARPINUS',
    3: 'ACER LIQUIDAMBAR NYSSA CORNUS OXYDENDRUM CERCIS',
    4: 'QUERCUS FAGUS AESCULUS PLATANUS CASTANEA JUGLANS',
    5: 'THUJA PSEUDOTSUGA PICEA PINUS CHAMAECYPARIS TSUGA ABIES SEQUOIADENDRON CEDRUS SEQUOIA TAXUS CUPRESSOCYPARIS ARAUCARIA CALOCEDRUS',
}
GENUS = {g: k for k, s in FALLC.items() for g in s.split()}
city_trees = []
with open('data/trees.csv', encoding='utf-8-sig') as fh:
    for row in csv.DictReader(fh, delimiter=';'):
        try:
            lat, lon = map(float, row['geo_point_2d'].split(','))
            h = float(row['height_m'] or 0) or 8.0
        except ValueError: continue
        x, y = ll(lat, lon)
        k = GENUS.get(row['genus_name'], 0)
        if k == 0 and random.random() < 0.15: k = random.choice([1, 2, 3])  # unknown genera turn too
        city_trees.append((x, y, k, h))
print('city trees', len(city_trees))
CITY_W = -123.2245  # Vancouver's western city limit (Blanca St); street-tree data covers the city only

q = lambda v: max(-32767, min(32767, int(round(v * 2))))  # half-metre int16
out = bytearray()
# tree colours, early autumn: shared with the page through meta.json (index = palette entry)
TPAL = {0: [0x3f8a2e, 0x4f9a36, 0x2f7a2c, 0x5aa040, 0x3a7030, 0x6aac44, 0x478e3a, 0x58962e],
        1: [0xc9a227, 0xd8b23a, 0xb8a434, 0xe0c048], 2: [0xd98f22, 0xe07a26, 0xc96a24, 0xe89a3a],
        3: [0xb8452a, 0xa8342c, 0xc0502e, 0x9a2f36], 4: [0x9a6a32, 0x8a7034, 0xa88a40],
        5: [0x2f5e3c, 0x2a5638, 0x376840, 0x244c30, 0x41744c, 0x30603e],
        6: [0x3a6a30, 0x447436, 0x2f5e2c, 0x4e7c3a, 0x38642e]}  # broadleaf in the woods
PAL_LIST = [c for k in sorted(TPAL) for c in TPAL[k]]
PAL_AT = {k: sum(len(TPAL[j]) for j in sorted(TPAL) if j < k) for k in TPAL}


def tree_colour(k, wood=False):  # about a quarter of the deciduous trees have turned
    if k not in (0, 5) and random.random() < 0.7: k = 0
    if k == 0 and wood: k = 6
    if k == 3 and random.random() < 0.6: k = 2  # maples mostly orange, some red
    return PAL_AT[k] + random.randrange(len(TPAL[k]))


meta = {'regions': [], 'origin': [LAT_O, LON_O], 'k': [KX, KY], 'treePal': PAL_LIST}
all_buildings, all_trees, all_boats, all_bridges, all_roads = [], [], [], [], []

for R in REGIONS:
    S, W, N, E = R['bbox']
    X0, Y0 = ll(S, W); X1, Y1 = ll(N, E)
    WM, HM = X1 - X0, Y1 - Y0
    TW, TH = int(WM / RES), int(HM / RES)
    px = lambda pt, ss=SS: ((pt[0] - X0) / RES * ss, (Y1 - pt[1]) / RES * ss)
    cell = lambda x, y: (min(TH - 1, max(0, int((Y1 - y) / RES))), min(TW - 1, max(0, int((x - X0) / RES))))
    inbox = lambda p, m=0: X0 + m < p[0] < X1 - m and Y0 + m < p[1] < Y1 - m
    els = json.load(open(R['osm']))['elements']
    print('==', R['name'], len(els), 'elements', TW, 'x', TH)

    areas, waters, coast, roads, bridges, rails, piers, marinas, blds, parts, drive = [], [], [], [], [], [], [], [], [], [], []
    special = {}
    for e in els:
        t = e.get('tags', {})
        if 'building:part' in t:
            parts.append(e); continue
        if 'building' in t:
            blds.append(e); continue
        if t.get('natural') == 'coastline':
            coast.append(line(e)); continue
        if t.get('natural') == 'water' or ('water' in t and t.get('natural') != 'coastline'):
            waters.append(e); continue
        if t.get('leisure') == 'marina':
            marinas.append(e)
        if t.get('man_made') in ('pier', 'breakwater'):
            piers.append(e); continue
        if 'railway' in t and e['type'] == 'way' and t['railway'] in ('rail', 'light_rail') and t.get('tunnel') != 'yes':
            rails.append(line(e)); continue
        hw = t.get('highway')
        if hw and e['type'] == 'way':
            if t.get('tunnel') in ('yes', 'building_passage') or t.get('area') == 'yes': continue
            if hw in DRIVE and t.get('access') not in ('private', 'no') and 'nodes' in e: drive.append(e)
            if hw not in ROAD: continue
            if t.get('bridge') == 'yes' and hw in ('trunk', 'primary', 'secondary', 'trunk_link', 'tertiary', 'cycleway', 'footway'):
                bridges.append((line(e), ROAD[hw], t.get('name', '')))
            else:
                roads.append((line(e), ROAD[hw]))
            continue
        for k in ('natural', 'landuse', 'leisure'):
            if t.get(k) in AREA and AREA[t[k]][1]:
                areas.append((AREA[t[k]][0], AREA[t[k]][1], e, t[k])); break

    # ---------- texture ----------
    W2, H2 = TW * SS, TH * SS
    img = Image.new('RGB', (W2, H2), (146, 150, 126))
    dr = ImageDraw.Draw(img)

    def fill_shape(draw, sh, col):
        for outers, inners in sh:
            for r in outers: draw.polygon([px(p) for p in r], fill=col)
            for r in inners: draw.polygon([px(p) for p in r], fill=(146, 150, 126))

    woodmask = Image.new('L', (TW, TH), 0); wd = ImageDraw.Draw(woodmask)
    parkmask = Image.new('L', (TW, TH), 0); pd = ImageDraw.Draw(parkmask)
    resmask = Image.new('L', (TW, TH), 0); rd = ImageDraw.Draw(resmask)
    for order, col, e, kind_ in sorted(areas, key=lambda a: a[0]):
        sh = shapes(e)
        jit = tuple(max(0, min(255, c + random.randint(-6, 6))) for c in col)
        for outers, inners in sh:
            if inners:
                xs = [px(p) for r in outers for p in r]
                x0, y0 = int(max(0, min(p[0] for p in xs))), int(max(0, min(p[1] for p in xs)))
                x1, y1 = int(min(W2, max(p[0] for p in xs)) + 1), int(min(H2, max(p[1] for p in xs)) + 1)
                if x1 <= x0 or y1 <= y0: continue
                m = Image.new('L', (x1 - x0, y1 - y0), 0); md = ImageDraw.Draw(m)
                for r in outers: md.polygon([(a - x0, b - y0) for a, b in map(px, r)], fill=255)
                for r in inners: md.polygon([(a - x0, b - y0) for a, b in map(px, r)], fill=0)
                img.paste(jit, (x0, y0, x1, y1), m)
            else:
                for r in outers: dr.polygon([px(p) for p in r], fill=jit)
            tgt = wd if kind_ in ('wood', 'forest') else pd if kind_ in ('park', 'grass', 'garden', 'recreation_ground', 'cemetery', 'meadow', 'golf_course', 'grassland', 'scrub') else rd if kind_ == 'residential' else None
            if tgt:
                for r in outers: tgt.polygon([px(p, 1) for p in r], fill=255)
                for r in inners: tgt.polygon([px(p, 1) for p in r], fill=0)

    # sea: coastline lines are walls, flooded from a seed in open water
    wall = Image.new('L', (TW, TH), 0); wdw = ImageDraw.Draw(wall)
    for l in coast: wdw.line([px(p, 1) for p in l], fill=255, width=2)
    lab, _ = ndimage.label(np.array(wall) == 0)
    sx, sy = px(ll(*R['sea']), 1)
    sea = lab == lab[int(sy), int(sx)]
    sea |= ndimage.binary_dilation(sea) & (np.array(wall) > 0)
    water = sea.copy()
    lakes = Image.new('L', (TW, TH), 0); ld = ImageDraw.Draw(lakes)
    for e in waters:
        for outers, inners in shapes(e):
            for r in outers: ld.polygon([px(p, 1) for p in r], fill=255)
            for r in inners: ld.polygon([px(p, 1) for p in r], fill=0)
    water |= np.array(lakes) > 0
    print('sea fraction', sea.mean())
    # land not connected to the region's own (the North Shore) is cut away into the dark
    land_lab, nl = ndimage.label(~water)
    hx_, hy_ = px(ll(*R['home']), 1)
    sizes = ndimage.sum(np.ones_like(land_lab), land_lab, range(nl + 1))
    void = (land_lab != land_lab[int(hy_), int(hx_)]) & (sizes[land_lab] * RES * RES > 300000) & (land_lab > 0)
    in_void = lambda x, y: void[cell(x, y)]

    dist = ndimage.distance_transform_edt(water) * RES
    t = np.clip(dist / 45, 0, 1)[..., None]
    shallow, deep = np.array([40, 98, 150]), np.array([22, 58, 108])
    wc = shallow * (1 - t) ** 1.6 + deep * (1 - (1 - t) ** 1.6)
    wc = np.where((dist < 3)[..., None], np.array([70, 128, 168]), wc)
    noise = ndimage.gaussian_filter(np.random.rand(TH, TW), 6)
    wc = wc * (0.92 + 0.16 * (noise - noise.min()) / (np.ptp(noise) + 1e-9))[..., None]
    wimg = Image.fromarray(wc.astype(np.uint8)).resize((W2, H2), Image.BILINEAR)
    wmask = Image.fromarray((water * 255).astype(np.uint8)).resize((W2, H2), Image.NEAREST).filter(ImageFilter.GaussianBlur(1))
    img.paste(wimg, (0, 0), wmask)

    for e in piers:
        sh = shapes(e)
        if sh: fill_shape(dr, sh, (184, 164, 128))
        else: dr.line([px(p) for p in line(e)], fill=(184, 164, 128), width=int(3 / RES * SS))
    for l in rails: dr.line([px(p) for p in l], fill=(118, 108, 98), width=int(3 / RES * SS))
    for casing in (True, False):
        for l, w in sorted(roads, key=lambda r: r[1]):
            pts = [px(p) for p in l]
            if w < 2:
                if not casing: dr.line(pts, fill=(214, 206, 186), width=max(1, int(w / RES * SS)))
                continue
            ww = int((w + (1.6 if casing else 0)) / RES * SS)
            col = (188, 184, 172) if casing else (120, 124, 128) if w >= 6 else (132, 134, 136)  # sidewalk, asphalt
            dr.line(pts, fill=col, width=ww, joint='curve')
    # centre lines on the big roads
    for l, w in roads:
        if w >= 6: dr.line([px(p) for p in l], fill=(214, 196, 120), width=1)

    grain = (ndimage.gaussian_filter(np.random.rand(H2 // 4, W2 // 4), 1.2) - 0.5) * 22
    grain = np.array(Image.fromarray(((grain + 128)).clip(0, 255).astype(np.uint8)).resize((W2, H2), Image.BILINEAR), dtype=np.int16) - 128
    arr = np.clip(np.array(img, dtype=np.int16) + grain[..., None], 0, 255).astype(np.uint8)
    ground = Image.fromarray(arr).resize((TW, TH), Image.LANCZOS)
    vm = Image.fromarray((void * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.5))
    ground.paste((14, 22, 32), (0, 0), vm)

    # ---------- terrain grid ----------
    nx, ny = int(WM / HSTEP) + 2, int(HM / HSTEP) + 2
    dem, GE, GN = terrain(X0, Y0, nx, ny)
    wgrid = np.array([[water[cell(GE[j, i], GN[j, i])] for i in range(nx)] for j in range(ny)])
    dem = np.where(ndimage.binary_erosion(wgrid, iterations=1), 0, dem)  # the sea is flat
    Z = zfit(dem, GE, GN)

    def zat(x, y):  # bilinear on the grid, as the page does
        fx = min(nx - 1.001, max(0, (x - X0) / HSTEP)); fy = min(ny - 1.001, max(0, (y - Y0) / HSTEP))
        i, j = int(fx), int(fy); u, v = fx - i, fy - j
        return (Z[j, i] * (1 - u) * (1 - v) + Z[j, i + 1] * u * (1 - v) + Z[j + 1, i] * (1 - u) * v + Z[j + 1, i + 1] * u * v)
    sea_z = float(zfit(0, (X0 + X1) / 2, (Y0 + Y1) / 2))

    # ---------- buildings ----------
    DOWNTOWN = [(49.2955, -123.1440), (49.2830, -123.1095), (49.2745, -123.1000), (49.2700, -123.1045), (49.2755, -123.1290),
                (49.2860, -123.1440), (49.2905, -123.1500)]
    DT = [ll(a, b) for a, b in DOWNTOWN]

    def height(t, a, c, lid):
        h = hnum(t.get('height'))
        if h: return h, hnum(t.get('min_height')) or 0, None
        lv = hnum(t.get('building:levels'))
        mn = (hnum(t.get('building:min_level')) or 0) * 3.1
        if lid and 'building:part' not in t:
            ridge = lid['maxht_m']; flat = (lid.get('rooftype') or '').lower() != 'pitched'
            if lv and lv * 3.1 > ridge * 1.6: return lv * 3.1 + 1.5, mn, None  # rebuilt taller since 2009
            if flat: return max(2.5, lid.get('hgt_agl') or ridge), 0, None
            eave = min(ridge - 1.2, max(2.6, 2 * (lid.get('avght_m') or ridge) - ridge))
            return eave, 0, ridge
        if lv: return lv * 3.1 + (1.5 if lv > 3 else 0.8), mn, None
        b = t.get('building', t.get('building:part', 'yes'))
        if b in ('house', 'detached', 'semidetached_house', 'residential') and a < 400:
            e = random.uniform(4.5, 6.5); return e, 0, e + random.uniform(2.2, 3.6)
        if b in ('garage', 'garages', 'shed', 'roof', 'carport', 'hut', 'kiosk'): return 3.0, 0, None
        if inside(c, DT):
            if a > 500: return random.choice([random.uniform(25, 60), random.uniform(60, 120), random.uniform(15, 30)]), 0, None
            return random.uniform(10, 24), 0, None
        if a > 2500: return random.uniform(8, 16), 0, None
        if a > 600: return random.uniform(9, 14), 0, None
        e = random.uniform(4.5, 6.5); return e, 0, e + random.uniform(2, 3.2)

    part_cells = {}
    for e in parts:
        for outers, _ in shapes(e):
            c = cent(outers[0]); part_cells.setdefault((int(c[0] // 50), int(c[1] // 50)), []).append(c)

    def has_parts(r):
        xs = [p[0] for p in r]; ys = [p[1] for p in r]
        for gx in range(int(min(xs) // 50), int(max(xs) // 50) + 1):
            for gy in range(int(min(ys) // 50), int(max(ys) // 50) + 1):
                if any(inside(c, r) for c in part_cells.get((gx, gy), [])): return True
        return False

    def kind(t, h, c):  # palette class: 0 house, 1 apartment, 2 glass tower, 3 brick, 4 concrete/commercial, 5 white
        b = t.get('building', t.get('building:part', 'yes'))
        mat = t.get('building:material', '') + t.get('building:colour', '')
        if 'glass' in mat or (h > 40 and random.random() < 0.4): return 2
        if 'brick' in mat or (inside(c, DT) and h < 30 and random.random() < 0.25): return 3
        if b in ('house', 'detached', 'semidetached_house', 'garage', 'shed') or (h < 10 and not inside(c, DT)): return 0
        if b in ('apartments', 'residential') or h >= 12: r = random.random(); return 1 if r < 0.6 else 5 if r < 0.85 else 4
        return 4

    footprint = Image.new('L', (TW, TH), 0); fd = ImageDraw.Draw(footprint)
    landmarks = []
    for e in blds:
        name = e.get('tags', {}).get('name', '')
        for outers, _ in shapes(e):
            r = outers[0]; c = cent(r)
            if 'BC Place' in name: special['bcplace'] = [round(c[0]), round(c[1]), round(math.sqrt(area(r) / math.pi))]; landmarks.append(r)
            if name == 'Science World': special['scienceworld'] = [round(c[0]), round(c[1])]; landmarks.append(r)
    nb0 = len(all_buildings)
    seen = set()
    for e in blds + parts:
        t = e.get('tags', {})
        for outers, _ in shapes(e):
            r = outers[0]
            if r[0] == r[-1]: r = r[:-1]
            if len(r) < 3 or len(r) > 250: continue
            c = cent(r)
            if not inbox(c) or in_void(*c): continue
            a = area(r)
            fd.polygon([px(p, 1) for p in r], fill=255)
            if any(inside(c, lm) for lm in landmarks): continue
            if 'building' in t and has_parts(r): continue  # its parts carry the shape; both would z-fight
            key_ = (round(c[0] * 2), round(c[1] * 2), round(a / 4))
            if key_ in seen: continue  # the same footprint mapped twice
            seen.add(key_)
            h, mn, ridge = height(t, a, c, lidar_for(r) if 'building:part' not in t else None)
            base = min(zat(x, y) for x, y in r)
            roof = None
            if ridge:
                cx, cy, ang, hl, hw, ar = obb(r)
                if a / ar > 0.8 and hw > 2 and ridge - h < hw * 1.4: roof = (cx, cy, ang, hl, hw, ridge)
            h += random.random() * 0.15  # no two roofs exactly level: overlapping footprints never z-fight
            # each footprint pulled in by its own few centimetres: walls of overlapping or touching
            # buildings are never coplanar, so they cannot z-fight
            gid = random.randrange(1, 1 << 30)
            all_buildings.append((inset(r, random.uniform(0.03, 0.3)), base, h, mn, kind(t, h, c), roof, gid, h, t, r))
    # the same building mapped twice with different outlines (often two approximations of a round tower):
    # keep the bigger one when most of a footprint is already covered by a kept one of about the same height
    rows = sorted(all_buildings[nb0:], key=lambda b: -area(b[0]))
    top = np.zeros((int(HM) + 2, int(WM) + 2), np.float32)
    kept_b = []
    for b in rows:
        r, base, h, mn = b[0], b[1], b[2], b[3]
        xs = [p[0] - X0 for p in r]; ys = [Y1 - p[1] for p in r]
        x0_, y0_ = max(0, int(min(xs))), max(0, int(min(ys))); x1_, y1_ = min(top.shape[1], int(max(xs)) + 2), min(top.shape[0], int(max(ys)) + 2)
        if x1_ <= x0_ or y1_ <= y0_: continue
        m = Image.new('L', (x1_ - x0_, y1_ - y0_), 0)
        ImageDraw.Draw(m).polygon([(x - x0_, y - y0_) for x, y in zip(xs, ys)], fill=1)
        m = np.array(m, bool)
        if m.sum() >= 4:
            under = top[y0_:y1_, x0_:x1_][m]
            same = (under > 0) & (np.abs(under - h) < max(3.0, 0.3 * h))
            if same.mean() > 0.5 and mn == 0: continue
        cell_ = top[y0_:y1_, x0_:x1_]; cell_[m] = np.maximum(cell_[m], h)
        kept_b.append(b)
    print('buildings', len(kept_b), 'dropped as duplicates', len(rows) - len(kept_b))

    # LiDAR sections: where the city's 2009 survey has a building that is still there (a section mostly inside a
    # current OSM footprint), its sections replace the OSM block: podiums, towers, setbacks at their real heights.
    # OSM wins where it is clearly taller (rebuilt since 2009) or the survey covers too little of it.
    G = 2.0; gw, gh = int(WM / G) + 2, int(HM / G) + 2
    gx = lambda x: (x - X0) / G; gy = lambda y: (Y1 - y) / G
    ids = Image.new('I', (gw, gh), 0); idd = ImageDraw.Draw(ids)
    for n_, b in enumerate(kept_b): idd.polygon([(gx(x), gy(y)) for x, y in b[9]], fill=n_ + 1)
    ids = np.array(ids)
    seg_of = {}
    for r, hg, rt in segments:
        xs = [p[0] for p in r]; ys = [p[1] for p in r]
        if max(xs) < X0 or min(xs) > X1 or max(ys) < Y0 or min(ys) > Y1: continue
        x0_, y0_ = max(0, int(gx(min(xs)))), max(0, int(gy(max(ys)))); x1_, y1_ = min(gw, int(gx(max(xs))) + 2), min(gh, int(gy(min(ys))) + 2)
        if x1_ <= x0_ or y1_ <= y0_: continue
        m = Image.new('L', (x1_ - x0_, y1_ - y0_), 0)
        ImageDraw.Draw(m).polygon([(gx(x) - x0_, gy(y) - y0_) for x, y in r], fill=1)
        m = np.array(m, bool)
        if not m.any():
            cc = cent(r); i_, j_ = int(gy(cc[1])), int(gx(cc[0]))
            under = ids[i_:i_ + 1, j_:j_ + 1].ravel() if 0 <= i_ < gh and 0 <= j_ < gw else np.zeros(0, int)
        else: under = ids[y0_:y1_, x0_:x1_][m]
        if not len(under): continue
        vals, cnt = np.unique(under, return_counts=True)
        k_ = cnt.argmax()
        if vals[k_] == 0 or cnt[k_] < 0.5 * len(under): continue
        seg_of.setdefault(int(vals[k_]) - 1, []).append((r, hg, rt, m.sum() if m.any() else 1))
    out_rows, nseg, nrep = [], 0, 0
    for n_, b in enumerate(kept_b):
        segs = seg_of.get(n_)
        r_osm, base, h, mn, k, roof, gid, gh_, t, raw = b
        tagged_h = hnum(t.get('height')) or (hnum(t.get('building:levels')) or 0) * 3.1
        if segs and mn == 0:
            covered = sum(sg[3] for sg in segs) * G * G / max(1.0, area(raw))
            top_h = max(sg[1] for sg in segs)
            if covered > 0.6 and not (tagged_h and tagged_h > 1.4 * top_h + 3):
                nrep += 1
                kk = kind(t, top_h, cent(raw))
                for r, hg, rt, _ in segs:
                    rf = None; hh = hg
                    if rt == 'pitched' and hg < 16:
                        cx, cy, ang, hl, hw, ar = obb(r)
                        if area(r) / ar > 0.75 and hw > 2:
                            hh = max(2.6, hg - min(hw * 0.9, 3.5)); rf = (cx, cy, ang, hl, hw, hg)
                    hh += random.random() * 0.15
                    out_rows.append((inset(r, random.uniform(0.03, 0.3)), base, hh, 0, kk, rf, gid, top_h, t, r)); nseg += 1
                continue
        out_rows.append(b)
    print('lidar: replaced', nrep, 'OSM buildings with', nseg, 'sections')
    all_buildings[nb0:] = out_rows

    # ---------- trees ----------
    fp = ndimage.binary_dilation(np.array(footprint) > 0, iterations=1)
    # where no tree may stand: the carriageways as the tiles draw them (1.9x the nominal width, plus the kerb),
    # piers, and sports fields, tracks, playgrounds, car parks, beaches, pools, rail yards, building sites
    roadm = Image.new('L', (TW * 2, TH * 2), 0); rmd = ImageDraw.Draw(roadm)  # 1 m grid
    for l, w in roads:
        if w >= 2.4: rmd.line([px(p, 2) for p in l], fill=255, width=max(2, int(round(w * 1.9 + 1.2))), joint='curve')
    for e in piers: rmd.line([px(p, 2) for p in line(e)], fill=255, width=4)
    for order, col, e, kind_ in areas:
        if kind_ in ('pitch', 'track', 'stadium', 'playground', 'beach', 'sand', 'swimming_pool', 'construction', 'railway'):
            for outers, _ in shapes(e):
                for r in outers: rmd.polygon([px(p, 2) for p in r], fill=255)
    for e in json.load(open(R['parking']))['elements']:
        for outers, _ in shapes(e):
            for r in outers: rmd.polygon([px(p, 2) for p in r], fill=255)
    road1 = np.array(roadm) > 0
    roadm = road1.reshape(TH, 2, TW, 2).max(axis=(1, 3)) if road1.shape == (TH * 2, TW * 2) else road1[::2, ::2]
    fp1 = np.array(footprint.resize((TW * 2, TH * 2), Image.NEAREST)) > 0
    blocked1 = road1 | ndimage.binary_dilation(fp1, iterations=1) | np.array(Image.fromarray(water).resize((TW * 2, TH * 2), Image.NEAREST))
    d_free, (fi, fj) = ndimage.distance_transform_edt(blocked1, return_indices=True)  # nearest free metre for every metre
    open_ = ~(water | fp | roadm)
    d_road = ndimage.distance_transform_edt(~roadm) * RES
    wood, park, res = np.array(woodmask) > 0, np.array(parkmask) > 0, np.array(resmask) > 0
    has_city = lambda x: x > ll(49.26, CITY_W)[0]
    xs_ = X0 + (np.arange(TW) + 0.5) * RES
    city_cols = np.array([has_city(x) for x in xs_])[None, :]
    prob = np.zeros((TH, TW), np.float32)
    prob[res] = 0.42  # back yards (street trees come from the city's inventory where it has one)
    prob[res & ~city_cols & (d_road > 1.5) & (d_road < 6)] = 0.9
    prob[~res & ~park & ~wood & ~city_cols & (d_road > 1.5) & (d_road < 5)] = 0.25
    prob[park] = 0.18
    prob[park & (d_road < 7)] = 0.4
    prob[wood] = 1.0
    prob[~open_ | void] = 0
    nt0 = len(all_trees)
    CELL = 7.0
    for gy in np.arange(Y0, Y1, CELL):
        for gx in np.arange(X0, X1, CELL):
            x, y = gx + random.random() * CELL, gy + random.random() * CELL
            i, j = cell(x, y)
            p = prob[i, j]
            if p and random.random() < p:
                w_ = wood[i, j]
                k = 5 if w_ and random.random() < 0.7 else random.choice([0, 0, 0, 0, 0, 1, 2, 3]) if not w_ else random.choice([0, 0, 0, 1])
                hh = random.uniform(16, 38) if k == 5 else random.uniform(7, 16) + (4 if w_ else 0)
                all_trees.append((x, y, zat(x, y), k, tree_colour(k, w_), hh))
    moved = dropped = 0
    for x, y, k, h in city_trees:  # street trees: onto the boulevard if the drawing put them on the road
        if not inbox((x, y)) or in_void(x, y): continue
        i, j = min(TH * 2 - 1, max(0, int((Y1 - y)))), min(TW * 2 - 1, max(0, int((x - X0))))
        if blocked1[i, j]:
            if d_free[i, j] > 4.5: dropped += 1; continue
            i2, j2 = fi[i, j], fj[i, j]
            x, y = X0 + j2 + 0.5, Y1 - i2 - 0.5; moved += 1
        all_trees.append((x, y, zat(x, y), k, tree_colour(k), h))
    print('street trees moved off roads', moved, 'dropped', dropped)
    print('trees', len(all_trees) - nt0)
    # under the 3D trees (zoomed in): their shadows, cast away from the afternoon sun in the south-west
    plain = ground.copy(); sd = Image.new('L', (TW, TH), 0); sdd = ImageDraw.Draw(sd)
    for x, y, z, k, ci, h in all_trees[nt0:]:
        r = (h * 0.17 if k == 5 else min(7, max(2, h * 0.28))) / RES
        ox, oy = (x - X0) / RES + h * 0.42 / RES, (Y1 - y) / RES - h * 0.38 / RES
        sdd.ellipse((ox - r, oy - r * 0.8, ox + r, oy + r * 0.8), fill=255)
    sd = sd.filter(ImageFilter.GaussianBlur(0.8))
    plain = Image.composite(Image.eval(plain, lambda v: int(v * 0.62)), plain, sd)
    plain.save(f"public/ground-{R['name']}-plain.jpg", quality=86)
    # crowns painted into the ground: what the trees look like zoomed out, where the page skips them
    gd = ImageDraw.Draw(ground)
    for x, y, z, k, ci, h in all_trees[nt0:]:
        r = max(0.8, (h * 0.24 if k == 5 else min(11, max(3.6, h * 0.48))) / RES)
        c = PAL_LIST[ci]; col = tuple(int(((c >> s_) & 255) * 0.82) for s_ in (16, 8, 0))
        cx_, cy_ = (x - X0) / RES, (Y1 - y) / RES
        gd.ellipse((cx_ - r, cy_ - r, cx_ + r, cy_ + r), fill=col)
    ground.save(f"public/ground-{R['name']}.jpg", quality=86)

    # ---------- boats in marinas ----------
    mm = Image.new('L', (TW, TH), 0); mmd = ImageDraw.Draw(mm)
    for e in marinas:
        for outers, _ in shapes(e):
            for r in outers: mmd.polygon([px(p, 1) for p in r], fill=255)
    pierm = Image.new('L', (TW, TH), 0); pmd = ImageDraw.Draw(pierm)
    for e in piers:
        sh = shapes(e)
        if sh:
            for r in sh[0][0]: pmd.polygon([px(p, 1) for p in r], fill=255)
        else: pmd.line([px(p, 1) for p in line(e)], fill=255, width=2)
    d_pier = ndimage.distance_transform_edt(np.array(pierm) == 0) * RES
    gy_, gx_ = np.gradient(d_pier)
    mmask = np.array(mm) > 0
    kept, grid = [], {}

    def moor(x, y, a, L):
        if not inbox((x, y)): return
        i, j = cell(x, y)
        if not (water[i, j] and mmask[i, j] and d_pier[i, j] > 1.5): return
        k = (int(x // 2), int(y // 2))
        if any(grid.get((k[0] + a_, k[1] + c_)) for a_ in (-1, 0, 1) for c_ in (-1, 0, 1)): return
        grid[k] = 1; kept.append((x, y, sea_z, a, L))
    # side by side along every pier edge in a marina, sterns to the pier
    for e in piers:
        for l in [r for o, _ in shapes(e) for r in o] or [line(e)]:
            for (x1, y1), (x2, y2) in zip(l, l[1:]):
                L = math.dist((x1, y1), (x2, y2))
                if L < 4: continue
                ux, uy = (x2 - x1) / L, (y2 - y1) / L
                for side in (1, -1):
                    nx_, ny_ = -uy * side, ux * side
                    s_ = 2.5
                    while s_ < L - 2:
                        bl = random.uniform(7, 13)
                        if random.random() < 0.75: moor(x1 + ux * s_ + nx_ * (1.6 + bl / 2), y1 + uy * s_ + ny_ * (1.6 + bl / 2), math.atan2(ny_, nx_), bl)
                        s_ += random.uniform(4.3, 5.3)
    for i, j in zip(*np.nonzero(water & mmask & (d_pier > 12))):  # a few at anchor
        if random.random() < 0.004: moor(X0 + (j + 0.5) * RES, Y1 - (i + 0.5) * RES, random.uniform(-3.14, 3.14), random.uniform(8, 14))
    all_boats += kept

    # ---------- bridges: deck height = distance to the nearest abutment x ramp slope, over the terrain ----------
    key = lambda p: (round(p[0], 1), round(p[1], 1))
    ground_v = {key(p) for l, _ in roads for p in l}
    adj = {}
    for l, _, _ in bridges:
        for a, b in zip(l, l[1:]):
            d = math.dist(a, b)
            adj.setdefault(key(a), []).append((key(b), d)); adj.setdefault(key(b), []).append((key(a), d))
    dist_ab = {v: 0.0 for v in adj if v in ground_v}
    pq = [(0.0, v) for v in dist_ab]
    while pq:
        d, v = heapq.heappop(pq)
        if d > dist_ab.get(v, 1e18): continue
        for u, w in adj[v]:
            if d + w < dist_ab.get(u, 1e18): dist_ab[u] = d + w; heapq.heappush(pq, (d + w, u))
    deck_z = {}
    for l, w, _ in bridges:
        if len(l) < 2 or not all(inbox(p, 5) for p in l) or any(in_void(*p) for p in l): continue
        za, zb = zat(*l[0]), zat(*l[-1]); tot = sum(math.dist(a, b) for a, b in zip(l, l[1:])) or 1; s = 0
        pts = []
        for i, p in enumerate(l):
            if i: s += math.dist(l[i - 1], p)
            z = za + (zb - za) * s / tot + min(26.0, dist_ab.get(key(p), 40) * 0.06)
            pts.append((p[0], p[1], z)); deck_z[key(p)] = z
        all_bridges.append((pts, w))

    # ---------- road graph for traffic ----------
    nr0 = len(all_roads)
    nodes, use = {}, {}
    for e in drive:
        for n_, p in zip(e['nodes'], e['geometry']):
            if p: nodes[n_] = xy(p); use[n_] = use.get(n_, 0) + 1
        for n_ in (e['nodes'][0], e['nodes'][-1]): use[n_] = use.get(n_, 0) + 1
    for e in drive:
        t = e['tags']; cls = DRIVE[t['highway']]
        ow = t.get('oneway') in ('yes', '1', '-1') or t.get('junction') == 'roundabout' or t['highway'] in ('motorway', 'motorway_link')
        ids = [n_ for n_ in e['nodes'] if n_ in nodes]
        if t.get('oneway') == '-1': ids = ids[::-1]
        lanes = int(hnum(t.get('lanes')) or (2 if cls <= 1 else 1) * (1 if ow else 2))
        per = max(1, min(4, lanes if ow else lanes // 2))
        cut = [0] + [i for i in range(1, len(ids) - 1) if use[ids[i]] >= 2] + [len(ids) - 1]
        for a, b in zip(cut, cut[1:]):
            seg = ids[a:b + 1]
            pts = [nodes[n_] for n_ in seg]
            if len(pts) < 2 or not all(inbox(p, 2) for p in pts) or any(in_void(*p) for p in pts): continue
            zs = [deck_z.get(key(p), zat(*p)) if t.get('bridge') == 'yes' else zat(*p) for p in pts]
            all_roads.append((seg[0], seg[-1], cls, ow, per, [(p[0], p[1], z) for p, z in zip(pts, zs)]))

    # ---------- detailed ground tiles: 0.5 m/px, 512 m square on a world grid; the page loads only
    # the ones on screen, zoomed in. Sidewalks, asphalt, centre lines, crosswalks, tree shadows. ----------
    os.makedirs(f"public/tiles/{R['name']}", exist_ok=True)
    bbox_of = lambda pts: (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))
    area_items = [(bbox_of([p for r in o for p in r]), col, o, i) for _, col, e, _k in sorted(areas, key=lambda a: a[0]) for o, i in shapes(e) if o]
    road_items = [(bbox_of(l), l, w) for l, w in roads if len(l) > 1]
    pier_items = [(bbox_of(r), r) for e in piers for o, _ in shapes(e) for r in o] + [(bbox_of(line(e)), None, line(e)) for e in piers if not shapes(e) and len(line(e)) > 1]
    rail_items = [(bbox_of(l), l) for l in rails if len(l) > 1]
    deg, best = {}, {}
    for a, b, cls, ow, per, pts in all_roads[nr0:]:
        for n_ in (a, b): deg[n_] = deg.get(n_, 0) + 1; best[n_] = min(best.get(n_, 9), cls)
    half = {}
    for a, b, cls, ow, per, pts in all_roads[nr0:]:
        for n_ in (a, b): half[n_] = max(half.get(n_, 0), CW[cls] / 2 + 1.5)
    zebra = []  # crosswalk bars as polygons
    for a, b, cls, ow, per, pts in all_roads[nr0:]:
        for n_, p0, p1 in ((a, pts[0], pts[1]), (b, pts[-1], pts[-2])):
            if deg[n_] < 3 or best[n_] > 3: continue
            dx, dy = p1[0] - p0[0], p1[1] - p0[1]; L = math.hypot(dx, dy)
            if L < half[n_] + 5: continue
            dx, dy = dx / L, dy / L; nx_, ny_ = -dy, dx
            W = CW[cls]; cx, cy = p0[0] + dx * (half[n_] + 2.2), p0[1] + dy * (half[n_] + 2.2)
            o = -W / 2 + 0.45
            while o < W / 2 - 0.2:
                bx, by = cx + nx_ * o, cy + ny_ * o
                zebra.append([(bx + dx * s1 + nx_ * s2, by + dy * s1 + ny_ * s2) for s1, s2 in ((-1.3, -0.28), (1.3, -0.28), (1.3, 0.28), (-1.3, 0.28))])
                o += 1.1
    zebra_items = [(bbox_of(z), z) for z in zebra]
    pitch_items = []  # sports fields with their markings
    for order, col, e, kind_ in areas:
        if kind_ != 'pitch': continue
        sport = e.get('tags', {}).get('sport', '')
        for o, _ in shapes(e):
            r = o[0]
            if len(r) < 4 or area(r) < 150: continue
            pitch_items.append((bbox_of(r), r, obb(r), sport))
    # parked cars: along the kerbs of residential and collector streets, and in rows on surface lots
    CARC = [(243, 242, 236), (196, 200, 205), (43, 47, 53), (194, 58, 47), (47, 94, 166), (91, 96, 104), (34, 52, 90),
            (63, 122, 75), (214, 204, 180), (139, 37, 51), (236, 235, 229), (154, 161, 170), (240, 194, 50)]
    parked = []  # (x, y, angle)
    for l, w in roads:
        if w not in (4, 5, 6) or len(l) < 2: continue
        half = w * 1.9 / 2 - 1.15
        for (x1, y1), (x2, y2) in zip(l, l[1:]):
            L = math.dist((x1, y1), (x2, y2))
            if L < 14: continue
            ux, uy = (x2 - x1) / L, (y2 - y1) / L
            for side in (1, -1):
                s_ = 8 + random.random() * 3
                while s_ < L - 8:
                    if random.random() < 0.55: parked.append((x1 + ux * s_ - uy * half * side, y1 + uy * s_ + ux * half * side, math.atan2(uy, ux)))
                    s_ += random.uniform(5.8, 6.8)
    for e in json.load(open(R['parking']))['elements']:
        for outers, _ in shapes(e):
            r = outers[0]
            if len(r) < 4 or area(r) < 150: continue
            cx_, cy_, ang, hl, hw, ar = obb(r)
            ca, sa = math.cos(ang), math.sin(ang)
            v = -hw + 3
            while v < hw - 2.4:  # two rows nose to nose, then an aisle
                for dv in (0, 5.2):
                    if v + dv > hw - 2.4: break
                    u = -hl + 1.5
                    while u < hl - 1.2:
                        x, y = cx_ + u * ca - (v + dv) * sa, cy_ + u * sa + (v + dv) * ca
                        if inside((x, y), r) and random.random() < 0.72: parked.append((x, y, ang + math.pi / 2))
                        u += 2.6
                v += 16.4
    park_cells = {}
    for x, y, a in parked:
        if inbox((x, y)): park_cells.setdefault((int(x // TILE), int(y // TILE)), []).append((x, y, a, random.choice(CARC)))
    lots = [(bbox_of(r), r) for e in json.load(open(R['parking']))['elements'] for o, _ in shapes(e) for r in o[:1]]
    print('parked cars', len(parked), 'lots', len(lots))
    tree_cells = {}
    for x, y, z, k, ci, h in all_trees[nt0:]:
        tree_cells.setdefault((int((x + 0.42 * h) // TILE), int((y + 0.38 * h) // TILE)), []).append((x + 0.42 * h, y + 0.38 * h, (h * 0.24 if k == 5 else min(11, max(3.6, h * 0.48)))))
    S2 = int(TILE / TRES) * 2  # drawn at twice the size, then halved
    kpx, n_ = S2 / TILE, int(TILE / RES)
    RIPPLE = Image.new('L', (S2, S2), 0); rd_ = ImageDraw.Draw(RIPPLE)  # 4 m lattice: seamless across tiles
    for gy in range(0, TILE, 4):
        for gx in range(0, TILE, 4):
            cx_, cy_ = (gx + (2 if (gy // 4) % 2 else 0)) * kpx, gy * kpx
            rr = 0.55 * kpx
            rd_.polygon([(cx_ - rr * 1.6, cy_), (cx_, cy_ - rr), (cx_ + rr * 1.6, cy_), (cx_, cy_ + rr)], fill=int(60 + 50 * random.random()))
    wc8 = wc.astype(np.uint8)
    tiles = []
    for ti in range(int(X0 // TILE), int(X1 // TILE) + 1):
        for tj in range(int(Y0 // TILE), int(Y1 // TILE) + 1):
            tx0, ty0 = ti * TILE, tj * TILE
            c0, r0 = int(round((tx0 - X0) / RES)), int(round((Y1 - ty0 - TILE) / RES))
            def crop(a, fill):
                o_ = np.full((n_, n_) + a.shape[2:], fill, a.dtype)
                rs, cs, re, ce = max(0, r0), max(0, c0), min(TH, r0 + n_), min(TW, c0 + n_)
                if re > rs and ce > cs: o_[rs - r0:re - r0, cs - c0:ce - c0] = a[rs:re, cs:ce]
                return o_
            wcrop, vcrop = crop(water, False), crop(void, True)
            if (wcrop | vcrop).mean() > 0.995: continue
            P = lambda p: ((p[0] - tx0) * kpx, (ty0 + TILE - p[1]) * kpx)
            inb = lambda b: b[2] >= tx0 - 10 and b[0] <= tx0 + TILE + 10 and b[3] >= ty0 - 10 and b[1] <= ty0 + TILE + 10
            img = Image.new('RGB', (S2, S2), (146, 150, 126)); d = ImageDraw.Draw(img)
            for b, col, outers, inners in area_items:
                if inb(b):
                    for r in outers: d.polygon([P(p) for p in r], fill=col)
                    for r in inners: d.polygon([P(p) for p in r], fill=(146, 150, 126))
            wm = Image.fromarray((wcrop * 255).astype(np.uint8)).resize((S2, S2), Image.BILINEAR).filter(ImageFilter.GaussianBlur(3))
            img.paste(Image.fromarray(crop(wc8, 0)).resize((S2, S2), Image.BILINEAR), (0, 0), wm)
            if wcrop.any():  # the drawing's ripples: a lattice of small light diamonds on open water, fading near the shore
                shore = Image.fromarray((crop(dist > 8, False) * 255).astype(np.uint8)).resize((S2, S2), Image.BILINEAR).filter(ImageFilter.GaussianBlur(6))
                img.paste(Image.new('RGB', (S2, S2), (78, 138, 186)), (0, 0), Image.fromarray((np.array(RIPPLE) * (np.array(shore) / 255.0)).astype(np.uint8)))
            for it in pier_items:
                if inb(it[0]):
                    if len(it) == 2: d.polygon([P(p) for p in it[1]], fill=(184, 164, 128))
                    else: d.line([P(p) for p in it[2]], fill=(184, 164, 128), width=int(3 * kpx))
            for b, l in rail_items:
                if inb(b): d.line([P(p) for p in l], fill=(112, 102, 92), width=int(3 * kpx))
            # real street widths: carriageway, then (outside downtown) a grass boulevard, then the sidewalk
            for b, r in lots:
                if inb(b): d.polygon([P(p) for p in r], fill=(122, 125, 129))
            vis = [(l, w * 1.9 if w >= 2.4 else w, w == 4 and not inside(l[len(l) // 2], DT)) for b, l, w in road_items if inb(b)]
            for layer in (0, 1, 2):
                for l, w, blvd in sorted(vis, key=lambda r: r[1]):
                    pts = [P(p) for p in l]
                    if w < 2:
                        if layer == 2: d.line(pts, fill=(212, 204, 186), width=max(2, int(w * kpx)), joint='curve')
                        continue
                    extra = (7.6 if blvd and w < 12 else 4.0) if layer == 0 else (4.0 if blvd and w < 12 else 0.6) if layer == 1 else 0
                    col = (196, 192, 182) if layer == 0 else (110, 160, 74) if blvd and w < 12 and layer == 1 else (150, 150, 146) if layer == 1 else (108, 112, 118) if w >= 11 else (120, 123, 127)
                    d.line(pts, fill=col, width=int((w + extra) * kpx), joint='curve')
            for l, w, _ in vis:
                if w >= 11: d.line([P(p) for p in l], fill=(222, 196, 92), width=max(2, int(0.35 * kpx)))
                if w >= 11:  # dashed lane lines between the lanes of each direction
                    for side in (1, -1):
                        off = w / 4 * side
                        for (x1, y1), (x2, y2) in zip(l, l[1:]):
                            L = math.dist((x1, y1), (x2, y2))
                            if L < 1: continue
                            ux, uy = (x2 - x1) / L, (y2 - y1) / L
                            s_ = 1.0
                            while s_ < L - 3:
                                a_ = (x1 + ux * s_ - uy * off, y1 + uy * s_ + ux * off)
                                b_ = (a_[0] + ux * 3, a_[1] + uy * 3)
                                d.line([P(a_), P(b_)], fill=(226, 226, 220), width=max(2, int(0.3 * kpx)))
                                s_ += 9
            for (x, y, a, col) in [t for a_ in (-1, 0, 1) for b_ in (-1, 0, 1) for t in park_cells.get((ti + a_, tj + b_), [])]:
                ca, sa = math.cos(a), math.sin(a)
                rect = lambda hl, hw, dx=0, dy=0: [P((x + dx + u * ca - v * sa, y + dy + u * sa + v * ca)) for u, v in ((-hl, -hw), (hl, -hw), (hl, hw), (-hl, hw))]
                d.polygon(rect(2.3, 1.0, 0.35, -0.35), fill=(70, 72, 76))  # shadow
                d.polygon(rect(2.2, 0.9), fill=col)
                d.polygon(rect(1.15, 0.78, ca * 0.15, sa * 0.15), fill=(40, 52, 64))  # glass
                d.polygon(rect(0.75, 0.72, -ca * 0.05, -sa * 0.05), fill=tuple(min(255, int(v * 1.08)) for v in col))  # roof
            for b, z in zebra_items:
                if inb(b): d.polygon([P(p) for p in z], fill=(232, 232, 226))
            for b, r, (cx, cy, ang, hl, hw, ar), sport in pitch_items:
                if not inb(b): continue
                ca, sa = math.cos(ang), math.sin(ang)
                W_ = lambda u, v: P((cx + u * ca - v * sa, cy + u * sa + v * ca))
                rect = lambda u0, u1, v0, v1: [W_(u0, v0), W_(u1, v0), W_(u1, v1), W_(u0, v1)]
                court = any(k in sport for k in ('tennis', 'basketball', 'pickleball', 'volleyball')) or hl * hw < 700
                if court:
                    d.polygon([P(p) for p in r], fill=(74, 128, 92) if 'tennis' in sport else (176, 98, 72) if 'basketball' in sport else (70, 120, 150))
                    d.polygon(rect(-hl + 1, hl - 1, -hw + 1, hw - 1), outline=(236, 236, 230), width=max(2, int(0.15 * kpx)))
                    d.line([W_(0, -hw + 1), W_(0, hw - 1)], fill=(236, 236, 230), width=max(2, int(0.15 * kpx)))
                    continue
                if 'baseball' in sport or 'softball' in sport:  # infield diamond in clay
                    rr = min(hl, hw) * 0.8
                    d.polygon([W_(-hl + 2, -hw + 2), W_(-hl + 2 + rr, -hw + 2), W_(-hl + 2, -hw + 2 + rr)], fill=(184, 132, 92))
                    continue
                n_s = max(6, int(hl / 4.5))  # mowing stripes across the length
                for k_ in range(n_s):
                    u0 = -hl + 2 * hl * k_ / n_s
                    d.polygon(rect(u0, u0 + 2 * hl / n_s, -hw, hw), fill=(96, 158, 70) if k_ % 2 else (110, 172, 80))
                lw = max(2, int(0.18 * kpx)), (238, 240, 232)
                m_ = 1.5
                d.polygon(rect(-hl + m_, hl - m_, -hw + m_, hw - m_), outline=lw[1], width=lw[0])
                d.line([W_(0, -hw + m_), W_(0, hw - m_)], fill=lw[1], width=lw[0])
                cr = min(9.15, hw * 0.3)
                d.ellipse([W_(0, 0)[0] - cr * kpx, W_(0, 0)[1] - cr * kpx, W_(0, 0)[0] + cr * kpx, W_(0, 0)[1] + cr * kpx], outline=lw[1], width=lw[0])
                for sgn in (1, -1):  # penalty boxes
                    bl, bw = min(16.5, hl * 0.3), min(20.15, hw * 0.6)
                    u = sgn * (hl - m_)
                    d.polygon(rect(min(u, u - sgn * bl), max(u, u - sgn * bl), -bw, bw), outline=lw[1], width=lw[0])
            sh = Image.new('L', (S2, S2), 0); sd2 = ImageDraw.Draw(sh)
            for (x, y, r) in [t for a_ in (-1, 0, 1) for b_ in (-1, 0, 1) for t in tree_cells.get((ti + a_, tj + b_), [])]:
                cx_, cy_ = P((x, y)); rr = r * kpx
                sd2.ellipse((cx_ - rr, cy_ - rr * 0.8, cx_ + rr, cy_ + rr * 0.8), fill=150)
            img = Image.composite(Image.eval(img, lambda v: int(v * 0.6)), img, sh.filter(ImageFilter.GaussianBlur(3)))
            g_ = (np.random.rand(S2 // 4, S2 // 4) - 0.5) * 18
            g_ = np.array(Image.fromarray((g_ + 128).astype(np.uint8)).resize((S2, S2), Image.BILINEAR), dtype=np.int16) - 128
            arr = np.clip(np.array(img, dtype=np.int16) + g_[..., None], 0, 255).astype(np.uint8)
            img = Image.fromarray(arr)
            img.paste((14, 22, 32), (0, 0), Image.fromarray((vcrop * 255).astype(np.uint8)).resize((S2, S2), Image.BILINEAR))
            img.resize((S2 // 2, S2 // 2), Image.LANCZOS).save(f"public/tiles/{R['name']}/{ti}_{tj}.webp", quality=78, method=4)
            tiles.append([ti, tj])
    print('tiles', len(tiles))

    meta['regions'].append({'name': R['name'], 'x0': X0, 'y0': Y0, 'x1': X1, 'y1': Y1, 'tex': f"ground-{R['name']}.jpg",
                            'nx': nx, 'ny': ny, 'step': HSTEP, 'zoff': len(out), 'tile': TILE, 'tiles': tiles})
    out += struct.pack('<HH', nx, ny) + np.round(Z * 10).astype('<i2').tobytes()
    meta.update(special)

# ---------- pack (after the terrain grids) ----------
qz = lambda z: max(-32767, min(32767, int(round(z * 10))))  # decimetres
out += struct.pack('<I', len(all_buildings))
for r, base, h, mn, k, roof, gid, gh_, *_ in all_buildings:
    out += struct.pack('<HhHHBBIH', len(r), qz(base), int(min(h, 400) * 10), int(min(mn, 400) * 10), k, 1 if roof else 0, gid, int(min(gh_, 400) * 10))
    for x, y in r: out += struct.pack('<hh', q(x), q(y))
    if roof:
        cx, cy, ang, hl, hw, ridge = roof
        out += struct.pack('<hhhHHH', q(cx), q(cy), int(ang * 1000), int(hl * 10), int(hw * 10), int(ridge * 10))
out += struct.pack('<I', len(all_trees))
for x, y, z, k, ci, h in all_trees: out += struct.pack('<hhhBBB', q(x), q(y), qz(z), k, ci, int(min(63, h) * 4))
out += struct.pack('<I', len(all_boats))
for x, y, z, a, L in all_boats: out += struct.pack('<hhhhB', q(x), q(y), qz(z), int(a * 1000), int(L * 10))
out += struct.pack('<I', len(all_bridges))
for pts, w in all_bridges:
    out += struct.pack('<HB', len(pts), int(w * 10))
    for x, y, z in pts: out += struct.pack('<hhh', q(x), q(y), qz(z))
# roads: node ids renumbered; each way piece = from, to, class, oneway, lanes per direction, points
ids = {}
for a, b, *_ in all_roads:
    for n_ in (a, b): ids.setdefault(n_, len(ids))
out += struct.pack('<II', len(ids), len(all_roads))
for a, b, cls, ow, per, pts in all_roads:
    out += struct.pack('<IIBBBH', ids[a], ids[b], cls, int(ow), per, len(pts))
    for x, y, z in pts: out += struct.pack('<hhh', q(x), q(y), qz(z))
open('public/city.bin', 'wb').write(out)
json.dump(meta, open('public/meta.json', 'w'))
print('buildings', len(all_buildings), 'trees', len(all_trees), 'boats', len(all_boats), 'bridges', len(all_bridges),
      'road pieces', len(all_roads), 'nodes', len(ids), 'bytes', len(out))
