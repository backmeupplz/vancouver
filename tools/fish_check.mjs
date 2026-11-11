// node tools/fish_check.mjs: the fishing plugin (public/plugins/fish).
// 1. the rules, in node: seasons (no pinks in even years, sturgeon only in the Fraser, trout only in lakes), a fight a
//    sensible angler wins and a careless one loses, the crab gauge's calls and fines.
// 2. in the page: every spot of rules.js SPOTS is dry, at the water's edge (water within a short cast) and can be walked
//    to (a street or path within 150 m in a dry straight line, not inside a building); exits 1 otherwise. `--snap 1`
//    prints the nearest place that passes for each one that fails.
// 3. on foot at Jericho Pier (--at id: another crabbing pier) a bot casts, strikes and reels until a fish is landed, then drops a crab trap, hauls it and
//    sorts the crab with the gauge (no fines).
// 4. under sail off Jericho the bot trolls a line and lands a fish while the boat keeps sailing.
// --spots 0 skips 2 (--ids a,b: only those); --shots dir saves cast / fight / card / gauge / logbook pictures; --size phone | 360x640;
// --embed 1 the X embed layout; --tiles https://vancouver.borodutch.com/tiles the published tiles.
import assert from 'node:assert/strict'
import { args, server, open, settle } from './pw.mjs'
import { SPOTS, SPECIES, biting, hookFish, newFight, stepFight, soak, judge, legal, tideAt, RODS, TRAPS, CRAB } from '../public/plugins/fish/rules.js'
import { mulberry32 } from '../public/core/util.js'

// ---------------------------------------------------------------- 1. the rules
{
  const base = { water: 's', kind: 'pier', month: 9, year: 2027, hour: 7, tide: { h: 3, rate: 0.4 }, wx: 'rain', lure: 'buzz', power: 0.7 }
  const ids = (c) => biting(c).map((b) => b.sp.id), share = (c, id) => { const l = biting(c), t = l.reduce((a, b) => a + b.w, 0); return (l.find((b) => b.sp.id === id)?.w || 0) / t }
  assert(ids(base).includes('pink') && !ids({ ...base, year: 2026 }).includes('pink'), 'pinks run in odd years only')
  assert(!ids(base).includes('sturgeon') && ids({ ...base, water: 'r' }).includes('sturgeon'), 'sturgeon: the Fraser only')
  assert(ids({ ...base, water: 'f' }).includes('rainbow') && !ids({ ...base, water: 'f' }).some((i) => /salmon|chinook|coho/.test(i)), 'lakes: trout, no salmon')
  assert(share(base, 'coho') > 8 * share({ ...base, month: 3 }, 'coho'), 'coho run in the fall')
  assert(share({ ...base, hour: 23 }, 'dogfish') > 2 * share({ ...base, hour: 12 }, 'dogfish'), 'dogfish at night')
  assert(share({ ...base, spot: SPOTS.find((s) => s.id === 'ambleside') }, 'coho') > 1.5 * share(base, 'coho'), 'Ambleside is coho water')
  const rng = mulberry32(7)
  let land = 0, lose = 0, secs = 0
  for (let i = 0; i < 200; i++) { // reel in the green, ease off on a run: lands nearly all; the button held down: loses the strong ones
    const fish = hookFish(base, rng), play = (smart) => { const f = newFight(fish, 14, RODS.spin); for (let t = 0; t < 180; t += 1 / 60) { const ev = stepFight(f, 1 / 60, smart ? f.T < (f.run > 0 ? 0.5 : 0.8) && !(f.run > 0 && f.p * (0.35 + 0.65 * f.st) > 0.55) : true, rng); if (ev && ev !== 'run') return [ev, t] } return ['timeout', 180] }
    const [a, t] = play(true), [b] = play(false)
    if (a === 'landed') { land++; secs += t } if (b !== 'landed' && fish.sp.fight > 0.5) lose++
  }
  assert(land >= 190, `a careful angler lands the fish (${land}/200)`); assert(lose > 20, `holding the button loses the strong ones (${lose})`)
  const tides = Array.from({ length: 24 * 14 }, (_, h) => tideAt(Date.UTC(2026, 10, 1) + h * 3600000).h)
  assert(Math.min(...tides) > 0 && Math.max(...tides) < 5.6 && Math.max(...tides) - Math.min(...tides) > 3, 'the tide stays between 0 and 5.6 m and ranges over 3 m')
  const slack = soak(120, { tide: { rate: 0 }, trap: TRAPS.pot }, mulberry32(3)).length, ebb = soak(120, { tide: { rate: 0.9 }, trap: TRAPS.pot }, mulberry32(3)).length
  assert(slack > ebb && !soak(5, { tide: { rate: 0 } }).length && soak(600, { tide: { rate: 0 }, trap: TRAPS.ring }, mulberry32(3)).length < soak(120, { tide: { rate: 0 }, trap: TRAPS.ring }, mulberry32(3)).length, 'slack tide fills the trap; a ring left too long empties')
  const big = { kind: 'dungeness', mm: 180, male: true }, small = { ...big, mm: 150 }, hen = { ...big, male: false }
  assert(judge(big, true).cash > 0 && judge(small, true).cash < 0 && judge(hen, true).cash < 0 && judge(big, true, 4).cash < 0, 'keep: only a legal male under the daily limit')
  assert(judge(small, false).cash > 0 && judge(hen, false).ok && !judge(big, false).ok && legal(big) && !legal(hen), 'release: paid when it had to go back')
  assert(SPECIES.every((s) => s.lines?.length && s.shape) && SPOTS.every((s) => s.closed || biting({ ...base, water: s.water, kind: s.kind, spot: s }).length > 3), 'every species has a line and a model, every spot has fish')
  console.log(`rules ok: ${SPECIES.length} species, ${SPOTS.length} spots, careful angler ${land}/200 landed in ${(secs / land).toFixed(1)} s on average, button-masher lost ${lose}; pot at slack ${slack} vs running tide ${ebb}; Dungeness ${CRAB.dungeness.min} mm`)
}

