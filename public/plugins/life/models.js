// Street-level models for the life plugin: the fleet (cars, vans, trucks, emergency vehicles: a detailed model of
// each near a camera, a cheaper one of each kind beyond), people in several outfits (a dog on a lead, a stroller, an
// umbrella in the rain), cyclists on real bikes, and Vancouver-style traffic signals. Low-poly on purpose (under a
// thousand triangles a car, a couple of hundred far away), flat-shaded through one instanced shader (lifeMaterial).
// No real liveries: the taxi, police, ambulance, fire and car-share markings are generic.
import { kit, under, SHADE } from '../../core/kit.js'

const GLASS = 0x2b3a4a, DARK = 0x1c1e21, TYRE = 0x1d1f22, HUB = 0xb4b9bf, TRIM = 0x2c2f33, PLATE = 0xeeeee6
const HEAD = 0xfff2d0, TAIL = 0xb3121a, AMBER = 0xd88a1c, WHITE = 0xf2f2ee, STEEL = 0x9aa0a6

// ---------------------------------------------------------------- cars
// the part of polygon p ([x, y] points) where nx * x + ny * y >= c
function clip(p, nx, ny, c) {
  const out = []
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], da = nx * a[0] + ny * a[1] - c, db = nx * b[0] + ny * b[1] - c
    if (da >= 0) out.push(a)
    if (da * db < 0) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) }
  }
  return out
}
// a convex polygon moved in by d on every side
function inset(p, d) {
  let area = 0
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; area += a[0] * b[1] - b[0] * a[1] }
  const g = area < 0 ? [...p].reverse() : p
  let q = g
  for (let i = 0; i < g.length; i++) {
    const a = g[i], b = g[(i + 1) % g.length], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy)
    if (l > 1e-6) q = clip(q, -dy / l, dx / l, (-dy * a[0] + dx * a[1]) / l + d)
  }
  return q
}
// flat faces, one-sided: on a car's side s (±1) at |z| = zf(y); across the car facing d (±1) at x
function side(k, s, pts, zf) {
  const p = s > 0 ? pts : [...pts].reverse(), v = p.map(([x, y]) => [x, y, s * zf(y)])
  for (let i = 1; i < v.length - 1; i++) k.tri(v[0], v[i], v[i + 1])
}
const rect = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
function face(k, d, x, y0, y1, z0, z1) { if (d > 0) k.quad([x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]); else k.quad([x, y0, z1], [x, y1, z1], [x, y1, z0], [x, y0, z0]) }
// a pair of boxes mirrored across the car: x0..x1, y0..y1, |z| from z0 to z1
const pair = (k, x0, x1, y0, y1, z0, z1) => { k.box(x0, x1, y0, y1, z0, z1); k.box(x0, x1, y0, y1, -z1, -z0); return k }
// wheels on an axle at x: tyres with a rim and a cap (lod: one block across); dual: two tyres a side
function axle(k, x, r, track, lod, dual = false) {
  const w = dual ? 0.44 : 0.22
  if (lod) return k.c(TYRE).box(x - r * 0.9, x + r * 0.9, 0, r * 1.9, -track, track)
  for (const s of [-1, 1]) {
    k.c(TYRE).wheel(x, r, s * (track - w / 2), r, w, 10)
    k.c(HUB).wheel(x, r, s * (track + 0.004), r * 0.6, 0.02, 8).c(TRIM).wheel(x, r, s * (track + 0.016), r * 0.2, 0.02, 5)
  }
}
// lamps: head (part 2) and tail (part 3) as [y0, y1, z0, z1], blinkers (parts 7 left / 8 right: drawn only while
// blinking) at the corners at height y
function lamps(k, f, r, o, lod) {
  const put = (x, d, [y0, y1, z0, z1]) => { if (lod) { face(k, d, x + d * 0.012, y0, y1, z0, z1); face(k, d, x + d * 0.012, y0, y1, -z1, -z0) } else pair(k, x - (d > 0 ? 0.12 : 0.01), x + (d > 0 ? 0.01 : 0.12), y0, y1, z0, z1) }
  k.c(HEAD, 2); put(f, 1, o.head)
  k.c(TAIL, 3); put(r, -1, o.tail)
  const y = o.blink ?? o.head[0], z = o.head[3]
  for (const [part, s] of [[7, -1], [8, 1]]) {
    k.c(AMBER, part)
    const z0 = s > 0 ? z - 0.14 : -z, z1 = s > 0 ? z : -z + 0.14
    if (lod) { face(k, 1, f + 0.02, y, y + 0.1, z0, z1); face(k, -1, r - 0.02, y, y + 0.1, z0, z1) } else { k.box(f - 0.07, f + 0.02, y, y + 0.08, z0, z1); k.box(r - 0.02, r + 0.07, y, y + 0.08, z0, z1) }
  }
}
// A car (forward +x) from its side profile. o.top: the profile from the front bumper's foot over the roof to the rear
// one's (x, y pairs); under it the floor at o.yb with the wheel arches. Below o.belt the body (o.paint, or the
// instance's colour), above it the greenhouse: its sloping ends are glass (below o.glassTop; o.blindRear: not the
// rear), its sides lean in (o.tumble) and carry the side windows (o.panes: [x0, x1] each, cut from the greenhouse's
// outline moved in by a pillar's width). Both are extruded with flat sides, so panes and markings lie on them.
// o.wheels: [x, radius] each; o.head / o.tail: lamps; lod: the far model (no bevels, hubs, mirrors or trim).
// Returns { f, r, lo(y), hi(y) }: the ends and the sides' |z| at height y, for markings (side()).
function car(k, o, lod = false) {
  const { hw, yb, belt, tumble = 0.2, top, wheels, paint = null } = o
  const f = top[0], r = top[top.length - 2], bev = lod ? 0 : (o.bevel ?? 0.07), track = o.track ?? hw - 0.03
  const line = [...under(r + 0.05, f - 0.05, yb, wheels.map(([x, wr]) => [x, wr + 0.09]), wheels[0][1], lod ? 2 : 5), ...top], poly = []
  for (let i = 0; i < line.length; i += 2) poly.push([line[i], line[i + 1]])
  const nar1 = (y) => 0.02 * (y - yb), nar2 = (y) => nar1(belt) + (y - belt) * tumble
  const lo = (y) => hw - nar1(y) + 0.012, hi = (y) => hw - nar2(y) + 0.012
  k.c(paint).prism(clip(poly, 0, -1, -belt).flat(), -hw, hw, { bevel: bev, narrow: nar1, edge: (i, nx, ny) => { if (ny < -0.3) k.c(DARK) } })
  const green = clip(poly, 0, 1, belt)
  k.c(paint).prism(green.flat(), -hw, hw, { bevel: bev, narrow: nar2, edge: (i, nx, ny, y) => {
    if (ny > -0.5 && (ny < 0.93 || o.glassRoof) && y < (o.glassTop ?? 9) && !(o.blindRear && nx < 0)) k.c(GLASS)
  } })
  if (o.panes) {
    let g = inset(green, lod ? 0.09 : 0.075)
    if (o.glassTop) g = clip(g, 0, -1, -o.glassTop)
    k.c(GLASS)
    for (const [x0, x1] of o.panes) { const p = clip(clip(g, 1, 0, x0), -1, 0, -x1); if (p.length > 2) for (const s of [-1, 1]) side(k, s, p, hi) }
  }
  for (const [x, wr] of wheels) axle(k, x, wr, track, lod)
  lamps(k, f, r, o, lod)
  if (!lod) {
    if (o.grille) k.c(DARK).box(f - 0.06, f + 0.015, o.grille[0], o.grille[1], -o.grille[2], o.grille[2])
    k.c(o.bumper ?? TRIM).box(f - 0.16, f + 0.03, yb, yb + 0.15, -hw + 0.06, hw - 0.06).box(r - 0.03, r + 0.16, yb, yb + 0.15, -hw + 0.06, hw - 0.06)
    k.c(PLATE).box(f + 0.03, f + 0.045, yb + 0.02, yb + 0.13, -0.2, 0.2).box(r - 0.045, r - 0.03, o.plate ?? yb + 0.3, (o.plate ?? yb + 0.3) + 0.12, -0.2, 0.2)
    if (o.mirror) { k.c(o.mirrorPaint ?? paint); pair(k, o.mirror, o.mirror + 0.13, belt - 0.03, belt + 0.1, hw - 0.1, hw + 0.11) }
    k.c(DARK)
    for (const x of o.seams || []) for (const s of [-1, 1]) side(k, s, rect(x, x + 0.022, yb + 0.14, belt - 0.09), lo)
    for (const x of o.handles || []) for (const s of [-1, 1]) side(k, s, rect(x, x + 0.16, belt - 0.2, belt - 0.16), (y) => lo(y) + 0.004)
  }
  return { f, r, lo, hi }
}

