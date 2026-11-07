// Shared materials for the streamed map. All surfaces are Lambert (so the sun, the shadows and the ink pass
// work) with their detail drawn procedurally in the fragment shader: crisp at any zoom, nothing to download.
import * as THREE from 'three'

const COMMON = `
  vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
  float fbm(vec2 p) { return noise(p) * 0.5 + noise(p * 2.03) * 0.25 + noise(p * 4.1) * 0.125 + noise(p * 8.3) * 0.0625; }
  // 1 inside [lo, hi], antialiased by the screen-space footprint fw
  float band(float x, float lo, float hi, float fw) { return smoothstep(lo - fw, lo + fw, x) * (1.0 - smoothstep(hi - fw, hi + fw, x)); }
`

// ---------------------------------------------------------------- ground
// class order matches tools/tiles.py GROUND
const GROUND_COLOURS = [
  [126, 160, 92], [122, 156, 88], [178, 174, 164], [168, 160, 146], [168, 176, 104], [112, 164, 74], [108, 174, 80], [112, 134, 82],
  [98, 130, 94], [56, 98, 54], [230, 214, 172], [152, 148, 142], [180, 162, 132], [150, 152, 154], [122, 125, 129], [204, 198, 186],
  [198, 172, 132], [100, 168, 72], [190, 102, 76], [40, 98, 150], [176, 150, 110], [96, 192, 222], [240, 244, 248],
  // 23 trail, walk, cycle, ballast, sidewalk, blvd, road, arterial (order = tools/tiles.py GROUND)
  [184, 164, 128], [206, 202, 194], [104, 108, 112], [140, 128, 114], [200, 198, 190], [108, 160, 76], [120, 123, 128], [104, 108, 115],
]
export function groundMaterial() {
  const m = new THREE.MeshLambertMaterial()
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float cls;\nflat varying float vCls;\nvarying vec3 vW;\nvarying float vSlope;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCls = cls;\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSlope = 1.0 - objectNormal.y;')
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nflat varying float vCls;\nvarying vec3 vW;\nvarying float vSlope;\n${COMMON}
        const vec3 CL[${GROUND_COLOURS.length}] = vec3[](${GROUND_COLOURS.map((c) => `vec3(${c.map((v) => (v / 255).toFixed(4)).join(',')})`).join(',')});`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        int c = int(vCls + 0.5);
        vec2 p = vW.xz;
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
        diffuseColor.rgb = col;`)
  }
  m.customProgramCacheKey = () => 'ground4'
  return m
}

