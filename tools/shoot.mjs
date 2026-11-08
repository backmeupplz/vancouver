// node tools/shoot.mjs --out DIR [--port P] [--dpr 1|2] [--size 1400x900|phone|phone-land] [--tier auto|high|low]
//   [--weather clear|rain|snow|fog|storm|cloudy] [--hour H] [--season spring] SPEC...
// SPEC: name=#X,Y,zoom (map) | name=drive:lat,lon[,yaw rad, 0 north, + west] | walk:lat,lon[,yaw] | taxi:lat,lon | sail:lat,lon | bus:ROUTE:DIR
// Prints one line per shot: path + console error count.
import { mkdirSync } from 'node:fs'
import { args, server, open, settle } from './pw.mjs'
const [o, specs] = args(process.argv.slice(2), { out: '.', dpr: 1, size: '1400x900', tier: 'auto', weather: 'clear', hour: 13 })
if (!specs.length) { console.error('usage: see header of tools/shoot.mjs'); process.exit(1) }
mkdirSync(o.out, { recursive: true })
const srv = await server(o.port)
try {
  for (const spec of specs) { // fresh page per shot so modes never leak into each other
    const [name, v] = [spec.slice(0, spec.indexOf('=')), spec.slice(spec.indexOf('=') + 1)]
    const map = v.startsWith('#'), [kind, a, b, c] = v.split(/[:,]/), game = !map
    const { browser, page, errs } = await open({ ...o, port: srv.port, query: game ? '?drivedebug' : '', hash: map ? v : '' })
    await settle(page, 800)
    if (game && kind !== 'sail') await page.waitForFunction(() => window.driveDebug, null, { timeout: 30000 })
    if (kind === 'sail') {
      await page.evaluate(([la, lo]) => { const c = city, d = c.world.fromLatLon(la, lo).sub(c.controls.target); c.camera.position.add(d); c.controls.target.add(d); c.camera.zoom = 0.12; c.camera.updateProjectionMatrix(); c.controls.update(); c.requestRender() }, [+a, +b])
      await settle(page, 1500)
      await page.click('button[title^="Sail"]')
      const [x, y] = await page.evaluate(([la, lo]) => { const p = city.world.fromLatLon(la, lo).project(city.camera); return [(p.x + 1) / 2 * innerWidth, (1 - p.y) / 2 * innerHeight] }, [+a, +b])
      await page.mouse.click(x, y)
      await page.waitForTimeout(4500)
    } else if (kind === 'bus') {
      await page.evaluate(([r, d]) => driveDebug.startBus(r, +d || 0), [a, b])
    } else if (game) {
      await page.evaluate(([k, la, lo, yaw]) => { const p = city.world.fromLatLon(la, lo), y = -p.z; k === 'taxi' ? driveDebug.startTaxi(p.x, y) : driveDebug.start(k === 'walk' ? 'foot' : 'car', p.x, y, yaw) }, [kind, +a, +b, +c || 0])
    }
    await settle(page, game ? 2500 : 1000)
    const file = `${o.out}/${name}.png`
    await page.screenshot({ path: file })
    console.log(`${file} errors=${errs.length}${errs.length ? ' ' + errs[0].slice(0, 120) : ''}`)
    await browser.close()
  }
} finally { srv.stop() }
