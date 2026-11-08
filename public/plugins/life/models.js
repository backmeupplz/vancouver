// Street-level models for the life plugin, drawn instead of the map's boxes within a stone's throw of a perspective
// camera (the drive plugin's chase view): cars with bevelled bodies, wheel arches, windows and wheels, people with
// heads, hands and an umbrella in the rain, and Vancouver-style traffic signals. Low-poly on purpose (a few hundred
// triangles a car), all flat-shaded through the same instanced shaders as the boxes (see index.js for the parts).
import { kit, under } from '../../core/kit.js'

const GLASS = 0x2b3a4a, DARK = 0x1c1e21, TYRE = 0x1d1f22, HUB = 0xb4b9bf, TRIM = 0x2c2f33, PLATE = 0xeeeee6
const HEAD = 0xfff2d0, TAIL = 0xb3121a, AMBER = 0xd88a1c

// a car body: one bevelled side profile (forward +x) whose sloping faces above the belt line are glass, the faces
// under it and inside the arches dark; side windows as thin panels on the leaning sides; wheels with hubs; lamps
function body(k, o) {
  const nar = (y) => 0.02 * (y - o.yb) + Math.max(0, y - o.belt) * (o.tumble ?? 0.26)
  k.c(null).prism(o.profile, -o.hw, o.hw, { bevel: o.bevel ?? 0.07, narrow: nar,
    edge: (i, nx, ny, y) => { if (y > o.belt && Math.abs(nx) > 0.4 && ny > 0.15) k.c(GLASS); else if (ny < -0.3) k.c(DARK) } })
  for (const w of o.windows) for (const s of [-1, 1]) {
    k.c(GLASS).prism(w, s > 0 ? o.hw - 0.04 : -o.hw - 0.012, s > 0 ? o.hw + 0.012 : -o.hw + 0.04, { bevel: 0.015, lean: (y) => -s * nar(y) })
  }
  for (const [x, r] of o.wheels) for (const s of [-1, 1]) {
    k.c(TYRE).wheel(x, r, s * (o.track - 0.1), r, 0.22, 10)
    k.c(HUB).wheel(x, r, s * (o.track + 0.02), r * 0.56, 0.03, 7)
  }
  return nar
}
// a pair of boxes mirrored across the car: x0..x1, y0..y1, |z| from z0 to z1
const pair = (k, x0, x1, y0, y1, z0, z1) => { k.box(x0, x1, y0, y1, z0, z1); k.box(x0, x1, y0, y1, -z1, -z0); return k }
// blinker lamps at the four corners (parts 7 left / 8 right: drawn only while blinking)
function blinkers(k, f, r, y, z) {
  for (const [part, s] of [[7, -1], [8, 1]]) { k.c(AMBER, part); k.box(f - 0.07, f + 0.01, y, y + 0.08, s > 0 ? z - 0.1 : -z, s > 0 ? z : -z + 0.1); k.box(r - 0.01, r + 0.07, y, y + 0.08, s > 0 ? z - 0.1 : -z, s > 0 ? z : -z + 0.1) }
}

