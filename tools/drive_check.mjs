// node tools/drive_check.mjs [--routes all|99,14,R4] [--grid [step_m]] [--only bus|van] [--procs n] [--out file.json] [--secs n]
// Drivability: the real drive plugin (public/plugins/drive, its physics, decks, kerbs and collisions) runs headless
// under node on the baked tiles (public/tiles, built by the real tile worker), with an autopilot at the wheel:
//   bus routes: the 12 m / 18 m bus (whichever the route runs) follows its GPS line (route.js) from the first stop to
//   the last, each way; grid: the van along the arterials and collectors from a grid of starts across the city.
// Every incident is logged with where it happened and a view link: the vehicle's surface jumping > 0.5 m between
// frames, stuck > 3 s with the throttle down, bounced off a building while on the road (or off a post in the lane),
// tilted > 20°, dropping off a deck, riding a level other than the road it follows (on a deck over a street, under
// one), the GPS line off the road, a stop's bay off the road. Prints counts per kind and the worst spots; --out writes
// them all (worst first). Shards over --procs processes (default: cores - 2).
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'
import zlib from 'node:zlib'
import os from 'node:os'
import { spawn } from 'node:child_process'

const ROOT = new URL('../public/', import.meta.url)
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true }
const DT = 1 / 60, TRACE = args.includes('--trace')
const TILES = opt('--tiles') ? pathToFileURL(opt('--tiles') + '/') : new URL('tiles/', ROOT) // another bake to drive on

// ---------------------------------------------------------------- the jobs, and the shards that run them
const manifest = JSON.parse(fs.readFileSync(new URL('plugins/transit/data/manifest.json', ROOT)))
const lineIndex = JSON.parse(fs.readFileSync(new URL('plugins/transit/data/lines/index.json', ROOT)))
const tileIndex = JSON.parse(fs.readFileSync(new URL('index.json', TILES)))
function jobs() {
  const out = [], only = opt('--only', '')
  const want = opt('--routes', opt('--grid') ? '' : 'all')
  if (want && only !== 'van') {
    const names = want === true || want === 'all' ? null : new Set(String(want).split(','))
    for (const k of Object.keys(lineIndex)) {
      const r = manifest.routes[+k]
      if (names && !names.has(r.name)) continue
      lineIndex[k].forEach((_, dir) => out.push({ kind: 'bus', name: r.name, ri: +k, dir }))
    }
  }
  const g = opt('--grid')
  if (g && only !== 'bus') { // starts every `step` m over the map's land, each way along the nearest arterial
    const step = g === true ? 2000 : +g, [x0, y0, x1, y1] = tileIndex.extent
    for (let x = Math.ceil(x0 / step) * step; x < x1; x += step) for (let y = Math.ceil(y0 / step) * step; y < y1; y += step) {
      if (!fs.existsSync(new URL(`0/${Math.floor(x / 1024)}_${Math.floor(y / 1024)}.bin`, TILES))) continue
      for (const way of [0, 1]) out.push({ kind: 'van', x, y, way })
    }
  }
  return out
}

