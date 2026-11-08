// Drive a bus: a real TransLink route (the transit plugin's data/lines, built by tools/transit_data.py) on its
// timetable. The route picker lists every bus route each way; the shift starts at its first stop or at the stop nearest
// the map's centre, on the next scheduled trip. A GPS line on the road shows the way (the route's shape snapped to the
// streets, its kerb lane, fading out 300 m ahead) with chevrons, turn arrows and the next stop's bay; the strip on the
// right lists the stops with the timetable. People wait at the stops (more at rush hour, at exchanges and where buses
// are few), ring the bell for theirs, tap their fare at the front door and get off at the back. Happiness is smooth
// driving (no harsh braking or cornering, no bumps), stopping where asked and keeping to the timetable. Trolleybuses
// run under their wires (drawn along the route) and dewire when swung too far from them.
// Data: "Route and arrival data used in this product or service is provided by permission of TransLink. TransLink
// assumes no responsibility for the accuracy or currency of the Data used in this product or service."
import { localFrame, patternOf } from '../transit/index.js'
import { vancouver, clamp, wrap, esc, getJSON } from '../../core/util.js'
import { makeWalker } from './walker.js'
import { noise } from '../../core/play.js'

const DATA = new URL('../transit/data/', import.meta.url)
const STEP = 3, SPAN = 660, MAXS = Math.ceil(SPAN / STEP) + 2 // the lane line: a sample every 3 m over 660 m around the bus
const AHEAD = 300 // the GPS line fades out this far ahead
const WIRE_H = 5.6, POLE_L = 6.2, REACH = 0.73 // trolley wires over the lane; the poles swing at most this far (rad)
const POOL = 14 // people on foot at a stop
const fmtT = (s) => { s = ((Math.round(s / 60) % 1440) + 1440) % 1440; const h = Math.floor(s / 60), m = s % 60; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}` }

// lines on the road: drawn as if 2 m nearer the eye along their own ray (the same pixels), so the ground's mesh, coarser
// than heightAt between its vertices (a trench, a crest), doesn't swallow them; the bus and buildings in front still do
// (vCam: fades them out right under the camera)
const NEAR = 'varying float vCam; vec4 nearer(vec4 mv) { float l = length(mv.xyz); vCam = smoothstep(4.0, 12.0, l); mv.xyz *= max(0.2, 1.0 - 2.0 / l); return projectionMatrix * mv; }'

// ---------------------------------------------------------------- data
let lines = null
export function loadLines() {
  return (lines ??= Promise.all(['manifest.json', 'lines/index.json'].map((f) => getJSON(new URL(f, DATA))))
    .then(([man, index]) => ({ man, index })).catch((e) => { lines = null; throw e }))
}
export const loadRoute = (ri) => getJSON(new URL(`lines/${ri}.json`, DATA))
const brand = (r) => (r.name === '99' ? 'B-Line' : /^R\d/.test(r.name) ? 'RapidBus' : r.kind === 'trolley' ? 'Trolley' : '')
const destOf = (head) => (head.includes('/To ') ? head.split('/To ').pop() : head.replace(/^To /, ''))
export const accentOf = (r) => (r.color?.length === 7 ? parseInt(r.color.slice(1), 16) : null)
const num = (n) => { const m = /\d+/.exec(n); return m ? +m[0] : 9999 }
const badge = (r) => `<b class="bus-badge${r.name === '99' ? ' bl' : /^R\d/.test(r.name) ? ' rb' : r.kind === 'trolley' ? ' tr' : ''}">${esc(r.name)}</b>`

export const CSS = `
  .bus-pick input { width: 100%; box-sizing: border-box; font: inherit; color: var(--text); background: rgba(255,255,255,.06); border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; margin-bottom: 6px; }
  .bus-list { display: grid; gap: 4px; max-height: min(52vh, 420px); overflow-y: auto; overscroll-behavior: contain; }
  .dlv-menu .bus-list button { padding: 6px 8px; }
  .bus-badge { flex: none; min-width: 38px; height: 24px; padding: 0 5px; box-sizing: border-box; border-radius: 6px; display: inline-grid; place-items: center; background: #1d3a86; color: #fff; font: 700 13px system-ui, sans-serif; }
  .bus-badge.bl { background: #d04110 } .bus-badge.rb { background: #008522 } .bus-badge.tr { background: #1d3a86; box-shadow: inset 0 -3px 0 #f5c400 }
  .bus-dir { display: grid; grid-template-columns: 1fr auto; gap: 4px; }
  .dlv-menu .bus-dir .near { font-size: 12px; padding: 6px 8px; color: var(--muted) }
  .bus-head { display: flex; gap: 10px; align-items: center; padding: 2px 2px 6px; }
  .bus-note { font-size: 11px; color: var(--muted); line-height: 1.35; margin-top: 2px }
  .dlv-bus { left: 12px; top: 12px; padding: 8px 12px; min-width: 230px; max-width: min(360px, calc(100vw - 230px)); box-sizing: border-box; }
  .dlv-bus .rt { display: flex; gap: 8px; align-items: center; font-weight: 650; white-space: nowrap; overflow: hidden; }
  .dlv-bus .rt span { overflow: hidden; text-overflow: ellipsis }
  .dlv-bus .st { display: flex; gap: 12px; margin-top: 4px; font-variant-numeric: tabular-nums; color: #e6dccf; white-space: nowrap; }
  .dlv-bus .st b { color: #fdf6ea; font-weight: 650 }
  .dlv-strip { right: 12px; top: 60px; width: 250px; padding: 8px 10px 8px 8px; font-size: 12.5px; }
  .dlv-strip .row { display: grid; grid-template-columns: 16px 1fr auto; gap: 6px; align-items: center; padding: 3px 0; color: #d9cbbb; }
  .dlv-strip .row .n { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .dlv-strip .row .t { font-variant-numeric: tabular-nums; font-size: 11.5px }
  .dlv-strip .row i { width: 10px; height: 10px; border-radius: 50%; border: 2px solid #8fb7ff; box-sizing: border-box; justify-self: center; }
  .dlv-strip .row.past { opacity: .45 } .dlv-strip .row.past i { background: #8fb7ff }
  .dlv-strip .row.next { color: #fdf6ea; font-weight: 650 } .dlv-strip .row.next i { width: 14px; height: 14px; background: #ffb02e; border-color: #ffe1a8 }
  .dlv-strip .req { margin: 2px 0 4px 22px; display: inline-block; background: #2a0d0b; color: #ff5a3c; font: 700 11px ui-monospace, monospace; letter-spacing: .08em; padding: 2px 6px; border-radius: 4px; border: 1px solid #5a1a14; }
  .dlv-strip .eta { margin: 1px 0 4px 22px; color: #e6dccf; font-size: 11.5px; font-variant-numeric: tabular-nums }
  .dlv-strip .late { color: #ffd38a } .dlv-strip .early { color: #9fd8ff } .dlv-strip .ok { color: #8fd9b0 }
  .dlv-gps { left: 50%; top: 12px; transform: translateX(-50%); display: flex; gap: 10px; align-items: center; padding: 7px 14px 7px 8px; max-width: min(420px, calc(100vw - 560px)); min-width: 200px; box-sizing: border-box; }
  .dlv-gps svg { flex: none; width: 38px; height: 38px; }
  .dlv-gps .a { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums } .dlv-gps .b { color: #e2d4c4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .dlv-gps > div { min-width: 0 }
  .dlv-gps.warn { background: rgba(120, 40, 20, .7) }
  @media (max-width: 1000px) { .dlv-gps { top: 74px; max-width: calc(100vw - 24px) } .dlv-strip { top: 128px } }
  .compact .dlv-bus { left: var(--sl); top: var(--st); min-height: 44px; padding: 5px 10px; min-width: 0; max-width: calc(100% - var(--sl) - var(--sr) - 146px); }
  .compact .dlv-bus .st { gap: 8px; margin-top: 1px; font-size: 12px }
  .compact.dlv-assist .dlv-bus { max-width: calc(100% - var(--sl) - var(--sr) - 230px) }
  .compact .dlv-gps { top: calc(var(--st) + 56px); left: var(--sl); right: var(--sr); transform: none; max-width: none; padding: 5px 10px 5px 6px; }
  .compact .dlv-gps svg { width: 30px; height: 30px } .compact .dlv-gps .a { font-size: 15px }
  .compact .dlv-strip { top: calc(var(--st) + 106px); left: var(--sl); right: auto; width: min(250px, calc(100% - var(--sl) - var(--sr))); padding: 5px 8px; }
  .compact .dlv-strip .row:not(.next), .compact .dlv-strip .eta { display: none }
  @media (orientation: landscape) { .compact .dlv-gps { left: 50%; right: auto; transform: translateX(-50%); top: var(--st); max-width: 40% } .compact .dlv-strip { top: calc(var(--st) + 56px) } }`

// the route list for the Drive menu: search, a route, then which way and where to start
export function picker(el, data, onPick, onBack) {
  const { man, index } = data
  const rank = (r) => (r.name === '99' ? 0 : /^R\d/.test(r.name) ? 1 : r.kind === 'trolley' ? 2 : 3)
  const all = Object.keys(index).map((k) => ({ ri: +k, r: man.routes[+k], dirs: index[k] })).sort((a, b) => rank(a.r) - rank(b.r) || num(a.r.name) - num(b.r.name) || a.r.name.localeCompare(b.r.name))
  const kind = (r) => [brand(r), r.artic ? 'articulated' : ''].filter(Boolean).join(' · ')
  function list(q = '') {
    el.innerHTML = `<div class="bus-pick"><input type="search" placeholder="Route number or name: 99, 14, R4, Hastings…" aria-label="Find a route" autocomplete="off"><div class="bus-list"></div></div><button class="back" data-back>‹ Back</button>`
    const box = el.querySelector('.bus-list'), input = el.querySelector('input')
    const show = () => {
      const s = input.value.trim().toLowerCase()
      const hit = all.filter((x) => !s || x.r.name.toLowerCase() === s || x.r.name.toLowerCase().startsWith(s) || x.r.long.toLowerCase().includes(s) || x.dirs.some((d) => d[0].toLowerCase().includes(s)))
      box.innerHTML = hit.slice(0, 80).map((x) => `<button data-r="${x.ri}">${badge(x.r)}<div>${esc(x.r.long)}<small>${esc(x.dirs.map((d) => destOf(d[0])).join(' ⇄ '))}${kind(x.r) ? ' · ' + kind(x.r) : ''}</small></div></button>`).join('') || '<div class="bus-note">No route by that name.</div>'
      for (const b of box.querySelectorAll('[data-r]')) b.onclick = () => route(all.find((x) => x.ri === +b.dataset.r), input.value)
    }
    input.value = q; input.oninput = show; show()
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.focus(), 50)
    el.querySelector('[data-back]').onclick = onBack
  }
  function route(x, q) {
    el.innerHTML = `<div class="bus-head">${badge(x.r)}<div><b>${esc(x.r.long)}</b><div class="bus-note">${esc(kind(x.r) || 'Bus')}${x.r.kind === 'trolley' ? ': stay under the wires' : ''}</div></div></div>` +
      x.dirs.map((d, i) => `<div class="bus-dir"><button data-d="${i}" data-f="first"><span>➜</span><div>To ${esc(destOf(d[0]))}<small>From the first stop · ${d[1]} stops · ${d[2]} km</small></div></button><button class="near" data-d="${i}" data-f="near" title="Start at the stop nearest the middle of the map">Nearest<br>stop</button></div>`).join('') +
      '<div class="bus-note">On the next scheduled trip. Route and arrival data used in this product or service is provided by permission of TransLink.</div><button class="back" data-back>‹ All routes</button>'
    for (const b of el.querySelectorAll('[data-d]')) b.onclick = () => onPick({ ri: x.ri, r: x.r, dir: +b.dataset.d, from: b.dataset.f, man })
    el.querySelector('[data-back]').onclick = () => list(q)
  }
  list()
}

// ---------------------------------------------------------------- the shift
// ctx (from drive/index.js): THREE, city, car, bus (the model), secs (the body's boxes), nearestRoad, nearestStreet,
// loaded(x, y), popup, toast, audio(), out() (the sound's gain), tone, bell, sfx, buzz, setGoal, hideMarkers, icon (the stop sign), el(cls, html)
export function busGame(ctx, pick, d0) {
  const { THREE, city, car, bus } = ctx
  const { r, man } = pick, D = d0.dirs[pick.dir]
  const trolley = r.kind === 'trolley', artic = !!bus.userData.rear, rapid = r.name === '99' || /^R\d/.test(r.name)
  const dest = destOf(D.head), cap = artic ? 110 : 75

  // the route's shape in the drive plugin's (x, north) and its stops
  const F = localFrame(city, man), q = man.q, ns = D.shape.length / 2
  const sx = new Float64Array(ns), sy = new Float64Array(ns), cum = new Float64Array(ns)
  for (let i = 0, e = 0, n = 0; i < ns; i++) {
    e += D.shape[i * 2] * q; n += D.shape[i * 2 + 1] * q
    sx[i] = F.o.x + F.ax * e + F.bx * n; sy[i] = -(F.o.z + F.az * e + F.bz * n)
    if (i) cum[i] = cum[i - 1] + Math.hypot(sx[i] - sx[i - 1], sy[i] - sy[i - 1])
  }
  const LEN = cum[ns - 1]
  const stops = D.stops.map(([name, code, d], i) => ({ i, name, code, d: Math.min(d, LEN), short: name.includes('@') ? name.split('@').pop().trim() : name, wait: -1, alight: 0, req: false, done: false, missed: false, sched: 0, at: null }))
  const N = stops.length
  // where on the shape: at(d) → P.x, P.y and the unit direction P.dx, P.dy
  const P = { x: 0, y: 0, dx: 1, dy: 0 }
  function at(d) {
    let lo = 0, hi = ns - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m }
    const L = cum[hi] - cum[lo] || 1, t = clamp((d - cum[lo]) / L, 0, 1)
    P.x = sx[lo] + (sx[hi] - sx[lo]) * t; P.y = sy[lo] + (sy[hi] - sy[lo]) * t; P.dx = (sx[hi] - sx[lo]) / L; P.dy = (sy[hi] - sy[lo]) / L
    return P
  }
  // the nearest point of the shape to (x, y) around segment k: { d, dist }; k follows the bus
  let k = 0, lost = 0
  const J = { d: 0, dist: 0 }
  function project(x, y, move, wide) {
    let bd = Infinity, bk = k, bt = 0
    const a = wide ? 0 : Math.max(0, k - 20), b = wide ? ns - 1 : Math.min(ns - 1, k + 30)
    for (let i = a; i < b; i++) {
      const ex = sx[i + 1] - sx[i], ey = sy[i + 1] - sy[i], l2 = ex * ex + ey * ey || 1, t = clamp(((x - sx[i]) * ex + (y - sy[i]) * ey) / l2, 0, 1)
      const dx = x - sx[i] - ex * t, dy = y - sy[i] - ey * t, dd = dx * dx + dy * dy
      if (dd < bd) { bd = dd; bk = i; bt = t }
    }
    if (move) k = bk
    J.d = cum[bk] + (cum[bk + 1] - cum[bk]) * bt; J.dist = Math.sqrt(bd)
    return J
  }

  // ---------------------------------------------------------------- the timetable: the next trip from the start stop
  function prof(p) { const o = new Float64Array(N); let t = 0; for (let i = 0; i < N; i++) { t += (D.prof[p][i] || 0) * 30; o[i] = t } return o }
  function trip(i0) {
    const v = vancouver(Date.now()), pat = patternOf(man, v.ymd), now = v.sec
    let best = null, all = []
    for (let i = 0, s = 0; i < D.trips.length; i += 3) {
      s += D.trips[i]
      if (!(D.trips[i + 2] & (1 << pat))) continue
      const o = prof(D.trips[i + 1]), t = s + o[i0]
      all.push(t)
      if (t >= now - 240 && (!best || t < best.t)) best = { t, s, o } // the next one, or one just gone (start a little late)
    }
    if (!best) { // after the last one: tomorrow's first (the same timetable, near enough)
      for (let i = 0, s = 0; i < D.trips.length; i += 3) { s += D.trips[i]; const o = prof(D.trips[i + 1]), t = s + o[i0] + 86400; if (!best || t < best.t) best = { t, s: s + 86400, o } }
    }
    all.sort((a, b) => a - b)
    const j = all.findIndex((t) => t >= best.t - 1)
    const head = j > 0 && j < all.length - 1 ? (all[j + 1] - all[j - 1]) / 2 : j >= 0 && j < all.length - 1 ? all[j + 1] - all[j] : 1800
    for (let i = 0; i < N; i++) stops[i].sched = best.s + best.o[i]
    return clamp(head / 60, 3, 40)
  }

  // ---------------------------------------------------------------- the lane line: the shape on the kerb lane
  const lane = { d0: 0, n: 0, x: new Float32Array(MAXS), y: new Float32Array(MAXS), h: new Float32Array(MAXS), nx: new Float32Array(MAXS), ny: new Float32Array(MAXS), curb: new Float32Array(MAXS), snapped: new Uint8Array(MAXS), missing: false, at: 0, turns: [] }
  function buildLane(from) {
    const d0 = clamp(from, 0, Math.max(0, LEN - 20)), n = Math.min(MAXS, Math.floor((LEN - d0) / STEP) + 1)
    lane.d0 = d0; lane.n = n; lane.missing = false; lane.at = performance.now()
    for (let i = 0; i < n; i++) {
      const p = at(d0 + i * STEP), rx = p.dy, ry = -p.dx // right of the way
      if (i * STEP < 360 && !ctx.loaded(p.x, p.y)) lane.missing = true
      const s = ctx.roadAlong(p.x, p.y, p.dx, p.dy, 16) // the street the shape runs along: onto its kerb lane
      let x = p.x + rx * 2.2, y = p.y + ry * 2.2, h = NaN, curb = 2.0, ok = 0
      if (s) {
        const nx = Math.sin(s.dir) * s.along, ny = -Math.cos(s.dir) * s.along, off = clamp(s.w / 2 - 2.1, 0, 7)
        x = s.px + nx * off; y = s.py + ny * off; curb = s.w / 2 - off; ok = 1
        if (s.z != null) h = s.z + 0.58
      }
      lane.x[i] = x; lane.y[i] = y; lane.h[i] = Number.isNaN(h) ? city.world.heightAt(x, -y) + 0.2 : h; lane.curb[i] = curb; lane.snapped[i] = ok
    }
    for (let pass = 0; pass < 2; pass++) for (let i = 1; i < n - 1; i++) { lane.x[i] = (lane.x[i - 1] + 2 * lane.x[i] + lane.x[i + 1]) / 4; lane.y[i] = (lane.y[i - 1] + 2 * lane.y[i] + lane.y[i + 1]) / 4 }
    for (let i = 0; i < n; i++) { // normals (to the right) from the smoothed line
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), dx = lane.x[b] - lane.x[a], dy = lane.y[b] - lane.y[a], l = Math.hypot(dx, dy) || 1
      lane.nx[i] = dy / l; lane.ny[i] = -dx / l
    }
    // turns: where the way swings more than ~40° within 24 m
    lane.turns.length = 0
    let last = -99
    for (let i = 4; i < n - 4; i++) {
      const h0 = Math.atan2(lane.y[i] - lane.y[i - 4], lane.x[i] - lane.x[i - 4]), h1 = Math.atan2(lane.y[i + 4] - lane.y[i], lane.x[i + 4] - lane.x[i]), t = wrap(h1 - h0)
      if (Math.abs(t) > 0.7 && i - last > 10) {
        let bi = i, bt = t // the sharpest point of this bend
        for (let j = i + 1; j < Math.min(n - 4, i + 8); j++) { const g = wrap(Math.atan2(lane.y[j + 4] - lane.y[j], lane.x[j + 4] - lane.x[j]) - Math.atan2(lane.y[j] - lane.y[j - 4], lane.x[j] - lane.x[j - 4])); if (Math.abs(g) > Math.abs(bt)) { bt = g; bi = j } }
        lane.turns.push(d0 + bi * STEP, bt); last = bi; i = bi + 4
      }
    }
    ribbonFill(); if (trolley) wiresFill()
    turnAt = -1; zoneFor = -1
  }
  const L = { x: 0, y: 0, h: 0, nx: 0, ny: 0, curb: 2, ok: false } // laneAt's answer
  function laneAt(d) {
    const f = (d - lane.d0) / STEP
    if (!lane.n || f < 0 || f > lane.n - 1) { const p = at(d); L.x = p.x + p.dy * 2.2; L.y = p.y - p.dx * 2.2; L.h = city.world.heightAt(L.x, -L.y) + 0.2; L.nx = p.dy; L.ny = -p.dx; L.curb = 2; L.ok = false; return L }
    const i = Math.min(lane.n - 2, Math.floor(f)), t = f - i
    L.x = lane.x[i] + (lane.x[i + 1] - lane.x[i]) * t; L.y = lane.y[i] + (lane.y[i + 1] - lane.y[i]) * t; L.h = lane.h[i] + (lane.h[i + 1] - lane.h[i]) * t
    L.nx = lane.nx[i]; L.ny = lane.ny[i]; L.curb = lane.curb[i]; L.ok = true
    return L
  }

  // ---------------------------------------------------------------- the GPS line (a ribbon over the lane, built per section)
  const rpos = new Float32Array(MAXS * 2 * 3), rd = new Float32Array(MAXS * 2), ru = new Float32Array(MAXS * 2)
  const ridx = new Uint16Array((MAXS - 1) * 6)
  for (let i = 0; i < MAXS - 1; i++) ridx.set([i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2], i * 6)
  const rgeo = new THREE.BufferGeometry()
  rgeo.setAttribute('position', new THREE.BufferAttribute(rpos, 3)); rgeo.setAttribute('aD', new THREE.BufferAttribute(rd, 1)); rgeo.setAttribute('aU', new THREE.BufferAttribute(ru, 1))
  rgeo.setIndex(new THREE.BufferAttribute(ridx, 1))
  const uni = { uD: { value: 0 }, uT: { value: 0 }, uLen: { value: AHEAD }, uCol: { value: new THREE.Color(0x3fb8ff) } }
  const gpsMat = new THREE.ShaderMaterial({
    uniforms: uni, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    vertexShader: `attribute float aD, aU; varying float vD, vU; ${NEAR}
      void main() { vD = aD; vU = aU; gl_Position = nearer(modelViewMatrix * vec4(position, 1.0)); }`,
    fragmentShader: `uniform float uD, uT, uLen; uniform vec3 uCol; varying float vD, vU, vCam;
      void main() {
        float a = vD - uD, fade = smoothstep(-6.0, 4.0, a) * (1.0 - smoothstep(uLen * 0.55, uLen, a));
        float u = abs(vU), body = 1.0 - smoothstep(0.82, 1.0, u), glow = 1.0 - smoothstep(0.0, 1.0, u);
        float c = fract((vD - uT * 9.0) / 8.0 + u * 0.22), chev = smoothstep(0.5, 0.56, c) * (1.0 - smoothstep(0.7, 0.76, c)) * step(u, 0.7);
        vec3 col = mix(uCol, vec3(1.0), 0.25 * glow + 0.75 * chev);
        gl_FragColor = vec4(col, vCam * fade * body * (0.5 + 0.3 * glow + 0.2 * chev));
      }`,
  })
  const ribbon = new THREE.Mesh(rgeo, gpsMat)
  ribbon.frustumCulled = false; ribbon.renderOrder = 2
  function ribbonFill() {
    const n = lane.n
    for (let i = 0; i < n; i++) for (const s of [-1, 1]) {
      const j = i * 2 + (s > 0 ? 1 : 0), w = 1.0
      rpos[j * 3] = lane.x[i] + lane.nx[i] * w * s; rpos[j * 3 + 1] = lane.h[i] + 0.1; rpos[j * 3 + 2] = -(lane.y[i] + lane.ny[i] * w * s)
      rd[j] = lane.d0 + i * STEP; ru[j] = s
    }
    rgeo.setDrawRange(0, Math.max(0, n - 1) * 6)
    for (const a of ['position', 'aD', 'aU']) rgeo.attributes[a].needsUpdate = true
  }
  // turn arrows and the next stop's bay: little strips along the lane (fixed buffers, refilled when they move on)
  const arrow = strip(96, 0xffffff, false), zone = strip(96, 0xffb02e, true)
  let turnAt = -1, zoneFor = -1
  function strip(max, colour, edges) {
    const pos = new Float32Array(max * 3), u = new Float32Array(max * 2), g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(u, 2))
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color(colour) }, uA: { value: 1 }, uE: { value: edges ? 1 : 0 } }, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, side: THREE.DoubleSide, forceSinglePass: true,
      vertexShader: `varying vec2 vUv; ${NEAR} void main() { vUv = uv; gl_Position = nearer(modelViewMatrix * vec4(position, 1.0)); }`,
      fragmentShader: 'uniform vec3 uCol; uniform float uA, uE; varying vec2 vUv; varying float vCam; void main() { float e = abs(vUv.x); gl_FragColor = vec4(uCol, vCam * uA * (vUv.y > 1.5 ? 0.95 : mix(0.9, 0.16 + 0.74 * smoothstep(0.72, 0.92, e), uE))); }',
    }))
    m.frustumCulled = false; m.renderOrder = 3; m.visible = false
    return { m, g, pos, u, max }
  }
  // a band along the lane from da to db, w wide, y up; head: an arrowhead at the end (u.y 2 marks it solid)
  function fillStrip(S, da, db, w, y, head) {
    let v = 0
    const put = (x, h, z, a, b) => { if (v >= S.max) return; S.pos[v * 3] = x; S.pos[v * 3 + 1] = h; S.pos[v * 3 + 2] = z; S.u[v * 2] = a; S.u[v * 2 + 1] = b; v++ }
    const n = Math.max(2, Math.min(14, Math.ceil((db - da) / 2)))
    let px = 0, py = 0, ph = 0, pnx = 0, pny = 0
    for (let i = 0; i <= n; i++) {
      const p = laneAt(da + ((db - da) * i) / n), x = p.x, yy = p.y, h = p.h + y, nx = p.nx, ny = p.ny
      if (i) { // a quad from the last cross-section to this one, as two triangles
        put(px - pnx * w, ph, -(py - pny * w), -1, 0); put(px + pnx * w, ph, -(py + pny * w), 1, 0); put(x + nx * w, h, -(yy + ny * w), 1, 0)
        put(px - pnx * w, ph, -(py - pny * w), -1, 0); put(x + nx * w, h, -(yy + ny * w), 1, 0); put(x - nx * w, h, -(yy - ny * w), -1, 0)
      }
      px = x; py = yy; ph = h; pnx = nx; pny = ny
    }
    if (head) { // the arrowhead: a triangle past the end, along the last direction
      const fx = -pny, fy = pnx // forward = left of the right normal... (nx, ny) is to the right of the way
      put(px - pnx * w * 2.6, ph, -(py - pny * w * 2.6), 0, 2); put(px + pnx * w * 2.6, ph, -(py + pny * w * 2.6), 0, 2); put(px + fx * w * 3.2, ph, -(py + fy * w * 3.2), 0, 2)
    }
    S.g.setDrawRange(0, v)
    S.g.attributes.position.needsUpdate = true; S.g.attributes.uv.needsUpdate = true
    S.m.visible = v > 0
  }

  // ---------------------------------------------------------------- trolley wires along the lane: two wires, spans and poles
  const wireMax = MAXS * 4 + 80 * 4
  const wpos = new Float32Array(wireMax * 3), wgeo = new THREE.BufferGeometry()
  wgeo.setAttribute('position', new THREE.BufferAttribute(wpos, 3))
  const wires = new THREE.LineSegments(wgeo, new THREE.LineBasicMaterial({ color: 0x25282c }))
  wires.frustumCulled = false
  const poleGeo = new THREE.CylinderGeometry(0.11, 0.14, 7.6, 6).translate(0, 3.8, 0)
  const wpoles = new THREE.InstancedMesh(poleGeo, new THREE.MeshLambertMaterial({ color: 0x5a5f66, flatShading: true }), 60)
  wpoles.frustumCulled = false; wpoles.count = 0
  const M4 = new THREE.Matrix4()
  function wiresFill() {
    let v = 0, np = 0
    const put = (x, h, y) => { if (v < wireMax) { wpos[v * 3] = x; wpos[v * 3 + 1] = h; wpos[v * 3 + 2] = -y; v++ } }
    for (let i = 0; i < lane.n - 1; i++) for (const s of [-0.3, 0.3]) {
      put(lane.x[i] + lane.nx[i] * s, lane.h[i] + WIRE_H, lane.y[i] + lane.ny[i] * s); put(lane.x[i + 1] + lane.nx[i + 1] * s, lane.h[i + 1] + WIRE_H, lane.y[i + 1] + lane.ny[i + 1] * s)
    }
    for (let i = 0; i < lane.n; i += 11) { // a span every 33 m from a pole at the kerb across to the wires
      const c = lane.curb[i] + 0.5, x = lane.x[i] + lane.nx[i] * c, y = lane.y[i] + lane.ny[i] * c, g = city.world.heightAt(x, -y)
      put(x, g + 7.2, y); put(lane.x[i] - lane.nx[i] * 0.6, lane.h[i] + WIRE_H + 0.15, lane.y[i] - lane.ny[i] * 0.6)
      if (np < 60) wpoles.setMatrixAt(np++, M4.makeTranslation(x, g - 0.1, -y))
    }
    wgeo.setDrawRange(0, v); wgeo.attributes.position.needsUpdate = true
    wpoles.count = np; wpoles.instanceMatrix.needsUpdate = true
  }

  // ---------------------------------------------------------------- people at the stops
  const SHIRTS = [0x3f7cbf, 0xc8553d, 0x6a994e, 0xf2c14e, 0x8e6c8a, 0x2a9d8f, 0xe07a5f, 0x5c677d, 0xd4a373, 0x9b2226, 0x4a4e69, 0xf4f1de, 0x264653, 0xbc6c25]
  const PANTS = [0x2b2d42, 0x3d405b, 0x6b705c, 0x1d3557, 0x5e503f, 0x22223b], HAIR = [0x1b1b1b, 0x4a3428, 0x8d6e48, 0xcfb37a, 0x9a9a9a], SKIN = [0xf1c9a5, 0xe0ac69, 0xc68642, 0x8d5524, 0x5c3a1e]
  const folk = []
  for (let i = 0; i < POOL; i++) {
    const w = makeWalker(THREE, SHIRTS[i], { courier: false, pants: PANTS[i % PANTS.length], hair: HAIR[(i * 3) % HAIR.length], skin: SKIN[(i * 7) % SKIN.length] })
    w.visible = false
    folk.push({ w, mode: 'off', x: 0, y: 0, h: 0, yaw: 0, tx: 0, ty: 0, t: 0, then: null, speed: 0 })
  }
  const group = new THREE.Group()
  for (const f of folk) group.add(f.w)
  if (trolley) group.add(wires, wpoles)
  city.scene.add(group)
  city.overlay.add(ribbon, arrow.m, zone.m)
  const free = () => folk.find((f) => f.mode === 'off')
  const yawTo = (dx, dy) => Math.atan2(dx, dy) + Math.PI // facing (dx, dy) in (x, north): the models face -z
  function line(s) { // the people waiting at stop s, queued along the kerb behind its pole
    const p = laneAt(s.d), c = p.curb + 1.1, tx = -p.ny, ty = p.nx // along the way
    let n = 0
    for (const f of folk) if (f.mode === 'wait' && f.stop === s) n++
    for (let i = n; i < Math.min(s.wait, 10); i++) {
      const f = free()
      if (!f) break
      const along = -1 - i * 0.95 + (i % 3) * 0.2, out = c + (i % 2) * 0.55
      f.x = p.x + p.nx * out + tx * along; f.y = p.y + p.ny * out + ty * along
      f.h = city.world.heightAt(f.x, -f.y) + 0.15
      f.yaw = yawTo(-p.nx + tx * (i % 4 === 1 ? 0.8 : 0), -p.ny + ty * (i % 4 === 1 ? 0.8 : 0)) // looking out for the bus
      f.mode = 'wait'; f.stop = s; f.speed = 0; f.t = Math.random() * 3; f.w.visible = true
    }
  }
  function walkTo(f, x, y, speed, then) { f.tx = x; f.ty = y; f.speed = speed; f.then = then; f.mode = 'walk' }
  function stepFolk(dt) {
    for (const f of folk) {
      if (f.mode === 'off') continue
      if (f.mode === 'walk') {
        const dx = f.tx - f.x, dy = f.ty - f.y, d = Math.hypot(dx, dy), st = f.speed * dt
        if (d <= st + 0.05) { f.x = f.tx; f.y = f.ty; const th = f.then; f.then = null; f.mode = 'idle'; th?.(f) } else { f.x += (dx / d) * st; f.y += (dy / d) * st; f.yaw += wrap(yawTo(dx, dy) - f.yaw) * Math.min(1, dt * 10) }
        f.h += (city.world.heightAt(f.x, -f.y) + 0.15 - f.h) * Math.min(1, dt * 8)
      }
      if (f.mode === 'gone' && (f.t -= dt) <= 0) { f.mode = 'off'; f.w.visible = false; continue }
      f.w.position.set(f.x, f.h - 0.05, -f.y); f.w.rotation.set(0, f.yaw, 0)
      f.w.update(dt, f.mode === 'walk' ? f.speed : 0)
    }
  }
  function clearFolk(s) { for (const f of folk) if (!s || f.stop === s) { f.mode = 'off'; f.w.visible = false; f.stop = null } }

  // ---------------------------------------------------------------- the doors (where people get on and off, in x / north)
  const DOORS = artic ? [[0, 4.425], [0, 0], [1, 1.675]] : [[0, 4.825], [0, -0.6]] // [section, metres ahead of its middle]
  const DP = { x: 0, y: 0 }
  function doorAt(j, out = 0.7) {
    const [sec, a] = DOORS[j], b = ctx.secs[sec], rx = b.fy, ry = -b.fx // right of the section
    DP.x = b.x + b.fx * a + rx * (b.hw + out); DP.y = b.y + b.fy * a + ry * (b.hw + out)
    return DP
  }

  // ---------------------------------------------------------------- the shift's state
  const S = { i0: 0, aboard: 0, mood: 90, served: 0, missed: 0, onTime: 0, timed: 0, carried: 0, harsh: 0, sway: 0, bumps: 0, dewire: 0, km: 0, t0: performance.now(), end: false, summary: false }
  let d = 0, dLast = 0, next = 0, doors = false, doorK = 0, serving = null, boardQ = 0, alightQ = 0, tick = 0, leftAt = 0, ringAt = 0, jerkAt = 0, swayAt = 0, decel = 0, offRoute = 0
  let headway = 10, pole = { on: trolley, k: trolley ? 1 : 0, fix: 0, pitch: 0.38, yaw: 0, lat: 0 }
  const kneel = { k: 0 }
  // where to start: the first stop, or the one nearest a point
  function startAt(from, nx, ny) {
    let i0 = 0
    if (from === 'near') { let bd = Infinity; for (const s of stops.slice(0, -1)) { const p = at(s.d), dd = Math.hypot(p.x - nx, p.y - ny); if (dd < bd) { bd = dd; i0 = s.i } } }
    S.i0 = i0; next = i0
    for (let i = 0; i < i0; i++) stops[i].done = true
    headway = trip(i0)
    const s = stops[i0], dc = Math.max(s.d + 1.5 - car.V.hl, 1), p = at(dc)
    k = 0; project(p.x, p.y, true, true); d = dLast = s.d
    return { x: p.x + p.dy * 2.4, y: p.y - p.dx * 2.4, yaw: Math.atan2(p.dy, p.dx) - Math.PI / 2, d: dc }
  }
  let settled = false
  // once the tiles are in: onto the kerb lane at the stop, if the bus hasn't moved yet
  function settle(spot) {
    if (settled || lane.missing || !lane.n) return
    settled = true
    if (Math.abs(car.speed) > 0.5 || Math.hypot(car.x - spot.x, car.y - spot.y) > 8) return
    // where the lane is on a street (a terminus loop's shape often isn't): the first such spot from the stop on
    let dc = spot.d
    for (let i = Math.max(0, Math.round((dc - lane.d0) / STEP)); i < Math.min(lane.n, Math.round((dc + 120 - lane.d0) / STEP)); i++) if (lane.snapped[i] && lane.snapped[Math.min(lane.n - 1, i + 4)]) { dc = Math.max(dc, lane.d0 + i * STEP + 6); break }
    const p = laneAt(dc), dx = -p.ny, dy = p.nx
    ctx.place(p.x, p.y, Math.atan2(dy, dx) - Math.PI / 2, p.h)
    car.speed = 0
    d = dLast = project(car.x - car.V.hl * Math.sin(car.yaw), car.y + car.V.hl * Math.cos(car.yaw), true, true).d
    action(true) // the doors open: the first riders get on
  }

  // people waiting at a stop: busier at rush hour, at exchanges and stations, on B-Line and RapidBus; fewer late
  // at night; a bus every `headway` minutes gathers that long's worth
  function waiting(s) {
    if (s.i >= N - 1) return 0
    const h = vancouver(Date.now()).sec / 3600
    const rate = h < 5 ? 0.02 : h < 6.5 ? 0.06 : h < 9.5 ? 0.22 : h < 15 ? 0.12 : h < 18.5 ? 0.22 : h < 22 ? 0.07 : 0.04
    const hub = /Station|Exchange|Loop|Bay \d/.test(s.name) ? 3 : 1, m = rate * hub * (rapid ? 1.8 : 1) * clamp(headway, 3, 20)
    let n = 0, t = Math.random() // Poisson
    const e = Math.exp(-m)
    while (t > e && n < 14) { n++; t *= Math.random() }
    return Math.min(n, cap - S.aboard)
  }
  // where someone boarding at stop i is going: nearer stops more likely, exchanges and stations more
  function dest_(i) {
    const left = N - 1 - i
    if (left <= 1) return N - 1
    let tot = 0
    for (let j = i + 1; j < N; j++) tot += w(i, j, left)
    let x = Math.random() * tot
    for (let j = i + 1; j < N; j++) { x -= w(i, j, left); if (x <= 0) return j }
    return N - 1
  }
  const w = (i, j, left) => Math.exp(-(j - i) / Math.max(3, left * 0.4)) * (/Station|Exchange|Loop/.test(stops[j].name) ? 3 : 1) + (j === N - 1 ? 0.5 : 0)

  // ---------------------------------------------------------------- sounds
  let hissBuf = null
  function hiss(t, dur, vol, f = 1800) {
    const ac = ctx.audio(); if (!ac) return
    hissBuf ??= noise(ac)
    const s = ac.createBufferSource(), b = ac.createBiquadFilter(), g = ac.createGain()
    s.buffer = hissBuf; b.type = 'bandpass'; b.frequency.value = f; b.Q.value = 0.8
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    s.connect(b); b.connect(g); g.connect(ctx.out()); s.start(t); s.stop(t + dur + 0.05)
  }
  const snd = {
    doors(open) { const ac = ctx.audio(); if (!ac) return; const t = ac.currentTime; hiss(t, 0.7, 0.07); ctx.tone(open ? 880 : 660, t + 0.05, 0.25, 0.04); ctx.tone(open ? 660 : 523, t + 0.3, 0.3, 0.04) },
    fare() { const ac = ctx.audio(); if (!ac) return; const t = ac.currentTime; ctx.tone(1760, t, 0.07, 0.05, 'square'); ctx.tone(2349, t + 0.08, 0.09, 0.04, 'square') },
    ding() { const ac = ctx.audio(); if (!ac) return; const t = ac.currentTime + 0.02; ctx.bell(1174.7, t, 0.09); ctx.bell(880, t + 0.32, 0.07) },
    kneel() { const ac = ctx.audio(); if (!ac) return; hiss(ac.currentTime, 1.1, 0.05, 900) },
    dewire() { const ac = ctx.audio(); if (!ac) return; const t = ac.currentTime; hiss(t, 0.25, 0.12, 4500); ctx.tone(90, t, 0.4, 0.15); ctx.tone(620, t + 0.15, 0.5, 0.05); ctx.tone(931, t + 0.15, 0.35, 0.03) },
  }

  // ---------------------------------------------------------------- sparks (a dewirement)
  const SPARKS = 24, spPos = new Float32Array(SPARKS * 3), spVel = new Float32Array(SPARKS * 3)
  const spGeo = new THREE.BufferGeometry(); spGeo.setAttribute('position', new THREE.BufferAttribute(spPos, 3))
  const dot = document.createElement('canvas'); dot.width = dot.height = 32
  { const g = dot.getContext('2d'), r = g.createRadialGradient(16, 16, 0, 16, 16, 16); r.addColorStop(0, '#fff'); r.addColorStop(0.3, 'rgba(190,230,255,.8)'); r.addColorStop(1, 'rgba(120,180,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 32, 32) }
  const sparks = new THREE.Points(spGeo, new THREE.PointsMaterial({ color: 0xdff2ff, size: 0.22, map: new THREE.CanvasTexture(dot), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
  sparks.frustumCulled = false; sparks.visible = false
  city.overlay.add(sparks)
  let sparkT = 0
  function spark(x, h, y) {
    for (let i = 0; i < SPARKS; i++) { spPos.set([x, h, -y], i * 3); spVel.set([(Math.random() - 0.5) * 6, Math.random() * 3, (Math.random() - 0.5) * 6], i * 3) }
    sparkT = 0.8; sparks.visible = true
  }

  // ---------------------------------------------------------------- HUD
  const hud = {
    top: ctx.el('dlv dlv-bus card', `<div class="rt">${badge(r)}<span>${esc(brand(r) ? brand(r) + ' to ' : 'To ')}${esc(dest)}</span></div><div class="st"></div>`),
    gps: ctx.el('dlv dlv-gps card', '<svg viewBox="0 0 40 40"></svg><div><div class="a"></div><div class="b"></div></div>'),
    strip: ctx.el('dlv dlv-strip card', ''),
  }
  hud.st = hud.top.querySelector('.st'); hud.svg = hud.gps.querySelector('svg'); hud.a = hud.gps.querySelector('.a'); hud.b = hud.gps.querySelector('.b')
  const ARROWS = {
    left: '<path d="M27 34 V18 Q27 12 21 12 H12" fill="none" stroke="#fdf6ea" stroke-width="4.5" stroke-linecap="round"/><path d="M14 4 L5 12 L14 20 Z" fill="#fdf6ea"/>',
    right: '<path d="M13 34 V18 Q13 12 19 12 H28" fill="none" stroke="#fdf6ea" stroke-width="4.5" stroke-linecap="round"/><path d="M26 4 L35 12 L26 20 Z" fill="#fdf6ea"/>',
    ahead: '<path d="M20 36 V10" stroke="#fdf6ea" stroke-width="4.5" stroke-linecap="round"/><path d="M11 13 L20 3 L29 13 Z" fill="#fdf6ea"/>',
    stop: '<rect x="7" y="4" width="26" height="22" rx="4" fill="#2f62b8"/><rect x="12" y="9" width="16" height="9" rx="2" fill="#fff"/><rect x="18.5" y="26" width="3" height="11" fill="#c9ccd0"/>',
    back: '<path d="M30 30 Q30 10 18 10 H8" fill="none" stroke="#ffd38a" stroke-width="4.5" stroke-linecap="round"/><path d="M11 2 L3 10 L11 18 Z" fill="#ffd38a"/>',
    wire: '<path d="M4 8 H36 M4 13 H36" stroke="#ffd38a" stroke-width="2"/><path d="M12 34 L22 14 M18 34 L30 14" stroke="#ffd38a" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 3"/>',
  }
  let stripKey = '', gpsKey = '', topKey = ''
  const dist = (m) => (m > 950 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`)
  const mins = (s) => { const m = Math.round(s / 60); return m === 0 ? 'on time' : m > 0 ? `${m} min late` : `${-m} min early` }
  function drawHud(nowSec) {
    if (hud.top.hidden) for (const e of [hud.top, hud.gps, hud.strip]) e.hidden = false
    const face = S.mood > 80 ? '😊' : S.mood > 60 ? '🙂' : S.mood > 40 ? '😐' : '😟'
    const tk = `${S.aboard}|${Math.round(S.mood)}|${Math.round(Math.abs(car.speed) * 3.6)}|${pole.on}`
    if (tk !== topKey) {
      topKey = tk
      hud.st.innerHTML = `<span><b>${S.aboard}</b> aboard</span><span>${face} <b>${Math.round(S.mood)}%</b></span><span><b>${Math.round(Math.abs(car.speed) * 3.6)}</b> km/h</span>${trolley && !pole.on ? '<span style="color:#ffd38a">dewired</span>' : ''}`
    }
    // the GPS card: a dewirement, a wrong way, the next turn, else the next stop
    const s = stops[next], ahead = s ? s.d - d : 0
    let icon = 'ahead', a = '', b = '', warn = false
    const turn = nextTurn()
    if (trolley && !pole.on) { icon = 'wire'; a = 'Dewired'; b = Math.abs(car.speed) > 0.3 ? 'Stop to put the poles back up' : Math.abs(pole.lat) > 2.6 ? 'Back under the wires, then E' : `${ctx.touchy ? 'Tap Rewire' : 'Press E'} to put the poles back`; warn = true }
    else if (offRoute > 1) { icon = 'back'; a = 'Off the route'; b = `${dist(J.dist)} away: follow the blue line back`; warn = true }
    else if (S.end) { icon = 'stop'; a = 'End of the line'; b = 'Everyone off: thanks for driving!' }
    else if (turn && turn.d - d < 350 && (!s || turn.d < s.d + 10 || ahead > 80)) { icon = turn.t > 0 ? 'left' : 'right'; a = `${dist(turn.d - d)}`; b = `Turn ${turn.t > 0 ? 'left' : 'right'}${turn.st ? ' onto ' + turn.st : ''}` }
    else if (s) { icon = 'stop'; a = ahead < 15 ? 'Stop here' : dist(ahead); b = s.short + (s.req ? ' · requested' : s.wait > 0 ? ` · ${s.wait} waiting` : '') }
    const gk = icon + a + b + warn
    if (gk !== gpsKey) { gpsKey = gk; hud.svg.innerHTML = ARROWS[icon]; hud.a.textContent = a; hud.b.textContent = b; hud.gps.classList.toggle('warn', warn) }
    // the strip: the last stop, the next, the three after; the next one's ETA against the timetable
    const from = Math.max(S.i0, next - 1), to = Math.min(N, from + 5)
    let html = ''
    for (let i = from; i < to; i++) {
      const t = stops[i], cls = i < next ? 'past' : i === next ? 'next' : ''
      html += `<div class="row ${cls}"><i></i><span class="n">${esc(t.short)}</span><span class="t">${fmtT(t.sched)}</span></div>`
      if (i === next) {
        if (t.req) html += '<span class="req">STOP REQUESTED</span>'
        const eta = nowSec + Math.max(0, ahead) / Math.max(5, Math.abs(car.speed) * 0.6 + 3), late = eta - t.sched
        const first = i === S.i0, wait = first ? Math.round((t.sched - nowSec) / 60) : 0
        html += `<div class="eta">${first ? `Departs ${fmtT(t.sched)}` : `ETA ${fmtT(eta)}`} · ${first && wait > 0 ? `<span class="ok">in ${wait} min</span>` : `<span class="${Math.abs(late) < 90 ? 'ok' : late > 0 ? 'late' : 'early'}">${mins(first ? nowSec - t.sched : late)}</span>`}${t.wait > 0 ? ` · ${t.wait} waiting` : ''}</div>`
      }
    }
    if (html !== stripKey) { stripKey = html; hud.strip.innerHTML = html }
  }
  function nextTurn() {
    for (let i = 0; i < lane.turns.length; i += 2) if (lane.turns[i] > d - 4) {
      if (turnAt !== lane.turns[i]) { // its arrow on the road, and the street it turns onto
        turnAt = lane.turns[i]
        fillStrip(arrow, turnAt - 14, turnAt + 12, 0.45, 0.16, true)
        const p = laneAt(turnAt + 25), st = ctx.nearestStreet(p.x, p.y, 25)
        T.st = st ? st.name : ''
      }
      T.d = lane.turns[i]; T.t = lane.turns[i + 1]
      return T
    }
    arrow.m.visible = false
    return null
  }
  const T = { d: 0, t: 0, st: '' }

  // ---------------------------------------------------------------- per frame
  function frame(dt, now, time) {
    // where along the route: the front of the bus, on the shape
    const fx = -Math.sin(car.yaw), fy = Math.cos(car.yaw), hl = car.V.hl
    const pr = project(car.x + fx * hl, car.y + fy * hl, true, false)
    if (pr.dist > 60 && now - lost > 1500) { lost = now; project(car.x + fx * hl, car.y + fy * hl, true, true) }
    offRoute = J.dist > 30 ? offRoute + dt : 0
    d = J.d
    S.km += Math.abs(d - dLast) / 1000; dLast = d
    if (!lane.n || d > lane.d0 + 220 || d < lane.d0 + 20 && lane.d0 > 0 || (lane.missing && now - lane.at > 2000)) buildLane(d - 60)
    uni.uD.value = d; uni.uT.value = time
    if (!S.end) stopsTick(dt, now)
    doorK += ((doors ? 1 : 0) - doorK) * Math.min(1, dt * 3.2)
    ctx.doors(doorK)
    kneel.k += ((doors ? 1 : 0) - kneel.k) * Math.min(1, dt * 1.2)
    car.kneel = kneel.k
    stepFolk(dt)
    if (trolley) poles(dt, now)
    serve(dt)
    comfort(dt, now)
    // the stop's bay on the road and its marker
    const s = stops[next]
    if (s && !S.end) {
      if (zoneFor !== next) { zoneFor = next; fillStrip(zone, s.d - car.V.length - 2, s.d + 3, 1.5, 0.14, false); const p = laneAt(s.d), c = p.curb + 0.8; ctx.setGoal(p.x + p.nx * c, p.y + p.ny * c, 0xffb02e, ctx.icon) }
      zone.m.material.uniforms.uA.value = (s.req || s.wait > 0 ? 1 : 0.45) * clamp((420 - (s.d - d)) / 120, 0, 1)
    }
    if (sparkT > 0) {
      sparkT -= dt
      for (let i = 0; i < SPARKS; i++) { spVel[i * 3 + 1] -= 9.8 * dt; for (let j = 0; j < 3; j++) spPos[i * 3 + j] += spVel[i * 3 + j] * dt }
      spGeo.attributes.position.needsUpdate = true; sparks.material.opacity = clamp(sparkT / 0.5, 0, 1)
      if (sparkT <= 0) sparks.visible = false
    }
    if (now - tick > 100) { tick = now; drawHud(vancouver(Date.now()).sec) }
  }
  function stopsTick(dt, now) {
    // people turn up at the next stops as the bus gets near; the bell rings for theirs a little after the last one
    for (let i = next; i < N && stops[i].d - d < 500; i++) if (stops[i].wait < 0) stops[i].wait = i === S.i0 && !stops[i].done ? Math.max(1, waiting(stops[i])) : waiting(stops[i])
    const s = stops[next]
    if (!s) return
    if (s.wait > 0 && s.d - d < 170 && !serving && settled) line(s)
    for (const f of folk) if (f.mode === 'wait' && f.stop.d < d - 120) { f.mode = 'off'; f.w.visible = false; f.stop = null } // left behind
    if (s.alight > 0 && !s.req && (s.d - d < 220 || (leftAt && now - leftAt > ringAt))) { s.req = true; snd.ding(); ctx.buzz(20) }
    // passed it: served, skipped (nobody there, nobody for it) or missed
    if (!serving && d > s.d + 14) {
      if (!s.done && (s.wait > 0 || s.alight > 0)) {
        s.missed = true; S.missed++
        const who = s.alight, left = Math.max(0, s.wait)
        S.mood -= 4 + who * 1.5 + left * 0.8
        if (next + 1 < N) stops[next + 1].alight += who
        ctx.popup('Missed a stop!', `${who ? `${who} ${who === 1 ? 'person' : 'people'} wanted ${s.short}` : ''}${who && left ? ', and ' : ''}${left ? `${left} left waiting at the stop` : ''}.`)
      }
      s.done = true; advance(now)
    }
  }
  function advance(now) {
    next++
    leftAt = now; ringAt = 3000 + Math.random() * 9000
    if (next >= N) { S.end = true; ctx.hideMarkers(); zone.m.visible = false }
  }
  // the next stop, with the front of the bus in its bay and close to the kerb
  function inBay() {
    const s = stops[next]
    if (!s) return null
    const p = laneAt(d), lat = (car.x - p.x) * p.nx + (car.y - p.y) * p.ny
    return d > s.d - 16 && d < s.d + 8 && Math.abs(lat) < 3.2 ? s : null
  }
  // E / the button: the doors, or the poles back up
  function action(first) {
    if (S.summary) return
    if (trolley && !pole.on) {
      if (Math.abs(car.speed) > 0.3) return ctx.toast('Stop first', 1500)
      if (Math.abs(pole.lat) > 2.6) return ctx.toast('Back up under the wires first: they run over the kerb lane', 2500)
      if (!pole.fix) { pole.fix = performance.now(); ctx.sfx.door() }
      return
    }
    if (doors) return closeDoors()
    if (Math.abs(car.speed) > 0.4) return ctx.toast('Stop the bus to open the doors', 1500)
    doors = true; car.parked = true; snd.doors(true); snd.kneel()
    const s = first ? stops[next] : inBay()
    if (!s) { ctx.toast('The doors are open, but there’s no stop here', 2000); return }
    serving = s; s.at = vancouver(Date.now()).sec
    alightQ = next === N - 1 ? S.aboard : s.alight; boardQ = Math.max(0, s.wait); s.wait = Math.max(0, s.wait)
    serveT = 0.6; alightT = 0.4
    // on time? (the first stop: leaving early is what counts, see closeDoors)
    if (next !== S.i0) { const late = s.at - s.sched; S.timed++; if (Math.abs(late) < 120) { S.onTime++; S.mood += 1 } else if (late > 300) S.mood -= 2 }
    if (decel < 2.6 && S.aboard) S.mood += 0.5 // a gentle stop
  }
  let serveT = 0, alightT = 0
  function closeDoors() {
    doors = false; car.parked = false; snd.doors(false)
    const s = serving
    serving = null
    if (!s) return
    if (boardQ > 0) { S.mood -= 2 + boardQ; ctx.popup('Doors closed on them!', `${boardQ} still waiting at ${s.short}. They’ll catch the next one…`); clearFolk(s) }
    const early = s.sched - vancouver(Date.now()).sec
    if (early > 120 && next !== S.i0 && /Station|Exchange/.test(s.name)) { S.mood -= 2; ctx.popup('Leaving early', `${Math.round(early / 60)} min ahead of the timetable: someone running for it will miss you.`) }
    s.wait = 0; s.alight = 0; s.req = false; s.done = true
    S.served++
    if (next === N - 1) { S.end = true; advance(performance.now()); setTimeout(() => !S.summary && ctx.summary(), 1200) } else advance(performance.now())
  }
  function serve(dt) { // while the doors are open at a stop: off at the back, on at the front, one by one
    const s = serving
    if (!s) return
    if (alightQ > 0 && (alightT -= dt) <= 0) {
      alightQ--; s.alight--; S.aboard--; alightT = rapid ? 0.5 : 0.75
      const f = free()
      if (f) { // out of a back door and away along the sidewalk
        const p = doorAt(artic && Math.random() < 0.5 ? 2 : 1, 0.2), ln = laneAt(d), c = ln.curb + 2.2, tx = -ln.ny, ty = ln.nx, along = (Math.random() - 0.3) * 14
        const ax = ln.x + ln.nx * c + tx * along * 0.2, ay = ln.y + ln.ny * c + ty * along * 0.2, bx = ln.x + ln.nx * (c + 0.6) + tx * along, by = ln.y + ln.ny * (c + 0.6) + ty * along
        f.x = p.x; f.y = p.y; f.h = city.world.heightAt(f.x, -f.y) + 0.15; f.w.visible = true; f.stop = null
        walkTo(f, ax, ay, 1.4, (g) => walkTo(g, bx, by, 1.3, (h) => { h.mode = 'gone'; h.t = 1.5 }))
      }
    }
    if (boardQ > 0 && S.aboard < cap && (serveT -= dt) <= 0) {
      boardQ--; serveT = rapid ? 0.55 : 1.0
      // the first in the queue walks to the front door (or a back one, on the B-Line and RapidBus)
      const f = folk.find((g) => g.mode === 'wait' && g.stop === s)
      const go = () => { S.aboard++; S.carried++; s.wait = Math.max(0, s.wait - 1); const j = dest_(s.i); stops[j].alight++; snd.fare(); bus.userData.aboard(S.aboard) }
      if (f) { const p = doorAt(rapid ? Math.floor(Math.random() * DOORS.length) : 0, 0.15); walkTo(f, p.x, p.y, 1.6, (g) => { g.mode = 'off'; g.w.visible = false; g.stop = null }); go() } else go()
    }
    bus.userData.aboard(S.aboard)
  }
  // smooth driving: harsh braking or cornering with people aboard costs happiness (a word now and then)
  function comfort(dt, now) {
    const dec = -car.ax
    decel = Math.max(dec, decel - dt * 0.6)
    if (!S.aboard || Math.abs(car.speed) < 0.5) return
    const crowd = Math.min(1, 0.3 + S.aboard / 25)
    if (dec > 3.4) { S.mood -= dt * 10 * crowd; if (now - jerkAt > 6000) { jerkAt = now; S.harsh++; ctx.popup('Whoa!', 'Easy on the brakes: people are standing.'); ctx.buzz(30) } }
    const latA = Math.abs(car.speed * car.yawRate)
    if (latA > 2.7) { S.mood -= dt * 8 * crowd; if (now - swayAt > 6000) { swayAt = now; S.sway++; ctx.popup('Hold on tight!', 'Slower round the corners: coffee everywhere.') } }
    S.mood = clamp(S.mood, 0, 100)
  }
  // a knock or a kerb (from drive/index.js): impact in m/s
  function bump(k) { S.bumps++; if (S.aboard) S.mood = clamp(S.mood - Math.min(8, 1 + k), 0, 100) }

  // ---------------------------------------------------------------- the trolley poles: up to the wires, or off them
  function poles(dt, now) {
    const ud = bus.userData, b = ctx.secs[artic ? 1 : 0], off = artic ? 0.6 : -2.75 // the base, metres ahead of its section's middle
    const bx = b.x + b.fx * off, by = b.y + b.fy * off
    const pr = project(bx, by, false, false), ln = laneAt(J.d), rx = b.fy, ry = -b.fx
    const lat = (ln.x - bx) * rx + (ln.y - by) * ry // the wires, to the right of the base (+)
    pole.lat = lat
    const baseH = car.h + 3.44, rise = clamp(ln.h + WIRE_H - baseH, 0.5, 4), a = Math.asin(rise / POLE_L), reach = POLE_L * Math.cos(a)
    if (pole.on && settled && pr.dist < 40) {
      if (Math.abs(lat) > reach * Math.sin(REACH) || offRoute > 0.5) { // off the wires
        pole.on = false; car.nopower = true; S.dewire++; S.mood = clamp(S.mood - 4, 0, 100)
        snd.dewire(); ctx.buzz([40, 30, 60])
        const tip = POLE_L * Math.cos(a)
        spark(bx - b.fx * tip + rx * lat, ln.h + WIRE_H, by - b.fy * tip + ry * lat)
        ctx.popup('Dewired!', 'The poles jumped off the wires. Stop, then put them back up.')
      }
    }
    if (pole.fix && now - pole.fix > 3500) { pole.fix = 0; pole.on = true; car.nopower = false; ctx.sfx.clank(); ctx.toast('Poles back on the wires', 1500) }
    // aim: on the wires, swung over to them; off: down on the hooks; while being put back: rising
    const tp = pole.on ? a : pole.fix ? a * clamp((now - pole.fix) / 3500, 0, 1) : 0.03, ty = pole.on || pole.fix ? Math.asin(clamp(lat / reach, -0.95, 0.95)) * (pole.on ? 1 : clamp((now - pole.fix) / 3500, 0, 1)) : 0
    pole.pitch += (tp - pole.pitch) * Math.min(1, dt * (pole.on ? 12 : 3)); pole.yaw += (ty - pole.yaw) * Math.min(1, dt * (pole.on ? 12 : 3))
    for (const p of ud.poles) { p.rotation.x = -pole.pitch; p.rotation.y = pole.yaw }
  }

  // ---------------------------------------------------------------- the end of the shift
  function summary() {
    const mins = (performance.now() - S.t0) / 60000
    const stars = Math.max(1, Math.min(5, Math.round(1 + 4 * (S.mood / 100) * (S.served ? 1 : 0.4) - (S.missed ? 0.5 : 0))))
    const line = !S.carried ? 'No passengers this time: the depot’s kettle is on.' : S.missed ? 'A few missed stops: keep an ear out for the bell.'
      : S.harsh + S.sway > 2 ? 'Everyone got there, if a little shaken. Gently on the pedals!' : stars >= 4 ? 'Smooth, punctual and friendly: a model operator.' : 'A solid shift. Put your feet up.'
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`
    return { title: `Coast Transit · ${r.name} ${esc(dest)}`, big: `${S.carried} rider${S.carried === 1 ? '' : 's'}`, stars, line,
      rows: row('Stops served', `${S.served}${S.missed ? `, ${S.missed} missed` : ''}`) + row('On time', S.timed ? `${Math.round((100 * S.onTime) / S.timed)}% of stops` : '–') +
        row('Happiness', `${Math.round(S.mood)}%`) + row('Smooth driving', S.harsh + S.sway ? `${S.harsh} harsh stop${S.harsh === 1 ? '' : 's'}, ${S.sway} swerve${S.sway === 1 ? '' : 's'}` : 'silky') +
        row('Bumps', S.bumps || 'none') + (trolley ? row('Dewirements', S.dewire || 'none') : '') + row('Driven', `${S.km.toFixed(1)} km in ${Math.max(1, Math.round(mins))} min`) }
  }

  function dispose() {
    city.scene.remove(group); city.overlay.remove(ribbon, arrow.m, zone.m, sparks)
    for (const g of [rgeo, arrow.g, zone.g, wgeo, poleGeo, spGeo]) g.dispose()
    for (const m of [gpsMat, arrow.m.material, zone.m.material, wires.material, wpoles.material, sparks.material]) { m.map?.dispose(); m.dispose() }
    for (const f of folk) f.w.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); m.material.dispose() } })
    for (const e of [hud.top, hud.gps, hud.strip]) e.remove()
    car.nopower = false; car.parked = false; car.kneel = 0
  }
  // is (x, y) in the route's lane, where the bus is? (posts the map puts there, where a street's width is off, are let be)
  function inLane(x, y) {
    if (!lane.n) return false
    const jd = J.d, jt = J.dist, p = project(x, y, false, false)
    let ok = false
    if (p.dist < 25) { const l = laneAt(p.d); ok = Math.abs((x - l.x) * l.nx + (y - l.y) * l.ny) < 1.6 }
    J.d = jd; J.dist = jt
    return ok
  }
  // R: back onto the lane where the bus is along the route
  function resetSpot() {
    const p = laneAt(Math.max(d - car.V.hl, 0)), dx = -p.ny, dy = p.nx
    return { x: p.x, y: p.y, yaw: Math.atan2(dy, dx) - Math.PI / 2, h: p.h }
  }
  const actionLabel = () => (S.summary ? '' : trolley && !pole.on ? (pole.fix ? 'Rewiring…' : Math.abs(car.speed) < 0.3 ? 'Rewire' : '') : doors ? 'Close doors' : Math.abs(car.speed) < 0.4 ? 'Open doors' : '')
  const G = { x: 0, y: 0 }
  const goal = () => { const s = stops[next]; if (!s || S.end) return null; const p = laneAt(s.d); G.x = p.x; G.y = p.y; return G }
  bus.userData.aboard(0)
  ctx.bus.userData.setSign(r.name, dest, accentOf(r) ? r.color : null)
  return { S, startAt, settle, inLane, frame, action, actionLabel, bump, summary, dispose, resetSpot, goal, get serving() { return !!serving }, get busy() { return !!serving && (boardQ > 0 || alightQ > 0) }, get doors() { return doors }, get end() { return S.end }, get d() { return d }, get next() { return stops[next] }, stops, trolley, pole, lane, get settled() { return settled } }
}
