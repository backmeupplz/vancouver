// The courier on foot: a small low-poly person in the Salmonberry Parcel Co. colours, built with the shared kit
// (round limbs, a waisted torso, hands with thumbs, sneakers, ears, eyes and a nose, hair, a cap and a parcel bag).
// Local frame like the van: forward -z, up +y, origin on the ground between the feet; 1.75 m tall.
// The joints: body (everything; bobs and hops) > legs > shins, and torso (from the waist: leans, twists, breathes)
// > arms > forearms, head. pose(walker, phase, amount, run) swings them (amount 0 standing .. 1 full stride).
import { kit, kitMaterial } from '../../core/kit.js'

const CREAM = 0xf6ead2, SHIRT = 0xe8735a, PANTS = 0x3b4a5e, SKIN = 0xe2b48c, HAIR = 0x4a3428, SHOE = 0x2b2e33, CAP = 0xf2a07e, EYE = 0x2a2420
const SLOTS = { shirt: SHIRT, pants: PANTS, cap: CAP } // the clothes that can be repainted (paint()), by the colour they are built in

// stacked elliptical rings [y, half depth, half width, forward shift] joined into a tube of 8 sides; caps: 1 top, 2 bottom
function tube(k, rings, caps = 0, a0, a1) {
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], B = rings[i + 1], s = k.at()
    k.cyl(1, 1, 1, 8, (i === rings.length - 2 ? caps & 1 : 0) | (i ? 0 : caps & 2), a0, a1)
    k.xf(s, (p) => { const t = p.y, m = (j) => A[j] + (B[j] - A[j]) * t; p.set(p.x * m(1) + ((A[3] || 0) + ((B[3] || 0) - (A[3] || 0)) * t), m(0), p.z * m(2)) })
  }
  return k
}

