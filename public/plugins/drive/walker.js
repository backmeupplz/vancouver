// The courier on foot: a small low-poly person in the Salmonberry Parcel Co. colours, flat-shaded Lambert like the
// map. Local frame like the van: forward -z, up +y, origin on the ground between the feet; 1.75 m tall.
// pose(walker, phase, amount, run) swings the legs and arms (amount 0 standing .. 1 full stride).
export function makeWalker(THREE, colour = 0xe8735a) { // colour: the shirt
  const root = new THREE.Group(), body = new THREE.Group()
  root.add(body)
  const M = (color) => new THREE.MeshLambertMaterial({ color, flatShading: true })
  const shirt = M(new THREE.Color(colour)), cream = M(0xf6ead2), pants = M(0x3b4a5e), skin = M(0xe2b48c), hair = M(0x4a3428), shoe = M(0x2b2e33), cap = M(0xf2a07e)
  const box = (parent, w, h, l, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat); m.position.set(x, y, z); parent.add(m); return m }
  // a limb hangs from a pivot (hip or shoulder) so it can swing
  const limb = (x, y, parts) => { const g = new THREE.Group(); g.position.set(x, y, 0); for (const [w, h, l, mat, yy, zz = 0] of parts) box(g, w, h, l, mat, 0, yy, zz); body.add(g); return g }
  const legs = [-1, 1].map((s) => limb(s * 0.11, 0.9, [[0.16, 0.5, 0.19, pants, -0.24], [0.15, 0.42, 0.17, pants, -0.66], [0.16, 0.1, 0.28, shoe, -0.86, -0.05]]))
  const arms = [-1, 1].map((s) => limb(s * 0.27, 1.43, [[0.12, 0.34, 0.13, shirt, -0.15], [0.11, 0.3, 0.11, skin, -0.46], [0.1, 0.1, 0.1, skin, -0.65]]))
  box(body, 0.44, 0.58, 0.25, shirt, 0, 1.18, 0) // torso
  box(body, 0.46, 0.1, 0.27, cream, 0, 0.95, 0) // belt line
  box(body, 0.3, 0.32, 0.12, cream, 0, 1.2, 0.17) // a little backpack-style parcel bag
  box(body, 0.12, 0.08, 0.12, skin, 0, 1.51, 0) // neck
  const head = new THREE.Group(); head.position.set(0, 1.64, 0); body.add(head)
  box(head, 0.24, 0.26, 0.24, skin, 0, 0, 0)
  box(head, 0.26, 0.1, 0.26, hair, 0, 0.06, 0.02)
  box(head, 0.27, 0.07, 0.27, cap, 0, 0.13, 0) // cap
  box(head, 0.22, 0.03, 0.14, cap, 0, 0.1, -0.18) // peak
  root.traverse((m) => { if (m.isMesh) { m.receiveShadow = true; m.castShadow = false } })
  root.userData = { body, legs, arms, head, phase: 0 }
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
