// Shared materials for the streamed map. All surfaces are Lambert (so the sun, the shadows and the ink pass
// work) with their detail drawn procedurally in the fragment shader: crisp at any zoom, nothing to download.
import * as THREE from 'three'
import { NOISE_GLSL, SEA0, SEA_RISE } from './util.js'
import { LOOK_GLSL, lookUniforms } from './look.js'
import { treeForm, FORMS, ASPECT } from './treeforms.js'

const COMMON = `
  vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
  ${NOISE_GLSL}
  float fbm(vec2 p) { return noise(p) * 0.5 + noise(p * 2.03) * 0.25 + noise(p * 4.1) * 0.125 + noise(p * 8.3) * 0.0625; }
  // the rain's puddle map: fbm's two coarse octaves (the two fine ones, 8 hashes, only roughened the puddle edge) and their mean
  float puddles(vec2 p) { return noise(p) * 0.5 + noise(p * 2.03) * 0.25 + 0.094; }
  // 1 inside [lo, hi], antialiased by the screen-space footprint fw
  float band(float x, float lo, float hi, float fw) { return smoothstep(lo - fw, lo + fw, x) * (1.0 - smoothstep(hi - fw, hi + fw, x)); }
  // how much of a pixel fw wide at x lies in [lo, hi] (a box filter): a line thinner than a pixel fades with its width
  // instead of breaking up, however far off
  float cover(float x, float lo, float hi, float fw) { return clamp((min(x + fw * 0.5, hi) - max(x - fw * 0.5, lo)) / fw, 0.0, 1.0); }
  // the same for stripes on along the first \`duty\` of every unit of x (fw in units): far off they even out to the duty, no moire
  float stripes(float x, float duty, float fw) {
    fw = max(fw, 1e-3); float a = x - fw * 0.5, b = x + fw * 0.5;
    return clamp((floor(b) - floor(a)) * duty / fw + (min(fract(b), duty) - min(fract(a), duty)) / fw, 0.0, 1.0);
  }
`

// Weather on the ground (city.surface): wet darkens paved and planted ground and gives it a sheen of the sky at
// grazing angles (puddles shine most); snow whitens flat ground, roofs and, less, the roads.
// seaHole (x, sea level, z, radius; radius 0 = off): the map's sea is left out within radius of (x, z) and below sea
// level + 3 m, where a plugin draws its own water (the sail plugin's waves)
// tide (city.sea.level): metres the sea stands above the baked one. The ground's water and piers (floating docks) rise
// with it, up to SEA_RISE; the sand it covers is drawn as water, the sand it has left is wet (util.js SEA0, SEA_RISE)
export const surface = { wet: { value: 0 }, snow: { value: 0 }, sky: { value: new THREE.Color(0x8090a0) }, seaHole: { value: new THREE.Vector4() }, tide: { value: 0 } }
const SURF = `uniform float wet, snow; uniform vec3 skyCol;
  // the sky seen in a wet surface at p (up-facing): Schlick fresnel towards the camera
  float sheenAt(vec3 p) { float c = max(dot(normalize(cameraPosition - p), vec3(0.0, 1.0, 0.0)), 0.0); return pow(1.0 - c, 5.0); }`

// What stands between a street-level camera and the player (main.js sets occluder from city.player: centre xyz,
// radius; radius 0 = off) dissolves: the 3D trees as a whole, building faces that cross the line of sight. A world
// space dissolve in ~0.6 m cells rather than a per-pixel dither, which the ink pass would outline pixel by pixel.
export const occluder = { value: new THREE.Vector4() }
export const OCCLUDE = `uniform vec4 occluder;
  // 1 within r (+ the player's radius) of the line from the camera to the player, fading out over 1.5 m beyond;
  // the line stops short of the player, whose own surroundings stay
  float occluded(vec3 p, float r) {
    if (occluder.w <= 0.0) return 0.0;
    vec3 ab = occluder.xyz - cameraPosition;
    float L = length(ab), t = clamp(dot(p - cameraPosition, ab) / (L * L), 0.0, 1.0 - min(0.9, (occluder.w + 1.0) / L));
    float d = distance(p, cameraPosition + ab * t) - r - occluder.w;
    return 1.0 - smoothstep(0.0, 1.5, d);
  }`
export const DISSOLVE = `void dissolve(vec3 p, float k) { if (k > 0.0 && fract(sin(dot(mod(floor(p * 1.7), 289.0), vec3(12.99, 78.23, 37.72))) * 43758.55) < k) discard; }`
const surfUniforms = (s) => { s.uniforms.wet = surface.wet; s.uniforms.snow = surface.snow; s.uniforms.skyCol = surface.sky }

export const night = { value: 0 } // 0 day .. 1 night: lights a share of the windows, the street lamps (city.light.night)
export const late = { value: 0 } // 0 evening .. 1 the small hours: fewer windows lit (city.light.late)
// Light on the ground at night: street lamps and the storefronts' spill, drawn from above into one texture over
// what is on screen (lights.js; red: lamps, green: shops). box: its west edge, south edge (three.js z), 1 / its size,
// and 1 while it holds anything. The overview tiles carry no lamps: their streets glow faintly instead (groundMaterial(true))
export const streetLight = { map: { value: null }, box: { value: new THREE.Vector4() } }
const LIGHT = `uniform sampler2D tLight; uniform vec4 lightBox;
  // the light falling on the ground at p (times the surface's own colour, it is what the surface gives off)
  vec3 poolLight(vec3 p) {
    vec2 uv = vec2(p.x - lightBox.x, lightBox.y - p.z) * lightBox.z;
    vec2 L = lightBox.w > 0.5 && uv == clamp(uv, 0.0, 1.0) ? texture2D(tLight, uv).rg : vec2(0.0);
    L = 1.0 - exp(-1.6 * L); // overlapping pools saturate instead of adding up to white
    return (vec3(1.0, 0.62, 0.3) * L.x * 2.3 + vec3(1.0, 0.56, 0.26) * L.y * 0.6) * night;
  }
  // the share of a pixel's colour that is this light (the post pass leaves it out of the night grade)
  float lightShare(vec3 lit, vec3 outgoing) { return clamp(dot(lit, vec3(0.3, 0.59, 0.11)) / max(dot(outgoing, vec3(0.3, 0.59, 0.11)), 1e-4), 0.0, 1.0); }`
const lightUniforms = (s) => { s.uniforms.night = night; s.uniforms.tLight = streetLight.map; s.uniforms.lightBox = streetLight.box }

