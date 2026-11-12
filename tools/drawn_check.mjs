// node tools/drawn_check.mjs <tiles dir> <i_j> [...]: the geometry rules (tools/geom_rules.py) over what the page draws
// from baked tiles, built by the page's own code (core/tile-worker.js, plugins/life/worker.js) for the detail tiles of
// these 4 km cells (their neighbours loaded too). Prints one JSON line per cell: {cell, issues: [{rule, x, y, h, v, what}]}
//   paint-ground  a ground decal (lane lines, stop lines, crosswalks, rails) off the ground (the terrain grid the drawn ground
//                 follows to 5 cm, heightAt) by more than TOL
//   paint-deck    a ground decal within 2.5 m under a deck's top, or over it (seen through or over the deck)
//   deck-gap      a drivable deck piece with no deck drawn under its lanes (not a hairline crack: none within 1 cm)
//   deck-overlap  another deck strip drawn within 3 m over or under a drivable deck's lanes, off by more than 0.15 m
//   lane-surface  a traffic lane or junction path (where the cars drive) off the surface drawn under it (deck or ground)
//   crosswalk     a crosswalk (crosswalks()) whose middle or ends are off its carriageway
//   pole          a street lamp's pole on a carriageway or cycle track, or off the ground with no deck under it
//   ground-crack  a slit in the drawn ground inside the tile (but round a tunnel's open box): beside an edge no other
//                 triangle shares, 2 cm out, no ground, or ground more than 1 cm higher or lower (a T-junction's step)
//   bldg-plinth   a building's windowless plinth (its walls carried down a slope) more than TOL over the ground beside it:
//                 a blank band under the building that reads as a building in the air from the street
//   object        things inside each other: parked cars, lamp poles, tree trunks, beach logs and the buildings' footprints
//   ground-seam   a step over 2 cm between a tile's ground and the next tile's along their shared edge (#557)
//   deck-zfight   two deck strips drawn over each other within 3 cm (they flicker; not where they only meet along an edge)
//   pier-air      a fixed pier's deck (section PIER) over water lower than 0.6 m over high water; a float's vertex over water that
//                 does not ride the tide (tile-worker.js ground(): the tidal byte 255; only where the page builds floats at all)
//   pier-land     a fixed pier (its pieces joined across tiles) with no rim point where the ground outside (0.5 m out, raw, not water)
//                 lies within 0.3 m of its top, and no street or path ending at it ('allowed': detached, no ground within 3 m)
import fs from 'node:fs'
import zlib from 'node:zlib'
import vm from 'node:vm'

const ROOT = new URL('../public/', import.meta.url)
const W = await import(new URL('core/tile-worker.js', ROOT).href)
const { parse, readLines, terrain, roads, pois, build, carEnds, crosswalks, eachPoly } = W
const onCarriage = W.onCarriage || ((c) => c), roadMask = W.roadMask || (() => null) // (an older tile-worker.js: measuring before a change)
const { sampleTerr, inPoly, wallHeight, SEA0, SEA_RISE } = await import(new URL('core/util.js', ROOT).href)
const [DIR, ...CELLS] = process.argv.slice(2)
const TOL = { paint: 0.15, lane: 0.3, deck: 0.15, plinth: 1.2 }
const CARR = new Set([25, 29, 30]) // cycle, road, arterial (tile-worker.js roadMask)
const LIFT = (kind) => 0.36 + (18 - kind) * 0.004 // tile-worker.js roads(): a deck strip over its z

