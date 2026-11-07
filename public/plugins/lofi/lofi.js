// Procedural lo-fi hip hop, generated live with the Web Audio API (no library, no audio files).
// `lofi()` adds a small player pill (bottom-left; move it with --lofi-left / --lofi-bottom / --lofi-z
// on :root or override the .lofi class) and returns { dispose() }. `renderOffline()` renders a track
// to an AudioBuffer, for testing.

const PLACES = ['Kitsilano', 'Gastown', 'Yaletown', 'Strathcona', 'Kerrisdale', 'Jericho', 'Lonsdale', 'Dunbar',
  'Fairview', 'Burrard', 'Cambie', 'Davie', 'Robson', 'Hastings', 'Granville', 'Chinatown', 'Marpole', 'Shaughnessy',
  'Steveston', 'Seawall', 'Kits', 'Lynn', 'Grouse', 'Cypress', 'Musqueam', 'Riley', 'Hornby', 'Main', 'Commercial', 'Deas']
const MOODS = ['Rain', 'Drizzle', 'Fog', 'Ferry', 'Lanterns', 'Puddles', 'Seabus', 'Tea', 'Windows', 'Sunday', 'Dusk',
  'Streetcar', 'Herons', 'Ravens', 'Umbrellas', 'Cedars', 'Steam', 'Moss', 'Neon', 'Skytrain', 'Morning', 'Afterglow',
  'Driftwood', 'Pages', 'Cocoa', 'Tides', 'Gulls', 'Mist', 'Blossoms', 'Bookshop', 'Sleepers', 'Harbour']

// Chord qualities as semitones above the chord root; 5+ note chords are voiced rootless (the bass has the root).
const Q = { M9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], d9: [0, 4, 7, 10, 14], m7: [0, 3, 7, 10], M7: [0, 4, 7, 11],
  m11: [0, 3, 7, 10, 14, 17], d13: [0, 4, 10, 14, 21] }
// Progressions in a major key: [degree in semitones, quality].
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
const PENT = [0, 2, 4, 7, 9]

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

