// node tools/leaves_check.mjs [--tiles https://vancouver.borodutch.com/tiles]: every maple leaf of the progress plugin (leaves.js),
// after its tile has settled it (?drivedebug: window.progressDebug): 144 in the stated 12 areas (13 at sea), each snapped to
// something (within 250 m), land ones on a street or path the van or the walker stands on (not in a building, under a deck, in
// a tunnel), sea ones on open water 15 m clear of shore and vessels and connected to the open sea, none within 150 m
// of another. --area N or --only 0.1,2.3: just those (no cross-area checks). One line per failing leaf (id, area, reason, lat/lon); exits 1 on any.
import { spawnSync } from 'node:child_process'
import { args, server, open, settle } from './pw.mjs'
const COUNTS = [14, 11, 16, 9, 14, 9, 13, 12, 12, 7, 14, 13] // per area, in leaves.js order
const [o] = args(process.argv.slice(2), { tiles: '', area: '', only: '' })
if (o.area === '' && !o.only) { // one fresh browser per area (a page holding the whole map's tiles crashes), then the checks across areas
  const res = [], bad = []
  for (let a = 0; a < COUNTS.length; a++) {
    let r
    for (let go = 0; go < 3; go++) { // (a page crashes now and then on a loaded machine: again)
      r = spawnSync(process.execPath, [process.argv[1], '--area', a, ...(o.tiles ? ['--tiles', o.tiles] : [])], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] })
      if (r.stdout.includes('RES ')) break
    }
    for (const line of r.stdout.split('\n')) if (line.startsWith('RES ')) res.push(...JSON.parse(line.slice(4))); else if (line && !line.endsWith('problems') && !line.endsWith('pass')) bad.push(line)
    if (r.status === null || (r.status && !r.stdout.includes('problems'))) bad.push(`area ${a}: the check itself failed`)
  }
  if (res.length !== 144) bad.push(`${res.length} leaves, not 144`)
  COUNTS.forEach((c, a) => { const n = res.filter((l) => l.area === a).length; if (n !== c) bad.push(`area ${a}: ${n} leaves, stated ${c}`) })
  if (res.filter((l) => l.sea).length !== 13) bad.push('not 13 leaves at sea')
  for (const a of res) for (const b of res) if (a.id < b.id && Math.hypot(a.x - b.x, a.z - b.z) < 150) bad.push(`${b.id} "${b.name}": ${Math.round(Math.hypot(a.x - b.x, a.z - b.z))} m from ${a.id} "${a.name}" (${b.ll[0]}, ${b.ll[1]})`)
  console.log(bad.join('\n'))
  console.log(bad.length ? `${bad.length} problems` : `${res.length}/144 pass`)
  process.exit(bad.length ? 1 : 0)
}
const srv = await server()
const { browser, page } = await open({ ...o, port: srv.port, query: '?drivedebug' })
const bad = []
try {
  await settle(page, 800)
  await page.waitForFunction(() => window.progressDebug && window.driveDebug && window.sailDebug, null, { timeout: 60000 })
  const all = (await page.evaluate(() => progressDebug.leaves())).filter((l) => (o.only ? o.only.split(',').includes(l.id) : l.area === +o.area))
  const names = await page.evaluate(() => progressDebug.AREAS.map((a) => [a[0], a[1].length]))
  const fail = (l, why) => bad.push(`${l.id} ${names[l.area][0]} "${l.name}": ${why} (${l.ll[0]}, ${l.ll[1]})`)
  const res = []
  for (const l0 of all) {
    await page.evaluate(([la, lo]) => { const c = city, d = c.world.fromLatLon(la, lo).sub(c.controls.target); c.camera.position.add(d); c.controls.target.add(d); c.camera.zoom = 0.12; c.camera.updateProjectionMatrix(); c.requestRender() }, l0.ll)
    const i = l0.id
    await settle(page, 500)
    await page.waitForFunction((i) => progressDebug.leaves().find((l) => l.id === i).set, i, { timeout: 20000 }).catch(() => {})
    await page.waitForFunction((i) => { const l = progressDebug.leaves().find((l) => l.id === i), y = -l.z; return l.sea ? sailDebug.wet(l.x, l.z) : driveDebug.nearestRoad(l.x, y, 6, false, true) }, i, { timeout: 8000 }).catch(() => {}) // (its index built)
    const r = await page.evaluate((i) => {
      const l = progressDebug.leaves().find((l) => l.id === i), D = driveDebug, y = -l.z, out = { ...l, why: [] }
      if (!l.set) return { ...out, why: ['tile never loaded'] }
      if (l.snap < 0) out.why.push('nothing to snap to within 250 m')
      if (l.sea) {
        const w = (a, b) => sailDebug.wet(a, -b) // (the sail plugin's: the boat floats on it)
        let dry = !w(l.x, y) ? 1 : 0
        for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8; if (!w(l.x + 15 * Math.cos(a), y + 15 * Math.sin(a))) dry++ }
        if (dry) out.why.push(`${dry} of 17 points within 15 m are not water`)
        const v = (city.ships?.nearby?.(l.x, l.z, 15) || []).length
        if (v) out.why.push(`${v} vessels within 15 m`)
        // the sea the sailboat starts in: a flood fill of the sail plugin's water mask (the coarse base picture where no tile is loaded), 40 m cells, to the open water off Jericho (within a box round the two, 4 km wider)
        const wet = sailDebug.wet, S = 40, T = [Math.round(city.world.fromLatLon(49.2795, -123.215).x / S), Math.round(city.world.fromLatLon(49.2795, -123.215).z / S)]
        const seen = new Set(), q = [[Math.round(l.x / S), Math.round(l.z / S)]]; let ok = false, n = 0
        while (q.length && n++ < 400000) { const [a, b] = q.pop(), k = a * 100003 + b; if (seen.has(k) || Math.abs(a * S - (l.x + T[0] * S) / 2) > Math.abs(l.x - T[0] * S) / 2 + 4000 || Math.abs(b * S - (l.z + T[1] * S) / 2) > Math.abs(l.z - T[1] * S) / 2 + 4000 || !wet(a * S, b * S)) continue; seen.add(k); if (Math.abs(a - T[0]) < 3 && Math.abs(b - T[1]) < 3) { ok = true; break } q.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]) }
        if (!ok) out.why.push(`not connected to the open sea by water (${seen.size} cells reached)`)
      } else {
        const g = city.world.heightAt(l.x, l.z), r = D.nearestRoad(l.x, y, 6, false, true), dk = D.nearestRoad(l.x, y, 6, true, false, false, g)
        if (!r || r.dist > r.w / 2 + 1) out.why.push('no street or path the walker can stand on')
        else if (r.s.p.tunnel) out.why.push('inside a tunnel')
        if (dk && dk.d < 1 && dk.z != null && dk.z > g + 3 && !dk.s.p.tunnel) out.why.push(`under a deck (${Math.round(dk.z - g)} m up)`)
        if (D.collide(l.x, y, 0.6, g + 1)) out.why.push('inside a building')
        if (D.isWater(l.x, y)) out.why.push('in water')
      }
      return out
    }, i)
    res.push(r)
    for (const w of r.why) fail(r, w)
    console.error(r.id, r.sea ? 'sea' : 'land', Math.round(r.snap), r.why.length ? 'FAIL' : 'ok')
  }
  console.log('RES ' + JSON.stringify(res.map(({ id, name, area, sea, x, z, ll }) => ({ id, name, area, sea, x, z, ll }))))
} finally { await browser.close(); srv.stop() }
console.log(bad.join('\n'))
const n = bad.length
console.log(n ? `${n} problems` : 'pass')
process.exit(n ? 1 : 0)