// look (optional): { pants, hair, skin, cap } colours and courier: false for someone else, without the cap and the bag
export function makeWalker(THREE, colour = SHIRT, look = {}) { // colour: the shirt
  const { hair = HAIR, skin = SKIN, courier = true } = look
  const root = new THREE.Group(), body = new THREE.Group(), night = { value: 0 }
  root.add(body)
  const mat = kitMaterial(THREE, night, false), dark = new THREE.Color(skin).multiplyScalar(0.72).getHex()
  // a part built facing +x (the kit's way; +z its right), turned to face -z, hung at (x, y) in `parent`
  const part = (parent, x, y, build) => {
    const k = kit(THREE); build(k)
    const g = k.geometry(true).rotateY(Math.PI / 2)
    g.userData.base = g.attributes.color.array.slice()
    const o = new THREE.Group(); o.position.set(x, y, 0); o.add(new THREE.Mesh(g, mat)); parent.add(o)
    return o
  }
  // legs and arms in two parts: the shin hangs from the knee, the forearm from the elbow
  const legs = [-1, 1].map((s) => part(body, s * 0.09, 0.88, (k) => k.c(PANTS).rod([0, 0.03, 0], [0, -0.44, 0], 0.088, 0.066)))
  const shins = legs.map((leg) => part(leg, 0, -0.42, (k) => {
    k.c(PANTS).rod([0, 0.03, 0], [0, -0.39, 0], 0.064, 0.046)
    k.c(SHOE).prism([-0.075, -0.46, 0.17, -0.46, 0.175, -0.425, 0.09, -0.37, -0.07, -0.37], -0.056, 0.056, { bevel: 0.012 })
    k.c(CREAM).box(-0.08, 0.178, -0.478, -0.456, -0.059, 0.059) // the sole
  }))
  part(body, 0, 0, (k) => {
    tube(k.c(PANTS), [[0.8, 0.1, 0.15], [0.86, 0.108, 0.168], [0.99, 0.104, 0.164]], 2)
    if (courier) tube(k.c(CREAM), [[0.955, 0.11, 0.17], [0.99, 0.11, 0.17]]) // belt line
  })
  const torso = part(body, 0, 1.0, (k) => {
    tube(k.c(SHIRT), [[-0.04, 0.1, 0.16], [0.12, 0.098, 0.156], [0.33, 0.125, 0.198, 0.01], [0.43, 0.1, 0.185], [0.5, 0.06, 0.085]], 1)
    k.c(skin).rod([0, 0.48, 0], [0.005, 0.56, 0], 0.05, 0.046)
    if (courier) { // the parcel bag and its berry, a strap over each shoulder
      k.c(0xb98a55).prism([-0.09, 0.08, -0.23, 0.1, -0.24, 0.36, -0.1, 0.41], -0.135, 0.135, { bevel: 0.035 }) // kraft paper brown
      k.c(CREAM).prism([-0.1, 0.3, -0.248, 0.27, -0.25, 0.365, -0.1, 0.418], -0.14, 0.14, { bevel: 0.03 }) // its flap
      k.c(0xd9483b).box(-0.262, -0.245, 0.285, 0.345, -0.03, 0.03)
      for (const s of [-1, 1]) k.c(CREAM).box(0.085, 0.136, 0.2, 0.425, s * 0.105 - 0.018, s * 0.105 + 0.018).box(-0.1, 0.1, 0.425, 0.45, s * 0.105 - 0.018, s * 0.105 + 0.018)
    }
  })
  const arms = [-1, 1].map((s) => part(torso, s * 0.228, 0.41, (k) => {
    k.c(SHIRT).rod([0, 0.03, 0], [0, -0.17, 0], 0.07, 0.062).rod([0, 0.03, 0], [0, 0.06, 0], 0.07, 0.045) // a short sleeve, the shoulder
    k.c(skin).rod([0, -0.15, 0], [0, -0.31, 0], 0.048, 0.043)
  }))
  const forearms = arms.map((arm, i) => part(arm, 0, -0.29, (k) => {
    k.c(skin).rod([0, 0.02, 0], [0, -0.26, 0], 0.044, 0.035)
    k.box(-0.032, 0.036, -0.36, -0.25, -0.022, 0.022, 0.8).box(0.03, 0.052, -0.31, -0.262, (i ? -1 : 1) * 0.02 - 0.012, (i ? -1 : 1) * 0.02 + 0.012) // a hand, its thumb
  }))
  const head = part(torso, 0, 0.53, (k) => {
    tube(k.c(skin), [[0, 0.055, 0.058, 0.012], [0.045, 0.09, 0.084, 0.012], [0.11, 0.104, 0.097, 0.008], [0.17, 0.105, 0.1], [0.215, 0.086, 0.086]], 3)
    k.box(0.1, 0.128, 0.082, 0.125, -0.014, 0.014) // nose
    for (const s of [-1, 1]) k.box(-0.02, 0.015, 0.095, 0.145, s * 0.094, s * 0.112) // ears
    k.c(dark).box(0.09, 0.103, 0.052, 0.061, -0.026, 0.026) // mouth
    for (const s of [-1, 1]) k.c(EYE).box(0.096, 0.111, 0.125, 0.15, s * 0.045 - 0.012, s * 0.045 + 0.012).c(hair).box(0.098, 0.113, 0.16, 0.168, s * 0.045 - 0.02, s * 0.045 + 0.02) // eyes, brows
    tube(k.c(hair), [[0.06, 0.1, 0.1], [0.1, 0.113, 0.108], [0.19, 0.112, 0.108]], 0, Math.PI * 0.42, Math.PI * 1.58) // round the back, ear to ear
    if (courier) { // cap and peak
      tube(k.c(CAP), [[0.165, 0.114, 0.109], [0.215, 0.106, 0.102], [0.248, 0.07, 0.07]], 1)
      k.prism([0.085, 0.165, 0.255, 0.155, 0.255, 0.17, 0.085, 0.185], -0.082, 0.082)
    } else {
      tube(k, [[0.165, 0.113, 0.109], [0.215, 0.108, 0.103], [0.255, 0.07, 0.07]], 1)
      k.box(0.07, 0.118, 0.165, 0.205, -0.085, 0.085) // a fringe
    }
  })
  root.traverse((m) => { if (m.isMesh) { m.receiveShadow = true; m.castShadow = false } })
  root.userData = { body, torso, legs, shins, arms, forearms, head, phase: 0, night }
  // the clothes in other colours: { shirt, pants, cap } (CSS colours or hex numbers; one left out keeps its first colour)
  const a = new THREE.Color(), b = new THREE.Color()
  root.paint = (to = {}) => root.traverse((m) => {
    const c = m.geometry?.attributes.color, base = m.geometry?.userData.base; if (!base) return
    for (const [slot, from] of Object.entries(SLOTS)) {
      a.set(from); b.set(to[slot] ?? from)
      for (let i = 0; i < c.count; i++) if (Math.abs(base[i * 3] - a.r) + Math.abs(base[i * 3 + 1] - a.g) + Math.abs(base[i * 3 + 2] - a.b) < 1e-3) c.setXYZ(i, b.r, b.g, b.b)
    }
    c.needsUpdate = true
  })
  if (colour !== SHIRT || look.pants != null || look.cap != null) root.paint({ shirt: colour, pants: look.pants, cap: look.cap })
  // for other plugins (city.models.person): advance the walk cycle at this speed (m/s)
  root.update = (dt, speed) => { const a = Math.abs(speed), run = a > 2.4; root.userData.phase += dt * a * (run ? 2.3 : 3.6); poseWalker(root, root.userData.phase, Math.min(1, a / 1.6), run) }
  return root
}

