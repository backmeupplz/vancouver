# Builds public/plugins/ships/data.json for the ships plugin from the OSM extract:
#   ferries:  BC Ferries and False Creek mini-ferry route lines (route=ferry; SeaBus left to the transit plugin)
#   berths:   straight quay runs where a port terminal (industrial=port) meets the water, with the water side
#             (coastline has water on its right; river polygons are reoriented the same way)
#   river:    the Fraser's North Arm and main channel centrelines, for tugs towing log booms
#   anchorages: approximate Port of Vancouver anchorage spots (OSM has no seamark:type=anchorage here)
# Usage: uv run --with osmium,shapely python3 tools/ships_data.py [data/lm.osm.pbf]
# Map data © OpenStreetMap contributors, ODbL.
import json, math, os, subprocess, sys, tempfile

import osmium
from shapely import wkb
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import linemerge, unary_union

SRC = sys.argv[1] if len(sys.argv) > 1 else '/Users/borodutch/code/vancouver/data/lm.osm.pbf'
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'plugins', 'ships', 'data.json')
LAT0, LON0 = 49.25, -123.0
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110574  # metres per degree, local equirectangular


def xy(lon, lat): return ((lon - LON0) * KX, (lat - LAT0) * KY)
def ll(x, y): return [round(LAT0 + y / KY, 5), round(LON0 + x / KX, 5)]


tmp = tempfile.mkdtemp()
sub = os.path.join(tmp, 'sea.osm.pbf')
subprocess.run(['osmium', 'tags-filter', '-O', '-o', sub, SRC, 'w/route=ferry', 'w/natural=coastline', 'w/waterway=river',
                'wr/industrial=port', 'wr/industrial=oil;port', 'wr/industrial=port;oil', 'wr/water=river'], check=True)
fab = osmium.geom.WKBFactory()
ferries, coast, rivers, terminals, riverpolys = [], [], {}, [], []


class H(osmium.SimpleHandler):
    def way(self, w):
        t = w.tags
        try:
            line = wkb.loads(fab.create_linestring(w), hex=True)
        except Exception:
            return
        line = LineString([xy(*p) for p in line.coords])
        if t.get('route') == 'ferry':
            op, name = t.get('operator', ''), t.get('name', '')
            if 'SeaBus' in name or 'approach' in name.lower() or 'Foot' in name:
                return
            if t.get('network') == 'BC Ferries' and t.get('ref'):
                ferries.append({'name': name, 'ref': t['ref'], 'op': 'bcf', 'line': line})
            elif op in ('Aquabus', 'False Creek Ferries') or t.get('network') in ('Aquabus', 'False Creek Ferries'):
                ferries.append({'name': name, 'op': 'aquabus' if t.get('network') == 'Aquabus' else 'fcf', 'line': line})
        elif t.get('natural') == 'coastline':
            coast.append(line)
        elif t.get('waterway') == 'river' and t.get('name') in ('Fraser River', 'Fraser River (North Arm)'):
            rivers.setdefault(t['name'], []).append(line)

    def area(self, a):
        t = a.tags
        try:
            g = wkb.loads(fab.create_multipolygon(a), hex=True)
        except Exception:
            return
        polys = [Polygon([xy(*p) for p in p.exterior.coords]) for p in g.geoms]
        if 'port' in t.get('industrial', '') and t.get('name'):
            terminals.append({'name': t['name'], 'cargo': t.get('cargo', ''), 'poly': unary_union(polys)})
        elif t.get('water') == 'river':
            riverpolys.extend(polys)


H().apply_file(sub, locations=True)

# shorelines with the water on the right: coastline as drawn, river polygons clockwise
shores = coast + [LineString(orient(p, -1).exterior.coords) for p in riverpolys]


