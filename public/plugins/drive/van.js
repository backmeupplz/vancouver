// The Salmonberry Parcel Co. van: a small low-poly kei-style delivery van, flat-shaded Lambert like the map.
// Local frame: forward -z, up +y, origin on the ground between the axles. 4.3 m long, 1.8 m wide.
export function makeVan(THREE, colour = 0xf2a07e) { // colour: the body (a hex number or CSS colour)
  const van = new THREE.Group()
  const M = (color, extra) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra })
  const body = M(new THREE.Color(colour)), cream = M(0xf6ead2), dark = M(0x3a3f47), glass = M(0x5d7f96), trim = M(0x8a8f96)
  const box = (w, h, l, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat); m.position.set(x, y, z); van.add(m); return m }

  // cargo box at the back and the cab at the front, its windshield raked back
  box(1.8, 1.55, 2.55, body, 0, 1.38, 0.72)
  const cab = new THREE.BoxGeometry(1.76, 1.3, 1.5)
  const p = cab.attributes.position
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 0 && p.getZ(i) < 0) p.setZ(i, p.getZ(i) + 0.55) // top front edge back
  cab.computeVertexNormals()
  const cabM = new THREE.Mesh(cab, body); cabM.position.set(0, 1.25, -1.28); van.add(cabM)
  box(1.7, 0.42, 4.1, cream, 0, 0.66, 0) // cream skirt all round
  box(1.84, 0.12, 2.57, cream, 0, 1.85, 0.72) // a stripe on the box
  // windows: windshield (tilted like the cab), side windows
  const ws = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.95, 0.05), glass)
  ws.position.set(0, 1.5, -1.7); ws.rotation.x = Math.atan2(0.55, 1.3); van.add(ws)
  for (const s of [-1, 1]) box(0.05, 0.6, 0.75, glass, s * 0.89, 1.52, -1.1)
  // bumpers, lights, mirrors
  box(1.86, 0.28, 0.22, dark, 0, 0.46, -2.08)
  box(1.86, 0.28, 0.2, dark, 0, 0.46, 2.07)
  const headL = M(0xfff4c8, { emissive: 0xfff0b0, emissiveIntensity: 0.6 }), tailL = M(0xe03a2e, { emissive: 0x801010, emissiveIntensity: 0.5 })
  for (const s of [-1, 1]) {
    box(0.34, 0.2, 0.06, headL, s * 0.62, 0.88, -2.03)
    box(0.22, 0.32, 0.06, tailL, s * 0.75, 1.0, 2.0)
    box(0.08, 0.2, 0.14, dark, s * 0.98, 1.45, -1.4)
  }
  van.userData.lights = [headL, tailL]
  // the back: two doors with little windows, a handle and a plate
  box(0.03, 1.2, 0.02, dark, 0, 1.4, 2.0)
  for (const s of [-1, 1]) box(0.6, 0.42, 0.04, glass, s * 0.42, 1.78, 2.0)
  box(0.2, 0.05, 0.05, trim, 0.18, 1.35, 2.01)
  box(0.5, 0.18, 0.04, cream, 0, 0.5, 2.18)
  // the logo: a salmonberry (a coral berry with a leaf) on each side of the box
  const berry = M(0xd9483b), leaf = M(0x5c9a3e)
  for (const s of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 0), berry); b.position.set(s * 0.92, 1.35, 0.7); b.scale.set(0.35, 1, 1); van.add(b)
    const l = box(0.05, 0.1, 0.32, leaf, s * 0.92, 1.66, 0.62); l.rotation.x = 0.4
  }
  // parcels strapped to the roof rack
  const kraft = M(0xc9955c), kraft2 = M(0xb8834e)
  box(1.5, 0.06, 2.2, trim, 0, 2.2, 0.7)
  box(0.7, 0.45, 0.6, kraft, -0.35, 2.45, 0.3)
  box(0.55, 0.35, 0.5, kraft2, 0.4, 2.4, 0.9).rotation.y = 0.2
  box(0.5, 0.3, 0.45, kraft2, -0.3, 2.83, 0.35).rotation.y = -0.3

  // wheels: a tyre and a hub; front pair steer
  const tyre = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 10).rotateZ(Math.PI / 2)
  const hub = new THREE.CylinderGeometry(0.2, 0.2, 0.28, 6).rotateZ(Math.PI / 2)
  const tyreM = M(0x2b2e33), hubM = M(0xd8d8d2)
  const wheels = []
  for (const [x, z] of [[-0.82, -1.35], [0.82, -1.35], [-0.82, 1.35], [0.82, 1.35]]) {
    const steer = new THREE.Group(); steer.position.set(x, 0.36, z)
    const spin = new THREE.Group()
    spin.add(new THREE.Mesh(tyre, tyreM), new THREE.Mesh(hub, hubM))
    steer.add(spin); van.add(steer)
    wheels.push({ steer, spin, front: z < 0 })
  }
  van.userData.wheels = wheels
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
