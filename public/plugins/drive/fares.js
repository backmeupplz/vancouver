// Rush Fare's clock rules, pure so tools/van_check.mjs can run them under node
export const START_TIME = 60 // s on the clock at the start of a shift
// seconds a pickup adds: the class's base, or the road time for the trip (1.3 × the straight line) at a pace that
// tightens with the fares done (16, 19, then 22 m/s) plus 6 s to find the door: the first two fares are generous
export const pickupSeconds = (add, dist, fares) => Math.max(add, 6 + (1.3 * dist) / (fares < 2 ? 16 : fares < 5 ? 19 : 22))