function readRingAt(t, o) { // tile-worker.js readRing (not exported): count + delta-encoded int16 points -> [tile-local pts, next offset]
  const dv = t.dv, n = dv.getUint32(o, true), pts = new Float32Array(n * 2)
  let x = 0, y = 0
  o += 4
  for (let i = 0; i < n; i++) { x += dv.getInt16(o, true); y += dv.getInt16(o + 2, true); o += 4; pts[i * 2] = x * t.k; pts[i * 2 + 1] = y * t.k }
  return [pts, o]
}
const cache = new Map()
function tile(k) {
  if (cache.has(k)) return cache.get(k)
  const f = `${DIR}/0/${k}.bin`
  let T = null
  if (fs.existsSync(f)) {
    const r = fs.readFileSync(f), b = r[0] === 0x1f ? zlib.gunzipSync(r) : r
    const t = parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), terr = terrain(t), lines = readLines(t)
    T = { t, terr, lines, ox: t.ox, oy: t.oy, surf: roads(t, terr, lines, 0, pois(t)).surf }
  }
  cache.set(k, T)
  return T
}
const keyOf = (x, y) => `${Math.floor(x / 1024)}_${Math.floor(y / 1024)}`
function ground(x, y) { // the drawn ground (terrain + 0.02): the tile the point is in
  const T = tile(keyOf(x, y))
  if (!T) return null
  const g = sampleTerr(T.terr, x - T.ox, y - T.oy)
  return (T.terr.wall ? wallHeight(T.terr.wall, g, x - T.ox, y - T.oy) : g) + 0.02 // (on a seawall's walk: core/util.js)
}
// deck strips of loaded tiles by 8 m cell: [x0, y0, z0, x1, y1, z1, x2, y2, z2, kind]
const C = 8, grid = new Map(), gridded = new Set()
function addSurf(k) {
  if (gridded.has(k)) return
  gridded.add(k)
  const T = tile(k), g = T?.surf
  if (!g) return
  const P = g.position, I = g.index, K = g.aRoad
  for (let q = 0; q < I.length; q += 3) {
    const a = I[q] * 3, b = I[q + 1] * 3, c = I[q + 2] * 3
    const Tr = [P[a] + T.ox, -P[a + 2] + T.oy, P[a + 1], P[b] + T.ox, -P[b + 2] + T.oy, P[b + 1], P[c] + T.ox, -P[c + 2] + T.oy, P[c + 1], K[I[q] * 4 + 3]]
    for (let u = Math.floor(Math.min(Tr[0], Tr[3], Tr[6]) / C); u <= Math.floor(Math.max(Tr[0], Tr[3], Tr[6]) / C); u++)
      for (let v = Math.floor(Math.min(Tr[1], Tr[4], Tr[7]) / C); v <= Math.floor(Math.max(Tr[1], Tr[4], Tr[7]) / C); v++) {
        const key = u * 65536 + v; let l = grid.get(key); if (!l) grid.set(key, (l = [])); l.push(Tr)
      }
  }
}
function decks(x, y, m = 0) { // [[height, kind]] of the deck strips drawn over (x, y) (m: at least m metres inside them)
  const out = []
  for (const T of grid.get(Math.floor(x / C) * 65536 + Math.floor(y / C)) || []) {
    const d = (T[4] - T[7]) * (T[0] - T[6]) + (T[6] - T[3]) * (T[1] - T[7])
    if (!d) continue
    const l1 = ((T[4] - T[7]) * (x - T[6]) + (T[6] - T[3]) * (y - T[7])) / d, l2 = ((T[7] - T[1]) * (x - T[6]) + (T[0] - T[6]) * (y - T[7])) / d, l3 = 1 - l1 - l2
    const e = m ? [Math.hypot(T[3] - T[6], T[4] - T[7]), Math.hypot(T[0] - T[6], T[1] - T[7]), Math.hypot(T[0] - T[3], T[1] - T[4])].map((l) => (m * l) / Math.abs(d)) : [-1e-6, -1e-6, -1e-6]
    if (l1 >= e[0] && l2 >= e[1] && l3 >= e[2]) out.push([l1 * T[2] + l2 * T[5] + l3 * T[8], T[9]])
  }
  return out
}

