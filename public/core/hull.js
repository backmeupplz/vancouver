// Boat building on top of the kit (core/kit.js): hulls skinned over cross-sections, plan shapes extruded upwards,
// bellied sails, and the little sloop the sail plugin sails and the ships plugin moors and sails about.
// Everything here: x along the boat (+ = bow), y up (0 = the waterline), z across.

const thin = (a, b, c) => { // a triangle without area (where a hull closes onto its stem)
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
  return (uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2 < 1e-12
}
const tri = (k, a, b, c) => { if (!thin(a, b, c)) k.tri(a, b, c) }
const quad = (k, a, b, c, d) => { tri(k, a, b, c); tri(k, a, c, d) }

// A hull: stations [x, section] from the stern to the bow, each section the half of a cross-section as points
// [z, y, dx = 0] from the keel up to the deck edge (as many in every station; dx moves a point along x: a raked
// stem). Both sides are skinned, the ends closed where a section has width (a transom).
// o.paint(j, i): set the colour (k.c) of strip j (between section points j and j + 1) of the side after station i
//   (i = -1: the stern's end, -2: the bow's);
// o.deck: the colour of the deck across the tops (omit: open), o.top(i) to repaint it after station i; o.well { from, to (stations), w, y, c }: a cockpit
//   let into the deck between two stations, half as wide as w, its floor at y
export function loft(k, st, o = {}) {
  const P = st.map(([x, sec]) => sec.map(([z, y, dx = 0]) => [x + dx, y, z]))
  const m = (p) => [p[0], p[1], -p[2]], n = P[0].length, e = P.length - 1
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < e; i++) {
      o.paint?.(j, i)
      const A = P[i][j], B = P[i + 1][j], C = P[i + 1][j + 1], D = P[i][j + 1]
      quad(k, A, B, C, D); quad(k, m(A), m(D), m(C), m(B))
    }
    o.paint?.(j, -1); quad(k, P[0][j], P[0][j + 1], m(P[0][j + 1]), m(P[0][j]))
    o.paint?.(j, -2); quad(k, m(P[e][j]), m(P[e][j + 1]), P[e][j + 1], P[e][j])
  }
  if (o.deck == null) return k
  const w = o.well
  for (let i = 0; i < e; i++) {
    const T = P[i][n - 1], U = P[i + 1][n - 1]
    k.c(o.deck); o.top?.(i)
    if (!w || i < w.from || i >= w.to) { quad(k, T, U, m(U), m(T)); continue }
    const a = [T[0], T[1], w.w], b = [U[0], U[1], w.w], c = [U[0], w.y, w.w], d = [T[0], w.y, w.w]
    quad(k, T, U, b, a); quad(k, m(a), m(b), m(U), m(T)) // the side decks
    k.c(w.c)
    quad(k, a, b, c, d); quad(k, m(a), m(d), m(c), m(b)); quad(k, d, c, m(c), m(d)) // the well's sides and floor
    if (i === w.from) quad(k, a, d, m(d), m(a))
    if (i === w.to - 1) quad(k, b, m(b), m(c), c)
  }
  return k
}

// a plan (x, z pairs, either winding) extruded from y0 up to y1; o as kit.prism (bevel: chamfered edges)
export function slab(k, pts, y0, y1, o) {
  const s = k.at()
  k.prism(pts.map((v, i) => (i % 2 ? -v : v)), y0, y1, o)
  return k.rot(s, 'x', -Math.PI / 2)
}
// a plan symmetric about the centre line from its +z half ([x, z] points, stern to bow), grown outwards by `grow`
export const sym = (half, grow = 0) => {
  const x0 = half[0][0], x1 = half[half.length - 1][0], g = (x) => x + (x <= x0 ? -grow : x >= x1 ? grow : 0)
  return [...half.map(([x, z]) => [g(x), z + grow]), ...half.slice().reverse().map(([x, z]) => [g(x), -z - grow])].flat()
}
// a box without its bottom (things standing on a deck)
export function block(k, x0, x1, y0, y1, z0, z1) {
  if (x0 > x1) [x0, x1] = [x1, x0]
  if (z0 > z1) [z0, z1] = [z1, z0]
  const b = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]
  for (const f of [[7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]) k.quad(b[f[0]], b[f[1]], b[f[2]], b[f[3]])
  return k
}

// ---- the sloop: 6.6 m, bow at x 3.5, transom at -3.1, mast at 0.9; her boom pivots at SLOOP.boom, her jib about
// the forestay from SLOOP.tack (leaning aft by SLOOP.stay)
export const SLOOP = { boom: [0.9, 1.5, 0], tack: [3.15, 0.75, 0], stay: Math.atan2(2.2, 7.2), mast: 9.25, L: 6.6, B: 2.4, mid: 0.2 }
const ANTI = 0x8c3b34, DECK = 0xe9dcc3, CABIN = 0xf3ead8, GLASS = 0x2c3c4e, SPAR = 0xd9d9d4