const SEDAN = { hw: 0.9, yb: 0.26, belt: 1.04, tumble: 0.24, top: [2.27, 0.42, 2.27, 0.7, 2.2, 0.86, 1.25, 1.0, 0.5, 1.42, -0.75, 1.44, -1.55, 1.02, -2.15, 0.99, -2.27, 0.88, -2.27, 0.42],
  wheels: [[-1.38, 0.33], [1.38, 0.33]], panes: [[-1.5, -0.42], [-0.3, 1.3]], head: [0.66, 0.79, 0.48, 0.86], tail: [0.78, 0.94, 0.46, 0.86], grille: [0.44, 0.62, 0.44], mirror: 0.88, seams: [0.9, -0.36], handles: [-0.28, -1.2] }
const HATCH = { hw: 0.9, yb: 0.26, belt: 1.05, tumble: 0.22, top: [2.15, 0.42, 2.15, 0.72, 2.07, 0.88, 1.25, 1.02, 0.55, 1.48, -1.4, 1.5, -1.98, 1.08, -2.15, 0.92, -2.15, 0.42],
  wheels: [[-1.3, 0.32], [1.3, 0.32]], panes: [[-2.0, -1.44], [-1.36, -0.4], [-0.3, 1.3]], head: [0.68, 0.82, 0.46, 0.86], tail: [0.84, 1.04, 0.5, 0.86], grille: [0.44, 0.64, 0.4], mirror: 0.9, seams: [0.84, -0.34], handles: [-0.26, -1.2] }
const EV = { hw: 0.92, yb: 0.24, belt: 1.05, tumble: 0.26, glassRoof: true, top: [2.27, 0.4, 2.27, 0.68, 2.15, 0.86, 1.4, 1.0, 0.6, 1.42, -0.3, 1.46, -1.72, 1.03, -2.2, 0.98, -2.27, 0.84, -2.27, 0.4],
  wheels: [[-1.42, 0.35], [1.42, 0.35]], panes: [[-1.6, -0.4], [-0.3, 1.4]], head: [0.72, 0.8, 0.36, 0.88], tail: [0.88, 0.95, 0.0, 0.88], blink: 0.58, mirror: 0.95, seams: [0.92, -0.34], bumper: DARK }
const SHARE = { hw: 0.86, yb: 0.26, belt: 1.02, tumble: 0.2, paint: WHITE, top: [2.0, 0.42, 2.0, 0.7, 1.9, 0.86, 1.25, 1.0, 0.7, 1.5, -1.45, 1.52, -1.9, 1.05, -2.0, 0.9, -2.0, 0.42],
  wheels: [[-1.2, 0.31], [1.2, 0.31]], panes: [[-1.9, -1.3], [-1.22, -0.28], [-0.18, 1.3]], head: [0.64, 0.78, 0.44, 0.82], tail: [0.8, 1.0, 0.48, 0.82], grille: [0.42, 0.6, 0.36], mirror: 0.95, mirrorPaint: 0x16a394, seams: [0.78, -0.22] }
const SUV = { hw: 0.95, yb: 0.34, belt: 1.22, tumble: 0.16, top: [2.42, 0.5, 2.42, 0.98, 2.3, 1.1, 1.35, 1.2, 0.62, 1.7, -1.9, 1.72, -2.36, 1.24, -2.42, 1.05, -2.42, 0.5],
  wheels: [[-1.5, 0.38], [1.5, 0.38]], panes: [[-2.3, -1.5], [-1.4, -0.42], [-0.32, 1.4]], head: [0.84, 0.98, 0.5, 0.9], tail: [0.98, 1.2, 0.56, 0.9], grille: [0.56, 0.84, 0.46], mirror: 1.02, seams: [0.95, -0.36], handles: [-0.28, -1.3], plate: 0.66 }
const PICKUP = { hw: 0.95, yb: 0.38, belt: 1.24, tumble: 0.16, top: [2.42, 0.52, 2.42, 1.04, 2.28, 1.16, 1.35, 1.22, 0.72, 1.76, -0.85, 1.78, -0.95, 1.22, -2.42, 1.22, -2.42, 0.52],
  wheels: [[-1.55, 0.4], [1.5, 0.4]], panes: [[-0.9, -0.14], [-0.04, 1.4]], head: [0.88, 1.02, 0.52, 0.9], tail: [0.86, 1.14, 0.72, 0.9], grille: [0.56, 0.88, 0.5], mirror: 1.08, seams: [0.98, -0.1, -0.98], handles: [-0.02, -0.8], bumper: STEEL, plate: 0.64 }
const MINIVAN = { hw: 0.96, yb: 0.3, belt: 1.14, tumble: 0.14, top: [2.42, 0.45, 2.42, 0.82, 2.28, 1.0, 1.7, 1.12, 0.85, 1.7, -2.15, 1.74, -2.42, 1.25, -2.42, 0.45],
  wheels: [[-1.5, 0.35], [1.55, 0.35]], panes: [[-2.4, -1.55], [-1.45, -0.3], [-0.2, 1.7]], head: [0.74, 0.9, 0.46, 0.9], tail: [1.0, 1.5, 0.74, 0.92], grille: [0.5, 0.72, 0.42], mirror: 1.2, seams: [1.0, -0.26], handles: [-0.2, -0.5], plate: 0.62 }