// the ground's triangles touching the tile-local line x = at (u 0) or y = at (u 1), as [along, across, h] corners
function rimTris(g, u, at) {
  const P = g.position, I = g.index, out = []
  for (let q = 0; q < I.length; q += 3) {
    const v = [I[q], I[q + 1], I[q + 2]].map((i) => (u ? [P[i * 3], -P[i * 3 + 2], P[i * 3 + 1]] : [-P[i * 3 + 2], P[i * 3], P[i * 3 + 1]]))
    if (v.some((p) => Math.abs(p[1] - at) < 0.01)) out.push(v.map((p) => [p[0], p[1] - at, p[2]]))
  }
  return out
}
function rimAt(tris, s) { // their heights at (along s, across 0)
  const hs = []
  for (const v of tris) {
    const d = (v[1][1] - v[2][1]) * (v[0][0] - v[2][0]) + (v[2][0] - v[1][0]) * (v[0][1] - v[2][1]); if (!d) continue
    const l1 = ((v[1][1] - v[2][1]) * (s - v[2][0]) + (v[2][0] - v[1][0]) * -v[2][1]) / d, l2 = ((v[2][1] - v[0][1]) * (s - v[2][0]) + (v[0][0] - v[2][0]) * -v[2][1]) / d, l3 = 1 - l1 - l2
    if (l1 >= -1e-5 && l2 >= -1e-5 && l3 >= -1e-5) hs.push(l1 * v[0][2] + l2 * v[1][2] + l3 * v[2][2])
  }
  return hs
}
const drawn = new Map() // tile key -> its drawn ground (built once)
function check(cell) {
  const [ci, cj] = cell.split('_').map(Number), X0 = ci * 4096, Y0 = cj * 4096
  const own = [], issues = []
  const inCell = (x, y) => x >= X0 && x < X0 + 4096 && y >= Y0 && y < Y0 + 4096
  const add = (rule, x, y, h, v, what) => issues.push({ rule, x: +x.toFixed(1), y: +y.toFixed(1), h: +h.toFixed(1), v: +v.toFixed(2), what })
  for (let a = -1; a <= 4; a++) for (let b = -1; b <= 4; b++) { const k = `${ci * 4 + a}_${cj * 4 + b}`; if (tile(k)) { addSurf(k); if (a >= 0 && a < 4 && b >= 0 && b < 4) own.push(k) } }
  for (const k of own) {
    const T = tile(k), out = build(T.t, 0), [ki, kj] = k.split('_').map(Number) // what the page draws of it
    // ---- paint on the ground: each decal triangle at its corners, edge middles and centre
    const g = out.paint
    if (g) {
      const P = g.position, I = g.index
      for (let q = 0; q < I.length; q += 3) {
        const v = [I[q] * 3, I[q + 1] * 3, I[q + 2] * 3].map((a) => [P[a] + T.ox, -P[a + 2] + T.oy, P[a + 1]])
        const pts = [...v, ...[[0, 1], [1, 2], [2, 0]].map(([i, j]) => v[i].map((c, n) => (c + v[j][n]) / 2)), v[0].map((c, n) => (c + v[1][n] + v[2][n]) / 3)]
        let worst = null
        for (const [x, y, h] of pts) {
          const gr = ground(x, y)
          if (gr == null) continue
          const dk = decks(x, y).filter(([d]) => d > h - 0.3 && d < h + 2.5)
          if (dk.length) { if (!worst || worst[0] !== 'paint-deck') worst = ['paint-deck', x, y, h, Math.max(...dk.map(([d]) => d)) - h, 'under a deck']; continue }
          const off = h - 0.03 - gr // (decals 5 cm over the terrain, the ground 2 cm)
          if (Math.abs(off) > TOL.paint && (!worst || Math.abs(off) > worst[4])) worst = ['paint-ground', x, y, h, Math.abs(off), `${off.toFixed(2)} m off the ground`]
        }
        if (worst) add(...worst)
      }
    }
    // ---- decks: drawn under every drivable deck's lanes, at its profile
    for (const L of T.lines) {
      if (!L.drive || L.kind > 7 || !L.z || L.tunnel) continue
      const P = L.pts, n = P.length / 2
      for (let i = 0; i < n - 1; i++) {
        const x0 = P[i * 2] + T.ox, y0 = P[i * 2 + 1] + T.oy, x1 = P[i * 2 + 2] + T.ox, y1 = P[i * 2 + 3] + T.oy, l = Math.hypot(x1 - x0, y1 - y0)
        if (!l) continue
        const nx = -(y1 - y0) / l, ny = (x1 - x0) / l
        for (let s = i ? 0 : 2; s < l; s += 4) {
          const f = s / l, cx = x0 + (x1 - x0) * f, cy = y0 + (y1 - y0) * f, E = L.z[i] + (L.z[i + 1] - L.z[i]) * f + LIFT(L.kind)
          for (const o of [-0.35, 0, 0.35]) {
            const x = cx + nx * o * L.w, y = cy + ny * o * L.w
            const s1 = decks(x, y).filter(([h, kd]) => kd < 100 && Math.abs(h - E) < 3)
            if (!s1.length && !decks(x, y, -0.01).some(([h, kd]) => kd < 100 && Math.abs(h - E) < 3)) { add('deck-gap', x, y, E, 3, `no deck drawn (kind ${L.kind} ${L.a}-${L.b})`); continue }
            const off = s1.reduce((m, [h]) => (Math.abs(h - E) > Math.abs(m) ? h - E : m), 0)
            if (Math.abs(off) > TOL.deck) add('deck-overlap', x, y, E, Math.abs(off), `another deck ${off.toFixed(2)} m over/under ${L.a}-${L.b}`)
          }
        }
      }
    }
    // ---- crosswalks on their carriageway, lamp poles off it
    const carr = []
    eachPoly(T.t, CARR, (flat, holes) => {
      const ring = (a, b) => { const r = []; for (let i = a; i < b; i += 2) r.push([flat[i], flat[i + 1]]); return r }
      const st = [0, ...holes.map((h) => h * 2), flat.length], rings = st.slice(0, -1).map((a, i) => ring(a, st[i + 1]))
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const [x, y] of rings[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
      carr.push({ rings, bb: [x0, y0, x1, y1] })
    })
    const onCarr = (x, y) => carr.some(({ rings, bb }) => x >= bb[0] && y >= bb[1] && x <= bb[2] && y <= bb[3] && inPoly(x, y, rings[0]) && !rings.slice(1).some((r) => inPoly(x, y, r)))
    const lines = T.lines, ps = pois(T.t)
    for (const c of onCarriage(crosswalks(lines, carEnds(lines), ps, T.ox, T.oy), roadMask(T.t))) { // (as roads() draws them)
      const half = c.w / 2 - 0.75
      for (const s of [-1, 0, 1]) {
        const x = c.x - c.ty * half * s, y = c.y + c.tx * half * s
        if (x < 0 || y < 0 || x >= 1024 || y >= 1024) continue // (the next tile's ground)
        if (!onCarr(x, y)) { add('crosswalk', x + T.ox, y + T.oy, ground(x + T.ox, y + T.oy) ?? 0, 1, `crosswalk ${s ? 'end' : 'middle'} off the carriageway`); break }
      }
    }
    const pl = out.lights?.poles
    // ---- the ground: every triangle edge shared, but on the tile's edge and round a tunnel's open box
    const gr = out.ground
    if (gr) {
      const P = gr.position, I = gr.index, cnt = new Map(), key = (a) => Math.round(P[a * 3] * 50) * 65536 + Math.round(-P[a * 3 + 2] * 50)
      const tg = new Map(), TG = 4 // the triangles by 4 m cell
      for (let q = 0; q < I.length; q += 3) {
        for (const [a, b, o] of [[I[q], I[q + 1], I[q + 2]], [I[q + 1], I[q + 2], I[q]], [I[q + 2], I[q], I[q + 1]]]) {
          const ka = key(a), kb = key(b), k = ka < kb ? `${ka},${kb}` : `${kb},${ka}`
          const c = cnt.get(k); if (c) c[0]++; else cnt.set(k, [1, a, b, o])
        }
        const xs = [I[q], I[q + 1], I[q + 2]].map((v) => P[v * 3]), ys = [I[q], I[q + 1], I[q + 2]].map((v) => -P[v * 3 + 2])
        for (let u = Math.floor(Math.min(...xs) / TG); u <= Math.floor(Math.max(...xs) / TG); u++) for (let v = Math.floor(Math.min(...ys) / TG); v <= Math.floor(Math.max(...ys) / TG); v++) { const k = u * 65536 + v; let l = tg.get(k); if (!l) tg.set(k, (l = [])); l.push(q) }
      }
      const cover = (x, y) => { // the ground's heights over (x, y)
        const hs = []
        for (const q of tg.get(Math.floor(x / TG) * 65536 + Math.floor(y / TG)) || []) {
          const v = [I[q], I[q + 1], I[q + 2]].map((i) => [P[i * 3], -P[i * 3 + 2], P[i * 3 + 1]])
          const d = (v[1][1] - v[2][1]) * (v[0][0] - v[2][0]) + (v[2][0] - v[1][0]) * (v[0][1] - v[2][1]); if (!d) continue
          const l1 = ((v[1][1] - v[2][1]) * (x - v[2][0]) + (v[2][0] - v[1][0]) * (y - v[2][1])) / d, l2 = ((v[2][1] - v[0][1]) * (x - v[2][0]) + (v[0][0] - v[2][0]) * (y - v[2][1])) / d, l3 = 1 - l1 - l2
          if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) hs.push(l1 * v[0][2] + l2 * v[1][2] + l3 * v[2][2])
        }
        return hs
      }
      const open = [] // tunnel pieces' open stretches, this tile's and its neighbours' (the cut reaches over the seam): [x0, y0, x1, y1, reach]
      for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) {
        const N = tile(keyOf(T.ox + 512 + u * 1024, T.oy + 512 + v * 1024)), dx = u * 1024, dy = v * 1024
        if (N) for (const L of N.lines) if (L.tube) for (let i = 0; i < L.pts.length / 2 - 1; i++) if (L.tube[i] || L.tube[i + 1]) open.push([L.pts[i * 2] + dx, L.pts[i * 2 + 1] + dy, L.pts[i * 2 + 2] + dx, L.pts[i * 2 + 3] + dy, L.w / 2 + 3])
      }
      const nearOpen = (x, y) => open.some(([x0, y0, x1, y1, r]) => { const dx = x1 - x0, dy = y1 - y0, f = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(x - x0 - dx * f, y - y0 - dy * f) < r })
      const rim = (v) => v < 0.05 || v > 1023.95
      const WL = T.terr.wall, nearWall = (x, y) => { // a seawall's line: the walk's ground steps down to the water there, its face drawn over the step
        if (!WL) return false
        for (let r = 0; r < WL.runs.length - 1; r++) for (let i = WL.runs[r]; i < WL.runs[r + 1] - 1; i++) {
          const a = i * 7, b = a + 7, dx = WL.P[b] - WL.P[a], dy = WL.P[b + 1] - WL.P[a + 1], f = Math.max(0, Math.min(1, ((x - WL.P[a]) * dx + (y - WL.P[a + 1]) * dy) / (dx * dx + dy * dy || 1)))
          if (Math.hypot(x - WL.P[a] - dx * f, y - WL.P[a + 1] - dy * f) < 2) return true
        }
        return false
      }
      for (const [c, a, b, o] of cnt.values()) {
        if (c !== 1) continue
        const ax = P[a * 3], ay = -P[a * 3 + 2], bx = P[b * 3], by = -P[b * 3 + 2], L = Math.hypot(bx - ax, by - ay)
        if (L < 0.02 || (gr.cls[a] === 20 && gr.cls[b] === 20) || (rim(ax) && rim(bx) && Math.abs(ax - bx) < 0.1) || (rim(ay) && rim(by) && Math.abs(ay - by) < 0.1) || nearOpen((ax + bx) / 2, (ay + by) / 2) || nearWall((ax + bx) / 2, (ay + by) / 2)) continue
        let nx = -(by - ay) / L, ny = (bx - ax) / L
        if (nx * (P[o * 3] - ax) + ny * (-P[o * 3 + 2] - ay) > 0) { nx = -nx; ny = -ny } // (out, away from its triangle)
        for (const f of [0.25, 0.5, 0.75]) {
          const x = ax + (bx - ax) * f + nx * 0.02, y = ay + (by - ay) * f + ny * 0.02, ox = P[o * 3], oy = -P[o * 3 + 2], dd = (by - oy) * (ax - ox) + (ox - bx) * (ay - oy)
          const l1 = ((by - oy) * (x - ox) + (ox - bx) * (y - oy)) / dd, l2 = ((oy - ay) * (x - ox) + (ax - ox) * (y - oy)) / dd, h = l1 * P[a * 3 + 1] + l2 * P[b * 3 + 1] + (1 - l1 - l2) * P[o * 3 + 1] // (its own plane carried 2 cm on)
          if (x < 0 || y < 0 || x > 1024 || y > 1024) continue
          const hs = cover(x, y)
          if (!hs.length || hs.every((g) => Math.abs(g - h) > 0.02)) { add('ground-crack', x + T.ox, y + T.oy, h, hs.length ? Math.min(...hs.map((g) => Math.abs(g - h))) : 1, hs.length ? 'a step between ground triangles' : 'a gap in the ground'); break }
        }
      }
    }
    // ---- the ground across the tile's east and north edges: the next tile's own ground meets it there
    drawn.set(k, out.ground)
    if (gr) for (const [u, nk] of [[0, `${ki + 1}_${kj}`], [1, `${ki}_${kj + 1}`]]) {
      const N = tile(nk), ng = N && (drawn.get(nk) ?? (drawn.set(nk, build(N.t, 0).ground), drawn.get(nk)))
      if (!ng) continue
      const a = rimTris(gr, u, 1024), b = rimTris(ng, u, 0)
      let worst = null
      for (let s = 0.25; s < 1024; s += 0.5) {
        const ha = rimAt(a, s), hb = rimAt(b, s)
        if (!ha.length || !hb.length) continue
        const d = Math.min(...ha.flatMap((p) => hb.map((q) => Math.abs(p - q))))
        if (d > 0.02 && (!worst || d > worst[1])) worst = [s, d, ha[0]]
      }
      if (worst) add('ground-seam', T.ox + (u ? worst[0] : 1024), T.oy + (u ? 1024 : worst[0]), worst[2], worst[1], `a step in the ground across the tile's ${u ? 'north' : 'east'} edge`)
      }
    // ---- a building's windowless plinth (tile-worker.js buildings(): its walls carried down a slope) showing more than
    // TOL.plinth over the ground just outside it: from the street a blank band under the building, as if it stood in the air
    const bw = out.buildings
    if (bw?.position) {
      const P = bw.position, N = bw.normal, A = bw.aWin, seen = new Set()
      for (let v = 0; v < P.length / 3; v += 3) {
        if (Math.abs(N[v * 3 + 1]) > 10 || A[v * 4] !== 0 || A[v * 4 + 2] !== 0) continue // (plinths: no pattern, z 0)
        const xs = [0, 1, 2].map((k) => P[(v + k) * 3] + T.ox), ys = [0, 1, 2].map((k) => -P[(v + k) * 3 + 2] + T.oy), hs = [0, 1, 2].map((k) => P[(v + k) * 3 + 1])
        const x = (Math.min(...xs) + Math.max(...xs)) / 2 + (N[v * 3] / 127) * 0.6, y = (Math.min(...ys) + Math.max(...ys)) / 2 - (N[v * 3 + 2] / 127) * 0.6
        const g = ground(x, y), top = Math.max(...hs), k = `${Math.round(x)},${Math.round(y)}`
        if (g != null && top - g > TOL.plinth && !seen.has(k)) { seen.add(k); add('bldg-plinth', x, y, g, top - g, `a blank plinth ${(top - g).toFixed(1)} m tall under a building's wall`) }
      }
    }
    // ---- objects inside each other (tile-local): boxes [x, y, angle, half length, half width, what], discs [x, y, r, what]
    const boxes = [], discs = [], fpRings = []
    const fp = out.footprints, nCars = (out.parked.lot?.length || 0) / 5, nLogs = out.beach?.solid.length || 0
    if (fp) for (let r = 0; r < fp.start.length - 1 - nCars - nLogs; r++) { const ring = []; for (let q = fp.start[r]; q < fp.start[r + 1]; q += 2) ring.push([fp.pts[q] - T.ox, fp.pts[q + 1] - T.oy]); fpRings.push(ring) }
    for (const k of ['lot', 'kerb']) { const c = out.parked[k]; for (let i = 0; c && i < c.length; i += 5) boxes.push([c[i], -c[i + 2], c[i + 3], 2.3, 0.95, 'parked car']) }
    for (const [x, y, a, l, w] of out.beach?.solid || []) boxes.push([x, y, a, l, w, 'beach log'])
    if (pl) for (let i = 0; i < pl.length; i += 4) if (pl[i + 1] - ground(pl[i] + T.ox, -pl[i + 2] + T.oy) < 1) discs.push([pl[i], -pl[i + 2], 0.15, 'lamp pole']) // (on the ground: one up on a deck is the pole rule's)
    const tr = out.trees?.pos
    if (tr) for (let i = 0; i < tr.length; i += 3) discs.push([tr[i], -tr[i + 2], 0.25, 'tree trunk'])
    const corners = (b) => { const fx = Math.cos(b[2]), fy = Math.sin(b[2]); return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([p, q]) => [b[0] + fx * p * b[3] + fy * q * b[4], b[1] + fy * p * b[3] - fx * q * b[4]]) }
    const inBox = (b, x, y, m = 0) => { const fx = Math.cos(b[2]), fy = Math.sin(b[2]), dx = x - b[0], dy = y - b[1]; return Math.abs(dx * fx + dy * fy) < b[3] + m && Math.abs(dx * fy - dy * fx) < b[4] + m }
    const G2 = 24, og = new Map(), put = (x, y, v) => { const k = Math.floor(x / G2) * 4096 + Math.floor(y / G2); let l = og.get(k); if (!l) og.set(k, (l = [])); l.push(v) }
    const near = (x, y, fn) => { for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const v of og.get((Math.floor(x / G2) + i) * 4096 + Math.floor(y / G2) + j) || []) fn(v) }
    fpRings.forEach((r) => { const [x0, y0, x1, y1] = r.reduce(([a, b, c, d], [x, y]) => [Math.min(a, x), Math.min(b, y), Math.max(c, x), Math.max(d, y)], [1e9, 1e9, -1e9, -1e9]); for (let i = Math.floor(x0 / G2); i <= Math.floor(x1 / G2); i++) for (let j = Math.floor(y0 / G2); j <= Math.floor(y1 / G2); j++) { const k = i * 4096 + j; let l = og.get(k); if (!l) og.set(k, (l = [])); l.push({ ring: r }) } })
    boxes.forEach((b) => put(b[0], b[1], { box: b })); discs.forEach((d) => put(d[0], d[1], { disc: d }))
    const hit = new Set(), report = (x, y, what) => { const k = `${Math.round(x * 2)},${Math.round(y * 2)},${what}`; if (!hit.has(k)) { hit.add(k); add('object', x + T.ox, y + T.oy, ground(x + T.ox, y + T.oy) ?? 0, 1, what) } }
    for (const b of boxes) {
      const cs = corners(b)
      near(b[0], b[1], (o) => {
        if (o.ring) { if (cs.some(([x, y]) => inPoly(x, y, o.ring)) || o.ring.some(([x, y]) => inBox(b, x, y))) report(b[0], b[1], `${b[5]} in a building`) }
        else if (o.box && o.box !== b && o.box[0] + o.box[1] * 1e-3 < b[0] + b[1] * 1e-3) { if (cs.some(([x, y]) => inBox(o.box, x, y)) || corners(o.box).some(([x, y]) => inBox(b, x, y))) report(b[0], b[1], `${b[5]} on a ${o.box[5]}`) }
        else if (o.disc && inBox(b, o.disc[0], o.disc[1], o.disc[2])) report(o.disc[0], o.disc[1], `${o.disc[3]} in a ${b[5]}`)
      })
    }
    for (const d of discs) {
      if (d[3] !== 'lamp pole') continue // (trees: the bake's own; checked against the buildings there)
      near(d[0], d[1], (o) => {
        if (o.ring && inPoly(d[0], d[1], o.ring)) report(d[0], d[1], 'lamp pole in a building')
        else if (o.disc && o.disc !== d && Math.hypot(o.disc[0] - d[0], o.disc[1] - d[1]) < d[2] + o.disc[2]) report(d[0], d[1], `lamp pole in a ${o.disc[3]}`)
      })
    }
    // ---- deck strips over each other within 3 cm: they flicker
    for (const L of T.lines) {
      if (!L.z || L.tunnel || L.kind > 13) continue
      const P = L.pts
      for (let i = 0; i < P.length / 2 - 1; i++) {
        const x0 = P[i * 2] + T.ox, y0 = P[i * 2 + 1] + T.oy, x1 = P[i * 2 + 2] + T.ox, y1 = P[i * 2 + 3] + T.oy, l = Math.hypot(x1 - x0, y1 - y0)
        for (let s = 0; s < l; s += 2) {
          const hs = decks(x0 + (x1 - x0) * s / l, y0 + (y1 - y0) * s / l, 0.01).filter(([, k]) => k < 100).map(([h]) => h).sort((a, b) => a - b)
          for (let q = 1; q < hs.length; q++) if (hs[q] - hs[q - 1] > 0.001 && hs[q] - hs[q - 1] < 0.03) { add('deck-zfight', x0 + (x1 - x0) * s / l, y0 + (y1 - y0) * s / l, hs[q], hs[q] - hs[q - 1], `two deck strips ${(hs[q] - hs[q - 1]).toFixed(3)} m apart`); break }
        }
      }
    }
    if (pl) for (let i = 0; i < pl.length; i += 4) { // on the ground off the carriageways, or on a deck
      const x = pl[i], y = -pl[i + 2], h = pl[i + 1], g = ground(x + T.ox, y + T.oy)
      if (Math.abs(h - (g - 0.02)) < 0.3) { if (onCarr(x, y)) add('pole', x + T.ox, y + T.oy, h, 1, 'lamp pole on a carriageway') }
      else if (!decks(x + T.ox, y + T.oy).some(([d]) => Math.abs(d - h - 0.36) < 0.5)) add('pole', x + T.ox, y + T.oy, h, Math.abs(h - g), `lamp pole ${(h - g).toFixed(1)} m off the ground, no deck under it`)
    }
  }
  // ---- traffic: the life worker's lanes and junction paths over this cell, on the drawn surface
  const src = fs.readFileSync(new URL('plugins/life/worker.js', ROOT), 'utf8')
  const ctx = vm.createContext({ postMessage() {}, performance, console, Math })
  vm.runInContext(src, ctx)
  const add_ = []
  for (let a = -1; a <= 4; a++) for (let b = -1; b <= 4; b++) {
    const k = `${ci * 4 + a}_${cj * 4 + b}`, T = tile(k)
    if (!T) continue
    const pieces = T.lines.filter((L) => L.kind <= 13).map((L) => { const pts = new Float32Array(L.pts.length); for (let q = 0; q < pts.length; q += 2) { pts[q] = L.pts[q] + T.ox; pts[q + 1] = L.pts[q + 1] + T.oy } return { ...L, pts, tunnel: L.tunnel ? 1 : 0 } })
    add_.push({ key: `0/${k}`, level: 0, ox: T.ox, oy: T.oy, size: 1024, terrain: { n: T.terr.n, h: T.terr.h, wall: T.terr.wall, f: T.terr.f }, pieces, pois: [] })
  }
  ctx.onmessage({ data: { type: 'tiles', add: add_, drop: [] } })
  ctx.onmessage({ data: { type: 'area', area: { x: X0 + 2048, y: Y0 + 2048, r: 3600, vx: X0 + 2048, vy: Y0 + 2048, vr: 300 } } })
  const net = vm.runInContext('(() => { const g = buildCars(); let r; while (!(r = g.next()).done); return r.value })()', ctx)
  for (const g of [...net.lanes, ...[...net.nodes.values()].flatMap((n) => n.conns)]) {
    if (g.p?.tunnel || g.from?.p?.tunnel || g.to?.p?.tunnel) continue
    let worst = null
    for (let s = 0; s <= g.len; s += 2) {
      const o = vm.runInContext('(g, s) => at(g, s, {})', ctx)(g, s)
      if (!inCell(o.x, o.y)) continue
      const hs = decks(o.x, o.y).map(([q]) => q), gr = ground(o.x, o.y)
      if (gr != null) hs.push(gr)
      if (!hs.length) continue
      const near = hs.reduce((b, q) => (Math.abs(o.h - 0.2 - q) < Math.abs(o.h - 0.2 - b) ? q : b))
      const off = o.h - 0.2 - near
      if (Math.abs(off) > TOL.lane && (!worst || Math.abs(off) > worst[4])) worst = [o.x, o.y, o.h, off]
    }
    if (worst) { const p = g.conn ? g.from.p : g.p; add('lane-surface', worst[0], worst[1], worst[2], Math.abs(worst[3]), `${g.conn ? 'junction path after' : 'lane on'} ${p.z ? 'deck' : 'ground'} piece ${p.a}-${p.b} kind ${p.kind} ${worst[3].toFixed(2)} m off`) }
  }
  // ---- piers (tools/tiles.py pier_decks): the decks of section PIER (tile-worker.js readDecks, once the page has it), the floats the page draws
  {
    const HI = SEA0 + SEA_RISE, pieces = []
    for (const k of own) {
      const T = tile(k), sec = T.t.sections.PIER
      if (!sec) continue
      const dv = T.t.dv, n = dv.getUint16(sec.off, true)
      let o = sec.off + 2
      for (let i = 0; i < n; i++) {
        const flags = dv.getUint8(o), z = dv.getInt16(o + 1, true) / 10, nr = dv.getUint16(o + 3, true), rings = []
        o += 5
        for (let r = 0; r < nr; r++) { const [pts, o2] = readRingAt(T.t, o); o = o2; rings.push(pts) }
        pieces.push({ k, T, flags, z, rings, link: null })
      }
    }
    const raw = (T, x, y) => sampleTerr(T.terr, x, y)
    for (const d of pieces) { // pier-air: the deck's top at its ring points and edge middles
      for (const ring of d.rings) for (let i = 0; i < ring.length / 2; i++) {
        const j = (i + 1) % (ring.length / 2)
        for (const [x, y] of [[ring[i * 2], ring[i * 2 + 1]], [(ring[i * 2] + ring[j * 2]) / 2, (ring[i * 2 + 1] + ring[j * 2 + 1]) / 2]]) {
          const g = raw(d.T, x, y), top = Math.max(d.z, g + 0.06)
          if (g < SEA0 + 0.3 && top < Math.max(g, HI) + 0.6) { add('pier-air', x + d.T.ox, y + d.T.oy, top, top - Math.max(g, HI) - 0.6, `a fixed deck at ${top.toFixed(2)} over water (ground ${g.toFixed(2)}), high water ${HI.toFixed(2)}`); break }
        }
      }
    }
    for (const k of own) { // the floats: a vertex over water that does not ride (a page that builds them: ground.pier)
      const g = drawn.get(k) || build(tile(k).t, 0).ground, T = tile(k)
      if (!g?.pier) continue
      for (let i = 0; i < g.cls.length; i++) {
        if (g.cls[i] !== 20 || g.tidal[i] === 255) continue
        const x = g.position[i * 3], y = -g.position[i * 3 + 2], h = raw(T, x, y)
        if (h < SEA0 + 0.3 && Math.abs(g.position[i * 3 + 1] - h) < 0.05) { add('pier-air', x + T.ox, y + T.oy, h, 0, 'a float vertex over water that does not ride'); break }
      }
    }
    // pier-land: pieces that share a ring point (across a tile's edge) are one pier
    const par = pieces.map((_, i) => i), find = (i) => (par[i] === i ? i : (par[i] = find(par[i])))
    const at = new Map()
    pieces.forEach((d, i) => { for (const ring of d.rings) for (let q = 0; q < ring.length; q += 2) { const key = Math.round((ring[q] + d.T.ox) * 10) * 1e7 + Math.round((ring[q + 1] + d.T.oy) * 10); const j = at.get(key); if (j === undefined) at.set(key, i); else par[find(i)] = find(j) } })
    const comps = new Map()
    pieces.forEach((d, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(d) })
    const ends = [] // where a street or path ends: world x, y
    for (const k of own) for (const L of tile(k).lines) if (L.kind >= 8 && L.kind <= 12 || L.z) { const T = tile(k), n = L.pts.length; ends.push([L.pts[0] + T.ox, L.pts[1] + T.oy], [L.pts[n - 2] + T.ox, L.pts[n - 1] + T.oy]) }
    const land = (x, y) => { const g = ground(x, y); return g !== null && g - 0.02 > SEA0 + 0.3 ? g - 0.02 : null }
    for (const ds of comps.values()) {
      let best = Infinity, any3 = false, cx = 0, cy = 0, cn = 0, z0 = ds[0].z, touch = false
      for (const d of ds) d.rings.forEach((ring, r) => {
        const m = ring.length / 2; let area = 0
        for (let i = 0; i < m; i++) { const j = (i + 1) % m; area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1] }
        const sg = (area > 0 ? 1 : -1) * (r ? -1 : 1), edge = (u) => u < 1e-3 || u > 1024 - 1e-3
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m, ax = ring[i * 2], ay = ring[i * 2 + 1], bx = ring[j * 2], by = ring[j * 2 + 1], L = Math.hypot(bx - ax, by - ay)
          if (L < 1e-3 || (edge(ax) && edge(bx) && Math.abs(ax - bx) < 1e-3) || (edge(ay) && edge(by) && Math.abs(ay - by) < 1e-3)) continue
          const nx = ((by - ay) / L) * sg, ny = (-(bx - ax) / L) * sg
          for (let u = 0; u < L; u += 2) {
            const x = ax + ((bx - ax) * u) / L, y = ay + ((by - ay) * u) / L, wx = x + d.T.ox, wy = y + d.T.oy, top = Math.max(d.z, raw(d.T, x, y) + 0.06)
            cx += wx; cy += wy; cn++
            const g = land(wx + nx * 0.5, wy + ny * 0.5)
            if (g !== null) best = Math.min(best, Math.abs(g - top))
            if (ends.some(([ex, ey]) => Math.hypot(ex - wx, ey - wy) < 1.5)) touch = true
            if (!any3 && (land(wx + nx * 3, wy + ny * 3) !== null || g !== null)) any3 = true
          }
        }
      })
      if (touch || best <= 0.3 || !cn) continue
      const [x, y] = [cx / cn, cy / cn]
      if (!inCell(x, y)) continue
      add('pier-land', x, y, z0, best === Infinity ? 99 : best, `a fixed pier at ${z0.toFixed(1)} m meets no ground${best === Infinity ? '' : ` (nearest ${best.toFixed(2)} m off its top)`}`)
      if (!any3) issues[issues.length - 1].allowed = 'detached'
    }
  }
  return issues
}

for (const cell of CELLS) console.log(JSON.stringify({ cell, issues: check(cell) }))
