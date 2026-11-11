// Fishing and crabbing, on foot at any water's edge (the piers, the seawall, beaches, lakes) and trolling from the
// sailboat. A prompt shows when the walker stands facing water (F), and at a crabbing pier a trap can go down (T).
//   Fishing: hold to cast, watch the bobber (nibbles are false alarms, a strike pulls it under), strike in time, then
//   the fight: reel in the green, ease off when it runs. A catch card, a logbook, cash and XP (city.progress).
//   Crabbing: drop the trap, go and fish, haul it, then gauge each crab: undersize ones and females go back.
// rules.js has what bites where and when, the fight and the crab rules; models.js the kit models. Nothing runs per
// frame unless a line is in the water: a 4 Hz look for the water's edge while there is a player, no more.
// The drive plugin freezes the walker while city.fishing.busy; the tide is city.tide (weather plugin) when it is there.
import { clamp, esc, vancouver } from '../../core/util.js'
import { audioContext, tone, noise, buzz, typing } from '../../core/play.js'
import { SPOTS, SPECIES, RANGER, RODS, LURES, TRAPS, CRAB, CRAB_LIMIT, GREEN, biting, hookFish, biteIn, newFight, stepFight, soak, legal, judge, tideAt, tideWord } from './rules.js'
import { makeModels } from './models.js'

const KEY = 'fish.v1'
const CSS = `
.fs, .fs-card { left: 50%; transform: translateX(-50%); box-sizing: border-box; width: min(340px, calc(100% - 24px)); z-index: 30; font-size: 13px; color: var(--text); }
.fs, .fs-card { bottom: calc(var(--sb, 0px) + 32px); padding: 10px 12px; }
.fs.boat, .fs.boat + .fs-card { bottom: auto; top: calc(var(--st, 0px) + 118px); }
.fs[hidden], .fs-card[hidden], .fs-chips[hidden], .fs-chips button[hidden] { display: none; }
.fs-top { display: flex; align-items: baseline; gap: 8px; }
.fs-top b { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fs-top span, .fs-card small, .fs-dim { color: var(--muted); font-size: 11px; }
.fs-top span { margin-left: auto; white-space: nowrap; }
.fs-cond { color: var(--muted); font-size: 11px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fs-msg { margin: 8px 0 6px; font-weight: 600; min-height: 17px; }
.fs-bar { position: relative; height: 10px; border-radius: 5px; background: rgba(255,255,255,.1); overflow: hidden; }
.fs-bar u { position: absolute; top: 0; bottom: 0; background: rgba(127,216,154,.28); display: none; }
.fs-bar.fight u { display: block; }
.fs-bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: var(--accent); border-radius: 5px; }
.fs-bar.hot i { background: #ff6a55; } .fs-bar.good i { background: #7fd89a; }
.fs-line { height: 4px; margin-top: 4px; border-radius: 2px; background: rgba(255,255,255,.08); overflow: hidden; visibility: hidden; }
.fs-line.on { visibility: visible; } .fs-line i { display: block; height: 100%; background: #ffd23a; width: 0; }
.fs-btns { display: flex; gap: 6px; margin-top: 10px; }
.fs button { font: 600 13px system-ui, sans-serif; color: var(--text); background: rgba(255,255,255,.07); border: 1px solid var(--line); border-radius: 9px; min-height: 40px; padding: 0 12px; cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.fs .fs-act { flex: 1; background: rgba(127,196,232,.22); border-color: var(--accent); font-size: 14px; }
.fs .fs-act.on { background: var(--accent); color: #0b1016; }
.compact .fs button { min-height: 50px; }
.fs-card { padding: 12px 14px; max-height: min(430px, calc(100% - var(--st, 0px) - 150px)); overflow-y: auto; overscroll-behavior: contain; }
.fs-card h3 { margin: 0 0 2px; font-size: 16px; } .fs-card p { margin: 6px 0 0; line-height: 1.35; }
.fs-card .big { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.fs-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.fs-tags i { font-style: normal; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 99px; background: rgba(255,210,58,.18); color: #ffd23a; }
.fs-tags i.g { background: rgba(127,216,154,.18); color: #7fd89a; } .fs-tags i.r { background: rgba(255,106,85,.18); color: #ff8a78; }
.fs-row { display: flex; gap: 6px; margin-top: 10px; }
.fs-row button, .fs-list button { font: 600 13px system-ui, sans-serif; flex: 1; min-height: 40px; color: var(--text); background: rgba(255,255,255,.07); border: 1px solid var(--line); border-radius: 9px; cursor: pointer; }
.fs-row button.go { background: rgba(127,196,232,.22); border-color: var(--accent); }
.fs-crab { display: flex; gap: 8px; align-items: center; margin-top: 6px; } .fs-crab svg { display: block; }
.fs-crab .w { animation: fs-wrig .5s ease-in-out infinite alternate; transform-origin: 100px 64px; }
@keyframes fs-wrig { from { transform: rotate(-5deg); } to { transform: rotate(5deg) translateY(2px); } }
.fs-list { width: 300px; max-width: 100%; box-sizing: border-box; padding: 12px; }
.compact .fs-list { width: auto; padding: 4px 4px 12px; }
.fs-list h4 { margin: 12px 0 4px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.fs-list h4:first-child { margin-top: 0; }
.fs-list .sc { max-height: min(40vh, 300px); overflow-y: auto; overscroll-behavior: contain; }
.fs-it { display: flex; align-items: baseline; gap: 8px; padding: 5px 0; border-top: 1px solid var(--line); }
.fs-it:first-child { border-top: 0; } .fs-it span { margin-left: auto; color: var(--muted); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.fs-it.no { color: var(--muted); } .fs-it small { display: block; }
.fs-list button.fs-it { width: 100%; text-align: left; background: none; border: 0; border-top: 1px solid var(--line); border-radius: 0; min-height: 0; font-weight: 400; }
.fs-list label { display: flex; align-items: center; gap: 6px; min-height: 28px; cursor: pointer; }
.fs-chips { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--sb, 0px) + 92px); z-index: 30; display: flex; gap: 8px; }
.compact .fs-chips { bottom: calc(var(--sb, 0px) + 236px); }
.fs-chips button { font: 600 14px system-ui, sans-serif; color: #fff; background: rgba(24,20,18,.78); border: 1px solid rgba(255,255,255,.3); border-radius: 22px; min-height: 44px; padding: 0 16px; cursor: pointer; backdrop-filter: blur(8px); white-space: nowrap; animation: fs-pop .25s cubic-bezier(.2,1.6,.4,1); }
.fs-chips kbd { font: inherit; opacity: .6; margin-left: 4px; } .compact .fs-chips kbd { display: none; }
@keyframes fs-pop { from { transform: scale(.7); opacity: 0; } }
/* the progress pops, clear of the panel on phones */
.compact body.fs-on .pg-pops, .compact body.fs-on .pg-conf { bottom: auto !important; top: calc(var(--st, 0px) + 150px) !important; }
body.fs-on .dlv-touch, body.fs-on .ft-btns, body.fs-on .dlv-help { display: none !important; }
@media (max-height: 520px) { .fs-card { max-height: calc(100% - 60px); } .fs-cond { display: none; } }
`
const money = (n) => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n))
const cap = (s) => s[0].toUpperCase() + s.slice(1)