function sedanish(k, hatch) {
  const L = hatch ? 2.2 : 2.27
  const profile = hatch
    ? [...under(-2.15, 2.15, 0.28, [[-1.32, 0.4], [1.32, 0.4]], 0.33), 2.2, 0.42, 2.19, 0.66, 1.9, 0.8, 1.0, 0.92, 0.28, 1.43, -1.72, 1.45, -2.12, 1.05, -2.2, 0.95, -2.2, 0.42]
    : [...under(-2.22, 2.22, 0.28, [[-1.38, 0.4], [1.38, 0.4]], 0.33), 2.27, 0.42, 2.26, 0.66, 1.95, 0.8, 1.05, 0.92, 0.3, 1.41, -0.85, 1.43, -1.6, 0.99, -2.15, 0.94, -2.27, 0.72, -2.25, 0.42]
  const windows = hatch
    ? [[-0.3, 0.99, 0.9, 0.99, 0.32, 1.34, -0.3, 1.35], [-1.62, 0.99, -0.42, 0.99, -0.42, 1.35, -1.66, 1.35]]
    : [[-0.32, 0.99, 0.95, 0.99, 0.36, 1.33, -0.32, 1.34], [-1.48, 0.99, -0.44, 0.99, -0.44, 1.34, -0.88, 1.35]]
  const wx = hatch ? 1.32 : 1.38
  body(k, { profile, hw: 0.9, yb: 0.28, belt: 0.93, windows, wheels: [[-wx, 0.33], [wx, 0.33]], track: 0.88 })
  k.c(HEAD, 2); pair(k, L - 0.15, L + 0.005, 0.58, 0.7, 0.5, 0.8)
  k.c(TAIL, 3); pair(k, -L - 0.02, -L + 0.1, hatch ? 0.78 : 0.72, hatch ? 0.94 : 0.86, 0.48, 0.82)
  k.c(DARK).box(L - 0.06, L + 0.02, 0.44, 0.58, -0.42, 0.42) // grille
  k.c(TRIM).box(L - 0.14, L + 0.03, 0.28, 0.44, -0.84, 0.84).box(-L - 0.03, -L + 0.14, 0.28, 0.44, -0.84, 0.84) // bumpers
  k.c(PLATE).box(L + 0.02, L + 0.04, 0.3, 0.42, -0.2, 0.2).box(-L - 0.045, -L - 0.025, 0.48, 0.6, -0.2, 0.2)
  k.c(null); pair(k, 0.86, 1.0, 0.92, 1.04, 0.82, 1.0) // mirrors
  blinkers(k, L, -L, 0.62, 0.88)
}
function suv(k) {
  const profile = [...under(-2.36, 2.36, 0.36, [[-1.5, 0.48], [1.5, 0.48]], 0.38), 2.42, 0.5, 2.41, 0.95, 2.05, 1.07, 1.25, 1.15, 0.5, 1.72, -2.15, 1.75, -2.38, 1.3, -2.42, 1.0, -2.42, 0.5]
  const windows = [[-0.35, 1.21, 1.12, 1.21, 0.55, 1.64, -0.35, 1.65], [-1.4, 1.21, -0.47, 1.21, -0.47, 1.65, -1.4, 1.65], [-2.15, 1.21, -1.52, 1.21, -1.52, 1.65, -2.05, 1.65]]
  body(k, { profile, hw: 0.95, yb: 0.36, belt: 1.15, tumble: 0.18, windows, wheels: [[-1.5, 0.38], [1.5, 0.38]], track: 0.92 })
  k.c(HEAD, 2); pair(k, 2.28, 2.425, 0.84, 0.97, 0.52, 0.86)
  k.c(TAIL, 3); pair(k, -2.44, -2.33, 0.98, 1.2, 0.55, 0.88)
  k.c(DARK).box(2.36, 2.44, 0.55, 0.82, -0.45, 0.45)
  k.c(TRIM).box(2.27, 2.47, 0.36, 0.55, -0.92, 0.92).box(-2.47, -2.27, 0.36, 0.55, -0.92, 0.92)
  k.c(PLATE).box(2.465, 2.485, 0.38, 0.5, -0.2, 0.2).box(-2.445, -2.425, 0.62, 0.74, -0.2, 0.2)
  k.c(TRIM); pair(k, -1.95, 0.25, 1.74, 1.8, 0.58, 0.64) // roof rails
  k.c(null); pair(k, 1.05, 1.2, 1.14, 1.27, 0.86, 1.04)
  blinkers(k, 2.42, -2.42, 0.86, 0.94)
}
function pickup(k) {
  const profile = [...under(-2.36, 2.36, 0.38, [[-1.55, 0.5], [1.5, 0.5]], 0.4), 2.42, 0.52, 2.41, 1.0, 2.0, 1.12, 1.3, 1.18, 0.62, 1.76, -0.3, 1.78, -0.42, 1.2, -2.42, 1.22, -2.42, 0.52]
  body(k, { profile, hw: 0.95, yb: 0.38, belt: 1.18, tumble: 0.18, windows: [[-0.28, 1.25, 1.17, 1.25, 0.66, 1.68, -0.28, 1.69]], wheels: [[-1.55, 0.4], [1.5, 0.4]], track: 0.92 })
  k.c(TRIM).box(-2.38, -0.48, 1.2, 1.255, -0.87, 0.87) // bed cover
  k.c(GLASS).box(-0.44, -0.4, 1.3, 1.68, -0.62, 0.62) // cab back window
  k.c(HEAD, 2); pair(k, 2.28, 2.425, 0.86, 0.99, 0.52, 0.86)
  k.c(TAIL, 3); pair(k, -2.44, -2.34, 0.85, 1.12, 0.7, 0.9)
  k.c(DARK).box(2.36, 2.44, 0.55, 0.85, -0.5, 0.5)
  k.c(0x9aa0a6).box(2.27, 2.48, 0.38, 0.56, -0.92, 0.92).box(-2.48, -2.3, 0.38, 0.56, -0.92, 0.92)
  k.c(PLATE).box(-2.445, -2.425, 0.62, 0.74, -0.2, 0.2)
  k.c(null); pair(k, 1.12, 1.26, 1.18, 1.31, 0.86, 1.04)
  blinkers(k, 2.42, -2.42, 0.88, 0.94)
}
function van(k) {
  const profile = [...under(-2.66, 2.66, 0.36, [[-1.85, 0.46], [1.75, 0.46]], 0.36), 2.72, 0.48, 2.7, 0.95, 2.3, 1.12, 1.6, 1.25, 1.0, 2.12, 0.75, 2.3, -2.6, 2.32, -2.72, 2.18, -2.72, 0.48]
  body(k, { profile, hw: 1.0, yb: 0.36, belt: 1.2, tumble: 0.03, bevel: 0.09, windows: [[0.35, 1.32, 1.47, 1.32, 1.05, 1.95, 0.35, 1.96]], wheels: [[-1.85, 0.36], [1.75, 0.36]], track: 0.96 })
  k.c(HEAD, 2); pair(k, 2.58, 2.715, 0.82, 0.98, 0.56, 0.9)
  k.c(TAIL, 3); pair(k, -2.745, -2.68, 0.9, 1.35, 0.8, 0.96)
  k.c(DARK).box(2.62, 2.72, 0.55, 0.82, -0.5, 0.5).box(-2.74, -2.71, 0.5, 2.12, -0.012, 0.012)
  k.c(TRIM).box(2.6, 2.79, 0.36, 0.55, -0.98, 0.98).box(-2.78, -2.6, 0.36, 0.55, -0.98, 0.98)
  k.c(GLASS); pair(k, -2.74, -2.71, 1.55, 2.0, 0.12, 0.84)
  k.c(PLATE).box(2.785, 2.8, 0.38, 0.5, -0.2, 0.2).box(-2.78, -2.76, 0.6, 0.72, -0.2, 0.2)
  k.c(DARK); pair(k, 1.2, 1.3, 1.65, 1.92, 1.0, 1.14) // mirrors
  blinkers(k, 2.72, -2.72, 0.85, 1.0)
}
function truck(k) { // a cab and a box
  const cab = [...under(2.45, 4.3, 0.5, [[3.3, 0.58]], 0.45), 4.35, 0.6, 4.35, 1.45, 4.25, 1.7, 4.02, 2.68, 3.85, 2.82, 2.45, 2.82, 2.45, 0.5]
  body(k, { profile: cab, hw: 1.15, yb: 0.5, belt: 1.6, tumble: 0.02, bevel: 0.08, windows: [[3.0, 1.62, 3.98, 1.62, 3.79, 2.55, 3.0, 2.56]], wheels: [[3.3, 0.45]], track: 1.0 })
  k.c(0xeeeee8).prism([-4.35, 0.95, 2.32, 0.95, 2.32, 3.7, -4.35, 3.7], -1.25, 1.25, { bevel: 0.05 })
  k.c(null).box(-4.25, 2.25, 2.95, 3.25, -1.262, 1.262) // a stripe in the cab's colour along the box
  k.c(0xd2d2cc).box(-4.38, -4.34, 1.02, 3.62, -1.15, 1.15) // roll door
  k.c(DARK).box(-4.3, 2.5, 0.42, 0.95, -0.85, 0.85)
  for (const x of [-3.2, -2.1]) for (const s of [-1, 1]) { k.c(TYRE).wheel(x, 0.45, s * 0.9, 0.45, 0.4, 10); k.c(HUB).wheel(x, 0.45, s * 1.11, 0.25, 0.03, 7) }
  k.c(0x9aa0a6).box(4.3, 4.45, 0.45, 0.78, -1.15, 1.15)
  k.c(DARK).box(4.33, 4.37, 0.85, 1.4, -0.6, 0.6) // grille
  k.c(HEAD, 2); pair(k, 4.3, 4.37, 0.88, 1.08, 0.68, 1.0)
  k.c(TAIL, 3); pair(k, -4.4, -4.34, 1.05, 1.3, 0.9, 1.15)
  k.c(DARK); pair(k, 3.8, 3.9, 1.9, 2.4, 1.15, 1.32)
  blinkers(k, 4.35, -4.35, 1.1, 1.15)
}

