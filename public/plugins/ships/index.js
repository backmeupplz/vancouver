// Ships and boats on the water: freighters at the English Bay and inner-harbour anchorages, container ships,
// bulkers and tankers at their terminals, BC Ferries on their routes from Tsawwassen and Horseshoe Bay, the
// False Creek mini ferries, tugs towing log booms on the Fraser, a few sail and motor boats in English Bay, kayaks and
// paddleboards inshore, the marinas' moored boats, float planes at the Flight Centre and, in the Alaska season,
// cruise ships at Canada Place and Ballantyne Pier. The models: models.js.
// Simulated on the clock (Vancouver time, the same for everyone); set AIS_URL below for live positions.
// Routes and berths: tools/ships_data.py → data.json, from OpenStreetMap (© OpenStreetMap contributors, ODbL).
// The SeaBus belongs to the transit plugin.
import { mulberry32, vancouver, getJSON } from '../../core/util.js'
import { shipModels } from './models.js'

// ---- LIVE AIS: the one switch -------------------------------------------------------------------------------
// A same-origin URL returning the vessels in the area as JSON, polled every 15 s while the page is visible:
//   [{ "mmsi": 316001234, "lat": 49.29, "lon": -123.2, "sog": 12.5 (knots), "cog": 270 (deg), "hdg": 268 (deg,
//      511 = unknown), "type": 70 (AIS ship and cargo type), "len": 225 (m, optional) }, …]
// aisstream.io (free, needs an API key, no browser connections) behind a tiny relay is one way to get it. With it
// set, live vessels replace all the simulated ones.
const AIS_URL = ''
// --------------------------------------------------------------------------------------------------------------

const DATA = new URL('./data.json', import.meta.url)
// BC Ferries routes we sail (OSM ref): crossing time in minutes, sailings every N minutes between first and last
// departure (local hours) from both ends. Approximate, not the timetable.
const ROUTES = { 1: [95, 120, 7, 21], 2: [100, 120, 6.5, 20.5], 3: [40, 120, 7.3, 21.3], 8: [20, 60, 6, 22], 30: [120, 180, 5.25, 20.25], 9: [55, 240, 9, 17] }
const MINI_HOURS = [6.75, 22.5] // Aquabus / False Creek Ferries service
const SMALL_ZOOM = 0.06 // below this boats under ~30 m are not drawn (or moved)

// Cruise ships, April to October: a static weekly schedule (Alaska cruises turn round on the same weekday each week),
// berthed 7:00 to 16:30 (17:30 at weekends). Berths: the ships' centre lines, stern to bow, from the 2022 orthophoto
// (two ships at Canada Place) and Ballantyne Pier's north face. Plausible, not the port's actual schedule.
const CRUISE = [
  { stern: [49.28873, -123.11336], bow: [49.28991, -123.10988], days: ['Sat', 'Sun', 'Mon', 'Tue', 'Thu', 'Fri'] }, // Canada Place West
  { stern: [49.28944, -123.10726], bow: [49.28817, -123.11082], days: ['Sat', 'Sun', 'Mon', 'Wed', 'Fri'] }, // Canada Place East
  { stern: [49.288716, -123.087852], bow: [49.289734, -123.09152], days: ['Sat', 'Sun'], peak: true }, // Ballantyne
]
let cdMin = -1, cdDay = null
function cruiseDay(ms) { // { wd, shoulder, weekend } while ships are berthed, else null (worked out once a minute)
  if (Math.floor(ms / 60000) === cdMin) return cdDay
  cdMin = Math.floor(ms / 60000)
  const { p, sec, wd } = vancouver(ms), m = +p.month, weekend = wd === 'Sat' || wd === 'Sun'
  return (cdDay = m < 4 || m > 10 || sec < 7 * 3600 || sec > (weekend ? 17.5 : 16.5) * 3600 ? null : { wd, shoulder: m === 4 || m === 10, weekend })
}