export function makeTrack(seed) {
  const r = rng(seed)
  const pick = (a) => a[Math.floor(r() * a.length)]
  const name = pick(PLACES) + ' ' + pick(MOODS)
  const bpm = 70 + Math.floor(r() * 21)
  const key = 48 + Math.floor(r() * 8)
  const progA = pick(PROGS)
  let progB = pick(PROGS)
  if (progB === progA) progB = PROGS[(PROGS.indexOf(progA) + 3) % PROGS.length]
  const kickA = pick(KICKS)
  let kickB = pick(KICKS)
  if (kickB === kickA) kickB = KICKS[(KICKS.indexOf(kickA) + 1) % KICKS.length]
  const lick = () => { // a 2-bar pentatonic noodle, [step 0..31, midi, length]
    const notes = []
    let s = Math.floor(r() * 4) * 2, d = 3 + Math.floor(r() * 4)
    const n = 4 + Math.floor(r() * 4)
    while (notes.length < n && s < 30) {
      notes.push([s, key + 12 + PENT[d % 5] + 12 * Math.floor(d / 5), 2])
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
    A: { name: 'A', prog: progA, kick: kickA, drums: 1, bass: 1, lick: lick(), lickP: 0.35 },
    B: { name: 'B', prog: progB, kick: kickB, drums: 1, bass: 1, hat16: 1, lick: lick(), lickP: 0.8 },
    outro: { name: 'outro', prog: progA, kick: kickA, drums: 0.5, bass: 1 },
  }
  const bars = []
  for (const [sec, n] of pick(FORMS)) for (let i = 0; i < n; i++) bars.push({ sec: S[sec], i, n })
  return {
    seed, name, bpm, key, bars, r, sd: 60 / bpm / 4,
    swing: 0.18 + r() * 0.18, strum: 0.006 + r() * 0.014, chordBars: pick([1, 2]),
    comp: pick(COMPS), bass: pick(BASSES), ghost: pick(GHOSTS),
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
  const lfo = (f, depth, param) => { const o = O('sine', f, G(depth, param)); o.start(); oscs.push(o) }

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
  const drums = G(0.42, F('lowpass', 9000, 0.3, mix))
  const music = G(1, mix) // ducked by the kick
  const verb = ac.createConvolver() // short generated room
  verb.buffer = buf(2, 1.4, (d) => {
    let y = 0
    for (let i = 0; i < d.length; i++) { y += 0.3 * ((Math.random() * 2 - 1) - y); d[i] = y * (1 - i / d.length) ** 3 }
  })
  verb.connect(G(0.7, music))
  const trem = G(0.82, music)
  lfo(3.1, 0.18, trem.gain)
  const keysLP = F('lowpass', 2400, 0.6, trem)
  keysLP.connect(G(0.3, verb))
  const keys = G(1, keysLP)
  const bass = G(1, F('lowpass', 420, 0.7, music))
  const lead = G(1, F('lowpass', 3200, 0.5, music))
  const echo = ac.createDelay(2)
  echo.connect(F('lowpass', 1800, 0.4, G(0.35, echo)))
  echo.connect(G(0.3, music))
  lead.connect(echo)
  lead.connect(G(0.4, verb))
  const snares = G(1, drums)
  snares.connect(G(0.25, verb))
  // vinyl: looped sparse clicks + hiss, straight to the clipper (not filtered by sections)
  const vinyl = G(1, clip)
  const crackle = buf(1, 5, (d) => {
    for (let i = 0; i < d.length; i++) {
      if (Math.random() > 14 / sr) continue
      const a = (0.15 + 0.85 * Math.random() ** 3) * (Math.random() < 0.5 ? -1 : 1)
      for (let k = 0; k < 40 && i + k < d.length; k++) d[i + k] += a * Math.exp(-k / 6) * (k % 2 ? -0.6 : 1)
    }
  })
  const loops = [[crackle, F('highpass', 500, 0.7, G(0.22, vinyl))], [noise, F('bandpass', 5000, 0.3, G(0.02, vinyl))]]
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
    mg.gain.setValueAtTime(f * 1.4, t)
    mg.gain.setTargetAtTime(f * 0.3, t, 0.12)
    for (const o of [a, b, mod]) { o.start(t); o.stop(end) }
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
  function hit(t, v, type, f, q, dec, bus) { // filtered noise burst
    const s = ac.createBufferSource(), g = G(0, bus)
    s.buffer = noise
    s.connect(F(type, f, q, g))
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(v, t + 0.002)
    g.gain.exponentialRampToValueAtTime(0.001, t + dec)
    s.start(t, Math.random() * 1.5)
    s.stop(t + dec + 0.02)
  }
  function tonal(t, v, f0, f1, dec, bus) {
    const g = G(0, bus), o = O('triangle', f0, g)
    g.gain.setValueAtTime(v, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dec)
    o.frequency.exponentialRampToValueAtTime(f1, t + dec)
    o.start(t)
    o.stop(t + dec + 0.02)
  }
  const snare = (t, v) => { hit(t, v * 0.7, 'bandpass', 1900, 0.7, 0.18, snares); tonal(t, v * 0.5, 190, 160, 0.09, snares) }
  const rim = (t, v) => { hit(t, v, 'bandpass', 3200, 3, 0.03, drums); tonal(t, v * 0.6, 900, 850, 0.03, drums) }
  const hat = (t, v, open) => hit(t, v, 'highpass', 6500, 0.5, open ? 0.3 : 0.045, drums)

  const voice = (key, [root, q]) => Q[q].slice(Q[q].length > 4 ? 1 : 0).map((iv) => {
    let m = key + root + iv
    while (m < 52) m += 12
    while (m > 71) m -= 12
    return m
  }).sort((a, b) => a - b)

  let T, bar, st, next, lickOn = false
  function sectionStart(S, t, dur) {
    const f = tone.frequency
    if (S.name === 'intro') {
      mix.gain.setValueAtTime(1, t)
      f.setValueAtTime(500, t)
      f.setTargetAtTime(6500, t, dur / 3)
    } else if (S.name === 'outro') {
      f.setTargetAtTime(600, t, dur / 3)
      mix.gain.setTargetAtTime(0, t + dur * 0.4, dur / 6)
    } else f.setTargetAtTime(S.name === 'B' ? 8500 : 6500, t, 0.4)
  }
  function step(t) {
    const b = T.bars[bar], S = b.sec, s = st, sd = T.sd, r = T.r
    const ts = t + (s % 2 ? T.swing * sd : 0), hum = () => ts + (r() - 0.5) * 0.008
    if (s === 0) {
      if (b.i === 0) sectionStart(S, t, b.n * 16 * sd)
      if (b.i % 4 === 2) lickOn = !!S.lick && r() < S.lickP
      if (b.i % 4 < 2) lickOn = false
    }
    const chord = S.prog[Math.floor(b.i / T.chordBars) % S.prog.length]
    for (const [cs, cd] of T.comp) {
      if (cs === s) voice(T.key, chord).forEach((m, k) => ep(ts + k * T.strum + r() * 0.006, m, 0.08 + r() * 0.03, cd * sd - 0.03, keys))
    }
    if (S.bass) {
      let root = ((T.key + chord[0]) % 12) + 36
      if (root > 45) root -= 12
      for (const [bs, iv, bd] of T.bass) if (bs === s) bassNote(hum(), root + iv, 0.13, bd * sd - 0.02)
    }
    const brk = b.i === b.n - 1 && S.name !== 'outro' // last bar of a section: drop the kick, half the hats
    if (S.drums && b.i < b.n * S.drums) {
      if (S.kick.includes(s) && !(brk && s > 0)) kick(hum(), 0.55)
      if (s === 4 || s === 12) snare(hum(), 0.5 + r() * 0.1)
      else if (T.ghost.includes(s) && r() < 0.6) rim(hum(), 0.12)
      if ((S.hat16 || s % 2 === 0) && !(brk && s >= 8)) {
        hat(hum(), (s % 4 === 0 ? 0.3 : s % 2 === 0 ? 0.2 : 0.09) * (0.8 + r() * 0.4), S.hat16 && s === 14 && b.i % 2 === 1)
      }
    }
    if (lickOn && b.i % 4 >= 2) {
      const ls = (b.i % 4 - 2) * 16 + s
      for (const [n, m, d] of S.lick) if (n === ls) ep(hum(), m, 0.09, d * sd, lead)
    }
  }
  function start(track, t) {
    T = track
    bar = st = 0
    next = t
    echo.delayTime.setValueAtTime(T.sd * 3, t) // dotted eighth
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
        if (bar >= T.bars.length) start(onTrackEnd(T), next)
        step(next)
        next += T.sd
        if (++st === 16) { st = 0; bar++ }
      }
    },
    skip(track) { // fade the current track out quickly and start another
      const now = ac.currentTime
      for (const p of [mix.gain, tone.frequency]) p.cancelScheduledValues(now)
      mix.gain.setTargetAtTime(0, now, 0.04)
      start(track, Math.max(now + 0.25, next))
    },
  }
}

