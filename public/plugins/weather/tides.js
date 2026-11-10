// The tide at Vancouver (CHS station 07735, in Burrard Inlet): heights in metres above chart datum.
// Live: the Canadian Hydrographic Service's predictions and the gauge's latest reading, from Fisheries and Oceans
// Canada's Integrated Water Level System (https://api-iwls.dfo-mpo.gc.ca, keyless, CORS open; Open Government
// Licence - Canada). Offline, or for any other time: a harmonic approximation, 20 constituents fitted by least squares to
// the CHS hourly predictions for 2026-2028 (rms 7 cm, worst 25 cm; no nodal corrections, so it drifts by a few cm a
// year outside those years).
const API = 'https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/5cebf1de3d0f4a073c4bb943/data?time-series-code='
const EPOCH = Date.UTC(2026, 0, 1), Z0 = 3.061 // mean water level
export const TIDE_MIN = 0, TIDE_MAX = 5 // the range the map shows (large tides: 0.0 to 5.0 m)
// [speed in degrees an hour, cos, sin] from EPOCH: M2 S2 N2 K2 K1 O1 P1 Q1 M4 MK3 J1 NU2 MU2 L2 SA SSA MF M1 OO1 NO1
const C = [[28.9841042, 0.7929, -0.4616], [30, 0.0915, 0.2157], [28.4397295, 0.1212, -0.1466], [30.0821373, -0.0683, -0.0388], [15.0410686, 0.0514, -0.9316],
  [13.9430356, -0.4212, -0.3313], [14.9589314, 0.1265, -0.2374], [13.3986609, -0.0675, -0.0572], [57.9682084, -0.0111, 0.0068], [44.0251729, -0.01, 0.0084],
  [15.5854433, 0.0311, -0.0478], [28.5125831, -0.0215, -0.0322], [27.9682084, -0.0099, 0.0041], [29.5284789, -0.0285, 0.0099], [0.0410686, 0.0541, -0.0059],
  [0.0821373, 0.0183, 0.0123], [1.0980331, 0.017, -0.001], [14.4920521, -0.0135, 0.0249], [16.1391017, -0.0492, 0.0142], [14.4966939, 0.028, -0.0399]]

export function harmonic(ms) {
  const t = ((ms - EPOCH) / 3600e3) * (Math.PI / 180)
  let h = Z0
  for (const [w, a, b] of C) h += a * Math.cos(w * t) + b * Math.sin(w * t)
  return h
}

// the predicted height at a time: the live curve ([[ms, m], …], evenly spaced) where it covers it, else the harmonics
export function predicted(ms, curve) {
  if (curve?.length > 1) {
    const f = (ms - curve[0][0]) / (curve[1][0] - curve[0][0]), i = Math.floor(f)
    if (i >= 0 && i < curve.length - 1) return curve[i][1] + (curve[i + 1][1] - curve[i][1]) * (f - i)
  }
  return harmonic(ms)
}

// rising or falling now, how fast (metres an hour), and the next turn of the tide (within 14 hours)
export function outlook(ms, curve) {
  const h = (t) => predicted(t, curve), STEP = 6 * 60e3, rate = (h(ms + STEP) - h(ms - STEP)) * 5, rising = rate > 0
  for (let t = ms + STEP; t < ms + 14 * 3600e3; t += STEP) if (h(t + STEP) > h(t) !== rising) return { rising, rate, next: { high: rising, t, height: h(t) } }
  return { rising, rate, next: null }
}

// → { curve: predictions every 15 minutes from an hour ago for 36 hours (old's, while it lasts), surge: the gauge's last reading minus the
// prediction for that minute (0 without one) }
export async function fetchTides(getJSON, now = Date.now(), old = null) {
  const iso = (t) => new Date(t).toISOString().slice(0, 19) + 'Z', q = Math.floor(now / 900e3) * 900e3
  const rows = (j) => j.map((r) => [Date.parse(r.eventDate), r.value]).filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]))
  let curve = old?.curve // (kept while it reaches 12 hours ahead: one request for the predictions every day)
  if (!(curve?.at(-1)[0] > now + 12 * 3600e3 && curve[0][0] < now)) curve = rows(await getJSON(`${API}wlp&resolution=FIFTEEN_MINUTES&from=${iso(q - 3600e3)}&to=${iso(q + 36 * 3600e3)}`))
  if (curve.length < 8) throw new Error('tides: no predictions')
  let surge = 0
  try {
    const obs = rows(await getJSON(`${API}wlo&from=${iso(now - 1800e3)}&to=${iso(now)}`)).pop()
    if (obs) surge = Math.max(-1, Math.min(1, obs[1] - predicted(obs[0], curve)))
  } catch {}
  return { curve, surge }
}
