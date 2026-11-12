// node tools/clip_check.mjs [--routes downtown-van,beach-walk] [--secs 45] [--procs 4] [--out file.json] [--base main.json] [--cap 220] [--shots dir] [--tier high] [--tiles https://vancouver.borodutch.com/tiles]
// Clipping at play time (#587): the real page in Chrome, an autopilot in each third-person mode (van, cab, bus,
// walker, hiker, boat) over places across the map; every frame it counts
//   camera:  inside  the view shows the back of solid geometry (a second, tiny render of the solid meshes through the
//                    game's camera with back faces in red: inside a building, under the ground or a deck, in a tunnel wall)
//                    counted when back faces within 6 m fill > 1% of the view, or any > 8%
//            under   the camera is under the terrain
//            camTree the lens is in a tree's trunk; camShip (sailing) in a ship's hull or a bridge pier
//   player:  nan (its position is not a number: nothing is drawn), bldg (in a building footprint), tree / post (a trunk or a pole in the body), car / ped (traffic, people
//            in the body), wheel (a wheel > 20 cm under or over the road), feet (the walker's feet > 30 cm under or
//            over the ground), shore / ship (a metre of the boat's hull on land, the hull in a ship or a bridge pier)
//   others:  npcBldg (a simulated car or pedestrian near the player inside a building), npcProp (in a trunk or pole),
//            npcCar (two simulated cars in each other)
// The autopilot follows the road or path, and every few seconds swerves off it into whatever stands beside it, then
// reverses, so walls, trees, poles and parked cars get hit and the camera is squeezed against them.
// Repeatable, so it can gate a PR (--base): nothing live is fetched (no other players, ships, planes, weather: a
// fixed Wednesday 13:00), and from before the mode starts the page runs on a clock of exactly 1/60 s a frame
// (performance.now, the frame's time, Date.now, its timers) with seeded Math.random (three.js's object ids from a
// stream of their own; the traffic worker's too, its time budget counted in calls), a frame waiting for the tiles and
// files being fetched and for the traffic's answer to the last one; the traffic starts anew from the tiles the page
// has when the player is down from the map, then the streets fill for 10 s before the count. --secs × 60 frames
// however fast the machine draws them (a route is CUT, and fails the gate, at under a quarter of real time).
// Measured (#598): two runs of a build give the same counts on 14 to 16 of the 16 routes; on tunnel-van and
// seawall-walk the traffic can take one of two courses (CLAUDE.md).
// Looking into one: --routes one --at wheel[:n] stops at the (n-th) frame counted as that kind, --js 'expression' prints its value in the page then; --each 'expression' its value at every counted frame.
// Prints one line per route (frames, then the count of frames per kind) and the total; --out writes them with the
// first spots of each kind; --shots saves a frame of each kind as it happens (for tools/sheet.py).
import { args, server, open, settle } from './pw.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const ROUTES = { // name: [kind, lat, lon, option]
  'downtown-van': ['car', 49.2838, -123.1185],
  'gastown-taxi': ['taxi', 49.2836, -123.1085],
  'bridge-van': ['car', 49.2755, -123.1368, 'deck'], // Burrard Bridge: starts on the nearest deck
  'tunnel-van': ['car', 49.2775, -123.0312, 'tunnel'], // Cassiar tunnel: starts in the nearest tube (in the published tiles: --tiles)
  'massey-van': ['car', 49.1217, -123.0757, 'tunnel'], // George Massey tunnel
  'suburb-van': ['car', 49.2335, -123.156],
  'northshore-van': ['car', 49.342, -123.073],
  'bus-14': ['bus', 0, 0, '14'],
  'downtown-walk': ['foot', 49.2827, -123.1207],
  'beach-walk': ['foot', 49.2745, -123.153],
  'seawall-walk': ['foot', 49.287, -123.143],
  'slope-walk': ['foot', 49.2416, -123.1128], // Queen Elizabeth Park: the quarry's banks, steps and paths
  'grind-hike': ['hike', 0, 0, 'grind'],
  'falsecreek-sail': ['sail', 49.2728, -123.131],
  'bridge-sail': ['sail', 49.2752, -123.1372], // under Burrard Bridge: its piers, Granville Island's docks
  'marina-sail': ['sail', 49.2916, -123.125], // Coal Harbour: moored boats, floats
}
const [o, rest] = args(process.argv.slice(2), { routes: Object.keys(ROUTES).join(','), secs: 45, procs: 4, out: '', base: '', cap: 0, shots: '', rt: '', tier: 'high', dpr: 1, tiles: '', at: '', js: '', each: '' })
const names = String(o.routes).split(',')

