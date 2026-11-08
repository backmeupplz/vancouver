// The Rush Fare cabs and their drivers (taxi.js), low-poly in the kit's style like the van: six cabs, each with its
// own handling (van.js taxiSpec) and three liveries, and six drivers. makeCab(THREE, cab, livery, driver) builds one
// in the van's frame (forward -z, up +y, origin on the ground between the axles) with the van's userData (lights,
// wheels, night) plus exhausts ([x, y, z] where the nitro flames come out, pointing back +z), flame (its colour) and,
// in the open cabs, the driver at the wheel.
import { kit, under as arched, kitMaterial } from '../../core/kit.js'
import { lamps } from './van.js'
import { makeWalker } from './walker.js'

const DARK = 0x2b2e33, GLASS = 0x3d5568, CHROME = 0xd6dade, CREAM = 0xf6ead2, TYRE = 0x25272b, SEAT = 0x7a3b2e
// stats: vmax m/s, push, grip, mass kg, tank s of nitro; wb, hl, hw: wheelbase and the collision box; circles: vs buildings
export const CABS = [
  { id: 'sunbeam', name: 'Sunbeam ’74', blurb: 'A long yellow convertible from the disco years: fast on the straights, floaty in the bends.', open: true,
    stats: { vmax: 37, push: 10, grip: 0.9, mass: 1900, tank: 5, wb: 3.2, hl: 2.7, hw: 1.0, wheel: 0.36, circles: [[1.7, 0, -1.7], 1.1] }, flame: 0xff8a2a,
    liveries: [['Classic', 0xf5c518, 0x1d1d1d], ['Seawall mint', 0x9fe0c8, 0xf6ead2], ['Cherry', 0xd9352b, 0xf6ead2]] },
  { id: 'bluebox', name: 'Bluebox', blurb: 'The boxy minivan cab: slow to get going, grips like a limpet, a huge nitro tank.',
    stats: { vmax: 31, push: 9, grip: 1.08, mass: 2100, tank: 8, wb: 3.0, hl: 2.45, hw: 0.97, wheel: 0.35, circles: [[1.5, 0, -1.5], 1.05] }, flame: 0xff9a3a,
    liveries: [['Bluebox', 0x2e6fd8, 0xffd23a], ['Checker', 0xf5c518, 0x1d1d1d], ['Forest', 0x2f7d4f, 0xf6ead2]] },
  { id: 'kustom', name: 'Kingsway Kustom', blurb: 'A chopped hot-rod coupe with a blower through the hood: brutal off the line, twitchy at the back.',
    stats: { vmax: 36, push: 14, grip: 0.86, mass: 1350, tank: 4, wb: 2.8, hl: 2.2, hw: 0.9, wheel: 0.42, circles: [[1.3, 0, -1.3], 1.0] }, flame: 0x6aa8ff,
    liveries: [['Midnight flames', 0x22252c, 0xff7a1a], ['Candy apple', 0xc81d3a, 0xffd23a], ['Mustard', 0xe8b324, 0x1d1d1d]] },
  { id: 'zip', name: 'Zip', blurb: 'A three-wheeler that turns on a loonie: light, nimble, not much top end, nitro tops it up.', open: true,
    stats: { vmax: 27, push: 11, grip: 1.12, mass: 650, tank: 6, wb: 1.9, hl: 1.5, hw: 0.78, wheel: 0.28, circles: [[0.7, -0.7], 0.85], turnG: 2.0, lock: 0.7 }, flame: 0xffc23a,
    liveries: [['Marigold', 0xffb000, 0x2a9d8f], ['Lagoon', 0x2a9d8f, 0xffb000], ['Berry', 0xb5307a, 0xf6ead2]] },
  { id: 'stretch', name: 'Shaughnessy Stretch', blurb: 'Seven and a half metres of limo: a big top speed, turns like a ferry, shrugs off anything it hits.',
    stats: { vmax: 39, push: 10, grip: 0.95, mass: 2900, tank: 5, wb: 5.6, hl: 3.75, hw: 1.0, wheel: 0.36, circles: [[2.8, 1.4, 0, -1.4, -2.8], 1.1], lock: 0.5 }, flame: 0xff6a2a,
    liveries: [['Black tie', 0x1b1d22, 0xe8c45a], ['Pearl', 0xefeee8, 0x2b2e33], ['Yellow stretch', 0xf5c518, 0x1d1d1d]] },
  { id: 'drizzle', name: 'Drizzle EV', blurb: 'An electric hatch: all its pull from a standstill, quick to boost, a small battery for it.',
    stats: { vmax: 33, push: 16, grip: 1.0, mass: 1500, tank: 4.5, wb: 2.6, hl: 2.0, hw: 0.9, wheel: 0.33, circles: [[1.1, -1.1], 1.05], flat: 0.25 }, flame: 0x37e0ff,
    liveries: [['Rain cloud', 0x9fb4c4, 0x37e0ff], ['Lime', 0x9bd83a, 0x1d1d1d], ['Taxi yellow', 0xf5c518, 0x37e0ff]] },
]
// the drivers: who they are, how they look (shirt, pants, hair, skin, a hat or such: hat colour) and what they say
export const DRIVERS = [
  { id: 'dot', name: 'Dot Fairweather', bio: 'Retired rally champion, 71, back behind the wheel “for the fresh air”.', line: 'Seatbelt on, dear. I drive like it’s 1979.', shirt: 0xd2557a, pants: 0x3b4a5e, hair: 0xdedad2, skin: 0xf0c8a8, hat: 'scarf', acc: 0x5fb6c8 },
  { id: 'marlon', name: 'Marlon Okafor', bio: 'Twenty years a deckhand on the harbour ferries, now he takes the long way round by land.', line: 'Smooth sailing. Mostly.', shirt: 0x2f62b8, pants: 0x2b2e33, hair: 0x1d1612, skin: 0x7a4a30, hat: 'toque', acc: 0xe8735a },
  { id: 'priya', name: 'Priya Gill', bio: 'Knows every back lane from Kits to Commercial. Has opinions about all of them.', line: 'I know a shortcut. I always know a shortcut.', shirt: 0x2a9d8f, pants: 0x30343a, hair: 0x221a16, skin: 0xb07a52, hat: 'shades', acc: 0x15171a },
  { id: 'kenji', name: 'Kenji “Drizzle” Ito', bio: 'Has driven through every rainy season since 1998 and never once used an umbrella.', line: 'Wipers on, worries off.', shirt: 0xf2c94c, pants: 0x3b4a5e, hair: 0x14110f, skin: 0xe2b48c, hat: 'hood', acc: 0xf2c94c },
  { id: 'lou', name: 'Lou Tremblay', bio: 'Came out from Trois-Rivières for a weekend in 1986 and stayed. Always has gum.', line: 'Meter’s running, my friend!', shirt: 0xf6ead2, pants: 0x5a4636, hair: 0x6b5040, skin: 0xe8bc98, hat: 'cap', acc: 0x6b7a4a, tash: true },
  { id: 'zed', name: 'Zed', bio: 'Bike courier turned cabbie. Treats red lights as a personal challenge (stops anyway).', line: 'Lions Gate in four minutes flat.', shirt: 0x2b2e33, pants: 0x1d1d1d, hair: 0xff4fa8, skin: 0xd8a47e, hat: 'mohawk', acc: 0xff4fa8 },
]

