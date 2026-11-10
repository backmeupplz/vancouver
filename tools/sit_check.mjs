// node tools/sit_check.mjs [--out dir] [--size phone] [--tiles url] (the published tiles: local ones may have no logs): on foot in the real page, sat on what is there and petting a dog:
// next to a bench (Kitsilano Beach park), a driftwood log and on open grass, C sits the walker on it (at the seat, its
// head down, the button naming it) and a move key gets it up where it stood; G by a dog pets it once (the `pet` stat).
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { args, server, open, settle } from './pw.mjs'
const [o] = args(process.argv.slice(2), { out: '', at: '49.2745,-123.153', size: '1400x900', tiles: 'https://vancouver.borodutch.com/tiles' })
if (o.out) mkdirSync(o.out, { recursive: true })
const srv = await server(o.port)
const { browser, page, errs } = await open({ ...o, port: srv.port, query: '?drivedebug' })
try {
  await settle(page, 800)
  await page.waitForFunction(() => window.driveDebug, null, { timeout: 30000 })
  await page.evaluate(([la, lo]) => { const p = city.world.fromLatLon(la, lo); driveDebug.start('foot', p.x, -p.z, 0) }, o.at.split(',').map(Number))
  await settle(page, 3000)
  const life = await page.evaluate(() => !!city.traffic?.benches) // (the life plugin's benches() and dogs(), #606: without them the log and the grass only)
  if (life) await page.waitForFunction(() => city.traffic.benches(driveDebug.man.x, -driveDebug.man.y, 400).length, null, { timeout: 240000 })
  const shot = async (n) => { if (o.out) await page.screenshot({ path: `${o.out}/${n}.png` }) }
  // stand the walker a metre off (x, north), facing it
  const stand = (x, y, off = 1) => page.evaluate(([x, y, off]) => { const m = driveDebug.man, h = city.world.heightAt(x, -(y - off)); Object.assign(m, { x, y: y - off, yaw: 0, speed: 0, h: h + 0.15 }); driveDebug.chase.yaw = 0 }, [x, y, off])
  const state = () => page.evaluate(() => { const m = driveDebug.man; return { x: m.x, y: m.y, h: m.h, low: driveDebug.foot.low, label: document.querySelector('[data-f=sit]').textContent } })
  const sitOn = async (name, want, x, y, off) => {
    await stand(x, y, off); await page.waitForTimeout(900)
    const a = await state()
    assert(a.label.includes(want), `${name}: the button says "${a.label}"`)
    await page.keyboard.press('KeyC'); await page.waitForTimeout(3200)
    const b = await state(); await shot(name)
    assert(b.low > 0.25 && b.label === 'Get up', `${name}: sat (head down ${b.low.toFixed(2)} m)`)
    await page.keyboard.down('KeyW'); await page.waitForTimeout(900); await page.keyboard.up('KeyW'); await page.waitForTimeout(300)
    const c = await state()
    assert(c.low === 0, `${name}: up again`)
    return b
  }
  const here = await state()
  if (life) {
  const bench = await page.evaluate(([x, y]) => { const b = city.traffic.benches(x, -y, 400).map((q) => ({ x: q.x, y: -q.z, h: q.heading, d: Math.hypot(q.x - x, -q.z - y) })).sort((p, q) => p.d - q.d)[0]; return b || null }, [here.x, here.y])
  assert(bench, 'a bench near the start')
  await page.evaluate((b) => { const m = driveDebug.man; Object.assign(m, { x: b.x + Math.sin(b.h) * 1.2, y: b.y - Math.cos(b.h) * 1.2, speed: 0 }); m.h = city.world.heightAt(m.x, -m.y) + 0.15 }, bench)
  await page.waitForTimeout(900)
  assert((await state()).label === 'Sit on the bench', `bench: the button says "${(await state()).label}"`)
  await page.keyboard.press('KeyC'); await page.waitForTimeout(3200)
  const sb = await state(); await shot('bench')
  assert(sb.low > 0.25 && Math.hypot(sb.x - bench.x, sb.y - bench.y) < 0.5, `on the bench: ${Math.hypot(sb.x - bench.x, sb.y - bench.y).toFixed(2)} m from its middle`)
  await page.keyboard.down('KeyW'); await page.waitForTimeout(900); await page.keyboard.up('KeyW')
  }
  const log = await page.evaluate(([x, y]) => city.tiles.logsNear(x, -y, 600).filter((l) => l.dia > 0.3).map((l) => ({ x: l.x, y: -l.z, d: Math.hypot(l.x - x, -l.z - y) })).sort((p, q) => p.d - q.d)[0] || null, [here.x, here.y])
  assert(log, 'a log near the start')
  await sitOn('log', 'the log', log.x, log.y, 0.9)
  await sitOn('grass', 'Sit', here.x + 6, here.y + 1, 0)
  // a dog: stand by it, pet it
  const dog = life && await page.evaluate(([x, y]) => { const d = city.traffic.dogs(x, -y, 500).map((q) => ({ id: q.id, x: q.x, y: -q.z, d: Math.hypot(q.x - x, -q.z - y) })).sort((p, q) => p.d - q.d)[0]; return d || null }, [here.x, here.y])
  if (dog) {
    const pets = () => page.evaluate(() => city.progress?.stats.pet || 0), n0 = await pets()
    await page.evaluate((id) => { const d = city.traffic.dogs(driveDebug.man.x, -driveDebug.man.y, 900).find((q) => q.id === id), m = driveDebug.man; Object.assign(m, { x: d.x + 0.9, y: -d.z, speed: 0 }); m.h = city.world.heightAt(m.x, -m.y) + 0.15 }, dog.id)
    await page.waitForTimeout(500)
    await page.keyboard.press('KeyG'); await page.waitForTimeout(800); await shot('pet'); await page.waitForTimeout(1200)
    assert.equal(await pets(), n0 + 1, 'petting counts a `pet`')
    await page.keyboard.press('KeyG'); await page.waitForTimeout(300)
    assert.equal(await pets(), n0 + 1, 'the same dog only once a day')
  }
  assert(!errs.some((m) => !/404|Failed to load/.test(m)), 'page errors: ' + errs.join(' | ').slice(0, 300))
  console.log(`ok: ${life ? 'bench, ' : ''}log, grass${dog ? ', a dog petted once' : ' (no dog about)'}`)
} finally { await browser.close(); srv.stop() }
