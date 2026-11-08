// The courier on foot: a small low-poly person in the Salmonberry Parcel Co. colours, built with the life plugin's
// kit like the people on the sidewalks (bevelled head and torso, sleeves and hands, a cap and a parcel bag).
// Local frame like the van: forward -z, up +y, origin on the ground between the feet; 1.75 m tall.
// pose(walker, phase, amount, run) swings the legs and arms (amount 0 standing .. 1 full stride).
import { kit, shaded } from '../life/kit.js'

const CREAM = 0xf6ead2, PANTS = 0x3b4a5e, SKIN = 0xe2b48c, HAIR = 0x4a3428, SHOE = 0x2b2e33, CAP = 0xf2a07e

// look (optional): { pants, hair, skin } colours and courier: false for someone else, without the cap and the bag
export function makeWalker(THREE, colour = 0xe8735a, look = {}) { // colour: the shirt
  const { pants = PANTS, hair = HAIR, skin = SKIN, courier = true } = look
  const root = new THREE.Group(), body = new THREE.Group(), night = { value: 0 }
  root.add(body)
  const mat = shaded(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), night, false)
  const shirt = new THREE.Color(colour).getHex()
  // a part built facing +x (the kit's way), turned to face -z, hung at (x, y) in `parent`
  const part = (parent, x, y, build) => {
    const k = kit(THREE); build(k)
    const g = k.geometry().rotateY(Math.PI / 2)
    g.setAttribute('color', g.attributes.aCol)
    const o = new THREE.Group(); o.position.set(x, y, 0); o.add(new THREE.Mesh(g, mat)); parent.add(o)
    return o
  }
  const legs = [-1, 1].map((s) => part(body, s * 0.11, 0.9, (k) => {
    k.c(pants).box(-0.08, 0.08, -0.82, 0.02, -0.075, 0.075, 1.2, 1.2)
    k.c(SHOE).box(-0.07, 0.17, -0.9, -0.8, -0.065, 0.065, 0.85)
  }))
  const arms = [-1, 1].map((s) => part(body, s * 0.27, 1.43, (k) => {
    k.c(shirt).box(-0.062, 0.062, -0.34, 0.02, -0.062, 0.062, 1.15)
    k.c(skin).box(-0.05, 0.05, -0.62, -0.32, -0.05, 0.05, 1.1).box(-0.042, 0.052, -0.73, -0.6, -0.037, 0.037, 1.15)
  }))
  part(body, 0, 0, (k) => {
    k.c(pants).box(-0.11, 0.11, 0.84, 1.0, -0.18, 0.18) // hips
    const t = k.at()
    k.c(shirt).prism([-0.17, 0.97, 0.17, 0.97, 0.22, 1.34, 0.19, 1.46, -0.19, 1.46, -0.22, 1.34], -0.12, 0.13, { bevel: 0.03 })
    k.rot(t, 'y', Math.PI / 2)
    if (courier) {
      k.c(CREAM).box(-0.125, 0.135, 0.95, 1.03, -0.19, 0.19) // belt line
      k.c(CREAM).box(-0.29, -0.12, 1.04, 1.38, -0.16, 0.16, 0.95).c(0xd9483b).box(-0.3, -0.29, 1.18, 1.26, -0.04, 0.04) // the parcel bag and its berry
    }
    k.c(skin).box(-0.05, 0.05, 1.45, 1.54, -0.05, 0.05) // neck
  })
  const head = part(body, 0, 1.64, (k) => {
    k.c(skin).prism([-0.11, -0.13, 0.1, -0.13, 0.125, -0.04, 0.115, 0.08, -0.1, 0.1, -0.12, -0.01], -0.1, 0.1, { bevel: 0.032 })
    k.box(0.11, 0.145, -0.05, 0.0, -0.02, 0.02) // nose
    k.c(hair).prism([-0.135, -0.1, -0.125, 0.09, 0.0, 0.1, -0.06, 0.0, -0.08, -0.06], -0.112, 0.112, { bevel: 0.02 })
    if (courier) k.c(CAP).prism([-0.13, 0.04, 0.12, 0.04, 0.1, 0.15, -0.1, 0.16], -0.118, 0.118, { bevel: 0.035 }).box(0.08, 0.27, 0.035, 0.06, -0.1, 0.1) // cap and peak
    else k.prism([-0.135, 0.02, 0.11, 0.06, 0.1, 0.14, -0.1, 0.16], -0.116, 0.116, { bevel: 0.035 }) // the top of the hair
  })
  root.traverse((m) => { if (m.isMesh) { m.receiveShadow = true; m.castShadow = false } })
  root.userData = { body, legs, arms, head, phase: 0, night }
  // for other plugins (city.models.person): advance the walk cycle at this speed (m/s)
  root.update = (dt, speed) => { const a = Math.abs(speed), run = a > 2.4; root.userData.phase += dt * a * (run ? 2.3 : 3.6); poseWalker(root, root.userData.phase, Math.min(1, a / 1.6), run) }
  return root
}

export function poseWalker(w, phase, amount, run, carry = false) { // carry: both arms out in front, round a parcel
  const { body, legs, arms, head } = w.userData
  const s = Math.sin(phase), a = amount * (run ? 0.85 : 0.55)
  legs[0].rotation.x = s * a; legs[1].rotation.x = -s * a
  arms[0].rotation.x = carry ? 1.15 : -s * a * 0.9; arms[1].rotation.x = carry ? 1.15 : s * a * 0.9
  for (const [i, arm] of arms.entries()) arm.rotation.z = (i ? -1 : 1) * (carry ? -0.12 : 0.06 + (run ? 0.12 : 0) * amount)
  body.position.y = Math.abs(Math.cos(phase)) * (run ? 0.09 : 0.035) * amount
  body.rotation.x = -(run ? 0.22 : 0.05) * amount // lean into the stride
  head.rotation.x = (run ? 0.15 : 0.03) * amount
}
