// Progress: the game around the games. Cash and XP from every mode (city.progress.award, see PLUGINS.md), levels
// that unlock van colours, horns, hull colours and Rush Fare cabs, maple leaves hidden at real places all over the
// map, three daily challenges and a streak, and leaderboards on the live server. Everything is kept in
// localStorage; no accounts. One toolbar button (a tile in the phone ⋯ sheet) opens the panel.
import { clamp, mulberry32, esc, getJSON } from '../../core/util.js'
import { audioContext, tone, buzz } from '../../core/play.js'
import { AREAS } from './leaves.js'

const KEY = 'progress.v1'
const XP_AT = (l) => 50 * (l - 1) * (l + 2) // XP at which level l starts: 200, 500, 900, 1400 … 20 900 at level 20
const levelOf = (xp) => { let l = 1; while (xp >= XP_AT(l + 1)) l++; return l }
// the day of the dailies and their board: the same sum as the server's day_of (midnight Pacific Standard Time)
export const dayOf = (ms = Date.now()) => Math.floor((ms / 1000 - 8 * 3600) / 86400)
const money = (n) => '$' + Math.round(n).toLocaleString('en-CA')

// what there is to unlock: id, name, value, level (or { leaves }), price to buy it before that level.
// The first of each slot is the default everyone has.
const ITEMS = [
  ['van:salmonberry', 'Salmonberry', '#f2a07e', 1], ['van:sky', 'Seawall sky', '#7fb8e0', 2, 400], ['van:fern', 'Fern', '#6fae7a', 4, 900],
  ['van:cab', 'Cab yellow', '#f5c518', 6, 1500], ['van:plum', 'Plum', '#8a5fa8', 9, 2500], ['van:midnight', 'Midnight', '#2b3440', 12, 4000],
  ['van:gold', 'Gold leaf', '#d9a520', { leaves: 40 }], ['van:maple', 'Maple red', '#d9352b', { leaves: 100 }],
  ['horn:van', 'Van horn', null, 1], ['horn:rig', 'Big rig', [155, 196], 3, 600], ['horn:clown', 'Clown car', [620, 930], 5, 1200],
  ['horn:ferry', 'Ferry', [98, 131], 8, 2000], ['horn:train', 'Freight train', [311, 370, 415, 494], { leaves: 70 }],
  ['boat:teal', 'Harbour teal', '#2f6f8f', 1], ['boat:sunset', 'Sunset', '#e8703a', 3, 600], ['boat:orca', 'Orca', '#22252c', 5, 1200],
  ['boat:mint', 'Seawall mint', '#9fe0c8', 7, 1800], ['boat:cherry', 'Cherry', '#c81d3a', 10, 3000], ['boat:gold', 'Gold leaf', '#d9a520', { leaves: 20 }],
].map(([id, name, value, need, price]) => ({ id, slot: id.split(':')[0], name, value, lv: need.leaves ? 0 : need, leaves: need.leaves || 0, price: price || 0 }))
const CAB_LEVELS = [1, 1, 1, 1, 2, 3, 4, 5, 6, 8, 10, 12] // Rush Fare cabs by their index in CABS: the first four are everyone's
const SLOTS = [['van', 'Van'], ['horn', 'Horn'], ['boat', 'Boat'], ['cab', 'Rush Fare cabs']]

// the daily challenges: one from each group a day. [group, stat, text, min, max, step, award kind it needs]:
// a challenge on an award kind is only drawn once the player has earned that kind (so it can always be done).
const POOL = [
  [0, 'delivery', (n) => `Deliver ${n} parcels`, 3, 6, 1, 'delivery'], [0, 'fare.cash', (n) => `Earn ${money(n)} in Rush Fare fares`, 150, 400, 50, 'fare'],
  [0, 'bus', (n) => `Serve ${n} bus stops`, 5, 10, 1, 'bus'], [0, 'km.car', (n) => `Drive ${n} km`, 3, 6, 1], [0, 'km.bus', (n) => `Drive a bus ${n} km`, 1, 3, 1],
  [1, 'km.boat', (n) => `Sail ${n} km`, 1, 3, 1], [1, 'km.foot', (n) => `Walk ${n} km`, 0.5, 1.5, 0.5], [1, 'climb', (n) => `Climb ${n} m on foot`, 60, 200, 20],
  [1, 'sail', (n) => `${n} sights or races under sail`, 2, 3, 1, 'sail'], [1, 'hike', () => 'Finish a hike', 1, 1, 1, 'hike'],
  [2, 'leaf', (n) => `Find ${n} maple ${n > 1 ? 'leaves' : 'leaf'}`, 1, 3, 1], [2, 'cash', (n) => `Earn ${money(n)} any way you like`, 300, 800, 100],
  [2, 'stunt', (n) => `Pull off ${n} stunts`, 5, 15, 5, 'stunt'],
]
const BOARD_NAMES = { daily: 'Today', taxi: 'Rush Fare', delivery: 'Deliveries', bus: 'Bus', sail: 'Sailing', hike: 'Hiking' }
const DAILY_PAY = 150, LEAF_PAY = 50