const VAN = { hw: 1.0, yb: 0.36, belt: 1.32, tumble: 0.04, glassTop: 2.12, blindRear: true, top: [2.72, 0.48, 2.72, 0.98, 2.52, 1.16, 1.95, 1.3, 1.38, 2.28, 1.12, 2.44, -2.62, 2.46, -2.72, 2.32, -2.72, 0.48],
  wheels: [[-1.85, 0.36], [1.75, 0.36]], panes: [[0.5, 2.0]], head: [0.84, 1.0, 0.54, 0.94], tail: [0.9, 1.4, 0.82, 0.97], grille: [0.55, 0.82, 0.5], mirror: 1.4, mirrorPaint: DARK, seams: [1.2, 0.42, -0.9], handles: [0.5], plate: 0.62 }
// a truck's or an ambulance's cab alone (its `top` comes down behind the cab); the body behind it is added after
const CAB = { hw: 1.15, yb: 0.5, belt: 1.6, tumble: 0.02, bevel: 0.08, glassTop: 2.6, blindRear: true, top: [4.35, 0.6, 4.35, 1.45, 4.25, 1.7, 4.02, 2.68, 3.85, 2.82, 2.45, 2.82, 2.45, 0.6],
  wheels: [[3.3, 0.45]], track: 1.1, panes: [[3.0, 4.2]], head: [0.88, 1.08, 0.66, 1.04], tail: [1.05, 1.3, 0.9, 1.15], grille: [0.85, 1.4, 0.6], mirror: 3.85, mirrorPaint: DARK, bumper: STEEL, seams: [2.95] }

const sedan = (k, lod) => car(k, SEDAN, lod)
const hatch = (k, lod) => car(k, HATCH, lod)
const ev = (k, lod) => car(k, EV, lod)
function share(k, lod) { // a car-share compact: white, a teal band and mirrors, bars on the roof
  const c = car(k, SHARE, lod)
  k.c(0x16a394); for (const s of [-1, 1]) { side(k, s, rect(-0.7, 0.72, 0.42, 0.94), (y) => c.lo(y) + 0.003); side(k, s, rect(-1.75, 1.75, 0.78, 0.9), (y) => c.lo(y) + 0.003) }
  if (!lod) { k.c(TRIM); for (const x of [-0.9, 0.2]) k.box(x, x + 0.06, 1.52, 1.58, -0.7, 0.7) }
}
function suv(k, lod) {
  car(k, SUV, lod)
  if (!lod) { k.c(TRIM); pair(k, -1.85, 0.3, 1.72, 1.78, 0.6, 0.66) } // roof rails
}
function pickup(k, lod) {
  car(k, PICKUP, lod)
  k.c(TRIM).box(-2.36, -1.02, 1.0, 1.235, -0.84, 0.84, 1, 1) // the bed, covered
  if (!lod) k.c(DARK).box(-2.43, -2.41, 0.7, 1.16, -0.8, 0.8) // tailgate panel
}
function minivan(k, lod) {
  const c = car(k, MINIVAN, lod)
  if (!lod) { k.c(DARK); for (const s of [-1, 1]) side(k, s, rect(-1.5, -0.3, 1.02, 1.045), c.lo); k.c(TRIM); pair(k, -1.8, 0.4, 1.74, 1.79, 0.62, 0.68) } // the sliding doors' rails, roof rails
}
function van(k, lod) {
  car(k, VAN, lod)
  if (lod) return
  k.c(DARK).box(-2.74, -2.71, 0.52, 2.2, -0.012, 0.012) // the rear doors' seam and windows
  k.c(GLASS); pair(k, -2.74, -2.71, 1.55, 2.02, 0.12, 0.84)
}
// what a truck carries behind its cab: the frame, rear axles, tail lamps
function chassis(k, lod, x0, x1, axles, y = 0.95) {
  k.c(DARK).box(x0 + 0.05, x1, 0.45, y, -0.85, 0.85)
  for (const x of axles) axle(k, x, 0.45, 1.12, lod, true)
}
function boxTruck(k, lod) {
  car(k, CAB, lod)
  chassis(k, lod, -4.35, 2.5, [-3.2, -2.1])
  k.c(WHITE).prism([-4.35, 0.95, 2.32, 0.95, 2.32, 3.7, -4.35, 3.7], -1.25, 1.25, { bevel: lod ? 0 : 0.05 })
  k.c(null); for (const s of [-1, 1]) side(k, s, rect(-4.2, 2.2, 2.95, 3.25), () => 1.262) // a stripe in the cab's colour
  if (!lod) k.c(0xd2d2cc).box(-4.38, -4.34, 1.02, 3.62, -1.15, 1.15) // roll door
}
function garbage(k, lod) { // a cab-over packer: white cab, the body in the instance's colour, a hopper at the back
  car(k, { ...CAB, paint: WHITE, belt: 1.55, glassTop: 2.5, top: [4.35, 0.6, 4.35, 2.52, 4.2, 2.7, 2.95, 2.7, 2.95, 0.6], wheels: [[3.55, 0.45]], panes: [[3.1, 4.1]], head: [0.8, 1.0, 0.7, 1.06], grille: [1.05, 1.4, 0.7], mirror: 4.0, seams: [3.1] }, lod)
  chassis(k, lod, -4.2, 2.95, [-2.9, -1.75])
  k.c(null).prism([-3.3, 0.95, 2.8, 0.95, 2.8, 3.35, -3.1, 3.35], -1.22, 1.22, { bevel: lod ? 0 : 0.06 })
  k.c(0x70767c).prism([-4.3, 1.0, -3.3, 0.8, -3.3, 3.2, -3.9, 3.0, -4.3, 2.2], -1.2, 1.2, { bevel: lod ? 0 : 0.05 }) // the hopper
  if (!lod) { k.c(DARK); for (const x of [-2.2, -0.9, 0.4, 1.7]) for (const s of [-1, 1]) side(k, s, rect(x, x + 0.08, 1.1, 3.25), () => 1.232) } // ribs
  k.c(AMBER, 6).box(3.3, 3.5, 2.7, 2.82, -0.12, 0.12) // a beacon, lit at night
}
function semi(k, lod) { // a day-cab tractor and a short trailer
  car(k, { ...CAB, belt: 1.9, glassTop: 2.7, top: [4.35, 0.6, 4.35, 1.55, 4.2, 1.8, 3.25, 1.88, 2.95, 2.75, 2.8, 2.9, 1.95, 2.9, 1.95, 0.6], wheels: [[3.6, 0.5]], panes: [[2.05, 3.1]], head: [1.0, 1.2, 0.7, 1.06], grille: [0.95, 1.6, 0.56], mirror: 2.95, seams: [2.0] }, lod)
  chassis(k, lod, 0.3, 2.0, [1.0], 1.2)
  k.c(WHITE).prism([-4.35, 1.3, 1.6, 1.3, 1.6, 3.95, -4.35, 3.95], -1.27, 1.27, { bevel: lod ? 0 : 0.05 }) // the trailer
  k.c(null); for (const s of [-1, 1]) side(k, s, [[-4.2, 1.5], [1.45, 1.5], [1.45, 1.75], [-4.2, 2.3]], () => 1.282)
  k.c(DARK).box(-4.3, 0.2, 0.95, 1.3, -0.5, 0.5)
  for (const x of [-3.75, -2.7]) axle(k, x, 0.45, 1.14, lod, true)
  if (!lod) k.c(STEEL).rod([1.85, 1.2, 1.0], [1.85, 3.4, 1.0], 0.07, 0.07, 6).c(0xd2d2cc).box(-4.38, -4.34, 1.36, 3.88, -1.17, 1.17) // exhaust stack, doors
  k.c(TAIL, 3); pair(k, -4.37, -4.33, 1.02, 1.22, 0.9, 1.2)
}
function fire(k, lod) { // an engine: crew cab, pump body with roller shutters, a ladder on top
  const RED = 0xc0241c
  car(k, { ...CAB, paint: RED, belt: 1.55, glassTop: 2.4, top: [4.35, 0.6, 4.35, 1.5, 4.3, 2.45, 4.1, 2.62, 1.55, 2.62, 1.55, 0.6], wheels: [[3.3, 0.48]], panes: [[1.7, 2.65], [2.8, 4.25]], head: [0.86, 1.06, 0.66, 1.04], grille: [1.1, 1.42, 0.62], mirror: 3.95, seams: [2.72], blink: 1.2 }, lod)
  chassis(k, lod, -4.3, 1.6, [-2.6])
  k.c(RED).prism([-4.3, 0.95, 1.5, 0.95, 1.5, 2.5, -4.3, 2.5], -1.2, 1.2, { bevel: lod ? 0 : 0.05 })
  k.c(0xb9bec4); for (const s of [-1, 1]) { side(k, s, rect(-4.1, -3.3, 1.2, 2.3), () => 1.212); side(k, s, rect(-1.9, 1.3, 1.2, 2.3), () => 1.212) } // shutters
  k.c(WHITE); for (const s of [-1, 1]) side(k, s, rect(1.6, 4.3, 1.28, 1.42), (y) => 1.15 - 0.02 * (y - 0.5) + 0.016)
  k.c(STEEL); pair(k, -4.2, 1.9, 2.56, 2.66, 0.18, 0.24) // the ladder
  if (!lod) for (let x = -4.0; x < 1.8; x += 0.5) k.box(x, x + 0.05, 2.59, 2.63, -0.18, 0.18)
  k.c(0xff2020, 4).box(3.5, 3.75, 2.62, 2.76, -0.8, -0.05); k.c(0xff2020, 5).box(3.5, 3.75, 2.62, 2.76, 0.05, 0.8)
  k.c(TAIL, 3); pair(k, -4.33, -4.29, 1.05, 1.3, 0.9, 1.15)
}
function ambulance(k, lod) { // a van cab with a box: white, a red band, beacons
  const c = car(k, { ...VAN, paint: WHITE, glassTop: 1.95, top: [2.72, 0.48, 2.72, 0.98, 2.52, 1.16, 1.95, 1.3, 1.45, 2.0, 1.25, 2.1, 0.7, 2.1, 0.7, 1.0, -2.6, 1.0, -2.6, 0.48], seams: [1.2], tail: [0.62, 0.86, 0.8, 1.02] }, lod)
  k.c(WHITE).prism([-2.72, 0.62, 0.78, 0.62, 0.78, 2.62, -2.6, 2.62, -2.72, 2.5], -1.08, 1.08, { bevel: lod ? 0 : 0.06 })
  k.c(0xc0241c); for (const s of [-1, 1]) { side(k, s, rect(-2.6, 0.7, 1.2, 1.45), () => 1.092); side(k, s, rect(0.85, 2.3, 1.02, 1.2), c.lo) }
  k.c(0x2a62b8); for (const s of [-1, 1]) side(k, s, [[-0.5, 1.75], [-0.1, 1.75], [-0.1, 2.15], [-0.5, 2.15]], () => 1.092) // a blue square where the star of life would be
  k.c(0xff2020, 4).box(0.5, 0.72, 2.62, 2.74, -0.9, -0.1); k.c(0x2050ff, 5).box(0.5, 0.72, 2.62, 2.74, 0.1, 0.9)
  k.c(0xff2020, 4).box(-2.7, -2.55, 2.62, 2.72, 0.5, 0.9); k.c(0xff2020, 5).box(-2.7, -2.55, 2.62, 2.72, -0.9, -0.5)
  if (!lod) { k.c(GLASS); pair(k, -2.74, -2.715, 1.6, 2.2, 0.12, 0.8) }
}
function taxi(k, lod) { // a roof sign (lit at night) and a checker band
  const c = car(k, SEDAN, lod)
  k.c(0xfaf6e8, 6).box(-0.45, 0.05, 1.42, 1.64, -0.3, 0.3)
  k.c(DARK); for (const s of [-1, 1]) for (let i = 0; i < (lod ? 0 : 9); i++) side(k, s, rect(-0.9 + i * 0.2, -0.8 + i * 0.2, 0.74 + (i % 2) * 0.06, 0.8 + (i % 2) * 0.06), c.lo)
}
function police(k, lod) { // dark doors and a light bar
  const c = car(k, SEDAN, lod)
  k.c(0x1c2b4a); for (const s of [-1, 1]) side(k, s, rect(-1.0, 0.95, 0.46, 0.9), c.lo)
  k.c(0xff2020, 4).box(-0.35, -0.05, 1.42, 1.56, -0.62, -0.02); k.c(0x2050ff, 5).box(-0.35, -0.05, 1.42, 1.56, 0.02, 0.62)
}