if (names.length > 1) { // the parent: a process per route, a few at a time
  const res = [], todo = [...names]
  const one = (n) => new Promise((done) => {
    let buf = ''
    const p = spawn(process.execPath, [process.argv[1], '--routes', n, '--secs', o.secs, '--tier', o.tier, '--cap', o.cap, ...(o.tiles ? ['--tiles', o.tiles] : []), ...(o.port ? ['--port', o.port] : []), ...(o.shots ? ['--shots', o.shots] : [])], { stdio: ['ignore', 'pipe', 'inherit'] })
    const cap = setTimeout(() => p.kill(), ((+o.cap || (+o.secs + 10) * 4) + 300) * 1000) // (the page's load and the frames, both capped in the child: this is for one that hangs)
    p.stdout.on('data', (d) => (buf += d)); p.on('close', () => { clearTimeout(cap); try { res.push(JSON.parse(buf.trim().split('\n').pop())) } catch { res.push({ route: n, error: buf.slice(-200) }) } done() })
  })
  await Promise.all(Array.from({ length: +o.procs }, async () => { while (todo.length) await one(todo.shift()) }))
  res.sort((a, b) => names.indexOf(a.route) - names.indexOf(b.route))
  const total = {}
  for (const r of res) {
    for (const [k, v] of Object.entries(r.counts || {})) total[k] = (total[k] || 0) + v
    console.log(`${r.route.padEnd(16)} ${r.error ? 'ERROR ' + r.error : `${String(r.frames).padStart(5)} frames, ${Math.round(r.dist)} m  ${JSON.stringify(r.counts)}${r.cut ? ' CUT' : ''}${r.stalled ? ' stalled ' + r.stalled : ''}`}`)
  }
  console.log(`TOTAL ${JSON.stringify(total)}  sum ${Object.values(total).reduce((a, b) => a + b, 0)}`)
  if (o.out) fs.writeFileSync(o.out, JSON.stringify(res, null, 1))
  let worse = 0
  if (o.base) { // the gate: no route with more frames of a kind than in --base (the same check's --out on main; over by 3 frames + 2% is no more: two runs of one build differ by a frame or two of `inside` in a tunnel); a route that didn't run to the end fails too
    const base = Object.fromEntries(JSON.parse(fs.readFileSync(o.base, 'utf8')).map((r) => [r.route, r]))
    for (const r of res) {
      const b = base[r.route]?.counts || {}, bad = r.error || r.cut ? ['did not finish'] : r.stalled ? ['stalled (a tile or the traffic never answered: not repeatable)'] : Object.entries(r.counts).filter(([k, v]) => v > (b[k] || 0) * 1.02 + 3).map(([k, v]) => `${k} ${b[k] || 0} -> ${v}`)
      if (bad.length) { worse++; console.log(`WORSE ${r.route}: ${bad.join(', ')}`) }
    }
    console.log(worse ? `${worse} route(s) worse than ${o.base}` : `no route worse than ${o.base}`)
  }
  process.exit(worse ? 1 : 0)
}

