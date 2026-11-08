// Live aircraft over the Lower Mainland: airliners into YVR, Boundary Bay and Pitt Meadows traffic, floatplanes
// and helicopters, at their reported position, altitude and track, dead-reckoned smoothly between polls.
// Data: adsb.lol (ODbL, https://adsb.lol), OpenSky Network as a fallback, both through the site's cached proxy
// in nginx.conf (/adsb/…; neither API sends CORS headers). One fixed query for the whole area, polled every 8 s
// while aircraft are on screen, every 30 s otherwise, never while the tab is hidden, with back-off on errors.
import { wrap } from '../../core/util.js'

const SOURCES = [
  { url: new URL('../../adsb/lm', import.meta.url), parse: parseAdsbLol, name: 'adsb.lol', href: 'https://adsb.lol' },
  { url: new URL('../../adsb/opensky', import.meta.url), parse: parseOpenSky, name: 'OpenSky Network', href: 'https://opensky-network.org' },
]
const FAST = 8000, SLOW = 30000, MAX_BACKOFF = 300000
const H = 1200 // displayed altitude: real up to a few hundred metres, then eased so cruising jets stay near the map

// tail colours by ICAO airline prefix of the callsign
const LIVERY = {
  ACA: 0x1f2124, JZA: 0x1f2124, ROU: 0xd22630, WJA: 0x1aa6a0, WEN: 0x1aa6a0, SWG: 0xf7a600, TSC: 0x1b75bb, POE: 0x13294b,
  FLE: 0x8cc63f, PCO: 0x0d4d8c, HES: 0x0072bc, KEW: 0xd62828, UAL: 0x0b3b8c, ASA: 0x01426a, QXE: 0x01426a, DAL: 0xc8102e,
  AAL: 0x9da6ab, SKW: 0x2c3e50, CPA: 0x005d63, JAL: 0xcc0000, ANA: 0x13448f, BAW: 0x1d2d5c, KLM: 0x00a1de, AFR: 0x002157,
  DLH: 0x05164d, EVA: 0x00843d, KAL: 0x76b3df, CES: 0x1d4f91, CSN: 0x0a5ea8, HAL: 0x5b2d8c, UAE: 0xd71a21, QFA: 0xe0001b,
  AMX: 0x0b2a4a, VOI: 0x7b1fa2, FDX: 0x4d148c, UPS: 0x4a2b1b, CJT: 0x1f3a93, PAL: 0x0038a8, ANZ: 0x111111, SIA: 0xf2b300,
  CAL: 0xd8a1b5, AAR: 0x2d2a6e, CCA: 0xc8102e, HVN: 0x00728a, THY: 0xc8102e, FJI: 0x2b4c7e, SCX: 0xf28c00, NKS: 0xf5d000,
}
const GA_COLOURS = [0xc0392b, 0x2b6cb0, 0x1d3a5f, 0xe67e22, 0x2f8f5b, 0xf1c40f, 0x8e44ad]

const HELI = /^(EC\d\d|AS[35]\d|H1[2356]\d|H160|B06|B05|B105|BK17|B212|B222|B230|B407|B412|B427|B429|B430|B505|R22|R44|R66|S76|S92|S61|S70|A109|A119|A139|A169|A189|AW\d|EXPL|MD52|MD60|EH10|H60|UH1|CH47|EN48|G2CA)/
const FLOAT = /^(DHC2|DHC3|DH3T|BEVR)$/
const PROP = /^(DH8|AT4|AT7|DHC6|DHC7|SF34|SW4|B190|BE20|BE30|B350|BE9|C208|PC12|JS3|JS4|D328|E120|L410|AN2|C212|PC6|KODI|P180|M28|DHC5|TBM)/
const GA = /^(C1[5-9]\d|C2[0-1]\d|PA\d|P28|P32|SR2|DA4|DA2|BE3[56]|M20|C82|RV\d|G115|C42|AA5)/

