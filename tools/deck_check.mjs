// node tools/deck_check.mjs [--tiles dir] [--cells i_j,..] [--bridges] [--top n] [--kind k,..] [--cars [--worker file]] [--only bridge,..] [--out file.json]
// Bridges, overpasses and viaducts: does everything on a deck stand on the deck as drawn? For every drivable deck
// piece of the baked detail tiles (public/tiles, built by the real tile worker), every 4 m along it and across its
// lanes, it compares with the deck profile (the piece's z, as the deck strip lifts it):
//   deck    the drawn deck top there (tile-worker.js roads(): the strips of every tile, neighbours too) — off when
//           another deck strip covers it more than 0.15 m higher or lower (decks meeting at different heights), or
//           none at all (a gap in the deck)
//   joint   two deck pieces meeting at a node at heights more than 0.15 m apart (steps at joints, tile edges)
//   paint   the ground decals (lane lines, stop lines, crosswalks) within 2.5 m under or anywhere over the deck there
//   van     the drive plugin's road top (surface(): z + 0.58 within 1.2 m of the edge) where no deck is drawn
//   cars    (--cars) the traffic sim (plugins/life/worker.js, run under node on these tiles round each bridge):
//           every car's wheels against the drawn surface under it (deck strips or ground), a car more than 0.5 m
//           off it is flying (or sunk)
// Prints counts per kind (samples and 25 m spots) overall and per named bridge (--bridges), and the worst spots.
import fs from 'node:fs'
import zlib from 'node:zlib'
import vm from 'node:vm'

const ROOT = new URL('../public/', import.meta.url)
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true }
const TILES = opt('--tiles') ? new URL(`file://${fs.realpathSync(opt('--tiles'))}/`) : new URL('tiles/', ROOT)
const { parse, readLines, terrain, roads } = await import(new URL('core/tile-worker.js', ROOT).href)
const index = JSON.parse(fs.readFileSync(new URL('index.json', TILES)))
const [LAT_O, LON_O] = index.origin, [KX, KY] = index.k
const xy = (lat, lon) => [(lon - LON_O) * KX, (lat - LAT_O) * KY]
const BRIDGES = { // name: [lat, lon] of its middle; a spot belongs to the nearest within 900 m
  burrard: [49.2747, -123.1376], granville: [49.2716, -123.1338], cambie: [49.2729, -123.1146], lionsgate: [49.3152, -123.1385],
  ironworkers: [49.2955, -123.0258], knight: [49.2071, -123.0768], oak: [49.2047, -123.1288], arthurlaing: [49.1985, -123.1530],
  portmann: [49.2208, -122.8133], pattullo: [49.2122, -122.8952], georgia: [49.2788, -123.1027], hwy1_willingdon: [49.2567, -123.0055],
  hwy1_grandview: [49.2585, -123.0245], skytrain_joyce: [49.2384, -123.0318],
}
const BXY = Object.fromEntries(Object.entries(BRIDGES).map(([k, [la, lo]]) => [k, xy(la, lo)]))
const bridgeOf = (x, y) => { let b = null, bd = 900; for (const [k, [bx, by]] of Object.entries(BXY)) { const d = Math.hypot(x - bx, y - by); if (d < bd) { bd = d; b = k } } return b }

// ---------------------------------------------------------------- the tiles: decks, paint, ground
const raw = (k, lvl = 0) => { const f = new URL(`${lvl}/${k}.bin`, TILES); if (!fs.existsSync(f)) return null; const r = fs.readFileSync(f), b = r[0] === 0x1f ? zlib.gunzipSync(r) : r; return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }
const cells = opt('--cells') ? new Set(String(opt('--cells')).split(',')) : null // only the detail tiles of these 4 km cells (a test bake's)
const keys = fs.readdirSync(new URL('0/', TILES)).filter((f) => f.endsWith('.bin')).map((f) => f.slice(0, -4))
  .filter((k) => { const [i, j] = k.split('_').map(Number); return !cells || cells.has(`${Math.floor(i / 4)}_${Math.floor(j / 4)}`) })
