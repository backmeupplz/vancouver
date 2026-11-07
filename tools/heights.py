# A coarse height grid for the whole map (64 m cells), so heights are known everywhere before any tile has
# loaded: public/tiles/heights.bin = 'HGT1', x0, y1, cell (float32), w, h (uint32), then w*h int16 decimetres,
# row 0 north. Terrain from HRDEM (data/hr) where there is some, else MRDEM; the sea is flat at 0 m.
# Run: uv run --with numpy,scipy,rasterio python3 tools/heights.py
import glob, os, struct, sys, gzip
import numpy as np
from scipy import ndimage
sys.path.insert(0, os.path.dirname(__file__))
from world import extent, L1

C = 64.0
X0, Y0, X1, Y1 = extent()
W, H = int((X1 - X0) / C) + 2, int((Y1 - Y0) / C) + 2
mr = np.load('data/mrdem32.npz')
z = ndimage.zoom(np.nan_to_num(mr['z'], nan=0.0), 0.5, order=1)[:H, :W]
z = np.pad(z, ((0, max(0, H - z.shape[0])), (0, max(0, W - z.shape[1]))), mode='edge')
for f in glob.glob('data/hr/*.npz'):
    d = np.load(f)
    if 'dtm' not in d: continue
    i, j = map(int, os.path.basename(f)[:-4].split('_'))
    dtm = d['dtm']
    k = int(C / 2)  # 2 m cells per 64 m cell
    small = np.nanmean(dtm[: dtm.shape[0] // k * k, : dtm.shape[1] // k * k].reshape(dtm.shape[0] // k, k, dtm.shape[1] // k, k), axis=(1, 3))
    c0, r0 = int(round((i * L1 - X0) / C)), int(round((Y1 - (j + 1) * L1) / C))
    for r in range(small.shape[0]):
        for c in range(small.shape[1]):
            rr, cc = r0 + r, c0 + c
            if 0 <= rr < H and 0 <= cc < W and np.isfinite(small[r, c]): z[rr, cc] = small[r, c]
sea = np.load('data/sea.npz')
S = sea['sea'].astype(bool)
step = int(C / float(sea['cell']))
seaC = S[: S.shape[0] // step * step, : S.shape[1] // step * step].reshape(S.shape[0] // step, step, S.shape[1] // step, step).mean(axis=(1, 3)) > 0.5
seaC = np.pad(seaC, ((0, max(0, H - seaC.shape[0])), (0, max(0, W - seaC.shape[1]))))[:H, :W]
z = np.where(seaC, 0.0, z)
out = b'HGT1' + struct.pack('<fffII', X0, Y1, C, W, H) + np.clip(np.round(z * 10), -32768, 32767).astype('<i2').tobytes()
os.makedirs('public/tiles', exist_ok=True)
open('public/tiles/heights.bin', 'wb').write(gzip.compress(out, 9))
print(W, H, 'max', float(z.max()), 'bytes', os.path.getsize('public/tiles/heights.bin'))
