// node tools/traffic_check.mjs: the traffic simulation (public/plugins/life/worker.js) moves cars smoothly: no jump or
// sudden turn from one frame to the next (short pieces of road, junctions, a new network swapped in while they
// drive), and no car appears or vanishes near the player; and nothing it hands out (cars, people walking, people
// sitting or waiting, cyclists) ever has a position, heading or speed that is not a number (#591)
// node tools/traffic_check.mjs --live [--secs 60] [--port P] [SPEC...]: the same on the real page, as drawn. SPEC:
// name=map#X,Y,zoom (the map view at that hash) or name=drive#X,Y,zoom[,yaw] (the van standing on the road nearest
// that spot, the chase camera behind it); default: W 7th & Macdonald (#558) both ways, downtown, a bridge. Every frame
// for --secs it reads city.traffic (cars and people as drawn) and prints one JSON line per spec:
//   overlap/pairs: car-frames (and car pairs) whose bodies intersect; pop/vanish (ppop/pvanish: people): things that
//   appear or disappear in the camera's view (perspective: within POP m); jump: a car moving more than its speed allows
//   plus 0.4 m in a frame (pjump: a person, 0.5 m); turn: a heading snapping > 0.25 rad; judder/pjudder: % of moving
//   things whose speed in a frame is off their recent speed by > 60 %; slow: frames over 50 ms; stale: the longest wait
//   for the worker's answer (ms); tickMax: its longest tick (ms); onDeck/underDeck: transit vehicles seen on a road
//   deck (sampled every 2 s), and of them those more than 1 m under it. ex: an example of each; why: the cars' states
//   for the first overlapping pairs (?lifedebug)
//   jerk / pjerk (cars / people): how unevenly each one in view moves, per agent: the change of its drawn velocity
//   from one frame to the next (m/s), [mean, 95th percentile, worst] over all its frames; a thing moving smoothly
//   changes by its acceleration × the frame (a car braking hard at 30 fps: 0.15), a stutter by its whole speed.
//   roadWalk: the most people at once on a carriageway and not crossing it; alongRoad: crossing one along a path
//   that runs down it; roadStand: waiting or sitting on one; target: how many cars and people the hour asks for
//   --fps 30: the page draws at 30 frames a second (every other display frame); --cpu 4: the main thread 4× slower;
//   --go: in a drive spec the van drives off (the accelerator held), so tiles, networks and detail levels change
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

if (process.argv.includes('--live')) { await live(); process.exit(0) }

const src = fs.readFileSync(new URL('../public/plugins/life/worker.js', import.meta.url), 'utf8')
const got = []
const ctx = vm.createContext({ postMessage: (m) => got.push(m), performance, console })
vm.runInContext(src, ctx)
const send = (m) => ctx.onmessage({ data: m })

// a 1 km tile, flat at 10 m: an avenue west-east through a junction with a street north-south, and on the avenue's
// east side a kink over two nodes 2 m apart (a lane a few decimetres long between connectors a few metres long)
const road = (a, b, pts, kind, lanes, w) => ({ kind, lanes, w, a, b, pts: new Float32Array(pts), z: null, drive: true, oneway: false, crossing: false })
const pieces = [
  road(1, 2, [0, 500, 500, 500], 2, 4, 14), road(2, 3, [500, 500, 700, 500], 2, 4, 14),
  road(3, 4, [700, 500, 702, 501], 2, 4, 14), road(4, 5, [702, 501, 1000, 560], 2, 4, 14),
  road(6, 2, [500, 0, 500, 500], 5, 2, 9), road(2, 7, [500, 500, 500, 1000], 5, 2, 9),
]
// for the people (switched on at the end): a footpath and a cycleway off the streets, a bench and a bus stop
pieces.push({ ...road(20, 21, [100, 800, 400, 900], 9, 1, 3), drive: false }, { ...road(22, 23, [100, 850, 450, 950], 10, 1, 3), drive: false })
const pois = [{ kind: 4, id: 30, x: 250, y: 852 }, { kind: 5, id: 31, x: 300, y: 870 }]
const tile = { key: '0/0_0', level: 0, ox: 0, oy: 0, size: 1024, terrain: { n: 2, h: new Float32Array([10, 10, 10, 10]) }, pieces, pois }
send({ type: 'opts', opts: { cars: true, people: false, bikes: false, density: 6, hour: 17, maxCars: 300, maxPeople: 0 } })
send({ type: 'tiles', add: [tile], drop: [] })
send({ type: 'area', area: { x: 500, y: 500, r: 3000, vx: 500, vy: 500, vr: 500 } })
const player = { x: 300, y: 620 } // off the road, within sight of the junction
send({ type: 'obstacles', list: [{ id: 'p', x: player.x, y: player.y, ang: 0, len: 4.6, w: 1.9, speed: 0, h: null, c: 1, s: 0 }] })

