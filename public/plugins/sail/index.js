// Sail: a small sloop on the real water (English Bay, False Creek, Burrard Inlet, Howe Sound, the Fraser…).
// The toolbar's "Sail" button asks for a spot on the water, then dives from the map into a chase view behind the
// boat; Esc flies back. The wind is the weather plugin's (live from Open-Meteo, a gale when a storm is picked), with
// gusts you can see coming (dark ruffled patches on the water, water.js): no sailing into it (the no-go zone),
// fastest across it on a beam reach, slower running before it. The sail trims itself, a little slowly; W / S trim in
// and ease out faster (S all the way luffs it and stops the boat), and the HUD shows the ideal trim against yours.
// The sea is water.js's: waves from the wind that the boat pitches, rolls and surfs on. Things to do (sights to
// collect, buoy races, orcas) are goals.js's. A first-timer gets a little animated wind diagram and hints for what
// to do next. The shore comes from the map tiles' water masks (the coarse base map until they load): the boat bumps
// and stops there. Ships (city.ships), bridge piers (city.landmarks.piers) and other players (city.multiplayer) are
// solid too. Published as city.player { mode: 'boat' }, with city.models.boat for others.
import { kit, kitMaterial, repaint } from '../../core/kit.js'
import { makeBoat, COLOUR } from './boat.js'
import { makeWater } from './water.js'
import { makeGoals, fmtTime } from './goals.js'
import { want } from './fleet.js'
import { clamp, smooth, wrap, circleBox } from '../../core/util.js'
import { typing, buzz, MOVE_KEYS, mapPicker, mapCameraPose, poseOf, dive, streetSky, touchButtons, audioContext, tone, noise } from '../../core/play.js'

const VMAX = 9 // m/s: a small keelboat in a gale (the server allows 12 for boats)
// share of the best speed by true wind angle (degrees off the bow): nothing in the no-go zone, best on a beam reach
const POLAR = [0, 0, 34, 0, 45, 0.68, 60, 0.86, 95, 1, 130, 0.9, 180, 0.62]
const HULL = [3.1, 0, 2.15, 0, 1.2, 0, -0.8, 0, -1.8, 0, -2.8, 0, 0.3, 1.15, 0.3, -1.15] // [ahead, right] points that must stay on the water (metres): a metre apart along her, or the corner of a shore cell (4 m) passes between two and a metre and more of the hull is on the land
const TRAIL = 48, TRAIL_DT = 0.2 // wake: samples, seconds apart
const SPRAY = 90 // spray droplets
const PLANE = 5.4 // m/s (10.5 kn): faster than this she lifts and planes
const RAD = Math.PI / 180, KN = 1.944
function polar(deg) {
  for (let i = 2; i < POLAR.length; i += 2) if (deg <= POLAR[i]) return POLAR[i - 1] + ((POLAR[i + 1] - POLAR[i - 1]) * (deg - POLAR[i - 2])) / (POLAR[i] - POLAR[i - 2])
  return POLAR[POLAR.length - 1]
}
// the best sheet (0 eased right out .. 1 hard in) for an apparent wind angle in degrees
const idealSheet = (awa) => clamp(1 - (awa - 28) / 135, 0.06, 1)

// the wind rose drawn in the HUD gauge and the how-to card: the wind from the top, the no-go zone (red), the fast
// angles (green) either side and the slower ones; c the centre, r the outer radius (an SVG fragment)
function rose(c, r, w) {
  const at = (a, rr) => `${(c + rr * Math.sin(a * RAD)).toFixed(1)} ${(c - rr * Math.cos(a * RAD)).toFixed(1)}`
  const sector = (a0, a1, r0, r1, fill) => `<path d="M${at(a0, r1)} A${r1} ${r1} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${at(a1, r1)} L${at(a1, r0)} A${r0} ${r0} 0 ${a1 - a0 > 180 ? 1 : 0} 0 ${at(a0, r0)}Z" fill="${fill}"/>`
  const r0 = r - w
  return sector(-180, -130, r0, r, 'rgba(159,211,230,.28)') + sector(130, 180, r0, r, 'rgba(159,211,230,.28)')
    + sector(-130, -55, r0, r, 'rgba(122,226,146,.62)') + sector(55, 130, r0, r, 'rgba(122,226,146,.62)')
    + sector(-55, -38, r0, r, 'rgba(159,211,230,.38)') + sector(38, 55, r0, r, 'rgba(159,211,230,.38)')
    + sector(-38, 38, r0 - w * 0.4, r, 'rgba(255,112,92,.6)')
}
// a little sloop seen from above, pointing up, with its boom (data-sail) to turn
const BOAT_SVG = (s) => `<path d="M0 ${-9 * s} C${4 * s} ${-4 * s} ${4 * s} ${4 * s} ${3 * s} ${8 * s} L${-3 * s} ${8 * s} C${-4 * s} ${4 * s} ${-4 * s} ${-4 * s} 0 ${-9 * s}Z" fill="#fdf6ea"/><line data-sail x1="0" y1="${-2 * s}" x2="0" y2="${7 * s}" stroke="#2f6f8f" stroke-width="${1.6 * s}" stroke-linecap="round"/>`