// the fleet, in the order DETAIL picks from; FAR: the model of each kind the far fleet is drawn as
const FLEET = { sedan, hatch, ev, share, suv, pickup, minivan, van, ambulance, boxTruck, garbage, semi, fire, taxi, police }
const FAR = [sedan, suv, van, boxTruck, taxi, police]
const build = (THREE, fn, lod, name) => { const k = kit(THREE); fn(k, lod); const g = k.geometry(); g.name = name; return g }
export const carModels = (THREE) => Object.entries(FLEET).map(([name, fn]) => build(THREE, fn, false, name))
// which detailed model a car of a kind (sedan, suv, van, truck, taxi, police) with this seed (0..1) is drawn as
const SHARES = [[[0.36, 0], [0.64, 1], [0.86, 2], [1, 3]], [[0.5, 4], [0.76, 5], [1, 6]], [[0.94, 7], [1, 8]], [[0.55, 9], [0.72, 10], [0.95, 11], [1, 12]], [[1, 13]], [[1, 14]]]
export const DETAIL = (kind, seed) => SHARES[kind].find(([s]) => seed < s)?.[1] ?? SHARES[kind][0][1]

// ---------------------------------------------------------------- people
// People, 1.75 m before the shader's scale, facing +x. The shader swings the limbs about the hips (y 0.86) and
// shoulders (1.38) and bends them at the knees and elbows (JOINT: what is below bends), by aSwing: ±1 legs, ±2 arms,
// 9 a companion (a dog, a stroller: no pose moves it), 10 the dog's tail. Parts: 0 shirt, 1 trousers, 2 skin, 3 hair, 4 fixed, 5 the
// shirt a shade darker, 6 an umbrella (only in the rain; its holder's arm is raised).
export const H = 1.08 // people a touch larger than life, so they read at street zoom
const JOINT = { hip: 0.86, knee: 0.465, shoulder: 1.38, elbow: 1.105 }
const SKIN = 0xe2b48c, SHOE = 0x2a2a2e
const OUTFITS = ['tee', 'coat', 'hoodie', 'jogger', 'dress', 'dog', 'stroller']
function personModel(THREE, v) {
  const k = kit(THREE), bare = v === 'jogger' || v === 'dress', short = v === 'tee' || v === 'jogger' || v === 'dress', long = v === 'coat' || v === 'dress'
  for (const s of [-1, 1]) { // legs: thigh, shin (bare under shorts and a dress), shoe
    const z = s * 0.1
    k.c(null, bare ? 0 : 1, s).box(-0.08, 0.08, 0.46, 0.9, z - 0.07, z + 0.07, 1.1, 1.1)
    k.c(bare ? SKIN : null, bare ? 2 : 1, s).box(-0.066, 0.066, 0.07, 0.47, z - 0.058, z + 0.058, 1.2, 1.2)
    k.c(v === 'jogger' ? 0xe8e8e2 : SHOE, 4, s).box(-0.07, 0.16, 0, 0.085, z - 0.06, z + 0.06, 0.85)
  }
  k.c(null, bare ? 0 : 1).box(-0.1, 0.1, 0.82, 0.98, -0.17, 0.17) // hips
  if (v === 'coat') k.c(null, 0).box(-0.13, 0.13, 0.5, 1.0, -0.2, 0.2, 0.85, 0.92) // the coat's skirt
  if (v === 'dress') k.c(null, 0).box(-0.17, 0.17, 0.52, 1.0, -0.23, 0.23, 0.6, 0.72)
  const t = k.at() // torso, seen from the front: waist up to the shoulders, chamfered
  k.c(null, 0).prism([-0.16, 0.95, 0.16, 0.95, 0.21, 1.33, 0.18, 1.43, -0.18, 1.43, -0.21, 1.33], -0.11, 0.12, { bevel: 0.03 })
  k.rot(t, 'y', Math.PI / 2)
  k.c(SKIN, 2).box(-0.045, 0.045, 1.42, 1.5, -0.045, 0.045) // neck
  k.c(null, 2).prism([-0.1, 1.49, 0.09, 1.49, 0.115, 1.58, 0.105, 1.71, -0.09, 1.73, -0.11, 1.62], -0.092, 0.092, { bevel: 0.03 }) // head, nose
  k.box(0.1, 0.135, 1.58, 1.63, -0.018, 0.018)
  if (v === 'hoodie') k.c(null, 5).prism([-0.125, 1.63, 0.115, 1.66, 0.09, 1.78, -0.1, 1.79], -0.105, 0.105, { bevel: 0.035 }) // beanie
  else k.c(null, 3).prism(long ? [-0.135, 1.34, -0.12, 1.75, 0.06, 1.77, 0.125, 1.68, 0.0, 1.67, -0.07, 1.42] : [-0.125, 1.56, -0.115, 1.75, 0.07, 1.765, 0.125, 1.68, 0.0, 1.675, -0.07, 1.6], long ? -0.112 : -0.106, long ? 0.112 : 0.106, { bevel: 0.03 })
  if (v === 'jogger') k.c(null, 3).box(-0.24, -0.11, 1.5, 1.66, -0.035, 0.035, 0.6) // ponytail
  if (v === 'tee') k.c(null, 5).box(-0.26, -0.11, 0.98, 1.36, -0.15, 0.15, 0.95) // backpack
  if (v === 'hoodie') k.c(null, 5).box(-0.17, -0.1, 1.3, 1.45, -0.15, 0.15) // hood
  if (v === 'dress') k.c(0x8a5a3c, 4).box(-0.1, 0.12, 0.72, 1.0, -0.34, -0.27).box(-0.01, 0.01, 1.0, 1.4, -0.31, -0.29) // a tote on its strap
  for (const s of [-1, 1]) { // arms: sleeve, forearm (bare with short sleeves), hand; pushing a stroller: held out
    const z = s * 0.25, a = k.at(), sw = v === 'stroller' ? 0 : 2 * s
    k.c(null, 0, sw).box(-0.055, 0.055, 1.1, 1.4, z - 0.055, z + 0.055, 1.15)
    k.c(short ? SKIN : null, short ? 2 : 0, sw).box(-0.048, 0.048, 0.8, 1.11, z - 0.048, z + 0.048, 1.1)
    k.c(SKIN, 2, sw).box(-0.04, 0.05, 0.7, 0.81, z - 0.035, z + 0.035, 1.15)
    if (v === 'stroller') k.move(a, 0, -1.38, 0).rot(a, 'z', 0.8).move(a, 0, 1.38, 0)
  }
  if (v === 'dog') { // on a lead, trotting ahead to the right: the coat in a hair colour
    k.c(null, 3, 9).box(0.62, 1.08, 0.26, 0.5, 0.36, 0.54, 0.92).box(1.0, 1.26, 0.42, 0.66, 0.37, 0.53, 0.8).box(1.22, 1.36, 0.44, 0.54, 0.41, 0.49) // body, head, muzzle
    k.box(1.0, 1.06, 0.64, 0.74, 0.37, 0.41).box(1.0, 1.06, 0.64, 0.74, 0.49, 0.53) // ears
    k.c(null, 3, 10).box(0.5, 0.64, 0.44, 0.5, 0.43, 0.47).c(null, 3, 9) // the tail (10: it wags while the dog is petted)
    for (const [x, z] of [[0.66, 0.39], [0.66, 0.51], [1.0, 0.39], [1.0, 0.51]]) k.box(x, x + 0.07, 0, 0.28, z - 0.03, z + 0.03)
    k.c(0xc23b2e, 4, 9).box(1.0, 1.04, 0.5, 0.62, 0.365, 0.535).rod([0.04, 0.78, 0.27], [1.02, 0.62, 0.45], 0.012, 0.012, 3) // collar and lead
  }
  if (v === 'stroller') {
    k.c(null, 5, 9).prism([0.5, 0.3, 1.02, 0.3, 1.08, 0.62, 0.5, 0.66], -0.2, 0.2, { bevel: 0.03 }) // the seat, its hood
    k.c(TRIM, 4, 9).prism([0.46, 0.64, 0.8, 0.64, 0.74, 0.9, 0.52, 0.92], -0.21, 0.21, { bevel: 0.03 })
    for (const s of [-1, 1]) for (const x of [0.58, 1.0]) k.wheel(x, 0.1, s * 0.2, 0.1, 0.04, 6).box(x - 0.015, x + 0.015, 0.1, 0.32, s * 0.2 - 0.015, s * 0.2 + 0.015)
    k.box(0.44, 0.47, 0.86, 0.9, -0.21, 0.21) // the handle
  }
  if (!['jogger', 'dog', 'stroller'].includes(v)) { // the umbrella, held in the right hand raised forward
    k.c(0x2a2a2e, 6).box(0.37, 0.39, 0.85, 1.95, 0.24, 0.26)
    const u = k.at()
    k.c(null, 6).cyl(0.56, 0.05, 0.24, 8, 2)
    k.move(u, 0.2, 1.9, 0.1)
  }
  const g = k.geometry(); g.name = v
  return g
}
export const peopleModels = (THREE) => OUTFITS.map((v) => personModel(THREE, v))
// which outfit a person with this seed (0..1) wears: dogs and strollers are the rare ones
const WEARS = [0.2, 0.4, 0.58, 0.7, 0.86, 0.93]
export const OUTFIT = (seed) => { const i = WEARS.findIndex((s) => seed < s); return i < 0 ? WEARS.length : i }

