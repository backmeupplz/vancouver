// The fleet's models, built in code with the low-poly kit: one merged, vertex-coloured geometry per variant of
// each class (the ships plugin draws them all in one batched mesh; the transit plugin's SeaBus is here too).
// x along the vessel (+ = bow), y up from the waterline, z across; centred on the middle of the hull.
// Generic liveries: no operator's marks.
import { kit } from '../../core/kit.js'
import { loft, slab, sym, block, sloop, sailTris, SLOOP } from '../../core/hull.js'
import { mulberry32 } from '../../core/util.js'

const WHITE = 0xf3f3ee, NAVY = 0x1d3463, GLASS = 0x2a3b52, ANTI = 0x8f2f2a, BLACK = 0x1d1d22, STEEL = 0x7d8590, SPAR = 0xd9d9d4, SKIN = 0xd9a984
const BOXES = [0x2b6cb0, 0xc0392b, 0xe8e8e3, 0x7d8590, 0x2f8f5b, 0xe67e22, 0xf1c40f, 0x1d3a5f, 0x8e44ad, 0xb5651d, 0x16a085]
const HULLS = [0x1d3a5f, 0x7a1f1f, 0x23262b, 0x1f5f4a, 0x2b4a7a, 0x3a3f47]
const RAINBOW = [0xe74c3c, 0xf39c12, 0xf1c40f, 0x27ae60, 0x2980b9, 0x8e44ad]
const pick = (r, a) => a[Math.floor(r() * a.length)]

