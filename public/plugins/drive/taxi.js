// Rush Fare: an arcade cab shift against the clock (the drive plugin's taxi mode). Pick a cab, a livery and a driver
// in the garage (a turntable), a spot on the map, then pick up the people waving at the kerbs (their ring's colour
// says how far they're going: blue short, amber medium, pink long), stop in the ring and race them to real Vancouver
// places (a big bouncing arrow points the way). A fare adds time to the clock; getting there quickly adds more.
// Stunts with someone aboard earn tips and fill the nitro: near misses with traffic, big air off crests and deck ends,
// handbrake drifts, nitro streaks, all multiplied by the combo. A film crew has left stunt ramps in the kerb lanes of
// the bigger streets around (Hollywood North): the cab rides up them (rampAt) and flies. The shift ends when the clock runs out: a rank and
// the best score (kept in localStorage). Sounds are synthesised. Places: OpenStreetMap (© OpenStreetMap contributors,
// ODbL) and the drive plugin's shops.
// The cab drives with van.js's arcade numbers (taxiSpec); index.js runs it and calls in here each frame.
import { CABS, DRIVERS, makeCab, makeDriver } from './cabs.js'
import { newVan, stepVan, taxiSpec } from './van.js'
import { makeWalker, poseWalker } from './walker.js'
import { kit, kitMaterial } from '../../core/kit.js'
import { clamp, wrap, esc } from '../../core/util.js'
import { noise } from '../../core/play.js'
import { speedLines } from './feel.js'

export const NAME = 'Rush Fare'
const START_TIME = 50 // s on the clock
// who gets in: most just want to get there; some change the ride (pay: times the fare; limit: times their patience;
// stunt: times the stunt tips; clean: times the fare again if nothing was hit on the way)
const RIDERS = [
  { p: 0.45 },
  { p: 0.2, name: 'Thrill-seeker', say: 'Make it wild!', stunt: 2 },
  { p: 0.18, name: 'Late for a flight', say: 'Step on it, I’m so late!', pay: 1.8, limit: 0.7 },
  { p: 0.17, name: 'Nervous rider', say: 'Gently, please… not a scratch.', clean: 1.7, stunt: 0.5 },
]
function rider() { let r = Math.random(); for (const k of RIDERS) if ((r -= k.p) < 0) return k; return RIDERS[0] }
const CLASS = [ // fare classes: ring colour, straight-line distance (m), seconds added on pickup
  { name: 'short', col: 0x4fc3ff, css: '#4fc3ff', r: [350, 1300], add: 9 },
  { name: 'medium', col: 0xffb43a, css: '#ffb43a', r: [1300, 2700], add: 14 },
  { name: 'long', col: 0xff4fa8, css: '#ff4fa8', r: [2700, 5500], add: 20 },
]
// real places to go (OpenStreetMap), [name, where, lat, lon]: the drop-off is the kerb of the street nearest
const DEST = [
  ['Granville Island', 'the Public Market', 49.2712, -123.134], ['Science World', 'False Creek', 49.2731, -123.1022],
  ['Stanley Park', 'the Pavilion', 49.2985, -123.1366], ['Canada Place', 'the cruise terminal', 49.2885, -123.1115],
  ['UBC', 'the bus loop', 49.2672, -123.2475], ['Commercial Drive', 'Grandview Park', 49.2738, -123.0695],
  ['Kits Beach', 'Cornwall Ave', 49.2733, -123.1545], ['Metrotown', 'Burnaby', 49.2268, -123.0028],
  ['Gastown', 'the steam clock', 49.2845, -123.1088], ['BC Place', 'Pacific Blvd', 49.2766, -123.1118],
  ['Waterfront Station', 'Cordova St', 49.2858, -123.1118], ['English Bay', 'Beach Ave', 49.2866, -123.1422],
  ['Olympic Village', 'Southeast False Creek', 49.2702, -123.1064], ['Queen Elizabeth Park', 'Cambie St', 49.2418, -123.1124],
  ['Chinatown', 'the Millennium Gate', 49.2803, -123.1036], ['Jericho Beach', 'Point Grey', 49.2722, -123.1955],
  ['Lonsdale Quay', 'North Vancouver', 49.31, -123.0823], ['Vancouver General', 'W 12th Ave', 49.2618, -123.1238],
  ['Main & Broadway', 'Mount Pleasant', 49.2629, -123.1005], ['City Hall', 'Cambie & 12th', 49.2609, -123.1137],
  ['Trout Lake', 'John Hendry Park', 49.2562, -123.0636], ['Davie Village', 'Davie St', 49.281, -123.133],
  ['Playland', 'Hastings Park', 49.2818, -123.042], ['YVR', 'the airport', 49.1945, -123.1786],
  ['Robson Square', 'Robson St', 49.2822, -123.121], ['Yaletown', 'the Roundhouse', 49.2737, -123.1218],
  ['Kerrisdale', 'W 41st Ave', 49.2341, -123.1555], ['Spanish Banks', 'NW Marine Dr', 49.2763, -123.2205],
  ['SFU', 'Burnaby Mountain', 49.2786, -122.9163], ['Deep Cove', 'North Vancouver', 49.3268, -122.9496],
  ['River Market', 'New Westminster', 49.2001, -122.9116], ['Park Royal', 'West Vancouver', 49.3262, -123.137],
  ['VanDusen Garden', 'Oak St', 49.2385, -123.131], ['Rogers Arena', 'Griffiths Way', 49.2779, -123.1084],
]
const HAIL = ['{d}, please, and quick!', 'Can you get me to {d}? I’m so late.', '{d}. The scenic route is not required.', 'To {d}! My ferry leaves in ten.',
  '{d}, please. My latte’s getting cold.', 'Oh thank goodness. {d}!', '{d}, as fast as this thing goes.', 'Is this the cab to {d}? Perfect!']
const THANKS = ['Fastest ride of my life!', 'My heart’s still back on Granville.', 'Five stars, no notes.', 'Never again. Here’s a tip!', 'Thanks! I think.', 'That was better than Playland!', 'I need to sit down. Thank you!']
const RANKS = [[260, 'Sea-to-Sky Superstar', 'S'], [160, 'Lions Gate Legend', 'A'], [90, 'Downtown Hustler', 'B'], [40, 'Night-Shift Regular', 'C'], [0, 'Learner’s Permit', 'D']]
const SHIRTS = [0xe8735a, 0x2f62b8, 0x5fb37a, 0xf2c94c, 0x9b6bd1, 0xd9483b, 0x3fb6b0, 0xf6ead2, 0x8a5a3c, 0xff8fb1]
const PANTS = [0x3b4a5e, 0x2b2e33, 0x5a4636, 0x6b7a8f, 0x1d1d1d]
const HAIRS = [0x1d1612, 0x4a3428, 0x8a5a2c, 0xd8c08a, 0xdedad2, 0x2b2420]
const SKINS = [0xf0c8a8, 0xe2b48c, 0xc28e64, 0x9a6a46, 0x6e4630]
const pick = (a) => a[Math.floor(Math.random() * a.length)]
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const money = (v) => `$${v.toFixed(2)}`
const dist = (d) => (d > 950 ? `${(d / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(d / 10) * 10)} m`)

// the cabs' numbers, and how quick each is from 0 to 80 km/h (worked out once, for the garage's bars)
export const specOf = (cab) => taxiSpec(cab.stats)
const to80 = (cab) => { const c = newVan(specOf(cab)), I = { up: true, down: false, steer: 0, hand: false }; let t = 0; while (c.speed < 22.2 && t < 20) { stepVan(c, 1 / 60, I, 1); t += 1 / 60 } return t }
const STATS = CABS.map((c) => ({ top: c.stats.vmax * 3.6, accel: to80(c), grip: c.stats.grip, mass: c.stats.mass, tank: c.stats.tank }))
const range = (k) => [Math.min(...STATS.map((s) => s[k])), Math.max(...STATS.map((s) => s[k]))]
const BARS = [['top', 'Top speed', (v) => `${Math.round(v)} km/h`], ['accel', 'Acceleration', (v) => `0–80 ${v.toFixed(1)} s`, true], ['grip', 'Grip', (v) => `${Math.round(v * 100)}`],
  ['mass', 'Weight', (v) => `${(v / 1000).toFixed(1)} t`], ['tank', 'Nitro', (v) => `${v.toFixed(1)} s`]].map(([k, label, fmt, low]) => ({ k, label, fmt, low, r: range(k) }))

function loadChoice() {
  let c = null
  try { c = JSON.parse(localStorage.getItem('taxi.choice') || 'null') } catch {}
  const cab = CABS.findIndex((x) => x.id === c?.cab), drv = DRIVERS.findIndex((x) => x.id === c?.driver)
  return { cab: cab < 0 ? 0 : cab, livery: clamp(c?.livery | 0, 0, 2), driver: drv < 0 ? 0 : drv }
}
function saveChoice(c) { try { localStorage.setItem('taxi.choice', JSON.stringify({ cab: CABS[c.cab].id, livery: c.livery, driver: DRIVERS[c.driver].id })) } catch {} }
function bestOf() { try { return JSON.parse(localStorage.getItem('taxi.best') || 'null') } catch { return null } }

