// Real production CLIP worker + packaged ORT, including an upgrade from poisoned
// v1.0.1/v1.0.2 CacheStorage. Run after either frontend build; --web checks Pages base.
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { launch } from './testkit.mjs'
const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)))
const base = process.argv.includes('--web') ? '/photo-tagger/' : '/'
const worker = (await fs.readdir(path.join(root, 'assets'))).find(f => /^worker-.*\.js$/.test(f))
const { version } = JSON.parse(await fs.readFile(new URL('../node_modules/onnxruntime-web/package.json', import.meta.url)))
const requests = []
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === `${base}probe`) { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>ORT test</title>'); return }
  try {
    assert(url.pathname.startsWith(base))
    const file = path.resolve(root, url.pathname.slice(base.length))
    assert(file.startsWith(root + path.sep))
    const body = await fs.readFile(file)
    const type = file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'
    if (url.pathname.includes('/ort/')) requests.push({ url: url.pathname + url.search, type })
    res.setHeader('content-type', type)
    res.end(body)
  } catch {
    // Match Tauri's dangerous missing-asset SPA fallback, not a helpful 404.
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html></html>')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const { browser, context } = await launch()
try {
  for (const poison of [false, true]) {
    const page = await context.newPage()
    await page.goto(`${origin}${base}probe`)
    const result = await page.evaluate(async ({ base, worker, poison, version }) => {
      if (poison) {
        const cache = await caches.open('transformers-cache')
        for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
          for (const query of ['', `?v=${version}`]) {
            await cache.put(`${location.origin}${base}ort/${file}${query}`, new Response('<!doctype html><html>old fallback</html>', { headers: { 'content-type': 'text/html' } }))
          }
        }
      }
      const w = new Worker(`${base}assets/${worker}`, { type: 'module' })
      let seq = 0
      const call = msg => new Promise((resolve, reject) => {
        const id = ++seq
        const timer = setTimeout(() => reject(Error('worker timed out')), 120_000)
        w.onerror = e => { clearTimeout(timer); reject(Error(e.message)) }
        w.onmessage = e => {
          if (e.data.id !== id) return
          clearTimeout(timer)
          if (e.data.type === 'error') reject(Error(e.data.message))
          else resolve(e.data)
        }
        w.postMessage({ ...msg, id })
      })
      try {
        await call({ type: 'init', base: `${location.origin}${base}`, modelId: 'Xenova/clip-vit-base-patch32', host: 'https://huggingface.co/' })
        const { embedding } = await call({ type: 'embed', width: 224, height: 224, rgb: new Uint8ClampedArray(224 * 224 * 3).fill(128) })
        const norm = Math.hypot(...embedding)
        return { length: embedding.length, norm, finite: [...embedding].every(Number.isFinite) }
      } finally { w.terminate() }
    }, { base, worker, poison, version })
    assert.equal(result.length, 512)
    assert(result.finite && Math.abs(result.norm - 1) < .001)
    await page.close()
    console.log(`PASS ${base} real CLIP vision inference (${poison ? 'poisoned persisted HTML cache' : 'clean cache'})`)
  }
  assert(requests.some(r => r.type === 'text/javascript' && r.url.includes('.mjs?v=')))
  assert(requests.some(r => r.type === 'application/wasm' && r.url.includes('.wasm?v=')))
  console.log('Runtime requests:', JSON.stringify(requests))
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
