# What the bake tools share. The map's frame: world metres east (x) and north (y) of an origin in downtown
# Vancouver, equirectangular. Heights are real elevations in metres (CGVD2013, from NRCan HRDEM / MRDEM).
# Also: OpenStreetMap line kinds, the per-tile inputs on disk (data/feat, data/hr), ring databases, retries, what an
# incremental bake keys its outputs on (digest, code_key, stamps) and the CPU slots every bake process shares (cpu_slot).
# Light on purpose (the standard library; numpy only inside the functions that need it): importing it costs
# nothing, unlike tiles.py, which loads its inputs.
import hashlib, math, os, pickle, time
from contextlib import contextmanager

LAT_O, LON_O, SC = 49.28606407, -123.10901045, 0.99744659
KX = 111320 * math.cos(math.radians(49.2845)) / SC  # metres per degree of longitude
KY = 110574 / SC                                     # metres per degree of latitude
BBOX = (48.99, -123.33, 49.48, -122.40)              # S, W, N, E: the Lower Mainland and the North Shore mountains
L0, L1, L2 = 1024, 4096, 16384                       # tile sizes per level of detail, metres
SEA0, SEA_RISE = 0.02, 0.7  # the level sea (core/util.js): the lowest tide's surface and how far the highest rises over it
SEA_HIGH = SEA0 + SEA_RISE  # high water
HR = 2.0                                             # HRDEM cell (data/hr), metres


def xy(lat, lon):
    return ((lon - LON_O) * KX, (lat - LAT_O) * KY)


def latlon(x, y):
    return (LAT_O + y / KY, LON_O + x / KX)


def extent():
    x0, y0 = xy(BBOX[0], BBOX[1]); x1, y1 = xy(BBOX[2], BBOX[3])
    return x0, y0, x1, y1


