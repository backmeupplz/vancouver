// Deliveries: a four-minute shift for the Salmonberry Parcel Co. (the drive plugin's delivery mode). The order board
// holds up to three pickups at real shops around you, each with its own beam: take whichever suits (a rush order pays
// double on time and half late, fragile parcels pay half as much again if they arrive unrattled, rain and snow pay
// more). At the shop the courier fetches the parcels, then each goes to its door. Every parcel on time and in one
// piece adds to the streak, which multiplies the pay; a late or rattled one breaks it. When the clock runs out: the
// takings, a rank and the best shift (localStorage), and another go.
// index.js runs the van, the courier's errands and the goal marker, and calls in here.
// ctx: THREE, city, body() (the van or the courier), stopFor, address, placesNear, setGoal, hideMarkers, icons
// { pickup, drop }, popup, sfx, buzz, ui (the HUD's elements), busy() (an errand under way), exit(force), abbr, dist, mmss
import { clamp, esc } from '../../core/util.js'

export const SHIFT = 240 // seconds on the clock
const RANKS = [[230, 'S', 'Legend of the loading dock.'], [160, 'A', 'Lovely work: quick, smooth, happy doorsteps.'], [95, 'B', 'A good shift. The streak is where the money is.'], [40, 'C', 'Parcels got there. Try the rush orders next time.'], [0, 'D', 'The kettle’s on at the depot. Have another go.']]
export const rankOf = (cash) => RANKS.find((r) => cash >= r[0])
// what a parcel pays: the base for the distance and the tip, times the order's kind, the weather and the streak
export function payFor({ dist, left, limit, care, rush, fragile, wet = 1, streak = 0 }) {
  const onTime = left > 0, intact = care >= 0.85
  const tip = Math.max(0.5, (onTime ? 2.5 + 6 * (left / limit) : 1.2) * care)
  const kind = (rush ? (onTime ? 2 : 0.5) : 1) * (fragile ? (intact ? 1.5 : 0.4) : 1)
  const mult = Math.min(3, 1 + 0.25 * streak)
  const r2 = (v) => Math.round(v * 100) / 100
  return { pay: r2((6 + (dist / 1000) * 5 + tip) * kind * wet * mult), tip: r2(tip), onTime, intact, mult, clean: onTime && care >= 0.6 }
}
const FIRST = ['Mei', 'Arjun', 'Sofia', 'Daniel', 'Priya', 'Kenji', 'Amara', 'Liam', 'Noor', 'Jasmine', 'Tomás', 'Hana', 'Owen', 'Leilani', 'Ravi', 'Grace', 'Mateo', 'Yuki', 'Farah', 'Theo', 'Ines', 'Sam', 'Marguerite', 'Kai', 'Harpreet', 'Wei', 'Olivia', 'Jun', 'Aiyana', 'Connor', 'Fatima', 'Diego', 'Elodie', 'Min-jun', 'Rosa', 'Ezra']
const LAST = ['Chen', 'Sandhu', 'Nguyen', 'MacLeod', 'Wong', 'Gill', 'Tremblay', 'Kim', 'Singh', 'Lee', 'Fraser', 'Santos', 'Park', 'Dhillon', 'Campbell', 'Ito', 'Hassan', 'Martin', 'Leung', 'Grewal', 'Okafor', 'Novak', 'Reyes', 'Thompson', 'Lam', 'Jackson']
const PARCELS = ['a small parcel', 'a carefully taped box', 'a padded envelope', 'a parcel marked “fragile”', 'a flat-pack bookshelf', 'a box of vinyl records', 'a ceramic teapot (fragile!)',
  'a bag of coffee beans', 'a houseplant', 'a pair of rain boots', 'a board game', 'a stack of library holds', 'a bicycle wheel', 'a very long umbrella', 'a jar of local honey']
