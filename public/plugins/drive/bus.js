// A Vancouver city bus in the low-poly kit style (life/kit.js, like the van): a 12 m low-floor bus or an 18 m
// articulated one with its bellows, in a "Coast Transit" livery (white, a navy skirt, a yellow stripe, or the
// route's colour on B-Line and RapidBus), the black window band with people sitting behind it, a dot-matrix
// destination sign, plug doors that swing open, wheels that spin and steer, mirrors on their arms, a folded bike rack,
// and on a trolleybus the two poles up to the wires. Glass glows warm at night (the lit inside).
// Local frame like the van: forward -z, up +y, origin on the ground in the middle of the (front) section's box.
// userData: lights [head, tail], glass (material), night ({ value }), wheels [{ steer, spin, front }], doors
// [{ leaves, open }], rear (the articulated rear section, turned about the joint at userData.joint), poles
// [group] (a trolleybus), sil [instanced silhouettes], seats (how many), setSign(number, destination, colour).
import { kit, shaded } from '../life/kit.js'

const WHITE = 0xf3f4f1, NAVY = 0x1d3a86, YELLOW = 0xf5c400, DARK = 0x262a2f, GLASS = 0x3b4f63, FRAME = 0x14171a
const TYRE = 0x222428, HUB = 0xc9ccd0, ROOF = 0xe4e6e3, STEEL = 0x9aa0a8, DOORWAY = 0x2a2f35
const W = 1.275 // half width
const AXLE = 0.5, ROOF_Y = 3.08

// along the bottom, over the wheel arches ([centre x, radius]), forward +x while building
function under(x0, x1, yb, arches) {
  const out = [x0, yb]
  for (const [cx, r] of arches) { out.push(cx - r, yb); for (let i = 0; i <= 7; i++) { const t = Math.PI - (Math.PI * i) / 7; out.push(cx + r * Math.cos(t), Math.max(yb, AXLE + r * Math.sin(t))) } out.push(cx + r, yb) }
  out.push(x1, yb)
  return out
}
// plain geometry with vertex colours from a kit (drops the life shader's attributes)
function geo(k, turn = true) {
  const g = k.geometry()
  if (turn) g.rotateY(Math.PI / 2) // kit +x (forward) to -z
  g.setAttribute('color', g.attributes.aCol); g.deleteAttribute('aCol'); g.deleteAttribute('aPart'); g.deleteAttribute('aSwing')
  return g
}

// the dot-matrix destination sign, one canvas shared by the front, side and rear signs
function signTexture(THREE) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 64
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4
  t.draw = (num, dest, accent) => {
    const g = c.getContext('2d')
    g.fillStyle = '#0b0c0d'; g.fillRect(0, 0, 512, 64)
    g.fillStyle = '#ffb21e'; g.textBaseline = 'middle'
    g.font = 'bold 50px system-ui, sans-serif'
    const nw = g.measureText(num).width
    g.fillText(num, 12, 35)
    let size = 40
    g.font = `600 ${size}px system-ui, sans-serif`
    while (g.measureText(dest).width > 500 - nw - 40 && size > 18) { size -= 2; g.font = `600 ${size}px system-ui, sans-serif` }
    g.fillText(dest, nw + 30, 35)
    if (accent) { g.fillStyle = accent; g.fillRect(nw + 18, 12, 4, 40) }
    g.fillStyle = 'rgba(0,0,0,0.55)' // the dots
    for (let x = 0; x < 512; x += 4) g.fillRect(x, 0, 1, 64)
    for (let y = 0; y < 64; y += 4) g.fillRect(0, y, 512, 1)
    t.needsUpdate = true
  }
  return t
}
// the operator's name on the sides: a wordmark with a little wave, white on the navy skirt
let mark = null
function wordmark(THREE) {
  if (mark) return mark
  const c = document.createElement('canvas'); c.width = 512; c.height = 96
  const g = c.getContext('2d')
  g.strokeStyle = '#ffffff'; g.lineWidth = 7; g.lineCap = 'round'
  g.beginPath(); for (let x = 0; x <= 64; x += 2) g.lineTo(14 + x, 50 + Math.sin(x / 9) * 9); g.stroke()
  g.strokeStyle = '#f5c400'; g.beginPath(); for (let x = 0; x <= 64; x += 2) g.lineTo(14 + x, 68 + Math.sin(x / 9 + 1) * 7); g.stroke()
  g.fillStyle = '#ffffff'; g.font = 'bold 50px system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillText('Coast Transit', 98, 52)
  mark = new THREE.CanvasTexture(c); mark.colorSpace = THREE.SRGBColorSpace; mark.anisotropy = 4
  return mark
}

