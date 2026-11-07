// The Salmonberry Parcel Co. van: a small low-poly delivery van, flat-shaded Lambert like the map, built with the
// life plugin's kit (one bevelled side profile with wheel arches and glass, a cream skirt, bumpers, mirrors, wipers,
// parcels on the roof rack) in one mesh, plus its lamps (userData.lights: the head- and taillight materials) and
// four wheels (userData.wheels) that spin and steer, and the company's name on the sides.
// Local frame: forward -z, up +y, origin on the ground between the axles. 4.3 m long, 1.8 m wide.
import { kit, shaded } from '../life/kit.js'

const CREAM = 0xf6ead2, DARK = 0x2f3338, GLASS = 0x3d5568, TRIM = 0x8a8f96, KRAFT = 0xc9955c, KRAFT2 = 0xb8834e, TAPE = 0xeedfc0
const ARCHES = [[-1.35, 0.45], [1.35, 0.45]]
const under = (x0, x1, yb) => { // along the bottom, over the wheel arches (forward +x while building)
  const out = [x0, yb]
  for (const [cx, r] of ARCHES) { out.push(cx - r, yb); for (let i = 0; i <= 6; i++) { const t = Math.PI - (Math.PI * i) / 6; out.push(cx + r * Math.cos(t), Math.max(yb, 0.36 + r * Math.sin(t))) } out.push(cx + r, yb) }
  out.push(x1, yb)
  return out
}
const nar = (y) => 0.025 * (y - 0.32) + Math.max(0, y - 1.2) * 0.05 // tumblehome
let livery = null // the name on the sides, drawn once (a canvas texture)
function liveryTexture(THREE) {
  if (livery) return livery
  const c = document.createElement('canvas'); c.width = 512; c.height = 192
  const g = c.getContext('2d')
  g.fillStyle = '#d9483b'; g.beginPath(); g.arc(86, 104, 58, 0, Math.PI * 2); g.fill() // the salmonberry
  g.fillStyle = '#f08a70'; for (const [x, y] of [[66, 86], [100, 80], [80, 118], [112, 112], [92, 140]]) { g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.fill() }
  g.fillStyle = '#5c9a3e'; g.beginPath(); g.ellipse(112, 40, 34, 14, -0.5, 0, Math.PI * 2); g.fill()
  g.fillStyle = '#fff8ec'; g.font = 'bold 64px system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillText('Salmonberry', 160, 84)
  g.font = '600 34px system-ui, sans-serif'; g.fillText('PARCEL CO.  ·  since 1886', 164, 140)
  livery = new THREE.CanvasTexture(c); livery.colorSpace = THREE.SRGBColorSpace; livery.anisotropy = 4
  return livery
}