if (!args.includes('--shard')) { // the parent: shards, then the report
  const all = jobs(), procs = Math.min(all.length, +opt('--procs', Math.max(1, os.cpus().length - 2)))
  console.log(`${all.length} drives over ${procs} processes`)
  const t0 = Date.now(), results = []
  let done = 0
  await Promise.all(Array.from({ length: procs }, (_, s) => new Promise((ok) => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args, '--shard', `${s}/${procs}`], { stdio: ['ignore', 'pipe', 'inherit'] })
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.startsWith('{')) { if (line.trim()) console.log(line); continue }
        const r = JSON.parse(line); results.push(r); done++
        const n = r.incidents.length
        if (opt('--verbose') || n) console.log(`[${done}/${all.length}] ${r.label}: ${(r.km).toFixed(1)} km${r.end ? '' : ' (not to the end)'}, ${n} incident${n === 1 ? '' : 's'}`)
      }
    })
    p.on('exit', ok)
  })))
  report(results, (Date.now() - t0) / 1000)
  process.exit(0)
}
function report(results, secs) {
  const inc = results.flatMap((r) => r.incidents.map((i) => ({ ...i, drive: r.label })))
  const kinds = [...new Set(inc.map((i) => i.kind))].sort()
  const km = results.reduce((s, r) => s + r.km, 0)
  // one spot per kind and 25 m cell, however many drives met it
  const spots = new Map()
  for (const i of inc) {
    const k = `${i.kind} ${Math.round(i.x / 25)} ${Math.round(i.y / 25)}`
    const s = spots.get(k) || spots.set(k, { ...i, n: 0, drives: new Set(), worst: 0 }).get(k)
    s.n++; s.drives.add(i.drive)
    if (i.v > s.worst) Object.assign(s, { worst: i.v, x: i.x, y: i.y, h: i.h, what: i.what })
  }
  const list = [...spots.values()].map((s) => ({ ...s, drives: [...s.drives] })).sort((a, b) => b.drives.length - a.drives.length || b.worst - a.worst)
  console.log(`\n${results.length} drives, ${km.toFixed(0)} km in ${secs.toFixed(0)} s; ${results.filter((r) => !r.end).length} not to the end`)
  console.log('kind                 incidents  spots')
  for (const k of kinds) console.log(`${k.padEnd(20)} ${String(inc.filter((i) => i.kind === k).length).padStart(9)} ${String(list.filter((s) => s.kind === k).length).padStart(6)}`)
  console.log('\nworst spots (most drives first):')
  for (const s of list.slice(0, +opt('--top', 40))) console.log(`${s.kind.padEnd(14)} ${String(s.drives.length).padStart(3)} drives  ${s.what || ''}  ${link(s)}  ${s.drives.slice(0, 3).join(', ')}`)
  const out = opt('--out')
  if (out) fs.writeFileSync(out, JSON.stringify({ drives: results.map(({ incidents, ...r }) => ({ ...r, incidents: incidents.length })), kinds: Object.fromEntries(kinds.map((k) => [k, { incidents: inc.filter((i) => i.kind === k).length, spots: list.filter((s) => s.kind === k).length }])), spots: list }, null, 0))
}
function link(s) { // the site's view hash (main.js setView), close in
  return `https://vancouver.borodutch.com/#${Math.round(s.x * 6 + 23551.5)},${Math.round(9727.5 - (s.y * 0.5 + (s.h || 0) * 0.866) * 6)},1.5`
}

// ================================================================ a shard: the browser, enough of it
registerHooks({ resolve: (spec, ctx, next) => spec === 'three' ? { url: new URL('vendor/three.module.min.js', ROOT).href, shortCircuit: true } : next(spec, ctx) })
let NOW = 0 // the clock the plugin sees (performance.now), driven by the frames
Object.defineProperty(globalThis, 'performance', { value: { now: () => NOW }, configurable: true })
const fileFetch = async (u) => {
  const url = new URL(String(u), ROOT)
  if (url.protocol !== 'file:') throw new Error(`no network: ${url}`)
  try { return new Response(fs.readFileSync(fileURLToPath(url))) } catch { return new Response(null, { status: 404 }) }
}
globalThis.fetch = fileFetch
// the DOM: anything goes (an element is a callable proxy that keeps what is set on it)
function el() {
  const store = Object.create(null)
  return new Proxy(function () { return el() }, {
    get(t, k) {
      if (k in store) return store[k]
      if (k === Symbol.iterator) return function* () {}
      if (k === Symbol.toPrimitive) return () => 0
      if (k === 'then') return undefined
      if (k === 'length' || k === 'width' || k === 'height') return 0
      return (store[k] = el())
    },
    set(t, k, v) { store[k] = v; return true },
  })
}
const listeners = new Map()
Object.assign(globalThis, {
  window: globalThis, document: Object.assign(el(), { hidden: false }), location: { search: '?drivedebug', hash: '' },
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  addEventListener: (k, f) => listeners.set(k, f), removeEventListener() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
})
globalThis.document.createElement = () => el()
const THREE = await import('three')
const { parse, build } = await import(new URL('core/tile-worker.js', ROOT).href)
const { clamp, wrap, wallHeight } = await import(new URL('core/util.js', ROOT).href)
const drivePlugin = (await import(new URL('plugins/drive/index.js', ROOT).href)).default

