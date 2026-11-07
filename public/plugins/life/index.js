// Life: traffic, traffic lights and people on the real streets of whatever map tiles are loaded.
// The street graph, signals, crossings, stop signs, benches and bus stops come from the map tiles
// (OpenStreetMap, © OpenStreetMap contributors, ODbL). The simulation runs in worker.js; this file streams the
// nearby tiles to it, ticks it once per drawn frame and draws what it sends back: one instanced mesh per kind of
// car, one for people and one for cyclists (positioned in the vertex shader straight from the worker's floats),
// plus the signal poles and heads at signalled junctions. Nothing runs when zoomed out, switched off or hidden.
// It publishes city.traffic (see PLUGINS.md): where the cars are, and obstacles (a player's van) they brake for.

const CAR_ZOOM = 0.08, PEOPLE_ZOOM = 0.25
const KEY = 'vancouver.life'
const MOBILE = matchMedia('(pointer: coarse)').matches || innerWidth < 700
const MAX_CARS = MOBILE ? 2000 : 4000, MAX_PEOPLE = MOBILE ? 1500 : 3000, MAX_BIKES = 300
const KINDS = 6 // sedan, suv, van, truck, taxi, police

export default function life(city) {
  const { THREE } = city
  const set = { on: true, cars: true, people: true, bikes: true, density: 1 }
  try { Object.assign(set, JSON.parse(localStorage.getItem(KEY)) || {}) } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(set)) } catch {} }

  // ---------------------------------------------------------------- models
  const uni = { uNight: { value: 0 }, uTime: { value: 0 } }
  // boxes: [x0, x1, y0, y1, z half-width, colour (null = the instance's colour), part, taper (top scale), swing, z centre]
  // parts: cars 0 body, 1 fixed colour, 2 headlight, 3 taillight, 4/5 police beacons, 6 taxi sign, 7/8 left/right blinkers;
  // people 0 shirt, 1 trousers, 2 skin, 3 hair, 4 fixed, 5 bike frame. swing: ±1 legs, ±2 arms (left/right)
  function model(boxes) {
    const P = [], C = [], A = [], S = [], col = new THREE.Color()
    for (const [x0, x1, y0, y1, hw, c, part = c == null ? 0 : 1, taper = 1, swing = 0, zc = 0] of boxes) {
      col.setHex(c ?? 0xffffff)
      const xm = (x0 + x1) / 2, tx = ((x1 - x0) / 2) * taper, tz = hw * taper
      const v = [[x0, y0, zc - hw], [x1, y0, zc - hw], [x1, y0, zc + hw], [x0, y0, zc + hw], [xm - tx, y1, zc - tz], [xm + tx, y1, zc - tz], [xm + tx, y1, zc + tz], [xm - tx, y1, zc + tz]]
      for (const f of [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]) {
        // counter-clockwise seen from outside (else the near faces are culled and a car shows its insides)
        for (const i of [f[0], f[1], f[2], f[0], f[2], f[3]]) { P.push(...v[i]); C.push(col.r, col.g, col.b); A.push(part); S.push(swing) }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(C, 3))
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(A, 1))
    g.setAttribute('aSwing', new THREE.Float32BufferAttribute(S, 1))
    g.computeVertexNormals()
    return g
  }
  const TYRE = 0x1d1f22, GLASS = 0x2c3c4e, HEAD = 0xfff2d0, TAIL = 0xb3121a
  const AMBER = 0xd88a1c
  // blinker lamps at the four corners: drawn only while that side blinks (collapsed in the shader otherwise)
  const blinkers = (f, r, y0, y1, z) => [7, 8].flatMap((part) => [f - 0.06, r - 0.04].map((x) => [x, x + 0.1, y0 - 0.02, y1 + 0.02, 0.2, AMBER, part, 1, 0, (part === 7 ? -1 : 1) * (z - 0.18)]))
  const wheels = (xs, r, side) => xs.flatMap((x) => [-side, side].map((z) => [x - r, x + r, 0, 2 * r, 0.13, TYRE, 1, 1, 0, z]))
  const sedan = (extra = []) => model([
    [-2.25, 2.25, 0.3, 0.95, 0.9, null], // body
    [-1.15, 0.85, 0.95, 1.45, 0.8, GLASS, 1, 0.82], // cabin glass
    [-1.0, 0.6, 1.45, 1.5, 0.66, null], // roof
    [2.2, 2.27, 0.62, 0.8, 0.75, HEAD, 2], [-2.27, -2.2, 0.66, 0.84, 0.78, TAIL, 3],
    ...wheels([-1.38, 1.38], 0.33, 0.8), ...blinkers(2.25, -2.25, 0.62, 0.8, 0.9), ...extra,
  ])
  const MODELS = [
    sedan(),
    model([ // suv
      [-2.4, 2.4, 0.38, 1.15, 0.95, null], [-1.95, 1.0, 1.15, 1.78, 0.88, GLASS, 1, 0.9], [-1.85, 0.8, 1.78, 1.84, 0.8, null],
      [2.35, 2.42, 0.78, 0.98, 0.8, HEAD, 2], [-2.42, -2.35, 0.82, 1.02, 0.82, TAIL, 3], ...wheels([-1.5, 1.5], 0.38, 0.85), ...blinkers(2.4, -2.4, 0.8, 0.98, 0.95),
    ]),
    model([ // van
      [-2.7, 2.7, 0.36, 1.15, 1.0, null], [-2.7, 1.25, 1.15, 2.35, 1.0, null], [1.25, 1.95, 1.15, 2.05, 0.96, GLASS, 1, 0.9],
      [2.65, 2.72, 0.7, 0.92, 0.85, HEAD, 2], [-2.72, -2.65, 0.8, 1.05, 0.88, TAIL, 3], ...wheels([-1.85, 1.75], 0.36, 0.9), ...blinkers(2.7, -2.7, 0.72, 0.92, 1.0),
    ]),
    model([ // truck: cab and a box
      [-4.3, 4.3, 0.42, 0.9, 1.05, 0x2a2c30, 1], [2.55, 4.3, 0.9, 2.85, 1.2, null], [4.27, 4.33, 1.75, 2.6, 1.05, GLASS, 1],
      [-4.3, 2.4, 0.9, 3.7, 1.25, 0xeeeee8, 1],
      [4.28, 4.35, 0.95, 1.2, 0.9, HEAD, 2], [-4.35, -4.28, 1.0, 1.25, 1.0, TAIL, 3], ...wheels([-3.2, -2.1, 3.3], 0.45, 1.0), ...blinkers(4.3, -4.3, 1.0, 1.22, 1.15),
    ]),
    sedan([[-0.45, 0.05, 1.5, 1.74, 0.32, 0xfaf6e8, 6]]), // taxi: roof sign
    sedan([[-1.25, 1.25, 0.36, 0.86, 0.91, 0x15171a, 1], [-0.3, 0.0, 1.5, 1.64, 0.3, 0xff2020, 4, 1, 0, -0.32], [-0.3, 0.0, 1.5, 1.64, 0.3, 0x2050ff, 5, 1, 0, 0.32]]), // police
  ]
  const H = 1.08 // people a touch larger than life, so they read at street zoom
  const person = model([
    [-0.08, 0.08, 0, 0.86, 0.075, null, 1, 1, 1, 0.1], [-0.08, 0.08, 0, 0.86, 0.075, null, 1, 1, -1, -0.1], // legs
    [-0.12, 0.12, 0.84, 1.42, 0.2, null, 0, 0.92], // torso
    [-0.06, 0.06, 0.86, 1.4, 0.06, null, 0, 1, 2, 0.27], [-0.06, 0.06, 0.86, 1.4, 0.06, null, 0, 1, -2, -0.27], // arms
    [-0.11, 0.11, 1.45, 1.7, 0.1, null, 2], // head
    [-0.13, 0.1, 1.64, 1.75, 0.115, null, 3], // hair
  ])
  person.scale(H, H, H)
  const bike = model([
    [-0.85, -0.2, 0, 0.66, 0.03, 0x222428, 4], [0.2, 0.85, 0, 0.66, 0.03, 0x222428, 4], [-0.55, 0.55, 0.55, 0.62, 0.035, null, 5], // wheels, frame
    [0.45, 0.55, 0.6, 1.0, 0.03, 0x333333, 4], [0.42, 0.5, 1.0, 1.04, 0.3, 0x333333, 4], [-0.35, -0.12, 0.9, 0.95, 0.08, 0x222222, 4], // fork, bars, saddle
    [-0.08, 0.08, 0.15, 0.95, 0.07, null, 1, 1, 1, 0.12], [-0.08, 0.08, 0.15, 0.95, 0.07, null, 1, 1, -1, -0.12], // legs
    [-0.38, -0.02, 0.92, 1.5, 0.19, null, 0, 0.85], [-0.27, -0.05, 1.52, 1.76, 0.1, null, 2], [-0.29, -0.07, 1.7, 1.8, 0.11, null, 3],
    [-0.2, 0.45, 1.25, 1.33, 0.05, null, 0, 1, 0, 0.24], [-0.2, 0.45, 1.25, 1.33, 0.05, null, 0, 1, 0, -0.24], // arms to the bars
  ])

  function material(kind) {
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff })
    m.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, uni)
      s.vertexShader = s.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 iA, iB; attribute vec3 aCol; attribute float aPart, aSwing; uniform float uNight, uTime;
          varying vec3 vCol, vEmit;
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
            float pose = floor(iB.y + 0.001), seed = fract(iB.y) / 0.9;
            vec3 skin[4] = vec3[](vec3(0.98, 0.80, 0.66), vec3(0.87, 0.65, 0.48), vec3(0.62, 0.43, 0.29), vec3(0.40, 0.27, 0.18));
            vec3 hair[5] = vec3[](vec3(0.12, 0.09, 0.07), vec3(0.35, 0.22, 0.12), vec3(0.85, 0.70, 0.40), vec3(0.55, 0.55, 0.55), vec3(0.05, 0.05, 0.06));
            vec3 col = aPart < 0.5 ? unpack(iB.z) : aPart < 1.5 ? unpack(iB.w) : aPart < 2.5 ? pow(skin[int(seed * 3.99)], vec3(2.2))
              : aPart < 3.5 ? pow(hair[int(fract(seed * 7.13) * 4.99)], vec3(2.2)) : aPart > 4.5 ? unpack(iB.z) * 0.8 : aCol;
            vec3 em = vec3(0.0);
            if (aSwing != 0.0) {
              bool leg = abs(aSwing) < 1.5; float sd = sign(aSwing), a = 0.0;
              vec2 piv = vec2(0.0, (leg ? ${kind === 'bike' ? '0.95' : '0.86'} : 1.38) * ${kind === 'bike' ? '1.0' : H.toFixed(3)});
              if (pose < 0.5) a = sin(iB.x) * (leg ? 0.5 : -0.45) * sd;
              else if (pose > 1.5 && pose < 2.5) a = leg ? 1.5708 : 0.3;
              else if (pose > 2.5) a = 0.55 + sin(iB.x + (sd > 0.0 ? 0.0 : 3.1416)) * 0.5;
              P0.xy = rot(P0.xy, piv, a); N0.xy = rot(N0.xy, vec2(0.0), a);
            }
            if (pose > 1.5 && pose < 2.5) P0.y -= 0.38;`}
          vCol = col; vEmit = em;
          vec3 objectNormal = orient(N0, iA.w, pitch);`)
        .replace('#include <begin_vertex>', 'vec3 transformed = orient(P0, iA.w, pitch) + iA.xyz;')
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCol, vEmit;')
        .replace('#include <color_fragment>', 'diffuseColor.rgb *= vCol;')
        .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += vEmit;')
    }
    m.customProgramCacheKey = () => 'life-' + kind
    return m
  }
  const group = new THREE.Group(), glowGroup = new THREE.Group()
  city.scene.add(group); city.overlay.add(glowGroup)
  // instanced meshes whose per-instance data is an 8-float interleaved buffer filled from the worker
  function instanced(geo, mat, cap, parent = group) {
    const ib = new THREE.InstancedInterleavedBuffer(new Float32Array(cap * 8), 8).setUsage(THREE.DynamicDrawUsage)
    const g = new THREE.InstancedBufferGeometry().copy(geo)
    g.instanceCount = 0
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 4, 0))
    g.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 4, 4))
    const m = new THREE.Mesh(g, mat)
    m.frustumCulled = false; m.receiveShadow = true; m.matrixAutoUpdate = false
    parent.add(m)
    return { m, ib, cap }
  }
  const carMat = material('car'), personMat = material('person'), bikeMat = material('bike')
  const carMeshes = MODELS.map((g) => instanced(g, carMat, MAX_CARS))
  const people = instanced(person, personMat, MAX_PEOPLE)
  const bikes = instanced(bike, bikeMat, MAX_BIKES)
  // light on the road at night (overlay, additive): a headlight pool ahead of each car and a red glow behind,
  // sharing the cars' instance buffers. x is metres out from the bumper; z across; w: 0 ahead, 1 behind
  const poolGeo = new THREE.BufferGeometry()
  const quad = (x0, x1, z0, z1, w) => [x0, -z0, w, x1, -z1, w, x1, z1, w, x0, -z0, w, x1, z1, w, x0, z0, w]
  poolGeo.setAttribute('position', new THREE.Float32BufferAttribute([...quad(0, 10, 0.9, 3.4, 0), ...quad(0, 3, 0.9, 1.4, 1)], 3))
  const HALF = MODELS.map((g) => { g.computeBoundingBox(); return g.boundingBox.max.x })
  const WIDE = MODELS.map((g) => g.boundingBox.max.z * 2)
  const pools = carMeshes.map(({ ib }, k) => {
    const g = new THREE.InstancedBufferGeometry().copy(poolGeo)
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(ib, 4, 0)); g.setAttribute('iB', new THREE.InterleavedBufferAttribute(ib, 4, 4))
    g.instanceCount = 0
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...uni, uHalf: { value: HALF[k] } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec4 iA, iB; uniform float uHalf; varying float vF, vRear, vBrake;
        void main() {
          vRear = position.z; vBrake = mod(iB.z, 2.0);
          float x = position.x, len = vRear > 0.5 ? 3.0 : 10.0;
          vF = 1.0 - x / len;
          x = vRear > 0.5 ? -(uHalf + x) : uHalf + x;
          vec3 p = vec3(x, 0.3, position.y);
          float c = cos(iA.w), s = sin(iA.w);
          vec3 w = vec3(p.x * c + p.z * s, p.y + p.x * sin(iB.x), -p.x * s + p.z * c) + iA.xyz;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: `uniform float uNight; varying float vF, vRear, vBrake;
        void main() {
          vec3 c = vRear > 0.5 ? vec3(1.0, 0.08, 0.05) * (0.35 + 0.5 * vBrake) : vec3(1.0, 0.85, 0.6) * 0.8;
          gl_FragColor = vec4(c * vF * vF * uNight, 1.0);
        }`,
    })
    const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.matrixAutoUpdate = false
    glowGroup.add(m)
    return m
  })

  // ---------------------------------------------------------------- signals and benches (static, per network)
  const sig = { group: new THREE.Group(), heads: null, ctls: null, state: null, lamps: null, glow: null, meshes: [] }
  group.add(sig.group)
  const poleGeo = new THREE.CylinderGeometry(0.12, 0.15, 6.4, 6).translate(0, 3.2, 0)
  const armGeo = new THREE.BoxGeometry(1, 0.16, 0.16).translate(0.5, 0, 0)
  const headGeo = new THREE.BoxGeometry(0.42, 1.15, 0.42)
  const lampGeo = new THREE.BoxGeometry(0.14, 0.28, 0.3)
  const benchGeo = model([[-0.24, 0.2, 0.42, 0.5, 0.8, 0x9a6a3a], [-0.26, -0.2, 0.5, 0.95, 0.8, 0x9a6a3a], [-0.2, 0.15, 0, 0.42, 0.04, 0x3a3d42, 1, 1, 0, -0.65], [-0.2, 0.15, 0, 0.42, 0.04, 0x3a3d42, 1, 1, 0, 0.65]])
  const greyMat = new THREE.MeshLambertMaterial({ color: 0x6b7178 }), housingMat = new THREE.MeshLambertMaterial({ color: 0xd9a51e })
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const benchMat = new THREE.MeshLambertMaterial({ vertexColors: true })
  benchGeo.setAttribute('color', benchGeo.attributes.aCol)
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64
    const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)')
    x.fillStyle = g; x.fillRect(0, 0, 64, 64)
    return new THREE.CanvasTexture(c)
  })()
  const glowMat = new THREE.PointsMaterial({ size: 8, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false })
  const LIT = [0xff2a1a, 0xffa800, 0x2bff70].map((h) => new THREE.Color(h)), DARK = [0x3a2422, 0x3a3222, 0x1e3326].map((h) => new THREE.Color(h))
  const S = 1.5 // signal heads a bit larger than life
  function buildSignals(heads, ctls) {
    for (const m of sig.meshes) { m.removeFromParent(); m.dispose?.() }
    sig.meshes = []
    sig.heads = heads; sig.ctls = ctls
    const n = heads.length / 8
    sig.state = new Int8Array(n).fill(-1)
    if (!n) return
    const pole = new THREE.InstancedMesh(poleGeo, greyMat, n), arm = new THREE.InstancedMesh(armGeo, greyMat, n), head = new THREE.InstancedMesh(headGeo, housingMat, n)
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, n * 3)
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0)
    const gpos = new Float32Array(n * 3), gcol = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const [x, y, h, armYaw, armLen, headYaw] = heads.subarray(i * 8, i * 8 + 6)
      pole.setMatrixAt(i, M.makeTranslation(x, h, -y))
      arm.setMatrixAt(i, M.compose(V.set(x, h + 6.1, -y), Q.setFromAxisAngle(Y, armYaw), new THREE.Vector3(armLen, 1, 1)))
      const hx = x + Math.cos(armYaw) * armLen * 0.9, hy = y + Math.sin(armYaw) * armLen * 0.9, hh = h + 6.1 - 0.55 * S
      head.setMatrixAt(i, M.compose(V.set(hx, hh, -hy), Q.setFromAxisAngle(Y, headYaw), new THREE.Vector3(S, S, S)))
      for (let k = 0; k < 3; k++) {
        const fx = Math.cos(headYaw) * 0.24 * S, fy = Math.sin(headYaw) * 0.24 * S
        lamps.setMatrixAt(i * 3 + k, M.compose(V.set(hx + fx, hh + (0.36 - k * 0.36) * S, -(hy + fy)), Q.setFromAxisAngle(Y, headYaw), new THREE.Vector3(S, S, S)))
        lamps.setColorAt(i * 3 + k, DARK[2 - k])
      }
      gpos.set([hx + Math.cos(headYaw) * 0.4 * S, hh, -(hy + Math.sin(headYaw) * 0.4 * S)], i * 3)
    }
    const glowGeo = new THREE.BufferGeometry()
    glowGeo.setAttribute('position', new THREE.BufferAttribute(gpos, 3)); glowGeo.setAttribute('color', new THREE.BufferAttribute(gcol, 3))
    const glow = new THREE.Points(glowGeo, glowMat)
    glow.frustumCulled = false
    for (const m of [pole, arm, head, lamps]) { m.computeBoundingSphere(); m.castShadow = false; m.receiveShadow = true; sig.group.add(m); sig.meshes.push(m) }
    glowGroup.add(glow); sig.meshes.push(glow)
    sig.lamps = lamps; sig.glow = glow
  }
  let benchMesh = null
  function buildBenches(b) {
    if (benchMesh) { benchMesh.removeFromParent(); benchMesh.dispose() }
    benchMesh = null
    const n = b.length / 4
    if (!n) return
    benchMesh = new THREE.InstancedMesh(benchGeo, benchMat, n)
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1)
    for (let i = 0; i < n; i++) benchMesh.setMatrixAt(i, M.compose(V.set(b[i * 4], b[i * 4 + 2], -b[i * 4 + 1]), Q.setFromAxisAngle(Y, b[i * 4 + 3]), one))
    benchMesh.computeBoundingSphere(); benchMesh.receiveShadow = true
    benchMesh.visible = peopleOn
    group.add(benchMesh)
  }
  // 2 green, 1 amber, 0 red (the worker's rule, on the worker's clock)
  function light(c, g, t) {
    const q = sig.ctls, o = c * 6, A = q[o + 4], u = (t + q[o + 1]) % q[o], v = g ? u - (q[o + 2] + A + q[o + 5]) : u, G = q[o + 2 + g]
    return v < 0 ? 0 : v < G ? 2 : v < G + A ? 1 : 0
  }
  let sigAt = 0
  function updateSignals(t) {
    if (!sig.lamps || Math.abs(t - sigAt) < 0.1) return
    sigAt = t
    const n = sig.state.length
    let changed = false
    const gc = sig.glow.geometry.attributes.color
    for (let i = 0; i < n; i++) {
      const st = light(sig.heads[i * 8 + 6], sig.heads[i * 8 + 7], t)
      if (st === sig.state[i]) continue
      sig.state[i] = st; changed = true
      for (let k = 0; k < 3; k++) sig.lamps.setColorAt(i * 3 + k, 2 - k === st ? LIT[st] : DARK[2 - k])
      const p = sig.glow.geometry.attributes.position
      const hh = sig.heads[i * 8 + 2] + 6.1 - 0.55 * S
      p.setY(i, hh + (0.36 - (2 - st) * 0.36) * S)
      gc.setXYZ(i, LIT[st].r, LIT[st].g, LIT[st].b)
      p.needsUpdate = true
    }
    if (changed) { sig.lamps.instanceColor.needsUpdate = true; gc.needsUpdate = true }
  }

  // ---------------------------------------------------------------- the worker
  const worker = new Worker(new URL('./worker.js', import.meta.url))
  if (location.search.includes('lifedebug')) window.lifeDebug = (x, y, r = 30) => new Promise((ok) => { debugCb = ok; worker.postMessage({ type: 'debug', x, y, r }) })
  let debugCb = null
  let busy = false, accDt = 0, spare = null, simT = 0, simAt = 0, stats = { cars: 0, people: 0 }
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'frame') {
      busy = false; spare = m.buf
      if (!active) return
      let off = 0
      for (let k = 0; k < KINDS; k++) {
        const n = Math.min(m.counts[k], carMeshes[k].cap)
        put(carMeshes[k], m.buf, off, n); pools[k].geometry.instanceCount = n
        off += m.counts[k]
      }
      put(people, m.buf, off, Math.min(m.nPeople, people.cap)); off += m.nPeople
      put(bikes, m.buf, off, Math.min(m.nBikes, bikes.cap))
      // the cars for city.traffic.nearby: positions and (id, speed), kept until the next frame
      if (snap.pos.length < m.cars * 8) { snap.pos = new Float32Array(m.cars * 12); snap.aux = new Float32Array(m.cars * 3) }
      snap.pos.set(m.buf.subarray(0, m.cars * 8)); snap.aux.set(m.buf.subarray(m.base, m.base + m.cars * 2))
      snap.n = m.cars; snap.counts = m.counts
      simT = m.simT; simAt = performance.now()
      stats = m
      if (window.lifeDebug) { const a = (window.lifeMs ||= []); a.push(m.ms); if (a.length > 600) a.shift() }
      city.requestRender()
    } else if (m.type === 'debug') debugCb?.(m)
    else if (m.type === 'net') {
      if (window.lifeDebug) console.log(`life: network ${m.ms.toFixed(0)} ms, ${m.heads.length / 8} signal heads`)
      buildSignals(m.heads, m.ctls)
      buildBenches(m.benches)
      city.requestRender()
    }
  }
  function put(o, buf, off, n) {
    o.ib.array.set(buf.subarray(off * 8, (off + n) * 8))
    o.ib.clearUpdateRanges(); o.ib.addUpdateRange(0, n * 8); o.ib.needsUpdate = true
    o.m.geometry.instanceCount = n
  }

  // ---------------------------------------------------------------- city.traffic, for games
  const snap = { pos: new Float32Array(0), aux: new Float32Array(0), n: 0, counts: [] }
  const obstacles = new Map()
  let obsT = 0, obsAt = 0
  function sendObstacles() { // at most 10 times a second
    obsT = 0; obsAt = performance.now()
    worker.postMessage({ type: 'obstacles', list: [...obstacles].map(([id, o]) => ({ id, x: o.x, y: -o.z, ang: (o.heading || 0) - Math.PI / 2, len: o.length || 4.6, w: o.width || 1.9, speed: o.speed || 0, h: Number.isFinite(o.y) ? o.y : null })) })
  }
  const traffic = {
    // cars within r metres of (x, z): { id, x, y, z, heading, length, width, speed } (heading: forward is (sin, 0, cos))
    nearby(x, z, r) {
      const out = [], r2 = r * r, p = snap.pos
      if (!active) return out
      let k = 0, end = snap.counts[0] || 0
      for (let i = 0; i < snap.n; i++) {
        while (i >= end && k < KINDS - 1) end += snap.counts[++k]
        const o = i * 8, dx = p[o] - x, dz = p[o + 2] - z
        if (dx * dx + dz * dz > r2) continue
        out.push({ id: snap.aux[i * 2], x: p[o], y: p[o + 1], z: p[o + 2], heading: p[o + 3] + Math.PI / 2, length: HALF[k] * 2, width: WIDE[k], speed: snap.aux[i * 2 + 1] })
      }
      return out
    },
    // a player's vehicle or walker { x, z, heading, length, width, speed, y? } (null removes it): cars brake for it;
    // with y (its height) only lanes at that level, so a van on a bridge leaves the street below alone
    setObstacle(id, o) {
      if (o) obstacles.set(id, o); else obstacles.delete(id)
      if (!obsT) obsT = setTimeout(sendObstacles, Math.max(0, 100 - (performance.now() - obsAt)))
    },
    // the player hit car `id`: it stops for a few seconds
    bump(id) { worker.postMessage({ type: 'bump', id }) },
  }
  city.traffic = traffic
  city.emit('traffic:ready', traffic)

  // ---------------------------------------------------------------- tiles near the view -> worker
  const tiles = new Map(), sent = new Set()
  const tkey = (t) => `${t.level}/${t.i}_${t.j}`
  let simA = null, pedA = null, syncT = 0
  const offTiles = city.world.eachTile((t) => { tiles.set(tkey(t), t); schedule() })
  const offUnload = city.on('tile:unload', (t) => { tiles.delete(tkey(t)); schedule() })
  function schedule() { if (!syncT) syncT = setTimeout(sync, 250) }
  function sync() {
    syncT = 0
    if (!active) return
    const c = city.view.center, b = city.view.bounds, cx = c.x, cy = -c.z
    const rv = Math.hypot((b.x1 - b.x0) / 2, (b.z1 - b.z0) / 2), need = Math.min(rv, 2600)
    let moved = false
    if (!simA || Math.hypot(cx - simA.x, cy - simA.y) + need > simA.r || (simA.r > 2.4 * (need + 400) && simA.r > 1200)) {
      simA = { x: cx, y: cy, r: Math.min(3000, (need + 400) * 1.6) }; moved = true
    }
    const pr = Math.min(rv, 1500)
    if (!pedA || Math.hypot(cx - pedA.vx, cy - pedA.vy) + pr > pedA.vr || pedA.vr > 2.5 * (pr + 150)) {
      pedA = { vx: cx, vy: cy, vr: pr * 1.4 + 150 }; moved = true
    }
    const near = (t, x, y, r) => {
      const s = t.level ? 4096 : 1024, dx = Math.max(t.ox - x, 0, x - t.ox - s), dy = Math.max(t.oy - y, 0, y - t.oy - s)
      return dx * dx + dy * dy < (r + 100) ** 2
    }
    const add = [], drop = []
    for (const [k, t] of tiles) {
      if (sent.has(k) || !t.graph || !(near(t, simA.x, simA.y, simA.r) || near(t, pedA.vx, pedA.vy, pedA.vr))) continue
      sent.add(k)
      add.push({ key: k, level: t.level, ox: t.ox, oy: t.oy, size: t.level ? 4096 : 1024, terrain: { n: t.terrain.n, h: t.terrain.h },
        pieces: t.graph.pieces.filter((p) => p.kind <= 13), pois: (t.graph.pois || []).filter((q) => q.kind !== 3) })
    }
    for (const k of sent) {
      const t = tiles.get(k)
      if (!t || !(near(t, simA.x, simA.y, simA.r) || near(t, pedA.vx, pedA.vy, pedA.vr))) { sent.delete(k); drop.push(k) }
    }
    if (add.length || drop.length) worker.postMessage({ type: 'tiles', add, drop })
    if (moved) worker.postMessage({ type: 'area', area: { ...simA, ...pedA } })
  }

  // ---------------------------------------------------------------- on / off, settings, time of day
  const vanHour = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return +p.hour + p.minute / 60 }
  let active = false, peopleOn = false, stopAnim = null, lastOpts = ''
  function sendOpts() {
    const o = { cars: set.cars, people: peopleOn, bikes: set.bikes, density: set.density, hour: +(city.weather?.hour ?? vanHour()).toFixed(1), maxCars: MAX_CARS, maxPeople: MAX_PEOPLE }
    const s = JSON.stringify(o)
    if (s !== lastOpts) { lastOpts = s; worker.postMessage({ type: 'opts', opts: o }) }
  }
  function check() {
    const z = city.view.zoom
    const want = set.on && !document.hidden && z >= CAR_ZOOM && (set.cars || (set.people && z >= PEOPLE_ZOOM))
    const ppl = want && set.people && z >= PEOPLE_ZOOM
    if (ppl !== peopleOn) { peopleOn = ppl; if (benchMesh) benchMesh.visible = ppl }
    for (const o of carMeshes) o.m.visible = want && set.cars
    people.m.visible = bikes.m.visible = ppl
    if (want !== active) {
      active = want
      group.visible = glowGroup.visible = want
      if (want) { stopAnim = city.animate(); schedule() } else { stopAnim?.(); stopAnim = null }
      city.requestRender()
    }
    if (active) { sendOpts(); schedule() }
  }
  const offView = city.on('view', check)
  const offWeather = city.on('weather', () => sendOpts())
  const onVis = () => check()
  document.addEventListener('visibilitychange', onVis)
  const clock = setInterval(() => active && sendOpts(), 15000)
  const offFrame = city.on('frame', (dt, t) => {
    if (!active) return
    uni.uNight.value = city.light.night; uni.uTime.value = t
    for (const p of pools) p.visible = city.light.night > 0.08
    if (sig.glow) { sig.glow.material.size = Math.max(3, 2.6 * 6 * city.view.zoom) * city.renderer.getPixelRatio(); sig.glow.material.opacity = 0.45 + 0.55 * city.light.night }
    accDt += dt
    if (!busy) {
      busy = true
      worker.postMessage({ type: 'tick', dt: accDt, buf: spare }, spare ? [spare.buffer] : [])
      spare = null; accDt = 0
    }
    updateSignals(simT + (performance.now() - simAt) / 1000)
  })

  // ---------------------------------------------------------------- panel
  const btn = city.ui.addButton({ label: 'Life', icon: '🚦', title: 'Traffic and people', panel: true })
  const el = btn.panel
  el.innerHTML = `
    <div style="display:grid;gap:6px;font-size:13px">
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="on"> <b style="flex:1">City life</b><span data-st style="color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums"></span></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="cars"> Cars, signals</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="people"> People</label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-k="bikes"> Cyclists</label>
      <label style="display:flex;gap:8px;align-items:center">Busy <input type="range" min="0.2" max="2" step="0.1" data-d style="flex:1"></label>
      <div style="font-size:11px;color:var(--muted);line-height:1.35">Simulated, busier at rush hour (Vancouver time). Cars from neighbourhood zoom, people up close. Streets, signals, crossings, benches and stops © OpenStreetMap contributors.</div>
    </div>`
  for (const cb of el.querySelectorAll('[data-k]')) {
    cb.checked = set[cb.dataset.k]
    cb.addEventListener('change', () => { set[cb.dataset.k] = cb.checked; save(); check(); city.requestRender() })
  }
  const dens = el.querySelector('[data-d]')
  dens.value = String(set.density)
  dens.addEventListener('input', () => { set.density = +dens.value; save(); sendOpts() })
  const stEl = el.querySelector('[data-st]')
  const statT = setInterval(() => {
    if (el.hidden) return
    const z = city.view.zoom
    stEl.textContent = !set.on ? 'off' : !active ? (z < CAR_ZOOM ? 'zoom in' : '') : `${stats.cars || 0} cars${peopleOn ? ` · ${stats.people || 0} people` : ''}`
  }, 500)

  check()
  return {
    dispose() {
      offTiles(); offUnload(); offView(); offWeather(); offFrame()
      document.removeEventListener('visibilitychange', onVis)
      clearInterval(clock); clearInterval(statT); clearTimeout(syncT); clearTimeout(obsT)
      if (city.traffic === traffic) delete city.traffic
      stopAnim?.()
      worker.terminate()
      group.removeFromParent(); glowGroup.removeFromParent()
      for (const o of [...carMeshes, people, bikes]) o.m.geometry.dispose()
      for (const m of [...pools, ...sig.meshes]) m.geometry?.dispose()
      benchMesh?.dispose()
      for (const m of [carMat, personMat, bikeMat, ...pools.map((p) => p.material), greyMat, housingMat, lampMat, benchMat, glowMat]) m.dispose()
      glowTex.dispose()
      btn.remove()
      city.requestRender()
    },
  }
}
