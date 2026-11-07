// The sea around the boat: one grid mesh that stands in for the map's flat sea (city.surface.seaHole leaves that out
// around it) while sailing. Gerstner waves from the wind move its vertices: glassy in a calm, a chop at 10 kn,
// whitecaps from ~10 kn, rollers in a gale. The grid is even (and snapped, so the facets don't swim) for ~80 m round
// a point ahead of the boat; past that its cells grow out to a kilometre, flat, with the waves drawn by normals alone.
// One Lambert material (the sun, the shadows, the fog and the ink pass work as on the map): flat-shaded facets up close,
// the sky and the fog mirrored at grazing angles, sun (or moon) glints, foam on the crests and along the shore, a
// lighter tint over the shallows (by the distance to the shore: tile water masks, see shore()), darker ruffled gust
// patches (gusts(): the sail plugin's speed bursts) and foam round the hull. mix 0 is exactly the map's sea, for the
// dive. heightAt() gives the same waves to the CPU (the boat rides them, the wake follows them).
const NW = 5 // waves
const REL = [[1, 0, 0.55], [0.71, 0.42, 0.32], [0.53, -0.5, 0.22], [0.37, 0.95, 0.12], [0.26, -1.1, 0.08]] // wavelength, angle off the wind, amplitude (shares)
const OUT = 18, FAR = 1000 // outer cells a side, growing out to FAR metres
const SHORE_N = 256, SHORE_C = 4 // shore distance field: cells a side, metres a cell (1 km square)
const GUSTS = 4
// by quality tier (city.quality.tier.name): grid vertices a side (even; 2 * OUT of them are the outer ring) and sun
// glints; a tier may carry its own as tier.sea = { n, glints }
const TIERS = { high: { n: 192, glints: true }, low: { n: 128, glints: true } }

const GLSL = `
  float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y); }
  uniform vec4 uW[${NW}], uW2[${NW}]; // dir x, dir z, k, amplitude | omega, Q, phase, fade distance
  uniform vec3 uOrigin; uniform float uT, uCore, uMix;
  uniform sampler2D uShore; uniform vec3 uShoreBox; // x0, z0, size
  float shoreAt(vec2 p) { vec2 uv = (p - uShoreBox.xy) / uShoreBox.z;
    if (uShoreBox.z <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 64.0;
    return texture2D(uShore, uv).r * 64.0; }`