const THANKS = ['Thanks so much!', 'Oh, lovely. Thank you!', 'Right on time, you’re a star.', 'Perfect, have a cozy day!', 'Ah, I was hoping it’d come today!', 'Thank you, drive safe!', 'Wonderful, cheers!']
const ITEMS = {
  cafe: ['two oat lattes and a croissant', 'a box of pastries', 'a bag of fresh-roasted beans'], coffee: ['a bag of fresh-roasted beans'], bakery: ['a warm sourdough loaf', 'a birthday cake (level, please)', 'a dozen cinnamon buns'],
  restaurant: ['a hot dinner for two', 'a party platter'], fast_food: ['a bag of burgers, still warm', 'poutine for the office'], books: ['a stack of paperbacks', 'a signed first edition'],
  florist: ['a bouquet of dahlias', 'a potted monstera'], garden_centre: ['a potted monstera', 'a tray of seedlings'], bicycle: ['a bicycle wheel', 'a new saddle'], pharmacy: ['a prescription'], chemist: ['a prescription'],
  supermarket: ['a week of groceries', 'a watermelon'], convenience: ['snacks and a newspaper'], greengrocer: ['a crate of apples', 'a bag of lemons'], clothes: ['a raincoat', 'a wool sweater'], shoes: ['a pair of rain boots'],
  pet: ['a bag of cat food', 'a squeaky toy'], toys: ['a wooden train set'], music: ['a vinyl record'], hardware: ['a toolbox', 'a tin of paint'], doityourself: ['a tin of paint'],
}
const FRAGILE = /fragile|cake|teapot|level|vinyl|record|lemon|monstera|latte/
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const cap = (s) => s[0].toUpperCase() + s.slice(1)
const COL = { std: 0xffb05c, rush: 0xff5a4a, fragile: 0x7fd6ff }