const keySet = new Set(keys), inKeys = (x, y) => keySet.has(`${Math.floor(x / 1024)}_${Math.floor(y / 1024)}`) // (checked there)
const want = new Set()
for (const k of keys) {
  const t = raw(k)
  if (!readLines(t).some((L) => L.z && !L.tunnel)) continue
  const [i, j] = k.split('_').map(Number)
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) want.add(`${i + a}_${j + b}`)
}
const tiles = new Map()
const C = 8, cell = (x, y) => Math.floor(x / C) * 65536 + Math.floor(y / C)
const tris = { surf: new Map(), paint: new Map() }
function addTris(map, g, ox, oy, kindOf, tile) {
  if (!g) return
  const P = g.position, I = g.index
  for (let q = 0; q < I.length; q += 3) {
    const a = I[q] * 3, b = I[q + 1] * 3, c = I[q + 2] * 3
    const T = [P[a] + ox, -P[a + 2] + oy, P[a + 1], P[b] + ox, -P[b + 2] + oy, P[b + 1], P[c] + ox, -P[c + 2] + oy, P[c + 1], kindOf(I[q]), tile]
    for (let u = Math.floor(Math.min(T[0], T[3], T[6]) / C); u <= Math.floor(Math.max(T[0], T[3], T[6]) / C); u++)
      for (let v = Math.floor(Math.min(T[1], T[4], T[7]) / C); v <= Math.floor(Math.max(T[1], T[4], T[7]) / C); v++) {
        const k = u * 65536 + v; let l = map.get(k); if (!l) map.set(k, (l = [])); l.push(T)
      }
  }
}
for (const k of want) {
  const t = raw(k)
  if (!t) continue
  const terr = terrain(t), lines = readLines(t), rd = roads(t, terr, lines, 0, [])
  tiles.set(k, { t, terr, lines, ox: t.ox, oy: t.oy })
  addTris(tris.surf, rd.surf, t.ox, t.oy, (v) => rd.surf.aRoad[v * 4 + 3], k)
  addTris(tris.paint, rd.paint, t.ox, t.oy, () => 0, k)
}
// heights of the triangles of `map` over (x, y): [[h, kind], ...]
function under(map, x, y) {
  const out = []
  for (const T of map.get(cell(x, y)) || []) {
    const d = (T[4] - T[7]) * (T[0] - T[6]) + (T[6] - T[3]) * (T[1] - T[7])
    if (!d) continue
    const l1 = ((T[4] - T[7]) * (x - T[6]) + (T[6] - T[3]) * (y - T[7])) / d, l2 = ((T[7] - T[1]) * (x - T[6]) + (T[0] - T[6]) * (y - T[7])) / d, l3 = 1 - l1 - l2
    if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) out.push([l1 * T[2] + l2 * T[5] + l3 * T[8], T[9]])
  }
  return out
}
function ground(x, y) { // the drawn ground (terrain + 0.02), as the page's heightAt
  const T = tiles.get(`${Math.floor(x / 1024)}_${Math.floor(y / 1024)}`)
  if (!T) return null
  const { n, h } = T.terr, c = 1024 / (n - 1), fx = Math.min(n - 1.0001, Math.max(0, (x - T.ox) / c)), fy = Math.min(n - 1.0001, Math.max(0, (1024 - (y - T.oy)) / c)), i = fx | 0, j = fy | 0, u = fx - i, v = fy - j
  return h[j * n + i] * (1 - u) * (1 - v) + h[j * n + i + 1] * u * (1 - v) + h[(j + 1) * n + i] * (1 - u) * v + h[(j + 1) * n + i + 1] * u * v + 0.02
}
const LIFT = (kind) => 0.36 + (18 - kind) * 0.004 // tile-worker.js roads(): a deck strip over its z

