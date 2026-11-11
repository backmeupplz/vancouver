// Van stunt bonuses (free roam and deliveries; the cab's own tips live in taxi.js): a near miss passes a moving car
// within a metre at over 30 km/h without touching it (several inside 4 s chain, ×1 to ×4), airtime pays by the second.
// Pure rules, checked by tools/van_check.mjs. Pedestrians never count: no reward for scaring people at crosswalks.
export const NEAR_KMH = 30, NEAR_GAP = 1, CHAIN_MS = 4000, CHAIN_MAX = 4, AIR_MIN = 0.4

// the gap in metres between two boxes (centre, unit forward, half length and width): the largest separation on any
// of their four axes, negative when they overlap
export function boxGap(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y
  let gap = -Infinity
  for (const n of [[a.fx, a.fy], [-a.fy, a.fx], [b.fx, b.fy], [-b.fy, b.fx]]) {
    const ra = a.hl * Math.abs(a.fx * n[0] + a.fy * n[1]) + a.hw * Math.abs(-a.fy * n[0] + a.fx * n[1])
    const rb = b.hl * Math.abs(b.fx * n[0] + b.fy * n[1]) + b.hw * Math.abs(-b.fy * n[0] + b.fx * n[1])
    gap = Math.max(gap, Math.abs(dx * n[0] + dy * n[1]) - ra - rb)
  }
  return gap
}

export const airPay = (secs) => (secs > AIR_MIN ? Math.min(60, Math.round(6 * secs)) : 0)

export function makeBonus() {
  const close = new Map() // car id -> smallest gap while it was within a metre at speed
  let chain = 0, last = -Infinity
  return {
    // each frame, every car near enough to matter: its id, the gap, whether it moves; kmh: the van's speed
    track(id, gap, moving, kmh) { if (moving && kmh > NEAR_KMH && gap < NEAR_GAP) close.set(id, Math.min(close.get(id) ?? 9, gap)) },
    // after the frame's tracking: cars no longer within `seen` (a Set of ids still close) are passed: pay the clean ones
    sweep(now, seen) {
      const out = []
      for (const [id, g] of close) {
        if (seen.has(id)) continue
        close.delete(id)
        if (g <= 0.02) continue // touched
        chain = now - last < CHAIN_MS ? Math.min(CHAIN_MAX, chain + 1) : 1
        last = now
        out.push({ mult: chain, pay: 3 * chain })
      }
      return out
    },
  }
}
