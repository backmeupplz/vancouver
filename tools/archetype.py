#!/usr/bin/env python3
"""Building archetypes (BUILDINGS.md step 2b): what kind of building this is, by type and era, from data only (no random
numbers: every rule reads a tag, a measurement or the tax report's year built). tiles.py calls archetype() per building
group and writes the result in the BARC section; the page draws walls, trim and roof edges by it.

  python3 tools/archetype.py                      self-test
  python3 tools/archetype.py validate TRACE...    the no-year rules against the tax year (TRACE: ARCH_TRACE=file bakes)
                                                  [--places specs.txt] also counts each archetype within 450 m of the places
"""
import sys, json, math

# style ids: the page's palettes and facade patterns (tile-worker.js PALETTES); tiles.py imports them from here
HOUSE, APT, OFFICE, BRICK, COMM, CIVIC, GLASS, CONCRETE, SHED, BIGBOX, STONE, CHARACTER, SPECIAL = range(13)
(NONE, CRAFTSMAN, BUNGALOW, SPECIAL_A, BUILDER, CONTEMPORARY, ROW, WALKUP, MIDRISE, TOWER_SLAB, TOWER_GLASS, TOWER_WALL,
 HERITAGE, MAINSTREET, STRIP, TILTUP) = (0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)
NAMES = ['none', 'craftsman', 'bungalow', 'special', 'builder', 'contemporary', 'row', 'walkup', 'midrise', 'tower_slab', 'tower_glass', 'tower_wall',
         'heritage', 'mainstreet', 'strip', 'tiltup']
# the no-year rules that ship: `validate` agreed with the tax year on 70% or more of City houses (the table in the PR); a rule
# switched off leaves those houses at 0
NOYEAR = set()  # all four failed the gate (`validate`: 24, 45, 30, 43%): without a year a house stays 0; add one back when it passes
HOUSES = {'house', 'detached', 'semidetached_house', 'bungalow', 'cabin', 'terrace'}
RESID = {'apartments', 'residential', 'dormitory'}

# body colours (sRGB as seen) and trim indices (tile-worker.js TRIM) per archetype; a building takes one by its gid
ARCH_PAL = {
    CRAFTSMAN: ([0x4f6a5a, 0x5a7088, 0x7a8a7c, 0x8a4a42, 0x3f5868, 0x6a6258, 0xd8c89c, 0x565c60], [0, 0, 0, 1]),
    BUNGALOW: ([0xe8e2d2, 0xd6dccf, 0xcfd8de, 0xe6d8b8, 0xd8c8b8, 0xf0ece0], [0, 3]),
    BUILDER: ([0xe2d2bc, 0xd8c2a8, 0xe6cfc0, 0xd0c4b0, 0xc8b8a0, 0xe8dcc8], [1, 3]),
    CONTEMPORARY: ([0x6e767c, 0x50585e, 0x8a9298, 0x3e4a54, 0xb8bcbc, 0x7a6a58], [0, 2]),
    ROW: ([0x7a8288, 0x8c8a80, 0xa89c88, 0x5c6a72, 0xb4b0a4], [0]),
    WALKUP: ([0xe0dace, 0xd0c8b4, 0xc4b89c, 0xb8bcb4, 0xa8a094, 0xd8d4cc], [3, 6]),
    MIDRISE: ([0xb8b4a8, 0x8c9498, 0xa89684, 0x70787c, 0xc8c0b0, 0x94887a], [2, 0]),
    STRIP: ([0xd8d2c4, 0xc4bcaa, 0xb0aca2, 0xcccbc6, 0xa8a49a], [2]),
    MAINSTREET: ([0xd8d2c4, 0xc4bcaa, 0xb0aca2, 0xcccbc6, 0xa8a49a], [2]),
    TILTUP: ([0xb4b2ac, 0x9a9c9c, 0xc4c0b6, 0x7e8284, 0xd0cec8], [2]),
}
TRIM_ANY = [0, 0, 0, 1, 2, 6]  # the rest: the page's old pick
ROOF_HOUSE = [0x4a4f55, 0x5f6366, 0x6e6a66, 0x7a5a48, 0x3e4349, 0x52606a, 0x585450]
ROOF_TILE = 0x9a5a48  # a third of the 1986-2005 builder houses
ROOF_FLAT = [0xb8b8b4, 0x8a8c8a]  # membrane, gravel


def era_of(year):
    return 0 if not year else 1 if year < 1915 else 2 if year < 1940 else 3 if year < 1965 else 4 if year < 1986 else 5 if year < 2006 else 6


def pick(gid, n, salt=0):
    return ((gid * 2654435761 + salt * 40503) >> 9) % n  # from the building's own id, so a rebake keeps it


