// Sail: a small sloop on the real water (English Bay, False Creek, Burrard Inlet, Howe Sound, the Fraser…).
// The toolbar's "Sail" button asks for a spot on the water, then dives from the map into a chase view behind the
// boat; Esc flies back. The wind is the weather plugin's (live from Open-Meteo, a gale when a storm is picked), with
// gentle gusts: no sailing into it (the no-go zone), fastest across it on a beam reach, slower running before it.
// The sails trim themselves; W / S sheet in and ease out (S all the way stops the boat). Tacks and jibes happen as
// you steer through the wind. The shore comes from the map tiles' water masks (the coarse base map until they
// load): the boat bumps and stops there. Ships (city.ships), bridge piers (city.landmarks.piers) and other players
// (city.multiplayer) are solid too. Published as city.player { mode: 'boat' }, with city.models.boat for others.

const VMAX = 9 // m/s: a small keelboat in a gale (the server allows 12 for boats)
// share of the best speed by true wind angle (degrees off the bow): nothing in the no-go zone, best on a beam reach
const POLAR = [0, 0, 34, 0, 45, 0.68, 60, 0.86, 95, 1, 130, 0.9, 180, 0.62]
const HULL = [3.1, 0, -2.8, 0, 0.3, 1.15, 0.3, -1.15] // [ahead, right] points that must stay on the water (metres)
const TRAIL = 48, TRAIL_DT = 0.2 // wake: samples, seconds apart
const RAD = Math.PI / 180, KN = 1.944
const COLOUR = '#2f6f8f'
const EASE = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
function polar(deg) {
  for (let i = 2; i < POLAR.length; i += 2) if (deg <= POLAR[i]) return POLAR[i - 1] + ((POLAR[i + 1] - POLAR[i - 1]) * (deg - POLAR[i - 2])) / (POLAR[i] - POLAR[i - 2])
  return POLAR[POLAR.length - 1]
}

// A 6.6 m sloop, flat-shaded like the map. Forward -z, origin on the waterline. userData: hull (heels and pitches),
// boom and jib (turn about y), main and jibSail (flap); update(dt, speed) bobs it, for other players' boats.
export function makeBoat(THREE, colour = COLOUR) {
  const boat = new THREE.Group(), hull = new THREE.Group()
  const M = (color, extra) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra })
  const deck = M(0xe9dcc3), cream = M(0xf3ead8), spar = M(0xd9d9d4), sailM = M(0xfbfaf2, { side: THREE.DoubleSide })
  const plan = new THREE.Shape([[-0.95, -3.1], [0.95, -3.1], [1.2, -1], [1.15, 0.8], [0.75, 2.3], [0, 3.5], [-0.75, 2.3], [-1.15, 0.8], [-1.2, -1]].map(([x, y]) => new THREE.Vector2(x, y)))
  const hg = new THREE.ExtrudeGeometry(plan, { depth: 1.1, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, -0.45, 0)
  const p = hg.attributes.position
  for (let i = 0; i < p.count; i++) if (p.getY(i) < 0) p.setX(i, p.getX(i) * 0.5) // a V bottom
  hg.computeVertexNormals()
  hull.add(new THREE.Mesh(hg, [deck, M(new THREE.Color(colour))])) // caps: the deck; sides: the hull colour
  const box = (w, h, l, m, x, y, z) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m); b.position.set(x, y, z); hull.add(b); return b }
  box(1.3, 0.5, 1.9, cream, 0, 0.88, -0.3) // the cabin
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 8.6, 6), spar); mast.position.set(0, 4.95, -0.9); hull.add(mast)
  const tri = (a, b, c) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3)); g.computeVertexNormals(); return new THREE.Mesh(g, sailM) }
  const boom = new THREE.Group(); boom.position.set(0, 1.5, -0.9); hull.add(boom)
  const bm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 3).translate(0, 0, 1.5), spar); boom.add(bm)
  const main = tri([0, 0.05, 0.05], [0, 7.6, 0.02], [0, 0.05, 2.95]); boom.add(main)
  const jib = new THREE.Group(); jib.position.set(0, 0.75, -3.15); hull.add(jib)
  const jibSail = tri([0, 0, 0], [0, 7.2, 2.2], [0, 0.35, 2.3]); jib.add(jibSail)
  boat.add(hull)
  boat.userData = { hull, boom, jib, main, jibSail }
  let t = Math.random() * 10
  boat.update = (dt) => { t += dt; hull.position.y = 0.06 * Math.sin(t * 1.4); hull.rotation.set(0.02 * Math.sin(t * 1.1), 0, 0.12 + 0.03 * Math.sin(t * 0.9)); boom.rotation.y = jib.rotation.y = -0.4 }
  return boat
}

