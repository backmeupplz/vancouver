// The Salmonberry Parcel Co. van: a small low-poly kei-style delivery van, flat-shaded Lambert like the map.
// Local frame: forward -z, up +y, origin on the ground between the axles. 4.3 m long, 1.8 m wide.
export function makeVan(THREE) {
  const van = new THREE.Group()
  const M = (color, extra) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra })
  const body = M(0xf2a07e), cream = M(0xf6ead2), dark = M(0x3a3f47), glass = M(0x5d7f96), trim = M(0x8a8f96)
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
