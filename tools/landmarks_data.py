# Extracts the geometry the landmarks plugin needs from the OpenStreetMap extract into
# public/plugins/landmarks/data.json: landmark footprints and their 3D building parts, the bridge centre
# lines with deck height profiles, port terminals (outline, quay line, silos), ski runs and the Grouse gondola.
# Ground and water along the bridges come from MRDEM 30 m (NRCan, Open Government Licence - Canada).
# Map data (c) OpenStreetMap contributors, ODbL.
# Run: uv run --with numpy,rasterio python3 tools/landmarks_data.py [path/to/lm.osm.pbf]
import json, math, os, re, subprocess, sys, tempfile
import numpy as np

PBF = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/code/vancouver/data/lm.osm.pbf')
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'plugins', 'landmarks', 'data.json')
DEM = '/vsicurl/https://canelevation-dem.s3.ca-central-1.amazonaws.com/mrdem-30/mrdem-30-dtm.tif'
os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')

# landmark -> root OSM objects; building:parts inside the roots come along
LANDMARKS = {
    'scienceworld': ['w37084312'], 'bcplace': ['w24705904'], 'rogers': ['w24705911'],
    'canadaplace': ['w223635729'], 'vccwest': ['w85240507'], 'harbourcentre': ['w1371268997', 'w139571552'],
    'hotelvancouver': ['w139571554'], 'marine': ['w125579375'], 'vancouverhouse': ['w742009401'],
    'shangrila': ['w91998136'], 'gimarket': ['w27926613'],
    'giants': [f'w{i}' for i in range(564838015, 564838021)], 'oceanconcrete': ['w564840236', 'w564840237'],
}
POINTS = {'cauldron': 'n648735254', 'steamclock': 'n703754423'}
# port terminals: kind decides what fills them
TERMINALS = {
    'centerm': ('w220771243', 'containers'), 'vanterm': ('r15852167', 'containers'), 'deltaport': ('w1308709923', 'containers'),
    'westshore': ('w170286454', 'coal'), 'neptune': ('w564571990', 'coal'), 'wharves': ('r15847617', 'sulphur'),
    'pct': ('w41840541', 'sulphur'), 'cascadia': ('w42246026', 'grain'), 'alliance': ('w1173738444', 'grain'),
    'cargill': ('r15803612', 'grain'), 'richardson': ('r15803613', 'grain'), 'viterra': ('w1174883978', 'grain'),
    'fibreco': ('w1172875700', 'chips'), 'seaspan': ('w709281886', 'shipyard'), 'lafarge': ('w1172622374', 'cement'),
}
# bridges: deck ways, then the structure. Stations are metres along the centre line from its southern end;
# deck heights are metres above the water under the bridge ('g' = the ground there, from the DEM).
BRIDGES = {
    'lionsgate': dict(name='Lions Gate Bridge', ways=[4755915], type='suspension',
                      deck=[(0, 'g'), (54, 58), (477, 64), (901, 58), (1548, 'g')], towers=[241, 714], anchors=[54, 901], top=111),
    'ironworkers': dict(name='Ironworkers Memorial Bridge', ways=[23795563, 48608388, 1059700345, 1275279652], type='cantilever',
                        deck=[(0, 'g'), (200, 44), (507, 47), (815, 42), (1317, 'g')], truss=[200, 340, 675, 815]),
    'burrard': dict(name='Burrard Bridge', ways=[23188868, 849900149], type='burrard',
                    deck=[(0, 'g'), (150, 25), (425, 30), (515, 30), (760, 26), (864, 'g')], towers=[425, 515], sidetruss=[150, 760]),
    'granville': dict(name='Granville Bridge', ways=[1419040129, 1419040128, 1419040127, 24530078, 341691648, 1419312044], type='decktruss',
                      deck=[(0, 'g'), (300, 30), (470, 33), (640, 31), (886, 'g')], truss=[330, 610], piers=[330, 410, 530, 610]),
    'cambie': dict(name='Cambie Bridge', ways=[32333986, 56864227, 1150603773, 392359700, 255863563, 1285497220, 1353705210, 56864237, 392359701, 59123669],
                   type='girder', deck=[(0, 'g'), (670, 18), (984, 'g')], girder=[450, 900], piers=[520, 610, 730, 820]),
    'portmann': dict(name='Port Mann Bridge', ways=[190721968, 191165108], type='stayed', pylon='I',
                     deck=[(0, 'g'), (330, 40), (556, 46), (790, 48), (1024, 46), (1250, 40), (1980, 'g')], towers=[556, 1024], top=160, back=[330, 1250]),
    'alexfraser': dict(name='Alex Fraser Bridge', ways=[25005852, 25005853], type='stayed', pylon='H',
                       deck=[(0, 'g'), (805, 52), (1037, 58), (1270, 60), (1503, 58), (1735, 52), (2012, 'g')], towers=[1037, 1503], top=154, back=[805, 1735]),
    'skybridge': dict(name='SkyBridge', ways=[37226895, 425639371], type='stayed', pylon='H',
                      deck=[(0, 30), (60, 38), (196, 46), (364, 48), (532, 46), (700, 38), (756, 35)], towers=[196, 532], top=123, back=[60, 700]),
    'riverview': dict(name='stal̕əw̓asəm Bridge', ways=[880065891, 1477855462, 1456979642, 880065890], type='stayed', pylon='H',
                      deck=[(0, 'g'), (500, 40), (698, 46), (864, 47), (1030, 45), (1216, 'g')], towers=[698], top=167, back=[500, 1030]),
    'knight': dict(name='Knight Street Bridge', ways=[389809699, 389809703], type='girder',
                   deck=[(0, 'g'), (560, 20), (800, 26), (1000, 18), (1115, 'g')], girder=[620, 980], piers=[680, 740, 860, 920]),
    'arthurlaing': dict(name='Arthur Laing Bridge', ways=[20669374, 23188860, 30605187, 338169325, 50783656], type='girder', steel='weathering',
                        deck=[(0, 'g'), (235, 23), (370, 24), (505, 23), (998, 'g')], girder=[150, 590], piers=[235, 505], haunch=True),
    'oakstreet': dict(name='Oak Street Bridge', ways=[24530021, 182607985, 24530023, 182607986, 338171747, 1274838145], type='girder',
                      deck=[(0, 'g'), (1000, 20), (1155, 22), (1310, 20), (1825, 'g')], girder=[900, 1400], piers=[1000, 1090, 1220, 1310]),
}


