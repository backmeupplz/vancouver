// Fishing and crabbing: the rules, with no three.js and no DOM (tools/fish_check.mjs runs them in node).
// Where (real piers, seawall, beaches, lakes), what bites (by water, season, tide, hour, weather, lure and how far the
// cast went), the reel fight, and the crab trap with its gauge. Sizes and seasons follow the real fish; the size limits
// and the daily limit for crab are DFO's for Burrard Inlet (Dungeness 165 mm, red rock 115 mm, four a day, males only
// here); wolf eel and Fraser white sturgeon are catch and release, as they are for real.
import { clamp } from '../../core/util.js'

// [id, name, lat, lon, kind, water, blurb, extras]. kind: pier | seawall | beach | lake | river; water: s salt, f fresh,
// r the Fraser. The position is the place to stand (tools/fish_check.mjs --snap prints one at the water's edge).
// extras: crab (share of red rock crab in a trap there; no key: no crabbing), closed (no fishing: the ranger),
// boost { species: × }, seal (chance a seal takes a salmon)
export const SPOTS = [
  ['jericho', 'Jericho Pier', 49.27684, -123.20174, 'pier', 's', 'Sandy bottom: flounder, perch and Dungeness.', { crab: 0.15, boost: { flounder: 1.8, perch: 1.4 } }],
  ['ambleside', 'Ambleside Pier', 49.32639, -123.15382, 'pier', 's', 'Off the mouth of the Capilano: coho country.', { crab: 0.3, boost: { coho: 2.6, pink: 2, chinook: 1.5 }, seal: 0.12 }],
  ['dundarave', 'Dundarave Pier', 49.33246, -123.18253, 'pier', 's', 'A short pier over kelp and rock.', { crab: 0.6, boost: { rockfish: 1.6, lingcod: 1.4 } }],
  ['belcarra', 'Belcarra Pier', 49.31307, -122.92868, 'pier', 's', 'The crabbing pier. Bring a gauge.', { crab: 0.35, boost: { rockfish: 1.5, sculpin: 1.4 } }],
  ['whiterock', 'White Rock Pier', 49.01705, -122.80572, 'pier', 's', '470 m out over Semiahmoo Bay.', { crab: 0.1, boost: { flounder: 2, dogfish: 1.6, perch: 1.3 } }],
  ['steveston', 'Steveston Fisherman’s Wharf', 49.1235, -123.18446, 'pier', 'r', 'The Fraser’s front door. Sea lions want a cut.', { crab: 0.1, boost: { sturgeon: 1.5 }, seal: 0.2 }],
  ['no3road', 'No. 3 Road Fishing Pier', 49.11052, -123.1383, 'pier', 'r', 'Bar fishing on the South Arm.', { boost: { sturgeon: 2.2, chinook: 1.5, pikeminnow: 1.3 } }],
  ['mcdonald', 'McDonald Beach', 49.21343, -123.16777, 'river', 'r', 'North Arm sand: sturgeon water.', { boost: { sturgeon: 2.5 } }],
  ['garry', 'Garry Point', 49.1245, -123.1975, 'beach', 'r', 'Where the river meets the Strait.', { boost: { flounder: 1.6, chum: 1.5 } }],
  ['newbrighton', 'New Brighton Pier', 49.29077, -123.03723, 'pier', 's', 'Under the grain elevators.', { crab: 0.4, boost: { perch: 1.5, dogfish: 1.5, cart: 2 } }],
  ['crabpark', 'CRAB Park Pier', 49.28643, -123.10316, 'pier', 's', 'Between the SeaBus and the cranes.', { crab: 0.5, boost: { cart: 3, mobi: 3, sculpin: 1.5 } }],
  ['rockypoint', 'Rocky Point Pier', 49.28245, -122.84997, 'pier', 's', 'The head of the inlet, Port Moody.', { crab: 0.2, boost: { flounder: 1.5, chum: 2 } }],
  ['crescent', 'Crescent Beach Pier', 49.05939, -122.88369, 'pier', 's', 'Boundary Bay shallows.', { crab: 0.1, boost: { flounder: 2, perch: 1.3 } }],
  ['horseshoe', 'Horseshoe Bay Dock', 49.37571, -123.27549, 'pier', 's', 'Deep, cold Howe Sound.', { crab: 0.5, boost: { lingcod: 1.8, rockfish: 1.8, wolfeel: 3 } }],
  ['siwash', 'Siwash Rock seawall', 49.30859, -123.15607, 'seawall', 's', 'Cast from the Stanley Park seawall.', { boost: { lingcod: 1.6, rockfish: 1.5, wolfeel: 2 }, seal: 0.1 }],
  ['brockton', 'Brockton Point', 49.30091, -123.11698, 'seawall', 's', 'The tide rips round the lighthouse.', { boost: { chinook: 1.4, rockfish: 1.3 } }],
  ['sunset', 'Sunset Beach seawall', 49.27859, -123.13814, 'seawall', 's', 'False Creek’s mouth, Aquabuses passing.', { boost: { herring: 2, perch: 1.5, mobi: 2 } }],
  ['spanish', 'Spanish Banks', 49.27797, -123.22161, 'beach', 's', 'Surf-cast across the sand flats.', { boost: { flounder: 2.2 } }],
  ['kits', 'Kitsilano Beach', 49.27574, -123.15356, 'beach', 's', 'Surf-casting with a view of the freighters.', { boost: { flounder: 1.5, perch: 1.3 } }],
  ['iona', 'Iona Beach', 49.21968, -123.2151, 'beach', 'r', 'Flats where the North Arm spills out.', { boost: { flounder: 2, chum: 1.4 } }],
  ['wreck', 'Wreck Beach', 49.26157, -123.26227, 'beach', 's', 'Nobody minds what you wear to fish.', { boost: { coho: 1.4, flounder: 1.3 } }],
  ['troutlake', 'Trout Lake', 49.25596, -123.06314, 'lake', 'f', 'John Hendry Park. More carp than trout.', { boost: { carp: 2.2, rainbow: 0.5 } }],
  ['ricelake', 'Rice Lake', 49.35555, -123.01399, 'lake', 'f', 'Stocked rainbows in the Seymour forest.', { boost: { rainbow: 2 } }],
  ['lafarge', 'Lafarge Lake', 49.28686, -122.78752, 'lake', 'f', 'Coquitlam’s stocked pond.', { boost: { rainbow: 1.8, carp: 1.3 } }],
  ['sasamat', 'Sasamat Lake', 49.31628, -122.88692, 'lake', 'f', 'Off the floating walkway.', { boost: { cutthroat: 2 } }],
  ['comolake', 'Como Lake', 49.26019, -122.85966, 'lake', 'f', 'Family fishing: the hatchery truck comes by.', { boost: { rainbow: 1.6, sunfish: 1.4 } }],
  ['deerlake', 'Deer Lake', 49.23507, -122.97558, 'lake', 'f', 'Burnaby, lily pads, bullheads.', { boost: { bullheadcat: 2, carp: 1.5 } }],
  ['lostlagoon', 'Lost Lagoon', 49.29413, -123.13979, 'lake', 'f', 'A bird sanctuary.', { closed: true }],
].map(([id, name, lat, lon, kind, water, blurb, x = {}]) => ({ id, name, lat, lon, kind, water, blurb, ...x }))
export const RANGER = ['Park ranger: “Lost Lagoon is a bird sanctuary. No fishing.” The heron looks smug.', 'The ranger again: “Still no fishing.” A swan hisses in agreement.',
  'Ranger: “I admire the persistence. Trout Lake is that way.”']

