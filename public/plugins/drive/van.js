// The Salmonberry Parcel Co. van: a small low-poly delivery van, flat-shaded Lambert like the map, built with the
// life plugin's kit (one bevelled side profile with wheel arches and glass, a cream skirt, bumpers, mirrors, wipers,
// parcels on the roof rack) in one mesh, plus its lamps (userData.lights: the head- and taillight materials) and
// four wheels (userData.wheels) that spin and steer, and the company's name on the sides.
// Local frame: forward -z, up +y, origin on the ground between the axles. 4.3 m long, 1.8 m wide.
import { kit, shaded, under as arched, kitMaterial } from '../../core/kit.js'
import { clamp } from '../../core/util.js'

const CREAM = 0xf6ead2, DARK = 0x2f3338, GLASS = 0x3d5568, TRIM = 0x8a8f96, KRAFT = 0xc9955c, KRAFT2 = 0xb8834e, TAPE = 0xeedfc0
const ARCHES = [[-1.35, 0.45], [1.35, 0.45]]
const under = (x0, x1, yb) => arched(x0, x1, yb, ARCHES, 0.36) // along the bottom, over the wheel arches (forward +x while building)
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

// head- and taillight materials (their own, so the drive plugin can turn them up at night)
export const lamps = (THREE, night) => [
  shaded(new THREE.MeshLambertMaterial({ color: 0xfff4c8, emissive: 0xfff0b0, emissiveIntensity: 0.6, flatShading: true }), night),
  shaded(new THREE.MeshLambertMaterial({ color: 0xe03a2e, emissive: 0x801010, emissiveIntensity: 0.5, flatShading: true }), night),
]
export function makeVan(THREE, colour = 0xf2a07e) { // colour: the body (a hex number or CSS colour)
  const van = new THREE.Group(), night = { value: 0 }
  const vc = () => kitMaterial(THREE, night)
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
  // the roof rack and parcels strapped to it
  k.c(TRIM); for (const s of [-1, 1]) k.box(-1.8, 0.55, 2.13, 2.2, s * 0.62, s * 0.7)
  for (const x of [-1.6, -0.6, 0.35]) k.box(x, x + 0.06, 2.18, 2.22, -0.7, 0.7)
  for (const [x0, x1, y0, y1, z0, z1, c, r] of [[-1.35, -0.75, 2.22, 2.67, -0.7, 0.0, KRAFT, 0], [-0.55, 0.0, 2.22, 2.57, 0.05, 0.6, KRAFT2, 0.2], [-1.25, -0.8, 2.67, 2.97, -0.55, -0.05, KRAFT2, -0.3]]) {
    const a = k.at(), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
    k.c(c).box(x0, x1, y0, y1, z0, z1).c(TAPE).box(x0 - 0.01, x1 + 0.01, y0, y1 + 0.01, cz - 0.05, cz + 0.05)
    k.move(a, -cx, 0, -cz).rot(a, 'y', r).move(a, cx, 0, cz)
  }
  const add = (g, m) => { g.rotateY(Math.PI / 2); const o = new THREE.Mesh(g, m); van.add(o); return o }
  add(k.geometry(true), vc())
  // lamps: headlights and tail lights, their own materials so the drive plugin can turn them up at night
  const [headL, tailL] = lamps(THREE, night)
  const hl = kit(THREE), tl = kit(THREE)
  for (const s of [-1, 1]) { hl.c(0xffffff).box(2.08, 2.18, 0.86, 1.0, s * 0.42, s * 0.8, 1, 0.92); tl.c(0xffffff).box(-2.19, -2.13, 1.14, 1.3, s * 0.72, s * 0.87) }
  add(hl.geometry(true), headL); add(tl.geometry(true), tailL)
  van.userData.lights = [headL, tailL]
  // the lamps that signal: brake lights (and a high one), reversing lights, indicators (left, right), dark until lit
  const sig = (hex) => shaded(new THREE.MeshLambertMaterial({ color: hex, emissive: hex, emissiveIntensity: 0.04, flatShading: true }), night)
  const brakeM = sig(0xff2a1e), revM = sig(0xf4f2e6), indM = [-1, 1].map(() => sig(0xffa21a)), bk = kit(THREE), rk = kit(THREE)
  bk.c(0xffffff).box(-2.185, -2.15, 2.0, 2.05, -0.3, 0.3)
  for (const s of [-1, 1]) { bk.box(-2.19, -2.13, 0.98, 1.12, s * 0.72, s * 0.87); rk.c(0xffffff).box(-2.19, -2.13, 0.78, 0.86, s * 0.74, s * 0.86) }
  add(bk.geometry(true), brakeM); add(rk.geometry(true), revM)
  for (const [i, s] of [-1, 1].entries()) { const ik = kit(THREE); ik.c(0xffffff).box(2.06, 2.16, 0.8, 0.88, s * 0.82, s * 0.9).box(-2.19, -2.13, 0.88, 0.96, s * 0.74, s * 0.86).box(1.3, 1.36, 1.46, 1.5, s * 1.0, s * 1.065); add(ik.geometry(true), indM[i]) }
  // c: the van's state (newVan()), t: seconds. Braking, reversing, and indicating into a slow turn
  van.userData.signal = (c, t) => {
    const blink = Math.abs(c.steer) > 0.2 && Math.abs(c.speed) < 9 && (t * 1.5) % 1 < 0.5
    brakeM.emissiveIntensity = c.brk > 0.05 ? 2.2 : 0.04; revM.emissiveIntensity = c.gear < 0 ? 1.8 : 0.04
    indM[0].emissiveIntensity = blink && c.steer > 0 ? 2 : 0.04; indM[1].emissiveIntensity = blink && c.steer < 0 ? 2 : 0.04
  }
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
    w.c(0x2b2e33).wheel(0, 0, 0, 0.36, 0.24, 12, 'x').c(0x3a3e44).wheel(o * 0.118, 0, 0, 0.25, 0.02, 10, 'x').c(0x6b7078).wheel(o * 0.14, 0, 0, 0.075, 0.03, 6, 'x')
    w.c(0xd8d8d2); for (let i = 0; i < 5; i++) { const a = w.at(); w.box(o * 0.12, o * 0.145, 0.04, 0.25, -0.035, 0.035, 1, 1.6); w.rot(a, 'x', (i * Math.PI * 2) / 5) } // five spokes, so the spin shows
    const g = w.geometry(true)
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
// V: what is driven (VAN, or a BUS: the same model with heavier numbers). c.parked holds it (the handbrake, or a bus's
// door interlock); c.nopower: no drive (a dewired trolleybus), the brakes still work.
export const VAN = {
  gears: [3.6, 2.15, 1.54, 1.15, 0.87], rev: 3.4, rpmPer: 160, idle: 850, redline: 6200, flare: 1500, band: [1000, 4800], up: [2300, 2700], down: [1100, 1000], pulses: 2,
  vmax: 21, vrev: 6, wb: 2.7, push: 4.3, brake: 7.8, drag: 0.00045, lock: 0.62, lockV: 7.5, under: 0.0016, thr: 5.5, brk: 9, // thr / brk: how fast the pedals come in
  pitch: [0.0085, -0.075, 0.05, 70, 8], roll: [0.011, 0.085, 55, 6.5],
  hl: 2.2, hw: 0.95, length: 4.3, width: 1.8, pivot: 0, wheel: 0.36, // collision box half length / width; pivot: how far the body's middle is ahead of the axle it turns about
  circles: [[1.45, 0, -1.45], 1.05], // against buildings: circles along it (metres ahead of the middle) and their radius
  // grip: the tyres' friction; tract: the share of it the drive wheels pull with; flat: how much less the high gears
  // pull (1: by the ratio); turnG: the cornering limit; the handbrake: its drag (m/s²), the rear grip left (slide) and
  // how much more it turns (handYaw), coming back over 1 / slipBack s; nitro: the boost's push (m/s², 0: none) and
  // top speed (× vmax); airYaw: steering while airborne (rad/s); keep: the share of a slide the tyres turn back into
  // speed as they grip again (an arcade drift doesn't scrub it off); drift: in an arcade drift the slide dies away at
  // this rate (1/s) rather than by the tyres' grip, so the cab holds an angle; mass (kg)
  grip: 0.95, tract: 0.55, flat: 1, turnG: 1.05, nitro: 0, nvmax: 1, airYaw: 0, keep: 0, drift: 0, mass: 1500,
  // the van's handbrake turn: the tail comes round in about a second and most of the slide comes back as speed
  handDrag: 2, slide: 0.3, handYaw: 2.4, slipBack: 3, hkeep: 0.6, steerRate: 9,
}
// A Vancouver city bus: 12 m (New Flyer-ish) or 18 m articulated, a 6-cylinder diesel or trolley motor through a
// five-speed automatic, slow to pull away, soft on its air springs (it leans and dives), a long wheelbase and turning
// about the rear axle, so the tail swings out on a tight turn. Artic: the front section's numbers; the rear one is
// towed (see drive/index.js).
export const BUS = {
  ...VAN, gears: [3.4, 2.0, 1.4, 1.0, 0.75], rev: 3.0, rpmPer: 110, idle: 650, redline: 2400, flare: 600, band: [800, 1400], up: [1500, 650], down: [700, 250], pulses: 3,
  vmax: 19.5, vrev: 3.5, wb: 6.2, push: 2.5, brake: 5.6, drag: 0.0009, lock: 0.7, lockV: 10, under: 0.0011, thr: 2.2, brk: 1.8, // air brakes build up: a tap is gentle
  pitch: [0.016, -0.06, 0.035, 26, 5], roll: [0.024, 0.075, 18, 3.6],
  hl: 6.1, hw: 1.28, length: 12.2, width: 2.55, pivot: 2.7, wheel: 0.5, circles: [[4.8, 2.4, 0, -2.4, -4.8], 1.35],
  handDrag: 5, handYaw: 1.4, slipBack: Infinity, hkeep: 0, steerRate: 6, // a bus doesn't do handbrake turns
}
export const ARTIC = { ...BUS, push: 2.3, wb: 5.8, hl: 5.6, length: 18.3, pivot: 2.6, circles: [[4.4, 2.2, 0, -2.2, -4.4], 1.35],
  joint: 5.85, trail: 4.4, rear: [3.7, 3.45, [2.2, 0, -2.2]] } // the joint behind the middle, the rear axle behind it; the rear box: its middle behind the joint, half length, circles
// Arcade cabs for the taxi game (taxi.js): quick, fast, forgiving; the handbrake drifts rather than stops, a nitro
// boost past the top speed, a little steering in the air. Each cab is this with its own numbers (taxiSpec).
export const TAXI = {
  ...VAN, gears: [3.3, 2.2, 1.6, 1.22, 0.96, 0.8], rpmPer: 150, redline: 6800, up: [2600, 3000], down: [1300, 1100],
  vmax: 34, vrev: 9, push: 11, brake: 11, drag: 0.00035, lock: 0.6, lockV: 16, under: 0.0005, thr: 7, brk: 12,
  tract: 0.9, flat: 0.45, turnG: 1.7, handDrag: 1.2, slide: 0.35, handYaw: 1.6, slipBack: 1.8, nitro: 9, nvmax: 1.4, airYaw: 1.6, keep: 0.75, drift: 2.2,
  // arcade feel: brakes that bite past the tyres (~2 g), engine braking off the gas, quick and sharp steering
  hkeep: 0, brake: 22, brk: 30, brakeGrip: 2.2, coast: 2.2, steerRate: 13, lockV: 30, turnG: 2.6, under: 0.0002, handYaw: 1.15,
}
// s: { vmax (m/s), push, grip, mass (kg), tank (s of nitro), wb, hl, hw, wheel, circles, ... }: TAXI with those
export const taxiSpec = (s) => ({ ...TAXI, ...s, length: s.hl * 2, width: s.hw * 2 })
const G = 9.8
export function newVan(V = VAN) {
  return { V, speed: 0, lat: 0, yaw: 0, steer: 0, kick: 0, yawRate: 0, gear: 1, rpm: V.idle, thr: 0, brk: 0, shiftT: 0, revT: 0, ax: 0,
    pitch: 0, parked: false, nopower: false, bp: 0, bpv: 0, br: 0, brv: 0, hz: 0, hv: 0, slip: 0, boost: false, air: false } // pitch: the ground's; bp / br / hz: the body on its springs; boost / air: set by the caller
}
export function stepVan(c, dt, I, grip) {
  const V = c.V, GEARS = V.gears, mu = V.grip * grip, sp = Math.abs(c.speed), s0 = c.speed
  // into reverse: hold the brake at a standstill for a moment; back into drive the same way with the gas
  if (c.gear > 0 ? I.down && c.speed < 0.3 : I.up && c.speed > -0.3) { if ((c.revT += dt) > 0.3) { c.gear = c.gear > 0 ? -1 : 1; c.revT = 0 } } else c.revT = 0
  const fwd = c.gear > 0, gas = !c.parked && !c.nopower && (fwd ? I.up : I.down), brake = fwd ? I.down : I.up
  c.thr += ((gas ? 1 : 0) - c.thr) * (1 - Math.exp(-(gas ? V.thr : 10) * dt))
  c.brk += ((brake ? 1 : 0) - c.brk) * (1 - Math.exp(-(brake ? V.brk : 9) * dt))
  // the gearbox: up early when cruising, late with the foot down; down as the revs sag (and kickdown)
  if (fwd && c.shiftT <= 0) {
    const r = sp * V.rpmPer * GEARS[c.gear - 1]
    if (c.gear < GEARS.length && r > V.up[0] + V.up[1] * c.thr) { c.gear++; c.shiftT = 0.3 } else if (c.gear > 1 && r < V.down[0] + V.down[1] * c.thr) { c.gear--; c.shiftT = 0.22 }
  }
  c.shiftT -= dt
  const ratio = fwd ? GEARS[c.gear - 1] : V.rev
  // revs: the wheels' through the gear; at a standstill the torque converter slips and the engine revs with the gas
  const rpmT = Math.max(V.idle + c.thr * V.flare * Math.max(0, 1 - sp / 4), sp * V.rpmPer * ratio) * (c.shiftT > 0 ? 0.9 : 1)
  c.rpm += (Math.min(V.redline, rpmT) - c.rpm) * (1 - Math.exp(-14 * dt))
  // pushing: torque (a flat curve, a little peak mid-range) through the gear, not past the tyres' grip; the limiter
  const tq = 0.78 + 0.22 * Math.sin(Math.PI * clamp((c.rpm - V.band[0]) / V.band[1], 0, 1))
  let push = c.shiftT > 0 ? 0 : c.thr * V.push * (ratio / GEARS[0]) ** V.flat * tq
  push = Math.min(push * clamp(((fwd ? V.vmax : V.vrev) - sp) / 1.5, 0, 1), mu * G * V.tract)
  // nitro: a push of its own, past the top speed (forward only, not when held)
  if (c.boost && fwd && V.nitro && !c.parked) push += V.nitro * clamp((V.vmax * V.nvmax - c.speed) / 3, 0, 1)
  if (c.air) push = 0 // the wheels spin in the air: only the boost pushes
  if (c.air && c.boost && fwd && V.nitro) push = V.nitro * 0.5
  c.speed += ((fwd ? push : -push) - (c.air ? 0 : G * Math.sin(clamp(c.pitch, -0.2, 0.2)) * (c.parked ? 0 : 0.8))) * dt // (no street is steeper than 20%)
  // holding back, never past a standstill: the brakes (as hard as the tyres allow), the handbrake, rolling, air, and
  // the engine off the gas
  const res = c.air ? V.drag * c.speed * c.speed : c.brk * Math.min(V.brake, mu * G * (V.brakeGrip || 1)) + (c.parked ? 12 : I.hand ? Math.min(V.handDrag, mu * G * 0.6) : 0) + 0.15 + V.drag * c.speed * c.speed + (gas ? 0 : 0.3 + c.rpm / 9000 + (V.coast || 0) * Math.min(1, sp / 8))
  c.speed = Math.abs(c.speed) <= res * dt ? 0 : c.speed - Math.sign(c.speed) * res * dt
  // steering: less lock the faster, eased in
  const maxSteer = V.lock / (1 + sp / V.lockV)
  c.steer += (clamp(I.steer, -1, 1) * maxSteer - c.steer) * (1 - Math.exp(-(I.steer ? V.steerRate || 6 : (V.steerRate || 6) * 1.5) * dt))
  // turning: the bicycle model with understeer growing with speed (more on a slippery road), never more than the
  // front tyres can hold; pushing against a wall still lets it creep round as if at walking pace
  const turnV = sp < 1.2 && gas ? (fwd ? 1.2 : -1.2) : c.speed
  let yr = (turnV * Math.tan(c.steer)) / (V.wb * (1 + (V.under / grip) * c.speed * c.speed))
  const lim = (mu * G * V.turnG) / Math.max(2, sp)
  yr = clamp(yr, -lim, lim)
  // the handbrake: the rear lets go (a van grips again as soon as it is let off, a cab's drift dies away)
  c.slip = I.hand && sp > 3 ? 1 : Math.max(0, c.slip - dt * (V.slipBack === Infinity ? 1e9 : V.slipBack))
  yr *= 1 + (V.handYaw - 1) * c.slip
  if (c.air) yr = clamp(I.steer, -1, 1) * V.airYaw // in the air: a little air control, no tyres
  yr += c.kick
  c.kick *= Math.exp(-5 * dt)
  // the van turns, its momentum doesn't: the velocity is split anew along the turned body...
  const d = yr * dt, cs = Math.cos(d), sn = Math.sin(d), s = c.speed, l = c.lat
  c.yaw += d
  c.speed = s * cs - l * sn; c.lat = s * sn + l * cs
  // ...and the tyres pull the sideways part out as hard as their grip allows: a slide where they can't
  let pull = c.air ? 0 : mu * G * (1 - (1 - V.slide) * c.slip) * dt
  if (V.drift && c.slip && !c.air) pull += (Math.abs(c.lat) * (1 - Math.exp(-V.drift * dt)) - mu * G * dt) * c.slip // arcade: an angle it holds
  const lat0 = Math.abs(c.lat)
  c.lat = Math.abs(c.lat) <= pull ? 0 : c.lat - Math.sign(c.lat) * pull
  if (c.speed > 1) c.speed += (lat0 - Math.abs(c.lat)) * (V.keep + (V.hkeep || 0) * c.slip) // (hkeep: only out of a handbrake slide)
  c.yawRate = yr
  // the body on its springs: squats as it pulls away, dives under braking, leans out of turns, bounces over kerbs
  const [pk, p0, p1, ps, pd] = V.pitch, [rk, rm, rs, rd] = V.roll
  c.ax += ((c.speed - s0) / dt - c.ax) * (1 - Math.exp(-12 * dt))
  c.bpv += ((clamp(c.ax * pk, p0, p1) - c.bp) * ps - c.bpv * pd) * dt; c.bp += c.bpv * dt
  c.brv += ((clamp(-s * yr * rk, -rm, rm) - c.br) * rs - c.brv * rd) * dt; c.br += c.brv * dt
  c.hv += (-c.hz * 90 - c.hv * 9) * dt; c.hz += c.hv * dt
}
// a kerb or a pothole under the wheels: k 0..1, front first (1) or rear first (-1), side -1 left .. 1 right
export function jolt(c, k, front = 1, side = 0) { c.hv += 1.1 * k; c.bpv += 2.6 * k * front; c.brv += 1.8 * k * side }
