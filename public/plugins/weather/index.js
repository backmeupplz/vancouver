// Weather and time of day, synced to the real Vancouver weather by default, with a picker.
// Weather data: Open-Meteo (https://open-meteo.com), CC BY 4.0, current conditions refreshed every 15 minutes.
// Sun position: the NOAA general solar position equations (fractional-year series), no library.
// Sets `city.weather = { kind, intensity, isNight, hour, live }` and emits 'weather' whenever it changes.

const LAT = 49.2827, LON = -123.1207 // downtown Vancouver
const API = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,weather_code,cloud_cover,precipitation,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`
const KEY = 'vancouver.weather'
const RAD = Math.PI / 180

// WMO weather code -> [kind, intensity, description]
const WMO = {
  0: ['clear', 0, 'clear sky'], 1: ['clear', 0.25, 'mainly clear'], 2: ['cloudy', 0.5, 'partly cloudy'], 3: ['overcast', 0.8, 'overcast'],
  45: ['fog', 0.65, 'fog'], 48: ['fog', 0.8, 'rime fog'],
  51: ['drizzle', 0.3, 'light drizzle'], 53: ['drizzle', 0.5, 'drizzle'], 55: ['drizzle', 0.7, 'heavy drizzle'],
  56: ['drizzle', 0.4, 'freezing drizzle'], 57: ['drizzle', 0.7, 'freezing drizzle'],
  61: ['rain', 0.35, 'light rain'], 63: ['rain', 0.6, 'rain'], 65: ['rain', 0.9, 'heavy rain'],
  66: ['rain', 0.4, 'freezing rain'], 67: ['rain', 0.8, 'freezing rain'],
  71: ['snow', 0.35, 'light snow'], 73: ['snow', 0.6, 'snow'], 75: ['snow', 0.9, 'heavy snow'], 77: ['snow', 0.3, 'snow grains'],
  80: ['rain', 0.4, 'light showers'], 81: ['rain', 0.65, 'showers'], 82: ['rain', 0.95, 'violent showers'],
  85: ['snow', 0.5, 'snow showers'], 86: ['snow', 0.85, 'heavy snow showers'],
  95: ['storm', 0.7, 'thunderstorm'], 96: ['storm', 0.85, 'thunderstorm, hail'], 99: ['storm', 1, 'thunderstorm, hail'],
}
export function fromOpenMeteo(c) {
  const [kind, base, desc] = WMO[c.weather_code] || ['cloudy', 0.5, 'cloudy']
  const p = c.precipitation || 0 // mm in the last 15 minutes
  let intensity = base
  if (kind === 'clear' || kind === 'cloudy' || kind === 'overcast') intensity = (c.cloud_cover ?? base * 100) / 100
  else if (kind !== 'fog') intensity = Math.max(base, Math.min(1, Math.sqrt((p * 4) / 8))) // mm/h, 8 mm/h = downpour
  return { kind, intensity, desc, temp: c.temperature_2m, cloud: (c.cloud_cover ?? 50) / 100, wind: c.wind_speed_10m ?? 3, windFrom: c.wind_direction_10m ?? 225 }
}

// Sun elevation and azimuth (radians, azimuth clockwise from north) at a UTC time; NOAA, accurate to ~0.1°.
export function solar(ms, lat = LAT, lon = LON) {
  const d = new Date(ms), doy = Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1
  const hr = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
  const g = (2 * Math.PI / 365) * (doy - 1 + (hr - 12) / 24), { cos, sin } = Math
  const eq = 229.18 * (0.000075 + 0.001868 * cos(g) - 0.032077 * sin(g) - 0.014615 * cos(2 * g) - 0.040849 * sin(2 * g))
  const decl = 0.006918 - 0.399912 * cos(g) + 0.070257 * sin(g) - 0.006758 * cos(2 * g) + 0.000907 * sin(2 * g) - 0.002697 * cos(3 * g) + 0.00148 * sin(3 * g)
  const ha = ((hr * 60 + eq + 4 * lon) / 4 - 180) * RAD, la = lat * RAD
  const el = Math.asin(sin(la) * sin(decl) + cos(la) * cos(decl) * cos(ha))
  const az = Math.atan2(sin(ha), cos(ha) * sin(la) - Math.tan(decl) * cos(la)) + Math.PI
  return { el, az }
}

// Vancouver wall-clock time: hour of day and the UTC time of local midnight
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
export function vanTime(ms) {
  const p = Object.fromEntries(FMT.formatToParts(ms).map((x) => [x.type, +x.value]))
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
  return { hour: p.hour + p.minute / 60, midnight: Date.UTC(p.year, p.month - 1, p.day) - offset }
}

// Time-of-day looks by true sun elevation (degrees); interpolated. tint/desat go to the post grade.
const TOD = [
  { el: -14, tint: [0.36, 0.42, 0.66], desat: 0.3, sun: 0xb8c8ff, sunI: 1.5, sky: 0x8a9ac8, gnd: 0x3a3848, hemiI: 1.5 },
  { el: -6, tint: [0.5, 0.5, 0.74], desat: 0.2, sun: 0xc0b8f0, sunI: 1.3, sky: 0x9a90c0, gnd: 0x45404c, hemiI: 1.6 },
  { el: -1, tint: [0.84, 0.66, 0.7], desat: 0.08, sun: 0xff8050, sunI: 1.4, sky: 0xc09cc0, gnd: 0x5a4a48, hemiI: 1.6 },
  { el: 4, tint: [1.02, 0.8, 0.68], desat: 0, sun: 0xff9a58, sunI: 2.3, sky: 0xdcb4b4, gnd: 0x7a6658, hemiI: 1.7 },
  { el: 9, tint: [1.02, 0.92, 0.84], desat: 0, sun: 0xffc890, sunI: 2.3, sky: 0xe2dce6, gnd: 0x86786a, hemiI: 1.9 },
  { el: 16, tint: [1, 1, 1], desat: 0, sun: 0xfff1dc, sunI: 2.3, sky: 0xe8eef8, gnd: 0x8a8070, hemiI: 2.0 }, // the core's own light
]
// Weather looks: share of direct sun kept, grade, haze (fog veil), cloud shadows
const LOOK = {
  clear: { sun: 1, tint: [1, 1, 1], desat: 0, haze: 0 },
  cloudy: { sun: 0.85, tint: [0.97, 0.98, 1], desat: 0.08, haze: 0.02 },
  overcast: { sun: 0.3, tint: [0.86, 0.88, 0.94], desat: 0.32, haze: 0.06 },
  fog: { sun: 0.2, tint: [0.95, 0.96, 0.98], desat: 0.35, haze: 0.55 },
  drizzle: { sun: 0.2, tint: [0.76, 0.8, 0.9], desat: 0.36, haze: 0.08, hazeCol: [0.62, 0.66, 0.74] },
  rain: { sun: 0.1, tint: [0.62, 0.68, 0.82], desat: 0.45, haze: 0.1, hazeCol: [0.56, 0.61, 0.7] },
  storm: { sun: 0.05, tint: [0.38, 0.42, 0.58], desat: 0.52, haze: 0.08, hazeCol: [0.4, 0.44, 0.54] },
  snow: { sun: 0.3, tint: [0.92, 0.97, 1.08], desat: 0.5, haze: 0.32, hazeCol: [0.95, 0.97, 1] },
}
const PICKS = { clear: 0.1, cloudy: 0.5, rain: 0.6, storm: 0.9, snow: 0.6, fog: 0.7 } // manual choices: intensity
const ICON = { clear: '☀︎', night: '☾︎', cloudy: '⛅︎', overcast: '☁︎', fog: '≋', drizzle: '☂︎', rain: '☂︎', storm: '⚡︎', snow: '❄︎' }

export default function weather(city) {
  const { THREE } = city
  const { sun, hemi } = city.light, U = city.post.uniforms
  const saved = { sunC: sun.color.clone(), sunI: sun.intensity, sky: hemi.color.clone(), gnd: hemi.groundColor.clone(), hemiI: hemi.intensity, dir: sun.position.clone().sub(sun.target.position).normalize() }

  let state = { mode: 'live', hour: null } // mode: 'live' or a kind; hour: null = live time
  try { Object.assign(state, JSON.parse(localStorage.getItem(KEY)) || {}) } catch {}
  let live = null, fetchedAt = 0
  const v3 = new THREE.Vector3(), c3 = new THREE.Color(), ca = new THREE.Color(), cb = new THREE.Color()

  // ---------- atmosphere: one full-screen quad that multiplies the image (cloud shadows) and veils it (haze),
  // with the ground position reconstructed per pixel (the camera is orthographic, so it is affine in the screen)
  const atmo = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { uG0: { value: new THREE.Vector2() }, uGx: { value: new THREE.Vector2() }, uGy: { value: new THREE.Vector2() }, uDrift: { value: new THREE.Vector2() },
      uCov: { value: 0 }, uShade: { value: 0 }, uHaze: { value: 0 }, uHazeCol: { value: new THREE.Vector3() } },
    vertexShader: `uniform vec2 uG0, uGx, uGy; varying vec2 vG;
      void main() { vG = uG0 + uGx * position.x + uGy * position.y; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform vec2 uDrift; uniform float uCov, uShade, uHaze; uniform vec3 uHazeCol; varying vec2 vG;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + 1.0), f.x), f.y); }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int k = 0; k < 4; k++) { s += a * n(p); p = p * 2.07 + 17.3; a *= 0.5; } return s; }
      void main() {
        float shade = 1.0;
        if (uShade > 0.0) {
          float c = fbm((vG + uDrift) / 1100.0), t = 0.62 - 0.32 * uCov;
          shade = 1.0 - uShade * smoothstep(t - 0.05, t + 0.09, c);
        }
        float f = 0.0;
        if (uHaze > 0.0) f = clamp(uHaze * (0.55 + 0.9 * fbm((vG + uDrift * 0.4) / 2600.0 + 5.0)), 0.0, 0.92);
        gl_FragColor = vec4(uHazeCol * f, shade * (1.0 - f)); // blended as src + dst * src.a
      }`,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
    transparent: true, depthTest: false, depthWrite: false,
  }))
  atmo.frustumCulled = false; atmo.renderOrder = -1000; atmo.visible = false
  city.overlay.add(atmo)

  // ---------- rain and snow: one instanced quad mesh in screen space, anchored to the ground as the view pans
  const MAXP = 8000, MINZ = matchMedia('(pointer: coarse)').matches ? 0.06 : 0.025 // particles from this zoom in (phones: closer)
  const pg = new THREE.InstancedBufferGeometry()
  pg.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3))
  pg.setIndex([0, 1, 2, 0, 2, 3])
  const seeds = new Float32Array(MAXP * 3)
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random()
  pg.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 3))
  pg.instanceCount = 0
  const drops = new THREE.Mesh(pg, new THREE.ShaderMaterial({
    uniforms: { uRes: { value: new THREE.Vector2() }, uOff: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2(0, -1) }, uT: { value: 0 },
      uSpeed: { value: 900 }, uLen: { value: 18 }, uWid: { value: 1.2 }, uSnow: { value: 0 }, uCol: { value: new THREE.Vector4(1, 1, 1, 0.4) } },
    vertexShader: `attribute vec3 seed; uniform vec2 uRes, uOff, uDir; uniform float uT, uSpeed, uLen, uWid, uSnow; varying vec2 vUv;
      void main() {
        vec2 span = uRes + 120.0, d = uDir;
        float k = 0.75 + 0.5 * seed.z; // nearer drops: faster, longer
        vec2 p = seed.xy * span + uOff + d * uSpeed * k * uT;
        p.x += uSnow * sin(uT * (0.7 + seed.z) + seed.x * 40.0) * 10.0 * k;
        p = mod(p, span) - 60.0;
        float len = mix(uLen * k, uWid * k, uSnow);
        p += -d * position.x * len + vec2(-d.y, d.x) * position.y * uWid * k * 0.5;
        vUv = position.xy;
        gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
      }`,
    fragmentShader: `uniform float uSnow; uniform vec4 uCol; varying vec2 vUv;
      void main() {
        float a = uSnow > 0.5 ? 1.0 - smoothstep(0.35, 1.0, length(vec2(vUv.x * 2.0 - 1.0, vUv.y)))
          : (1.0 - vUv.x) * (1.0 - vUv.y * vUv.y);
        gl_FragColor = vec4(uCol.rgb, uCol.a * a);
      }`,
    transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  }))
  drops.frustumCulled = false; drops.renderOrder = 1000; drops.visible = false
  city.overlay.add(drops)

  // ---------- state -> lights, grade, effects
  const fx = { tint: [1, 1, 1], desat: 0, flash: 0, precip: 0, snow: false, storm: false, wind: [0, 0] } // grade before a lightning flash
  let w = null, emitted = '', anim = null, lastDir = null, nextBolt = 0, flashT = -1, lightLevel = 1, lastFrameAt = 0

  function current() {
    const t = state.hour == null ? Date.now() : vanTime(Date.now()).midnight + state.hour * 3600e3
    const hour = state.hour == null ? vanTime(t).hour : state.hour
    let kind, intensity, cloud
    if (state.mode === 'live' && live) ({ kind, intensity, cloud } = live)
    else if (state.mode === 'live') { kind = 'cloudy'; intensity = 0.5; cloud = 0.5 } // until the first answer
    else { kind = state.mode; intensity = PICKS[kind] ?? 0.5; cloud = kind === 'clear' ? 0.12 : kind === 'cloudy' ? 0.55 : 1 }
    return { t, hour, kind, intensity, cloud, ...solar(t) }
  }

  function lerpKeys(el) {
    const e = el / RAD
    let i = 0
    while (i < TOD.length - 2 && e > TOD[i + 1].el) i++
    const a = TOD[i], b = TOD[i + 1], k = THREE.MathUtils.clamp((e - a.el) / (b.el - a.el), 0, 1)
    const mix = (x, y) => x + (y - x) * k
    const col = (x, y) => ca.setHex(x).lerp(cb.setHex(y), k).clone()
    return { tint: a.tint.map((x, j) => mix(x, b.tint[j])), desat: mix(a.desat, b.desat), sun: col(a.sun, b.sun), sunI: mix(a.sunI, b.sunI), sky: col(a.sky, b.sky), gnd: col(a.gnd, b.gnd), hemiI: mix(a.hemiI, b.hemiI) }
  }

  function apply() {
    const c = current(), tod = lerpKeys(c.el), look = LOOK[c.kind] || LOOK.cloudy
    const elDeg = c.el / RAD, isNight = elDeg < -6
    const wet = c.kind === 'clear' || c.kind === 'cloudy' ? 0 : 0.6 + 0.4 * c.intensity // how far towards the weather look
    // light: the sun, clamped above 10° so the shadows stay readable; through twilight it turns into a soft
    // moon-like key light from the south-south-west (the camera looks north, so its shadows fall into view)
    const night = THREE.MathUtils.smoothstep(elDeg, 2, -8)
    const se = Math.max(c.el, 10 * RAD), mz = 200 * RAD, me = 38 * RAD
    v3.set(Math.sin(c.az) * Math.cos(se), Math.sin(se), -Math.cos(c.az) * Math.cos(se)).multiplyScalar(1 - night)
      .add(new THREE.Vector3(Math.sin(mz) * Math.cos(me), Math.sin(me), -Math.cos(mz) * Math.cos(me)).multiplyScalar(night)).normalize()
    if (!lastDir || lastDir.angleTo(v3) > 0.002) { lastDir = v3.clone(); city.light.setSunDirection(v3) }
    // windows light up through dusk (and earlier on dark, wet days)
    if ('night' in city.light) city.light.night = Math.min(1, 1 - THREE.MathUtils.smoothstep(elDeg, -6, 8) + (c.kind === 'storm' || c.kind === 'rain' ? 0.25 * c.intensity : 0))
    const keep = c.kind === 'clear' || c.kind === 'cloudy' ? 1 - (1 - look.sun) * c.intensity : look.sun + (1 - look.sun) * (1 - wet) * 0.3
    sun.color.copy(tod.sun).lerp(c3.setHex(0xdde4f0), 1 - keep) // diffuse days: whiter, weaker sun
    sun.intensity = tod.sunI * keep
    hemi.color.copy(tod.sky).lerp(c3.setHex(0xc8d0dc).multiplyScalar(tod.hemiI / 2), (1 - keep) * 0.6)
    hemi.groundColor.copy(tod.gnd)
    hemi.intensity = tod.hemiI * (1 + 0.3 * (1 - keep))
    // grade
    const cl = c.kind === 'clear' || c.kind === 'cloudy' ? c.intensity : 1
    fx.tint = tod.tint.map((x, j) => x * (1 + (look.tint[j] - 1) * (wet || cl)))
    fx.desat = Math.min(0.8, tod.desat + look.desat * (wet || cl))
    lightLevel = Math.max(0.25, (tod.tint[0] + tod.tint[1] + tod.tint[2]) / 3)
    grade()
    // atmosphere: cloud shadows by day under broken cloud; haze in fog, rain, snow and overcast
    const a = atmo.material.uniforms
    const shadows = c.kind === 'clear' || c.kind === 'cloudy' ? THREE.MathUtils.smoothstep(elDeg, -2, 8) : 0
    a.uCov.value = THREE.MathUtils.clamp(c.cloud, 0.05, 0.9)
    a.uShade.value = shadows * (c.cloud > 0.04 ? 0.16 + 0.1 * c.cloud : 0) // lighter for a few fair-weather clouds
    a.uHaze.value = look.haze * (c.kind === 'fog' ? 0.5 + 0.7 * c.intensity : wet || cl)
    const hz = isNight ? [0.1, 0.12, 0.18] : (look.hazeCol || [0.8, 0.84, 0.9]).map((x, j) => x * Math.min(1, 0.35 + tod.tint[j] * 0.65))
    a.uHazeCol.value.set(...hz)
    // particles
    const snow = c.kind === 'snow', rain = c.kind === 'rain' || c.kind === 'storm' || c.kind === 'drizzle'
    fx.precip = rain || snow ? c.intensity * (c.kind === 'drizzle' ? 0.5 : 1) : 0
    fx.snow = snow
    const wnd = (live?.wind ?? 3), from = (live?.windFrom ?? 225) * RAD
    fx.wind = [-Math.sin(from) * wnd, Math.cos(from) * wnd] // towards, x east / z south, m/s
    fx.storm = c.kind === 'storm'
    effects()
    // the contract
    w = { kind: c.kind, intensity: +c.intensity.toFixed(2), isNight, hour: +c.hour.toFixed(2), live: state.mode === 'live' && state.hour == null }
    city.weather = w
    const key = JSON.stringify(w)
    if (key !== emitted) { emitted = key; city.emit('weather', w) }
    ui()
    city.requestRender()
  }

  function grade() {
    const f = fx.flash
    U.tint.value.set(...fx.tint.map((x, j) => x * (1 - f) + f * [2.2, 2.3, 2.7][j]))
    U.desat.value = fx.desat * (1 - f)
  }

  function sizeDrops() { // by zoom: bigger, faster and denser up close; a fine texture from far away
    const f = THREE.MathUtils.clamp(Math.log(city.camera.zoom / 0.025) / Math.log(0.5 / 0.025), 0, 1) // 0 city .. 1 street
    const u = drops.material.uniforms, area = innerWidth * innerHeight
    u.uSnow.value = fx.snow ? 1 : 0
    u.uSpeed.value = fx.snow ? 40 + 60 * f : 420 + 680 * f
    u.uLen.value = 6 + 22 * f
    u.uWid.value = fx.snow ? 2.2 + 4.8 * f : 0.8 + 0.8 * f
    const b = Math.min(1, lightLevel * 1.4)
    u.uCol.value.set(...(fx.snow ? [0.97, 0.98, 1].map((x) => x * Math.max(0.45, b)) : [0.86, 0.9, 1].map((x) => x * Math.max(0.4, b))), fx.snow ? 0.95 : 0.2 + 0.25 * f)
    const per = fx.snow ? 380 : 320 // CSS px² per particle at full intensity
    pg.instanceCount = Math.min(MAXP, Math.round((area / per) * (0.15 + 0.85 * fx.precip) * (0.55 + 0.45 * f)))
  }

  // what is on screen decides what runs
  const dropsWanted = () => !document.hidden && fx.precip > 0 && city.camera.zoom >= MINZ
  function effects() {
    const on = !document.hidden, pOn = dropsWanted()
    drops.visible = pOn
    atmo.visible = atmo.material.uniforms.uShade.value > 0.001 || atmo.material.uniforms.uHaze.value > 0.001
    const want = pOn || (on && flashT >= 0)
    if (want && !anim) anim = city.animate()
    else if (!want && anim) { anim(); anim = null }
    city.requestRender()
  }

  // per frame: camera-dependent uniforms, the clock, lightning
  const ndc = new THREE.Vector3(), g = (x, y, out) => { // ground (y = 0) under an NDC point
    ndc.set(x, y, -1).unproject(city.camera); const o = ndc.clone()
    ndc.set(x, y, 1).unproject(city.camera); const t = o.y / (o.y - ndc.y)
    return out.set(o.x + (ndc.x - o.x) * t, o.z + (ndc.z - o.z) * t)
  }
  const t0 = performance.now()
  const offFrame = city.on('frame', () => {
    lastFrameAt = performance.now()
    const t = (lastFrameAt - t0) / 1000, cam = city.camera
    cam.updateMatrixWorld()
    if (drops.visible && !dropsWanted()) effects() // zoomed out past them
    if (atmo.visible) {
      const a = atmo.material.uniforms, sp = Math.max(3, Math.hypot(...fx.wind) * 2) / Math.max(0.5, Math.hypot(...fx.wind))
      g(0, 0, a.uG0.value); g(1, 0, a.uGx.value).sub(a.uG0.value); g(0, 1, a.uGy.value).sub(a.uG0.value)
      a.uDrift.value.set(-fx.wind[0] * sp * t, -fx.wind[1] * sp * t)
    }
    if (drops.visible) {
      sizeDrops()
      const u = drops.material.uniforms, W = innerWidth, H = innerHeight
      u.uRes.value.set(W, H)
      u.uT.value = t % 600
      // the ground origin's screen position anchors the pattern; the fall direction is the wind-slanted
      // velocity projected to the screen (rain falls ~9 m/s, snow ~1 m/s)
      const p0 = v3.set(0, 0, 0).project(cam), x0 = p0.x, y0 = p0.y
      u.uOff.value.set(x0 * W / 2, y0 * H / 2)
      const fall = fx.snow ? 1.2 : 9, s = Math.min(fx.snow ? 1.5 : 0.7, 1 / fall)
      const tgt = city.controls.target, a = v3.copy(tgt).project(cam), ax = a.x, ay = a.y
      const b = v3.copy(tgt).add(ndc.set(fx.wind[0] * s, -1, fx.wind[1] * s)).project(cam)
      u.uDir.value.set((b.x - ax) * W, (b.y - ay) * H).normalize()
    }
    if (flashT >= 0) { // lightning: a bright flicker, then a second, weaker one
      const e = t - flashT
      fx.flash = e > 0.55 ? 0 : 0.5 * Math.max(0, 1 - e / 0.07) + 0.75 * Math.max(0, 1 - Math.abs(e - 0.2) / 0.1) + 0.3 * Math.max(0, 1 - Math.abs(e - 0.36) / 0.12)
      grade()
      if (e > 0.55) { flashT = -1; effects() }
    }
  })
  const offView = city.on('view', () => { if (drops.visible !== dropsWanted()) effects() })
  const onVis = () => { effects(); if (!document.hidden && Date.now() - fetchedAt > 15 * 60e3) refresh() }
  document.addEventListener('visibilitychange', onVis)

  // slow things: the sun every minute, a rare lightning bolt, clouds drifting while nothing else redraws
  let secs = 0
  const tick = setInterval(() => {
    if (document.hidden) return
    const t = (performance.now() - t0) / 1000
    if (fx.storm && flashT < 0 && t > nextBolt) { if (nextBolt) { flashT = t; effects() } nextBolt = t + 10 + Math.random() * 30 }
    if (state.hour == null && ++secs % 60 === 0) apply()
    else if (atmo.visible && performance.now() - lastFrameAt > 900) city.requestRender()
  }, 1000)

  // ---------- live data
  let timer = 0, busy = false
  async function refresh() {
    clearTimeout(timer)
    timer = setTimeout(refresh, 15 * 60e3)
    if (document.hidden || busy) return
    busy = true
    try {
      const j = await fetch(API).then((r) => { if (!r.ok) throw new Error(r.status); return r.json() })
      live = fromOpenMeteo(j.current); fetchedAt = Date.now()
      apply()
    } catch (e) { console.warn('weather: Open-Meteo', e); if (!live) { live = false; ui() } } finally { busy = false }
  }

  // ---------- UI
  const style = document.createElement('style')
  style.textContent = `.wx h3 { margin: 10px 0 6px; font-size: 10.5px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
    .wx .now { color: var(--text); }
    .wx .chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .wx .chips button, .wx .row button { font: inherit; color: var(--text); background: rgba(255,255,255,.06); border: 1px solid var(--line); border-radius: 7px; padding: 4px 9px; cursor: pointer; }
    .wx button[aria-pressed="true"] { background: var(--accent); color: #0b1016; border-color: transparent; }
    .wx .row { display: flex; align-items: center; gap: 8px; }
    .wx input[type=range] { flex: 1; accent-color: var(--accent); }
    .wx .clock { font-variant-numeric: tabular-nums; color: var(--text); min-width: 3em; text-align: right; }
    .wx .credit { margin-top: 10px; color: var(--muted); font-size: 11.5px; }`
  document.head.append(style)
  const btn = city.ui.addButton({ label: 'Weather', title: 'Weather and time of day', panel: true })
  const P = btn.panel
  P.classList.add('wx')
  P.innerHTML = `<div class="now"></div>
    <h3>Weather</h3><div class="chips">${['live', 'clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'].map((k) => `<button type="button" data-k="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
    <h3>Time of day</h3><div class="row"><button type="button" data-t="live">Live</button><input type="range" min="0" max="24" step="0.25" aria-label="Hour of day"><span class="clock"></span></div>
    <div class="credit">Vancouver weather by <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a> (CC BY 4.0)</div>`
  const range = P.querySelector('input'), clock = P.querySelector('.clock'), now = P.querySelector('.now')
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)) } catch {} }
  P.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return
    if (b.dataset.k) state.mode = b.dataset.k
    if (b.dataset.t) state.hour = null
    save(); apply()
  })
  range.addEventListener('input', () => { state.hour = +range.value; save(); apply() })
  const hhmm = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60 + 1e-6)).padStart(2, '0')}`
  function ui() {
    for (const b of P.querySelectorAll('[data-k]')) b.setAttribute('aria-pressed', String(b.dataset.k === state.mode))
    P.querySelector('[data-t]').setAttribute('aria-pressed', String(state.hour == null))
    if (document.activeElement !== range) range.value = String(w.hour)
    clock.textContent = hhmm(w.hour)
    now.textContent = live ? `Live: ${Math.round(live.temp)}°C, ${live.desc}` : live === false ? 'Live: Open-Meteo unreachable, retrying' : 'Live: loading Vancouver weather…'
    const ic = w.isNight && (w.kind === 'clear' || w.kind === 'cloudy') ? ICON.night : ICON[w.kind]
    btn.button.textContent = state.mode === 'live' && live ? `${ic} ${Math.round(live.temp)}°` : `${ic} Weather`
  }

  apply()
  refresh()

  return {
    dispose() {
      clearTimeout(timer); clearInterval(tick)
      offFrame(); offView(); document.removeEventListener('visibilitychange', onVis)
      anim?.(); btn.remove(); style.remove()
      for (const m of [atmo, drops]) { city.overlay.remove(m); m.geometry.dispose(); m.material.dispose() }
      sun.color.copy(saved.sunC); sun.intensity = saved.sunI
      hemi.color.copy(saved.sky); hemi.groundColor.copy(saved.gnd); hemi.intensity = saved.hemiI
      city.light.setSunDirection(saved.dir)
      U.tint.value.set(1, 1, 1); U.desat.value = 0
      city.requestRender()
    },
  }
}
