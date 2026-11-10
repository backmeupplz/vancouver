// Small helpers shared by the core, its tile workers and the plugins (no DOM, no three.js: tools/*.mjs import
// plugins that use them under node)

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
export const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a)) // an angle into -π .. π
export const EASE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2) // cubic in-out

// GLSL: a hash and smooth value noise over 2D, for the procedural shaders
export const NOISE_GLSL = `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }`

// a seeded random number generator (mulberry32): () => 0 .. 1
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// bilinear sample of an n×n height grid h over `size` metres (row 0 north) at tile-local (x, y north)
export function sampleGrid(h, n, size, x, y) {
  const c = size / (n - 1), fx = Math.min(n - 1.0001, Math.max(0, x / c)), fy = Math.min(n - 1.0001, Math.max(0, (size - y) / c))
  const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j
  return h[j * n + i] * (1 - u) * (1 - v) + h[j * n + i + 1] * u * (1 - v) + h[(j + 1) * n + i] * (1 - u) * v + h[(j + 1) * n + i + 1] * u * v
}

// The seawalls over a detail tile (tools/seawall.py, the SEAW section, tile-worker.js terrain()): the ground on top of
// a wall's walk up to its reach and the water or sand at its foot, the terrain's 8 m grid can't step. P: per point
// [x, y north (tile-local), top, foot, reach, end weight (0 at a run's ends), rail], 7 floats each; starts: each run's
// first point, then the total; ground(x, y): the terrain (its walk's, min(reach, 4) m in, is what the walk blends to at
// a run's ends: tools/seawall.py inland()). -> { seg, start, idx, G } segments in 32 m cells over the tile (tools/seawall.py height())
// The tide. The terrain has the sea's surface at SEA0 around Vancouver (no sea bed under it), and the map's water is
// baked as far as the high water line, lying on the shore's slope above SEA0. The lowest tide is the sea at SEA0, the
// highest SEA_RISE above it (city.sea.level; the real range is 5 m, drawn at 28% so that the low banks, the docks and
// the seawall's foot keep their places); the ground shader (materials.js) flattens the water to that level and draws
// the slope above it as wet shore
export const SEA0 = -0.7, SEA_RISE = 1.4
// the still water's height where the baked water lies at h, with the sea `level` above the baked one: the sea itself (and
// lower water) rises by it; water baked above the sea (a shelf, a lagoon) only once the sea reaches it
export const seaSurface = (h, level) => (h > SEA0 ? Math.max(h, SEA0 + level) : h + level)
const WALL_C = 32, WALL_N = 34, WALL_R = 32 // cell, cells across (one past each edge), the furthest a wall reaches (REACH + 4 + B_IN)
export function wallGrid(P, starts, ground) {
  const seg = []
  for (let r = 0; r < starts.length - 1; r++) for (let i = starts[r]; i < starts[r + 1] - 1; i++) seg.push(i)
  const lists = Array.from({ length: WALL_N * WALL_N }, () => [])
  const cell = (v) => Math.max(0, Math.min(WALL_N - 1, Math.floor(v / WALL_C) + 1))
  seg.forEach((i, k) => {
    const a = i * 7, b = a + 7
    for (let u = cell(Math.min(P[a], P[b]) - WALL_R); u <= cell(Math.max(P[a], P[b]) + WALL_R); u++)
      for (let v = cell(Math.min(P[a + 1], P[b + 1]) - WALL_R); v <= cell(Math.max(P[a + 1], P[b + 1]) + WALL_R); v++) lists[v * WALL_N + u].push(k)
  })
  const start = new Int32Array(lists.length + 1)
  lists.forEach((l, c) => { start[c + 1] = start[c] + l.length })
  const N = new Float32Array((P.length / 7) * 2) // per point its normal to the walk's side, at a corner between its segments' (tools/seawall.py vnormals)
  for (let r = 0; r < starts.length - 1; r++) for (let i = starts[r]; i < starts[r + 1] - 1; i++) {
    const dx = P[i * 7 + 7] - P[i * 7], dy = P[i * 7 + 8] - P[i * 7 + 1], l = Math.hypot(dx, dy) || 1e-9
    N[i * 2] -= dy / l; N[i * 2 + 1] += dx / l; N[i * 2 + 2] -= dy / l; N[i * 2 + 3] += dx / l
  }
  for (let i = 0; i < N.length; i += 2) { const l = Math.hypot(N[i], N[i + 1]) || 1e-9; N[i] /= l; N[i + 1] /= l }
  const G = new Float32Array(P.length / 7)
  for (let i = 0; i < G.length; i++) { const o = Math.min(P[i * 7 + 4], 4); G[i] = ground ? ground(P[i * 7] + N[i * 2] * o, P[i * 7 + 1] + N[i * 2 + 1] * o) : NaN }
  const segRun = new Int32Array(seg.length)
  for (let k = 0, r = 0; k < seg.length; k++) { while (seg[k] >= starts[r + 1]) r++; segRun[k] = r }
  return { P, N, G, runs: Int32Array.from(starts), seg: Int32Array.from(seg), segRun, start, idx: Int32Array.from(lists.flat()) }
}
// the drawn ground at tile-local (x, y) over the terrain's g there (tools/seawall.py height(), the same numbers): low
// true for the ground classes at a wall's foot (water, sand) and what lies on them, else the walk's side (to 0.2 m out
// over the wall's line: tools/tiles.py cuts the ground there, under the face)
const B_IN = 10, LOW = 2, LOW_B = 8, FADE = 3
export function wallHeight(W, g, x, y, low) {
  const c = Math.max(0, Math.min(WALL_N - 1, Math.floor(y / WALL_C) + 1)) * WALL_N + Math.max(0, Math.min(WALL_N - 1, Math.floor(x / WALL_C) + 1))
  const P = W.P, N = W.N
  // each run's nearest segment (the cell lists them in run order) -> the two nearest runs, cross-faded where they're
  // about as near (a run ending by another, two walls at a corner: no step between them)
  let d1 = WALL_R, h1 = g, d2 = WALL_R, h2 = g, run = -1, rd = WALL_R, rh = g
  const done = () => { if (rd < d1) { d2 = d1; h2 = h1; d1 = rd; h1 = rh } else if (rd < d2) { d2 = rd; h2 = rh } }
  for (let q = W.start[c]; q < W.start[c + 1]; q++) {
    const i = W.seg[W.idx[q]], r = W.segRun[W.idx[q]]
    if (r !== run) { done(); run = r; rd = WALL_R; rh = g }
    const a = i * 7, b = a + 7, ax = P[a], ay = P[a + 1], dx = P[b] - ax, dy = P[b + 1] - ay, L2 = dx * dx + dy * dy || 1e-9
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)), dist = Math.hypot(x - ax - dx * u, y - ay - dy * u)
    if (dist >= rd) continue
    rd = dist // (off a segment's end, the side its corner's normal says)
    const sd = u <= 0 ? (x - ax) * N[i * 2] + (y - ay) * N[i * 2 + 1] : u >= 1 ? (x - P[b]) * N[i * 2 + 2] + (y - P[b + 1]) * N[i * 2 + 3] : dx * (y - ay) - dy * (x - ax)
    const d = sd < 0 ? -dist : dist, lerp = (o) => P[a + o] + (P[b + o] - P[a + o]) * u, F = lerp(5)
    if (low ? d >= 0.4 : d > -0.2) { // the walk: toward a run's ends first the terrain on its walk (the coping stays on it), then the terrain here
      const gw = W.G ? W.G[i] + (W.G[i + 1] - W.G[i]) * u : NaN, Gc = gw === gw ? g + (gw - g) * Math.min(1, 2 * F) : g
      rh = g + (Gc + (lerp(2) - Gc) * F - g) * Math.max(0, Math.min(1, 1 - (d - lerp(4)) / B_IN))
    } else rh = g + (lerp(3) - g) * Math.max(0, Math.min(1, 1 - (-d - LOW) / LOW_B)) * F
  }
  done()
  const t = Math.min(1, (d2 - d1) / FADE)
  return h1 + (h2 - h1) * 0.5 * (1 - t * t * (3 - 2 * t))
}
// the drawn terrain at tile-local (x, y north): its grid (sampleGrid) plus, where the bake left them, the 2 m offsets
// under the streets the grid can't follow (section TFIN, tile-worker.js terrain(): f.B each 16 x 16 block's slot in
// f.V, or -1)
export function sampleTerr(T, x, y) {
  const g = sampleGrid(T.h, T.n, T.size, x, y), f = T.f
  if (!f) return g
  const N = f.n, fx = Math.min(N - 1.0001, Math.max(0, x / 2)), fy = Math.min(N - 1.0001, Math.max(0, (T.size - y) / 2))
  const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j
  const at = (a, b) => { const s = f.B[(b >> 4) * f.nb + (a >> 4)]; return s < 0 ? 0 : f.V[s * 256 + (b & 15) * 16 + (a & 15)] }
  return g + at(i, j) * (1 - u) * (1 - v) + at(i + 1, j) * u * (1 - v) + at(i, j + 1) * (1 - u) * v + at(i + 1, j + 1) * u * v
}