const CSS = `
.pg { width: 300px; max-width: 100%; box-sizing: border-box; padding: 12px; font-variant-numeric: tabular-nums; }
.compact .pg { width: auto; padding: 4px 4px 12px; }
.pg h3 { margin: 0; font-size: 15px; display: flex; align-items: baseline; gap: 8px; }
.pg h3 small { font-weight: 400; color: var(--muted); font-size: 12px; margin-left: auto; }
.pg-bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.1); overflow: hidden; margin: 6px 0 2px; }
.pg-bar i { display: block; height: 100%; background: var(--accent); border-radius: 3px; transition: width .4s; }
.pg-bar.done i { background: #7fd89a; }
.pg small, .pg .dim { color: var(--muted); font-size: 11px; }
.pg-tabs { display: flex; gap: 4px; margin: 10px 0 8px; }
.pg-tabs button, .pg-chips button { font: inherit; color: var(--text); background: rgba(255,255,255,.05); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.pg-tabs button { flex: 1; padding: 6px 2px; min-height: 32px; }
.compact .pg-tabs button { min-height: 44px; }
.pg-tabs button[aria-selected=true], .pg-chips button[aria-pressed=true] { background: rgba(127,196,232,.22); border-color: var(--accent); }
.pg-body { max-height: min(46vh, 380px); overflow-y: auto; overscroll-behavior: contain; }
.pg-row { padding: 6px 0; border-top: 1px solid var(--line); }
.pg-row:first-child { border-top: 0; }
.pg-row b { font-weight: 600; }
.pg-row .r { float: right; color: var(--muted); }
.pg-areas { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin-top: 8px; }
.pg-areas div { min-width: 0; font-size: 12px; }
.pg-areas span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pg-chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0 10px; }
.pg-chips button { padding: 4px 9px; min-height: 30px; display: inline-flex; align-items: center; gap: 5px; }
.compact .pg-chips button { min-height: 40px; }
.pg-chips button.lock { color: var(--muted); border-style: dashed; }
.pg-chips button.buy { color: var(--text); }
.pg-chips i { width: 12px; height: 12px; border-radius: 50%; border: 1px solid rgba(255,255,255,.5); }
.pg h4 { margin: 8px 0 2px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.pg ol { margin: 0; padding: 0; list-style: none; }
.pg ol li { display: flex; gap: 8px; padding: 3px 0; }
.pg ol li span:nth-child(2) { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pg ol li.me { color: var(--accent); font-weight: 600; }
.pg ol li span:first-child { width: 1.6em; color: var(--muted); }
.pg label { display: flex; align-items: center; gap: 6px; min-height: 28px; cursor: pointer; }
.pg-pops { position: fixed; left: 50%; top: calc(var(--st) + 96px); transform: translateX(-50%); z-index: 41; display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; max-width: calc(100% - 24px); }
.compact .pg-pops { top: calc(var(--st) + 104px); }
.compact body.dlv-on .pg-pops { top: auto; bottom: calc(max(16px, calc(env(safe-area-inset-bottom) + 4px)) + 214px); }
.pg-pop { position: static; padding: 6px 14px; border-radius: 999px; font-weight: 600; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; animation: pg-in .35s cubic-bezier(.2,1.6,.4,1); transition: opacity .35s, transform .35s; }
.pg-pop.big { font-size: 15px; padding: 9px 18px; border-color: #ffd23a; }
.pg-pop.out { opacity: 0; transform: translateY(-8px); }
@keyframes pg-in { from { transform: scale(.5); opacity: 0; } }
.pg-conf { position: fixed; left: 50%; top: calc(var(--st) + 110px); width: 0; height: 0; z-index: 42; pointer-events: none; }
.compact body.dlv-on .pg-conf { top: auto; bottom: calc(max(16px, calc(env(safe-area-inset-bottom) + 4px)) + 230px); }
.pg-conf i { position: absolute; width: 6px; height: 10px; border-radius: 1px; animation: pg-fly .9s cubic-bezier(.1,.7,.3,1) forwards; }
@keyframes pg-fly { to { transform: translate(var(--x), var(--y)) rotate(var(--r)); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .pg-conf { display: none; } .pg-pop { animation: none; } }
`