export default function planes(city) {
  const { THREE } = city
  const MAX = 160

  // ---------- models: flat-shaded, white with a livery accent (tinted per instance) ----------
  const cyl = (r1, r2, len, x, y = 0, z = 0, seg = 6) => new THREE.CylinderGeometry(r1, r2, len, seg).rotateZ(-Math.PI / 2).translate(x, y, z)
  const flat = (pts, t, y) => new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b))), { depth: t, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y, 0)
  const fin = (pts, t = 0.5) => new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([a, b]) => new THREE.Vector2(a, b))), { depth: t, bevelEnabled: false }).translate(0, 0, -t / 2)
  const box = (sx, sy, sz, x, y, z) => new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z)
  const BODY = 0xf3f4f1, GREY = 0x9aa3ab, DARK = 0x4a5056, L = null // L = livery
  const sym = (half) => [...half, ...half.slice().reverse().map(([x, y]) => [x, -y])]
  const KINDS = {
    jet: [40, [[cyl(2, 2, 30, 0), BODY], [cyl(0.5, 2, 5, 17.5), BODY], [cyl(2, 0.5, 6, -18, 0.3), BODY],
      [flat(sym([[3, 1.8], [-3, 17], [-5.5, 17], [-5, 1.8]]), 0.5, -1.2), BODY],
      [flat(sym([[-14, 1], [-17, 6.5], [-18.5, 6.5], [-18.5, 1]]), 0.4, 0.6), BODY],
      [fin([[-14, 1.2], [-20, 1.2], [-21, 10], [-17.5, 10]]), L], [cyl(1.1, 1.1, 4.5, 2, -2, 6), GREY], [cyl(1.1, 1.1, 4.5, 2, -2, -6), GREY]]],
    prop: [33, [[cyl(1.4, 1.4, 24, 0), BODY], [cyl(0.3, 1.4, 4, 14), BODY], [cyl(1.4, 0.5, 5, -14.5, 0.3), BODY],
      [flat([[2.2, -14], [-0.6, -14], [-0.6, 14], [2.2, 14]], 0.4, 1.2), BODY], [cyl(0.7, 0.7, 5, 2.5, 0.9, 4.2), BODY], [cyl(0.7, 0.7, 5, 2.5, 0.9, -4.2), BODY],
      [cyl(1.9, 1.9, 0.1, 5.1, 0.9, 4.2, 10), DARK], [cyl(1.9, 1.9, 0.1, 5.1, 0.9, -4.2, 10), DARK],
      [fin([[-11, 1.2], [-16, 1.2], [-17, 7.5], [-14.5, 7.5]]), L], [flat([[-14.3, -4.5], [-16.8, -4.5], [-16.8, 4.5], [-14.3, 4.5]], 0.3, 7.3), L]]],
    ga: [8.5, [[cyl(0.65, 0.65, 4, 0.5), BODY], [cyl(0.65, 0.3, 3, -3), BODY], [cyl(0.3, 0.65, 1, 3), BODY],
      [flat([[0.8, -5.5], [-0.7, -5.5], [-0.7, 5.5], [0.8, 5.5]], 0.15, 0.7), BODY], [fin([[-2.6, 0.3], [-4.2, 0.3], [-4.4, 1.9], [-3.6, 1.9]], 0.15), L],
      [flat([[-3.5, -1.7], [-4.3, -1.7], [-4.3, 1.7], [-3.5, 1.7]], 0.1, 0.2), L], [cyl(0.9, 0.9, 0.06, 3.55, 0, 0, 8), DARK]]],
    float: [10, [[cyl(0.75, 0.75, 4.5, 0.5), BODY], [cyl(0.75, 0.3, 3.5, -3.5), BODY], [cyl(0.4, 0.75, 1, 3.2), BODY],
      [flat([[1, -7.3], [-0.9, -7.3], [-0.9, 7.3], [1, 7.3]], 0.15, 0.8), L], [fin([[-3, 0.3], [-4.8, 0.3], [-5.1, 2.2], [-4.2, 2.2]], 0.15), L],
      [flat([[-4, -2.2], [-5, -2.2], [-5, 2.2], [-4, 2.2]], 0.1, 0.2), BODY], [cyl(1, 1, 0.06, 3.75, 0, 0, 8), DARK],
      [box(7, 0.55, 0.55, 0.3, -1.9, 1.2), L], [box(7, 0.55, 0.55, 0.3, -1.9, -1.2), L],
      [box(0.15, 1.3, 0.15, 1.5, -1.2, 1.2), GREY], [box(0.15, 1.3, 0.15, 1.5, -1.2, -1.2), GREY], [box(0.15, 1.3, 0.15, -1, -1.2, 1.2), GREY], [box(0.15, 1.3, 0.15, -1, -1.2, -1.2), GREY]]],
    heli: [12, [[new THREE.IcosahedronGeometry(1.5, 0).scale(1.6, 1, 1.05), L], [cyl(0.35, 0.18, 6, -4.6, 0.4), L], [fin([[-6.8, 0.3], [-7.6, 0.3], [-7.9, 2], [-7.3, 2]], 0.15), L],
      [box(10.8, 0.08, 0.35, 0, 1.8, 0), DARK], [box(0.35, 0.08, 10.8, 0, 1.8, 0), DARK], [box(0.3, 0.5, 0.3, 0, 1.5, 0), DARK],
      [box(3.4, 0.12, 0.14, 0, -1.55, 0.9), GREY], [box(3.4, 0.12, 0.14, 0, -1.55, -0.9), GREY]]],
  }
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
  mat.onBeforeCompile = (s) => { // the instance colour tints only the livery parts
    s.vertexShader = s.vertexShader.replace('#include <color_pars_vertex>', '#include <color_pars_vertex>\nattribute float accent;')
      .replace('#include <color_vertex>', THREE.ShaderChunk.color_vertex.replace('vColor.xyz *= instanceColor.xyz;', 'vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, accent);'))
  }
  const meshes = {}, sizes = {}
  for (const k in KINDS) {
    const [len, parts] = KINDS[k], P = [], C = [], A = [], c = new THREE.Color()
    for (const [g0, col] of parts) {
      const g = g0.index ? g0.toNonIndexed() : g0, p = g.attributes.position.array
      c.set(col ?? 0xffffff)
      for (let i = 0; i < p.length; i += 3) { P.push(p[i], p[i + 1], p[i + 2]); C.push(c.r, c.g, c.b); A.push(col === L ? 1 : 0) }
      g.dispose(); g0.dispose()
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3))
    geo.setAttribute('accent', new THREE.Float32BufferAttribute(A, 1))
    geo.computeVertexNormals()
    const m = new THREE.InstancedMesh(geo, mat, MAX)
    m.name = 'planes-' + k
    m.count = 0
    m.castShadow = true
    m.frustumCulled = false
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    m.setColorAt(0, c.set(0xffffff))
    city.scene.add(m)
    meshes[k] = m
    sizes[k] = len
  }
  // where it is over the ground: a faint cross at the foot of a drop line, in the overlay (the sun casts the real shadow)
  const shadowGeo = new THREE.BufferGeometry().setFromPoints([[0.5, 0.05], [-0.5, 0.05], [-0.5, -0.05], [0.5, -0.05], [0.12, 0.5], [-0.05, 0.5], [-0.05, -0.5], [0.12, -0.5]].map(([x, z]) => new THREE.Vector3(x, 0, z)))
  shadowGeo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
  const shadows = new THREE.InstancedMesh(shadowGeo, new THREE.MeshBasicMaterial({ color: 0x0b1016, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }), MAX)
  shadows.count = 0
  shadows.frustumCulled = false
  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 6), 3).setUsage(THREE.DynamicDrawUsage))
  lineGeo.setDrawRange(0, 0)
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }))
  lines.frustumCulled = false
  city.overlay.add(shadows, lines)

  // ---------- aircraft state ----------
  const planes = new Map() // hex → state
  function ingest(list) {
    const now = Date.now() / 1000, seen = new Set()
    for (const a of list) {
      if (a.lat == null || a.lon == null) continue
      seen.add(a.id)
      const v = city.world.fromLatLon(a.lat, a.lon)
      let p = planes.get(a.id)
      const fresh = !p
      if (p) { const d = draw(p, now); p.cx = d.x; p.cz = d.z; p.calt = d.alt; p.h0 = d.h } // drawn here now: ease from it
      p = Object.assign(p || { tu: 0 }, a, { x: v.x, z: v.z, t0: now - a.age, kind: kindOf(a) })
      if (fresh) { const d = draw(p, now); p.cx = d.x; p.cz = d.z; p.calt = d.alt; p.h0 = p.trk }
      p.tu = now
      planes.set(a.id, p)
      p.colour = livery(p)
    }
    for (const id of planes.keys()) if (!seen.has(id)) planes.delete(id)
  }
  const D = { x: 0, z: 0, alt: 0, h: 0 }
  function draw(p, t) { // dead-reckoned position at time t (≤ 30 s ahead of the last report), plus the eased correction
    const dt = Math.min(30, Math.max(0, t - p.t0)), sp = p.ground && p.gs < 1 ? 0 : p.gs
    let x = p.x + Math.sin(p.trk) * sp * dt, z = p.z - Math.cos(p.trk) * sp * dt, alt = p.ground ? 0 : Math.max(0, p.alt + p.vr * dt)
    const e = Math.exp(-(t - p.tu) / 1.5)
    if (p.tu) { x += (p.cx - x) * e; z += (p.cz - z) * e; alt += (p.calt - alt) * e }
    const k = Math.min(1, (t - p.tu) / 2)
    D.x = x; D.z = z; D.alt = alt; D.h = p.h0 + wrap(p.trk - p.h0) * k
    return D
  }

  // ---------- drawing ----------
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(0, 0, 0, 'YZX'), PV = new THREE.Vector3(), S = new THREE.Vector3(), col = new THREE.Color()
  const screen = [] // [id, x, y, z] of what was drawn, for the hover labels
  let anyMoving = false
  function update() {
    const t = Date.now() / 1000, zoom = city.view.zoom, b = city.view.bounds, n = {}
    for (const k in meshes) n[k] = 0
    let ns = 0, nl = 0
    const lp = lineGeo.attributes.position.array
    anyMoving = false
    screen.length = 0
    for (const [id, p] of planes) {
      const d = draw(p, t), g = city.world.heightAt(d.x, d.z), air = !p.ground
      const y = g + (air ? H * (1 - Math.exp(-d.alt / H)) : 0.5)
      const len = sizes[p.kind] * p.size
      const s = Math.min(air ? 8 : 2, Math.max(1, 30 / (len * 6 * zoom))) * p.size // stay ~30 px long when zoomed out
      const i = n[p.kind]++
      if (i >= MAX) continue
      E.set(air ? p.roll || 0 : 0, Math.PI / 2 - d.h, air ? Math.atan2(p.vr, Math.max(30, p.gs)) : 0)
      meshes[p.kind].setMatrixAt(i, M.compose(PV.set(d.x, y, d.z), Q.setFromEuler(E), S.setScalar(s)))
      meshes[p.kind].setColorAt(i, col.set(p.colour))
      if (air) {
        shadows.setMatrixAt(ns++, M.compose(PV.set(d.x, g + 0.6, d.z), Q.setFromEuler(E.set(0, Math.PI / 2 - d.h, 0)), S.set(sizes[p.kind] * s * 0.6, 1, sizes[p.kind] * s * 0.6)))
        lp.set([d.x, g, d.z, d.x, y - 2 * s, d.z], nl * 6); nl++
      }
      screen.push([id, d.x, y, d.z])
      const ze = d.z - 1.732 * (y - g) // where it shows on screen, in ground terms
      if (p.gs > 1 && d.x > b.x0 - 500 && d.x < b.x1 + 500 && ((ze > b.z0 - 500 && ze < b.z1 + 500) || (d.z > b.z0 && d.z < b.z1))) anyMoving = true
    }
    for (const k in meshes) { const m = meshes[k]; m.count = Math.min(MAX, n[k]); m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true }
    shadows.count = ns; shadows.instanceMatrix.needsUpdate = true
    lineGeo.setDrawRange(0, nl * 2); lineGeo.attributes.position.needsUpdate = true
    placeLabel()
  }

  // ---------- animation: only while a moving aircraft is on screen ----------
  let stop = null
  function check() {
    update()
    const want = anyMoving && !document.hidden
    if (want && !stop) stop = city.animate()
    else if (!want && stop) { stop(); stop = null }
    city.requestRender()
  }
  const offFrame = city.on('frame', () => { if (stop) update() })
  let viewT = 0
  const offView = city.on('view', () => { if (!viewT) viewT = setTimeout(() => { viewT = 0; if (!stop) check() }, 150) })

  // ---------- polling ----------
  const credit = city.ui.credit('Live aircraft: adsb.lol', SOURCES[0].href)
  let timer = 0, fails = 0, primaryDownUntil = 0, inflight = false, disposed = false
  async function poll() {
    timer = 0
    if (document.hidden || inflight || disposed) return
    inflight = true
    let ok = false
    for (const [i, src] of SOURCES.entries()) {
      if (i === 0 && Date.now() < primaryDownUntil) continue
      try {
        const r = await fetch(src.url, { cache: 'no-store' })
        if (!r.ok) throw new Error(`${src.name}: HTTP ${r.status}`)
        ingest(src.parse(await r.json()))
        credit.set(`✈ ${planes.size} live aircraft: ${src.name}`, src.href)
        ok = true
        break
      } catch (e) {
        if (i === 0) primaryDownUntil = Date.now() + 300000 // try the fallback for 5 minutes
        console.warn('planes:', e.message || e)
      }
    }
    inflight = false
    if (disposed) return
    fails = ok ? 0 : fails + 1
    if (!ok) credit.set('Live aircraft: offline, retrying', SOURCES[0].href)
    check()
    timer = setTimeout(poll, ok ? (anyMoving ? FAST : SLOW) : Math.min(MAX_BACKOFF, 15000 * 2 ** (fails - 1)))
  }
  function onVisibility() {
    if (document.hidden) { clearTimeout(timer); timer = 0; check() } else if (!timer && !inflight) poll()
  }
  document.addEventListener('visibilitychange', onVisibility)
  poll()

  // ---------- hover / tap labels ----------
  const label = document.createElement('div')
  label.className = 'panel'
  Object.assign(label.style, { padding: '3px 8px', fontSize: '11.5px', pointerEvents: 'none', zIndex: 15, transform: 'translate(-50%, calc(-100% - 12px))', whiteSpace: 'nowrap' })
  label.hidden = true
  document.body.append(label)
  let picked = null, pickedUntil = 0
  const pv = new THREE.Vector3()
  function toScreen(x, y, z) { pv.set(x, y, z).project(city.camera); const r = city.canvas.getBoundingClientRect(); return [r.left + ((pv.x + 1) / 2) * r.width, r.top + ((1 - pv.y) / 2) * r.height] }
  function nearest(cx, cy) {
    let best = null, bd = 22 * 22
    for (const [id, x, y, z] of screen) { const [sx, sy] = toScreen(x, y, z), d = (sx - cx) ** 2 + (sy - cy) ** 2; if (d < bd) { bd = d; best = id } }
    return best
  }
  function placeLabel() {
    const p = picked && planes.get(picked), e = p && screen.find((s) => s[0] === picked)
    if (!e || (pickedUntil && Date.now() > pickedUntil)) { label.hidden = true; if (!p) picked = null; return }
    const [sx, sy] = toScreen(e[1], e[2], e[3])
    label.textContent = [p.cs || p.reg || p.id, p.type, p.ground ? 'on the ground' : `${Math.round(p.alt / 0.3048 / 100) * 100} ft`, `${Math.round(p.gs / 0.5144)} kt`].filter(Boolean).join(' · ')
    label.style.left = `${sx}px`; label.style.top = `${sy}px`
    label.hidden = false
  }
  let downAt = null
  const onMove = (e) => { if (e.pointerType === 'mouse' && !e.buttons) { picked = nearest(e.clientX, e.clientY); pickedUntil = 0; placeLabel() } }
  const onDown = (e) => { downAt = [e.clientX, e.clientY] }
  const onUp = (e) => { // a tap (not a drag) picks the nearest aircraft for a few seconds
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return
    picked = nearest(e.clientX, e.clientY); pickedUntil = e.pointerType === 'mouse' ? 0 : Date.now() + 6000; placeLabel()
  }
  city.canvas.addEventListener('pointermove', onMove, { passive: true })
  city.canvas.addEventListener('pointerdown', onDown, { passive: true })
  city.canvas.addEventListener('pointerup', onUp, { passive: true })

  return {
    dispose() {
      disposed = true
      clearTimeout(timer); clearTimeout(viewT); offFrame(); offView(); stop?.()
      document.removeEventListener('visibilitychange', onVisibility)
      city.canvas.removeEventListener('pointermove', onMove); city.canvas.removeEventListener('pointerdown', onDown); city.canvas.removeEventListener('pointerup', onUp)
      for (const m of [...Object.values(meshes), shadows, lines]) { m.removeFromParent(); m.geometry.dispose() }
      mat.dispose(); shadows.material.dispose(); lines.material.dispose()
      label.remove(); credit.remove()
      city.requestRender()
    },
  }
}

