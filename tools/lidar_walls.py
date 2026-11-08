# What each wall looks like, from the City of Vancouver's 2022 LiDAR (tools/lidar_massing.py bakes it with the
# massing, into data/massing22.npz): the points on a wall plane, as an elevation image (along the wall x height),
# show its windows as gaps (glass returns little), its floor slabs and spandrels as rows, its piers as columns. From
# that, per wall: the window grid (bay width from the columns' rhythm, how much of a bay and of a storey the window
# fills), the kind of glazing (punched windows, vertical strips between piers, ribbon bands, a curtain wall, a blank
# wall), how tall the ground floor is (a storefront: glass from the sidewalk up, then the regular rhythm) and an
# awning or canopy over the sidewalk (points standing out of the wall plane a storey up). tiles.py hands it to the page
# per wall (public/core/tile-worker.js, materials.js draw it), stylized: no photo textures.
# Descriptor: 3 bytes a wall (0 = not seen):
#   d0: kind (bits 0-2: 1 punched, 2 vertical strips, 3 ribbon bands, 4 curtain wall, 5 blank), 8 awning,
#       ground floor height (bits 4-7: 0 none, k: 2.6 + 0.4 k m)
#   d1: bay width, 0.5 + 0.05 d1 m
#   d2: window width (bits 0-3) and height (bits 4-7) as fifteenths of the bay and the storey
import math
import numpy as np

CELL = 0.25          # m, the elevation image's cells
BAYS = (1.2, 9.0)    # m, window bays looked for
KINDS = dict(punched=1, strips=2, bands=3, curtain=4, blank=5)


def period(prof, lo, hi):
    """the strongest repeat of a 1D profile (cells) between lo and hi cells: (period in cells, strength 0..1)"""
    p = prof - prof.mean()
    n = len(p)
    if n < 2 * hi or not p.any(): return 0, 0.0
    f = np.fft.rfft(p, 2 * n)
    ac = np.fft.irfft(f * np.conj(f))[:n]
    ac /= ac[0] or 1
    best, k = 0.0, 0
    for lag in range(int(lo), int(hi) + 1):
        if 0 < lag < n - 1 and ac[lag] >= ac[lag - 1] and ac[lag] >= ac[lag + 1] and ac[lag] > best: best, k = float(ac[lag]), lag
    if not k: return 0, 0.0
    # refine to the sub-cell peak
    y0, y1, y2 = ac[k - 1], ac[k], ac[k + 1]
    d = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) if y0 - 2 * y1 + y2 else 0.0
    return k + float(np.clip(d, -0.5, 0.5)), best


def fold(prof, per):
    """a profile folded on its period (cells): the mean at each phase (8 phases), and the share that is gap (glass)"""
    ph = (np.arange(len(prof)) % per) / per
    b = np.minimum((ph * 8).astype(int), 7)
    m = np.array([prof[b == i].mean() if (b == i).any() else 0 for i in range(8)])
    lo, hi = m.min(), m.max()
    if hi - lo < 1e-6: return m, 0.0
    return m, float((m < (lo + hi) / 2).mean())