// ---------------------------------------------------------------- the checks
const found = [] // { kind, x, y, v (metres off), what }
const DRIVE = (L) => L.drive && L.kind <= 7 && L.z && !L.tunnel
const ends = new Map() // node id -> [[z, kind, x, y]] of deck pieces ending there (all tiles: tile edges too)
let samples = 0
for (const [k, T] of tiles) for (const L of T.lines) { // every drivable piece's ends: decks, and the streets going on from them
  if (!L.drive || L.kind > 7 || L.tunnel) continue
  const P = L.pts, n = P.length / 2
  for (const [e, id] of [[0, L.a], [n - 1, L.b]]) { let a = ends.get(id); if (!a) ends.set(id, (a = [])); a.push([L.z ? L.z[e] : null, L.kind, P[e * 2] + T.ox, P[e * 2 + 1] + T.oy, `${L.a}-${L.b}`]) }
}
for (const [k, T] of tiles) {
  if (!keySet.has(k)) continue
  for (const L of T.lines) {
    if (!DRIVE(L)) continue
    const P = L.pts, n = P.length / 2
    for (let i = 0; i < n - 1; i++) {
      const x0 = P[i * 2] + T.ox, y0 = P[i * 2 + 1] + T.oy, x1 = P[i * 2 + 2] + T.ox, y1 = P[i * 2 + 3] + T.oy, l = Math.hypot(x1 - x0, y1 - y0)
      if (!l) continue
      const nx = -(y1 - y0) / l, ny = (x1 - x0) / l
      for (let s = i ? 0 : 2; s < l; s += 4) {
        const f = s / l, cx = x0 + (x1 - x0) * f, cy = y0 + (y1 - y0) * f, E = L.z[i] + (L.z[i + 1] - L.z[i]) * f + LIFT(L.kind)
        for (const o of [-0.35, 0, 0.35]) {
          const x = cx + nx * o * L.w, y = cy + ny * o * L.w
          samples++
          const s1 = under(tris.surf, x, y).filter(([h, kd]) => kd < 100 && Math.abs(h - E) < 3)
          if (!s1.length) found.push({ kind: 'deck-gap', x, y, h: E, v: 3, what: `no deck drawn (kind ${L.kind})` })
          else {
            const top = Math.max(...s1.map(([h]) => h)), low = Math.min(...s1.map(([h]) => h))
            const off = Math.abs(top - E) > Math.abs(low - E) ? top - E : low - E
            if (Math.abs(off) > 0.15) found.push({ kind: 'deck-off', x, y, h: E, v: Math.abs(off), what: `another deck ${off.toFixed(2)} m over/under the profile` })
          }
          const pt = under(tris.paint, x, y).filter(([h]) => h > E - 0.3) // (paint further under the deck is hidden by it)
          if (pt.length) { const h = Math.max(...pt.map(([h]) => h)); found.push({ kind: 'paint', x, y, h: E, v: Math.abs(h - E), what: `paint ${(h - E).toFixed(2)} m from the deck top` }) }
        }
        // the van: within 1.2 m past the strip's edge it rides z + 0.58 (drive surface()); is a deck drawn there?
        for (const sd of [-1, 1]) {
          const x = cx + nx * sd * (L.w / 2 + 0.8), y = cy + ny * sd * (L.w / 2 + 0.8)
          const s1 = under(tris.surf, x, y).filter(([h]) => Math.abs(h - E) < 1)
          const g = ground(x, y)
          if (!s1.length && g != null && E - g > 1.2) found.push({ kind: 'van-edge', x, y, h: E, v: E - g, what: `van on air ${(E - g).toFixed(1)} m over the ground beside the deck` })
        }
      }
    }
  }
}
// paint off the ground it is painted on (a decal past its tile's edge follows that tile's terrain, clamped there)
const seenT = new Set()
for (const l of tris.paint.values()) for (const T of l) {
  if (seenT.has(T) || !keySet.has(T[10])) continue // (a checked tile's paint)
  seenT.add(T)
  for (let q = 0; q < 9; q += 3) {
    const x = T[q], y = T[q + 1], g = ground(x, y)
    if (g == null || Math.abs(T[q + 2] - 0.05 - g) < 0.3) continue
    if (under(tris.surf, x, y).some(([h]) => Math.abs(h - T[q + 2]) < 1)) continue // (on a ramp's deck: counted above)
    found.push({ kind: 'paint-ground', x, y, h: g, v: Math.abs(T[q + 2] - 0.05 - g), what: `paint ${(T[q + 2] - 0.05 - g).toFixed(2)} m off the ground` })
    break
  }
}
for (const [id, a] of ends) {
  const zs = a.filter((e) => e[0] != null).map((e) => e[0])
  if (!zs.length) continue
  const d = Math.max(...zs) - Math.min(...zs)
  if (d > 0.15) found.push({ kind: 'joint', x: a[0][2], y: a[0][3], h: Math.max(...zs), v: d, what: `deck ends at node ${id} ${d.toFixed(2)} m apart` })
  // a street going on at grade from a deck end up in the air: its cars, paint and van drop to the ground there
  const st = a.find((e) => e[0] == null), g = st && inKeys(st[2], st[3]) && ground(st[2], st[3])
  if (st && typeof g === "number" && Math.min(...zs) + LIFT(0) - g > 1.5) found.push({ kind: 'air-joint', x: st[2], y: st[3], h: Math.min(...zs), v: Math.min(...zs) + LIFT(0) - g, what: `street ${st[4]} (kind ${st[1]}) goes on at grade from a deck ${(Math.min(...zs) - g).toFixed(1)} m up, node ${id}` })
}

