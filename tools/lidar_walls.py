# What each wall looks like, from the City of Vancouver's 2022 LiDAR (tools/lidar_massing.py bakes it with the
# massing, into data/massing22.npz). The building points on a wall's plane bunch where it is solid (piers, sills, slab
# edges, spandrels: glass returns little), so their rhythm along the wall is the window bay and up it the storey; folded
# on those, the emptier share of a period is how wide and tall the window is. Which of the two rhythms is there says the
# glazing: punched windows (both), vertical strips between piers (only along), ribbon bands (only up), a curtain wall
# (glass all over: few returns, or a fine grid of thin mullions), a blank wall (dense, no rhythm). The returns'
# intensity (the laser's own near-infrared, unlike the survey's photo colours, which clip to white in the sun and go
# sky-blue in the shade), brought to one scale per flight (lidar_massing.py Cloud), says whether the spandrels are dark (tinted glass,
# dark metal) or light (white panels, pale stone). Any LiDAR: the City's 2022 set (about 25 roof returns a m2) and the
# regional ones (6-57, tools/lidar_stream.py) alike; the counts scale with the set's density, and a rhythm has to stand
# above the noise of the points there are. tiles.py hands it to the page per wall (public/core/tile-worker.js aFac, materials.js), stylized.
# (A storefront's height and awnings were tried here too: too few returns under the street trees and canopies to tell.)
# Descriptor: 4 bytes a wall (all 0: not seen)
#   d0: glazing (bits 0-2: 1 punched, 2 vertical strips, 3 ribbon bands, 4 curtain wall, 5 blank), spandrel tone
#       (bits 3-4: 0 the wall's own colour, 1 dark, 2 light)
#   d1: bay width, 0.5 + 0.05 d1 m (0: no rhythm along)
#   d2: window width (bits 0-3) and height (bits 4-7) as fifteenths of the bay and the storey
#   d3: storey height, 2 + 0.025 d3 m (0: no rhythm up)
# Run: python3 tools/lidar_walls.py   (self-test on synthetic walls)
import math
import numpy as np

KINDS = dict(punched=1, strips=2, bands=3, curtain=4, blank=5)
BAYS = np.arange(1.2, 6.0, 0.02)     # m, window bays looked for
STOREYS = np.arange(2.5, 4.9, 0.02)  # m, storeys looked for
STRONG = 0.1                         # Rayleigh strength from which a rhythm counts (noise: about 0.03)
DARK, LIGHT = 60, 190                # return intensity (on the City's downtown scale: lidar_massing.py Cloud) under / over which a
                                     # wall is dark (tinted glass, dark metal) / light (white concrete, pale stone)
REF_PD = 25                          # roof returns a m2 in the City's 2022 set, which the thresholds below are set for