// the detailed cars, in the order DETAIL picks them from (kind, seed)
export function carModels(THREE) {
  const make = (fn) => { const k = kit(THREE); fn(k); return k.geometry() }
  return [
    make((k) => sedanish(k, false)), make((k) => sedanish(k, true)), make(suv), make(pickup), make(van), make(truck),
    make((k) => { sedanish(k, false); k.c(0xfaf6e8, 6).box(-0.45, 0.05, 1.42, 1.66, -0.3, 0.3); k.c(0x1d1f22); for (const s of [-1, 1]) k.box(-0.95, 0.95, 0.76, 0.82, s > 0 ? 0.88 : -0.9, s > 0 ? 0.905 : -0.885) }), // taxi
    make((k) => { sedanish(k, false); k.c(0x1c2b4a); for (const s of [-1, 1]) k.box(-0.95, 0.95, 0.5, 0.9, s > 0 ? 0.875 : -0.905, s > 0 ? 0.905 : -0.875)
      k.c(0xff2020, 4).box(-0.35, -0.05, 1.42, 1.56, -0.62, -0.02); k.c(0x2050ff, 5).box(-0.35, -0.05, 1.42, 1.56, 0.02, 0.62) }), // police
  ]
}
// which detailed model a car of a kind (sedan, suv, van, truck, taxi, police) with this seed is drawn as
export const DETAIL = (kind, seed) => (kind === 0 ? (seed < 0.62 ? 0 : 1) : kind === 1 ? (seed < 0.72 ? 2 : 3) : kind + 2)