def archetype(info, main, top, style, lot=False, com=False, noyear=None):
    """-> (archetype id, era code, trim index, flags: 1 garage on the front (step 3), 2 faces a car park).
    info: btype, a, year, fac, shop, ind, lv; main: the biggest part (roof byte, pitch, ridge, h, ring)."""
    noyear = NOYEAR if noyear is None else noyear  # (validate switches every no-year rule on)
    btype, a, year, shop = info['btype'], info['a'], info['year'], info['shop']
    era = era_of(year)
    roof, pitch = main['roof'] & 15, main['pitch']
    pitched = roof in (1, 2, 3, 5, 7) and (main['ridge'] or 0) > main['h']
    rise = (main['ridge'] or 0) - main['h']
    house = style in (HOUSE, CHARACTER, SPECIAL)
    resid = btype in RESID or btype == 'yes' and style in (APT, CONCRETE, GLASS)
    storeys = info['lv'] or top / 3.1
    arch, e = NONE, era
    if btype == 'terrace' and house and pitched and 40 < a < 2500:
        arch = ROW
    elif house and style == CHARACTER and (year or CRAFTSMAN in noyear):
        arch, e = CRAFTSMAN, (1 if year and year < 1915 else 2)
    elif house and style == SPECIAL and (1962 <= year <= 1988 if year else SPECIAL_A in noyear):
        arch, e = SPECIAL_A, 4
    elif house and year and 1940 <= year <= 1964: arch, e = BUNGALOW, 3
    elif house and not year and BUNGALOW in noyear and top < 5.5 and a < 140: arch, e = BUNGALOW, 3
    elif house and year and 1986 <= year <= 2005: arch, e = BUILDER, 5
    elif house and not year and BUILDER in noyear and a > 170 and roof in (2, 3) and 0.3 <= pitch <= 0.5 and top >= 6: arch, e = BUILDER, 5
    elif house and year and year >= 2006: arch, e = CONTEMPORARY, 6
    elif not house and resid and 2 <= storeys <= 3.5 and pitched and 250 <= a <= 2500 and style in (APT, COMM) and aspect(main) > 2.5:
        arch = ROW
    elif resid and style in (APT, CONCRETE) and top < 14 and (year and year < 1986 or not year and not pitched):
        arch = WALKUP
    elif resid and style in (APT, CONCRETE, GLASS, OFFICE) and top < 24:
        arch = MIDRISE
    elif resid and style == CONCRETE and top >= 24:
        arch, e = TOWER_SLAB, 4
    elif style == GLASS and resid or style == GLASS and top >= 24:
        arch, e = (TOWER_WALL, 6) if year and year >= 2006 else (TOWER_GLASS, 5)
    elif style in (BRICK, STONE) and btype not in HOUSES and top < 45:
        arch, e = HERITAGE, (era if 0 < era <= 2 else 2)
    elif not resid and not house and top < 8.5 and a > 350 and not pitched and lot and (com or shop or style in (COMM, BIGBOX) or btype == 'yes'):
        arch = STRIP
    elif shop and top < 12 and style not in (SHED,): arch = MAINSTREET
    elif (style == SHED or info['ind']) and not pitched and a > 1500: arch = TILTUP
    return arch, e, 0, (2 if lot else 0)


def aspect(main):
    return main.get('aspect') or 1.0  # the OBB's length over width, which tiles.py puts in the part


def finish(arch, era, gid, flags):
    """the bake's own colours for an archetype: -> (wall 0xRRGGBB or 0, trim index)"""
    if arch in ARCH_PAL:
        pal, trims = ARCH_PAL[arch]
        return pal[pick(gid, len(pal))], trims[pick(gid, len(trims), 1)]
    return 0, TRIM_ANY[pick(gid, len(TRIM_ANY), 1)]


def roof_colour(arch, roof, gid):
    """a roof colour where the photo and the mapper have none: 0 leaves it to the page"""
    if roof & 15 and arch in (CRAFTSMAN, BUNGALOW, SPECIAL_A, BUILDER, CONTEMPORARY, ROW):
        return ROOF_TILE if arch == BUILDER and pick(gid, 3, 2) == 0 else ROOF_HOUSE[pick(gid, len(ROOF_HOUSE), 3)]
    if not roof & 15 and arch in (STRIP, MAINSTREET, TILTUP): return ROOF_FLAT[pick(gid, 2, 4)]
    return 0


