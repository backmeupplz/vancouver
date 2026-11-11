// Metro Vancouver transit on its timetable: SkyTrain (Expo, Millennium, Canada Line), West Coast Express, the SeaBus,
// buses and trolleybuses, each where the schedule says it is right now (America/Vancouver time), riding concrete
// guideways where the line is elevated and vanishing where it goes underground.
//
// Data: TransLink static GTFS (https://gtfs-static.translink.ca/gtfs/google_transit.zip), "Route and arrival data
// used in this product or service is provided by permission of TransLink. TransLink assumes no responsibility for the
// accuracy or currency of the Data used in this product or service." Guideway bridge/tunnel tags and stations:
// (c) OpenStreetMap contributors, ODbL. Built into data/ by tools/transit_data.py (format documented there).

import { vancouver, getJSON } from '../../core/util.js'
import { kit } from '../../core/kit.js'
import { seabusGeo } from '../ships/models.js'

const DATA = new URL('./data/', import.meta.url)
const BUS_ZOOM = 0.07 // below this a bus is about a pixel wide: not drawn, its data not fetched

// ---------- data ----------
export function decode(buf) {
  const b = new Uint8Array(buf)
  let p = 0
  const u = () => { let v = 0, m = 1, c; do { c = b[p++]; v += (c & 127) * m; m *= 128 } while (c & 128); return v }
  const s = () => { const v = u(); return v % 2 ? -(v + 1) / 2 : v / 2 }
  const shapes = []
  for (let k = u(); k--;) {
    const n = u(), x = new Float64Array(n), y = new Float64Array(n), lift = new Float32Array(n), mode = new Uint8Array(n)
    let px = 0, py = 0
    for (let i = 0; i < n; i++) {
      x[i] = px += s(); y[i] = py += s()
      const c = u(), l = Math.floor(c / 3); mode[i] = c % 3; lift[i] = (l % 2 ? -(l + 1) / 2 : l / 2) / 4
    }
    shapes.push({ x, y, lift, mode })
  }
  const pats = []
  for (let k = u(); k--;) {
    const route = u(), shape = u(), n = u(), dist = new Float32Array(n)
    for (let i = 0, d = 0; i < n; i++) dist[i] = d += u()
    pats.push({ route, shape, dist })
  }
  const profs = []
  for (let k = u(); k--;) {
    const pat = u(), n = pats[pat].dist.length, arr = new Int32Array(n), dep = new Int32Array(n)
    for (let i = 0, t = 0; i < n; i++) { arr[i] = t += u(); dep[i] = t += u() }
    profs.push({ pat, arr, dep, dur: dep[n - 1] })
  }
  const n = u(), starts = new Int32Array(n), prof = new Uint32Array(n), mask = new Uint8Array(n)
  let maxDur = 0
  for (let i = 0, t = 0; i < n; i++) { starts[i] = t += u(); prof[i] = u(); mask[i] = u(); maxDur = Math.max(maxDur, profs[prof[i]].dur) }
  return { shapes, pats, profs, starts, prof, mask, n, maxDur }
}

// local (metres east/north of man.origin) -> world: x = o.x + ax * e + bx * n, z = o.z + az * e + bz * n, an affine
// fit of the core's own projection (the drive plugin's buses use it too)
export function localFrame(city, man) {
  const [la0, lo0] = man.origin, o = city.world.fromLatLon(la0, lo0)
  const ex = city.world.fromLatLon(la0, lo0 + 0.01), en = city.world.fromLatLon(la0 + 0.01, lo0)
  return { o, ax: (ex.x - o.x) / (0.01 * man.k[0]), az: (ex.z - o.z) / (0.01 * man.k[0]), bx: (en.x - o.x) / (0.01 * man.k[1]), bz: (en.z - o.z) / (0.01 * man.k[1]) }
}

// day pattern (0 Mon–Thu, 1 Fri, 2 Sat, 3 Sun/holiday) of a yyyymmdd service date
export function patternOf(man, ymd) {
  if (ymd in man.special) return man.special[ymd]
  const wd = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6))).getUTCDay()
  return [3, 0, 0, 0, 0, 1, 2][wd]
}

// calls fn(trip index, seconds into the trip) for every trip running at `sec` on service date pattern `pat`
// (and yesterday's after-midnight trips, pattern `patY`)
export function eachActive(ch, sec, pat, patY, fn) {
  activeAt(ch, sec, 1 << pat, fn)
  activeAt(ch, sec + 86400, 1 << patY, fn)
}
function activeAt(ch, tt, bit, fn) {
  let lo = 0, hi = ch.n
  while (lo < hi) { const m = (lo + hi) >> 1; if (ch.starts[m] < tt - ch.maxDur) lo = m + 1; else hi = m }
  for (let i = lo; i < ch.n && ch.starts[i] <= tt; i++) {
    if (!(ch.mask[i] & bit)) continue
    const rel = tt - ch.starts[i]
    if (rel <= ch.profs[ch.prof[i]].dur) fn(i, rel)
  }
}

function fromVancouver(y, mo, d, h, mi) { // wall-clock time in Vancouver -> epoch ms
  const want = Date.UTC(y, mo - 1, d, h, mi)
  let t = want + 8 * 3600e3
  for (let k = 0; k < 2; k++) { const { p } = vancouver(t); t += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) }
  return t
}

