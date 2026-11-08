// Shared materials for the streamed map. All surfaces are Lambert (so the sun, the shadows and the ink pass
// work) with their detail drawn procedurally in the fragment shader: crisp at any zoom, nothing to download.
import * as THREE from 'three'
import { NOISE_GLSL } from './util.js'
import { treeForm, FORMS, ASPECT } from './treeforms.js'

const COMMON = `
  vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
  ${NOISE_GLSL}
  float fbm(vec2 p) { return noise(p) * 0.5 + noise(p * 2.03) * 0.25 + noise(p * 4.1) * 0.125 + noise(p * 8.3) * 0.0625; }
  // 1 inside [lo, hi], antialiased by the screen-space footprint fw
  float band(float x, float lo, float hi, float fw) { return smoothstep(lo - fw, lo + fw, x) * (1.0 - smoothstep(hi - fw, hi + fw, x)); }
`

// Weather on the ground (city.surface): wet darkens paved and planted ground and gives it a sheen of the sky at
// grazing angles (puddles shine most); snow whitens flat ground, roofs and, less, the roads.
// seaHole (x, sea level, z, radius; radius 0 = off): the map's sea is left out within radius of (x, z) and below sea
// level + 3 m, where a plugin draws its own water (the sail plugin's waves)
export const surface = { wet: { value: 0 }, snow: { value: 0 }, sky: { value: new THREE.Color(0x8090a0) }, seaHole: { value: new THREE.Vector4() } }
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

// ---------------------------------------------------------------- ground
// class order matches tools/tiles.py GROUND
const GROUND_COLOURS = [ // stylized but true: greens by land cover (not neon), teal water, grey asphalt, light concrete walks
  [124, 150, 90], [122, 146, 90], [178, 174, 164], [168, 162, 150], [166, 166, 108], [110, 152, 78], [104, 160, 80], [110, 132, 84],
  [98, 128, 94], [60, 98, 58], [226, 212, 174], [154, 150, 144], [178, 162, 134], [146, 148, 150], [112, 115, 120], [196, 192, 182],
  [196, 172, 136], [98, 152, 72], [184, 102, 78], [52, 104, 128], [168, 148, 118], [92, 184, 206], [240, 244, 248],
  // 23 trail, walk, cycle, ballast, sidewalk, blvd, road, arterial (order = tools/tiles.py GROUND)
  [182, 164, 130], [196, 192, 184], [98, 102, 108], [132, 120, 108], [190, 188, 180], [106, 144, 76], [104, 107, 113], [96, 99, 106],
]
export function groundMaterial() {
  const m = new THREE.MeshLambertMaterial()
  m.onBeforeCompile = (s) => {
    surfUniforms(s)
    s.uniforms.seaHole = surface.seaHole
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float cls;\nflat varying float vCls;\nvarying vec3 vW;\nvarying float vSlope;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCls = cls;\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSlope = 1.0 - objectNormal.y;')
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nflat varying float vCls;\nvarying vec3 vW;\nvarying float vSlope;\nuniform vec4 seaHole;\n${COMMON}\n${SURF}
        const vec3 CL[${GROUND_COLOURS.length}] = vec3[](${GROUND_COLOURS.map((c) => `vec3(${c.map((v) => (v / 255).toFixed(4)).join(',')})`).join(',')});`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        int c = int(vCls + 0.5);
        vec2 p = vW.xz;
        if (c == 19 && seaHole.w > 0.0 && vW.y < seaHole.y + 3.0 && distance(p, seaHole.xz) < seaHole.w) discard;
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
          if (paved) sheen = wet * sheenAt(vW) * (0.35 + 0.65 * smoothstep(0.5, 0.7, fbm(p * 0.21 + 3.0)));
        }
        if (snow > 0.0 && c != 19) { // snow: lying on the flat, thinner on steep ground and where traffic runs
          float cover = smoothstep(0.25, 0.7, snow - 0.9 * sl + 0.35 * (n - 0.5)) * (c == 29 || c == 30 ? 0.45 : 1.0);
          col = mix(col, vec3(0.86, 0.89, 0.93) * (0.94 + 0.08 * fine), cover);
        }
        diffuseColor.rgb = col;`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += skyCol * sheen;')
  }
  m.customProgramCacheKey = () => 'ground5'
  return m
}