// ---------------------------------------------------------------- roads
// decal = true: only the paint (lines, crosswalks, rails), blended onto the ground; else full bridge surfaces
export function roadMaterial(decal = false) {
  const m = new THREE.MeshLambertMaterial(decal ? { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 } : {})
  if (decal) m.defines = { DECAL: '' }
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aRoad;\nattribute vec4 aRoad2;\nvarying vec4 vR;\nvarying vec4 vR2;\nvarying vec3 vW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvR = aRoad; vR2 = aRoad2;\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec4 vR;\nvarying vec4 vR2;\nvarying vec3 vW;\n${COMMON}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float s = vR.x, t = vR.y, w = vR.z; int kind = int(vR.w + 0.5);
        float at = abs(t), fs = max(fwidth(s), 1e-3), ft = max(fwidth(t), 1e-3);
        float detail = 1.0 - smoothstep(0.25, 0.7, max(fs, ft)); // markings fade out before they shimmer
        vec3 col; float dPaint = 0.0; vec3 dCol = vec3(1.0);
        float grain = 0.94 + 0.08 * noise(vW.xz * 2.3) + 0.04 * noise(vW.xz * 0.2);
        if (kind == 101) { // bridge deck fascia and underside
          col = srgb(vec3(0.78, 0.77, 0.73)) * grain;
        } else if (kind == 100) { // sidewalks, kerbs, boulevards (under the carriageway)
          float blvd = floor(vR2.x / 256.0), walk = floor(mod(vR2.x, 256.0) / 16.0);
          float e = at - w * 0.5;
          vec3 concrete = srgb(vec3(0.80, 0.78, 0.74)) * grain, kerb = srgb(vec3(0.88, 0.87, 0.84)), grass = srgb(vec3(0.42, 0.62, 0.30)) * (0.92 + 0.12 * noise(vW.xz * 0.5));
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
        } else if (kind == 102) { // a mapped crosswalk: zebra bars across the walk
          col = srgb(vec3(0.94, 0.94, 0.9));
          dPaint = band(fract(s / 1.1), 0.0, 0.5, fs / 1.1) * step(at, w * 0.5 + 0.2); dCol = col;
        } else if (kind >= 9 && kind <= 13) { // footway, cycleway, path, steps, track
          col = kind == 10 ? srgb(vec3(0.40, 0.42, 0.44)) : kind == 11 || kind == 13 ? srgb(vec3(0.72, 0.64, 0.50)) : srgb(vec3(0.82, 0.80, 0.76));
          col *= grain;
          if (kind == 10) col = mix(col, srgb(vec3(0.95, 0.95, 0.9)), band(at, 0.0, 0.06, ft) * band(fract(s / 4.0), 0.0, 0.5, fs) * detail);
          if (kind == 12) col *= 1.0 - 0.18 * band(fract(s / 0.35), 0.0, 0.18, fs) * detail;
        } else { // carriageways, runways, taxiways
          float lanes = mod(vR2.x, 32.0), oneway = step(31.5, vR2.x);
          float dA = vR2.y, dB = vR2.z, len = vR2.w;
          col = srgb(kind <= 4 || kind >= 16 ? vec3(0.40, 0.42, 0.45) : vec3(0.47, 0.48, 0.50)) * grain;
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
        diffuseColor.rgb = col;
        #ifdef DECAL
          if (dPaint < 0.02) discard;
          diffuseColor = vec4(dCol, dPaint);
        #endif`)
  }
  m.customProgramCacheKey = () => (decal ? 'road2d' : 'road2')
  return m
}

