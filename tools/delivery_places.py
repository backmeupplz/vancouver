# Named shops, cafés and other places for the delivery minigame (public/plugins/delivery/places.json).
# Source: OpenStreetMap (© OpenStreetMap contributors, ODbL). Run from the repo root:
#   osmium tags-filter -O -o /tmp/named.osm.pbf data/lm.osm.pbf nwa/shop nwa/craft \
#     nwa/amenity=cafe,restaurant,fast_food,bakery,pub,bar,ice_cream,library,pharmacy,community_centre,marketplace,theatre,cinema,arts_centre,clinic,dentist,veterinary,post_office,school,kindergarten,childcare \
#     nwa/tourism=hotel,museum,gallery,guest_house
#   uv run --with osmium python3 tools/delivery_places.py /tmp/named.osm.pbf
import json, sys, osmium

SRC = sys.argv[1]
OUT = 'public/plugins/delivery/places.json'
AMENITY = {'cafe', 'restaurant', 'fast_food', 'bakery', 'pub', 'bar', 'ice_cream', 'library', 'pharmacy', 'community_centre',
           'marketplace', 'theatre', 'cinema', 'arts_centre', 'clinic', 'dentist', 'veterinary', 'post_office', 'school',
           'kindergarten', 'childcare'}
TOURISM = {'hotel', 'museum', 'gallery', 'guest_house'}
SKIP = {'vacant', 'lottery', 'money lender', 'bookmaker', 'erotic', 'cannabis', 'weapons', 'tobacco', 'e-cigarette', 'funeral directors', 'gambling', 'pawnbroker', 'adult', 'no', 'yes'}


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.out, self.kinds = [], {}

    def add(self, tags, lat, lon):
        name = tags.get('name')
        if not name: return
        kind = tags.get('shop') or (tags.get('amenity') if tags.get('amenity') in AMENITY else None) \
            or (tags.get('tourism') if tags.get('tourism') in TOURISM else None) or tags.get('craft')
        if not kind: return
        kind = kind.split(';')[0].replace('_', ' ')
        if kind in SKIP: return
        k = self.kinds.setdefault(kind, len(self.kinds))
        num, street = tags.get('addr:housenumber'), tags.get('addr:street')
        row = [round(lat * 1e5), round(lon * 1e5), name[:48], k]
        if num and street: row.append(f'{num} {street}'[:48])
        self.out.append(row)

    def node(self, n):
        if n.location.valid(): self.add(n.tags, n.location.lat, n.location.lon)

    def way(self, w):
        if not w.is_closed() or len(w.nodes) < 4: return
        try: pts = [(n.location.lat, n.location.lon) for n in list(w.nodes)[:-1]]
        except osmium.InvalidLocationError: return
        self.add(w.tags, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


h = H()
h.apply_file(SRC, locations=True)
h.out.sort(key=lambda r: (r[0], r[1]))
with open(OUT, 'w') as f:
    json.dump({'source': '© OpenStreetMap contributors (ODbL)', 'kinds': list(h.kinds), 'places': h.out}, f, separators=(',', ':'), ensure_ascii=False)
print(len(h.out), 'places,', len(h.kinds), 'kinds')