const DT = 1 / 60, last = new Map()
let buf = null, jumps = 0, turns = 0, frames = 0, born = 0, gone = 0, jumped = '', turned = '', nans = 0, nan = ''
function tick(check) {
  got.length = 0
  send({ type: 'tick', dt: DT, buf })
  const m = got.find((x) => x.type === 'frame'), a = (buf = m.buf), now = new Map()
  // every agent's 8 numbers (x, y, z, heading, ...) and the people's and cyclists' velocities
  const things = m.cars + m.nPeople + m.nBikes, what = (i) => (i < m.cars ? 'car' : i < m.cars + m.nPeople ? 'person' : 'cyclist')
  for (let i = 0; i < things * 8; i++) if (!Number.isFinite(a[i])) { nans++; nan ||= `${what(i >> 3)} ${i >> 3} field ${i & 7} is ${a[i]}` }
  for (let i = m.vbase; i < m.vbase + (m.nPeople + m.nBikes) * 2; i++) if (!Number.isFinite(a[i])) { nans++; nan ||= `velocity ${i - m.vbase} is ${a[i]}` }
  for (let i = 0; i < m.cars; i++) {
    const id = a[m.base + i * 2], v = a[m.base + i * 2 + 1], x = a[i * 8], z = a[i * 8 + 2], yaw = a[i * 8 + 3]
    now.set(id, [x, z, yaw])
    if (!check) continue
    const p = last.get(id), near = Math.hypot(x - player.x, -z - player.y) < 230
    if (!p) { if (near) born++; continue }
    const d = Math.hypot(x - p[0], z - p[1]), dy = Math.abs(Math.atan2(Math.sin(yaw - p[2]), Math.cos(yaw - p[2])))
    if (d > v * DT + 0.15) { jumps++; jumped = `car ${id} moved ${d.toFixed(2)} m at ${v.toFixed(1)} m/s` }
    if (dy > 0.12 && v > 0.5) { turns++; turned = `car ${id} turned ${dy.toFixed(2)} rad in a frame` }
  }
  if (check) for (const [id, p] of last) if (!now.has(id) && Math.hypot(p[0] - player.x, -p[1] - player.y) < 230) gone++
  last.clear(); for (const [k, v] of now) last.set(k, v)
  frames++
  return m
}
for (let i = 0; i < 600; i++) tick(false) // the first network, the cars settling in
const n0 = last.size
for (let i = 0; i < 3600; i++) {
  if (i % 900 === 450) send({ type: 'tiles', add: [], drop: [] }) // a tile came in: a new network, built while they drive
  tick(true)
}
console.log(`${n0} cars, ${frames} frames: ${jumps} jumps (${jumped || '-'}), ${turns} sudden turns (${turned || '-'}), ${born} appeared and ${gone} vanished near the player`)
assert(n0 > 30, `cars: ${n0}`)
assert.equal(jumps + turns + born + gone, 0)
// the people: walking, on the bench and at the bus stop, and the cyclists, from the frame they appear
send({ type: 'opts', opts: { people: true, bikes: true, maxPeople: 300 } })
let walkers = 0, riders = 0
for (let i = 0; i < 1800; i++) { const m = tick(false); walkers = Math.max(walkers, m.nPeople); riders = Math.max(riders, m.nBikes) }
got.length = 0; send({ type: 'debug', x: 0, y: 0, r: 0 })
const sitters = got.find((x) => x.type === 'debug').statics
console.log(`${walkers - sitters} walking, ${sitters} sitting or waiting, ${riders} cyclists: ${nans} numbers not finite (${nan || '-'})`)
assert(walkers > sitters && sitters > 0 && riders > 0, 'people of every kind')
assert.equal(nans, 0, nan)
// As drawn (#606): the page's own smoothing (public/plugins/life/smooth.js) between the worker and the screen, at 60
// and 30 frames a second and at an uneven rate, with the worker's answers on time, up to two frames late, and stalled
// (a quarter second now and then), a new network built on the way. Per kind of thing, over every one of them:
//   glitch: frames per 1000 in which one moved at a speed unlike both the frame before and the frame after (it stood
//   for a frame and then jumped: a stutter; stopping at a kerb or pulling away is not one), and accel: the 99th
//   percentile of the change of its drawn velocity from frame to frame, over the frame (m/s2; a car brakes at 3 to 4);
//   gait: the same for the turning of a walker's legs (radians: 4.2 a metre walked)
// `--old`: the same for the page as it was (each thing moved on along its heading from the latest answer)
const { smoother } = await import('../public/plugins/life/smooth.js')
const OLD = process.argv.includes('--old'), rnd = (s) => () => ((s = (s * 48271) % 2147483647) / 2147483647)
function drawn(name, dtOf, lateOf, frames = 1800) {
  const sm = smoother(), r = rnd(7), hist = new Map(), st = { car: [0, 0, []], person: [0, 0, []], cyclist: [0, 0, []], gait: [0, 0, []] }
  let elapsed = 0, accDt = 0, busy = false, sentT = 0, spare = buf, due = [], P = new Float32Array(0), Q = new Float32Array(0), old = null
  const see = (kind, id, x, z, dt) => {
    let h = hist.get(id); if (!h) hist.set(id, (h = { x, z, v: [], dt: 0, vx: 0, vz: 0, f: -1 }))
    if (h.f === f - 1 && h.dt && f > 120) { // (seen last frame too, and the one before: three speeds in a row; not the first two seconds, while the page finds how late the answers are)
      const vx = (x - h.x) / dt, vz = (z - h.z) / dt, sp = Math.hypot(vx, vz), S = st[kind]
      if (h.v.length) S[2].push(Math.hypot(vx - h.vx, vz - h.vz) / dt)
      h.v.push(sp); h.vx = vx; h.vz = vz
      if (h.v.length === 3) { const [a, b, c] = h.v, lim = 0.5 * Math.max(a, b, c) + 0.2; S[0]++; if (Math.abs(b - a) > lim && Math.abs(b - c) > lim) S[1]++; h.v.shift() }
    } else h.v.length = 0
    h.x = x; h.z = z; h.dt = dt; h.f = f
  }
  let f = 0
  for (; f < frames; f++) {
    for (const d of due) if (d.at <= f) { // the answers that have come since the last frame
      busy = false; spare = d.m.buf
      if (OLD) old = { t: d.t, m: d.m, buf: d.m.buf.slice() }; else sm.push(d.m, d.t)
    }
    due = due.filter((d) => d.at > f)
    if (f === 900) send({ type: 'tiles', add: [], drop: [] })
    const dt = dtOf(r); accDt += dt; elapsed += dt
    if (OLD ? old : sm.b.t >= 0) {
      let m, a, ids, pids
      if (OLD) { // the latest answer, each thing moved on at its speed for the time since it was asked for
        m = old.m; a = old.buf.slice(); const e = Math.min(0.5, Math.max(0, elapsed - old.t))
        for (let i = 0; i < m.cars; i++) { const d = a[m.base + i * 2 + 1] * e, h = d * Math.cos(a[i * 8 + 4]); a[i * 8] += Math.cos(a[i * 8 + 3]) * h; a[i * 8 + 2] -= Math.sin(a[i * 8 + 3]) * h }
        for (let i = 0; i < m.nPeople + m.nBikes; i++) { a[(m.cars + i) * 8] += a[m.vbase + i * 2] * e; a[(m.cars + i) * 8 + 2] += a[m.vbase + i * 2 + 1] * e }
        for (let i = 0; i < m.cars; i++) see('car', a[m.base + i * 2], a[i * 8], a[i * 8 + 2], dt)
        for (let i = 0; i < m.nPeople + m.nBikes; i++) see(i < m.nPeople ? 'person' : 'cyclist', 'p' + a[m.pbase + i], a[(m.cars + i) * 8], a[(m.cars + i) * 8 + 2], dt)
        for (let i = 0; i < m.nPeople; i++) if (a[(m.cars + i) * 8 + 5] < 1) see('gait', 'g' + a[m.pbase + i], a[(m.cars + i) * 8 + 4], 0, dt)
      } else {
        const t = sm.step(elapsed, dt), B = sm.b, np = B.pn + B.bn
        if (P.length < B.n * 8) P = new Float32Array(B.n * 12)
        if (Q.length < np * 8) Q = new Float32Array(np * 12)
        sm.cars(P, t); sm.people(Q, t)
        for (let i = 0; i < B.n; i++) see('car', B.aux[i * 2], P[i * 8], P[i * 8 + 2], dt)
        for (let i = 0; i < np; i++) see(i < B.pn ? 'person' : 'cyclist', 'p' + B.pid[i], Q[i * 8], Q[i * 8 + 2], dt)
        for (let i = 0; i < B.pn; i++) if (Q[i * 8 + 5] < 1) see('gait', 'g' + B.pid[i], Q[i * 8 + 4], 0, dt)
      }
    }
    if (!busy) {
      busy = true; sentT = elapsed; got.length = 0
      send({ type: 'tick', dt: accDt, buf: spare }); spare = null; accDt = 0
      due.push({ at: f + 1 + lateOf(r, f), t: sentT, m: got.find((x) => x.type === 'frame') })
    }
  }
  buf = due.at(-1)?.m.buf || spare
  const out = {}
  for (const [k, [n, g, acc]] of Object.entries(st)) { acc.sort((x, y) => x - y); out[k] = { glitch: +((1000 * g) / (n || 1)).toFixed(2), accel: +(acc[Math.floor(acc.length * 0.99)] || 0).toFixed(1) } }
  console.log(`${name.padEnd(22)} ${JSON.stringify(out)}`)
  return out
}
const even = (fps) => () => 1 / fps, uneven = (r) => [1 / 60, 1 / 30, 1 / 20][Math.floor(r() * 3)]
const prompt = () => 0, late = (r) => Math.floor(r() * 3), stall = (r, f) => (f % 120 === 60 ? 15 : Math.floor(r() * 2))
let worst = 0
for (const [name, dtOf, lateOf] of [['60 fps', even(60), prompt], ['30 fps', even(30), prompt], ['60 fps, late answers', even(60), late], ['30 fps, late answers', even(30), late],
  ['uneven frames, late', uneven, late], ['60 fps, stalls', even(60), stall], ['30 fps, stalls', even(30), stall]]) {
  const o = drawn(name, dtOf, lateOf)
  if (!name.includes('stalls')) for (const k in o) if (k !== 'cyclist') worst = Math.max(worst, o[k].glitch) // (a cyclist turns round on the spot at a path's dead end, and the test has two)
}
// how busy by the hour, the day and the weather (#606): what the worker aims for (cars, people)
const aim = (o) => { send({ type: 'opts', opts: { density: 6, maxCars: 4000, maxPeople: 3000, weekend: false, wet: 0, ...o } }); got.length = 0; send({ type: 'debug', x: 0, y: 0, r: 0 }); const d = got.find((x) => x.type === 'debug'); return [d.carTarget, d.pedTarget] }
const rush = aim({ hour: 17 }), dawn = aim({ hour: 6.5 }), night = aim({ hour: 3 }), noon = aim({ hour: 12 }), wet = aim({ hour: 12, wet: 1 }), sat8 = aim({ hour: 8, weekend: true }), wed8 = aim({ hour: 8 })
console.log(`cars, people aimed for: 17:00 ${rush}, 6:30 ${dawn}, 3:00 ${night}, noon ${noon}, noon in a downpour ${wet}, 8:00 Wed ${wed8}, Sat ${sat8}`)
assert(dawn[0] < 0.35 * rush[0] && night[0] < 0.08 * rush[0] && sat8[0] < 0.4 * wed8[0], 'cars by the hour')
assert(dawn[1] < 0.25 * noon[1] && night[1] < 0.08 * noon[1] && wet[1] < 0.5 * noon[1], 'people by the hour and the weather')
if (!OLD) assert(worst < 0.1, `things stutter as drawn: ${worst} glitches per 1000 frames`)
console.log('traffic ok')

