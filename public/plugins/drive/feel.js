// Game feel for whatever is driven (van, bus, cab): tyre marks and smoke where the tyres slide, sparks where it hits
// something, speed lines and a wider view at speed, the tyres' squeal and a crunch on impact. index.js calls update()
// each frame after the vehicle has moved, and impact() from its one bump handler.
import { clamp } from '../../core/util.js'
import { noise } from '../../core/play.js'

// lines round the view, rushing at the camera (a shader moves them: no work per line on the CPU); set uA 0..1
export function speedLines(THREE, low) {
  const M = low ? 26 : 64, lp = new Float32Array(M * 6), lk = new Float32Array(M * 2), ll = new Float32Array(M * 2)
  for (let i = 0; i < M; i++) {
    const a = Math.random() * Math.PI * 2, r = 2.2 + Math.random() * 4.5, z = -Math.random() * 44, L = 2.5 + Math.random() * 4
    for (let e = 0; e < 2; e++) { lp.set([Math.cos(a) * r * 1.4, Math.sin(a) * r, z], i * 6 + e * 3); lk[i * 2 + e] = e; ll[i * 2 + e] = L }
  }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp, 3)); lg.setAttribute('aK', new THREE.BufferAttribute(lk, 1)); lg.setAttribute('aL', new THREE.BufferAttribute(ll, 1))
  const lineMat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uA: { value: 0 } },
    vertexShader: 'attribute float aK, aL; uniform float uT; varying float vA; void main() { vec3 p = position; p.z = mod(p.z + uT * 60.0, 44.0) - 46.0 + aK * aL; vA = (1.0 - aK) * smoothstep(-46.0, -30.0, p.z) * (1.0 - smoothstep(-6.0, -2.0, p.z)); gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }',
    fragmentShader: 'uniform float uA; varying float vA; void main() { gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * vA * uA, vA * uA); }',
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  })
  const lines = new THREE.LineSegments(lg, lineMat); lines.frustumCulled = false; lines.renderOrder = 10; lines.visible = false
  return { lines, lineMat, set(pcam, t, a) { lines.visible = a > 0.02; if (!lines.visible) return; lines.position.copy(pcam.position); lines.quaternion.copy(pcam.quaternion); lineMat.uniforms.uT.value = t; lineMat.uniforms.uA.value = a }, dispose() { lg.dispose(); lineMat.dispose() } }
}

// a pool of points thrown about: emit(x, y, z, vx, vy, vz, life); g: gravity (m/s², negative rises)
function puffs(THREE, n, mat, g) {
  const pos = new Float32Array(n * 3).fill(-1e5), vel = new Float32Array(n * 3), life = new Float32Array(n)
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false
  let next = 0, live = 0
  return {
    pts,
    emit(x, y, z, vx, vy, vz, l) { const j = next * 3; pos[j] = x; pos[j + 1] = y; pos[j + 2] = z; vel[j] = vx; vel[j + 1] = vy; vel[j + 2] = vz; life[next] = l; next = (next + 1) % n; live = n },
    step(dt) {
      if (!live) return
      live = 0
      for (let i = 0; i < n; i++) {
        if (life[i] <= 0) continue
        const j = i * 3
        if ((life[i] -= dt) <= 0) { pos[j + 1] = -1e5; continue }
        live++
        vel[j + 1] -= g * dt
        pos[j] += vel[j] * dt; pos[j + 1] += vel[j + 1] * dt; pos[j + 2] += vel[j + 2] * dt
      }
      geo.attributes.position.needsUpdate = true
    },
    dispose() { geo.dispose(); mat.dispose() },
  }
}