// ---------------------------------------------------------------- the map: detail tiles as the page has them (tiles.js)
const [LAT_O, LON_O] = tileIndex.origin, [KX, KY] = tileIndex.k
const tiles = new Map() // "i_j" -> tile
const handlers = new Map()
const city = {
  version: 1, THREE, scene: new THREE.Scene(), overlay: new THREE.Scene(), camera: Object.assign(new THREE.OrthographicCamera(-640, 640, 400, -400, 1, 1e5), { zoom: 1 }), controls: { target: new THREE.Vector3() },
  canvas: el(), renderer: el(),
  world: {
    fromLatLon(lat, lon) { const x = (lon - LON_O) * KX, n = (lat - LAT_O) * KY; return new THREE.Vector3(x, heightAt(x, n), -n) },
    toLatLon(x, z) { return { lat: LAT_O - z / KY, lon: LON_O + x / KX } },
    heightAt: (x, z) => heightAt(x, -z),
    offRoad(x, z, margin = 0.6, maxD = 8) { const p = offRoad(x, -z, margin, maxD); return p && { x: p.x, z: -p.y } },
    suppressBuildings() {},
    eachTile(fn) { for (const t of tiles.values()) fn(t); return city.on('tile:load', fn) },
  },
  view: { zoom: 1, get center() { return new THREE.Vector3() }, useCamera() {}, release() {} },
  light: { night: 0, late: 0 }, surface: { wet: 0, snow: 0 }, quality: { tier: { name: 'high', view: Infinity } },
  ui: { addButton: () => ({ button: el(), panel: el(), remove() {} }), toast() {} },
  animate: () => () => {}, requestRender() {}, data: {},
  on(k, f) { if (!handlers.has(k)) handlers.set(k, new Set()); handlers.get(k).add(f); return () => handlers.get(k)?.delete(f) },
  emit(k, ...a) { for (const f of handlers.get(k) || []) f(...a) },
}
const sampleGrid = (h, n, size, x, y) => { const c = size / (n - 1), fx = Math.min(n - 1.0001, Math.max(0, x / c)), fy = Math.min(n - 1.0001, Math.max(0, (size - y) / c)), i = fx | 0, j = fy | 0, u = fx - i, v = fy - j; return h[j * n + i] * (1 - u) * (1 - v) + h[j * n + i + 1] * u * (1 - v) + h[(j + 1) * n + i] * (1 - u) * v + h[(j + 1) * n + i + 1] * u * v }
function heightAt(x, n) { const t = tiles.get(`${Math.floor(x / 1024)}_${Math.floor(n / 1024)}`); if (!t) return 0; const g = sampleGrid(t.terrain.h, t.terrain.n, 1024, x - t.ox, n - t.oy); return t.terrain.wall ? wallHeight(t.terrain.wall, g, x - t.ox, n - t.oy) : g } // (core/tiles.js heightAt)
function onRoad(x, y) { const t = tiles.get(`${Math.floor(x / 1024)}_${Math.floor(y / 1024)}`), R = t?.carriage; if (!R) return false; const k = Math.floor(y - t.oy) * R.n + Math.floor(x - t.ox); return !!(R.bits[k >> 3] & (1 << (k & 7))) }
function offRoad(x, y, margin, maxD) {
  const clear = (px, py) => !onRoad(px, py) && !onRoad(px + margin, py) && !onRoad(px - margin, py) && !onRoad(px, py + margin) && !onRoad(px, py - margin)
  if (!tiles.get(`${Math.floor(x / 1024)}_${Math.floor(y / 1024)}`)?.carriage || clear(x, y)) return null
  for (let r = 0.5; r <= maxD; r += 0.5) { const n = Math.max(8, Math.ceil(r * 6)); for (let a = 0; a < n; a++) { const px = x + Math.cos((a / n) * 2 * Math.PI) * r, py = y + Math.sin((a / n) * 2 * Math.PI) * r; if (clear(px, py)) return { x: px, y: py } } }
  return null
}
const built = new Map() // built tiles kept for the next drives (only what the plugin reads), least recently used dropped
function loadTile(i, j) {
  const k = `${i}_${j}`
  if (tiles.has(k)) return
  let t = built.get(k)
  if (t === undefined) {
    const f = new URL(`0/${k}.bin`, TILES)
    t = null
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f), buf = raw[0] === 0x1f ? zlib.gunzipSync(raw) : raw
      const res = build(parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), 0)
      const tr = res.trees, size = tr && new Float32Array((tr.pos.length / 3) * 2)
      if (tr) for (let q = 0; q < tr.pos.length / 3; q++) size[q * 2] = Math.min(30, Math.max(1.2, (tr.info[q * 4 + 1] >> 4) ? 2 + (tr.info[q * 4 + 1] >> 4) * 1.4 : tr.info[q * 4 + 2] * 0.7)) // the crown's width, near enough (tiles.js makeTrees)
      t = { level: 0, i, j, ox: i * 1024, oy: j * 1024, size: 1024, terrain: res.terrain, graph: res.graph, footprints: res.footprints || null, water: res.water || null, carriage: res.carriage || null, trees: tr && { pos: tr.pos, size } }
      t.decks = new Map() // every deck's segments (rail and paths too) by 16 m cell, for what passes over the vehicle
      for (const p of res.graph.pieces) if (p.z && !p.tunnel && !p.roof) for (let q = 0; q < p.pts.length / 2 - 1; q++) {
        const sg = [p.pts[q * 2], p.pts[q * 2 + 1], p.pts[q * 2 + 2], p.pts[q * 2 + 3], p.z[q], p.z[q + 1], p.w / 2 + (p.band ? 2 : 0), p.kind]
        for (let a = Math.floor(Math.min(sg[0], sg[2]) / 16); a <= Math.floor(Math.max(sg[0], sg[2]) / 16); a++) for (let b = Math.floor(Math.min(sg[1], sg[3]) / 16); b <= Math.floor(Math.max(sg[1], sg[3]) / 16); b++) { const k = a * 65536 + b; if (!t.decks.has(k)) t.decks.set(k, []); t.decks.get(k).push(sg) }
      }
    }
    built.set(k, t)
    if (built.size > 220) for (const key of built.keys()) { if (!tiles.has(key)) { built.delete(key); if (built.size <= 200) break } }
  } else { built.delete(k); built.set(k, t) }
  if (!t) return
  tiles.set(k, t)
  city.emit('tile:load', t)
}
let streamedAt = null
function stream(x, y, force) { // detail tiles within 900 m, as the drive camera's focus has them; dropped past 1.6 km
  if (!force && streamedAt && Math.hypot(x - streamedAt[0], y - streamedAt[1]) < 60) return
  streamedAt = [x, y]
  for (let i = Math.floor((x - 900) / 1024); i <= Math.floor((x + 900) / 1024); i++) for (let j = Math.floor((y - 900) / 1024); j <= Math.floor((y + 900) / 1024); j++) {
    const cx = clamp(x, i * 1024, i * 1024 + 1024), cy = clamp(y, j * 1024, j * 1024 + 1024)
    if (Math.hypot(cx - x, cy - y) < 900) loadTile(i, j)
  }
  for (const [k, t] of tiles) if (Math.hypot(t.ox + 512 - x, t.oy + 512 - y) > 1600) { tiles.delete(k); city.emit('tile:unload', t) }
}