// People, 1.75 m before the shader's scale, facing +x: hips at 0.86 and shoulders at 1.38 (the pivots the shader
// swings the legs and arms about: swing ±1 legs, ±2 arms). Parts: 0 shirt, 1 trousers, 2 skin, 3 hair, 4 fixed,
// 5 the shirt a shade darker, 6 an umbrella (only in the rain; its holder's arm is raised). Three outfits: a
// t-shirt with a backpack, a long coat with long hair, a hoodie with a beanie.
export function peopleModels(THREE) {
  const SHOE = 0x2a2a2e
  const make = (v) => {
    const k = kit(THREE)
    for (const s of [-1, 1]) { // legs: a tapered trouser leg and a shoe
      k.c(null, 1, s).box(-0.075, 0.075, 0.08, 0.9, s * 0.1 - 0.065, s * 0.1 + 0.065, 1.2, 1.25)
      k.c(SHOE, 4, s).box(-0.07, 0.15, 0, 0.09, s * 0.1 - 0.06, s * 0.1 + 0.06, 0.85)
    }
    k.c(null, 1).box(-0.1, 0.1, 0.82, 0.98, -0.17, 0.17) // hips
    if (v === 1) k.c(null, 0).box(-0.13, 0.13, 0.5, 1.0, -0.2, 0.2, 0.85, 0.92) // the coat's skirt
    // torso, seen from the front: waist up to broad shoulders, chamfered
    const t = k.at()
    k.c(null, 0).prism([-0.16, 0.95, 0.16, 0.95, 0.21, 1.33, 0.18, 1.43, -0.18, 1.43, -0.21, 1.33], -0.11, 0.12, { bevel: 0.03 })
    k.rot(t, 'y', Math.PI / 2)
    k.c(0xe2b48c, 2).box(-0.045, 0.045, 1.42, 1.5, -0.045, 0.045) // neck
    const h = k.at() // head: a bevelled block with a nose
    k.c(null, 2).prism([-0.1, 1.49, 0.09, 1.49, 0.115, 1.58, 0.105, 1.71, -0.09, 1.73, -0.11, 1.62], -0.092, 0.092, { bevel: 0.03 })
    k.box(0.1, 0.135, 1.58, 1.63, -0.018, 0.018)
    if (v === 2) k.c(null, 5).prism([-0.125, 1.63, 0.115, 1.66, 0.09, 1.78, -0.1, 1.79], -0.105, 0.105, { bevel: 0.035 }) // beanie
    else k.c(null, 3).prism(v === 1 ? [-0.135, 1.34, -0.12, 1.75, 0.06, 1.77, 0.125, 1.68, 0.0, 1.67, -0.07, 1.42] : [-0.125, 1.56, -0.115, 1.75, 0.07, 1.765, 0.125, 1.68, 0.0, 1.675, -0.07, 1.6], v === 1 ? -0.112 : -0.106, v === 1 ? 0.112 : 0.106, { bevel: 0.03 })
    void h
    if (v === 0) k.c(null, 5).box(-0.26, -0.11, 0.98, 1.36, -0.15, 0.15, 0.95) // backpack
    if (v === 2) k.c(null, 5).box(-0.17, -0.1, 1.3, 1.45, -0.15, 0.15) // hood
    for (const s of [-1, 1]) { // arms: sleeve, forearm (bare with the t-shirt), hand
      const z = s * 0.25
      k.c(null, 0, 2 * s).box(-0.055, 0.055, 1.08, 1.4, z - 0.055, z + 0.055, 1.15)
      k.c(v === 0 ? 0xe2b48c : null, v === 0 ? 2 : 0, 2 * s).box(-0.048, 0.048, 0.8, 1.1, z - 0.048, z + 0.048, 1.1)
      k.c(0xe2b48c, 2, 2 * s).box(-0.04, 0.05, 0.7, 0.81, z - 0.035, z + 0.035, 1.15)
    }
    // the umbrella, held in the right hand (z +0.25) raised forward: shaft and an eight-sided canopy
    k.c(0x2a2a2e, 6).box(0.37, 0.39, 0.85, 1.95, 0.24, 0.26)
    const u = k.at()
    k.c(null, 6).cyl(0.56, 0.05, 0.24, 8, 2)
    k.move(u, 0.2, 1.9, 0.1)
    return k.geometry()
  }
  return [0, 1, 2].map(make)
}