// ---------------------------------------------------------------- ground
// class order matches tools/tiles.py GROUND
const GROUND_COLOURS = [ // stylized but true: greens by land cover (not neon), teal water, grey asphalt, light concrete walks
  [124, 150, 90], [122, 146, 90], [178, 174, 164], [168, 162, 150], [166, 166, 108], [110, 152, 78], [104, 160, 80], [110, 132, 84],
  [98, 128, 94], [60, 98, 58], [226, 212, 174], [154, 150, 144], [178, 162, 134], [146, 148, 150], [112, 115, 120], [196, 192, 182],
  [196, 172, 136], [98, 152, 72], [184, 102, 78], [52, 104, 128], [168, 148, 118], [92, 184, 206], [240, 244, 248],
  // 23 trail, walk, cycle, ballast, sidewalk, blvd, road, arterial (order = tools/tiles.py GROUND)
  [182, 164, 130], [196, 192, 184], [98, 102, 108], [132, 120, 108], [190, 188, 180], [106, 144, 76], [104, 107, 113], [96, 99, 106],
]
// far: the overview tiles' (no lamps: a faint glow along the streets at night)
export function groundMaterial(far = false) {
  const m = new THREE.MeshLambertMaterial()
  if (far) m.defines = { FAR: '' }
  m.onBeforeCompile = (s) => {
    surfUniforms(s); lightUniforms(s)
    s.uniforms.seaHole = surface.seaHole; s.uniforms.tide = surface.tide
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float cls;\nattribute float tidal;\nuniform float tide;\nflat varying float vCls;\nvarying float vTidal;\nvarying vec3 vW;\nvarying float vSlope;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nif (cls > 19.5 && cls < 20.5) transformed.y = max(transformed.y, ${SEA0.toFixed(2)} + tide + 0.45); // a dock stays above the water\nelse if (cls > 18.5 && cls < 19.5) transformed.y = transformed.y > ${SEA0.toFixed(2)} ? max(transformed.y, ${SEA0.toFixed(2)} + tide) : transformed.y + tide; // the sea (util.js seaSurface); a lake or a shelf above it only once the sea reaches it\nvCls = cls;\nvTidal = tidal;\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSlope = 1.0 - objectNormal.y;`)
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nflat varying float vCls;\nvarying float vTidal;\nvarying vec3 vW;\nvarying float vSlope;\nuniform vec4 seaHole;\nuniform float tide;\nuniform float night;\n${COMMON}\n${SURF}\n${LIGHT}
        const vec3 CL[${GROUND_COLOURS.length}] = vec3[](${GROUND_COLOURS.map((c) => `vec3(${c.map((v) => (v / 255).toFixed(4)).join(',')})`).join(',')});`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        int c = int(vCls + 0.5);
        vec2 p = vW.xz;
        // the tide: the water is baked up to the high water line, lying on the shore's slope there. By a beach (vTidal:
        // tile-worker.js ground), what of that slope stands above the sea now is the sand it has left, wet up to the
        // highest tide's line; the sand the sea covers is water, and wet above it
        float seaY = ${SEA0.toFixed(2)} + tide, wetSand = 0.0, foam = 0.0, shore = 0.0;
        const float TOP = ${(SEA0 + SEA_RISE + 0.25).toFixed(2)};
        if (c == 19) shore = smoothstep(seaY + 0.02, seaY + 0.1, vW.y) * (1.0 - smoothstep(2.6, 3.0, vW.y)) * smoothstep(0.0, 0.45, vTidal);
        else if (c == 10 && vW.y < seaY) { c = 19; foam = 1.0 - smoothstep(0.0, 0.07, seaY - vW.y); }
        if ((c == 10 || shore > 0.0) && vW.y < TOP) wetSand = 1.0 - smoothstep(TOP - 0.35, TOP, vW.y);
        if (c == 19 && shore < 0.5 && seaHole.w > 0.0 && vW.y < seaHole.y + 3.0 && distance(p, seaHole.xz) < seaHole.w) discard;
        vec3 col = srgb(CL[c]);
        float n = fbm(p * 0.08), fine = noise(p * 1.7);
        float px = max(fwidth(p.x), 1e-3); // metres per pixel, to fade detail before it can shimmer
        float near = 1.0 - smoothstep(0.15, 0.6, px);
        if (c == 9) { // forest: a canopy of lumps, lit from the upper left
          vec2 q = p * 0.22; float lumps = fbm(q * 1.3 + vec2(0.0, n));
          col *= 0.72 + 0.55 * lumps;
        } else if (c == 19) { // water: ripple diamonds
          vec2 r = vec2(p.x * 0.25 + p.y * 0.08, p.y * 0.5);
          float d = abs(fract(r.x) - 0.5) + abs(fract(r.y) - 0.5);
          col = mix(col * (0.9 + 0.2 * n), col * 1.35, (1.0 - smoothstep(0.12, 0.18, d)) * near * 0.6);
        } else if (c == 17 || c == 6) { // pitches and golf: mowing stripes
          col *= 1.0 + 0.07 * near * sign(sin(p.x * 0.35 + p.y * 0.12));
        } else if (c == 4) { // farmland: crop rows
          col *= 1.0 + 0.06 * sin(p.x * 1.6 + n * 3.0) * near + 0.12 * (n - 0.5);
        } else if (c == 15) { // plaza pavers
          vec2 g = fract(p * 0.8); col *= 1.0 - 0.06 * near * (step(g.x, 0.06) + step(g.y, 0.06));
        } else if (c == 20) { // pier planks
          col *= 1.0 - 0.12 * near * step(fract(p.x * 1.4), 0.12);
        } else if (c == 14 || c == 29 || c == 30 || c == 25) { // asphalt: parking, roads, cycle tracks
          col *= 0.94 + 0.08 * fine + 0.04 * noise(p * 0.2);
        } else if (c == 27 || c == 24) { // sidewalks and walks: concrete slabs
          vec2 g = fract(p / 1.5); float fw = max(fwidth(p.x / 1.5), 1e-3);
          col *= (0.95 + 0.06 * fine) * (1.0 - 0.07 * near * (1.0 - smoothstep(0.0, fw * 2.0, min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y)))));
        } else {
          col *= 0.9 + 0.2 * n + 0.05 * (fine - 0.5) * near;
        }
        if (shore > 0.0) col = mix(col, srgb(CL[10]) * (0.9 + 0.2 * n), shore);
        col = mix(col * mix(vec3(1.0), vec3(0.66, 0.68, 0.7), wetSand), vec3(0.86, 0.9, 0.9), foam * 0.55);
        if (c == 0) { // untagged land: lawns down in town, mountain forest up high
          float up = smoothstep(150.0, 450.0, vW.y + 60.0 * (n - 0.5));
          vec3 wild = srgb(vec3(0.24, 0.42, 0.24)) * (0.72 + 0.55 * fbm(p * 0.03 + vec2(n)));
          col = mix(col, wild, up);
        }
        // slopes: darker and rockier the steeper they are, so hills, cliffs and plateaus (UBC, Burnaby Mountain) read
        float sl = smoothstep(0.03, 0.45, vSlope);
        if (c != 19) col = mix(col, srgb(vec3(0.46, 0.42, 0.36)) * (0.85 + 0.2 * n), sl * 0.45) * (1.0 - 0.28 * sl);
        bool paved = c == 14 || c == 29 || c == 30 || c == 25 || c == 27 || c == 24 || c == 15 || c == 2 || c == 3 || c == 13;
        float sheen = 0.0;
        if (wet > 0.0 && c != 19) { // rain: darker, and paved ground mirrors the sky, most in the puddles
          col *= 1.0 - wet * (paved ? 0.42 : 0.22);
          if (paved) sheen = wet * sheenAt(vW) * (0.35 + 0.65 * smoothstep(0.5, 0.7, puddles(p * 0.21 + 3.0)));
        }
        if (snow > 0.0 && c != 19) { // snow: lying on the flat, thinner on steep ground and where traffic runs
          float cover = smoothstep(0.25, 0.7, snow - 0.9 * sl + 0.35 * (n - 0.5)) * (c == 29 || c == 30 ? 0.45 : 1.0);
          col = mix(col, vec3(0.86, 0.89, 0.93) * (0.94 + 0.08 * fine), cover);
        }
        diffuseColor.rgb = col;
        // street lamps and shop windows at night (lights.js); on the overview tiles a faint glow along the streets
        vec3 pool = vec3(0.0);
        if (night > 0.01 && c != 19) {
          pool = poolLight(vW);
          #ifdef FAR
          if (c == 29 || c == 30 || c == 27) pool += vec3(1.0, 0.72, 0.42) * 0.22 * night;
          #endif
        }
        vec3 poolE = (min(mix(col, vec3(dot(col, vec3(0.3, 0.59, 0.11))), 0.6), vec3(0.32)) + 0.05) * pool + (paved ? pool * wet * 0.1 : vec3(0.0)); // greys the grass, lights dark asphalt; wet paving shines`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += skyCol * sheen + poolE;')
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a = 1.0 - lightShare(poolE, gl_FragColor.rgb);')
  }
  m.customProgramCacheKey = () => (far ? 'ground6f' : 'ground6')
  return m
}

