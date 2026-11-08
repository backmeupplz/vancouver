// Things to do on the water, all optional: sights to sail past and collect (kept in localStorage), buoy races with
// best times, and now and then orcas or a seal. The next target gets a beacon (a tall glow, drawn over the fog) and
// the HUD's pill points at it. The sail plugin calls step() every frame and reads target() for the pill.
const SIGHTS = [ // name, lat, lon, how close counts (metres)
  ['Siwash Rock', 49.3135, -123.1555, 130], ['Lions Gate Bridge', 49.3150, -123.1385, 140], ['Brockton Point lighthouse', 49.3010, -123.1170, 160],
  ['Canada Place sails', 49.2888, -123.1111, 220], ['English Bay Beach', 49.2865, -123.1430, 230], ['Kitsilano Beach', 49.2765, -123.1550, 200],
  ['Burrard Bridge', 49.2755, -123.1375, 130], ['Granville Island', 49.2722, -123.1335, 160], ['Science World', 49.2733, -123.1037, 260],
]
const COURSES = [ // marks in order (lat, lon); a loop ends back at the first
  { id: 'eb', name: 'English Bay', marks: [[49.2830, -123.1500], [49.2870, -123.1650], [49.2800, -123.1750], [49.2760, -123.1600], [49.2830, -123.1500]] },
  { id: 'fc', name: 'False Creek', marks: [[49.2745, -123.1365], [49.2725, -123.1325], [49.2700, -123.1200], [49.2728, -123.1100], [49.2700, -123.1200], [49.2745, -123.1365]] },
  { id: 'bi', name: 'Burrard Inlet', marks: [[49.2925, -123.1100], [49.3010, -123.1170], [49.3150, -123.1385], [49.3110, -123.1530]] },
]
const MARK_R = 28 // metres: rounding a mark
const KEY = 'sail.goals'
import { kit, kitMaterial } from '../../core/kit.js'

export const fmtTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