export function makeWater(THREE, city) {
  const U = {
    uW: { value: Array.from({ length: NW }, () => new THREE.Vector4()) },
    uW2: { value: Array.from({ length: NW }, () => new THREE.Vector4()) },
    uOrigin: { value: new THREE.Vector3() }, uT: { value: 0 }, uCore: { value: 80 }, uMix: { value: 0 },
    uShore: { value: null }, uShoreBox: { value: new THREE.Vector3() },
    uHor: { value: new THREE.Color(0xcfe2ec) }, uZen: { value: new THREE.Color(0x84b7dc) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() }, uGlint: { value: 1 },
    uCap: { value: 0 }, uRipple: { value: 0.3 }, uWind: { value: new THREE.Vector2(1, 0) },
    uGust: { value: Array.from({ length: GUSTS }, () => new THREE.Vector4()) }, uBoat: { value: new THREE.Vector4() },
  }
  // the shore: distance (metres, to 64) from each water cell to the nearest land, an R8 texture
  const shoreD = new Uint8Array(SHORE_N * SHORE_N), shoreF = new Float32Array(SHORE_N * SHORE_N)
  const shoreTex = new THREE.DataTexture(shoreD, SHORE_N, SHORE_N, THREE.RedFormat, THREE.UnsignedByteType)
  shoreTex.magFilter = shoreTex.minFilter = THREE.LinearFilter
  U.uShore.value = shoreTex
  const shore = { x0: 0, z0: 0, ok: false }

  const mat = new THREE.MeshLambertMaterial({ flatShading: true })
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, U)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>\n${GLSL}\nvarying vec3 vW; varying float vCrest, vFade, vGeo;`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position.x + uOrigin.x, uOrigin.y, position.z + uOrigin.z);
        float fade = uMix * (1.0 - smoothstep(uCore * 0.6, uCore * 0.97, length(position.xz)));
        float damp = 0.2 + 0.8 * smoothstep(1.0, 40.0, shoreAt(transformed.xz)); // smaller waves in the shallows
        float camD = distance(cameraPosition.xz, transformed.xz), crest = 0.0, geo = 0.0, full = 1e-5;
        // further off, each wave is kept lower than the view's slope down to it: its crests never hide the troughs
        // behind (the ink pass would draw them as long dark lines); the normals carry it on (fragment)
        float view = (cameraPosition.y - uOrigin.y) / max(camD, 1.0);
        vec3 d = vec3(0.0);
        for (int i = 0; i < ${NW}; i++) {
          vec4 w = uW[i], w2 = uW2[i];
          float lod = min(1.0, 0.35 * view / max(w.z * w.w, 1e-4)) * (1.0 - smoothstep(w2.w * 0.6, w2.w, camD));
          float a = w.w * fade * damp * lod;
          geo += w.w * lod; full += w.w;
          float ph = w.z * dot(w.xy, transformed.xz) - w2.x * uT + w2.z, sn = sin(ph), cs = cos(ph);
          d.y += a * sn; d.xz += w2.y * a * w.xy * cs;
          crest += w2.y * w.z * a * sn;
        }
        transformed += d;
        vW = transformed; vCrest = crest / max(damp, 0.2); vFade = fade; vGeo = geo / full;`)
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL}
        varying vec3 vW; varying float vCrest, vFade, vGeo;
        uniform vec3 uHor, uZen, uSunDir, uSunCol; uniform float uGlint, uCap, uRipple; uniform vec2 uWind;
        uniform vec4 uGust[${GUSTS}], uBoat;
        vec3 srgbW(vec3 c) { return pow(c, vec3(2.2)); }
        float fbmW(vec2 p) { return wNoise(p) * 0.5 + wNoise(p * 2.03) * 0.25 + wNoise(p * 4.1) * 0.125 + wNoise(p * 8.3) * 0.0625; }
        float gustAt(vec2 p, float n) { float g = 0.0;
          for (int i = 0; i < ${GUSTS}; i++) { vec4 q = uGust[i]; if (q.z > 0.0) g = max(g, q.w * (1.0 - smoothstep(0.5, 1.0, distance(p, q.xy) / q.z + 0.35 * (n - 0.5)))); }
          return g; }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 P = vW.xz;
        if (distance(P, uOrigin.xz) > ${FAR - 5}.0) discard; // the map's sea is left out only to ${FAR - 10} m
        float px = max(length(fwidth(P)), 1e-3); // metres per pixel
        float n1 = wNoise(P * 0.09), n2 = wNoise(P * 0.7 + uT * vec2(0.3, -0.2));
        // the map's sea (materials.js, class 19), for the dive
        vec3 mapSea; { vec2 r = vec2(P.x * 0.25 + P.y * 0.08, P.y * 0.5); float dd = abs(fract(r.x) - 0.5) + abs(fract(r.y) - 0.5);
          vec3 c0 = srgbW(vec3(40.0, 98.0, 150.0) / 255.0); float near = 1.0 - smoothstep(0.15, 0.6, px);
          mapSea = mix(c0 * (0.9 + 0.2 * fbmW(P * 0.08)), c0 * 1.35, (1.0 - smoothstep(0.12, 0.18, dd)) * near * 0.6); }
        float sd = shoreAt(P), gust = gustAt(P, n1);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // world normal: the facets up close (where the grid has waves), the waves' own slope where it is flat; ripples on top
        vec3 Nf = normalize((vec4(normal, 0.0) * viewMatrix).xyz); if (Nf.y < 0.0) Nf = -Nf;
        vec2 grad = vec2(0.0), Pw = P + (vec2(n1, wNoise(P * 0.05 + 7.0)) - 0.5) * 9.0; // warped: no lattice of crossing waves
        for (int i = 0; i < ${NW}; i++) {
          vec4 w = uW[i], w2 = uW2[i];
          float lod = 1.0 - smoothstep(0.06, 0.2, px * w.z / 6.2832);
          grad += w.w * w.z * w.xy * cos(w.z * dot(w.xy, Pw) - w2.x * uT + w2.z) * lod;
        }
        // detail flattens towards grazing angles, where it would only shimmer into stripes
        float graze = smoothstep(0.012, 0.1, normalize(cameraPosition - vW).y);
        grad *= (0.2 + 0.8 * smoothstep(1.0, 40.0, sd)) * 0.7 * graze;
        vec3 Nw = normalize(mix(normalize(vec3(-grad.x, 1.0, -grad.y)), Nf, vFade / max(uMix, 1e-3) * vGeo));
        { // short ripples across the wind, more in a gust; gone before they shimmer
          vec2 a = uWind, b = vec2(-a.y, a.x), q = P + (vec2(n1, wNoise(P * 0.13 + 3.0)) - 0.5) * 7.0;
          float rk = (uRipple + 0.9 * gust) * (1.0 - smoothstep(0.08, 0.5, px)) * graze * (0.6 + 0.8 * wNoise(P * 0.03 - uT * 0.05));
          vec2 rg = a * cos(dot(q, a) * 2.1 - uT * 4.6) * 0.5 + (a * 0.6 + b * 0.8) * cos(dot(q, a * 0.6 + b * 0.8) * 3.3 - uT * 5.7) * 0.35
            + (a * 0.7 - b * 0.7) * cos(dot(q, a * 0.7 - b * 0.7) * 4.7 - uT * 6.8) * 0.25;
          Nw = normalize(Nw - vec3(rg.x, 0.0, rg.y) * rk);
        }
        Nw = normalize(mix(vec3(0.0, 1.0, 0.0), Nw, uMix));
        normal = normalize(mat3(viewMatrix) * Nw);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 deep = srgbW(vec3(0.13, 0.34, 0.50)), shallow = srgbW(vec3(0.27, 0.58, 0.60));
          vec3 base = mix(shallow, deep, smoothstep(3.0, 40.0, sd)) * (0.94 + 0.12 * n1) * (1.0 - 0.55 * gust);
          vec3 V = normalize(cameraPosition - vW), R = reflect(-V, Nw);
          float F = (0.03 + 0.97 * pow(1.0 - max(dot(Nw, V), 0.0), 5.0)) * (1.0 - 0.6 * gust); // a gust's ruffle mirrors less: darker
          vec3 sky = mix(uHor, uZen, smoothstep(0.02, 0.5, R.y));
          // foam: along the shore (a fringe and the run-up), on the crests, streaks in a gale, round the hull
          float foam = (1.0 - smoothstep(0.6, 2.2 + 2.5 * n2, sd)) + smoothstep(0.8, 0.97, sin(sd * 0.85 - uT * 1.3 + n1 * 6.0)) * (1.0 - smoothstep(1.5, 9.0, sd)) * 0.7;
          foam += smoothstep(0.32, 0.62, vCrest / max(vFade * vGeo, 0.1) * 0.9 + 0.5 * (n2 - 0.5)) * uCap * vFade * smoothstep(0.05, 0.3, vGeo);
          foam += smoothstep(0.72, 0.9, wNoise(vec2(dot(P, uWind) * 0.04, dot(P, vec2(-uWind.y, uWind.x)) * 0.5) + n1)) * smoothstep(0.5, 1.0, uCap) * 0.5 * (1.0 - smoothstep(0.3, 1.5, px));
          { vec2 o = P - uBoat.xy, f = vec2(sin(uBoat.z), cos(uBoat.z)); vec2 l = vec2(dot(o, vec2(-f.y, f.x)), dot(o, f));
            float e = length(l / vec2(1.6, 3.7)); foam += (1.0 - smoothstep(0.9, 1.05 + 0.3 * n2, e)) * smoothstep(1.5, 4.5, uBoat.w) * smoothstep(-3.0, 2.0, l.y) * 0.7; }
          foam = clamp(foam, 0.0, 1.0) * (1.0 - smoothstep(0.4, 2.0, px) * 0.6);
          vec3 water = mix(base * (1.0 - F), srgbW(vec3(0.93, 0.95, 0.96)), foam);
          diffuseColor.rgb = mix(mapSea, water, uMix);
          float glint = pow(max(dot(R, uSunDir), 0.0), 600.0) * 14.0 + pow(max(dot(R, uSunDir), 0.0), 60.0) * 0.25;
          totalEmissiveRadiance += uMix * (1.0 - foam) * (sky * F * 0.95 + uSunCol * glint * uGlint);
        }`)
  }
  mat.customProgramCacheKey = () => 'sailsea1'

  let mesh = null, tier = null, n = 0, cell = 1
  function build(T) {
    if (mesh && tier?.n === T.n) { tier = T; return }
    tier = T; n = T.n
    const K0 = n / 2 - OUT // even cells a side of the centre
    cell = 80 / K0
    // outer cells grow geometrically from `cell` so that OUT of them reach FAR
    let q = 1.3
    for (let it = 0; it < 40; it++) { const sum = (cell * (q ** OUT - 1)) / (q - 1); q *= ((FAR - 80) / sum) ** (0.5 / OUT) }
    const coord = (i) => { const u = i - n / 2, a = Math.abs(u); return Math.sign(u) * (a <= K0 ? a * cell : 80 + (cell * (q ** (a - K0) - 1)) / (q - 1)) }
    const N1 = n + 1, pos = new Float32Array(N1 * N1 * 3), idx = new Uint32Array(n * n * 6)
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const k = (j * N1 + i) * 3; pos[k] = coord(i); pos[k + 2] = coord(j) }
    let o = 0
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * N1 + i, b = a + 1, c = a + N1, d = c + 1
      if ((i + j) & 1) idx.set([a, c, b, b, c, d], o); else idx.set([a, c, d, a, d, b], o) // alternate the diagonals: no grain
      o += 6
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1))
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N1 * N1 * 3).fill(0), 3))
    if (mesh) { mesh.geometry.dispose(); mesh.geometry = g } else {
      mesh = new THREE.Mesh(g, mat)
      mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false
    }
    U.uCore.value = K0 * cell
  }
  const setQuality = (t) => { build(t?.sea || TIERS[t?.name] || TIERS.high); U.uGlint.value = tier.glints ? 1 : 0 }
  setQuality(matchMedia('(pointer: coarse)').matches ? { name: 'low' } : city.quality?.tier)

  // ---------------------------------------------------------------- waves from the wind
  const W = { x: 0, z: 1, speed: -1, A: 0, L: 1, chop: 0, t0: performance.now() / 1000 }
  const WV = Array.from({ length: NW }, () => ({ dx: 0, dz: 0, k: 0, a: 0, w: 0, q: 0, p: 0 }))
  // set the sea for a steady wind (m/s, unit direction it blows towards): wavelengths and directions only change
  // when the wind does by much (their phases would jump); amp() eases the height with the gusts
  function setWind(speed, dx, dz) {
    const turned = W.x * dx + W.z * dz < 0.94
    if (Math.abs(speed - W.speed) < 1.5 && !turned) return
    W.speed = speed; W.x = dx; W.z = dz
    W.L = 2 + 1.4 * speed
    W.chop = 0.35 + 0.5 * smooth(3, 13, speed)
    let sum = 0
    for (let i = 0; i < NW; i++) {
      const [l, ang, a] = REL[i], c = Math.cos(ang), s = Math.sin(ang), v = WV[i], L = W.L * l
      v.dx = dx * c - dz * s; v.dz = dx * s + dz * c; v.k = (2 * Math.PI) / L; v.a = a; v.w = Math.sqrt(9.81 * v.k); v.p = i * 1.7
      sum += v.k * a
      U.uW2.value[i].set(v.w, 0, v.p, 12 * L)
    }
    W.ksum = sum
    U.uWind.value.set(dx, dz)
  }
  function amp(speed) { // the height for the wind blowing now (m/s), gusts and all
    W.A = (0.03 * speed + 0.0035 * speed * speed) * smooth(1, 4, speed)
    for (let i = 0; i < NW; i++) {
      const v = WV[i]; v.q = W.chop / (W.ksum * W.A || 1)
      U.uW.value[i].set(v.dx, v.dz, v.k, v.a * W.A); U.uW2.value[i].y = v.q
    }
    U.uCap.value = smooth(4.6, 7.5, speed) * (0.6 + 0.4 * smooth(7.5, 14, speed))
    U.uRipple.value = 0.03 + 0.4 * smooth(2, 8, speed)
  }
  // the sea's height above sea level at (x, z) now (the vertical part of the waves at that point, near the centre)
  function heightAt(x, z) {
    const t = U.uT.value, damp = 0.2 + 0.8 * smooth(1, 40, shoreAt(x, z))
    let h = 0
    for (let i = 0; i < NW; i++) { const v = WV[i]; h += v.a * W.A * Math.sin(v.k * (v.dx * x + v.dz * z) - v.w * t + v.p) }
    return h * damp * U.uMix.value
  }

  // ---------------------------------------------------------------- the shore
  function shoreAt(x, z) {
    if (!shore.ok) return 64
    const i = Math.floor((x - shore.x0) / SHORE_C), j = Math.floor((z - shore.z0) / SHORE_C)
    return i < 0 || j < 0 || i >= SHORE_N || j >= SHORE_N ? 64 : shoreF[j * SHORE_N + i]
  }
  // rebuild the distance field around (x, z) from wet(x, z) (a chamfer distance transform, two passes)
  function buildShore(x, z, wet) {
    const N = SHORE_N, C = SHORE_C, x0 = Math.round((x - (N * C) / 2) / C) * C, z0 = Math.round((z - (N * C) / 2) / C) * C, D = shoreF
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) D[j * N + i] = wet(x0 + (i + 0.5) * C, z0 + (j + 0.5) * C) ? 1e4 : 0
    const a = C, b = C * Math.SQRT2
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i; let v = D[k]
      if (!v) continue
      if (i > 0) v = Math.min(v, D[k - 1] + a)
      if (j > 0) { v = Math.min(v, D[k - N] + a); if (i > 0) v = Math.min(v, D[k - N - 1] + b); if (i < N - 1) v = Math.min(v, D[k - N + 1] + b) }
      D[k] = v
    }
    for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
      const k = j * N + i; let v = D[k]
      if (!v) continue
      if (i < N - 1) v = Math.min(v, D[k + 1] + a)
      if (j < N - 1) { v = Math.min(v, D[k + N] + a); if (i < N - 1) v = Math.min(v, D[k + N + 1] + b); if (i > 0) v = Math.min(v, D[k + N - 1] + b) }
      D[k] = v
    }
    // cells are centred: a water cell next to land is ~C/2 from it
    for (let k = 0; k < N * N; k++) { D[k] = D[k] ? Math.min(64, D[k] - C * 0.5) : 0; shoreD[k] = Math.round((D[k] / 64) * 255) }
    shore.x0 = x0; shore.z0 = z0; shore.ok = true
    shoreTex.needsUpdate = true
    U.uShoreBox.value.set(x0, z0, N * C)
  }
  const shoreCentre = () => ({ x: shore.x0 + (SHORE_N * SHORE_C) / 2, z: shore.z0 + (SHORE_N * SHORE_C) / 2 })

  // ---------------------------------------------------------------- gusts: dark patches drifting downwind
  const gusts = Array.from({ length: GUSTS }, () => ({ x: 0, z: 0, r: 0, s: 0, life: 0, fade: 0 }))
  // the share of extra wind at (x, z)
  function gustAt(x, z) {
    let g = 0
    for (const q of gusts) if (q.r > 0) g = Math.max(g, q.s * q.fade * (1 - smooth(0.5, 1, Math.hypot(x - q.x, z - q.z) / q.r)))
    return g
  }
  function stepGusts(dt, bx, bz, wx, wz, rnd = Math.random) {
    const ws = Math.hypot(wx, wz) || 1, ux = wx / ws, uz = wz / ws, want = 2 + (ws > 6 ? 2 : ws > 3 ? 1 : 0)
    let live = 0
    for (const q of gusts) {
      if (q.r <= 0) continue
      q.x += wx * 0.85 * dt; q.z += wz * 0.85 * dt; q.life += dt
      const down = (q.x - bx) * ux + (q.z - bz) * uz
      q.fade = Math.min(1, q.life / 3, (350 - down) / 60)
      if ((q.life > 1 && q.fade <= 0) || Math.hypot(q.x - bx, q.z - bz) > 700) q.r = 0; else live++
    }
    if (live < want) for (const q of gusts) if (q.r <= 0) { // a new one upwind, somewhere ahead or abeam
      const up = 120 + rnd() * 220, side = (rnd() - 0.5) * 360
      q.x = bx - ux * up - uz * side; q.z = bz - uz * up + ux * side
      q.r = 45 + rnd() * 70; q.s = 0.3 + rnd() * 0.25; q.life = 0; q.fade = 0
      break
    }
    for (let i = 0; i < GUSTS; i++) { const q = gusts[i]; U.uGust.value[i].set(q.x, q.z, q.r, q.r > 0 ? q.s * q.fade : 0) }
  }

  // ---------------------------------------------------------------- per frame
  // centre: where the even grid goes (ahead of the boat); sea: sea level; t: seconds; mix: 0 the map's sea .. 1 ours
  function update(t, cx, cz, sea, mix) {
    U.uT.value = t - W.t0
    U.uOrigin.value.set(Math.round(cx / cell) * cell, sea, Math.round(cz / cell) * cell)
    U.uMix.value = mix
    const h = city.surface?.seaHole
    if (h) { if (mesh.parent) h.set(U.uOrigin.value.x, sea, U.uOrigin.value.z, FAR - 10); else h.set(0, 0, 0, 0) }
    const sun = city.light.sun
    U.uSunDir.value.copy(sun.position).sub(sun.target.position).normalize()
    U.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity * 0.5 * smooth(-0.05, 0.1, U.uSunDir.value.y))
  }
  function sky(horizon, zenith) { U.uHor.value.setHex(horizon); U.uZen.value.setHex(zenith) }
  function off() { const h = city.surface?.seaHole; if (h) h.set(0, 0, 0, 0); for (const q of gusts) q.r = 0 }

  return {
    get mesh() { return mesh }, uniforms: U, setWind, amp, heightAt, shoreAt, buildShore, shoreCentre, gustAt, stepGusts, gusts, update, sky, off, setQuality,
    get wave() { return W },
    dispose() { off(); mesh?.geometry.dispose(); mat.dispose(); shoreTex.dispose() },
  }
}

function smooth(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