const newSeed = () => (Math.random() * 2 ** 32) >>> 0

export async function renderOffline(seconds = 20, seed = 1, rate = 44100) {
  const ac = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate)
  const e = createEngine(ac, ac.destination, (t) => makeTrack(t.seed + 1))
  e.start(makeTrack(seed), 0.05)
  e.tick(seconds)
  return ac.startRendering()
}

const CSS = `
.lofi{position:fixed;left:var(--lofi-left,12px);bottom:var(--lofi-bottom,56px);z-index:var(--lofi-z,20);display:flex;align-items:center;gap:2px;box-sizing:border-box;max-width:calc(100vw - 24px);padding:4px 10px 4px 4px;background:rgba(11,16,22,.72);color:#cfd8e0;font:12px/1.2 system-ui,-apple-system,sans-serif;border-radius:8px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);user-select:none;-webkit-user-select:none}
.lofi button{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:none;color:inherit;cursor:pointer}
.lofi button:hover{background:rgba(207,216,224,.1)}
.lofi button:focus-visible,.lofi input:focus-visible{outline:2px solid #cfd8e0;outline-offset:1px}
.lofi svg{width:14px;height:14px;fill:currentColor}
.lofi canvas{display:block;flex:none;width:28px;height:14px;margin:0 4px}
.lofi-name{flex:1 1 auto;min-width:0;max-width:15em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lofi input{flex:none;width:64px;margin:0 0 0 8px;accent-color:#cfd8e0}
`
const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>',
  next: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5v11l7.5-5.5zM10.5 2.5h3v11h-3z"/></svg>',
}

export default function lofi(ctx) {
  const store = {
    get(k) { try { return localStorage.getItem(k) } catch { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch {} },
  }
  let vol = parseFloat(store.get('lofi:vol'))
  if (!(vol >= 0 && vol <= 1)) vol = 0.6
  let track = makeTrack(newSeed()), ac, engine, analyser, timer, vizTimer, playing = false

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  const el = document.createElement('div')
  el.className = 'lofi'
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', 'Lo-fi music')
  el.innerHTML = `<button type="button" class="lofi-play" aria-label="Play music">${ICON.play}</button>`
    + `<button type="button" class="lofi-next" aria-label="Next track">${ICON.next}</button>`
    + '<canvas width="56" height="28" aria-hidden="true"></canvas><span class="lofi-name" aria-live="polite"></span>'
    + '<input type="range" min="0" max="1" step="0.01" aria-label="Volume">'
  document.body.appendChild(el)
  const [playBtn, nextBtn] = el.querySelectorAll('button')
  const canvas = el.querySelector('canvas'), g2 = canvas.getContext('2d')
  const nameEl = el.querySelector('.lofi-name'), volEl = el.querySelector('input')
  volEl.value = vol
  const showName = () => { nameEl.textContent = track.name; nameEl.title = `${track.name} · ${track.bpm} BPM` }
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
    engine = createEngine(ac, analyser, () => { track = makeTrack(newSeed()); showName(); return track })
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
    track = makeTrack(newSeed())
    showName()
    if (ac) engine.skip(track)
  }
  volEl.oninput = () => {
    vol = +volEl.value
    store.set('lofi:vol', vol)
    if (ac) engine.out.gain.setTargetAtTime(gain(), ac.currentTime, 0.03)
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
      clearInterval(timer)
      clearInterval(vizTimer)
      if (ac) ac.close()
      el.remove()
      style.remove()
    },
  }
}