// ---------------------------------------------------------------- cyclists
// A rider on a bike, facing +x, hips over the origin (the shader's pivot). The shader pedals: the legs (aSwing ±1)
// reach for the pedals from the hip (BIKE.hip) through the knee, the cranks (±3) turn about the bottom bracket and
// the wheels (4 rear, 5 front) about their axles. Parts as people, and 7: a share bike's basket and mudguards (one
// rider in four rides one, its frame blue), 8: a helmet (most wear one).
const BIKE = { hip: 0.95, knee: 0.555, thigh: 0.4, shin: 0.42, bb: [0.12, 0.31], crank: 0.16, rear: [-0.42, 0.34], front: [0.66, 0.34] }
function ring(k, [cx, cy], r0, r1, w, seg) { // a flat ring (a tyre from the side) round (cx, cy), w thick
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2
    const p = (r, a, z) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r, z]
    k.quad(p(r0, a0, w), p(r0, a1, w), p(r1, a1, w), p(r1, a0, w)); k.quad(p(r1, a0, -w), p(r1, a1, -w), p(r0, a1, -w), p(r0, a0, -w))
    k.quad(p(r0, a0, -w), p(r0, a1, -w), p(r0, a1, w), p(r0, a0, w))
  }
}
function bikeModel(THREE) {
  const k = kit(THREE), { bb, rear, front } = BIKE, seat = [-0.03, 0.84], head = [0.5, 0.94], crown = [0.535, 0.76]
  const P = ([x, y], z = 0) => [x, y, z]
  for (const [c, sw] of [[rear, 4], [front, 5]]) {
    k.c(0x222428, 4, sw); ring(k, c, 0.34, 0.285, 0.022, 9)
    k.c(0xa9aeb4, 4, sw)
    for (let i = 0; i < 3; i++) { const a = k.at(); k.box(-0.29, 0.29, -0.007, 0.007, -0.007, 0.007); k.rot(a, 'z', (i * Math.PI) / 3 + 0.3).move(a, c[0], c[1], 0) }
  }
  k.c(null, 5) // the frame: two triangles, the fork
  for (const [a, b] of [[bb, seat], [bb, crown], [[-0.01, 0.78], head], [bb, rear], [[-0.02, 0.8], rear], [crown, front], [crown, [0.49, 1.03]]]) k.rod(P(a), P(b), 0.022, 0.022, 4)
  k.c(0x26282c, 4).box(0.47, 0.51, 1.01, 1.05, -0.24, 0.24).box(-0.17, 0.1, 0.84, 0.9, -0.06, 0.06, 0.8) // bars, saddle
  for (const s of [-1, 1]) k.c(0x26282c, 4, 3 * s).box(bb[0] - 0.015, bb[0] + BIKE.crank, bb[1] - 0.015, bb[1] + 0.015, s * 0.05, s * 0.07).box(bb[0] + BIKE.crank - 0.05, bb[0] + BIKE.crank + 0.05, bb[1] - 0.012, bb[1] + 0.012, s * 0.07, s * 0.16)
  k.c(0x2f3338, 7).box(0.56, 0.84, 0.8, 1.0, -0.15, 0.15, 1.1) // a share bike: basket, mudguards
  for (const [c] of [[rear], [front]]) k.c(0x1f6fb5, 7).box(c[0] - 0.22, c[0] + 0.22, c[1] + 0.35, c[1] + 0.38, -0.035, 0.035)
  for (const s of [-1, 1]) { // legs, hanging from the hip until the shader bends them
    const z = s * 0.1
    k.c(null, 1, s).box(-0.075, 0.075, 0.555, 0.98, z - 0.065, z + 0.065, 1.1, 1.1)
    k.box(-0.062, 0.062, 0.16, 0.565, z - 0.055, z + 0.055, 1.2, 1.2)
    k.c(SHOE, 4, s).box(-0.08, 0.15, 0.1, 0.18, z - 0.055, z + 0.055, 0.85)
  }
  const u = k.at() // the upper body, built upright on the hips then leant to the bars
  k.c(null, 1).box(-0.1, 0.1, 0.9, 1.04, -0.16, 0.16)
  const t = k.at()
  k.c(null, 0).prism([-0.16, 1.02, 0.16, 1.02, 0.21, 1.4, 0.18, 1.5, -0.18, 1.5, -0.21, 1.4], -0.11, 0.12)
  k.rot(t, 'y', Math.PI / 2)
  k.move(u, 0, -0.95, 0).rot(u, 'z', -0.5).move(u, 0, 0.95, 0)
  const h = k.at() // the head, kept level
  k.c(SKIN, 2).box(-0.045, 0.045, 1.42, 1.5, -0.045, 0.045)
  k.c(null, 2).prism([-0.1, 1.49, 0.09, 1.49, 0.115, 1.58, 0.105, 1.71, -0.09, 1.73, -0.11, 1.62], -0.092, 0.092)
  k.c(null, 3).prism([-0.125, 1.56, -0.115, 1.75, 0.07, 1.765, 0.125, 1.68, 0.0, 1.675, -0.07, 1.6], -0.106, 0.106)
  k.c(0xe9e9e4, 8).prism([-0.15, 1.66, 0.14, 1.67, 0.1, 1.8, -0.02, 1.83, -0.13, 1.79], -0.115, 0.115)
  k.move(h, 0.27, -0.03, 0)
  for (const s of [-1, 1]) { const z = s * 0.24; k.c(null, 0).rod([0.24, 1.4, z], [0.3, 1.16, z], 0.055, 0.05, 4).c(SKIN, 2).rod([0.3, 1.16, z], [0.49, 1.06, s * 0.2], 0.045, 0.04, 4) } // arms to the bars
  const g = k.geometry(); g.name = 'cyclist'
  return g
}
export const bikeModels = (THREE) => [bikeModel(THREE)]