def runs(line, min_len=170, max_turn=12):
    """Straight pieces of a polyline: [(x0, y0, x1, y1)] split where it turns more than max_turn degrees."""
    c = list(line.coords)
    out, start = [], 0
    for i in range(1, len(c) - 1):
        a = math.atan2(c[i][1] - c[start][1], c[i][0] - c[start][0])
        b = math.atan2(c[i + 1][1] - c[i][1], c[i + 1][0] - c[i][0])
        if abs((b - a + math.pi) % (2 * math.pi) - math.pi) > math.radians(max_turn):
            out.append((c[start], c[i])); start = i
    out.append((c[start], c[-1]))
    return [(p, q) for p, q in out if math.dist(p, q) >= min_len]


KIND = {'container': 'container', 'dry_bulk': 'bulk', 'bulk': 'bulk', 'liquid_bulk': 'tanker', 'vehicle': 'car', 'breakbulk': 'general'}
berths = []
for t in terminals:
    cargo = t['cargo'].split(';')[0] or {'Deltaport': 'container'}.get(t['name'], '')
    if cargo not in KIND:
        continue
    zone = t['poly'].buffer(30)
    for s in shores:
        if not s.intersects(zone):
            continue
        part = s.intersection(zone)
        for g in getattr(part, 'geoms', [part]):
            if g.geom_type != 'LineString':
                continue
            for p, q in runs(g):
                L = math.dist(p, q)
                # quays often stand out over the water past the coastline: move the berth line out of the terminal
                nx, ny = (q[1] - p[1]) / L, -(q[0] - p[0]) / L  # right of p→q: the water side
                mx, my = (p[0] + q[0]) / 2, (p[1] + q[1]) / 2
                off = next((d for d in range(0, 160, 5) if not t['poly'].contains(Point(mx + nx * d, my + ny * d))), None)
                if off is None:
                    continue
                berths.append({'t': t['name'], 'k': KIND[cargo], 'a': ll(*p), 'b': ll(*q), 'len': round(L), 'off': off})

out = {'ferries': [], 'berths': berths, 'river': [], 'anchorages': []}
for f in ferries:
    line = f.pop('line').simplify(8)
    f['pts'] = [ll(*p) for p in line.coords]
    out['ferries'].append(f)
REGION = Polygon([xy(-123.33, 48.99), xy(-122.40, 48.99), xy(-122.40, 49.48), xy(-123.33, 49.48)])
seen = set()
for name, lines in rivers.items():
    m = linemerge(lines).intersection(REGION)
    for g in getattr(m, 'geoms', [m]):
        ends = tuple(round(v, -2) for v in (*g.coords[0], *g.coords[-1]))
        if g.geom_type == 'LineString' and g.length > 3000 and ends not in seen:  # braided channels: one of each
            seen.add(ends)
            out['river'].append({'name': name, 'pts': [ll(*p) for p in g.simplify(15).coords]})

# Anchorages: approximate positions read off the Port of Vancouver anchorage chart (English Bay and the inner
# harbour; ODbL-free, hand-placed). Ships at anchor swing together to the tide.
out['anchorages'] = [
    [49.2905, -123.1835], [49.2950, -123.1970], [49.2890, -123.2050], [49.2985, -123.2135], [49.2915, -123.2245],
    [49.3010, -123.2290], [49.2860, -123.2370], [49.2955, -123.2420], [49.3055, -123.2465], [49.2830, -123.2560],
    [49.2925, -123.2600], [49.3020, -123.2640], [49.2870, -123.2760], [49.2975, -123.2810],
    [49.3015, -123.0820], [49.2990, -123.0640],  # inner harbour, off Neptune and Lynnterm
]
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
print(f"{OUT}: {os.path.getsize(OUT)} bytes, {len(out['ferries'])} ferry lines, {len(berths)} berth runs, "
      f"{len(out['river'])} river lines; terminals: {sorted({b['t'] for b in berths})}")
missing = sorted({t['name'] for t in terminals if t['cargo'].split(';')[0] in KIND} - {b['t'] for b in berths})
print('terminals without a quay run:', missing)