// one section of the body, in the kit (forward +x): o = { x0, x1 (its ends), front, rear (faces there, else a joint),
// arches, doors [[x0, x1]] (right side), accent, roof [[x0, x1]] (pods) }
function section(k, g, o) {
  const { x0, x1, arches, accent } = o
  const fx = o.front ? x1 + 0.08 : x1, rx = x0
  const pts = under(x0, x1, 0.3, arches)
  if (o.front) pts.push(x1 + 0.06, 0.34, x1 + 0.08, 1.05, x1, 2.98, x1 - 0.22, ROOF_Y)
  else pts.push(x1, ROOF_Y)
  if (o.rear) pts.push(x0 + 0.25, ROOF_Y, x0 + 0.02, 2.9, x0, 0.34)
  else pts.push(x0, ROOF_Y)
  k.c(WHITE).prism(pts, -W, W, { bevel: 0.07, narrow: (y) => Math.max(0, y - 2.7) * 0.12, edge: (i, nx, ny) => { if (ny < -0.3) k.c(DARK) } })
  // the navy skirt over the arches and the stripe above it
  const sx0 = o.rear ? rx - 0.012 : x0, sx1 = o.front ? fx + 0.012 : x1
  k.c(NAVY).prism([...under(sx0, sx1, 0.29, arches.map(([c, r]) => [c, r + 0.01])), sx1, 1.0, sx0, 1.0], -W - 0.01, W + 0.01, { bevel: 0.03 })
  k.c(accent).box(sx0 - 0.002, sx1 + 0.002, 1.0, 1.1, -W - 0.012, W + 0.012)
  // the black window band and the glass in it (the glass kit), the right side cut for the doors
  const bx0 = o.rear ? x0 + 0.35 : x0 + 0.05, bx1 = o.front ? x1 - 0.1 : x1 - 0.05
  k.c(FRAME)
  for (const s of [-1, 1]) k.box(bx0, bx1, 1.27, 2.7, s * (W + 0.002), s * (W + 0.009))
  const cuts = [...o.doors].sort((a, b) => a[0] - b[0])
  for (const s of [-1, 1]) {
    let a = bx0 + 0.08
    const spans = []
    for (const [d0, d1] of s > 0 ? cuts : []) { if (d0 > a) spans.push([a, d0 - 0.1]); a = d1 + 0.1 }
    spans.push([a, bx1 - 0.08])
    for (const [p0, p1] of spans) { // panes about 1.4 m wide with pillars between
      const n = Math.max(1, Math.round((p1 - p0) / 1.4)), w = (p1 - p0) / n
      for (let i = 0; i < n; i++) g.c(GLASS).box(p0 + i * w + 0.05, p0 + (i + 1) * w - 0.05, 1.33, 2.63, s * (W + 0.009), s * (W + 0.016))
    }
  }
  // doorways: dark, with a grab pole and a light step, under the leaves (separate meshes)
  for (const [d0, d1] of o.doors) {
    k.c(DOORWAY).box(d0, d1, 0.34, 2.68, W + 0.004, W + 0.014)
    k.c(YELLOW).box((d0 + d1) / 2 - 0.025, (d0 + d1) / 2 + 0.025, 0.4, 2.6, W + 0.014, W + 0.018)
    k.c(0xb7bcc2).box(d0 + 0.05, d1 - 0.05, 0.3, 0.36, W + 0.004, W + 0.06)
  }
  if (o.front) {
    // windscreen and a pair of wipers, the destination sign's box above it, bumper, lamps' housings, bike rack
    g.c(GLASS).prism([x1 + 0.083, 1.12, x1 + 0.097, 1.12, x1 + 0.017, 2.64, x1 + 0.003, 2.64], -1.14, 1.14)
    k.c(FRAME).prism([x1 + 0.07, 1.06, x1 + 0.1, 1.06, x1 + 0.02, 2.99, x1 - 0.01, 2.99], -1.2, -1.14).prism([x1 + 0.07, 1.06, x1 + 0.1, 1.06, x1 + 0.02, 2.99, x1 - 0.01, 2.99], 1.14, 1.2)
    k.c(FRAME).box(x1 - 0.01, x1 + 0.025, 2.66, 2.98, -1.16, 1.16)
    for (const z of [-0.55, 0.45]) k.c(DARK).box(x1 + 0.09, x1 + 0.11, 1.16, 1.2, z - 0.42, z + 0.42)
    k.c(DARK).box(x1 + 0.04, x1 + 0.2, 0.28, 0.58, -W + 0.04, W - 0.04)
    k.c(FRAME).box(x1 + 0.075, x1 + 0.095, 0.66, 0.98, -1.2, -0.68).box(x1 + 0.075, x1 + 0.095, 0.66, 0.98, 0.68, 1.2)
    k.c(STEEL) // the bike rack, folded up against the front
    for (const z of [-0.85, 0.85]) k.rod([x1 + 0.2, 0.42, z], [x1 + 0.3, 1.0, z], 0.03)
    k.rod([x1 + 0.3, 1.0, -0.85], [x1 + 0.3, 1.0, 0.85], 0.03).rod([x1 + 0.25, 0.7, -0.85], [x1 + 0.25, 0.7, 0.85], 0.025)
    for (const z of [-0.3, 0.3]) k.rod([x1 + 0.22, 0.5, z], [x1 + 0.3, 1.0, z], 0.02)
    // rabbit-ear mirrors on curved arms
    for (const s of [-1, 1]) {
      k.c(FRAME).rod([x1 - 0.15, 2.72, s * 1.15], [x1 + 0.25, 2.8, s * 1.32], 0.035).rod([x1 + 0.25, 2.8, s * 1.32], [x1 + 0.42, 2.3, s * 1.42], 0.035)
      k.box(x1 + 0.36, x1 + 0.46, 1.72, 2.36, s * 1.3, s * 1.56)
      k.c(0x7f97ad).box(x1 + 0.345, x1 + 0.36, 1.76, 2.32, s * 1.33, s * 1.53)
    }
  }
  if (o.rear) {
    g.c(GLASS).box(rx - 0.012, rx + 0.01, 1.6, 2.5, -0.95, 0.95)
    k.c(DARK).box(rx - 0.012, rx + 0.02, 0.48, 1.38, -0.95, 0.95) // engine grille and its louvres
    k.c(FRAME); for (let y = 0.6; y < 1.3; y += 0.12) k.box(rx - 0.02, rx - 0.008, y, y + 0.04, -0.85, 0.85)
    k.c(DARK).box(rx - 0.16, rx + 0.02, 0.28, 0.55, -W + 0.04, W - 0.04)
    k.c(FRAME).box(rx - 0.02, rx + 0.02, 2.56, 2.86, -0.5, 0.5)
  }
  for (const [a, b, y = 0.32, c = ROOF] of o.roof || []) k.c(c).box(a, b, ROOF_Y - 0.03, ROOF_Y + y, -0.98, 0.98, 0.92, 0.94)
}