export function makeVan(THREE, colour = 0xf2a07e) { // colour: the body (a hex number or CSS colour)
  const van = new THREE.Group(), night = { value: 0 }
  const vc = () => shaded(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), night)
  const bodyHex = new THREE.Color(colour).getHex()
  const k = kit(THREE)
  // the body: windscreen and the round of the roof from one profile; glass where it slopes above the belt
  k.c(bodyHex).prism([...under(-2.1, 2.1, 0.33), 2.15, 0.42, 2.17, 0.62, 2.14, 0.98, 1.62, 1.16, 0.98, 2.02, 0.75, 2.14, -1.98, 2.16, -2.12, 2.1, -2.15, 1.9, -2.15, 0.45], -0.9, 0.9,
    { bevel: 0.09, narrow: nar, edge: (i, nx, ny, y) => { if (y > 1.2 && Math.abs(nx) > 0.4 && ny > 0.15 && ny < 0.8) k.c(GLASS); else if (ny < -0.3) k.c(DARK) } })
  k.c(CREAM).prism([...under(-2.11, 2.11, 0.31), 2.16, 0.42, 2.18, 0.62, 2.18, 0.76, -2.16, 0.76, -2.16, 0.42], -0.912, 0.912, { bevel: 0.05, narrow: nar }) // two-tone skirt
  for (const s of [-1, 1]) { // the cab's side windows (on the leaning sides), door seams and handles, mirrors
    const z0 = s > 0 ? 0.86 : -0.912, z1 = s > 0 ? 0.912 : -0.86, lean = (y) => -s * nar(y)
    k.c(GLASS).prism([0.0, 1.28, 1.42, 1.28, 0.93, 1.95, 0.0, 1.96], z0, z1, { bevel: 0.015, lean })
    k.c(DARK); for (const x of [-0.05, -1.25]) k.prism([x, 0.78, x + 0.025, 0.78, x + 0.025, 1.98, x, 1.98], z0 + s * 0.006, z1 + s * 0.006, { lean })
    k.prism([0.08, 1.12, 0.24, 1.12, 0.24, 1.17, 0.08, 1.17], z0 + s * 0.01, z1 + s * 0.01, { lean })
    k.c(DARK).box(1.28, 1.36, 1.5, 1.55, s * 0.86, s * 1.0).box(1.27, 1.37, 1.44, 1.66, s * 0.98, s * 1.06)
  }
  k.c(DARK).box(2.1, 2.25, 0.28, 0.5, -0.93, 0.93).box(-2.25, -2.1, 0.28, 0.5, -0.93, 0.93) // bumpers
  k.c(DARK).box(2.15, 2.205, 0.6, 0.76, -0.42, 0.42).c(0xd9483b).box(2.2, 2.215, 0.65, 0.71, -0.04, 0.04) // grille and its berry
  k.c(0xf3f0e6).box(2.24, 2.26, 0.32, 0.45, -0.22, 0.22).box(-2.26, -2.24, 0.33, 0.46, -0.22, 0.22) // plates
  k.c(DARK).box(1.5, 1.56, 1.22, 1.25, -0.7, -0.08).box(1.5, 1.56, 1.22, 1.25, 0.08, 0.7) // wipers
  // the back: two doors with little windows and a handle
  k.c(DARK).box(-2.17, -2.14, 0.5, 2.0, -0.012, 0.012).c(GLASS).box(-2.17, -2.14, 1.5, 1.92, -0.76, -0.08).box(-2.17, -2.14, 1.5, 1.92, 0.08, 0.76)
  k.c(TRIM).box(-2.18, -2.15, 1.3, 1.34, 0.06, 0.24)
  k.c(0xd88a1c); for (const s of [-1, 1]) k.box(2.06, 2.16, 0.8, 0.88, s * 0.82, s * 0.9).box(-2.17, -2.13, 0.76, 0.84, s * 0.74, s * 0.86) // indicators
  // the roof rack and parcels strapped to it
  k.c(TRIM); for (const s of [-1, 1]) k.box(-1.8, 0.55, 2.13, 2.2, s * 0.62, s * 0.7)
  for (const x of [-1.6, -0.6, 0.35]) k.box(x, x + 0.06, 2.18, 2.22, -0.7, 0.7)
  for (const [x0, x1, y0, y1, z0, z1, c, r] of [[-1.35, -0.75, 2.22, 2.67, -0.7, 0.0, KRAFT, 0], [-0.55, 0.0, 2.22, 2.57, 0.05, 0.6, KRAFT2, 0.2], [-1.25, -0.8, 2.67, 2.97, -0.55, -0.05, KRAFT2, -0.3]]) {
    const a = k.at(), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
    k.c(c).box(x0, x1, y0, y1, z0, z1).c(TAPE).box(x0 - 0.01, x1 + 0.01, y0, y1 + 0.01, cz - 0.05, cz + 0.05)
    k.move(a, -cx, 0, -cz).rot(a, 'y', r).move(a, cx, 0, cz)
  }
  const add = (g, m) => { g.rotateY(Math.PI / 2); g.deleteAttribute('aPart'); g.deleteAttribute('aSwing'); g.setAttribute('color', g.attributes.aCol); g.deleteAttribute('aCol'); const o = new THREE.Mesh(g, m); van.add(o); return o }
  add(k.geometry(), vc())
  // lamps: headlights and tail lights, their own materials so the drive plugin can turn them up at night
  const headL = shaded(new THREE.MeshLambertMaterial({ color: 0xfff4c8, emissive: 0xfff0b0, emissiveIntensity: 0.6, flatShading: true }), night)
  const tailL = shaded(new THREE.MeshLambertMaterial({ color: 0xe03a2e, emissive: 0x801010, emissiveIntensity: 0.5, flatShading: true }), night)
  const hl = kit(THREE), tl = kit(THREE)
  for (const s of [-1, 1]) { hl.c(0xffffff).box(2.08, 2.18, 0.86, 1.0, s * 0.42, s * 0.8, 1, 0.92); tl.c(0xffffff).box(-2.19, -2.13, 0.9, 1.3, s * 0.72, s * 0.87) }
  add(hl.geometry(), headL); add(tl.geometry(), tailL)
  van.userData.lights = [headL, tailL]
  // the name on both sides of the cargo box
  const decal = new THREE.MeshLambertMaterial({ map: liveryTexture(THREE), transparent: true, alphaTest: 0.3, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.75, 0.66), decal)
    p.rotation.set(0, s > 0 ? Math.PI / 2 : -Math.PI / 2, 0); p.rotateX(-0.06)
    p.position.set(s * (0.905 - nar(1.42)), 1.42, 1.0); van.add(p)
  }
  // wheels: a tyre, a hub and a cap; the front pair steer
  const wheels = []
  for (const [x, z] of [[-0.82, -1.35], [0.82, -1.35], [-0.82, 1.35], [0.82, 1.35]]) {
    const w = kit(THREE), o = Math.sign(x)
    w.c(0x2b2e33).wheel(0, 0, 0, 0.36, 0.24, 12, 'x').c(0xd8d8d2).wheel(o * 0.125, 0, 0, 0.21, 0.02, 8, 'x').c(0x6b7078).wheel(o * 0.14, 0, 0, 0.07, 0.02, 6, 'x')
    const g = w.geometry(); g.deleteAttribute('aPart'); g.deleteAttribute('aSwing'); g.setAttribute('color', g.attributes.aCol); g.deleteAttribute('aCol')
    const steer = new THREE.Group(); steer.position.set(x, 0.36, z)
    const spin = new THREE.Group()
    spin.add(new THREE.Mesh(g, vc()))
    steer.add(spin); van.add(steer)
    wheels.push({ steer, spin, front: z < 0 })
  }
  van.userData.wheels = wheels
  van.userData.night = night // 0 day .. 1 night: the rim light dims
  van.traverse((m) => { if (m.isMesh) { m.receiveShadow = true; m.castShadow = false } }) // the shadow map is static: a blob shadow instead
  return van
}

