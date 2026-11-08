// node tools/van_check.mjs: the van's dynamics (public/plugins/drive/van.js) behave like a van
import { newVan, stepVan } from '../public/plugins/drive/van.js'
import assert from 'node:assert/strict'

const DT = 1 / 60
const run = (c, I, grip, secs, until = () => false) => { let x = 0; for (let t = 0; t < secs; t += DT) { stepVan(c, DT, I, grip); x += c.speed * DT; if (until(c)) break } return x }
const go = { up: true, down: false, steer: 0, hand: false }, brake = { up: false, down: true, steer: 0, hand: false }
// pulling away: up through the gears, 0-50 km/h in a van-like time, a top speed near 75 km/h
let c = newVan(), t = 0
run(c, go, 1, 30, (c) => { t += DT; return c.speed > 13.9 })
assert(t > 4 && t < 9, `0-50 km/h in ${t.toFixed(1)} s`)
run(c, go, 1, 60)
assert(c.gear >= 4 && c.speed > 19 && c.speed < 21.5, `top: gear ${c.gear}, ${c.speed.toFixed(1)} m/s`)
const top = c.speed
// stopping from 50 km/h: about 13 m dry, much longer in snow
const stop = (grip) => { const c = newVan(); c.speed = 13.9; c.gear = 3; return run(c, brake, grip, 30, (c) => c.speed === 0) }
const dry = stop(1), snow = stop(0.3)
assert(dry > 10 && dry < 18, `dry stop ${dry.toFixed(1)} m`)
assert(snow > dry * 2, `snow stop ${snow.toFixed(1)} m vs ${dry.toFixed(1)}`)
// reverse: hold the brake at a standstill
c = newVan(); run(c, brake, 1, 3)
assert(c.gear === -1 && c.speed < -2, `reverse: gear ${c.gear}, ${c.speed.toFixed(1)} m/s`)
// understeer: full lock at speed turns less on snow, and the body leans
const turn = (grip) => { const c = newVan(); c.speed = 15; c.gear = 4; run(c, { up: true, down: false, steer: 1, hand: false }, grip, 2); return c }
const a = turn(1), b = turn(0.3)
assert(a.yaw > b.yaw * 1.5, `yaw dry ${a.yaw.toFixed(2)} vs snow ${b.yaw.toFixed(2)}`)
assert(Math.abs(a.br) > 0.02, 'leans in a turn')
console.log(`ok: 0-50 km/h ${t.toFixed(1)} s, top ${(top * 3.6).toFixed(0)} km/h, stop from 50: dry ${dry.toFixed(1)} m, snow ${snow.toFixed(1)} m; 2 s at full lock: ${a.yaw.toFixed(2)} rad dry, ${b.yaw.toFixed(2)} snow`)
// the bus: slow to pull away (0-50 km/h in 10-20 s), about 70 km/h flat out, longer to stop, a wide turn at full lock
import { BUS, ARTIC } from '../public/plugins/drive/van.js'
for (const V of [BUS, ARTIC]) {
  let b = newVan(V), tb = 0
  run(b, go, 1, 60, (c) => { tb += DT; return c.speed > 13.9 })
  assert(tb > 10 && tb < 20, `bus 0-50 km/h in ${tb.toFixed(1)} s`)
  run(b, go, 1, 90)
  assert(b.speed > 17 && b.speed < 20, `bus top ${b.speed.toFixed(1)} m/s`)
  const s = newVan(V); s.speed = 13.9; s.gear = 3
  const d = run(s, brake, 1, 30, (c) => c.speed === 0)
  assert(d > dry * 1.2 && d < 30, `bus stop ${d.toFixed(1)} m`)
  const w = newVan(V); w.speed = 3; w.gear = 1
  run(w, { up: true, down: false, steer: 1, hand: false }, 1, 1.5)
  const r = w.speed / Math.max(1e-6, w.yawRate)
  assert(r > 8 && r < 14, `bus turning radius ${r.toFixed(1)} m`)
  console.log(`ok: ${V === BUS ? '12 m' : '18 m'} bus 0-50 km/h ${tb.toFixed(1)} s, top ${(b.speed * 3.6).toFixed(0)} km/h, stop from 50 ${d.toFixed(1)} m, turning radius ${r.toFixed(1)} m`)
}