def selftest():
    mk = lambda **k: dict(dict(btype='house', a=120, year=None, fac={}, shop=False, ind=False, lv=None), **k)
    m = lambda roof=2, pitch=0.4, ridge=7.0, h=4.5, asp=1.5: dict(roof=roof, pitch=pitch, ridge=ridge, h=h, ring=[(0, 0)], aspect=asp)
    assert archetype(mk(year=1925), m(), 7, CHARACTER)[:2] == (CRAFTSMAN, 2)
    assert archetype(mk(year=1912), m(), 7, CHARACTER)[:2] == (CRAFTSMAN, 1)
    assert archetype(mk(), m(), 7, CHARACTER)[0] == NONE  # (no year: the roof alone is not 70% right)
    assert archetype(mk(year=1975), m(), 7, SPECIAL)[:2] == (SPECIAL_A, 4)
    assert archetype(mk(year=2012), m(), 7, SPECIAL)[0] == CONTEMPORARY  # the year rules out a Special
    assert archetype(mk(year=1950), m(), 5, HOUSE)[:2] == (BUNGALOW, 3)
    assert archetype(mk(year=1995), m(), 7, HOUSE)[:2] == (BUILDER, 5)
    assert archetype(mk(btype='apartments', a=600, year=1965), m(0, 0, 0, 10, 2), 10, APT)[0] == WALKUP
    assert archetype(mk(btype='apartments', a=600, year=1995), m(0, 0, 0, 10, 2), 10, APT)[0] == MIDRISE
    assert archetype(mk(btype='apartments', a=600), m(0, 0, 0, 40, 2), 40, GLASS)[:2] == (TOWER_GLASS, 5)
    assert archetype(mk(btype='yes', a=500, year=1912), m(0, 0, 0, 10, 2), 10, BRICK)[:2] == (HERITAGE, 1)
    assert archetype(mk(btype='retail', a=900), m(0, 0, 0, 6, 2), 6, COMM, lot=True)[0] == STRIP
    assert archetype(mk(btype='retail', a=300, shop=True), m(0, 0, 0, 8, 2), 8, COMM)[0] == MAINSTREET
    assert archetype(mk(btype='industrial', a=3000, ind=True), m(0, 0, 0, 9, 2), 9, SHED)[0] == TILTUP
    assert archetype(mk(btype='terrace', a=250), m(1), 7, HOUSE)[0] == ROW
    assert finish(CRAFTSMAN, 2, 12345, 0) == finish(CRAFTSMAN, 2, 12345, 0) and finish(HERITAGE, 1, 5, 0)[0] == 0
    print('archetype selftest ok')


def validate(argv):
    """the rules with the tax year hidden, against the answer with it, on City buildings of every trace row that carries a year"""
    places, files = None, []
    it = iter(argv)
    for x in it:
        if x == '--places': places = next(it)
        else: files.append(x)
    rows = [json.loads(l) for f in files for l in open(f)]
    print(len(rows), 'buildings in the traces,', sum(1 for r in rows if r['year']), 'with a year')
    cm = {}
    for r in rows:
        if r['year'] and r['house']: cm[(r['n'], r['a'])] = cm.get((r['n'], r['a']), 0) + 1
    print('houses with a year: archetype with the year hidden -> with it (count)')
    names = sorted({k[0] for k in cm})
    for n in names:
        tot = sum(v for k, v in cm.items() if k[0] == n)
        print(f'  {NAMES[n]:13s} {tot:6d}  ' + ', '.join(f'{NAMES[k[1]]} {v}' for k, v in sorted(cm.items(), key=lambda kv: -kv[1]) if k[0] == n and v >= max(1, tot // 50)))
    print('no-year rules: share of the houses each picks (year hidden) whose tax year says the same')
    truth = {CRAFTSMAN: lambda y: y < 1940, SPECIAL_A: lambda y: 1962 <= y <= 1988, BUNGALOW: lambda y: 1940 <= y <= 1964, BUILDER: lambda y: 1986 <= y <= 2005}
    for n, f in truth.items():
        ys = [r['year'] for r in rows if r['year'] and r['house'] and r['n'] == n]
        ok = sum(1 for y in ys if f(y))
        print(f'  {NAMES[n]:13s} {ok}/{len(ys)} = {ok / len(ys):.0%}  {"ships" if ys and ok / len(ys) >= 0.7 else "SWITCHED OFF"}' if ys else f'  {NAMES[n]:13s} none')
    if places:
        P = [(l.split('=')[0], l.split('=')[1][6:].split(',')[:2]) for l in open(places).read().split()]
        sys.path.insert(0, 'tools')
        from common import xy
        print('archetypes within 450 m of each place (with the year where known):')
        for name, (la, lo) in P:
            x, y = xy(float(la), float(lo))
            c = {}
            for r in rows:
                if math.hypot(r['px'] - x, r['py'] - y) < 450: c[r['a']] = c.get(r['a'], 0) + 1
            print(f'  {name:10s} ' + ', '.join(f'{NAMES[k]} {v}' for k, v in sorted(c.items(), key=lambda kv: -kv[1])))


if __name__ == '__main__':
    if sys.argv[1:2] == ['validate']: validate(sys.argv[2:])
    else: selftest()