// a part's geometry, built forward +x, turned to forward -z
const geo = (k) => k.geometry(true).rotateY(Math.PI / 2)
const ARCH = (wheels, cy) => (x0, x1, yb) => arched(x0, x1, yb, wheels, cy)
// a checkered band along both sides from x0 to x1 between y0 and y1, at half width w
function checker(k, x0, x1, y0, y1, w, a, b) {
  const n = Math.max(2, Math.round((x1 - x0) / (y1 - y0) * 2)), d = (x1 - x0) / n, h = (y1 - y0) / 2
  for (let i = 0; i < n; i++) for (let r = 0; r < 2; r++) k.c((i + r) % 2 ? a : b).box(x0 + i * d, x0 + (i + 1) * d, y0 + r * h, y0 + (r + 1) * h, -w, w)
}
// the roof sign, a lit box with TAXI on its sides
let signTex = null
function sign(THREE, night) {
  if (!signTex) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64
    const g = c.getContext('2d')
    g.fillStyle = '#ffe680'; g.fillRect(0, 0, 256, 64)
    g.fillStyle = '#1d1d1d'; g.font = 'bold 46px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('TAXI', 128, 35)
    signTex = new THREE.CanvasTexture(c); signTex.colorSpace = THREE.SRGBColorSpace; signTex.anisotropy = 4
  }
  const m = new THREE.MeshLambertMaterial({ map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.25 })
  m.userData.night = night
  return m
}