// ---------------------------------------------------------------- one route, in the page
const name = names[0], [kind, lat, lon, option] = ROUTES[name]
const srv = await server(o.port)
process.on('exit', () => srv.stop()) // (also when the page fails to open)
const init = () => {
  // nothing live: no other players, ships, planes or weather (each run would see its own)
  window.WebSocket = function () { return { send() {}, close() {}, addEventListener() {} } }
  const fetch0 = window.fetch
  let pending = 0 // the page's own files on their way (a bus line's timetable, a hike): frames wait for them, whole
  window.fetch = (u, ...a) => {
    if (new URL(u.url || u, location.href).origin !== location.origin) return Promise.reject(new TypeError('offline (clip_check)'))
    pending++
    const rec = [String(u.url || u).slice(-40), n, vt == null ? 'real' : 'v']; (window.__flog ||= []).push(rec)
    return fetch0(u, ...a).then(async (r) => { // (read here: what the page does with it then follows at once, not some frames later)
      const buf = await r.arrayBuffer(), res = new Response(buf, { status: r.status, statusText: r.statusText, headers: r.headers }), text = () => new TextDecoder().decode(buf)
      return Object.assign(res, { arrayBuffer: () => Promise.resolve(buf.slice(0)), text: () => Promise.resolve(text()), json: () => new Promise((ok) => ok(JSON.parse(text()))) })
    }).finally(() => { pending--; rec.push(n) })
  } // __vclock(): from then on the page runs on its own clock, 1/60 s a frame, in step with its workers
  const raf = window.requestAnimationFrame.bind(window), real = performance.now.bind(performance)
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window), ct = window.clearTimeout.bind(window), ci = window.clearInterval.bind(window)
  const rnd = (s) => () => { let t = (s = (s + 0x6d2b79f5) | 0); t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  let vt = null, n = 0, seen = -1, go = true, held = 0, ticks = 0, nid = 1e7, stalled = 0, last = 0, renew = null, fresh = false
  const v0 = 3.6e6
  const timers = new Map() // setTimeout / setInterval on the page's clock
  window.__renew = () => renew?.()
  window.__vclock = () => { const now = real(); for (const t of timers.values()) t.at = v0 + Math.max(0, t.at - now); vt = v0; const r = rnd(7), ids = rnd(5); window.__rn = 0
    Math.random = () => { // three.js names every object it makes with four of these (a mesh streamed in, a landmark's scan loaded: whenever that happens to be): those from a stream of their own
      const lim = Error.stackTraceLimit; Error.stackTraceLimit = 2; const st = new Error().stack; Error.stackTraceLimit = lim
      if (st.includes('three.module')) return ids()
      window.__rn++; if (window.__rlog) window.__rlog.push(new Error().stack.split('\n').slice(2, 5).join(' < ').replace(/http:\/\/[^/]+/g, '')); return r()
    }
    fresh = true } // (from an hour in, whenever the page got here: the same sums of 1/60 s, to the last bit, every run)
  performance.now = () => vt ?? real()
  const d0 = Date.UTC(2026, 0, 14, 21) // a Wednesday, 13:00 in Vancouver: the timetable, the tide, the traffic's hour are every run's
  Date.now = () => d0 + (vt == null ? 0 : Math.round(vt - v0))
  // (the page's timers are kept here from the start, run off the real clock until __vclock(): one set before it,
  // the traffic's "send the new tiles in 250 ms", then comes due on the page's clock like the rest, in the same frame every run)
  const due = (now) => { for (const [id, t] of [...timers]) if (t.at <= now && timers.has(id)) { if (t.every) t.at += t.every; else timers.delete(id); t.fn(...t.a) } }
  const pump = si(() => (vt == null ? due(real()) : ci(pump)), 4)
  window.setTimeout = (fn, ms = 0, ...a) => { if (typeof fn !== 'function') return st(fn, ms, ...a); timers.set(++nid, { at: (vt ?? real()) + (+ms || 0), fn, a }); return nid }
  window.setInterval = (fn, ms = 0, ...a) => { if (typeof fn !== 'function') return si(fn, ms, ...a); timers.set(++nid, { at: (vt ?? real()) + (+ms || 0), fn, a, every: Math.max(1, +ms || 0) }); return nid }
  window.clearTimeout = (id) => { if (!timers.delete(id)) ct(id) }
  window.clearInterval = (id) => { if (!timers.delete(id)) ci(id) }
  // a frame waits for the tiles being fetched and decoded and for the traffic worker's answer to the last frame, so
  // what they bring arrives in the same frame every run (not for ever: two minutes)
  const waiting = () => ticks > 0 || pending > 0 || [...window.view.tiles.tiles.values()].some((t) => t.state === 'loading' && !t.res)
  window.__waits = () => ({ stalled, ticks, loading: [...window.view.tiles.tiles].filter(([, t]) => t.state === 'loading' && !t.res).map(([k]) => k) }) // (for --js)
  window.requestAnimationFrame = (fn) => raf(function cb(ts) {
    if (vt == null) { last = ts; return fn(ts) }
    if (window.__clip?.hold) return raf(cb) // (--at: stopped at that frame, as it is)
    if (ts !== seen) { // a new frame: the one before is drawn, count it
      seen = ts
      if (fresh && !ticks) { fresh = false; renew?.() } // (once the old one has answered: the page waits for that)
      go = stalled > 2 || !waiting() || ++held >= 7200
      if (go && held >= 7200) { stalled++; ticks = pending = 0 } // (a tile or an answer that never comes: after three of those the run goes on without waiting, and says so)
      if (go) {
        held = 0; try { window.__clip?.sample?.() } catch (e) { window.__clip.error = String(e.stack || e).slice(0, 300) } if (!window.__clip?.hold) vt = v0 + (++n * 1000) / 60
        if (window.__clip?.hold) go = false; else {
          due(vt)
          window.view.tiles.made.sort((a, b) => a.level - b.level || a.i - b.i || a.j - b.j) // (the tiles that came in since the last frame: built in the same order every run, not as their fetches happened to end)
        }
      }
    }
    if (go) fn(vt); else raf(cb)
  })
  // the traffic and people (a worker with no imports): seeded random numbers, its time budget counted in calls; and at
  // __vclock() a new one, given the tiles it had in a fixed order, so the cars and people of a run don't hang on what
  // happened while the page loaded (the run then waits WARM frames for the streets to fill)
  const W = window.Worker
  window.Worker = function (url, opt) {
    if (!/life\/worker/.test(String(url))) return new W(url, opt)
    const src = URL.createObjectURL(new Blob([`{ let c = 0; Math.random = (${rnd})(11); performance.now = () => (c += 0.01) }\nimportScripts(${JSON.stringify(String(url))})`], { type: 'text/javascript' }))
    const had = { tiles: new Map(), masks: [], area: null, opts: null }
    let w, first = false
    const make = () => { w = new W(src, opt); w.onmessage = (e) => { if (e.data?.type === 'frame' && ticks) ticks--; F.onmessage?.(e) } }
    const F = { onmessage: null, terminate: () => w.terminate(),
      postMessage(m, tr) {
        if (m?.type === 'tick') { ticks++; if (first) { first = false; m.dt = 1 / 60 } } // (the new one's first step: not the time since the old one's last, which was the machine's)
        if (window.__wlog && window.__wlog.length < 6000) window.__wlog.push(JSON.stringify(m, (k, v) => (k === 'buf' ? undefined : ArrayBuffer.isView(v) ? v.length : k === 'add' ? v.map((t) => t.key) : v)).slice(0, 400)) // (--js '__wlog = []' ... to see what the worker is told)
        if (m?.type === 'tiles') { for (const k of m.drop) had.tiles.delete(k); for (const t of m.add) had.tiles.set(t.key, t); had.masks = m.masks }
        else if (m?.type === 'area' || m?.type === 'opts') had[m.type] = m
        w.postMessage(m, tr)
      } }
    renew = () => {
      window.__wlog = ['renew ' + JSON.stringify([had.opts, [...had.tiles.keys()].sort(), had.area, had.masks.length])]; first = true
      let h = 0; for (const c of window.__wlog[0]) h = (h * 31 + c.charCodeAt(0)) | 0
      window.__life = `${had.tiles.size} tiles ${(h >>> 0).toString(36)}` // what the traffic starts from (in the output: two runs that part at once differ here)
      w.terminate(); make()
      if (had.opts) w.postMessage(had.opts)
      w.postMessage({ type: 'tiles', add: [...had.tiles.values()].sort((a, b) => (a.key < b.key ? -1 : 1)), drop: [], masks: had.masks })
      if (had.area) w.postMessage(had.area)
    }
    make()
    return F
  }
}
const { browser, page, errs } = await open({ ...o, port: srv.port, query: '?drivedebug&lifedebug', hash: '#13645,11243,0.1295', init })
await settle(page, 500)
await page.waitForFunction(() => window.driveDebug, null, { timeout: 30000 })
const goto = (la, lo) => page.evaluate(([la, lo]) => { const c = city, d = c.world.fromLatLon(la, lo).sub(c.controls.target); c.camera.position.add(d); c.controls.target.add(d); c.camera.zoom = 0.12; c.camera.updateProjectionMatrix(); c.controls.update(); c.requestRender() }, [la, lo])
if (lat) { await goto(lat, lon); await settle(page, 1500) } // (its tiles first: the start is on its street, deck or tube)
// the mode is started on the page's own clock, with its seeded random numbers (Rush Fare's ramps and fares, the
// bus's riders, the dive down from the map are every run's), and the run counts its frames from the dive's end
const begin = ([kind, la, lo, option]) => {
  const D = driveDebug
  if (kind === 'bus') return D.startBus(option, 0)
  if (kind === 'hike') return D.startHike(option)
  const p = city.world.fromLatLon(la, lo)
  if (kind === 'sail') return sailDebug.start(p.x, p.z)
  let x = p.x, y = -p.z, yaw = 0, z = null
  if (option) { // the start of the nearest deck / tube, along it
    let bd = 1500
    for (const t of city.tiles.tiles.values()) for (const q of t.graph?.pieces || []) {
      if (!q.drive || !q.z || !!q.tunnel !== (option === 'tunnel') || q.pts.length < 4) continue
      const i = (q.pts.length >> 2) * 2, j = i / 2, d = Math.hypot(q.pts[i] - p.x, q.pts[i + 1] + p.z) // (its middle: off the joint at its end)
      if (d < bd && i + 3 < q.pts.length) { bd = d; x = q.pts[i]; y = q.pts[i + 1]; z = q.z[j]; yaw = Math.atan2(q.pts[i + 3] - y, q.pts[i + 2] - x) - Math.PI / 2 }
    }
    if (z == null) throw new Error('no ' + option + ' near')
    window.__deck = z + 0.58
  }
  if (!option && kind === 'car') { const r = D.nearestRoad(x, y, 80); if (r) { x = r.px; y = r.py; yaw = Math.atan2(r.s.y1 - r.s.y0, r.s.x1 - r.s.x0) - Math.PI / 2 } } // on the street, along it
  if (kind === 'taxi') D.startTaxi(x, y); else D.start(kind, x, y, yaw)
}