def rhythm(x, periods):
    """the period (m) the positions x repeat at most strongly, and how strongly (0..1, Rayleigh)"""
    if len(x) < 100: return 0.0, 0.0
    x = x[:: max(1, len(x) // 5000)]
    r = np.abs(np.exp(2j * np.pi * x[:, None] / periods[None, :]).mean(0))
    k = int(np.argmax(r))
    return float(periods[k]), float(r[k])


def opening(x, per):
    """the share of a period that is window: of 16 phases, those emptier than halfway between the emptiest and the
    busiest (the solid parts catch the grazing beams best, so the gaps read a little wide: clamped)"""
    h = np.bincount(np.minimum((np.mod(x, per) / per * 16).astype(int), 15), minlength=16).astype(float)
    return float(np.clip((h < 0.5 * (h.min() + h.max())).mean(), 0.25, 0.75))


def wall_look(al, z, out, inten, L, top, pd=REF_PD):
    """one wall: al (m along it), z (m above its foot), out (m out of its plane), inten (the returns' intensity) of the
    building points near it (all 0: the set has none); pd the roof returns a m2 (sparser sets see fewer wall returns)
    -> (d0, d1, d2, d3), or None when the LiDAR saw too little of it"""
    k = pd / REF_PD
    on = np.abs(out) < 0.6
    if on.sum() < max(40, 2.0 * L * k): return None
    top = min(top, float(np.percentile(z[on], 99)))  # this wall's own top (a podium's under a tower)
    if top < 3: return None
    body = on & (z > min(3.0, top / 3)) & (z < top - 1.0)  # not the ground floor nor the parapet
    if body.sum() < 40: return None
    a, h = al[body], z[body]
    dens = on.sum() / (L * top) / k  # returns a m2 of wall, as the City's set would see it
    bay, rc = rhythm(a, BAYS[BAYS < L / 3]) if L > 3.6 else (0.0, 0.0)  # three bays at least
    st, rr = rhythm(h, STOREYS[STOREYS < (top - 3) / 2]) if top > 8 else (0.0, 0.0)
    strong = max(STRONG, 2.5 / math.sqrt(min(body.sum(), 5000)))  # over the noise of a few points (sparse sets)
    col, row = rc >= 1.5 * strong, rr >= strong  # (the piers' rhythm is the fainter: the scan lines cross the wall slantwise)
    wx = opening(a, bay) if col else 0.0
    wy = opening(h, st) if row else 0.0
    i = float(np.median(inten[on])) if inten[on].any() else (DARK + LIGHT) / 2  # (no intensity: neither)
    # glass returns little, and weakly: a curtain wall. Masonry and concrete: punched windows, unless one rhythm is
    # plainly there and the other plainly not (the piers catch the beams better than the slab edges, and the other way
    # round, often enough that the weaker rhythm alone says little)
    if dens < 0.6 or i < DARK and dens < 4: kind = 'curtain'
    elif rc >= 3 * strong and rr < 1.2 * strong: kind = 'strips'
    elif rr >= 4 * strong and rc < 0.8 * strong: kind = 'bands'
    elif not col and not row and dens > 4 and L > 12 and top > 8: kind = 'blank'  # (where both rhythms had room to show)
    else: kind = 'punched'
    tone = 1 if i < DARK else 2 if i > LIGHT else 0
    d0 = KINDS[kind] | tone << 3
    d1 = int(np.clip(round((bay - 0.5) / 0.05), 1, 255)) if col else 0
    d2 = int(np.clip(round(wx * 15), 0, 15)) | int(np.clip(round(wy * 15), 0, 15)) << 4
    d3 = int(np.clip(round((st - 2.0) / 0.025), 1, 255)) if row else 0
    return d0, d1, d2, d3


def walls_of(ring, X, Y, Z, I, top, pd=REF_PD):
    """the walls of a ring (UTM, metres; heights above the ground; I the intensity; pd: wall_look): [(a, b, (d0, d1, d2,
    d3))] for the
    walls the LiDAR saw, a and b on the measured wall plane, counter-clockwise (the outside on the right of a to b)"""
    ring = np.asarray(ring, float)
    s = 1 if 0.5 * np.sum(ring[:, 0] * np.roll(ring[:, 1], -1) - np.roll(ring[:, 0], -1) * ring[:, 1]) > 0 else -1  # ccw: outward (dy, -dx)
    out = []
    for k in range(len(ring)):
        a, b = ring[k], ring[(k + 1) % len(ring)]
        L = float(np.hypot(*(b - a)))
        if L < 4: continue
        u = (b - a) / L; n = np.array([u[1], -u[0]]) * s
        al = (X - a[0]) * u[0] + (Y - a[1]) * u[1]; dp = (X - a[0]) * n[0] + (Y - a[1]) * n[1]
        sel = (al > 0.3) & (al < L - 0.3) & (dp > -3) & (dp < 3) & (Z > 0.3) & (Z < top + 0.5)
        if sel.sum() < 40: continue
        hz = sel & (Z > 3)
        hh, ed = np.histogram(dp[hz] if hz.sum() > 20 else dp[sel], bins=np.arange(-3, 3.01, 0.25))
        f0 = ed[np.argmax(hh)] + 0.125  # the wall plane (OSM outlines are often a metre or two off)
        d = wall_look(al[sel], Z[sel], dp[sel] - f0, I[sel], L, top, pd)
        if d: out.append((a + n * f0, b + n * f0, d) if s > 0 else (b + n * f0, a + n * f0, d))
    return out


def decode(d):
    d0, d1, d2, d3 = d
    return dict(kind=d0 & 7, tone=d0 >> 3 & 3, bay=0.5 + 0.05 * d1 if d1 else 0, wx=(d2 & 15) / 15, wy=(d2 >> 4) / 15, storey=2 + 0.025 * d3 if d3 else 0)


def check():
    """synthetic walls: punched windows (1.4 m in 3 m bays, 1.6 m in 3.4 m storeys), ribbon bands, vertical strips"""
    rng = np.random.default_rng(1)
    al = rng.uniform(0, 30, 40000); z = rng.uniform(0, 34, 40000)
    def look(keep, inten=150):
        a, h = al[keep], z[keep]
        return decode(wall_look(a, h, rng.normal(0, 0.1, len(a)), np.full(len(a), inten), 30.0, 34.0))
    winx = ((al % 3.0) > 0.8) & ((al % 3.0) < 2.2); winy = ((z % 3.4) > 1.0) & ((z % 3.4) < 2.6)
    d = look(~(winx & winy))
    print('punched', d)
    assert d['kind'] == 1 and abs(d['bay'] - 3.0) < 0.1 and abs(d['storey'] - 3.4) < 0.1, d
    assert 0.35 < d['wx'] < 0.6 and 0.35 < d['wy'] < 0.6 and d['tone'] == 0
    d = look(~winy, 30)
    print('bands', d)
    assert d['kind'] == 3 and d['bay'] == 0 and abs(d['storey'] - 3.4) < 0.1 and d['tone'] == 1, d
    d = look(~winx, 400)
    print('strips', d)
    assert d['kind'] == 2 and abs(d['bay'] - 3.0) < 0.1 and d['storey'] == 0 and d['tone'] == 2, d
    keep = ~(winx & winy) & (rng.uniform(0, 1, len(al)) < 0.2)  # a regional set: a fifth of the returns
    d = decode(wall_look(al[keep], z[keep], rng.normal(0, 0.1, keep.sum()), np.zeros(keep.sum()), 30.0, 34.0, pd=5))
    print('sparse punched', d)
    assert d['kind'] == 1 and abs(d['storey'] - 3.4) < 0.1 and d['tone'] == 0, d
    print('walls check ok')


if __name__ == '__main__':
    check()
