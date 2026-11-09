// node tools/traffic_check.mjs: the traffic simulation (public/plugins/life/worker.js) moves cars smoothly: no jump or
// sudden turn from one frame to the next (short pieces of road, junctions, a new network swapped in while they
// drive), and no car appears or vanishes near the player
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
const tile = { key: '0/0_0', level: 0, ox: 0, oy: 0, size: 1024, terrain: { n: 2, h: new Float32Array([10, 10, 10, 10]) }, pieces, pois: [] }
send({ type: 'opts', opts: { cars: true, people: false, bikes: false, density: 6, hour: 17, maxCars: 300, maxPeople: 0 } })
send({ type: 'tiles', add: [tile], drop: [] })
send({ type: 'area', area: { x: 500, y: 500, r: 3000, vx: 500, vy: 500, vr: 500 } })
const player = { x: 300, y: 620 } // off the road, within sight of the junction
send({ type: 'obstacles', list: [{ id: 'p', x: player.x, y: player.y, ang: 0, len: 4.6, w: 1.9, speed: 0, h: null, c: 1, s: 0 }] })

const DT = 1 / 60, last = new Map()
let buf = null, jumps = 0, turns = 0, frames = 0, born = 0, gone = 0, jumped = '', turned = ''
function tick(check) {
  got.length = 0
  send({ type: 'tick', dt: DT, buf })
  const m = got.find((x) => x.type === 'frame'), a = (buf = m.buf), now = new Map()
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
console.log('traffic ok')

async function live() {
  const { args, server, open, settle } = await import('./pw.mjs')
  let [o, specs] = args(process.argv.slice(2).filter((a) => a !== '--live'), { secs: 60, dpr: 1, tier: 'high', hour: 17 })
  if (!specs.length) specs = ['stop=drive#15054,11350,0.02,1.5708', 'stopmap=map#15054,11350,1.2', 'downtown=map#13645,11243,0.5', 'bridge=map#13124,13929,1.9436']
  const srv = await server(o.port)
  try {
    for (const spec of specs) {
      const [name, v] = spec.split('='), drive = v.startsWith('drive'), [hx, hy, hz, yaw] = v.slice(v.indexOf('#') + 1).split(',').map(Number)
      const { browser, page, errs } = await open({ ...o, port: srv.port, query: '?drivedebug&lifedebug', hash: `#${hx},${hy},${hz}` })
      await settle(page, 800)
      if (drive) {
        await page.waitForFunction(() => window.driveDebug, null, { timeout: 30000 })
        await page.evaluate((yaw) => { const t = view.controls.target; driveDebug.start('car', t.x, -t.z, yaw || 0) }, yaw)
        await settle(page, 1500)
      }
      await page.waitForTimeout(4000) // the traffic settles in
      const r = await page.evaluate((secs) => new Promise((done) => {
        const T = city.traffic, cam = () => city.view.camera, POP = 250
        const st = { frames: 0, cars: 0, people: 0, overlap: 0, pairs: new Set(), pop: 0, vanish: 0, ppop: 0, pvanish: 0, jump: 0, pjump: 0, turn: 0, slow: 0, judder: 0, moving: 0, pjudder: 0, pmoving: 0, ex: {}, onDeck: 0, underDeck: 0 }
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
            const J = jud('p' + q.id, Math.hypot(q.x - p[0], q.z - p[2]), dt, vis); if (J) { st.pmoving++; if (J > 1) st.pjudder++ }
            if (vis && Math.hypot(q.x - p[0], q.z - p[2]) > 0.5) { st.pjump++; note('pjump', `${q.id} ${f1(Math.hypot(q.x - p[0], q.z - p[2]))} m at ${f1(q.x)},${f1(q.z)}`) }
          }
          if (lastP) for (const [id, p] of lastP) if (!curP.has(id) && Math.hypot(p[0] - c.x, p[2] - c.z) < R - 30 && inView(p[0], p[1], p[2])) st.pvanish++
          last = cur; lastP = curP; st.frames++
          if (st.frames % 120 === 1) buses()
          if (now - t0 < secs * 1000) requestAnimationFrame(frame)
          else { st.pairs = st.pairs.size; st.tickMax = Math.round(Math.max(0, ...(window.lifeMs || []))) // the worker's longest tick (ms) in the last 600
 st.judder = +(100 * st.judder / (st.moving || 1)).toFixed(2); st.pjudder = +(100 * st.pjudder / (st.pmoving || 1)).toFixed(2); delete st.moving; delete st.pmoving; done(st) }
        }
        requestAnimationFrame(frame)
      }), +o.secs)
      console.log(JSON.stringify({ name, ...r, errors: errs.length }))
      await browser.close()
    }
  } finally { srv.stop() }
}