def osm(args, out):
    subprocess.run(['osmium', *args, '-o', out, '--overwrite'], check=True)


def features(path):
    for line in open(path):
        f = json.loads(line.strip('\x1e'))
        yield f['properties']['@type'][0] + str(f['properties']['@id']), f['properties'], f['geometry']


def rings(g):  # outer rings of a geometry, [[lon, lat], ...]
    t, c = g['type'], g['coordinates']
    return [c] if t == 'LineString' else [c[0]] if t == 'Polygon' else [p[0] for p in c] if t == 'MultiPolygon' else [[c]]


def flat(r, d=6):  # [[lon, lat]] -> [lat, lon, lat, lon, ...]
    return [round(v, d) for p in r for v in (p[1], p[0])]


def inside(x, y, r):
    c = False
    for (x1, y1), (x2, y2) in zip(r, r[1:] + r[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c


def num(v):
    m = re.match(r'\s*(-?[\d.]+)', v or '')
    return float(m.group(1)) if m else None


def dem_sampler():
    import rasterio
    from rasterio.warp import transform
    src = rasterio.open(DEM)

    def sample(lat, lon):
        x, y = transform('EPSG:4326', src.crs, list(lon), list(lat))
        return np.array([max(0.0, float(v[0])) for v in src.sample(zip(x, y))])
    return sample


def main():
    tmp = tempfile.mkdtemp()
    a, b = os.path.join(tmp, 'a.pbf'), os.path.join(tmp, 'b.pbf')
    # everything but buildings, whole region
    osm(['tags-filter', PBF, 'w/bridge', 'nwr/landuse=industrial', 'nwr/man_made=silo', 'nwr/piste:type=downhill', 'w/aerialway', 'n/historic'], a)
    osm(['export', a, '-f', 'geojsonseq', '-a', 'type,id'], a + '.json')
    # buildings and parts around the landmarks only
    osm(['extract', '-b', '-123.145,49.265,-123.095,49.292', PBF], b)
    osm(['tags-filter', b, 'nwr/building', 'nwr/building:part'], b + '.f.pbf')
    osm(['export', b + '.f.pbf', '-f', 'geojsonseq', '-a', 'type,id'], b + '.json')

    feats = {}
    for k, p, g in features(a + '.json'): feats[k] = (p, g)
    blds = {}
    for k, p, g in features(b + '.json'): blds[k] = (p, g)
    out = {'landmarks': {}, 'points': {}, 'terminals': {}, 'bridges': {}, 'pistes': [], 'gondolas': []}

    # ---------- landmarks: root outlines, and every building:part whose centre is inside one ----------
    parts = [(k, p, g) for k, (p, g) in blds.items() if 'building:part' in p and g['type'] in ('Polygon', 'MultiPolygon')]
    for name, roots in LANDMARKS.items():
        outl = [r for k in roots for r in rings(blds[k][1])]
        lm = {'rings': [flat(r) for r in outl], 'tags': {k: blds[k][0].get(t) for k in roots for t in ('height', 'building:levels') if blds[k][0].get(t)}, 'parts': []}
        for k, p, g in parts:
            for r in rings(g):
                cx, cy = np.mean(r[:-1], 0)
                if any(inside(cx, cy, o) for o in outl):
                    lm['parts'].append({'r': flat(r), 'h': num(p.get('height')), 'mh': num(p.get('min_height')) or 0,
                                        'roof': p.get('roof:shape'), 'rh': num(p.get('roof:height')), 'lv': num(p.get('building:levels'))})
        out['landmarks'][name] = lm
    for name, k in POINTS.items():
        p, g = feats[k]
        out['points'][name] = [round(g['coordinates'][1], 6), round(g['coordinates'][0], 6)]

    # ---------- port terminals ----------
    sample = dem_sampler()
    silos = [(p, r) for k, (p, g) in feats.items() if p.get('man_made') == 'silo' and g['type'] in ('Polygon', 'MultiPolygon') for r in rings(g)]
    for name, (k, kind) in TERMINALS.items():
        p, g = feats[k]
        r = max(rings(g), key=len)
        lat0, lon0 = np.mean([q[1] for q in r]), np.mean([q[0] for q in r])
        kx, ky = 111320 * math.cos(math.radians(lat0)), 110574
        xy = np.array([((q[0] - lon0) * kx, (q[1] - lat0) * ky) for q in r])
        # oriented bounding box; the quay is the long side with water outside it (DEM at sea level)
        best = None
        for e0, e1 in zip(xy, xy[1:]):
            u = (e1 - e0) / (np.linalg.norm(e1 - e0) or 1); v = np.array([-u[1], u[0]])
            pu, pv = xy @ u, xy @ v
            ar = (pu.max() - pu.min()) * (pv.max() - pv.min())
            if best is None or ar < best[0]: best = (ar, u, v, pu.min(), pu.max(), pv.min(), pv.max())
        _, u, v, u0, u1, v0, v1 = best
        if u1 - u0 < v1 - v0: u, v, u0, u1, v0, v1 = v, -u, v0, v1, -u1, -u0
        sides = []
        for sgn, vv in ((1, v1), (-1, v0)):
            pts = [u * (u0 + (u1 - u0) * f) + v * (vv + sgn * 70) for f in (0.2, 0.35, 0.5, 0.65, 0.8)]
            z = sample([lat0 + q[1] / ky for q in pts], [lon0 + q[0] / kx for q in pts])
            sides.append(((z < 1).sum(), sgn, vv))
        wet, sgn, vv = max(sides)
        quay = [u * u0 + v * vv, u * u1 + v * vv]
        ll = lambda q: [round(lat0 + q[1] / ky, 6), round(lon0 + q[0] / kx, 6)]
        t = {'kind': kind, 'name': p.get('name'), 'ring': flat(r), 'quay': ll(quay[0]) + ll(quay[1]) if wet else None,
             'land': ll(-v * sgn * 100)}  # a point inland of the quay, giving the direction
        t['silos'] = [flat(sr) for sp, sr in silos if inside(*np.mean(sr[:-1], 0), r)]
        out['terminals'][name] = t

    # ---------- bridges: centre line (10 m stations), width, deck profile ----------
    ways = {int(k[1:]): g['coordinates'] for k, (p, g) in feats.items() if k[0] == 'w' and g['type'] == 'LineString'}
    lanes = {int(k[1:]): num(p.get('lanes')) or 2 for k, (p, g) in feats.items() if k[0] == 'w'}
    for name, B in BRIDGES.items():
        pts = np.array([c for i in B['ways'] for c in ways[i]])
        lat0, lon0 = pts[:, 1].mean(), pts[:, 0].mean()
        kx, ky = 111320 * math.cos(math.radians(lat0)), 110574
        # every way resampled every 4 m, then binned along the main axis (southern end first)
        dense = []
        for i in B['ways']:
            w = np.array([((c[0] - lon0) * kx, (c[1] - lat0) * ky) for c in ways[i]])
            for p0, p1 in zip(w, w[1:]):
                n = max(1, int(np.linalg.norm(p1 - p0) / 4))
                for f in np.arange(n) / n: dense.append((*(p0 + (p1 - p0) * f), lanes[i]))
            dense.append((*w[-1], lanes[i]))
        dense = np.array(dense)
        c0 = dense[:, :2].mean(0)
        u = np.linalg.svd(dense[:, :2] - c0)[2][0]
        if u[1] < 0: u = -u
        v = np.array([-u[1], u[0]])
        t, d = (dense[:, :2] - c0) @ u, (dense[:, :2] - c0) @ v
        L = t.max() - t.min()
        st = np.arange(0, L + 0.01, 10.0)
        line, half = [], []
        for s in st:
            m = np.abs(t - t.min() - s) < 8
            if not m.any(): m = np.abs(t - t.min() - s) < 30
            lo, hi = d[m].min(), d[m].max()
            ln = dense[m, 2]
            line.append(c0 + u * (t.min() + s) + v * (lo + hi) / 2)
            half.append((hi - lo) / 2 + ln.max() * 3.6 / 2 + 1.2)  # outer lanes plus shoulder and railing
        line = np.array(line)
        # smooth the centre line a little (ramps joining make the bins jumpy)
        k = np.ones(5) / 5
        line = np.c_[np.convolve(np.pad(line[:, 0], 2, mode='edge'), k, 'valid'), np.convolve(np.pad(line[:, 1], 2, mode='edge'), k, 'valid')]
        half = np.convolve(np.pad(np.array(half), 2, mode='edge'), k, 'valid')
        lat, lon = lat0 + line[:, 1] / ky, lon0 + line[:, 0] / kx
        ground = sample(lat, lon)
        prof = [(s, float(np.interp(s, st, ground)) if h == 'g' else h) for s, h in B['deck']]
        sp, hp = zip(*prof)
        deck = np.interp(st, sp, hp)
        out['bridges'][name] = {
            'name': B['name'], 'type': B['type'], 'line': [round(x, 6) for a_, o_ in zip(lat, lon) for x in (a_, o_)],
            'half': [round(float(h), 1) for h in half], 'deck': [round(float(h), 1) for h in deck], 'ground': [round(float(g_), 1) for g_ in ground],
            'step': 10, **{k_: v_ for k_, v_ in B.items() if k_ not in ('ways', 'deck', 'name', 'type')},
        }
        print(name, f'L={L:.0f} width~{2 * np.median(half):.0f} water at', [int(s) for s, gz in zip(st, ground) if gz < 0.5][:1], '..', [int(s) for s, gz in zip(st, ground) if gz < 0.5][-1:])

    # ---------- North Shore: ski runs and the Grouse gondola ----------
    for k, (p, g) in feats.items():
        if p.get('piste:type') == 'downhill' and g['type'] != 'Point':
            for r in rings(g):
                if r[0][1] > 49.3: out['pistes'].append({'area': g['type'] != 'LineString', 'diff': p.get('piste:difficulty'), 'r': flat(r, 5)})
        if p.get('aerialway') in ('gondola', 'cable_car') and 'Skyride' in (p.get('name') or '') + (p.get('description') or ''):
            out['gondolas'].append(flat(g['coordinates']))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f: json.dump(out, f, separators=(',', ':'), ensure_ascii=False)
    print(OUT, os.path.getsize(OUT), 'bytes;', {k: len(v) if hasattr(v, '__len__') else v for k, v in out.items()})


if __name__ == '__main__':
    main()