def wall_look(al, z, out, L, top, storey):
    """one wall: al (m along it), z (m above the ground), out (m out of its plane) of the building points near it ->
    (d0, d1, d2) or None when the LiDAR saw too little of it"""
    on = np.abs(out) < 0.6
    if on.sum() < max(60, 2.0 * L): return None
    top = min(top, float(np.percentile(z[on], 99)))  # this wall's own top (a podium's under a tower)
    if top < 3: return None
    nu, nz = int(L / CELL) + 1, int(top / CELL) + 1
    img = np.zeros((nz, nu))
    np.add.at(img, (np.clip((z[on] / CELL).astype(int), 0, nz - 1), np.clip((al[on] / CELL).astype(int), 0, nu - 1)), 1)
    seen_rows = img.sum(1) > 0
    # the regular part of the wall: from where the ground floor ends to a storey under the top
    st = storey or 3.2
    rows_d = img.sum(1) / max(1, nu)
    dens = on.sum() / (L * top)  # points a m2 on the wall plane
    # awning: points 0.8-4 m out of the plane, 2.4-5 m up, along a good part of the wall
    aw = (out > 0.8) & (out < 4.0) & (z > 2.4) & (z < 5.0)
    awning = aw.sum() > max(25, 4 * L) and len(np.unique((al[aw] / 1.0).astype(int))) > 0.4 * L
    if dens < 0.6: return (KINDS['curtain'] | (8 if awning else 0), 0, 0)  # glass all over: almost no returns
    # ground floor: the lowest rows that are emptier than the wall above them (shop glass), up to 7.4 m
    gf = 0
    z0 = int(2.0 / CELL); z1 = int(min(top - st, 7.6) / CELL)
    if z1 > z0 + 4:
        above = np.median(rows_d[z1:int(max(z1 + 1, (top - 1) / CELL))]) if int((top - 1) / CELL) > z1 else rows_d[z1:].mean()
        low = rows_d[z0:z1] < 0.5 * above
        if low[:int(1.6 / CELL)].mean() > 0.6:  # glass from about 2 m up
            k = int(np.argmax(~low)) if (~low).any() else len(low)
            gf = (z0 + k) * CELL + 0.6
    zr0 = int(max(gf, 3.0) / CELL); zr1 = int((top - min(2.0, 0.4 * st)) / CELL)
    if zr1 - zr0 < int(1.5 * st / CELL): zr0 = int(1.0 / CELL)
    body = img[zr0:zr1]
    if body.size == 0 or body.sum() < 30: return None
    col = body.sum(0); row = body.sum(1)
    pc, sc = period(col, BAYS[0] / CELL, min(BAYS[1] / CELL, len(col) / 2.2))
    pr, sr = period(row, 2.4 / CELL, min(5.4 / CELL, len(row) / 2.2))
    fill = float((body > 0).mean())
    # (sills, ledges and slab edges catch the grazing beams best: the gaps read wider than the glass; clamped)
    wx = float(np.clip(fold(col, pc)[1], 0.3, 0.85)) if pc and sc > 0.12 else 0.0
    wy = float(np.clip(fold(row, pr)[1] * 0.8, 0.35, 0.8)) if pr and sr > 0.12 else 0.0
    if sc < 0.12 and sr < 0.12: kind = 'blank' if fill > 0.55 and dens > 4 else 'punched'
    elif sc >= 0.12 and sr < 0.12: kind = 'strips'
    elif sr >= 0.12 and (sc < 0.12 or wx > 0.8): kind = 'bands'
    else: kind = 'punched'
    gcode = 0 if gf < 2.8 else int(np.clip(round((gf - 2.6) / 0.4), 1, 15))
    d0 = KINDS[kind] | (8 if awning else 0) | gcode << 4
    d1 = int(np.clip(round((pc * CELL - 0.5) / 0.05), 1, 255)) if pc and sc > 0.12 else 0
    d2 = int(np.clip(round(wx * 15), 0, 15)) | int(np.clip(round(wy * 15), 0, 15)) << 4
    return d0, d1, d2


def walls_of(ring, X, Y, Z, top, storey=0):
    """the walls of a ring (UTM, metres; heights above the ground): [(a, b, (d0, d1, d2))] for the walls the LiDAR saw"""
    ring = np.asarray(ring, float)
    s = 1 if 0.5 * np.sum(ring[:, 0] * np.roll(ring[:, 1], -1) - np.roll(ring[:, 0], -1) * ring[:, 1]) > 0 else -1  # ccw: outward (dy, -dx)
    out = []
    for k in range(len(ring)):
        a, b = ring[k], ring[(k + 1) % len(ring)]
        L = float(np.hypot(*(b - a)))
        if L < 4: continue
        u = (b - a) / L; n = np.array([u[1], -u[0]]) * s
        al = (X - a[0]) * u[0] + (Y - a[1]) * u[1]; dp = (X - a[0]) * n[0] + (Y - a[1]) * n[1]
        sel = (al > 0.3) & (al < L - 0.3) & (dp > -3) & (dp < 4.5) & (Z > 0.3) & (Z < top + 0.5)
        if sel.sum() < 40: continue
        w = sel & (dp < 3)
        h, ed = np.histogram(dp[w & (Z > 3)] if (w & (Z > 3)).sum() > 20 else dp[w], bins=np.arange(-3, 3.01, 0.25))
        f0 = ed[np.argmax(h)] + 0.125  # the wall plane (OSM outlines are often a metre or two off)
        d = wall_look(al[sel], Z[sel], dp[sel] - f0, L, top, storey)
        if d: out.append((a + n * f0, b + n * f0, d))
    return out


def check():
    """a synthetic wall: punched windows 1.4 m wide in 3 m bays, 1.6 m tall in 3.2 m storeys, a 5 m storefront"""
    rng = np.random.default_rng(1)
    al = rng.uniform(0, 30, 60000); z = rng.uniform(0, 32, 60000)
    win = ((al % 3.0) > 0.8) & ((al % 3.0) < 2.2) & (((z - 5) % 3.2) > 1.0) & (((z - 5) % 3.2) < 2.6) & (z > 5)
    shop = (z > 0.6) & (z < 4.6) & ((al % 6) > 0.4)
    keep = ~win & ~shop
    al, z = al[keep], z[keep]
    out = rng.normal(0, 0.1, len(al))
    d0, d1, d2 = wall_look(al, z, out, 30.0, 32.0, 3.2)
    kind, gf, bay = d0 & 7, 2.6 + 0.4 * (d0 >> 4), 0.5 + 0.05 * d1
    print('kind', kind, 'ground floor', gf, 'bay', bay, 'wx', (d2 & 15) / 15, 'wy', (d2 >> 4) / 15)
    assert kind == 1 and abs(bay - 3.0) < 0.2 and 4.2 < gf < 5.8, (d0, d1, d2)
    assert 0.3 < (d2 & 15) / 15 < 0.65 and 0.35 < (d2 >> 4) / 15 < 0.7
    print('walls check ok')


if __name__ == '__main__':
    check()
