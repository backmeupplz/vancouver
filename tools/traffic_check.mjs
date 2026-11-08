// node tools/traffic_check.mjs: the traffic simulation (public/plugins/life/worker.js) moves cars smoothly: no jump or
// sudden turn from one frame to the next (short pieces of road, junctions, a new network swapped in while they
// drive), and no car appears or vanishes near the player
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

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
