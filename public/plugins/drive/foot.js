// Things to do on foot (the drive plugin's walk and hike modes call in here; the walking itself stays in index.js):
// - a photo walk: P (or the camera button) lifts the camera to the eye; frame a real landmark and snap it for points,
//   best shot kept per landmark; the job card points at the nearest one not yet shot
// - sitting down (C) on what is there: a free seat of a bench (the life plugin's city.traffic.benches), a driftwood
//   log (core/tiles.js logsNear), steps, the edge of a wall or the seawall with the legs over it, else cross-legged
//   on the ground; the button says which. The camera settles to one side; on a beach it counts the beach, more at
//   golden hour
// - petting a dog (G) that walks by with its owner (city.traffic.dogs): each dog once a day, a `pet` for city.progress
// - hikes: quarter marks with split times against your best (and a second wind), a medal for the time at the top,
//   and now and then a deer or a raccoon by the trail to spot
// - footsteps that sound of what is underfoot (paving, grass, sand, a wooden deck; wetter in the rain), a hop (Space)
// Kept in localStorage ('drive.foot'); points go to city.progress when it is there.
import { kit, kitMaterial } from '../../core/kit.js'
import { clamp, wrap } from '../../core/util.js'
import { noise, tone } from '../../core/play.js'
import { sitWalker } from './walker.js'

// name, lat, lon, height (m, where to aim), from how far it counts (m); tall ones show over the roofs
const SHOTS = [
  ['Science World', 49.27341, -123.10365, 40, 450], ['BC Place', 49.27671, -123.11213, 55, 550], ['Rogers Arena', 49.2779, -123.10905, 30, 350],
  ['Canada Place', 49.28875, -123.11061, 40, 450], ['Harbour Centre', 49.28472, -123.11206, 150, 800], ['Hotel Vancouver', 49.28374, -123.12119, 100, 450],
  ['Marine Building', 49.2875, -123.11709, 90, 350], ['Vancouver House', 49.27487, -123.13096, 150, 700], ['Shangri-La', 49.28572, -123.12388, 190, 800],
  ['Granville Island Market', 49.27223, -123.13505, 12, 220], ['Giants silos', 49.2716, -123.13314, 20, 280], ['Olympic Cauldron', 49.289361, -123.11766, 10, 180],
  ['Gastown Steam Clock', 49.284384, -123.10889, 5, 110], ['Lions Gate Bridge', 49.31777, -123.136421, 110, 1500], ['Burrard Bridge', 49.274958, -123.138555, 35, 600],
] // (the ones the landmarks plugin models: something to see in the frame)
const BEACHES = [['English Bay Beach', 49.2866, -123.1432], ['Sunset Beach', 49.2800, -123.1385], ['Second Beach', 49.2955, -123.1512], ['Third Beach', 49.3030, -123.1575],
  ['Kitsilano Beach', 49.2748, -123.1535], ['Jericho Beach', 49.2725, -123.1930], ['Locarno Beach', 49.2760, -123.2080], ['Spanish Banks', 49.2770, -123.2230], ['Wreck Beach', 49.2622, -123.2617]]
// a hike's length (m) and climb (m): its par is walking it without a stop
const TRAILS = { grind: [2900, 850], quarry: [1800, 100], lynn: [600, 30], siwash: [700, 0], wreck: [500, 0], lighthouse: [700, 0], dog: [2500, 120], seawall: [3300, 0] }
const MEDALS = [['🥇', 0.8], ['🥈', 0.92], ['🥉', 1.1]] // icon, times the par
const WILD = { grind: 'deer', quarry: 'deer', lynn: 'deer', dog: 'deer' } // the rest: raccoons
const KEY = 'drive.foot', NONE = []
const today = () => Math.floor((Date.now() / 1000 - 8 * 3600) / 86400) // the progress plugin's day (midnight PST)
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// a footstep by what is underfoot: a burst of noise through [filter, Hz, Q], seconds long, how loud
const STEPS = { path: ['bandpass', 1500, 1.2, 0.05, 0.05], grass: ['lowpass', 700, 0.5, 0.11, 0.04], sand: ['lowpass', 1100, 0.3, 0.17, 0.045], wood: ['bandpass', 480, 2, 0.07, 0.06] }