const M = (a, b) => { const o = []; for (let m = a; ; m = (m % 12) + 1) { o.push(m); if (m === b) break } return o } // months a..b (wraps the new year)
// id: [name, waters, min cm, max cm, k (kg = k × 1e-5 × cm³), pay, fight 0-1, weight, opts]
// opts: m months it runs, odd (odd years only), at { kind: × }, tide flood | ebb | slack, time dawn | day | night,
// wx (likes rain and cloud), lure { id: × }, deep (0-1: likes a long cast), release (it must go back), junk,
// shape + col + belly (the model), lines (the catch card)
const SP = {
  chinook: ['Chinook salmon', 'sr', 60, 110, 1.25, 70, 0.9, 4, { m: M(5, 9), tide: 'flood', time: 'dawn', lure: { herring: 2.5, hoochie: 1.6, buzz: 1.3 }, deep: 0.8, shape: 'salmon', col: 0x5d7f86, belly: 0xdfe6e4, lines: ['A spring! A tyee is anything over thirty pounds: keep casting.', 'Chinook: the one the orcas want too.'] }],
  coho: ['Coho salmon', 'sr', 45, 78, 1.2, 45, 0.75, 6, { m: M(9, 11), tide: 'flood', wx: 1, lure: { buzz: 2, hoochie: 2 }, deep: 0.5, shape: 'salmon', col: 0x6f8f9a, belly: 0xe6ecea, lines: ['Silver bright and furious about it.', 'Coho stack up off the Capilano every fall, waiting for rain.'] }],
  pink: ['Pink salmon', 'sr', 40, 62, 1.15, 25, 0.5, 14, { m: M(7, 9), odd: true, lure: { hoochie: 3, buzz: 2 }, shape: 'salmon', col: 0x7d9a8c, belly: 0xf0d9dc, lines: ['A humpy! Pinks only run in odd years, millions at a time.'] }],
  chum: ['Chum salmon', 'sr', 55, 88, 1.2, 35, 0.8, 7, { m: M(10, 12), lure: { hoochie: 1.5, buzz: 1.4 }, deep: 0.4, shape: 'salmon', col: 0x6c7f5e, belly: 0xc9a9b4, lines: ['A chum in its calico stripes. Fights like a dog salmon should.'] }],
  rockfish: ['Copper rockfish', 's', 18, 42, 1.9, 22, 0.35, 9, { at: { pier: 1.4, seawall: 1.6, beach: 0.2 }, lure: { buzz: 1.5 }, shape: 'rock', col: 0xb5652f, belly: 0xe8cfa4, lines: ['Copper rockfish can live fifty years. This one looks unimpressed.'] }],
  lingcod: ['Lingcod', 's', 50, 115, 1.0, 80, 0.85, 2.5, { m: M(5, 9), at: { seawall: 1.5, beach: 0.2 }, tide: 'slack', lure: { herring: 2.5 }, deep: 0.7, shape: 'eel', col: 0x6b6a4a, belly: 0xc9c39a, lines: ['All teeth and attitude. No relation to ling, or to cod.'] }],
  flounder: ['Starry flounder', 'sr', 18, 52, 1.3, 16, 0.3, 9, { at: { beach: 2, river: 1.5, seawall: 0.5 }, lure: { worm: 1.6 }, shape: 'flat', col: 0x6e6248, belly: 0xe9e2cf, lines: ['Both eyes on one side, both judging you.'] }],
  perch: ['Shiner perch', 's', 8, 30, 2.0, 8, 0.15, 14, { at: { pier: 2, beach: 0.5 }, time: 'day', lure: { worm: 2 }, shape: 'rock', col: 0xa9b7b0, belly: 0xf0e9b8, lines: ['Shiner perch: every kid’s first fish off the pier.'] }],
  herring: ['Pacific herring', 's', 15, 26, 1.0, 9, 0.15, 10, { m: M(11, 4), at: { pier: 2, beach: 0.4 }, lure: { worm: 1.3 }, shape: 'salmon', col: 0x54707e, belly: 0xe9eef0, lines: ['Herring are back in False Creek since the pilings got wrapped.'] }],
  dogfish: ['Spiny dogfish', 's', 60, 115, 0.55, 20, 0.6, 5, { time: 'night', tide: 'ebb', lure: { herring: 2 }, deep: 0.5, shape: 'shark', col: 0x77756c, belly: 0xe2ddd0, lines: ['A small shark with a big grudge. Mind the spines.'] }],
  sculpin: ['Bullhead (sculpin)', 's', 8, 22, 2.2, 5, 0.1, 11, { at: { pier: 2, seawall: 1.5, beach: 0.6 }, lure: { worm: 2 }, shape: 'rock', col: 0x5f5540, belly: 0xb9ad8a, lines: ['A bullhead. Mostly head, as advertised.'] }],
  wolfeel: ['Wolf eel', 's', 90, 190, 0.45, 220, 0.8, 0.5, { at: { seawall: 2, pier: 1.5, beach: 0 }, deep: 0.5, release: true, shape: 'eel', col: 0x6d7780, belly: 0x9aa3a8, lines: ['A face like a retired boxer, and it mates for life. Back it goes.'] }],
  sturgeon: ['White sturgeon', 'r', 90, 300, 0.65, 260, 1, 1.2, { lure: { herring: 2 }, deep: 0.6, release: true, shape: 'sturgeon', col: 0x6f7376, belly: 0xd7d5cc, lines: ['Older than the SkyTrain. Every Fraser sturgeon goes back: a photo, then a gentle release.'] }],
  pikeminnow: ['Northern pikeminnow', 'r', 22, 55, 1.0, 10, 0.3, 10, { shape: 'salmon', col: 0x7b7f5c, belly: 0xe6e2c4, lines: ['It eats salmon smolts. Nobody minds you catching it.'] }],
  rainbow: ['Rainbow trout', 'f', 20, 48, 1.3, 20, 0.45, 12, { m: [...M(3, 6), ...M(9, 11)], wx: 1, time: 'dawn', lure: { worm: 1.5, buzz: 1.2 }, shape: 'salmon', col: 0x6f8f6a, belly: 0xf0c9c0, lines: ['A stocked rainbow. The hatchery truck was here last week.'] }],
  cutthroat: ['Coastal cutthroat trout', 'fr', 20, 45, 1.2, 28, 0.5, 4, { wx: 1, lure: { buzz: 1.5 }, shape: 'salmon', col: 0x8a8a52, belly: 0xf0dca0, lines: ['The red slash under the jaw gives it away.'] }],
  carp: ['Common carp', 'f', 40, 80, 1.8, 18, 0.7, 4, { m: M(4, 10), time: 'day', lure: { worm: 2 }, shape: 'rock', col: 0xa58a3c, belly: 0xe9d9a0, lines: ['A carp the size of a corgi.'] }],
  bullheadcat: ['Brown bullhead', 'f', 15, 32, 1.6, 8, 0.2, 7, { time: 'night', lure: { worm: 2 }, shape: 'rock', col: 0x4f4433, belly: 0xc9b98c, lines: ['A small catfish with whiskers and opinions.'] }],
  sunfish: ['Pumpkinseed', 'f', 8, 18, 2.4, 6, 0.1, 10, { time: 'day', lure: { worm: 2 }, shape: 'rock', col: 0xd9892b, belly: 0xf2d24a, lines: ['Bright as a candy wrapper.'] }],
  boot: ['One left boot', 'sfr', 0, 0, 0, 2, 0.2, 1.4, { junk: 1, shape: 'boot', lines: ['Size eleven. The Great Shoreline Cleanup pays for it.'] }],
  umbrella: ['An umbrella', 'sfr', 0, 0, 0, 1, 0.2, 0.9, { junk: 1, shape: 'boot', lines: ['Inside out, as they all end up. It is Vancouver.'] }],
  cart: ['A shopping cart', 's', 0, 0, 0, 5, 0.55, 0.6, { junk: 1, at: { beach: 0.3 }, shape: 'cart', lines: ['False Creek’s most common species. One wheel still squeaks.'] }],
  mobi: ['A Mobi bike', 's', 0, 0, 0, 15, 0.6, 0.4, { junk: 1, at: { beach: 0.2 }, shape: 'bike', lines: ['Eleven months overdue. Mobi sends a finder’s fee.'] }],
}
export const SPECIES = Object.entries(SP).map(([id, [name, waters, min, max, k, pay, fight, w, o]]) => ({ id, name, waters, min, max, k, pay, fight, w, ...o }))
export const species = (id) => SPECIES.find((s) => s.id === id)