// The fleet: a variant of a class's model (models.js), stretched to this vessel's length and beam
const pick = (r, a) => a[Math.floor(r() * a.length)]
const vessel = (models) => (r, kind, L, B) => { const m = pick(r, models[kind]); return { m, L: L ?? m.L, B: B ?? m.B, small: m.small } }

export default async function ships(city) {
  const { THREE } = city
  const data = await getJSON(DATA)
  const ground = (x, z) => (city.sea?.at ? city.sea.at(x, z) : city.world.heightAt(x, z)) // the water there, with the tide
  const xz = (lat, lon) => { const v = city.world.fromLatLon(lat, lon); return [v.x, v.z] }

  const V = vessel(shipModels(THREE))
  const MODELS = {
    container: (r) => V(r, 'container', 280 + r() * 40), bulk: (r) => V(r, 'bulk', 200 + r() * 40), tanker: (r) => V(r, 'tanker', 230 + r() * 30),
    car: (r) => V(r, 'car'), general: (r) => V(r, 'general', 150 + r() * 40), cruise: (r, L) => V(r, 'cruise', L),
    bcf: (r, L, B) => V(r, 'bcf', L, B), mini: (r, aquabus) => V(r, aquabus ? 'aquabus' : 'fcf'), tug: (r) => V(r, 'tug'), boom: (r) => V(r, 'boom'),
    sail: (r) => V(r, 'sail', 10 + r() * 4, 3.4), motor: (r) => V(r, 'motor', 8 + r() * 4, 3),
    kayak: (r) => V(r, 'kayak'), sup: (r) => V(r, 'sup'),
  }

  // ---------- the fleet: dynamic vessels first (their instances are re-uploaded each frame), then static ----------
  const r = mulberry32(20261106)
  const dyn = [], stat = []
  const add = (list, model, place, extra) => { const v = { ...model, place, ...extra }; list.push(v); return v }
  const sec = localClock()

  if (AIS_URL) {
    for (const [kind, n] of [['container', 25], ['bulk', 40], ['tanker', 15], ['bcf', 15], ['mini', 10], ['tug', 30], ['sail', 25], ['motor', 40]])
      for (let i = 0; i < n; i++) add(dyn, MODELS[kind](r), livePlace, { kind, live: null })
  } else {
    const W = (fn) => fn // readability: place functions get (t: epoch s, out) and fill out = [x, z, heading, speed] or return false
    // BC Ferries: both ends depart on the same pattern; a ferry waits at the berth for 25 min before sailing
    const seen = new Set()
    for (const f of data.ferries) {
      if (f.op !== 'bcf' || !ROUTES[f.ref] || (f.ref === '9' && !f.name.includes('Galiano')) || seen.has(f.ref)) continue
      seen.add(f.ref)
      const [mins, every, first, last] = ROUTES[f.ref], P = path(f.pts.map(([a, b]) => xz(a, b))), dur = mins * 60, ev = every * 60
      const n = Math.ceil((dur + 1500) / ev) + 1
      for (const back of [false, true]) for (let slot = 0; slot < n; slot++) {
        add(dyn, MODELS.bcf(r, f.ref === '8' ? 96 : 160, f.ref === '8' ? 21 : 27), W((t, out) => {
          const s = sec(t)
          for (let k = 0, d = first * 3600; d <= last * 3600; k++, d += ev) {
            if (k % n !== slot || s < d - 1500 || s > d + dur) continue
            const u = Math.max(0, s - d) / dur, along = smooth(u) * P.len
            P.at(back ? P.len - along : along, out, back)
            out[3] = s < d ? 0 : P.len / dur
            return true
          }
          return false
        }))
      }
    }
    // False Creek: one boat per leg, back and forth, a minute at each dock
    const legs = new Set()
    for (const f of data.ferries) {
      if (f.op === 'bcf' || legs.has(f.name)) continue
      legs.add(f.name)
      const P = path(f.pts.map(([a, b]) => xz(a, b))), v = 3, run = P.len / v, per = 2 * (run + 60), phase = r() * per
      add(dyn, MODELS.mini(r, f.op === 'aquabus'), W((t, out) => {
        const h = sec(t) / 3600
        let q = h < MINI_HOURS[0] || h > MINI_HOURS[1] ? 0 : (t + phase) % per
        const back = q > per / 2
        if (back) q -= per / 2
        const u = Math.min(1, Math.max(0, (q - 30) / run))
        P.at(back ? P.len * (1 - smooth(u)) : P.len * smooth(u), out, back)
        out[3] = u > 0 && u < 1 ? v : 0
        return true
      }))
    }
    // tugs with log booms on the Fraser, 1.6 m/s, turning round at the ends of each reach
    for (const rv of data.river) {
      const P = path(rv.pts.map(([a, b]) => xz(a, b))), v = 1.6, per = (2 * P.len) / v, phase = r() * per
      const at = (t, out, lag) => {
        let q = ((t + phase) % per) * v
        const back = q > P.len
        if (back) q = 2 * P.len - q
        P.at(Math.min(P.len, Math.max(0, q + (back ? lag : -lag))), out, back)
        out[3] = v
        return true
      }
      add(dyn, MODELS.tug(r), (t, out) => at(t, out, 0))
      add(dyn, MODELS.boom(r), (t, out) => { at(t, out, 62); out[3] = 0; return true })
    }
    // English Bay: sailboats on slow ellipses, motor boats on figure eights
    const BAY = [[49.2870, -123.1650, 300], [49.2835, -123.1800, 260], [49.2900, -123.1720, 220], [49.2860, -123.1950, 350], [49.2950, -123.1650, 160]]
    for (let i = 0; i < 12; i++) {
      const [la, lo, R] = BAY[i % BAY.length], [cx, cz] = xz(la, lo), sail = i < 8, w = (sail ? 2.6 : 7) / R, ph = r() * 7, dir = r() < 0.5 ? 1 : -1
      add(dyn, MODELS[sail ? 'sail' : 'motor'](r), (t, out) => {
        const a = (t * w * dir + ph) % (Math.PI * 2)
        const x = sail ? R * Math.cos(a) : R * Math.sin(a), z = sail ? 0.6 * R * Math.sin(a) : 0.45 * R * Math.sin(2 * a)
        const dx = sail ? -R * Math.sin(a) : R * Math.cos(a), dz = sail ? 0.6 * R * Math.cos(a) : 0.9 * R * Math.cos(2 * a)
        out[0] = cx + x; out[1] = cz + z; out[2] = Math.atan2(dx * dir, -dz * dir); out[3] = w * R
        return true
      })
    }

    // cruise ships at their berths on their weekdays in season (fewer in April and October)
    for (const c of CRUISE) {
      const [ax, az] = xz(...c.stern), [bx, bz] = xz(...c.bow), L = Math.hypot(bx - ax, bz - az), h = Math.atan2(bx - ax, -(bz - az))
      for (const wd of c.days) add(dyn, MODELS.cruise(r, L), (t, out) => {
        const d = cruiseDay(t * 1000)
        if (!d || d.wd !== wd || (d.shoulder && (c.peak || !d.weekend))) return false
        out[0] = (ax + bx) / 2; out[1] = (az + bz) / 2; out[2] = h; out[3] = 0
        return true
      }, { cruise: true })
    }
    // at anchor: all swing to the tide (flood ~ every 12.4 h), facing into it
    const tide = Math.floor(Date.now() / 1000 / 22350) % 2 ? 2.0 : 5.1
    for (const [la, lo] of data.anchorages) {
      if (r() < 0.2) continue
      const [x, z] = xz(la, lo), m = MODELS[pick(r, ['bulk', 'bulk', 'bulk', 'container', 'tanker', 'general'])](r)
      add(stat, m, null, { x, z, h: tide + (r() - 0.5) * 0.3 })
    }
    // at the terminals: ships along each straight quay, on its water side (OSM coastline: water on the right) and
    // clear of the terminal (b.off: how far its wharf stands out past the coastline)
    const cruiseAt = CRUISE.map((c) => xz((c.stern[0] + c.bow[0]) / 2, (c.stern[1] + c.bow[1]) / 2))
    for (const b of data.berths) {
      const [ax, az] = xz(...b.a), [bx, bz] = xz(...b.b), len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len
      if (cruiseAt.some(([x, z]) => Math.hypot(x - (ax + bx) / 2, z - (az + bz) / 2) < 120)) continue // a cruise berth (Ballantyne)
      const kind = b.k === 'general' && /Auto/.test(b.t) ? 'car' : b.k
      let s = 15
      for (;;) {
        const m = MODELS[kind](r)
        if (s + m.L > len - 10) break
        if (r() < 0.7) { // 30% of berths empty
          const c = s + m.L / 2, off = (b.off || 0) + m.B / 2 + 4, flip = r() < 0.5
          add(stat, m, null, { x: ax + ux * c - uz * off, z: az + uz * c + ux * off, h: Math.atan2(ux, -uz) + (flip ? Math.PI : 0) })
        }
        s += m.L + 25
      }
    }
  }

  // paddlers close inshore: kayaks and paddleboards on slow loops off the beaches and in False Creek
  const PADDLE = [[49.288, -123.148, 60], [49.2775, -123.158, 70], [49.278, -123.2, 80], [49.296, -123.158, 60], [49.3215, -123.155, 60], // off the beaches
    ...data.ferries.filter((f) => f.op !== 'bcf').slice(0, 9).filter((f, i) => i % 3 === 0).map((f) => [...f.pts[f.pts.length >> 1], 35])] // False Creek
  for (let i = 0; i < 16 && !AIS_URL; i++) {
    const [la, lo, R] = PADDLE[i % PADDLE.length], [cx, cz] = xz(la, lo), sup = i % 3 === 2, a0 = r() * 7, w = ((sup ? 0.9 : 1.5) / R) * (r() < 0.5 ? 1 : -1), e = 0.4 + r() * 0.4
    add(dyn, MODELS[sup ? 'sup' : 'kayak'](r), (t, out) => {
      const a = t * w + a0
      out[0] = cx + R * Math.cos(a); out[1] = cz + R * e * Math.sin(a); out[2] = Math.atan2(-Math.sin(a) * w, -e * Math.cos(a) * w); out[3] = 0.2 // (too slow for a wake)
      return true
    })
  }
  // moored: marina berths, three in four taken, and float planes at the Vancouver Harbour Flight Centre's floats
  const moored = []
  for (const [la, lo, hd, len] of data.moorings || []) {
    if (r() < 0.25) continue
    const [x, z] = xz(la, lo), L = Math.min(13, Math.max(6, len * 0.85)) * (0.8 + r() * 0.2), kind = r() < 0.55 ? 'moored' : 'motor'
    add(moored, V(r, kind, L, L * 0.34), null, { x, z, h: (hd * Math.PI) / 180 + (r() < 0.5 ? Math.PI : 0) })
  }
  for (const [la, lo, hd] of [[49.29098, -123.1178, 190], [49.290944, -123.1175, 190], [49.290755, -123.116867, 205], [49.290683, -123.116593, 205]])
    add(moored, V(r, 'floatplane'), null, { x: xz(la, lo)[0], z: xz(la, lo)[1], h: (hd * Math.PI) / 180 })

  // ---------- one batched mesh: every variant's geometry once, an instance per vessel, drawn in one call ----------
  const usedBy = (list) => [...new Set(list.map((v) => v.m))]
  const all = [...dyn, ...stat], used = usedBy(all)
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true })
  const mesh = new THREE.BatchedMesh(all.length, used.reduce((n, m) => n + m.geo.attributes.position.count, 0), 0, mat)
  mesh.name = 'ships'
  mesh.castShadow = mesh.receiveShadow = true
  mesh.frustumCulled = false // spread over the whole region (each vessel is culled on its own)
  mesh.sortObjects = false
  for (const m of used) m.id = mesh.addGeometry(m.geo)
  for (const v of all) { v.id = mesh.addInstance(v.m.id); v.s = new THREE.Vector3(v.L / v.m.L, v.B / v.m.B, v.B / v.m.B) }
  city.scene.add(mesh)
  // the moored boats: a batch of their own that never moves, shown from SMALL_ZOOM in
  const moor = new THREE.BatchedMesh(Math.max(1, moored.length), usedBy(moored).reduce((n, m) => n + m.geo.attributes.position.count, 0) || 3, 0, mat)
  moor.name = 'ships-moored'
  moor.castShadow = moor.receiveShadow = true
  moor.sortObjects = false
  const mid = new Map(usedBy(moored).map((m) => [m, moor.addGeometry(m.geo)]))
  for (const v of moored) v.id = moor.addInstance(mid.get(v.m))
  city.scene.add(moor)

  // wakes: a Kelvin V and a churned centre line behind every moving vessel, in the overlay
  const wakeGeo = new THREE.BufferGeometry()
  {
    const P = [], C = []
    const tri = (a, b, c, al) => { P.push(...a, ...b, ...c); C.push(1, 1, 1, al[0], 1, 1, 1, al[1], 1, 1, 1, al[2]) }
    for (const s of [1, -1]) { // two arms at the Kelvin angle (19.5°), thin, fading aft
      const a0 = [0, 0, s * 0.06], a1 = [0, 0, s * 0.1], b0 = [-1, 0, s * 0.33], b1 = [-1, 0, s * 0.38]
      tri(a0, b0, a1, [0.5, 0, 0.5]); tri(a1, b0, b1, [0.5, 0, 0])
    }
    tri([0, 0, -0.07], [-0.65, 0, 0], [0, 0, 0.07], [0.4, 0, 0.4])
    wakeGeo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
    wakeGeo.setAttribute('color', new THREE.Float32BufferAttribute(C, 4))
  }
  const wakes = new THREE.InstancedMesh(wakeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }), Math.max(1, dyn.length))
  wakes.frustumCulled = false
  wakes.count = 0
  city.overlay.add(wakes)

  // ---------- placing ----------
  const W4 = new THREE.Matrix4(), M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1)
  const water = (x, z, h, L) => { // the sea is the lowest ground under the hull (the shore is interpolated up into it)
    const dx = Math.sin(h) * L * 0.45, dz = -Math.cos(h) * L * 0.45
    return Math.min(ground(x, z), ground(x + dx, z + dz), ground(x - dx, z - dz))
  }
  function put(v, x, z, h, k = 1) {
    pos.set(x, water(x, z, h, v.L * k), z)
    W4.compose(pos, q.setFromAxisAngle(up, Math.PI / 2 - h), one.setScalar(k))
    mesh.setMatrixAt(v.id, M4.copy(W4).scale(v.s))
    mesh.setVisibleAt(v.id, true)
  }
  const hide = (v) => mesh.setVisibleAt(v.id, false)
  function place() { // the ones that lie still: now, and again when the tide has moved the water
    for (const v of stat) put(v, v.x, v.z, v.h)
    for (const v of moored) {
      pos.set(v.x, water(v.x, v.z, v.h, v.L), v.z)
      moor.setMatrixAt(v.id, M4.compose(pos, q.setFromAxisAngle(up, Math.PI / 2 - v.h), one.set(v.L / v.m.L, v.B / v.m.B, v.B / v.m.B)))
    }
    city.requestRender()
  }
  place(); const offTide = city.on('tide', place)
  for (const v of dyn) hide(v)
  const out = [0, 0, 0, 0]
  function update() {
    const t = Date.now() / 1000, zoom = city.view.zoom
    let nw = 0
    for (const v of dyn) {
      if ((v.small && zoom < SMALL_ZOOM) || !v.place(t, out, v)) { hide(v); continue }
      const k = v.k || 1
      put(v, out[0], out[1], out[2], k)
      if (out[3] > 0.3) { // wake: length grows with speed
        const len = Math.max(25, v.L * k * Math.min(3, out[3] / 3.5))
        M4.compose(pos.set(-v.L * 0.48, 0.25 / k, 0), q.identity(), one.set(len / k, 1, len / k))
        wakes.setMatrixAt(nw++, M4.premultiply(W4))
      }
    }
    wakes.count = nw
    wakes.instanceMatrix.needsUpdate = true
  }
  update()
  city.requestRender()

  // ---------- animate only while something moving is on screen ----------
  let stop = null
  function onScreen() { // 0: nothing moving in view, 1: only slower than ~3 px/s (a step every 2 s will do), 2: animate
    if (document.hidden) return 0
    const b = city.view.bounds, t = Date.now() / 1000, zoom = city.view.zoom
    let r = 0
    for (const v of dyn) {
      if (v.small && zoom < SMALL_ZOOM) continue
      if (v.place(t, out, v) && out[3] > 0 && out[0] > b.x0 - 300 && out[0] < b.x1 + 300 && out[1] > b.z0 - 300 && out[1] < b.z1 + 300) {
        if (out[3] * 6 * zoom > 3) return 2
        r = 1
      }
    }
    return r
  }
  let berthed = ''
  function check() {
    const t = Date.now() / 1000, now = cruiseDay(t * 1000)?.wd ?? ''
    if (now !== berthed) { berthed = now; update(); city.requestRender() } // a cruise ship came in or left
    if (moor.visible !== city.view.zoom >= SMALL_ZOOM) { moor.visible = !moor.visible; city.requestRender() }
    const want = onScreen()
    if (want === 2 && !stop) stop = city.animate()
    else if (want < 2 && stop) { stop(); stop = null; update() }
    else if (want === 1) { update(); city.requestRender() }
  }
  const offFrame = city.on('frame', () => { if (stop) update() })
  let viewT = 0
  const offView = city.on('view', () => { if (!viewT) viewT = setTimeout(() => { viewT = 0; check() }, 200) })
  const tick = setInterval(check, 2000)
  document.addEventListener('visibilitychange', check)
  check()

  // ---------- live AIS ----------
  let aisT = 0
  function livePlace(t, out, v) {
    const a = v.live
    if (!a) return false
    const dt = Math.min(120, t - a.t), sp = a.sog * 0.5144
    out[0] = a.x + Math.sin(a.cog) * sp * dt; out[1] = a.z - Math.cos(a.cog) * sp * dt; out[2] = a.hdg; out[3] = sp
    return true
  }
  async function pollAIS() {
    if (!document.hidden) {
      try {
        const list = await fetch(AIS_URL, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`AIS: HTTP ${r.status}`); return r.json() }), t = Date.now() / 1000, byM = new Map()
        for (const v of dyn) if (v.live) byM.set(v.live.mmsi, v)
        const fresh = new Set()
        for (const s of list) {
          const kind = aisKind(s), [x, z] = xz(s.lat, s.lon), cog = ((s.cog ?? 0) * Math.PI) / 180
          let v = byM.get(s.mmsi)
          if (v && v.kind !== kind) { v.live = null; v = null }
          v ||= dyn.find((d) => !d.live && d.kind === kind)
          if (!v) continue
          v.live = { mmsi: s.mmsi, x, z, t, sog: s.sog || 0, cog, hdg: s.hdg != null && s.hdg < 360 ? (s.hdg * Math.PI) / 180 : cog }
          v.k = s.len ? Math.min(2, Math.max(0.4, s.len / v.L)) : 1
          fresh.add(v)
        }
        for (const v of dyn) if (v.live && !fresh.has(v)) v.live = null
        update(); city.requestRender(); check()
      } catch (e) { console.warn('ships: AIS', e) }
    }
    aisT = setTimeout(pollAIS, 15000)
  }
  if (AIS_URL) pollAIS()

  const credit = city.ui.credit(AIS_URL ? 'Ships: live AIS' : 'Ships: simulated · routes © OpenStreetMap')

  // for games (the sail plugin): vessels within r metres of their hull's end, like city.traffic.nearby
  // ({ id, x, y, z, heading, length, width, speed }, forward = (sin heading, cos heading) in x / z)
  city.ships = {
    nearby(x, z, r, hidden = false) { // hidden: the moored boats too while the map is too far out to show them (where a game is about to start)
      const res = [], t = Date.now() / 1000, zoom = city.view.zoom
      const near = (v, px, pz, h, sp, k) => {
        if (Math.hypot(px - x, pz - z) > r + (v.L * k) / 2) return
        res.push({ id: 'ship', x: px, y: ground(px, pz), z: pz, heading: Math.PI - h, length: v.L * k, width: v.B * k, speed: sp })
      }
      for (const v of dyn) if (!(v.small && zoom < SMALL_ZOOM) && v.place(t, out, v)) near(v, out[0], out[1], out[2], out[3], v.k || 1)
      for (const v of stat) near(v, v.x, v.z, v.h, 0, 1)
      if (moor.visible || hidden) for (const v of moored) near(v, v.x, v.z, v.h, 0, 1)
      return res
    },
  }

  return {
    dispose() {
      clearInterval(tick); clearTimeout(aisT); clearTimeout(viewT); offFrame(); offView()
      document.removeEventListener('visibilitychange', check)
      stop?.()
      offTide()
      for (const m of [mesh, moor, wakes]) { m.removeFromParent(); m.dispose() }
      for (const m of usedBy([...all, ...moored])) m.geo.dispose()
      wakeGeo.dispose()
      mat.dispose(); wakes.material.dispose(); credit.remove()
      delete city.ships
      city.requestRender()
    },
  }
}