// ---------------------------------------------------------------- driving
drivePlugin(city)
const dbg = globalThis.driveDebug, car = dbg.car
const fwdX = (yaw) => -Math.sin(yaw), fwdY = (yaw) => Math.cos(yaw)
let probe = []
dbg.probe = (kind, x, y, v) => probe.push({ kind, x, y, v }) // hits the plugin reports (index.js)

async function run(job) {
  const incidents = [], seen = new Map()
  const log = (kind, x, y, v, what) => { // at most once per kind and 15 m a drive
    const k = `${kind} ${Math.round(x / 15)} ${Math.round(y / 15)}`
    if (seen.has(k)) { const o = seen.get(k); if (v > o.v) Object.assign(o, { v, what }); return }
    const o = { kind, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, h: Math.round(car.h * 10) / 10, v: Math.round(v * 100) / 100, what }
    seen.set(k, o); incidents.push(o)
  }
  const tick = () => { NOW += DT * 1000; stream(car.x, car.y); dbg.frame(DT, NOW / 1000) }
  // the path to follow: the bus's lane (route.js), or the van's (follow(), along the graph)
  let path, label, G = null, startX, startY
  if (job.kind === 'bus') {
    label = `${job.name} ${job.dir ? '⇐' : '⇒'} ${lineIndex[job.ri][job.dir][0]}`
    const D = JSON.parse(fs.readFileSync(new URL(`plugins/transit/data/lines/${job.ri}.json`, ROOT))).dirs[job.dir]
    const q = manifest.q, [la0, lo0] = manifest.origin, ox = (lo0 - LON_O) * KX, oy = (la0 - LAT_O) * KY
    startX = ox + (D.shape[0] * q) * (KX / manifest.k[0]); startY = oy + (D.shape[1] * q) * (KY / manifest.k[1])
    stream(startX, startY, true)
    await dbg.startBus(job.name, job.dir, 'first')
    G = dbg.game
    if (!G) return { label, km: 0, end: false, incidents: [{ kind: 'no start', x: startX, y: startY, h: 0, v: 1 }] }
  } else {
    path = follow(job)
    if (!path) return null
    label = `van ${job.x},${job.y} ${job.way ? '⇐' : '⇒'}`
    dbg.start('car', path.x[0], path.y[0], path.yaw0)
  }
  label = label || ''
  for (let i = 0; i < 400 && dbg.state !== 'play'; i++) tick() // the dive
  if (G) for (let i = 0; i < 600 && !G.settled; i++) tick()
  if (G) for (let i = 0; i < 1200 && G.doors; i++) { if (!G.busy) G.action(); tick() } // the first riders on, the doors shut
  // the autopilot: pure pursuit of a point on the path ahead from the axle the body turns about, at a speed the bends allow
  const V = car.V, I = { steer: 0, up: false, down: false, hand: false, run: false }
  let stuckT = 0, stuckAt = -1e9, lastSy = null, lastDeck = false, km = 0, px = car.x, py = car.y, laneSeen = -1, end = false, resets = 0
  const P = { x: 0, y: 0, h: 0, ok: true } // the path at a distance along it
  const pathLen = () => (G ? G.lane.d0 + (G.lane.n - 1) * 3 : path.len)
  const pathAt = (d) => {
    const L = G ? G.lane : path, f = clamp((d - (G ? L.d0 : 0)) / 3, 0, L.n - 1.001), i = Math.floor(f), t = f - i
    P.x = L.x[i] + (L.x[i + 1] - L.x[i]) * t; P.y = L.y[i] + (L.y[i + 1] - L.y[i]) * t; P.h = L.h[i] + (L.h[i + 1] - L.h[i]) * t; if (Number.isNaN(P.h)) P.h = heightAt(P.x, P.y) + 0.2; P.ok = G ? !!L.snapped[i] : true
    return P
  }
  let along = 0 // how far along the path the reference axle is (the van: its own search; the bus: the lane's)
  const nearestAlong = (x, y) => {
    const L = G ? G.lane : path, base = G ? L.d0 : 0
    let bd = Infinity, best = along
    const from = Math.max(base, along - 30)
    for (let d = from; d < Math.min(pathLen(), Math.max(from, along) + 60); d += 1) { pathAt(d); const e = Math.hypot(P.x - x, P.y - y); if (e < bd) { bd = e; best = d } }
    return [best, bd]
  }
  if (G) along = G.lane.d0
  dbg.autopilot = () => I
  const limit = (G ? G.stops.at(-1).d : path.len) / 3 + 240 // seconds: a slow average, and some
  const lenTotal = G ? G.stops.at(-1).d : path.len
  for (let step = 0; step * DT < limit; step++) {
    const ref = { x: car.x - fwdX(car.yaw) * V.pivot, y: car.y - fwdY(car.yaw) * V.pivot }
    const [a, off] = nearestAlong(ref.x, ref.y)
    along = a
    if (G && (G.end || G.d > lenTotal - 15)) { end = true; break }
    if (!G && along > path.len - 12) { end = true; break }
    const sp = Math.max(0, car.speed), Ld = Math.max(7, 4 + sp * 0.9) + (G ? V.hl * 0.3 : 0)
    pathAt(along + Ld)
    const ax = P.x - ref.x, ay = P.y - ref.y, alpha = wrap(Math.atan2(ay, ax) - Math.atan2(fwdY(car.yaw), fwdX(car.yaw))), Lr = Math.hypot(ax, ay) || 1
    const kappa = (2 * Math.sin(alpha)) / Lr, tanS = kappa * V.wb * (1 + V.under * sp * sp)
    I.steer = clamp(Math.atan(tanS) / (V.lock / (1 + sp / V.lockV)), -1, 1)
    // speed: the bends ahead (2 m/s² sideways), braking for them in time
    let vt = G ? 12 : 13.5
    for (let d = 3; d < 90; d += 3) {
      const a0 = pathAt(along + d - 3), x0 = a0.x, y0 = a0.y, a1 = pathAt(along + d), x1 = a1.x, y1 = a1.y, a2 = pathAt(along + d + 3)
      const turn = Math.abs(wrap(Math.atan2(a2.y - y1, a2.x - x1) - Math.atan2(y1 - y0, x1 - x0))), k = turn / 3
      if (k > 1e-3) vt = Math.min(vt, Math.sqrt((G ? 1.6 : 2.2) / k + 2 * 1.8 * Math.max(0, d - Ld)))
    }
    vt = Math.max(vt, 3)
    I.up = car.speed < vt - 0.3 && off < 12; I.down = car.speed > vt + 1.2 || off >= 12
    // what happened in this frame
    probe = []
    const h0 = car.h
    tick()
    km += Math.hypot(car.x - px, car.y - py) / 1000; px = car.x; py = car.y
    const s = dbg.surface(car.x, car.y, car.h)
    if (lastSy != null && Math.abs(s.y - lastSy) > 0.5) log('height jump', car.x, car.y, Math.abs(s.y - lastSy), `${lastSy.toFixed(1)} → ${s.y.toFixed(1)} m${s.deck || lastDeck ? ' (deck)' : ''}`)
    if (lastDeck && !s.deck && lastSy - s.y > 1) log('off a deck', car.x, car.y, lastSy - s.y, `dropped ${(lastSy - s.y).toFixed(1)} m`)
    lastSy = s.y; lastDeck = s.deck
    const tilt = Math.max(Math.abs(car.pitch), Math.abs(car.roll)) * 180 / Math.PI
    if (tilt > 20) log('tilt', car.x, car.y, tilt, `${tilt.toFixed(0)}°`)
    // the level of the road it follows (the lane's height: a deck's, or the ground's) against where it rides
    pathAt(along)
    if (Math.abs(car.h - P.h) > 1.2 && Math.hypot(P.x - car.x, P.y - car.y) < 4) log('wrong level', car.x, car.y, Math.abs(car.h - P.h), `riding at ${car.h.toFixed(1)} m, the road at ${P.h.toFixed(1)} m`)
    if (step % 4 === 0) { // a deck over the vehicle lower than its roof: it drives through it (the guideway over a bus loop)
      const top = car.h + (G ? 3.2 : 2.2) + 0.8, KN = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living', 'pedestrian', 'footway', 'cycleway', 'path', 'steps', 'track', 'rail', 'lightrail']
      for (let a = Math.floor((car.x - 12) / 16); a <= Math.floor((car.x + 12) / 16); a++) for (let b = Math.floor((car.y - 12) / 16); b <= Math.floor((car.y + 12) / 16); b++) {
        const t = tiles.get(`${Math.floor((a * 16) / 1024)}_${Math.floor((b * 16) / 1024)}`)
        for (const sg of t?.decks.get(a * 65536 + b) || []) {
          const dx = sg[2] - sg[0], dy = sg[3] - sg[1], u = clamp(((car.x - sg[0]) * dx + (car.y - sg[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1), z = sg[4] + (sg[5] - sg[4]) * u
          if (z > car.h + 1.2 && z < top && Math.hypot(car.x - sg[0] - dx * u, car.y - sg[1] - dy * u) < sg[6] + V.hw * 0.6) log('low deck', car.x, car.y, top - z, `a ${KN[sg[7]] || sg[7]} deck at ${z.toFixed(1)} m over the vehicle at ${car.h.toFixed(1)} m`)
        }
      }
    }
    for (const p of probe) {
      if (p.kind === 'wall') { const r = dbg.nearestRoad(p.x, p.y, 3, false, false, true); if (r && r.dist < r.w / 2 + 0.3) log('building on road', p.x, p.y, p.v, `${p.v.toFixed(1)} m/s into a footprint, ${r.dist.toFixed(1)} m off the centre of a ${r.w} m road`) }
      else if (p.kind === 'post') { const r = dbg.nearestRoad(p.x, p.y, 3, false, false, true); if (r && r.dist < r.w / 2 - 0.5 && p.v > 1) log('post in lane', p.x, p.y, p.v, `${p.what || 'a post'} ${r.dist.toFixed(1)} m off the centre of a ${r.w} m road`) }
      else if (p.v > 1) log(p.kind, p.x, p.y, p.v, `${p.v.toFixed(1)} m/s`)
    }
    if (TRACE && step % 30 === 0) console.error(`t ${(step * DT).toFixed(1)} x ${car.x.toFixed(1)} y ${car.y.toFixed(1)} h ${car.h.toFixed(2)} v ${car.speed.toFixed(1)} vt ${vt.toFixed(1)} along ${along.toFixed(0)}/${pathLen().toFixed(0)} off ${off.toFixed(1)} deck ${car.deck} steer ${I.steer.toFixed(2)} gd ${G?.d.toFixed(0)} pitch ${(car.pitch * 57.3).toFixed(0)} roll ${(car.roll * 57.3).toFixed(0)}`)
    if (along < stuckAt + 1.5) stuckT += DT; else { stuckT = 0; stuckAt = along } // no headway along the path
    if (stuckT > 3) { // stuck: logged, and on 25 m along the path (like R, but past it)
      log('stuck', car.x, car.y, 3, off > 6 ? `${off.toFixed(0)} m off the path` : `on the path, ${car.speed.toFixed(1)} m/s`)
      stuckT = 0
      if (++resets > 40) break
      const d = along + 25 + V.hl; pathAt(d); const x = P.x, y = P.y, h = P.h; pathAt(d + 3)
      const yaw = Math.atan2(P.y - y, P.x - x) - Math.PI / 2
      Object.assign(car, { x, y, h, yaw, speed: 0, lat: 0, steer: 0, kick: 0, gear: 1, deck: false, tyaw: yaw, tx: x - fwdX(yaw) * ((V.joint || 0) + (V.trail || 0)), ty: y - fwdY(yaw) * ((V.joint || 0) + (V.trail || 0)) })
      along = d - V.pivot; lastSy = null; px = car.x; py = car.y; stuckAt = along
    }
    // the GPS line and the stop bays, as each lane section is built
    if (G && G.lane.d0 !== laneSeen) {
      laneSeen = G.lane.d0
      const L = G.lane
      for (let i = 0; i < L.n; i += 2) {
        const d = L.d0 + i * 3
        if (d < along - 10 || d > along + 230) continue
        const r = dbg.nearestRoad(L.x[i], L.y[i], 8, false, false, true)
        if (!L.snapped[i]) log('gps off road', L.x[i], L.y[i], 1, 'not on a street running its way')
        else if (!r || r.dist > r.w / 2 + 0.3) log('gps off road', L.x[i], L.y[i], r ? r.dist - r.w / 2 : 8, r ? `${(r.dist - r.w / 2).toFixed(1)} m past the kerb` : 'no road within 8 m')
      }
      for (const st of G.stops) {
        if (st.d < L.d0 || st.d > L.d0 + (L.n - 1) * 3 || st.checked) continue
        st.checked = true
        const p = pathAt(st.d), r = dbg.nearestRoad(p.x, p.y, 8, false, false, true)
        if (!P.ok || !r || r.dist > r.w / 2) log('stop off road', p.x, p.y, r ? r.dist - r.w / 2 : 8, `${st.name}${r ? `: ${(r.dist - r.w / 2).toFixed(1)} m past the kerb` : ''}`)
      }
    }
  }
  dbg.autopilot = null
  dbg.stop()
  return { label, km: Math.round(km * 100) / 100, end, len: Math.round(lenTotal), incidents }
}

// the van's path: from the arterial nearest (x, y) on along the graph, the straightest way on a road at least as big
// as a collector at each junction, 3 km (or until it ends); its lane: the right half of the road, on its level
function follow(job) {
  stream(job.x, job.y, true)
  const pieces = new Map(), byNode = new Map()
  const add = () => { for (const t of tiles.values()) for (const p of t.graph.pieces) { if (!p.drive || p.kind > 4 || p.kind < 1) continue; const key = `${p.a} ${p.b} ${p.pts[0]} ${p.pts[1]}`; if (pieces.has(key)) continue; pieces.set(key, p); for (const n of [p.a, p.b]) { if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push(p) } } }
  add()
  let best = null, bd = 400
  for (const p of pieces.values()) for (let i = 0; i < p.pts.length / 2 - 1; i++) {
    const x0 = p.pts[i * 2], y0 = p.pts[i * 2 + 1], dx = p.pts[i * 2 + 2] - x0, dy = p.pts[i * 2 + 3] - y0, u = clamp(((job.x - x0) * dx + (job.y - y0) * dy) / (dx * dx + dy * dy || 1), 0, 1)
    const d = Math.hypot(job.x - x0 - dx * u, job.y - y0 - dy * u) + (p.z ? 50 : 0)
    if (d < bd) { bd = d; best = p }
  }
  if (!best) return null
  // a chain of pieces, each as a list of (x, y, z) points the way it is driven
  const X = [], Y = [], Z = []
  const push = (p, fwd) => { const n = p.pts.length / 2; for (let k = 0; k < n; k++) { const i = fwd ? k : n - 1 - k; X.push(p.pts[i * 2]); Y.push(p.pts[i * 2 + 1]); Z.push(p.z ? p.z[i] + 0.58 : NaN) } }
  let p = best, fwd = job.way === 0, used = new Set(), len = 0
  if (p.oneway) fwd = true
  for (let n = 0; n < 400 && len < 3000; n++) {
    used.add(p); push(p, fwd)
    for (let k = Math.max(1, X.length - p.pts.length / 2); k < X.length; k++) len += Math.hypot(X[k] - X[k - 1], Y[k] - Y[k - 1])
    stream(X.at(-1), Y.at(-1), true); add()
    const node = fwd ? p.b : p.a, hx = X.at(-1) - X.at(-2), hy = Y.at(-1) - Y.at(-2), hl = Math.hypot(hx, hy) || 1
    let nb = null, nf = true, ncos = 0.5
    for (const q of byNode.get(node) || []) {
      if (used.has(q)) continue
      const f = q.a === node
      if (!f && q.oneway) continue
      const m = q.pts.length / 2, i0 = f ? 0 : m - 1, i1 = f ? Math.min(m - 1, 1) : Math.max(0, m - 2)
      const ex = q.pts[i1 * 2] - q.pts[i0 * 2], ey = q.pts[i1 * 2 + 1] - q.pts[i0 * 2 + 1], c = (ex * hx + ey * hy) / ((Math.hypot(ex, ey) || 1) * hl) - (q.kind > p.kind ? 0.05 : 0)
      if (c > ncos) { ncos = c; nb = q; nf = f }
    }
    if (!nb) break
    p = nb; fwd = nf
  }
  // resample every 3 m onto the right half (w * 0.22 off the centre, as carSpawn), smoothed, heights: decks' or the ground's
  const cum = [0]; for (let k = 1; k < X.length; k++) cum.push(cum[k - 1] + Math.hypot(X[k] - X[k - 1], Y[k] - Y[k - 1]))
  const total = cum.at(-1), n = Math.floor(total / 3) + 1
  if (n < 30) return null
  const out = { x: new Float32Array(n), y: new Float32Array(n), h: new Float32Array(n), n, len: (n - 1) * 3 }
  for (let i = 0, k = 0; i < n; i++) {
    const d = i * 3
    while (k < X.length - 2 && cum[k + 1] < d) k++
    const L = cum[k + 1] - cum[k] || 1, t = clamp((d - cum[k]) / L, 0, 1), dx = (X[k + 1] - X[k]) / L, dy = (Y[k + 1] - Y[k]) / L
    const w = 3.2 // the kerb lane of a two-way street, near enough
    out.x[i] = X[k] + (X[k + 1] - X[k]) * t + dy * w * 0.5; out.y[i] = Y[k] + (Y[k + 1] - Y[k]) * t - dx * w * 0.5
    const z = Z[k] + (Z[k + 1] - Z[k]) * t
    out.h[i] = z // NaN on the ground: its height when driven (its tile may be gone by then)
  }
  out.yaw0 = Math.atan2(out.y[1] - out.y[0], out.x[1] - out.x[0]) - Math.PI / 2
  return out
}

// ---------------------------------------------------------------- the shard's share of the jobs
const [s, ns] = opt('--shard').split('/').map(Number)
const mine = jobs().filter((_, i) => i % ns === s)
for (const job of mine) {
  let r
  try { r = await run(job) } catch (e) { r = { label: JSON.stringify(job), km: 0, end: false, incidents: [{ kind: 'error', x: 0, y: 0, h: 0, v: 1, what: String(e.stack || e).slice(0, 300) }] } }
  if (r) process.stdout.write(JSON.stringify(r) + '\n')
}
process.exit(0)