// ---------------------------------------------------------------- roads
// decal = true: only the paint (lines, crosswalks, rails), blended onto the ground; else full bridge surfaces
export function roadMaterial(decal = false) {
  const m = new THREE.MeshLambertMaterial(decal ? { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 } : {})
  if (decal) m.defines = { DECAL: '' }
  m.onBeforeCompile = (s) => {
    surfUniforms(s)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aRoad;\nattribute vec4 aRoad2;\nvarying vec4 vR;\nvarying vec4 vR2;\nvarying vec3 vW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvR = aRoad; vR2 = aRoad2;\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec4 vR;\nvarying vec4 vR2;\nvarying vec3 vW;\n${COMMON}\n${SURF}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float s = vR.x, t = vR.y, w = vR.z; int kind = int(vR.w + 0.5);
        float at = abs(t), fs = max(fwidth(s), 1e-3), ft = max(fwidth(t), 1e-3);
        float detail = 1.0 - smoothstep(0.25, 0.7, max(fs, ft)); // markings fade out before they shimmer
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
          float sleeper = band(fract(s / 0.65), 0.0, 0.35, fs) * band(at, 0.0, 1.3, ft);
          col = mix(col, srgb(vec3(0.42, 0.32, 0.24)), sleeper * detail);
          float rail = band(at, 0.66, 0.78, ft);
          col = mix(col, srgb(vec3(0.62, 0.62, 0.64)), rail);
          dPaint = max(sleeper * detail * 0.9, rail); dCol = rail > 0.5 ? srgb(vec3(0.62, 0.62, 0.64)) : srgb(vec3(0.42, 0.32, 0.24));
        } else if (kind == 102) { // a crosswalk, kerb to kerb (s): continental bars centred on the road, or two lines (vR2.x 1)
          col = srgb(vec3(0.94, 0.94, 0.9));
          dPaint = (vR2.x > 0.5 ? band(at, w * 0.5 - 0.3, w * 0.5, ft) : band(fract((s - 0.5 * vR2.w) / 1.1 + 0.25), 0.0, 0.5, fs / 1.1)) * band(s, 0.3, vR2.w - 0.3, fs); dCol = col;
        } else if (kind >= 9 && kind <= 13) { // footway, cycleway, path, steps, track
          col = kind == 10 ? srgb(vec3(0.40, 0.42, 0.44)) : kind == 11 || kind == 13 ? srgb(vec3(0.72, 0.64, 0.50)) : srgb(vec3(0.71, 0.70, 0.67));
          col *= grain;
          if (kind == 10) col = mix(col, srgb(vec3(0.95, 0.95, 0.9)), band(at, 0.0, 0.06, ft) * band(fract(s / 4.0), 0.0, 0.5, fs) * detail);
          if (kind == 12) col *= 1.0 - 0.18 * band(fract(s / 0.35), 0.0, 0.18, fs) * detail;
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
              float c2 = band(at, 0.08, 0.2, ft);
              paint = max(paint, c2); if (c2 > 0.0) pc = yellow;
              float k = (at) / lw, onLine = band(abs(fract(k) - 0.5), 0.5 - 0.09 / lw, 0.5, ft / lw) * step(1.0, k + 0.02) * step(k, lanes * 0.5 - 0.5);
              paint = max(paint, onLine * band(fract(s / 12.0), 0.0, 0.25, fs / 12.0));
            } else {
              float k = (t + w * 0.5) / lw, onLine = band(abs(fract(k) - 0.5), 0.5 - 0.09 / lw, 0.5, ft / lw) * step(0.98, k) * step(k, lanes - 0.98);
              paint = max(paint, onLine * band(fract(s / 12.0), 0.0, 0.25, fs / 12.0));
            }
            if (kind <= 1) paint = max(paint, band(at, w * 0.5 - 0.55, w * 0.5 - 0.4, ft)); // edge lines
            paint *= junctionFade;
          }
          if (kind <= 4) { // stop lines just outside junctions (crosswalks are mapped ones, drawn separately)
            for (int e = 0; e < 2; e++) {
              float d = e == 0 ? dA : dB;
              if (d > 20.0) continue;
              float stop = band(d, 5.0, 5.45, fs) * step(0.0, oneway > 0.5 ? 1.0 : (e == 0 ? -t : t)) * step(at, w * 0.5 - 0.3);
              paint = max(paint, stop);
            }
          }
          if (kind == 16) { // runway: centre dashes, edge lines, threshold piano keys
            paint = max(paint, band(at, 0.0, 0.45, ft) * band(fract(s / 60.0), 0.0, 0.5, fs / 60.0));
            paint = max(paint, band(at, w * 0.5 - 1.5, w * 0.5 - 0.6, ft));
            float th = min(s, len - s);
            paint = max(paint, band(th, 6.0, 36.0, fs) * band(abs(fract(t / 3.6) - 0.5), 0.0, 0.25, ft / 3.6) * step(at, w * 0.5 - 3.0));
          } else if (kind == 17) { // taxiway: yellow centre line
            float c2 = band(at, 0.0, 0.2, ft); paint = max(paint, c2); if (c2 > 0.0) pc = yellow;
          }
          col = mix(col, pc, paint * detail);
          dPaint = paint * detail; dCol = pc;
        }
        float sheen = 0.0;
        if (wet > 0.0) {
          col *= 1.0 - 0.4 * wet; dCol *= 1.0 - 0.25 * wet;
          sheen = wet * sheenAt(vW) * (0.4 + 0.6 * smoothstep(0.5, 0.7, fbm(vW.xz * 0.21 + 3.0)));
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
        #endif`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += skyCol * sheen;')
  }
  m.customProgramCacheKey = () => (decal ? 'road3d' : 'road3')
  return m
}