// each cab's body, in kit coordinates (forward +x, up +y, z across): returns { lamps: [head boxes, tail boxes],
// wheels: [[x across, z along (front -), r, front]], exhausts, seat ([x, y, z] in the final frame, open cabs), sign
// ([x, y, z, length]) }
const BODIES = {
  sunbeam(k, B, A) {
    const AR = [[1.6, 0.44], [-1.6, 0.44]], u = ARCH(AR, 0.36)
    k.c(B).prism([...u(-2.62, 2.62, 0.3), 2.68, 0.42, 2.7, 0.7, 2.5, 0.8, 0.95, 0.86, 0.8, 0.9, -1.5, 0.9, -1.8, 0.94, -2.55, 0.9, -2.7, 0.78, -2.7, 0.42], -0.98, 0.98,
      { bevel: 0.07, edge: (i, nx, ny) => { if (ny < -0.3) k.c(DARK) } })
    k.c(A).box(-2.66, 2.66, 0.62, 0.68, -0.99, 0.99) // the stripe
    k.c(0x3a2a26).box(-1.45, 0.78, 0.9, 0.905, -0.86, 0.86) // the cockpit floor
    k.c(CREAM).box(-0.5, 0.1, 0.9, 1.02, -0.84, 0.84).box(-0.62, -0.42, 0.9, 1.4, -0.84, 0.84, 0.9) // front bench and its back
    k.box(-1.42, -0.95, 0.9, 1.0, -0.84, 0.84).box(-1.5, -1.32, 0.9, 1.32, -0.84, 0.84, 0.9) // rear bench
    k.c(GLASS).prism([0.8, 0.88, 0.86, 0.9, 0.55, 1.38, 0.49, 1.36], -0.86, 0.86, { bevel: 0.01 }) // windscreen
    k.c(CHROME).box(0.47, 0.6, 1.34, 1.4, -0.88, 0.88).box(2.62, 2.78, 0.28, 0.46, -1.0, 1.0).box(-2.78, -2.62, 0.3, 0.46, -1.0, 1.0) // its top, bumpers
    k.c(DARK).box(2.66, 2.72, 0.48, 0.72, -0.62, 0.62); k.c(CHROME); for (let z = -0.5; z <= 0.5; z += 0.2) k.box(2.7, 2.73, 0.5, 0.7, z - 0.02, z + 0.02)
    k.c(DARK).wheel(0.35, 1.12, -0.42, 0.18, 0.04, 10, 'x') // the steering wheel
    k.c(CHROME).box(2.3, 2.42, 0.86, 0.94, -0.03, 0.03) // a hood ornament
    k.c(DARK).box(0.82, 0.92, 0.2, 0.86, -0.995, 0.995) // door seams
    return { lamps: [[[2.62, 2.72, 0.56, 0.7, 0.62, 0.9], [2.62, 2.72, 0.56, 0.7, -0.9, -0.62]], [[-2.73, -2.66, 0.55, 0.72, 0.6, 0.92], [-2.73, -2.66, 0.55, 0.72, -0.92, -0.6]]],
      wheels: [[-0.86, -1.6, 0.36, true], [0.86, -1.6, 0.36, true], [-0.86, 1.6, 0.36], [0.86, 1.6, 0.36]], exhausts: [[-0.55, 0.3, 2.72], [0.55, 0.3, 2.72]],
      seat: [-0.42, 1.0, 0.18], sign: [-2.15, 0.94, 0, 0.7] }
  },
  bluebox(k, B, A) {
    const AR = [[1.5, 0.44], [-1.5, 0.44]], u = ARCH(AR, 0.35)
    k.c(B).prism([...u(-2.4, 2.4, 0.3), 2.44, 0.42, 2.46, 0.82, 2.32, 0.98, 1.6, 1.12, 0.9, 1.86, 0.65, 1.94, -2.25, 1.95, -2.42, 1.82, -2.44, 0.42], -0.96, 0.96,
      { bevel: 0.08, edge: (i, nx, ny, y) => { if (y > 1.15 && nx > 0.4 && ny > 0.15 && ny < 0.8) k.c(GLASS); else if (ny < -0.3) k.c(DARK) } })
    checker(k, -2.3, 2.3, 0.92, 1.08, 0.975, A, 0xf6f3ea)
    k.c(GLASS); for (const s of [-1, 1]) k.box(-2.2, 0.75, 1.22, 1.78, s * 0.95, s * 0.975)
    k.c(B); for (const x of [-1.15, -0.25]) k.box(x - 0.06, x + 0.06, 1.2, 1.8, -0.985, 0.985) // pillars
    k.c(DARK).box(-0.32, -0.28, 0.4, 1.8, -0.99, 0.99) // the sliding door's seam
    k.c(GLASS).box(-2.46, -2.42, 1.2, 1.75, -0.8, 0.8)
    k.c(DARK).box(2.4, 2.56, 0.28, 0.5, -0.97, 0.97).box(-2.56, -2.4, 0.28, 0.5, -0.97, 0.97).box(2.44, 2.48, 0.6, 0.8, -0.5, 0.5)
    k.c(0x8a8f96); for (const s of [-1, 1]) k.box(-2.0, 0.5, 1.95, 2.0, s * 0.68, s * 0.74) // roof rails
    return { lamps: [[[2.42, 2.49, 0.82, 0.96, 0.55, 0.88], [2.42, 2.49, 0.82, 0.96, -0.88, -0.55]], [[-2.47, -2.42, 0.95, 1.4, 0.72, 0.9], [-2.47, -2.42, 0.95, 1.4, -0.9, -0.72]]],
      wheels: [[-0.84, -1.5, 0.35, true], [0.84, -1.5, 0.35, true], [-0.84, 1.5, 0.35], [0.84, 1.5, 0.35]], exhausts: [[0.6, 0.3, 2.48]], sign: [-0.6, 1.95, 0, 0.75] }
  },
  kustom(k, B, A) {
    const u = (x0, x1, yb) => arched(x0, x1, yb, [[1.45, 0.4], [-1.35, 0.52]], 0.4)
    k.c(B).prism([...u(-2.15, 2.12, 0.32), 2.16, 0.42, 2.16, 0.7, 1.92, 0.82, 0.55, 0.9, 0.2, 1.3, -0.9, 1.34, -1.6, 0.98, -2.1, 0.86, -2.18, 0.5], -0.88, 0.88,
      { bevel: 0.07, edge: (i, nx, ny, y) => { if (y > 0.95 && Math.abs(nx) > 0.3 && Math.abs(ny) > 0.2 && Math.abs(ny) < 0.95) k.c(GLASS); else if (ny < -0.3) k.c(DARK) } })
    k.c(GLASS); for (const s of [-1, 1]) k.box(-1.1, 0.15, 0.98, 1.24, s * 0.875, s * 0.89)
    k.c(A); for (const s of [-1, 1]) { // flames licking back along the sides
      for (const [x, l, y] of [[1.95, 1.3, 0.7], [1.9, 0.95, 0.6], [1.85, 1.15, 0.5]]) k.prism([x, y - 0.05, x, y + 0.05, x - l, y], s * 0.885, s * 0.895)
    }
    k.c(CHROME).box(0.9, 1.45, 0.8, 1.1, -0.28, 0.28, 0.85) // the blower through the hood
    k.c(DARK).box(1.0, 1.35, 1.1, 1.26, -0.2, 0.2, 0.8)
    k.c(CHROME).box(1.95, 2.25, 0.28, 0.44, -0.86, 0.86).box(-2.25, -2.1, 0.3, 0.44, -0.86, 0.86) // bumpers
    k.c(DARK).box(2.12, 2.18, 0.46, 0.72, -0.45, 0.45)
    k.c(CHROME); for (const s of [-1, 1]) k.wheel(0.1, 0.33, s * 0.93, 0.06, 1.6, 8, 'x') // side pipes
    return { lamps: [[[2.0, 2.18, 0.72, 0.84, 0.5, 0.78], [2.0, 2.18, 0.72, 0.84, -0.78, -0.5]], [[-2.2, -2.14, 0.6, 0.76, 0.55, 0.8], [-2.2, -2.14, 0.6, 0.76, -0.8, -0.55]]],
      wheels: [[-0.8, -1.45, 0.33, true], [0.8, -1.45, 0.33, true], [-0.84, 1.35, 0.44], [0.84, 1.35, 0.44]], exhausts: [[-0.93, 0.33, 0.72], [0.93, 0.33, 0.72]], sign: [-0.4, 1.33, 0, 0.6] }
  },
  zip(k, B, A) {
    k.c(B).prism([-1.4, 0.32, 0.72, 0.32, 0.8, 0.5, 0.8, 0.9, -1.35, 0.92, -1.45, 0.75], -0.66, 0.66, { bevel: 0.06 }) // the tub
    k.c(B).prism([0.7, 0.62, 1.3, 0.6, 1.5, 0.8, 1.42, 1.08, 1.1, 1.22, 0.7, 1.22], -0.4, 0.4, { bevel: 0.06 }) // the nose
    k.c(A).box(-1.42, 0.78, 0.56, 0.64, -0.67, 0.67)
    k.c(GLASS).prism([1.0, 1.2, 1.12, 1.2, 1.02, 1.78, 0.92, 1.78], -0.6, 0.6)
    k.c(A).box(-1.5, 1.05, 1.8, 1.9, -0.76, 0.76).box(-1.45, 1.0, 1.9, 1.95, -0.7, 0.7) // the canopy
    k.c(DARK); for (const [x, s] of [[0.95, -1], [0.95, 1], [-1.35, -1], [-1.35, 1]]) k.box(x - 0.04, x + 0.04, 0.9, 1.82, s * 0.64 - 0.03, s * 0.64 + 0.03)
    k.c(SEAT).box(0.2, 0.6, 0.9, 1.0, -0.3, 0.3).box(-1.3, -0.5, 0.9, 1.02, -0.6, 0.6).box(-1.35, -1.2, 0.9, 1.45, -0.6, 0.6) // seats
    k.c(DARK).rod([0.95, 1.3, -0.3], [0.95, 1.3, 0.3], 0.025).rod([1.1, 1.0, 0], [0.95, 1.3, 0], 0.03) // handlebars
    k.c(DARK); for (const s of [-1, 1]) k.box(-1.15, -0.55, 0.62, 0.66, s * 0.66, s * 0.9).box(-1.15, -0.55, 0.62, 0.68, s * 0.84, s * 0.9) // fenders
    k.c(DARK).box(1.15, 1.45, 0.45, 0.52, -0.12, 0.12) // the front fork's mudguard
    return { lamps: [[[1.42, 1.5, 0.82, 0.98, -0.12, 0.12]], [[-1.47, -1.43, 0.6, 0.75, 0.42, 0.6], [-1.47, -1.43, 0.6, 0.75, -0.6, -0.42]]],
      wheels: [[0, -1.25, 0.28, true], [-0.76, 0.85, 0.28], [0.76, 0.85, 0.28]], exhausts: [[0.3, 0.32, 1.48]], seat: [0, 0.98, -0.42], sign: [-0.2, 1.95, 0, 0.6] }
  },
  stretch(k, B, A) {
    const AR = [[2.8, 0.44], [-2.8, 0.44]], u = ARCH(AR, 0.36)
    k.c(B).prism([...u(-3.72, 3.72, 0.3), 3.76, 0.42, 3.78, 0.72, 3.55, 0.84, 2.4, 0.92, 1.75, 1.42, -3.0, 1.45, -3.45, 1.02, -3.76, 0.92, -3.78, 0.42], -0.98, 0.98,
      { bevel: 0.07, edge: (i, nx, ny, y) => { if (y > 0.95 && Math.abs(nx) > 0.3 && Math.abs(ny) > 0.2 && Math.abs(ny) < 0.95) k.c(GLASS); else if (ny < -0.3) k.c(DARK) } })
    k.c(GLASS); for (const s of [-1, 1]) k.box(-3.1, 1.6, 0.98, 1.32, s * 0.97, s * 0.99)
    k.c(A).box(-3.74, 3.74, 0.8, 0.84, -0.995, 0.995) // pinstripe
    k.c(B); for (const x of [-1.5, 0.1, 1.15]) k.box(x - 0.05, x + 0.05, 0.96, 1.4, -1.0, 1.0)
    k.c(CHROME).box(3.7, 3.86, 0.28, 0.46, -0.98, 0.98).box(-3.86, -3.7, 0.3, 0.46, -0.98, 0.98).box(3.76, 3.8, 0.5, 0.74, -0.5, 0.5)
    k.c(DARK); for (let z = -0.42; z <= 0.42; z += 0.12) k.box(3.79, 3.81, 0.52, 0.72, z - 0.02, z + 0.02)
    return { lamps: [[[3.72, 3.8, 0.56, 0.7, 0.6, 0.9], [3.72, 3.8, 0.56, 0.7, -0.9, -0.6]], [[-3.8, -3.74, 0.6, 0.86, 0.66, 0.92], [-3.8, -3.74, 0.6, 0.86, -0.92, -0.66]]],
      wheels: [[-0.86, -2.8, 0.36, true], [0.86, -2.8, 0.36, true], [-0.86, 2.8, 0.36], [0.86, 2.8, 0.36]], exhausts: [[-0.55, 0.3, 3.82], [0.55, 0.3, 3.82]], sign: [-1.2, 1.45, 0, 0.75] }
  },
  drizzle(k, B, A) {
    const AR = [[1.3, 0.42], [-1.3, 0.42]], u = ARCH(AR, 0.33)
    k.c(B).prism([...u(-1.92, 1.92, 0.3), 1.96, 0.42, 1.98, 0.7, 1.75, 0.86, 1.1, 0.96, 0.35, 1.55, -1.3, 1.6, -1.85, 1.38, -1.95, 0.9, -1.96, 0.42], -0.9, 0.9,
      { bevel: 0.1, edge: (i, nx, ny, y) => { if (y > 1.0 && Math.abs(nx) > 0.3 && Math.abs(ny) > 0.2 && Math.abs(ny) < 0.95) k.c(GLASS); else if (ny < -0.3) k.c(DARK) } })
    k.c(GLASS); for (const s of [-1, 1]) k.box(-1.6, 0.4, 1.0, 1.45, s * 0.89, s * 0.905)
    k.c(DARK).box(-1.96, 1.96, 0.3, 0.46, -0.91, 0.91) // cladding
    k.c(A).box(-1.9, 1.9, 0.47, 0.52, -0.915, 0.915)
    k.c(DARK).box(-0.45, -0.42, 0.5, 1.5, -0.91, 0.91)
    return { lamps: [[[1.86, 1.98, 0.74, 0.8, -0.82, 0.82]], [[-1.98, -1.93, 0.95, 1.02, -0.85, 0.85]]],
      wheels: [[-0.8, -1.3, 0.33, true], [0.8, -1.3, 0.33, true], [-0.8, 1.3, 0.33], [0.8, 1.3, 0.33]], exhausts: [[-0.45, 0.4, 1.98], [0.45, 0.4, 1.98]], sign: [-0.5, 1.6, 0, 0.6] }
  },
}