// ---------------------------------------------------------------- how it drives
// A small rear-wheel-drive van of about 1.5 t with a five-speed automatic, one step of `dt` seconds. Units: metres,
// seconds, radians; `c` is the van's state (newVan()), `I` the driver: { up, down, steer (-1 right .. 1 left), hand },
// up / down being the W / S keys (gas and brake, swapped in reverse); `grip` 1 on a dry road, less wet or snowy.
// It moves nothing: the caller moves the van by speed (forward) and lat (sideways, + right) and resolves collisions.
export const GEARS = [3.6, 2.15, 1.54, 1.15, 0.87], REVERSE = 3.4
const RPM_PER = 160 // engine rpm per m/s per unit of gear ratio (final drive 6, 0.36 m wheels)
const IDLE = 850, VMAX = 21, VREV = 6, WB = 2.7, G = 9.8
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
export function newVan() {
  return { speed: 0, lat: 0, yaw: 0, steer: 0, kick: 0, yawRate: 0, gear: 1, rpm: IDLE, thr: 0, brk: 0, shiftT: 0, revT: 0, ax: 0,
    pitch: 0, parked: false, bp: 0, bpv: 0, br: 0, brv: 0, hz: 0, hv: 0 } // pitch: the ground's; bp / br / hz: the body on its springs
}
export function stepVan(c, dt, I, grip) {
  const mu = 0.95 * grip, sp = Math.abs(c.speed), s0 = c.speed
  // into reverse: hold the brake at a standstill for a moment; back into drive the same way with the gas
  if (c.gear > 0 ? I.down && c.speed < 0.3 : I.up && c.speed > -0.3) { if ((c.revT += dt) > 0.3) { c.gear = c.gear > 0 ? -1 : 1; c.revT = 0 } } else c.revT = 0
  const fwd = c.gear > 0, gas = !c.parked && (fwd ? I.up : I.down), brake = fwd ? I.down : I.up
  c.thr += ((gas ? 1 : 0) - c.thr) * (1 - Math.exp(-(gas ? 4 : 10) * dt))
  c.brk += ((brake ? 1 : 0) - c.brk) * (1 - Math.exp(-9 * dt))
  // the gearbox: up early when cruising, late with the foot down; down as the revs sag (and kickdown)
  if (fwd && c.shiftT <= 0) {
    const r = sp * RPM_PER * GEARS[c.gear - 1]
    if (c.gear < 5 && r > 2300 + 2700 * c.thr) { c.gear++; c.shiftT = 0.3 } else if (c.gear > 1 && r < 1100 + 1000 * c.thr) { c.gear--; c.shiftT = 0.22 }
  }
  c.shiftT -= dt
  const ratio = fwd ? GEARS[c.gear - 1] : REVERSE
  // revs: the wheels' through the gear; at a standstill the torque converter slips and the engine revs with the gas
  const rpmT = Math.max(IDLE + c.thr * 1500 * Math.max(0, 1 - sp / 4), sp * RPM_PER * ratio) * (c.shiftT > 0 ? 0.9 : 1)
  c.rpm += (Math.min(6200, rpmT) - c.rpm) * (1 - Math.exp(-14 * dt))
  // pushing: torque (a flat curve, a little peak mid-range) through the gear, not past the tyres' grip; the limiter
  const tq = 0.78 + 0.22 * Math.sin(Math.PI * clamp((c.rpm - 1000) / 4800, 0, 1))
  let push = c.shiftT > 0 ? 0 : c.thr * 4.3 * (ratio / GEARS[0]) * tq
  push = Math.min(push * clamp(((fwd ? VMAX : VREV) - sp) / 1.5, 0, 1), mu * G * 0.55)
  c.speed += ((fwd ? push : -push) - G * Math.sin(clamp(c.pitch, -0.2, 0.2)) * (c.parked ? 0 : 0.8)) * dt // (no street is steeper than 20%)
  // holding back, never past a standstill: the brakes (as hard as the tyres allow), the handbrake, rolling, air, and
  // the engine off the gas
  const res = c.brk * Math.min(7.8, mu * G) + (c.parked ? 12 : I.hand ? Math.min(5, mu * G * 0.6) : 0) + 0.15 + 0.00045 * c.speed * c.speed + (gas ? 0 : 0.3 + c.rpm / 9000)
  c.speed = Math.abs(c.speed) <= res * dt ? 0 : c.speed - Math.sign(c.speed) * res * dt
  // steering: less lock the faster, eased in
  const maxSteer = 0.62 / (1 + sp / 7.5)
  c.steer += (clamp(I.steer, -1, 1) * maxSteer - c.steer) * (1 - Math.exp(-(I.steer ? 6 : 9) * dt))
  // turning: the bicycle model with understeer growing with speed (more on a slippery road), never more than the
  // front tyres can hold; pushing against a wall still lets it creep round as if at walking pace
  const turnV = sp < 1.2 && gas ? (fwd ? 1.2 : -1.2) : c.speed
  let yr = (turnV * Math.tan(c.steer)) / (WB * (1 + (0.0016 / grip) * c.speed * c.speed))
  const lim = (mu * G * 1.05) / Math.max(2, sp)
  yr = clamp(yr, -lim, lim)
  const hand = I.hand && sp > 3
  if (hand) yr *= 1.4 // the rear lets go
  yr += c.kick
  c.kick *= Math.exp(-5 * dt)
  // the van turns, its momentum doesn't: the velocity is split anew along the turned body...
  const d = yr * dt, cs = Math.cos(d), sn = Math.sin(d), s = c.speed, l = c.lat
  c.yaw += d
  c.speed = s * cs - l * sn; c.lat = s * sn + l * cs
  // ...and the tyres pull the sideways part out as hard as their grip allows: a slide where they can't
  const pull = mu * G * (hand ? 0.3 : 1) * dt
  c.lat = Math.abs(c.lat) <= pull ? 0 : c.lat - Math.sign(c.lat) * pull
  c.yawRate = yr
  // the body on its springs: squats as it pulls away, dives under braking, leans out of turns, bounces over kerbs
  c.ax += ((c.speed - s0) / dt - c.ax) * (1 - Math.exp(-12 * dt))
  c.bpv += ((clamp(c.ax * 0.0085, -0.075, 0.05) - c.bp) * 70 - c.bpv * 8) * dt; c.bp += c.bpv * dt
  c.brv += ((clamp(-s * yr * 0.011, -0.085, 0.085) - c.br) * 55 - c.brv * 6.5) * dt; c.br += c.brv * dt
  c.hv += (-c.hz * 90 - c.hv * 9) * dt; c.hz += c.hv * dt
}
// a kerb or a pothole under the wheels: k 0..1, front first (1) or rear first (-1), side -1 left .. 1 right
export function jolt(c, k, front = 1, side = 0) { c.hv += 1.1 * k; c.bpv += 2.6 * k * front; c.brv += 1.8 * k * side }