// ---------------------------------------------------------------- buildings (facade styles; see tile-worker.js)
export const night = { value: 0 } // 0 day .. 1 night: lights a share of the windows (city.light.night)
export function buildingMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true })
  m.onBeforeCompile = (s) => {
    s.uniforms.night = night
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWin;\nvarying vec4 vWin;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWin = aWin;')
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vWin;
        ${COMMON}
        float thin(float width, float fw) { return smoothstep(0.6, 1.3, width / fw); }
        float box(vec2 f, vec2 lo, vec2 hi, vec2 fw) { vec2 a = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f)); return a.x * a.y; }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float style = vWin.x, seed = vWin.w, z = vWin.z;
        vec3 base = diffuseColor.rgb;
        vec3 glassC = srgb(seed < 0.45 ? vec3(0.42, 0.72, 0.78) : seed < 0.65 ? vec3(0.42, 0.60, 0.78) : seed < 0.85 ? vec3(0.40, 0.70, 0.66) : vec3(0.30, 0.46, 0.62));
        if (style > 0.5) {
          vec3 pat, avg;
          if (style > 2.5 && style < 3.5) { // balcony towers (the 3D slabs come in close; this is the far look)
            vec2 g = vec2(vWin.y / 3.2, z / 3.0), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            float slab = mix(0.36, 1.0 - smoothstep(0.36 - fw.y, 0.36 + fw.y, f.y), thin(0.36, fw.y));
            float mull = mix(0.04, 1.0 - smoothstep(0.04 - fw.x, 0.04 + fw.x, f.x), thin(0.04, fw.x));
            vec3 glass = glassC * (0.85 + 0.45 * mix(0.7, f.y, thin(0.5, fw.y)));
            pat = mix(mix(glass, base, mull), min(base * 1.12, vec3(1.0)), slab);
            avg = mix(glassC * 0.9, base * 1.1, 0.48);
            diffuseColor.rgb = mix(avg, pat, detail);
          } else if (style > 1.5 && style < 2.5) { // curtain wall
            vec2 g = vec2(vWin.y / 1.6, z / 3.4), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            float ix = mix(0.87, smoothstep(0.13 - fw.x, 0.13 + fw.x, f.x), thin(0.13, fw.x));
            float iy = mix(0.74, smoothstep(0.26 - fw.y, 0.26 + fw.y, f.y), thin(0.26, fw.y));
            vec3 glass = glassC * (0.72 + 0.45 * mix(0.6, f.y, thin(0.5, fw.y)));
            pat = mix(base, glass, ix * iy);
            avg = mix(base, glassC * 0.95, 0.64);
            diffuseColor.rgb = mix(avg, pat, detail);
          } else { // punched windows; style 4 adds a storefront
            vec2 g = vec2(vWin.y / 3.0, z / 3.2), fw = max(fwidth(g), vec2(1e-4)), f = fract(g);
            float detail = clamp(1.6 - 2.5 * max(fw.x, fw.y), 0.0, 1.0);
            vec3 glass = srgb(vec3(0.40, 0.52, 0.62)) * (0.8 + 0.35 * f.y);
            float w = box(f, vec2(0.28, 0.3), vec2(0.78, 0.84), fw);
            pat = mix(base, glass, w * 0.9);
            avg = mix(base, glass, 0.25 * 0.9);
            vec3 col = mix(avg, pat, detail);
            if (style > 3.5 && z < 4.2) {
              vec2 sg = vec2(vWin.y / 2.6, z / 4.2), sfw = max(fwidth(sg), vec2(1e-4)), sf = fract(sg);
              float sdet = clamp(1.6 - 2.5 * max(sfw.x, sfw.y), 0.0, 1.0);
              vec3 shop = mix(srgb(vec3(0.16, 0.2, 0.24)), glassC * 0.9, box(sf, vec2(0.06, 0.05), vec2(0.94, 0.72), sfw));
              shop = mix(shop, min(base * 1.12, vec3(1.0)), step(0.8, sf.y));
              col = mix(mix(srgb(vec3(0.3, 0.38, 0.44)), base, 0.2), shop, sdet);
            }
            diffuseColor.rgb = col;
          }
        }
        diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.0, 5.0, z)); // contact shadow at the foot of walls
        // lit windows at night: a seeded share of the window cells glows warm
        vec3 glow = vec3(0.0);
        if (night > 0.01 && style > 0.5 && z < 900.0) {
          vec2 cellSz = style > 1.5 && style < 2.5 ? vec2(1.6, 3.4) : style > 2.5 && style < 3.5 ? vec2(3.2, 3.0) : vec2(3.0, 3.2);
          vec2 g = vec2(vWin.y, z) / cellSz, cid = floor(g), f = fract(g), fw = max(fwidth(g), vec2(1e-4));
          float on = step(hash(cid + seed * 57.0), 0.18 + 0.5 * night * hash(vec2(seed, 3.1)));
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
  m.customProgramCacheKey = () => 'building2'
  return m
}

// ---------------------------------------------------------------- trees: painted billboards from a canvas atlas
// shapes (tools/tiles.py): 0 round, 1 columnar, 2 spreading, 3 weeping, 4 fir, 5 cedar, 6 pine, 7 palm
// colour families: 0 green, 1 yellow, 2 orange, 3 red, 4 brown, 5 dark conifer, 6 blue-green conifer, 7 forest green, 8 thin
const FAMILY = [
  [0x4f9a36, 0x3f8a2e, 0x5aa040, 0x478e3a, 0x6aac44], [0xd8b23a, 0xc9a227, 0xe0c048, 0xb8a434], [0xe07a26, 0xd98f22, 0xc96a24, 0xe89a3a],
  [0xb8452a, 0xa8342c, 0xc0502e, 0x9a2f36], [0x9a6a32, 0x8a7034, 0xa88a40], [0x2f5e3c, 0x2a5638, 0x376840, 0x244c30],
  [0x4a7464, 0x3e6a5c, 0x527c6c], [0x3a6a30, 0x447436, 0x2f5e2c, 0x4e7c3a], [0x8a8a5a, 0x9a9060],
].map((f) => f.map((h) => new THREE.Color(h)))
export { FAMILY }

