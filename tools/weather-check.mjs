// node tools/weather-check.mjs: sanity checks for the weather plugin's sun position, clock and WMO mapping
import assert from 'node:assert/strict'
import { solar, vanTime, fromOpenMeteo } from '../public/plugins/weather/index.js'

const deg = (r) => r / (Math.PI / 180)
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(2)} vs ${b}`)
// Vancouver solar noon elevation: 90 - 49.28 + 23.44 = 64.16° at the June solstice, 17.28° at the December one
let s = solar(Date.UTC(2026, 5, 21, 20, 12)); near(deg(s.el), 64.1, 0.3, 'June noon elevation'); near(deg(s.az), 180, 3, 'June noon azimuth')
s = solar(Date.UTC(2026, 11, 21, 20, 13)); near(deg(s.el), 17.3, 0.3, 'December noon elevation')
s = solar(Date.UTC(2026, 2, 20, 14, 15)); near(deg(s.el), 0, 1.5, 'March sunrise (~07:15 PDT)'); near(deg(s.az), 90, 3, 'sunrise in the east')
assert.ok(deg(solar(Date.UTC(2026, 10, 7, 7, 0)).el) < -30, 'Nov 6 23:00 PST is night')
// clock: 2026-11-06 19:30 PST = 2026-11-07 03:30 UTC
const v = vanTime(Date.UTC(2026, 10, 7, 3, 30)); near(v.hour, 19.5, 1e-9, 'local hour')
assert.equal(v.midnight, Date.UTC(2026, 10, 6, 8, 0), 'local midnight in UTC')
assert.equal(vanTime(Date.UTC(2026, 6, 1, 19, 0)).hour, 12, 'PDT offset')
// WMO
assert.equal(fromOpenMeteo({ weather_code: 61, precipitation: 0.1, cloud_cover: 100 }).kind, 'rain')
assert.equal(fromOpenMeteo({ weather_code: 3, cloud_cover: 90 }).intensity, 0.9)
assert.equal(fromOpenMeteo({ weather_code: 75 }).kind, 'snow')
assert.equal(fromOpenMeteo({ weather_code: 95, precipitation: 3 }).intensity, 1)
console.log('ok')