export default function sail(city) {
  const { THREE } = city
  const v3 = new THREE.Vector3(), v4 = new THREE.Vector3()

  // ================================================================ where the water is
  const masks = new Map() // detail tile (i * 8192 + j) → tile, whose .water is a 256² mask (1 = water)
  const tkey = (i, j) => i * 8192 + j
  let shoreDirty = 0 // when a detail tile near the boat came in: rebuild the shore field (water.js) soon
  const offTiles = [
    city.world.eachTile((t) => { if (t.level === 0) { masks.set(tkey(t.i, t.j), t); shoreDirty = shoreDirty || performance.now() + 400 } }), // (not `state`: eachTile calls back at once for tiles already in, before it exists)
    city.on('tile:unload', (t) => { if (t.level === 0) masks.delete(tkey(t.i, t.j)) }),
  ]
  let base = null // the core's base map (1 px = 64 m; water is (40, 98, 150)) for where no detail tile is loaded
  function baseWet(x, n) {
    const g = city.tiles?.coarse, img = city.tiles?.baseMesh?.material?.map?.image ?? city.tiles?.baseMesh?.children?.[0]?.material?.map?.image
    if (!g || !img?.width) return false
    if (!base) {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0)
      base = { w: c.width, h: c.height, k: c.width / g.w, d: cx.getImageData(0, 0, c.width, c.height).data }
    }
    const i = Math.round(((x - g.x0) / g.c) * base.k), j = Math.round(((g.y1 - n) / g.c) * base.k)
    if (i < 0 || j < 0 || i >= base.w || j >= base.h) return false
    const o = (j * base.w + i) * 4
    return base.d[o + 2] > base.d[o] + 60
  }
  function wet(x, z) { // is world (x, z) water?
    const n = -z, t = masks.get(tkey(Math.floor(x / 1024), Math.floor(n / 1024)))
    if (!t) return baseWet(x, n)
    const w = t.water
    if (!w) return false
    const N = w.n, a = Math.floor(((x - t.ox) / 1024) * N), b = Math.floor(((n - t.oy) / 1024) * N)
    return w.mask[b * N + a] === 1
  }
  function dry(x, z, h) { // how many hull points are on land
    const fx = Math.sin(h), fz = Math.cos(h)
    let d = 0
    for (let i = 0; i < HULL.length; i += 2) if (!wet(x + fx * HULL[i] - fz * HULL[i + 1], z + fz * HULL[i] + fx * HULL[i + 1])) d++
    return d
  }
  const roomy = (x, z) => wet(x, z) && wet(x + 7, z) && wet(x - 7, z) && wet(x, z + 7) && wet(x, z - 7)
  function nearestWater(x, z, maxR) { // the nearest open water to (x, z) within maxR metres, or null
    for (let r = 0; r <= maxR; r += r < 200 ? 6 : 24) {
      const n = Math.max(1, Math.ceil((2 * Math.PI * r) / (r < 200 ? 6 : 24)))
      for (let k = 0; k < n; k++) { const a = (k / n) * 2 * Math.PI, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r; if (roomy(px, pz)) return { x: px, z: pz } }
    }
    return null
  }

  // ================================================================ scene objects
  const boat = makeBoat(THREE)
  const { hull, boom, jib, main, jibSail } = boat.userData
  city.models = { ...city.models, boat: (colour = COLOUR) => makeBoat(THREE, colour) }
  const water = makeWater(THREE, city)
  const offQuality = city.on('quality', (t) => { water.setQuality(t); city.requestRender() })
  // the wake: two foam lines spreading at the Kelvin angle behind the stern, fading, riding the waves; written in place
  const wpos = new Float32Array(TRAIL * 12), wcol = new Float32Array(TRAIL * 16).fill(1)
  const wgeo = new THREE.BufferGeometry()
  wgeo.setAttribute('position', new THREE.BufferAttribute(wpos, 3).setUsage(THREE.DynamicDrawUsage))
  wgeo.setAttribute('color', new THREE.BufferAttribute(wcol, 4).setUsage(THREE.DynamicDrawUsage))
  const widx = []
  for (let k = 0; k < TRAIL - 1; k++) for (const s of [0, 2]) { const a = k * 4 + s, c = a + 4; widx.push(a, a + 1, c, a + 1, c + 1, c) }
  wgeo.setIndex(widx)
  const wake = new THREE.Mesh(wgeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }))
  wake.frustumCulled = false
  const trail = { x: new Float32Array(TRAIL), z: new Float32Array(TRAIL), h: new Float32Array(TRAIL), s: new Float32Array(TRAIL), t: new Float32Array(TRAIL), head: 0, n: 0, at: 0 }
  // spray off the bow when she is fast, slams into a wave or surfs: droplets flying out and falling back
  const spos = new Float32Array(SPRAY * 3), scol = new Float32Array(SPRAY * 4).fill(1), svel = new Float32Array(SPRAY * 3), sage = new Float32Array(SPRAY).fill(9)
  const sgeo = new THREE.BufferGeometry()
  sgeo.setAttribute('position', new THREE.BufferAttribute(spos, 3).setUsage(THREE.DynamicDrawUsage))
  sgeo.setAttribute('color', new THREE.BufferAttribute(scol, 4).setUsage(THREE.DynamicDrawUsage))
  const dot = (() => { const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d'), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c) })()
  const spray = new THREE.Points(sgeo, new THREE.PointsMaterial({ size: 0.45, map: dot, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true }))
  spray.frustumCulled = false
  let sprayNext = 0, splashAt = 0

  // ================================================================ sound: the sea along the hull, the wind, spray, a bump, chimes
  let ac = null, out = null, src = null, sea = null, muted = false // out: our gain on the shared context (core/play.js)
  try { muted = localStorage.getItem('sail.muted') === '1' } catch {}
  function audio() {
    if (out) return audioContext()
    if (!(ac = audioContext())) return null
    out = ac.createGain(); out.connect(ac.destination)
    src = ac.createBufferSource()
    src.buffer = noise(ac, 2); src.loop = true; src.start()
    const chan = (type, f0, q) => { const f = ac.createBiquadFilter(), g = ac.createGain(); f.type = type; f.frequency.value = f0; if (q) f.Q.value = q; g.gain.value = 0; src.connect(f); f.connect(g); g.connect(out); return { f, g } }
    sea = { hull: chan('lowpass', 400), wind: chan('bandpass', 900, 0.8), spray: chan('highpass', 2600) }
    return ac
  }
  function thud(k) { if (audio() && !muted) tone(out, 65, ac.currentTime, 0.35, 0.2 * k, 'triangle', 0.01) }
  const NOTES = [[659, 880], [784, 988], [659, 784, 988, 1319]] // start, a mark, a sight or the finish
  function chime(k) { if (audio() && !muted) NOTES[k].forEach((hz, i) => tone(out, hz, ac.currentTime + i * 0.11, 0.9, 0.09, 'sine', 0.015)) }
  function splash(k) { if (sea && !muted) { const t = ac.currentTime; sea.spray.g.gain.cancelScheduledValues(t); sea.spray.g.gain.setTargetAtTime(0.05 * k, t, 0.02); sea.spray.g.gain.setTargetAtTime(0, t + 0.12, 0.25) } }
  function setMuted(m) { muted = m; try { localStorage.setItem('sail.muted', m ? '1' : '0') } catch {}; ui.mute.textContent = m ? 'Sound off' : 'Sound on' }

  // ================================================================ HUD (the drive plugin's look)
  const touchy = matchMedia('(pointer: coarse)').matches
  const css = document.createElement('style')
  css.textContent = `
    .sl { position: fixed; z-index: 25; font: 13px/1.35 system-ui, -apple-system, sans-serif; color: #fdf6ea; pointer-events: none; }
    .sl[hidden] { display: none !important }
    .sl.card { background: rgba(28, 34, 40, 0.62); border: 1px solid rgba(225, 240, 255, 0.16); border-radius: 14px; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); box-shadow: 0 6px 22px rgba(0,0,0,.18); }
    .sl button { pointer-events: auto; font: inherit; color: inherit; background: rgba(28, 34, 40, 0.62); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border: 1px solid rgba(225,240,255,.18); border-radius: 9px; padding: 5px 10px; cursor: pointer; }
    .sl button:hover { background: rgba(52, 64, 74, 0.75) }
    .sl-read { left: 12px; top: 12px; display: flex; align-items: center; gap: 10px; padding: 6px 14px 6px 6px; font-variant-numeric: tabular-nums; }
    .sl-gauge { flex: none; width: 62px; height: 62px; }
    .sl-gauge [data-rose] { transition: transform .12s linear; }
    .sl-read .sp { font-size: 15px; white-space: nowrap } .sl-read .sp b { font-size: 19px; font-weight: 700 }
    .sl-read .sub { font-size: 12px; color: #d6dee4; white-space: nowrap }
    .sl-read .sub.irons [data-pos] { color: #ffb4a0 }
    .sl-read .gust { color: #9fe0b0; font-weight: 650 }
    .sl-trim { margin-top: 5px; display: flex; align-items: center; gap: 7px; font-size: 11px; color: #c8d2da; }
    .sl-trim .bar { position: relative; flex: 1; min-width: 96px; height: 6px; border-radius: 3px; background: rgba(255,255,255,.14); }
    .sl-trim i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: #ffc66e; transition: background .3s; }
    .sl-trim i.ok { background: #7ae292 }
    .sl-trim u { position: absolute; top: -4px; width: 3px; height: 14px; margin-left: -1.5px; border-radius: 2px; background: #fdf6ea; box-shadow: 0 0 0 1px rgba(0,0,0,.35); }
    .sl-btns { right: 12px; top: 12px; display: flex; gap: 6px; }
    .sl-btns .short, .sl-btns .mn { display: none }
    .sl-help { left: 50%; bottom: 52px; transform: translateX(-50%); padding: 7px 14px; color: #eef3f6; font-size: 13px; white-space: nowrap; transition: opacity .5s; text-align: center; }
    .sl-help.fade { opacity: 0 }
    .sl-help kbd { font: 600 11px system-ui, sans-serif; padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.22); }
    .sl-pop { left: 50%; top: 30%; transform: translate(-50%, -50%); padding: 8px 18px; font-size: 18px; font-weight: 700; color: #ffe1a8; opacity: 0; transition: opacity .3s; white-space: nowrap; }
    .sl-pop.on { opacity: 1 }
    .sl-pick { left: 50%; top: 12px; transform: translateX(-50%); padding: 8px 10px 8px 14px; display: flex; gap: 10px; align-items: center; font-size: 14px; }
    .sl-tgt { left: 50%; top: 12px; transform: translateX(-50%); padding: 7px 14px 7px 9px; display: flex; gap: 8px; align-items: center; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .sl-tgt .ar { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: rgba(255,210,122,.22); color: #ffd27a; font-size: 13px; transition: transform .12s linear; }
    .sl-tgt.race .ar { background: rgba(255,154,74,.25); color: #ffb37a }
    .sl-tgt b { font-weight: 700 } .sl-tgt .tm { color: #ffd27a; font-weight: 700 }
    .sl-goals { right: 12px; top: 56px; width: 290px; padding: 12px 14px; pointer-events: auto; max-height: calc(100dvh - 130px); overflow-y: auto; }
    .sl-goals h3 { margin: 0 0 6px; font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .06em; color: #b8c6d0; }
    .sl-goals .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 0; }
    .sl-goals .row small { display: block; color: #b8c6d0; font-size: 11.5px }
    .sl-goals .sights { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 10px; }
    .sl-goals .sights span { font-size: 11px; padding: 2px 7px; border-radius: 9px; background: rgba(255,255,255,.08); color: #9aa8b2; }
    .sl-goals .sights span.got { background: rgba(255,210,122,.2); color: #ffe1a8 }
    .sl-learn { left: 12px; bottom: 96px; width: 400px; padding: 12px 14px; display: flex; gap: 14px; align-items: center; pointer-events: auto; }
    .sl-learn svg { flex: none; width: 150px; height: 150px; }
    .sl-learn h3 { margin: 0 0 4px; font-size: 15px; }
    .sl-learn ul { margin: 0 0 8px; padding-left: 16px; font-size: 12.5px; color: #e3e9ee; } .sl-learn li { margin: 2px 0 }
    .sl-learn .st { font-weight: 650; font-size: 12px; min-height: 16px; }
    .sl-learn .spd { height: 5px; border-radius: 3px; background: rgba(255,255,255,.14); margin: 3px 0 8px; overflow: hidden; } .sl-learn .spd i { display: block; height: 100%; background: #7ae292; }
    .sl-learn kbd, .sl-goals kbd { font: 600 11px system-ui, sans-serif; padding: 0 4px; border-radius: 4px; background: rgba(255,255,255,.16); }
    body.sl-picking canvas { cursor: crosshair }
    body.sl-picking #hint { display: none }
    .sl-touch { inset: auto 0 0 0; height: 170px; display: none; }
    .sl-touch button { position: absolute; bottom: 52px; width: 74px; height: 74px; border-radius: 50%; font-size: 15px; font-weight: 650; line-height: 1.05; background: rgba(28,34,40,.5); border: 2px solid rgba(225,240,255,.35); touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
    .sl-touch button b { display: block; font-size: 19px } .sl-touch button small { display: block; font-size: 10.5px; font-weight: 500; opacity: .85; margin-top: 2px }
    .sl-touch .trim b, .sl-touch .ease b { font-size: 15px }
    .sl-touch button.on { background: rgba(70,150,190,.75) }
    .sl-touch .l { left: 16px } .sl-touch .r { left: 100px } .sl-touch .trim { right: 16px; height: 100px; border-radius: 22px } .sl-touch .ease { right: 100px }
    body.sail-on.sl-touchy .sl-touch { display: block }
    body.sail-on.sl-touchy .sl-help { bottom: 150px; white-space: normal; width: max-content; max-width: calc(100% - 40px); }
    html:not(.compact) body.sail-on.sl-touchy .sl-learn { bottom: 224px; } /* tablets: over the steering buttons and the music */
    body.sail-on #bar, body.sail-on #hint, body.sail-on #about, body.sail-on #tools, body.sail-on .tool-panel, body.sail-on #credits { display: none !important }
    @media (max-width: 640px) { .sl-btns .opt { display: none } .sl-pick { font-size: 13px; white-space: nowrap; top: 64px } }
    .compact .sl-read { left: var(--sl); top: var(--st); padding: 4px 10px 4px 4px; gap: 7px; }
    .compact .sl-gauge { width: 54px; height: 54px }
    .compact .sl-trim .bar { min-width: 70px }
    .compact .sl-btns { right: var(--sr); top: var(--st); flex-direction: column; align-items: flex-end; }
    .compact .sl-btns .opt, .compact .sl-btns .long { display: none } .compact .sl-btns .short { display: inline }
    .compact .sl-btns button { width: 78px; height: 40px; padding: 0; border-radius: 12px; }
    /* phones: the next sight or mark is a line in the readout (hud() moves it in), ? and Goals are in the ⋯ sheet */
    .sl-read .sl-tgt { position: static; transform: none; margin-top: 4px; padding: 0; gap: 6px; font-size: 12px; background: none; border: 0; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
    .sl-read .sl-tgt .ar { width: 18px; height: 18px; font-size: 10px; }
    #menu [data-learn] .q, #menu [data-goals] .short { display: none }
    .compact .sl-goals { left: var(--sl); right: var(--sr); width: auto; top: calc(var(--st) + 140px); }
    .compact .sl-learn { left: var(--sl); right: var(--sr); width: auto; top: calc(var(--st) + 140px); bottom: auto; gap: 10px; padding: 10px 12px; }
    .compact .sl-learn svg { width: 112px; height: 112px } .compact .sl-learn ul { font-size: 12px; padding-left: 14px }
    /* landscape phones: between the readout and the buttons, clear of the steering and the sail buttons below */
    @media (orientation: landscape) { .compact .sl-goals, .compact .sl-learn { top: var(--st); left: calc(var(--sl) + 240px); right: calc(var(--sr) + 136px); bottom: auto; max-height: calc(100% - var(--st) - 72px); overflow-y: auto; box-sizing: border-box; } }
    .compact .sl-pick { top: calc(var(--st) + 52px); left: var(--sl); right: var(--sr); transform: none; justify-content: space-between; white-space: normal; }
    .compact .sl-pick button { min-height: 44px; padding: 0 14px; flex: none; }
    .compact .sl-touch { --pb: max(16px, calc(env(safe-area-inset-bottom) + 4px)); height: auto; top: 0; }
    .compact .sl-touch button { bottom: var(--pb); }
    .compact .sl-touch .l { left: var(--sl) } .compact .sl-touch .r { left: calc(var(--sl) + 84px) }
    .compact .sl-touch .trim { right: var(--sr) } .compact .sl-touch .ease { right: calc(var(--sr) + 86px) }
    .compact body.sail-on .sl-help { top: calc(var(--st) + 116px); bottom: auto; left: var(--sl); right: calc(var(--sr) + 88px); transform: none; width: auto; max-width: none; white-space: normal; text-align: left; font-size: 12.5px; }
    body.sl-learning .sl-help { display: none }
    html.embed body:has(.sl-learn:not([hidden]), .sl-goals:not([hidden])) .more-fab { display: none } /* the embed's cards span the top: ⋯ comes back with them closed */`
  document.head.append(css)
  const el = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; d.hidden = true; document.body.append(d); return d }
  const K = touchy ? { left: '◀', right: '▶', trim: 'Trim', ease: 'Ease' } : { left: 'A', right: 'D', trim: 'W', ease: 'S' } // what to press, in hints
  const kb = (k) => (touchy ? `<b>${K[k]}</b>` : `<kbd>${K[k]}</kbd>`)
  const ui = {
    read: el('sl sl-read card', `<svg class="sl-gauge" viewBox="0 0 64 64" role="img" aria-label="Wind and sail"><circle cx="32" cy="32" r="31" fill="rgba(255,255,255,.06)"/>
        <g data-rose>${rose(32, 30, 7)}<path d="M32 1 L32 13 M27 8 L32 14 L37 8" fill="none" stroke="#9fd3e6" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></g>
        <g transform="translate(32 33)">${BOAT_SVG(1.25)}</g></svg>
      <div><div class="sp"><b data-v>0.0</b> kn <span class="sub" data-pos></span></div>
        <div class="sub">wind <b data-w></b> kn <span class="gust" data-gust></span></div>
        <div class="sl-trim" title="Sail trim: the white mark is the best for this wind angle. W trims in, S eases out"><span>sail</span><div class="bar"><i data-sh></i><u data-id></u></div></div></div>`),
    btns: el('sl sl-btns', '<button class="opt" data-mute title="Sound (M)">Sound on</button><button data-learn title="How to sail (H)" aria-label="How to sail"><span class="q">?</span><span class="mn">How to sail</span></button><button data-goals title="Races and sights (G)"><span class="long">Goals</span><span class="short">Goals</span></button><button data-exit title="Back to the map (Esc)" aria-label="Back to the map"><span class="long">Back to map</span><span class="short">‹ Map</span></button>'),
    help: el('sl sl-help card', ''),
    pop: el('sl sl-pop card', ''),
    pick: el('sl sl-pick card', '<span data-pt></span><button data-cancel>Cancel</button>'),
    tgt: el('sl sl-tgt card', '<span class="ar" data-ar>▲</span><span data-tn></span><b data-td></b><span class="tm" data-tt></span>'),
    goals: el('sl sl-goals card', ''),
    learn: el('sl sl-learn card', `<svg viewBox="0 0 160 160" aria-hidden="true">${rose(80, 66, 16)}
        <path d="M80 2 L80 22 M73 14 L80 23 L87 14" fill="none" stroke="#9fd3e6" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="80" y="44" fill="#ffcfc4" font-size="10" font-weight="700" text-anchor="middle">NO-GO</text>
        <text x="138" y="84" fill="#c6f5d2" font-size="9.5" font-weight="700" text-anchor="middle">FAST</text><text x="22" y="84" fill="#c6f5d2" font-size="9.5" font-weight="700" text-anchor="middle">FAST</text>
        <text x="80" y="140" fill="#cfe6f0" font-size="9" text-anchor="middle">slower</text>
        <g data-demo transform="translate(80 82)">${BOAT_SVG(2.1)}</g></svg>
      <div><h3>How to sail</h3><div class="st" data-st></div><div class="spd"><i data-spd></i></div>
        <ul><li>The wind blows from the arrow. Steer with ${touchy ? '<b>◀ ▶</b>' : '<kbd>A</kbd> <kbd>D</kbd> or <kbd>←</kbd> <kbd>→</kbd>'}.</li>
        <li>You can't sail into the <b style="color:#ffb4a0">red</b>: turn away from it.</li>
        <li>Fastest with the wind on your side (<b style="color:#9fe0b0">green</b>).</li>
        <li>The sail trims itself. ${touchy ? '<b>Trim</b> / <b>Ease</b>' : '<kbd>W</kbd> / <kbd>S</kbd>'} help it onto the white mark.</li></ul>
        <button data-ok>Let's sail</button></div>`),
    touch: el('sl sl-touch', '<button class="l" data-k="left" aria-label="Steer left"><b>◀</b><small>left</small></button><button class="r" data-k="right" aria-label="Steer right"><b>▶</b><small>right</small></button><button class="ease" data-k="ease" aria-label="Ease the sail out"><b>Ease</b><small>sail out</small></button><button class="trim" data-k="trim" aria-label="Trim the sail in"><b>Trim</b><small>sail in</small></button>'),
  }
  const q = (e, s) => e.querySelector(s)
  Object.assign(ui, { all: [ui.read, ui.btns, ui.help, ui.pop, ui.pick, ui.touch, ui.tgt, ui.goals, ui.learn], rose: q(ui.read, '[data-rose]'), v: q(ui.read, '[data-v]'), pos: q(ui.read, '[data-pos]'), sub: q(ui.read, '.sp .sub'),
    w: q(ui.read, '[data-w]'), gust: q(ui.read, '[data-gust]'), sh: q(ui.read, '[data-sh]'), id: q(ui.read, '[data-id]'), mute: q(ui.btns, '[data-mute]'), exit: q(ui.btns, '[data-exit]'),
    pt: q(ui.pick, '[data-pt]'), cancel: q(ui.pick, '[data-cancel]'), ar: q(ui.tgt, '[data-ar]'), tn: q(ui.tgt, '[data-tn]'), td: q(ui.tgt, '[data-td]'), tt: q(ui.tgt, '[data-tt]'),
    demo: q(ui.learn, '[data-demo]'), demoSail: q(ui.learn, '[data-demo] [data-sail]'), st: q(ui.learn, '[data-st]'), spd: q(ui.learn, '[data-spd]'), sail: q(ui.read, '[data-sail]') })
  const touchState = { left: false, right: false, trim: false, ease: false }
  touchButtons(ui.touch, touchState, audio)
  ui.exit.onclick = () => exit()
  ui.cancel.onclick = () => cancelPick()
  ui.mute.onclick = () => setMuted(!muted)
  ui.mute.textContent = muted ? 'Sound off' : 'Sound on'
  city.ui.inMenu?.(ui.mute) // phones: in the ⋯ sheet
  const goalsBtn = q(ui.btns, '[data-goals]'), learnBtn = q(ui.btns, '[data-learn]')
  goalsBtn.onclick = () => { city.ui.closeAll(); toggleGoals() } // (closes the ⋯ sheet they are in on phones)
  learnBtn.onclick = () => { city.ui.closeAll(); ui.learn.hidden ? showLearn() : hideLearn() }
  city.ui.inMenu?.(goalsBtn); city.ui.inMenu?.(learnBtn)
  q(ui.learn, '[data-ok]').onclick = () => hideLearn()
  let popT = 0, helpT = 0
  let popHold = 0 // a long popup (a race's result) isn't talked over by a short one
  function popup(text, ms = 1600) { const now = performance.now(); if (ms <= 1600 && now < popHold) return; if (ms > 1600) popHold = now + ms; ui.pop.textContent = text; ui.pop.hidden = false; requestAnimationFrame(() => ui.pop.classList.add('on')); clearTimeout(popT); popT = setTimeout(() => ui.pop.classList.remove('on'), ms) }

  // ================================================================ state
  const pcam = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 1, 900)
  const opts = { focus: new THREE.Vector3(), radius: 900, shadowRadius: 300 }
  // the boat, in world x / z: heading h with forward (sin h, cos h), like city.traffic; y the sea level under her
  const B = { x: 0, y: 0, z: 0, h: 0, speed: 0, steer: 0, sheet: -1, ideal: 1, eff: 1, manualT: -9, heel: 0, boom: 0, side: 0, bumpT: 0, twa: 0, aws: 0, from: 0, gust: 0, surf: 0, surfT: 0, plane: 0 }
  const ride = { y: 0, vy: 0, pitch: 0, roll: 0, slam: 0, slope: 0 } // on the waves
  const wind = { x: 3, z: -3, base: 4 } // m/s towards, smoothed, with gusts; base: the steady wind, for the sea
  const chase = { pos: new THREE.Vector3(), look: new THREE.Vector3(), yaw: 0 }
  const player = { mode: 'boat', vehicle: 'boat', colour: COLOUR, x: 0, y: 0, z: 0, heading: 0, speed: 0 }
  let state = 'off', anim = null, offFrame = null, t0 = 0, mapPose = null, fromPose = null, saved = null
  let hudAt = 0, skyAt = 0, obsAt = 0, fogFar = 850, obs = [], seaMix = 0, playT = 0
  const keys = new Set()
  let seenAt = { surf: -99, plane: -99, gust: -99 }
  const topSpeed = (ws) => Math.min(VMAX, 0.8 + 0.6 * ws) // m/s at the best angle in this wind
  const goals = makeGoals(THREE, city, { chime, popup, makeBoat, wind, polar, top: topSpeed, wet })
  let tgtNow = null, auto = null // tests (?drivedebug): the computer steers the player round the course

  const button = city.ui.addButton({ label: 'Sail', icon: '⛵', title: 'Sail a small boat on the real water, in the real wind', onClick: () => startPick(), dock: true })

  // ---------------------------------------------------------------- pick where to start
  const picker = mapPicker(city, 'sl-picking', (x, z) => {
    const w = nearestWater(x, z, 3000)
    if (!w) { city.ui.toast('No water near there: try the bay or the inlet'); return }
    cancelPick()
    start(w.x, w.z)
  })
  function startPick() {
    if (state === 'pick') return cancelPick()
    if (state !== 'off' || city.player) return
    city.ui.closeAll()
    state = 'pick'
    audio()
    ui.pt.textContent = `${touchy ? 'Tap' : 'Click'} the water where you want to set sail`
    ui.pick.hidden = false
    picker.on()
  }
  function cancelPick() {
    if (state !== 'pick') return
    state = 'off'
    ui.pick.hidden = true
    picker.off()
  }

  function start(x, z) {
    document.activeElement?.blur?.()
    windStep(10, 0)
    // among moored boats (a marina's rows hold a boat that starts between them): from the nearest water clear of them
    const clear = (px, pz) => wet(px, pz) && !city.ships?.nearby?.(px, pz, 10, true).length
    for (let d = 10, k = 0; !clear(x, z) && d <= 200; k = (k + 1) % 12, d += k ? 0 : 10) {
      const px = x + Math.sin(k * Math.PI / 6) * d, pz = z + Math.cos(k * Math.PI / 6) * d
      if (clear(px, pz)) { x = px; z = pz }
    }
    // set off on a beam reach, the way with more water ahead
    const from = Math.atan2(-wind.x, -wind.z)
    let h = from + Math.PI / 2
    const open = (hh) => { let n = 0; for (let d = 20; d <= 200; d += 20) n += wet(x + Math.sin(hh) * d, z + Math.cos(hh) * d) ? 1 : 0; return n }
    if (open(from - Math.PI / 2) > open(h)) h = from - Math.PI / 2
    Object.assign(B, { x, z, h, y: city.world.heightAt(x, z), speed: 0, steer: 0, sheet: -1, heel: 0, boom: 0, side: 0, surf: 0, plane: 0 })
    Object.assign(ride, { y: 0, vy: 0, pitch: 0, roll: 0 })
    trail.n = 0; trail.head = 0
    mapPose = mapCameraPose(city)
    saved = { bg: city.scene.background, fog: city.scene.fog }
    chasePose(0, true)
    city.scene.add(boat, goals.group)
    city.overlay.add(wake, spray, goals.fx)
    wake.visible = false
    water.setWind(wind.base, -Math.sin(from), -Math.cos(from))
    water.buildShore(x, z, wet)
    seaMix = 0
    place(0, 0)
    fitCamera()
    state = 'in'; t0 = performance.now()
    city.view.useCamera(pcam, opts)
    anim = city.animate()
    offFrame = city.on('frame', frame)
    // dlv-on: a game owns the screen (toolbar away, the chat button and music placed for it; see PLUGINS.md)
    document.body.classList.add('sail-on', 'dlv-on')
    document.body.classList.toggle('sl-touchy', touchy)
    document.body.classList.toggle('dlv-touchy', touchy)
    pose(0)
    publish()
    const hue = city.progress?.choice('boat')?.value || COLOUR // the hull colour picked in the progress panel
    if (hue !== player.colour) { repaint(THREE, boat, player.colour, hue); player.colour = hue }
    city.player = player; city.emit('player', player)
  }
  function exit() {
    if (state === 'pick') return cancelPick()
    if (state !== 'play') return
    fromPose = poseOf(chase.pos, chase.look, pcam.fov)
    state = 'out'; t0 = performance.now()
    for (const e of ui.all) e.hidden = true
    keys.clear()
    goals.hide()
    if (sea) for (const c of Object.values(sea)) c.g.gain.setTargetAtTime(0, ac.currentTime, 0.3)
  }
  function finish() {
    state = 'off'
    city.view.release()
    offFrame?.(); offFrame = null
    anim?.(); anim = null
    city.scene.remove(boat, goals.group, water.mesh)
    city.overlay.remove(wake, spray, goals.fx)
    water.off()
    city.scene.background = saved.bg; city.scene.fog = saved.fog
    if (city.player === player) { city.player = null; city.emit('player', null) }
    document.body.classList.remove('sail-on', 'dlv-on', 'sl-touchy', 'dlv-touchy', 'sl-learning')
    city.requestRender()
  }
  // somewhere else on the water (a race's start): the camera and the wake start afresh there
  function teleport(x, z, h) {
    const w = roomy(x, z) ? { x, z } : nearestWater(x, z, 400)
    if (!w) return
    Object.assign(B, { x: w.x, z: w.z, h, y: city.world.heightAt(w.x, w.z), speed: 1.5, steer: 0, sheet: -1, heel: 0, side: 0 })
    trail.n = 0; trail.head = 0
    water.buildShore(B.x, B.z, wet)
    chasePose(0, true)
  }

  // ---------------------------------------------------------------- camera (as the drive plugin's)
  function fitCamera() { pcam.aspect = innerWidth / innerHeight; pcam.updateProjectionMatrix() }
  const chaseFov = () => (innerWidth < innerHeight ? 72 : 58) + 5 * B.plane
  function chasePose(dt, snap) {
    chase.yaw += wrap(B.h - chase.yaw) * (snap ? 1 : 1 - Math.exp(-2.2 * dt))
    const back = 15 + Math.max(0, B.speed) * 0.4
    v3.set(B.x - Math.sin(chase.yaw) * back, B.y + ride.y * 0.6 + 6, B.z - Math.cos(chase.yaw) * back)
    v3.y = Math.max(v3.y, city.world.heightAt(v3.x, v3.z) + 2) // a narrow channel: stay above the bank
    if (snap) chase.pos.copy(v3); else chase.pos.lerp(v3, 1 - Math.exp(-6 * dt))
    v4.set(B.x + Math.sin(B.h) * 7, B.y + ride.y * 0.8 + 2.2, B.z + Math.cos(B.h) * 7)
    if (snap) chase.look.copy(v4); else chase.look.lerp(v4, 1 - Math.exp(-8 * dt))
  }
  const chaseTo = poseOf(chase.pos, chase.look, 58)
  function pose(e) { // the dive: from a nearly orthographic long lens over the map down to the chase camera
    const ek = state === 'out' ? dive(pcam, opts, mapPose, fromPose, 1 - e, 1, atmosphere) : dive(pcam, opts, mapPose, poseOf(chase.pos, chase.look, chaseFov(), chaseTo), e, 1, atmosphere)
    seaMix = smooth(0.55, 1, ek)
    // our sea stands in for the map's once the camera is down near it (from far above its edge would show)
    const on = ek > 0.35
    if (on && !water.mesh.parent) city.scene.add(water.mesh)
    else if (!on && water.mesh.parent) { city.scene.remove(water.mesh); water.off() }
  }
  // sky and fog: the weather plugin's street-level look (core/play.js), the sea reflecting its sky
  const sky = streetSky()
  function atmosphere(k) { // k: 0 map look (no fog) .. 1 street look; returns how far the view reaches
    const A = sky.apply(city, pcam.position.distanceTo(opts.focus), k, saved.bg)
    water.sky(A.horizon, A.zenith)
    return (fogFar = sky.far)
  }

  // ---------------------------------------------------------------- wind and sailing
  function windStep(dt, t) {
    const W = city.weather || {}
    let wx = 3, wz = -3 // a south-westerly until the weather plugin answers
    if (Array.isArray(W.wind)) { wx = W.wind[0]; wz = W.wind[1] }
    else if (typeof W.wind === 'number') { const f = (W.windFrom ?? 225) * RAD; wx = -Math.sin(f) * W.wind; wz = Math.cos(f) * W.wind }
    let s = Math.hypot(wx, wz)
    if (s < 0.05) { wx = 0.7; wz = -0.7; s = 1 } // dead calm: the light air still comes from somewhere
    // never quite becalmed (cozy), a gale when a storm is picked; gusts (water.js: you can see them) and slow shifts on top
    wind.base = Math.max(clamp(s, 2, 15), W.kind === 'storm' ? 12 : 0)
    B.gust = state === 'play' ? water.gustAt(B.x, B.z) : 0
    const want = wind.base * (1 + 0.1 * Math.sin(t * 0.31) * Math.sin(t * 0.17 + 1.3) + B.gust) / s
    const veer = 0.07 * Math.sin(t * 0.05) + 0.12 * B.gust * Math.sin(t * 0.4), c = Math.cos(veer), sn = Math.sin(veer), k = 1 - Math.exp(-0.9 * dt)
    wind.x += ((wx * c - wz * sn) * want - wind.x) * k
    wind.z += ((wx * sn + wz * c) * want - wind.z) * k
  }
  const I = { steer: 0, sheet: 0 }
  function input() {
    const L = keys.has('ArrowLeft') || keys.has('KeyA') || touchState.left, R = keys.has('ArrowRight') || keys.has('KeyD') || touchState.right
    const up = keys.has('ArrowUp') || keys.has('KeyW') || touchState.trim, dn = keys.has('ArrowDown') || keys.has('KeyS') || touchState.ease
    I.steer = (L ? 1 : 0) - (R ? 1 : 0); I.sheet = (up ? 1 : 0) - (dn ? 1 : 0)
    if (auto && tgtNow) { auto.x = B.x; auto.z = B.z }
    if (auto && tgtNow?.slow && B.speed > 1) I.sheet = -1
    if (auto && tgtNow) I.steer = clamp(wrap(want(auto, tgtNow.x, tgtNow.z, wind, wet, 0.016) - B.h) * 4, -1, 1)
  }
  function sailStep(dt, t) {
    windStep(dt, t)
    input()
    const fx = Math.sin(B.h), fz = Math.cos(B.h), ws = Math.hypot(wind.x, wind.z)
    B.from = wrap(Math.atan2(-wind.x, -wind.z) - B.h) // where the true wind comes from, off the bow (+: the left)
    B.twa = Math.abs(B.from) / RAD
    // the apparent wind (true wind minus the boat's own), and which side the sail goes to (+1: starboard, the right)
    const ax = wind.x - fx * B.speed, az = wind.z - fz * B.speed
    B.aws = Math.hypot(ax, az)
    const awa = Math.abs(wrap(Math.atan2(-ax, -az) - B.h)), lee = Math.sign(-ax * fz + az * fx) || 1
    // the sheet: trimmed towards the best for the wind slowly by itself, quickly by hand (and left alone a moment after)
    B.ideal = idealSheet(awa / RAD)
    if (B.sheet < 0) B.sheet = B.ideal
    if (I.sheet) { B.sheet = clamp(B.sheet + I.sheet * 0.7 * dt, 0, 1); B.manualT = t }
    else if (t - B.manualT > 1.2) B.sheet += clamp(B.ideal - B.sheet, -0.22 * dt, 0.22 * dt)
    const e = B.sheet - B.ideal // < 0: eased too far, the sail luffs; > 0: pinned in, it stalls (and heels her more)
    B.eff = e < 0 ? clamp(1 - (e / 0.32) ** 2, 0, 1) : clamp(1 - 0.75 * (e / 0.5) ** 2, 0.25, 1)
    // speed: towards the polar's for this angle and wind, quicker to build than to fade (tacks carry through); planing
    // past PLANE lifts her a little further, and running down a wave's face pushes her on (surfing)
    const p = polar(B.twa)
    let target = B.eff * (p * topSpeed(ws)) - (p === 0 ? 0.4 : 0)
    B.plane += (smooth(PLANE - 0.4, PLANE + 0.8, B.speed) - B.plane) * (1 - Math.exp(-2 * dt))
    target *= 1 + 0.14 * B.plane
    B.speed += (target - B.speed) * (1 - Math.exp(-(target > B.speed ? 0.45 : 0.2) * dt))
    const along = (water.wave.x * fx + water.wave.z * fz) // the waves run with us (1) or at us (-1)
    const surf = B.speed > 1.5 && along > 0.2 ? clamp(-ride.slope, 0, 0.3) * 9.81 * 0.55 - clamp(ride.slope, 0, 0.3) * 9.81 * 0.2 : 0
    B.surf += (surf - B.surf) * (1 - Math.exp(-4 * dt))
    B.speed = Math.min(VMAX * 1.25, B.speed + B.surf * dt)
    B.surfT = B.surf > 0.35 ? B.surfT + dt : 0
    // the rudder bites with speed, though a little steerage way is always there
    B.steer += (I.steer - B.steer) * (1 - Math.exp(-6 * dt))
    const nh = wrap(B.h + B.steer * Math.min(0.7, 0.2 + 0.12 * Math.abs(B.speed)) * dt)
    // a tack or a jibe: the wind came across the bow or the stern
    const side = Math.sign(wrap(Math.atan2(-wind.x, -wind.z) - nh))
    if (B.side && side !== B.side && Math.abs(B.speed) > 0.3) popup(B.twa < 90 ? 'Tacking' : 'Jibing')
    B.side = side
    // move, drifting a little with the wind; the shore stops the boat (it may always back off or turn away)
    const nx = B.x + (fx * B.speed + wind.x * 0.03) * dt, nz = B.z + (fz * B.speed + wind.z * 0.03) * dt
    d0 = dry(B.x, B.z, B.h)
    if (d0 >= 6 && !wet(B.x, B.z)) { const w = nearestWater(B.x, B.z, 120); if (w) { B.x = w.x; B.z = w.z; B.speed = 0 } } // on land (a tile came in): back afloat
    else if (ok(nx, nz, nh)) { B.x = nx; B.z = nz; B.h = nh }
    else {
      if (ok(B.x, B.z, nh)) B.h = nh
      if (ok(nx, B.z, B.h)) B.x = nx; else if (ok(B.x, nz, B.h)) B.z = nz
      bumped(Math.abs(B.speed))
      B.speed *= -0.25
    }
    // pushed off a moored boat or a pier: not onto the shore, and not into the next boat of the row (a gap narrower
    // than she is: she stops where she was, instead of ending up aground or inside a hull)
    const px = B.x, pz = B.z
    collideObstacles(t)
    if (hits && Math.hypot(x0 - B.x, z0 - B.z) < 5 && (dry(B.x, B.z, B.h) > d0 || (collideObstacles(t), hits))) { B.x = x0; B.z = z0; B.speed *= -0.25 } else if (!hits) { x0 = px; z0 = pz } // (x0, z0: where she was last clear of them)
    // heel to leeward with the apparent wind (more when pinned in); the sail eased by the sheet, flogging when it can't draw
    const luff = clamp(Math.max(-e / 0.25, (36 - B.twa) / 8), 0, 1)
    const heel = clamp((0.55 + 0.45 * B.sheet) * (1 - luff) * B.aws * B.aws * Math.sin(Math.min(awa, Math.PI / 2)) * 0.0045, 0, 0.42)
    B.heel += (lee * heel - B.heel) * (1 - Math.exp(-2 * dt))
    const sa = Math.min((6 + (1 - B.sheet) * 82) * RAD, awa + 0.1)
    const tb = lee * sa + luff * 0.1 * Math.sin(t * 9), d = tb - B.boom
    B.boom += Math.sign(d) * Math.min(Math.abs(d), 2.6 * dt) // a jibe swings the boom across
    main.rotation.y = luff * 0.22 * Math.sin(t * 15)
    jibSail.rotation.y = luff * 0.3 * Math.sin(t * 17 + 1)
    // the sea level under her (the lowest ground under the hull; the shore is interpolated up into it): only out on
    // open water, so the sea doesn't climb the beach with her
    if (water.shoreAt(B.x, B.z) > 12 || !B.y) {
      const wy = Math.min(city.world.heightAt(B.x, B.z), city.world.heightAt(B.x + fx * 3, B.z + fz * 3), city.world.heightAt(B.x - fx * 3, B.z - fz * 3))
      B.y += (wy - B.y) * (1 - Math.exp(-0.5 * dt))
    }
  }
  let d0 = 0 // hull points on land before this step's move
  let x0 = NaN, z0 = NaN
  function ok(x, z, h) { const d = dry(x, z, h); return d === 0 || d < d0 } // a move that doesn't run (further) aground
  function bumped(impact) {
    const now = performance.now()
    if (impact < 0.4 || now - B.bumpT < 500) return
    B.bumpT = now
    thud(clamp(impact / 4, 0.3, 1))
    buzz(Math.round(clamp(impact * 12, 15, 60)))
  }
  let hits = 0
  function hit(p) { // pushed out of something ({ x, y }: y along z): bounce off it if heading into it
    hits++
    B.x += p.x; B.z += p.y
    const l = Math.hypot(p.x, p.y) || 1, vn = (Math.sin(B.h) * p.x + Math.cos(B.h) * p.y) / l * B.speed
    if (vn < 0) { bumped(-vn); B.speed *= 0.3 }
  }
  function refreshObstacles() { // ships and other players near the boat, 10 times a second
    obs = []
    try { if (city.ships?.nearby) for (const o of city.ships.nearby(B.x, B.z, 60)) obs.push(o) } catch (e) { console.warn('sail: ships.nearby', e) }
    try { if (city.multiplayer?.nearby) for (const o of city.multiplayer.nearby(B.x, B.z, 40)) obs.push(o) } catch (e) { console.warn('sail: multiplayer.nearby', e) }
    for (const o of goals.boats()) obs.push(o)
    for (const o of obs) o.at = performance.now()
  }
  function collideObstacles() {
    hits = 0
    const fx = Math.sin(B.h), fz = Math.cos(B.h), now = performance.now()
    for (let a = -2.2; a <= 2.21; a += 2.2) {
      const cx = B.x + fx * a, cz = B.z + fz * a
      for (const o of obs) {
        const s = Math.sin(o.heading), c = Math.cos(o.heading), age = (now - o.at) / 1000 // moved on since the query
        const p = circleBox(cx, cz, 1.2, o.x + s * o.speed * age, o.z + c * o.speed * age, s, c, (o.length || 4) / 2, (o.width || 2) / 2)
        if (p) hit(p)
      }
      const P = city.landmarks?.piers
      if (P) for (let i = 0; i < P.length; i += 5) {
        if (Math.abs(P[i] - cx) > 40 || Math.abs(P[i + 1] - cz) > 40) continue
        const p = circleBox(cx, cz, 1.2, P[i], P[i + 1], Math.cos(P[i + 4]), -Math.sin(P[i + 4]), P[i + 2], P[i + 3])
        if (p) hit(p)
      }
    }
  }
  // the boat on the waves: the sea's height under the bow, the stern and either side lifts, pitches and rolls her
  // (on a spring, so she has some weight); planing lifts the bow
  function place(t, dt) {
    const fx = Math.sin(B.h), fz = Math.cos(B.h), H = water.heightAt
    const hb = H(B.x + fx * 2.8, B.z + fz * 2.8), hs = H(B.x - fx * 2.6, B.z - fz * 2.6), hl = H(B.x + fz * 1.3, B.z - fx * 1.3), hr = H(B.x - fz * 1.3, B.z + fx * 1.3)
    const ty = (hb + hs + hl + hr) / 4 + 0.05 * B.plane
    if (dt > 0) { ride.vy += ((ty - ride.y) * 45 - ride.vy * 9) * Math.min(dt, 0.05); ride.y += ride.vy * Math.min(dt, 0.05) } else { ride.y = ty; ride.vy = 0 }
    ride.slope = (hb - hs) / 5.4
    const k = 1 - Math.exp(-7 * dt), pitch = Math.atan(ride.slope) + 0.045 * B.plane + 0.02 * Math.sin(t * 1.1) * (1 - water.uniforms.uMix.value)
    const p0 = ride.pitch
    ride.pitch += (pitch - ride.pitch) * k
    ride.slam = dt > 0 ? Math.max(0, (p0 - ride.pitch) / dt) : 0 // the bow dropping into a trough (rad/s)
    ride.roll += (Math.atan((hr - hl) / 2.6) * 0.8 - ride.roll) * k
    boat.position.set(B.x, B.y + ride.y, B.z)
    boat.rotation.set(0, B.h + Math.PI, 0)
    hull.rotation.set(ride.pitch, 0, ride.roll - B.heel)
    boom.rotation.y = B.boom
    jib.rotation.y = B.boom * 0.85
  }
  function wakeStep(t) { // a sample every TRAIL_DT; the newest point rides the stern; every point rides the waves
    const fx = Math.sin(B.h), fz = Math.cos(B.h), T = trail, lift = 0.14 + 0.35 * water.wave.A
    if (t - T.at > TRAIL_DT || !T.n) { T.at = t; T.head = (T.head + 1) % TRAIL; T.n = Math.min(TRAIL, T.n + 1) }
    const H = T.head
    T.x[H] = B.x - fx * 3; T.z[H] = B.z - fz * 3; T.h[H] = B.h; T.s[H] = Math.max(0, B.speed) * (1 + 0.5 * B.plane); T.t[H] = t
    for (let k = 0; k < TRAIL; k++) {
      const i = (H - k + TRAIL) % TRAIL, age = t - T.t[i], rx = -Math.cos(T.h[i]), rz = Math.sin(T.h[i])
      const off = 0.5 + 0.35 * age * T.s[i], th = 0.3 + 0.1 * age
      const al = k < T.n ? 0.55 * (1 - clamp(age / (TRAIL * TRAIL_DT), 0, 1)) ** 1.5 * clamp(T.s[i] / 2.5, 0, 1) : 0
      const yl = B.y + water.heightAt(T.x[i] - rx * off, T.z[i] - rz * off) + lift, yr = B.y + water.heightAt(T.x[i] + rx * off, T.z[i] + rz * off) + lift
      for (let v = 0; v < 4; v++) {
        const o = v === 0 ? -off - th : v === 1 ? -off : v === 2 ? off : off + th, j = (k * 4 + v) * 3
        wpos[j] = T.x[i] + rx * o; wpos[j + 1] = v < 2 ? yl : yr; wpos[j + 2] = T.z[i] + rz * o
        wcol[(k * 4 + v) * 4 + 3] = v === 0 || v === 3 ? al * 0.4 : al
      }
    }
    wgeo.attributes.position.needsUpdate = true; wgeo.attributes.color.needsUpdate = true
    wake.visible = true
  }
  function sprayStep(dt, t) { // droplets: thrown off either bow, then falling; more when slamming, surfing or planing
    const fx = Math.sin(B.h), fz = Math.cos(B.h), s = Math.max(0, B.speed)
    const rate = s < 2.5 ? 0 : (s - 2.5) * 6 * (0.3 + B.plane) + smooth(0.08, 0.4, ride.slam) * 160 * smooth(2, 4, s) + B.surf * 40
    if (ride.slam > 0.2 && s > 3 && t - splashAt > 0.6) { splashAt = t; splash(Math.min(1, ride.slam * 2)) }
    sprayNext += rate * dt
    for (let i = 0; i < SPRAY && sprayNext >= 1; i++) {
      if (sage[i] < 1) continue
      sprayNext--
      const sd = Math.random() < 0.5 ? -1 : 1, up = 1.5 + Math.random() * 2.5, out = 1.5 + Math.random() * 2
      spos[i * 3] = B.x + fx * 2.6 - fz * sd * 0.6; spos[i * 3 + 1] = B.y + ride.y + 0.3; spos[i * 3 + 2] = B.z + fz * 2.6 + fx * sd * 0.6
      svel[i * 3] = fx * s * 0.8 - fz * sd * out; svel[i * 3 + 1] = up; svel[i * 3 + 2] = fz * s * 0.8 + fx * sd * out
      sage[i] = 0
    }
    sprayNext = Math.min(sprayNext, 4)
    for (let i = 0; i < SPRAY; i++) {
      if (sage[i] >= 1) { scol[i * 4 + 3] = 0; continue }
      sage[i] += dt / 0.9
      svel[i * 3 + 1] -= 9.81 * dt
      spos[i * 3] += svel[i * 3] * dt; spos[i * 3 + 1] += svel[i * 3 + 1] * dt; spos[i * 3 + 2] += svel[i * 3 + 2] * dt
      scol[i * 4 + 3] = 0.75 * (1 - sage[i])
    }
    sgeo.attributes.position.needsUpdate = true; sgeo.attributes.color.needsUpdate = true
  }
  function publish() {
    player.x = B.x; player.y = B.y + ride.y; player.z = B.z; player.heading = B.h; player.speed = B.speed
  }

  // ---------------------------------------------------------------- the sea around her, each frame
  const seaAt = (x, z) => B.y + water.heightAt(x, z) // the water's surface there now
  function seaStep(dt, time) {
    const fx = Math.sin(B.h), fz = Math.cos(B.h)
    water.setWind(wind.base, water.wave.x, water.wave.z) // (a new wind speed only; turned with the weather below)
    water.amp(Math.hypot(wind.x, wind.z) * 0.6 + wind.base * 0.4)
    water.update(time, B.x + fx * 30, B.z + fz * 30, B.y, seaMix)
    water.uniforms.uBoat.value.set(B.x, B.z, B.h, Math.max(0, B.speed))
    if (state === 'play') water.stepGusts(dt, B.x, B.z, wind.x, wind.z)
    const c = water.shoreCentre(), now = performance.now()
    if (Math.hypot(B.x - c.x, B.z - c.z) > 220 || (shoreDirty && now > shoreDirty)) { shoreDirty = 0; water.buildShore(B.x, B.z, wet) }
  }
  function onWeather() { // the weather changed (a storm picked, or the live wind turned): the sea follows
    if (state === 'off') return
    windStep(10, 0)
    const from = Math.atan2(-wind.x, -wind.z)
    water.setWind(wind.base, -Math.sin(from), -Math.cos(from))
  }
  const offWeather = city.on('weather', onWeather)

  // ---------------------------------------------------------------- per frame
  function frame(dt, time) {
    const now = performance.now()
    if (state === 'in' || state === 'out') {
      const e = clamp((now - t0) / (state === 'in' ? 2600 : 2200), 0, 1)
      pose(e)
      seaStep(dt, time)
      place(time, 0)
      if (e >= 1) {
        if (state === 'out') return finish()
        state = 'play'; playT = time
        ui.read.hidden = ui.btns.hidden = ui.touch.hidden = false
        let n = 0
        try { n = +localStorage.getItem('sail.learned') || 0; localStorage.setItem('sail.learned', String(n + 1)) } catch {}
        if (n < 2) showLearn()
        showHelp(touchy ? `Steer ${kb('left')} ${kb('right')} · help the sail with ${kb('ease')} / ${kb('trim')}` : `${kb('left')} ${kb('right')} steer · ${kb('trim')} ${kb('ease')} trim / ease · <kbd>G</kbd> goals · <kbd>H</kbd> how to · <kbd>Esc</kbd> map`, city.ui.compact ? 5000 : 9000)
      }
      return
    }
    if (state !== 'play' || !(dt > 0)) return
    if (now - obsAt > 100) { obsAt = now; refreshObstacles() }
    sailStep(dt, time)
    seaStep(dt, time)
    place(time, dt)
    wakeStep(time)
    sprayStep(dt, time)
    const tgt = tgtNow = goals.step(dt, time, B, seaAt, wet)
    feel(time)
    publish()
    chasePose(dt)
    const fov = chaseFov(), far = fogFar + 60
    if (Math.abs(pcam.fov - fov) > 0.05 || pcam.near !== 1 || pcam.far !== far) { pcam.fov += (fov - pcam.fov) * Math.min(1, dt * 3); pcam.near = 1; pcam.far = far; pcam.updateProjectionMatrix() }
    pcam.position.copy(chase.pos); pcam.up.set(0, 1, 0); pcam.lookAt(chase.look)
    opts.focus.set(B.x + Math.sin(B.h) * 150, B.y, B.z + Math.cos(B.h) * 150)
    opts.radius = 900; opts.shadowRadius = 300
    if (!ui.learn.hidden) demo(time)
    if (now - hudAt > 100) { hudAt = now; hud(time, tgt) }
    if (now - skyAt > 1000) { skyAt = now; atmosphere(1) }
  }
  // moments worth a word: surfing, planing, a gust
  function feel(t) {
    if (B.surfT > 0.6 && t - seenAt.surf > 25) { seenAt.surf = t; popup('Surfing!'); buzz(20) }
    if (B.plane > 0.7 && t - seenAt.plane > 40) { seenAt.plane = t; popup('Planing!') }
    if (B.gust > 0.15 && t - seenAt.gust > 12) { seenAt.gust = t; splash(0.8); buzz(15) } // into a gust: a hiss of spray (goals.js counts the ride)
  }

  // ---------------------------------------------------------------- the how-to card: the boat turning through the wind
  // on a phone a hint would sit under an open card: none then
  const cards = () => document.body.classList.toggle('sl-learning', touchy && (!ui.learn.hidden || !ui.goals.hidden))
  function showLearn() { ui.learn.hidden = false; ui.goals.hidden = true; learnT = performance.now(); cards() }
  function hideLearn() { ui.learn.hidden = true; cards() }
  let learnT = 0
  function demo(t) {
    const a = 165 * Math.sin(t * 0.42), twa = Math.abs(a) // the demo boat's heading off the wind (degrees, + right)
    ui.demo.setAttribute('transform', `translate(80 82) rotate(${a.toFixed(1)})`)
    const sa = twa < 36 ? 0 : -(6 + (1 - idealSheet(twa)) * 82) * Math.sign(a) // to leeward
    ui.demoSail.setAttribute('transform', `rotate(${(twa < 36 ? 8 * Math.sin(t * 14) : sa).toFixed(1)} 0 ${-2 * 2.1})`)
    const st = POS.find((p) => twa < p[0])[1], sp = polar(twa)
    if (ui.st.textContent !== st) { ui.st.textContent = st; ui.st.style.color = twa < 36 ? '#ffb4a0' : twa >= 60 && twa < 130 ? '#9fe0b0' : '#cfe6f0' }
    ui.spd.style.width = `${Math.round(sp * 100)}%`
    // it goes by itself once she's sailing and the player has been steering a while
    if (performance.now() - learnT > 25000 && B.speed > 1) hideLearn()
  }

  // ---------------------------------------------------------------- hints: what to do now, one at a time
  const hint = { name: '', at: 0, quiet: 0, shown: {} }
  function showHelp(html, ms) {
    ui.help.innerHTML = html; ui.help.hidden = false; ui.help.classList.remove('fade')
    clearTimeout(helpT); helpT = ms ? setTimeout(() => ui.help.classList.add('fade'), ms) : 0
  }
  function hints(t) {
    const awayKey = B.from > 0 ? 'right' : 'left' // bear away: turn the bow away from the wind's side
    const nearGust = water.gusts.some((g) => g.r > 0 && g.fade > 0.5 && Math.hypot(g.x - B.x, g.z - B.z) < g.r + 140)
    const pick = (name, html, cond, max = 3) => (cond && (name === hint.name || (hint.shown[name] || 0) < max) ? [name, html] : null)
    const h = pick('irons', `Too close to the wind: bear away, steer ${kb(awayKey)}`, B.twa < 36, 99)
      || pick('ease', `Ease the sail ${kb('ease')}: the wind is further behind you now`, B.sheet - B.ideal > 0.2 && I.sheet >= 0)
      || pick('trim', `The sail is flapping: trim it in ${kb('trim')}`, B.ideal - B.sheet > 0.2 && I.sheet <= 0 && B.twa > 40)
      || pick('run', 'Dead downwind is slow: head up a little onto a broad reach', B.twa > 168 && B.speed > 0.8, 2)
      || pick('gust', 'A dark ruffled patch on the water is a gust: sail into it for speed', nearGust && B.gust < 0.05, 2)
      || pick('goals', `Want a goal? Open ${city.ui.compact ? '<b>⋯</b> → ' : ''}<b>Goals</b>${touchy ? '' : ' (<kbd>G</kbd>)'}: race three rivals round the buoys, dock, or collect the sights`, t - playT > 20 && goals.found === 0 && goals.S.mode !== 'race', 1)
    if (h) {
      if (h[0] !== hint.name && t - hint.at > 1.5) { hint.name = h[0]; hint.at = t; hint.shown[h[0]] = (hint.shown[h[0]] || 0) + 1; showHelp(h[1], city.ui.compact ? 4500 : 0) } // phones: a moment, then out of the way
      hint.quiet = t
    } else if (hint.name && t - hint.quiet > 2.5) { hint.name = ''; ui.help.classList.add('fade') }
  }

  // ---------------------------------------------------------------- goals panel
  function toggleGoals() {
    if (!ui.goals.hidden) { ui.goals.hidden = true; cards(); return }
    const G = goals, race = G.S.mode === 'race'
    ui.goals.innerHTML = `<h3>Sights · ${G.found} of ${G.sights.length}</h3>
      <div class="sights">${G.sights.map((s) => `<span class="${G.has(s.name) ? 'got' : ''}">${s.name}</span>`).join('')}</div>
      <div class="row"><span>Beacon on the nearest sight</span><button data-show>${G.S.show ? 'On' : 'Off'}</button></div>
      <h3 style="margin-top:8px">Regattas · 3 rivals and your ghost</h3>
      ${G.courses.map((c, i) => `${c.dock && !G.courses[i - 1].dock ? '<h3 style="margin-top:8px">Docking · stop in the ring</h3>' : ''}<div class="row"><span>${G.medal(c.id)} ${c.name}<small>${c.dock ? '' : `${c.pts.length - 1} legs · `}best ${G.best(c.id) ? fmtTime(G.best(c.id)) : '–'}</small></span><button data-race="${c.id}">${race && G.S.race.c.id === c.id ? 'Restart' : c.dock ? 'Dock' : 'Race'}</button></div>`).join('')}
      <div class="row"><span><small>Gusts ridden ${G.tally.gusts} · sea life spotted ${G.tally.spotted}</small></span></div>
      ${race ? '<div class="row"><span></span><button data-quit>Stop racing</button></div>' : ''}`
    ui.goals.hidden = false; hideLearn()
    q(ui.goals, '[data-show]').onclick = () => { G.S.show = !G.S.show; toggleGoals(); toggleGoals() }
    for (const b of ui.goals.querySelectorAll('[data-race]')) b.onclick = () => {
      const p = G.startRace(b.dataset.race)
      ui.goals.hidden = true; cards()
      if (p) { teleport(p.x, p.z, p.h); popup(G.S.race.c.dock ? 'Through the buoy, then stop at the dock' : 'Through the start buoy: beat the fleet', 3000) }
    }
    const qb = q(ui.goals, '[data-quit]'); if (qb) qb.onclick = () => { G.quitRace(); ui.goals.hidden = true; cards() }
  }

  const POS = [[36, 'In irons: bear away'], [60, 'Close-hauled'], [80, 'Close reach'], [110, 'Beam reach'], [150, 'Broad reach'], [181, 'Running']]
  function hud(t, tgt) {
    ui.v.textContent = (Math.max(0, B.speed) * KN).toFixed(1)
    ui.w.textContent = String(Math.round(Math.hypot(wind.x, wind.z) * KN))
    ui.gust.textContent = B.gust > 0.08 ? `gust +${Math.round(B.gust * 100)}%` : ''
    const pos = POS.find((p) => B.twa < p[0])[1]
    if (ui.pos.textContent !== pos) { ui.pos.textContent = pos; ui.sub.classList.toggle('irons', B.twa < 36) }
    // the gauge: the wind rose turned to where the wind comes from, relative to the bow; the trim against the best
    ui.rose.style.transform = `rotate(${(-B.from / RAD).toFixed(1)}deg)`
    ui.rose.style.transformOrigin = '32px 32px'
    ui.sail.setAttribute('transform', `rotate(${(B.boom / RAD * -1).toFixed(1)} 0 ${-2 * 1.25})`)
    ui.sh.style.width = `${Math.round(B.sheet * 100)}%`
    ui.sh.classList.toggle('ok', Math.abs(B.sheet - B.ideal) < 0.1)
    ui.id.style.left = `${(B.ideal * 100).toFixed(1)}%`
    // the pill: the next sight or race mark, its arrow relative to where the camera looks
    if (tgt) {
      const view = Math.atan2(chase.look.x - chase.pos.x, chase.look.z - chase.pos.z), d = Math.hypot(tgt.x - B.x, tgt.z - B.z)
      ui.ar.style.transform = `rotate(${(-wrap(Math.atan2(tgt.x - B.x, tgt.z - B.z) - view) / RAD).toFixed(0)}deg)`
      ui.tn.textContent = tgt.name
      ui.td.textContent = d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`
      ui.tt.textContent = tgt.time != null ? fmtTime(tgt.time) : ''
      ui.tgt.classList.toggle('race', tgt.kind === 'race')
      ui.tgt.hidden = false
      const home = city.ui.compact ? ui.read.lastElementChild : document.body // phones: a line in the readout
      if (ui.tgt.parentElement !== home) home.append(ui.tgt)
    } else ui.tgt.hidden = true
    hints(t)
    // the wake and the spray are drawn after the colour grade: grade them by hand (dusk, night, a storm's gloom)
    const G = city.post.uniforms.tint.value, lk = 0.45 + 0.55 * (1 - city.light.night)
    wake.material.color.setRGB(G.x * lk, G.y * lk, G.z * lk); spray.material.color.copy(wake.material.color)
    if (sea && !muted) {
      const tt = ac.currentTime, s = Math.max(0, B.speed)
      sea.hull.g.gain.setTargetAtTime(0.012 + 0.01 * s + 0.002 * Math.hypot(wind.x, wind.z) + 0.01 * B.plane, tt, 0.3)
      sea.hull.f.frequency.setTargetAtTime(250 + s * 110 + 300 * B.plane, tt, 0.3)
      sea.wind.g.gain.setTargetAtTime(0.002 + 0.0006 * B.aws * B.aws * 0.1 + 0.02 * B.gust, tt, 0.4)
      sea.wind.f.frequency.setTargetAtTime(500 + B.aws * 45, tt, 0.4)
    } else if (sea) for (const c of Object.values(sea)) c.g.gain.setTargetAtTime(0, ac.currentTime, 0.1)
  }

  // ---------------------------------------------------------------- keys (taken before the drive plugin's D)
  const CONTROL = new Set(MOVE_KEYS)
  function onKey(e) {
    if (state === 'off' || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.code === 'Escape') { if (!ui.goals.hidden) { ui.goals.hidden = true; cards() } else if (!ui.learn.hidden) hideLearn(); else exit(); return }
    if (CONTROL.has(e.code)) { e.preventDefault(); e.stopPropagation(); if (state === 'play') keys.add(e.code) }
    if (state !== 'play' || e.repeat) return
    if (e.code === 'KeyM') setMuted(!muted)
    if (e.code === 'KeyG') toggleGoals()
    if (e.code === 'KeyH' || e.key === '?') ui.learn.hidden ? showLearn() : hideLearn()
  }
  const onKeyUp = (e) => keys.delete(e.code)
  const onBlur = () => { keys.clear(); for (const k in touchState) touchState[k] = false }
  const onResize = () => { fitCamera(); if (state !== 'off') city.requestRender() }
  const onVis = () => { if (document.hidden) { onBlur(); ac?.suspend() } else if (ac && state !== 'off') ac.resume() }
  addEventListener('keydown', onKey, true)
  addEventListener('keyup', onKeyUp)
  addEventListener('blur', onBlur)
  addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVis)

  if (location.search.includes('drivedebug')) window.sailDebug = { B, wind, goals, wet, teleport, get state() { return state }, start: (x, z) => { const w = nearestWater(x, z, 3000); if (w) start(w.x, w.z) }, toggleGoals, set auto(v) { auto = v ? { tack: 0, tackT: 0 } : null } }
  return {
    dispose() {
      cancelPick()
      if (state !== 'off') finish()
      for (const f of offTiles) f()
      offQuality(); offWeather()
      removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKeyUp); removeEventListener('blur', onBlur); removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVis)
      button.remove()
      delete city.models?.boat
      for (const e of ui.all) e.remove()
      css.remove()
      wgeo.dispose(); wake.material.dispose(); sgeo.dispose(); spray.material.dispose(); dot.dispose()
      water.dispose(); goals.dispose()
      src?.stop(); out?.disconnect()
      sky.dispose()
    },
  }
}
