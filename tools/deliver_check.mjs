// node tools/deliver_check.mjs: the delivery shift's pay rules (public/plugins/drive/deliver.js)
import { payFor, rankOf } from '../public/plugins/drive/deliver.js'
import assert from 'node:assert/strict'
const base = { dist: 600, left: 60, limit: 120, care: 1, rush: false, fragile: false }
const plain = payFor(base), late = payFor({ ...base, left: 0 })
assert(plain.clean && plain.pay > late.pay && !late.clean, 'on time pays more and keeps the streak')
assert(payFor({ ...base, rush: true }).pay > plain.pay * 1.9 && payFor({ ...base, rush: true, left: 0 }).pay < late.pay, 'a rush order: double on time, less late')
assert(payFor({ ...base, fragile: true }).pay > plain.pay * 1.4 && payFor({ ...base, fragile: true, care: 0.5 }).pay < plain.pay * 0.5, 'fragile: more intact, little broken')
assert.equal(payFor({ ...base, streak: 20 }).mult, 3, 'the streak tops out at ×3')
assert(payFor({ ...base, wet: 1.3 }).pay > plain.pay * 1.25, 'rain pays more')
assert.equal(rankOf(0)[1], 'D'); assert.equal(rankOf(500)[1], 'S')
console.log(`ok: plain $${plain.pay}, late $${late.pay}, rush $${payFor({ ...base, rush: true }).pay}, streak ×3 $${payFor({ ...base, streak: 8 }).pay}`)
