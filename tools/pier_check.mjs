// node tools/pier_check.mjs [--tiles URL] [--tides 0,5] [--only jericho,...]: the walker out along a pier and a marina float, at each tide:
// feet on the deck (within 5 cm), the deck over the water, the walker never under the sea's surface, and turned
// sideways at the end of the run it stays on the deck (no walking off the side). Exits 1 on any failure.
import { args, server, open, settle } from './pw.mjs'
const [o] = args(process.argv.slice(2), { tides: '0,5', only: '', size: '1000x700', tiles: '' })
const PLACES = { // name: [lat, lon] a spot on the pier or float
  jericho: [49.27655, -123.20188],
  ambleside: [49.32603, -123.15451],
  whiterock: [49.01823, -122.80571],
  'coalharbour-float': [49.29195, -123.12762],
}
const srv = await server(o.port)
let bad = 0
for (const tide of o.tides.split(',')) {
  const { browser, page, errs } = await open({ ...o, port: srv.port, tide, query: '?drivedebug' })
  try {
    await page.waitForFunction(() => window.driveDebug, null, { timeout: 30000 })
    for (const [name, [la, lo]] of Object.entries(PLACES)) {
      if (o.only && !o.only.split(',').includes(name)) continue
      await page.evaluate(([la, lo]) => { const p = city.world.fromLatLon(la, lo); driveDebug.start('foot', p.x, -p.z, 0) }, [la, lo])
      await settle(page, 2500)
      await page.waitForFunction(() => view.tiles.pierIn(driveDebug.man.x, driveDebug.man.y), null, { timeout: 90000 }).catch(() => {}); await settle(page, 1000)
      // the heading with the longest unbroken pier ahead
      const yaw = await page.evaluate(() => {
        const m = driveDebug.man; let best = 0, by = 0
        if (!city.world.pierAt?.(m.x, -m.y)) { // (the nearest pier point within 40 m)
          let d0 = 1e9, q = null
          for (let dx = -40; dx <= 40; dx += 1) for (let dy = -40; dy <= 40; dy += 1) if (Math.hypot(dx, dy) < d0 && city.world.pierAt?.(m.x + dx, -(m.y + dy))) { d0 = Math.hypot(dx, dy); q = [dx, dy] }
          if (q) { m.x += q[0]; m.y += q[1] }
        }
        for (let a = 0; a < 32; a++) { const yw = a * Math.PI / 16; let n = 0; for (; n < 200; n++) if (!city.world.pierAt?.(m.x - Math.sin(yw) * n, -(m.y + Math.cos(yw) * n))) break; if (n > best) { best = n; by = yw } }
        m.yaw = by; return by
      })
      const run = async (ms) => {
        const out = []
        await page.keyboard.down('KeyW')
        for (let t = 0; t < ms; t += 100) {
          await page.waitForTimeout(100)
          out.push(await page.evaluate(() => { const m = driveDebug.man, p = city.world.pierAt?.(m.x, -m.y); return { on: !!p, feet: m.h - 0.15, top: p?.y, sea: city.sea.at(m.x, -m.y), raw: view.tiles.heightAt(m.x, m.y, true) } }))
        }
        await page.keyboard.up('KeyW')
        return out
      }
      const fails = []; let strip = 0
      const s1 = await run(4000)
      const on = s1.filter((s) => s.on)
      if (on.length < 5) fails.push(`only ${on.length} of ${s1.length} samples on the pier`)
      for (const s of on.slice(3)) { // (the first beats: stepping on)
        if (s.feet > s.top + 0.3) { strip++; continue } // (a footway that is its own drawn deck strip, bridge=boardwalk: out of scope, walked at its own height)
        if (Math.abs(s.feet - s.top) > 0.05) fails.push(`feet ${s.feet.toFixed(2)} vs deck ${s.top.toFixed(2)}`)
        if (s.raw < 0.3 && s.top <= s.sea) fails.push(`deck ${s.top.toFixed(2)} not over the water ${s.sea.toFixed(2)}`)
      }
      for (const s of s1) if (s.feet < s.sea - 0.5) fails.push(`under the sea: feet ${s.feet.toFixed(2)} sea ${s.sea.toFixed(2)}`)
      // sideways: turn 90 degrees and walk on; the walker must still stand on the deck (or have been stopped at its edge)
      await page.evaluate(() => { driveDebug.man.yaw += Math.PI / 2 })
      const s2 = await run(2500)
      for (const s of s2) if (s.feet < s.sea - 0.5) fails.push(`side: under the sea, feet ${s.feet.toFixed(2)} sea ${s.sea.toFixed(2)}`)
      const last = s2[s2.length - 1]
      if (!last.on && last.raw < 0.3) fails.push('side: walked off the deck into the water')
      const u = [...new Set(fails.map((f) => f.replace(/[\d.-]+/g, 'N')))]
      console.log(`${fails.length ? 'FAIL' : 'ok  '} tide ${tide} ${name.padEnd(18)} ${on.length}/${s1.length} on deck${strip ? `, ${strip} on a deck strip` : ''}${fails.length ? ' ' + fails.length + ' faults, e.g. ' + fails.slice(0, 3).join('; ') : ''}`)
      if (fails.length) bad++
    }
    if (errs.length) console.log('page errors:', errs.slice(0, 3).join(' | '))
  } finally { await browser.close() }
}
srv.stop()
process.exit(bad ? 1 : 0)