// A Vancouver signal pole, in the frame of its mast arm (+x, over the lanes; heads face -z, the oncoming traffic),
// origin at its foot: the pole, a near-side head and a pedestrian head on it, and a street-name blade on the arm.
// The arm (a unit long, scaled to each) and the overhead head (origin where it hangs from the arm) are their own
// models; LENSES are where the lit discs and pedestrian squares go, in those frames.
export const ARM_Y = 6.1
const SIG_POLE = 0x3a3e44, SIG_YELLOW = 0xd9a51e, SIG_BLACK = 0x1a1b1d, BLADE = 0x1f4f9a
function signalHead(k, x, y, z, plate) { // a three-lens head facing -z, top centre at (x, y, z): visors and a backplate
  k.c(SIG_YELLOW).prism([x - 0.17, y - 1.04, x + 0.17, y - 1.04, x + 0.17, y, x - 0.17, y], z - 0.13, z + 0.13, { bevel: 0.03 })
  if (plate) { k.c(SIG_YELLOW).box(x - 0.4, x + 0.4, y - 1.16, y + 0.08, z + 0.135, z + 0.155); k.c(SIG_BLACK).box(x - 0.37, x + 0.37, y - 1.13, y + 0.05, z + 0.11, z + 0.14) }
  k.c(SIG_BLACK)
  for (const c of [0.18, 0.52, 0.86]) {
    const arc = []
    for (let i = 0; i <= 6; i++) { const a = -0.35 + ((Math.PI + 0.7) * i) / 6; arc.push(x + Math.cos(a) * 0.16, y - c + Math.sin(a) * 0.16) }
    for (let i = 6; i >= 0; i--) { const a = -0.35 + ((Math.PI + 0.7) * i) / 6; arc.push(x + Math.cos(a) * 0.135, y - c + Math.sin(a) * 0.135) }
    k.prism(arc, z - 0.36, z - 0.13)
  }
}
export function signalModels(THREE) {
  const pole = kit(THREE)
  pole.c(SIG_POLE).cyl(0.2, 0.17, 0.45, 8).cyl(0.11, 0.085, ARM_Y + 0.4, 8)
  signalHead(pole, 0, 4.35, -0.27, false) // the near-side head, on the pole
  pole.c(SIG_POLE).box(-0.05, 0.05, 3.45, 4.2, -0.2, -0.08)
  pole.c(SIG_BLACK).prism([0.08, 2.6, 0.42, 2.6, 0.42, 3.05, 0.08, 3.05], -0.18, 0.18, { bevel: 0.02 }) // pedestrian head (faces +x)
  pole.c(0xf0f0ea).box(0.95, 2.65, ARM_Y + 0.17, ARM_Y + 0.53, -0.012, 0.012) // street-name blade: white border, blue face,
  pole.c(BLADE).box(0.98, 2.62, ARM_Y + 0.2, ARM_Y + 0.5, -0.022, 0.022)
  pole.c(0xf0f0ea) // and white words
  for (const [a, b] of [[1.08, 1.2], [1.28, 1.9], [1.98, 2.18], [2.3, 2.52]]) pole.box(a, b, ARM_Y + 0.31, ARM_Y + 0.39, -0.026, 0.026)
  pole.c(SIG_POLE).box(0.9, 0.96, ARM_Y + 0.05, ARM_Y + 0.55, -0.02, 0.02).box(2.62, 2.68, ARM_Y + 0.05, ARM_Y + 0.55, -0.02, 0.02)
  const arm = kit(THREE)
  const a = arm.at(); arm.c(SIG_POLE).cyl(0.09, 0.055, 1, 6, 1); arm.rot(a, 'z', -Math.PI / 2)
  const head = kit(THREE)
  head.c(SIG_POLE).box(-0.03, 0.03, -0.05, 0.08, -0.03, 0.03)
  signalHead(head, 0, -0.05, 0, true)
  return { pole: pole.geometry(true), arm: arm.geometry(true), head: head.geometry(true) }
}
// lit lenses: red, amber, green from the top, 0.14 in front of a head's centre line; [x, y, z] in its frame
export const LENSES = [0.18, 0.52, 0.86].map((c) => [0, -0.05 - c, -0.14])
export const POLE_LENSES = [0.18, 0.52, 0.86].map((c) => [0, 4.35 - c, -0.41])
export const PED_LENSES = [[0.425, 2.94, 0], [0.425, 2.71, 0]] // hand (top), walking person