// a driver: the courier's model in their own clothes, with their hat (or shades, hood, mohawk)
export function makeDriver(THREE, d) {
  const w = makeWalker(THREE, d.shirt, { pants: d.pants, hair: d.hair, skin: d.skin, courier: false })
  const k = kit(THREE), a = d.acc
  if (d.hat === 'toque') k.c(a).box(-0.14, 0.12, 0.06, 0.21, -0.125, 0.125, 0.82).c(0xf6ead2).box(-0.05, 0.05, 0.2, 0.28, -0.05, 0.05)
  else if (d.hat === 'shades') k.c(a).box(0.105, 0.14, 0.0, 0.055, -0.105, 0.105).box(-0.02, 0.11, 0.025, 0.04, -0.118, 0.118)
  else if (d.hat === 'cap') k.c(a).prism([-0.14, 0.06, 0.13, 0.06, 0.1, 0.15, -0.12, 0.15], -0.122, 0.122, { bevel: 0.03 }).box(0.08, 0.22, 0.05, 0.075, -0.11, 0.11)
  else if (d.hat === 'scarf') k.c(a).prism([-0.14, -0.04, 0.06, 0.1, 0.1, 0.15, -0.12, 0.165], -0.126, 0.126, { bevel: 0.03 }).box(-0.2, -0.12, -0.08, 0.0, -0.03, 0.03)
  else if (d.hat === 'hood') k.c(a).box(-0.17, 0.06, -0.14, 0.2, -0.14, 0.14, 0.9)
  else if (d.hat === 'mohawk') k.c(a).box(-0.13, 0.09, 0.1, 0.27, -0.025, 0.025, 0.8)
  if (d.tash) k.c(d.hair).box(0.115, 0.14, -0.075, -0.05, -0.055, 0.055)
  const m = new THREE.Mesh(geo(k), w.userData.head.children[0].material)
  w.userData.head.add(m)
  return w
}
// sitting at the wheel: legs forward, hands on it
export function seat(w) {
  const { legs, arms, body, head } = w.userData
  for (const l of legs) l.rotation.x = 1.45
  for (const a of arms) { a.rotation.x = 0.95; a.rotation.z = 0 }
  body.position.y = 0; body.rotation.x = 0.08; head.rotation.x = 0
}

