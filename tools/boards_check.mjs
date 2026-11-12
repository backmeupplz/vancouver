// node tools/boards_check.mjs [--tiles URL] [--shots dir]: honest boards (server/src/world.rs run tickets) end to end. Starts
// the live server (cargo build once; a temp database) and the page against it (?live=ws://…): a run ticket per scored
// run; an honest run is kept, a replay, a too fast run and an over-bound value are not; today's best run's ghost goes
// up and comes back in another browser; offline there is no ticket (best kept locally, nothing submitted). Takes ~1 min
// (the server's clock: 46 s). With --shots dir: the Top tab at desktop, phone and the 360 px embed.
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { args, server, open } from './pw.mjs'
const [o] = args(process.argv.slice(2), { tiles: '', shots: '' })
const root = fileURLToPath(new URL('..', import.meta.url))
execFileSync('cargo', ['build', '--quiet'], { cwd: root + 'server', stdio: 'inherit' })
const port = 30000 + Math.floor(Math.random() * 9000), dir = mkdtempSync(tmpdir() + '/boards-')
const live = spawn(root + 'server/target/debug/vancouver-live', [], { env: { ...process.env, PORT: port, DATA: dir + '/live.db' }, stdio: 'ignore' })
const base = `http://127.0.0.1:${port}/live`
for (let i = 0; i < 50 && !(await fetch(base + '/health').then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 200))
const srv = await server()
let bad = 0
const ok = (c, m) => { if (!c) { bad++; console.log('FAIL', m) } else console.log('ok  ', m) }
const rows = async (b, key = 'boards') => (await (await fetch(base + '/boards?t=' + Math.random())).json())[key][b] || []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const L = `?drivedebug&live=ws://127.0.0.1:${port}/live/ws`
const pts = Array.from({ length: 41 }, (_, i) => [1000 + i * 12, 2000 + Math.sin(i / 5) * 30, 0.5]) // 40 s of path, ~12 m a second
let A, B, off
try {
  A = await open({ ...o, port: srv.port, query: L })
  await A.page.waitForFunction(() => city.multiplayer?.connected, null, { timeout: 20000 })
  const nameA = await A.page.evaluate(() => city.multiplayer.name)
  // tickets from the server (a clock for each run), then too fast: nothing
  const t = await A.page.evaluate(async () => {
    const P = city.progress, tk = Object.fromEntries(['dock', 'd-dash', 'taxi', 'delivery'].map((b) => [b, P.run(b)]))
    const t0 = performance.now(); while (Object.values(tk).some((r) => !r.n) && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50))
    window.__n = Object.fromEntries(Object.entries(tk).map(([b, r]) => [b, r.n]))
    return { n: Object.values(tk).map((r) => r.n), live: Object.values(tk).map((r) => r.live) }
  })
  ok(t.n.every((n) => /^[0-9a-f]{8}$/.test(n)) && t.live.every(Boolean), 'the server answers a run with a ticket')
  await A.page.evaluate(() => city.progress.score('delivery', 100)) // 0 s into a 120 s minimum
  await sleep(600)
  ok((await rows('delivery')).length === 0, 'too fast run rejected')
  await sleep(46000 - 600) // the server's clock: taxi needs 45 s (and pays at most 6 a second + 50)
  await A.page.evaluate((p) => { const P = city.progress; P.score('taxi', 400); P.score('dock', 900); P.score('d-dash', 550000, { ghost: p }) }, pts)
  await sleep(800)
  ok((await rows('taxi')).length === 0, 'over-bound value rejected (taxi 400 after 46 s: the bound is 326)')
  const dock = await rows('dock'), dash = await rows('d-dash')
  ok(dock.length === 1 && dock[0].v === 900 && dock[0].ok, 'happy path: an honest dock run is kept and verified')
  ok(dash.length === 1 && dash[0].v === 550000 && dash[0].ok && dash[0].name === nameA, "happy path: today's dash run is on the day's board")
  ok((await rows('d-dash', 'all')).length === 1 && (await rows('dock', 'all')).length === 1, 'the all-time boards have it too')
  await A.page.evaluate(() => city.multiplayer.send({ t: 'score', board: 'dock', v: 1500, n: window.__n.dock })) // the same ticket again
  await sleep(600)
  ok((await rows('dock'))[0].v === 900, 'replay rejected (a spent ticket)')
  // ghost round trip: A's page uploaded it (the board showed it as the day's best); B, another browser, fetches it
  B = await open({ ...o, port: srv.port, query: L })
  await B.page.waitForFunction(() => city.multiplayer?.connected, null, { timeout: 20000 })
  let g = null
  for (let i = 0; i < 20 && !g; i++) { g = await B.page.evaluate(() => city.progress.ghost('d-dash')); if (!g) await sleep(500) }
  ok(g && g.name === nameA && g.v === 550000 && g.pts.length === 41, `ghost round trip (${g ? g.name + ' ' + g.v + ' ' + g.pts.length + ' pts' : 'none'})`)
  ok(g && g.pts.every((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]) < 0.11 && Math.abs(q[2] - 0.5) < 0.03), 'ghost path survives the quantising (0.1 m, 1.4 deg)')
  // B posts a better time without a ticket (an old page): below the verified row, and no ghost of its own
  await B.page.evaluate(() => city.multiplayer.send({ t: 'score', board: 'd-dash', v: 599000 }))
  await sleep(600)
  const dash2 = await rows('d-dash')
  ok(dash2[0].name === nameA && dash2[0].v === 550000 && dash2[1]?.v === 599000 && dash2[1].ok === false, 'a ticketless score is flagged unverified and ranks below')
  const raw = await fetch(base + '/ghost?board=d-dash'), buf = new Uint8Array(await raw.arrayBuffer())
  ok(raw.ok && buf.length === 14 + 5 * 40 && raw.headers.get('x-v') === '550000', 'the stored ghost is still A\'s (~214 bytes)')
  const hack = await fetch(base + '/ghost?board=d-dash', { method: 'POST', headers: { 'x-token': await B.page.evaluate(() => city.multiplayer.token) }, body: buf })
  ok(hack.status === 403, `B cannot post a ghost for a score that is not the top (${hack.status})`)
  // offline: no ticket, the best is kept locally and nothing is submitted
  off = await open({ ...o, port: srv.port, query: '?drivedebug&live=ws://127.0.0.1:1/live/ws' })
  await off.page.waitForFunction(() => city.progress, null, { timeout: 20000 }); await sleep(1500) // (it never connects)
  const r = await off.page.evaluate(() => { const P = city.progress, tk = P.run('dock'); return { live: tk.live, best: P.score('dock', 1800), again: P.score('dock', 1700) } })
  await sleep(600)
  ok(!r.live && r.best && !r.again && (await rows('dock'))[0].v === 900 && (await rows('dock')).length === 1, 'offline: ticketless, best kept locally, nothing submitted')
  if (o.shots) { // the Top tab at desktop (A, with its own rows), phone, the 360 px embed
    mkdirSync(o.shots, { recursive: true })
    const shot = async (c, name) => {
      await c.page.evaluate(() => document.querySelector('button[title^="Progress"]').click()); await c.page.click('[data-tab=top]'); await c.page.click('[data-board=d-dash]'); await sleep(900)
      await c.page.screenshot({ path: `${o.shots}/${name}.png` })
      await c.page.click('[data-span=all]').catch(() => {}); await sleep(300); await c.page.screenshot({ path: `${o.shots}/${name}-all.png` })
    }
    await shot(A, 'desktop')
    for (const [name, opt, q] of [['phone', { size: 'phone' }, L], ['embed', { size: '640x360' }, L + '&embed']]) {
      const c = await open({ ...o, ...opt, port: srv.port, query: q }); await c.page.waitForFunction(() => city.multiplayer?.connected, null, { timeout: 20000 })
      await shot(c, name); await c.browser.close()
    }
  }
  for (const c of [A, B, off]) { const e = c.errs.filter((m) => !/Failed to load resource|WebSocket connection/.test(m)); if (e.length) { bad++; console.log('FAIL page errors', e.slice(0, 3)) } }
} finally {
  for (const c of [A, B, off]) await c?.browser.close()
  live.kill(); srv.stop()
}
console.log(bad ? `${bad} FAILED` : 'boards_check: all ok'); process.exit(bad ? 1 : 0)