// a cargo ship's hull: a flared transom, parallel sides, a raised forecastle, a raked stem over a bulbous bow, the
// antifouling showing up to `boot` above the water (how light she rides)
function cargo(k, L, B, D, c, o = {}) {
  const h = B / 2, fc = o.fc ?? 3.5, boot = o.boot ?? 1.5, rake = 0.035 * L
  const S = [[-0.5, 0.8, 0.45, 0], [-0.46, 0.96, 0.8, 0], [-0.38, 1, 1, 0], [0.3, 1, 1, 0], [0.375, 0.9, 0.74, 0], [0.38, 0.89, 0.73, fc], [0.45, 0.56, 0.3, fc + 0.5]]
  const st = S.map(([x, bd, bw, up]) => [x * L, [[bw * h, -1.5], [(bw + ((bd - bw) * boot) / D) * h, boot], [bd * h, D + up]]])
  st.push([0.5 * L, [[0, -1.5, -rake], [0, boot, -rake * 0.85], [0, D + fc + 1.2]]])
  loft(k, st, { paint: (j) => k.c(j ? c : ANTI), deck: o.deck ?? 0x7a4a3c })
  const s = k.at()
  k.c(ANTI).cyl(2.4, 0.9, 9, 6, 1).rot(s, 'z', -Math.PI / 2).move(s, 0.5 * L - rake - 5, -0.9, 0) // the bulb
  block(k.c(STEEL), 0.44 * L, 0.455 * L, D + fc, D + fc + 2.2, -1.5, 1.5) // the windlass
  k.rod([0.47 * L, D + fc, 0], [0.47 * L, D + fc + 7, 0], 0.4, 0.2, 4) // the foremast
  return D
}
// the accommodation block on the deck at y between x0 and x1: decks w wide with bands of windows, the bridge with
// its wings (bw wide) on top and a mast
function house(k, x0, x1, y, w, floors, bw) {
  const top = y + floors * 3, xm = (x0 + x1) / 2
  block(k.c(WHITE), x0, x1, y, top, -w / 2, w / 2)
  for (let f = 1; f < floors; f += 2) k.c(GLASS).box(x0 - 0.3, x1 + 0.3, y + f * 3 + 0.9, y + f * 3 + 2.1, -w / 2 - 0.3, w / 2 + 0.3)
  k.c(WHITE).box(x0 - 0.5, x1 + 1, top, top + 3.2, -bw / 2, bw / 2)
  k.c(GLASS).box(x0 - 0.8, x1 + 1.35, top + 1.5, top + 2.7, -bw / 2 - 0.3, bw / 2 + 0.3)
  k.c(STEEL).rod([xm, top + 3.2, 0], [xm, top + 9.5, 0], 0.45, 0.2, 4)
  k.box(xm - 0.4, xm + 0.4, top + 6, top + 6.5, -2.6, 2.6)
}
// a funnel raked aft, with a black top
function funnel(k, x, y0, y1, len, w, c, z = 0) {
  const a = len / 2, rk = (y1 - y0) * 0.12
  k.c(c).prism([x - a, y0, x + a, y0, x + a - rk, y1, x - a - rk, y1], z - w / 2, z + w / 2, { bevel: Math.min(0.4, w * 0.12) })
  block(k.c(BLACK), x - a - rk + w * 0.12, x + a - rk - w * 0.12, y1, y1 + Math.min(1.4, len * 0.2), z - w * 0.36, z + w * 0.36)
}
// a deck crane: a pedestal with its cab, the jib resting towards the bow
function crane(k, x, y, z, reach) {
  block(k.c(0xe0b830), x - 1.3, x + 1.3, y, y + 13, z - 1.3, z + 1.3)
  k.box(x - 2, x + 2.4, y + 13, y + 16.5, z - 2, z + 2)
  k.rod([x + 2, y + 15, z], [x + reach, y + 8, z], 0.7, 0.4, 4)
}
// somebody sitting or standing at x, their seat at y: a body in colour c and a head
function person(k, x, y, z, c, tall = 0.55) {
  block(k.c(c), x - 0.13, x + 0.13, y, y + tall, z - 0.2, z + 0.2)
  k.c(SKIN).box(x - 0.1, x + 0.1, y + tall + 0.03, y + tall + 0.25, z - 0.1, z + 0.1)
}
// a sloop's boom and sails, the boom out by a radians (+ = to +z), on a hull built by sloop()
function rig(k, a, c) {
  const both = (p, q, s) => { k.tri(p, q, s); k.tri(p, s, q) }
  let s = k.at()
  k.c(SPAR).rod([0, 0, 0], [-3, 0, 0], 0.05, 0.04, 4)
  k.c(c); sailTris('main', Math.sign(a), both)
  k.rot(s, 'y', a).move(s, ...SLOOP.boom)
  s = k.at()
  k.c(0xfbfbf5); sailTris('jib', Math.sign(a), both)
  k.rot(s, 'y', a * 0.85).rot(s, 'z', SLOOP.stay).move(s, ...SLOOP.tack)
}

// The SeaBus: a double-ended catamaran, the wheelhouse on the roof amidships (front +x, y 0 = the waterline)
export function seabusGeo(THREE) {
  const k = kit(THREE), HULL = 0x2f4f6f
  for (const z of [-3.7, 3.7]) {
    const s = k.at(), S = [[-14.5, 0.75], [-8, 1], [8, 1], [14.5, 0.75]]
    loft(k.c(HULL), [[-17, [[0, -0.8, 1.2], [0, 0.1, 0.6], [0, 1]]], ...S.map(([x, b]) => [x, [[b * 1.2, -0.8], [b * 1.9, 0.1], [b * 1.9, 1]]]), [17, [[0, -0.8, -1.2], [0, 0.1, -0.6], [0, 1]]]])
    k.move(s, 0, 0, z)
  }
  const plan = (g) => sym([[-16.4, 3.2], [-13.4, 5.75], [13.4, 5.75], [16.4, 3.2]], g)
  slab(k.c(0xf5c400), plan(0), 0.95, 1.35)
  slab(k.c(0xf4f5f2), plan(-0.3), 1.35, 2.45)
  slab(k.c(0x26323f), plan(-0.22), 2.45, 3.6)
  slab(k.c(0xf4f5f2), plan(-0.1), 3.6, 4.3, { bevel: 0.12 })
  const wh = (g) => sym([[-4.4, 2], [-3.4, 3], [3.4, 3], [4.4, 2]], g)
  slab(k, wh(0), 4.3, 4.9)
  slab(k.c(0x26323f), wh(0.08), 4.9, 5.75)
  slab(k.c(0xf4f5f2), wh(0.3), 5.75, 6, { bevel: 0.06 })
  k.c(0x9aa0a6).rod([0, 6, 0], [0, 8.2, 0], 0.12, 0.06, 4)
  return k.geometry(true)
}

