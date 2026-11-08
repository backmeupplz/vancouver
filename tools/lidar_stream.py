# Streams the Lower Mainland LiDAR (data/lidar_lm/urls.json) into building massing without keeping the 438 GB:
# per tile download -> `lidar_massing.py tile` (massing and each wall's look) -> keep its small data/massing_lm/<tile>.npz
# -> delete the tile.
# Resumable (done tiles are skipped), failed tiles retry with backoff, a few hosts-polite downloads at once. Tiles closest
# to the city centre go first (the inner ring: Burnaby, Richmond, New Westminster, the Tri-Cities, North Van), the
# "optional_*" sections are skipped. Progress: <out>/progress.log. Then: python3 tools/lidar_massing.py merge
# Run (inside the bake image, see tools/lidar_stream.sh): python3 tools/lidar_stream.py urls.json OUT_DIR [workers]
import json, os, re, struct, subprocess, sys, time, zipfile, zlib
from concurrent.futures import ThreadPoolExecutor
from threading import Lock, BoundedSemaphore
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
CENTRE = (49.25, -123.10)
HOSTS = {}
lock = Lock()
stat = dict(done=0, skipped=0, failed=0, bytes=0)


def host_slot(url):
    h = urlparse(url).netloc
    return HOSTS.setdefault(h, BoundedSemaphore(2 if 'arcgis' in h else 3))  # polite: few connections per host


def entries(urls):
    out = []
    for src, items in urls['sources'].items():
        slug = re.sub(r'\W+', '_', src).strip('_')
        for e in items:
            e = dict(url=e) if isinstance(e, str) else dict(e)
            base = e.get('name') or os.path.basename(e['url'])
            e['id'] = f"{slug}__{re.sub(r'[.]copc$|[.](laz|las)$', '', re.sub(r'[.]copc[.]laz$', '', base))}"
            e['ext'] = 'las' if e.get('deflate') else 'laz'
            out.append(e)
    return out


def curl(e, dest, rng=None):
    cmd = ['curl', '-fsSL', '--retry', '3', '--retry-delay', '5', '--connect-timeout', '30', '-o', dest, e['url']]
    r = rng or e.get('range')
    if r: cmd[1:1] = ['-r', r]
    subprocess.run(cmd, check=True)


def fetch(e, dest):
    with host_slot(e['url']):
        if not e.get('deflate'): return curl(e, dest)
        curl(e, dest + '.z')
    d = zlib.decompressobj(-15)
    with open(dest + '.z', 'rb') as f, open(dest, 'wb') as g:
        while b := f.read(1 << 22): g.write(d.decompress(b))
        g.write(d.flush())
    os.remove(dest + '.z')


def head(e, tmp):
    """the tile's centre lat/lon from the first 4 KB of its LAS header"""
    from pyproj import Transformer
    lo = int(e['range'].split('-')[0]) if e.get('range') else 0
    p = f"{tmp}/h_{e['id']}"
    with host_slot(e['url']): curl(e, p, f'{lo}-{lo + 4095}')
    b = open(p, 'rb').read(); os.remove(p)
    b = zlib.decompressobj(-15).decompress(b) if e.get('deflate') else b
    v = struct.unpack('<6d', b[179:227])
    lon, lat = Transformer.from_crs('EPSG:3157', 'EPSG:4326', always_xy=True).transform((v[0] + v[1]) / 2, (v[2] + v[3]) / 2)
    return lat, lon


def order(es, out):
    f = f'{out}/order.json'
    pos = json.load(open(f)) if os.path.exists(f) else {}
    todo = [e for e in es if e['id'] not in pos]
    def h(e):
        for k in range(4):
            try: return e['id'], head(e, out)
            except Exception: time.sleep(5 * 2 ** k)
        return e['id'], None
    with ThreadPoolExecutor(6) as ex:
        for i, p in ex.map(h, todo): pos[i] = p
    json.dump(pos, open(f, 'w'))
    d = lambda e: (lambda p: 1e9 if p is None else ((p[0] - CENTRE[0]) * 111) ** 2 + ((p[1] - CENTRE[1]) * 73) ** 2)(pos.get(e['id']))
    return sorted(es, key=d)


def log(out, total, msg=''):
    with lock:
        s = f"{time.strftime('%F %T')} {stat['done'] + stat['skipped']}/{total} done ({stat['skipped']} already), {stat['failed']} failed, {stat['bytes'] / 1e9:.1f} GB fetched {msg}"
        open(f'{out}/progress.log', 'a').write(s + '\n')


def one(e, out, scratch, total):
    res = f"{out}/{e['id']}.npz"
    if os.path.exists(res) and 'wseg.npy' in zipfile.ZipFile(res).namelist():  # (one from before the walls' looks is redone)
        stat['skipped'] += 1; return
    src = f"{scratch}/{e['id']}.{e['ext']}"
    for k in range(4):
        try:
            fetch(e, src)
            n = os.path.getsize(src)
            subprocess.run(['nice', '-n', '19', sys.executable, f'{HERE}/lidar_massing.py', 'tile', src, res + '.tmp.npz'], check=True, cwd=os.path.dirname(HERE))
            os.replace(res + '.tmp.npz', res)
            with lock: stat['done'] += 1; stat['bytes'] += n
            log(out, total, e['id']); break
        except Exception as ex:
            time.sleep(30 * 2 ** k)
            if k == 3:
                with lock: stat['failed'] += 1
                open(f'{out}/failures.log', 'a').write(f"{e['id']} {e['url']} {ex}\n"); log(out, total, 'FAILED ' + e['id'])
        finally:
            for f in (src, src + '.z'):
                if os.path.exists(f): os.remove(f)


if __name__ == '__main__':
    urls, out = sys.argv[1], sys.argv[2]
    workers = int(sys.argv[3]) if len(sys.argv) > 3 else 5
    os.makedirs(out, exist_ok=True); scratch = f'{out}/scratch'; os.makedirs(scratch, exist_ok=True)
    es = order(entries(json.load(open(urls))), out)
    log(out, len(es), 'start')
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(lambda e: one(e, out, scratch, len(es)), es))
    log(out, len(es), 'finished')