// the far fleet (one cheap model per kind of car, a person, the cyclist): what the map draws from afar, and the
// chase view beyond the near radii
export function farModels(THREE) {
  const k = kit(THREE)
  for (const [x0, x1, y0, y1, hw, part, taper, swing, zc] of [
    [-0.08, 0.08, 0, 0.86, 0.075, 1, 1, 1, 0.1], [-0.08, 0.08, 0, 0.86, 0.075, 1, 1, -1, -0.1], // legs
    [-0.12, 0.12, 0.84, 1.42, 0.2, 0, 0.92, 0, 0], // torso
    [-0.06, 0.06, 0.86, 1.4, 0.06, 0, 1, 2, 0.27], [-0.06, 0.06, 0.86, 1.4, 0.06, 0, 1, -2, -0.27], // arms
    [-0.11, 0.11, 1.45, 1.7, 0.1, 2, 1, 0, 0], [-0.13, 0.1, 1.64, 1.75, 0.115, 3, 1, 0, 0], // head, hair
  ]) k.c(null, part, swing).box(x0, x1, y0, y1, zc - hw, zc + hw, taper)
  return { cars: FAR.map((fn, i) => build(THREE, fn, true, 'far ' + i)), person: k.geometry().scale(H, H, H), bike: bikeModel(THREE) }
}

