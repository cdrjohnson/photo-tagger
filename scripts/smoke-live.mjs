// Smoke test against the deployed site (real network, real Hugging Face download – no mocking).
// Run: node scripts/smoke-live.mjs [url]
import { chromium } from 'playwright'
import path from 'node:path'
const URL_LIVE = process.argv[2] || 'https://cdrjohnson.github.io/photo-tagger/'
const sample = (n) => path.resolve('samples', n)
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
const errors = [], failed = [], hf = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('requestfailed', (r) => failed.push(r.url()))
page.on('response', (r) => { if (/huggingface|hf\.co|xethub/.test(r.url())) hf.push(`${r.status()} ${r.url().split('?')[0].split('/').slice(-2).join('/')}`) })
const log = (s) => console.log(s)
const t0 = Date.now()
const res = await page.goto(URL_LIVE); log(`load: HTTP ${res.status()} ${page.url()}`)
await page.getByTestId('empty').waitFor(); log('empty state shown')
const man = await (await page.request.get(URL_LIVE + 'manifest.webmanifest')).json()
log(`manifest: start_url=${man.start_url} scope=${man.scope} icons=${man.icons.length}`)
for (const i of man.icons) { const r = await page.request.get(URL_LIVE + i.src); if (!r.ok()) throw new Error('icon ' + i.src) }
log('wasm: HTTP ' + (await page.request.get(URL_LIVE + 'ort/ort-wasm-simd-threaded.wasm')).status())
log('service worker scope: ' + await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope)))
const t1 = Date.now()
await page.getByTestId('file-input').setInputFiles([sample('dog.jpg'), sample('pizza.jpg'), sample('geotagged-cat.jpg')])
await page.waitForFunction(() => document.querySelectorAll('[data-testid=photo-tile][data-status=ready]').length >= 3, null, { timeout: 420_000 })
log(`tagged 3 photos in ${((Date.now() - t1) / 1000).toFixed(1)}s (includes real model download)`)
const tags = {}
for (const t of await page.getByTestId('photo-tile').all()) tags[await t.getAttribute('data-name')] = await t.getAttribute('data-tags')
log(JSON.stringify(tags, null, 1))
let ok = tags['dog.jpg'].includes('dog') && tags['pizza.jpg'].includes('pizza') && tags['geotagged-cat.jpg'].includes('cat') && tags['geotagged-cat.jpg'].includes('geotagged')
await page.getByTestId('tag-chip').filter({ hasText: 'pets' }).first().click()
log('filter pets -> ' + await page.getByTestId('count').textContent())
// faces: two Biden portraits -> two faces in one cluster; name it
await page.getByTestId('clear-filters').click().catch(() => {})
const t2 = Date.now()
await page.getByTestId('file-input').setInputFiles([sample('biden-2013.jpg'), sample('biden-2021.jpg')])
await page.getByTestId('view-people').click()
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=cluster]')].some((c) => c.dataset.photos.split('|').length === 2 && /biden/.test(c.dataset.photos)), null, { timeout: 300_000 })
log(`face detection + clustering on live site in ${((Date.now() - t2) / 1000).toFixed(1)}s`)
const fc = page.locator('[data-testid=cluster]', { has: page.locator('.pick[title="biden-2013.jpg"]') })
await fc.getByTestId('cluster-name').fill('Joe Biden'); await fc.getByTestId('cluster-save').click()
await page.locator('[data-testid=person-card][data-person="Joe Biden"]').waitFor()
const faceOk = (await page.locator('[data-testid=person-card][data-person="Joe Biden"] small').textContent()).startsWith('2 photos')
log('faces ok: ' + faceOk)
await page.screenshot({ path: 'docs/images/live-smoke.png' })
log('model requests: ' + [...new Set(hf)].join(' | '))
log('page errors: ' + JSON.stringify(errors) + ' | failed requests: ' + JSON.stringify(failed))
await browser.close()
ok = ok && faceOk
console.log(ok && !errors.length ? `LIVE SMOKE TEST PASSED (${((Date.now() - t0) / 1000).toFixed(0)}s)` : 'LIVE SMOKE TEST FAILED')
process.exit(ok && !errors.length ? 0 : 1)