// ---------------------------------------------------------------- the traffic, run round each bridge
const carStats = { cars: 0 }
if (opt('--cars')) {
  const src = fs.readFileSync(opt('--worker') || new URL('plugins/life/worker.js', ROOT), 'utf8') // (--worker: another version of it)
  for (const [name, [bx, by]] of Object.entries(BXY)) {
    if (opt('--only') && !String(opt('--only')).split(',').includes(name)) continue
    const got = [], ctx = vm.createContext({ postMessage: (m) => got.push(m), performance, console, Math: Object.assign(Object.create(Math), { random: mulberry(7) }) })
    vm.runInContext(src, ctx)
    const send = (m) => ctx.onmessage({ data: m })
    const add = []
    for (const [k, T] of tiles) {
      const [i, j] = k.split('_').map(Number)
      if (Math.max(Math.abs(i * 1024 + 512 - bx), Math.abs(j * 1024 + 512 - by)) > 1600) continue
      const pieces = T.lines.filter((L) => L.kind <= 13).map((L) => { const pts = new Float32Array(L.pts.length); for (let q = 0; q < pts.length; q += 2) { pts[q] = L.pts[q] + T.ox; pts[q + 1] = L.pts[q + 1] + T.oy } return { ...L, pts, tunnel: L.tunnel ? 1 : 0 } })
      add.push({ key: `0/${k}`, level: 0, ox: T.ox, oy: T.oy, size: 1024, terrain: { n: T.terr.n, h: T.terr.h }, pieces, pois: [] })
    }
    if (!add.length) continue
    send({ type: 'opts', opts: { cars: true, people: false, bikes: false, density: 4, hour: 17, maxCars: 1500, maxPeople: 0 } })
    send({ type: 'tiles', add, drop: [] })
    send({ type: 'area', area: { x: bx, y: by, r: 900, vx: bx, vy: by, vr: 300 } })
    let buf = null
    for (let f = 0; f < 1800; f++) {
      got.length = 0
      send({ type: 'tick', dt: 1 / 30, buf })
      const m = got.find((q) => q.type === 'frame')
      if (!m) continue
      buf = m.buf
      if (f % 60 || f < 300) continue
      const live = vm.runInContext('cars', ctx) // (the frame's order: by kind)
      const byId = new Map(live.map((c) => [c.id, c]))
      for (let c = 0; c < m.cars; c++) {
        const x = buf[c * 8], h = buf[c * 8 + 1], y = -buf[c * 8 + 2]
        // the surface under the car: deck strips and the ground; the lane rides 0.17 to 0.25 m over it
        const hs = under(tris.surf, x, y).map(([q]) => q), g = ground(x, y)
        if (g != null) hs.push(g)
        if (!hs.length || !inKeys(x, y)) continue
        carStats.cars++
        const near = hs.reduce((b, q) => (Math.abs(h - 0.2 - q) < Math.abs(h - 0.2 - b) ? q : b))
        const off = h - 0.2 - near
        if (Math.abs(off) > 0.5) {
          const car = byId.get(buf[m.base + c * 2]), sg = car?.seg, p = sg?.conn ? sg.from.p : sg?.p
          const on = sg ? `${sg.conn ? 'junction after ' : ''}${p.z ? 'deck' : 'ground'} piece ${p.a}-${p.b} kind ${p.kind}` : ''
          found.push({ kind: off > 0 ? 'car-flying' : 'car-sunk', x, y, h, v: Math.abs(off), what: `car ${off.toFixed(2)} m off the drawn road, on a ${on}` })
        }
      }
    }
  }
}
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

