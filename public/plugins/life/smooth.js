// Even motion from uneven answers (#606). The worker steps the world in fixed steps and answers each tick with the
// world at exactly the time asked (cars moved on over what is left of a step, people between their last two). The
// answers come when they come: a frame later, two, or half a second on a busy machine. So the page keeps the last two
// (A older, B newer), finds each thing in the other by its id, and draws every frame at `elapsed - delay`, between
// them: a thing moves evenly at any frame rate and however unevenly the answers arrive (drawn as they came, or moved
// on along their headings from the latest one, they stood still while an answer was late and then jumped). `delay`
// follows how old the latest answer has grown lately before the next came: one frame when each comes before the next
// frame, the usual case, and then B is drawn as it is. No three.js here: tools/traffic_check.mjs runs it against the worker.
const shot = () => ({ t: -1, n: 0, raw: new Float32Array(0), aux: new Float32Array(0), from: new Int32Array(0), counts: [], pn: 0, bn: 0, praw: new Float32Array(0), pid: new Float32Array(0), pfrom: new Int32Array(0), pv: new Float32Array(0) })
// from[i]: where thing i of `ids` (every `step`th number) was in the snapshot before (`was`, n0 of them), or -1
function match(n, ids, step, n0, was, from) {
  let map = null
  for (let i = 0; i < n; i++) {
    const id = ids[i * step]
    if (i < n0 && was[i * step] === id) { from[i] = i; continue } // (nothing came or went before it: the usual case)
    if (!map) { map = new Map(); for (let j = 0; j < n0; j++) map.set(was[j * step], j) }
    from[i] = map.get(id) ?? -1
  }
}
// n things (8 numbers each) into `out` as they are at k of the way from snapshot a to b (1: as in b; over 1, an
// answer is late: moved on as they were going): place, heading and field 4 (a car's pitch; a person's walk cycle,
// which the worker turns by the distance walked, so the feet keep to the ground they cover), the rest as in b.
// One that is new in b, or that went further than sqrt(far) metres between the two (set down elsewhere): from where
// it is in b, back along its own way by the time e to b (vel: its speed, or its velocity x, z; drawn as in b, ahead
// of the rest, it jumped back when the next answer came).
function mix(n, a, b, from, out, k, far, people, e, vel) {
  out.set(b.subarray(0, n * 8))
  if (k === 1) return
  const u = k - 1, ua = Math.min(0, u), TAU = Math.PI * 2
  for (let i = 0; i < n; i++) {
    const j = from[i], s = i * 8, o = j * 8, dx = b[s] - a[o], dz = b[s + 2] - a[o + 2]
    if (j < 0 || dx * dx + dz * dz > far) {
      if (people) { out[s] += vel[i * 2] * e; out[s + 2] += vel[i * 2 + 1] * e }
      else { const d = vel[i * 2 + 1] * e, h = d * Math.cos(b[s + 4]); out[s] += Math.cos(b[s + 3]) * h; out[s + 1] += Math.sin(b[s + 4]) * d; out[s + 2] -= Math.sin(b[s + 3]) * h }
      continue
    }
    out[s] += dx * u; out[s + 1] += (b[s + 1] - a[o + 1]) * u; out[s + 2] += dz * u
    const dy = b[s + 3] - a[o + 3]
    out[s + 3] += (dy - TAU * Math.round(dy / TAU)) * ua
    if (!people || Math.floor(b[s + 5]) === Math.floor(a[o + 5])) out[s + 4] += (b[s + 4] - a[o + 4]) * (people ? u : ua) // (the same pose in both)
  }
}
export function smoother() {
  // the answers, oldest first, as far back as the time being drawn (more than two: with answers up to three frames
  // late the world is drawn five frames back, and there are newer ones than that), and the two being drawn between
  const H = [shot()]
  let A = H[0], B = H[0], delay = 0, fresh = false, T = 0, age = 0, hiT = 0, lost = 0, late = 0, simT = null, sentT = 0, rate = 0, v = 0
  const hi = [0, 0]
  const last = () => H[H.length - 1]
  // how far from A to B the world is at clock time t (an answer over a quarter second late: they wait)
  const k = (t) => { const span = B.t - A.t; return A.t >= 0 && span > 1e-4 ? Math.max(0, 1 + Math.min(t - B.t, 0.25) / span) : 1 }
  const at = (t) => { let i = 1; while (i < H.length - 1 && H[i].t < t) i++; B = H[Math.min(i, H.length - 1)]; A = H[Math.max(0, Math.min(i, H.length - 1) - 1)] }
  return {
    get b() { return B }, // the answer being drawn: n cars (aux: id, speed each; counts per kind), pn people and bn cyclists (pid: ids)
    get delay() { return delay },
    // the worker's answer m to the tick sent at clock time t (its own clock, m.simT, falls behind that when it drops
    // time: a tick over a quarter second long. `lost` is by how much, and the world is drawn that much later: `late`,
    // eased to it; `rate`: how fast it loses time lately, seconds a second)
    push(m, t) {
      const drop = simT == null ? 0 : t - sentT - (m.simT - simT)
      if (drop > 1e-3) lost += drop
      if (simT != null && t > sentT) rate += ((drop > 1e-3 ? drop : 0) / (t - sentT) - rate) * Math.min(1, (t - sentT) / 2)
      simT = m.simT; sentT = t; t -= lost
      while (H.length > 3 && H[2].t <= T) H.shift() // (no longer drawn)
      const S = H.length >= 40 || (H.length > 2 && H[1].t <= T) ? H.shift() : shot(), was = last()
      H.push(S)
      const nb = m.nPeople + m.nBikes, ids = m.vbase - m.pbase >= nb // (a worker from before the cyclists had ids: an old cached file)
      if (S.raw.length < m.cars * 8) { S.raw = new Float32Array(m.cars * 12); S.aux = new Float32Array(m.cars * 3); S.from = new Int32Array(m.cars * 1.5) }
      if (S.praw.length < nb * 8) { S.praw = new Float32Array(nb * 12); S.pid = new Float32Array(nb * 1.5); S.pfrom = new Int32Array(nb * 1.5); S.pv = new Float32Array(nb * 3) }
      S.raw.set(m.buf.subarray(0, m.cars * 8)); S.aux.set(m.buf.subarray(m.base, m.base + m.cars * 2))
      S.praw.set(m.buf.subarray(m.cars * 8, (m.cars + nb) * 8)); S.pid.set(m.buf.subarray(m.pbase, m.pbase + (ids ? nb : m.nPeople)))
      if (!ids) S.pid.fill(-1, m.nPeople, nb)
      S.pv.set(m.buf.subarray(m.vbase, m.vbase + nb * 2))
      S.n = m.cars; S.counts = m.counts; S.pn = m.nPeople; S.bn = m.nBikes; S.t = t
      match(S.n, S.aux, 2, was.n, was.aux, S.from); match(nb, S.pid, 1, was.pn + was.bn, was.pid, S.pfrom)
      fresh = true
      at(T) // (the two may have changed: the oldest answer is written over)
    },
    // a frame, dt after the last, at clock time `elapsed`: the time to draw the world at
    step(elapsed, dt) {
      // `late` grows at v: the rate time is lost at plus a pull towards what is lost so far, v itself changing by at most
      // 1 a second, and under 0.9 (with the delay's 0.1: the world is drawn slower, never backwards; a snap back to a
      // quarter second behind made 98% of the stutters with a worker that could not keep up, #604)
      v += Math.max(-dt, Math.min(dt, Math.max(-0.2, Math.min(0.9, rate + 0.5 * (lost - late))) - v))
      late += v * dt
      const e0 = elapsed - late
      elapsed -= lost
      // how old the latest answer had grown by the frame before a new one came (the tick after it is sent only when it
      // has come, so that is the wait for the one and for the other): drawn that far back there is always a newer one
      // The most it was in the last few seconds (hi: this second and a half, and the one before), and `delay` eased to
      // that: things run a few percent slower or faster while it changes, which is seldom
      if (fresh) { fresh = false; hi[0] = Math.max(hi[0], age) }
      if (elapsed - hiT > 1.5) { hiT = elapsed; hi[1] = hi[0]; hi[0] = 0 }
      age = elapsed - last().t
      delay += Math.max(-0.03 * dt, Math.min(0.1 * dt, Math.max(hi[0], hi[1]) - delay))
      at((T = e0 - delay))
      return T
    },
    cars(out, t) { mix(B.n, A.raw, B.raw, B.from, out, k(t), 1600, false, Math.min(t - B.t, 0.25), B.aux) },
    people(out, t) { mix(B.pn + B.bn, A.praw, B.praw, B.pfrom, out, k(t), 36, true, Math.min(t - B.t, 0.25), B.pv) }, // (the people, then the cyclists)
  }
}