export function deliveryGame(ctx) {
  const { THREE, city, ui } = ctx
  const S = { n: 0, money: 0, tips: 0, km: 0, bumps: 0, people: 0, kerbs: 0, shops: new Set(), best: null, streak: 0, top: 0, left: SHIFT, started: false, over: false, saved: false }
  let run = null, retry = 0, aimed = null
  const offers = [] // the board: { shop, parcels, rush, fragile, est, t0 (when posted), m (its beam) }
  // a beam for each order on the board that isn't the one the big marker stands on
  const beamG = new THREE.CylinderGeometry(1.3, 1.3, 70, 10, 1, true).translate(0, 35, 0)
  const beams = [0, 1, 2].map(() => { const m = new THREE.Mesh(beamG, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })); m.visible = false; return m })
  city.overlay.add(...beams)
  const wet = () => 1 + 0.3 * (city.surface?.wet || 0) + 0.6 * (city.surface?.snow || 0)
  const kindOf = (o) => (o.rush ? 'rush' : o.fragile ? 'fragile' : 'std')
  const tags = (o) => `${o.rush ? ' · RUSH ×2' : ''}${o.fragile ? ' · fragile ×1.5' : ''}`

  // an order for the board: a real shop near the van with one to three parcels, each for a door 200-900 m from it
  function post() {
    const P = ctx.body()
    for (const [r0, r1] of [[100, 700], [80, 1500]]) {
      const shops = ctx.placesNear(P.x, P.y, r0, r1)
      for (let k = 0; k < 8 && shops.length; k++) {
        const p = shops.splice(Math.floor(Math.random() * shops.length), 1)[0]
        if (offers.some((o) => Math.hypot(o.shop.sx - p.x, o.shop.sy - p.y) < 90)) continue
        const s = ctx.stopFor(p.x, p.y)
        if (!s) continue
        const want = 1 + (Math.random() < 0.5 ? 1 : 0) + (Math.random() < 0.25 ? 1 : 0), parcels = []
        for (let i = 0; i < want * 3 && parcels.length < want; i++) {
          const to = ctx.address(p.x, p.y, 200, 900)
          if (!to || parcels.some((q) => Math.hypot(q.to.x - to.x, q.to.y - to.y) < 40)) continue
          const who = `${pick(FIRST)} ${pick(LAST)}`, item = ITEMS[p.kind] && Math.random() < 0.75 ? pick(ITEMS[p.kind]) : pick(PARCELS)
          parcels.push({ to, item, who, aboard: false, done: false, bumps: 0, fragile: FRAGILE.test(item), dist: Math.hypot(to.x - s.x, to.y - s.y), t0: 0, limit: 0 })
        }
        if (!parcels.length) continue
        const rush = S.n > 0 && Math.random() < 0.34, fragile = parcels.some((q) => q.fragile) // (the first order is a plain one)
        const est = parcels.reduce((a, q) => a + (6 + (q.dist / 1000) * 5 + 4) * (rush ? 2 : 1) * (q.fragile ? 1.5 : 1), 0) * wet()
        const m = beams.find((b) => !offers.some((o) => o.m === b))
        offers.push({ shop: { ...s, label: p.name, sub: p.addr ? ctx.abbr(p.addr) : p.kind, kind: p.kind, sx: p.x, sy: p.y }, parcels, rush, fragile, est, t0: performance.now(), m })
        return true
      }
    }
    return false
  }
  // where to now: the nearest order on the board, the shop of the one taken, else the nearest door with a parcel for it
  function aim() {
    const P = ctx.body(), near = (a, b) => !b || Math.hypot(a.x - P.x, a.y - P.y) < Math.hypot(b.x - P.x, b.y - P.y)
    let t = null, col = COL.std, icon = ctx.icons.pickup
    if (!run) { let o = null; for (const q of offers) if (near(q.shop, o?.shop)) o = q; if (o) { t = o.shop; t.offer = o; col = COL[kindOf(o)] } }
    else if (run.stage === 'pickup') { run.cur = null; t = run.shop; col = COL[kindOf(run)] }
    else { let b = null; for (const p of run.parcels) if (!p.done && near(p.to, b?.to)) b = p; run.cur = b; t = b?.to; col = 0x5fd6c4; icon = ctx.icons.drop }
    if (t !== aimed) { aimed = t; if (t) ctx.setGoal(t.x, t.y, col, icon); else ctx.hideMarkers() }
    for (const b of beams) b.visible = false
    if (!run) for (const o of offers) if (o.shop !== t) { o.m.material.color.set(COL[kindOf(o)]); o.m.position.set(o.shop.x, city.world.heightAt(o.shop.x, -o.shop.y), -o.shop.y); o.m.visible = true }
    return t
  }
  const target = () => aimed
  // stopped at an order's shop: it is ours, the rest of the board waits
  function take() {
    if (run || !aimed?.offer) return
    const o = aimed.offer
    offers.splice(offers.indexOf(o), 1)
    run = { shop: o.shop, parcels: o.parcels, rush: o.rush, fragile: o.fragile, stage: 'pickup', cur: null }
    S.started = true
    aim()
  }
  function pickedUp() {
    const now = performance.now(), n = run.parcels.length
    run.parcels.sort((a, b) => a.dist - b.dist)
    run.parcels.forEach((p, i) => { p.aboard = true; p.t0 = now; p.limit = ((p.dist * 1.35 + 260 * i) / 7 + 70) * (run.rush ? 0.6 : 1) })
    run.stage = 'drop'
    S.shops.add(run.shop.label)
    ctx.sfx.pickup(); ctx.buzz(30)
    ctx.popup(run.rush ? 'Rush order!' : 'Picked up!', n === 1 ? `${cap(run.parcels[0].item)} for ${run.parcels[0].who}` : `${n} parcels from ${run.shop.label}: ${run.parcels.map((p) => p.who.split(' ')[0]).join(', ')}`)
    aim()
  }
  const careOf = (p) => Math.max(0.15, 1 - 0.16 * p.bumps * (p.fragile ? 1.6 : 1))
  function delivered(p) {
    const used = (performance.now() - p.t0) / 1000
    const r = payFor({ dist: p.dist, left: Math.max(0, p.limit - used), limit: p.limit, care: careOf(p), rush: run.rush, fragile: p.fragile, wet: wet(), streak: S.streak })
    p.done = true
    S.n++; S.money += r.pay; S.tips += r.tip
    S.streak = r.clean ? S.streak + 1 : 0; S.top = Math.max(S.top, S.streak)
    if (!S.best || r.pay > S.best.pay) S.best = { pay: r.pay, who: p.who }
    city.progress?.award('delivery', r.pay, { quiet: true })
    if (S.streak > 1) city.progress?.stat('delivery.streak', 1)
    ctx.sfx.deliver(); ctx.buzz([30, 70, 30, 70, 60])
    const word = !r.intact && p.fragile ? 'Oh no, it’s broken…' : careOf(p) < 0.6 ? 'It’s a bit rattled, but thanks!' : !r.onTime ? (run.rush ? 'I needed that ages ago.' : 'A little late, but thanks!') : pick(THANKS)
    ctx.popup(`+$${r.pay.toFixed(2)}${r.mult > 1 ? ` ×${r.mult}` : ''}`, `${p.who.split(' ')[0]}: ${word}${S.streak > 1 ? ` · streak ${S.streak}` : r.clean ? '' : ' · streak lost'}`)
    if (run.parcels.every((q) => q.done)) { run = null; retry = 0 }
    aim()
  }
  const rattle = (k) => { if (run) for (const p of run.parcels) if (p.aboard && !p.done) p.bumps += k }

  function results() {
    S.over = true
    const cash = Math.round(S.money * 100) / 100, r = rankOf(cash)
    let best = 0, all = { n: 0, money: 0 }
    try { best = +localStorage.getItem('delivery.best') || 0; all = JSON.parse(localStorage.getItem('delivery.totals') || '{"n":0,"money":0}') } catch {}
    const record = cash > best && S.n > 0, final = S.left <= 0
    const save = () => { // once, when the shift is really over (the clock, or leaving)
      if (S.saved) return
      S.saved = true
      all.n += S.n; all.money += S.money
      try { localStorage.setItem('delivery.totals', JSON.stringify(all)); if (record) localStorage.setItem('delivery.best', String(cash)) } catch {}
      if (S.n) city.progress?.score('delivery', Math.round(cash))
    }
    if (final) save()
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`
    ui.sheet.innerHTML = `<h3>Salmonberry Parcel Co. · ${final ? 'end of shift' : 'shift so far'}</h3>
      <div class="rank r${r[1]}">${r[1]}</div><div class="big">$${cash.toFixed(2)}</div>
      <dl>${row('Parcels delivered', S.n)}${row('Tips', `$${S.tips.toFixed(2)}`)}${row('Best streak', S.top > 1 ? `${S.top} in a row (×${Math.min(3, 1 + 0.25 * (S.top - 1))})` : 'none yet')}
      ${row('Knocks', S.bumps + S.kerbs ? `${S.bumps} bump${S.bumps === 1 ? '' : 's'}, ${S.kerbs} kerb${S.kerbs === 1 ? '' : 's'}` : 'none')}${S.people ? row('People startled', S.people) : ''}
      ${S.best ? row('Best drop', `$${S.best.pay.toFixed(2)} from ${esc(S.best.who.split(' ')[0])}`) : ''}${row(record ? 'New best shift!' : 'Best shift', `$${Math.max(best, cash).toFixed(2)}`)}${row('All time', `${all.n + (S.saved ? 0 : S.n)} parcels, $${(all.money + (S.saved ? 0 : S.money)).toFixed(2)}`)}</dl>
      <div class="line">${r[2]}</div><div class="row">${final ? '' : '<button data-k>Keep driving</button>'}<button data-end>Back to map</button><button class="main" data-again>Another shift</button></div>`
    ui.sheet.hidden = false
    const q = (s) => ui.sheet.querySelector(s)
    if (!final) q('[data-k]').onclick = () => { ui.sheet.hidden = true; S.over = false }
    q('[data-end]').onclick = () => { save(); ctx.exit(true) }
    q('[data-again]').onclick = () => { save(); ui.sheet.hidden = true; ctx.again() }
    q('[data-again]').focus()
  }

  return {
    S, get run() { return run }, target, take, pickedUp, delivered, results, aim,
    bump(impact) { if (!run) return; S.bumps++; rattle(impact > 6 ? 2 : 1) },
    kerb() { if (!run) return; S.kerbs++; rattle(0.5) },
    person() { S.people++; rattle(3) },
    frame(dt, now) {
      if (S.over) return aimed
      if (S.started && !ctx.busy()) S.left -= dt // the clock waits while the courier is at a door
      if (S.left <= 0 && !ctx.busy()) { S.left = 0; ctx.sfx.summit?.(); results(); return aimed }
      for (let i = offers.length - 1; i >= 0; i--) if (offers[i].rush && now - offers[i].t0 > 50000 && offers[i].shop !== aimed) offers.splice(i, 1) // a rush order nobody took goes to someone else
      if (!run && offers.length < 3 && now > retry) { retry = now + (post() ? 350 : 1200) }
      return aim()
    },
    hud(t, street) {
      const P = ctx.body()
      ui.n.textContent = String(S.n)
      ui.m.textContent = `$${S.money.toFixed(2)}`
      ui.c.innerHTML = `<b class="${S.left < 30 ? 'late' : ''}">${ctx.mmss(S.left)}</b>${S.streak > 0 ? ` <span class="late">×${Math.min(3, 1 + 0.25 * S.streak)}</span>` : ''}`
      if (!t) {
        ui.arrow.style.opacity = 0.3
        ui.w.textContent = 'Order board'; ui.s.textContent = street ? `on ${street}` : ''; ui.d.textContent = ''; ui.t.textContent = ''; ui.aboard.textContent = ''
        ui.p.textContent = 'Looking for orders…'
        return
      }
      ui.d.textContent = `${ctx.dist(Math.hypot(t.x - P.x, t.y - P.y))} away`
      ui.t.className = ''
      if (!run) {
        const o = t.offer, n = o.parcels.length, others = offers.filter((q) => q !== o)
        ui.w.textContent = `Order board · nearest of ${offers.length}`
        ui.p.textContent = t.label
        ui.s.textContent = `${n} parcel${n === 1 ? '' : 's'} · about $${Math.round(o.est)}${tags(o)}`
        ui.aboard.textContent = others.length ? `Or: ${others.map((q) => `${q.shop.label} ${ctx.dist(Math.hypot(q.shop.x - P.x, q.shop.y - P.y))} $${Math.round(q.est)}${q.rush ? ' rush' : q.fragile ? ' fragile' : ''}`).join(' · ')}` : ''
        ui.t.textContent = S.started ? 'stop at any beam' : 'the clock starts at your first pickup'
        return
      }
      const pickup = run.stage === 'pickup', n = run.parcels.length, left = run.parcels.filter((p) => !p.done)
      ui.w.textContent = pickup ? `Pick up ${n === 1 ? 'a parcel' : `${n} parcels`} at` : `Deliver ${run.cur.item}`
      ui.p.textContent = t.label
      ui.s.textContent = pickup ? t.sub || '' : `for ${run.cur.who}${run.rush ? ' · RUSH' : ''}${run.cur.fragile ? ` · fragile, ${Math.round(careOf(run.cur) * 100)}% intact` : ''}`
      ui.aboard.textContent = pickup ? `For ${run.parcels.map((p) => p.who.split(' ')[0]).join(', ')}` : left.length > 1 ? `Also aboard: ${left.filter((p) => p !== run.cur).map((p) => `${p.who.split(' ')[0]} (${p.to.label})`).join(', ')}` : 'Last one in the van'
      if (pickup) ui.t.textContent = ctx.busy() ? 'fetching…' : 'stop at the kerb'
      else {
        const rem = run.cur.limit - (performance.now() - run.cur.t0) / 1000
        ui.t.textContent = rem > 0 ? `${ctx.mmss(rem)} ${run.rush ? 'for double pay' : 'to keep the streak'}` : run.rush ? 'late: half pay' : 'late: streak at risk'
        ui.t.className = rem > 0 ? '' : 'late'
      }
    },
    dispose() { city.overlay.remove(...beams); beamG.dispose(); for (const b of beams) b.material.dispose() },
  }
}