// ---------------------------------------------------------------- roads
// decal = true: only the paint (lines, crosswalks, rails), blended onto the ground; else full bridge surfaces
export function roadMaterial(decal = false) {
  // a decal blends its colour and leaves the alpha as the ground had it (the share of lamp light, see LIGHT)
  const m = new THREE.MeshLambertMaterial(decal ? { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor } : {})
  if (decal) m.defines = { DECAL: '' }
  m.onBeforeCompile = (s) => {
    surfUniforms(s); lightUniforms(s)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aRoad;\nattribute vec4 aRoad2;\nvarying vec4 vR;\nvarying vec4 vR2;\nvarying vec3 vW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvR = aRoad; vR2 = aRoad2;\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec4 vR;\nvarying vec4 vR2;\nvarying vec3 vW;\nuniform float night;\n${COMMON}\n${SURF}\n${LIGHT}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float s = vR.x, t = vR.y, w = vR.z; int kind = int(vR.w + 0.5);
        float at = abs(t), fs = max(fwidth(s), 1e-3), ft = max(fwidth(t), 1e-3);
        float detail = 1.0 - smoothstep(0.25, 0.7, max(fs, ft)); // texture (not markings) fades out before it shimmers
        vec3 col; float dPaint = 0.0; vec3 dCol = vec3(1.0);
        float grain = 0.94 + 0.08 * noise(vW.xz * 2.3) + 0.04 * noise(vW.xz * 0.2);
        if (kind == 101) { // bridge deck fascia and underside
          col = srgb(vec3(0.70, 0.69, 0.66)) * grain;
        } else if (kind == 100) { // sidewalks, kerbs, boulevards (under the carriageway)
          float blvd = floor(vR2.x / 256.0), walk = floor(mod(vR2.x, 256.0) / 16.0);
          float e = at - w * 0.5;
          vec3 concrete = srgb(vec3(0.68, 0.67, 0.64)) * grain, kerb = srgb(vec3(0.78, 0.77, 0.74)), grass = srgb(vec3(0.38, 0.50, 0.28)) * (0.92 + 0.12 * noise(vW.xz * 0.5));
          col = concrete;
          if (blvd > 0.0) col = mix(col, grass, band(e, 0.25, 0.25 + blvd, ft));
          col = mix(col, kerb, band(e, -0.1, 0.25, ft));
          col *= 1.0 - 0.08 * detail * (1.0 - smoothstep(0.0, 0.05, abs(fract(s / 1.5) - 0.5) - 0.47)); // joints
        } else if (kind == 14 || kind == 15) { // rail: ballast, sleepers, steel
          col = srgb(vec3(0.55, 0.50, 0.45)) * grain;
          float sleeper = stripes(s / 0.65, 0.35, fs / 0.65) * cover(at, -1.0, 1.3, ft);
          col = mix(col, srgb(vec3(0.42, 0.32, 0.24)), sleeper);
          float rail = cover(at, 0.66, 0.78, ft);
          col = mix(col, srgb(vec3(0.62, 0.62, 0.64)), rail);
          dPaint = max(sleeper * 0.9, rail); dCol = rail > 0.5 ? srgb(vec3(0.62, 0.62, 0.64)) : srgb(vec3(0.42, 0.32, 0.24));
        } else if (kind == 102) { // a crosswalk, kerb to kerb (s): continental bars centred on the road, or two lines (vR2.x 1)
          col = srgb(vec3(0.94, 0.94, 0.9));
          dPaint = (vR2.x > 0.5 ? cover(at, w * 0.5 - 0.3, w * 0.5, ft) : stripes((s - 0.5 * vR2.w) / 1.1 + 0.25, 0.5, fs / 1.1)) * cover(s, 0.3, vR2.w - 0.3, fs); dCol = col;
        } else if (kind >= 9 && kind <= 13) { // footway, cycleway, path, steps, track
          col = kind == 10 ? srgb(vec3(0.40, 0.42, 0.44)) : kind == 11 || kind == 13 ? srgb(vec3(0.72, 0.64, 0.50)) : srgb(vec3(0.71, 0.70, 0.67));
          col *= grain;
          if (kind == 10) col = mix(col, srgb(vec3(0.95, 0.95, 0.9)), cover(at, -1.0, 0.06, ft) * stripes(s / 4.0, 0.5, fs / 4.0));
          if (kind == 12) col *= 1.0 - 0.18 * stripes(s / 0.35, 0.18, fs / 0.35);
        } else { // carriageways, runways, taxiways
          float lanes = mod(vR2.x, 32.0), oneway = step(31.5, vR2.x);
          float dA = vR2.y, dB = vR2.z, len = vR2.w;
          col = srgb(kind <= 4 || kind >= 16 ? vec3(0.33, 0.34, 0.36) : vec3(0.36, 0.37, 0.39)) * grain;
          col *= 1.0 - 0.06 * band(at, w * 0.5 - 0.6, w * 0.5, ft); // gutters
          float junctionFade = smoothstep(9.0, 12.0, min(dA, dB)); // no lane paint inside junctions
          vec3 white = srgb(vec3(0.94, 0.94, 0.90)), yellow = srgb(vec3(0.93, 0.78, 0.25));
          float paint = 0.0; vec3 pc = white;
          if (kind <= 4 && lanes >= 2.0) {
            float lw = w / max(lanes, 1.0);
            if (oneway < 0.5) { // double yellow centre line, white dashes between lanes in each direction
              float c2 = cover(at, 0.08, 0.2, ft);
              paint = max(paint, c2); if (c2 > 0.0) pc = yellow;
              float k = (at) / lw, onLine = stripes(k + 0.09 / lw, 0.18 / lw, ft / lw) * step(1.0, k + 0.02) * step(k, lanes * 0.5 - 0.5);
              paint = max(paint, onLine * stripes(s / 12.0, 0.25, fs / 12.0));
            } else {
              float k = (t + w * 0.5) / lw, onLine = stripes(k + 0.09 / lw, 0.18 / lw, ft / lw) * step(0.98, k) * step(k, lanes - 0.98);
              paint = max(paint, onLine * stripes(s / 12.0, 0.25, fs / 12.0));
            }
            if (kind <= 1) paint = max(paint, cover(at, w * 0.5 - 0.55, w * 0.5 - 0.4, ft)); // edge lines
            paint *= junctionFade;
          }
          if (kind <= 4) { // stop lines just outside junctions (crosswalks are mapped ones, drawn separately)
            for (int e = 0; e < 2; e++) {
              float d = e == 0 ? dA : dB;
              if (d > 20.0) continue;
              float stop = cover(d, 5.0, 5.45, fs) * step(0.0, oneway > 0.5 ? 1.0 : (e == 0 ? -t : t)) * step(at, w * 0.5 - 0.3);
              paint = max(paint, stop);
            }
          }
          if (kind == 16) { // runway: centre dashes, edge lines, threshold piano keys
            paint = max(paint, cover(at, -1.0, 0.45, ft) * stripes(s / 60.0, 0.5, fs / 60.0));
            paint = max(paint, cover(at, w * 0.5 - 1.5, w * 0.5 - 0.6, ft));
            float th = min(s, len - s);
            paint = max(paint, cover(th, 6.0, 36.0, fs) * stripes(t / 3.6 - 0.25, 0.5, ft / 3.6) * step(at, w * 0.5 - 3.0));
          } else if (kind == 17) { // taxiway: yellow centre line
            float c2 = cover(at, -1.0, 0.2, ft); paint = max(paint, c2); if (c2 > 0.0) pc = yellow;
          }
          col = mix(col, pc, paint);
          dPaint = paint; dCol = pc;
        }
        float sheen = 0.0;
        if (wet > 0.0) {
          col *= 1.0 - 0.4 * wet; dCol *= 1.0 - 0.25 * wet;
          sheen = wet * sheenAt(vW) * (0.4 + 0.6 * smoothstep(0.5, 0.7, puddles(vW.xz * 0.21 + 3.0)));
        }
        if (snow > 0.0) { // white walks; slush on the carriageway, thickest away from the wheel tracks
          float road = kind == 100 || (kind >= 9 && kind <= 13) || kind == 102 ? 1.0 : 0.55 + 0.35 * smoothstep(0.3, 0.6, abs(fract(t / 1.8) - 0.5) * 2.0);
          float cover = smoothstep(0.25, 0.7, snow + 0.3 * (noise(vW.xz * 0.3) - 0.5)) * road;
          col = mix(col, vec3(0.86, 0.89, 0.93) * grain, cover);
          dPaint *= 1.0 - 0.8 * cover;
        }
        diffuseColor.rgb = col;
        #ifdef DECAL
          if (dPaint < 0.02) discard;
          diffuseColor = vec4(dCol, dPaint);
          sheen *= 0.5;
        #endif
        vec3 pool = night > 0.01 ? poolLight(vW) : vec3(0.0), poolE = (diffuseColor.rgb + 0.04) * pool + pool * wet * 0.1;`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += skyCol * sheen + poolE;')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        #ifndef DECAL
        gl_FragColor.a = 1.0 - lightShare(poolE, gl_FragColor.rgb);
        #endif`)
  }
  m.customProgramCacheKey = () => (decal ? 'road4d' : 'road4')
  return m
}

// ---------------------------------------------------------------- the shade where walls meet the ground
// (tile-worker.js skirt): multiplies what is under it, darkest at the wall; gone in the fog
export function aoMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsLib.fog }, fog: true,
    vertexShader: `attribute float t; varying float vT;
      #include <fog_pars_vertex>
      void main() {
        vT = t; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        #ifdef USE_FOG
        vFogDepth = -mv.z;
        #endif
      }`,
    fragmentShader: `varying float vT;
      #include <fog_pars_fragment>
      void main() {
        float k = 1.0 - 0.5 * (1.0 - vT) * (1.0 - vT);
        #if defined(USE_FOG) && !defined(FOG_EXP2)
        k = mix(k, 1.0, smoothstep(fogNear, fogFar, vFogDepth));
        #endif
        gl_FragColor = vec4(vec3(k), 1.0);
      }`,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  })
}