// api: { man, walker, popup(big, line), sfx, audio() (the game's sound output, or null), pathAt(x, y) (the nearest path or street: { d, drv, steps }),
//   chase, orbit (the drive plugin's camera orbit and its input), yawOf(dx, dy) (the yaw facing that way), wallHit(x0, y0, x1, y1), wet(x, y), fwdX, fwdY, flash(), hikeSpeed (m/s) }
export function makeFoot(THREE, city, api) {
  const { man } = api
  let saved = { shots: {}, beaches: [], wild: 0, splits: {}, best: {}, stages: {}, reach: {}, pets: { day: 0, ids: [] } }
  try { Object.assign(saved, JSON.parse(localStorage.getItem(KEY)) || {}) } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)) } catch {} }
  const award = (kind, n, meta) => { try { city.progress?.award(kind, n, meta) } catch (e) { console.warn('foot: progress', e) } }
  const at = (la, lo) => { const p = city.world.fromLatLon(la, lo); return { x: p.x, y: -p.z } } // (x, north), as the drive plugin
  const shots = SHOTS.map(([name, la, lo, h, r]) => ({ name, h, r, ...at(la, lo) }))
  const beaches = BEACHES.map(([name, la, lo]) => ({ name, ...at(la, lo) }))

  // ---------------------------------------------------------------- the buttons (touch and mouse)
  const css = document.createElement('style')
  css.textContent = `.ft-btns { position: fixed; left: 12px; bottom: 170px; z-index: 6; display: flex; flex-direction: column; gap: 8px; }
    .ft-btns button { font: 600 13px system-ui, sans-serif; min-width: 46px; height: 46px; padding: 0 10px; border-radius: 23px; border: 1px solid rgba(255,255,255,.25); background: rgba(24,20,18,.72); color: #fff; backdrop-filter: blur(8px); cursor: pointer; touch-action: manipulation; }
    .ft-btns button.on { background: #f2a07e; color: #2a1c14; }
    .ft-btns[hidden], .ft-frame[hidden] { display: none; }
    .ft-frame { position: fixed; inset: 112px 5% 196px; z-index: 5; pointer-events: none; border: 2px solid rgba(255,255,255,.75); border-radius: 6px; box-shadow: 0 0 0 100vmax rgba(0,0,0,.28); }
    .ft-frame::after { content: attr(data-t); position: absolute; left: 0; right: 0; bottom: 8px; text-align: center; color: #fff; font: 600 13px system-ui, sans-serif; text-shadow: 0 1px 3px #000; }
    @media (max-height: 600px) { .ft-frame { inset: 92px 5% 56px; } }
    @media (min-width: 720px) { .ft-btns { bottom: 96px; } .ft-frame { inset: 9% 8%; } }
    @media (max-height: 420px) { body:not(.dlv-touchy) .ft-btns { bottom: 96px; } }` // (the 360 px embed with a keyboard: under the photo walk's card)
  const btns = document.createElement('div'); btns.className = 'ft-btns'; btns.hidden = true
  btns.innerHTML = '<button data-f="photo" aria-label="Camera" title="Camera: frame a landmark (P)">📷</button><button data-f="sit" aria-label="Sit down" title="Sit down a while (C)">Sit</button><button data-f="pet" title="Pet the dog (G)" hidden>🐶 Pet</button>'
  const frameEl = document.createElement('div'); frameEl.className = 'ft-frame'; frameEl.hidden = true
  document.head.append(css); document.body.append(btns, frameEl)
  const bPhoto = btns.querySelector('[data-f=photo]'), bSit = btns.querySelector('[data-f=sit]')
  const bPet = btns.querySelector('[data-f=pet]'); bPet.onclick = () => key('KeyG')
  bPhoto.onclick = () => (S.framing ? snap() : key('KeyP')); bSit.onclick = () => (S.framing ? key('KeyP') : key('KeyC'))

  // ---------------------------------------------------------------- wildlife
  const group = new THREE.Group(), mat = kitMaterial(THREE, undefined, false)
  const animal = (build) => { const k = kit(THREE); build(k); const m = new THREE.Mesh(k.geometry(true), mat); m.visible = false; group.add(m); return m }
  const models = {
    deer: animal((k) => {
      k.c(0x9a6b42).box(-0.55, 0.55, 0.75, 1.2, -0.2, 0.2).box(0.42, 0.62, 1.1, 1.58, -0.09, 0.09).box(0.5, 0.88, 1.5, 1.72, -0.1, 0.1)
      for (const [x, z] of [[-0.45, -0.13], [-0.45, 0.13], [0.45, -0.13], [0.45, 0.13]]) k.box(x - 0.05, x + 0.05, 0, 0.78, z - 0.045, z + 0.045)
      k.box(0.52, 0.6, 1.72, 1.9, -0.14, -0.08).box(0.52, 0.6, 1.72, 1.9, 0.08, 0.14) // ears
      k.c(0xf4efe4).box(-0.63, -0.55, 1.0, 1.2, -0.07, 0.07).c(0x2a2420).box(0.86, 0.9, 1.55, 1.63, -0.05, 0.05)
    }),
    raccoon: animal((k) => {
      k.c(0x77736c).box(-0.3, 0.3, 0.1, 0.4, -0.16, 0.16).box(0.24, 0.5, 0.24, 0.48, -0.13, 0.13).box(0.3, 0.36, 0.48, 0.56, -0.13, -0.07).box(0.3, 0.36, 0.48, 0.56, 0.07, 0.13)
      k.c(0x2c2a28).box(0.42, 0.51, 0.33, 0.41, -0.135, 0.135).box(-0.62, -0.5, 0.2, 0.34, -0.07, 0.07).box(-0.4, -0.3, 0.2, 0.34, -0.07, 0.07)
      k.c(0xcfcac0).box(-0.5, -0.4, 0.2, 0.34, -0.07, 0.07).box(0.5, 0.56, 0.3, 0.37, -0.05, 0.05)
    }),
  }
  const W = { m: null, x: 0, y: 0, a: 0, t: 0, flee: 0, seen: false, next: 20 }

  const S = { on: false, hike: null, framing: false, tilt: 0.08, sit: null, d0: 0, q: 0, mark: 0, splits: [], near: null, nearAt: 0 }
  const v = new THREE.Vector3()
  const ground = (x, y, d) => { const h = city.world.heightAt(x, -y); return Number.isFinite(h) && h !== 0 ? h : d }

  function setFraming(f) {
    S.framing = f; frameEl.hidden = !f; api.walker.visible = !f
    bPhoto.classList.toggle('on', f); bPhoto.textContent = f ? 'Snap' : '📷'; bSit.textContent = f ? '✕' : sitLabel()
    if (f) { S.sit = null; frameEl.dataset.t = 'Turn to frame a landmark, then Snap' }
  }
  // what is in the frame, best first: [shot, score]
  function inFrame(cam) {
    const out = []
    for (const L of shots) {
      const d = Math.hypot(L.x - man.x, L.y - man.y)
      if (d > L.r) continue
      v.set(L.x, ground(L.x, L.y, man.h) + L.h * 0.55, -L.y).project(cam)
      if (v.z > 1 || Math.abs(v.x) > 0.8 || Math.abs(v.y) > 0.85) continue
      // hidden behind a building on the way (not its own walls; a tower shows over the roofs)
      if (L.h < 60 && d > 80 && api.wallHit(man.x, man.y, L.x, L.y) * d < d - 70) continue
      out.push([L, Math.round(100 * (1 - 0.5 * Math.min(1, Math.hypot(v.x, v.y))) * (0.55 + 0.45 * clamp(1.4 - d / L.r, 0, 1)))])
    }
    return out.sort((a, b) => b[1] - a[1])
  }
  function snap() {
    api.sfx.shutter(); api.flash()
    const got = inFrame(S.cam)
    if (!got.length) { api.popup('Nothing famous in frame', S.near ? `${S.near.name} is ${Math.round(S.near.d / 10) * 10} m away: follow the arrow` : 'Walk on and look around'); return }
    const [L, pts] = got[0], prev = saved.shots[L.name] || 0, n = Object.keys(saved.shots).length + (prev ? 0 : 1)
    if (pts > prev) { saved.shots[L.name] = pts; save(); award('photo', pts - prev, { label: `Photo: ${L.name}` }) }
    api.popup(`${L.name} · ${pts} pts`, !prev ? `New! ${n} of ${shots.length} landmarks` : pts > prev ? `Your best shot of it (was ${prev})` : `Best ${prev}: get closer, centre it`)
  }
  // what is underfoot: a path or a street, a wooden deck (a pier, a boardwalk: a footway on a deck), sand, else grass
  function surface() {
    if (api.pierAt?.(man.x, man.y)) return 'wood'
    const r = api.pathAt(man.x, man.y)
    if (r && r.d < 1.8) return man.deck && !r.drv ? 'wood' : 'path'
    if (man.deck) return 'path'
    // ponytail: sand = low ground by a named beach; ask the tiles' own sand areas if core ever publishes them
    return man.h < 6 && beaches.some((b) => Math.hypot(b.x - man.x, b.y - man.y) < 320) ? 'sand' : 'grass'
  }
  let grain = null
  function step() {
    const dest = api.audio(); if (!dest) return
    const c = dest.context, t = c.currentTime, r = (S.stepN * 0.618) % 1, wet = city.surface?.wet > 0.3, kind = surface()
    grain ||= noise(c, 0.4)
    const burst = ([type, f, q, dur, vol]) => {
      const src = c.createBufferSource(), bq = c.createBiquadFilter(), g = c.createGain()
      src.buffer = grain; bq.type = type; bq.frequency.value = f * (0.85 + 0.3 * r); bq.Q.value = q
      g.gain.setValueAtTime(vol * (man.run ? 1.5 : 1), t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      src.connect(bq); bq.connect(g); g.connect(dest); src.start(t, r * 0.2, dur + 0.02)
    }
    burst(STEPS[kind])
    if (kind === 'wood') tone(dest, 95 + 30 * r, t, 0.09, 0.05)
    if (wet && kind !== 'sand') burst(['highpass', 2600, 0.5, 0.13, 0.03]) // a little splash
  }
  // ---------------------------------------------------------------- sitting on things
  // where to sit from here: { kind (walker.js sitWalker), label, x, y, yaw, h (the seat over its ground), base (that
  // ground's height) }; always something (the ground under the walker)
  const tB = [], tP = [], tL = [], tD = []
  function seatNear() {
    const T = city.traffic, fx = api.fwdX(man.yaw), fy = api.fwdY(man.yaw), feet = man.h - 0.05
    let best = null, bd = 2
    for (const b of T?.benches?.(man.x, -man.y, 3.5, tB) || NONE) for (const s of [-1, 1]) { // its two seats; not one someone is on
      const x = b.x + Math.cos(b.heading) * 0.45 * s, z = b.z - Math.sin(b.heading) * 0.45 * s, d = Math.hypot(x - man.x, -z - man.y)
      if (d < bd && !T.people(x, z, 0.4, tP).length) { bd = d; best = { kind: 'seat', label: 'the bench', x, y: -z, yaw: wrap(b.heading + Math.PI), h: 0.45, base: b.y } }
    }
    if (best) return best
    bd = 1.6
    for (const L of city.tiles?.logsNear?.(man.x, -man.y, 2, tL) || NONE) { // on top of it, facing down the beach
      if (L.dia < 0.22) continue
      const ax = Math.cos(L.angle), ay = Math.sin(L.angle), t = clamp((man.x - L.x) * ax + (man.y + L.z) * ay, -L.length / 2 + 0.3, L.length / 2 - 0.3)
      const x = L.x + ax * t, y = -L.z + ay * t, d = Math.hypot(x - man.x, y - man.y)
      if (d >= bd) continue
      const s = ground(x - ay * 3, y + ax * 3, 0) < ground(x + ay * 3, y - ax * 3, 0) ? 1 : -1
      bd = d; best = { kind: 'seat', label: 'the log', x, y, yaw: api.yawOf(-ay * s, ax * s), h: L.dia * 0.85, base: L.y }
    }
    if (best) return best
    const r = api.pathAt(man.x, man.y)
    if (r?.steps && r.d < 1.2) { // facing down them
      const s = ground(man.x + fx * 1.5, man.y + fy * 1.5, man.h) <= ground(man.x - fx * 1.5, man.y - fy * 1.5, man.h) ? 1 : -1
      return { kind: 'seat', label: 'the steps', x: man.x, y: man.y, yaw: api.yawOf(fx * s, fy * s), h: 0.17, base: feet }
    }
    for (let d = 0.3; d < 1.5; d += 0.15) { // a drop just ahead, or the water under a wall: on the edge, the legs over it
      const x = man.x + fx * d, y = man.y + fy * d
      if (ground(x, y, man.h) < man.h - 0.85 || (api.wet(x, y) && man.h > 1.2)) return { kind: 'edge', label: 'the edge', x: man.x + fx * (d - 0.4), y: man.y + fy * (d - 0.4), yaw: man.yaw, h: 0, base: feet }
    }
    // (off the paths the walker stands a little over the grass: sat, it is on it)
    return { kind: 'ground', label: '', x: man.x, y: man.y, yaw: man.yaw, h: 0, base: r && r.d < 1.8 || man.deck ? feet : Math.min(feet, ground(man.x, man.y, feet)) }
  }
  const sitLabel = () => (S.sit ? 'Get up' : S.seat?.label ? `Sit on ${S.seat.label}` : 'Sit')
  // sat: { k: 0 standing .. 1 sat (it moves to the seat and back to where it stood), dir, from, to, t, ... }
  function sit() {
    if (S.sit) { S.sit.dir = -1; return }
    const to = seatNear()
    S.sit = { t: 0, k: 0, dir: 1, done: false, to, from: { x: man.x, y: man.y, yaw: man.yaw, h: man.h }, look: 1 }
  }
  function sitStep(dt) {
    const T = S.sit, { from, to } = T
    T.k = clamp(T.k + (T.dir * dt) / 0.45, 0, 1)
    const e = T.k * T.k * (3 - 2 * T.k)
    man.x = from.x + (to.x - from.x) * e; man.y = from.y + (to.y - from.y) * e; man.h = from.h + (to.base + 0.05 - from.h) * e
    man.yaw = from.yaw + wrap(to.yaw - from.yaw) * e
    if (T.dir < 0 && T.k === 0) { S.sit = null; S.low = 0 }
  }

  // ---------------------------------------------------------------- dogs
  // a heart over a petted dog
  const heart = (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64
    const g = cv.getContext('2d'); g.font = '48px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('❤️', 32, 36)
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false }))
    m.scale.setScalar(0.45); m.visible = false; group.add(m)
    return m
  })()
  const petsToday = () => { if (saved.pets?.day !== today()) saved.pets = { day: today(), ids: [] }; return saved.pets.ids }
  const dogBy = (id) => { for (const d of city.traffic?.dogs?.(man.x, -man.y, 6, tD) || NONE) if (d.id === id) return d; return null }
  function dogNear() { // one in reach, not yet petted today
    const done = petsToday()
    let best = null, bd = 2
    for (const d of city.traffic?.dogs?.(man.x, -man.y, 3, tD) || NONE) { const q = Math.hypot(d.x - man.x, -d.z - man.y); if (q < bd && !done.includes(d.id)) { bd = q; best = d.id } }
    return best
  }
  function pet() {
    const id = dogNear(), d = id != null && dogBy(id); if (!d) return
    petsToday().push(id); save()
    city.traffic.knock?.(id, d.x - man.x, d.z + man.y, 0.5) // its walker stops a moment and turns to you
    S.pet = { t: 0, id, x: d.x, y: d.y, z: d.z }
    award('pet', 15, { label: `Good dog! ${saved.pets.ids.length} petted today` })
    const dest = api.audio(); if (dest) { const t = dest.context.currentTime + 0.45; tone(dest, 587, t, 0.1, 0.05, 'triangle'); tone(dest, 880, t + 0.11, 0.16, 0.05, 'triangle') } // a happy yip
  }
  function petStep(dt) {
    const P = S.pet, d = dogBy(P.id)
    if (d) { P.x = d.x; P.y = d.y; P.z = d.z }
    P.t += dt
    man.yaw += wrap(api.yawOf(P.x - man.x, -P.z - man.y) - man.yaw) * Math.min(1, dt * 10)
    const k = clamp((P.t - 0.45) / 0.9, 0, 1)
    heart.visible = k > 0 && k < 1; heart.position.set(P.x, P.y + 0.75 + k * 0.7, P.z); heart.material.opacity = Math.min(1, 3 * (1 - k)); heart.scale.setScalar(0.3 + 0.25 * Math.min(1, k * 4))
    if (P.t > 1.5) { S.pet = null; heart.visible = false; S.low = 0 }
  }
  function key(code) { // true: taken
    if (!S.on) return false
    if (code === 'Space' && !S.framing && !S.sit && !S.pet) { if (!man.air) man.air = 1e-3; return true }
    if (S.hike) return false
    if (code === 'KeyP') { setFraming(!S.framing); return true }
    if (S.framing && (code === 'Space' || code === 'Enter')) { snap(); return true }
    if (S.pet) return true
    if (code === 'KeyC' && !S.framing && Math.abs(man.speed) < 0.5) { sit(); return true }
    if (code === 'KeyG' && !S.framing && !S.sit && S.dog != null) { pet(); return true }
    return false
  }

  // ---------------------------------------------------------------- hikes
  function par(id) { const T = TRAILS[id]; return T ? (T[0] * (1 + 1.2 * (T[1] / T[0]))) / api.hikeSpeed : 0 }
  function hikeStep(H, now) {
    const d = Math.hypot(H.gx - man.x, H.gy - man.y)
    if (!S.d0) { S.d0 = d; S.q = 0; S.mark = 0; S.splits = [] }
    if (!H.t0 || H.done || H.stage != null) return // (a stage run is one stage: no quarter marks inside it)
    const f = 1 - d / S.d0
    if (S.q < 3 && f >= (S.q + 1) / 4) {
      const secs = (now - H.t0) / 1000, was = saved.splits[H.id]?.[S.q], diff = was ? secs - was : 0
      S.splits.push(+secs.toFixed(1)); S.q++
      stageDone(H.id, S.q - 1, secs - S.mark, S.q); S.mark = secs
      man.stamina = 1; man.winded = false
      api.popup(`${['¼', '½', '¾'][S.q - 1]} · ${mmss(secs)}`, `${was ? `${diff <= 0 ? '−' : '+'}${mmss(Math.abs(diff))} on your best · ` : ''}second wind!`)
      api.sfx.pickup(); award('hike.quarter', 20, { quiet: true })
    }
  }
  // stages: the trail's four quarters, each with its own best and medal (a quarter's par is a quarter of the trail's);
  // `reach` is the furthest stage a run can start at (one more than the last quarter mark crossed)
  const stagePar = (id) => par(id) / 4
  const canStage = (id) => par(id) > 420 // (a trail shorter than ~7 min is just a trail)
  function stageDone(id, k, secs, reach) {
    const b = (saved.stages[id] ||= [0, 0, 0, 0])
    if (secs > 5 && (!b[k] || secs < b[k])) b[k] = +secs.toFixed(1)
    saved.reach[id] = Math.max(saved.reach[id] || 0, Math.min(3, reach))
    save()
  }
  const medalOf = (secs, p) => (p && secs ? MEDALS.findIndex((q) => secs <= p * q[1]) : -1)
  // at the top: keeps the splits of a best time; returns a line for the photo card
  function summit(H, secs) {
    if (H.stage != null) { // the end of one stage
      const p = stagePar(H.id), m = medalOf(secs, p)
      stageDone(H.id, H.stage, secs, H.stage + 1)
      award('hike', 40 + (m >= 0 ? [100, 70, 40][m] : 0), { label: H.name })
      const nxt = m > 0 ? MEDALS[m - 1] : m < 0 && p ? MEDALS[2] : null
      return `${m >= 0 ? `${MEDALS[m][0]} ` : ''}${nxt ? `${nxt[0]} under ${mmss(p * nxt[1])}` : m === 0 ? 'Gold pace!' : ''}`
    }
    const p = par(H.id), m = p ? MEDALS.findIndex((q) => secs <= p * q[1]) : -1, best = saved.best[H.id]
    if (secs && (!best || secs < best)) { saved.best[H.id] = +secs.toFixed(1); saved.splits[H.id] = S.splits.slice(); save() }
    stageDone(H.id, 3, secs - S.mark, 3)
    award('hike', 150 + (m >= 0 ? [300, 200, 100][m] : 0), { label: H.name })
    const nxt = m > 0 ? MEDALS[m - 1] : m < 0 && p ? MEDALS[2] : null
    return `${m >= 0 ? `${MEDALS[m][0]} ` : ''}${nxt ? `${nxt[0]} under ${mmss(p * nxt[1])}` : m === 0 ? 'Gold pace!' : ''}`
  }
  function wild(dt) {
    const m = W.m
    if (!m) {
      if (Math.abs(man.speed) > 1) W.next -= dt
      if (W.next > 0) return
      W.next = 5
      const fx = api.fwdX(man.yaw), fy = api.fwdY(man.yaw), side = Math.random() < 0.5 ? -1 : 1, a = 22 + Math.random() * 10, o = side * (7 + Math.random() * 5)
      const x = man.x + fx * a + fy * o, y = man.y + fy * a - fx * o, h = city.world.heightAt(x, -y)
      if (!Number.isFinite(h) || api.wallHit(man.x, man.y, x, y) < 1 || api.wet(x, y)) return
      Object.assign(W, { m: models[WILD[S.hike.id] || 'raccoon'], x, y, a: Math.atan2(man.y - y, man.x - x), t: 0, flee: 0, seen: false })
      W.m.visible = true
      return
    }
    W.t += dt
    const d = Math.hypot(man.x - W.x, man.y - W.y)
    if (!W.seen && d < 24) {
      W.seen = true; saved.wild++; save()
      api.popup(m === models.deer ? 'A deer!' : 'A raccoon!', `Wildlife spotted · ${saved.wild}`); api.sfx.pickup()
      award('hike.wildlife', 30, { label: 'Wildlife spotted' })
    }
    if (!W.flee && d < 8) { W.flee = 0.01; W.a = Math.atan2(W.y - man.y, W.x - man.x) } // off it goes
    if (W.flee) { W.flee += dt; W.x += Math.cos(W.a) * 7 * dt; W.y += Math.sin(W.a) * 7 * dt }
    else W.a += wrap(Math.atan2(man.y - W.y, man.x - W.x) - W.a) * Math.min(1, dt * 2) // watching you
    m.position.set(W.x, ground(W.x, W.y, man.h) + (W.flee ? Math.abs(Math.sin(W.flee * 9)) * 0.35 : 0), -W.y)
    m.rotation.y = W.a
    if (W.flee > 3.5 || d > 90 || W.t > 60) { m.visible = false; W.m = null; W.next = 35 + Math.random() * 40 }
  }

  return {
    key, summit,
    get framing() { return S.framing },
    get low() { return (S.sit || S.pet) && S.low || 0 }, // how far the head is down (sat, crouched), for the camera
    // into walk or hike mode (hike: the drive plugin's hike object or null)
    start(hike) {
      S.on = true; S.hike = hike; S.d0 = 0; S.sit = null; W.next = 15 + Math.random() * 15
      city.scene.add(group); btns.hidden = !!hike
    },
    stop() {
      if (S.framing) setFraming(false)
      S.on = false; S.sit = null; btns.hidden = true
      if (W.m) { W.m.visible = false; W.m = null }
      city.scene.remove(group)
    },
    // the walk is held: framing a photo (the keys turn the camera) or sitting (a move key gets up)
    busy(I, dt) {
      if (S.sit && (I.up || I.down || I.steer)) S.sit.dir = -1
      if (S.sit) sitStep(dt)
      if (S.pet) petStep(dt)
      if (S.framing) man.yaw += I.steer * 1.1 * dt
      return S.framing || !!S.sit || !!S.pet
    },
    pose(w) { // after poseWalker: sat on its seat, or crouched to a dog
      const p = S.pet ? Math.sin(Math.PI * clamp(S.pet.t / 1.5, 0, 1)) : 0
      if (S.sit?.k > 0.5) S.low = sitWalker(w, S.sit.to.kind, S.sit.to.h)
      else if (p > 0.4) S.low = sitWalker(w, 'crouch')
      else if (S.sit || S.pet) S.low = 0
    },
    // each frame on foot, after the chase camera is set: cam may be taken over (the eye for a photo, a slow drift when sat)
    frame(dt, now, cam, hike, afoot) {
      S.hike = hike; S.cam = cam
      const n = Math.floor(man.phase / Math.PI)
      if (n !== S.stepN) { S.stepN = n; if (afoot && Math.abs(man.speed) > 0.3 && !man.air) step() }
      btns.hidden = !!hike || !afoot
      if (S.framing && !afoot) setFraming(false)
      if (afoot && now - (S.seatAt || 0) > 300) { // what is in reach: a seat (the Sit button names it), a dog to pet
        S.seatAt = now; S.seat = S.sit ? S.seat : seatNear(); S.dog = S.sit || S.pet || hike ? null : dogNear()
        const t = sitLabel(); if (!S.framing && bSit.textContent !== t) bSit.textContent = t
        bPet.hidden = S.dog == null
      }
      if (hike) { if (!hike.photo) { hikeStep(hike, now); wild(dt) } return }
      if (now - S.nearAt > 500) { // the nearest landmark not yet shot
        S.nearAt = now; S.near = null
        for (const L of shots) { if (saved.shots[L.name]) continue; const d = Math.hypot(L.x - man.x, L.y - man.y); if (!S.near || d < S.near.d) S.near = { name: L.name, x: L.x, y: L.y, d, r: L.r } }
      }
      const fx = api.fwdX(man.yaw), fy = api.fwdY(man.yaw)
      if (S.framing) {
        // the eye; it tilts by itself to the landmark in front
        const got = inFrame(cam)[0], L = got?.[0]
        const want = L ? Math.atan2(ground(L.x, L.y, man.h) + L.h * 0.55 - man.h - 1.6, Math.hypot(L.x - man.x, L.y - man.y)) : 0.08
        S.tilt += (clamp(want, -0.1, 0.6) - S.tilt) * Math.min(1, dt * 3)
        cam.position.set(man.x + fx * 0.3, man.h + 1.62, -(man.y + fy * 0.3))
        cam.lookAt(v.set(man.x + fx * 50, man.h + 1.62 + Math.tan(S.tilt) * 50, -(man.y + fy * 50)))
        if (cam.fov !== 52) { cam.fov = 52; cam.updateProjectionMatrix() }
        const t = got ? `${L.name} · ${got[1]} pts` : 'Turn to frame a landmark'
        if (frameEl.dataset.t !== t && now - (S.capAt || 0) > 2500) frameEl.dataset.t = t
        if (!S.capAt) S.capAt = now
      } else if (S.sit) {
        // the camera settles to one side of the view, a little back, unless it has been turned since sitting down
        const T = S.sit, C = api.chase, k = 1 - Math.exp(-1.2 * dt); T.t += dt
        if (api.orbit.idle < T.t) T.look = 0
        if (T.look && T.t < 5) { C.yaw += wrap(man.yaw + 0.45 - C.yaw) * k; C.pitch += (0.16 - C.pitch) * k; C.dist += (Math.max(C.dist, 4.6) - C.dist) * k }
        if (!T.done && T.t > 6) {
          T.done = true
          const b = beaches.find((q) => Math.hypot(q.x - man.x, q.y - man.y) < 260), golden = city.light.night > 0.04 && city.light.night < 0.7
          if (b && !saved.beaches.includes(b.name)) {
            saved.beaches.push(b.name); save()
            api.popup(b.name, `${golden ? 'Sunset on the sand' : 'A beach to remember'} · ${saved.beaches.length} of ${beaches.length}`); api.sfx.pickup()
            award('beach', golden ? 120 : 60, { label: b.name })
          } else { api.popup(golden ? 'Golden hour' : 'Taking it in', b ? b.name : 'A quiet minute'); award('rest', golden ? 20 : 10, { quiet: true }) }
        }
      } else S.capAt = 0
    },
    // the job card on a free walk: { title, line, sub, target } or null
    card() {
      const n = Object.keys(saved.shots).length
      if (S.sit) return { title: S.sit.to.label ? `On ${S.sit.to.label}` : 'Sitting a while', line: 'Move to get up', sub: `Beaches ${saved.beaches.length} of ${beaches.length}`, target: null }
      if (!S.near) return { title: `Photo walk · ${n} of ${shots.length}`, line: 'Every landmark shot!', sub: 'Reshoot for a better score', target: null }
      const d = S.near.d
      return { title: `Photo walk · ${n} of ${shots.length}`, line: S.near.name, sub: d < S.near.r ? 'In range: frame it and snap' : `${d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`} · snaps from ${S.near.r} m`, target: S.near }
    },
    stages: (id) => (canStage(id) ? { reach: saved.reach[id] || 0, bests: saved.stages[id] || [0, 0, 0, 0], medals: (saved.stages[id] || []).map((b) => { const m = medalOf(b, stagePar(id)); return m >= 0 ? MEDALS[m][0] : '' }) } : null),
    medal: (id) => { const p = par(id), b = saved.best[id], m = p && b ? MEDALS.findIndex((q) => b <= p * q[1]) : -1; return m >= 0 ? MEDALS[m][0] : '' },
    dispose() { heart.material.map.dispose(); heart.material.dispose(); css.remove(); btns.remove(); frameEl.remove(); mat.dispose(); for (const m of Object.values(models)) m.geometry.dispose() },
  }
}