// The cheapest models, for what is a few pixels on the screen (#604): a car as two blocks in the main colours of its
// lower and upper halves (taken from its far model `cars[k]`) with a lamp strip at each end, 144 vertices for 432; a
// person as legs, body and head, 108 for 252.
export function dotModels(THREE, cars) {
  const col = new THREE.Color()
  const main = (g, y0, y1) => { // [colour, part] of most of the surface between two heights
    const P = g.attributes.position.array, C = g.attributes.aCol.array, A = g.attributes.aPart.array, sum = new Map()
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
    for (let i = 0; i < P.length / 3; i += 3) {
      a.fromArray(P, i * 3); b.fromArray(P, i * 3 + 3); c.fromArray(P, i * 3 + 6)
      const y = (a.y + b.y + c.y) / 3
      if (y < y0 || y >= y1 || A[i] > 1.5) continue // (not the lamps)
      const key = A[i] < 0.5 ? 'body' : col.setRGB(C[i * 3], C[i * 3 + 1], C[i * 3 + 2]).getHex()
      sum.set(key, (sum.get(key) || 0) + b.sub(a).cross(c.sub(a)).length())
    }
    const best = [...sum].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 'body'
    return best === 'body' ? [null, 0] : [best, 1]
  }
  const car = (g, i) => {
    g.computeBoundingBox()
    const { min, max } = g.boundingBox, k = kit(THREE), L = max.x - min.x, ym = min.y + (max.y - min.y) * 0.55
    k.c(...main(g, min.y + 0.3, ym)).box(min.x, max.x, min.y + 0.2, ym, min.z, max.z)
    k.c(...main(g, ym, max.y + 1)).box(min.x + L * 0.12, max.x - L * 0.22, ym, max.y, min.z * 0.9, max.z * 0.9)
    k.c(0xfff2cc, 2).box(max.x, max.x + 0.04, 0.6, 0.74, min.z, max.z).c(0xb01010, 3).box(min.x - 0.04, min.x, 0.62, 0.76, min.z, max.z)
    const o = k.geometry(); o.name = 'dot ' + i
    return o
  }
  const k = kit(THREE)
  k.c(null, 1).box(-0.09, 0.09, 0, 0.86, -0.17, 0.17).c(null, 0).box(-0.13, 0.13, 0.84, 1.44, -0.24, 0.24).c(null, 2).box(-0.11, 0.11, 1.45, 1.74, -0.1, 0.1)
  return { cars: cars.map(car), person: k.geometry().scale(H, H, H) }
}