await page.evaluate(async ([kind, stopAt, atN, maxFrames, begin, how, eachSrc]) => {
  const each = eachSrc && (0, eval)('() => (' + eachSrc + ')') // --each 'expr': its value at every counted frame (two runs side by side: the frame they part at)
  const THREE = await import('three'), D = window.driveDebug, W = city.world, T = city.traffic
  const WARM = 600 // frames
  __vclock()
  const go = () => { try { Promise.resolve((0, eval)('(' + begin + ')')(how)).catch((e) => { C.error = String(e) }) } catch (e) { C.error = String(e) } }
  const C = (window.__clip = { px: null, frames: 0, counts: {}, spots: {}, shot: null, dist: 0, cat: {}, trace: [], each: [], warm: kind === 'sail' ? 60 : WARM, warm0: kind === 'sail' ? 60 : WARM })
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), boat = kind === 'sail', foot = kind === 'foot' || kind === 'hike'
  // ---- the back-face pass: solid, one-sided, static meshes only (no instances, sprites, glass or shader effects)
  const rt = new THREE.WebGLRenderTarget(160, 100), px = new Uint8Array(160 * 100 * 4), R = view.renderer
  C.px = px
  // (the back faces first, then the front faces over them where they are as near or nearer: a wall built of two
  // faces back to back, as a tunnel's tube is, shows its front)
  const vertexShader = 'varying float d; void main() { vec4 p = modelViewMatrix * vec4(position, 1.0); d = -p.z; gl_Position = projectionMatrix * p; }'
  const mat = new THREE.ShaderMaterial({ side: THREE.BackSide, uniforms: { cat: { value: 0 } }, vertexShader, fragmentShader: 'uniform float cat; varying float d; void main() { gl_FragColor = vec4(1.0, cat / 255.0, d < 6.0 ? 1.0 : 0.0, 1.0); }' })
  const front = new THREE.ShaderMaterial({ side: THREE.FrontSide, depthFunc: THREE.LessEqualDepth, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8, vertexShader, fragmentShader: 'void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }' })
  const CATS = ['', 'building', 'ground', 'road', 'landmark', 'other']
  const catOf = (o) => { const a = o.geometry.attributes; return a.aFac ? 1 : a.cls ? 2 : a.aRoad ? 3 : o.userData.landmarks || a.aWin ? 4 : 5 }
  const solid = (o) => { const M = o.material; return o.isMesh && !o.isInstancedMesh && !o.geometry.isInstancedBufferGeometry && !Array.isArray(M) && M.side === THREE.FrontSide && !M.transparent && !M.isShaderMaterial && M.depthWrite }
  const hidden = []
  function backFaces() { // the share of the view (0 .. 1) showing back faces, and what of
    const cam = city.view.camera, bg = city.scene.background, auto = R.shadowMap.autoUpdate, was = R.getRenderTarget()
    city.scene.traverseVisible((o) => {
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return
      if (!solid(o)) { o.visible = false; hidden.push(o) } else if (!o.__cat) { o.__cat = catOf(o); const f = o.onBeforeRender; o.onBeforeRender = function (...a) { if (a[4] === mat) { mat.uniforms.cat.value = o.__cat; mat.uniformsNeedUpdate = true } f.apply(this, a) } }
    })
    city.scene.overrideMaterial = mat; city.scene.background = null; R.shadowMap.autoUpdate = false
    const ac = R.autoClear
    R.setRenderTarget(rt); R.clear(); R.autoClear = false; R.render(city.scene, cam); city.scene.overrideMaterial = front; R.render(city.scene, cam); R.autoClear = ac; R.readRenderTargetPixels(rt, 0, 0, 160, 100, px)
    R.setRenderTarget(was); city.scene.overrideMaterial = null; city.scene.background = bg; R.shadowMap.autoUpdate = auto
    for (const o of hidden) o.visible = true
    hidden.length = 0
    let n = 0, near = 0; const by = [0, 0, 0, 0, 0, 0]
    for (let i = 0; i < px.length; i += 4) if (px[i] > 128) { n++; by[px[i + 1]]++; if (px[i + 2] > 128) near++ }
    return { share: n / 16000, near: near / 16000, of: CATS[by.indexOf(Math.max(...by))] }
  }
  // ---- helpers on the game's own data
  const inB = (x, y) => !!D.collide(x, y, 0.01)
  const deepIn = (x, y) => { const p = D.collide(x, y, 0.01); return !!p && Math.hypot(p.x, p.y) > 0.4 } // well inside (not in a doorway)
  const boxOf = (x, y, fx, fy, hl, hw) => ({ x, y, fx, fy, hl, hw })
  const circleIn = (b, x, y, r) => { // how deep a circle is in a box (> 0: in)
    const dx = x - b.x, dy = y - b.y, a = dx * b.fx + dy * b.fy, s = dx * b.fy - dy * b.fx
    return r - Math.hypot(Math.max(0, Math.abs(a) - b.hl), Math.max(0, Math.abs(s) - b.hw))
  }
  const boxIn = (a, b) => { // overlap depth of two boxes (separating axes), 0 if apart
    let best = Infinity
    for (const [nx, ny] of [[a.fx, a.fy], [a.fy, -a.fx], [b.fx, b.fy], [b.fy, -b.fx]]) {
      const ra = a.hl * Math.abs(a.fx * nx + a.fy * ny) + a.hw * Math.abs(a.fy * nx - a.fx * ny), rb = b.hl * Math.abs(b.fx * nx + b.fy * ny) + b.hw * Math.abs(b.fy * nx - b.fx * ny)
      const d = ra + rb - Math.abs((a.x - b.x) * nx + (a.y - b.y) * ny)
      if (d <= 0) return 0
      best = Math.min(best, d)
    }
    return best
  }
  const npcBox = (q) => boxOf(q.x, -q.z, Math.sin(q.heading), -Math.cos(q.heading), (q.length || 4.4) / 2, (q.width || 1.8) / 2)
  const dry = (x, z) => { // land in the tile's water mask (where the tile is in)
    const t = city.tiles.tiles.get?.(`0/${Math.floor(x / 1024)}_${Math.floor(-z / 1024)}`) || [...city.tiles.tiles.values()].find((t) => t.level === 0 && t.water && x >= t.ox && x < t.ox + 1024 && -z >= t.oy && -z < t.oy + 1024), w = t?.water
    return !!w && w.mask[Math.floor(((-z - t.oy) / 1024) * w.n) * w.n + Math.floor(((x - t.ox) / 1024) * w.n)] !== 1
  }
  const BENCH = 6 // drive/props.js
  const tilesIn = () => { const t = view.tiles; return !t.queue.length && !t.made.length && !t.warming.length && ![...t.tiles.values()].some((x) => x.state === 'loading') }
  let veh = null
  const v = new THREE.Vector3(), v2 = new THREE.Vector3()
  let last = null
  C.sample = () => {
    const P = city.player
    if (!P || C.off || (boat ? sailDebug : D).state !== 'play') return // (not yet down from the map)
    // the traffic and people anew (half a second in: the page has sent the tiles round the player by then), not what the worker made of them as they came in
    if (C.warm === C.warm0 && !tilesIn()) return // (the tiles round the start all in first: the traffic starts from the same ones every run)
    if (C.warm === C.warm0 - 30) __renew()
    if (window.__deck) { Object.assign(D.car, { h: __deck, deck: true }); window.__deck = 0 } // (the dive keeps it on the ground until now)
    if (C.warm > 0) { if (!--C.warm) t0 = performance.now(); return } // (the streets fill; then the autopilot's clock starts)
    if (C.frames >= maxFrames) { C.off = true; return }
    C.pilot?.()
    if (each) C.each.push(each())
    if (C.frames % 300 === 0) { const q = T?.nearby?.(P.x, P.z, 70) || []; C.trace.push(+P.x.toFixed(2), +P.z.toFixed(2), q.length + ':' + Math.round(q.reduce((a, c) => a + c.x + c.z, 0))) } // where it is every 5 s, and the cars round it (how many : their places, summed): two runs side by side show where they part
    const cam = city.view.camera, bad = {}
    const hit = (k, note) => { bad[k] = note ?? true }
    C.frames++
    if (!(P.x === P.x && P.y === P.y && P.z === P.z)) { hit('nan'); C.counts.nan = (C.counts.nan || 0) + 1; return } // the player is nowhere (drawn nowhere: a black view)
    if (last) C.dist += Math.hypot(P.x - last.x, P.z - last.z)
    last = { x: P.x, z: P.z }
    // camera
    const bf = backFaces()
    if (bf.near > 0.01 || bf.share > 0.08) { // (facade details and awnings further off show a few back faces: not counted)
      const cx = cam.position.x, cy = -cam.position.z
      let wall = '> 3'
      if (D) for (const r of [3, 2, 1.2, 0.6, 0.3, 0.01]) if (D.collide(cx, cy, r, cam.position.y + 0.5)) wall = r === 0.01 ? 'in' : '< ' + r
      const worst = !C.rt || bf.near > C.rtNear
      if (worst) { C.rt = px.slice(); C.rtNear = bf.near } // the worst one, for --rt
      const note = `${bf.of} ${(bf.near * 100).toFixed(1)}% near, ${(bf.share * 100).toFixed(1)}% all, wall ${wall} m, ${(cam.position.y - W.heightAt(cam.position.x, cam.position.z)).toFixed(1)} m up, near ${cam.near.toFixed(2)}`
      if (worst) { // (and what the camera is in there: a footprint, a raised part, a landmark's outline)
        const inP = (P, s0, s1) => { let c = false; for (let q = s0, w = s1 - 2; q < s1; w = q, q += 2) if ((P[q + 1] > cy) !== (P[w + 1] > cy) && cx < ((P[w] - P[q]) * (cy - P[q + 1])) / (P[w + 1] - P[q + 1]) + P[q]) c = !c; return c }
        const within = []
        for (const t of city.tiles.tiles.values()) {
          if (t.level !== 0) continue
          for (const [k, F] of [['footprint', t.footprints], ['raised part', t.overhangs]]) if (F) for (let r = 0; r < F.start.length - 1; r++) if (inP(F.pts, F.start[r], F.start[r + 1])) within.push(k + (F.lo ? ` from ${(F.lo[r] - W.heightAt(cam.position.x, cam.position.z)).toFixed(1)} m up` : ''))
        }
        for (const r of city.tiles.masks || []) if (inP(r.flat(), 0, r.length * 2)) within.push('landmark')
        const ll = W.toLatLon(cam.position.x, cam.position.z)
        const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(0, 0.5), cam); rc.far = 80 // what is ahead (a little up): the mesh, how far
        const meshes = []; city.scene.traverseVisible((o) => { if (solid(o) && o.geometry.attributes.position?.array) meshes.push(o) }) // (the tiles' meshes keep no arrays once uploaded)
        const sides = meshes.map((o) => o.material.side); for (const o of meshes) o.material.side = THREE.DoubleSide
        const h = rc.intersectObjects(meshes, false)[0]
        meshes.forEach((o, i) => { o.material.side = sides[i] })
        if (h) within.push(`ahead ${h.distance.toFixed(1)} m: ${h.object.name || h.object.parent?.name || '?'} [${Object.keys(h.object.geometry.attributes)}] ${h.object.geometry.attributes.position.count} verts, y ${(h.point.y - W.heightAt(h.point.x, h.point.z)).toFixed(1)} up, normal y ${h.face.normal.y.toFixed(1)}, tile ${[...city.tiles.tiles.values()].filter((t) => t.group === h.object.parent || t.group === h.object).map((t) => t.level + ':' + t.state)}`)
        C.worst = `frame ${C.frames}: ${note}; camera at ${ll.lat.toFixed(5)},${ll.lon.toFixed(5)} in [${within}], ${Math.hypot(cx - P.x, cy + P.z).toFixed(1)} m from the player`
      }
      hit('inside', note)
    }
    const c = D?.car, m = D?.man, body = boat ? null : P.mode === 'foot' ? m : c
    if (cam.position.y < W.heightAt(cam.position.x, cam.position.z) + 0.1 && body?.roof == null) hit('under')
    if (D && body?.roof == null) D.propsNear(cam.position.x, -cam.position.z, 0.3, (x, y, r, k, ang, g) => { if (!k && Math.hypot(x - cam.position.x, y + cam.position.z) < r + Math.min(0.3, cam.near) && cam.position.y - g < 6) hit('camTree') })
    if (boat) {
      const fx = Math.sin(P.heading), fz = Math.cos(P.heading)
      const cx = cam.position.x, cz = cam.position.z // the lens in a tall hull (a small boat's is under it) or a pier
      for (const s of city.ships?.nearby?.(cx, cz, 60) || []) if (s.length > 20 && circleIn(boxOf(s.x, s.z, Math.sin(s.heading), Math.cos(s.heading), s.length / 2, s.width / 2), cx, cz, 0) > 0.5) hit('camShip')
      const Qc = city.landmarks?.piers
      if (Qc) for (let i = 0; i < Qc.length; i += 5) if (circleIn(boxOf(Qc[i], Qc[i + 1], Math.cos(Qc[i + 4]), -Math.sin(Qc[i + 4]), Qc[i + 2], Qc[i + 3]), cx, cz, 0) > 0.3) hit('camShip', 'pier')
      for (let a = -2.5, run = 0; a <= 2.5; a += 0.25) { run = dry(P.x + fx * a, P.z + fz * a) ? run + 1 : 0; if (run > 4) hit('shore') } // a metre of the hull on land (not the corner of a 4 m cell of the mask grazed)
      for (const a of [-2.5, 0, 2.5]) {
        const x = P.x + fx * a, z = P.z + fz * a
        for (const s of city.ships?.nearby?.(x, z, 60) || []) if (circleIn(boxOf(s.x, s.z, Math.sin(s.heading), Math.cos(s.heading), (s.length || 4) / 2, (s.width || 2) / 2), x, z, 1.2) > 0.5) hit('ship')
        const Q = city.landmarks?.piers
        if (Q) for (let i = 0; i < Q.length; i += 5) if (circleIn(boxOf(Q[i], Q[i + 1], Math.cos(Q[i + 4]), -Math.sin(Q[i + 4]), Q[i + 2], Q[i + 3]), x, z, 1.2) > 0.5) hit('ship', 'pier')
      }
    } else {
      const fx = -Math.sin(body.yaw), fy = Math.cos(body.yaw), free = body.deck || body.roof != null
      const B = foot || P.mode === 'foot' ? boxOf(m.x, m.y, fx, fy, 0.25, 0.25) : boxOf(c.x, c.y, fx, fy, c.V.length / 2, c.V.width / 2)
      // buildings: the corners (a little in) and the middle, unless on a deck / in a tube, or on a street through a passage
      if (!free) for (const [a, s] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const x = B.x + fx * a * Math.max(0, B.hl - 0.3) + fy * s * Math.max(0, B.hw - 0.3), y = B.y + fy * a * Math.max(0, B.hl - 0.3) - fx * s * Math.max(0, B.hw - 0.3)
        if (inB(x, y) && !(D.nearestRoad(x, y, 1)?.d === 0)) hit('bldg')
      }
      D.propsNear(B.x, B.y, B.hl + 1, (x, y, r, k, ang, g) => { if (circleIn(B, x, y, r) > 0.12 && !(g - body.h > 2.5) && !(body.h - g > 4)) hit(k ? 'post' : 'tree') })
      for (const q of T?.poles?.(B.x, -B.y, B.hl + 1) || []) if (circleIn(B, q.x, -q.z, q.r) > 0.12 && Math.abs(q.y - body.h) < 3) hit('post', 'signal')
      for (const q of T?.nearby?.(B.x, -B.y, 14) || []) if (!String(q.id).startsWith('player') && !String(q.id).startsWith('mp:') && Math.abs((q.y ?? body.h) - body.h) < 2.5 && boxIn(B, npcBox(q)) > 0.35) hit('car')
      for (const q of T?.people?.(B.x, -B.y, B.hl + 1) || []) if (Math.abs(q.y - body.h) < 2.5 && circleIn(B, q.x, -q.z, 0) > 0.25) hit('ped')
      if (body === c) { // wheels on the road
        if (!veh?.parent) { veh = null; city.scene.traverse((q) => { if (q.userData.wheels && q.visible && Math.hypot(q.position.x - c.x, q.position.z + c.y) < 1) veh = q }) } // the player's model
        if (veh && !(c.lift > 0.02)) for (const w of veh.userData.wheels) {
          w.spin.getWorldPosition(v); veh.worldToLocal(v2.copy(v))
          const gap = v.y - c.V.wheel - D.surface(v.x, -v.z, c.h).y // (not while the body is still dropping onto a step)
          if (Math.abs(gap) > 0.2 && Math.abs(c.h - D.surface(c.x, c.y, c.h).y) < 0.15) { hit('wheel', `${gap.toFixed(2)} (h ${(c.h - D.surface(c.x, c.y, c.h).y).toFixed(2)}, hz ${(c.hz || 0).toFixed(2)}, pitch ${c.pitch.toFixed(2)}, roll ${c.roll.toFixed(2)}, ${(c.speed * 3.6).toFixed(0)} km/h${c.deck ? ', deck' : ''}})`); break }
        }
      } else if (!free) { // feet on the ground (a step ahead and behind too)
        const gap = m.h - 0.15 - W.heightAt(m.x, -m.y)
        if (Math.abs(gap) > 0.3) hit('feet', gap.toFixed(2))
      }
      // the others near the player
      const cars = (T?.nearby?.(P.x, P.z, 70) || []).filter((q) => !String(q.id).startsWith('player') && !String(q.id).startsWith('mp:'))
      const ground = (q) => Math.abs(q.y - W.heightAt(q.x, q.z)) < 1.5
      for (const q of cars) {
        if (!ground(q)) continue
        if (inB(q.x, -q.z) && !(D.nearestRoad(q.x, -q.z, 1)?.d === 0)) hit('npcBldg', 'car')
        const b = npcBox(q)
        D.propsNear(b.x, b.y, b.hl + 1, (x, y, r, k, ang, g) => { if (circleIn(b, x, y, r) > 0.3 && Math.abs(g - q.y) < 2.5) hit('npcProp', k ? 'car in post' : 'car in tree') })
        for (const p of cars) if (p !== q && p.id < q.id && Math.abs(p.y - q.y) < 2 && boxIn(b, npcBox(p)) > 0.5) hit('npcCar')
      }
      for (const q of T?.people?.(P.x, P.z, 40) || []) {
        if (!ground(q)) continue
        if (deepIn(q.x, -q.z) && !(D.nearestRoad(q.x, -q.z, 3, true, true)?.d === 0)) hit('npcBldg', `ped ${Math.hypot(...Object.values(D.collide(q.x, -q.z, 0.01))).toFixed(1)} m in, ${(D.nearestRoad(q.x, -q.z, 3, false, true)?.d ?? 9).toFixed(1)} m off a path`)
        D.propsNear(q.x, -q.z, 1, (x, y, r, k, ang, g) => { if (k !== BENCH && Math.hypot(x - q.x, y + q.z) < r + 0.1 && Math.abs(g - q.y) < 2.5) hit('npcProp', k ? 'ped in post' : 'ped in tree') }) // (people sit on benches)
      }
    }
    for (const k in bad) {
      C.counts[k] = (C.counts[k] || 0) + 1
      if (k === stopAt && C.counts[k] >= atN) C.off = C.hold = true
      const S = C.spots[k] || (C.spots[k] = []), ll = W.toLatLon ? W.toLatLon(P.x, P.z) : null
      if (S.length < 6 && !(S.length && C.frames - S[S.length - 1].f < 90)) { S.push({ f: C.frames, x: +P.x.toFixed(1), z: +P.z.toFixed(1), ll, note: bad[k] }); if (!C.shot) C.shot = k + S.length }
    }
  }
  // ---- the autopilot
  let t0 = performance.now()
  let stuck = 0, back = 0, at = { x: 0, y: 0 }, eWait = 0
  if (boat) { // at whatever is nearest (a moored boat, a ship, a pier), then tacks away, and again
    const down = {}, key = (code, on) => { if (!!down[code] !== on) { down[code] = on; dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, key: code })) } }
    C.pilot = () => {
      key('KeyW', true)
      const P = city.player, ph = ((performance.now() - t0) / 1000) % 20
      let bd = 150, tx = 0, tz = 0
      for (const s of city.ships?.nearby?.(P.x, P.z, 150) || []) { const d = Math.hypot(s.x - P.x, s.z - P.z); if (d < bd) { bd = d; tx = s.x; tz = s.z } }
      const Q = city.landmarks?.piers
      if (Q) for (let i = 0; i < Q.length; i += 5) { const d = Math.hypot(Q[i] - P.x, Q[i + 1] - P.z); if (d < bd) { bd = d; tx = Q[i]; tz = Q[i + 1] } }
      let turn = 0
      if (ph < 13 && bd < 150) { const a = Math.atan2(tx - P.x, tz - P.z) - P.heading, w = Math.atan2(Math.sin(a), Math.cos(a)); turn = w > 0.15 ? 1 : w < -0.15 ? -1 : 0 } else if (ph > 13 && ph < 17) turn = -1
      key('KeyA', turn > 0); key('KeyD', turn < 0)
    }
    return go()
  }
  D.autopilot = () => {
    if (C.warm > 0) return { steer: 0, up: false, down: false, hand: true, run: false, boost: false }
    const P = city.player, b = P.mode === 'foot' ? D.man : D.car, t = (performance.now() - t0) / 1000
    const fx = -Math.sin(b.yaw), fy = Math.cos(b.yaw), sp = Math.abs(b.speed), L = b === D.man ? 5 : 9 + sp * 0.8
    const r = D.nearestRoad(b.x + fx * L, b.y + fy * L, 30, b === D.car && !!b.deck, b === D.man, kind === 'bus', b.deck ? b.h - 0.58 : null)
    let steer = 0
    if (r) { const dx = r.px - b.x, dy = r.py - b.y; steer = clamp(Math.atan2(fx * dy - fy * dx, fx * dx + fy * dy) * 3, -1, 1) }
    const G = kind === 'bus' && D.game
    if (G) { // the bus drives its line: along the kerb lane, into each stop's bay, doors open for a few seconds, and on; poles back on the wires if they come off
      const label = G.actionLabel(), to = G.next ? G.next.d - G.d : 1e9, off = G.trolley && !G.pole.on
      const p = G.laneAt(G.d + L), dx = p.x - b.x, dy = p.y - b.y
      steer = clamp(Math.atan2(fx * dy - fy * dx, fx * dx + fy * dy) * 3, -1, 1)
      const press = /^(Close|Rewire)/.test(label) || (label === 'Open doors' && to > -6 && to < 12)
      if (!press) eWait = 0; else if (++eWait > (label === 'Close doors' ? 240 : 30)) { eWait = 0; dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'e' })); dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', key: 'e' })) }
      if (label === 'Close doors' || label === 'Rewiring…') return { steer: 0, up: false, down: false, hand: true, run: false, boost: false }
      const want = off ? 0 : Math.min(12, to > -6 ? Math.sqrt(Math.max(0, 2 * 1.2 * (to - 3))) : 12) // (to a stop in the bay; poles off: stop and put them up)
      return { steer, up: b.speed < want - 0.5, down: false, hand: b.speed > want + 0.5 || want === 0, run: false, boost: false } // (no swerving off the line: a trolleybus off its wires has no power)
    }
    const side = Math.floor(t / 16) % 2 ? 1 : -1
    if (b === D.man) { const ph = t % 12; return { steer: ph > 7 && ph < 7.8 ? side : ph > 9.6 && ph < 10.4 ? -side : steer, up: true, down: false, hand: false, run: ph < 4, boost: false } }
    const ph = t % 16
    const moved = Math.hypot(b.x - at.x, b.y - at.y); at = { x: b.x, y: b.y }
    stuck = moved < 0.005 && ph < 10 ? stuck + 1 : 0 // (the wheels may turn against a wall)
    if (stuck > 150) { stuck = 0; back = t + 1.8 }
    if (back && t > back + 4 && stuck > 100) { back = 0; dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' })); dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' })) }
    if (t < back) return { steer: -steer, up: false, down: true, hand: false, run: false, boost: false }
    if (ph > 10 && ph < 12.5) return { steer: side, up: true, down: false, hand: false, run: false, boost: false } // off the road, into what stands there
    if (ph >= 12.5 && ph < 15) return { steer: -side * 0.6, up: false, down: true, hand: false, run: false, boost: false } // and back out
    return { steer, up: sp < (kind === 'taxi' ? 20 : 12), down: false, hand: false, run: false, boost: false }
  }
  go()
}, [kind, String(o.at).split(':')[0], +String(o.at).split(':')[1] || 1, +o.secs * 60, String(begin), [kind, lat, lon, option], o.each])