// gear (the progress plugin's garage lists the same ids: rod:<id>, lure:<id>, trap:<id>; the first is everyone's)
export const RODS = { spin: { name: 'Seawall spinner', cast: 18, reel: 2, str: 1 }, surf: { name: 'Surf caster', cast: 30, reel: 2, str: 1.1 }, mooch: { name: 'Mooching rod', cast: 22, reel: 2.5, str: 1.4 }, sturgeon: { name: 'Sturgeon stick', cast: 24, reel: 2.2, str: 1.9 } }
export const LURES = { worm: 'Worm and float', buzz: 'Buzz Bomb', hoochie: 'Pink hoochie', herring: 'Cut-plug herring' }
export const TRAPS = { ring: { name: 'Crab ring', cap: 3, holds: false }, fold: { name: 'Folding trap', cap: 4, holds: true }, pot: { name: 'Crab pot', cap: 6, holds: true } }

// ---------------------------------------------------------------- the tide
// Used when the weather plugin has no live tide (city.tide): the four big constituents at Point Atkinson with made-up
// phases, so the rhythm is right (two unequal tides a day, 1-5 m) but not the clock. h metres, rate metres an hour.
const TIDE = [[12.4206, 0.92, 1.1], [23.9345, 0.86, 2.3], [25.8193, 0.48, 0.4], [12, 0.23, 0.7]]
const tideH = (ms) => { const t = (ms - 1767225600000) / 3600000; let h = 3.05; for (const [p, a, ph] of TIDE) h += a * Math.cos((2 * Math.PI * t) / p - ph); return h }
export const tideAt = (ms) => ({ h: tideH(ms), rate: (tideH(ms + 180000) - tideH(ms - 180000)) * 10 })
export const tideWord = (t) => (Math.abs(t.rate) < 0.15 ? 'slack' : t.rate > 0 ? 'flood' : 'ebb')