const rad = (d) => ((d || 0) * Math.PI) / 180
const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0 }

function kindOf({ type = '', cat = '' }) {
  if (cat === 'A7' || HELI.test(type)) return 'heli'
  if (FLOAT.test(type)) return 'float'
  if (PROP.test(type)) return 'prop'
  if (cat === 'A1' || GA.test(type)) return 'ga'
  if (!type && (cat === 'B1' || cat === 'B4')) return 'ga' // gliders, ultralights
  return 'jet'
}
function livery(p) {
  const pre = /^[A-Z]{3}\d/.test(p.cs || '') ? p.cs.slice(0, 3) : ''
  if (LIVERY[pre]) return LIVERY[pre]
  if (p.kind === 'jet' || p.kind === 'prop') return pre ? 0xaab4be : 0x7d8a99
  return GA_COLOURS[hash(p.id) % GA_COLOURS.length]
}

// adsb.lol / ADSBExchange v2: { ac: [{ hex, flight, t, r, category, alt_baro ('ground' | ft), alt_geom, gs (kt), track, roll, baro_rate, geom_rate (ft/min), lat, lon, seen_pos }] }
function parseAdsbLol(j) {
  return (j.ac || []).map((a) => {
    const ground = a.alt_baro === 'ground', ft = ground ? 0 : (a.alt_geom ?? a.alt_baro ?? 0)
    return { id: a.hex, cs: (a.flight || '').trim(), reg: a.r, type: a.t || '', cat: a.category || '', ground, alt: ft * 0.3048, gs: (a.gs || 0) * 0.5144,
      trk: rad(a.track ?? a.true_heading ?? a.mag_heading), vr: ((a.geom_rate ?? a.baro_rate ?? 0) * 0.3048) / 60, roll: rad(a.roll),
      lat: a.lat, lon: a.lon, age: Math.min(30, a.seen_pos ?? a.seen ?? 0), size: SIZE[a.category] || 1 }
  })
}
const SIZE = { A1: 1, A2: 0.8, A3: 1, A4: 1.2, A5: 1.6, A6: 0.6 } // jets: business jet … heavy
// OpenSky state vectors (extended=1): [icao24, callsign, country, time_position, last_contact, lon, lat, baro_alt (m),
// on_ground, velocity (m/s), true_track, vertical_rate (m/s), sensors, geo_alt (m), squawk, spi, source, category]
function parseOpenSky(j) {
  const CAT = { 2: 'A1', 3: 'A2', 4: 'A3', 5: 'A4', 6: 'A5', 7: 'A6', 8: 'A7', 9: 'B1', 12: 'B4' }
  return (j.states || []).map((s) => ({ id: s[0], cs: (s[1] || '').trim(), type: '', cat: CAT[s[17]] || '', ground: !!s[8], alt: s[13] ?? s[7] ?? 0,
    gs: s[9] || 0, trk: rad(s[10]), vr: s[11] || 0, roll: 0, lat: s[6], lon: s[5], age: Math.min(30, Math.max(0, (j.time || 0) - (s[3] || j.time || 0))),
    size: SIZE[CAT[s[17]]] || 1 }))
}