export default function sail(city) {
  const { THREE } = city
  const v3 = new THREE.Vector3(), v4 = new THREE.Vector3()

  // ================================================================ where the water is
  const masks = new Map() // detail tile (i * 8192 + j) → tile, whose .water is a 256² mask (1 = water)
  const tkey = (i, j) => i * 8192 + j
  const offTiles = [
    city.world.eachTile((t) => { if (t.level === 0) masks.set(tkey(t.i, t.j), t) }),
    city.on('tile:unload', (t) => { if (t.level === 0) masks.delete(tkey(t.i, t.j)) }),
  ]
  let base = null // the core's base map (1 px = 64 m; water is (40, 98, 150)) for where no detail tile is loaded
  function baseWet(x, n) {
    const g = city.tiles?.coarse, img = city.tiles?.baseMesh?.material?.map?.image
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
  // the wake: two foam lines spreading at the Kelvin angle behind the stern, fading; written in place every frame
  const wpos = new Float32Array(TRAIL * 12), wcol = new Float32Array(TRAIL * 16).fill(1)
  const wgeo = new THREE.BufferGeometry()
  wgeo.setAttribute('position', new THREE.BufferAttribute(wpos, 3).setUsage(THREE.DynamicDrawUsage))
  wgeo.setAttribute('color', new THREE.BufferAttribute(wcol, 4).setUsage(THREE.DynamicDrawUsage))
  const widx = []
  for (let k = 0; k < TRAIL - 1; k++) for (const s of [0, 2]) { const a = k * 4 + s, c = a + 4; widx.push(a, a + 1, c, a + 1, c + 1, c) }
  wgeo.setIndex(widx)
  const wake = new THREE.Mesh(wgeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }))
  wake.frustumCulled = false
  const trail = { x: new Float32Array(TRAIL), y: new Float32Array(TRAIL), z: new Float32Array(TRAIL), h: new Float32Array(TRAIL), s: new Float32Array(TRAIL), t: new Float32Array(TRAIL), head: 0, n: 0, at: 0 }

  // ================================================================ sound: the sea along the hull, a bump
  let ac = null, sea = null, muted = false
  try { muted = localStorage.getItem('sail.muted') === '1' } catch {}
  function audio() {
    if (ac) return ac
    try { ac = new AudioContext() } catch { return null }
    const len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain()
    src.buffer = buf; src.loop = true; f.type = 'lowpass'; f.frequency.value = 400; g.gain.value = 0
    src.connect(f); f.connect(g); g.connect(ac.destination); src.start()
    sea = { f, g }
    return ac
  }
  function thud(k) {
    if (!audio() || muted) return
    const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain()
    o.type = 'triangle'; o.frequency.value = 65
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.2 * k, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
    o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + 0.4)
  }
  const buzz = (p) => { try { navigator.vibrate?.(p) } catch {} }
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
    .sl-read { left: 12px; top: 12px; display: flex; align-items: center; gap: 10px; padding: 7px 14px 7px 7px; font-variant-numeric: tabular-nums; }
    .sl-dial { flex: none; width: 46px; height: 46px; border-radius: 50%; display: grid; place-items: center; background: rgba(255,255,255,.08); border: 1px solid rgba(225,240,255,.14); }
    .sl-dial svg { width: 30px; height: 30px; transition: transform .12s linear; }
    .sl-read .sp { font-size: 15px } .sl-read .sp b { font-size: 18px; font-weight: 700 }
    .sl-read .sub { font-size: 12px; color: #d6dee4; white-space: nowrap }
    .sl-read .sub.irons [data-pos] { color: #ffd38a }
    .sl-sheet { margin-top: 4px; height: 4px; width: 100%; border-radius: 2px; background: rgba(255,255,255,.14); overflow: hidden; }
    .sl-sheet i { display: block; height: 100%; background: #9fd3e6; border-radius: 2px; }
    .sl-btns { right: 12px; top: 12px; display: flex; gap: 6px; }
    .sl-btns .short { display: none }
    .sl-help { left: 50%; bottom: 52px; transform: translateX(-50%); padding: 6px 12px; color: #e3e9ee; font-size: 12px; white-space: nowrap; transition: opacity .6s; }
    .sl-help.fade { opacity: 0 }
    .sl-pop { left: 50%; top: 34%; transform: translate(-50%, -50%); padding: 8px 18px; font-size: 18px; font-weight: 700; color: #ffe1a8; opacity: 0; transition: opacity .3s; }
    .sl-pop.on { opacity: 1 }
    .sl-pick { left: 50%; top: 12px; transform: translateX(-50%); padding: 8px 10px 8px 14px; display: flex; gap: 10px; align-items: center; font-size: 14px; }
    body.sl-picking canvas { cursor: crosshair }
    body.sl-picking #hint { display: none }
    .sl-touch { inset: auto 0 0 0; height: 170px; display: none; }
    .sl-touch button { position: absolute; bottom: 52px; width: 74px; height: 74px; border-radius: 50%; font-size: 15px; font-weight: 650; background: rgba(28,34,40,.5); border: 2px solid rgba(225,240,255,.35); touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
    .sl-touch button.on { background: rgba(70,150,190,.75) }
    .sl-touch .l { left: 16px } .sl-touch .r { left: 100px } .sl-touch .trim { right: 16px; height: 100px; border-radius: 22px } .sl-touch .ease { right: 100px; width: 66px; height: 66px }
    body.sail-on.sl-touchy .sl-touch { display: block }
    body.sail-on.sl-touchy .sl-help { display: none }
    body.sail-on #bar, body.sail-on #hint, body.sail-on #about, body.sail-on #tools, body.sail-on .tool-panel, body.sail-on #credits { display: none !important }
    @media (max-width: 640px) { .sl-btns .opt { display: none } .sl-pick { font-size: 13px; white-space: nowrap; top: 64px } }
    .compact .sl-read { left: var(--sl); top: var(--st); padding: 5px 12px 5px 5px; gap: 8px; }
    .compact .sl-dial { width: 40px; height: 40px }
    .compact .sl-btns { right: var(--sr); top: var(--st); }
    .compact .sl-btns .opt, .compact .sl-btns .long { display: none } .compact .sl-btns .short { display: inline }
    .compact .sl-btns [data-exit] { width: 78px; height: 44px; padding: 0; border-radius: 12px; }
    .compact .sl-pick { top: calc(var(--st) + 52px); left: var(--sl); right: var(--sr); transform: none; justify-content: space-between; white-space: normal; }
    .compact .sl-pick button { min-height: 44px; padding: 0 14px; flex: none; }
    .compact .sl-touch { --pb: max(16px, calc(env(safe-area-inset-bottom) + 4px)); height: auto; top: 0; }
    .compact .sl-touch button { bottom: var(--pb); }
    .compact .sl-touch .l { left: var(--sl) } .compact .sl-touch .r { left: calc(var(--sl) + 84px) }
    .compact .sl-touch .trim { right: var(--sr) } .compact .sl-touch .ease { right: calc(var(--sr) + 86px) }`
  document.head.append(css)
  const el = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; d.hidden = true; document.body.append(d); return d }
  const ui = {
    read: el('sl sl-read card', `<div class="sl-dial" title="Wind"><svg viewBox="0 0 30 30"><path d="M15 27 V7 M8 13 L15 4 L22 13" fill="none" stroke="#9fd3e6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      <div><div class="sp"><b data-v>0.0</b> kn</div><div class="sub"><span data-pos></span> · wind <b data-w></b> kn</div><div class="sl-sheet" title="Sail: W trims in, S eases out"><i data-sh></i></div></div>`),
    btns: el('sl sl-btns', '<button class="opt" data-mute title="Sound (M)">Sound on</button><button data-exit title="Back to the map (Esc)" aria-label="Back to the map"><span class="long">Back to map</span><span class="short">‹ Map</span></button>'),
    help: el('sl sl-help card', 'A D or ← → to steer · W trims the sail in · S eases it out (all the way stops) · Esc to the map'),
    pop: el('sl sl-pop card', ''),
    pick: el('sl sl-pick card', '<span data-pt></span><button data-cancel>Cancel</button>'),
    touch: el('sl sl-touch', '<button class="l" data-k="left" aria-label="Steer left">◀</button><button class="r" data-k="right" aria-label="Steer right">▶</button><button class="ease" data-k="ease" aria-label="Ease the sail out">Ease</button><button class="trim" data-k="trim" aria-label="Trim the sail in">Trim</button>'),
  }
  const q = (e, s) => e.querySelector(s)
  Object.assign(ui, { all: [ui.read, ui.btns, ui.help, ui.pop, ui.pick, ui.touch], dial: q(ui.read, 'svg'), v: q(ui.read, '[data-v]'), pos: q(ui.read, '[data-pos]'), sub: q(ui.read, '.sub'),
    w: q(ui.read, '[data-w]'), sh: q(ui.read, '[data-sh]'), mute: q(ui.btns, '[data-mute]'), exit: q(ui.btns, '[data-exit]'), pt: q(ui.pick, '[data-pt]'), cancel: q(ui.pick, '[data-cancel]') })
  const touchState = { left: false, right: false, trim: false, ease: false }
  for (const b of ui.touch.querySelectorAll('[data-k]')) {
    const k = b.dataset.k, set = (on) => (e) => { e.preventDefault(); if (on && !touchState[k]) buzz(6); touchState[k] = on; b.classList.toggle('on', on); if (on) audio() }
    b.addEventListener('pointerdown', (e) => { try { b.setPointerCapture(e.pointerId) } catch {} set(true)(e) })
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, set(false))
    b.addEventListener('contextmenu', (e) => e.preventDefault())
  }
  ui.exit.onclick = () => exit()
  ui.cancel.onclick = () => cancelPick()
  ui.mute.onclick = () => setMuted(!muted)
  ui.mute.textContent = muted ? 'Sound off' : 'Sound on'
  let popT = 0, helpT = 0
  function popup(text) { ui.pop.textContent = text; ui.pop.hidden = false; requestAnimationFrame(() => ui.pop.classList.add('on')); clearTimeout(popT); popT = setTimeout(() => ui.pop.classList.remove('on'), 1400) }

  // ================================================================ state
  const pcam = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 1, 900)
  const opts = { focus: new THREE.Vector3(), radius: 900, shadowRadius: 300 }
  // the boat, in world x / z: heading h with forward (sin h, cos h), like city.traffic
  const B = { x: 0, y: 0, z: 0, h: 0, speed: 0, steer: 0, power: 0, heel: 0, boom: 0, side: 0, bumpT: 0, twa: 0, aws: 0 }
  const wind = { x: 3, z: -3 } // m/s towards, smoothed, with gusts
  const chase = { pos: new THREE.Vector3(), look: new THREE.Vector3(), yaw: 0 }
  const player = { mode: 'boat', vehicle: 'boat', colour: COLOUR, x: 0, y: 0, z: 0, heading: 0, speed: 0 }
  let state = 'off', anim = null, offFrame = null, t0 = 0, mapPose = null, fromPose = null, saved = null, down = null
  let hudAt = 0, skyAt = 0, obsAt = 0, fogFar = 850, obs = []
  const keys = new Set()

  const button = city.ui.addButton({ label: 'Sail', icon: '⛵', title: 'Sail a small boat on the real water, in the real wind', onClick: () => startPick() })

  // ---------------------------------------------------------------- pick where to start
  function startPick() {
    if (state === 'pick') return cancelPick()
    if (state !== 'off' || city.player) return
    city.ui.closeAll()
    state = 'pick'
    audio()
    ui.pt.textContent = `${touchy ? 'Tap' : 'Click'} the water where you want to set sail`
    ui.pick.hidden = false
    document.body.classList.add('sl-picking')
    city.canvas.addEventListener('pointerdown', onPickDown)
    city.canvas.addEventListener('pointerup', onPickUp)
  }
  function cancelPick() {
    if (state !== 'pick') return
    state = 'off'; down = null
    ui.pick.hidden = true
    document.body.classList.remove('sl-picking')
    city.canvas.removeEventListener('pointerdown', onPickDown)
    city.canvas.removeEventListener('pointerup', onPickUp)
  }
  const pointers = new Set()
  function onPickDown(e) { pointers.add(e.pointerId); down = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null }
  function onPickUp(e) { // a click or tap, not the end of a drag or a pinch
    pointers.delete(e.pointerId)
    const d = down; down = null
    if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 600) return
    const g = groundAt(e.clientX, e.clientY)
    const w = g && nearestWater(g.x, g.z, 3000)
    if (!w) { city.ui.toast('No water near there: try the bay or the inlet'); return }
    cancelPick()
    start(w.x, w.z)
  }
  // the ground under a screen point: march down the map camera's ray until it is below the terrain
  const ray = new THREE.Raycaster()
  function groundAt(cx, cy) {
    const r = city.canvas.getBoundingClientRect()
    ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), city.camera)
    const o = ray.ray.origin, d = ray.ray.direction
    if (d.y > -0.05) return null
    const below = (t) => o.y + d.y * t < city.world.heightAt(o.x + d.x * t, o.z + d.z * t)
    let a = (o.y - 2200) / -d.y, b = a
    for (let k = 0; k < 1000 && !below(b); k++) { a = b; b += 12 }
    if (!below(b)) return null
    for (let k = 0; k < 14; k++) { const m = (a + b) / 2; if (below(m)) b = m; else a = m }
    return { x: o.x + d.x * b, z: o.z + d.z * b }
  }

  function start(x, z) {
    document.activeElement?.blur?.()
    windStep(10, 0)
    // set off on a beam reach, the way with more water ahead
    const from = Math.atan2(-wind.x, -wind.z)
    let h = from + Math.PI / 2
    const open = (hh) => { let n = 0; for (let d = 20; d <= 200; d += 20) n += wet(x + Math.sin(hh) * d, z + Math.cos(hh) * d) ? 1 : 0; return n }
    if (open(from - Math.PI / 2) > open(h)) h = from - Math.PI / 2
    Object.assign(B, { x, z, h, y: city.world.heightAt(x, z), speed: 0, steer: 0, power: 0, heel: 0, boom: 0, side: 0 })
    trail.n = 0; trail.head = 0
    const C = city.camera, T = city.controls.target
    mapPose = { look: T.clone(), dir: C.position.clone().sub(T).normalize(), H: (C.top - C.bottom) / C.zoom, fov: 2 }
    saved = { bg: city.scene.background, fog: city.scene.fog }
    chasePose(0, true)
    city.scene.add(boat)
    city.overlay.add(wake)
    wake.visible = false
    place(0)
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
    city.player = player; city.emit('player', player)
  }
  function exit() {
    if (state === 'pick') return cancelPick()
    if (state !== 'play') return
    fromPose = { look: chase.look.clone(), dir: chase.pos.clone().sub(chase.look).normalize(), H: 2 * chase.pos.distanceTo(chase.look) * Math.tan((pcam.fov * Math.PI) / 360), fov: pcam.fov }
    state = 'out'; t0 = performance.now()
    for (const e of ui.all) e.hidden = true
    keys.clear()
    if (sea) sea.g.gain.setTargetAtTime(0, ac.currentTime, 0.3)
  }
  function finish() {
    state = 'off'
    city.view.release()
    offFrame?.(); offFrame = null
    anim?.(); anim = null
    city.scene.remove(boat)
    city.overlay.remove(wake)
    city.scene.background = saved.bg; city.scene.fog = saved.fog
    if (city.player === player) { city.player = null; city.emit('player', null) }
    document.body.classList.remove('sail-on', 'dlv-on', 'sl-touchy', 'dlv-touchy')
    city.requestRender()
  }

  // ---------------------------------------------------------------- camera (as the drive plugin's)
  function fitCamera() { pcam.aspect = innerWidth / innerHeight; pcam.updateProjectionMatrix() }
  const chaseFov = () => (innerWidth < innerHeight ? 72 : 58)
  function chasePose(dt, snap) {
    chase.yaw += wrap(B.h - chase.yaw) * (snap ? 1 : 1 - Math.exp(-2.2 * dt))
    const back = 15 + Math.max(0, B.speed) * 0.4
    v3.set(B.x - Math.sin(chase.yaw) * back, B.y + 6, B.z - Math.cos(chase.yaw) * back)
    v3.y = Math.max(v3.y, city.world.heightAt(v3.x, v3.z) + 2) // a narrow channel: stay above the bank
    if (snap) chase.pos.copy(v3); else chase.pos.lerp(v3, 1 - Math.exp(-6 * dt))
    v4.set(B.x + Math.sin(B.h) * 7, B.y + 2.2, B.z + Math.cos(B.h) * 7)
    if (snap) chase.look.copy(v4); else chase.look.lerp(v4, 1 - Math.exp(-8 * dt))
  }
  const nd = new THREE.Vector3()
  function pose(e) { // the dive: from a nearly orthographic long lens over the map down to the chase camera
    const b = { look: chase.look, dir: nd.copy(chase.pos).sub(chase.look).normalize(), H: 2 * chase.pos.distanceTo(chase.look) * Math.tan((chaseFov() * Math.PI) / 360), fov: chaseFov() }
    const [S, E, k] = state === 'out' ? [mapPose, fromPose, 1 - e] : [mapPose, b, e]
    const ek = EASE(k)
    const look = v3.copy(S.look).lerp(E.look, ek), dir = v4.copy(S.dir).lerp(E.dir, ek).normalize()
    const H = Math.exp(Math.log(S.H) + (Math.log(E.H) - Math.log(S.H)) * ek)
    const fov = S.fov + (E.fov - S.fov) * smooth(0.3, 1, ek), dist = H / 2 / Math.tan((fov * Math.PI) / 360)
    pcam.fov = fov
    atmosphere(smooth(0.55, 1, ek))
    pcam.near = Math.max(1, dist * 0.04); pcam.far = dist + 4000 + (fogFar + 60 - 4000) * smooth(0.6, 1, ek)
    pcam.updateProjectionMatrix()
    pcam.position.copy(look).addScaledVector(dir, dist)
    pcam.up.set(0, 1, 0); pcam.lookAt(look)
    opts.focus.copy(look)
    const half = (H / 2) * Math.max(1, pcam.aspect)
    opts.radius = clamp(half * 1.5, 900, 8000)
    opts.shadowRadius = clamp(half * 1.9, 300, 6000)
  }
  // sky and fog: the weather plugin's street-level look (city.weather.atmosphere), else a fair day
  const skyTex = (() => { const c = document.createElement('canvas'); c.width = 2; c.height = 128; const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.cv = c; return t })()
  const fog = new THREE.Fog(0xcfe0ea, 120, 850)
  const ca = new THREE.Color(), cb = new THREE.Color(), cc = new THREE.Color()
  let skyKey = ''
  function atmosphere(k) { // k: 0 map look (no fog) .. 1 street look
    const A = city.weather?.atmosphere || { horizon: 0xcfe2ec, zenith: 0x84b7dc, fogNear: 140, fogFar: 850 }
    ca.setHex(A.horizon); cb.setHex(A.zenith)
    fogFar = A.fogFar
    const D = pcam.position.distanceTo(opts.focus)
    fog.color.copy(ca)
    fog.near = A.fogNear + (D * 4 + 2000) * (1 - k); fog.far = A.fogFar + (D * 8 + 4000) * (1 - k)
    city.scene.fog = fog
    const key = `${A.horizon}${A.zenith}${k.toFixed(2)}`
    if (key !== skyKey) {
      skyKey = key
      const g = skyTex.cv.getContext('2d'), bg = (saved.bg?.isColor ? saved.bg : cc.set(0x0e1620)).getStyle(), gr = g.createLinearGradient(0, 0, 0, 128)
      gr.addColorStop(0, cb.getStyle()); gr.addColorStop(0.55, ca.getStyle()); gr.addColorStop(1, ca.getStyle())
      g.globalAlpha = 1; g.fillStyle = bg; g.fillRect(0, 0, 2, 128)
      g.globalAlpha = k; g.fillStyle = gr; g.fillRect(0, 0, 2, 128)
      skyTex.needsUpdate = true
    }
    city.scene.background = skyTex
  }

  // ---------------------------------------------------------------- wind and sailing
  function windStep(dt, t) {
    const W = city.weather || {}
    let wx = 3, wz = -3 // a south-westerly until the weather plugin answers
    if (Array.isArray(W.wind)) { wx = W.wind[0]; wz = W.wind[1] }
    else if (typeof W.wind === 'number') { const f = (W.windFrom ?? 225) * RAD; wx = -Math.sin(f) * W.wind; wz = Math.cos(f) * W.wind }
    const s = Math.hypot(wx, wz) || 1
    // never quite becalmed (cozy), a gale when a storm is picked, and slow gusts and shifts on top
    const want = Math.max(clamp(s, 3, 15), W.kind === 'storm' ? 12 : 0) * (1 + 0.15 * Math.sin(t * 0.31) * Math.sin(t * 0.17 + 1.3)) / s
    const veer = 0.07 * Math.sin(t * 0.05), c = Math.cos(veer), sn = Math.sin(veer), k = 1 - Math.exp(-0.6 * dt)
    wind.x += ((wx * c - wz * sn) * want - wind.x) * k
    wind.z += ((wx * sn + wz * c) * want - wind.z) * k
  }
  const I = { steer: 0, sheet: 0 }
  function input() {
    const L = keys.has('ArrowLeft') || keys.has('KeyA') || touchState.left, R = keys.has('ArrowRight') || keys.has('KeyD') || touchState.right
    const up = keys.has('ArrowUp') || keys.has('KeyW') || touchState.trim, dn = keys.has('ArrowDown') || keys.has('KeyS') || touchState.ease
    I.steer = (L ? 1 : 0) - (R ? 1 : 0); I.sheet = (up ? 1 : 0) - (dn ? 1 : 0)
  }
  function sailStep(dt, t) {
    windStep(dt, t)
    input()
    B.power = clamp(B.power + I.sheet * 0.8 * dt, 0, 1)
    const fx = Math.sin(B.h), fz = Math.cos(B.h), ws = Math.hypot(wind.x, wind.z)
    const from = wrap(Math.atan2(-wind.x, -wind.z) - B.h) // where the true wind comes from, off the bow
    B.twa = Math.abs(from) / RAD
    // the apparent wind (true wind minus the boat's own), and which side the sail goes to (+1: starboard, the right)
    const ax = wind.x - fx * B.speed, az = wind.z - fz * B.speed
    B.aws = Math.hypot(ax, az)
    const awa = Math.abs(wrap(Math.atan2(-ax, -az) - B.h)), lee = Math.sign(-ax * fz + az * fx) || 1
    // speed: towards the polar's for this angle and wind, quicker to build than to fade (tacks carry through)
    const p = polar(B.twa), target = B.power * (p * Math.min(VMAX, 0.8 + 0.6 * ws) - (p === 0 ? 0.4 : 0))
    B.speed += (target - B.speed) * (1 - Math.exp(-(target > B.speed ? 0.45 : 0.2) * dt))
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
    if (d0 >= 3 && !wet(B.x, B.z)) { const w = nearestWater(B.x, B.z, 120); if (w) { B.x = w.x; B.z = w.z; B.speed = 0 } } // on land (a tile came in): back afloat
    else if (ok(nx, nz, nh)) { B.x = nx; B.z = nz; B.h = nh }
    else {
      if (ok(B.x, B.z, nh)) B.h = nh
      if (ok(nx, B.z, B.h)) B.x = nx; else if (ok(B.x, nz, B.h)) B.z = nz
      bumped(Math.abs(B.speed))
      B.speed *= -0.25
    }
    collideObstacles(t)
    // heel to leeward with the apparent wind; the sail eased for the angle, flogging when it can't draw
    const luff = clamp(Math.max((0.4 - B.power) / 0.4, (36 - B.twa) / 8), 0, 1)
    const heel = clamp(B.power * (1 - luff) * B.aws * B.aws * Math.sin(Math.min(awa, Math.PI / 2)) * 0.0045, 0, 0.42)
    B.heel += (lee * heel - B.heel) * (1 - Math.exp(-2 * dt))
    let sa = clamp((awa / RAD - 20) * 0.55, 8, 85) * RAD
    sa += (1 - B.power) * (85 * RAD - sa) * (awa > 0.6 ? 1 : 0)
    const tb = lee * sa + luff * 0.1 * Math.sin(t * 9), d = tb - B.boom
    B.boom += Math.sign(d) * Math.min(Math.abs(d), 2.6 * dt) // a jibe swings the boom across
    main.rotation.y = luff * 0.22 * Math.sin(t * 15)
    jibSail.rotation.y = luff * 0.3 * Math.sin(t * 17 + 1)
    // float on the water (the lowest ground under the hull: the shore is interpolated up into it)
    const wy = Math.min(city.world.heightAt(B.x, B.z), city.world.heightAt(B.x + fx * 3, B.z + fz * 3), city.world.heightAt(B.x - fx * 3, B.z - fz * 3))
    B.y += (wy - B.y) * (1 - Math.exp(-4 * dt))
  }
  let d0 = 0 // hull points on land before this step's move
  function ok(x, z, h) { const d = dry(x, z, h); return d === 0 || d < d0 } // a move that doesn't run (further) aground
  function bumped(impact) {
    const now = performance.now()
    if (impact < 0.4 || now - B.bumpT < 500) return
    B.bumpT = now
    thud(clamp(impact / 4, 0.3, 1))
    buzz(Math.round(clamp(impact * 12, 15, 60)))
  }
  // circle (x, z, r) against a box (centre, unit forward f, half length hl, half width hw): the push out, or null
  const push = { x: 0, z: 0 }
  function circleBox(x, z, r, cx, cz, fx, fz, hl, hw) {
    const dx = x - cx, dz = z - cz, lf = dx * fx + dz * fz, lr = dx * fz - dz * fx
    let ef = lf - clamp(lf, -hl, hl), er = lr - clamp(lr, -hw, hw), d = Math.hypot(ef, er), k
    if (d < 1e-6) { const pf = hl - Math.abs(lf), pr = hw - Math.abs(lr); if (pf < pr) { ef = Math.sign(lf) || 1; er = 0; k = r + pf } else { ef = 0; er = Math.sign(lr) || 1; k = r + pr } }
    else if (d < r) k = (r - d) / d
    else return null
    push.x = (ef * fx + er * fz) * k; push.z = (ef * fz - er * fx) * k
    return push
  }
  function hit(p) { // pushed out of something: bounce off it if heading into it
    B.x += p.x; B.z += p.z
    const l = Math.hypot(p.x, p.z) || 1, vn = (Math.sin(B.h) * p.x + Math.cos(B.h) * p.z) / l * B.speed
    if (vn < 0) { bumped(-vn); B.speed *= 0.3 }
  }
  function refreshObstacles() { // ships and other players near the boat, 10 times a second
    obs = []
    try { if (city.ships?.nearby) for (const o of city.ships.nearby(B.x, B.z, 60)) obs.push(o) } catch (e) { console.warn('sail: ships.nearby', e) }
    try { if (city.multiplayer?.nearby) for (const o of city.multiplayer.nearby(B.x, B.z, 40)) obs.push(o) } catch (e) { console.warn('sail: multiplayer.nearby', e) }
    for (const o of obs) o.at = performance.now()
  }
  function collideObstacles() {
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
  function place(t) { // the boat on gentle waves (taller in a stronger wind)
    const A = 0.08 + Math.hypot(wind.x, wind.z) * 0.012, ph = t * 1.3 + B.x * 0.07, pz = t * 2.1 + B.z * 0.09
    boat.position.set(B.x, B.y + A * (Math.sin(ph) + 0.6 * Math.sin(pz)), B.z)
    boat.rotation.set(0, B.h + Math.PI, 0)
    hull.rotation.set(A * 0.35 * Math.cos(ph), 0, -B.heel + A * 0.3 * Math.sin(t * 1.7 + B.z * 0.05))
    boom.rotation.y = B.boom
    jib.rotation.y = B.boom * 0.85
  }
  function wakeStep(t) { // a sample every TRAIL_DT; the newest point rides the stern
    const fx = Math.sin(B.h), fz = Math.cos(B.h), T = trail
    if (t - T.at > TRAIL_DT || !T.n) { T.at = t; T.head = (T.head + 1) % TRAIL; T.n = Math.min(TRAIL, T.n + 1) }
    const H = T.head
    T.x[H] = B.x - fx * 3; T.z[H] = B.z - fz * 3; T.y[H] = B.y + 0.12; T.h[H] = B.h; T.s[H] = Math.max(0, B.speed); T.t[H] = t
    for (let k = 0; k < TRAIL; k++) {
      const i = (H - k + TRAIL) % TRAIL, age = t - T.t[i], rx = -Math.cos(T.h[i]), rz = Math.sin(T.h[i])
      const off = 0.5 + 0.35 * age * T.s[i], th = 0.3 + 0.1 * age
      const al = k < T.n ? 0.55 * (1 - clamp(age / (TRAIL * TRAIL_DT), 0, 1)) ** 1.5 * clamp(T.s[i] / 2.5, 0, 1) : 0
      for (let v = 0; v < 4; v++) {
        const o = v === 0 ? -off - th : v === 1 ? -off : v === 2 ? off : off + th, j = (k * 4 + v) * 3
        wpos[j] = T.x[i] + rx * o; wpos[j + 1] = T.y[i]; wpos[j + 2] = T.z[i] + rz * o
        wcol[(k * 4 + v) * 4 + 3] = v === 0 || v === 3 ? al * 0.4 : al
      }
    }
    wgeo.attributes.position.needsUpdate = true; wgeo.attributes.color.needsUpdate = true
    wake.visible = true
  }
  function publish() {
    player.x = B.x; player.y = B.y; player.z = B.z; player.heading = B.h; player.speed = B.speed
  }

  // ---------------------------------------------------------------- per frame
  function frame(dt, time) {
    const now = performance.now()
    if (state === 'in' || state === 'out') {
      const e = clamp((now - t0) / (state === 'in' ? 2600 : 2200), 0, 1)
      pose(e)
      place(time)
      if (e >= 1) {
        if (state === 'out') return finish()
        state = 'play'
        B.power = 1
        ui.read.hidden = ui.btns.hidden = ui.touch.hidden = false
        ui.help.hidden = false; ui.help.classList.remove('fade')
        clearTimeout(helpT); helpT = setTimeout(() => ui.help.classList.add('fade'), 8000)
      }
      return
    }
    if (state !== 'play' || !(dt > 0)) return
    if (now - obsAt > 100) { obsAt = now; refreshObstacles() }
    sailStep(dt, time)
    place(time)
    wakeStep(time)
    publish()
    chasePose(dt)
    const fov = chaseFov(), far = fogFar + 60
    if (pcam.fov !== fov || pcam.near !== 1 || pcam.far !== far) { pcam.fov = fov; pcam.near = 1; pcam.far = far; pcam.updateProjectionMatrix() }
    pcam.position.copy(chase.pos); pcam.up.set(0, 1, 0); pcam.lookAt(chase.look)
    opts.focus.set(B.x + Math.sin(B.h) * 150, B.y, B.z + Math.cos(B.h) * 150)
    opts.radius = 900; opts.shadowRadius = 300
    if (now - hudAt > 100) { hudAt = now; hud() }
    if (now - skyAt > 1000) { skyAt = now; atmosphere(1) }
  }
  const POS = [[36, 'In irons: bear away'], [60, 'Close-hauled'], [80, 'Close reach'], [110, 'Beam reach'], [150, 'Broad reach'], [181, 'Running']]
  function hud() {
    ui.v.textContent = (Math.max(0, B.speed) * KN).toFixed(1)
    ui.w.textContent = String(Math.round(Math.hypot(wind.x, wind.z) * KN))
    const pos = POS.find((p) => B.twa < p[0])[1]
    if (ui.pos.textContent !== pos) { ui.pos.textContent = pos; ui.sub.classList.toggle('irons', B.twa < 36) }
    ui.sh.style.width = `${Math.round(B.power * 100)}%`
    // the wind arrow, relative to where the camera looks (up: blowing the way you look)
    const view = Math.atan2(chase.look.x - chase.pos.x, chase.look.z - chase.pos.z)
    ui.dial.style.transform = `rotate(${-wrap(Math.atan2(wind.x, wind.z) - view)}rad)`
    if (sea && !muted) {
      const t = ac.currentTime, s = Math.max(0, B.speed)
      sea.g.gain.setTargetAtTime(0.012 + 0.01 * s + 0.002 * Math.hypot(wind.x, wind.z), t, 0.3)
      sea.f.frequency.setTargetAtTime(250 + s * 110, t, 0.3)
    } else if (sea) sea.g.gain.setTargetAtTime(0, ac.currentTime, 0.1)
  }

  // ---------------------------------------------------------------- keys (taken before the drive plugin's D)
  const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable
  const CONTROL = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'])
  function onKey(e) {
    if (state === 'off' || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.code === 'Escape') { exit(); return }
    if (CONTROL.has(e.code)) { e.preventDefault(); e.stopPropagation(); if (state === 'play') keys.add(e.code) }
    if (state === 'play' && e.code === 'KeyM' && !e.repeat) setMuted(!muted)
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

  return {
    dispose() {
      cancelPick()
      if (state !== 'off') finish()
      for (const f of offTiles) f()
      removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKeyUp); removeEventListener('blur', onBlur); removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVis)
      button.remove()
      delete city.models?.boat
      for (const e of ui.all) e.remove()
      css.remove()
      wgeo.dispose(); wake.material.dispose()
      ac?.close()
    },
  }
}
