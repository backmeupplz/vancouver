// node tools/firstrun_check.mjs [--size phone] [--embed 1] [--only van,walk] [--shots dir] [--tiles URL]: the first
// minute of a new visitor (#602). A fresh profile for each mode, the live server answering (a stand-in socket: a
// generated name, none chosen), then the mode starts: the van by the real buttons (Explore, Explore by van, a click on
// the map), the rest by the debug hooks shoot.mjs uses. Once the how-to card has gone: no panel or dialog is open (the
// username prompt came up over the game twice) and no two pieces of the HUD overlap; while fishing the photo walk's
// card is away. Run it at each size: (default desktop) | --size phone | --embed 1 (the 360 px X embed).
import { mkdirSync } from 'node:fs'
import { args, server, open, settle, live } from './pw.mjs'
const [o] = args(process.argv.slice(2), { size: '', embed: '', only: '', shots: '', tiles: '' })
o.size ||= o.embed ? '640x360' : '1400x900'
if (o.shots) mkdirSync(o.shots, { recursive: true })
const MODES = ['van', 'deliveries', 'bus', 'taxi', 'walk', 'hike', 'sail', 'fishing'].filter((m) => !o.only || o.only.split(',').includes(m))
const starts = {
  async van(page) { // the real way in
    await page.click('button[title^="Explore"]'); await page.click('[data-m="car"]')
    await page.waitForFunction(() => document.body.classList.contains('dlv-picking')); await page.waitForTimeout(300)
    const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]); await page.mouse.click(w / 2, h / 2)
  },
  deliveries: (page) => page.evaluate(() => { const p = city.world.fromLatLon(49.2838, -123.1185); driveDebug.start('deliver', p.x, -p.z) }),
  bus: (page) => page.evaluate(() => driveDebug.startBus('99')),
  taxi: (page) => page.evaluate(() => { const p = city.world.fromLatLon(49.2838, -123.1185); driveDebug.startTaxi(p.x, -p.z) }),
  walk: (page) => page.evaluate(() => { const p = city.world.fromLatLon(49.2745, -123.153); driveDebug.start('foot', p.x, -p.z) }),
  hike: (page) => page.evaluate(() => driveDebug.startHike('lynn')),
  sail: (page) => page.evaluate(() => { const p = city.world.fromLatLon(49.284, -123.19); sailDebug.start(p.x, p.z) }),
  async fishing(page) { // on Jericho Pier, a line in the water
    await page.evaluate(() => { const s = fishDebug.spots.find((q) => q.id === 'jericho'); driveDebug.start('foot', s.x, -s.z) })
    await page.waitForFunction(() => city.player && fishDebug.near, null, { timeout: 90000 })
    await page.evaluate(() => { fishDebug.begin(); fishDebug.press(true) })
  },
}
// what is on screen over the game: panels and dialogs; the HUD's boxes that overlap another
const look = () => {
  const seen = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && +s.opacity > 0.3 && r.width > 2 && r.height > 2 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight }
  const name = (e) => (e.id ? '#' + e.id : '.' + [...e.classList].join('.')) + (e.textContent.trim() ? ` "${e.textContent.trim().replace(/\s+/g, ' ').slice(0, 24)}"` : '')
  const open = [...document.querySelectorAll('.panel, [role=dialog], dialog[open], #start')].filter((e) => { const r = e.getBoundingClientRect(); return seen(e) && !e.matches('.fs, .fs-card') && r.width > 180 && r.height > 100 }).map(name) // (a button or a toast is a .panel too: a sheet is bigger; the fishing cards are its HUD)
  // a box: something positioned over the canvas that paints (a background, a border) and is not most of the screen
  const paints = (e) => { const s = getComputedStyle(e); return (!/rgba\(.*, 0\)|transparent/.test(s.backgroundColor) || s.backgroundImage !== 'none' || parseFloat(s.borderTopWidth) > 0) }
  const boxes = []
  const walk = (e, placed) => {
    if (e.tagName === 'CANVAS' || e.tagName === 'SCRIPT' || e.tagName === 'STYLE' || !seen(e)) { if (getComputedStyle(e).display === 'contents') for (const c of e.children) walk(c, placed); return }
    const s = getComputedStyle(e), r = e.getBoundingClientRect()
    placed ||= s.position === 'fixed' || s.position === 'absolute'
    if (placed && paints(e) && r.width * r.height < innerWidth * innerHeight * 0.5) return boxes.push({ e, r })
    for (const c of e.children) walk(c, placed)
  }
  walk(document.body, false)
  const over = []
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i].r, b = boxes[j].r, w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    if (w > 3 && h > 3) over.push(`${name(boxes[i].e)} × ${name(boxes[j].e)} (${Math.round(w)}×${Math.round(h)} px)`)
  }
  return { open, over, boxes: boxes.length, photoWalk: /photo walk/i.test(document.querySelector('.dlv-job:not([hidden])')?.textContent || ''), fishing: !!city.fishing?.active }
}
const srv = await server(o.port)
const { browser, page, errs } = await open({ ...o, port: srv.port, query: o.embed ? '?embed&drivedebug' : '?drivedebug', hash: '#13645,11243,0.1295', init: live })
let bad = 0
try {
  for (const m of MODES) {
    await page.evaluate(() => localStorage.clear()); await page.reload() // a fresh profile
    await page.waitForFunction(() => window.driveDebug && window.sailDebug && window.fishDebug && city.multiplayer?.connected && !document.querySelector('#loading'), null, { timeout: 240000 })
    await settle(page, 500)
    await starts[m](page)
    await page.waitForFunction(() => city.player, null, { timeout: 120000 })
    await page.waitForTimeout(7800) // (the prompt came 3 s after the dive; the keys strip fades at 7 s; the chip's check follows)
    await page.waitForFunction(() => { const h = document.querySelector('.dlv-how, .sl-how'); return !h || h.hidden || !h.checkVisibility() }, null, { timeout: 30000 }).catch(() => {})
    await page.evaluate(() => [...document.querySelectorAll('.sl-learn button')].find((b) => /Let.s sail/.test(b.textContent))?.click()) // (sailing's how-to stays until it is read)
    await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 }).catch(() => {}) // (a toast comes and goes over the cards on a phone: not the HUD)
    await page.evaluate(() => city.loading.track('check', 0, 1)) // the loading chip shown for the look: it must be clear of the HUD too
    await page.waitForTimeout(1300) // (the chip's spot is found every 400 ms)
    const r = await page.evaluate(look), fails = []
    await page.evaluate(() => city.loading.track('check', 1, 1))
    if (r.open.length) fails.push('open: ' + r.open.join(', '))
    if (r.over.length) fails.push('overlap: ' + r.over.join('; '))
    if (m === 'fishing' && (!r.fishing || r.photoWalk)) fails.push(r.fishing ? 'the photo walk card is up while fishing' : 'not fishing')
    if (o.shots) await page.screenshot({ path: `${o.shots}/${o.embed ? 'embed' : o.size}-${m}.png` })
    console.log(`${fails.length ? 'FAIL' : 'ok'} ${m} (${r.boxes} boxes)${fails.length ? ': ' + fails.join(' | ') : ''}`)
    bad += fails.length
  }
  const e = errs.filter((x) => !/404|Failed to load/.test(x))
  if (e.length) { bad++; console.log('page errors: ' + e.join(' | ').slice(0, 400)) }
} finally { await browser.close(); srv.stop() }
process.exit(bad ? 1 : 0)
