// The camera's look, after the weather's grade (main.js's ink pass, the tree billboards): exposure and white balance,
// a cool-shadow / warm-highlight split, contrast about middle grey, saturation with a little vibrance, ACES filmic
// tone mapping and a faint vignette; per time of day (golden hour, midday, twilight, midnight, blended by the sun's
// height). And a selective bloom: what is brighter than the threshold (lit windows, lamp pools, shop fronts, glints),
// its peak capped so a single hot pixel can't flare, blurred over a chain of quarter, eighth... resolution targets
// (dual Kawase) and added before the tone mapping.
// Adapted from Slop Toronto's post-processing.js and live-sky.js (MIT, © 2026 Mr.doob, © 2026 John Fewell; see
// THIRD_PARTY.md): the looks' values and the order of operations; here in GLSL on a WebGL2 target.
import * as THREE from 'three'

const LOOKS = {
  golden: { exposure: 1.04, contrast: 1.12, saturation: 1.08, balance: [1.045, 1.0, 0.955], bloom: 0, threshold: 1.2 }, // (no bloom by day: nothing that bright, and it costs)
  midday: { exposure: 1.0, contrast: 1.1, saturation: 1.06, balance: [1.015, 1.0, 0.985], bloom: 0, threshold: 1.35 },
  twilight: { exposure: 1.12, contrast: 1.1, saturation: 1.08, balance: [1.025, 0.995, 1.015], bloom: 0.3, threshold: 0.7 },
  midnight: { exposure: 1.4, contrast: 1.0, saturation: 1.06, balance: [0.985, 1.0, 1.035], bloom: 0.34, threshold: 0.6 },
}
const ANCHORS = [['midnight', -9], ['twilight', -1], ['golden', 10], ['midday', 32]] // sun elevation (degrees) of each

export const look = {
  exposure: { value: 1 }, contrast: { value: 1.1 }, saturation: { value: 1.06 }, balance: { value: new THREE.Vector3(1, 1, 1) },
  bloom: { value: 0 }, threshold: { value: 1.35 }, tBloom: { value: null },
}
// the look for the sun this many degrees up (the presets blended between their anchors)
export function lookFor(elevation) {
  let a = ANCHORS[0], b = ANCHORS[0], s = 0
  if (elevation >= ANCHORS[3][1]) a = b = ANCHORS[3]
  else if (elevation > ANCHORS[0][1]) for (let i = 0; i < 3; i++) if (elevation <= ANCHORS[i + 1][1]) { a = ANCHORS[i]; b = ANCHORS[i + 1]; s = THREE.MathUtils.smoothstep(elevation, a[1], b[1]); break }
  const A = LOOKS[a[0]], B = LOOKS[b[0]], m = (k) => A[k] + (B[k] - A[k]) * s
  look.exposure.value = m('exposure'); look.contrast.value = m('contrast'); look.saturation.value = m('saturation')
  look.balance.value.set(...[0, 1, 2].map((i) => A.balance[i] + (B.balance[i] - A.balance[i]) * s))
  look.bloom.value = m('bloom'); look.threshold.value = m('threshold')
}
lookFor(40) // midday until the weather says otherwise

// vec3 tone(vec3 c): linear scene colour (graded) -> display-referred linear, before the sRGB encoding
export const LOOK_GLSL = `uniform float exposure, contrast, saturation; uniform vec3 balance;
  vec3 aces(vec3 c) { // three.js's ACESFilmicToneMapping (Stephen Hill's fit), exposure folded in by the caller
    const mat3 I = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
    const mat3 O = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
    c = I * (c / 0.6);
    c = (c * (c + 0.0245786) - 0.000090537) / (c * (0.983729 * c + 0.4329510) + 0.238081);
    return clamp(O * c, 0.0, 1.0);
  }
  vec3 exposed(vec3 c) { return max(c, 0.0) * exposure * balance; }
  vec3 tone(vec3 c) { // c: exposed
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c *= mix(vec3(0.965, 1.005, 1.045), vec3(1.0), smoothstep(0.02, 0.6, l)) * mix(vec3(1.0), vec3(1.035, 1.005, 0.965), smoothstep(0.6, 3.0, l));
    c *= pow(max(l, 1e-4) / 0.18, contrast - 1.0);
    float g = dot(c, vec3(0.2126, 0.7152, 0.0722)), hi = max(max(c.r, c.g), c.b), ch = hi - min(min(c.r, c.g), c.b);
    c = max(mix(vec3(g), c, saturation + 0.1 * (1.0 - ch / max(hi, 1e-4))), 0.0);
    return aces(c);
  }`