export function makeBus(THREE, opt = {}) {
  const artic = !!opt.artic, trolley = !!opt.trolley, accent = opt.accent ?? YELLOW
  const bus = new THREE.Group(), night = { value: 0 }
  const vc = () => shaded(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), night)
  const glass = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0xffd9a0, emissiveIntensity: 0 })
  const headL = shaded(new THREE.MeshLambertMaterial({ color: 0xfff4c8, emissive: 0xfff0b0, emissiveIntensity: 0.6, flatShading: true }), night)
  const tailL = shaded(new THREE.MeshLambertMaterial({ color: 0xe03a2e, emissive: 0x801010, emissiveIntensity: 0.5, flatShading: true }), night)
  const sign = signTexture(THREE)
  const signMat = new THREE.MeshBasicMaterial({ map: sign, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  const decal = new THREE.MeshLambertMaterial({ map: wordmark(THREE), transparent: true, alphaTest: 0.3, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  const silMat = new THREE.MeshBasicMaterial({ color: 0x0f151c, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })
  const body = vc(), wheelMat = vc()
  const ud = { lights: [headL, tailL], glass, night, wheels: [], doors: [], poles: [], sil: [], seats: 0, rear: null, joint: 0, sign }
  // seated people: a head over shoulders, flat against the glass, one instance a seat
  const silKit = kit(THREE)
  silKit.c(0xffffff).box(-0.24, 0.24, 1.4, 1.86, -0.002, 0.002, 0.78, 1).box(-0.11, 0.11, 1.86, 2.16, -0.002, 0.002, 0.82, 1)
  const silGeo = geo(silKit, false)
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0)

  // builds one section into `parent`: its body, glass, lamps, wheels, doors, signs and seats
  function build(parent, o, wheelsAt, signs) {
    const k = kit(THREE), g = kit(THREE), hl = kit(THREE), tl = kit(THREE)
    section(k, g, { ...o, accent })
    if (o.front) for (const s of [-1, 1]) {
      hl.c(0xffffff).box(o.x1 + 0.07, o.x1 + 0.1, 0.72, 0.92, s * 0.72, s * 1.12)
      k.c(0xd88a1c).box(o.x1 + 0.065, o.x1 + 0.1, 0.62, 0.7, s * 0.95, s * 1.15) // indicators
    }
    if (o.rear) for (const s of [-1, 1]) tl.c(0xffffff).box(o.x0 - 0.025, o.x0 + 0.01, 0.62, 1.42, s * 1.0, s * 1.2)
    const add = (gg, m) => { const mesh = new THREE.Mesh(gg, m); parent.add(mesh); return mesh }
    add(geo(k), body); add(geo(g), glass)
    if (o.front) add(geo(hl), headL)
    if (o.rear) add(geo(tl), tailL)
    for (const [x, front, dual] of wheelsAt) for (const s of [-1, 1]) { // tyre, hub, cap; duals at the drive axle
      const w = kit(THREE), wd = dual ? 0.52 : 0.3
      w.c(TYRE).wheel(0, 0, 0, AXLE, wd, 14, 'x').c(HUB).wheel(s * (wd / 2 + 0.005), 0, 0, 0.3, 0.02, 10, 'x').c(0x6b7078).wheel(s * (wd / 2 + 0.015), 0, 0, 0.1, 0.02, 6, 'x')
      const steer = new THREE.Group(); steer.position.set(s * (W - 0.05 - wd / 2), AXLE, -x)
      const spin = new THREE.Group(); spin.add(new THREE.Mesh(geo(w, false), wheelMat)); steer.add(spin); parent.add(steer)
      ud.wheels.push({ steer, spin, front })
    }
    for (const [d0, d1] of o.doors) { // two plug-door leaves on hinges at the doorway's ends, glass in a dark frame
      const leaves = [], wl = (d1 - d0) / 2
      for (const s of [1, -1]) {
        const lk = kit(THREE)
        lk.c(FRAME).box(-0.02, 0.02, 0.36, 2.66, 0, s * wl).c(GLASS).box(-0.025, 0.025, 0.5, 2.5, s * 0.07, s * (wl - 0.06))
        lk.c(FRAME).box(-0.03, 0.03, 1.42, 1.48, s * 0.07, s * (wl - 0.06))
        const hinge = new THREE.Group(); hinge.position.set(W + 0.035, 0, s > 0 ? -d1 : -d0)
        hinge.add(new THREE.Mesh(geo(lk, false), body)); parent.add(hinge)
        leaves.push({ hinge, s })
      }
      ud.doors.push({ leaves, open: 0 })
    }
    for (const [x, y, w, side] of signs) { // the destination sign and its repeats
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 8), signMat) // (a plane faces +z)
      m.position.set(side === 1 || side === -1 ? side * (W + 0.02) : 0, y, -x)
      m.rotation.y = side === 0 ? Math.PI : side === 2 ? 0 : side * Math.PI / 2
      parent.add(m)
    }
    if (o.mark != null) for (const s of [-1, 1]) { // the wordmark on the skirt
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.375), decal)
      m.position.set(s * (W + 0.013), 0.63, -o.mark); m.rotation.y = s * Math.PI / 2; parent.add(m)
    }
    // seats: along both sides, clear of the doors and the arches' wheel housings
    const seats = []
    for (let x = o.x0 + 0.9; x < o.x1 - (o.front ? 2.2 : 0.5); x += 0.78) for (const s of [-1, 1]) {
      if (s > 0 && o.doors.some(([a, b]) => x > a - 0.4 && x < b + 0.4)) continue
      seats.push([x, s])
    }
    seats.sort((a, b) => ((a[0] * 7.31 + a[1] * 3.7) % 1.7) - ((b[0] * 7.31 + b[1] * 3.7) % 1.7)) // fill in a scattered order
    const sil = new THREE.InstancedMesh(silGeo, silMat, seats.length)
    seats.forEach(([x, s], i) => { sil.setMatrixAt(i, m4.compose(p.set(s * (W + 0.021), 0, -x), q.setFromAxisAngle(up, Math.PI / 2), one)) })
    sil.count = 0; parent.add(sil)
    ud.sil.push(sil); ud.seats += seats.length
  }

  if (!artic) {
    // 12.2 m: front axle 3.5 m ahead of the middle, the drive axle 2.7 m behind (wheelbase 6.2)
    build(bus, { x0: -6.1, x1: 6.0, front: true, rear: true, arches: [[-2.7, 0.62], [3.5, 0.58]], doors: [[4.25, 5.4], [-1.2, 0.0]], mark: 1.45,
      roof: [[-1.2, 2.2], trolley ? [-3.6, -2.0, 0.2, 0x8f949a] : [2.6, 5.2, 0.24]] },
    [[3.5, true, false], [-2.7, false, true]], [[6.03, 2.82, 2.2, 0], [2.6, 2.46, 1.5, 1], [2.6, 2.46, 1.5, -1], [-6.13, 2.71, 0.95, 2]])
    if (trolley) poles(bus, -2.75, -5.8)
  } else {
    // 18.3 m: the front section (front axle +3.2, middle axle -2.6) to the joint at -5.85; the rear one turns about it
    build(bus, { x0: -5.6, x1: 5.6, front: true, rear: false, arches: [[-2.6, 0.62], [3.2, 0.58]], doors: [[3.85, 5.0], [-0.6, 0.6]], mark: 1.6, roof: [[-0.6, 2.4], [2.8, 5.0, 0.24]] },
      [[3.2, true, false], [-2.6, false, true]], [[5.63, 2.82, 2.2, 0], [2.4, 2.46, 1.4, 1], [2.4, 2.46, 1.4, -1]])
    const rear = new THREE.Group(); rear.position.set(0, 0, 5.85); bus.add(rear)
    build(rear, { x0: -7.15, x1: -0.25, front: false, rear: true, arches: [[-4.4, 0.62]], doors: [[-2.6, -1.45]], mark: null, roof: trolley ? [[-4.6, -2.8, 0.2, 0x8f949a]] : [[-6.6, -4.4, 0.3]] },
      [[-4.4, false, true]], [[-7.18, 2.71, 0.95, 2]])
    // the bellows: accordion folds, half on each section, and the turntable's ring under them
    const b = kit(THREE), b2 = kit(THREE)
    for (let x = 0; x < 0.26; x += 0.065) { b.c(x % 0.13 < 0.06 ? 0x2b2d31 : 0x1a1c1f).box(-5.6 - x - 0.06, -5.6 - x, 0.42, 2.98, -W + 0.06, W - 0.06); b2.c(x % 0.13 < 0.06 ? 0x2b2d31 : 0x1a1c1f).box(-x - 0.06, -x, 0.42, 2.98, -W + 0.06, W - 0.06) }
    for (let x = 0; x < 0.26; x += 0.13) { b.c(0x3a3d42).box(-5.63 - x, -5.6 - x, 0.4, 3.0, -W + 0.02, W - 0.02); b2.c(0x3a3d42).box(-x - 0.03, -x, 0.4, 3.0, -W + 0.02, W - 0.02) }
    bus.add(new THREE.Mesh(geo(b), body)); rear.add(new THREE.Mesh(geo(b2), body))
    if (trolley) poles(rear, -3.1, -6.85)
    ud.rear = rear; ud.joint = 5.85
  }
  // trolley poles: from a base on the roof at kit x, reaching back over the hooks at hx; the drive plugin lifts and
  // swings them
  function poles(parent, x, hx) {
    const pk = kit(THREE)
    pk.c(0x5d6268).box(x - 0.6, x + 0.5, ROOF_Y + 0.18, ROOF_Y + 0.32, -0.55, 0.55)
    for (const s of [-1, 1]) pk.c(FRAME).box(hx - 0.1, hx + 0.1, ROOF_Y, ROOF_Y + 0.42, s * 0.2, s * 0.42) // the hooks they rest in
    parent.add(new THREE.Mesh(geo(pk), body))
    for (const s of [-1, 1]) {
      const r = kit(THREE)
      r.c(0x2b2e33).rod([0, 0, 0], [0, 0, 6.2], 0.04, 0.03).c(0x1a1b1d).box(-0.05, 0.05, -0.06, 0.08, 6.1, 6.35)
      r.c(0x8a8f96).box(-0.07, 0.07, -0.07, 0.07, -0.15, 0.25) // the spring base
      const pole = new THREE.Group(); pole.position.set(s * 0.32, ROOF_Y + 0.36, -x)
      pole.add(new THREE.Mesh(geo(r, false), body)); parent.add(pole)
      pole.rotation.order = 'YXZ'; pole.rotation.x = -0.38
      ud.poles.push(pole)
    }
  }
  ud.setSign = (num, dest, colour) => sign.draw(num, dest, colour)
  ud.setSign(opt.number || '', opt.dest || 'Not in service', opt.accent && opt.accent !== YELLOW ? '#' + new THREE.Color(opt.accent).getHexString() : null)
  // people aboard, n of them, shown in the seats
  ud.aboard = (n) => { let left = n; for (const s of ud.sil) { s.count = Math.min(left, s.instanceMatrix.count); left -= s.count } }
  bus.traverse((m) => { if (m.isMesh) { m.receiveShadow = true; m.castShadow = false } })
  bus.userData = ud
  // for other players (city.models.bus): spin the wheels at this speed
  bus.update = (dt, speed) => { for (const w of ud.wheels) w.spin.rotation.x -= (speed * dt) / AXLE }
  return bus
}
// doors: 0 shut .. 1 open
export function setDoors(bus, k) {
  for (const d of bus.userData.doors) { d.open = k; for (const { hinge, s } of d.leaves) { hinge.rotation.y = s * k * 1.45; hinge.position.x = W + 0.035 + k * 0.05 } }
}