const t1 = Date.now()
let shots = 0
if (o.shots) fs.mkdirSync(o.shots, { recursive: true })
while (!(await page.evaluate(() => __clip.off || !!__clip.error)) && Date.now() - t1 < (+o.cap || (+o.secs + 10) * 4) * 1000) { // (a loaded machine draws them slower; at a quarter of the speed, or after --cap seconds, the route is cut, and says so)
  await page.waitForTimeout(200)
  if (!o.shots) continue
  const k = await page.evaluate(() => { const k = __clip.shot; __clip.shot = null; return k })
  if (k && shots++ < 8) await page.screenshot({ path: `${o.shots}/${name}-${k}.png` })
}
if (o.shots) await page.screenshot({ path: `${o.shots}/${name}-end.png` })
if (o.rt) fs.writeFileSync(o.rt, Buffer.concat([Buffer.from('P6 160 100 255\n'), Buffer.from(await page.evaluate(() => { const a = []; const px = __clip.rt || __clip.px; for (let y = 99; y >= 0; y--) for (let x = 0; x < 160; x++) a.push(...px.slice((y * 160 + x) * 4, (y * 160 + x) * 4 + 3).map((v, i) => (i === 1 ? px[(y * 160 + x) * 4 + 2] : v))); return a }))])) // the worst back-face view (PPM: red = back faces, white = those within 6 m)
const r = await page.evaluate(() => { const r = { frames: __clip.frames, dist: __clip.dist, counts: __clip.counts, worst: __clip.worst, spots: __clip.spots, error: __clip.error, stalled: __waits().stalled || undefined, life: window.__life, cut: !__clip.off || undefined, trace: __clip.trace.join(' '), each: __clip.each.length ? __clip.each : undefined }; __clip.off = true; return r })
if (o.js) r.js = await page.evaluate(o.js).catch((e) => String(e))
if (errs.length) r.errors = [...new Set(errs)].slice(0, 5) // (the page's own: nothing above is to be trusted then)
console.log(JSON.stringify({ route: name, ...r }))
await browser.close(); srv.stop()