async function live() {
  const { args, server, open, settle } = await import('./pw.mjs')
  let [o, specs] = args(process.argv.slice(2).filter((a) => a !== '--live' && a !== '--go'), { secs: 60, dpr: 1, tier: 'high', hour: 17, fps: 60, cpu: 1 })
  if (!specs.length) specs = ['stop=drive#15054,11350,0.02,1.5708', 'stopmap=map#15054,11350,1.2', 'downtown=map#13645,11243,0.5', 'bridge=map#13124,13929,1.9436']
  const srv = await server(o.port)
  try {
    for (const spec of specs) {
      const [name, v] = spec.split('='), drive = v.startsWith('drive'), [hx, hy, hz, yaw] = v.slice(v.indexOf('#') + 1).split(',').map(Number)
      // --fps: each frame waits out the display frames between (60 / fps of them)
      const init = +o.fps < 60 ? `{ const raf = requestAnimationFrame.bind(window), n = ${Math.round(60 / +o.fps)}; window.requestAnimationFrame = (cb) => { let k = n; const f = (t) => (--k ? raf(f) : cb(t)); return raf(f) } }` : undefined
      const { browser, ctx, page, errs } = await open({ ...o, init, port: srv.port, query: '?drivedebug&lifedebug', hash: `#${hx},${hy},${hz}` })
      if (+o.cpu > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: +o.cpu })
      await settle(page, 800)
      if (drive) {
        await page.waitForFunction(() => window.driveDebug, null, { timeout: 30000 })
        await page.evaluate((yaw) => { const t = view.controls.target; driveDebug.start('car', t.x, -t.z, yaw || 0) }, yaw)
        await settle(page, 1500)
      }
      await page.waitForTimeout(4000) // the traffic settles in
      if (drive && process.argv.includes('--go')) await page.keyboard.down('w')
      const r = await page.evaluate((secs) => new Promise((done) => {
        const T = city.traffic, cam = () => city.view.camera, POP = 250
        const st = { frames: 0, cars: 0, people: 0, overlap: 0, pairs: new Set(), pop: 0, vanish: 0, ppop: 0, pvanish: 0, jump: 0, pjump: 0, turn: 0, slow: 0, judder: 0, moving: 0, pjudder: 0, pmoving: 0, ex: {}, onDeck: 0, underDeck: 0 }
        const vel = new Map(), jk = { c: [], p: [] } // per thing: its drawn velocity last frame; the changes of it
        const jerk = (k, x, z, p, dt, vis, into) => { const vx = (x - p[0]) / dt, vz = (z - p[1]) / dt, w = vel.get(k); vel.set(k, [vx, vz]); if (vis && w && Math.hypot(vx, vz) + Math.hypot(w[0], w[1]) > 0.2) into.push(Math.hypot(vx - w[0], vz - w[1])) }
        const ema = new Map() // per thing: its speed over the last frames (judder: a frame's speed off it by more than 60 %)
        const jud = (k, d, dt, vis) => { const sp = d / dt, e = ema.get(k); ema.set(k, e == null ? sp : e * 0.8 + sp * 0.2); if (!vis || e == null || e < 0.5) return 0; return Math.abs(sp - e) > 0.6 * e ? 2 : 1 }
        let last = null, lastP = null, t0 = performance.now(), tp = t0 - 16.7
        const note = (k, m) => { st.ex[k] ||= m }, f1 = (v) => v.toFixed(1)
        const inView = (x, y, z) => {
          const C = cam(), d = Math.hypot(x - C.position.x, z - C.position.z)
          if (C.isPerspectiveCamera && d > POP) return false
          const p = C.position.clone().set(x, y + 0.8, z).project(C)
          return Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1
        }
        const box = (c) => { const h = c.heading, f = [Math.sin(h), Math.cos(h)], s = [f[1], -f[0]]; return { x: c.x, z: c.z, f, s, l: c.length * 0.45, w: c.width * 0.45 } }
        const hit = (a, b) => { // separating axis between two rectangles
          for (const ax of [a.f, a.s, b.f, b.s]) {
            const d = Math.abs((b.x - a.x) * ax[0] + (b.z - a.z) * ax[1])
            const ra = a.l * Math.abs(a.f[0] * ax[0] + a.f[1] * ax[1]) + a.w * Math.abs(a.s[0] * ax[0] + a.s[1] * ax[1])
            const rb = b.l * Math.abs(b.f[0] * ax[0] + b.f[1] * ax[1]) + b.w * Math.abs(b.s[0] * ax[0] + b.s[1] * ax[1])
            if (d > ra + rb) return false
          }
          return true
        }
        // transit vehicles (plugins/transit) along a road deck (a drivable graph piece with deck heights z, running their
        // way) and how many of them ride more than 1 m under its surface (z + 0.38, where the van's wheels touch)
        const deckSegs = []
        city.world.eachTile((t) => { if (t.level === 0) for (const p of t.graph?.pieces || []) if (p.z && p.drive) for (let i = 0; i < p.pts.length / 2 - 1; i++) deckSegs.push([p.pts[i * 2], p.pts[i * 2 + 1], p.pts[i * 2 + 2], p.pts[i * 2 + 3], p.z[i], p.z[i + 1], p.w]) })()
        function buses() {
          const g = city.scene.getObjectByName('transit')
          for (const m of g?.children || []) {
            if (!m.isInstancedMesh) continue
            const e = m.instanceMatrix.array
            for (let k = 0; k < m.count; k++) {
              const o = k * 16, x = e[o + 12], y = e[o + 13], n = -e[o + 14], fx = e[o], fy = -e[o + 2], fl = Math.hypot(fx, fy) || 1
              if (!inView(x, y, -n)) continue
              let deck = null
              for (const [x0, y0, x1, y1, z0, z1, w] of deckSegs) {
                const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, f = ((x - x0) * dx + (n - y0) * dy) / (L * L)
                if (f < 0 || f > 1 || Math.abs(dx * fx + dy * fy) < 0.85 * L * fl || Math.hypot(x - x0 - dx * f, n - y0 - dy * f) > w / 2) continue
                const h = z0 + (z1 - z0) * f + 0.38
                if (deck == null || Math.abs(h - y) < Math.abs(deck - y)) deck = h
              }
              if (deck == null) continue
              st.onDeck++
              if (y < deck - 1) { st.underDeck++; note('underDeck', `${f1(x)},${f1(y)},${f1(-n)} deck ${f1(deck)}`) }
            }
          }
        }
        function frame(now) { // (the frame's time, as main.js steps the world by it)
          const dt = Math.max(1e-3, (now - tp) / 1000); tp = now
          const C = cam(), c = C.isPerspectiveCamera ? C.position : view.controls.target, R = C.isPerspectiveCamera ? POP + 150 : 2000
          const cars = T.nearby(c.x, c.z, R), cur = new Map(), people = T.people(c.x, c.z, R), curP = new Map()
          if (st.frames) {
            if (dt > 0.05) st.slow++
            st.stale = Math.max(st.stale || 0, Math.round(now - (window.lifeAt || now))) // ms since the worker last answered
            st.cars = Math.max(st.cars, cars.length); st.people = Math.max(st.people, people.length)
          }
          const boxes = cars.map(box)
          for (let i = 0; i < cars.length; i++) {
            const a = cars[i]; cur.set(a.id, [a.x, a.y, a.z, a.heading])
            if (!last) continue
            const p = last.get(a.id), vis = inView(a.x, a.y, a.z)
            if (!p) { if (vis) { st.pop++; note('pop', `${a.id} at ${f1(a.x)},${f1(a.y)},${f1(a.z)}`) } continue }
            const d = Math.hypot(a.x - p[0], a.z - p[2]), dy = Math.abs(Math.atan2(Math.sin(a.heading - p[3]), Math.cos(a.heading - p[3])))
            jerk(a.id, a.x, a.z, [p[0], p[2]], dt, vis, jk.c)
            const J = jud(a.id, d, dt, vis); if (J) { st.moving++; if (J > 1) { st.judder++; note('judder', `${a.id} ${f1(d / dt)} m/s, was ${f1(ema.get(a.id))}, speed ${f1(a.speed)}, dt ${(dt * 1000).toFixed(0)} ms`) } }
            if (vis && d > a.speed * dt * 1.5 + 0.4) { st.jump++; note('jump', `${a.id} ${f1(d)} m at ${f1(a.speed)} m/s, ${f1((now - t0) / 1000)} s in, worker ${Math.round(now - (window.lifeAt || now))} ms ago, ${f1(a.x)},${f1(a.y)},${f1(a.z)} dy ${f1(a.y - p[1])}`) }
            if (vis && dy > 0.25 && a.speed > 0.5) st.turn++
            for (let j = i + 1; j < cars.length; j++) {
              const b = cars[j]
              if (Math.abs(a.y - b.y) > 2 || Math.abs(a.x - b.x) > 12 || Math.abs(a.z - b.z) > 12 || !hit(boxes[i], boxes[j])) continue
              if (vis) { st.overlap++; const pk = Math.min(a.id, b.id) + ':' + Math.max(a.id, b.id); if (!st.pairs.has(pk) && st.pairs.size < 8 && window.lifeDebug) lifeDebug(0, 0, 0, [a.id, b.id]).then((d) => (st.why ||= []).push(d.cars)); st.pairs.add(pk); note('overlap', `${a.id}/${b.id} at ${f1(a.x)},${f1(a.y)},${f1(a.z)} v ${f1(a.speed)}/${f1(b.speed)}`) }
            }
          }
          if (last) for (const [id, p] of last) if (!cur.has(id) && Math.hypot(p[0] - c.x, p[2] - c.z) < R - 30 && inView(p[0], p[1], p[2])) { st.vanish++; note('vanish', `${id} at ${f1(p[0])},${f1(p[1])},${f1(p[2])}`) }
          for (const q of people) {
            curP.set(q.id, [q.x, q.y, q.z])
            if (!lastP) continue
            const p = lastP.get(q.id), vis = inView(q.x, q.y, q.z)
            if (!p) { if (vis) { st.ppop++; note('ppop', `${q.id} at ${f1(q.x)},${f1(q.z)}`) } continue }
            jerk('p' + q.id, q.x, q.z, [p[0], p[2]], dt, vis, jk.p)
            const J = jud('p' + q.id, Math.hypot(q.x - p[0], q.z - p[2]), dt, vis); if (J) { st.pmoving++; if (J > 1) st.pjudder++ }
            if (vis && Math.hypot(q.x - p[0], q.z - p[2]) > 0.5) { st.pjump++; note('pjump', `${q.id} ${f1(Math.hypot(q.x - p[0], q.z - p[2]))} m at ${f1(q.x)},${f1(q.z)}`) }
          }
          if (lastP) for (const [id, p] of lastP) if (!curP.has(id) && Math.hypot(p[0] - c.x, p[2] - c.z) < R - 30 && inView(p[0], p[1], p[2])) st.pvanish++
          last = cur; lastP = curP; st.frames++
          if (st.frames % 120 === 1) buses()
          if (st.frames % 90 === 45 && window.lifeDebug) lifeDebug(0, 0, 0).then((d) => { for (const k of ['roadWalk', 'alongRoad', 'roadStand']) st[k] = Math.max(st[k] || 0, d[k]); st.target = [d.carTarget, d.pedTarget] })
          if (now - t0 < secs * 1000) requestAnimationFrame(frame)
          else { st.pairs = st.pairs.size; st.tickMax = Math.round(Math.max(0, ...(window.lifeMs || []))) // the worker's longest tick (ms) in the last 600
 st.judder = +(100 * st.judder / (st.moving || 1)).toFixed(2); st.pjudder = +(100 * st.pjudder / (st.pmoving || 1)).toFixed(2); delete st.moving; delete st.pmoving
            const sum = (a) => { a.sort((x, y) => x - y); return a.length ? [a.reduce((s, x) => s + x, 0) / a.length, a[Math.floor(a.length * 0.95)], a[a.length - 1]].map((x) => +x.toFixed(3)) : null }
            st.jerk = sum(jk.c); st.pjerk = sum(jk.p); done(st) }
        }
        requestAnimationFrame(frame)
      }), +o.secs)
      console.log(JSON.stringify({ name, fps: +o.fps, cpu: +o.cpu, ...r, errors: errs.length }))
      await browser.close()
    }
  } finally { srv.stop() }
}