export const CSS = `
  .tx-garage { position: fixed; inset: 0; z-index: 40; display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(300px, 1fr); color: #fdf6ea;
    font: 13px/1.4 system-ui, -apple-system, sans-serif; background: radial-gradient(ellipse at 35% 70%, #4a3a52 0%, #241c2c 55%, #120e16 100%); }
  .tx-garage[hidden] { display: none }
  .tx-garage button { font: inherit; color: inherit; cursor: pointer; background: rgba(255,255,255,.08); border: 1px solid rgba(255,236,214,.2); border-radius: 10px; }
  .tx-garage button:hover { background: rgba(255,255,255,.16) }
  .tx-stage { position: relative; min-height: 0; }
  .tx-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: pan-y; }
  .tx-logo { position: absolute; left: 20px; top: 16px; font: 800 28px/1 system-ui, sans-serif; letter-spacing: .02em; font-style: italic; color: #ffd23a; text-shadow: 3px 3px 0 #d9483b; }
  .tx-logo small { display: block; font: 600 11px system-ui; letter-spacing: .14em; text-transform: uppercase; color: #ffc9b5; text-shadow: none; font-style: normal; margin-top: 6px; }
  .tx-stage .nav { position: absolute; top: 50%; width: 48px; height: 64px; font-size: 26px; transform: translateY(-50%); }
  .tx-stage .prev { left: 14px } .tx-stage .next { right: 14px }
  .tx-dots { position: absolute; left: 0; right: 0; bottom: 16px; display: flex; justify-content: center; gap: 6px; }
  .tx-dots i { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,.25) } .tx-dots i.on { background: #ffd23a }
  .tx-side { overflow-y: auto; overscroll-behavior: contain; padding: 22px 22px 18px; background: rgba(20, 14, 22, .55); border-left: 1px solid rgba(255,236,214,.1); display: flex; flex-direction: column; gap: 12px; }
  .tx-side h2 { margin: 0; font-size: 24px; line-height: 1.1 } .tx-side .blurb { color: #e2d4c4; margin-top: -6px }
  .tx-side h4 { margin: 0 0 5px; font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: #ffc9b5 }
  .tx-liv { display: flex; gap: 8px; flex-wrap: wrap }
  .tx-liv button { display: flex; align-items: center; gap: 6px; padding: 5px 9px 5px 5px; min-height: 36px; }
  .tx-liv button.on { border-color: #ffd23a; background: rgba(255,210,58,.14) }
  .tx-liv i { width: 22px; height: 22px; border-radius: 6px; border: 2px solid rgba(255,255,255,.5) }
  .tx-bars { display: grid; grid-template-columns: auto 1fr auto; gap: 6px 10px; align-items: center; margin: 0; font-variant-numeric: tabular-nums; }
  .tx-bars dt { color: #d9cbbb } .tx-bars dd { margin: 0; text-align: right; color: #fdf6ea; font-size: 12px; white-space: nowrap }
  .tx-bars b { display: block; height: 8px; border-radius: 4px; background: rgba(255,255,255,.1); overflow: hidden }
  .tx-bars b i { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, #ffd23a, #ff8a2a); transition: width .25s }
  .tx-drv { display: grid; grid-template-columns: 40px 1fr 40px; gap: 8px; align-items: center; }
  .tx-drv button { height: 52px; font-size: 20px } .tx-drv b { font-size: 15px } .tx-drv small { display: block; color: #d9cbbb }
  .tx-drv q { display: block; color: #ffe1a8; font-style: italic; margin-top: 3px }
  .tx-best { color: #d9cbbb; font-variant-numeric: tabular-nums } .tx-best b { color: #ffd23a }
  .tx-go { display: flex; gap: 8px; margin-top: auto; padding: 8px 0 2px; position: sticky; bottom: 0; background: #1a141e; box-shadow: 0 -14px 12px -6px #1a141e; }
  .tx-go button { min-height: 48px; padding: 0 16px; border-radius: 14px; font-weight: 650 }
  .tx-go .start { flex: 1; background: linear-gradient(180deg, #ffd23a, #f5a623); color: #2a1a10; border-color: #ffe68a; font-size: 16px; }
  .tx-go .start:hover { background: linear-gradient(180deg, #ffe066, #ffb43a) }
  @media (max-width: 760px), (orientation: portrait) and (max-width: 1000px) {
    .tx-garage { grid-template-columns: 1fr; grid-template-rows: minmax(190px, 38vh) 1fr; }
    .tx-side { border-left: 0; border-top: 1px solid rgba(255,236,214,.1); padding: 14px 16px calc(14px + env(safe-area-inset-bottom)); gap: 10px }
    .tx-logo { left: 14px; top: calc(10px + env(safe-area-inset-top)); font-size: 22px }
    .tx-side h2 { font-size: 20px }
  }
  @media (orientation: landscape) and (max-height: 500px) {
    .tx-garage { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
    .tx-side { padding: 10px 14px; gap: 8px; border-top: 0; border-left: 1px solid rgba(255,236,214,.1) } .tx-side .blurb { display: none }
    .tx-logo { font-size: 20px; left: max(14px, env(safe-area-inset-left)) }
    .tx-stage .prev { left: max(10px, env(safe-area-inset-left)) }
  }
  /* the shift */
  .tx-clock { left: 12px; top: 12px; padding: 8px 14px 10px; min-width: 150px; box-sizing: border-box; }
  .tx-clock .t { font: 800 34px/1 system-ui, sans-serif; font-variant-numeric: tabular-nums; letter-spacing: .01em; color: #fff3c4; }
  .tx-clock .t.low { color: #ff6a5a; animation: tx-blink .5s steps(2) infinite }
  .tx-clock .m { font: 700 17px system-ui; color: #9fe8b0; font-variant-numeric: tabular-nums; margin-top: 3px }
  .tx-nos { height: 9px; border-radius: 5px; background: rgba(255,255,255,.12); margin-top: 7px; overflow: hidden; position: relative }
  .tx-nos i { position: absolute; inset: 0 auto 0 0; border-radius: 5px; background: linear-gradient(90deg, #37a0ff, #a46bff, #ff4fa8); }
  .tx-nos.on i { box-shadow: 0 0 10px #a46bff; filter: brightness(1.35) }
  .tx-nosl { font: 650 10px system-ui; letter-spacing: .12em; color: #c8b8ff; margin-top: 3px; text-transform: uppercase }
  .tx-combo { font: 800 15px system-ui; color: #ffd23a; margin-top: 4px; font-variant-numeric: tabular-nums } .tx-combo:empty { display: none }
  .tx-fare { left: 50%; top: 12px; transform: translateX(-50%); padding: 8px 16px 9px; text-align: center; width: max-content; max-width: min(440px, calc(100vw - 360px)); box-sizing: border-box; }
  .tx-fare .k { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; font-weight: 700; color: #ffc9b5; white-space: nowrap }
  .tx-fare .d { font: 750 19px/1.2 system-ui; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .tx-fare .s { color: #e2d4c4; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .tx-fare .bar { height: 5px; border-radius: 3px; background: rgba(255,255,255,.12); margin-top: 6px; overflow: hidden } .tx-fare .bar i { display: block; height: 100%; background: #8fd9b0; border-radius: 3px }
  .tx-fare .bar.late i { background: #ff6a5a }
  .tx-fare .s i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; vertical-align: -1px }
  .tx-feed { left: 50%; top: 31%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .tx-feed div { font: 800 20px system-ui, sans-serif; font-style: italic; color: #fff; text-shadow: 0 2px 0 rgba(0,0,0,.45), 0 0 14px rgba(255,140,40,.6); opacity: 0; white-space: nowrap; }
  .tx-feed div small { font-size: 14px; color: #ffd23a; margin-left: 6px }
  .tx-feed div.go { animation: tx-pop 1.6s ease-out forwards }
  .tx-big { left: 50%; top: 42%; transform: translate(-50%, -50%); font: 900 88px/1 system-ui, sans-serif; font-style: italic; color: #ffd23a; text-shadow: 5px 5px 0 #d9483b, 0 0 30px rgba(0,0,0,.35); white-space: nowrap; }
  .tx-big.go { animation: tx-zoom .9s ease-out forwards }
  .tx-big small { display: block; font-size: 20px; text-shadow: 2px 2px 0 #d9483b; text-align: center; margin-top: 6px }
  .tx-say { left: 50%; bottom: 116px; transform: translateX(-50%); padding: 7px 14px; max-width: min(460px, calc(100vw - 40px)); box-sizing: border-box; text-align: center; transition: opacity .4s; }
  .tx-say b { color: #ffd23a }
  .tx-res .rank { font: 900 54px/1 system-ui; font-style: italic; color: #ffd23a; text-shadow: 3px 3px 0 #d9483b; margin: 6px 0 0 }
  .tx-res .title { font-weight: 700; color: #ffe1a8; margin-bottom: 2px } .tx-res .new { color: #8fd9b0; font-weight: 700 }
  .dlv-sheet .row button.tx-again { background: linear-gradient(180deg, #ffd23a, #f5a623); color: #2a1a10; border-color: #ffe68a; font-weight: 700 }
  @keyframes tx-pop { 0% { opacity: 0; transform: translateY(14px) scale(.7) } 12% { opacity: 1; transform: translateY(0) scale(1.12) } 22% { transform: scale(1) } 75% { opacity: 1 } 100% { opacity: 0; transform: translateY(-18px) } }
  @keyframes tx-zoom { 0% { opacity: 0; transform: translate(-50%, -50%) scale(2.2) } 25% { opacity: 1; transform: translate(-50%, -50%) scale(1) } 75% { opacity: 1 } 100% { opacity: 0; transform: translate(-50%, -50%) scale(.9) } }
  @keyframes tx-blink { 50% { opacity: .45 } }
  .dlv-touch .nos { display: none; width: 72px; height: 72px; left: 22px; bottom: 164px; font-size: 13px; font-weight: 800; background: rgba(90, 50, 160, .55); border-color: rgba(200,170,255,.55); }
  .dlv-touch .nos.on { background: rgba(164, 107, 255, .9) }
  body.dlv-taxi .dlv-touch .nos { display: block } body.dlv-taxi .dlv-touch .hrn { display: none }
  body.dlv-taxi .dlv-help { bottom: 16px }
  @media (max-width: 1000px) { .tx-fare { top: 12px; left: auto; right: 12px; transform: none; max-width: calc(100vw - 210px) } }
  .compact .tx-clock { left: var(--sl); top: var(--st); padding: 5px 11px 7px; min-width: 112px }
  .compact .tx-clock .t { font-size: 26px } .compact .tx-clock .m { font-size: 14px; margin-top: 1px } .compact .tx-nosl { display: none } .compact .tx-nos { margin-top: 5px }
  .compact .tx-fare { top: calc(var(--st) + 52px); left: calc(var(--sl) + 124px); right: var(--sr); transform: none; width: auto; max-width: none; padding: 6px 10px 7px; text-align: left; }
  .compact .tx-fare .d { font-size: 15px } .compact .tx-fare .s { font-size: 12px }
  .compact .tx-big { font-size: 64px }
  .compact .tx-feed div { font-size: 16px }
  .compact .tx-say { bottom: calc(max(16px, env(safe-area-inset-bottom)) + 240px); font-size: 12.5px }
  .compact .dlv-touch .nos { left: calc(var(--sl) + 6px); bottom: calc(var(--pb) + 86px); width: 66px; height: 66px; }
  @media (orientation: portrait) { .compact .tx-fare { left: var(--sl); right: var(--sr); top: calc(var(--st) + 112px) } .compact .tx-feed { top: 40% } }
  @media (orientation: landscape) { .compact .tx-fare { top: var(--st); left: calc(var(--sl) + 124px); right: calc(var(--sr) + 176px); }
    .compact .tx-say { bottom: max(16px, env(safe-area-inset-bottom)); max-width: 40% } .compact .dlv-touch .nos { bottom: calc(var(--pb) + 84px); width: 60px; height: 60px } .compact .tx-big { font-size: 52px } }`