// cab: one of CABS; livery: its index; driver: one of DRIVERS (sits in an open cab)
export function makeCab(THREE, cab, livery = 0, driver = null) {
  const g = new THREE.Group(), night = { value: 0 }, [, B, A] = cab.liveries[livery] || cab.liveries[0]
  const k = kit(THREE), o = BODIES[cab.id](k, B, A)
  const add = (geom, m) => { const x = new THREE.Mesh(geom, m); g.add(x); return x }
  add(geo(k), kitMaterial(THREE, night))
  const [headL, tailL] = lamps(THREE, night), hl = kit(THREE), tl = kit(THREE)
  for (const b of o.lamps[0]) hl.c(0xffffff).box(...b)
  for (const b of o.lamps[1]) tl.c(0xffffff).box(...b)
  add(geo(hl), headL); add(geo(tl), tailL)
  const [sx, sy, sz, sl] = o.sign, s = add(new THREE.BoxGeometry(0.28, 0.24, sl), sign(THREE, night)) // (across, up, along: the text on its long sides)
  s.position.set(sz, sy + 0.14, -sx)
  const stalk = kit(THREE); stalk.c(DARK).box(sx - sl * 0.3, sx + sl * 0.3, sy - 0.01, sy + 0.03, -0.1, 0.1); add(geo(stalk), kitMaterial(THREE, night))
  const wheels = []
  for (const [x, z, r, front] of o.wheels) {
    const w = kit(THREE), side = Math.sign(x) || 1, wd = r * 0.62
    w.c(TYRE).wheel(0, 0, 0, r, wd, 12, 'x').c(cab.id === 'sunbeam' ? 0xf3f0e6 : 0xd8d8d2).wheel(side * (wd / 2 + 0.005), 0, 0, r * 0.6, 0.02, 10, 'x').c(CHROME).wheel(side * (wd / 2 + 0.015), 0, 0, r * 0.25, 0.02, 6, 'x')
    const steer = new THREE.Group(); steer.position.set(x, r, z)
    const spin = new THREE.Group(); spin.add(new THREE.Mesh(w.geometry(true), kitMaterial(THREE, night)))
    steer.add(spin); g.add(steer)
    wheels.push({ steer, spin, front: !!front })
  }
  if (driver && o.seat) {
    const d = makeDriver(THREE, driver)
    seat(d); d.position.set(o.seat[0], o.seat[1] - 0.88, o.seat[2])
    g.add(d); g.userData.driver = d
  }
  g.traverse((m) => { if (m.isMesh) { m.receiveShadow = true; m.castShadow = false } })
  Object.assign(g.userData, { lights: [headL, tailL], wheels, night, exhausts: o.exhausts, flame: cab.flame, sign: s.material })
  return g
}