// kind → its variants [{ kind, L, B (the model's own length and beam), geo, small? }]
export function shipModels(THREE, seed = 20261106) {
  const r = mulberry32(seed), out = {}
  const make = (kind, n, L, B, build, extra) => {
    out[kind] = Array.from({ length: n }, (_, i) => { const k = kit(THREE); build(k, i); return { kind, L, B, geo: k.geometry(true), ...extra } })
  }
  const small = { small: true }

  make('container', 4, 300, 42, (k) => {
    const L = 300, B = 42, D = cargo(k, L, B, 13, pick(r, HULLS), { boot: 0.8 + r() * 2 }), w = (B * 0.92) / 4
    house(k, -0.42 * L, -0.42 * L + 14, D, B * 0.86, 6, B * 1.04)
    funnel(k, -0.455 * L, D, D + 25, 8, 8, pick(r, [0x23262b, 0xc0392b, 0x2b6cb0, 0xe0b830]))
    for (let x = -0.36 * L; x < 0.33 * L; x += 14.4) for (let c = 0; c < 4; c++) { // the stacks: four blocks across a bay
      const tiers = Math.max(1, Math.round((2 + r() * 5) * (x > 0.22 * L ? 0.6 : 1)))
      block(k.c(pick(r, BOXES)), x, x + 12.6, D, D + tiers * 2.6, (c - 2) * w, (c - 1) * w)
    }
  })
  const bulk = (k, L, B, cranes, n) => {
    const D = cargo(k, L, B, 11, pick(r, HULLS), { boot: 0.6 + r() * 3, deck: pick(r, [0x8a4638, 0x5f6b5a, 0x70767c]) })
    house(k, -0.44 * L, -0.44 * L + 13, D, B * 0.82, 5, B * 1.03)
    funnel(k, -0.475 * L, D, D + 21, 7, 7, pick(r, [0x23262b, 0xc0392b, 0xe67e22]))
    const hatch = pick(r, [0x9c4a2f, 0x7d8590, 0x4f7d55, 0x2b4a7a]), pitch = (0.7 * L) / n
    for (let i = 0; i < n; i++) {
      const x = -0.36 * L + i * pitch
      block(k.c(hatch), x + pitch * 0.14, x + pitch * 0.94, D, D + 2.4, -B * 0.31, B * 0.31)
      if (cranes && i % 2 === 0 && i < n - 1) crane(k, x + pitch * 1.04, D, 0, pitch * 0.8)
    }
  }
  make('bulk', 4, 220, 32, (k, i) => bulk(k, 220, 32, i % 2 === 1, 7))
  make('general', 2, 170, 26, (k) => bulk(k, 170, 26, true, 5))
  make('tanker', 3, 245, 44, (k) => {
    const L = 245, B = 44, D = cargo(k, L, B, 10.5, pick(r, [0x7a1f1f, 0x23262b, 0x1d3a5f]), { boot: 0.5 + r() * 3.5, deck: pick(r, [0x6d7d62, 0x8a3b30]), fc: 2.5 })
    house(k, -0.43 * L, -0.43 * L + 15, D, B * 0.7, 5, B * 1.02)
    funnel(k, -0.47 * L, D, D + 23, 8, 9, pick(r, [0x23262b, 0xc0392b, 0x2b6cb0]))
    block(k.c(0xd5d5d0), -0.34 * L, 0.34 * L, D, D + 1.8, -2.2, 2.2) // the pipes along the centre line
    block(k, -4, 4, D, D + 3.6, -B * 0.36, B * 0.36) // the manifold, a hose crane each side of it
    for (const x of [-12, 12]) crane(k, x, D, 0, x < 0 ? 9 : -9)
    for (const x of [-0.2, 0.2]) block(k.c(0xd5d5d0), x * L - 0.6, x * L + 0.6, D, D + 2.6, -B * 0.3, B * 0.3)
  })
  make('car', 2, 200, 32, (k) => { // a car carrier: a slab-sided garage, the bridge across the top near the bow
    const L = 200, h = 16, T = 31, up = pick(r, [WHITE, 0x2b4a7a, 0xd9d4c4]), lo = pick(r, [0x23262b, 0x1d3a5f])
    const S = [[-0.5, 0.94, 0.8], [-0.47, 1, 0.96], [0.28, 1, 1], [0.4, 0.86, 0.6], [0.47, 0.5, 0.25]]
    const st = S.map(([x, bd, bw]) => [x * L, [[bw * h, -1.5], [(bw + (bd - bw) * 0.1) * h, 1], [bd * h, 10], [bd * h, T]]])
    st.push([0.5 * L, [[0, -1.5, -9], [0, 1, -8], [0, 10, -1.5], [0, T]]])
    loft(k, st, { paint: (j) => k.c([ANTI, lo, up][j]), deck: 0xcfd3d6 })
    block(k.c(WHITE), 0.33 * L, 0.33 * L + 8, T, T + 3.4, -h * 0.96, h * 0.96)
    k.c(GLASS).box(0.33 * L - 0.3, 0.33 * L + 8.3, T + 1.5, T + 2.7, -h * 0.96 - 0.3, h * 0.96 + 0.3)
    funnel(k, -0.4 * L, T, T + 7, 7, 6, lo)
    k.c(0x3a3f47).box(-0.5 * L - 0.5, -0.5 * L + 1, 2, 21, h * 0.12, h * 0.78) // the stern quarter ramp, stowed
    for (let x = -0.4; x < 0.25; x += 0.11) for (const s of [-1, 1]) k.box(x * L, x * L + 9, 24.5, 26.5, s * h - 0.3, s * h + 0.3) // vents
  })
  make('cruise', 3, 290, 36, (k, i) => { // decks stepping back to the bow, rows of balconies, lifeboats, a pool, a raked funnel
    const L = 290, h = 18, D = 11, [c, fc] = [[NAVY, 0x23262b], [WHITE, NAVY], [BLACK, 0xc0392b]][i]
    const S = [[-0.5, 0.78, 0.55, 0], [-0.465, 0.97, 0.88, 0], [-0.3, 1, 1, 0], [0.2, 1, 1, 0], [0.36, 0.74, 0.5, 1], [0.45, 0.36, 0.16, 2]]
    const st = S.map(([x, bd, bw, up]) => [x * L, [[bw * h, -1.5], [(bw + (bd - bw) * 0.25) * h, 1.2], [bd * h, D + up]]])
    st.push([0.5 * L, [[0, -1.5, -12], [0, 1.2, -10.5], [0, D + 2.6]]])
    loft(k, st, { paint: (j) => k.c(j ? c : ANTI), deck: 0xd9d4c4 })
    const plan = (P, g) => sym(P.map(([x, z]) => [x * L, z * h]), g)
    const lo = [[-0.47, 0.92], [0.2, 0.95], [0.3, 0.66], [0.335, 0.3]], hi = [[-0.42, 0.88], [0.15, 0.9], [0.24, 0.6], [0.27, 0.3]]
    slab(k.c(WHITE), plan(lo), D, 28)
    for (const y of [15.5, 19.5, 23.5]) slab(k.c(0x3b4a58), plan(lo, 0.4), y, y + 1.4)
    slab(k.c(WHITE), plan(hi), 28, 38)
    for (const y of [30, 34]) slab(k.c(0x3b4a58), plan(hi, 0.4), y, y + 1.4)
    for (let x = -0.3; x < 0.16; x += 0.09) for (const s of [-1, 1]) k.c(0xee8a1c).box(x * L, x * L + 10, 12, 14.8, s * h * 0.9, s * h * 1.04) // lifeboats
    block(k.c(WHITE), -0.36 * L, -0.14 * L, 38, 42, -h * 0.75, h * 0.75)
    block(k.c(0x46aee0), -0.1 * L, 0.02 * L, 38, 38.4, -h * 0.34, h * 0.34) // the pool
    block(k.c(WHITE), 0.06 * L, 0.2 * L, 38, 41.5, -h * 0.7, h * 0.7)
    k.box(0.232 * L, 0.262 * L, 30.6, 33.8, -h * 1.08, h * 1.08) // the bridge and its wings
    k.c(GLASS).box(0.232 * L - 0.3, 0.262 * L + 0.4, 31.9, 33.2, -h * 1.08 - 0.3, h * 1.08 + 0.3)
    funnel(k, -0.25 * L, 42, 54, 17, 11, fc)
    k.c(STEEL).rod([0.14 * L, 41.5, 0], [0.14 * L, 50, 0], 0.6, 0.25, 4)
  })
  make('bcf', 1, 160, 27, (k) => { // a double-ended car ferry: the car deck open at both ends, a bridge at each, the funnel amidships
    const L = 160, h = 13.5, D = 9
    const S = [[-0.5, 0.52, 0.3], [-0.44, 0.84, 0.62], [-0.34, 1, 0.95], [0.34, 1, 0.95], [0.44, 0.84, 0.62], [0.5, 0.52, 0.3]]
    loft(k, S.map(([x, bd, bw]) => [x * L, [[bw * h, -1.5], [((bw + bd) / 2) * h, 3.4], [bd * h, D]]]), { paint: (j, i) => k.c(j === 0 ? NAVY : i < 0 ? 0x2a2f36 : WHITE), deck: 0x70767c })
    const P = (a, b, g) => sym([[-a * L, 0.45 * h], [-(a - 0.07) * L, b * h], [(a - 0.07) * L, b * h], [a * L, 0.45 * h]], g)
    slab(k.c(WHITE), P(0.46, 0.96), D, 14.6); slab(k.c(GLASS), P(0.46, 0.96, 0.35), 11.4, 12.8)
    slab(k.c(WHITE), P(0.4, 0.9), 14.6, 19.4); slab(k.c(GLASS), P(0.4, 0.9, 0.35), 16.2, 17.7)
    for (const s of [-1, 1]) {
      const x = s * 0.33 * L
      block(k.c(WHITE), x - 4, x + 4, 19.4, 22.8, -h * 0.62, h * 0.62)
      k.c(GLASS).box(x - 4.3, x + 4.3, 20.7, 22, -h * 0.62 - 0.3, h * 0.62 + 0.3)
      k.c(STEEL).rod([x, 22.8, 0], [x, 28, 0], 0.3, 0.15, 4)
      for (const z of [-1, 1]) k.c(0xee8a1c).box(s * 0.16 * L - 4, s * 0.16 * L + 4, 19.4, 21.4, z * h * 0.9 - 1.3, z * h * 0.9 + 1.3) // lifeboats
    }
    block(k.c(WHITE), -5.5, 5.5, 19.4, 28, -3.6, 3.6) // the funnel: a red and a blue band, a black top
    k.c(0xc0392b).box(-5.8, 5.8, 23.4, 24.3, -3.9, 3.9)
    k.c(NAVY).box(-5.8, 5.8, 24.9, 27.2, -3.9, 3.9)
    block(k.c(BLACK), -4.8, 4.8, 28, 28.8, -2.9, 2.9)
  })
  // the False Creek mini ferries: a tubby hull, a cabin of windows under an overhanging roof
  const mini = (k, hull, body, roof, stripes) => {
    const h = 1.8, S = [[-5, 0.72, 0.7], [-4.2, 0.96, 0.7], [-1, 1, 0.7], [2, 1, 0.75], [3.8, 0.72, 0.85], [4.6, 0.4, 0.92]]
    const st = S.map(([x, b, yd]) => [x, [[b * h * 0.6, -0.4], [b * h * 0.96, 0.2], [b * h, yd]]])
    st.push([5, [[0, -0.4, -0.5], [0, 0.2, -0.3], [0, 0.98]]])
    loft(k, st, { paint: (j) => k.c(j ? hull : 0x1d3a5f), deck: 0x9aa0a4 })
    const plan = (g) => sym([[-3.5, 1.1], [-3.1, 1.5], [2.6, 1.5], [3.2, 1]], g)
    slab(k.c(body), plan(0), 0.7, 1.5)
    stripes?.forEach((c, i) => k.c(c).box(-3.1 + i * 0.95, -3.1 + (i + 1) * 0.95, 0.98, 1.26, -1.56, 1.56))
    slab(k.c(GLASS), plan(-0.06), 1.5, 2.45)
    slab(k.c(roof), plan(0.3), 2.45, 2.68, { bevel: 0.06 })
    block(k.c(WHITE), 1.4, 1.7, 2.68, 3.1, -0.15, 0.15)
  }
  make('aquabus', 3, 10, 3.6, (k, i) => mini(k, WHITE, [0x2980b9, 0x27ae60, 0xe67e22][i], WHITE, RAINBOW), small)
  make('fcf', 1, 10, 3.6, (k) => mini(k, 0x2a6fb5, 0xeef2f5, 0x2a6fb5), small)
  make('tug', 3, 24, 9, (k, i) => {
    const h = 4.5, c = [0xc0392b, 0xe0b830, 0x2b6cb0][i]
    const S = [[-12, 0.82, 0.6, 1.7], [-10.5, 0.98, 0.9, 1.6], [-2, 1, 1, 1.7], [4, 1, 0.95, 2.3], [8, 0.76, 0.6, 3.1], [10.8, 0.42, 0.26, 3.6]]
    const st = S.map(([x, bd, bw, yd]) => [x, [[bw * h * 0.9, -1.2], [bw * h, 0.4], [bd * h, yd]]])
    st.push([12, [[0, -1.2, -1.6], [0, 0.4, -1.2], [0, 3.85]]])
    loft(k, st, { paint: (j) => k.c(j ? BLACK : ANTI), deck: 0x6b3a2e })
    slab(k.c(WHITE), sym([[-3.5, 2.6], [-2.8, 3.1], [5.5, 3.1], [7, 2.2]]), 1.6, 4.4)
    const wh = (g) => sym([[1, 2], [1.4, 2.4], [5.2, 2.4], [6, 1.8]], g)
    slab(k, wh(0), 4.4, 5.5); slab(k.c(GLASS), wh(0.1), 5.5, 6.5); slab(k.c(c), wh(0.4), 6.5, 6.75)
    for (const z of [-1.7, 1.7]) funnel(k, -1.2, 4.4, 7.6, 1.8, 1.3, c, z)
    k.c(STEEL).rod([3, 6.75, 0], [3, 10.5, 0], 0.15, 0.08, 4)
    block(k.c(0x3a3f47), -7, -4.8, 1.6, 2.9, -1.3, 1.3) // the towing winch and its post
    block(k, -8.8, -8.4, 1.6, 3, -0.2, 0.2)
  })
  make('boom', 1, 70, 20, (k) => { // a raft of logs in three sections, boomsticks round it
    const browns = [0x8a6a46, 0x7c5d3c, 0x96744e, 0x6f5234]
    for (let s = 0; s < 3; s++) for (let l = 0; l < 6; l++) {
      const x = -34.2 + s * 23 + (r() - 0.5) * 1.6, z = -9.6 + l * 3.2
      block(k.c(pick(r, browns)), x, x + 21.6, -0.3, 0.25 + r() * 0.45, z, z + 3.2)
    }
    for (const z of [-10.2, 9.8]) block(k.c(0x5e4630), -35, 35, -0.3, 0.55, z, z + 0.4)
    for (const x of [-35, -11.8, 11.2, 34.5]) block(k, x, x + 0.5, -0.3, 0.9, -10.2, 10.2)
  })
  make('sail', 4, SLOOP.L, SLOOP.B, (k, i) => { // under sail, on either tack
    sloop(k, [WHITE, WHITE, NAVY, 0x8e2a2a][i], { far: true })
    rig(k, i % 2 ? 0.5 : -0.5, [0xfbfbf5, 0xfbfbf5, 0xfbfbf5, 0xf0d9a8][i])
    k.move(0, -SLOOP.mid, 0, 0)
  }, small)
  make('moored', 3, SLOOP.L, SLOOP.B, (k, i) => { // at her berth: the sail furled on the boom under its cover
    sloop(k, [WHITE, NAVY, WHITE][i], { far: true })
    k.c(SPAR).rod(SLOOP.boom, [SLOOP.boom[0] - 3, 1.5, 0], 0.05, 0.04, 4)
    k.c([0x2b4a7a, 0xb5651d, 0x1f5f4a][i]).box(SLOOP.boom[0] - 2.8, SLOOP.boom[0] - 0.1, 1.52, 1.76, -0.1, 0.1)
    k.move(0, -SLOOP.mid, 0, 0)
  }, small)
  make('motor', 4, 8, 2.6, (k, i) => {
    const h = 1.3, c = [WHITE, 0x2b4a7a, WHITE, 0xc0392b][i], cabin = i > 1
    const S = [[-4, 0.9, 0.78, 0.75], [-3.5, 0.98, 0.86, 0.75], [cabin ? -1.4 : -0.4, 1, 0.9, 0.8], [1.6, 0.86, 0.66, 0.95], [3.1, 0.45, 0.25, 1.1]]
    const st = S.map(([x, bd, bw, yd]) => [x, [[bw * h * 0.5, -0.35], [bw * h, 0.15], [bd * h, yd]]])
    st.push([4, [[0, -0.3, -0.9], [0, 0.15, -0.75], [0, 1.2]]])
    loft(k, st, { paint: (j) => k.c(j ? c : 0xdfe3e6), deck: WHITE, well: { from: 1, to: 2, w: 0.95, y: 0.25, c: 0xcfc3aa } })
    if (cabin) { // a cabin cruiser: windows all round under a hard top, a swim platform
      const plan = (g) => sym([[-1.4, 1], [-1, 1.1], [1.3, 1.05], [2.2, 0.6]], g)
      slab(k.c(WHITE), plan(0), 0.8, 1.25); slab(k.c(GLASS), plan(-0.05), 1.25, 1.8); slab(k.c(WHITE), plan(0.12), 1.8, 1.93, { bevel: 0.04 })
      block(k.c(0x8a6a46), -4.5, -4, 0.05, 0.22, -1, 1)
    } else { // a runabout: a raked windscreen, two seats, an outboard
      k.c(GLASS).prism([-0.4, 0.8, 0.7, 0.86, -0.25, 1.45], -1.05, 1.05)
      for (const z of [-0.5, 0.5]) block(k.c(WHITE), -1.3, -0.8, 0.25, 0.95, z - 0.28, z + 0.28)
      block(k.c(0x23262b), -4.4, -3.95, 0.1, 1.15, -0.22, 0.22)
    }
  }, small)
  make('kayak', 3, 5.2, 0.62, (k, i) => {
    const c = [0xe74c3c, 0xf1c40f, 0x2980b9][i], S = [[-1.7, 0.7, 0.2], [-0.3, 1, 0.2], [0.6, 1, 0.2], [1.8, 0.6, 0.24]]
    loft(k.c(c), [[-2.6, [[0, 0, 0.25], [0, 0.12, 0.1], [0, 0.3]]], ...S.map(([x, b, yd]) => [x, [[0, -0.08], [b * 0.29, 0.03], [b * 0.31, yd]]]), [2.6, [[0, 0, -0.25], [0, 0.12, -0.1], [0, 0.34]]]], { deck: c })
    person(k, -0.1, 0.2, 0, [0xf39c12, 0x2b4a7a, 0xc0392b][i])
    k.c(0x23262b).rod([0.25, 0.4, -1.05], [0.25, 0.78, 1.05], 0.025, 0.025, 4) // the paddle and its blades
    k.c(0xf1c40f).box(0.2, 0.3, 0.22, 0.56, -1.18, -1.0); k.box(0.2, 0.3, 0.64, 0.98, 1.0, 1.18)
  }, small)
  make('sup', 2, 3.2, 0.8, (k, i) => { // a paddleboarder
    slab(k.c([0xeef2f5, 0x16a085][i]), sym([[-1.6, 0.2], [-1, 0.4], [0.6, 0.4], [1.6, 0.05]]), 0, 0.1, { bevel: 0.03 })
    block(k.c(0x2a3b52), -0.12, 0.12, 0.1, 0.9, -0.17, 0.17) // legs
    person(k, 0, 0.9, 0, [0xc0392b, 0xf39c12][i])
    k.c(0x23262b).rod([0.15, 1.45, 0.25], [0.75, 0.05, 0.5], 0.025, 0.025, 4)
    k.box(0.68, 0.84, -0.2, 0.2, 0.44, 0.56)
  }, small)
  make('floatplane', 3, 9.6, 14.6, (k, i) => { // a single-engine float plane, moored: high wing, twin floats
    const c = [0xe0b830, 0xc0392b, 0x2b6cb0][i]
    // the fuselage: [x, half width, belly, roof]
    const F = [[-5, 0.08, 2.25, 2.6], [-1, 0.55, 1.4, 2.95], [1.6, 0.62, 1.3, 3], [2.6, 0.62, 1.3, 2.5], [4, 0.5, 1.45, 2.35], [4.4, 0.3, 1.6, 2.2]]
    loft(k, F.map(([x, w, yb, yt]) => [x, [[0, yb], [w, yb + 0.25], [w, yt - 0.3], [w * 0.6, yt]]]), { paint: (j, i) => k.c(i === 2 && j > 0 ? GLASS : j === 1 ? c : WHITE), deck: WHITE, top: (i) => i === 2 && k.c(GLASS) })
    k.c(GLASS).box(-0.6, 1.5, 2.25, 2.7, -0.66, 0.66) // the cabin windows
    block(k.c(WHITE), 0.9, 2.9, 3, 3.18, -7.3, 7.3) // the wing, its tips in the colour, and its struts
    for (const z of [-1, 1]) { k.c(c).box(0.88, 2.92, 2.98, 3.2, z * 6.4, z * 7.32); k.c(STEEL).rod([1.9, 3, z * 3.2], [1.6, 1.5, z * 0.6], 0.06, 0.06, 4) }
    k.c(c).prism([-5.1, 2.5, -3.6, 2.6, -4.6, 4.3, -5.3, 4.3], -0.06, 0.06)
    k.c(WHITE).box(-5.2, -4.2, 2.6, 2.7, -2.2, 2.2)
    k.c(0x23262b).box(4.4, 4.6, 1.7, 2.1, -0.2, 0.2); k.box(4.5, 4.58, 0.6, 3.2, -0.1, 0.1) // the propeller
    for (const z of [-1.5, 1.5]) { // the floats and their struts
      k.c(0xdfe3e6).prism([-3.6, 0.3, -3.4, -0.1, 2.6, -0.25, 3.8, 0.35, 3.4, 0.55, -3.4, 0.6], z - 0.36, z + 0.36, { bevel: 0.08 })
      for (const x of [-0.6, 2]) k.c(STEEL).rod([x, 0.55, z], [x, 1.5, z * 0.4], 0.06, 0.06, 4)
    }
  }, small)
  return out
}