// ================================================================ the garage
// opens over the page: a turntable with the cab and its driver, the cab's numbers, liveries and drivers; onStart(choice)
// when the shift starts, onBack() to close
export function openGarage(THREE, onStart, onBack) {
  const ch = loadChoice()
  const root = document.createElement('div'); root.className = 'tx-garage'
  root.innerHTML = `<div class="tx-stage"><canvas></canvas><div class="tx-logo">${NAME}<small>The garage · pick your cab</small></div>
      <button class="nav prev" aria-label="Previous cab">‹</button><button class="nav next" aria-label="Next cab">›</button><div class="tx-dots">${CABS.map(() => '<i></i>').join('')}</div></div>
    <div class="tx-side"><div><h2 data-n></h2></div><div class="blurb" data-b></div>
      <div><h4>Livery</h4><div class="tx-liv" data-l></div></div>
      <dl class="tx-bars" data-s></dl>
      <div><h4>Driver</h4><div class="tx-drv"><button data-dp aria-label="Previous driver">‹</button><div data-d></div><button data-dn aria-label="Next driver">›</button></div></div>
      <div class="tx-best" data-best></div>
      <div class="tx-go"><button data-back>‹ Back</button><button class="start" data-go>Start shift ›</button></div></div>`
  document.body.append(root)
  const q = (s) => root.querySelector(s), canvas = q('canvas')
  let renderer = null
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }) } catch (e) { console.warn('taxi: garage renderer', e) }
  renderer?.setPixelRatio(Math.min(2, devicePixelRatio || 1))
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(30, 1, 0.5, 100)
  scene.add(new THREE.HemisphereLight(0xfff1dc, 0x3a3244, 2.2))
  const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(5, 9, 6); scene.add(sun)
  const back = new THREE.DirectionalLight(0xa0b8ff, 1.2); back.position.set(-6, 4, -8); scene.add(back)
  const table = new THREE.Group(); scene.add(table)
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.03, 0.24, 48), new THREE.MeshLambertMaterial({ color: 0x2e2834 })); disc.position.y = -0.12; table.add(disc)
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 6, 64).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffd23a })); rim.position.y = 0.01; table.add(rim)
  let R = 4
  function frameCam() { // the whole disc in view, 18° down onto it, whatever the stage's shape
    const t = Math.tan((cam.fov * Math.PI) / 360), d = Math.max(R / (0.86 * t * cam.aspect), (R * 0.31 + 1.4) / (0.8 * t)), e = 0.32
    cam.position.set(0, Math.sin(e) * d + 0.6, Math.cos(e) * d); cam.lookAt(0, 0.6, 0)
  }
  let model = null, driver = null, spin = 0.6, drag = null, raf = 0, t0 = performance.now()
  const dispose3d = (o) => o?.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); for (const mt of [].concat(m.material)) mt.dispose() } })
  function build() {
    if (model) { table.remove(model); dispose3d(model) }
    if (driver) { table.remove(driver); dispose3d(driver) }
    const cab = CABS[ch.cab]
    model = makeCab(THREE, cab, ch.livery); table.add(model)
    driver = makeDriver(THREE, DRIVERS[ch.driver]); driver.position.set(cab.stats.hw + 1.0, 0, -cab.stats.hl * 0.35); driver.rotation.y = 0.5; table.add(driver)
    R = cab.stats.hl + 1.4; disc.scale.set(R, 1, R); rim.scale.set(R, R, R); frameCam()
  }
  function ui() {
    const cab = CABS[ch.cab], d = DRIVERS[ch.driver], S = STATS[ch.cab]
    q('[data-n]').textContent = cab.name; q('[data-b]').textContent = cab.blurb
    q('[data-l]').innerHTML = cab.liveries.map(([n, b, a], i) => `<button data-i="${i}" class="${i === ch.livery ? 'on' : ''}"><i style="background:linear-gradient(135deg,#${b.toString(16).padStart(6, '0')} 60%,#${a.toString(16).padStart(6, '0')} 60%)"></i>${esc(n)}</button>`).join('')
    for (const b of root.querySelectorAll('[data-l] button')) b.onclick = () => { ch.livery = +b.dataset.i; build(); ui() }
    q('[data-s]').innerHTML = BARS.map((B) => { const v = S[B.k], f = (v - B.r[0]) / (B.r[1] - B.r[0] || 1), w = 22 + 78 * (B.low ? 1 - f : f); return `<dt>${B.label}</dt><dd><b><i style="width:${w.toFixed(0)}%"></i></b></dd><dd>${B.fmt(v)}</dd>` }).join('')
    q('[data-d]').innerHTML = `<b>${esc(d.name)}</b><small>${esc(d.bio)}</small><q>${esc(d.line)}</q>`
    root.querySelectorAll('.tx-dots i').forEach((e, i) => e.classList.toggle('on', i === ch.cab))
    const go = q('[data-go]'), ok = window.city?.progress?.unlocked(`cab:${ch.cab}`) ?? true // (levels: the progress plugin)
    go.disabled = !ok; go.textContent = ok ? 'Start shift ›' : 'Locked: 🍁 Progress → Garage'
    const best = bestOf()
    q('[data-best]').innerHTML = best ? `Best shift: <b>${money(best.score)}</b> · ${esc(best.rank || '')} · ${esc(best.cab || '')}` : 'No shifts yet: the city is waiting.'
  }
  const setCab = (k) => { ch.cab = (ch.cab + k + CABS.length) % CABS.length; ch.livery = 0; build(); ui() }
  q('.prev').onclick = () => setCab(-1); q('.next').onclick = () => setCab(1)
  q('[data-dp]').onclick = () => { ch.driver = (ch.driver + DRIVERS.length - 1) % DRIVERS.length; build(); ui() }
  q('[data-dn]').onclick = () => { ch.driver = (ch.driver + 1) % DRIVERS.length; build(); ui() }
  q('[data-back]').onclick = () => { close(); onBack?.() }
  q('[data-go]').onclick = () => { saveChoice(ch); close(); onStart({ ...ch }) }
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, r: table.rotation.y }; try { canvas.setPointerCapture(e.pointerId) } catch {} })
  canvas.addEventListener('pointermove', (e) => { if (drag) table.rotation.y = drag.r + (e.clientX - drag.x) * 0.012 })
  const up = () => { drag = null }
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up)
  const onKey = (e) => { if (e.code === 'Escape') { e.stopPropagation(); close(); onBack?.() } else if (e.code === 'ArrowLeft') setCab(-1); else if (e.code === 'ArrowRight') setCab(1); else if (e.code === 'Enter') q('[data-go]').click() }
  addEventListener('keydown', onKey, true)
  function loop(now) {
    raf = requestAnimationFrame(loop)
    if (!renderer) return
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (!w || !h) return
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) { renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); frameCam() }
    const dt = Math.min(0.05, (now - t0) / 1000); t0 = now
    if (!drag) table.rotation.y += spin * dt
    if (driver) { // waving
      const { arms, body } = driver.userData, t = now / 1000
      arms[1].rotation.x = 2.75; arms[1].rotation.z = -0.25 + Math.sin(t * 7) * 0.35; arms[0].rotation.x = Math.sin(t * 1.3) * 0.08
      body.position.y = Math.abs(Math.sin(t * 3.5)) * 0.03
    }
    renderer.render(scene, cam)
  }
  function close() {
    cancelAnimationFrame(raf)
    removeEventListener('keydown', onKey, true)
    dispose3d(model); dispose3d(driver); disc.geometry.dispose(); disc.material.dispose(); rim.geometry.dispose(); rim.material.dispose()
    renderer?.dispose(); renderer?.forceContextLoss()
    root.remove()
  }
  build(); ui()
  raf = requestAnimationFrame(loop)
  return { close, root, choice: ch }
}