// ---------------------------------------------------------------- report
const kinds = ['deck-gap', 'deck-off', 'joint', 'air-joint', 'paint', 'paint-ground', 'van-edge', 'car-flying', 'car-sunk']
const spots = new Map()
for (const f of found) {
  const k = `${f.kind} ${Math.round(f.x / 25)} ${Math.round(f.y / 25)}`, s = spots.get(k)
  if (!s) spots.set(k, { ...f, n: 1 }); else { s.n++; if (f.v > s.v) Object.assign(s, f, { n: s.n }) }
}
const list = [...spots.values()].sort((a, b) => b.n * b.v - a.n * a.v)
const link = (s) => `#${Math.round(s.x * 6 + 23551.5)},${Math.round(9727.5 - (s.y * 0.5 + (s.h || 0) * 0.866) * 6)},1.5`
console.log(`${samples} deck samples on ${[...tiles.keys()].filter((k) => keySet.has(k)).length} tiles${opt('--cars') ? `, ${carStats.cars} car positions` : ''}`)
console.log('kind         samples  spots')
for (const k of kinds) console.log(`${k.padEnd(12)} ${String(found.filter((f) => f.kind === k).length).padStart(7)} ${String(list.filter((s) => s.kind === k).length).padStart(6)}`)
if (opt('--bridges')) {
  console.log('\nbridge            ' + kinds.map((k) => k.padStart(10)).join(''))
  for (const b of Object.keys(BRIDGES)) console.log(b.padEnd(18) + kinds.map((k) => String(list.filter((s) => s.kind === k && bridgeOf(s.x, s.y) === b).length).padStart(10)).join(''))
}
console.log('\nworst spots:')
for (const s of list.filter((s) => !opt('--kind') || String(opt('--kind')).split(',').includes(s.kind)).slice(0, +opt('--top', 25))) console.log(`${s.kind.padEnd(11)} ${String(s.n).padStart(4)}x ${s.v.toFixed(2)} m  ${s.what}  ${link(s)} (${s.x.toFixed(0)},${s.y.toFixed(0)})  ${bridgeOf(s.x, s.y) || ''}`)
if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify({ kinds: Object.fromEntries(kinds.map((k) => [k, { samples: found.filter((f) => f.kind === k).length, spots: list.filter((s) => s.kind === k).length }])), spots: list }))