def all_tiles():
    """every 4096 m tile (i, j) over BBOX"""
    x0, y0, x1, y1 = extent()
    return [(i, j) for i in range(int(x0 // L1), int(x1 // L1) + 1) for j in range(int(y0 // L1), int(y1 // L1) + 1)]


def tile_args(argv):
    """'i_j' command-line arguments -> [(i, j)]"""
    return [tuple(map(int, a.split('_'))) for a in argv]


# ---------------------------------------------------------------- ground classes (draw order = list order; the page's GROUND_COLOURS)
GROUND = ['land', 'residential', 'commercial', 'industrial', 'farmland', 'grass', 'golf', 'scrub', 'wetland', 'forest', 'sand',
          'rock', 'construction', 'apron', 'parking', 'plaza', 'playground', 'pitch', 'track', 'water', 'pier', 'pool', 'snow',
          'trail', 'walk', 'cycle', 'ballast', 'sidewalk', 'blvd', 'road', 'arterial']  # streets last: they win where things overlap
GI = {k: i for i, k in enumerate(GROUND)}


def read_tile(path):
    """a baked tile -> (bytes, ox, oy, size, {section tag: (offset, length)}, ring): ring(o) reads the delta-encoded
    points at o -> (world x, north array, next offset)"""
    import gzip, struct
    import numpy as np
    b = gzip.decompress(open(path, 'rb').read())
    ox, oy, size = struct.unpack_from('<fff', b, 8)
    k = (2 * size) / 32766
    sec, o = {}, 20
    while o < len(b):
        tag = b[o:o + 4].decode(); n = struct.unpack_from('<I', b, o + 4)[0]; sec[tag] = (o + 8, n); o += 8 + n

    def ring(o):
        n = struct.unpack_from('<I', b, o)[0]
        d = np.frombuffer(b, '<i2', 2 * n, o + 4).reshape(-1, 2).astype(np.int64).cumsum(0)
        return d * k + (ox, oy), o + 4 + 4 * n
    return b, ox, oy, size, sec, ring


# ---------------------------------------------------------------- roads and other lines
# kind ids shared with the page (KIND in public/core/tile-worker.js)
KINDS = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living', 'pedestrian', 'footway', 'cycleway',
         'path', 'steps', 'track', 'rail', 'lightrail', 'runway', 'taxiway']
KI = {k: i for i, k in enumerate(KINDS)}
DRIVE = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living'}
# amenities that count as shops (a storefront ground floor)
SHOP_AMENITY = {'restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'bank', 'pharmacy', 'ice_cream', 'clinic', 'dentist', 'doctors', 'post_office',
                'library', 'cinema', 'theatre', 'nightclub', 'food_court', 'bureau_de_change', 'veterinary', 'marketplace', 'community_centre'}


SLAB = 0.6  # a tunnel's walls and roof, m (tiles.py, the page's tile-worker.js tubes()): 0.6 m wider than its way each side


def tube_h(k):
    """clear height inside a tunnel of this kind, m (the page's tile-worker.js TUBE_H)"""
    return 6.0 if k in ('rail', 'lightrail') else 5.0 if k in DRIVE else 3.0


def line_kind(t):
    h = t.get('highway', ''); r = t.get('railway', ''); a = t.get('aeroway', '')
    if h:
        h = h.replace('_link', '')
        if h in ('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'pedestrian', 'footway', 'cycleway', 'path', 'steps', 'track'): return h
        if h in ('unclassified', 'road'): return 'residential'
        if h == 'busway': return 'service'  # bus-only (exchanges, loops): the bus plugin drives them, traffic doesn't (road_pieces)
        if h == 'living_street': return 'living'
        if h in ('bridleway', 'corridor'): return 'path'
        return None
    if r in ('rail', 'preserved', 'narrow_gauge') and t.get('usage') != 'industrial' or r == 'rail': return 'rail'
    if r in ('light_rail', 'subway', 'tram', 'monorail'): return 'lightrail'
    if a in ('runway', 'taxiway'): return a
    return None


def hnum(v):
    """a number from an OSM tag ('12 m', '3;4', '2,5'), or None"""
    try: return float(str(v).split(';')[0].replace('m', '').replace(',', '.').strip())
    except (ValueError, TypeError): return None


def densify(pts, step):
    out = [pts[0]]
    for p, q in zip(pts, pts[1:]):
        L = math.dist(p, q); n = max(1, int(L / step))
        for k in range(1, n + 1): out.append((p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n))
    return out


# ---------------------------------------------------------------- per-tile inputs on disk
def load_feat(i, j):
    """the OpenStreetMap features of a 4096 m tile (osm_split.py: data/feat/<i>_<j>.pkl), {} if there are none"""
    p = f'data/feat/{i}_{j}.pkl'
    if not os.path.exists(p): return {}
    with open(p, 'rb') as f: return pickle.load(f)


HR_CACHE = {}
HR_KEEP = 12  # tiles kept loaded (32 MB each); tiles.py's deck pass keeps them all: it reads them over and over


def hr_tile(i, j):
    """(dsm, dtm) of a 4 km HRDEM tile (hrdem.py: data/hr/<i>_<j>.npz), or None"""
    import numpy as np
    if (i, j) not in HR_CACHE:
        p = f'data/hr/{i}_{j}.npz'
        d = np.load(p) if os.path.exists(p) else None
        HR_CACHE[(i, j)] = (d['dsm'], d['dtm']) if d is not None and 'dsm' in d and 'dtm' in d else None
        if len(HR_CACHE) > HR_KEEP: HR_CACHE.pop(next(iter(HR_CACHE)))
    return HR_CACHE[(i, j)]


def hr_lookup(xs, ys, k):
    """LiDAR surface (k=0) or ground (k=1) at world points, NaN where there is none"""
    import numpy as np
    xs, ys = np.asarray(xs, float).ravel(), np.asarray(ys, float).ravel()
    out = np.full(xs.shape, np.nan, np.float32)
    ti, tj = np.floor(xs / L1).astype(int), np.floor(ys / L1).astype(int)
    for i, j in set(zip(ti.tolist(), tj.tolist())):
        a = hr_tile(i, j)
        if a is None: continue
        sel = (ti == i) & (tj == j)
        r = ((((j + 1) * L1) - ys[sel]) / HR).astype(int).clip(0, a[k].shape[0] - 1)
        c = ((xs[sel] - i * L1) / HR).astype(int).clip(0, a[k].shape[1] - 1)
        out[sel] = a[k][r, c]
    return out


def save_rings(path, rings, **cols):
    """a footprint database (roofs.py, facades.py, mapillary.py; read by roofs.ring_db): every ring's points in a row
    (rc), where each starts (ro), and per ring a value of each of cols"""
    import numpy as np
    rc = np.array([p for r in rings for p in r], np.float32)
    ro = np.cumsum([0] + [len(r) for r in rings]).astype(np.int32)
    np.savez_compressed(path, rc=rc, ro=ro, **cols)


def retry(fn, tries=4, wait=5):
    """fn(), tried again after wait, 2 wait, … seconds when it raises; the last error is raised"""
    for k in range(tries):
        try: return fn()
        except Exception:
            if k == tries - 1: raise
            time.sleep(wait * (k + 1))


# ---------------------------------------------------------------- incremental bakes: what an output was made from
HERE = os.path.dirname(os.path.abspath(__file__))


def digest(*parts):
    """a short hex digest of bytes, numpy arrays (their bytes, shape and type) and anything else by its repr"""
    h = hashlib.sha1()
    for p in parts:
        if hasattr(p, 'tobytes'): h.update(repr((p.shape, p.dtype.str)).encode()); p = p.tobytes()
        h.update(p if isinstance(p, (bytes, bytearray, memoryview)) else repr(p).encode()); h.update(b'\0')
    return h.hexdigest()[:16]


def file_digest(path):
    """a file's content digest, '' when it isn't there"""
    if not os.path.exists(path): return ''
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        while b := f.read(1 << 22): h.update(b)
    return h.hexdigest()[:16]


def files_digest(paths):
    """one digest of many files' contents (read in threads: hashlib lets go of the GIL)"""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(8) as ex: return digest(*[(os.path.basename(p), h) for p, h in zip(paths, ex.map(file_digest, paths))])


_DEFS = {}


def _defs(path):
    """a tools module's top-level names -> their source (def, class, assignments), and its names imported from other
    tools modules -> (that module's path, name)"""
    import ast
    if path not in _DEFS:
        src = open(path).read(); d, imp = {}, {}
        for node in ast.parse(src).body:
            seg = ast.get_source_segment(src, node)
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)): d[node.name] = d.get(node.name, '') + seg + '\n'
            elif isinstance(node, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
                for t in node.targets if isinstance(node, ast.Assign) else [node.target]:
                    for n in ast.walk(t):
                        if isinstance(n, ast.Name): d[n.id] = d.get(n.id, '') + seg + '\n'
            elif isinstance(node, ast.ImportFrom): imp.update(_tools_imports(node))
        _DEFS[path] = d, imp
    return _DEFS[path]


def _tools_imports(node):
    p = f'{HERE}/{node.module}.py'
    return {a.asname or a.name: (p, a.name) for a in node.names} if node.module and os.path.exists(p) else {}


def code_key(path, *names):
    """a digest of these top-level functions of a tools module and of everything at module level they use (functions,
    constants, the lines that load data), followed into the other tools modules: a stage's code version, which a
    change anywhere else in the code leaves alone"""
    return digest(*sorted(_closure(path, names)[0]))


def code_data(path, *names):
    """the data files ('data/…' string constants) that code reads"""
    return _closure(path, names)[1]


def _closure(path, names):
    import ast
    todo, seen, src, data = [(os.path.abspath(path), n) for n in names], set(), [], set()
    while todo:
        p, n = todo.pop()
        if (p, n) in seen: continue
        seen.add((p, n))
        d, imp = _defs(p)
        if n not in d:
            if n in imp: todo.append(imp[n])
            continue  # a local, a builtin, a library
        src.append(f'{os.path.basename(p)}:{n}\n{d[n]}')
        for m in ast.walk(ast.parse(d[n])):
            if isinstance(m, ast.Name): todo.append((p, m.id))
            elif isinstance(m, ast.ImportFrom): todo += _tools_imports(m).values()  # a function's own imports
            elif isinstance(m, ast.Constant) and isinstance(m.value, str) and m.value.startswith('data/'): data.add(m.value)
    return src, data


def stamp(path, key=None):
    """the key a stage's output at path was last made with ('' if none); with key: record it (path.key, written last)"""
    if key is None:
        try: return open(path + '.key').read()
        except OSError: return ''
    open(path + '.key.tmp', 'w').write(key); os.replace(path + '.key.tmp', path + '.key')


def manifest(out):
    """out/manifest.json: what each 4 km tile was last baked from (cells: key), each file's content and the bake that
    last changed it (files: path -> [digest, time])"""
    import json
    try: return json.load(open(f'{out}/manifest.json'))
    except (OSError, ValueError): return {}


def save_manifest(out, m):
    import json
    os.makedirs(out, exist_ok=True)
    json.dump(m, open(f'{out}/manifest.json.tmp', 'w')); os.replace(f'{out}/manifest.json.tmp', f'{out}/manifest.json')


VERSION = 2  # the tile format (tiles.py Out, the page's tile-worker.js parse())


def write_index(out):
    """out/index.json, the bake's table of contents (tiles.py, heights.py), written last: the tiles there and, per tile
    (v0, v1) and for heights.bin and base.png (vh, vb), the time of the bake that last changed it, its ?v= on the page,
    so after a bake browsers fetch only the tiles that changed"""
    import json
    m = manifest(out); old = m.get('files', {}); files = {}
    now = int(time.time())
    def ver(rel):
        h = file_digest(f'{out}/{rel}')
        files[rel] = old[rel] if rel in old and old[rel][0] == h else [h, now]
        return files[rel][1]
    ls = lambda lv: sorted(f[:-4] for f in os.listdir(f'{out}/{lv}') if f.endswith('.bin')) if os.path.isdir(f'{out}/{lv}') else []
    l0, l1 = ls(0), ls(1)
    idx = {'version': VERSION, 'origin': [LAT_O, LON_O], 'k': [KX, KY], 'extent': extent(), 'sizes': [L0, L1], 'ground': GROUND, 'kinds': KINDS,
           'l0': l0, 'l1': l1, 'built': now, 'v0': [ver(f'0/{n}.bin') for n in l0], 'v1': [ver(f'1/{n}.bin') for n in l1]}
    for k, f in (('vh', 'heights.bin'), ('vb', 'base.png')):
        if os.path.exists(f'{out}/{f}'): idx[k] = ver(f)
    m['files'] = files; save_manifest(out, m)
    json.dump(idx, open(f'{out}/index.json.tmp', 'w')); os.replace(f'{out}/index.json.tmp', f'{out}/index.json')
    print('index:', sum(v == now for v in idx['v0'] + idx['v1']), 'of', len(l0) + len(l1), 'tiles changed', flush=True)


def write_if_changed(path, data):
    """write data to path unless it already holds exactly that (its mtime then stays, so rsync skips it) -> changed"""
    try:
        if os.path.getsize(path) == len(data) and open(path, 'rb').read() == data: return False
    except OSError: pass
    open(path + '.tmp', 'wb').write(data); os.replace(path + '.tmp', path)
    return True


# ---------------------------------------------------------------- CPU slots: how many bake jobs run at once
SLOTS = os.environ.get('SLOTS', '/tmp/vancouver-bake-slots')  # shared by every bake process (bake-all, lidar_stream)


def cpus():
    return len(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else os.cpu_count()


def spare_cores(held):
    """cores the rest of the machine leaves to the bake: on Linux the share of the CPU time over 2 s that did not go to
    un-niced work (the bakes run at nice 19, so what production uses is user + system); elsewhere the load average
    less the bake jobs running (held). The host's figures, from inside a container too."""
    try:
        a = list(map(int, open('/proc/stat').readline().split()[1:9])); time.sleep(2)
        b = list(map(int, open('/proc/stat').readline().split()[1:9]))
    except OSError: return cpus() - max(0.0, os.getloadavg()[0] - held)
    user, nice, system, idle, iowait, irq, softirq, steal = (y - x for x, y in zip(a, b))
    return cpus() * (1 - (user + system + irq + softirq + steal) / max(1, sum(y - x for x, y in zip(a, b))))


@contextmanager
def cpu_slot(cap=None):
    """run a CPU-heavy job (a 4 km tile, a LiDAR tile) in a slot that every bake process on the machine shares
    (tiles.py, lidar_massing.py, lidar_stream.py, each in its container: SLOTS is a shared directory), while all of
    them together hold fewer than `cap` (PROCS) and than there are spare cores (spare_cores). When production gets busy the next jobs wait
    (a running one finishes; nice 19 lets production win meanwhile), when it is quiet more of them run."""
    import fcntl
    cap = cap or int(os.environ.get('PROCS') or cpus())
    os.makedirs(SLOTS, exist_ok=True)
    while True:
        fds = [os.open(f'{SLOTS}/{k}', os.O_RDWR | os.O_CREAT, 0o666) for k in range(max(cap, cpus()))]  # every process sees all the jobs
        free = []
        for k, fd in enumerate(fds):
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); free.append(k)
            except OSError: pass
        held = len(fds) - len(free)
        for k in free: fcntl.flock(fds[k], fcntl.LOCK_UN)  # (not held while measuring)
        allowed = max(1, min(cap, round(spare_cores(held))))
        mine = None
        for k in free:
            if held >= allowed: break
            try: fcntl.flock(fds[k], fcntl.LOCK_EX | fcntl.LOCK_NB); mine = k; break
            except OSError: held += 1  # taken meanwhile
        for k, fd in enumerate(fds):
            if k != mine: os.close(fd)
        if mine is not None: break
        time.sleep(3)
    try: yield
    finally:
        fcntl.flock(fds[mine], fcntl.LOCK_UN); os.close(fds[mine])


FINE = 2  # metres: the fine lattice under the streets (section TFIN), offsets over the 8 m grid where it can't follow them
FB = 16  # its nodes per block side: a detail tile's 513 x 513 nodes in 33 x 33 blocks, only those that move stored


def fine_grid(G, sec):
    """a detail tile's drawn terrain on the fine lattice: its grid G (n x n) upsampled to 2 m (bilinear: the same surface)
    plus section TFIN's offsets (bytes, or None)"""
    import struct
    import numpy as np
    from scipy import ndimage
    n = L0 // FINE + 1
    t = np.linspace(0, G.shape[0] - 1, n)
    out = ndimage.map_coordinates(np.asarray(G, float), np.meshgrid(t, t, indexing='ij'), order=1)
    if sec:
        nb = -(-n // FB); cnt = struct.unpack_from('<H', sec, 0)[0]; o = 2
        for _ in range(cnt):
            b = struct.unpack_from('<H', sec, o)[0]; v = np.frombuffer(sec, '<i2', FB * FB, o + 2).reshape(FB, FB) / 100.0; o += 2 + 2 * FB * FB
            r0, c0 = (b // nb) * FB, (b % nb) * FB
            out[r0:r0 + FB, c0:c0 + FB] += v[:n - r0, :n - c0]
    return out


def under_reach(w, band):  # metres from a deck's centre line it covers what is under it (its strip, its railings' or its sidewalk band's)
    return w / 2 + (2.5 if band else 0.6)
