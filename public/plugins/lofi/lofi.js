// Procedural lo-fi hip hop, generated live with the Web Audio API (no library, no audio files).
// `lofi(city?)` adds a small player pill (bottom-left; move it with --lofi-left / --lofi-bottom / --lofi-z
// on :root or override the .lofi class) and returns { dispose() }. The pill has a vibe menu; "Auto" follows
// the weather plugin (`city.weather` / 'weather' events) or, without one, the time of day in Vancouver.
// `renderOffline()` renders a track to an AudioBuffer, for testing.

const PLACES = ['Kitsilano', 'Gastown', 'Yaletown', 'Strathcona', 'Kerrisdale', 'Jericho', 'Lonsdale', 'Dunbar',
  'Fairview', 'Burrard', 'Cambie', 'Davie', 'Robson', 'Hastings', 'Granville', 'Chinatown', 'Marpole', 'Shaughnessy',
  'Steveston', 'Seawall', 'Kits', 'Lynn', 'Grouse', 'Cypress', 'Musqueam', 'Riley', 'Hornby', 'Main', 'Commercial', 'Deas']
const MOODS = ['Rain', 'Drizzle', 'Fog', 'Ferry', 'Lanterns', 'Puddles', 'Seabus', 'Tea', 'Windows', 'Sunday', 'Dusk',
  'Streetcar', 'Herons', 'Ravens', 'Umbrellas', 'Cedars', 'Steam', 'Moss', 'Neon', 'Skytrain', 'Morning', 'Afterglow',
  'Driftwood', 'Pages', 'Cocoa', 'Tides', 'Gulls', 'Mist', 'Blossoms', 'Bookshop', 'Sleepers', 'Harbour']

// Chord qualities as semitones above the chord root; 5+ note chords are voiced rootless (the bass has the root).
const Q = { M9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], d9: [0, 4, 7, 10, 14], m7: [0, 3, 7, 10], M7: [0, 4, 7, 11],
  m11: [0, 3, 7, 10, 14, 17], d13: [0, 4, 10, 14, 21], 69: [0, 4, 7, 9, 14] }
// Progressions: [degree in semitones above the key, quality].
const PROGS = [
  [[2, 'm9'], [7, 'd9'], [0, 'M9'], [9, 'm9']],
  [[0, 'M9'], [9, 'm9'], [2, 'm9'], [7, 'd13']],
  [[5, 'M9'], [4, 'm7'], [2, 'm9'], [0, 'M9']],
  [[9, 'm9'], [2, 'm9'], [7, 'd9'], [0, 'M9']],
  [[5, 'M9'], [4, 'm9'], [9, 'm9'], [7, 'd13']],
  [[4, 'm7'], [9, 'm9'], [2, 'm11'], [7, 'd13']],
  [[2, 'm11'], [2, 'm11'], [0, 'M9'], [0, 'M7']],
  [[0, 'M9'], [5, 'M9'], [4, 'm7'], [9, 'm9']],
]
const KICKS = [[0, 10], [0, 7, 10], [0, 3, 10], [0, 10, 13], [0, 6, 10], [0, 8, 10], [0, 3, 8, 10]]
const GHOSTS = [[7, 15], [15], [3, 11], [], [14]]
const COMPS = [[[0, 16]], [[0, 10], [10, 6]], [[0, 6], [6, 10]], [[0, 3], [3, 13]], [[0, 16]]] // [step, length]
const BASSES = [ // [step, semitones above root, length]
  [[0, 0, 7], [10, 0, 4], [14, 7, 2]],
  [[0, 0, 6], [6, 0, 2], [10, 7, 4], [14, 12, 2]],
  [[0, 0, 14]],
  [[0, 0, 4], [7, 0, 3], [10, 0, 6]],
  [[0, 0, 10], [10, 7, 6]],
]
const FORMS = [
  [['intro', 4], ['A', 16], ['B', 16], ['A', 16], ['outro', 4]],
  [['intro', 4], ['A', 8], ['B', 16], ['A', 16], ['B', 8], ['outro', 4]],
  [['intro', 2], ['A', 16], ['B', 8], ['A', 8], ['B', 16], ['outro', 4]],
]
const PENT = [0, 2, 4, 7, 9], MINPENT = [0, 3, 5, 7, 10]