export function treeAtlas() {
  const ATL = 256, atlas = document.createElement('canvas')
  atlas.width = ATL * 4; atlas.height = ATL * 2
  const g2 = atlas.getContext('2d'), RIM = 'rgba(16,24,14,0.85)', grey = (l) => `rgb(${255 * l},${255 * l},${255 * l})`
  const rnd = ((a) => () => { a = (a * 1664525 + 1013904223) % 4294967296; return a / 4294967296 })(7)
  const cell = (v) => [(v % 4) * ATL, Math.floor(v / 4) * ATL]
  const crown = (ox, oy, cx, cy, rx, ry, lobesN = 7, clumpsN = 70) => {
    const X = (x) => ox + x * ATL, Y = (y) => oy + y * ATL
    const lobes = []
    for (let i = 0; i < lobesN; i++) { const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()); lobes.push([cx + Math.cos(a) * d * rx * 0.55, cy + Math.sin(a) * d * ry * 0.55, Math.min(rx, ry) * (0.55 + rnd() * 0.2)]) }
    g2.fillStyle = RIM
    for (const [x, y, r] of lobes) { g2.beginPath(); g2.ellipse(X(x), Y(y), (r + 0.012) * ATL * rx / Math.min(rx, ry), (r + 0.012) * ATL * ry / Math.min(rx, ry), 0, 0, 7); g2.fill() }
    g2.save(); g2.beginPath()
    for (const [x, y, r] of lobes) { g2.moveTo(X(x) + r * ATL * rx / Math.min(rx, ry), Y(y)); g2.ellipse(X(x), Y(y), r * ATL * rx / Math.min(rx, ry), r * ATL * ry / Math.min(rx, ry), 0, 0, 7) }
    g2.clip()
    g2.fillStyle = grey(0.42); g2.fillRect(ox, oy, ATL, ATL)
    const cl = []
    for (let i = 0; i < clumpsN; i++) cl.push([cx - rx + rnd() * rx * 2, cy - ry + rnd() * ry * 2, 0.035 + rnd() * 0.045])
    cl.sort((a, b) => a[1] - b[1])
    for (const [x, y, r] of cl) {
      const light = Math.max(0.35, Math.min(1, 1.15 - (y - (cy - ry)) / (2 * ry) * 0.9 - (x - (cx - rx)) / (2 * rx) * 0.5))
      g2.fillStyle = grey(light * 0.62); g2.beginPath(); g2.arc(X(x + r * 0.15), Y(y + r * 0.2), r * ATL, 0, 7); g2.fill()
      g2.fillStyle = grey(light); g2.beginPath(); g2.arc(X(x), Y(y), r * 0.82 * ATL, 0, 7); g2.fill()
    }
    g2.restore()
  }
  const trunk = (ox, oy, top, w = 0.06) => { g2.fillStyle = '#4a3a2e'; g2.fillRect(ox + (0.5 - w / 2) * ATL, oy + top * ATL, w * ATL, (0.99 - top) * ATL) }
  const cone = (ox, oy, tiers, w0, w1, top, bottom, ragged) => {
    const X = (x) => ox + x * ATL, Y = (y) => oy + y * ATL
    for (const pass of [0, 1]) for (let i = 0; i < tiers; i++) {
      const f = i / (tiers - 1), y0 = top + (bottom - top) * f * 0.85, y1 = y0 + (bottom - top) / tiers * 2.2, w = w0 + (w1 - w0) * f + (ragged ? (rnd() - 0.5) * 0.04 : 0)
      const grow = pass ? 0 : 0.012
      if (pass) { const gr = g2.createLinearGradient(X(0.5 - w), 0, X(0.5 + w), 0), l = 1 - f * 0.25; gr.addColorStop(0, grey(0.95 * l)); gr.addColorStop(0.5, grey(0.7 * l)); gr.addColorStop(1, grey(0.42 * l)); g2.fillStyle = gr } else g2.fillStyle = RIM
      g2.beginPath(); g2.moveTo(X(0.5), Y(y0 - grow)); g2.lineTo(X(0.5 + w + grow), Y(y1 + grow * 0.5)); g2.lineTo(X(0.5 - w - grow), Y(y1 + grow * 0.5)); g2.closePath(); g2.fill()
    }
  }
  // 0 round, 1 columnar, 2 spreading, 3 weeping
  { const [ox, oy] = cell(0); trunk(ox, oy, 0.72); crown(ox, oy, 0.5, 0.42, 0.33, 0.3) }
  { const [ox, oy] = cell(1); trunk(ox, oy, 0.8, 0.05); crown(ox, oy, 0.5, 0.42, 0.18, 0.38, 6, 60) }
  { const [ox, oy] = cell(2); trunk(ox, oy, 0.68, 0.07); crown(ox, oy, 0.5, 0.42, 0.44, 0.24, 9, 90) }
  { const [ox, oy] = cell(3); trunk(ox, oy, 0.6); crown(ox, oy, 0.5, 0.5, 0.32, 0.36, 7, 70)
    const X = (x) => ox + x * ATL, Y = (y) => oy + y * ATL; g2.strokeStyle = 'rgba(20,30,16,0.35)'; g2.lineWidth = 2
    for (let i = 0; i < 14; i++) { const x = 0.25 + i * 0.036; g2.beginPath(); g2.moveTo(X(x), Y(0.4)); g2.quadraticCurveTo(X(x - 0.02), Y(0.65), X(x - 0.03), Y(0.86)); g2.stroke() } }
  // 4 fir, 5 cedar (broad, drooping), 6 pine (irregular), 7 palm
  { const [ox, oy] = cell(4); trunk(ox, oy, 0.88, 0.05); cone(ox, oy, 7, 0.04, 0.26, 0.03, 0.9, false) }
  { const [ox, oy] = cell(5); trunk(ox, oy, 0.9, 0.06); cone(ox, oy, 8, 0.06, 0.34, 0.05, 0.92, true) }
  { const [ox, oy] = cell(6); trunk(ox, oy, 0.55, 0.06); crown(ox, oy, 0.5, 0.3, 0.3, 0.22, 6, 50) }
  { const [ox, oy] = cell(7); const X = (x) => ox + x * ATL, Y = (y) => oy + y * ATL
    g2.strokeStyle = '#5a4636'; g2.lineWidth = 9; g2.beginPath(); g2.moveTo(X(0.5), Y(0.98)); g2.quadraticCurveTo(X(0.47), Y(0.6), X(0.52), Y(0.28)); g2.stroke()
    for (let i = 0; i < 9; i++) { const a = -Math.PI + (i / 8) * Math.PI; g2.fillStyle = RIM; g2.beginPath(); g2.ellipse(X(0.52 + Math.cos(a) * 0.17), Y(0.3 + Math.sin(a) * 0.06 + 0.06), 0.16 * ATL, 0.035 * ATL, a, 0, 7); g2.fill()
      g2.fillStyle = grey(0.85 - i * 0.03); g2.beginPath(); g2.ellipse(X(0.52 + Math.cos(a) * 0.17), Y(0.3 + Math.sin(a) * 0.06 + 0.06), 0.15 * ATL, 0.025 * ATL, a, 0, 7); g2.fill() } }
  const tex = new THREE.CanvasTexture(atlas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

export function treeMaterial(atlas) {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: atlas }, sat: { value: 1.0 }, gain: { value: new THREE.Vector3(1, 1, 1) }, tint: { value: new THREE.Vector3(1, 1, 1) }, desat: { value: 0 }, ...THREE.UniformsLib.fog },
    fog: true, // linear fog (a THREE.Fog on the scene) mixed in before the grade, like the rest of the map
    vertexShader: `attribute vec3 iPos; attribute vec2 iSize; attribute vec3 iCol; attribute float iVar;
      varying vec2 vUv; varying vec3 vCol;
      #include <fog_pars_vertex>
      void main() {
        float row = floor(iVar / 4.0);
        vUv = vec2((mod(iVar, 4.0) + uv.x) / 4.0, (uv.y + 1.0 - row) / 2.0);
        vCol = iCol;
        vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
        mv.xy += position.xy * iSize;
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
        vec3 cc = vCol * t.rgb * 1.3;
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