export const lookUniforms = (u) => Object.assign(u, { exposure: look.exposure, contrast: look.contrast, saturation: look.saturation, balance: look.balance })

// ---------------------------------------------------------------- bloom
const quad = new THREE.PlaneGeometry(2, 2)
const VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
export class Bloom {
  // prefilter: GLSL defining `vec3 source(vec2 uv)`, the exposed scene colour at the canvas uv (main.js's grade), with
  // its uniforms
  constructor(prefilter, uniforms) {
    this.levels = []
    this.scene = new THREE.Scene(); this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.mesh = new THREE.Mesh(quad); this.mesh.frustumCulled = false; this.scene.add(this.mesh)
    this.pre = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, threshold: look.threshold }, vertexShader: VS, depthTest: false, depthWrite: false,
      fragmentShader: `${prefilter} uniform float threshold; varying vec2 vUv;
        void main() {
          vec3 c = source(vUv); float peak = max(max(c.r, c.g), c.b);
          c *= 8.0 / max(peak, 8.0); peak = min(peak, 8.0); // the cap: colours kept, a hot pixel can't flare
          float k = smoothstep(threshold - 0.3, threshold + 0.3, peak);
          gl_FragColor = vec4(c * k, 1.0);
        }`,
    })
    // dual Kawase (Marius Bjørge, SIGGRAPH 2015): down 5 taps, up 8 taps, half a texel off
    this.down = new THREE.ShaderMaterial({
      uniforms: { src: { value: null }, px: { value: new THREE.Vector2() } }, vertexShader: VS, depthTest: false, depthWrite: false,
      fragmentShader: `uniform sampler2D src; uniform vec2 px; varying vec2 vUv;
        void main() { vec2 h = px * 0.5; gl_FragColor = (texture2D(src, vUv) * 4.0 + texture2D(src, vUv - h) + texture2D(src, vUv + h) + texture2D(src, vUv + vec2(h.x, -h.y)) + texture2D(src, vUv - vec2(h.x, -h.y))) / 8.0; }`,
    })
    this.up = new THREE.ShaderMaterial({
      uniforms: { src: { value: null }, px: { value: new THREE.Vector2() } }, vertexShader: VS, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending, transparent: true,
      fragmentShader: `uniform sampler2D src; uniform vec2 px; varying vec2 vUv;
        void main() { vec2 h = px * 0.5;
          vec4 s = texture2D(src, vUv + vec2(-h.x * 2.0, 0.0)) + texture2D(src, vUv + vec2(h.x * 2.0, 0.0)) + texture2D(src, vUv + vec2(0.0, -h.y * 2.0)) + texture2D(src, vUv + vec2(0.0, h.y * 2.0));
          s += (texture2D(src, vUv + h) + texture2D(src, vUv - h) + texture2D(src, vUv + vec2(h.x, -h.y)) + texture2D(src, vUv - vec2(h.x, -h.y))) * 2.0;
          gl_FragColor = vec4(s.rgb / 12.0 * 0.6, 1.0); }`,
    })
  }

  size(w, h) {
    const n = 4 // a quarter, an eighth... of the canvas (half was ~4x the cost for the same soft glow)
    for (let i = 0; i < n; i++) {
      const lw = Math.max(1, Math.round(w / 2 ** (i + 2))), lh = Math.max(1, Math.round(h / 2 ** (i + 2)))
      let t = this.levels[i]
      if (!t) t = this.levels[i] = new THREE.WebGLRenderTarget(lw, lh, { type: THREE.HalfFloatType, depthBuffer: false })
      else if (t.width !== lw || t.height !== lh) t.setSize(lw, lh)
    }
    look.tBloom.value = this.levels[0].texture
  }

  render(renderer, w, h) {
    this.size(w, h)
    const L = this.levels, pass = (mat, target) => { this.mesh.material = mat; renderer.setRenderTarget(target); renderer.render(this.scene, this.cam) }
    const keep = renderer.autoClear
    renderer.autoClear = true
    pass(this.pre, L[0])
    for (let i = 1; i < L.length; i++) { this.down.uniforms.src.value = L[i - 1].texture; this.down.uniforms.px.value.set(1 / L[i - 1].width, 1 / L[i - 1].height); pass(this.down, L[i]) }
    renderer.autoClear = false // the way back up adds each level onto the next bigger one
    for (let i = L.length - 1; i > 0; i--) { this.up.uniforms.src.value = L[i].texture; this.up.uniforms.px.value.set(1 / L[i].width, 1 / L[i].height); pass(this.up, L[i - 1]) }
    renderer.autoClear = keep
  }

  dispose() { for (const t of this.levels) t.dispose(); this.levels = []; look.tBloom.value = null }
}