// Vibes: parameter presets. Track-level fields shape the notes; `mix` sets the buses (crossfaded on a switch).
// hats: hi-hat step division per section [A, B] (1 = 16ths, 2 = 8ths, 4 = quarters); tone: master low-pass [A, B].
const CHILL = {
  label: 'Chill', icon: '☕', moods: MOODS, bpm: [70, 90], key: 48, scale: PENT, progs: PROGS, chordBars: [1, 2],
  comps: COMPS, basses: BASSES, bassLo: 36, kicks: KICKS, ghosts: GHOSTS, swing: [0.18, 0.36], lickP: [0.35, 0.8],
  hats: [2, 1], drums: 1, kit: 'tape', keys: 'ep', lift: 0, bark: 1, // lift: keys voicing range shift; bark: EP brightness
  mix: { tone: [6500, 8500], keysLP: 2400, trem: 0.18, drums: 0.42, drumsLP: 9000, verb: 0.7, crackle: 0.22, hiss: 0.02, rain: 0, bassLP: 420 },
}
const vibe = (o) => ({ ...CHILL, ...o, mix: { ...CHILL.mix, ...o.mix } })
export const VIBES = {
  chill: CHILL,
  rainy: vibe({
    label: 'Rainy day', icon: '🌧️', bpm: [64, 76], key: 45, scale: MINPENT, chordBars: [2],
    moods: ['Rain', 'Drizzle', 'Puddles', 'Umbrellas', 'Windows', 'Mist', 'Downpour', 'Gutters', 'Raincoats', 'Drops', 'Grey Skies', 'Wet Cedars'],
    progs: [ // minor key: i iv bVII bIII and friends, m9/m11 heavy
      [[0, 'm9'], [5, 'm9'], [10, 'd9'], [3, 'M9']],
      [[0, 'm11'], [8, 'M9'], [3, 'M9'], [10, 'd13']],
      [[0, 'm9'], [0, 'm11'], [5, 'm9'], [7, 'm7']],
      [[5, 'm9'], [10, 'd9'], [0, 'm11'], [0, 'm9']],
      [[8, 'M9'], [7, 'm7'], [5, 'm11'], [0, 'm11']],
    ],
    comps: [[[0, 16]], [[0, 10], [10, 6]], [[0, 6], [6, 10]]], lickP: [0.3, 0.6], hats: [2, 2], bark: 0.6,
    mix: { tone: [3800, 4600], keysLP: 1500, trem: 0.16, drums: 0.34, drumsLP: 5000, verb: 0.9, crackle: 0.34, hiss: 0.03, rain: 0.7, bassLP: 380 },
  }),
  sunny: vibe({
    label: 'Sunny afternoon', icon: '☀️', bpm: [84, 96], key: 50, chordBars: [1],
    moods: ['Sunshine', 'Blossoms', 'Seawall', 'Gulls', 'Picnic', 'Lemonade', 'Kites', 'Beach', 'Afternoon', 'Patio', 'Bikes', 'Sails'],
    progs: [
      [[0, 'M9'], [5, 'M9'], [0, '69'], [7, 'd9']],
      [[0, '69'], [9, 'm9'], [5, 'M9'], [7, 'd13']],
      [[5, 'M9'], [7, 'd9'], [0, 'M9'], [0, '69']],
      [[0, 'M9'], [2, 'm9'], [5, '69'], [7, 'd9']],
      [[5, 'M9'], [0, '69'], [5, 'M9'], [7, 'd13']],
    ],
    comps: [[[0, 10], [10, 6]], [[0, 6], [6, 10]], [[0, 3], [3, 13]], [[0, 3], [6, 4], [10, 6]]],
    kicks: [[0, 7, 10], [0, 3, 10], [0, 6, 10], [0, 3, 8, 10]], ghosts: [[7, 15], [3, 11], [14]],
    swing: [0.12, 0.26], lickP: [0.5, 0.9], hats: [1, 1], lift: 5, bark: 1.8,
    mix: { tone: [9000, 11000], keysLP: 3800, trem: 0.12, drums: 0.48, drumsLP: 12000, verb: 0.55, crackle: 0.16, hiss: 0.018, bassLP: 480 },
  }),
  late: vibe({
    label: 'Late night', icon: '🌙', bpm: [62, 72], key: 46, chordBars: [2],
    moods: ['Neon', 'Lanterns', 'Sleepers', 'Midnight', 'Skytrain', 'Streetlights', 'Night Bus', 'Moonlight', 'Insomnia', '2 AM', 'Taxis', 'Afterhours'],
    progs: [
      [[0, 'm11'], [0, 'm11'], [8, 'M9'], [8, 'M9']],
      [[9, 'm9'], [5, 'M9'], [9, 'm9'], [4, 'm7']],
      [[2, 'm11'], [2, 'm11'], [0, 'M9'], [0, 'M7']],
      [[0, 'm9'], [10, 'd9'], [8, 'M9'], [7, 'm7']],
    ],
    comps: [[[0, 16]], [[0, 10]]], basses: [[[0, 0, 14]], [[0, 0, 10], [10, 7, 6]]], bassLo: 32,
    kicks: [[0, 10], [0, 8]], ghosts: [[]], lickP: [0.15, 0.35], hats: [4, 2], lift: -2, bark: 0.5,
    mix: { tone: [4200, 5000], keysLP: 1700, trem: 0.2, drums: 0.2, drumsLP: 2400, verb: 1.4, crackle: 0.2, bassLP: 300 },
  }),
  jazz: vibe({
    label: 'Jazz café', icon: '🎷', bpm: [78, 92], key: 48, chordBars: [0.5, 1],
    moods: ['Bookshop', 'Espresso', 'Cocoa', 'Streetcar', 'Vinyl', 'Bistro', 'Brushes', 'Café', 'Records', 'Corner Booth', 'Latte', 'Saxophone'],
    progs: [ // ii-V turnarounds, a tritone sub, a long cycle
      [[2, 'm9'], [7, 'd13'], [0, 'M9'], [9, 'd9']],
      [[0, 'M9'], [9, 'd9'], [2, 'm9'], [7, 'd13']],
      [[4, 'm7'], [9, 'd9'], [2, 'm9'], [7, 'd13']],
      [[2, 'm9'], [1, 'd9'], [0, 'M9'], [0, '69']],
      [[5, 'M9'], [10, 'd9'], [4, 'm7'], [9, 'd9'], [2, 'm9'], [7, 'd13'], [0, 'M9'], [0, '69']],
    ],
    comps: [[[0, 6], [8, 6]], [[0, 3], [6, 2], [8, 3], [14, 2]], [[2, 4], [10, 4]]], basses: ['walk'],
    kicks: [[0, 10], [0, 8]], ghosts: [[7, 15], [3, 11]], swing: [0.3, 0.42], lickP: [0.45, 0.8], hats: [2, 2], kit: 'brush',
    mix: { tone: [7000, 8000], keysLP: 3000, trem: 0.06, drums: 0.42, drumsLP: 10000, verb: 0.8, crackle: 0.24, bassLP: 560 },
  }),
  study: vibe({
    label: 'Study', icon: '📚', bpm: [60, 72], key: 48, chordBars: [2],
    moods: ['Pages', 'Tea', 'Moss', 'Cedars', 'Tides', 'Library', 'Notes', 'Focus', 'Driftwood', 'Margins', 'Fog', 'Stillness'],
    progs: [[[2, 'm11'], [0, 'M9']], [[0, 'M9'], [5, 'M9']], [[9, 'm9'], [5, 'M9']], [[4, 'm7'], [9, 'm9'], [5, 'M9'], [0, 'M9']]],
    basses: [[[0, 0, 14]]], bassLo: 34, lickP: [0.1, 0.2], drums: 0, keys: 'pad',
    mix: { tone: [4800, 5600], keysLP: 1600, trem: 0.1, drums: 0, verb: 1.3, crackle: 0.14, hiss: 0.015, bassLP: 300 },
  }),
  snow: vibe({ // only reached through Auto: late-night calm, but major and warmer
    label: 'Snowfall', icon: '❄️', bpm: [64, 74], chordBars: [2],
    moods: ['Snow', 'Flurries', 'Frost', 'Cocoa', 'Firelight', 'Mittens', 'Snowfall', 'Quiet Streets', 'Wool', 'Icicles'],
    comps: [[[0, 16]], [[0, 10], [10, 6]]], basses: [[[0, 0, 14]], [[0, 0, 10], [10, 7, 6]]], bassLo: 33,
    kicks: [[0, 10], [0, 7, 10]], ghosts: [[], [15]], lickP: [0.25, 0.5], hats: [2, 2],
    mix: { tone: [5200, 6000], keysLP: 2100, trem: 0.14, drums: 0.26, drumsLP: 3500, verb: 1.2, crackle: 0.2, bassLP: 340 },
  }),
}
export const MENU = ['auto', 'chill', 'rainy', 'sunny', 'late', 'jazz', 'study']