// AIS ship type → model
function aisKind({ type = 0, len = 0, mmsi = 0 }) {
  if (type === 31 || type === 32 || type === 52) return 'tug'
  if (type === 36) return 'sail'
  if (type >= 60 && type < 70) return len > 60 ? 'bcf' : 'mini'
  if (type >= 70 && type < 80) return len > 260 || mmsi % 3 === 0 ? 'container' : 'bulk'
  if (type >= 80 && type < 90) return 'tanker'
  return len > 60 ? 'bulk' : 'motor'
}

// a polyline in x/z with lookups by distance along it; at() fills out = [x, z, heading (compass radians)]
function path(P) {
  const S = [0]
  for (let i = 1; i < P.length; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]))
  return {
    len: S[S.length - 1],
    at(s, out, back) {
      let i = 1
      while (i < S.length - 1 && S[i] < s) i++
      const ax = P[i - 1][0], az = P[i - 1][1], bx = P[i][0], bz = P[i][1], u = Math.min(1, Math.max(0, (s - S[i - 1]) / (S[i] - S[i - 1] || 1)))
      out[0] = ax + (bx - ax) * u; out[1] = az + (bz - az) * u
      out[2] = Math.atan2(bx - ax, -(bz - az)) + (back ? Math.PI : 0)
      return out
    },
  }
}
const smooth = (u) => { // constant speed with a gentle start and stop over the first and last 6%
  const e = 0.06
  if (u <= 0 || u >= 1) return Math.min(1, Math.max(0, u))
  const v = 1 / (1 - e) // area-preserving trapezoid speed profile
  if (u < e) return (v * u * u) / (2 * e)
  if (u > 1 - e) return 1 - (v * (1 - u) * (1 - u)) / (2 * e)
  return v * (u - e / 2)
}

// seconds since midnight in Vancouver for an epoch time (the offset is refreshed every 10 minutes)
function localClock() {
  let off = 0, at = -1e9
  return (t) => {
    if (t - at > 600) {
      at = t
      off = Math.floor(vancouver(Math.floor(t) * 1000).sec) - (Math.floor(t) % 86400)
    }
    return (((Math.floor(t) % 86400) + off) % 86400 + 86400) % 86400 + (t % 1)
  }
}