// ---------------------------------------------------------------- what bites
const timeOf = (h) => (h >= 5 && h < 8) || (h >= 17 && h < 21) ? 'dawn' : h >= 8 && h < 17 ? 'day' : 'night'
// c: { water, kind, spot (a SPOTS entry or null), month, year, hour, tide { h, rate }, wx (weather kind), lure, power 0-1 }
// → [{ sp, w }] heaviest first: the odds of each species on this cast
export function biting(c) {
  const tw = tideWord(c.tide || { rate: 0 }), tm = timeOf(c.hour ?? 12), wet = /rain|cloud|overcast|fog|storm|drizzle/.test(c.wx || ''), pw = c.power ?? 0.5
  const out = []
  for (const sp of SPECIES) {
    if (!sp.waters.includes(c.water)) continue
    let w = sp.w
    if (sp.m && !sp.m.includes(c.month)) w *= 0.03
    if (sp.odd && c.year % 2 === 0) w = 0
    w *= sp.at?.[c.kind] ?? 1
    if (sp.tide && c.water !== 'f') w *= sp.tide === tw ? 1.7 : 0.75
    if (sp.time) w *= sp.time === tm ? 1.8 : sp.time === 'night' || tm === 'night' ? 0.45 : 0.9
    if (sp.wx) w *= wet ? 1.5 : 0.85
    w *= sp.lure?.[c.lure] ?? (sp.junk ? 1 : 0.8)
    w *= sp.deep ? 1 + sp.deep * (pw - 0.5) * 1.6 : 1.25 - 0.5 * pw
    w *= c.spot?.boost?.[sp.id] ?? 1
    if (c.boat) w *= sp.junk ? 0 : /chinook|coho|pink|chum/.test(sp.id) ? 2.5 : /lingcod|dogfish|rockfish|cutthroat|rainbow/.test(sp.id) ? 0.6 : 0.1 // trolling: salmon mostly, no boots
    if (w > 0) out.push({ sp, w })
  }
  return out.sort((a, b) => b.w - a.w)
}
// one fish off that cast: { sp, cm, kg, frac (0-1 of its size range), cash, trophy }
export function hookFish(c, rng = Math.random, rod = RODS.spin) {
  const list = biting(c)
  let r = rng() * list.reduce((a, b) => a + b.w, 0), sp = list[list.length - 1].sp
  for (const b of list) { r -= b.w; if (r <= 0) { sp = b.sp; break } }
  if (sp.junk) return { sp, cm: 0, kg: 0, frac: 0.5, cash: sp.pay, trophy: false }
  const frac = clamp(Math.pow(rng(), 1.8) * (0.72 + 0.28 * (c.power ?? 0.5)) + (rod.str - 1) * 0.08, 0, 1), cm = Math.round(sp.min + (sp.max - sp.min) * frac)
  return { sp, cm, kg: Math.round(sp.k * cm * cm * cm) / 1e5, frac, cash: Math.round(sp.pay * (0.45 + 1.3 * frac)), trophy: frac > 0.8 }
}
// seconds until the bite, and the nibbles (false alarms) before it
export function biteIn(rng = Math.random) {
  const at = 3.5 + rng() * 6.5, nib = []
  for (let t = 1.2 + rng() * 2; t < at - 1.2; t += 1.4 + rng() * 2.5) nib.push(t)
  return { at, nib, window: 0.95 }
}