// Auto: weather plugin first (see the event contract in the brief), else night/day in Vancouver.
export function autoVibe(w, date = new Date()) {
  if (w && w.kind) {
    if (/rain|drizzle|storm/.test(w.kind)) return 'rainy'
    if (w.kind === 'snow') return 'snow'
    if (w.isNight) return 'late'
    if (w.kind === 'fog') return 'study'
    if (w.kind === 'overcast' || w.kind === 'cloudy') return 'chill'
    return 'sunny'
  }
  const h = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', hour: 'numeric', hourCycle: 'h23' }).format(date)
  return h >= 21 || h < 6 ? 'late' : 'chill'
}

function rng(seed) { // mulberry32
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const mtof = (m) => 440 * 2 ** ((m - 69) / 12)

export function makeTrack(seed, vibeName = 'chill') {
  const V = VIBES[vibeName] || CHILL
  const r = rng(seed)
  const pick = (a) => a[Math.floor(r() * a.length)]
  const other = (a, x) => a[(a.indexOf(x) + 1) % a.length] // differs from x when a has 2+ entries
  const name = pick(PLACES) + ' ' + pick(V.moods)
  const bpm = V.bpm[0] + Math.floor(r() * (V.bpm[1] - V.bpm[0] + 1))
  const key = V.key + Math.floor(r() * 8)
  const progA = pick(V.progs)
  let progB = pick(V.progs)
  if (progB === progA) progB = other(V.progs, progA)
  const kickA = pick(V.kicks)
  let kickB = pick(V.kicks)
  if (kickB === kickA) kickB = other(V.kicks, kickA)
  const lick = () => { // a 2-bar pentatonic noodle, [step 0..31, midi, length]
    const notes = []
    let s = Math.floor(r() * 4) * 2, d = 3 + Math.floor(r() * 4)
    const n = 4 + Math.floor(r() * 4)
    while (notes.length < n && s < 30) {
      notes.push([s, key + 12 + V.scale[d % 5] + 12 * Math.floor(d / 5), 2])
      const gap = pick([2, 2, 3, 4, 1, 6])
      if (notes.length > 1) notes[notes.length - 2][2] = Math.max(2, s - notes[notes.length - 2][0])
      s += gap
      d = Math.min(11, Math.max(2, d + pick([-2, -1, -1, 1, 1, 2])))
    }
    notes[notes.length - 1][2] = 8
    return notes
  }
  const S = {
    intro: { name: 'intro', prog: progA },
    A: { name: 'A', prog: progA, kick: kickA, drums: V.drums, hats: V.hats[0], bass: 1, lick: lick(), lickP: V.lickP[0] },
    B: { name: 'B', prog: progB, kick: kickB, drums: V.drums, hats: V.hats[1], bass: 1, lick: lick(), lickP: V.lickP[1] },
    outro: { name: 'outro', prog: progA, kick: kickA, drums: V.drums * 0.5, hats: V.hats[0], bass: 1 },
  }
  const bars = []
  for (const [sec, n] of pick(FORMS)) for (let i = 0; i < n; i++) bars.push({ sec: S[sec], i, n })
  return {
    seed, vibe: vibeName, v: V, name, bpm, key, bars, r, sd: 60 / bpm / 4,
    swing: V.swing[0] + r() * (V.swing[1] - V.swing[0]), strum: 0.006 + r() * 0.014, chordBars: pick(V.chordBars),
    comp: pick(V.comps), bass: pick(V.basses), ghost: pick(V.ghosts),
  }
}

// The synth: a fixed graph of buses plus short-lived voices per note. Works on any BaseAudioContext.
function createEngine(ac, dest, onTrackEnd) {
  const sr = ac.sampleRate
  const G = (v, to) => { const g = ac.createGain(); g.gain.value = v; if (to) g.connect(to); return g }
  const F = (type, f, q, to) => { const n = ac.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; n.connect(to); return n }
  const O = (type, f, to) => { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; o.connect(to); return o }
  const buf = (ch, sec, fill) => {
    const b = ac.createBuffer(ch, Math.ceil(sec * sr), sr)
    for (let c = 0; c < ch; c++) fill(b.getChannelData(c))
    return b
  }
  const oscs = []
  const lfo = (f, depth, param) => { const g = G(depth, param); const o = O('sine', f, g); o.start(); oscs.push(o); return g }

  const noise = buf(1, 2, (d) => { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1 })

  // master: mix -> tape wow (modulated delay) -> low-pass -> soft clip -> volume
  const out = G(1, dest)
  const clip = ac.createWaveShaper()
  clip.curve = Float32Array.from({ length: 1025 }, (_, i) => 0.95 * Math.tanh(1.5 * (i / 512 - 1)) / Math.tanh(1.5))
  clip.connect(out)
  const tone = F('lowpass', 5200, 0.4, clip)
  const wow = ac.createDelay(0.05)
  wow.delayTime.value = 0.012
  wow.connect(tone)
  lfo(0.27, 0.0016, wow.delayTime) // wow, ~8 cents
  lfo(5.3, 0.00007, wow.delayTime) // flutter
  const mix = G(1, wow)
  const drumsLP = F('lowpass', 9000, 0.3, mix)
  const drums = G(0.42, drumsLP)
  const music = G(1, mix) // ducked by the kick
  const verb = ac.createConvolver() // short generated room
  verb.buffer = buf(2, 1.4, (d) => {
    let y = 0
    for (let i = 0; i < d.length; i++) { y += 0.3 * ((Math.random() * 2 - 1) - y); d[i] = y * (1 - i / d.length) ** 3 }
  })
  const verbRet = G(0.7, music)
  verb.connect(verbRet)
  const trem = G(0.82, music)
  const tremDepth = lfo(3.1, 0.18, trem.gain)
  const keysLP = F('lowpass', 2400, 0.6, trem)
  keysLP.connect(G(0.3, verb))
  const keys = G(1, keysLP)
  const bassLP = F('lowpass', 420, 0.7, music)
  const bass = G(1, bassLP)
  const lead = G(1, F('lowpass', 3200, 0.5, music))
  const echo = ac.createDelay(2)
  echo.connect(F('lowpass', 1800, 0.4, G(0.35, echo)))
  echo.connect(G(0.3, music))
  lead.connect(echo)
  lead.connect(G(0.4, verb))
  const snares = G(1, drums)
  snares.connect(G(0.25, verb))
  // vinyl: looped sparse clicks + hiss (+ rain on a rainy day), straight to the clipper (not filtered by sections)
  const vinyl = G(1, clip)
  const crackle = buf(1, 5, (d) => {
    for (let i = 0; i < d.length; i++) {
      if (Math.random() > 14 / sr) continue
      const a = (0.15 + 0.85 * Math.random() ** 3) * (Math.random() < 0.5 ? -1 : 1)
      for (let k = 0; k < 40 && i + k < d.length; k++) d[i + k] += a * Math.exp(-k / 6) * (k % 2 ? -0.6 : 1)
    }
  })
  const rain = buf(1, 6, (d) => { // soft wash (low-passed noise) + many tiny droplets
    let y = 0
    for (let i = 0; i < d.length; i++) {
      y += 0.08 * ((Math.random() * 2 - 1) - y)
      d[i] += y * 0.35
      if (Math.random() > 90 / sr) continue
      const a = 0.02 + 0.1 * Math.random() ** 2, f = 0.25 + Math.random() * 0.5
      for (let k = 0; k < 120 && i + k < d.length; k++) d[i + k] += a * Math.exp(-k / 25) * Math.sin(k * f)
    }
  })
  const crackleG = G(0.22, vinyl), hissG = G(0.02, vinyl), rainG = G(0, vinyl)
  const loops = [[crackle, F('highpass', 500, 0.7, crackleG)], [noise, F('bandpass', 5000, 0.3, hissG)],
    [rain, F('highpass', 250, 0.5, rainG)]]
  let loopsOn = false

  function ep(t, m, v, d, bus) { // electric piano: detuned sines, 1:1 FM bark that decays
    const f = mtof(m), g = G(0, bus), end = t + d + 0.8
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(v, t + 0.006)
    g.gain.setTargetAtTime(v * 0.35, t + 0.006, 0.7)
    g.gain.setTargetAtTime(0, t + d, 0.12)
    const a = O('sine', f, g), b = O('triangle', f, G(0.6, g))
    b.detune.value = 7
    const mg = G(0, a.frequency), mod = O('sine', f, mg)
    mg.gain.setValueAtTime(f * 1.4 * T.v.bark, t)
    mg.gain.setTargetAtTime(f * 0.3 * T.v.bark, t, 0.12)
    for (const o of [a, b, mod]) { o.start(t); o.stop(end) }
  }
  function pad(t, m, v, d, bus) { // slow swell of detuned triangles, long release
    const f = mtof(m), g = G(0, bus), end = t + d + 3
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(v, t + 1.2)
    g.gain.setTargetAtTime(0, t + d, 0.7)
    for (const dt of [-6, 6]) { const o = O('triangle', f, g); o.detune.value = dt; o.start(t); o.stop(end) }
  }
  function bassNote(t, m, v, d) {
    const f = mtof(m), g = G(0, bass)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(v, t + 0.012)
    g.gain.setTargetAtTime(v * 0.7, t + 0.02, 0.3)
    g.gain.setTargetAtTime(0, t + d, 0.06)
    const a = O('sine', f, g), b = O('triangle', f, G(0.3, g))
    for (const o of [a, b]) { o.start(t); o.stop(t + d + 0.5) }
  }
  function kick(t, v) {
    const g = G(0, drums), o = O('sine', 130, g)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(v, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
    o.frequency.setValueAtTime(130, t)
    o.frequency.exponentialRampToValueAtTime(46, t + 0.12)
    o.start(t)
    o.stop(t + 0.5)
    music.gain.setTargetAtTime(0.5, t, 0.008) // sidechain-ish duck
    music.gain.setTargetAtTime(1, t + 0.06, 0.14)
  }
  function hit(t, v, type, f, q, dec, bus, att = 0.002) { // filtered noise burst
    const s = ac.createBufferSource(), g = G(0, bus)
    s.buffer = noise
    s.connect(F(type, f, q, g))
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(v, t + att)
    g.gain.exponentialRampToValueAtTime(0.001, t + att + dec)
    s.start(t, Math.random() * 1.5)
    s.stop(t + att + dec + 0.02)
  }
  function tonal(t, v, f0, f1, dec, bus) {
    const g = G(0, bus), o = O('triangle', f0, g)
    g.gain.setValueAtTime(v, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dec)
    o.frequency.exponentialRampToValueAtTime(f1, t + dec)
    o.start(t)
    o.stop(t + dec + 0.02)
  }
  const KITS = {
    tape: {
      snare: (t, v) => { hit(t, v * 0.7, 'bandpass', 1900, 0.7, 0.18, snares); tonal(t, v * 0.5, 190, 160, 0.09, snares) },
      rim: (t, v) => { hit(t, v, 'bandpass', 3200, 3, 0.03, drums); tonal(t, v * 0.6, 900, 850, 0.03, drums) },
      hat: (t, v, open) => hit(t, v, 'highpass', 6500, 0.5, open ? 0.3 : 0.045, drums),
    },
    brush: { // slow-attack noise swishes instead of sticks
      snare: (t, v) => hit(t, v * 0.55, 'bandpass', 2600, 0.5, 0.24, snares, 0.025),
      rim: (t, v) => hit(t, v * 0.8, 'bandpass', 2200, 0.6, 0.08, drums, 0.012),
      hat: (t, v) => hit(t, v * 0.7, 'bandpass', 5200, 0.7, 0.1, drums, 0.018),
    },
  }

  const voice = (key, [root, q]) => Q[q].slice(Q[q].length > 4 ? 1 : 0).map((iv) => {
    let m = key + root + iv
    while (m < 52 + T.v.lift) m += 12
    while (m > 71 + T.v.lift) m -= 12
    return m
  }).sort((a, b) => a - b)

  let T, bar, st, next, pending, lickOn = false
  function sectionStart(S, t, dur) {
    const f = tone.frequency, [toneA, toneB] = T.v.mix.tone
    if (S.name === 'intro') {
      mix.gain.setValueAtTime(1, t)
      f.setValueAtTime(500, t)
      f.setTargetAtTime(toneA, t, dur / 3)
    } else if (S.name === 'outro') {
      f.setTargetAtTime(600, t, dur / 3)
      mix.gain.setTargetAtTime(0, t + dur * 0.4, dur / 6)
    } else f.setTargetAtTime(S.name === 'B' ? toneB : toneA, t, 0.4)
  }
  function step(t) {
    const b = T.bars[bar], S = b.sec, s = st, sd = T.sd, r = T.r
    const ts = t + (s % 2 ? T.swing * sd : 0), hum = () => ts + (r() - 0.5) * 0.008
    if (s === 0) {
      if (b.i === 0) sectionStart(S, t, b.n * 16 * sd)
      if (b.i % 4 === 2) lickOn = !!S.lick && r() < S.lickP
      if (b.i % 4 < 2) lickOn = false
    }
    const span = 16 * T.chordBars, at = b.i * 16 + s // chord length and position within the section, in steps
    const chordAt = (p) => S.prog[Math.floor(p / span) % S.prog.length]
    const chord = chordAt(at)
    if (T.v.keys === 'pad') {
      if (at % span === 0) voice(T.key, chord).forEach((m) => pad(t, m, 0.045, span * sd - 0.05, keys))
    } else {
      for (const [cs, cd] of T.comp) {
        if (cs === s) voice(T.key, chord).forEach((m, k) => ep(ts + k * T.strum + r() * 0.006, m, 0.08 + r() * 0.03, cd * sd - 0.03, keys))
      }
    }
    if (S.bass) {
      const lo = T.v.bassLo, rootOf = (c) => { const m = ((T.key + c[0]) % 12) + lo; return m > lo + 9 ? m - 12 : m }
      const root = rootOf(chord)
      if (T.bass === 'walk') { // quarter-note walk: root, chord tones, then a step into the next chord
        if (s % 4 === 0) {
          const nx = chordAt(at + 4)
          const m = nx !== chord ? rootOf(nx) + (r() < 0.6 ? -1 : 1)
            : at % span === 0 ? root : root + [Q[chord[1]][1], 7, Q[chord[1]][3]][Math.floor(r() * 3)]
          bassNote(hum(), m, 0.12, 4 * sd * 0.85)
        }
      } else for (const [bs, iv, bd] of T.bass) if (bs === s) bassNote(hum(), root + iv, 0.13, bd * sd - 0.02)
    }
    const brk = b.i === b.n - 1 && S.name !== 'outro' // last bar of a section: drop the kick, half the hats
    if (S.drums && b.i < b.n * S.drums) {
      const kit = KITS[T.v.kit]
      if (S.kick.includes(s) && !(brk && s > 0)) kick(hum(), T.v.kit === 'brush' ? 0.42 : 0.55)
      if (s === 4 || s === 12) kit.snare(hum(), 0.5 + r() * 0.1)
      else if (T.ghost.includes(s) && r() < 0.6) kit.rim(hum(), 0.12)
      if (s % S.hats === 0 && !(brk && s >= 8)) {
        kit.hat(hum(), (s % 4 === 0 ? 0.3 : s % 2 === 0 ? 0.2 : 0.09) * (0.8 + r() * 0.4), S.hats === 1 && s === 14 && b.i % 2 === 1)
      }
    }
    if (lickOn && b.i % 4 >= 2) {
      const ls = (b.i % 4 - 2) * 16 + s
      for (const [n, m, d] of S.lick) if (n === ls) ep(hum(), m, 0.09, d * sd, lead)
    }
  }
  function start(track, t, from = 0) {
    T = track
    bar = from
    st = 0
    next = t
    const first = !loopsOn, p = T.v.mix
    const set = (param, v) => (first ? param.setValueAtTime(v, t) : param.setTargetAtTime(v, t, 0.6))
    set(echo.delayTime, T.sd * 3) // dotted eighth (glides on a change: tape-like, no click)
    for (const [param, v] of [[keysLP.frequency, p.keysLP], [tremDepth.gain, p.trem], [drums.gain, p.drums],
      [drumsLP.frequency, p.drumsLP], [verbRet.gain, p.verb], [crackleG.gain, p.crackle], [hissG.gain, p.hiss],
      [rainG.gain, p.rain], [bassLP.frequency, p.bassLP]]) set(param, v)
    if (from) { // joining mid-track (vibe change): undo a pending outro fade, glide to the new brightness
      mix.gain.cancelScheduledValues(t)
      mix.gain.setTargetAtTime(1, t, 0.3)
      tone.frequency.cancelScheduledValues(t)
    }
    if (!loopsOn) {
      loopsOn = true
      for (const [b, to] of loops) {
        const s = ac.createBufferSource()
        s.buffer = b
        s.loop = true
        s.connect(to)
        s.start(t)
        oscs.push(s)
      }
    }
  }
  return {
    out,
    start,
    track: () => T,
    tick(until) { // schedule every 16th note that starts before `until`
      while (next < until) {
        if (pending && st === 0) { // vibe change lands on the next bar line, skipping the new track's intro
          start(pending, next, Math.max(0, pending.bars.findIndex((b) => b.sec.name !== 'intro')))
          pending = null
        }
        if (bar >= T.bars.length) start(onTrackEnd(T), next)
        step(next)
        next += T.sd
        if (++st === 16) { st = 0; bar++ }
      }
    },
    change(track) { pending = track }, // switch at the next bar, no fade
    skip(track) { // fade the current track out quickly and start another
      const now = ac.currentTime
      pending = null
      for (const p of [mix.gain, tone.frequency]) p.cancelScheduledValues(now)
      mix.gain.setTargetAtTime(0, now, 0.04)
      start(track, Math.max(now + 0.25, next))
    },
  }
}

const newSeed = () => (Math.random() * 2 ** 32) >>> 0

// `then: [vibe, seconds]` switches vibe mid-render, like picking one in the menu.
export async function renderOffline(seconds = 20, seed = 1, rate = 44100, vibe = 'chill', then) {
  const ac = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate)
  const e = createEngine(ac, ac.destination, (t) => makeTrack(t.seed + 1, t.vibe))
  e.start(makeTrack(seed, vibe), 0.05)
  if (then) {
    e.tick(then[1])
    e.change(makeTrack(seed + 1, then[0]))
  }
  e.tick(seconds)
  return ac.startRendering()
}

const CSS = `
.lofi{position:fixed;left:var(--lofi-left,12px);bottom:var(--lofi-bottom,56px);z-index:var(--lofi-z,20);display:flex;align-items:center;gap:2px;box-sizing:border-box;max-width:calc(100vw - 24px);padding:4px 10px 4px 4px;background:rgba(11,16,22,.72);color:#cfd8e0;font:12px/1.2 system-ui,-apple-system,sans-serif;border-radius:8px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);user-select:none;-webkit-user-select:none}
.lofi button{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:none;color:inherit;font:inherit;cursor:pointer}
.lofi button:hover{background:rgba(207,216,224,.1)}
.lofi button:focus-visible,.lofi input:focus-visible{outline:2px solid #cfd8e0;outline-offset:1px}
.lofi svg{width:14px;height:14px;fill:currentColor}
.lofi canvas{display:block;flex:none;width:28px;height:14px;margin:0 4px}
.lofi-name{flex:1 1 auto;min-width:0;max-width:15em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lofi input{flex:none;width:64px;margin:0 0 0 8px;accent-color:#cfd8e0}
.lofi .lofi-vibe{position:relative;font-size:15px;line-height:1}
.lofi-vibe.auto::after{content:'';position:absolute;right:3px;bottom:3px;width:5px;height:5px;border-radius:50%;background:#8fd0ff}
.lofi-menu{position:absolute;left:0;bottom:calc(100% + 6px);display:flex;flex-direction:column;gap:1px;box-sizing:border-box;min-width:196px;max-width:calc(100vw - 24px);padding:4px;background:rgba(11,16,22,.92);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3)}
.lofi-menu[hidden]{display:none}
.lofi .lofi-menu button{display:flex;align-items:center;gap:8px;width:auto;height:30px;padding:0 10px 0 6px;text-align:left;white-space:nowrap}
.lofi-menu button[aria-checked=true]{background:rgba(207,216,224,.16)}
.lofi-menu i{font-style:normal;width:1.5em;text-align:center;font-size:14px}
.lofi-menu small{margin-left:auto;padding-left:10px;opacity:.65}
.compact .lofi{padding:0 12px 0 0;border-radius:12px;border:1px solid rgba(255,255,255,.12)}
.compact .lofi button{width:44px;height:44px;border-radius:11px}
.compact .lofi svg{width:16px;height:16px}
.compact .lofi .lofi-vibe{font-size:18px}
.compact .lofi input{display:none}
.compact .lofi-name{max-width:11em}
.compact .lofi .lofi-menu button{height:44px;padding:0 14px 0 8px;font-size:14px}
.compact .lofi-menu{max-height:calc(100vh - 140px);overflow-y:auto}
@media (orientation:landscape){.compact .lofi-menu:not([hidden]){display:grid;grid-template-columns:1fr 1fr;min-width:340px}}
`
const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>',
  next: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5v11l7.5-5.5zM10.5 2.5h3v11h-3z"/></svg>',
}