// carry: both arms out in front, round a parcel. m (optional, the drive plugin's `man`): lean (rad, forward: setting
// off, uphill; back: stopping, downhill), bank (rad, into a turn), air (0 .. 1 through a hop)
export function poseWalker(w, phase, amount, run, carry = false, m = null) {
  const { body, torso, legs, shins, arms, forearms, head } = w.userData
  const s = Math.sin(phase), c = Math.cos(phase), a = amount * (run ? 0.85 : 0.55), still = 1 - amount
  const br = Math.sin(performance.now() / 620) // breathing, seen when standing
  const hop = m?.air ? Math.sin(Math.PI * m.air) : 0, lean = m?.lean || 0
  legs[0].rotation.x = s * a + hop * 0.5; legs[1].rotation.x = -s * a + hop * 0.25
  arms[0].rotation.x = carry ? 1.15 : -s * a * 0.9; arms[1].rotation.x = carry ? 1.15 : s * a * 0.9
  for (const i of [0, 1]) { // the knee of the leg swinging forward bends; the elbows a little, more at a run or round a parcel
    shins[i].rotation.x = -Math.max(0, i ? -c : c) * amount * (run ? 1.5 : 0.95) - hop * 0.9
    forearms[i].rotation.x = carry ? 0.35 : 0.12 + amount * (run ? 1.1 : 0.25 + 0.3 * Math.max(0, i ? -s : s))
    legs[i].rotation.z = 0; shins[i].rotation.z = 0
  }
  for (const [i, arm] of arms.entries()) arm.rotation.z = (i ? -1 : 1) * (carry ? -0.12 : 0.07 + 0.012 * br * still + (run ? 0.12 : 0) * amount + hop * 0.5)
  body.position.y = Math.abs(c) * (run ? 0.09 : 0.035) * amount + hop * 0.42
  body.rotation.x = -(run ? 0.1 : 0.02) * amount - lean * 0.4 // lean into the stride, the whole body a little
  torso.rotation.set(-(run ? 0.14 : 0.04) * amount - lean * 0.6, carry ? 0 : s * a * 0.22, m?.bank || 0) // the shoulders turn against the hips
  torso.scale.y = 1 + 0.01 * br * still
  head.rotation.set((run ? 0.15 : 0.04) * amount + lean * 0.5, carry ? 0 : -s * a * 0.15, 0)
}