// kind: 'car', 'person' or 'bike'; hide: a { value } uniform, the squared radius around uCam within which these
// boxes are not drawn (the detailed models are), or null for the detailed models themselves
export function lifeMaterial(THREE, uni, kind, hide = null) {
  const bike = kind === 'bike'
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff })
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uni, hide ? { uNear: hide } : {})
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 iA, iB; attribute vec3 aCol; attribute float aPart, aSwing; uniform float uNight, uTime, uRain${hide ? ', uNear' : ''}; uniform vec3 uCam;
        varying vec3 vCol, vEmit; ${SHADE.vars}
        vec3 unpack(float c) { float r = floor(c / 65536.0), g = floor((c - r * 65536.0) / 256.0), b = c - r * 65536.0 - g * 256.0; return pow(vec3(r, g, b) / 255.0, vec3(2.2)); }
        vec3 orient(vec3 p, float yaw, float pitch) {
          float cp = cos(pitch), sp = sin(pitch); p = vec3(p.x * cp - p.y * sp, p.x * sp + p.y * cp, p.z);
          float cy = cos(yaw), sy = sin(yaw); return vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
        }
        vec2 rot(vec2 v, vec2 c, float a) { v -= c; return c + vec2(v.x * cos(a) - v.y * sin(a), v.x * sin(a) + v.y * cos(a)); }`)
      .replace('#include <beginnormal_vertex>', `vec3 P0 = position, N0 = normal; float pitch = 0.0;
        ${kind === 'car' ? `pitch = iB.x;
          vec3 col = aPart < 0.5 ? unpack(iB.y) : aCol;
          vec3 em = vec3(0.0);
          if (aPart > 1.5 && aPart < 2.5) em = vec3(1.0, 0.85, 0.6) * uNight * 3.0;
          else if (aPart > 2.5 && aPart < 3.5) em = vec3(1.0, 0.04, 0.02) * (uNight * 1.5 + mod(iB.z, 2.0) * 1.2);
          else if (aPart > 6.5) {
            if (abs(floor(iB.z * 0.5 + 0.01) - (aPart - 6.0)) > 0.5) P0 = vec3(0.0);
            em = vec3(1.0, 0.42, 0.0) * 1.3 * step(0.5, fract(uTime * 1.5 + iB.w * 5.0));
          }
          else if (aPart > 3.5 && aPart < 5.5) em = aCol * 2.0 * step(0.5, fract(uTime * 2.2 + iB.w * 7.0 + (aPart > 4.5 ? 0.5 : 0.0)));
          else if (aPart > 5.5) em = vec3(0.9, 0.75, 0.3) * uNight;` : `
          float pose = floor(iB.y + 0.001), seed = fract(iB.y) / 0.9, sw = abs(aSwing), sd = sign(aSwing);
          vec3 skin[4] = vec3[](vec3(0.98, 0.80, 0.66), vec3(0.87, 0.65, 0.48), vec3(0.62, 0.43, 0.29), vec3(0.40, 0.27, 0.18));
          vec3 hair[5] = vec3[](vec3(0.12, 0.09, 0.07), vec3(0.35, 0.22, 0.12), vec3(0.85, 0.70, 0.40), vec3(0.55, 0.55, 0.55), vec3(0.05, 0.05, 0.06));
          vec3 umbs[4] = vec3[](vec3(0.08, 0.1, 0.16), vec3(0.75, 0.12, 0.14), vec3(0.95, 0.75, 0.15), vec3(0.15, 0.4, 0.6));
          bool mobi = ${bike ? 'fract(seed * 9.7) < 0.25' : 'false'}; // a share bike
          vec3 col = aPart < 0.5 ? unpack(iB.z) : aPart < 1.5 ? unpack(iB.w) : aPart < 2.5 ? pow(skin[int(seed * 3.99)], vec3(2.2))
            : aPart < 3.5 ? pow(hair[int(fract(seed * 7.13) * 4.99)], vec3(2.2)) : aPart > 6.5 ? aCol : aPart > 5.5 ? pow(umbs[int(fract(seed * 3.7) * 3.99)], vec3(2.2))
            : aPart > 4.5 ? (mobi ? vec3(0.012, 0.16, 0.46) : unpack(iB.z) * 0.8) : aCol;
          vec3 em = vec3(0.0);
          ${bike ? `
          if ((aPart > 6.5 && aPart < 7.5 && !mobi) || (aPart > 7.5 && fract(seed * 3.3) > 0.75)) P0 = vec3(0.0);
          float th = iB.x + (sd > 0.0 ? 0.0 : 3.1416);
          vec2 bb = vec2(${BIKE.bb[0]}, ${BIKE.bb[1]});
          if (sw > 3.5) { vec2 ax = sw < 4.5 ? vec2(${BIKE.rear[0]}, ${BIKE.rear[1]}) : vec2(${BIKE.front[0]}, ${BIKE.front[1]}); P0.xy = rot(P0.xy, ax, -iB.x * 1.7); N0.xy = rot(N0.xy, vec2(0.0), -iB.x * 1.7); }
          else if (sw > 2.5) { P0.xy = rot(P0.xy, bb, -th); N0.xy = rot(N0.xy, vec2(0.0), -th); }
          else if (sw > 0.5) { // a leg: from the hip through the knee to its pedal
            vec2 hip = vec2(0.0, ${BIKE.hip}), d = bb + ${BIKE.crank} * vec2(cos(th), -sin(th)) - hip;
            float l1 = ${BIKE.thigh.toFixed(3)}, l2 = ${BIKE.shin.toFixed(3)}, L = min(length(d), l1 + l2 - 0.005);
            float a = atan(d.x, -d.y) + acos(clamp((l1 * l1 + L * L - l2 * l2) / (2.0 * l1 * L), -1.0, 1.0));
            float b = acos(clamp((l1 * l1 + l2 * l2 - L * L) / (2.0 * l1 * l2), -1.0, 1.0)) - 3.1416;
            if (P0.y < ${BIKE.knee}) { P0.xy = rot(P0.xy, vec2(0.0, ${BIKE.knee}), b); N0.xy = rot(N0.xy, vec2(0.0), b); }
            P0.xy = rot(P0.xy, hip, a); N0.xy = rot(N0.xy, vec2(0.0), a);
          }` : `
          bool umb = uRain > 0.5 && fract(seed * 7.31) < 0.6 && pose < 1.5; // an umbrella up, walking or waiting
          if (aPart > 5.5 && aPart < 6.5 && !umb) P0 = vec3(0.0);
          if (sw > 0.5 && sw < 2.5) { // a limb: a about the hip or shoulder, b at the knee or elbow (what is below it)
            bool leg = sw < 1.5; float a = 0.0, b = 0.0, s = sin(iB.x) * sd, c = cos(iB.x) * sd;
            if (pose < 0.5) { a = s * (leg ? 0.5 : -0.45); b = leg ? -0.95 * max(0.0, c) : 0.15 + 0.4 * max(0.0, -s); } // the swinging leg's knee bends
            else if (pose < 1.5) b = leg ? 0.0 : 0.12;
            else if (pose < 2.5) { a = leg ? 1.5708 : 0.3; b = leg ? -1.5708 : 0.6; } // sitting
            else if (pose > 4.5) b = leg ? 0.0 : 0.12; // stopped for someone petting their dog
            else if (pose > 3.5) a = leg ? 0.12 * sd : -0.9 * min(1.0, iB.x * 2.0); // knocked over: arms out
            if (umb && aSwing > 1.5) { a = 0.75; b = 0.0; } // holding it up
            float jy = (leg ? ${JOINT.knee} : ${JOINT.elbow}) * ${H.toFixed(3)};
            if (P0.y < jy) { P0.xy = rot(P0.xy, vec2(0.0, jy), b); N0.xy = rot(N0.xy, vec2(0.0), b); }
            P0.xy = rot(P0.xy, vec2(0.0, (leg ? ${JOINT.hip} : ${JOINT.shoulder}) * ${H.toFixed(3)}), a); N0.xy = rot(N0.xy, vec2(0.0), a);
          }
          if (pose > 1.5 && pose < 2.5 && sw < 8.5) P0.y -= 0.38;
          P0 *= 0.92 + 0.16 * fract(seed * 5.3); // short and tall
          if (sw > 9.5 && pose > 4.5) { float w = 0.8 * sin(iB.x * 24.0); P0.xz = rot(P0.xz, vec2(0.64, 0.45), w); N0.xz = rot(N0.xz, vec2(0.0), w); } // the dog's tail, wagging (iB.x: seconds)
          if (pose > 3.5 && pose < 4.5) pitch = iB.x; // tipping back from the feet`}`}
        vCol = col; vEmit = em; ${SHADE.vert}
        vec3 objectNormal = orient(N0, iA.w, pitch);`)
      .replace('#include <begin_vertex>', `${kind === 'car' ? 'P0 *= 1.0 - floor(iB.w * 0.5) / 15.0; // growing in, shrinking away (worker.js output())' : ''}
        vec3 transformed = orient(P0, iA.w, pitch) + iA.xyz;
        ${hide ? 'vec2 dc = iA.xz - uCam.xz; if (dot(dc, dc) < uNear) transformed = vec3(0.0, -1e5, 0.0);' : ''}`)
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCol, vEmit; ${SHADE.vars} uniform float uNight;`)
      .replace('#include <color_fragment>', `diffuseColor.rgb *= vCol; ${SHADE.frag}`) // (and the shared look, kit.js)
      .replace('#include <emissivemap_fragment>', `totalEmissiveRadiance += vEmit; ${SHADE.rim}`)
  }
  m.customProgramCacheKey = () => 'life-' + kind + (hide ? '-far' : '')
  return m
}
// A Vancouver signal pole, in the frame of its mast arm (+x, over the lanes; heads face -z, the oncoming traffic),
// origin at its foot: the pole, a near-side head and a pedestrian head on it (the street-name blade: blades.js).
// The arm (a unit long, scaled to each) and the overhead head (origin where it hangs from the arm) are their own
// models; LENSES are where the lit discs and pedestrian squares go, in those frames.
export const ARM_Y = 6.1
const SIG_POLE = 0x3a3e44, SIG_YELLOW = 0xd9a51e, SIG_BLACK = 0x1a1b1d
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
// Street-name blades (blades.js draws them, only where the name is known): centred at x, y, along x, w by h; on the
// mast arm (resting on it) a little larger than life so the name reads from down the block, and two crossed on a
// corner post at junctions without signals (turn: about the post)
export const ARM_BLADE = { x: 2.5, y: ARM_Y + 0.37, w: 2.8, h: 0.56 }
export const POST_BLADES = [{ x: 0, y: 2.8, w: 1.7, h: 0.34, turn: 0 }, { x: 0, y: 3.18, w: 1.7, h: 0.34, turn: Math.PI / 2 }]
export function postModel(THREE) { return kit(THREE).c(SIG_POLE).cyl(0.045, 0.04, 3.36, 6).geometry(true) }
export function signalModels(THREE) {
  const pole = kit(THREE)
  pole.c(SIG_POLE).cyl(0.2, 0.17, 0.45, 8).cyl(0.11, 0.085, ARM_Y + 0.4, 8)
  signalHead(pole, 0, 4.35, -0.27, false) // the near-side head, on the pole
  pole.c(SIG_POLE).box(-0.05, 0.05, 3.45, 4.2, -0.2, -0.08)
  pole.c(SIG_BLACK).prism([0.08, 2.6, 0.42, 2.6, 0.42, 3.05, 0.08, 3.05], -0.18, 0.18) // pedestrian head (faces +x)
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