// ctx: { audio() → the AudioContext (or null), out() → the gain to play into }
export function makeFeel(THREE, city, ctx) {
  const low = city.quality?.tier.name === 'low'
  // tyre marks: a ring of quads, one per wheel per step of a slide, the oldest drawn over
  const N = low ? 120 : 400, mp = new Float32Array(N * 12), idx = new Uint16Array(N * 6)
  for (let i = 0; i < N; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6)
  const mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.BufferAttribute(mp, 3)); mg.setIndex(new THREE.BufferAttribute(idx, 1))
  const markMat = new THREE.MeshBasicMaterial({ color: 0x14161a, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide })
  const marks = new THREE.Mesh(mg, markMat); marks.frustumCulled = false
  const last = [null, null] // each rear wheel's last point of the slide it is in
  let mnext = 0
  const dot = document.createElement('canvas'); dot.width = dot.height = 32
  { const g = dot.getContext('2d'), gr = g.createRadialGradient(16, 16, 1, 16, 16, 15); gr.addColorStop(0, '#fff'); gr.addColorStop(0.4, 'rgba(255,255,255,.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 32, 32) }
  const dotTex = new THREE.CanvasTexture(dot)
  const smoke = puffs(THREE, low ? 16 : 48, new THREE.PointsMaterial({ color: 0xdfe3e6, map: dotTex, size: 1.5, transparent: true, opacity: 0.22, depthWrite: false }), -1.2)
  const sparks = puffs(THREE, low ? 16 : 40, new THREE.PointsMaterial({ color: 0xffc35a, map: dotTex, size: 0.3, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }), 14)
  const sl = speedLines(THREE, low)
  const parts = [marks, smoke.pts, sparks.pts, sl.lines]
  city.overlay.add(...parts)
  // the tyres' squeal: noise through a narrow band, as loud as the slide
  let sq = null, nb = null
  function squeal(k) {
    const ac = ctx.audio()
    if (!ac) return
    if (!sq) {
      if (k < 0.05) return
      const s = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain()
      s.buffer = nb ??= noise(ac, 1); s.loop = true; bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 9; g.gain.value = 0
      s.connect(bp); bp.connect(g); g.connect(ctx.out()); s.start()
      sq = { g, bp }
    }
    sq.g.gain.setTargetAtTime(k * 0.11, ac.currentTime, 0.06); sq.bp.frequency.setTargetAtTime(1150 + 700 * k, ac.currentTime, 0.1)
  }
  let fov = 0, slide = 0
  return {
    get fov() { return fov }, get slide() { return slide }, // degrees wider; 0..1 how hard the tyres slide
    // car: the drive plugin's (x, y north, h, yaw, speed, lat, slip, brk, air, V); lines: speed lines too (not a cab: it has its own)
    update(dt, t, car, pcam, lines) {
      const V = car.V, sp = Math.hypot(car.speed, car.lat), fx = -Math.sin(car.yaw), fy = Math.cos(car.yaw), rx = Math.cos(car.yaw), ry = Math.sin(car.yaw)
      const s = car.air || car.lift > 0.05 || sp < 3 ? 0 : Math.max(clamp((Math.abs(car.lat) - 1) / 4, 0, 1), car.slip ? 0.6 : 0, car.brk > 0.9 && sp > 8 ? 0.35 : 0)
      slide += (s - slide) * (1 - Math.exp(-12 * dt))
      squeal(slide)
      for (let w = 0; w < 2; w++) {
        if (s < 0.2) { last[w] = null; continue }
        const o = (w ? 1 : -1) * V.hw * 0.82, x = car.x - fx * V.wb / 2 + rx * o, y = car.y - fy * V.wb / 2 + ry * o, h = car.h + 0.05, L = last[w]
        if (L && Math.hypot(x - L.x, y - L.y) < 0.5) continue
        if (L) { // a quad from the last point to this one, as wide as a tyre
          const dx = x - L.x, dy = y - L.y, l = Math.hypot(dx, dy), nx = (-dy / l) * 0.13, ny = (dx / l) * 0.13
          mp.set([L.x - nx, L.h, -(L.y - ny), L.x + nx, L.h, -(L.y + ny), x - nx, h, -(y - ny), x + nx, h, -(y + ny)], mnext * 12)
          mnext = (mnext + 1) % N; mg.attributes.position.needsUpdate = true
          if (Math.random() < s) smoke.emit(x, h + 0.2, -y, (Math.random() - 0.5) * 1.5, 0.4, (Math.random() - 0.5) * 1.5, 0.5 + Math.random() * 0.5)
        }
        last[w] = { x, y, h }
      }
      smoke.step(dt); sparks.step(dt)
      const k = clamp(sp / (V.vmax * (V.nvmax || 1)), 0, 1)
      fov += (k * k * 9 + slide * 2 - fov) * (1 - Math.exp(-3 * dt))
      sl.set(pcam, t, lines ? clamp((k - 0.72) / 0.28, 0, 1) * 0.4 : 0)
    },
    // it hit something at `impact` m/s: sparks off the corner that leads, a crunch
    impact(car, impact) {
      const k = clamp(impact / 9, 0.2, 1), d = Math.sign(car.speed || 1), fx = -Math.sin(car.yaw) * d, fy = Math.cos(car.yaw) * d
      for (let i = 0; i < Math.round(4 + 14 * k); i++) sparks.emit(car.x + fx * car.V.hl + (Math.random() - 0.5) * 1.6, car.h + 0.4 + Math.random() * 0.5, -(car.y + fy * car.V.hl) + (Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 9 - fx * 3, 2 + Math.random() * 5, (Math.random() - 0.5) * 9 + fy * 3, 0.25 + Math.random() * 0.35)
      const ac = ctx.audio()
      if (!ac) return
      const s = ac.createBufferSource(), lp = ac.createBiquadFilter(), g = ac.createGain(), t = ac.currentTime
      s.buffer = nb ??= noise(ac, 1); lp.type = 'lowpass'; lp.frequency.setValueAtTime(2600, t); lp.frequency.exponentialRampToValueAtTime(180, t + 0.25)
      g.gain.setValueAtTime(0.22 * k, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
      s.connect(lp); lp.connect(g); g.connect(ctx.out()); s.start(t, Math.random() * 0.5, 0.32)
    },
    quiet() { squeal(0); last[0] = last[1] = null; sl.set(null, 0, 0) },
    dispose() {
      city.overlay.remove(...parts)
      if (sq) sq.g.disconnect()
      mg.dispose(); markMat.dispose(); smoke.dispose(); sparks.dispose(); dotTex.dispose(); sl.dispose()
    },
  }
}