// ---------------------------------------------------------------- 2 + 3. in the page
const [o] = args(process.argv.slice(2), { tiles: '', snap: '', spots: '1', shots: '', size: '1400x900', embed: '', only: '', ids: '', at: 'jericho' })
if (o.only === 'rules') process.exit(0)
const srv = await server()
const { browser, page, errs } = await open({ ...o, port: srv.port, query: o.embed ? '?embed&drivedebug' : '?drivedebug', hash: '#13645,11243,0.1295' })
let bad = 0
const shot = async (name) => { if (o.shots) { await page.waitForTimeout(350); await page.screenshot({ path: `${o.shots}/${name}.png` }) } }
try {
  await page.waitForFunction(() => window.fishDebug && window.driveDebug, null, { timeout: 60000 })
  // one spot: where it stands, whether it passes, and with snap the nearest place that does
  const check = ([id, snap]) => {
    const F = fishDebug, s = F.spots.find((q) => q.id === id), K = (x, y) => Math.floor(x / 1024) + ',' + Math.floor(y / 1024)
    const around = (x, z) => { const o = []; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const t = F.tiles.get(K(x + i * 1024, -z + j * 1024)); if (t) o.push(t) } return o }
    const edge = (x, z) => { for (let a = 0; a < 16; a++) { const dx = Math.sin(a * Math.PI / 8), dz = Math.cos(a * Math.PI / 8), d = F.waterAhead(x, z, dx, dz); if (d) return { d, h: a * Math.PI / 8 } } return null }
    const inside = (x, z) => around(x, z).some((t) => { const f = t.footprints; if (!f) return false; for (let r = 0; r + 1 < f.start.length; r++) { let c = false; for (let a = f.start[r], n = f.start[r + 1], b = n - 2; a < n; b = a, a += 2) { const ax = f.pts[a], ay = f.pts[a + 1], bx = f.pts[b], by = f.pts[b + 1]; if ((ay > -z) !== (by > -z) && x < ((bx - ax) * (-z - ay)) / (by - ay) + ax) c = !c } if (c) return true } return false })
    const walk = (x, z) => { // metres to the nearest street or path that a dry straight line reaches, else -1
      let best = -1
      for (const t of around(x, z)) for (const p of t.graph?.pieces || []) { if (p.kind === 0 || p.kind >= 14) continue
        for (let i = 0; i < p.pts.length; i += 2) { const px = p.pts[i], pz = -p.pts[i + 1], d = Math.hypot(px - x, pz - z); if (d > 150 || (best >= 0 && d >= best)) continue
          let dry = true; for (let q = 0; q <= d; q += 1) if (F.isWater(x + (px - x) * q / (d || 1), z + (pz - z) * q / (d || 1))) { dry = false; break }
          if (dry) best = d } }
      return best
    }
    const onPath = (x, z, fn) => { // metres to the nearest street or path (a pier narrower than the water mask's 4 m cells is walked along its path)
      let best = 1e9
      for (const t of around(x, z)) for (const p of t.graph?.pieces || []) { if (p.kind === 0 || p.kind >= 14) continue
        for (let i = 0; i + 3 < p.pts.length; i += 2) { const ax = p.pts[i], az = -p.pts[i + 1], bx = p.pts[i + 2] - ax, bz = -p.pts[i + 3] - az, k = Math.max(0, Math.min(1, ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz || 1))), d = Math.hypot(ax + bx * k - x, az + bz * k - z)
          if (d < best) { best = d; fn?.(ax + bx * k, az + bz * k) } } }
      return best
    }
    const dry = (x, z) => !F.isWater(x, z) // (a pier is not water: core/tiles.js isWater)
    const test = (x, z) => { const e = dry(x, z) && edge(x, z); return e && !inside(x, z) && (onPath(x, z) < 0.6 || walk(x, z) >= 0) ? e : null }
    const r = { id, loaded: F.tiles.has(K(s.x, -s.z)), dry: dry(s.x, s.z), edge: edge(s.x, s.z), walk: Math.round(Math.min(onPath(s.x, s.z), walk(s.x, s.z) < 0 ? 1e9 : walk(s.x, s.z))), inside: inside(s.x, s.z), x: s.x, z: s.z, pier: !!city.world.pierAt(s.x, s.z), kind: s.kind }
    if (r.walk > 1e6) r.walk = -1
    r.ok = r.loaded && !!test(s.x, s.z)
    if (!r.ok && snap) for (let q = 2; q <= 400 && !r.snap; q += 2) for (let a = 0; a < 24; a++) { const x = s.x + Math.sin(a * Math.PI / 12) * q, z = s.z + Math.cos(a * Math.PI / 12) * q; if (test(x, z)) { const ll = city.world.toLatLon(x, z); r.snap = `${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)} (${q} m off)`; break } }
    if (!r.ok && snap) { let px, pz; const d = onPath(s.x, s.z, (x, z) => { px = x; pz = z }); if (d < 60 && test(px, pz)) { const ll = city.world.toLatLon(px, pz); r.onPath = `${ll.lat.toFixed(5)}, ${ll.lon.toFixed(5)} (${d.toFixed(0)} m off, on its path)` } }
    return r
  }
  const goto = async (id) => { await page.evaluate((id) => { const s = fishDebug.spots.find((q) => q.id === id), c = city, d = new c.THREE.Vector3(s.x, c.controls.target.y, s.z).sub(c.controls.target); c.camera.position.add(d); c.controls.target.add(d); c.camera.zoom = 1.6; c.camera.updateProjectionMatrix(); c.controls.update(); c.requestRender() }, id); await settle(page, 300) }
  if (o.spots !== '0') for (const s of SPOTS) {
    if (o.ids && !o.ids.split(',').includes(s.id)) continue
    await goto(s.id)
    const r = await page.evaluate(check, [s.id, !!o.snap])
    if (!r.ok) bad++
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${s.id.padEnd(12)} ${r.loaded ? '' : 'tile not loaded '}${r.dry ? 'dry' : 'IN WATER'}, water ${r.edge ? r.edge.d.toFixed(1) + ' m' : 'NONE within 13 m'}, path ${r.walk >= 0 ? r.walk + ' m' : 'NONE'}${r.inside ? ', INSIDE A BUILDING' : ''}${r.kind === 'pier' ? (r.pier ? ', on its pier' : ', NOT on a pier') : ''}${r.onPath ? `  → ${r.onPath}` : r.snap ? `  → ${r.snap}` : ''}`)
  }

  // 200 casts round the compass from three piers (one 3.5 m wide): no bobber ever lands on a deck
  if (o.spots !== '0') for (const id of ['jericho', 'ambleside', 'crescent']) {
    const spot = SPOTS.find((q) => q.id === id)
    if (!spot) continue
    await goto(id)
    const n = await page.evaluate(([x, z]) => { let bad = 0, tot = 0; for (let a = 0; a < 200; a++) for (let d = 3; d <= 30; d += 3) { const px = x + Math.sin(a * Math.PI / 100) * d, pz = z + Math.cos(a * Math.PI / 100) * d; if (fishDebug.isWater(px, pz)) { tot++; if (city.world.pierAt(px, pz)) bad++ } } return { bad, tot } }, [spot.x, spot.z])
    console.log(`${n.bad ? 'FAIL' : 'ok  '} casts ${id}: ${n.bad} of ${n.tot} bobbers on a deck`)
    if (n.bad) bad++
  }
  if (o.only === 'spots') throw new Error('spots only')
  // a catch and a haul at Jericho Pier
  await goto(o.at)
  const j = await page.evaluate(check, [o.at, false])
  assert(j.edge, 'there is water to cast into')
  await page.evaluate(([x, z, h, d]) => driveDebug.start('foot', x + Math.sin(h) * Math.max(0, d - 4), -z - Math.cos(h) * Math.max(0, d - 4), h - Math.PI), [j.x, j.z, j.edge.h, j.edge.d]) // (up to the rail)
  await page.waitForFunction(() => city.player?.mode === 'foot' && fishDebug.near, null, { timeout: 60000 })
  await settle(page, 1500)
  const at = await page.evaluate((id) => { const P = city.player, s = fishDebug.spots.find((q) => q.id === id); return { off: Math.hypot(P.x - s.x, P.z - s.z), chip: !document.querySelector('.fs-chips').hidden, place: fishDebug.near.place.id } }, o.at)
  assert(at.off < 14 && at.chip && at.place === o.at, `the walker stands on the pier with the prompt up (${JSON.stringify(at)})`)
  await shot('0-prompt')
  await page.evaluate(() => { localStorage.removeItem('fish.v1'); fishDebug.save.how = true; fishDebug.begin(); fishDebug.press(true) })
  await page.waitForTimeout(700); await shot('1-cast')
  await page.evaluate(() => { fishDebug.fast = 4; fishDebug.auto = 'hold' })
  for (let i = 0; i < 40; i++) { // (a fight can be lost, a seal can take it: the bot casts again)
    await page.waitForFunction(() => fishDebug.S?.st === 'fight' && fishDebug.S.f.t > 2.5 || fishDebug.S?.st === 'card', null, { timeout: 120000 })
    if (await page.evaluate(() => fishDebug.S.st === 'fight')) { await page.evaluate(() => { fishDebug.fast = 0 }); await shot('2-fight'); await page.evaluate(() => { fishDebug.fast = 4 }) }
    await page.waitForFunction(() => fishDebug.S?.st !== 'fight', null, { timeout: 120000 })
    if (await page.evaluate(() => fishDebug.S.st === 'card' && fishDebug.S.lastWin?.id)) break
    await page.evaluate(() => { if (fishDebug.S.st === 'card') { fishDebug.press(true); fishDebug.press(false) } fishDebug.auto = 'hold' })
  }
  const won = await page.evaluate(() => ({ ...fishDebug.S.lastWin, cash: city.progress?.cash, log: Object.keys(fishDebug.save.log), card: document.querySelector('.fs-card h3')?.textContent }))
  assert(won.id && won.log.includes(won.id) && won.card, 'a fish was landed, logged and shown')
  console.log(`catch ok: ${won.card}${won.cm ? ` ${won.cm} cm` : ''}, +$${won.cash}`)
  await shot('3-card')
  await page.evaluate(() => { fishDebug.fast = 1; fishDebug.stop(); fishDebug.look(); fishDebug.trapKey() })
  assert(await page.evaluate(() => !!fishDebug.trap), 'the trap went down off the pier')
  await page.evaluate(() => { fishDebug.age(110); fishDebug.look(); fishDebug.trapKey(); fishDebug.press(true) })
  await page.waitForFunction(() => fishDebug.S?.st === 'sort' || fishDebug.S?.st === 'sum', null, { timeout: 30000 })
  assert(await page.evaluate(() => fishDebug.S.st === 'sort'), 'a trap soaked for two minutes holds crab')
  await page.evaluate(() => { fishDebug.press(false); fishDebug.press(true); fishDebug.press(false) })
  await shot('4-gauge')
  await page.evaluate(() => { fishDebug.auto = true })
  await page.waitForFunction(() => fishDebug.lastHaul, null, { timeout: 30000 })
  const haul = await page.evaluate(() => fishDebug.lastHaul)
  assert(haul.n > 0 && !haul.fines && !haul.wrong && haul.kept + haul.back === haul.n, `the haul was sorted with no fines (${JSON.stringify(haul)})`)
  console.log(`haul ok: ${haul.n} crab, ${haul.kept} kept, ${haul.back} back, +$${haul.pay}`)
  await page.evaluate(() => { fishDebug.auto = false; fishDebug.stop(); fishDebug.look(); fishDebug.begin(); fishDebug.toggleLog() })
  await shot('5-logbook')
  await page.evaluate(() => fishDebug.stop())
  assert(await page.evaluate(() => !city.fishing.busy && !city.fishing.active && document.querySelector('.fs').hidden), 'packed up: nothing left running')
  // 4. trolling from the sailboat off Jericho: the bot sails, a fish is hooked and fought under way
  await page.reload(); await page.waitForFunction(() => window.fishDebug && window.sailDebug && !document.querySelector('#loading'), null, { timeout: 120000 })
  await page.evaluate(() => { const c = city, d = c.world.fromLatLon(49.284, -123.19).sub(c.controls.target); d.y = 0; c.camera.position.add(d); c.controls.target.add(d); c.camera.zoom = 0.5; c.camera.updateProjectionMatrix(); c.controls.update(); c.requestRender() })
  await settle(page, 500)
  await page.evaluate(() => { const p = city.world.fromLatLon(49.284, -123.19); sailDebug.start(p.x, p.z); sailDebug.auto = true })
  await page.waitForFunction(() => city.player?.mode === 'boat' && fishDebug.near && sailDebug.B.speed > 1, null, { timeout: 60000 })
  await page.evaluate(() => { fishDebug.save.how = true; fishDebug.fast = 3; fishDebug.auto = true; fishDebug.begin() })
  await page.waitForFunction(() => fishDebug.S?.st === 'fight' && fishDebug.S.f.t > 1.5, null, { timeout: 120000 })
  await page.evaluate(() => { fishDebug.fast = 0 }); await shot('6-troll'); await page.evaluate(() => { fishDebug.fast = 3 })
  await page.waitForFunction(() => fishDebug.caught.length, null, { timeout: 180000 })
  const tr = await page.evaluate(() => ({ c: fishDebug.caught[0], busy: city.fishing.busy, v: sailDebug.B.speed }))
  assert(tr.c && !tr.busy && tr.v > 0.5, 'a fish came aboard with the boat still sailing')
  console.log(`troll ok: ${tr.c.seal ? 'a seal took it' : `${tr.c.id} ${tr.c.cm} cm`} at ${tr.v.toFixed(1)} m/s`)
  await page.evaluate(() => fishDebug.stop())
  const real = errs.filter((e) => !/404|WebSocket|live\//.test(e)) // (no live server here)
  if (real.length) { bad++; console.log('page errors:', real.slice(0, 5)) }
} catch (e) { if (o.only === 'spots') process.exitCode = bad ? 1 : 0; else bad++; if (o.only !== 'spots') console.log('FAIL', e.message.split('\n')[0]); if (errs.length) console.log('page errors:', errs.slice(0, 5)); if (o.shots) await page.screenshot({ path: `${o.shots}/fail.png` }).catch(() => {}) }
finally { await browser.close(); srv.stop() }
process.exit(bad ? 1 : 0)