// a circle (x, y, r) against a box (centre cx, cy, unit forward fx, fy, half length hl and width hw; right is
// (fy, -fx)): how to push the circle out { x, y } (one reused object: read it before asking again), or null
const PUSH = { x: 0, y: 0 }
export function circleBox(x, y, r, cx, cy, fx, fy, hl, hw) {
  const dx = x - cx, dy = y - cy, lf = dx * fx + dy * fy, lr = dx * fy - dy * fx
  let ef = lf - clamp(lf, -hl, hl), er = lr - clamp(lr, -hw, hw), d = Math.hypot(ef, er), k
  if (d < 1e-6) { // centre inside: out through the nearest side
    const pf = hl - Math.abs(lf), pr = hw - Math.abs(lr)
    if (pf < pr) { ef = Math.sign(lf) || 1; er = 0; k = r + pf } else { ef = 0; er = Math.sign(lr) || 1; k = r + pr }
  } else if (d < r) k = (r - d) / d
  else return null
  PUSH.x = (ef * fx + er * fy) * k; PUSH.y = (ef * fy - er * fx) * k
  return PUSH
}

// is (x, y) inside the ring pts ([[x, y], …])? (even-odd)
export function inPoly(x, y, pts) {
  let c = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j]
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c
  }
  return c
}

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`) // for innerHTML

// fetch JSON, failing on an HTTP error rather than parsing its page
export const getJSON = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json() })

// Vancouver wall-clock time at epoch ms: { ymd: 'YYYYMMDD', sec: seconds since local midnight, wd: 'Mon', hm: 'HH:MM', p: the parts }
const FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' })
export function vancouver(ms) {
  const p = {}
  for (const { type, value } of FMT.formatToParts(ms)) p[type] = value
  return { ymd: p.year + p.month + p.day, sec: +p.hour * 3600 + +p.minute * 60 + +p.second + (((ms % 1000) + 1000) % 1000) / 1000, wd: p.weekday, hm: `${p.hour}:${p.minute}`, p }
}
