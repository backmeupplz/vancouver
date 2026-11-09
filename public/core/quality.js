// Graphics quality. Two tiers: `high` (the full look) and `low` (weaker GPUs: fewer pixels, FXAA instead of MSAA, a smaller
// shadow map, no balconies, fewer 3D trees, less traffic and rain). The viewer picks Auto, High or Low (About → Graphics, kept
// in localStorage); Auto starts from what the GPU is (software, integrated Intel, most phone GPUs: low), drops to
// low when the map is still late at its lowest resolution and goes back up once frames are on time again (main.js). Plugins read
// city.quality.tier and hear city.on('quality', tier) when it changes.
const KEY = 'vancouver.graphics'
export const TIERS = {
  // pixelRatio: the most device pixels per CSS px; minRes: the adaptive resolution's floor (share of that; under 0.6 the
  // scene went soft and stair-stepped even with FXAA, and its frames were mostly late from tile uploads anyway, #557);
  // shadows: 'high' (4096 px, soft) | 'low' (2048 px, plain PCF) | 'off' (phones at most 'low'); aa: main.js setAA's mode ('auto': MSAA + FXAA | 'fxaa': FXAA only | 'msaa' | 'off');
  // ink: outlines 'full' | 'off'; trees3d, near: share of the radius of 3D trees and of the detailed cars, people and signals (life);
  // detail: balconies and rooftop plant up close; life, weather: share of cars/people and of rain drops;
  // cached: tiles kept off screen (detail, overview); view: the farthest a street-level view reaches (its fog's end, at
  // most), overview: how far the overview tiles show there (the base layer beyond); lights: the night lights' texture
  // size (main.js; above 1024 the lamp heads glow too); hdr: the scene in a half-float target (else 8-bit sRGB), bloom: the
  // selective bloom (core/look.js; needs hdr)
  high: { name: 'high', pixelRatio: 2, minRes: 0.7, shadows: 'high', aa: 'auto', ink: 'full', trees3d: 1, near: 1, detail: true, life: 1, weather: 1, cached: [80, 48], view: 24000, overview: 4000, lights: 2048, hdr: true, bloom: true },
  low: { name: 'low', pixelRatio: 1.25, minRes: 0.6, shadows: 'low', aa: 'fxaa', ink: 'full', trees3d: 0.6, near: 0.6, detail: false, life: 0.5, weather: 0.5, cached: [32, 20], view: 2400, overview: 1800, lights: 1024, hdr: false, bloom: false },
}

// a first guess from the GPU's name (WEBGL_debug_renderer_info; Firefox and Safari may only say "Apple GPU" etc.)
function guessTier(gl) {
  let name = ''
  try { name = gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) || '' } catch {}
  const weak = /swiftshader|llvmpipe|software|microsoft basic|intel|mali-[gt][0-9]{1,2}\b|mali-4|adreno \(tm\) [1-5]\d\d|adreno [1-5]\d\d|powervr|videocore/i
  return weak.test(name) || (navigator.deviceMemory && navigator.deviceMemory <= 4) ? 'low' : 'high'
}

export function createQuality(gl, apply) {
  let setting = 'auto'
  try { setting = localStorage.getItem(KEY) || 'auto' } catch {}
  if (!['auto', 'high', 'low'].includes(setting)) setting = 'auto'
  const guess = document.documentElement.classList.contains('embed') ? 'low' : guessTier(gl) // embeds (index.html): small, often on phones
  const q = {
    guess,
    get setting() { return setting },
    tier: TIERS[setting === 'auto' ? guess : setting],
    set(s) { // 'auto' | 'high' | 'low', from the menu
      setting = s
      try { localStorage.setItem(KEY, s) } catch {}
      use(s === 'auto' ? guess : s)
    },
    demote() { if (setting === 'auto' && q.tier.name !== 'low') { use('low'); return true } }, // Auto, too slow even so
    promote() { if (setting === 'auto' && q.tier.name !== guess) { use(guess); return true } }, // Auto, on time again
  }
  const use = (name) => { if (q.tier.name === name) return; q.tier = TIERS[name]; apply(q.tier) }
  return q
}