// ---------------------------------------------------------------- buildings (facade styles; see tile-worker.js)
export const night = { value: 0 } // 0 day .. 1 night: lights a share of the windows (city.light.night)
// glass balcony railings, one per building by its seed (the hex as the linear colour, as vertex colours are)
const RAIL_GLSL = [0xb8dce0, 0xc8e4e8, 0xa8ccd8, 0xd8e8ea, 0x98c0cc].map((h, i, a) => {
  const v = `vec3(${[h >> 16, (h >> 8) & 255, h & 255].map((c) => (c / 255).toFixed(4)).join(', ')})`
  return i < a.length - 1 ? `seed < ${((i + 1) / a.length).toFixed(2)} ? ${v} : ` : v
}).join('')
export function buildingMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true })
  m.onBeforeCompile = (s) => {
    s.uniforms.night = night
    s.uniforms.occluder = occluder
    surfUniforms(s)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWin;\nvarying vec4 vWin;\nvarying float vUp;\nvarying vec3 vWp, vWn;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWin = aWin;\nvWn = normalize(mat3(modelMatrix) * objectNormal);\nvUp = vWn.y;\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vWin;
        varying float vUp;
        varying vec3 vWp, vWn;
        ${COMMON}
        ${SURF}
        ${OCCLUDE}
        ${DISSOLVE}
        float thin(float width, float fw) { return smoothstep(0.6, 1.3, width / fw); }
        float box(vec2 f, vec2 lo, vec2 hi, vec2 fw) { vec2 a = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f)); return a.x * a.y; }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // a face across the line of sight to the player (an overhang, a skybridge); not walls alongside it
        if (occluder.w > 0.0) dissolve(vWp, occluded(vWp, 0.3) * step(0.35, abs(dot(vWn, normalize(occluder.xyz - cameraPosition)))));
        // vWin.x = pattern + (storey code + 32 * storefront) / 64 (tile-worker.js): window rows follow the real floors
        float style = floor(vWin.x + 1e-4), q = floor(fract(vWin.x + 1e-4) * 64.0 + 0.5);
        float front = step(31.5, q), fq = mod(q, 32.0), storey = fq > 0.5 ? 2.4 + fq * 0.15 : 3.2;
        float seed = vWin.w, z = vWin.z, u = vWin.y;
        float gf = front * 4.5, zf = z - gf; // the storefront is one tall ground floor; storeys count from its top
        vec3 base = diffuseColor.rgb;
        vec3 glassC = srgb(seed < 0.45 ? vec3(0.44, 0.62, 0.68) : seed < 0.65 ? vec3(0.42, 0.54, 0.66) : seed < 0.85 ? vec3(0.42, 0.60, 0.60) : vec3(0.32, 0.42, 0.54));
        if (style == 11.0) { // balconies (tile-worker.js): on every floor a slab front (0.4 m, the vertex colour) under a
          // railing (1.05 m: glass, or solid in the wall's colour with bit 32), open up to the next floor
          float g = mod(z, storey), side = abs(vWn.x);
          if (g > 1.45) discard;
          vec3 glassRail = ${RAIL_GLSL};
          diffuseColor.rgb = g < 0.4 ? base * (0.86 + 0.14 * side) : (front > 0.5 ? base * (0.78 / 1.05) : glassRail) * (0.9 + 0.1 * side);
          style = 0.0; z = 999.0; // no facade pattern, no contact shadow, no lit windows
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
            vec2 g = vec2(u / 1.6, zf / storey), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            float ix = mix(0.87, smoothstep(0.13 - fw.x, 0.13 + fw.x, f.x), thin(0.13, fw.x));
            float iy = mix(0.74, smoothstep(0.26 - fw.y, 0.26 + fw.y, f.y), thin(0.26, fw.y));
            vec3 glass = glassC * (0.72 + 0.45 * mix(0.6, f.y, thin(0.5, fw.y)));
            pat = mix(base, glass, ix * iy);
            avg = mix(base, glassC * 0.95, 0.64);
            col = mix(avg, pat, detail);
          } else if (style == 10.0) { // window bands: tinted ribbon windows between concrete spandrels (1950s-80s)
            vec2 g = vec2(u / 1.5, zf / storey), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            float win = band(f.y, 0.38, 0.9, fw.y) * mix(0.9, smoothstep(0.06 - fw.x, 0.06 + fw.x, f.x), thin(0.06, fw.x));
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
            vec2 g = vec2(u / mix(3.0, 4.2, up), (z - 2.7 * up) / mix(2.7, 2.8, up)), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            vec3 brick = srgb(vec3(0.62, 0.38, 0.30)) * (0.92 + 0.12 * hash(vec2(seed, 1.0)));
            vec3 wallc = mix(brick, base, up);
            float w = up > 0.5 ? box(f, vec2(0.14, 0.3), vec2(0.86, 0.8), fw) : box(f, vec2(0.32, 0.4), vec2(0.68, 0.78), fw);
            vec3 glass = srgb(vec3(0.38, 0.48, 0.58)) * (0.8 + 0.35 * f.y);
            col = mix(mix(wallc, glass, 0.2), mix(wallc, glass, w * 0.9), detail);
          } else { // punched windows (1)
            vec2 g = vec2(u / 3.0, zf / storey), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            vec3 glass = srgb(vec3(0.40, 0.52, 0.62)) * (0.8 + 0.35 * f.y);
            float w = box(f, vec2(0.28, 0.3), vec2(0.78, 0.84), fw);
            pat = mix(base, glass, w * 0.9);
            avg = mix(base, glass, 0.25 * 0.9);
            col = mix(avg, pat, detail);
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
        diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.0, 5.0, z)); // contact shadow at the foot of walls
        diffuseColor.rgb *= 1.0 - 0.18 * wet;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.9, 0.94), smoothstep(0.3, 0.7, snow) * smoothstep(0.55, 0.85, vUp)); // snow on roofs
        // lit windows at night: a seeded share of the window cells glows warm; most storefronts are lit
        vec3 glow = vec3(0.0);
        if (night > 0.01 && style > 0.5 && style != 6.0 && style != 7.0 && z < 900.0) {
          bool shopF = front > 0.5 && z < gf;
          vec2 cellSz = shopF ? vec2(2.6, gf) : style == 2.0 ? vec2(1.6, storey) : style == 9.0 ? vec2(1.5, storey) : style == 3.0 ? vec2(3.2, storey) : style == 5.0 ? vec2(3.4, storey) : vec2(3.0, storey);
          vec2 g = vec2(u, shopF ? z : (style == 5.0 || style == 8.0 ? z : zf)) / cellSz, cid = floor(g), f = fract(g), fw = max(fwidth(g), vec2(1e-4));
          float on = step(hash(cid + seed * 57.0), shopF ? 0.75 : 0.18 + 0.5 * night * hash(vec2(seed, 3.1)));
          float shape = mix(0.45, box(f, vec2(0.2, 0.3), vec2(0.8, 0.85), fw), clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0));
          vec3 warm = mix(vec3(1.0, 0.72, 0.38), vec3(0.85, 0.9, 1.0), step(0.8, hash(cid + 11.0)));
          glow = warm * on * shape * night * 1.3 * step(1.0, z);
        }`)
    s.fragmentShader = s.fragmentShader
      .replace('uniform vec3 emissive;', 'uniform vec3 emissive;\nuniform float night;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += glow;')
      // the glow's strength rides in alpha, so the post pass can keep lit windows warm under a night grade
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a = 1.0 - min(1.0, dot(glow, vec3(0.5)));')
  }
  m.customProgramCacheKey = () => 'building7'
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

// The billboards are pictures of the 3D trees' forms (treeforms.js), drawn once at startup: one row as the map camera
// sees them (30° down, lit by the map's sun), one as a street-level camera sees them far off (upright, a little from
// above). Red: the light on the surface (times ATL_GAIN), green: 1 on bark (drawn in BARK, not the crown colour), and a
// dark rim like the ink outlines. frames[row * FORMS + form]: (half width per metre of crown, bottom, top, height) of
// the picture, in metres for a tree 1 m wide and ASPECT[form] tall, so the billboard covers just what the tree would.
const ATL_GAIN = 1.6, ROWS = [30, 4]
export function treeAtlas(renderer) {
  const C = 256, SS = 2, W = FORMS * C, H = ROWS.length * C, frames = new Float32Array(FORMS * ROWS.length * 4)
  const rt = new THREE.WebGLRenderTarget(W * SS, H * SS) // drawn at twice the size, averaged down
  const mat = new THREE.ShaderMaterial({
    uniforms: { sun: { value: new THREE.Vector3(-0.55, 0.62, 0.56).normalize() } }, // main.js SUN
    vertexShader: `attribute vec3 color; attribute float crown; varying vec3 vN; varying float vS, vT;
      void main() { vN = normalize(mat3(modelMatrix) * normal); vS = mix(1.0, color.g, crown); vT = 1.0 - crown; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    // Lambert under main.js's hemisphere (sky 0xe8eef8, ground 0x8a8070, 2.0) and sun (2.3)
    fragmentShader: `uniform vec3 sun; varying vec3 vN; varying float vS, vT;
      void main() { vec3 n = normalize(vN); float l = (2.0 * mix(0.21, 0.86, 0.5 + 0.5 * n.y) + 2.3 * max(dot(n, sun), 0.0)) / 3.14159 * vS;
        gl_FragColor = vec4(l / ${ATL_GAIN.toFixed(2)}, vT, 0.0, 1.0); }`,
  })
  const scene = new THREE.Scene(), mesh = new THREE.Mesh(undefined, mat), cam = new THREE.OrthographicCamera(), v = new THREE.Vector3()
  scene.add(mesh)
  const keep = { rt: renderer.getRenderTarget(), c: renderer.getClearColor(new THREE.Color()), a: renderer.getClearAlpha() }
  renderer.setRenderTarget(rt); renderer.setClearColor(0, 0); renderer.clear()
  for (let f = 0; f < FORMS; f++) {
    const geo = treeForm(THREE, f), P = geo.attributes.position.array, A = ASPECT[f]
    mesh.geometry = geo; mesh.scale.set(1, A, 1)
    ROWS.forEach((deg, r) => {
      const e = (deg * Math.PI) / 180, ce = Math.cos(e), se = Math.sin(e)
      let X = 0, y0 = Infinity, y1 = -Infinity
      for (let i = 0; i < P.length; i += 3) { const y = P[i + 1] * A * ce - P[i + 2] * se; X = Math.max(X, Math.abs(P[i])); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
      const span = Math.max(2 * X, y1 - y0) * 1.08, bottom = y0 - span * 0.03
      cam.left = -span / 2; cam.right = span / 2; cam.bottom = bottom; cam.top = bottom + span; cam.near = 0.1; cam.far = 100
      cam.position.set(0, se * 50, ce * 50); cam.lookAt(v.set(0, 0, 0)); cam.updateProjectionMatrix()
      frames.set([span / 2, bottom, bottom + span, A], (r * FORMS + f) * 4)
      rt.viewport.set(f * C * SS, r * C * SS, C * SS, C * SS); rt.scissor.copy(rt.viewport); rt.scissorTest = true
      renderer.setRenderTarget(rt); renderer.render(scene, cam)
    })
    geo.dispose()
  }
  const big = new Uint8Array(W * SS * H * SS * 4)
  renderer.readRenderTargetPixels(rt, 0, 0, W * SS, H * SS, big)
  renderer.setRenderTarget(keep.rt); renderer.setClearColor(keep.c, keep.a)
  rt.dispose(); mat.dispose()
  // averaged down (colours weighted by coverage), then a rim 2 px out from the edge
  const a = new Float32Array(W * H), out = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sa = 0, sr = 0, sg = 0
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) { const o = ((y * SS + j) * W * SS + x * SS + i) * 4, al = big[o + 3]; sa += al; sr += big[o] * al; sg += big[o + 1] * al }
    const p = y * W + x
    a[p] = sa / (255 * SS * SS)
    if (sa) { out[p * 4] = sr / sa; out[p * 4 + 1] = sg / sa }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x
    let rim = 0
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (i * i + j * j <= 5 && y + j >= 0 && y + j < H && x + i >= 0 && x + i < W) rim = Math.max(rim, a[p + j * W + i])
    const ra = rim * 0.85 * (1 - a[p]), al = a[p] + ra
    if (al > 0) { out[p * 4] = (out[p * 4] * a[p] + 12 * ra) / al; out[p * 4 + 1] = (out[p * 4 + 1] * a[p]) / al }
    out[p * 4 + 3] = al * 255
  }
  const tex = new THREE.DataTexture(out, W, H)
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.anisotropy = 4
  tex.needsUpdate = true
  tex.userData.frames = frames
  return tex
}

