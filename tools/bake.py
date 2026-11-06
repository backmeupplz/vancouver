# Bakes data/osm.json into the files the page draws:
#   public/ground.jpg   top-down ground texture (water, parks, beaches, streets)
#   public/city.bin     buildings, trees, boats, bridges as packed int16/uint16
#   public/meta.json    world size + landmarks
# Run: uv run --with numpy,pillow,scipy python3 tools/bake.py
import json, math, random, struct
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

random.seed(7)
S, W, N, E = 49.232, -123.172, 49.318, -123.080
LAT0, LON0 = (S + N) / 2, (W + E) / 2
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110574
RES = 2.0  # metres per texture pixel
SS = 2  # supersampling for the texture
WM, HM = (E - W) * KX, (N - S) * KY  # world size, metres
TW, TH = int(WM / RES), int(HM / RES)


def xy(p):  # lat/lon -> metres, origin at centre, +y north
    return ((p['lon'] - LON0) * KX, (p['lat'] - LAT0) * KY)


def px(pt, ss=SS):  # metres -> texture pixel
    return ((pt[0] + WM / 2) / RES * ss, (HM / 2 - pt[1]) / RES * ss)


els = json.load(open('data/osm.json'))['elements']


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


# ---------- classify ----------
AREA = {  # paint order, colour
    'residential': (0, (128, 148, 100)), 'commercial': (1, (162, 160, 152)), 'retail': (1, (165, 160, 150)),
    'industrial': (1, (150, 142, 128)), 'railway': (1, (140, 132, 120)), 'construction': (1, (176, 160, 130)),
    'brownfield': (1, (170, 155, 125)),
    'grass': (2, (128, 170, 78)), 'meadow': (2, (138, 172, 82)), 'recreation_ground': (2, (122, 168, 76)),
    'cemetery': (2, (118, 150, 84)), 'park': (2, (116, 162, 72)), 'garden': (3, (110, 156, 70)),
    'golf_course': (3, (126, 178, 80)), 'grassland': (2, (140, 170, 90)), 'scrub': (3, (98, 128, 66)),
    'playground': (4, (178, 160, 120)), 'pitch': (4, (98, 168, 70)), 'track': (5, (168, 142, 118)),
    'stadium': (4, (150, 150, 145)),
    'wood': (5, (52, 92, 46)), 'forest': (5, (52, 92, 46)), 'wetland': (5, (92, 124, 82)),
    'beach': (6, (226, 210, 168)), 'sand': (6, (222, 206, 164)),
    'marina': (-1, None), 'swimming_pool': (8, (96, 196, 222)),
}
ROAD = {'motorway': 8, 'trunk': 8, 'primary': 7, 'secondary': 6, 'tertiary': 5, 'trunk_link': 5, 'primary_link': 5,
        'secondary_link': 5, 'tertiary_link': 4, 'residential': 4, 'unclassified': 4, 'living_street': 3,
        'service': 2.4, 'pedestrian': 3, 'footway': 1.2, 'cycleway': 1.4, 'path': 1.1, 'track': 1.6, 'steps': 1.2}

areas, waters, coast, roads, bridges, rails, piers, marinas, blds, parts = [], [], [], [], [], [], [], [], [], []
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
        if t.get('tunnel') in ('yes', 'building_passage') or t.get('area') == 'yes' or hw not in ROAD: continue
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


def fill_shape(draw, sh, col, hole=None):
    for outers, inners in sh:
        for r in outers: draw.polygon([px(p) for p in r], fill=col)
        for r in inners: draw.polygon([px(p) for p in r], fill=hole if hole is not None else (146, 150, 126))


# land-use classes, low to high
woodmask = Image.new('L', (TW, TH), 0); wd = ImageDraw.Draw(woodmask)
parkmask = Image.new('L', (TW, TH), 0); pd = ImageDraw.Draw(parkmask)
resmask = Image.new('L', (TW, TH), 0); rd = ImageDraw.Draw(resmask)
for order, col, e, kind in sorted(areas, key=lambda a: a[0]):
    sh = shapes(e)
    jit = tuple(max(0, min(255, c + random.randint(-6, 6))) for c in col)
    for outers, inners in sh:
        # holes in multipolygons: paint by mask so lower layers show through
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
        tgt = wd if kind in ('wood', 'forest') else pd if kind in ('park', 'grass', 'garden', 'recreation_ground', 'cemetery', 'meadow', 'golf_course', 'grassland', 'scrub') else rd if kind == 'residential' else None
        if tgt:
            for r in outers: tgt.polygon([px(p, 1) for p in r], fill=255)
            for r in inners: tgt.polygon([px(p, 1) for p in r], fill=0)