export function makeGoals(THREE, city, { chime, popup }) {
  let saved = { found: [], best: {} }
  try { Object.assign(saved, JSON.parse(localStorage.getItem(KEY)) || {}) } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)) } catch {} }
  const at = (la, lo) => { const p = city.world.fromLatLon(la, lo); return { x: p.x, z: p.z } }
  const sights = SIGHTS.map(([name, la, lo, r]) => ({ name, r, ...at(la, lo) }))
  const courses = COURSES.map((c) => ({ ...c, pts: c.marks.map(([la, lo]) => at(la, lo)) }))

  const group = new THREE.Group() // buoys (in the scene: outlines, lit) and sea life
  const fx = new THREE.Group() // beacons (overlay)
  // a race mark: an orange can buoy with a little flag
  const buoyGeo = (() => {
    const k = kit(THREE)
    k.c(0xf08a24).prism([-0.7, -0.4, 0.7, -0.4, 0.55, 0.9, -0.55, 0.9], -0.7, 0.7, { bevel: 0.08 })
    k.c(0xfbf6ea).box(-0.57, 0.57, 0.35, 0.6, -0.57, 0.57)
    k.c(0x3a3f45).rod([0, 0.9, 0], [0, 2.9, 0], 0.05, 0.05)
    k.c(0xf6d23c).box(0, 0.9, 2.2, 2.85, -0.03, 0.03)
    return k.geometry(true)
  })()
  const buoyMat = kitMaterial(THREE, undefined, false)
  const buoys = Array.from({ length: 6 }, () => { const m = new THREE.Mesh(buoyGeo, buoyMat); m.visible = false; group.add(m); return m })
  // the beacon: a tall soft column of light over the next target, and a ring on the water
  const beaconMat = new THREE.ShaderMaterial({
    uniforms: { uCol: { value: new THREE.Color(0xffd27a) }, uT: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uCol; uniform float uT; varying vec2 vUv;
      void main() { float a = (1.0 - vUv.y) * (0.55 + 0.45 * sin(vUv.y * 18.0 - uT * 3.0) * 0.3) * (0.5 + 0.5 * sin(vUv.x * 6.2832 * 2.0) * 0.2);
        gl_FragColor = vec4(uCol, a * 0.55); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,
  })
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 90, 16, 1, true).translate(0, 45, 0), beaconMat)
  beacon.visible = false; beacon.frustumCulled = false; fx.add(beacon)

  // sea life: an orca's back and fin, or a seal's head, surfacing a few times and gone
  const life = (() => {
    const k = kit(THREE)
    k.c(0x1c2026).prism([-2.6, 0, -1.8, 0.45, 0, 0.6, 1.8, 0.4, 2.6, 0], -0.55, 0.55, { bevel: 0.1 }) // the back
    k.c(0x1c2026).prism([-0.6, 0.45, 0.25, 2.2, 0.55, 2.15, 0.5, 0.45], -0.07, 0.07) // the fin
    k.c(0xf4f2ee).box(-1.6, -1.0, 0.1, 0.32, -0.5, 0.5, 0.7) // the saddle patch
    k.rot(0, 'y', Math.PI / 2)
    const g = k.geometry(true)
    const ks = kit(THREE)
    ks.c(0x5a5650).prism([-0.25, -0.1, 0.25, -0.1, 0.3, 0.25, 0.1, 0.42, -0.2, 0.38, -0.3, 0.2], -0.22, 0.22, { bevel: 0.06 })
    ks.c(0x1e1c1a).box(0.12, 0.16, 0.25, 0.31, -0.12, 0.12)
    ks.rot(0, 'y', Math.PI / 2)
    const gs = ks.geometry(true)
    const mat = kitMaterial(THREE, undefined, false)
    const orcas = [new THREE.Mesh(g, mat), new THREE.Mesh(g, mat)], seal = new THREE.Mesh(gs, mat)
    for (const m of [...orcas, seal]) { m.visible = false; group.add(m) }
    return { orcas, seal, kind: null, t: 0, x: 0, z: 0, h: 0, next: 40 + Math.random() * 40, seen: { orca: false, seal: false } }
  })()

  const S = { mode: 'explore', race: null, show: true, beaconAt: null }
  let tAt = 0

  // the next sight not yet found, nearest first
  function nextSight(x, z) {
    let best = null, bd = Infinity
    for (const s of sights) { if (saved.found.includes(s.name)) continue; const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = s } }
    return best
  }
  function startRace(id) {
    const c = courses.find((q) => q.id === id)
    if (!c) return null
    S.mode = 'race'; S.race = { c, next: 0, t0: 0, t: 0, started: false }
    for (let i = 0; i < buoys.length; i++) { const b = buoys[i], p = c.pts[i]; b.visible = !!p && !(i === c.pts.length - 1 && dist(p, c.pts[0]) < 5); if (p) b.position.set(p.x, 0, p.z) }
    // set off 70 m before the start mark, heading for it
    const a = c.pts[0], b = c.pts[1], dx = a.x - b.x, dz = a.z - b.z, l = Math.hypot(dx, dz) || 1
    return { x: a.x + (dx / l) * 70, z: a.z + (dz / l) * 70, h: Math.atan2(-dx, -dz) }
  }
  function quitRace() { S.mode = 'explore'; S.race = null; for (const b of buoys) b.visible = false }
  const dist = (p, q) => Math.hypot(p.x - q.x, p.z - q.z)

  // per frame: B the boat { x, y, z, h, speed }; sea(x, z) the water's height there; t seconds
  function step(dt, t, B, sea, wet) {
    beaconMat.uniforms.uT.value = t
    for (const b of buoys) if (b.visible) { const y = sea(b.position.x, b.position.z); b.position.y = y; b.rotation.z = 0.1 * Math.sin(t * 1.3 + b.position.x) }
    let tgt = null
    if (S.mode === 'race' && S.race) {
      const R = S.race, c = R.c, p = c.pts[R.next]
      if (R.started) R.t = t - R.t0
      if (Math.hypot(p.x - B.x, p.z - B.z) < MARK_R) {
        if (!R.started) { R.started = true; R.t0 = t; R.t = 0; popup('Go!'); chime(0) }
        else if (R.next === c.pts.length - 1) {
          const best = saved.best[c.id], tm = R.t
          if (!best || tm < best) { saved.best[c.id] = +tm.toFixed(1); save() }
          popup(`Finished ${fmtTime(tm)}${!best || tm < best ? ' · best!' : ''}`); chime(2)
          quitRace()
          return finishLife(dt, t, B, sea, wet)
        } else { popup(`Mark ${R.next} of ${c.pts.length - 1}`); chime(1) }
        R.next++
      }
      if (S.race) tgt = { kind: 'race', x: c.pts[R.next].x, z: c.pts[R.next].z, name: !R.started ? `Start: ${c.name}` : R.next === c.pts.length - 1 ? 'Finish' : `Mark ${R.next} of ${c.pts.length - 1}`, time: R.started ? R.t : null }
    } else {
      // sights: found when close (any mode); the beacon on the nearest one left
      for (const s of sights) if (!saved.found.includes(s.name) && Math.hypot(s.x - B.x, s.z - B.z) < s.r) {
        saved.found.push(s.name); save(); chime(2)
        popup(`★ ${s.name} · ${saved.found.length} of ${sights.length}`)
      }
      const s = S.show && nextSight(B.x, B.z)
      if (s) tgt = { kind: 'sight', x: s.x, z: s.z, name: s.name }
    }
    if (tgt) {
      beacon.visible = true; beacon.position.set(tgt.x, sea(tgt.x, tgt.z) - 1, tgt.z)
      beaconMat.uniforms.uCol.value.setHex(tgt.kind === 'race' ? 0xff9a4a : 0xffd27a)
    } else beacon.visible = false
    tAt = tgt
    return finishLife(dt, t, B, sea, wet)
  }

  // ---------------------------------------------------------------- orcas and seals
  function finishLife(dt, t, B, sea, wet) {
    const L = life
    if (!L.kind) {
      L.next -= dt
      if (L.next > 0 || B.speed < 0.5) return tAt
      // ahead and off to one side, on open water
      const side = Math.random() < 0.5 ? -1 : 1, fx = Math.sin(B.h), fz = Math.cos(B.h), d = 45 + Math.random() * 40, off = side * (18 + Math.random() * 25)
      const x = B.x + fx * d - fz * off, z = B.z + fz * d + fx * off
      if (!wet(x, z) || !wet(x + 30, z) || !wet(x - 30, z) || !wet(x, z + 30) || !wet(x, z - 30)) { L.next = 5; return tAt }
      L.kind = Math.random() < 0.55 ? 'orca' : 'seal'; L.t = 0; L.x = x; L.z = z; L.h = B.h + side * (0.6 + Math.random() * 0.6)
      if (!L.seen[L.kind]) { L.seen[L.kind] = true; popup(L.kind === 'orca' ? 'Orcas!' : 'A seal says hello') }
    }
    L.t += dt
    if (L.kind === 'orca') { // two of them, rolling up and down every few seconds, swimming along
      const life = 16
      for (let i = 0; i < 2; i++) {
        const o = L.orcas[i], ph = (L.t - i * 0.7) / 3.2, sx = L.x + Math.sin(L.h) * L.t * 3.5 + Math.cos(L.h) * i * 6, sz = L.z + Math.cos(L.h) * L.t * 3.5 - Math.sin(L.h) * i * 6
        const up = Math.sin((ph % 1) * Math.PI)
        o.visible = ph > 0 && L.t < life
        o.position.set(sx, sea(sx, sz) - 2.2 + 2.2 * Math.max(0, up) * (ph % 1 < 0.5 ? 1 : 1), sz)
        o.rotation.set(0, L.h, 0); o.rotateX(0.35 * Math.cos((ph % 1) * Math.PI))
      }
      if (L.t > life) { L.kind = null; L.next = 60 + Math.random() * 90; for (const o of L.orcas) o.visible = false }
    } else if (L.kind === 'seal') { // a head bobbing, looking at you, then a dive
      const life = 14, s = L.seal
      s.visible = L.t < life
      const k = Math.min(1, L.t / 1.5, (life - L.t) / 1.2)
      s.position.set(L.x, sea(L.x, L.z) - 0.45 + 0.4 * k + 0.05 * Math.sin(L.t * 2), L.z)
      s.rotation.set(0, Math.atan2(B.x - L.x, B.z - L.z) + Math.PI / 2, 0)
      if (L.t > life) { L.kind = null; L.next = 60 + Math.random() * 90; s.visible = false }
    }
    return tAt
  }

  return {
    group, fx, sights, courses, S, startRace, quitRace, step,
    get found() { return saved.found.length },
    has: (name) => saved.found.includes(name),
    best: (id) => saved.best[id],
    hide() { beacon.visible = false; for (const o of [...life.orcas, life.seal]) o.visible = false; life.kind = null },
    dispose() { buoyGeo.dispose(); buoyMat.dispose(); beacon.geometry.dispose(); beaconMat.dispose(); life.orcas[0].geometry.dispose(); life.seal.geometry.dispose(); life.seal.material.dispose() },
  }
}