// ================================================================ effects: flames, sparks, speed lines, the arrow
function effects(THREE, city, cab) {
  const low = city.quality?.tier.name === 'low'
  // nitro flames out of each exhaust: two additive cones (a hot core in a coloured flame), pointing back (+z)
  const flames = new THREE.Group(); flames.matrixAutoUpdate = false
  const coneG = new THREE.ConeGeometry(0.17, 1, 8, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2) // base at the pipe, the tip 1 m back (+z)
  const outer = new THREE.MeshBasicMaterial({ color: cab.userData.flame, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide, forceSinglePass: true })
  const inner = new THREE.MeshBasicMaterial({ color: 0xfff4d0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide, forceSinglePass: true })
  const cones = []
  for (const [x, y, z] of cab.userData.exhausts) {
    const o = new THREE.Mesh(coneG, outer), i = new THREE.Mesh(coneG, inner)
    o.position.set(x, y, z); i.position.set(x, y, z)
    flames.add(o, i); cones.push(o, i)
  }
  // embers: points thrown back from the pipes while boosting (fewer on Low)
  const N = low ? 18 : 64, pos = new Float32Array(N * 3), vel = new Float32Array(N * 3), life = new Float32Array(N)
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); pg.setDrawRange(0, N)
  const dot = document.createElement('canvas'); dot.width = dot.height = 32
  { const g = dot.getContext('2d'), gr = g.createRadialGradient(16, 16, 1, 16, 16, 15); gr.addColorStop(0, '#fff'); gr.addColorStop(0.35, 'rgba(255,255,255,.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 32, 32) }
  const dotTex = new THREE.CanvasTexture(dot)
  const sparks = new THREE.Points(pg, new THREE.PointsMaterial({ color: cab.userData.flame, map: dotTex, size: 0.35, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
  sparks.frustumCulled = false
  for (let i = 0; i < N; i++) pos[i * 3 + 1] = -1e5
  let next = 0
  const sl = speedLines(THREE, low), lines = sl.lines, lineMat = sl.lineMat // speed lines round the view (feel.js)
  // the arrow: a fat chevron floating over the cab, pointing at where to go
  const k = kit(THREE), A = [-0.9, -0.32, 0.25, -0.32, 0.25, -0.78, 1.25, 0, 0.25, 0.78, 0.25, 0.32, -0.9, 0.32]
  k.c(0xffffff).prism(A, -0.2, 0.2, { bevel: 0.06, edge: () => k.c(0x8a8a8a) })
  const ag = k.geometry(true).rotateX(-Math.PI / 2)
  const arrowMat = new THREE.MeshBasicMaterial({ vertexColors: true, color: 0x8fff9a, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, fog: false })
  const arrow = new THREE.Mesh(ag, arrowMat); arrow.renderOrder = 11; arrow.scale.setScalar(1.6)
  const parts = [flames, sparks, lines, arrow]
  city.overlay.add(...parts)
  return {
    flames, arrow, arrowMat, lines, lineMat,
    // boost 0..1, the cab's world matrix (cab.matrixWorld), its velocity (x, z) for the embers
    update(dt, t, boost, vx, vz, pcam) {
      cab.updateMatrixWorld()
      flames.matrix.copy(cab.matrixWorld); flames.matrixWorldNeedsUpdate = true
      flames.visible = boost > 0.02
      if (flames.visible) {
        for (let i = 0; i < cones.length; i++) {
          const f = 0.75 + 0.25 * Math.sin(t * 47 + i * 1.7) + 0.15 * Math.sin(t * 91 + i), L = boost * (i % 2 ? 0.9 : 1.6) * f
          cones[i].scale.set(boost * (i % 2 ? 0.7 : 1.1), boost * (i % 2 ? 0.7 : 1.1), L)
        }
        // throw embers
        const ex = cab.userData.exhausts, e = cab.matrixWorld.elements
        for (let n = 0; n < (low ? 1 : 3); n++) {
          const P = ex[(next + n) % ex.length], x = P[0], y = P[1], z = P[2], j = next * 3
          pos[j] = e[0] * x + e[4] * y + e[8] * (z + 0.3) + e[12]; pos[j + 1] = e[1] * x + e[5] * y + e[9] * (z + 0.3) + e[13]; pos[j + 2] = e[2] * x + e[6] * y + e[10] * (z + 0.3) + e[14]
          vel[j] = vx * 0.6 + e[8] * 6 + (Math.random() - 0.5) * 2; vel[j + 1] = 0.6 + Math.random() * 1.6; vel[j + 2] = vz * 0.6 + e[10] * 6 + (Math.random() - 0.5) * 2
          life[next] = 0.35 + Math.random() * 0.3
          next = (next + 1) % N
        }
      }
      for (let i = 0; i < N; i++) {
        if (life[i] <= 0) continue
        life[i] -= dt
        const j = i * 3
        if (life[i] <= 0) { pos[j + 1] = -1e5; continue }
        vel[j + 1] -= 6 * dt
        pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt
      }
      pg.attributes.position.needsUpdate = true
      // speed lines in front of the camera, stronger the harder the boost
      lines.position.copy(pcam.position); lines.quaternion.copy(pcam.quaternion)
      lineMat.uniforms.uT.value = t; lineMat.uniforms.uA.value = boost * 0.8
      lines.visible = boost > 0.02
    },
    dispose() {
      city.overlay.remove(...parts)
      coneG.dispose(); outer.dispose(); inner.dispose(); pg.dispose(); sparks.material.dispose(); dotTex.dispose(); sl.dispose(); ag.dispose(); arrowMat.dispose()
    },
  }
}

// ================================================================ the shift
// ctx (index.js): THREE, city, car, cab (the model), pcam, el, audio(), out(), tone, bell, sfx, buzz, setGoal,
// hideMarkers, icon, segsNear, stopFor, insideBuilding, isWater, others, placesNear, reset(), exit(force), toGarage(),
// sheet (the summary card), shake(v), touchy
export function taxiGame(ctx, choice) {
  const { THREE, city, car } = ctx
  const cabDef = CABS[choice.cab], drv = DRIVERS[choice.driver]
  const fx = effects(THREE, city, ctx.cab)
  const low = city.quality?.tier.name === 'low'
  // the people waving for a cab: walkers from the kit, a ring at the kerb in their fare's colour, a gem over them
  const FOLK = low ? 4 : 6, folk = []
  const ringG = new THREE.RingGeometry(3.4, 4.3, 40).rotateX(-Math.PI / 2), gemG = new THREE.OctahedronGeometry(0.38)
  for (let i = 0; i < FOLK; i++) {
    const w = makeWalker(THREE, pick(SHIRTS), { pants: pick(PANTS), hair: pick(HAIRS), skin: pick(SKINS), courier: false })
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const ring = new THREE.Mesh(ringG, mat), gem = new THREE.Mesh(gemG, new THREE.MeshBasicMaterial({ fog: false }))
    w.visible = ring.visible = gem.visible = false
    city.scene.add(w); city.overlay.add(ring, gem)
    folk.push({ w, ring, gem, mode: 'off', x: 0, y: 0, rx: 0, ry: 0, yaw: 0, cls: null, dest: null, t: 0, phase: Math.random() * 6 })
  }
  // stunt ramps: a plywood wedge with yellow and black chevrons, in the kerb lane of a street with more than one lane
  // each way (traffic changes lanes round it: each is an obstacle for city.traffic)
  const RAMPS = low ? 3 : 5, RL = 7, RW = 3.2, RH = 1.4, ramps = []
  const rk = kit(THREE)
  rk.c(0xc9955c).prism([0, 0, RL, 0, RL, RH, RL - 0.25, RH], -RW / 2, RW / 2, { edge: (i, nx, ny) => { if (ny > 0.2) rk.c(0xf5c400); else if (nx > 0.5) rk.c(0x6b4a2c) } })
  for (let i = 0; i < 5; i++) { const a = 0.8 + i * 1.25, b = a + 0.6, ya = (a / RL) * RH, yb = (b / RL) * RH; rk.c(0x1d1d1d).prism([a, ya, b, yb, b, yb + 0.035, a, ya + 0.035], -RW / 2 + 0.12, RW / 2 - 0.12) } // hazard stripes on the slope
  const rampG = rk.geometry(true), rampM = kitMaterial(THREE, { value: 0 })
  for (let i = 0; i < RAMPS; i++) { const m = new THREE.Mesh(rampG, rampM); m.visible = false; m.receiveShadow = true; city.scene.add(m); ramps.push({ m, on: false, x: 0, y: 0, ux: 1, uy: 0, id: `taxi-ramp-${i}` }) }
  function placeRamp(r) {
    SEGS.length = 0
    ctx.segsNear(car.x, car.y, 480, (s) => {
      const p = s.p, each = p.oneway ? p.lanes : p.lanes / 2
      if (!s.drv || s.z0 != null || p.kind < 2 || p.kind > 5 || each < 2 || p.tunnel) return
      const L = Math.hypot(s.x1 - s.x0, s.y1 - s.y0), mx = (s.x0 + s.x1) / 2 - car.x, my = (s.y0 + s.y1) / 2 - car.y, d = Math.hypot(mx, my)
      if (L > 45 && d > 120 && d < 480) SEGS.push(s)
    })
    for (let k = 0; k < 6 && SEGS.length; k++) {
      const s = SEGS[Math.floor(Math.random() * SEGS.length)], p = s.p, L = Math.hypot(s.x1 - s.x0, s.y1 - s.y0)
      let ux = (s.x1 - s.x0) / L, uy = (s.y1 - s.y0) / L
      if (!p.oneway && Math.random() < 0.5) { ux = -ux; uy = -uy }
      const lane = p.w / (p.oneway ? p.lanes : p.lanes), off = p.oneway ? p.w / 2 - lane * 0.5 : p.w / 2 - lane * 0.5 // the kerb lane, on the right
      const u = 0.35 + Math.random() * 0.3, cx = s.x0 + (s.x1 - s.x0) * u + uy * off, cy = s.y0 + (s.y1 - s.y0) * u - ux * off
      if (ramps.some((o) => o !== r && o.on && Math.hypot(o.x - cx, o.y - cy) < 150) || ctx.isWater(cx, cy)) continue
      Object.assign(r, { on: true, x: cx, y: cy, ux, uy })
      const h0 = city.world.heightAt(cx - ux * RL / 2, -(cy - uy * RL / 2)), h1 = city.world.heightAt(cx + ux * RL / 2, -(cy + uy * RL / 2))
      r.m.position.set(cx - ux * RL / 2, h0 + 0.2, -(cy - uy * RL / 2)); r.m.rotation.set(0, Math.atan2(uy, ux), Math.atan2(h1 - h0, RL), 'YZX'); r.m.visible = true
      const heading = wrap(Math.atan2(uy, ux) - Math.PI / 2 + Math.PI)
      try { city.traffic?.setObstacle?.(r.id, { x: cx, z: -cy, heading, length: RL + 2, width: RW, speed: 0, y: h0 }) } catch {}
      return
    }
  }
  function dropRamp(r) { r.on = false; r.m.visible = false; try { city.traffic?.setObstacle?.(r.id, null) } catch {} }
  let rampAt0 = 0
  const S = {} // the shift's numbers (reset by restart())
  const UP = new THREE.Vector3(0, 1, 0), AX = new THREE.Vector3(), TILT = new THREE.Quaternion()
  let fare = null, state = 'count', countT = 0, spawnAt = 0, hudAt = 0, refineAt = 0, sayT = 0, endT = 0
  let nitro = 0.6, boosting = false, boostAmt = 0, streakT = 0, streakDone = false, driftT = 0, driftOff = 0, comboN = 0, comboT = 0, stuckT = 0
  const nearSeen = new Map() // car id -> when last counted (a near miss, or a hit)
  const tank = cabDef.stats.tank

  // ---------------------------------------------------------------- HUD
  const clockEl = ctx.el('dlv tx-clock card', '<div class="t" data-t>0:50</div><div class="m" data-m>$0.00</div><div class="tx-nos" data-n><i></i></div><div class="tx-nosl">Nitro · Shift</div><div class="tx-combo" data-c></div>')
  const fareEl = ctx.el('dlv tx-fare card', '<div class="k" data-k></div><div class="d" data-d></div><div class="s" data-s></div><div class="bar" data-b><i></i></div>')
  const feed = ctx.el('dlv tx-feed', '<div></div><div></div><div></div><div></div>')
  const big = ctx.el('dlv tx-big', '')
  const say = ctx.el('dlv tx-say card', '')
  const els = [clockEl, fareEl, feed, big, say]
  const q = (e, s) => e.querySelector(s)
  const H = { t: q(clockEl, '[data-t]'), m: q(clockEl, '[data-m]'), n: q(clockEl, '[data-n]'), ni: q(clockEl, '[data-n] i'), c: q(clockEl, '[data-c]'), k: q(fareEl, '[data-k]'), d: q(fareEl, '[data-d]'), s: q(fareEl, '[data-s]'), b: q(fareEl, '[data-b]'), bi: q(fareEl, '[data-b] i') }
  if (ctx.touchy) q(clockEl, '.tx-nosl').textContent = 'Nitro'
  document.body.classList.add('dlv-taxi')
  let feedI = 0
  function shout(text, sub = '') { // a line in the stunt feed (four lines, reused round)
    const d = feed.children[feedI++ % 4]
    d.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`
    d.classList.remove('go'); void d.offsetWidth; d.classList.add('go')
    feed.hidden = false
  }
  function banner(text, sub = '') { big.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`; big.hidden = false; big.classList.remove('go'); void big.offsetWidth; big.classList.add('go') }
  function speak(html, ms = 3500) { say.innerHTML = html; say.hidden = false; sayT = performance.now() + ms }

  // ---------------------------------------------------------------- sound
  let roar = null
  function whoosh() {
    const ac = ctx.audio(), out = ctx.out()
    if (!ac || !out) return
    const t = ac.currentTime, src = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain()
    src.buffer = noiseBuf(ac); bp.type = 'bandpass'; bp.Q.value = 1.4
    bp.frequency.setValueAtTime(260, t); bp.frequency.exponentialRampToValueAtTime(2600, t + 0.45); bp.frequency.exponentialRampToValueAtTime(900, t + 1.1)
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.22, t + 0.08); g.gain.exponentialRampToValueAtTime(0.001, t + 1.2)
    src.connect(bp); bp.connect(g); g.connect(out); src.start(t); src.stop(t + 1.3)
    ctx.tone(55, t, 0.5, 0.12, 'sine'); ctx.tone(110, t + 0.02, 0.3, 0.05, 'triangle')
    // and a roar for as long as it lasts
    const r = ac.createBufferSource(), lp = ac.createBiquadFilter(), rg = ac.createGain()
    r.buffer = noiseBuf(ac); r.loop = true; lp.type = 'lowpass'; lp.frequency.value = 700
    rg.gain.setValueAtTime(0, t); rg.gain.linearRampToValueAtTime(0.07, t + 0.2)
    r.connect(lp); lp.connect(rg); rg.connect(out); r.start(t)
    roar = { r, rg }
  }
  function roarOff() { if (!roar) return; const ac = ctx.audio(), t = ac.currentTime; roar.rg.gain.setTargetAtTime(0, t, 0.08); roar.r.stop(t + 0.5); roar = null }
  let nb = null
  const noiseBuf = (ac) => (nb ??= noise(ac, 2))
  function chime(n) { // a stunt: a quick arpeggio, higher with the combo
    const ac = ctx.audio(); if (!ac) return
    const t = ac.currentTime + 0.01, f0 = 523.3 * 2 ** (Math.min(n, 8) / 12)
    ;[1, 1.26, 1.5].forEach((m, i) => ctx.tone(f0 * m, t + i * 0.05, 0.18, 0.05, 'square'))
  }
  function beep(f, dur = 0.18) { const ac = ctx.audio(); if (!ac) return; ctx.tone(f, ac.currentTime + 0.01, dur, 0.09, 'square') }
  function cash() { const ac = ctx.audio(); if (!ac) return; const t = ac.currentTime + 0.01; ctx.bell(1318.5, t, 0.1); ctx.bell(1760, t + 0.08, 0.1); ctx.tone(2637, t + 0.16, 0.25, 0.04, 'triangle') }
  function buzzer() { const ac = ctx.audio(); if (!ac) return; const t = ac.currentTime + 0.01; ctx.tone(220, t, 0.25, 0.1, 'square'); ctx.tone(165, t + 0.25, 0.25, 0.1, 'square'); ctx.tone(110, t + 0.5, 0.6, 0.1, 'square') }

  // ---------------------------------------------------------------- fares
  const DESTS = DEST.map(([name, sub, lat, lon]) => { const p = city.world.fromLatLon(lat, lon); return { name, sub, x: p.x, y: -p.z } })
  // a destination for someone at (x, y): a landmark, or (for the shorter rides) a named shop, of the fare class asked
  // for, else the nearest class there is
  function destFor(x, y, want) {
    for (const c of [want, ...[0, 1, 2].filter((c) => c !== want)]) {
      const [r0, r1] = CLASS[c].r, all = []
      for (const d of DESTS) { const l = Math.hypot(d.x - x, d.y - y); if (l >= r0 && l <= r1) all.push(d) }
      if (c < 2 && (all.length < 2 || Math.random() < 0.35)) for (const p of ctx.placesNear(x, y, r0, Math.min(r1, 1500))) if (p.name) all.push({ name: p.name, sub: p.addr || p.kind, x: p.x, y: p.y, shop: true })
      if (all.length) return { cls: c, ...pick(all) }
    }
    return null
  }
  // a spot on a kerb 60-320 m from the cab, on a city street with sidewalks, not right behind it
  const SEGS = []
  function spawnSpot() {
    SEGS.length = 0
    const fwx = -Math.sin(car.yaw), fwy = Math.cos(car.yaw)
    ctx.segsNear(car.x, car.y, 320, (s) => {
      if (!s.drv || s.z0 != null || s.p.kind < 2 || s.p.kind > 6 || s.p.w < 5) return
      const mx = (s.x0 + s.x1) / 2 - car.x, my = (s.y0 + s.y1) / 2 - car.y, l = Math.hypot(mx, my)
      if (l < 60 || l > 320 || (mx * fwx + my * fwy) / l < -0.3) return
      SEGS.push(s)
    })
    for (let k = 0; k < 8 && SEGS.length; k++) {
      const s = SEGS[Math.floor(Math.random() * SEGS.length)], u = 0.2 + Math.random() * 0.6
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l, side = Math.random() < 0.5 ? 1 : -1
      const cx = s.x0 + dx * u, cy = s.y0 + dy * u, kx = cx + nx * side * (s.p.w / 2 + 1.4), ky = cy + ny * side * (s.p.w / 2 + 1.4)
      if (ctx.insideBuilding(kx, ky) || ctx.isWater(kx, ky) || folk.some((f) => f.mode !== 'off' && Math.hypot(f.x - kx, f.y - ky) < 60)) continue
      return { x: kx, y: ky, rx: cx + nx * side * Math.max(0, s.p.w / 2 - 1.8), ry: cy + ny * side * Math.max(0, s.p.w / 2 - 1.8), yaw: yawTo(-nx * side, -ny * side) }
    }
    return null
  }
  const yawTo = (dx, dy) => Math.atan2(-dx, dy) // the drive plugin's yaw facing (dx, dy) in (x, north)
  function spawn(f) {
    const sp = spawnSpot()
    if (!sp) return false
    const want = Math.random() < 0.45 ? 0 : Math.random() < 0.6 ? 1 : 2, d = destFor(sp.x, sp.y, want)
    if (!d) return false
    Object.assign(f, { mode: 'wait', x: sp.x, y: sp.y, rx: sp.rx, ry: sp.ry, yaw: sp.yaw, cls: CLASS[d.cls], dest: d, t: 0 })
    const g = city.world.heightAt(f.x, -f.y)
    f.w.position.set(f.x, g + 0.1, -f.y); f.w.rotation.set(0, f.yaw, 0); f.w.visible = true
    f.ring.material.color.setHex(f.cls.col); f.ring.position.set(f.rx, city.world.heightAt(f.rx, -f.ry) + 0.25, -f.ry); f.ring.visible = !fare
    f.gem.material.color.setHex(f.cls.col); f.gem.visible = true
    return true
  }
  function despawn(f) { f.mode = 'off'; f.w.visible = f.ring.visible = f.gem.visible = false }
  function board(f) { // stopped in the ring: they hop in
    f.mode = 'board'; f.t = 0; f.ring.visible = f.gem.visible = false
    const d = f.dest, l = Math.hypot(d.x - f.x, d.y - f.y)
    const who = rider()
    fare = { f, who, hits: 0, dest: d, dist: l, pay: Math.round((3.5 + 2.4 * (l / 1000)) * (who.pay || 1) * 100) / 100, tips: 0, limit: (10 + l / 15) * (who.limit || 1), t0: performance.now(), refined: false, gx: d.x, gy: d.y, r: d.shop ? 14 : 26 }
    S.time += f.cls.add
    ctx.sfx.pickup(); ctx.buzz(30)
    banner(`+${f.cls.add} s`, who.name ? `${who.name} · ${f.cls.name} fare` : `${f.cls.name} fare`)
    speak(`<b>“${esc(pick(HAIL).replace('{d}', d.name))}${who.say ? ` ${esc(who.say)}` : ''}”</b>`, who.say ? 4500 : 3500)
    nitro = Math.min(1, nitro + 0.15)
    ctx.setGoal(fare.gx, fare.gy, f.cls.col, ctx.icon)
    for (const o of folk) if (o.mode === 'wait') o.ring.visible = false
  }
  function dropOff() {
    const F = fare, used = (performance.now() - F.t0) / 1000, quick = used < F.limit * 0.6
    const bonus = quick ? 6 : used < F.limit ? 3 : 0
    const clean = F.who.clean && !F.hits
    if (F.who.clean) F.pay = Math.round(F.pay * (clean ? F.who.clean : 0.8) * 100) / 100
    city.progress?.award('fare', F.pay + F.tips, { quiet: true })
    S.time += bonus
    S.fares++; S.cash += F.pay + F.tips; S.fareCash += F.pay; S.tips += F.tips; S.km += F.dist / 1000
    cash(); ctx.buzz([30, 60, 30, 60, 60])
    banner(`+${money(F.pay + F.tips)}`, `${clean ? 'Not a scratch! ' : quick ? 'Speedy! ' : ''}${bonus ? `+${bonus} s` : ''}`)
    speak(`<b>“${esc(pick(THANKS))}”</b> fare ${money(F.pay)}${F.tips ? `, tips ${money(F.tips)}` : ''}`)
    const f = F.f; f.mode = 'leave'; f.t = 0; f.x = car.x + Math.cos(car.yaw) * 1.6; f.y = car.y + Math.sin(car.yaw) * 1.6; f.w.visible = true
    fare = null; nitro = Math.min(1, nitro + 0.2)
    ctx.hideMarkers()
    for (const o of folk) if (o.mode === 'wait') o.ring.visible = true
  }
  function bail() { // the fare's clock ran out
    const f = fare.f
    speak('<b>“Forget it, I’ll walk!”</b> The fare got out.'); buzzer()
    f.mode = 'leave'; f.t = 0; f.x = car.x + Math.cos(car.yaw) * 1.6; f.y = car.y + Math.sin(car.yaw) * 1.6; f.w.visible = true
    fare = null; comboN = 0
    ctx.hideMarkers()
    for (const o of folk) if (o.mode === 'wait') o.ring.visible = true
  }

  // ---------------------------------------------------------------- stunts
  function stunt(name, tip, fill, extra = '') {
    const now = performance.now()
    comboN = now - comboT < 4000 ? comboN + 1 : 1; comboT = now
    S.bestCombo = Math.max(S.bestCombo, comboN)
    nitro = Math.min(1, nitro + fill)
    const k = (1 + 0.5 * (comboN - 1)) * (fare?.who.stunt || 1), v = Math.round(tip * k * 100) / 100
    if (comboN > 1) city.progress?.stat('taxi.combo', 1)
    if (fare) fare.tips += v
    shout(name, fare ? `+${money(v)}${extra}` : extra || (comboN > 1 ? `×${comboN}` : ''))
    chime(comboN)
    ctx.buzz(18)
  }
  // two boxes overlap (separating axes on their own axes): centre, unit forward, half length and width
  function overlap(ax, ay, afx, afy, ahl, ahw, bx, by, bfx, bfy, bhl, bhw) {
    const dx = ax - bx, dy = ay - by
    for (let i = 0; i < 4; i++) {
      const nx = i === 0 ? afx : i === 1 ? afy : i === 2 ? bfx : bfy, ny = i === 0 ? afy : i === 1 ? -afx : i === 2 ? bfy : -bfx
      const ra = ahl * Math.abs(afx * nx + afy * ny) + ahw * Math.abs(afy * nx - afx * ny), rb = bhl * Math.abs(bfx * nx + bfy * ny) + bhw * Math.abs(bfy * nx - bfx * ny)
      if (Math.abs(dx * nx + dy * ny) > ra + rb) return false
    }
    return true
  }
  function nearMisses(now) {
    const sp = Math.abs(car.speed)
    if (sp < 11 || car.lift > 0.5) return
    const V = car.V, fwx = -Math.sin(car.yaw), fwy = Math.cos(car.yaw)
    for (const o of ctx.others(car.x, car.y, 14)) {
      const bfx = Math.sin(o.heading), bfy = -Math.cos(o.heading), bhl = (o.length || 4.4) / 2, bhw = (o.width || 1.8) / 2, ox = o.x, oy = -o.z
      const rel = Math.hypot(fwx * car.speed - bfx * (o.speed || 0), fwy * car.speed - bfy * (o.speed || 0))
      if (rel < 7 || nearSeen.get(o.id) > now - 3000) continue
      if (overlap(car.x, car.y, fwx, fwy, V.hl + 0.6, V.hw + 1.1, ox, oy, bfx, bfy, bhl, bhw) && !overlap(car.x, car.y, fwx, fwy, V.hl + 0.05, V.hw + 0.12, ox, oy, bfx, bfy, bhl, bhw)) {
        nearSeen.set(o.id, now); S.near++
        stunt('Near miss!', 1.0, 0.12)
      }
    }
    if (nearSeen.size > 200) nearSeen.clear()
  }

  // ---------------------------------------------------------------- the clock
  function restart() {
    Object.assign(S, { n: 4, shown: false, time: START_TIME, cash: 0, fareCash: 0, tips: 0, fares: 0, km: 0, near: 0, drift: 0, air: 0, bestCombo: 0, top: 0, over: false })
    for (const f of folk) despawn(f)
    fare = null; nitro = 0.6; comboN = 0; state = 'count'; countT = 0; spawnAt = 0; stuckT = 0
    car.speed = car.lat = 0; car.parked = true
    ctx.hideMarkers(); ctx.sheet.hidden = true
    speak(`<b>${esc(drv.name)}</b> “${esc(drv.line)}”`, 3800)
  }
  function timeUp() {
    state = 'over'; endT = performance.now(); S.over = true
    if (fare) { const f = fare.f; despawn(f); fare = null; ctx.hideMarkers() }
    banner('Time’s up!'); buzzer(); roarOff()
  }
  function rankOf(v) { return RANKS.find((r) => v >= r[0]) }
  function results() {
    const r = rankOf(S.cash), prev = bestOf(), isBest = !prev || S.cash > prev.score
    if (S.cash > 0) city.progress?.score('taxi', Math.round(S.cash))
    if (isBest && S.cash > 0) { try { localStorage.setItem('taxi.best', JSON.stringify({ score: S.cash, rank: r[1], cab: cabDef.name, driver: drv.name, fares: S.fares })) } catch {} }
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`
    ctx.sheet.innerHTML = `<h3>${NAME} · end of shift</h3><div class="tx-res"><div class="rank">${r[2]}</div><div class="title">${esc(r[1])}</div></div>
      <div class="big">${money(S.cash)}</div>${isBest && S.cash > 0 ? '<div class="tx-res"><span class="new">A new best!</span></div>' : prev ? `<div class="line" style="margin:0">Best: ${money(prev.score)}</div>` : ''}
      <dl>${row('Fares', `${S.fares} (${money(S.fareCash)})`)}${row('Tips from stunts', money(S.tips))}${row('Best combo', S.bestCombo > 1 ? `×${S.bestCombo}` : '—')}
      ${row('Near misses', S.near)}${row('Biggest air', S.air ? `${S.air.toFixed(1)} s` : '—')}${row('Drifting', `${S.drift.toFixed(1)} s`)}${row('Top speed', `${Math.round(S.top * 3.6)} km/h`)}
      ${row('Cab', `${esc(cabDef.name)} · ${esc(drv.name)}`)}</dl>
      <div class="row"><button data-x>Map</button><button data-g>Garage</button><button class="main tx-again" data-a>Another shift</button></div>`
    ctx.sheet.hidden = false
    ctx.sheet.querySelector('[data-x]').onclick = () => ctx.exit(true)
    ctx.sheet.querySelector('[data-g]').onclick = () => ctx.toGarage()
    ctx.sheet.querySelector('[data-a]').onclick = () => restart()
  }

  // ---------------------------------------------------------------- per frame (index.js: after the cab has moved)
  // the boost this frame (the caller sets car.boost): held, with nitro left, at least a little forward
  function boost(want, dt) {
    const on = state === 'play' && want && nitro > 0.01 && car.gear > 0 && (boosting || nitro > 0.08)
    if (on && !boosting) { whoosh(); ctx.buzz(25); streakT = 0; streakDone = false }
    if (!on && boosting) roarOff()
    boosting = on
    if (on) nitro = Math.max(0, nitro - dt / tank)
    return on
  }
  function frame(dt, now, time) {
    if (state === 'count') {
      countT += dt
      car.parked = true
      const n = 3 - Math.floor(countT / 0.8)
      if (n !== S.n) { S.n = n; if (n > 0) { banner(String(n)); beep(440) } else { banner('Go!'); beep(880, 0.4); city.progress?.run('taxi') } }
      if (countT > 2.4) { state = 'play'; car.parked = false }
    } else if (state === 'play') {
      S.time -= dt
      if (S.time <= 0) { S.time = 0; timeUp() }
    } else if (state === 'over' && now - endT > 1600 && ctx.sheet.hidden && !S.shown) { S.shown = true; results() }
    const sp = Math.abs(car.speed)
    S.top = Math.max(S.top, sp)
    // stunts
    if (state === 'play') {
      nearMisses(now)
      if (car.lift < 0.3 && Math.abs(car.lat) > 2.2 && sp > 8) { driftT += dt; driftOff = 0; nitro = Math.min(1, nitro + dt * 0.06) }
      else if (driftT > 0 && (driftOff += dt) > 0.3) { if (driftT > 0.8) { S.drift += driftT; stunt(`Drift ${driftT.toFixed(1)} s`, 0.6 * driftT, 0.04) } driftT = 0 }
      if (boosting && sp > 26) { streakT += dt; if (streakT > 2 && !streakDone) { streakDone = true; stunt('Nitro streak!', 1.5, 0) } }
      // stuck against something: back on the road
      stuckT = sp < 0.8 && (car.thr > 0.5 || car.brk > 0.5) ? stuckT + dt : 0
      if (stuckT > 2.5) { stuckT = 0; ctx.reset(); shout('Back on the road') }
    }
    // the people at the kerbs
    if (state === 'play' && now > spawnAt) {
      spawnAt = now + 700
      const f = folk.find((o) => o.mode === 'off')
      if (f) spawn(f)
    }
    if (now > rampAt0) { // a ramp at a time, every second or so; the ones left far behind go
      rampAt0 = now + 1100
      const r = ramps.find((o) => !o.on || Math.hypot(o.x - car.x, o.y - car.y) > 650)
      if (r) { if (r.on) dropRamp(r); placeRamp(r) }
    }
    for (const f of folk) {
      if (f.mode === 'off') continue
      f.t += dt; f.phase += dt
      const { arms, body } = f.w.userData
      if (f.mode === 'wait') {
        const dx = car.x - f.x, dy = car.y - f.y, d = Math.hypot(dx, dy)
        if (d > 480) { despawn(f); continue }
        f.yaw += wrap(yawTo(dx, dy) - f.yaw) * Math.min(1, dt * 3)
        f.w.rotation.y = f.yaw
        const eager = d < 60 ? 1 : 0.4 // waving, hopping when the cab comes near
        poseWalker(f.w, 0, 0, false)
        arms[1].rotation.x = 2.7; arms[1].rotation.z = -0.2 + Math.sin(f.phase * (6 + 5 * eager)) * 0.4
        if (eager === 1) { arms[0].rotation.x = 2.6; arms[0].rotation.z = 0.2 - Math.sin(f.phase * 11) * 0.4; body.position.y = Math.abs(Math.sin(f.phase * 7)) * 0.12 }
        f.gem.position.set(f.x, f.w.position.y + 2.5 + Math.sin(f.phase * 3) * 0.15, -f.y); f.gem.rotation.y = f.phase * 2
        if (!fare) {
          const s = 1 + Math.sin(f.phase * 4) * 0.05; f.ring.scale.set(s, 1, s)
          if (state === 'play' && Math.hypot(car.x - f.rx, car.y - f.ry) < 5.5 && sp < 3) board(f)
        }
      } else if (f.mode === 'board' || f.mode === 'leave') { // walking to the cab's door, or away from it to the kerb
        const k = Math.min(1, f.t / 0.7), into = f.mode === 'board'
        const tx = car.x + Math.cos(car.yaw) * 1.4, ty = car.y + Math.sin(car.yaw) * 1.4 // the kerb side door
        const x = into ? f.x + (tx - f.x) * k : f.x + Math.cos(car.yaw) * 2.5 * k, y = into ? f.y + (ty - f.y) * k : f.y + Math.sin(car.yaw) * 2.5 * k
        f.w.position.set(x, city.world.heightAt(x, -y) + 0.1, -y)
        poseWalker(f.w, f.t * 9, 1, true)
        if (!into && f.t > 0.7) { arms[0].rotation.x = arms[1].rotation.x = 2.9; body.position.y = Math.abs(Math.sin(f.t * 8)) * 0.15 } // a cheer
        if (into && k >= 1) { f.mode = 'aboard'; f.w.visible = false }
        if (!into && f.t > 2.6) despawn(f)
      }
    }
    // the fare: refine the drop-off onto the street once its tiles are in; arrive; run out of time
    if (fare) {
      if (!fare.refined && now > refineAt) {
        refineAt = now + 400
        if (Math.hypot(fare.dest.x - car.x, fare.dest.y - car.y) < 900) {
          const s = ctx.stopFor(fare.dest.x, fare.dest.y)
          if (s) { fare.gx = s.x; fare.gy = s.y; fare.refined = true; fare.r = 9 + s.w / 2; ctx.setGoal(fare.gx, fare.gy, fare.f.cls.col, ctx.icon) }
        }
      }
      const d = Math.hypot(fare.gx - car.x, fare.gy - car.y)
      if (state === 'play' && fare.f.mode === 'aboard' && d < fare.r && sp < 4) dropOff()
      else if (state === 'play' && (now - fare.t0) / 1000 > fare.limit) bail()
    }
    // effects: the boost, the arrow
    boostAmt += ((boosting ? 1 : 0) - boostAmt) * (1 - Math.exp(-(boosting ? 10 : 4) * dt))
    const fwx = -Math.sin(car.yaw), fwy = Math.cos(car.yaw)
    fx.update(dt, time, boostAmt, fwx * car.speed, -fwy * car.speed, ctx.pcam)
    if (boosting) ctx.shake(0.07 + 0.05 * boostAmt)
    let tx = null, ty = 0, col = 0
    if (fare) { tx = fare.gx; ty = fare.gy; col = fare.f.cls.col } else { // no fare: the nearest person waving
      let bd = Infinity
      for (const f of folk) if (f.mode === 'wait') { const d = Math.hypot(f.x - car.x, f.y - car.y); if (d < bd) { bd = d; tx = f.rx; ty = f.ry; col = f.cls.col } }
    }
    const A = fx.arrow
    A.visible = tx != null && state !== 'over'
    if (A.visible) {
      const top = car.h + (car.lift || 0) + 2.7 + Math.abs(Math.sin(time * 4.2)) * 0.45
      A.position.set(car.x + fwx * 1.2, top, -(car.y + fwy * 1.2))
      // pointing the way, its face tipped up towards the camera (about the camera's right) so it reads from behind
      A.quaternion.setFromAxisAngle(UP, Math.atan2(ty - car.y, tx - car.x))
      TILT.setFromAxisAngle(AX.setFromMatrixColumn(ctx.pcam.matrixWorld, 0), 0.55); A.quaternion.premultiply(TILT)
      fx.arrowMat.color.setHex(col)
      A.scale.setScalar(fare ? 1.6 : 1.1); fx.arrowMat.opacity = fare ? 0.95 : 0.6
    }
    if (!say.hidden && now > sayT) say.hidden = true
    if (now - hudAt > 100) { hudAt = now; hud() }
  }
  function hud() {
    H.t.textContent = mmss(Math.ceil(S.time)); H.t.classList.toggle('low', state === 'play' && S.time < 10)
    H.m.textContent = money(S.cash)
    H.ni.style.width = `${Math.round(nitro * 100)}%`; H.n.classList.toggle('on', boosting)
    H.c.textContent = comboN > 1 && performance.now() - comboT < 4000 ? `Combo ×${comboN}` : ''
    if (fare) {
      const left = fare.limit - (performance.now() - fare.t0) / 1000, d = Math.hypot(fare.gx - car.x, fare.gy - car.y)
      H.k.textContent = `${fare.f.cls.name} fare → `; H.k.style.color = fare.f.cls.css
      H.d.textContent = fare.dest.name
      H.s.textContent = `${dist(d)} · ${fare.dest.sub ? `${fare.dest.sub} · ` : ''}fare ${money(fare.pay)}${fare.tips ? ` + tips ${money(fare.tips)}` : ''}`
      H.bi.style.width = `${clamp(left / fare.limit, 0, 1) * 100}%`; H.b.classList.toggle('late', left < 8); H.b.hidden = false
    } else {
      H.k.textContent = state === 'over' ? 'Off duty' : 'Find a fare'; H.k.style.color = ''
      H.d.textContent = state === 'over' ? 'Shift over' : 'Folks are waving at the kerbs'
      H.s.innerHTML = CLASS.map((c) => `<i style="background:${c.css}"></i>${c.name}`).join(' &nbsp; ')
      H.b.hidden = true
    }
  }

  restart()
  for (const e of [clockEl, fareEl]) e.hidden = false
  return {
    frame, boost, restart, get debug() { return { fx, folk, fare, S, nitro, ramps } },
    // the height a ramp adds to the road at (x, north)
    rampAt(x, y) {
      for (let i = 0; i < ramps.length; i++) {
        const r = ramps[i]
        if (!r.on) continue
        const dx = x - r.x + r.ux * RL / 2, dy = y - r.y + r.uy * RL / 2, a = dx * r.ux + dy * r.uy
        if (a > 0 && a < RL && Math.abs(dx * r.uy - dy * r.ux) < RW / 2) return (a / RL) * RH
      }
      return 0
    },
    get frozen() { return state !== 'play' }, get over() { return state === 'over' }, get boosting() { return boosting },
    get fov() { return boostAmt * 14 + clamp((Math.abs(car.speed) - 15) / 25, 0, 1) * 6 },
    goal: () => (fare ? { x: fare.gx, y: fare.gy } : null),
    // a knock (impact m/s), a car hit, a person bumped, a landing (s in the air, how high, off a deck)
    bump(k) { if (fare && k > 2.5) fare.hits++; if (k > 6 && state === 'play') { if (comboN > 1) shout('Combo broken'); comboN = 0; if (fare && fare.tips) fare.tips = Math.max(0, fare.tips - 0.5) } },
    hitCar(id) { nearSeen.set(id, performance.now()) },
    oops() { comboN = 0; if (fare) { fare.tips = Math.max(0, fare.tips - 2); speak('<b>“Watch the sidewalk!”</b> −$2.00 in tips') } else shout('Watch the sidewalk!') },
    landed(secs, high, deck) {
      if (state !== 'play' || secs < 0.4 || Math.abs(car.speed) < 8) return
      S.air = Math.max(S.air, secs)
      if (deck && high > 1.2) stunt('Bridge leap!', 2.5 + 2 * secs, 0.25, ` ${secs.toFixed(1)} s`)
      else stunt(secs > 1.6 ? 'Huge air!' : 'Big air!', 1.2 * secs + 0.5, 0.1 + 0.15 * secs, ` ${secs.toFixed(1)} s`)
    },
    endShift() { if (state === 'play' || state === 'count') { S.time = 0; timeUp() } else if (state === 'over' && ctx.sheet.hidden) results() },
    help: () => `W gas · S brake, hold to reverse · A D steer · Space drift · Shift nitro · R unstick · Esc end the shift`,
    dispose() {
      roarOff()
      fx.dispose()
      for (const r of ramps) { dropRamp(r); city.scene.remove(r.m) }
      rampG.dispose(); rampM.dispose()
      for (const f of folk) { city.scene.remove(f.w); city.overlay.remove(f.ring, f.gem); f.w.traverse((m) => { if (m.isMesh) { m.geometry.dispose(); m.material.dispose() } }); f.ring.material.dispose(); f.gem.material.dispose() }
      ringG.dispose(); gemG.dispose()
      for (const e of els) e.remove()
      document.body.classList.remove('dlv-taxi')
    },
  }
}
export { CABS, DRIVERS, makeCab }