export default function lofi(city) {
  const store = {
    get(k) { try { return localStorage.getItem(k) } catch { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch {} },
  }
  let vol = parseFloat(store.get('lofi:vol'))
  if (!(vol >= 0 && vol <= 1)) vol = 0.6
  let choice = store.get('lofi:vibe')
  if (!MENU.includes(choice)) choice = 'chill'
  const current = () => (choice === 'auto' ? autoVibe(city && city.weather) : choice)
  let track = makeTrack(newSeed(), current()), ac, engine, analyser, timer, vizTimer, playing = false

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  const el = document.createElement('div')
  el.className = 'lofi'
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', 'Lo-fi music')
  el.innerHTML = `<button type="button" class="lofi-play" aria-label="Play music">${ICON.play}</button>`
    + `<button type="button" class="lofi-next" aria-label="Next track">${ICON.next}</button>`
    + '<button type="button" class="lofi-vibe" aria-haspopup="menu" aria-expanded="false" aria-controls="lofi-menu"></button>'
    + '<canvas width="56" height="28" aria-hidden="true"></canvas><span class="lofi-name" aria-live="polite"></span>'
    + '<input type="range" min="0" max="1" step="0.01" aria-label="Volume">'
    + '<div class="lofi-menu" id="lofi-menu" role="menu" aria-label="Vibe" hidden>'
    + MENU.map((k) => `<button type="button" role="menuitemradio" tabindex="-1" data-vibe="${k}"><i aria-hidden="true">${k === 'auto' ? '✨' : VIBES[k].icon}</i>${k === 'auto' ? 'Auto' : VIBES[k].label}${k === 'auto' ? '<small></small>' : ''}</button>`).join('')
    + '</div>'
  document.body.appendChild(el)
  const [playBtn, nextBtn, vibeBtn] = el.querySelectorAll('button')
  const menu = el.querySelector('.lofi-menu'), items = [...menu.querySelectorAll('button')]
  const canvas = el.querySelector('canvas'), g2 = canvas.getContext('2d')
  const nameEl = el.querySelector('.lofi-name'), volEl = el.querySelector('input')
  volEl.value = vol
  function showName() {
    const v = VIBES[track.vibe], label = choice === 'auto' ? `Auto (${v.label})` : v.label
    nameEl.textContent = track.name
    nameEl.title = `${track.name} · ${v.label} · ${track.bpm} BPM`
    vibeBtn.textContent = v.icon
    vibeBtn.classList.toggle('auto', choice === 'auto')
    vibeBtn.title = `Vibe: ${label}`
    vibeBtn.setAttribute('aria-label', `Vibe: ${label}`)
    for (const it of items) it.setAttribute('aria-checked', it.dataset.vibe === choice)
    items[0].querySelector('small').textContent = choice === 'auto' ? v.label : ''
  }
  showName()

  const bins = new Uint8Array(128), BANDS = [0, 1, 2, 3, 5, 8, 13] // ~170 Hz bins, roughly log-spaced
  function draw() {
    if (playing) analyser.getByteFrequencyData(bins)
    g2.clearRect(0, 0, 56, 28)
    g2.fillStyle = '#cfd8e0'
    for (let i = 0; i < 7; i++) {
      const v = playing ? bins[BANDS[i]] / 255 : 0
      const h = Math.max(3, Math.round(v * 26))
      g2.fillRect(i * 8 + 1, 28 - h, 6, h)
    }
  }
  draw()

  const gain = () => vol * vol
  function init() {
    ac = new (window.AudioContext || window.webkitAudioContext)()
    analyser = ac.createAnalyser()
    analyser.fftSize = 256
    analyser.minDecibels = -85
    analyser.maxDecibels = -25
    analyser.smoothingTimeConstant = 0.7
    analyser.connect(ac.destination)
    engine = createEngine(ac, analyser, () => { track = makeTrack(newSeed(), current()); showName(); return track })
    engine.out.gain.value = gain()
    engine.start(track, ac.currentTime + 0.1)
  }
  const tick = () => engine.tick(ac.currentTime + (document.hidden ? 1.5 : 0.1)) // timers slow down in hidden tabs
  function setPlaying(on) {
    playing = on
    playBtn.innerHTML = on ? ICON.pause : ICON.play
    playBtn.setAttribute('aria-label', on ? 'Pause music' : 'Play music')
    store.set('lofi:on', on ? '1' : '0')
    clearInterval(timer)
    clearInterval(vizTimer)
    if (on) {
      tick()
      timer = setInterval(tick, 25)
      vizTimer = setInterval(draw, 66)
    } else draw()
  }
  function play() {
    stopWaiting()
    if (!ac) init()
    ac.resume()
    setPlaying(true)
  }
  function pause() {
    setPlaying(false)
    ac.suspend()
  }
  playBtn.onclick = () => (playing ? pause() : play())
  nextBtn.onclick = () => {
    track = makeTrack(newSeed(), current())
    showName()
    if (ac) engine.skip(track)
  }
  volEl.oninput = () => {
    vol = +volEl.value
    store.set('lofi:vol', vol)
    if (ac) engine.out.gain.setTargetAtTime(gain(), ac.currentTime, 0.03)
  }

  // Vibe: a new track in the new vibe joins at the next bar line while playing (no fade, no gap).
  function retune() {
    if (current() === track.vibe) return showName()
    track = makeTrack(newSeed(), current())
    showName()
    if (ac) playing ? engine.change(track) : engine.skip(track)
  }
  function choose(k) {
    choice = k
    store.set('lofi:vibe', k)
    retune()
  }
  const offWeather = city && city.on ? city.on('weather', () => choice === 'auto' && retune()) : null

  function openMenu(focus = items.find((it) => it.dataset.vibe === choice)) {
    menu.hidden = false
    vibeBtn.setAttribute('aria-expanded', 'true')
    focus.focus()
    document.addEventListener('pointerdown', outside, true)
  }
  function closeMenu(refocus) {
    menu.hidden = true
    vibeBtn.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', outside, true)
    if (refocus) vibeBtn.focus()
  }
  function outside(e) { if (!el.contains(e.target)) closeMenu(false) }
  vibeBtn.onclick = () => (menu.hidden ? openMenu() : closeMenu(true))
  vibeBtn.onkeydown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    openMenu(e.key === 'ArrowUp' ? items[items.length - 1] : undefined)
  }
  menu.onclick = (e) => {
    const it = e.target.closest('button')
    if (!it) return
    choose(it.dataset.vibe)
    closeMenu(true)
  }
  menu.onkeydown = (e) => {
    const i = items.indexOf(document.activeElement), n = items.length
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key]
    if (to !== undefined) {
      e.preventDefault()
      items[(to + n) % n].focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu(true)
    } else if (e.key === 'Tab') closeMenu(false)
  }

  // Music was on last visit: resume on the first gesture anywhere (autoplay needs one).
  const gestures = ['pointerdown', 'pointerup', 'keydown']
  function onGesture(e) {
    if (el.contains(e.target)) return stopWaiting()
    if (navigator.userActivation && !navigator.userActivation.isActive) return
    play()
  }
  function stopWaiting() { for (const g of gestures) document.removeEventListener(g, onGesture, true) }
  if (store.get('lofi:on') === '1') for (const g of gestures) document.addEventListener(g, onGesture, true)

  return {
    dispose() {
      stopWaiting()
      closeMenu(false)
      if (offWeather) offWeather()
      clearInterval(timer)
      clearInterval(vizTimer)
      if (ac) ac.close()
      el.remove()
      style.remove()
    },
  }
}