export function treeMaterial(atlas) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: atlas }, frames: { value: atlas.userData.frames }, sat: { value: 1.0 }, gain: { value: new THREE.Vector3(1, 1, 1) }, tint: { value: new THREE.Vector3(1, 1, 1) }, desat: { value: 0 }, ...THREE.UniformsLib.fog,
      // a perspective camera (city.view.useCamera): upright billboards (cyl = 1), and none within near3d.z metres
      // of (near3d.x, near3d.y) on the ground, where trees3d.js draws real trees
      cyl: { value: 0 }, near3d: { value: new THREE.Vector3() } },
    fog: true, // linear fog (a THREE.Fog on the scene) mixed in before the grade, like the rest of the map
    vertexShader: `attribute vec3 iPos; attribute vec2 iSize; attribute vec3 iCol; attribute float iVar;
      uniform float cyl; uniform vec3 near3d; uniform vec4 frames[${FORMS * ROWS.length}];
      varying vec2 vUv; varying vec3 vCol;
      #include <fog_pars_vertex>
      void main() {
        float form = min(iVar, ${FORMS - 1}.0), row = cyl > 0.5 ? 1.0 : 0.0, w = iSize.x, h = iSize.y / 0.866;
        vec4 fr = frames[int(row * ${FORMS}.0 + form)];
        vUv = vec2((form + uv.x) / ${FORMS}.0, (row + uv.y) / ${ROWS.length}.0);
        vCol = iCol;
        vec2 q = vec2(position.x * 2.0 * fr.x * w, mix(fr.y, fr.z, position.y)); // the picture's corner, for a tree 1 m wide and fr.w tall
        vec4 mv;
        if (cyl > 0.5) { // standing up in the world, turned to the camera about the vertical
          vec3 p = (modelMatrix * vec4(iPos, 1.0)).xyz;
          if (distance(p.xz, near3d.xy) < near3d.z) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
          vec2 to = normalize(cameraPosition.xz - p.xz);
          p += vec3(to.y, 0.0, -to.x) * q.x + vec3(0.0, q.y * h / fr.w, 0.0);
          mv = viewMatrix * vec4(p, 1.0);
        } else { // the map camera: what shows of a tree 30° from above grows with its height and its crown's depth
          mv = modelViewMatrix * vec4(iPos, 1.0);
          mv.xy += vec2(q.x, q.y * (0.866 * h + 0.35 * w) / (0.866 * fr.w + 0.35));
        }
        gl_Position = projectionMatrix * mv;
        #ifdef USE_FOG
          vFogDepth = -mv.z;
        #endif
      }`,
    fragmentShader: `uniform sampler2D map; uniform float sat, desat; uniform vec3 gain, tint; varying vec2 vUv; varying vec3 vCol;
      #include <fog_pars_fragment>
      void main() {
        vec4 t = texture2D(map, vUv);
        if (t.a < 0.04) discard;
        vec3 cc = mix(vCol, vec3(${new THREE.Color(0x4a3a2e).toArray().map((x) => x.toFixed(4)).join(', ')}), t.g) * t.r * ${ATL_GAIN.toFixed(2)};
        #if defined(USE_FOG) && !defined(FOG_EXP2)
          cc = mix(cc, fogColor, smoothstep(fogNear, fogFar, vFogDepth));
        #endif
        cc = max(mix(vec3(dot(cc, vec3(0.2126, 0.7152, 0.0722))), cc, sat), 0.0) * gain;
        cc = mix(cc, vec3(dot(cc, vec3(0.2126, 0.7152, 0.0722))), desat) * tint;
        gl_FragColor = vec4(cc, t.a);
        #include <colorspace_fragment>
      }`,
    transparent: true,
  })
}