# sea: coastline lines are walls, flood from English Bay
wall = Image.new('L', (TW, TH), 0); wdw = ImageDraw.Draw(wall)
for l in coast: wdw.line([px(p, 1) for p in l], fill=255, width=2)
lab, _ = ndimage.label(np.array(wall) == 0)
seed = px(xy({'lat': 49.2855, 'lon': -123.160}), 1)
sea = lab == lab[int(seed[1]), int(seed[0])]
sea |= ndimage.binary_dilation(sea) & (np.array(wall) > 0)  # swallow the wall line
water = sea.copy()
lakes = Image.new('L', (TW, TH), 0); ld = ImageDraw.Draw(lakes)
for e in waters:
    for outers, inners in shapes(e):
        for r in outers: ld.polygon([px(p, 1) for p in r], fill=255)
        for r in inners: ld.polygon([px(p, 1) for p in r], fill=0)
water |= np.array(lakes) > 0
print('sea fraction', sea.mean())
# the North Shore is cut away into the dark, like the painting: every big land
# mass that is not connected to Vancouver itself
land_lab, nl = ndimage.label(~water)
home = px(xy({'lat': 49.28, 'lon': -123.12}), 1)
sizes = ndimage.sum(np.ones_like(land_lab), land_lab, range(nl + 1))
void = (land_lab != land_lab[int(home[1]), int(home[0])]) & (sizes[land_lab] * RES * RES > 300000) & (land_lab > 0)
in_void = lambda x, y: void[min(TH - 1, max(0, int((HM / 2 - y) / RES))), min(TW - 1, max(0, int((x + WM / 2) / RES)))]

# water colour by distance to shore
dist = ndimage.distance_transform_edt(water) * RES
t = np.clip(dist / 140, 0, 1)[..., None]
shallow, deep = np.array([78, 150, 196]), np.array([22, 70, 140])
wc = shallow * (1 - t) ** 1.6 + deep * (1 - (1 - t) ** 1.6)
wc = np.where((dist < 6)[..., None], np.array([120, 190, 210]), wc)  # surf line
noise = ndimage.gaussian_filter(np.random.rand(TH, TW), 6)
wc = wc * (0.92 + 0.16 * (noise - noise.min()) / (np.ptp(noise) + 1e-9))[..., None]
wimg = Image.fromarray(wc.astype(np.uint8)).resize((W2, H2), Image.BILINEAR)
wmask = Image.fromarray((water * 255).astype(np.uint8)).resize((W2, H2), Image.NEAREST).filter(ImageFilter.GaussianBlur(1))
img.paste(wimg, (0, 0), wmask)

# piers, rails, roads (casing then fill)
for e in piers:
    sh = shapes(e)
    if sh: fill_shape(dr, sh, (200, 196, 186))
    else: dr.line([px(p) for p in line(e)], fill=(200, 196, 186), width=int(3 / RES * SS))
for l in rails: dr.line([px(p) for p in l], fill=(118, 108, 98), width=int(3 / RES * SS))
for casing in (True, False):
    for l, w in sorted(roads, key=lambda r: r[1]):
        pts = [px(p) for p in l]
        if w < 2:
            if not casing: dr.line(pts, fill=(214, 206, 186), width=max(1, int(w / RES * SS)))
            continue
        ww = int((w + (1.6 if casing else 0)) / RES * SS)
        col = (120, 122, 118) if casing else (196, 196, 190) if w >= 6 else (182, 182, 176)
        dr.line(pts, fill=col, width=ww, joint='curve')