// ---------------------------------------------------------------- the fight
// The line's tension goes for a level set by who is pulling: reeling against a resting fish sits in the green, reeling
// against a run goes over the top (hold it there and the line snaps), not reeling lets the fish take line and, at
// rest, the hook work loose. Keeping it in the green tires the fish: its runs get shorter and weaker.
export const GREEN = [0.35, 0.86]
export function newFight(fish, d, rod = RODS.spin) {
  return { fish, rod, d, d0: d, T: 0.4, st: 1, run: 0, rest: 1.2, slack: 0, over: 0, t: 0, p: fish.sp.fight * (0.6 + 0.6 * fish.frac) / rod.str }
}
// → null | 'run' | 'landed' | 'snap' | 'spit'
export function stepFight(f, dt, reel, rng = Math.random) {
  f.t += dt
  let ev = null
  if (f.run > 0) f.run -= dt
  else if ((f.rest -= dt) <= 0 && !f.fish.sp.junk) { f.run = 0.7 + 1.5 * f.st * rng(); f.rest = 1.1 + 2.2 * rng() + (1 - f.st) * 1.5; ev = 'run' }
  const running = f.run > 0, pull = f.p * (0.35 + 0.65 * f.st) * (running ? 1 : 0.22) + (f.fish.sp.junk ? f.p * 0.5 : 0)
  const target = reel ? 0.45 + pull * 0.95 : running ? pull * 0.4 : 0
  f.T += (target - f.T) * (1 - Math.exp(-(reel ? 3.2 : 1.6) * dt))
  if (reel) f.d -= f.rod.reel * (running ? 0.3 : 1) * (f.T > 1 ? 0.4 : 1) * dt
  else if (running) f.d += pull * 7 * dt
  if (f.T > 1) { if ((f.over += dt) > 0.55 * f.rod.str) return 'snap' } else f.over = Math.max(0, f.over - dt * 0.7)
  if (f.T < 0.12) { if ((f.slack += dt * (running ? 1.6 : 1)) > 2.4) return 'spit' } else f.slack = Math.max(0, f.slack - dt * 0.6)
  f.st = Math.max(0, f.st - dt * (f.T >= GREEN[0] ? 0.075 + 0.07 * f.T : 0.012) / (0.55 + f.p))
  if (f.d <= 1.5) return 'landed'
  if (f.d > f.d0 + 45) return 'spit' // spooled
  return ev
}