export default function progress(city) {
  const { THREE } = city
  // ================================================================ the save
  const S = { xp: 0, cash: 0, stats: {}, found: {}, best: {}, sent: {}, own: {}, pick: {}, daily: null, streak: 0, streakDay: 0, areas: {}, mute: false, onMap: false }
  try { Object.assign(S, JSON.parse(localStorage.getItem(KEY)) || {}) } catch {}
  let saveT = 0
  const saveNow = () => { clearTimeout(saveT); saveT = 0; try { localStorage.setItem(KEY, JSON.stringify(S)) } catch {} }
  const save = () => { if (!saveT) saveT = setTimeout(saveNow, 1500) }
  const onHide = () => { if (saveT) saveNow() }
  addEventListener('pagehide', onHide); document.addEventListener('visibilitychange', onHide)

  const LEAVES = [] // { id, name, area, sea, x, z, y, set (settled on a street / the water), near }
  AREAS.forEach(([, list], a) => list.forEach(([name, lat, lon, sea], i) => { const p = city.world.fromLatLon(lat, lon); LEAVES.push({ id: `${a}.${i}`, name, area: a, sea: !!sea, x: p.x, z: p.z, y: 0, set: false, i: LEAVES.length }) }))
  const leafCount = () => Object.keys(S.found).length
  const items = new Map(ITEMS.map((it) => [it.id, it]))
  const unlocked = (id) => { const it = items.get(id); return !it || !!S.own[id] || (it.leaves ? leafCount() >= it.leaves : levelOf(S.xp) >= it.lv) }
  import('../drive/cabs.js').then((m) => m.CABS.forEach((c, i) => { // (until this is in, every cab is unlocked)
    const it = { id: `cab:${i}`, slot: 'cab', name: c.name, value: i, lv: CAB_LEVELS[i] || 12, leaves: 0, price: i < 4 ? 0 : 500 * (i - 3) }
    ITEMS.push(it); items.set(it.id, it)
  })).catch(() => {})

  // ================================================================ juice: pops, confetti, sounds
  const css = document.createElement('style'); css.textContent = CSS; document.head.append(css)
  const pops = document.createElement('div'); pops.className = 'pg-pops'; document.body.append(pops)
  function pop(text, big, ms = 2600) {
    const p = document.createElement('div'); p.className = 'panel pg-pop' + (big ? ' big' : ''); p.setAttribute('role', 'status'); p.textContent = text
    pops.append(p); while (pops.children.length > 4) pops.firstChild.remove()
    p.life = (t = ms) => { clearTimeout(p.t); p.t = setTimeout(() => { p.classList.add('out'); setTimeout(() => p.remove(), 400) }, t) }
    p.life(big ? ms + 1200 : ms)
    return p
  }
  function confetti(n = 16) {
    if (document.hidden) return
    const c = document.createElement('div'); c.className = 'pg-conf'
    for (let i = 0; i < n; i++) {
      const e = document.createElement('i'), a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 90
      e.style.cssText = `background:${['#ffd23a', '#e0362c', '#7fc4e8', '#7fd89a', '#f2a07e'][i % 5]};--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d * 0.7 + 40}px;--r:${Math.random() * 720 - 360}deg`
      c.append(e)
    }
    document.body.append(c); setTimeout(() => c.remove(), 950)
  }
  let out = null
  function jingle(notes, type = 'triangle', vol = 0.07) { // [freq, at seconds, length]
    if (S.mute) return
    const ac = audioContext(); if (!ac || ac.state !== 'running') return
    if (!out) { out = ac.createGain(); out.connect(ac.destination) }
    for (const [f, at, len] of notes) tone(out, f, ac.currentTime + at, len, vol, type)
  }
  const SFX = {
    coin: () => jingle([[988, 0, 0.09], [1319, 0.07, 0.22]], 'square', 0.03),
    leaf: () => jingle([[1175, 0, 0.3], [1568, 0.09, 0.3], [2093, 0.18, 0.5]], 'sine', 0.08),
    daily: () => jingle([[659, 0, 0.15], [784, 0.11, 0.15], [1047, 0.22, 0.4]]),
    level: () => jingle([[523, 0, 0.18], [659, 0.12, 0.18], [784, 0.24, 0.18], [1047, 0.36, 0.6], [1319, 0.36, 0.6]]),
  }

  // ================================================================ cash, XP, levels, stats
  function bump(name, d) { S.stats[name] = Math.round(((S.stats[name] || 0) + d) * 1000) / 1000; return S.stats[name] }
  function gain(cash, xp) {
    const before = levelOf(S.xp), had = ITEMS.filter((it) => unlocked(it.id))
    S.cash += cash; S.xp += xp
    if (cash) bump('cash', cash)
    const now = levelOf(S.xp)
    if (now > before) {
      pop(`Level ${now}!`, true); confetti(28); SFX.level(); buzz([30, 40, 60])
      city.emit('progress:level', now)
    }
    announce(had)
  }
  function announce(had) { // what just became unlocked
    for (const it of ITEMS) if (!had.includes(it) && unlocked(it.id)) { pop(`Unlocked: ${it.name}${it.slot === 'cab' ? ' (Rush Fare)' : ` ${it.slot}`}`, false, 4200); city.emit('progress:unlock', { id: it.id, name: it.name }) }
  }
  let cashPop = null, cashSum = 0
  function award(kind, amount = 0, meta = {}) {
    try {
      kind = String(kind).slice(0, 24); meta = meta || {}
      amount = Math.round(clamp(+amount || 0, 0, 5000)); const xp = Math.round(clamp(+(meta.xp ?? amount) || 0, 0, 5000))
      bump(kind, 1); if (amount) bump(kind + '.cash', amount)
      gain(amount, xp)
      if (!meta.quiet && amount > 0 && (meta.label || amount >= 20 || cashPop?.isConnected)) { // small ones add up in the pop on screen
        if (!cashPop?.isConnected || cashPop.classList.contains('out')) { cashPop = pop(''); cashSum = 0 }
        cashSum += amount; cashPop.textContent = `+${money(cashSum)}${meta.label ? ' · ' + meta.label : ''}`; cashPop.life(); SFX.coin()
      }
      city.emit('progress:award', { kind, amount, xp, meta })
      if (meta.score != null) score(meta.board || kind, meta.score)
      changed()
    } catch (e) { console.warn('progress: award', e) }
    return { cash: S.cash, xp: S.xp, level: levelOf(S.xp) }
  }
  function stat(name, d = 1) { const v = bump(String(name).slice(0, 32), +d || 0); changed(); return v }
  function changed() { dailies(); save(); label(); if (open()) draw() }

  // ================================================================ leaderboards
  const dev = new URLSearchParams(location.search).get('live')
  const BOARDS_URL = dev && /^wss?:\/\//.test(dev) ? dev.replace(/^ws/, 'http').replace(/\/ws$/, '/boards') : '/live/boards'
  function score(board, value) {
    board = String(board); value = Math.round(clamp(+value || 0, 0, 1e7))
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(board) || board === 'daily' || value <= (S.best[board] || 0)) return false
    S.best[board] = value; save(); sync()
    pop(`New best: ${BOARD_NAMES[board] || board}`); return true
  }
  let dailySent = 0
  function sync() { // bests the server hasn't had yet (it lets 6 through at once, then one every 5 s)
    const mp = city.multiplayer; if (!mp?.connected || !mp.send) return
    let n = 0
    for (const b in S.best) if (S.sent[b] !== S.best[b] && n++ < 4) { mp.send({ t: 'score', board: b, v: S.best[b] }); S.sent[b] = S.best[b] }
    const d = S.daily, v = d ? d.done.filter(Boolean).length * 1e6 + Math.min(999999, Math.round((S.stats.cash || 0) - d.cash0)) : 0
    if (v > 0 && v !== d.sent && Date.now() - dailySent > 20000) { mp.send({ t: 'score', board: 'daily', v }); d.sent = v; dailySent = Date.now() }
    if (n) save()
  }
  const syncT = setInterval(sync, 30000)

  // ================================================================ daily challenges and the streak
  function dailies() {
    const day = dayOf()
    if (S.daily?.day !== day) { // a new day: draw three, one from each group, the same for everyone who can do them
      const rnd = mulberry32(day * 7919 + 17), all = leafCount() >= LEAVES.length
      const items = [0, 1, 2].map((g) => {
        const r1 = rnd(), r2 = rnd(), can = POOL.map((p, i) => i).filter((i) => POOL[i][0] === g && (!POOL[i][6] || S.stats[POOL[i][6]] > 0) && !(all && POOL[i][1] === 'leaf'))
        const i = can[Math.floor(r1 * can.length)], [, st, , lo, hi, step] = POOL[i]
        return { i, n: lo + step * Math.floor(r2 * ((hi - lo) / step + 1)), from: S.stats[st] || 0 }
      })
      S.daily = { day, items, done: [false, false, false], cash0: S.stats.cash || 0, sent: 0 }
      if (S.streakDay < day - 1) S.streak = 0
      save()
    }
    const d = S.daily
    d.items.forEach((it, k) => {
      if (d.done[k] || (S.stats[POOL[it.i][1]] || 0) - it.from < it.n) return
      d.done[k] = true
      if (S.streakDay !== day) { S.streak = S.streakDay === day - 1 ? S.streak + 1 : 1; S.streakDay = day }
      const all = d.done.every(Boolean), mult = 1 + Math.min(S.streak - 1, 10) * 0.1
      pop(all ? `All three dailies done! 🔥 ${S.streak}-day streak` : `Daily done: ${POOL[it.i][2](it.n)}`, true); confetti(all ? 36 : 20); SFX.daily(); buzz(40)
      gain(Math.round((DAILY_PAY + (all ? 300 : 0)) * mult), Math.round((300 + (all ? 400 : 0)) * mult))
      bump('daily', 1); sync()
    })
  }

  // ================================================================ the maple leaves
  const shape = new THREE.Shape()
  const HALF = [0.03, -1, 0.03, -0.6, 0.42, -0.68, 0.36, -0.42, 0.86, -0.05, 0.68, 0.04, 0.78, 0.38, 0.5, 0.3, 0.46, 0.46, 0.24, 0.3, 0.3, 0.72, 0.16, 0.64, 0, 1]
  for (let i = 0; i < HALF.length; i += 2) shape[i ? 'lineTo' : 'moveTo'](HALF[i] * 0.8, HALF[i + 1] * 0.8)
  for (let i = HALF.length - 4; i >= 0; i -= 2) shape.lineTo(-HALF[i] * 0.8, HALF[i + 1] * 0.8)
  const leafGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.14, bevelEnabled: false }).translate(0, 0, -0.07)
  const leafMat = new THREE.MeshLambertMaterial({ color: 0xe0362c, emissive: 0x7a140c, flatShading: true })
  const mesh = new THREE.InstancedMesh(leafGeo, leafMat, LEAVES.length)
  mesh.frustumCulled = false; mesh.castShadow = false
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), SC = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0)
  function put(l, scale, rot = 0, lift = 0) {
    Q.setFromAxisAngle(UP, rot); P.set(l.x, l.y + (l.sea ? 2.4 : 1.7) + lift, l.z); SC.setScalar(S.found[l.id] ? 0 : scale)
    mesh.setMatrixAt(l.i, M.compose(P, Q, SC)); mesh.instanceMatrix.needsUpdate = true
  }
  for (const l of LEAVES) put(l, 0)
  city.scene.add(mesh)

  // a leaf settles where it can be reached when its detail tile comes in: on the nearest street or path (not a
  // motorway, rails, a runway or a bridge deck), or the nearest open water for the ones at sea
  const NO_LEAF = new Set([0, 14, 15, 16, 17])
  function settle(tile) {
    if (tile.level !== 0 || !tile.graph) return
    for (const l of LEAVES) {
      const n = -l.z
      if (l.set || l.x < tile.ox || l.x >= tile.ox + tile.size || n < tile.oy || n >= tile.oy + tile.size) continue
      let best = 250 * 250, bx = l.x, bn = n
      if (l.sea) {
        const w = tile.water; if (!w) continue
        const c = tile.size / w.n, wet = (i, j) => i >= 0 && j >= 0 && i < w.n && j < w.n && w.mask[j * w.n + i]
        for (let j = 1; j < w.n - 1; j++) for (let i = 1; i < w.n - 1; i++) {
          const x = tile.ox + (i + 0.5) * c, y = tile.oy + (j + 0.5) * c, d = (x - l.x) ** 2 + (y - n) ** 2
          if (d < best && wet(i, j) && wet(i - 1, j) && wet(i + 1, j) && wet(i, j - 1) && wet(i, j + 1)) { best = d; bx = x; bn = y }
        }
      } else {
        for (const p of tile.graph.pieces) {
          if (NO_LEAF.has(p.kind) || p.z != null) continue
          const q = p.pts
          for (let i = 0; i + 3 < q.length; i += 2) { // the nearest point on each segment
            const ax = q[i], ay = q[i + 1], dx = q[i + 2] - ax, dy = q[i + 3] - ay, t = clamp(((l.x - ax) * dx + (n - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1)
            const x = ax + dx * t, y = ay + dy * t, d = (x - l.x) ** 2 + (y - n) ** 2
            if (d < best) { best = d; bx = x; bn = y }
          }
        }
      }
      l.x = bx; l.z = -bn; l.set = true; l.y = l.sea ? 0 : city.world.heightAt(l.x, l.z)
      show()
    }
  }
  const offTiles = city.world.eachTile(settle)

  // on the map: only with the panel's switch on, as big markers; in a game: life-size, turning, near the player
  let nearT = 0, spin = 0
  const NEAR = []
  function show() {
    if (city.player) return
    const s = S.onMap ? Math.max(1.6, city.view.metresPerPixel * 30) : 0
    for (const l of LEAVES) { if (s && !l.set) l.y = l.sea ? 0 : city.world.heightAt(l.x, l.z); put(l, s, 0, s * 0.9) }
    city.requestRender()
  }
  let showT = 0
  const offView = city.on('view', () => { if (!city.player && S.onMap && !showT) showT = setTimeout(() => { showT = 0; show() }, 250) })
  const offPlayer = city.on('player', (p) => { last.on = false; if (p) { for (const l of LEAVES) put(l, 0); nearT = 0 } else show() })

  function collect(l) {
    S.found[l.id] = 1; put(l, 0)
    const had = ITEMS.filter((it) => unlocked(it.id)), [area, list] = AREAS[l.area], got = list.filter((_, i) => S.found[`${l.area}.${i}`]).length
    pop(`🍁 ${l.name} · ${leafCount()} / ${LEAVES.length}`, true); confetti(22); SFX.leaf(); buzz(30)
    bump('leaf', 1); gain(LEAF_PAY, 100); announce(had)
    if (got === list.length && !S.areas[l.area]) { S.areas[l.area] = 1; pop(`${area}: every leaf found! +${money(500)}`, true, 4000); gain(500, 500) }
    city.emit('progress:collect', { id: l.id, name: l.name, area })
    changed(); saveNow()
  }

  // every frame of a game: distances by mode, leaves near the player (found within a few metres)
  const last = { on: false, x: 0, y: 0, z: 0 }, acc = { car: 0, bus: 0, foot: 0, boat: 0, climb: 0 }
  const offFrame = city.on('frame', (dt) => {
    const p = city.player; if (!p) return
    if (last.on) {
      const d = Math.hypot(p.x - last.x, p.z - last.z)
      if (d < 60 && acc[p.mode] !== undefined) { // (further in a frame: a teleport)
        acc[p.mode] += d
        if (acc[p.mode] >= 100) { acc[p.mode] -= 100; stat('km.' + p.mode, 0.1) }
        if (p.mode === 'foot' && p.y > last.y) { acc.climb += p.y - last.y; if (acc.climb >= 10) { acc.climb -= 10; stat('climb', 10) } }
      }
    }
    last.on = true; last.x = p.x; last.y = p.y; last.z = p.z
    if ((nearT -= dt) <= 0) { // which leaves are near enough to draw: twice a second
      nearT = 0.5
      for (const l of NEAR) put(l, 0)
      NEAR.length = 0
      for (const l of LEAVES) if (!S.found[l.id] && Math.abs(l.x - p.x) < 450 && Math.abs(l.z - p.z) < 450) NEAR.push(l)
    }
    spin += dt * 1.8
    for (let i = 0; i < NEAR.length; i++) {
      const l = NEAR[i]
      if (S.found[l.id]) continue
      put(l, 1.6, spin + l.i, Math.sin(spin * 1.3 + l.i) * 0.18)
      const r = l.sea ? 16 : 7
      if (l.set && Math.abs(l.x - p.x) < r && Math.abs(l.z - p.z) < r && (l.sea ? p.mode === 'boat' : Math.abs(l.y - p.y) < 12)) collect(l)
    }
  })

  // ================================================================ the panel
  const tool = city.ui.addButton({ label: 'Progress', icon: '🍁', title: 'Progress: level, cash, maple leaves, dailies, leaderboards', panel: true })
  const root = document.createElement('div'); root.className = 'pg'; tool.panel.append(root)
  const open = () => !tool.panel.hidden
  function label() { tool.set({ label: `Lv ${levelOf(S.xp)} · ${money(S.cash)}` }) }
  let tab = 'today', board = 'daily', boards = null, boardsAt = 0
  const bar = (v, max) => `<div class="pg-bar${v >= max ? ' done' : ''}"><i style="width:${clamp((v / max) * 100, 0, 100)}%"></i></div>`
  function loadBoards() {
    if (Date.now() - boardsAt < 10000) return
    boardsAt = Date.now(); sync()
    getJSON(BOARDS_URL).then((b) => { boards = b; if (open()) draw() }).catch(() => { boards = boards || { boards: {}, off: true }; if (open()) draw() })
  }
  const TABS = {
    today() {
      const d = S.daily, left = (d.day + 1) * 86400 + 8 * 3600 - Date.now() / 1000
      return d.items.map((it, k) => {
        const [, st, text] = POOL[it.i], v = Math.min(it.n, Math.round(((S.stats[st] || 0) - it.from) * 10) / 10)
        return `<div class="pg-row"><span class="r">${d.done[k] ? '✓' : `${v} / ${it.n}`}</span><b>${esc(text(it.n))}</b>${bar(d.done[k] ? 1 : v, d.done[k] ? 1 : it.n)}</div>`
      }).join('') + `<div class="pg-row dim">${money(DAILY_PAY)} and 300 XP each, more for all three${S.streak > 1 ? ` · streak bonus +${Math.min(S.streak - 1, 10) * 10}%` : ''}. New ones in ${Math.floor(left / 3600)} h ${Math.floor((left % 3600) / 60)} min.</div>`
    },
    leaves() {
      return `<label><input type="checkbox" data-map ${S.onMap ? 'checked' : ''}> Show the ones still hidden on the map</label>
        <div class="dim">Drive, walk or sail up to a leaf to pick it up: ${money(LEAF_PAY)} and 100 XP each.</div>
        <div class="pg-areas">${AREAS.map(([name, list], a) => { const n = list.filter((_, i) => S.found[`${a}.${i}`]).length; return `<div><span>${esc(name)}</span><small>${n} / ${list.length}</small>${bar(n, list.length)}</div>` }).join('')}</div>`
    },
    garage() {
      const lv = levelOf(S.xp)
      return SLOTS.map(([slot, name]) => `<h4>${name}</h4><div class="pg-chips">${ITEMS.filter((it) => it.slot === slot).map((it, i) => {
        const has = unlocked(it.id), on = slot !== 'cab' && has && (S.pick[slot] ? S.pick[slot] === it.id : i === 0), can = !has && it.price && S.cash >= it.price
        const dot = typeof it.value === 'string' ? `<i style="background:${it.value}"></i>` : ''
        const why = has ? '' : it.leaves ? ` · ${it.leaves} 🍁` : ` · Lv ${it.lv}${it.price ? ` or ${money(it.price)}` : ''}`
        return `<button data-item="${it.id}" class="${has ? '' : can ? 'lock buy' : 'lock'}" aria-pressed="${on}" ${has || can ? '' : 'aria-disabled="true"'} title="${has ? '' : can ? 'Buy it now' : it.leaves ? `Find ${it.leaves} maple leaves` : `Reach level ${it.lv}${it.price ? ' or save up' : ''}`}">${dot}${esc(it.name)}${why}</button>`
      }).join('')}</div>`).join('') + `<div class="dim">You are level ${lv}. Picks apply the next time you start.</div>`
    },
    top() {
      loadBoards()
      const names = [...new Set(['daily', ...Object.keys(boards?.boards || {}), ...Object.keys(S.best)])], me = city.multiplayer?.name
      const rows = boards?.boards?.[board] || [], fmt = (v) => board === 'daily' ? `${'★'.repeat(Math.floor(v / 1e6)) || '·'} ${money(v % 1e6)}` : v.toLocaleString('en-CA')
      return `<div class="pg-chips">${names.map((b) => `<button data-board="${esc(b)}" aria-pressed="${b === board}">${esc(BOARD_NAMES[b] || b)}</button>`).join('')}</div>
        ${!boards ? '<div class="dim">Loading…</div>' : rows.length ? `<ol>${rows.map((r, i) => `<li class="${r.name === me ? 'me' : ''}"><span>${i + 1}</span><span>${esc(r.name)}</span><span>${fmt(r.v)}</span></li>`).join('')}</ol>` : `<div class="dim">${boards.off ? 'The leaderboards are offline right now.' : 'Nobody yet: be the first.'}</div>`}
        <div class="pg-row dim">${board === 'daily' ? 'Today’s dailies done (★) and cash earned; a new board every day.' : `Your best: ${(S.best[board] || 0).toLocaleString('en-CA')}`}${me ? ` · You are ${esc(me)}` : ''}</div>`
    },
  }
  function draw() {
    const lv = levelOf(S.xp), a = XP_AT(lv), b = XP_AT(lv + 1)
    root.innerHTML = `<h3>Level ${lv} <span>${money(S.cash)}</span><small>${S.streak ? `🔥 ${S.streak} · ` : ''}🍁 ${leafCount()} / ${LEAVES.length}</small></h3>
      ${bar(S.xp - a, b - a)}<small>${(S.xp - a).toLocaleString('en-CA')} / ${(b - a).toLocaleString('en-CA')} XP to level ${lv + 1}</small>
      <div class="pg-tabs" role="tablist">${[['today', 'Today'], ['leaves', 'Leaves'], ['garage', 'Garage'], ['top', 'Top']].map(([k, n]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${n}</button>`).join('')}</div>
      <div class="pg-body">${TABS[tab]()}</div>
      <label class="dim"><input type="checkbox" data-mute ${S.mute ? '' : 'checked'}> Sounds</label>`
  }
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return
    if (b.dataset.tab) tab = b.dataset.tab
    else if (b.dataset.board) board = b.dataset.board
    else if (b.dataset.item) {
      const it = items.get(b.dataset.item); if (!it) return
      if (!unlocked(it.id)) {
        if (!it.price || S.cash < it.price) return
        S.cash -= it.price; S.own[it.id] = 1; SFX.coin(); pop(`Bought: ${it.name}`)
      }
      if (it.slot !== 'cab') { S.pick[it.slot] = it.id; city.emit('progress:choice', it.slot) }
      saveNow(); label()
    }
    const y = root.querySelector('.pg-body')?.scrollTop
    draw(); if (y) root.querySelector('.pg-body').scrollTop = y
  })
  root.addEventListener('change', (e) => {
    if (e.target.dataset.map !== undefined) { S.onMap = e.target.checked; show() }
    if (e.target.dataset.mute !== undefined) S.mute = !e.target.checked
    saveNow()
  })
  tool.button.addEventListener('click', () => { if (open()) { dailies(); draw() } })

  city.progress = {
    award, stat, score, unlocked,
    choice(slot) { const it = items.get(S.pick[slot]); return it && it.lv !== 1 && unlocked(it.id) ? { id: it.id, name: it.name, value: it.value } : null },
    get level() { return levelOf(S.xp) }, get xp() { return S.xp }, get cash() { return S.cash }, get stats() { return { ...S.stats } },
    get leaves() { return LEAVES }, // (for tools and the console)
  }
  dailies(); label(); show()

  return {
    dispose() {
      saveNow(); clearTimeout(showT); clearInterval(syncT)
      removeEventListener('pagehide', onHide); document.removeEventListener('visibilitychange', onHide)
      offTiles(); offView(); offPlayer(); offFrame()
      city.scene.remove(mesh); leafGeo.dispose(); leafMat.dispose(); out?.disconnect()
      for (const el of [css, pops]) el.remove()
      tool.remove(); delete city.progress; city.requestRender()
    },
  }
}