// the hull (in `colour`, a hex number: the only thing in it, for repaint()), deck with its cockpit, cabin, keel,
// rudder with its tiller and the mast; o.far: boats seen from afar, with fewer faces and nothing below the canoe body
export function sloop(k, colour, o = {}) {
  // [x, half beam, sheer, keel]
  const S = [[-3.1, 0.9, 0.62, -0.1], [-2.8, 0.98, 0.6, -0.2], [-0.75, 1.2, 0.56, -0.42], [0.9, 1.15, 0.6, -0.42], [2.2, 0.8, 0.7, -0.3], [3.0, 0.38, 0.8, -0.14]]
  const st = S.map(([x, b, yd, yk]) => [x, o.far ? [[b * 0.8, -0.2], [b * 0.96, 0.1], [b, yd]] : [[0, yk], [b * 0.66, yk * 0.45], [b * 0.96, 0.1], [b, yd]]])
  st.push([3.5, o.far ? [[0, -0.2, -0.48], [0, 0.1, -0.4], [0, 0.88]] : [[0, -0.05, -0.5], [0, 0.02, -0.46], [0, 0.1, -0.4], [0, 0.88]]])
  loft(k, st, { paint: (j) => k.c(j < (o.far ? 1 : 2) ? ANTI : colour), deck: DECK, well: { from: 1, to: 2, w: 0.6, y: 0.18, c: 0xcfc3aa } })
  k.c(CABIN).prism([-0.7, 0.5, 1.75, 0.55, 1.3, 1.0, -0.6, 1.1], -0.66, 0.66, { bevel: o.far ? 0 : 0.04, narrow: (y) => Math.max(0, y - 0.56) * 0.35 })
  k.c(GLASS).box(-0.4, 1.05, 0.76, 0.94, -0.61, 0.61) // the windows, proud of the cabin's leaning sides
  k.c(SPAR).rod([SLOOP.boom[0], 1.0, 0], [SLOOP.boom[0], SLOOP.mast, 0], 0.08, 0.05, o.far ? 4 : 6)
  if (o.far) return k
  k.box(0.86, 0.94, 5.3, 5.36, -0.6, 0.6) // spreaders
  k.c(GLASS).box(0.1, 0.7, 1.04, 1.1, -0.28, 0.28) // the hatch
  k.c(0x8a6a46).rod([-2.95, 0.72, 0], [-2.0, 0.86, 0], 0.03, 0.03, 4) // the tiller
  k.c(ANTI).prism([1.0, -0.38, -0.45, -0.38, -0.3, -1.35, 0.5, -1.35], -0.07, 0.07, { bevel: 0.03 })
  return k.prism([-2.7, -0.15, -3.05, -0.08, -3.0, -1.0, -2.75, -1.0], -0.035, 0.035)
}

// A sail as triangles (tri(a, b, c), points [x, y, z] with the sail lying in the x/y plane from its luff aft towards
// -x), bellied to +z by `belly` (1: full; a flat-shaded grid, so the belly shows as panels).
// 'main': from the boom's pivot (the tack) up the mast, its foot along the boom; 'jib': from its tack up the stay
// (y along the stay), its clew aft and low
export function sailTris(kind, belly, tri) {
  const R = kind === 'main' ? 5 : 4, C = 3
  const pt = (r, c) => {
    const u = r / R, v = c / C, f = 3.3 * v ** 0.75 * (1 - v) // the camber, deepest 43% back from the luff
    if (kind === 'main') {
      const chord = Math.max(0.14, 2.9 * (1 - u) + 0.3 * Math.sin(Math.PI * u)) // a little roach
      return [-0.05 - chord * v, 0.05 + 7.55 * u + 0.04 * v, belly * (0.13 * chord * f * (0.45 + 0.55 * Math.sin(Math.PI * (0.12 + 0.76 * u))) + 0.3 * u * v * v)]
    }
    const ly = 7.53 * u, ty = 1 + 6.53 * u, tx = 2.1 * (1 - u)
    return [-tx * v, ly + (ty - ly) * v, belly * (0.15 * tx * f + 0.25 * u * v * v * (1 - u))]
  }
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const a = pt(r, c), b = pt(r, c + 1), d = pt(r + 1, c + 1), e = pt(r + 1, c)
    if (!thin(a, b, d)) tri(a, b, d)
    if (!thin(a, d, e)) tri(a, d, e)
  }
}
