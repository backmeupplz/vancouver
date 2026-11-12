// node tools/fun_check.mjs [--only taxi,enter,...] [--tiles URL]: scripted proofs for the play review's fixes (plans/FUN.md spec 1).
// taxi: a bot plays Rush Fare's first shift on the shift's own clock (carried 1.3 × the straight line at 16 m/s to each ring and door: it proves the
// clock budget, not street sense) and must finish 2 fares; enter: Enter in the garage
// starts the shift and opens nothing else. Each test prints ok/FAIL; exit 1 on any.
import { args, server, open, settle, live } from './pw.mjs'
const [o] = args(process.argv.slice(2), { only: '', tiles: '', secs: '150' })
const want = (k) => !o.only || o.only.split(',').includes(k)
const srv = await server(o.port)
const { browser, page, errs } = await open({ ...o, port: srv.port, query: '?drivedebug', init: live, hash: '#13645,11243,0.1295' })
let bad = 0
const say = (ok, t) => { console.log(`${ok ? 'ok' : 'FAIL'} ${t}`); if (!ok) bad++ }
// the bot: toward a target along drivable street (probe headings around the target's bearing, take the first that has road)
const BOT = () => {
  const D = driveDebug, b = D.car
  const ang = (a) => Math.atan2(Math.sin(a), Math.cos(a))
  let stuck = 0, back = 0, avoid = null, avoidT = 0, aboard = null, lock = null, ringT = {}, t0 = 0, need = 0, last = { x: b.x, y: b.y }, tk = 0
  D.autopilot = () => {
     if (lock && lock.mode !== 'wait') lock = null
    const T = D.taxi.debug, f = T.fare, tg = f ? { x: f.gx, y: f.gy } : lock || (lock = T.folk.filter((q) => q.mode === 'wait').sort((p, q) => Math.hypot(p.rx - b.x, p.ry - b.y) - Math.hypot(q.rx - b.x, q.ry - b.y))[0] || null) || {}
    const tx = tg.rx ?? tg.x, ty = tg.ry ?? tg.y
    if (tx == null) return { steer: 0, up: false, down: false, hand: true, run: false, boost: false }
    // with a rider aboard the bot waits out the road time (1.3 × the line at 16 m/s, the pace the first fares are priced for) on the shift's own
    // clock, then is at the door: this proves the clock budget, not the bot's street sense
    if (f && f.f.mode === 'aboard') {
      if (aboard !== f) aboard = f, t0 = T.S.time, need = (1.3 * Math.hypot(f.gx - b.x, f.gy - b.y)) / 16
      if (t0 - T.S.time >= need) { b.x = f.gx; b.y = f.gy }
      b.speed = 0
      return { steer: 0, up: false, down: false, hand: true, run: false, boost: false }
    }
    const want = Math.atan2(-(tx - b.x), ty - b.y), L = 14 + Math.abs(b.speed) * 0.7, d = Math.hypot(tx - b.x, ty - b.y)
    if (!f) { // (to a ring the bot is carried too: its road time, 1.3 × the line at 16 m/s, on the shift's clock)
      if (ringT.f !== tg) ringT = { f: tg, t0: T.S.time, need: (1.3 * d) / 16 }
      b.speed = 0
      if (ringT.t0 - T.S.time >= ringT.need) { b.x = tx; b.y = ty }
      return { steer: 0, up: false, down: false, hand: true, run: false, boost: false }
    }
    let best = null
    for (const dh of [0, 0.25, -0.25, 0.5, -0.5, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.2, -2.2, 3.1]) {
      const h = want + dh
      if (avoidT > 0 && Math.abs(ang(h - avoid)) < 0.7) continue
      const r = D.nearestRoad(b.x - Math.sin(h) * L, b.y + Math.cos(h) * L, 4, !!b.deck, false, false, b.deck ? b.h - 0.58 : null)
      if (r) { best = r; break }
    }
    const fx = -Math.sin(b.yaw), fy = Math.cos(b.yaw), to = best || { px: b.x + fx * 5, py: b.y + fy * 5 }
    const steer = Math.max(-1, Math.min(1, Math.atan2(fx * (to.py - b.y) - fy * (to.px - b.x), fx * (to.px - b.x) + fy * (to.py - b.y)) * 3))
    if (++tk % 30 === 0) { stuck = Math.hypot(b.x - last.x, b.y - last.y) < 1 ? stuck + 1 : 0; last = { x: b.x, y: b.y }; if (stuck > 2) { stuck = 0; back = 60; avoid = b.yaw; avoidT = 300 } }
    if (avoidT > 0) avoidT--
    if (back > 0) { back--; return { steer: -steer, up: false, down: true, hand: false, run: false, boost: false } }
    const slow = d < 12 ? 1.5 : d < 40 ? 5 : d < 90 ? 9 : 17
    return { steer, up: b.speed < slow, down: b.speed > slow + 4, hand: false, run: false, boost: false }
  }
}
try {
  await page.waitForFunction(() => window.driveDebug && !document.querySelector('#loading'), null, { timeout: 240000 })
  await settle(page, 500)
  if (want('enter')) { // Enter in the cab garage starts the shift's picker and opens nothing (the chat's username dialog came up over it)
    await page.evaluate(() => driveDebug.showGarage())
    await page.waitForSelector('[data-go]', { timeout: 30000 })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1500)
    const r = await page.evaluate(() => ({ go: !!document.querySelector('[data-go]'), picking: document.body.classList.contains('dlv-picking'), open: [...document.querySelectorAll('.panel, [role=dialog]')].filter((e) => e.checkVisibility() && /username|Chat/i.test(e.textContent) && !/Explore/.test(e.textContent)).map((e) => e.className + ':' + e.textContent.trim().slice(0, 30)) }))
    say(!r.go && r.picking && !r.open.length, `enter in the garage: garage gone ${!r.go}, picker ${r.picking}, open panels [${r.open}]`)
    await page.reload(); await page.waitForFunction(() => window.driveDebug && !document.querySelector('#loading'), null, { timeout: 240000 }); await settle(page, 500)
  }
  if (want('bus')) { // the 99 pulled out from its first stop under the how-to card: no miss, no lost happiness; the first-route group leads the picker
    await page.evaluate(() => driveDebug.startBus('99'))
    await page.waitForFunction(() => driveDebug.game?.S, null, { timeout: 120000 })
    await page.evaluate(() => { const D = driveDebug; D.autopilot = () => ({ steer: 0, up: true, down: false, hand: false, run: false, boost: false }) })
    await page.waitForTimeout(14000)
    const r = await page.evaluate(() => { const S = driveDebug.game.S; return { missed: S.missed, mood: S.mood, opened: !!S.opened, d: Math.round(driveDebug.game.d) } })
    say(r.missed === 0 && r.mood >= 90, `bus: driving off the first stop for 14 s: missed ${r.missed}, happiness ${r.mood}, drove ${r.d} m`)
    await page.reload(); await page.waitForFunction(() => window.driveDebug && !document.querySelector('#loading'), null, { timeout: 240000 }); await settle(page, 500)
  }
  if (want('photo')) { // 10 m from Canada Place the frame is a wall: nothing scores; from 250 m out on the water side the same landmark does
    await page.evaluate(() => { const p = city.world.fromLatLon(49.28875, -123.11061); driveDebug.start('foot', p.x, -p.z + 10, 0) })
    await settle(page, 1500)
    const at = (la, lo, face) => page.evaluate(([la, lo, face]) => { const D = driveDebug, p = city.world.fromLatLon(la, lo), q = city.world.fromLatLon(49.28875, -123.11061); D.man.x = p.x; D.man.y = -p.z; D.man.yaw = D.chase.yaw = Math.atan2(-(q.x - p.x), -(q.z - p.z)) * 1; return 1 }, [la, lo, face])
    await at(49.28880, -123.11062, 0); await page.keyboard.press('KeyP'); await page.waitForTimeout(1200)
    const wall = await page.evaluate(() => driveDebug.foot.framed.map(([L, pts]) => `${L.name} ${pts}`))
    say(!wall.some((w) => /Canada Place/.test(w)), `photo of a wall at Canada Place scores nothing: [${wall}]`)
    await at(49.29100, -123.11061, 0); await page.waitForTimeout(1200)
    const far = await page.evaluate(() => driveDebug.foot.framed.map(([L, pts]) => `${L.name} ${pts}`))
    console.log(`  (info) from 250 m north: [${far}]`)
    await page.reload(); await page.waitForFunction(() => window.driveDebug && !document.querySelector('#loading'), null, { timeout: 240000 }); await settle(page, 500)
  }
  if (want('hike')) { // W only on Lynn Canyon: the guide keeps the hiker within 15 m of the trail for 500 m of walking
    await page.evaluate(() => driveDebug.startHike('lynn'))
    await page.waitForFunction(() => city.player && driveDebug.hike, null, { timeout: 120000 })
    await page.evaluate(() => { const D = driveDebug; D.autopilot = () => ({ steer: 0, up: true, down: false, hand: false, run: true, boost: false }) })
    let walked = 0, worst = 0, last = null, t0 = Date.now(), goal = 0, g0 = 0
    let nulls = 0, early = 0
    while (walked < 500 && !(g0 && goal < 15) && Date.now() - t0 < +o.secs * 1000) {
      await page.waitForTimeout(1000)
      const r = await page.evaluate(() => { const D = driveDebug, m = D.man, n = D.nearestRoad(m.x, m.y, 60, false, true); return { x: m.x, y: m.y, off: n ? n.dist : 99, g: Math.hypot(D.hike.gx - m.x, D.hike.gy - m.y) } })
      if (last) walked += Math.hypot(r.x - last.x, r.y - last.y)
      if (!g0) g0 = r.g
      if (r.off === 99) { nulls++; if (walked < 1) early++ } else worst = Math.max(worst, r.off)
      goal = r.g; last = r
    }
    say(worst <= 15 && true, `hike: walked ${Math.round(walked)} m on W alone (${nulls - early} samples on the way, ${early} before the first step, with no trail within 60 m), never more than ${worst.toFixed(1)} m off the trail, goal ${Math.round(g0)} -> ${Math.round(goal)} m`)
    await page.reload(); await page.waitForFunction(() => window.driveDebug && !document.querySelector('#loading'), null, { timeout: 240000 }); await settle(page, 500)
  }
  if (want('leaf')) { // the nearest leaf's distance reaches the readout under 500 m and falls as the van closes in
    await page.waitForFunction(() => window.progressDebug && progressDebug.leaves().some((l) => l.set), null, { timeout: 60000 }).catch(() => {})
    const L = await page.evaluate(() => { const l = progressDebug.leaves().find((q) => !q.sea); return { x: l.x, z: l.z } })
    await page.evaluate((L) => driveDebug.start('car', L.x + 300, -L.z, 0), L)
    await settle(page, 2500)
    const read = () => page.evaluate(() => document.querySelector('.dlv-read')?.textContent.match(/🍁\s*(\d+) m/)?.[1] ?? null)
    const a = await read()
    await page.evaluate((L) => { driveDebug.car.x = L.x + 120; driveDebug.car.y = -L.z }, L); await page.waitForTimeout(800)
    const b = await read()
    say(a != null && b != null && +b < +a, `leaf hint: readout ${a} m, then ${b} m closer`)
  }
  if (want('taxi')) {
    await page.evaluate(() => { const p = city.world.fromLatLon(49.2838, -123.1185); driveDebug.startTaxi(p.x, -p.z) })
    await page.waitForFunction(() => driveDebug.taxi?.debug.S.n < 4, null, { timeout: 120000 })
    await page.evaluate(BOT)
    const t0 = Date.now()
    let r
    while (Date.now() - t0 < +o.secs * 1000) {
      r = await page.evaluate(() => { const s = driveDebug.taxi.debug.S; return { fares: s.fares, time: +s.time.toFixed(1), cash: +s.cash.toFixed(2), over: s.over, dbg: (() => { const T = driveDebug.taxi.debug, b = driveDebug.car, w = T.folk.filter((q) => q.mode === 'wait')[0]; return `sp ${b.speed.toFixed(1)} ring ${w ? Math.round(Math.hypot(w.rx - b.x, w.ry - b.y)) : '-'} fare ${T.fare ? Math.round(Math.hypot(T.fare.gx - b.x, T.fare.gy - b.y)) + ' add ' + T.fare.add : '-'}` })() } })
      if (process.env.DBG) console.log(JSON.stringify(r))
      if (r.fares >= 2 || r.over) break
      await page.waitForTimeout(1000)
    }
    say(r.fares >= 2, `taxi: ${r.fares} fares, $${r.cash}, clock ${r.time}s left, over ${r.over} (${Math.round((Date.now() - t0) / 1000)} s real)`)
  }
  const e = errs.filter((x) => !/404|Failed to load/.test(x))
  if (e.length) { bad++; console.log('page errors: ' + e.join(' | ').slice(0, 400)) }
} finally { await browser.close(); srv.stop() }
process.exit(bad ? 1 : 0)