// ---------------------------------------------------------------- buildings (facade styles; see tile-worker.js)
// glass balcony railings, one per building by its seed (the hex as the linear colour, as vertex colours are)
const RAIL_GLSL = [0xb8dce0, 0xc8e4e8, 0xa8ccd8, 0xd8e8ea, 0x98c0cc].map((h, i, a) => {
  const v = `vec3(${[h >> 16, (h >> 8) & 255, h & 255].map((c) => (c / 255).toFixed(4)).join(', ')})`
  return i < a.length - 1 ? `seed < ${((i + 1) / a.length).toFixed(2)} ? ${v} : ` : v
}).join('')
// far: the overview tiles' (seen from far off: the windows as floor bands only)
export function buildingMaterial(far = false) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true })
  if (far) m.defines = { FAR: '' }
  m.onBeforeCompile = (s) => {
    s.uniforms.occluder = occluder
    s.uniforms.late = late
    surfUniforms(s); lightUniforms(s)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWin;\nattribute vec4 aFac;\nvarying vec4 vWin;\nflat varying vec4 vFac;\nvarying float vUp;\nvarying vec3 vWp, vWn;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWin = aWin;\nvFac = aFac;\nvWn = normalize(mat3(modelMatrix) * objectNormal);\nvUp = vWn.y;\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vWin;
        flat varying vec4 vFac;
        varying float vUp;
        varying vec3 vWp, vWn;
        uniform float night, late;
        ${COMMON}
        ${SURF}
        ${LIGHT}
        ${OCCLUDE}
        ${DISSOLVE}
        float thin(float width, float fw) { return smoothstep(0.6, 1.3, width / fw); }
        float box(vec2 f, vec2 lo, vec2 hi, vec2 fw) { vec2 a = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f)); return a.x * a.y; }
        // Lit windows over a pixel's footprint g +- fw / 2 (in window cells), box-filtered (as #53): the lit pane area
        // inside it (up to 2 x 2 cells; lo, hi: the pane in its cell), so a pick under a pixel fades in and out as the
        // camera moves instead of flipping. c(cell) = the window's colour if it is lit, else black
        vec3 windowCol(vec2 c, float share, float seed, float use, bool shop) {
          if (hash(c + seed * 57.0) >= share) return vec3(0.0);
          float hc = hash(c + 11.0);
          vec3 warm = mix(vec3(1.0, 0.6, 0.26), vec3(1.0, 0.74, 0.42), hash(c + 5.0)), cool = vec3(0.62, 0.68, 0.76);
          return use > 1.5 && !shop ? (hc < 0.5 ? cool : warm) : hc < 0.05 && !shop ? vec3(0.42, 0.56, 1.0) : hc < 0.14 ? cool : warm;
        }
        vec3 panes(vec2 g, vec2 fw, vec2 lo, vec2 hi, float share, float seed, float use, bool shop) {
          vec2 h = min(fw * 1.25, vec2(1.0)) * 0.5, a = g - h, b = g + h, n = floor(b) - floor(a);
          vec3 lit = vec3(0.0);
          for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) {
            if (float(i) > n.x || float(j) > n.y) continue; // a cell the footprint doesn't reach
            vec2 c = floor(a) + vec2(i, j), o = max(min(b, c + hi) - max(a, c + lo), 0.0);
            lit += windowCol(c, share, seed, use, shop) * (o.x * o.y);
          }
          return lit / (4.0 * h.x * h.y);
        }
        // the share of [a, b] inside the band [lo, hi) of every unit cell: an exact box filter, stable at any size
        float integ(float x, float lo, float hi) { return floor(x) * (hi - lo) + clamp(fract(x), lo, hi) - lo; }
        float bandCover(float a, float b, float lo, float hi) { return (integ(b, lo, hi) - integ(a, lo, hi)) / max(b - a, 1e-5); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // a face across the line of sight to the player (an overhang, a skybridge); not walls alongside it
        if (occluder.w > 0.0) dissolve(vWp, occluded(vWp, 0.3) * step(0.35, abs(dot(vWn, normalize(occluder.xyz - cameraPosition)))));
        // vWin.x = pattern + (storey code + 32 * storefront) / 64 (tile-worker.js): window rows follow the real floors
        float style = floor(vWin.x + 1e-4), q = floor(fract(vWin.x + 1e-4) * 64.0 + 0.5), rise = fract(vWin.x + 1e-4) * 16.0; // (a gable end's: its height)
        if (style == 20.0) q = 0.0;
        float front = step(31.5, q), fq = mod(q, 32.0), storey = fq > 0.5 ? 2.4 + fq * 0.15 : 3.2;
        float seed = fract(vWin.w), use = mod(floor(vWin.w), 4.0), z = vWin.z, u = vWin.y; // use: 1 homes, 2 work (tile-worker.js)
        float doorW = step(3.5, vWin.w); // the house's front wall: its door in the bay whose index is a multiple of 64
        // this wall's own look where the 2022 LiDAR saw it (tile-worker.js aFac, tools/lidar_walls.py): its glazing (1 punched,
        // 2 vertical strips, 3 ribbon bands, 4 curtain wall, 5 blank) and spandrel tone (1 dark, 2 light), the window bay
        // and how much of a bay and a storey the window fills, the storey height. On the generic office and commercial
        // patterns (punched, curtain, bands) the glazing and tone too, on the rest (homes, glass condos) the grid only
        float lk = mod(vFac.x, 8.0), tone = mod(floor(vFac.x / 8.0), 4.0);
        float bay = vFac.y > 0.5 ? 0.5 + 0.05 * vFac.y : 0.0, wxf = mod(vFac.z, 16.0) / 15.0, wyf = floor(vFac.z / 16.0) / 15.0;
        if (vFac.w > 0.5) storey = 2.0 + 0.025 * vFac.w;
        vec3 base = diffuseColor.rgb;
        if (lk > 0.5 && (style == 1.0 || style == 2.0 || style == 10.0)) {
          style = lk == 2.0 ? 16.0 : lk == 3.0 ? 10.0 : lk == 4.0 ? 2.0 : lk == 5.0 ? 17.0 : 1.0;
          if (tone == 1.0) base = mix(base, srgb(vec3(0.16, 0.18, 0.21)), 0.75); // tinted glass, dark metal panels
          else if (tone == 2.0) base = mix(base, srgb(vec3(0.88, 0.87, 0.84)), 0.6); // white concrete, pale stone
        }
        float gf = front * 4.5, zf = z - gf; // the storefront is one tall ground floor; storeys count from its top
        // the punched window in its cell (lo, hi), the bay along the wall
        float bayP = bay > 0.0 ? bay : 3.0;
        vec2 wlo = wxf > 0.0 ? vec2(0.5 - 0.5 * wxf, 0.3) : vec2(0.28, 0.3), whi = vec2(wxf > 0.0 ? 0.5 + 0.5 * wxf : 0.78, wyf > 0.0 ? 0.3 + wyf : 0.84);
        if (wxf == 0.0 && use == 1.0) { float hw = 0.15 + 0.13 * hash(vec2(seed, 7.0)); wlo.x = 0.5 - hw; whi.x = 0.5 + hw; } // homes: each its own window width
        vec3 glassC = srgb(seed < 0.45 ? vec3(0.44, 0.62, 0.68) : seed < 0.65 ? vec3(0.42, 0.54, 0.66) : seed < 0.85 ? vec3(0.42, 0.60, 0.60) : vec3(0.32, 0.42, 0.54));
        if (style == 11.0) { // balconies (tile-worker.js): on every floor a slab front (0.4 m, the vertex colour) under a
          // railing (1.05 m: glass, or solid in the wall's colour with bit 32), open up to the next floor
          float g = mod(z, storey), side = abs(vWn.x);
          if (g > 1.45) discard;
          vec3 glassRail = ${RAIL_GLSL};
          diffuseColor.rgb = g < 0.4 ? base * (0.86 + 0.14 * side) : (front > 0.5 ? base * (0.78 / 1.05) : glassRail) * (0.9 + 0.1 * side);
          style = 0.0; z = 999.0; // no facade pattern, no contact shadow, no lit windows
        }
        if (style == 12.0) { // railings (tile-worker.js railings): u along, z over the deck; a handrail on top, two bars and
          // posts every 2 m, open between; never thinner than a pixel (no shimmer, they thicken as they go)
          float fu = fwidth(u), fz = fwidth(z), dp = min(fract(u / 2.0), 1.0 - fract(u / 2.0)) * 2.0, bar = max(0.02, fz * 0.6);
          if (dp > max(0.04, fu * 0.6) && z < 1.12 - fz && abs(z - 0.75) > bar && abs(z - 0.45) > bar) discard;
          style = 0.0; z = 999.0;
        }
        if (style == 18.0) { // seawall stone (tile-worker.js seawalls): u along, z the height; courses of 0.5 m, blocks of
          // 1.2 m staggered, each its own tone, and the dark band the tides leave along the foot
          vec2 g = vec2(u / 1.2 + 0.5 * floor(z / 0.5), z / 0.5), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
          float joint = 1.0 - box(f, vec2(0.04), vec2(0.96), fw), detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
          vec3 c = base * (0.88 + 0.22 * hash(floor(g) + seed * 17.0));
          c = mix(c, c * vec3(0.55, 0.6, 0.55), smoothstep(1.5, 0.9, z));
          diffuseColor.rgb = mix(mix(base, base * vec3(0.7, 0.74, 0.7), smoothstep(1.5, 0.9, z)), mix(c, base * 0.68, joint), detail);
          style = 0.0; z = 999.0;
        }
        vec3 roofGlow = vec3(0.0);
        float doorM = 0.0;
        if (style > 12.5) { // rooftops (tile-worker.js rooftop): 13 pool water, 14 solar panels, 15 a planted roof
          vec2 p = vWp.xz;
          if (style == 13.0) {
            diffuseColor.rgb = srgb(vec3(0.36, 0.74, 0.84)) * (0.85 + 0.3 * noise(p * 1.7));
            roofGlow = srgb(vec3(0.3, 0.8, 0.95)) * 0.35 * night; // lit from below at night
          } else if (style == 14.0) { // cells 1 m along the row, 1.2 m panels across it, between thin light frames
            vec2 g = vec2(u, z) / vec2(1.0, 0.6), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float frame = 1.0 - box(f, vec2(0.06), vec2(0.94), fw);
            diffuseColor.rgb = mix(base * (0.9 + 0.25 * f.y), base * 3.0, frame * clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0) * 0.6);
          } else { // beds of low planting and shrubs, darker clumps, gravel edges
            float n = fbm(p * 0.45), c = smoothstep(0.55, 0.62, noise(p * 0.9 + 7.0));
            diffuseColor.rgb = mix(base * (0.8 + 0.4 * n), base * vec3(0.7, 0.85, 0.65), c);
          }
          style = 0.0; z = 999.0;
        }
        if (style > 0.5) {
          vec3 pat, avg, col;
          if (style == 3.0) { // glass balcony towers (the 3D slabs come in close; this is the far look)
            vec2 g = vec2(u / 3.2, zf / storey), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            float slab = mix(0.36, 1.0 - smoothstep(0.36 - fw.y, 0.36 + fw.y, f.y), thin(0.36, fw.y));
            float mull = mix(0.04, 1.0 - smoothstep(0.04 - fw.x, 0.04 + fw.x, f.x), thin(0.04, fw.x));
            vec3 glass = glassC * (0.85 + 0.45 * mix(0.7, f.y, thin(0.5, fw.y)));
            pat = mix(mix(glass, base, mull), min(base * 1.12, vec3(1.0)), slab);
            avg = mix(glassC * 0.9, base * 1.1, 0.48);
            col = mix(avg, pat, detail);
          } else if (style == 9.0) { // glass condo tower: blue-green glass between thin white slab edges and mullions
            vec2 g = vec2(u / 1.5, zf / storey), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            float slab = mix(0.14, 1.0 - smoothstep(0.14 - fw.y, 0.14 + fw.y, f.y), thin(0.14, fw.y));
            float mull = mix(0.07, 1.0 - smoothstep(0.07 - fw.x, 0.07 + fw.x, f.x), thin(0.07, fw.x));
            vec3 cg = srgb(seed < 0.3 ? vec3(0.38, 0.54, 0.56) : seed < 0.55 ? vec3(0.42, 0.58, 0.62) : seed < 0.8 ? vec3(0.36, 0.50, 0.58) : vec3(0.46, 0.60, 0.58));
            vec3 glass = cg * (0.8 + 0.4 * mix(0.6, f.y, thin(0.5, fw.y)));
            pat = mix(mix(glass, base, mull), base, slab);
            avg = mix(cg * 0.95, base, 0.2);
            col = mix(avg, pat, detail);
          } else if (style == 2.0) { // curtain wall
            float mb = bay > 0.0 ? clamp(bay, 1.0, 3.2) : 1.6;
            vec2 g = vec2(u / mb, zf / storey), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            float ix = mix(0.87, smoothstep(0.13 - fw.x, 0.13 + fw.x, f.x), thin(0.13, fw.x));
            float iy = mix(0.74, smoothstep(0.26 - fw.y, 0.26 + fw.y, f.y), thin(0.26, fw.y));
            vec3 glass = glassC * (0.72 + 0.45 * mix(0.6, f.y, thin(0.5, fw.y)));
            pat = mix(base, glass, ix * iy);
            avg = mix(base, glassC * 0.95, 0.64);
            col = mix(avg, pat, detail);
          } else if (style == 10.0) { // window bands: tinted ribbon windows between concrete spandrels (1950s-80s)
            vec2 g = vec2(u / (bay > 0.0 ? clamp(bay, 1.0, 3.0) : 1.5), zf / storey), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            float win = band(f.y, wyf > 0.0 ? 0.9 - wyf : 0.38, 0.9, fw.y) * mix(0.9, smoothstep(0.06 - fw.x, 0.06 + fw.x, f.x), thin(0.06, fw.x));
            vec3 glass = srgb(vec3(0.30, 0.33, 0.36)) * (0.8 + 0.4 * f.y);
            pat = mix(base, glass, win);
            avg = mix(base, glass, 0.45);
            col = mix(avg, pat, detail);
          } else if (style == 6.0) { // ribbed metal cladding, roller doors at the foot
            float g = u / 0.9, fw = max(fwidth(g), 1e-4), detail = clamp(1.6 - 2.5 * fw, 0.0, 1.0);
            col = base * (1.0 - 0.1 * detail * (1.0 - smoothstep(0.0, 0.18 + fw, abs(fract(g) - 0.5) * 2.0 - 0.7)));
            vec2 d = vec2(u / 16.0, z / 4.6), dfw = max(fwidth(d), vec2(1e-4)), df = fract(d);
            float door = box(df, vec2(0.38, -1.0), vec2(0.66, 1.0), dfw) * step(z, 4.6) * step(0.5, hash(floor(d.xx) + seed));
            col = mix(col, srgb(vec3(0.5, 0.52, 0.54)) * (0.92 + 0.08 * step(0.5, fract(z / 0.45))), door);
          } else if (style == 7.0) { // big box: blank walls, a sign band, glass entrances
            vec2 e = vec2(u / 40.0, 0.0), efw = max(fwidth(e), vec2(1e-4));
            col = base * (1.0 - 0.18 * band(z, 4.2, 5.4, fwidth(z)));
            float ent = box(vec2(fract(e.x), z / 3.4), vec2(0.42, 0.0), vec2(0.58, 1.0), vec2(efw.x, fwidth(z / 3.4)));
            col = mix(col, glassC * 0.8, ent);
          } else if (style == 5.0) { // painted wood siding, white-trimmed windows
            vec2 g = vec2(u / 3.4, z / storey), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            float lap = z / 0.24, lfw = max(fwidth(lap), 1e-4);
            col = base * (1.0 - 0.09 * clamp(1.6 - 2.5 * lfw, 0.0, 1.0) * (1.0 - smoothstep(0.0, 0.25 + lfw, fract(lap))));
            float trim = box(f, vec2(0.25, 0.26), vec2(0.75, 0.84), fw), w = box(f, vec2(0.3, 0.32), vec2(0.7, 0.78), fw);
            vec3 glass = srgb(vec3(0.36, 0.46, 0.56)) * (0.8 + 0.35 * f.y);
            col = mix(mix(col, srgb(vec3(0.95, 0.94, 0.9)), trim * detail), glass, w * detail);
            col = mix(col, mix(base, srgb(vec3(0.95, 0.94, 0.9)), 0.12), 1.0 - detail);
          } else if (style == 8.0) { // Vancouver Special: brick ground storey, stucco above with wide windows
            float up = step(2.7, z);
            vec2 g = vec2(u / 4.2, (z - 2.7 * up) / mix(2.7, 2.8, up)), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            vec3 brick = srgb(vec3(0.62, 0.38, 0.30)) * (0.92 + 0.12 * hash(vec2(seed, 1.0)));
            vec3 wallc = mix(brick, base, up);
            float w = up > 0.5 ? box(f, vec2(0.14, 0.3), vec2(0.86, 0.8), fw) : box(f, vec2(0.32, 0.4), vec2(0.68, 0.78), fw);
            vec3 glass = srgb(vec3(0.38, 0.48, 0.58)) * (0.8 + 0.35 * f.y);
            col = mix(mix(wallc, glass, 0.2), mix(wallc, glass, w * 0.9), detail);
            if (doorW > 0.5 && up > 0.5 && mod(floor(u / 4.2) + 1.0, 64.0) < 2.5) { // the front balcony over the door: aluminium railing
              float rz = z - 2.75, pf = fwidth(u / 0.15), rdet = clamp(1.6 - 2.5 * pf, 0.0, 1.0), fz = fwidth(rz);
              float bars = max(band(rz, 0.94, 1.05, fz), band(rz, 0.0, 0.07, fz)), pick = mix(0.25, band(fract(u / 0.15), 0.0, 0.25, pf), rdet) * band(rz, 0.0, 1.05, fz);
              col = mix(col * mix(1.0, 0.7, band(rz, 0.0, 2.3, fz)), srgb(vec3(0.9, 0.9, 0.88)), max(bars, pick)); // (the balcony's shade behind it)
            }
          } else if (style == 20.0) { // a gable end: shingle courses, an attic window under the apex when it is tall enough
            float sh = z / 0.2, sfw = max(fwidth(sh), 1e-4), det = clamp(1.6 - 2.5 * sfw, 0.0, 1.0);
            col = base * (1.0 - 0.1 * det * (1.0 - smoothstep(0.0, 0.3 + sfw, fract(sh))));
            float aw = min(0.45, rise * 0.17), a0 = rise * 0.3, a1 = min(rise * 0.3 + 1.1, rise - 0.9);
            vec2 afw = vec2(fwidth(u), fwidth(z));
            float att = box(vec2(u, z), vec2(-aw, a0), vec2(aw, a1), afw), trim = box(vec2(u, z), vec2(-aw - 0.1, a0 - 0.1), vec2(aw + 0.1, a1 + 0.1), afw);
            if (rise > 1.6) col = mix(mix(col, srgb(vec3(0.95, 0.94, 0.9)), trim), srgb(vec3(0.36, 0.46, 0.56)) * (0.85 + 0.3 * (z - a0) / max(a1 - a0, 0.1)), att);
            z = 30.0; // (up at the eaves: no contact shadow)
          } else if (style == 16.0) { // vertical strips: glass from floor to floor between piers, darker over the slabs
            vec2 g = vec2(u / bayP, zf / storey), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0), sw = wxf > 0.0 ? wxf : 0.55;
            float strip = band(f.x, 0.5 - 0.5 * sw, 0.5 + 0.5 * sw, fw.x);
            vec3 glass = glassC * (0.78 + 0.35 * f.y) * (1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.12 + fw.y, f.y)));
            pat = mix(base, glass, strip);
            avg = mix(base, glassC * 0.9, sw);
            col = mix(avg, pat, detail);
          } else if (style == 17.0) { // a blank wall: panels and their joints
            vec2 g = vec2(u / 4.0, z / 1.5), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            col = base * (1.0 - 0.07 * detail * (1.0 - box(f, vec2(0.02), vec2(0.98), fw)));
          } else { // punched windows (1)
            vec2 g = vec2(u / bayP, zf / storey), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            vec3 glass = srgb(vec3(0.40, 0.52, 0.62)) * (0.8 + 0.35 * f.y);
            float w = box(f, wlo, whi, fw);
            pat = mix(base, glass, w * 0.9);
            avg = mix(base, glass, (whi.x - wlo.x) * (whi.y - wlo.y) * 0.9);
            col = mix(avg, pat, detail);
          }
          if (doorW > 0.5 && z < 2.4) { // the front door: a painted panel in a white frame, a small window high in it
            float db = style == 5.0 ? 3.4 : style == 8.0 ? 4.2 : bayP, dc = floor(u / db), fu = fract(u / db) * db - 0.5 * db;
            vec2 dfw = vec2(fwidth(u), fwidth(z));
            float frame = box(vec2(fu, z), vec2(-0.6, -1.0), vec2(0.6, 2.25), dfw) * step(abs(mod(dc + 0.5, 64.0) - 0.5), 0.1);
            float leaf = box(vec2(fu, z), vec2(-0.47, -1.0), vec2(0.47, 2.12), dfw), lite = box(vec2(fu, z), vec2(-0.3, 1.45), vec2(0.3, 1.95), dfw);
            float dh = hash(vec2(seed, 9.0));
            vec3 paint = srgb(dh < 0.2 ? vec3(0.45, 0.12, 0.1) : dh < 0.4 ? vec3(0.12, 0.18, 0.3) : dh < 0.55 ? vec3(0.1, 0.1, 0.1) : dh < 0.7 ? vec3(0.16, 0.3, 0.2) : dh < 0.85 ? vec3(0.42, 0.28, 0.16) : vec3(0.85, 0.84, 0.8));
            col = mix(col, mix(srgb(vec3(0.94, 0.93, 0.9)), mix(paint, srgb(vec3(0.3, 0.36, 0.42)), lite), leaf), frame);
            doorM = frame;
          }
          if (front > 0.5 && z < gf) { // storefronts: tall glass bays under a fascia
            vec2 sg = vec2(u / 2.6, z / gf), sfw = max(fwidth(sg), vec2(1e-4)), sf = fract(sg);
            float sdet = clamp(1.6 - 2.5 * max(sfw.x, sfw.y), 0.0, 1.0);
            vec3 shop = mix(srgb(vec3(0.16, 0.2, 0.24)), glassC * 0.9, box(sf, vec2(0.06, 0.05), vec2(0.94, 0.72), sfw));
            shop = mix(shop, min(base * 1.12, vec3(1.0)), step(0.8, sg.y));
            col = mix(mix(srgb(vec3(0.3, 0.38, 0.44)), base, 0.2), shop, sdet);
          }
          diffuseColor.rgb = col;
        }
        if (vUp > 0.9 && style < 0.5) diffuseColor.rgb *= 0.93 + 0.12 * noise(vWp.xz * 0.15); // weathered roofs (one octave: cheap)
        diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.0, 5.0, z)); // contact shadow at the foot of walls
        diffuseColor.rgb *= mix(0.84, 1.0, smoothstep(3.0, 30.0, z)); // and the urban canyon: less sky reaches the lower floors (after Slop Toronto)
        diffuseColor.rgb *= 1.0 - 0.18 * wet;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.9, 0.94), smoothstep(0.3, 0.7, snow) * smoothstep(0.55, 0.85, vUp)); // snow on roofs
        // lit windows at night, each exactly its pane as the pattern above draws it: homes the most in the evening, offices
        // few after hours, all fewer late at night (late), some buildings nearly dark; homes warm, a few cool white or TV
        // blue, offices fluorescent; most storefronts lit. Each window its own steady pick while a cell is over ~1 px; far
        // off, where cells shrink under the pixel, calm floor bands: each floor's window row lit to the building's share,
        // exactly filtered over the pixel (no blocks, no crawl)
        vec3 glow = vec3(0.0);
        if (night > 0.01 && style > 0.5 && style != 6.0 && style != 7.0 && style != 17.0 && style != 20.0 && z < 900.0) {
          bool shopF = front > 0.5 && z < gf;
          vec2 cellSz = vec2(bayP, storey), lo = wlo, hi = whi;
          if (shopF) { cellSz = vec2(2.6, gf); lo = vec2(0.06, 0.05); hi = vec2(0.94, 0.72); }
          else if (style == 2.0) { cellSz = vec2(bay > 0.0 ? clamp(bay, 1.0, 3.2) : 1.6, storey); lo = vec2(0.13, 0.26); hi = vec2(1.0); }
          else if (style == 16.0) { float sw = wxf > 0.0 ? wxf : 0.55; lo = vec2(0.5 - 0.5 * sw, 0.12); hi = vec2(0.5 + 0.5 * sw, 1.0); }
          else if (style == 9.0) { cellSz = vec2(1.5, storey); lo = vec2(0.07, 0.14); hi = vec2(1.0); }
          else if (style == 3.0) { cellSz = vec2(3.2, storey); lo = vec2(0.04, 0.36); hi = vec2(1.0); }
          else if (style == 10.0) { cellSz = vec2(bay > 0.0 ? clamp(bay, 1.0, 3.0) : 1.5, storey); lo = vec2(0.06, wyf > 0.0 ? 0.9 - wyf : 0.38); hi = vec2(1.0, 0.9); }
          else if (style == 5.0) { cellSz = vec2(3.4, storey); lo = vec2(0.3, 0.32); hi = vec2(0.7, 0.78); }
          else if (style == 8.0) { lo = vec2(0.2, 0.32); hi = vec2(0.8, 0.78); }
          vec2 g = vec2(u, shopF ? z : (style == 5.0 || style == 8.0 ? z : zf)) / cellSz, fw = max(fwidth(g), vec2(1e-4));
          float bh = hash(vec2(seed, 3.1)), m = max(fw.x, fw.y), far = smoothstep(0.75, 1.0, m); // (panes are exact up to a cell a pixel)
          #ifdef FAR
          far = 1.0;
          #endif
          float share = shopF ? mix(0.8, 0.3, late) : (use > 1.5 ? mix(0.24, 0.04, late) : use > 0.5 ? mix(0.34, 0.11, late) : mix(0.26, 0.08, late))
            * (bh < 0.12 ? 0.15 : 0.5 + bh) * (0.4 + 0.6 * night);
          vec3 lit = far < 1.0 ? panes(g, fw, lo, hi, share, seed, use, shopF) : vec3(0.0);
          if (far > 0.0) {
            vec3 avg = use > 1.5 && !shopF ? vec3(0.8, 0.82, 0.86) : vec3(0.97, 0.74, 0.46);
            lit = mix(lit, avg * share * 0.6 * (hi.x - lo.x) * bandCover(g.y - fw.y * 0.5, g.y + fw.y * 0.5, lo.y, hi.y), far);
          }
          glow = lit * night * 0.62 * step(1.0, z) * (1.0 - doorM);
        }
        // the lamps and the shop windows light the foot of the walls by them
        vec3 poolE = night > 0.01 && z < 6.0 ? diffuseColor.rgb * poolLight(vWp - vWn * 0.5) * (1.0 - smoothstep(0.0, 6.0, z)) * (1.0 - vUp) : vec3(0.0);
        glow += poolE + roofGlow;`)
    s.fragmentShader = s.fragmentShader
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += glow;')
      // the glow's strength rides in alpha, so the post pass can keep lit windows warm under a night grade
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a = 1.0 - max(min(1.0, dot(glow - poolE, vec3(0.5))), lightShare(poolE, gl_FragColor.rgb));')
  }
  m.customProgramCacheKey = () => (far ? 'building14f' : 'building14')
  return m
}

// ---------------------------------------------------------------- trees: billboards of the 3D forms
// shapes: treeforms.js
// colour families: 0 green, 1 yellow, 2 orange, 3 red, 4 brown, 5 dark conifer, 6 blue-green conifer, 7 forest green, 8 thin,
// 9 cherry, 10 cherry in blossom (tiles.js picks the season's)
const FAMILY = [ // muted, the way a canopy reads from above in late October
  [0x4e7a36, 0x56823a, 0x46702f, 0x5c8640, 0x648a42], [0xc4a23e, 0xb4983a, 0xccac4c, 0xa69238], [0xc47a32, 0xbc8836, 0xb06a2e, 0xcc9240],
  [0xa64c32, 0x963e32, 0xae5a36, 0x8c3c34], [0x8a6a3a, 0x7e6c3a, 0x967e46], [0x2e5034, 0x2a4c32, 0x345a3a, 0x24462e],
  [0x46685c, 0x3c6054, 0x4c7062], [0x3c602e, 0x446834, 0x32562a, 0x4c6e3a], [0x8a8a5a, 0x9a9060],
  [0xb85a3a, 0xc06a3c, 0xa84c36], [0xf0b4c6, 0xf4c4d2, 0xe6a6ba, 0xf8d4de], // 9 cherry (autumn), 10 cherry in blossom
].map((f) => f.map((h) => new THREE.Color(h)))
export { FAMILY }

// The billboards are pictures of the 3D trees' forms (treeforms.js), drawn once at startup and lit live by the scene's
// sun and sky the way the 3D trees are (Lambert, the same grade after), so the swap from one to the other doesn't
// show: one picture of each form as the map camera sees it (30° down), and ANGLES round each coarse form (what the 3D
// trees are past ~60 m) as a street-level camera sees it far off (4° down), picked and blended by how the camera sees
// each tree, turned and deepened as trees3d.js turns it. Two textures: `map` the face's normal (x right, y up, z towards
// the camera, upright) and coverage; `mat` the crown's shade (darker low in it and underneath), bark, and a dark rim
// like the ink outlines. frames[view * FORMS + form] (view 0 the map, 1 the street, alike at every angle): (half width
// per metre of crown, bottom, top, height) of the picture, in metres for a tree 1 m wide and ASPECT[form] tall, so the
// billboard covers just what the tree would; base[form]: where the coarse form's leaves start (share of its height).
const ANGLES = 8, C0 = 256, C1 = 128, PER = (FORMS * C0) / C1, TW = FORMS * C0, TH = C0 + Math.ceil((ANGLES * FORMS) / PER) * C1
export function treeAtlas(renderer) {
  const SS = 2, W = TW, H = TH, frames = new Float32Array(FORMS * 2 * 4), base = new Float32Array(FORMS)
  const rt = new THREE.WebGLRenderTarget(W * SS, H * SS) // drawn at twice the size, averaged down
  const mat = new THREE.ShaderMaterial({
    uniforms: { mode: { value: 0 }, right: { value: new THREE.Vector3() }, toward: { value: new THREE.Vector3() }, eye: { value: new THREE.Vector3() } },
    vertexShader: `attribute vec3 color; attribute float crown; varying vec3 vP; varying float vS, vB;
      void main() { vP = (modelMatrix * vec4(position, 1.0)).xyz; vS = mix(1.0, color.g, crown); vB = 1.0 - crown; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float mode; uniform vec3 right, toward, eye; varying vec3 vP; varying float vS, vB;
      void main() {
        vec3 n = normalize(cross(dFdx(vP), dFdy(vP))); // flat, as the 3D trees are shaded
        if (dot(n, eye) < 0.0) n = -n;
        gl_FragColor = mode < 0.5 ? vec4(vec3(dot(n, right), n.y, dot(n, toward)) * 0.5 + 0.5, 1.0) : vec4(vS, vB, 0.0, 1.0);
      }`,
  })
  const scene = new THREE.Scene(), mesh = new THREE.Mesh(undefined, mat), cam = new THREE.OrthographicCamera(), v = new THREE.Vector3(), U = mat.uniforms
  scene.add(mesh)
  // the views: [form, coarse, elevation°, azimuth, cell x, cell y, cell size]; the picture's frame is the same for all
  // of a form's street views (the widest), so blending two angles needs one quad
  const views = []
  for (let f = 0; f < FORMS; f++) {
    views.push([f, false, 30, 0, f * C0, 0, C0])
    for (let a = 0; a < ANGLES; a++) { const c = a * FORMS + f; views.push([f, true, 4, (a * 2 * Math.PI) / ANGLES, (c % PER) * C1, C0 + Math.floor(c / PER) * C1, C1]) }
  }
  const geos = Array.from({ length: FORMS * 2 }, (_, k) => treeForm(THREE, k >> 1, !!(k & 1)))
  for (let f = 0; f < FORMS; f++) { // frames, and where the coarse form's leaves start
    for (const st of [0, 1]) {
      const P = geos[f * 2 + st].attributes.position.array, A = ASPECT[f], e = ((st ? 4 : 30) * Math.PI) / 180, ce = Math.cos(e), se = Math.sin(e)
      let X = 0, y0 = Infinity, y1 = -Infinity
      for (const b of st ? Array.from({ length: ANGLES }, (_, a) => (a * 2 * Math.PI) / ANGLES) : [0]) {
        const cb = Math.cos(b), sb = Math.sin(b)
        for (let i = 0; i < P.length; i += 3) {
          const x = P[i] * cb - P[i + 2] * sb, z = P[i] * sb + P[i + 2] * cb, y = P[i + 1] * A * ce - z * se
          X = Math.max(X, Math.abs(x)); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
        }
      }
      const span = Math.max(2 * X, y1 - y0) * 1.08, bottom = y0 - span * 0.03
      frames.set([span / 2, bottom, bottom + span, A], (st * FORMS + f) * 4)
    }
    const g = geos[f * 2 + 1], P = g.attributes.position.array, Cr = g.attributes.crown.array
    let b0 = 1
    for (let i = 0; i < Cr.length; i++) if (Cr[i] > 0.5) b0 = Math.min(b0, P[i * 3 + 1])
    base[f] = Math.max(0.02, b0) // as trees3d.js finds it
  }
  const keep = { rt: renderer.getRenderTarget(), c: renderer.getClearColor(new THREE.Color()), a: renderer.getClearAlpha() }
  const px = [new Uint8Array(W * SS * H * SS * 4), null]
  for (const mode of [0, 1]) {
    U.mode.value = mode
    renderer.setRenderTarget(rt); renderer.setClearColor(0, 0); renderer.clear()
    for (const [f, coarse, deg, b, cx, cy, C] of views) {
      const st = coarse ? 1 : 0, fr = frames.subarray((st * FORMS + f) * 4), e = (deg * Math.PI) / 180, A = ASPECT[f]
      mesh.geometry = geos[f * 2 + st]; mesh.scale.set(1, A, 1)
      cam.left = -fr[0]; cam.right = fr[0]; cam.bottom = fr[1]; cam.top = fr[2]; cam.near = 0.1; cam.far = 100
      const sb = Math.sin(b), cb = Math.cos(b)
      cam.position.set(sb * Math.cos(e) * 50, Math.sin(e) * 50, cb * Math.cos(e) * 50); cam.up.set(0, 1, 0); cam.lookAt(v.set(0, 0, 0)); cam.updateProjectionMatrix()
      U.right.value.set(cb, 0, -sb); U.toward.value.set(sb, 0, cb); U.eye.value.copy(cam.position).normalize()
      rt.viewport.set(cx * SS, cy * SS, C * SS, C * SS); rt.scissor.copy(rt.viewport); rt.scissorTest = true
      renderer.setRenderTarget(rt); renderer.render(scene, cam)
    }
    if (mode) px[1] = new Uint8Array(W * SS * H * SS * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, W * SS, H * SS, px[mode])
  }
  renderer.setRenderTarget(keep.rt); renderer.setClearColor(keep.c, keep.a)
  rt.dispose(); mat.dispose(); for (const g of geos) g.dispose()
  // averaged down (weighted by coverage), then a rim out from the edge (2 px on the map's pictures, 1 on the street's)
  const a = new Float32Array(W * H), N = new Float32Array(W * H * 3), M = new Float32Array(W * H * 2)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sa = 0, n0 = 0, n1 = 0, n2 = 0, s = 0, k = 0
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const o = ((y * SS + j) * W * SS + x * SS + i) * 4, al = px[0][o + 3]
      sa += al; n0 += px[0][o] * al; n1 += px[0][o + 1] * al; n2 += px[0][o + 2] * al; s += px[1][o] * al; k += px[1][o + 1] * al
    }
    const p = y * W + x
    a[p] = sa / (255 * SS * SS)
    if (sa) { N[p * 3] = n0 / sa; N[p * 3 + 1] = n1 / sa; N[p * 3 + 2] = n2 / sa; M[p * 2] = s / sa; M[p * 2 + 1] = k / sa }
  }
  const outA = new Uint8Array(W * H * 4), outB = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, r2 = y < C0 ? 5 : 2
    let rim = 0
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (i * i + j * j <= r2 && y + j >= 0 && y + j < H && x + i >= 0 && x + i < W) rim = Math.max(rim, a[p + j * W + i])
    const ra = rim * 0.85 * (1 - a[p]), al = a[p] + ra, w = al > 0 ? a[p] / al : 0
    // empty and rim texels: a normal towards the camera, all rim (so the pictures' edges darken as they get small)
    outA[p * 4] = N[p * 3] * w + 128 * (1 - w); outA[p * 4 + 1] = N[p * 3 + 1] * w + 128 * (1 - w); outA[p * 4 + 2] = N[p * 3 + 2] * w + 255 * (1 - w); outA[p * 4 + 3] = al * 255
    outB[p * 4] = w ? M[p * 2] : 200; outB[p * 4 + 1] = M[p * 2 + 1] * w; outB[p * 4 + 2] = 255 * (1 - w); outB[p * 4 + 3] = 255
  }
  const tex = (d) => {
    const t = new THREE.DataTexture(d, W, H)
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4
    t.needsUpdate = true
    return t
  }
  const t = tex(outA)
  t.userData = { frames, base, mat: tex(outB) }
  return t
}

const BARK3 = (h) => new THREE.Color(h).toArray().map((x) => x.toFixed(4)).join(', ')
export function treeMaterial(atlas) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: atlas }, mat: { value: atlas.userData.mat }, frames: { value: atlas.userData.frames }, base: { value: atlas.userData.base },
      sat: { value: 1.0 }, gain: { value: new THREE.Vector3(1, 1, 1) }, tint: { value: new THREE.Vector3(1, 1, 1) }, desat: { value: 0 }, ...THREE.UniformsLib.fog,
      // the light (main.js keeps these the scene's): towards the sun, its colour times intensity; the sky's and ground's
      sunDir: { value: new THREE.Vector3(-0.55, 0.62, 0.56).normalize() }, sunCol: { value: new THREE.Color(0xfff1dc).multiplyScalar(2.3) },
      sky: { value: new THREE.Color(0xe8eef8).multiplyScalar(2) }, gnd: { value: new THREE.Color(0x8a8070).multiplyScalar(2) },
      // a perspective camera (city.view.useCamera): upright billboards (cyl = 1), and none within near3d.z - near3d.w metres
      // of (near3d.x, near3d.y) on the ground, where trees3d.js draws real trees; over the last near3d.w they fade in
      cyl: { value: 0 }, near3d: { value: new THREE.Vector4() },
      night, tLight: streetLight.map, lightBox: streetLight.box, lampTrees: { value: 0 }, // the street lamps light the crowns from below (close up)
      ...lookUniforms({}) },
    fog: true, // linear fog (a THREE.Fog on the scene) mixed in before the grade, like the rest of the map
    vertexShader: `attribute vec3 iPos; attribute vec2 iSize; attribute vec3 iCol; attribute float iVar; attribute float iClear;
      uniform float cyl; uniform vec4 near3d; uniform vec4 frames[${FORMS * 2}]; uniform float base[${FORMS}];
      varying vec2 vUv; flat varying vec3 vCol, vLamp; flat varying vec4 vCell, vPic, vBase; flat varying mat3 vM0, vM1; flat varying float vTrunk;
      uniform float night, lampTrees; ${LIGHT}
      #include <fog_pars_vertex>
      const float PI2 = 6.2831853;
      vec2 cell(float a, float form) { float c = a * ${FORMS}.0 + form; return vec2(mod(c, ${PER}.0) * ${C1}.0, ${C0}.0 + floor(c / ${PER}.0) * ${C1}.0) / vec2(${TW}.0, ${TH}.0); }
      // from a street picture's normals (angle a) to the world's, for a tree turned by (c, s) and stretched by (1, g, 1/k)
      mat3 frameOf(float a, float c, float s, float g, float k) {
        float b = a * PI2 / ${ANGLES}.0, cb = cos(b), sb = sin(b);
        vec2 r = vec2(cb, -sb / k), t = vec2(sb, cb / k);
        return mat3(vec3(c * r.x + s * r.y, 0.0, -s * r.x + c * r.y), vec3(0.0, g, 0.0), vec3(c * t.x + s * t.y, 0.0, -s * t.x + c * t.y));
      }
      void main() {
        float form = min(iVar, ${FORMS - 1}.0), w = iSize.x, h = iSize.y / 0.866;
        vec4 fr = frames[int((cyl > 0.5 ? ${FORMS}.0 : 0.0) + form)];
        vUv = vec2(position.x + 0.5, position.y);
        vCol = iCol;
        vLamp = night > 0.01 && lampTrees > 0.5 ? poolLight((modelMatrix * vec4(iPos, 1.0)).xyz) : vec3(0.0);
        vPic = vec4(fr.yzw, form);
        vTrunk = 0.032 / (2.0 * fr.x); // a trunk's half width, a share of the picture's
        vec2 q = vec2(position.x * 2.0 * fr.x * w, mix(fr.y, fr.z, position.y)); // the picture's corner, for a tree w wide and fr.w tall
        vec4 mv, fogMv;
        if (cyl > 0.5) { // standing up in the world, turned to the camera about the vertical
          vec3 p = (modelMatrix * vec4(iPos, 1.0)).xyz;
          float d = distance(p.xz, cameraPosition.xz), fade = near3d.w > 0.0 ? smoothstep(near3d.z - near3d.w, near3d.z, d) : 1.0;
          if (fade <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
          // as trees3d.js turns the tree (by a seed from where it stands) and deepens it (k), seen from the camera
          float v = iPos.x * 0.37 + iPos.z * 0.73, seed = sign(v) * mod(abs(v), 6.283), k = 0.88 + 0.24 * abs(sin(seed * 3.1));
          vec2 to = normalize(cameraPosition.xz - p.xz);
          float c = cos(seed), s = sin(seed);
          vec2 dl = vec2(c * to.x - s * to.y, s * to.x + c * to.y), du = normalize(vec2(dl.x, dl.y / k));
          float b = mod(atan(du.x, du.y) / PI2 * ${ANGLES}.0 + ${ANGLES}.0, ${ANGLES}.0), a0 = floor(b), a1 = mod(a0 + 1.0, ${ANGLES}.0);
          vCell = vec4(cell(a0, form), cell(a1, form));
          float g = fr.w * w / h;
          vM0 = frameOf(a0, c, s, g, k); vM1 = frameOf(a1, c, s, g, k);
          vBase = vec4(base[int(form)], max(iClear, base[int(form)]), smoothstep(0.25, 0.75, b - a0), fade); // the two nearest angles, blended halfway between
          vec3 wp = p + vec3(to.y, 0.0, -to.x) * q.x * sqrt(dl.y * dl.y + k * k * dl.x * dl.x) + vec3(0.0, q.y * h / fr.w, 0.0);
          // drawn nearer by its crown's depth, the same size on screen: in front of its own 3D tree as it fades in over it
          float D = distance(cameraPosition, p + vec3(0.0, 0.5 * h, 0.0)), off = min(0.6 * w * k, 0.5 * D);
          mv = viewMatrix * vec4(cameraPosition + (wp - cameraPosition) * ((D - off) / D), 1.0);
          fogMv = viewMatrix * vec4(wp, 1.0);
        } else { // the map camera: what shows of a tree 30° from above grows with its height and its crown's depth
          mv = modelViewMatrix * vec4(iPos, 1.0); fogMv = mv;
          mv.xy += vec2(q.x, q.y * (0.866 * h + 0.35 * w) / (0.866 * fr.w + 0.35));
          vec2 cell0 = vec2(form * ${C0}.0 / ${TW}.0, 0.0);
          vCell = vec4(cell0, cell0);
          vec3 r = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0])); // the camera's right, level
          vM0 = vM1 = mat3(r, vec3(0.0, 1.0, 0.0), vec3(-r.z, 0.0, r.x));
          vBase = vec4(0.0, 0.0, 0.0, 1.0);
        }
        gl_Position = projectionMatrix * mv;
        #ifdef USE_FOG
          vFogDepth = -fogMv.z;
        #endif
      }`,
    fragmentShader: `uniform sampler2D map, mat; uniform float sat, desat, cyl; uniform vec3 gain, tint, sunDir, sunCol, sky, gnd;
      varying vec2 vUv; flat varying vec3 vCol, vLamp; flat varying vec4 vCell, vPic, vBase; flat varying mat3 vM0, vM1; flat varying float vTrunk;
      #include <fog_pars_fragment>
      // Lambert under the hemisphere and the sun, as the 3D trees (no shadows), the rim darkened like an ink outline
      vec3 lit(vec4 n4, vec4 m, mat3 M) {
        vec3 n = normalize(M * (n4.xyz * 2.0 - 1.0));
        vec3 albedo = mix(vCol * m.r, vPic.w == 7.0 ? vec3(${BARK3(0x6e5a44)}) : vec3(${BARK3(0x4a3a2e)}), m.g); // a palm's bark (treeforms.js) or the rest's
        vec3 c = albedo * (mix(gnd, sky, 0.5 + 0.5 * n.y) + sunCol * max(dot(n, sunDir), 0.0)) * 0.3183099;
        return c * mix(vec3(1.0), vec3(0.16, 0.18, 0.22), m.b);
      }
      ${LOOK_GLSL}
      vec3 grade(vec3 cc, vec3 lit) { // as main.js's ink pass grades the scene, then the camera's look (look.js); lit: not graded
        cc = max(mix(vec3(dot(cc, vec3(0.2126, 0.7152, 0.0722))), cc, sat), 0.0) * gain;
        return tone(exposed(mix(cc, vec3(dot(cc, vec3(0.2126, 0.7152, 0.0722))), desat) * tint + lit));
      }
      void main() {
        vec2 uv = vUv;
        if (vBase.y > vBase.x) { // a pruned street tree (trees3d.js): its crown moved up, a bare trunk under it
          // (the crown's near rim shows a little below where it starts, seen 4° from above, and its outline 2 texels more)
          float y = mix(vPic.x, vPic.y, uv.y) / vPic.z, m = (0.035 + (vPic.y - vPic.x) * 2.5 / ${C1}.0) / vPic.z, b0 = vBase.x - m, b = vBase.y - m;
          if (y < b) {
            float fw = max(fwidth(uv.x), 1e-4), a = clamp((min(uv.x + fw * 0.5, 0.5 + vTrunk) - max(uv.x - fw * 0.5, 0.5 - vTrunk)) / fw, 0.0, 1.0) * vBase.w;
            if (a < 0.04 || y < 0.0) discard;
            vec3 cc = lit(vec4(0.5, 0.5, 1.0, 1.0), vec4(1.0, 1.0, 0.0, 1.0), vM0);
            #if defined(USE_FOG) && !defined(FOG_EXP2)
              cc = mix(cc, fogColor, smoothstep(fogNear, fogFar, vFogDepth));
            #endif
            gl_FragColor = vec4(grade(cc, vec3(0.0)), a);
            #include <colorspace_fragment>
            return;
          }
          uv.y = clamp((b0 + (y - b) * (1.0 - b0) / (1.0 - b)) * vPic.z - vPic.x, 0.0, vPic.y - vPic.x) / (vPic.y - vPic.x);
        }
        vec2 sz = cyl > 0.5 ? vec2(${C1 / TW}, ${C1 / TH}) : vec2(${C0 / TW}, ${C0 / TH}), u0 = vCell.xy + uv * sz, u1 = vCell.zw + uv * sz;
        vec4 n0 = texture2D(map, u0), n1 = texture2D(map, u1);
        float a0 = n0.a * (1.0 - vBase.z), a1 = n1.a * vBase.z, al = a0 + a1;
        if (al < 0.04) discard;
        vec3 cc = (lit(n0, texture2D(mat, u0), vM0) * a0 + lit(n1, texture2D(mat, u1), vM1) * a1) / al;
        #if defined(USE_FOG) && !defined(FOG_EXP2)
          cc = mix(cc, fogColor, smoothstep(fogNear, fogFar, vFogDepth));
        #endif
        gl_FragColor = vec4(grade(cc, vCol * vLamp * 0.5 * (1.0 - 0.6 * uv.y)), al * vBase.w); // lamp light from below, not graded
        #include <colorspace_fragment>
      }`,
    transparent: true,
  })
}