export default function fish(city) {
  const { THREE } = city
  // ================================================================ the save: the logbook
  const save = { log: {}, crab: { kept: 0, back: 0, fines: 0, best: {} }, day: '', today: [], keptToday: 0, how: false, seals: 0, ranger: 0, spotsOnMap: false } // (the saved key is spotsOnMap: off unless the player switches it on)
  try { Object.assign(save, JSON.parse(localStorage.getItem(KEY)) || {}) } catch {}
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(save)) } catch {} }
  const newDay = () => { const d = vancouver(Date.now()).ymd; if (save.day !== d) { save.day = d; save.today = []; save.keptToday = 0 } }
  const gear = (slot, table, first) => table[city.progress?.choice?.(slot)?.id?.split(':')[1]] ? city.progress.choice(slot).id.split(':')[1] : first
  const tide = () => { const f = tideAt(Date.now()), T = city.tide, h = T?.height ?? T?.level; return Number.isFinite(h) ? { h, rate: Number.isFinite(T.rate) ? T.rate : f.rate, live: true } : f }
  const tideText = (t = tide()) => `Tide ${t.h.toFixed(1)} m, ${{ slack: 'slack', flood: 'rising', ebb: 'falling' }[tideWord(t)]}`

  // ================================================================ water and places
  const tiles = new Map() // detail tiles by 'i,j' of their corner / 1024
  const tk = (t) => Math.round(t.ox / 1024) + ',' + Math.round(t.oy / 1024)
  const offTiles = city.world.eachTile((t) => { if (!t.level) tiles.set(tk(t), t) })
  const offUnload = city.on('tile:unload', (t) => { if (!t.level && tiles.get(tk(t)) === t) tiles.delete(tk(t)) })
  function isWater(x, z) {
    const t = tiles.get(Math.floor(x / 1024) + ',' + Math.floor(-z / 1024)), w = t?.water
    if (!w) return false
    const n = w.n, i = Math.floor(((x - t.ox) / 1024) * n), j = Math.floor(((-z - t.oy) / 1024) * n)
    return i >= 0 && j >= 0 && i < n && j < n && w.mask[j * n + i] === 1
  }
  const spots = SPOTS.map((s) => { const p = city.world.fromLatLon(s.lat, s.lon); return { ...s, x: p.x, z: p.z, r: s.kind === 'lake' ? 480 : s.kind === 'beach' || s.kind === 'river' ? 300 : 150 } })
  // where the player is fishing: a named spot, or just this water (a lake stands above the sea; the Fraser by where it is)
  function placeAt(x, z, wx, wz) {
    let best = null, bd = 1e9
    for (const s of spots) { const d = Math.hypot(s.x - x, s.z - z); if (d < s.r && d < bd) { best = s; bd = d } }
    if (best) return best
    const ll = city.world.toLatLon(x, z), fresh = city.world.heightAt(wx, wz) > 1.5, river = !fresh && ll.lat < 49.215 && ll.lon > -123.21
    return { id: '', name: fresh ? 'A quiet lake' : river ? 'The Fraser' : 'The saltchuck', kind: fresh ? 'lake' : river ? 'river' : 'seawall', water: fresh ? 'f' : river ? 'r' : 's', crab: fresh || river ? undefined : 0.3 }
  }
  // the first water ahead of (x, z) along (dx, dz), 1.5 to `reach` m on: its distance, or 0
  function waterAhead(x, z, dx, dz, reach = 13) {
    for (let d = 1.5; d <= reach; d += 0.75) if (isWater(x + dx * d, z + dz * d) && isWater(x + dx * (d + 3), z + dz * (d + 3))) return d
    return 0
  }
  const conditions = (pl, power, boat) => { const v = vancouver(Date.now()); return { water: pl.water, kind: pl.kind, spot: pl.id ? pl : null, month: +v.p.month, year: +v.p.year, hour: city.weather?.hour ?? v.sec / 3600, tide: tide(), wx: city.weather?.kind, lure: gear('lure', LURES, 'worm'), power, boat } }
  const bitingText = (pl, boat) => { const l = biting(conditions(pl, 0.6, boat)).filter((b) => !b.sp.junk).slice(0, 3).map((b) => b.sp.name.split(' (')[0].toLowerCase()); return l.length ? cap(l.join(', ')) : 'Not much' }

  // ================================================================ the page: prompt chips, the panel, the card
  const css = document.createElement('style'); css.textContent = CSS
  const chips = document.createElement('div'); chips.className = 'fs-chips'; chips.hidden = true
  chips.innerHTML = '<button data-c="fish">🎣 Fish<kbd>F</kbd></button><button data-c="trap">🦀 Drop trap<kbd>T</kbd></button>'
  const hud = document.createElement('div'); hud.className = 'fs panel'; hud.hidden = true
  hud.innerHTML = `<div class="fs-top"><b></b><span></span></div><div class="fs-cond"></div><div class="fs-msg"></div><div class="fs-bar"><u style="left:${(GREEN[0] / 1.15) * 100}%;width:${((GREEN[1] - GREEN[0]) / 1.15) * 100}%"></u><i></i></div><div class="fs-line"><i></i></div>
    <div class="fs-btns"><button class="fs-act"></button><button class="fs-lg" title="Logbook (L)" aria-label="Logbook">📖</button><button class="fs-x" title="Pack up (Esc)">Pack up</button></div>`
  const card = document.createElement('div'); card.className = 'fs-card panel'; card.hidden = true
  document.head.append(css); document.body.append(chips, hud, card)
  const el = { spot: hud.querySelector('.fs-top b'), tide: hud.querySelector('.fs-top span'), cond: hud.querySelector('.fs-cond'), msg: hud.querySelector('.fs-msg'), bar: hud.querySelector('.fs-bar'), fill: hud.querySelector('.fs-bar i'), line: hud.querySelector('.fs-line'), lineFill: hud.querySelector('.fs-line i'), act: hud.querySelector('.fs-act'), chipFish: chips.children[0], chipTrap: chips.children[1] }
  const say = (t) => { if (el.msg.textContent !== t) el.msg.textContent = t }
  const act = (t) => { if (el.act.textContent !== t) el.act.textContent = t }
  let barW = -1, barC = ''
  function bar(v, cls = '') { const w = Math.round(clamp(v, 0, 1) * 200) / 2; if (w !== barW) { barW = w; el.fill.style.width = w + '%' } if (cls !== barC) { barC = cls; el.bar.className = 'fs-bar ' + cls } }
  el.act.addEventListener('pointerdown', (e) => { e.preventDefault(); try { el.act.setPointerCapture(e.pointerId) } catch {} press(true) })
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.act.addEventListener(ev, () => { if (S?.held) press(false) })
  el.act.addEventListener('contextmenu', (e) => e.preventDefault())
  hud.querySelector('.fs-x').onclick = () => stop()
  hud.querySelector('.fs-lg').onclick = () => toggleLog()
  el.chipFish.onclick = () => begin(); el.chipTrap.onclick = () => trapKey()
  card.onclick = (e) => { const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a; if (a === 'keep' || a === 'back') decide(a === 'keep'); else if (a === 'log') toggleLog(); else press(true), press(false) }
  function show(kind, html) { if (S) S.card = kind; card.innerHTML = html; card.hidden = false; hud.hidden = true; card.scrollTop = 0 } // (the card takes the panel's place: one thing on screen)
  function hideCard() { if (S) S.card = ''; card.hidden = true; hud.hidden = !S }

  // ================================================================ sound
  let out = null
  function audio() { const ac = audioContext(); if (ac && !out) { out = ac.createGain(); out.gain.value = 0.5; out.connect(ac.destination) } return ac && out ? ac : null }
  const burst = (dur, freq, vol, q = 1) => { const ac = audio(); if (!ac) return; const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(); s.buffer = nz || (nz = noise(ac, 1)); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q; g.gain.setValueAtTime(vol, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur); s.connect(f); f.connect(g); g.connect(out); s.start(); s.stop(ac.currentTime + dur + 0.05) }
  let nz = null
  const note = (f, at, dur, vol, type) => { const ac = audio(); if (ac) tone(out, f, ac.currentTime + at, dur, vol, type) }
  const sfx = {
    splash: (big) => burst(big ? 0.5 : 0.25, big ? 900 : 1600, big ? 0.5 : 0.25), whoosh: () => burst(0.35, 2600, 0.18, 3), click: () => note(1900, 0, 0.03, 0.06, 'square'), tick: () => note(700, 0, 0.06, 0.08, 'triangle'),
    tug: () => { note(120, 0, 0.25, 0.4); buzz(40) }, win: () => [523, 659, 784, 1047].forEach((f, i) => note(f, i * 0.09, 0.3, 0.14, 'triangle')), bad: () => { note(220, 0, 0.3, 0.15, 'sawtooth'); note(165, 0.15, 0.4, 0.15, 'sawtooth') },
    snap: () => { burst(0.08, 3200, 0.5, 5); note(90, 0, 0.3, 0.3) }, gull: () => [0, 0.28, 0.5].forEach((t, i) => { note(1500 - i * 90, t, 0.2, 0.05, 'sawtooth'); note(1150 - i * 90, t + 0.09, 0.16, 0.05, 'sawtooth') }), bark: () => [0, 0.3].forEach((t) => note(260, t, 0.18, 0.2, 'sawtooth')),
  }

  // ================================================================ the scene: built on the first cast
  let G = null // { group, rod, tip, bobber, bucket, seal, line, rings, catch, trapM }
  const UP = new THREE.Vector3(0, 1, 0), v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), tb = new THREE.Vector3(), tipEnd = new THREE.Vector3(), end = new THREE.Vector3(), M = makeModels(THREE)
  function build() {
    const group = new THREE.Group(), [rod, tip] = M.rod(), bobber = M.bobber(), bucket = M.bucket(), seal = M.seal()
    const line = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(36), 3)), new THREE.LineBasicMaterial({ color: 0xeef3f6, transparent: true, opacity: 0.75, fog: false }))
    line.frustumCulled = false
    const ringG = new THREE.RingGeometry(0.78, 1, 20).rotateX(-Math.PI / 2)
    const rings = Array.from({ length: 6 }, () => { const m = new THREE.Mesh(ringG, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })); m.visible = false; m.userData = { t: 0, life: 1, s: 1 }; return m })
    seal.visible = false
    group.add(rod, tip, bobber, bucket, seal)
    G = { group, rod, tip, bobber, bucket, seal, line, rings, ringG, fish: null, over: new THREE.Group() }
    G.over.add(line, ...rings)
  }
  function ripple(x, y, z, s = 1, life = 1) { const m = G.rings.find((r) => !r.visible) || G.rings[0]; m.position.set(x, y + 0.04, z); m.userData.t = 0; m.userData.life = life; m.userData.s = s; m.visible = true }
  function setFish(f) { if (G.fish) { G.group.remove(G.fish); G.fish.geometry.dispose(); G.fish = null } if (f) { G.fish = M.fish(f.sp, f.sp.junk ? 1 : Math.max(0.36, (f.cm / 100) * 1.3)); G.fish.rotation.z = -Math.PI / 2; G.group.add(G.fish) } }
  // the rod from the hands at (bx, by, bz), leaning `pitch` from upright towards (dx, dz), its tip bent `bend` towards `end`; then the line
  function pose(bx, by, bz, dx, dz, pitch, bend, sag) {
    v1.set(Math.sin(pitch) * dx, Math.cos(pitch), Math.sin(pitch) * dz)
    G.rod.position.set(bx, by, bz); G.rod.quaternion.setFromUnitVectors(UP, v1)
    tb.set(bx, by, bz).addScaledVector(v1, 1.5)
    v2.copy(end).sub(tb).normalize().multiplyScalar(bend).addScaledVector(v1, 1 - bend).normalize()
    G.tip.position.copy(tb); G.tip.quaternion.setFromUnitVectors(UP, v2)
    tipEnd.copy(tb).addScaledVector(v2, 1.1)
    const a = G.line.geometry.attributes.position, mx = (tipEnd.x + end.x) / 2, my = Math.max(end.y, (tipEnd.y + end.y) / 2 - sag), mz = (tipEnd.z + end.z) / 2
    for (let i = 0; i < 12; i++) { const t = i / 11, u = 1 - t; a.setXYZ(i, u * u * tipEnd.x + 2 * t * u * mx + t * t * end.x, u * u * tipEnd.y + 2 * t * u * my + t * t * end.y, u * u * tipEnd.z + 2 * t * u * mz + t * t * end.z) }
    a.needsUpdate = true
  }

  // ================================================================ a session: rod in hand (or the trap's rope)
  let S = null, offFrame = null, stopAnim = null, dbg = null
  const api = (city.fishing = { busy: false, active: false, spots })
  const rnd = Math.random
  function begin(crab) {
    const P = city.player
    if (S || !P || !near) return
    if (near.place.closed) { city.ui.toast(RANGER[save.ranger++ % RANGER.length], 4500); city.progress?.stat('fish.ranger'); persist(); sfx.bad(); return }
    audio(); newDay()
    if (!G) build()
    const boat = P.mode === 'boat', h = P.heading, dx = boat ? -Math.sin(h) : Math.sin(h), dz = boat ? -Math.cos(h) : Math.cos(h), rodId = gear('rod', RODS, 'spin')
    S = { mode: crab ? 'crab' : boat ? 'boat' : 'foot', st: 'ready', place: near.place, x: P.x, y: P.y, z: P.z, dx, dz, wy: 0, dist: 0, power: 0, pd: 1, held: false, t: 0, bite: null, ni: 0, f: null, fish: null, rod: RODS[rodId], card: '', sealT: 0, tickT: 0, haul: 0, crabs: null, ci: 0, sum: null, gullT: 6 + rnd() * 10, lastWin: null }
    S.wy = boat ? P.y - 0.3 : city.world.heightAt(P.x + dx * near.d, P.z + dz * near.d)
    city.scene.add(G.group); city.overlay.add(G.over)
    G.bobber.visible = false; G.seal.visible = false; setFish(null)
    G.bucket.visible = !boat; G.bucket.position.set(P.x + dz * 0.55, P.y, P.z - dx * 0.55)
    G.rod.visible = G.tip.visible = G.line.visible = !crab
    api.active = true; api.busy = !boat
    document.body.classList.toggle('fs-on', !boat); hud.classList.toggle('boat', boat)
    el.spot.textContent = S.place.name; el.tide.textContent = S.place.water === 'f' ? '' : tideText()
    el.cond.textContent = crab ? 'Dungeness 165 mm, red rock 115 mm, males only, four a day' : `${LURES[gear('lure', LURES, 'worm')]} · biting: ${bitingText(S.place, boat).toLowerCase()}`
    hud.hidden = false; chips.hidden = true; bar(0); el.line.classList.remove('on')
    stopAnim = city.animate(); offFrame = city.on('frame', frame)
    if (crab) { S.st = 'haul'; say('Hold to haul the trap'); act('Haul') }
    else if (!save.how) { S.st = 'how'; howTo() } else ready()
    frame(0)
  }
  function stop() {
    if (!S) return
    if (S.sum) paySum()
    offFrame(); stopAnim(); offFrame = stopAnim = null
    city.scene.remove(G.group); city.overlay.remove(G.over); setFish(null)
    if (G.trapM) { G.group.remove(G.trapM); G.trapM.traverse((m) => m.geometry?.dispose()); G.trapM = null }
    document.body.classList.remove('fs-on')
    S = null; hideCard(); api.active = api.busy = false
    city.requestRender()
  }
  function howTo() {
    show('how', `<h3>Fishing in ten seconds</h3><p><b>Hold</b> ${S.mode === 'boat' ? 'F' : 'F or Space'} (or the big button) and let go to cast: the longer, the further.<br><b>Watch the bobber.</b> Nibbles are a tease; when it goes under, hit it.<br><b>Reel</b> by holding. Keep the line in the green, and ease off when the fish runs or it snaps.</p>
      <p class="fs-dim">Crab: drop a trap off a pier (T), fish a while, haul it and gauge each one. Tide, season, hour and weather change what bites.</p><div class="fs-row"><button class="go" data-a="ok">Got it</button></div>`)
    say(''); act('Got it')
  }
  function ready(msg) { S.st = 'ready'; S.t = 0; G.bobber.visible = false; bar(0); el.line.classList.remove('on'); say(msg || (S.mode === 'boat' ? 'Press F to let the line out' : 'Hold to cast')); act(S.mode === 'boat' ? 'Lines out' : 'Cast') }
  function cast() {
    const reach = 5 + S.power * (S.rod.cast - 5)
    let d = 0
    if (S.mode === 'boat') d = 16
    else for (let q = reach; q >= 2; q -= 1) if (isWater(S.x + S.dx * q, S.z + S.dz * q)) { d = q; break }
    if (!d) { ready('No water out there. Face the water'); return }
    S.dist = d; S.st = 'fly'; S.t = 0; S.flyT = 0.45 + 0.03 * d; sfx.whoosh(); say(''); act('…')
  }
  function landedOnWater() { S.st = 'wait'; S.t = 0; S.ni = 0; S.bite = biteIn(rnd); G.bobber.visible = true; ripple(end.x, S.wy, end.z, 1.2); sfx.splash(); say(S.mode === 'boat' ? 'Trolling. Keep her at a walking pace' : 'Wait for it…'); act('Reel in') }
  function press(down) {
    if (!S) return
    S.held = down; el.act.classList.toggle('on', down)
    if (!down) { if (S.st === 'aim') cast(); return }
    audio()
    if (S.card === 'log') return toggleLog()
    switch (S.st) {
      case 'how': save.how = true; persist(); hideCard(); ready(); break
      case 'ready': if (S.mode === 'boat') cast(); else { S.st = 'aim'; S.power = 0; S.pd = 1; say('Let go to cast'); act('Casting…') } break
      case 'wait': ready(S.t - (S.bite.nib[S.ni - 1] ?? -9) < 0.6 ? 'Too soon: that was a nibble' : 'Reeled in'); break
      case 'bite': hook(); break
      case 'card': hideCard(); G.seal.visible = false; setFish(null); ready(); break
      case 'sort': if (!S.gauged && !S.result) { S.gauged = true; sfx.click(); sortCard() } else if (S.result) nextCrab(); break
      case 'sum': stop(); break
    }
  }
  function hook() {
    S.fish = hookFish(conditions(S.place, S.power, S.mode === 'boat'), rnd, S.rod); S.f = newFight(S.fish, S.dist, S.rod)
    S.st = 'fight'; G.bobber.visible = false; sfx.tug(); el.line.classList.add('on'); say('Fish on! Hold to reel'); act('Reel')
  }
  function landed() {
    const f = S.fish, sp = f.sp, pl = S.place
    setFish(f); S.st = 'card'; bar(0); el.line.classList.remove('on'); act('Fish on'); say('')
    if (pl.water !== 'f' && (sp.shape === 'salmon') && rnd() < (pl.seal ?? 0.04)) { // the seal's share
      setFish(null); G.seal.visible = true; G.seal.position.set(end.x, S.wy - 0.05, end.z); G.seal.rotation.y = Math.atan2(S.x - end.x, S.z - end.z) + Math.PI; ripple(end.x, S.wy, end.z, 2, 1.4)
      save.seals++; persist(); city.progress?.stat('fish.seal'); sfx.bark(); S.lastWin = { seal: true }
      return show('catch', `<h3>Robbed!</h3><p>A harbour seal took your ${esc(sp.name.toLowerCase())} right off the line, ${f.cm} cm of it. It looked pleased.</p><div class="fs-row"><button class="go" data-a="ok">Cast again</button></div>`)
    }
    newDay()
    const L = save.log[sp.id] || (save.log[sp.id] = { n: 0, cm: 0, kg: 0, at: '' }), first = !L.n, pb = !first && f.cm > L.cm, cash = Math.round(f.cash * (first ? 1.5 : 1))
    L.n++; if (f.cm >= L.cm) { L.cm = f.cm; L.kg = f.kg; L.at = pl.name }
    if (!save.today.includes(sp.id)) { save.today.push(sp.id); if (!sp.junk) city.progress?.stat('fish.kinds') }
    persist()
    city.progress?.award('fish', cash, { quiet: true })
    const top = f.cm ? city.progress?.score('fish', f.cm * 10) : false
    sfx.win(); buzz(25); S.lastWin = { id: sp.id, cm: f.cm, cash }
    const tags = [first && '<i class="g">New species +50%</i>', pb && '<i>Personal best</i>', f.trophy && '<i>Trophy</i>', top && pb && '<i>Your biggest fish</i>', sp.release && '<i class="g">Released</i>'].filter(Boolean).join('')
    show('catch', `<h3>${esc(sp.name)}</h3>${f.cm ? `<div class="big">${f.cm} cm <small>${f.kg < 1 ? Math.round(f.kg * 1000) + ' g' : f.kg.toFixed(1) + ' kg'}</small></div>` : ''}<div class="fs-tags">${tags}</div><p>${esc(sp.lines[Math.floor(rnd() * sp.lines.length)])}</p>
      <p><b>+${money(cash)}</b> <small>and ${cash} XP · ${esc(pl.name)}</small></p><div class="fs-row"><button class="go" data-a="ok">Cast again</button><button data-a="log">Logbook</button></div>`)
    el.cond.textContent = `${LURES[gear('lure', LURES, 'worm')]} · biting: ${bitingText(pl, S.mode === 'boat').toLowerCase()}`
  }

  // ---------------------------------------------------------------- the frame (only while a session is on)
  function frame(dt) {
    if (!S) return
    const P = city.player
    if (!P || (S.mode === 'boat') !== (P.mode === 'boat')) return stop()
    if (dbg) { dt *= dbg.fast; bot() }
    dt = Math.min(dt, 0.1 * (dbg?.fast || 1))
    const boat = S.mode === 'boat'
    if (boat) { const h = P.heading; S.dx = -Math.sin(h); S.dz = -Math.cos(h); S.x = P.x; S.y = P.y; S.z = P.z; S.wy = P.y - 0.3 }
    S.t += dt
    let pitch = 0.75, bend = 0.12, sag = 0.4, d = S.dist, side = 0, ey = S.wy
    const bx = S.x + (boat ? S.dx * 1.6 : S.dx * 0.3 - S.dz * 0.42), by = S.y + (boat ? 1.1 : 1.02), bz = S.z + (boat ? S.dz * 1.6 : S.dz * 0.3 + S.dx * 0.42)
    switch (S.st) {
      case 'how': case 'ready': d = 1.2; ey = by + 0.5; pitch = 0.5; sag = 0; break
      case 'aim':
        S.power += S.pd * dt * 0.9; if (S.power >= 1) { S.power = 1; S.pd = -1 } else if (S.power <= 0.05) { S.power = 0.05; S.pd = 1 }
        bar(S.power); pitch = -0.2 - S.power * 0.8; d = 1.2; ey = by + 1.6; sag = 0; break
      case 'fly': {
        const k = Math.min(1, S.t / S.flyT); d = 1.5 + (S.dist - 1.5) * k; ey = S.wy + (by + 1.5 - S.wy) * (1 - k) + Math.sin(k * Math.PI) * (2 + S.dist * 0.12); pitch = -0.6 + 1.5 * Math.min(1, k * 3); sag = 0.1
        if (k >= 1) { end.set(S.x + S.dx * S.dist, S.wy, S.z + S.dz * S.dist); landedOnWater() } break
      }
      case 'wait': {
        const moving = !boat || (P.speed > 0.8 && P.speed < 4.5)
        if (!moving) { S.t -= dt; say(P.speed <= 0.8 ? 'Too slow to troll: get her moving' : 'Too fast: ease the sheets') } else if (boat) say('Trolling…')
        if (S.ni < S.bite.nib.length && S.t >= S.bite.nib[S.ni]) { S.ni++; S.dip = 0.25; ripple(end.x, S.wy, end.z, 0.6, 0.7); sfx.tick() }
        if (S.t >= S.bite.at) { S.st = 'bite'; S.t = 0; S.dip = 1; ripple(end.x, S.wy, end.z, 1.6); sfx.tug(); sfx.splash(); say('Strike! Hit it!'); act('Strike!') }
        if ((S.gullT -= dt) < 0 && S.place.water !== 'f') { S.gullT = 9 + rnd() * 16; sfx.gull() }
        break
      }
      case 'bite': bend = 0.5; if (S.t > S.bite.window) { S.st = 'wait'; S.t = 0; S.ni = 0; S.bite = biteIn(rnd); say('Missed. It took the bait'); act('Reel in'); sfx.bad() } break
      case 'fight': {
        const f = S.f, ev = stepFight(f, dt, S.held, rnd)
        d = f.d; side = Math.sin(f.t * 0.9) * 0.3 + Math.sin(f.t * 2.3) * 0.1; bend = 0.25 + 0.6 * Math.min(1, f.T); pitch = 0.95 - 0.55 * Math.min(1, f.T); sag = (1 - Math.min(1, f.T)) * 0.6
        bar(f.T / 1.15, f.T > 1 ? 'fight hot' : f.T >= GREEN[0] ? 'fight good' : 'fight'); el.lineFill.style.width = Math.round(clamp(1 - (f.d - 1.5) / (f.d0 + 10), 0, 1) * 100) + '%'
        if (S.held && (S.tickT -= dt) < 0) { S.tickT = f.run > 0 ? 0.16 : 0.07; sfx.click() }
        say(f.T > 1 ? 'Too tight! Ease off!' : f.run > 0 ? 'It’s running: let it go' : f.slack > 1 ? 'Slack line: reel!' : 'Reel it in')
        if (ev === 'run') { S.splash = 1; sfx.splash(true); buzz(20) }
        else if (ev === 'snap') { sfx.snap(); buzz(80); ready('Snap! The line parted') } else if (ev === 'spit') { sfx.bad(); ready(f.d > f.d0 + 40 ? 'Spooled. It is in Nanaimo by now' : 'It threw the hook') }
        else if (ev === 'landed') { sfx.splash(true); S.splash = 1 }
        if (ev === 'landed') landed()
        break
      }
      case 'card': d = 0; pitch = 0.35; bend = 0.3; sag = 0; break
      case 'haul': {
        S.haul = clamp(S.haul + (S.held ? dt / 2.4 : -dt / 5), 0, 1); bar(S.haul)
        if (S.held && (S.tickT -= dt) < 0) { S.tickT = 0.3; sfx.tick(); buzz(8) }
        if (S.haul >= 1) hauled()
        break
      }
    }
    if (S && S.mode !== 'crab') {
      if (S.st === 'card') end.set(bx + S.dx * 0.3 - S.dz * 0.45, by + 0.95, bz + S.dz * 0.3 + S.dx * 0.45) // held up beside the angler, side on to the camera
      else if (S.st !== 'wait' && S.st !== 'bite' || boat) { const c = Math.cos(side), s = Math.sin(side); end.set(S.x + (S.dx * c - S.dz * s) * d, ey, S.z + (S.dz * c + S.dx * s) * d) }
      if (S.dip > 0) S.dip = Math.max(0, S.dip - dt * (S.st === 'bite' ? 0 : 1.6))
      if (G.bobber.visible) G.bobber.position.set(end.x, S.wy - (S.dip || 0) * 0.14 + Math.sin(S.t * 2.2) * 0.012, end.z)
      if (S.splash) { S.splash = 0; ripple(end.x, S.wy, end.z, 1.8, 0.9) }
      pose(bx, by, bz, S.dx, S.dz, pitch, bend, sag)
      if (G.fish) { G.fish.position.set(end.x, end.y, end.z); G.fish.rotation.y = Math.atan2(S.dx, S.dz) + Math.sin(S.t * 1.7) * 0.35 }
    }
    for (const m of G.rings) if (m.visible) { const u = m.userData; u.t += dt; const k = u.t / u.life; if (k >= 1) m.visible = false; else { m.scale.setScalar(u.s * (0.25 + k)); m.material.opacity = 0.55 * (1 - k) } }
  }

  // ================================================================ crab: the trap, the haul, the gauge
  let trap = null // { x, z (the float), px, pz (where to haul from), wy, t0, place, id, m }
  function trapKey() {
    const P = city.player
    if (S || !P || P.mode !== 'foot') return
    if (trap && Math.hypot(P.x - trap.px, P.z - trap.pz) < 9) { near = near || { place: trap.place, d: 3 }; near.place = trap.place; return begin(true) }
    if (trap) return city.ui.toast(`Your trap is down at ${trap.place.name}. Haul it first.`)
    if (!near || near.place.crab == null || near.d > 9) return
    audio(); if (!G) build()
    const id = gear('trap', TRAPS, 'ring'), d = near.d + 1.5, h = P.heading, x = P.x + Math.sin(h) * d, z = P.z + Math.cos(h) * d, m = M.float()
    m.position.set(x, city.world.heightAt(x, z), z); city.scene.add(m)
    trap = { x, z, px: P.x, pz: P.z, t0: Date.now(), place: near.place, id, m }
    sfx.splash(true); city.requestRender(); look()
    city.ui.toast(`${TRAPS[id].name} down. Give it a minute or two (${tideText().toLowerCase()}: ${tideWord(tide()) === 'slack' ? 'the best time' : 'slack tide fishes best'}). Go wet a line.`, 5000)
  }
  function hauled() {
    const secs = (Date.now() - trap.t0) / 1000, id = trap.id, t = TRAPS[id]
    S.crabs = soak(secs, { tide: tide(), trap: t, rock: trap.place.crab ?? 0.3 }, rnd); S.soaked = secs; S.ci = 0; S.sum = { kept: 0, back: 0, fines: 0, cash: 0, wrong: 0 }
    city.scene.remove(trap.m); trap.m.geometry.dispose(); trap = null
    const g = (G.trapM = new THREE.Group()); g.add(M.trap(id))
    S.crabs.forEach((c, i) => { const m = M.crab(c.kind, c.mm); m.position.set((i % 2 - 0.5) * 0.22, 0.03 + Math.floor(i / 2) * 0.07, (i % 3 - 1) * 0.12); m.rotation.y = i * 2.1; g.add(m) })
    g.position.set(S.x + S.dx * 0.7 + S.dz * 0.95, S.y, S.z + S.dz * 0.7 - S.dx * 0.95); G.group.add(g)
    sfx.splash(true); bar(0); newDay()
    if (!S.crabs.length) { S.st = 'sum'; act('OK'); say(''); S.sum = null; return show('sum', `<h3>Empty</h3><p>${secs < 30 ? 'Barely wet. Leave it a minute or two.' : !t.holds && secs > 200 ? 'The bait is gone and so are the crab: a ring wants hauling within a few minutes.' : 'Nothing home this time. Crab walk at slack tide.'}</p><div class="fs-row"><button class="go" data-a="ok">OK</button></div>`) }
    S.st = 'sort'; S.gauged = false; S.result = null; sortCard()
  }
  function crabSVG(c, gauged) {
    const k = CRAB[c.kind], s = 1 + (c.mm / k.min - 1) * 2.2, w = 52 * s, col = c.kind === 'redrock' ? '#b8402f' : '#a57f92', leg = (sx, i) => `<path d="M${100 + sx * w * 0.8} ${60 + i * 9} q${sx * 22} ${-6 + i * 4} ${sx * 34} ${8 + i * 7}" />`
    return `<svg width="190" height="118" viewBox="5 0 190 118" role="img" aria-label="${k.name} from above"><g class="${gauged ? '' : 'w'}"><g fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round">${[0, 1, 2, 3].map((i) => leg(-1, i) + leg(1, i)).join('')}
      <path d="M${100 - w * 0.7} 50 q-14 -26 8 -34 M${100 + w * 0.7} 50 q14 -26 -8 -34" stroke-width="8" /></g>
      <path d="M${100 - w} 58 Q${100 - w * 0.8} 30 100 30 Q${100 + w * 0.8} 30 ${100 + w} 58 Q${100 + w * 0.6} 96 100 96 Q${100 - w * 0.6} 96 ${100 - w} 58 Z" fill="${col}" stroke="#14171a" stroke-width="1.5" /><circle cx="90" cy="34" r="3" fill="#14171a"/><circle cx="110" cy="34" r="3" fill="#14171a"/></g>
      ${gauged ? `<path d="M48 58 V104 H152 V58" fill="none" stroke="#ffd23a" stroke-width="3" /><path d="M48 58 l-4 -9 h8 z M152 58 l-4 -9 h8 z" fill="#ffd23a" /><text x="100" y="115" fill="#ffd23a" font-size="10" font-weight="700" text-anchor="middle">${k.min} mm gauge</text>` : ''}</svg>
      <svg width="74" height="84" viewBox="0 0 74 84" role="img" aria-label="Its underside"><ellipse cx="37" cy="36" rx="33" ry="26" fill="#e9dfcc" stroke="#14171a" stroke-width="1.5"/><path d="${c.male ? 'M32 60 L37 22 L42 60 Z' : 'M19 58 Q20 20 37 18 Q54 20 55 58 Z'}" fill="#cdbfa4" stroke="#14171a" stroke-width="1.5"/><text x="37" y="80" fill="#93a3b5" font-size="10" text-anchor="middle">underside</text></svg>`
  }
  function sortCard() {
    const c = S.crabs[S.ci], k = CRAB[c.kind], r = S.result
    show('sort', `<h3>${k.name} <small>${S.ci + 1} of ${S.crabs.length}</small></h3><div class="fs-crab">${crabSVG(c, S.gauged)}</div>
      ${r ? `<p><b style="color:${r.ok ? '#7fd89a' : '#ff8a78'}">${esc(r.why)}</b> ${r.cash ? `<b>${r.cash > 0 ? '+' : ''}${money(r.cash)}</b>` : ''}</p><div class="fs-row"><button class="go" data-a="ok">${S.ci + 1 < S.crabs.length ? 'Next crab' : 'Done'}</button></div>`
        : S.gauged ? `<p class="fs-dim">Keepers poke past the gauge and have a narrow apron (males). In the bucket today: ${save.keptToday} of ${CRAB_LIMIT}.</p><div class="fs-row"><button class="go" data-a="keep">Keep (K)</button><button data-a="back">Put it back (R)</button></div>`
        : '<p class="fs-dim">It will not hold still. Get the gauge on it.</p><div class="fs-row"><button class="go" data-a="ok">Measure</button></div>'}`)
    say(r ? '' : S.gauged ? 'Keep it, or back it goes?' : 'Measure it'); act(r ? 'Next' : S.gauged ? '…' : 'Measure')
  }
  function decide(keep) {
    if (!S || S.st !== 'sort' || !S.gauged || S.result) return
    const c = S.crabs[S.ci], r = (S.result = judge(c, keep, save.keptToday)), m = S.sum
    m.cash += r.cash
    if (keep && r.ok) { m.kept++; save.keptToday++; save.crab.kept++; save.crab.best[c.kind] = Math.max(save.crab.best[c.kind] || 0, c.mm) } else if (keep) { m.fines++; save.crab.fines++ } else { m.back++; save.crab.back++; if (!r.ok) m.wrong++ }
    if (G.trapM.children[1 + S.ci]) G.trapM.children[1 + S.ci].visible = false
    persist(); r.ok ? sfx.win() : sfx.bad(); if (!keep) { sfx.splash(); ripple(S.x + S.dx * 4, S.wy, S.z + S.dz * 4, 0.8) }
    sortCard()
  }
  function nextCrab() {
    if (++S.ci < S.crabs.length) { S.gauged = false; S.result = null; return sortCard() }
    const m = S.sum, pay = paySum()
    S.st = 'sum'; act('Done'); say('')
    show('sum', `<h3>The haul</h3><p>${m.kept} in the bucket, ${m.back} back in the water${m.fines ? `, ${m.fines} ${m.fines > 1 ? 'fines' : 'fine'}` : ''}.${m.wrong ? ' You let a keeper go.' : !m.fines ? ' Every call right.' : ''}</p>
      <p><b>+${money(pay)}</b> <small>${m.cash < 0 ? 'the fines ate the rest · ' : ''}soaked ${Math.round(S.soaked)} s, ${esc(tideText().toLowerCase())}</small></p><div class="fs-row"><button class="go" data-a="ok">Done</button><button data-a="log">Logbook</button></div>`)
  }
  function paySum() { // the haul's pay, once (also when the player packs up half way through the sorting)
    const m = S.sum, pay = Math.max(0, m.cash); S.sum = null; S.lastHaul = { ...m, pay, n: S.crabs.length }; if (dbg) dbg.lastHaul = S.lastHaul
    if (m.kept) city.progress?.stat('crab.keep', m.kept)
    city.progress?.award('crab', pay, { quiet: true, xp: pay + 5 * (m.kept + m.back - m.wrong) })
    return pay
  }

  // ================================================================ the logbook (the toolbar panel, and a card while fishing)
  function logHTML() {
    newDay()
    const fishes = SPECIES.filter((s) => !s.junk), got = fishes.filter((s) => save.log[s.id]).length, c = save.crab
    const row = (s) => { const L = save.log[s.id]; return L ? `<div class="fs-it"><div>${esc(s.name)}<small class="fs-dim">${s.junk ? '' : esc(L.at)}</small></div><span>${s.junk ? '' : `${L.cm} cm · `}×${L.n}</span></div>` : `<div class="fs-it no"><div>${s.junk ? '???' : esc(s.name)}</div><span>${s.junk ? '' : { s: 'salt', f: 'lakes', r: 'the Fraser' }[s.waters[0]]}</span></div>` }
    return `<h4>Logbook · ${got} of ${fishes.length} species</h4><div class="sc">${fishes.map(row).join('')}${SPECIES.filter((s) => s.junk).map(row).join('')}
      <div class="fs-it${c.kept + c.back ? '' : ' no'}"><div>Crab<small class="fs-dim">${c.best.dungeness ? `Dungeness ${c.best.dungeness} mm ` : ''}${c.best.redrock ? `red rock ${c.best.redrock} mm` : ''}</small></div><span>${c.kept} kept · ${c.back} back${c.fines ? ` · ${c.fines} fines` : ''}</span></div>
      ${save.seals ? `<div class="fs-it"><div>Fed to seals</div><span>×${save.seals}</span></div>` : ''}</div>`
  }
  function toggleLog() {
    if (!S || S.st === 'fight' || S.st === 'bite' || S.st === 'haul') return
    if (S.card === 'log') { if (S.back) { show(S.back[0], S.back[1]); S.back = null } else hideCard(); return }
    if (S.st === 'wait' || S.st === 'aim') ready('Reeled in')
    S.back = S.card ? [S.card, card.innerHTML] : null
    show('log', `<div class="fs-list" style="width:auto;padding:0">${logHTML()}</div><div class="fs-row"><button class="go" data-a="log">Close</button></div>`)
  }
  const tool = city.ui.addButton({ label: 'Fishing', icon: '🎣', title: 'Fishing and crabbing: the spots, what is biting, your logbook', panel: true, onClick: () => drawPanel() })
  function drawPanel() {
    if (!tool.panel) return
    const row = (s) => `<button class="fs-it" data-s="${s.id}"><div>${esc(s.name)}<small class="fs-dim">${s.closed ? esc(s.blurb) : esc(bitingText(s))}</small></div><span>${s.closed ? 'no fishing' : s.crab != null ? s.kind + ' · crab' : s.kind}</span></button>`
    tool.panel.innerHTML = `<div class="fs-list"><h4>Today · ${esc(tideText())}</h4><div class="fs-dim">Walk to the water’s edge or out on a pier and a 🎣 prompt appears (F). Drop a crab trap off a pier (T). Under sail, F trolls a line.</div>
      <label><input type="checkbox" ${save.spotsOnMap ? 'checked' : ''}> Show the spots on the map</label><h4>Spots</h4><div class="sc" style="max-height:min(26vh,200px)">${spots.map(row).join('')}</div>${logHTML()}</div>`
    tool.panel.querySelector('input').onchange = (e) => { save.spotsOnMap = e.target.checked; persist(); showMarks(); city.requestRender() }
    for (const b of tool.panel.querySelectorAll('[data-s]')) b.onclick = () => { // the map goes there
      const s = spots.find((q) => q.id === b.dataset.s)
      if (city.player || city.view.camera !== city.camera) return city.ui.toast(`${s.name}: ${s.blurb}`)
      const d = new THREE.Vector3(s.x, city.controls.target.y, s.z).sub(city.controls.target); city.camera.position.add(d); city.controls.target.add(d); city.camera.zoom = Math.max(city.camera.zoom, 1.2); city.camera.updateProjectionMatrix(); city.controls.update?.(); city.requestRender()
      city.ui.toast(`${s.name}: ${s.blurb}${s.closed ? '' : ' Start a walk here.'}`, 4000)
    }
  }

  // ================================================================ the spots on the map: one Points
  const cv = document.createElement('canvas'); cv.width = cv.height = 64
  { const g = cv.getContext('2d'); g.fillStyle = 'rgba(14,22,30,.86)'; g.beginPath(); g.arc(32, 32, 29, 0, 7); g.fill(); g.lineWidth = 3; g.strokeStyle = '#7fc4e8'; g.stroke(); g.font = '34px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('🎣', 32, 35) }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
  const marks = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(spots.flatMap((s) => [s.x, 8, s.z]), 3)), new THREE.PointsMaterial({ map: tex, size: 26 * Math.min(2, devicePixelRatio), sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false, fog: false }))
  marks.frustumCulled = false; marks.renderOrder = 5
  const pole = M.marker(); pole.visible = false; city.scene.add(pole) // in a game: one depth-tested pole at the nearest spot, on foot or afloat
  function showMarks() {
    const P = city.player
    marks.visible = save.spotsOnMap && !P
    let best = null, bd = 250
    if (P && (P.mode === 'foot' || P.mode === 'boat')) for (const s of spots) { const d = Math.hypot(s.x - P.x, s.z - P.z); if (d < bd) { bd = d; best = s } }
    if (best) { pole.position.set(best.x, Math.max(city.world.heightAt(best.x, best.z), 0), best.z); pole.scale.setScalar(clamp(bd / 60, 1, 4)) }
    if (pole.visible !== !!best) { pole.visible = !!best; city.requestRender() }
  }
  showMarks()
  city.overlay.add(marks)

  // ================================================================ the look-out: is the player at the water? (4 Hz, only while there is a player)
  let near = null, timer = 0
  function look() {
    const P = city.player
    near = null; showMarks()
    let fishOn = false, trapText = ''
    if (P && !S) {
      if (P.mode === 'boat') { near = { place: placeAt(P.x, P.z, P.x, P.z), d: 16 }; near.place = { ...near.place, crab: undefined }; fishOn = true }
      else if (P.mode === 'foot' && Math.abs(P.speed) < 0.6) {
        const dx = Math.sin(P.heading), dz = Math.cos(P.heading), d = waterAhead(P.x, P.z, dx, dz)
        if (d) { near = { place: placeAt(P.x, P.z, P.x + dx * (d + 3), P.z + dz * (d + 3)), d }; fishOn = true; if (!trap && near.place.crab != null && !near.place.closed && d <= 9) trapText = '🦀 Drop trap' }
        if (trap && Math.hypot(P.x - trap.px, P.z - trap.pz) < 9) { const s = Math.round((Date.now() - trap.t0) / 1000); trapText = `🦀 Haul trap · ${s < 60 ? s + ' s' : Math.floor(s / 60) + ' min'}` }
      }
    }
    el.chipFish.hidden = !fishOn; el.chipTrap.hidden = !trapText
    if (trapText && el.chipTrap.firstChild.data !== trapText) el.chipTrap.firstChild.data = trapText
    if (fishOn) { const t = P.mode === 'boat' ? '🎣 Troll' : near.place.closed ? '🎣 Fish?' : '🎣 Fish'; if (el.chipFish.firstChild.data !== t) el.chipFish.firstChild.data = t }
    chips.hidden = !fishOn && !trapText
  }
  const offPlayer = city.on('player', (p) => { clearInterval(timer); timer = 0; if (p) timer = setInterval(look, 250); else { stop(); look(); showMarks(); if (trap) { city.scene.remove(trap.m); trap = null } } })

  // ================================================================ keys
  const eat = (e) => { e.preventDefault(); e.stopImmediatePropagation() }
  function onKey(e) {
    if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return
    const c = e.code
    if (!S) { if (e.repeat || !city.player) return; if (c === 'KeyF' && !el.chipFish.hidden && !chips.hidden) { eat(e); begin() } else if (c === 'KeyT' && !el.chipTrap.hidden && !chips.hidden) { eat(e); trapKey() } return }
    const boat = S.mode === 'boat'
    if (c === 'KeyF' || (!boat && (c === 'Space' || c === 'Enter'))) { eat(e); if (!e.repeat) press(true) }
    else if (c === 'Escape') { eat(e); S.card === 'log' ? toggleLog() : stop() }
    else if (c === 'KeyL') { eat(e); toggleLog() }
    else if (c === 'KeyK' || c === 'KeyR') { eat(e); decide(c === 'KeyK') }
    else if (!boat && c !== 'KeyM') eat(e) // rod in hand: no walking off, no van, no camera
  }
  const onKeyUp = (e) => { if (S?.held && (e.code === 'KeyF' || e.code === 'Space' || e.code === 'Enter')) press(false) }
  const onBlur = () => { if (S?.held) press(false) }
  addEventListener('keydown', onKey, true); addEventListener('keyup', onKeyUp, true); addEventListener('blur', onBlur)

  // ================================================================ ?drivedebug (tools/fish_check.mjs): a bot on the button, a faster clock
  let botHold = false
  function bot() {
    if (!dbg.auto || !S) return
    const want = S.st === 'aim' ? S.power < 0.7 && S.pd > 0 : S.st === 'fight' ? (botHold = S.f.T < (S.f.run > 0 ? 0.5 : 0.8) && !(S.f.run > 0 && S.f.p * (0.35 + 0.65 * S.f.st) > 0.55)) : S.st === 'haul'
    if (S.st === 'ready') press(true)
    else if (S.st === 'bite' || S.st === 'how' || (S.st === 'sort' && !S.gauged)) { press(true); press(false) }
    else if (S.st === 'sort' && !S.result) decide(legal(S.crabs[S.ci]) && save.keptToday < CRAB_LIMIT)
    else if (S.st === 'sort') nextCrab()
    else if (S.st === 'card') { dbg.caught.push(S.lastWin); if (dbg.auto !== 'hold') { press(true); press(false) } else dbg.auto = false }
    else if (want !== S.held) press(want)
  }
  if (location.search.includes('drivedebug')) dbg = window.fishDebug = { fast: 1, auto: false, caught: [], lastHaul: null, spots, isWater, tiles, waterAhead, press, begin, trapKey, stop, look, toggleLog, save, get S() { return S }, get near() { return near }, get trap() { return trap }, age(s) { if (trap) trap.t0 -= s * 1000 } }

  return {
    dispose() {
      stop(); clearInterval(timer); offTiles(); offUnload(); offPlayer()
      removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKeyUp, true); removeEventListener('blur', onBlur)
      city.scene.remove(pole); pole.geometry.dispose(); city.overlay.remove(marks); marks.geometry.dispose(); marks.material.dispose(); tex.dispose()
      if (trap) city.scene.remove(trap.m)
      tool.remove(); css.remove(); chips.remove(); hud.remove(); card.remove(); delete city.fishing
      city.requestRender()
    },
  }
}
