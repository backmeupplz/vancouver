# Street names and named places for the drive plugin (public/plugins/drive/data/<I>_<J>.json), cut into the
# map's 4096 m overview cells so the game loads only the few around the player (I = floor(x / 4096),
# J = floor(north / 4096), world metres as in public/tiles/index.json).
# Per cell: {"o": [x, north] of the cell's SW corner, "n": street names, "s": [[name, x0, y0, x1, y1, ...]] (named
# street centrelines, simplified to 2 m, whole metres from "o"), "k": place kinds, "p": [[x, y, name, kind, addr?]]}.
# data/index.json lists the cells that exist.
# Source: OpenStreetMap (© OpenStreetMap contributors, ODbL). Run from the repo root:
#   osmium tags-filter -O -o /tmp/named.osm.pbf data/lm.osm.pbf \
#     w/highway=motorway,trunk,primary,secondary,tertiary,residential,unclassified,living_street,service,pedestrian,motorway_link,trunk_link,primary_link,secondary_link,tertiary_link \
#     nwa/shop nwa/craft \
#     nwa/amenity=cafe,restaurant,fast_food,bakery,pub,bar,ice_cream,library,pharmacy,community_centre,marketplace,theatre,cinema,arts_centre,clinic,dentist,veterinary,post_office,school,kindergarten,childcare \
#     nwa/tourism=hotel,museum,gallery,guest_house
#   uv run --with osmium,shapely python3 tools/delivery_places.py /tmp/named.osm.pbf
import json, os, shutil, sys
import osmium
from shapely.geometry import LineString

SRC = sys.argv[1]
OUT = 'public/plugins/drive/data'
CELL = 4096
idx = json.load(open('public/tiles/index.json'))
(LAT_O, LON_O), (KX, KY) = idx['origin'], idx['k']
world = lambda lat, lon: ((lon - LON_O) * KX, (lat - LAT_O) * KY)

AMENITY = {'cafe', 'restaurant', 'fast_food', 'bakery', 'pub', 'bar', 'ice_cream', 'library', 'pharmacy', 'community_centre',
           'marketplace', 'theatre', 'cinema', 'arts_centre', 'clinic', 'dentist', 'veterinary', 'post_office', 'school',
           'kindergarten', 'childcare'}
TOURISM = {'hotel', 'museum', 'gallery', 'guest_house'}
SKIP = {'vacant', 'lottery', 'money lender', 'bookmaker', 'erotic', 'cannabis', 'weapons', 'tobacco', 'e-cigarette', 'funeral directors', 'gambling', 'pawnbroker', 'adult', 'no', 'yes'}

cells = {}


def cell(I, J):
    c = cells.get((I, J))
    if c is None: c = cells[(I, J)] = {'o': [I * CELL, J * CELL], 'n': {}, 's': [], 'k': {}, 'p': []}
    return c


class H(osmium.SimpleHandler):
    def place(self, tags, lat, lon):
        name = tags.get('name')
        if not name: return
        kind = tags.get('shop') or (tags.get('amenity') if tags.get('amenity') in AMENITY else None) \
            or (tags.get('tourism') if tags.get('tourism') in TOURISM else None) or tags.get('craft')
        if not kind: return
        kind = kind.split(';')[0].replace('_', ' ')
        if kind in SKIP: return
        x, y = world(lat, lon)
        c = cell(int(x // CELL), int(y // CELL))
        k = c['k'].setdefault(kind, len(c['k']))
        row = [round(x - c['o'][0]), round(y - c['o'][1]), name[:48], k]
        num, street = tags.get('addr:housenumber'), tags.get('addr:street')
        if num and street: row.append(f'{num} {street}'[:48])
        c['p'].append(row)

    def node(self, n):
        if n.location.valid(): self.place(n.tags, n.location.lat, n.location.lon)

    def way(self, w):
        try: pts = [(n.location.lat, n.location.lon) for n in w.nodes]
        except osmium.InvalidLocationError: return
        if len(pts) < 2: return
        if 'highway' in w.tags:
            name = w.tags.get('name')
            if not name: return
            line = LineString([world(*p) for p in pts]).simplify(2.0)
            xy = list(line.coords)
            # cut into runs per cell (a run keeps the point it crossed in from, so no piece is lost)
            run, at = [xy[0]], (int(xy[0][0] // CELL), int(xy[0][1] // CELL))
            for p in xy[1:]:
                run.append(p)
                c = (int(p[0] // CELL), int(p[1] // CELL))
                if c != at: self.street(at, name, run); run, at = [run[-2], p], c
            self.street(at, name, run)
            return
        if w.is_closed() and len(pts) >= 4:
            pts = pts[:-1]
            self.place(w.tags, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))

    def street(self, at, name, run):
        if len(run) < 2: return
        c = cell(*at)
        k = c['n'].setdefault(name[:40], len(c['n']))
        row = [k]
        for x, y in run: row += [round(x - c['o'][0]), round(y - c['o'][1])]
        c['s'].append(row)


H().apply_file(SRC, locations=True)
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)
total = 0
for (I, J), c in cells.items():
    c['n'] = list(c['n']); c['k'] = list(c['k'])
    c['p'].sort(key=lambda r: (r[1], r[0]))
    s = json.dumps(c, separators=(',', ':'), ensure_ascii=False)
    with open(f'{OUT}/{I}_{J}.json', 'w') as f: f.write(s)
    total += len(s.encode())
with open(f'{OUT}/index.json', 'w') as f: json.dump(sorted(f'{I}_{J}' for I, J in cells), f, separators=(',', ':'))  # so the game asks only for cells that exist
print(len(cells), 'cells,', sum(len(c['s']) for c in cells.values()), 'street runs,', sum(len(c['p']) for c in cells.values()), 'places,', total // 1024, 'KB')