// ---------------------------------------------------------------- crab
export const CRAB = { dungeness: { name: 'Dungeness crab', min: 165, mean: 165, sd: 17, pay: 24 }, redrock: { name: 'Red rock crab', min: 115, mean: 115, sd: 13, pay: 11 } }
export const CRAB_LIMIT = 4, FINE = 60, RELEASE_PAY = 6
const gauss = (rng) => (rng() + rng() + rng() + rng() - 2) * 1.73
// what is in the trap after `secs` on the bottom: slack tide is best (crab walk when the current eases), a ring loses
// its crab once the bait has gone (after ~2.5 min), a trap or pot keeps them. → [{ kind, mm, male }]
export function soak(secs, { tide, trap = TRAPS.ring, rock = 0.3 }, rng = Math.random) {
  if (secs < 12) return []
  const slack = 1 - clamp(Math.abs(tide?.rate ?? 0.3) / 0.7, 0, 1)
  let mean = trap.cap * (1 - Math.exp(-secs / 45)) * (0.55 + 0.95 * slack)
  if (!trap.holds && secs > 150) mean *= Math.exp(-(secs - 150) / 70)
  const n = Math.min(trap.cap + 1, Math.floor(mean + rng()))
  return Array.from({ length: n }, () => {
    const kind = rng() < rock ? 'redrock' : 'dungeness', c = CRAB[kind]
    let mm = Math.round(clamp(c.mean + gauss(rng) * c.sd, c.min * 0.62, c.min * 1.24))
    if (Math.abs(mm - c.min) < 3) mm = c.min + (mm >= c.min ? 3 : -3) // (a gauge can tell)
    return { kind, mm, male: rng() < 0.62 }
  })
}
export const legal = (c) => c.male && c.mm >= CRAB[c.kind].min
// the call on one crab: keep it or put it back. kept: how many are in the bucket already today
// → { ok, cash, why }: a keeper pays, a right release pays a little, a wrong keep is a fine from the fisheries officer
export function judge(c, keep, kept = 0) {
  const k = CRAB[c.kind], good = legal(c) && kept < CRAB_LIMIT
  if (keep && good) return { ok: true, cash: Math.round(k.pay + (c.mm - k.min) * 0.5), why: `A keeper: ${c.mm} mm.` }
  if (keep) return { ok: false, cash: -FINE, why: `Fisheries officer: “${!c.male ? 'That one is a female: see the wide apron.' : c.mm < k.min ? `Undersize by ${k.min - c.mm} mm.` : `The daily limit is ${CRAB_LIMIT}.`}” $${FINE} fine.` }
  if (!good) return { ok: true, cash: RELEASE_PAY, why: !c.male ? 'A female: back she goes. Well spotted.' : c.mm < k.min ? `${k.min - c.mm} mm short: back to grow.` : 'Over the limit: back it goes.' }
  return { ok: false, cash: 0, why: `That was a keeper (${c.mm} mm, male).` }
}