// ---------- looks ----------
const C = {
  white: 0xf4f5f2, glass: 0x26323f, dark: 0x3a3f45, blue: 0x0d4ea6, yellow: 0xf5c400, grey: 0x9aa0a6,
  canada: 0x007c9f, purple: 0x6d2a8c, hull: 0x2f4f6f, rapid: 0x4bae4f, concrete: 0xc9c6bd, pier: 0xb9b5ab,
  canopy: 0xe9eef0, platform: 0xa8a49c, kiosk: 0x5f8fa8,
}
// a car: boxes [length (x), height, width (z), x, y (bottom), z, colour, tilt about z]; front is +x, wheels at y 0
function carGeo(THREE, parts) {
  const box = new THREE.BoxGeometry(1, 1, 1).toNonIndexed(), bp = box.attributes.position.array, bn = box.attributes.normal.array
  const pos = [], nor = [], col = [], c = new THREE.Color()
  for (const [l, h, w, x, y, z, hex, tilt = 0] of parts) {
    c.set(hex)
    const cs = Math.cos(tilt), sn = Math.sin(tilt)
    for (let i = 0; i < bp.length; i += 3) {
      const vx = bp[i] * l, vy = (bp[i + 1] + 0.5) * h
      pos.push(x + vx * cs - vy * sn, y + vx * sn + vy * cs, z + bp[i + 2] * w)
      nor.push(bn[i] * cs - bn[i + 1] * sn, bn[i] * sn + bn[i + 1] * cs, bn[i + 2])
      col.push(c.r, c.g, c.b)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  return g
}
// a rail car / bus body: underframe, body, window band each side, stripes, dark end windows
function body(L, H, W, { base = C.white, band = C.glass, stripe = C.blue, stripe2 = C.yellow, floor = 0.5, win = [0.52, 0.86], nose = 0 } = {}) {
  const hb = H - floor, wy0 = floor + hb * win[0], wy1 = floor + hb * win[1]
  return [
    [L * 0.86, floor, W * 0.8, 0, 0, 0, C.dark],
    [L - nose * 2, hb, W, 0, floor, 0, base],
    ...(nose ? [[nose * 2 + L * 0.0, hb * 0.82, W * 0.96, 0, floor, 0, base]] : []),
    [L - 0.8 - nose * 2, wy1 - wy0, W + 0.04, 0, wy0, 0, band],
    [L + 0.04, (wy1 - wy0) * 0.9, W * 0.7, 0, wy0, 0, band],
    [L - nose * 2 + 0.02, hb * 0.1, W + 0.05, 0, floor + hb * 0.1, 0, stripe],
    [L - nose * 2 + 0.02, hb * 0.05, W + 0.05, 0, floor + hb * 0.23, 0, stripe2],
  ]
}
const KINDS = {
  markI: { L: 12.7, parts: () => [...body(12.7, 3.15, 2.65, { stripe: C.blue, stripe2: C.yellow, win: [0.45, 0.82] }), [12.3, 0.08, 2.4, 0, 3.15, 0, C.grey]] },
  markII: { L: 17.3, parts: () => [...body(17.3, 3.15, 2.65, { nose: 0.5, win: [0.48, 0.86] }), [16, 0.1, 2.3, 0, 3.15, 0, C.grey]] },
  markIII: { L: 17.3, parts: () => [...body(17.3, 3.2, 2.65, { nose: 0.6, win: [0.42, 0.9], stripe: C.yellow, stripe2: C.blue })] },
  canada: { L: 20.5, parts: () => [...body(20.5, 3.8, 3.0, { stripe: C.canada, stripe2: C.canada, nose: 0.7, win: [0.45, 0.85] }), [19, 0.12, 2.6, 0, 3.8, 0, C.grey]] },
  wceLoco: { L: 20, parts: () => [...body(20, 4.6, 3.0, { base: C.purple, band: C.white, stripe: C.white, stripe2: C.yellow, win: [0.6, 0.62] }), [3, 0.9, 2.6, 7.6, 4.6, 0, C.purple], [2.4, 0.9, 2.9, 8.6, 3.2, 0, C.glass]] },
  wceCoach: { L: 25.9, parts: () => [...body(25.9, 5.8, 3.0, { stripe: C.purple, stripe2: C.purple, win: [0.35, 0.5] }), [25.0, 0.6, 3.04, 0, 3.7, 0, C.glass]] },
  seabus: { L: 34, geo: seabusGeo }, // a catamaran from the ships plugin's yard
  bus12: { L: 12.2, geo: (THREE) => busGeo(THREE, 12.2) },
  bus18: { L: 18.3, geo: (THREE) => busGeo(THREE, 18.3, true) },
  trolley12: { L: 12.2, geo: (THREE) => busGeo(THREE, 12.2, false, true) },
  trolley18: { L: 18.3, geo: (THREE) => busGeo(THREE, 18.3, true, true) },
}
// A city bus (12 m, or 18 m articulated: one rigid model with its bellows), front +x, built with the kit: a body
// with a raked windscreen and rounded roof ends, the window band, the blue and yellow stripes, a lit-looking sign,
// wheels in their arches, roof equipment, and a trolleybus's two poles up to the wires
function busGeo(THREE, L, artic = false, trolley = false) {
  const k = kit(THREE), h = L / 2, W = 1.275
  k.c(C.white).prism([-h, 0.45, h - 0.1, 0.45, h, 0.9, h, 2.1, h - 0.22, 3.1, h - 0.5, 3.2, -h + 0.25, 3.2, -h, 3.0], -W, W,
    { edge: (i, nx, ny, y) => { if (nx > 0.4 && y > 1.2) k.c(C.glass); else if (ny < -0.5) k.c(C.dark) } })
  k.c(C.glass).box(-h + 0.5, h - 0.9, 1.6, 2.75, -W - 0.02, W + 0.02).box(-h - 0.02, -h + 0.3, 1.9, 2.7, -0.9, 0.9) // windows: sides, rear
  k.c(C.blue).box(-h + 0.01, h - 0.3, 0.72, 1.0, -W - 0.025, W + 0.025).c(C.yellow).box(-h + 0.01, h - 0.3, 1.08, 1.2, -W - 0.025, W + 0.025)
  k.c(0xf2a81c).box(h - 0.42, h - 0.2, 2.8, 3.05, -0.85, 0.85) // the destination sign
  k.c(C.dark).box(h - 0.05, h + 0.1, 0.4, 0.75, -W, W).box(-h - 0.1, -h + 0.05, 0.4, 0.75, -W, W) // bumpers
  k.c(0xfff2d0).box(h - 0.02, h + 0.03, 0.95, 1.12, 0.7, 1.15).box(h - 0.02, h + 0.03, 0.95, 1.12, -1.15, -0.7)
  k.c(0xb3121a).box(-h - 0.03, -h + 0.02, 1.2, 1.55, 0.85, 1.15).box(-h - 0.03, -h + 0.02, 1.2, 1.55, -1.15, -0.85)
  k.c(C.grey).box(L * 0.1, L * 0.36, 3.2, 3.5, -1.0, 1.0, 0.92) // roof equipment
  for (const x of artic ? [h - 2.9, 0.6, -h + 3.2] : [h - 2.9, -h + 3.4]) for (const s of [-1, 1]) k.c(0x1d1f22).wheel(x, 0.5, s * 1.14, 0.5, 0.3, 6)
  if (artic) k.c(C.dark).box(1.9, 3.1, 0.5, 3.24, -W - 0.03, W + 0.03) // the bellows
  if (trolley) {
    k.c(C.dark).box(-h + 2.6, -h + 4.2, 3.2, 3.55, -0.7, 0.7)
    for (const z of [-0.3, 0.3]) k.rod([-h + 3.4, 3.5, z], [-h - 2.4, 5.45, z], 0.07, 0.05, 4)
  }
  return k.geometry(true)
}

// trains per line; a trip's train is picked by hashing its start time (TransLink publishes no fleet assignment)
// ponytail: the fleet mix is a guess at proportions, not a timetable of real consists
const MK1 = ['markI', 6], MK2 = ['markII', 4], MK3 = ['markIII', 4], CANADA = ['canada', 2], SEABUS = ['seabus', 1]
function consist(kind, h) {
  if (kind === 'expo') return h < 0.4 ? MK1 : h < 0.7 ? MK2 : MK3
  if (kind === 'millennium') return h < 0.45 ? MK2 : MK3
  if (kind === 'canada') return CANADA
  if (kind === 'wce') return null // locomotive + coaches
  if (kind === 'seabus') return SEABUS
  return null
}

export default async function transit(city) {
  const { THREE } = city
  const man = await getJSON(new URL('manifest.json', DATA))

  const { o, ax, az, bx, bz } = localFrame(city, man)
  const routes = man.routes
  const H = (x, z) => city.world.heightAt(x, z)
  let raf = 0, last = 0, force = false, lastView = { x: Infinity, z: 0, mpp: 0 }, ui = null // loop state (see the loop below)
  let speed = 1, anchorSim = Date.now(), anchorReal = performance.now() // clock
  const show = { sky: true, wce: true, seabus: true, bus: true }

  function prepare(ch, road) { // world coordinates, lengths and bridge runs per shape (road: buses, on the road decks)
    for (const sh of ch.shapes) {
      sh.road = road
      const n = sh.x.length, q = man.q
      sh.wx = new Float32Array(n); sh.wz = new Float32Array(n); sh.cum = new Float32Array(n)
      sh.ra = new Int32Array(n); sh.rb = new Int32Array(n)
      for (let i = 0; i < n; i++) {
        const x = sh.x[i] * q, y = sh.y[i] * q
        sh.wx[i] = o.x + ax * x + bx * y; sh.wz[i] = o.z + az * x + bz * y
        if (i) sh.cum[i] = sh.cum[i - 1] + Math.hypot(x - sh.x[i - 1] * q, y - sh.y[i - 1] * q)
      }
      for (let i = 0; i < n;) {
        if (sh.mode[i] !== 1) { i++; continue }
        let j = i; while (j + 1 < n && sh.mode[j + 1] === 1) j++
        sh.ra.fill(i, i, j + 1); sh.rb.fill(j, i, j + 1); i = j + 1
      }
      sh.len = sh.cum[n - 1]
    }
    for (const pr of ch.profs) pr.p = ch.pats[pr.pat]
    return ch
  }
  // point at distance d along a shape: out.x/y/z in world, out.hidden underground
  function at(sh, d, out) {
    const c = sh.cum, n = c.length
    let lo = 0, hi = n - 1
    if (d <= 0) hi = 1; else if (d >= sh.len) lo = n - 2
    else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= d) lo = m; else hi = m }
    const t = Math.min(1, Math.max(0, (d - c[lo]) / (c[hi] - c[lo] || 1)))
    out.x = sh.wx[lo] + (sh.wx[hi] - sh.wx[lo]) * t; out.z = sh.wz[lo] + (sh.wz[hi] - sh.wz[lo]) * t
    const lift = sh.lift[lo] + (sh.lift[hi] - sh.lift[lo]) * t
    if (sh.mode[lo] === 1 && sh.mode[hi] === 1) {
      const a = sh.ra[lo], b = sh.rb[lo], f = Math.min(1, Math.max(0, (d - c[a]) / (c[b] - c[a] || 1)))
      const ha = H(sh.wx[a], sh.wz[a]), hb = H(sh.wx[b], sh.wz[b])
      out.y = ha + (hb - ha) * f + lift
    } else out.y = H(out.x, out.z) + lift
    if (sh.road && lift > -2.5) { const z = deckAt(out.x, out.z, sh.wx[hi] - sh.wx[lo], sh.wz[hi] - sh.wz[lo], out.y); if (z != null) out.y = z }
    out.hidden = lift < -2.5
    return out
  }

  // the road decks (bridges, viaducts) of the map tiles' road graphs: a bus on one rides on it as the van does
  // (drive/index.js: deck height + 0.58 for the van's body over the drawn surface, 0.2 off a deck), not on the
  // ground or a bridge line guessed from the timetable shape. By level (detail, overview): 32 m cell -> [piece, i]
  const DC = 32, decks = [new Map(), new Map()], deckCells = new Map() // tile -> its cells
  const dkey = (x, y) => Math.floor(x / DC) * 65536 + Math.floor(y / DC)
  function addDecks(t) {
    if (deckCells.has(t)) dropDecks(t)
    const g = decks[t.level ? 1 : 0], cells = []
    for (const p of t.graph?.pieces || []) {
      if (!p.z || !p.drive) continue
      for (let i = 0; i < p.pts.length / 2 - 1; i++) {
        const x0 = p.pts[i * 2], y0 = p.pts[i * 2 + 1], x1 = p.pts[i * 2 + 2], y1 = p.pts[i * 2 + 3], r = p.w / 2 + 1
        for (let cx = Math.floor((Math.min(x0, x1) - r) / DC); cx <= Math.floor((Math.max(x0, x1) + r) / DC); cx++) for (let cy = Math.floor((Math.min(y0, y1) - r) / DC); cy <= Math.floor((Math.max(y0, y1) + r) / DC); cy++) {
          const k = cx * 65536 + cy
          let a = g.get(k); if (!a) g.set(k, (a = []))
          a.push(p, i); cells.push(k)
        }
      }
    }
    deckCells.set(t, cells)
  }
  function dropDecks(t) {
    const g = decks[t.level ? 1 : 0], ps = new Set(t.graph?.pieces || [])
    for (const k of deckCells.get(t) || []) { const a = g.get(k); if (!a) continue; const b = []; for (let j = 0; j < a.length; j += 2) if (!ps.has(a[j])) b.push(a[j], a[j + 1]); if (b.length) g.set(k, b); else g.delete(k) }
    deckCells.delete(t)
  }
  // the deck surface under world (x, z) along a road heading (dx, dz) (one across it is a bridge over this street),
  // the one nearest height y where decks stack; detail tiles first. Or null
  function deckAt(x, z, dx, dz, y) {
    const n = -z, l = Math.hypot(dx, dz) || 1, ux = dx / l, uy = -dz / l
    for (const g of decks) {
      const a = g.get(dkey(x, n))
      if (!a) continue
      let best = null
      for (let j = 0; j < a.length; j += 2) {
        const p = a[j], i = a[j + 1], P = p.pts, x0 = P[i * 2], y0 = P[i * 2 + 1], sx = P[i * 2 + 2] - x0, sy = P[i * 2 + 3] - y0, L2 = sx * sx + sy * sy || 1
        if (Math.abs(sx * ux + sy * uy) < 0.85 * Math.sqrt(L2)) continue
        const f = ((x - x0) * sx + (n - y0) * sy) / L2
        if (f < 0 || f > 1 || Math.hypot(x - x0 - sx * f, n - y0 - sy * f) > p.w / 2 + 0.5) continue
        const h = p.z[i] + (p.z[i + 1] - p.z[i]) * f + 0.38
        if (best == null || Math.abs(h - y) < Math.abs(best - y)) best = h
      }
      if (best != null) return best
    }
    return null
  }
  const offDecks = city.world.eachTile(addDecks), offDrop = city.on('tile:unload', dropDecks)

  // ---------- meshes ----------
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true })
  const cap = { markI: 900, markII: 600, markIII: 600, canada: 160, wceLoco: 12, wceCoach: 80, seabus: 6, bus12: 2500, bus18: 900, trolley12: 500, trolley18: 200 }
  const meshes = {}
  const group = new THREE.Group()
  group.name = 'transit'
  for (const [k, def] of Object.entries(KINDS)) {
    const m = new THREE.InstancedMesh(def.geo ? def.geo(THREE) : carGeo(THREE, def.parts()), mat, cap[k])
    m.count = 0; m.frustumCulled = false; m.receiveShadow = true
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    meshes[k] = m; group.add(m)
  }
  city.scene.add(group)

  const chunks = man.chunks.map((c) => ({ ...c, data: null, loading: false, rail: c.file === 'rail.bin' }))
  for (const c of chunks) { // chunk bbox in world
    const xs = [], zs = []
    for (const [x, y] of [[c.bbox[0], c.bbox[1]], [c.bbox[2], c.bbox[1]], [c.bbox[0], c.bbox[3]], [c.bbox[2], c.bbox[3]]]) { xs.push(o.x + ax * x + bx * y); zs.push(o.z + az * x + bz * y) }
    c.w = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]
  }
  let nGot = 0, nWant = 0 // chunks fetched / asked for in this burst (city.loading)
  const load = (c) => {
    c.loading = true
    city.loading?.track('transit', nGot, ++nWant)
    const fin = () => { city.loading?.track('transit', ++nGot, nWant); if (nGot >= nWant) nGot = nWant = 0 }
    return fetch(new URL(c.file, DATA)).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer() })
      .then((b) => { c.data = prepare(decode(b), !c.rail); kick(true) })
      .catch((e) => { console.warn('transit: could not load', c.file, e); setTimeout(() => { c.loading = false }, 30000) })
      .finally(fin)
  }
  const rail = chunks.find((c) => c.rail)
  await load(rail)

  // ---------- guideway, piers and stations: one instanced box mesh, rebuilt if the ground under it changes ----------
  const nBox = 16000
  // one instanced mesh per 1 km cell (frustum-culled, and hidden past the scene's fog end in third person): a view
  // from downtown draws the nearby cells, not all ~117k triangles of the line
  const CELLK = 1000, boxGeo = new THREE.BoxGeometry(1, 1, 1), boxMat = new THREE.MeshLambertMaterial()
  const structs = new THREE.Group(), cells = new Map()
  city.scene.add(structs)
  const M = new THREE.Matrix4(), Qn = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), E = new THREE.Euler(), col = new THREE.Color()
  function buildStructures() {
    let k = 0
    const boxes = new Map()
    const put = (x, y, z, l, h, w, yaw, pitch, hex) => { // box of l x h x w centred at x, y, z
      if (k >= nBox) return
      E.set(0, yaw, pitch, 'YXZ'); Qn.setFromEuler(E)
      M.compose(V.set(x, y, z), Qn, S.set(l, h, w)); k++
      const key = Math.floor(x / CELLK) * 4096 + Math.floor(z / CELLK)
      let a = boxes.get(key); if (!a) boxes.set(key, (a = [])); a.push(M.clone(), hex)
    }
    const sh = rail.data.shapes, A = {}, B = {}
    for (const [si, i0, i1] of man.guide) {
      const s = sh[si]
      let nextPier = 0
      for (let i = i0; i < i1; i++) {
        const a = at(s, s.cum[i], A), ya = a.y, xa = a.x, za = a.z, ha = a.hidden, la = ya - H(xa, za)
        const b = at(s, s.cum[i + 1], B)
        if (ha || b.hidden) continue
        const lb = b.y - H(b.x, b.z), dx = b.x - xa, dz = b.z - za, L = Math.hypot(dx, dz)
        const elevated = Math.max(la, lb) > 2.5, T = elevated ? 1.5 : 0.45
        put((xa + b.x) / 2, (ya + b.y) / 2 - T / 2, (za + b.z) / 2, L + 0.6, T, elevated ? 7.6 : 7, Math.atan2(-dz, dx), Math.atan2(b.y - ya, L), elevated ? C.concrete : C.platform)
        if (elevated) {
          put((xa + b.x) / 2, (ya + b.y) / 2 + 0.35, (za + b.z) / 2, L + 0.6, 0.7, 0.35, Math.atan2(-dz, dx), Math.atan2(b.y - ya, L), C.concrete) // centre wall between tracks
        }
        // piers about every 35 m where the deck is high enough
        for (let d = Math.max(nextPier, s.cum[i]); d < s.cum[i + 1]; d += 35) {
          const p = at(s, d, A), g = H(p.x, p.z), h = p.y - 1.5 - g
          if (h > 2.5 && !p.hidden) {
            put(p.x, g + h / 2, p.z, 1.5, h, 1.8, Math.atan2(-dz, dx), 0, C.pier)
            put(p.x, g + h - 0.5, p.z, 1.8, 1.0, 5.2, Math.atan2(-dz, dx), 0, C.pier)
          }
          nextPier = d + 35
        }
      }
    }
    for (const st of man.stations) {
      const s = sh[st.shape], p = at(s, st.s, A)
      // directions from the manifest are in local east/north; turn them into world yaw through the affine fit
      const dx = Math.cos(st.dir), dn = Math.sin(st.dir), wyaw = Math.atan2(-(az * dx + bz * dn), ax * dx + bx * dn)
      if (p.hidden) { // underground: an entrance kiosk on the street
        const g = H(p.x, p.z)
        put(p.x, g + 2, p.z, 10, 4, 7, wyaw, 0, C.kiosk)
        put(p.x, g + 4.15, p.z, 11, 0.3, 8, wyaw, 0, C.canopy)
        continue
      }
      const L = st.len, wide = st.kind === 'wce' ? 6 : 13
      const y = p.y, off = st.kind === 'wce' ? 5 : 0
      const ox_ = Math.sin(wyaw) * off, oz_ = Math.cos(wyaw) * off
      put(p.x + ox_, y - 0.6, p.z + oz_, L, 1.2, wide, wyaw, 0, C.platform) // platforms
      for (const f of [-0.22, 0, 0.22]) put(p.x + ox_ + Math.cos(wyaw) * L * f, y + 2.4, p.z + oz_ - Math.sin(wyaw) * L * f, 0.5, 4.8, wide * 0.7, wyaw, 0, C.grey)
      put(p.x + ox_, y + 5, p.z + oz_, L * 0.55, 0.45, wide + 1.5, wyaw, 0, C.canopy) // canopy roof over the middle
      if (p.y - H(p.x, p.z) > 3) { const g = H(p.x, p.z), h = y - 1.2 - g; put(p.x, g + h / 2, p.z, L * 0.5, h, 5, wyaw, 0, C.pier) } // stair/escalator core
    }
    for (const m of cells.values()) { structs.remove(m); m.dispose() }
    cells.clear()
    for (const [key, a] of boxes) {
      const m = new THREE.InstancedMesh(boxGeo, boxMat, a.length / 2)
      for (let i = 0; i < a.length; i += 2) { m.setMatrixAt(i / 2, a[i]); m.setColorAt(i / 2, col.set(a[i + 1])) }
      m.castShadow = m.receiveShadow = true
      m.computeBoundingSphere()
      m.userData.c = m.boundingSphere.center.clone(); m.userData.r = m.boundingSphere.radius
      cells.set(key, m); structs.add(m)
    }
    city.requestRender()
  }
  buildStructures()
  const offFog = city.on('frame', () => { // third person: cells past the fog end are not drawn (the map has no fog: all)
    const P = city.player, far = city.scene.fog?.isFog && P ? city.scene.fog.far + 100 : Infinity
    for (const m of cells.values()) m.visible = far === Infinity || Math.hypot(m.userData.c.x - P.x, m.userData.c.z - P.z) - m.userData.r < far
  })
  // the streamed core loads terrain tile by tile: build again once the ground under the guideway may have changed
  let rebuild = 0
  const offTile = city.on('tile:load', () => { clearTimeout(rebuild); rebuild = setTimeout(buildStructures, 400) })

  // ---------- clock ----------
  const simNow = () => anchorSim + (performance.now() - anchorReal) * speed
  const setClock = (ms, sp = speed) => { anchorSim = ms; anchorReal = performance.now(); speed = sp; kick(true) }
  const showOf = (kind) => (kind === 'expo' || kind === 'millennium' || kind === 'canada' ? show.sky : kind === 'bus' || kind === 'trolley' ? show.bus : show[kind])

  // ---------- per frame ----------
  const P1 = { x: 0, y: 0, z: 0, hidden: false }, P2 = { x: 0, y: 0, z: 0, hidden: false }
  const counts = new Map()
  let drawn = 0, lastDrawn = 0
  function placeCar(kind, sh, front, L, s, side) {
    const m = meshes[kind]
    if (m.count >= cap[kind]) return
    const a = at(sh, front, P1), b = at(sh, front - L, P2)
    if (a.hidden || b.hidden) return // in a tunnel
    let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
    const len = Math.hypot(dx, dy, dz) || 1
    dx /= len; dy /= len; dz /= len
    const hz = Math.hypot(dx, dz) || 1
    const ux = (-dx * dy) / hz, uy = hz, uz = (-dz * dy) / hz // up, perpendicular to travel
    const sx = dy * uz - dz * uy, sy = dz * ux - dx * uz, sz = dx * uy - dy * ux // side = dir x up
    const rx = -dz / hz, rz = dx / hz // right of travel on the ground
    const e = m.instanceMatrix.array, i = m.count * 16
    e[i] = dx; e[i + 1] = dy; e[i + 2] = dz; e[i + 3] = 0
    e[i + 4] = ux * s; e[i + 5] = uy * s; e[i + 6] = uz * s; e[i + 7] = 0
    e[i + 8] = sx * s; e[i + 9] = sy * s; e[i + 10] = sz * s; e[i + 11] = 0
    e[i + 12] = (a.x + b.x) / 2 + rx * side; e[i + 13] = (a.y + b.y) / 2; e[i + 14] = (a.z + b.z) / 2 + rz * side; e[i + 15] = 1
    m.count++
  }
  // the Vancouver clock at sim time ms: formatted once a minute (Intl is slow), counted on to the next
  const clk = { ms: -Infinity, v: null }
  function clock(ms) {
    let dt = (ms - clk.ms) / 1000
    if (!(clk.v && dt >= 0 && Math.floor((clk.v.sec + dt) / 60) === Math.floor(clk.v.sec / 60))) { clk.ms = ms; clk.v = vancouver(ms); clk.y = vancouver(ms - 864e5).ymd; dt = 0 }
    return { ymd: clk.v.ymd, ymdY: clk.y, sec: clk.v.sec + dt, hm: clk.v.hm, wd: clk.v.wd, p: clk.v.p }
  }
  let c, ch, vb, me, scale // the chunk being drawn, for visit()
  const pad = 250
  function update() {
    const v = clock(simNow())
    const pat = patternOf(man, v.ymd), patY = patternOf(man, v.ymdY)
    for (const m of Object.values(meshes)) m.count = 0
    counts.clear()
    vb = city.view.bounds
    const mpp = city.view.metresPerPixel, zoom = city.view.zoom
    const busOn = show.bus && zoom >= BUS_ZOOM && !document.hidden
    me = city.player?.vehicle === 'bus' ? city.player : null
    scale = Math.min(5, Math.max(1, mpp / 0.9)) // trains stay visible zoomed out
    drawn = 0
    for (c of chunks) {
      if (!c.rail) {
        if (!busOn || c.w[2] < vb.x0 - pad || c.w[0] > vb.x1 + pad || c.w[3] < vb.z0 - pad || c.w[1] > vb.z1 + pad) continue
        if (!c.data) { if (!c.loading) load(c); continue }
      }
      ch = c.data
      eachActive(ch, v.sec, pat, patY, visit)
    }
    for (const m of Object.values(meshes)) m.instanceMatrix.needsUpdate = true
    return v
  }
  function visit(i, rel) { // a trip running now: its vehicle on screen
        const pr = ch.profs[ch.prof[i]], p = pr.p, r = routes[p.route]
        if (!showOf(r.kind)) return
        counts.set(p.route, (counts.get(p.route) || 0) + 1)
        // distance along the shape: dwell at stops, ease between stations for trains, steady for buses
        const n = pr.arr.length
        let k = 0
        while (k + 1 < n && pr.arr[k + 1] <= rel) k++
        let d
        if (rel < pr.dep[k] || k === n - 1) d = p.dist[k]
        else {
          let f = (rel - pr.dep[k]) / Math.max(1, pr.arr[k + 1] - pr.dep[k])
          if (c.rail) { // accelerate, cruise, brake (trapezoid speed profile)
            const a = r.kind === 'seabus' ? 0.15 : 0.25
            f = f < a ? (f * f) / (2 * a * (1 - a)) : f > 1 - a ? 1 - ((1 - f) * (1 - f)) / (2 * a * (1 - a)) : (f - a / 2) / (1 - a)
          }
          d = p.dist[k] + (p.dist[k + 1] - p.dist[k]) * f
        }
        const sh = ch.shapes[p.shape]
        const h = ((ch.starts[i] * 2654435761) >>> 0) / 4294967296
        let cars, carL, kindOf
        const cs = consist(r.kind, h)
        if (cs) { kindOf = cs[0]; cars = cs[1]; carL = KINDS[kindOf].L } else if (r.kind === 'wce') { cars = 7; carL = 25.9 } else { kindOf = (r.kind === 'trolley' ? 'trolley' : 'bus') + (r.artic ? '18' : '12'); cars = 1; carL = KINDS[kindOf].L }
        const gap = 0.6, total = cars * carL + (cars - 1) * gap
        const front = Math.min(sh.len, Math.max(total, d + total / 2))
        // lead car on screen? (cheap check before the full placement)
        at(sh, front - total / 2, P1)
        const reach = total / 2 + pad
        if (P1.x < vb.x0 - reach || P1.x > vb.x1 + reach || P1.z < vb.z0 - reach || P1.z > vb.z1 + reach) return
        if (me && !c.rail && (P1.x - me.x) ** 2 + (P1.z - me.z) ** 2 < 900) return // not on top of the bus the user drives
        const side = r.kind === 'seabus' ? 22 : r.kind === 'wce' ? 0 : c.rail ? 1.9 : 1.8
        const s = c.rail ? scale : 1
        for (let j = 0; j < cars; j++) {
          const kk = r.kind === 'wce' ? (j === 0 ? 'wceLoco' : 'wceCoach') : kindOf
          const L = r.kind === 'wce' && j === 0 ? 20 : carL
          placeCar(kk, sh, front - j * (carL + gap), L, s, side)
        }
        drawn++
  }

  // ---------- loop: update about once per pixel of movement, only while on and visible ----------
  function kick(f) { force = force || f; if (!raf && !document.hidden) raf = requestAnimationFrame(loop) }
  function loop(now) {
    raf = 0
    if (document.hidden) return
    const mpp = city.view.metresPerPixel, c = city.view.center
    if (Math.abs(c.x - lastView.x) > 0.05 || Math.abs(c.z - lastView.z) > 0.05 || Math.abs(mpp - lastView.mpp) > 5e-5) { lastView.x = c.x; lastView.z = c.z; lastView.mpp = mpp; force = true }
    const interval = lastDrawn ? Math.min(250, (1000 * mpp) / (22 * speed)) : 1000
    if (force || now - last >= interval) {
      force = false; last = now
      update()
      if (drawn || lastDrawn) city.requestRender()
      lastDrawn = drawn
      ui?.refresh()
    }
    raf = requestAnimationFrame(loop)
  }
  const onVis = () => { if (!document.hidden) kick(true) }
  document.addEventListener('visibilitychange', onVis)

  // ---------- panel ----------
  ui = makePanel()
  function makePanel() {
    const btn = city.ui.addButton({ label: 'Transit', icon: '🚆', title: 'Transit on its timetable', panel: true })
    const el = btn.panel
    el.innerHTML = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px"><b data-t style="font-size:18px">--:--</b><span data-p style="color:var(--muted);font-size:12px"></span></div>
      <div style="display:flex;gap:4px;margin:8px 0" data-speeds>${[1, 10, 60].map((s) => `<button type="button" data-s="${s}" style="flex:1">×${s}</button>`).join('')}<button type="button" data-now style="flex:1.3">Now</button></div>
      <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted)">Jump to <input type="datetime-local" data-at style="flex:1;font:inherit;color:inherit;background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:6px;padding:2px 4px"></label>
      <div data-lines style="margin:10px 0;display:grid;gap:4px;font-size:13px"></div>
      <div style="font-size:11px;color:var(--muted);line-height:1.35">Scheduled positions, not live. ${man.credit} Feed ${man.feed.feed_version}. Guideways and stations © OpenStreetMap contributors.</div>`
    const style = 'font:inherit;color:var(--text);background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:6px;padding:4px 0;cursor:pointer'
    for (const b of el.querySelectorAll('button')) b.style.cssText += style
    el.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => setClock(simNow(), +b.dataset.s)))
    el.querySelector('[data-now]').addEventListener('click', () => setClock(Date.now(), 1))
    const atIn = el.querySelector('[data-at]')
    atIn.addEventListener('change', () => {
      const m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/.exec(atIn.value)
      if (m) setClock(fromVancouver(+m[1], +m[2], +m[3], +m[4], +m[5]))
    })
    const groups = [
      ['sky', 'Expo Line', 'expo', '#0033a0'], ['sky', 'Millennium Line', 'millennium', '#ffcd00'], ['sky', 'Canada Line', 'canada', '#007c9f'],
      ['wce', 'West Coast Express', 'wce', '#87189d'], ['seabus', 'SeaBus', 'seabus', '#746661'],
      ['bus', 'Buses', 'bus', '#0d4ea6'], ['bus', 'Trolleybuses', 'trolley', '#f5c400'],
    ]
    const lines = el.querySelector('[data-lines]')
    lines.innerHTML = groups.map(([g, name, kind, c]) => `<label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" data-g="${g}" checked><span style="width:14px;height:6px;border-radius:3px;background:${c}"></span><span style="flex:1">${name}</span><span data-n="${kind}" style="color:var(--muted);font-variant-numeric:tabular-nums"></span></label>`).join('')
    lines.querySelectorAll('[data-g]').forEach((cb) => cb.addEventListener('change', () => {
      show[cb.dataset.g] = cb.checked
      lines.querySelectorAll(`[data-g="${cb.dataset.g}"]`).forEach((x) => { x.checked = cb.checked })
      kick(true); city.requestRender()
    }))
    const tEl = el.querySelector('[data-t]'), pEl = el.querySelector('[data-p]')
    let lastText = ''
    return {
      remove: () => btn.remove(),
      refresh() {
        if (el.hidden) return
        const v = clock(simNow())
        const busNote = city.view.zoom < BUS_ZOOM ? 'zoom in' : 'nearby'
        const byKind = {}
        for (const [ri, n] of counts) byKind[routes[ri].kind] = (byKind[routes[ri].kind] || 0) + n
        const text = `${v.wd} ${v.hm}|${man.patterns[patternOf(man, v.ymd)]} timetable${speed > 1 ? ` · ×${speed}` : ''}|` + groups.map(([, , k]) => byKind[k] ?? '').join()
        if (text === lastText) return
        lastText = text
        tEl.textContent = `${v.wd} ${v.hm}`
        pEl.textContent = `${man.patterns[patternOf(man, v.ymd)]} timetable${speed > 1 ? ` · ×${speed}` : ''}`
        for (const [, , k] of groups) {
          const n = byKind[k] || 0
          el.querySelector(`[data-n="${k}"]`).textContent = k === 'bus' || k === 'trolley' ? (n ? `${n} ${busNote === 'nearby' ? 'nearby' : ''}` : busNote === 'zoom in' ? 'zoom in' : '0') : String(n)
        }
        el.querySelectorAll('[data-s]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.s === speed)))
      },
    }
  }

  kick(true)
  return {
    dispose() {
      cancelAnimationFrame(raf); raf = 0
      offTile(); offFog(); offDecks(); offDrop(); clearTimeout(rebuild); document.removeEventListener('visibilitychange', onVis)
      city.scene.remove(group); city.scene.remove(structs)
      for (const m of Object.values(meshes)) m.geometry.dispose()
      for (const m of cells.values()) m.dispose(); boxGeo.dispose(); boxMat.dispose(); mat.dispose()
      ui.remove(); city.requestRender()
    },
  }
}