# gentle texture grain so flat fills read like the painting
grain = (ndimage.gaussian_filter(np.random.rand(H2 // 4, W2 // 4), 1.2) - 0.5) * 26
grain = np.array(Image.fromarray(((grain + 128)).clip(0, 255).astype(np.uint8)).resize((W2, H2), Image.BILINEAR), dtype=np.int16) - 128
arr = np.clip(np.array(img, dtype=np.int16) + grain[..., None], 0, 255).astype(np.uint8)
ground = Image.fromarray(arr).resize((TW, TH), Image.LANCZOS)
vm = Image.fromarray((void * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.5))
ground.paste((11, 16, 22), (0, 0), vm)
ground.save('public/ground.jpg', quality=88)

# ---------- buildings ----------
DOWNTOWN = [(49.2955, -123.1440), (49.2830, -123.1095), (49.2745, -123.1000), (49.2700, -123.1045), (49.2755, -123.1290),
            (49.2860, -123.1440), (49.2905, -123.1500)]  # rough peninsula (West End + downtown + Yaletown)
DT = [xy({'lat': a, 'lon': b}) for a, b in DOWNTOWN]


def inside(pt, poly):
    x, y = pt; c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c


def area(r):
    return abs(sum(r[i][0] * r[i - 1][1] - r[i - 1][0] * r[i][1] for i in range(len(r)))) / 2


def hnum(v):
    try: return float(str(v).split(';')[0].replace('m', '').strip())
    except ValueError: return None


def height(t, a, c):
    h = hnum(t.get('height'))
    if h: return h, hnum(t.get('min_height')) or 0
    lv = hnum(t.get('building:levels'))
    mn = (hnum(t.get('building:min_level')) or 0) * 3.1
    if lv: return lv * 3.1 + (1.5 if lv > 3 else 0.8), mn
    b = t.get('building', t.get('building:part', 'yes'))
    if b in ('house', 'detached', 'semidetached_house', 'residential') and a < 400: return random.uniform(6.5, 9.5), 0
    if b in ('garage', 'garages', 'shed', 'roof', 'carport', 'hut', 'kiosk'): return 3.0, 0
    if inside(c, DT):  # unknown downtown block: towers if big enough
        if a > 500: return random.choice([random.uniform(25, 60), random.uniform(60, 120), random.uniform(15, 30)]), 0
        return random.uniform(10, 24), 0
    if a > 2500: return random.uniform(8, 16), 0
    if a > 600: return random.uniform(9, 14), 0
    return random.uniform(6, 9), 0


def cent(r):
    return (sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r))


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


# colour classes the shader maps to palettes: 0 house, 1 apartment, 2 glass tower, 3 brick, 4 concrete/commercial, 5 white
def kind(t, h, c):
    b = t.get('building', t.get('building:part', 'yes'))
    mat = t.get('building:material', '') + t.get('building:colour', '')
    if 'glass' in mat or (h > 40 and random.random() < 0.8): return 2
    if 'brick' in mat or (inside(c, DT) and h < 30 and random.random() < 0.25): return 3
    if b in ('house', 'detached', 'semidetached_house', 'garage', 'shed') or (h < 10 and not inside(c, DT)): return 0
    if b in ('apartments', 'residential') or (inside(c, DT) and h < 40): return 1 if random.random() < 0.6 else 5
    return 4


building_rows = []
footprint = Image.new('L', (TW, TH), 0); fd = ImageDraw.Draw(footprint)
landmarks = []  # footprints drawn by hand in main.js; OSM parts inside them are dropped
for e in blds:
    name = e.get('tags', {}).get('name', '')
    for outers, _ in shapes(e):
        r = outers[0]; c = cent(r)
        if 'BC Place' in name: special['bcplace'] = [round(c[0]), round(c[1]), round(math.sqrt(area(r) / math.pi))]; landmarks.append(r)
        if name == 'Science World': special['scienceworld'] = [round(c[0]), round(c[1])]; landmarks.append(r)
for e in blds + parts:
    t = e.get('tags', {})
    for outers, _ in shapes(e):
        r = outers[0]
        if r[0] == r[-1]: r = r[:-1]
        if len(r) < 3 or len(r) > 250: continue
        c = cent(r)
        if abs(c[0]) > WM / 2 or abs(c[1]) > HM / 2 or in_void(*c): continue
        a = area(r)
        fd.polygon([px(p, 1) for p in r], fill=255)
        if any(inside(c, lm) for lm in landmarks): continue
        if 'building' in t and not t.get('height') and not t.get('building:levels') and has_parts(r): continue
        h, mn = height(t, a, c)
        building_rows.append((r, h, mn, kind(t, h, c)))

# ---------- trees ----------
fp = ndimage.binary_dilation(np.array(footprint) > 0, iterations=1)
roadm = Image.new('L', (TW, TH), 0); rmd = ImageDraw.Draw(roadm)
for l, w in roads:
    if w >= 2: rmd.line([px(p, 1) for p in l], fill=255, width=max(1, int((w + 1) / RES)))
for e in piers: rmd.line([px(p, 1) for p in line(e)], fill=255, width=2)
roadm = np.array(roadm) > 0
open_ = ~(water | fp | roadm)
d_road = ndimage.distance_transform_edt(~roadm) * RES
wood, park, res = np.array(woodmask) > 0, np.array(parkmask) > 0, np.array(resmask) > 0
prob = np.zeros((TH, TW), np.float32)
prob[res] = 0.32
prob[res & (d_road > 1.5) & (d_road < 6)] = 0.9  # boulevard trees
prob[~res & ~park & ~wood & (d_road > 1.5) & (d_road < 5)] = 0.25  # downtown street trees
prob[park] = 0.18
prob[park & (d_road < 7)] = 0.4
prob[wood] = 1.0
prob[~open_ | void] = 0
trees = []
CELL = 7.0
for gy in np.arange(-HM / 2, HM / 2, CELL):
    for gx in np.arange(-WM / 2, WM / 2, CELL):
        x, y = gx + random.random() * CELL, gy + random.random() * CELL
        i, j = int((HM / 2 - y) / RES), int((x + WM / 2) / RES)
        if not (0 <= i < TH and 0 <= j < TW): continue
        p = prob[i, j]
        if p and random.random() < p:
            trees.append((x, y, 1 if wood[i, j] else 0))
print('trees', len(trees))

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
cand = water & (np.array(mm) > 0) & (d_pier > 1) & (d_pier < 12)
boats = []
for i, j in zip(*np.nonzero(cand)):
    if random.random() < 0.09:
        ang = math.atan2(-gy_[i, j], gx_[i, j])  # bow points away from the pier
        boats.append(((j + 0.5) * RES - WM / 2, HM / 2 - (i + 0.5) * RES, ang))
# thin out boats that overlap
kept, grid = [], {}
for b in boats:
    k = (int(b[0] // 5), int(b[1] // 5))
    if any(grid.get((k[0] + a, k[1] + c)) for a in (-1, 0, 1) for c in (-1, 0, 1)): continue
    grid[k] = 1; kept.append(b)
boats = kept
print('boats', len(boats))

# ---------- pack ----------
q = lambda v: max(-32767, min(32767, int(round(v * 2))))  # half-metre int16
out = bytearray()
out += struct.pack('<I', len(building_rows))
for r, h, mn, k in building_rows:
    out += struct.pack('<HHHB', len(r), int(min(h, 400) * 10), int(min(mn, 400) * 10), k)
    for x, y in r: out += struct.pack('<hh', q(x), q(y))
out += struct.pack('<I', len(trees))
for x, y, k in trees: out += struct.pack('<hhB', q(x), q(y), k)
out += struct.pack('<I', len(boats))
for x, y, a in boats: out += struct.pack('<hhh', q(x), q(y), int(a * 1000))
# bridge deck height: distance along the bridge network to the nearest abutment
# (a vertex shared with a ground road), times a ramp slope, capped
import heapq
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
inbox = lambda p: abs(p[0]) < WM / 2 - 5 and abs(p[1]) < HM / 2 - 5
long_bridges = [(l, w) for l, w, _ in bridges if len(l) > 1 and all(map(inbox, l)) and not any(in_void(*p) for p in l)]
out += struct.pack('<I', len(long_bridges))
for l, w in long_bridges:
    out += struct.pack('<HB', len(l), int(w * 10))
    for p in l:
        h = min(26.0, dist_ab.get(key(p), 40) * 0.06)
        out += struct.pack('<hhH', q(p[0]), q(p[1]), int(h * 10))
open('public/city.bin', 'wb').write(out)
json.dump({'w': WM, 'h': HM, 'tw': TW, 'th': TH, 'lat0': LAT0, 'lon0': LON0, 'kx': KX, 'ky': KY, **special}, open('public/meta.json', 'w'))
print('buildings', len(building_rows), 'bridges', len(long_bridges), 'bytes', len(out))
