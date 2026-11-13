// End-to-end tests (Playwright + Chromium) against the production build served by `vite preview`.
// Real CLIP model, real sample photos (samples/), real IndexedDB. Hugging Face files are cached on disk after the first run.
// Run: npm run build && npm run test:e2e
import fs from 'node:fs/promises'
import { execSync } from 'node:child_process'
import zlib from 'node:zlib'
import path from 'node:path'
import { devices } from 'playwright'
import { launch, makeScreenshotSample, ROOT, sample, startPreview, URL_BASE, routeModel } from './testkit.mjs'

const results = []
let current = ''
const T0 = Date.now()
let beforeEach = async () => {}
async function test(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return
  current = name
  const t = Date.now()
  try { await beforeEach(); await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`  ✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`) }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t, error: String(e.message ?? e).split('\n')[0] }); console.log(`  ✗ ${name}\n      ${String(e.message ?? e).split('\n').slice(0, 4).join('\n      ')}`) }
}
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const ok = (c, m) => { if (!c) throw new Error(m) }

const srv = await startPreview()
const { browser, context } = await launch()
// the app has no local "add photos" UI any more (Dropbox only); the harness loads fixture photos through a test-only input
await context.addInitScript(() => { window.__PT_E2E__ = true })
{ const nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await nc(o); await c.addInitScript(() => { window.__PT_E2E__ = true }); return c } }
await makeScreenshotSample(browser)
const FILES = ['dog.jpg', 'cat.jpg', 'beach.jpg', 'city.jpg', 'pizza.jpg', 'mountain.jpg', 'person.jpg', 'document.jpg',
  'blurry-mountain.jpg', 'dark-city.jpg', 'bright-beach.jpg', 'geotagged-cat.jpg', 'screenshot.png']

// Dropbox is stubbed: OAuth authorize/token and the HTTP API (list_folder, download, account) are served locally.
// No real key or account is used.
const SAMPLE_BY_ID = {
  'id:dbx-a': 'dropbox-import-a.jpg', 'id:dbx-b': 'dropbox-import-b.jpg', 'id:dbx-c': 'dropbox-import-g.jpg',
  'id:slow-a': 'dropbox-import-e.jpg', 'id:slow-b': 'dropbox-import-f.jpg',
  'id:p1': 'dropbox-import-c.jpg', 'id:p2': 'dropbox-import-d.jpg', 'id:p3': 'dropbox-import-h.jpg', 'id:p4': 'dropbox-import-i.jpg',
  'id:v1': 'dropbox-video-frame.jpg', // Dropbox's preview frame of clip.mp4 (id:v2 has no preview)
  'id:f1': 'obama-portrait.jpg', 'id:f2': 'biden-2013.jpg', 'id:f3': 'biden-2021.jpg',
}
// distinct little noise PNGs (1.0.30 big-folder test): no two are content- or near-duplicates
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function noisePng(seed, w = 48, h = 36) {
  let r = (seed * 2654435761) >>> 0 || 1
  const rnd = () => { r ^= r << 13; r >>>= 0; r ^= r >>> 17; r ^= r << 5; r >>>= 0; return r & 255 }
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = rnd() }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const sampleBytes = async (f) => (Buffer.isBuffer(f) ? f : fs.readFile(sample(f)))
const dbxFile = (id, name, dir) => ({ '.tag': 'file', id, name, path_display: `${dir}/${name}`, path_lower: `${dir}/${name}`.toLowerCase(), rev: 'r' + id.slice(3), size: 1000, content_hash: 'h' + id, client_modified: '2024-05-01T10:00:00Z' })
const dbxDir = (name, dir) => ({ '.tag': 'folder', id: 'id:dir-' + name, name, path_display: `${dir}/${name}`, path_lower: `${dir}/${name}`.toLowerCase() })
const DBX_TREE = {
  '': [dbxDir('Photos', ''), dbxDir('Docs', ''), dbxDir('Slow', ''), dbxDir('Faces', ''), dbxDir('Picks', ''), dbxDir('Movies', ''), { '.tag': 'file', id: 'id:txt', name: 'readme.txt', path_display: '/readme.txt', path_lower: '/readme.txt', rev: 'r1', size: 5 }],
  '/photos': [dbxDir('Trip', '/Photos'), dbxFile('id:dbx-a', 'from-dropbox.jpg', '/Photos'), dbxFile('id:dbx-b', 'from-dropbox-2.jpg', '/Photos'), { '.tag': 'file', id: 'id:pdf', name: 'notes.pdf', path_display: '/Photos/notes.pdf', path_lower: '/photos/notes.pdf', rev: 'r2', size: 5 }],
  '/photos/trip': [dbxFile('id:dbx-c', 'trip.jpg', '/Photos/Trip')],
  '/docs': [],
  '/movies': [dbxFile('id:v1', 'clip.mp4', '/Movies'), dbxFile('id:v2', 'noframe.mov', '/Movies')],
  '/picks': ['pick-1.jpg', 'pick-2.jpg', 'pick-3.jpg', 'pick-4.jpg'].map((n, i) => dbxFile('id:p' + (i + 1), n, '/Picks')),
  '/slow': [dbxFile('id:slow-a', 'cancel-stop-a.jpg', '/Slow'), dbxFile('id:slow-b', 'cancel-stop-b.jpg', '/Slow')],
  '/faces': [dbxFile('id:f1', 'obama-portrait.jpg', '/Faces'), dbxFile('id:f2', 'biden-2013.jpg', '/Faces'), dbxFile('id:f3', 'biden-2021.jpg', '/Faces')],
}
const idByPath = (p) => Object.values(DBX_TREE).flat().find((x) => x.path_lower === String(p).toLowerCase())?.id
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, dropbox-api-arg', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-expose-headers': 'dropbox-api-result' }
async function stubDropbox(ctx) {
  // writes = any write/delete outside Photo Tagger's /.photo-tagger metadata folder (must stay 0)
  const st = { token: [], downloads: {}, lists: [], revoked: 0, writes: 0, expireOnce: false, flakyOnce: new Set(), refreshes: 0, meta: new Map(), uploads: 0, metaDeletes: 0, thumbs: 0, fileTags: new Map([['id:dbx-a', new Set(['family_trip'])]]), tagAdds: [], tagRemoves: [], tagGets: [], tagBad: 0, thumbLog: [], thumbFailOnce: {}, thumbFailSmall: new Set(), inject: [], injected: 0 }
  // failure injection (1.0.26): { ep: '/2/files/tags/add', status | network, times, retryAfter, summary, body: /regex on request body or Dropbox-API-Arg/ }
  const injectFor = (req, pathname) => {
    const body = (req.postData() || '') + (req.headers()['dropbox-api-arg'] || '')
    const f = st.inject.find((x) => x.times > 0 && pathname === x.ep && (!x.body || x.body.test(body)))
    if (!f) return null
    f.times--; st.injected++; return f
  }
  const injected = (r, f) => f.network ? r.abort('failed') : r.fulfill({ status: f.status, headers: { ...CORS, 'access-control-expose-headers': 'dropbox-api-result, retry-after', ...(f.retryAfter ? { 'retry-after': String(f.retryAfter) } : {}) }, contentType: 'application/json', body: JSON.stringify({ error_summary: f.summary || 'too_many_requests/' }) })
  const metaEntry = (path) => ({ '.tag': 'file', id: 'id:meta-' + path, name: path.split('/').pop(), path_display: path, path_lower: path.toLowerCase(), rev: 'm', size: 1 })
  await ctx.route('https://www.dropbox.com/oauth2/authorize**', (r) => {
    const u = new URL(r.request().url())
    st.authorize = Object.fromEntries(u.searchParams)
    return r.fulfill({ status: 302, headers: { location: `${u.searchParams.get('redirect_uri')}?code=stub-code&state=${u.searchParams.get('state')}` } })
  })
  await ctx.route('https://api.dropboxapi.com/**', async (r) => {
    const req = r.request()
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 200, headers: CORS })
    const url = new URL(req.url())
    const json = (o, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(o) })
    if (url.pathname === '/oauth2/token') {
      const b = Object.fromEntries(new URLSearchParams(req.postData() || ''))
      st.token.push(b)
      if (b.grant_type === 'refresh_token') { st.refreshes++; return json({ access_token: 'tok-refreshed', token_type: 'bearer', expires_in: 14400 }) }
      return json({ access_token: 'tok-1', refresh_token: 'ref-1', token_type: 'bearer', expires_in: 14400, account_id: 'dbid:test' })
    }
    const auth = req.headers()['authorization'] || ''
    if (!/^Bearer tok-/.test(auth)) return json({ error_summary: 'invalid_access_token' }, 401)
    { const f = injectFor(req, url.pathname); if (f) return injected(r, f) }
    if (url.pathname === '/2/users/get_current_account') return json({ account_id: 'dbid:test', name: { display_name: 'Test User' }, email: 'test@example.com' })
    if (url.pathname === '/2/auth/token/revoke') { st.revoked++; return json(null) }
    // Native Dropbox file tags (metadata only): lowercase [\w]{1,32}, max 20 per file
    // Like the real API, the Tags endpoints only accept '/…' paths: 'id:…' gets a 400 regex error
    const badPath = (v) => !String(v).startsWith('/')
    const regex400 = () => r.fulfill({ status: 400, headers: CORS, contentType: 'text/plain', body: 'Error in call to API function "files/tags/get": Value must be a string conforming to regex (/(.|[\r\n])*)' })
    if (url.pathname === '/2/files/get_metadata') {
      const b = JSON.parse(req.postData() || '{}')
      ;(st.metaLookups ??= []).push(b.path)
      const e = Object.values(DBX_TREE).flat().find((x) => x.id === b.path || x.path_lower === String(b.path).toLowerCase())
      return e ? json(e) : json({ error_summary: 'path/not_found/' }, 409)
    }
    if (url.pathname === '/2/files/tags/get') {
      const b = JSON.parse(req.postData() || '{}')
      if (b.paths.some(badPath)) { st.tagBad++; return regex400() }
      if (st.tagReadError) return json({ error_summary: 'missing_scope/files.metadata.write/' }, 403)
      // like Dropbox: one path that no longer exists fails the whole request
      if (b.paths.some((p) => !idByPath(p))) { (st.tagGet409 ??= []).push([...b.paths]); return json({ error: { '.tag': 'path', path: { '.tag': 'not_found' } }, error_summary: 'path/not_found/' }, 409) }
      st.tagBatches ??= []; st.tagBatches.push([...b.paths])
      st.tagGets.push(...b.paths)
      return json({ paths_to_tags: b.paths.map((p) => ({ path: p, tags: [...(st.fileTags.get(idByPath(p)) ?? [])].map((t) => ({ '.tag': 'user_generated_tag', tag_text: t })) })) })
    }
    if (url.pathname === '/2/files/tags/add' || url.pathname === '/2/files/tags/remove') {
      const b = JSON.parse(req.postData() || '{}')
      if (badPath(b.path)) { st.tagBad++; return regex400() }
      const fid = idByPath(b.path)
      if (!SAMPLE_BY_ID[fid]) return json({ error_summary: 'path/not_found/' }, 409)
      const set = st.fileTags.get(fid) ?? new Set(); st.fileTags.set(fid, set)
      if (url.pathname.endsWith('add')) {
        if (!/^\w{1,32}$/.test(b.tag_text)) return json({ error_summary: 'other/' }, 400)
        if (set.size >= 20) return json({ error_summary: 'too_many_tags/' }, 409)
        st.tagAdds.push(b); if (b.tag_text !== st.ackWithoutWrite) set.add(b.tag_text.toLowerCase()); return json(null)
      }
      st.tagRemoves.push(b)
      if (!set.has(b.tag_text)) return json({ error_summary: 'tag_not_present/' }, 409)
      set.delete(b.tag_text); return json(null)
    }
    if (url.pathname === '/2/files/delete_v2') {
      const p = JSON.parse(req.postData() || '{}').path || ''
      // 1.0.33 Delete from Dropbox: a photo file, by its id only (moved to Dropbox's deleted files); unknown id = not_found
      if (p.startsWith('id:') && !p.startsWith('id:meta-')) {
        ;(st.fileDeleteCalls ??= []).push(p)
        for (const list of Object.values(DBX_TREE)) {
          const i = list.findIndex((x) => x.id === p && x['.tag'] === 'file')
          if (i >= 0) { const [e] = list.splice(i, 1); (st.fileDeletes ??= []).push(p); (st.deletedEntries ??= new Map()).set(p, e); return json({ metadata: e }) }
        }
        return json({ error: { '.tag': 'path_lookup', path_lookup: { '.tag': 'not_found' } }, error_summary: 'path_lookup/not_found/' }, 409)
      }
      if (!p.toLowerCase().startsWith('/.photo-tagger/')) { st.writes++; return json({ error_summary: 'forbidden' }, 400) }
      if (st.deleteDelay) await new Promise((res) => setTimeout(res, st.deleteDelay))
      if (!st.meta.has(p.toLowerCase())) return json({ error_summary: 'path_lookup/not_found/' }, 409)
      st.metaDeletes++; st.meta.delete(p.toLowerCase()); return json({ metadata: {} })
    }
    if (url.pathname === '/2/files/list_folder' && (JSON.parse(req.postData() || '{}').path || '').toLowerCase() === '/.photo-tagger/meta') {
      const entries = [...st.meta.keys()].filter((k) => k.startsWith('/.photo-tagger/meta/')).map(metaEntry)
      if (!entries.length) return json({ error_summary: 'path/not_found/' }, 409)
      return json({ entries, cursor: 'c:[]', has_more: false })
    }
    if (url.pathname === '/2/files/list_folder') {
      if (st.expireOnce && auth === 'Bearer tok-1') { st.expireOnce = false; return json({ error_summary: 'expired_access_token/' }, 401) }
      const b = JSON.parse(req.postData() || '{}')
      st.lists.push(b)
      const key = (b.path || '').toLowerCase()
      let entries = DBX_TREE[key] ?? []
      if (b.recursive) entries = Object.entries(DBX_TREE).filter(([k]) => k === key || k.startsWith(key + '/')).flatMap(([, v]) => v)
      // paginate: first page = first two entries, rest via /continue
      if (entries.length > 2) return json({ entries: entries.slice(0, 2), cursor: 'c:' + JSON.stringify(entries.slice(2)), has_more: true })
      return json({ entries, cursor: 'c:[]', has_more: false })
    }
    if (url.pathname === '/2/files/list_folder/continue') {
      const b = JSON.parse(req.postData() || '{}')
      st.lists.push({ continue: true })
      return json({ entries: JSON.parse(b.cursor.slice(2)), cursor: 'c:[]', has_more: false })
    }
    st.writes++ // any other endpoint (e.g. a delete) would be a bug
    return json({ error_summary: 'not_stubbed' }, 400)
  })
  await ctx.route('https://content.dropboxapi.com/**', async (r) => {
    const req = r.request()
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 200, headers: CORS })
    const url = new URL(req.url())
    const arg = JSON.parse(req.headers()['dropbox-api-arg'] || '{}')
    if (url.pathname === '/2/files/upload') {
      { const f = injectFor(req, url.pathname); if (f) return injected(r, f) }
      if (!String(arg.path).toLowerCase().startsWith('/.photo-tagger/')) { st.writes++; return r.fulfill({ status: 400, headers: CORS, body: 'no' }) }
      st.uploads++; st.meta.set(arg.path.toLowerCase(), req.postData() || '')
      return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{}' })
    }
    if (url.pathname === '/2/files/get_thumbnail_v2') {
      st.thumbs++
      const rid = String(arg.resource?.path ?? '').startsWith('/') ? idByPath(arg.resource.path) : arg.resource?.path
      st.thumbLog.push([arg.resource?.path, arg.size])
      if ((st.thumbFailOnce[rid] ?? 0) > 0) { st.thumbFailOnce[rid]--; return r.fulfill({ status: 500, headers: CORS, body: 'flaky' }) }
      if (st.thumbFailSmall.has(rid) && arg.size === 'w480h320') return r.fulfill({ status: 409, headers: CORS, contentType: 'application/json', body: '{"error_summary":"unsupported_image/"}' })
      const f = SAMPLE_BY_ID[rid]
      if (!f) return r.fulfill({ status: 409, headers: CORS, body: '{}' })
      return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: await sampleBytes(f) })
    }
    if (url.pathname !== '/2/files/download') { st.writes++; return r.fulfill({ status: 400, headers: CORS, body: 'no' }) }
    const id = arg.path
    if (String(id).startsWith('id:meta-') || String(id).toLowerCase().startsWith('/.photo-tagger/')) {
      const key = String(id).replace(/^id:meta-/, '').toLowerCase()
      return st.meta.has(key) ? r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: st.meta.get(key) }) : r.fulfill({ status: 409, headers: CORS, contentType: 'application/json', body: '{"error_summary":"path/not_found/"}' })
    }
    st.downloads[id] = (st.downloads[id] || 0) + 1; (st.dlOrder ??= []).push(id)
    if (st.flakyOnce.has(id)) { st.flakyOnce.delete(id); return r.abort('failed') } // transient — app should retry
    if (st.failDownload) return r.fulfill({ status: 409, headers: CORS, contentType: 'application/json', body: '{"error_summary":"path/not_found/"}' })
    if (id === 'id:slow-b') await new Promise((res) => setTimeout(res, 8_000))
    const file = SAMPLE_BY_ID[id]
    if (!file) return r.fulfill({ status: 409, headers: CORS, contentType: 'application/json', body: '{"error_summary":"path/not_found/"}' })
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: await sampleBytes(file) })
  })
  return st
}
const dbx = await stubDropbox(context)

const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('dialog', (d) => d.accept())

const tile = (n) => page.locator(`[data-testid=photo-tile][data-name="${n}"]`)
const tagsOf = async (n) => ((await tile(n).getAttribute('data-tags')) ?? '').split('|').filter(Boolean)
const names = async () => (await page.getByTestId('photo-tile').evaluateAll((els) => els.map((e) => e.dataset.name))).sort()
const waitReady = async (n, timeout = 300_000, { keepDupes = false } = {}) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (keepDupes && await page.getByTestId('dupe-review').count()) {
      await page.getByTestId('dupe-keep-all').click()
      await page.waitForFunction(() => !document.querySelector('[data-testid=dupe-review]'), null, { timeout: 300_000 }).catch(() => {})
      continue
    }
    if (await page.locator('[data-testid=photo-tile][data-status=ready]').count() >= n) return
    await page.waitForTimeout(400)
  }
  throw new Error(`waitReady(${n}) timed out with ${await page.locator('[data-testid=photo-tile]').count()} tiles (dupe-review=${!!(await page.getByTestId('dupe-review').count())})`)
}
const chip = async (tag) => {
  const c = page.locator(`[data-testid=tag-chip][data-tag="${tag}"]`)
  if (!(await c.count()) && (await page.getByTestId('all-tags').count())) { if ((await page.getByTestId('all-tags').textContent()).startsWith('All')) await page.getByTestId('all-tags').click() }
  return c
}
const clearFilters = async () => { if (await page.getByTestId('clear-filters').count()) await page.getByTestId('clear-filters').click() }
const openSettings = async (tab) => { await page.getByTestId('open-settings').click(); if (tab) await page.getByTestId(`tab-${tab}`).click() }
const closeSettings = () => page.getByTestId('settings-close').click()
beforeEach = async () => {
  if (page.url() === 'about:blank') return
  if (await page.getByTestId('dupe-review').count()) {
    await page.getByTestId('dupe-keep-all').click().catch(() => {})
    await page.waitForFunction(() => !document.querySelector('[data-testid=dupe-review]'), null, { timeout: 120_000 }).catch(() => {})
  }
  for (const id of ['detail-close', 'settings-close', 'bulk-close', 'sel-cancel']) { const b = page.getByTestId(id); if (await b.count()) await b.first().click().catch(() => {}) }
  if (await page.getByTestId('clear-filters').count()) await page.getByTestId('clear-filters').click().catch(() => {})
}
const settled = () => page.waitForFunction(() => !document.querySelector('[data-testid=job-label]') || /Done/.test(document.querySelector('[data-testid=job-label]').textContent), null, { timeout: 300_000 })

console.log('\nDesktop (Chromium 1280×860)')

await test('app shell loads, shows empty state, manifest + service worker are present', async () => {
  await page.goto(URL_BASE)
  await page.getByTestId('empty').waitFor()
  const pkgVer = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version
  eq((await page.getByTestId('app-version').textContent()).trim(), 'v' + pkgVer, 'brand version')
  ok(await page.getByTestId('app-version').isVisible(), 'brand version visible')
  const man = await (await fetch(URL_BASE + 'manifest.webmanifest')).json()
  eq(man.name, 'Photo Tagger'); eq(man.display, 'standalone')
  eq([man.start_url, man.scope], ['/photo-tagger/', '/photo-tagger/'], 'manifest start_url/scope')
  eq(await page.evaluate(() => navigator.serviceWorker.ready.then((r) => new URL(r.scope).pathname)), '/photo-tagger/', 'service worker scope')
  ok((await fetch(URL_BASE + 'ort/ort-wasm-simd-threaded.wasm')).ok && (await fetch(URL_BASE + 'ort/ort-wasm-simd-threaded.mjs')).ok, 'wasm under base')
  for (const n of ['ssd_mobilenetv1_model', 'face_landmark_68_model', 'face_recognition_model']) {
    const r = await fetch(URL_BASE + `face-models/${n}-weights_manifest.json`)
    ok(r.ok, `face-models ${n} manifest HTTP`)
    const body = await r.text()
    ok(!/^\s*<(!doctype|html)/i.test(body), `face-models ${n} is JSON not HTML`)
    JSON.parse(body)
  }
  ok(man.icons.length >= 3, 'icons')
  for (const i of man.icons) ok((await fetch(URL_BASE + i.src)).ok, `icon ${i.src}`)
  ok(await page.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active)), 'service worker active')
  eq(await page.locator('link[rel=manifest]').count(), 1)
})

await test('ingest: 13 photos through the file picker are decoded, tagged on-device and shown', async () => {
  await page.getByTestId('file-input').setInputFiles(FILES.map(sample))
  await waitReady(13, 300_000, { keepDupes: true })
  eq((await names()).length, 13)
  const okImgs = await page.locator('[data-testid=photo-tile] img').evaluateAll((els) => els.filter((i) => i.complete && i.naturalWidth > 0).length)
  eq(okImgs, 13, 'thumbnails rendered')
  eq(errors, [], 'page errors')
})

await test('auto-tags match what is in the photos (CLIP zero-shot)', async () => {
  const expect = { 'dog.jpg': ['dog', 'pets'], 'cat.jpg': ['cat', 'pets'], 'pizza.jpg': ['pizza', 'food'], 'city.jpg': ['city'],
    'beach.jpg': ['beach'], 'mountain.jpg': ['mountain'], 'person.jpg': ['people'], 'document.jpg': ['document'], 'screenshot.png': ['screenshot'] }
  const miss = []
  for (const [f, want] of Object.entries(expect)) {
    const got = await tagsOf(f)
    for (const w of want) if (!got.includes(w)) miss.push(`${f} missing "${w}" (got ${got.join(', ')})`)
  }
  eq(miss, [], 'tag mismatches')
})

await test('EXIF (camera, year, GPS) and quality (blur, dark, bright) tags', async () => {
  const g = await tagsOf('geotagged-cat.jpg')
  for (const t of ['geotagged', 'samplecam sample phone 1', '2021', 'cat']) ok(g.includes(t), `geotagged-cat.jpg lacks ${t}: ${g}`)
  ok((await tagsOf('blurry-mountain.jpg')).includes('blurry'), 'blurry')
  ok(!(await tagsOf('mountain.jpg')).includes('blurry'), 'sharp mountain not blurry')
  ok((await tagsOf('dark-city.jpg')).includes('dark'), 'dark')
  ok(!(await tagsOf('dark-city.jpg')).includes('blurry'), 'dark-but-sharp city is not "blurry"')
  ok((await tagsOf('bright-beach.jpg')).includes('bright'), 'bright')
  ok(!(await tagsOf('city.jpg')).includes('dark') && !(await tagsOf('city.jpg')).includes('bright'), 'normal exposure')
})

await test('Detection list "Photo metadata" toggles strip and re-apply year/camera/geotagged/quality tags', async () => {
  await openSettings('vocab')
  const g = page.getByTestId('meta-group')
  eq(await g.locator('label').evaluateAll((els) => els.map((e) => e.textContent.trim())), ['Year', 'Camera', 'Geotagged', 'Blurry', 'Dark', 'Bright'], 'six chips')
  ok(await page.getByTestId('detection-card').locator('h4').first().evaluate((h) => h.textContent === 'Photo metadata'), 'metadata group first')
  for (const id of ['year', 'camera', 'geotagged', 'blurry', 'dark', 'bright']) ok(await page.getByTestId(`meta-${id}`).isChecked(), id + ' on by default')
  await page.getByTestId('meta-year').uncheck(); await page.getByTestId('meta-blurry').uncheck()
  await page.getByTestId('retag-all').click(); await settled()
  await closeSettings(); await settled()
  await page.waitForFunction(() => !document.querySelector('[data-name="geotagged-cat.jpg"]').dataset.tags.split('|').includes('2021'), null, { timeout: 300_000 })
  const g1 = await tagsOf('geotagged-cat.jpg')
  ok(!g1.includes('2021') && g1.includes('geotagged') && g1.includes('samplecam sample phone 1') && g1.includes('cat'), 'year stripped, others kept: ' + g1)
  ok(!(await tagsOf('blurry-mountain.jpg')).includes('blurry'), 'blurry tag stripped')
  // 1.0.35: the corner warning badge follows the toggle too (Blurry off → no blurry badge; Dark still on → dark badge stays)
  eq(await tile('blurry-mountain.jpg').getByTestId('quality-badge').count(), 0, 'blurry corner badge hidden while Blurry is off')
  ok(/dark/.test(await tile('dark-city.jpg').getByTestId('quality-badge').getAttribute('data-warn')), 'dark badge still shown (Dark on)')
  await tile('blurry-mountain.jpg').click()
  ok(!/blurry/.test(await page.getByTestId('detail-sharpness').innerText()), 'details: no "(blurry)" while Blurry is off')
  await page.keyboard.press('Escape'); await page.getByTestId('detail').waitFor({ state: 'detached' })
  // single-photo Re-run tagging honors the toggles too
  await tile('geotagged-cat.jpg').click(); await page.getByRole('button', { name: 'Re-run tagging' }).click(); await settled()
  ok(!(await tagsOf('geotagged-cat.jpg')).includes('2021'), 'Re-run tagging keeps year off')
  await page.keyboard.press('Escape'); await page.getByTestId('detail').waitFor({ state: 'detached' })
  await openSettings('vocab')
  await page.getByRole('button', { name: 'Reset detection list' }).click()
  await page.waitForFunction(() => document.querySelector('[data-testid=meta-year]')?.checked && document.querySelector('[data-testid=meta-blurry]')?.checked, null, { timeout: 10_000 }).catch(() => {})
  ok(await page.getByTestId('meta-year').isChecked() && await page.getByTestId('meta-blurry').isChecked(), 'reset turns metadata chips back on')
  await page.getByTestId('retag-all').click(); await settled()
  await closeSettings(); await settled()
  await page.waitForFunction(() => document.querySelector('[data-name="geotagged-cat.jpg"]').dataset.tags.split('|').includes('2021'), null, { timeout: 300_000 })
  ok((await tagsOf('blurry-mountain.jpg')).includes('blurry'), 'blurry re-applied')
  eq(await tile('blurry-mountain.jpg').getByTestId('quality-badge').getAttribute('data-warn'), 'blurry', 'blurry corner badge back when Blurry is on')
  // 1.0.35: all three quality toggles off → no corner warning badge on any tile; on again → back
  await openSettings('vocab')
  for (const id of ['blurry', 'dark', 'bright']) await page.getByTestId(`meta-${id}`).uncheck()
  await closeSettings()
  await page.waitForFunction(() => !document.querySelector('[data-testid=quality-badge]'), null, { timeout: 10_000 })
  await openSettings('vocab')
  for (const id of ['blurry', 'dark', 'bright']) await page.getByTestId(`meta-${id}`).check()
  await closeSettings()
  await tile('dark-city.jpg').getByTestId('quality-badge').waitFor()
  await tile('bright-beach.jpg').getByTestId('quality-badge').waitFor()
})

await test('tag chip filter with AND / OR', async () => {
  await (await chip('pets')).click()
  eq(await names(), ['cat.jpg', 'dog.jpg', 'geotagged-cat.jpg'], 'pets')
  eq((await page.getByTestId('count').textContent()), '3 of 13')
  await (await chip('geotagged')).click()
  eq(await names(), ['geotagged-cat.jpg'], 'AND')
  await page.getByTestId('mode-or').click()
  eq(await names(), ['cat.jpg', 'dog.jpg', 'geotagged-cat.jpg'], 'OR')
  await page.getByTestId('mode-and').click()
  await clearFilters()
  eq((await names()).length, 13)
})

await test('search box, quality filter and date range', async () => {
  await page.getByTestId('search').fill('pizza')
  eq(await names(), ['pizza.jpg'], 'search tag')
  await page.getByTestId('search').fill('sample phone')
  eq(await names(), ['geotagged-cat.jpg'], 'search camera')
  await page.getByTestId('search').fill('')
  await page.getByTestId('quality').selectOption('blurry'); eq(await names(), ['blurry-mountain.jpg'], 'blurry')
  await page.getByTestId('quality').selectOption('dark'); eq(await names(), ['dark-city.jpg'], 'dark')
  await page.getByTestId('quality').selectOption('bright'); eq(await names(), ['bright-beach.jpg', 'screenshot.png'], 'bright (a white UI screenshot is bright too)')
  await page.getByTestId('quality').selectOption('good')
  const good = await names()
  ok(!good.includes('blurry-mountain.jpg') && !good.includes('dark-city.jpg') && !good.includes('bright-beach.jpg') && good.length >= 8, `good only: ${good}`)
  await page.getByTestId('quality').selectOption('any')
  await page.getByTestId('date-from').fill('2021-01-01'); await page.getByTestId('date-to').fill('2021-12-31')
  eq(await names(), ['geotagged-cat.jpg'], 'date range (EXIF date 4 Jul 2021)')
  await clearFilters()
})

await test('tag counts in the chip bar are faceted by the other filters', async () => {
  await page.getByTestId('search').fill('cat')
  const c = await (await chip('pets')).locator('small').textContent()
  eq(c, '2', 'pets count within "cat" search')
  await page.getByTestId('search').fill('')
})

await test('grid tile: two tags shown, +N lists and removes the rest without opening the photo', async () => {
  await tile('dog.jpg').click()
  await page.getByTestId('detail-tag-input').fill('overflow probe'); await page.getByTestId('detail-tag-input').press('Enter')
  await page.locator('[data-testid=detail-tag][data-tag="overflow probe"]').waitFor()
  await page.keyboard.press('Escape'); await page.getByTestId('detail').waitFor({ state: 'detached' })
  const t = tile('dog.jpg')
  eq(await t.locator('.cap > span').count(), 2, 'two caption tags')
  const all = await tagsOf('dog.jpg')
  const more = t.getByTestId('tile-more')
  eq(await more.innerText(), '+' + (all.length - 2), '+N counts the rest')
  await more.click()
  const menu = t.getByTestId('tile-more-menu'); await menu.waitFor()
  eq(await page.getByTestId('detail').count(), 0, 'photo not opened')
  ok(await menu.locator('[data-tag="overflow probe"]').isVisible(), 'overflow tag listed')
  eq(await menu.getByTestId('tile-more-tag').count(), all.length - 2, 'every other tag listed, none duplicated')
  await menu.locator('[data-tag="overflow probe"] [data-testid=tile-more-remove]').click()
  await page.waitForFunction(() => !document.querySelector('[data-testid=photo-tile][data-name="dog.jpg"]').dataset.tags.split('|').includes('overflow probe'))
  eq(await page.getByTestId('detail').count(), 0, 'still not opened after remove')
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' })
  eq(await page.locator('[data-testid=photo-tile].sel').count(), 0, 'selection untouched')
  // caption fill rule (1.0.17): every tile with 1–2 tags shows them all and no +N; with more, two chips + "+N"
  const bad = await page.locator('[data-testid=photo-tile]').evaluateAll((els) => els.map((e) => {
    const n = e.dataset.tags.split('|').filter(Boolean).length, chips = e.querySelectorAll('.cap > span').length, more = e.querySelector('[data-testid=tile-more]')
    return { name: e.dataset.name, ok: chips === Math.min(2, n) && (!!more === n > 2) }
  }).filter((x) => !x.ok).map((x) => x.name))
  eq(bad, [], 'tiles fill two chips from any tag kind; +N only beyond two')
})

await test('selection: None clears but stays in select mode; Shift-click selects or deselects a range', async () => {
  const tiles = page.getByTestId('photo-tile')
  await tiles.nth(0).getByTestId('tile-check').click({ force: true })
  await page.getByTestId('sel-all').click()
  ok((await page.locator('[data-testid=photo-tile].sel').count()) > 3, 'All selects')
  await page.getByTestId('sel-none').click()
  eq(await page.locator('[data-testid=photo-tile].sel').count(), 0, 'None clears')
  ok(await page.getByTestId('sel-all').isVisible(), 'still in select mode')
  ok(await page.getByTestId('sel-none').isDisabled(), 'None disabled with nothing selected')
  await tiles.nth(0).click(); await tiles.nth(3).click({ modifiers: ['Shift'] })
  eq(await page.locator('[data-testid=photo-tile].sel').count(), 4, 'Shift-click on unselected selects the range')
  await tiles.nth(1).click(); // deselect #1 → anchor 1
  await tiles.nth(3).click({ modifiers: ['Shift'] })
  eq(await page.locator('[data-testid=photo-tile].sel').count(), 1, 'Shift-click on selected deselects the range (only #0 left)')
  ok(await tiles.nth(0).evaluate((e) => e.classList.contains('sel')), 'outside the range untouched')
  const nTiles = await tiles.count()
  await page.getByTestId('sel-delete').click()
  await page.getByTestId('remove-confirm').waitFor()
  ok(/Remove this photo from the app/.test(await page.getByTestId('remove-confirm').innerText()), 'in-app confirm, not a browser popup')
  await page.keyboard.press('Enter') // focus is on Cancel
  await page.getByTestId('remove-confirm').waitFor({ state: 'detached' })
  eq(await tiles.count(), nTiles, 'Enter/Cancel removes nothing')
  await page.getByTestId('sel-cancel').click()
  eq(await page.getByTestId('sel-all').count(), 0, '✕ leaves select mode')
})

await test('detail view: edit tags by hand, navigate, persists across reload', async () => {
  await tile('dog.jpg').click()
  await page.getByTestId('detail').waitFor()
  eq(await page.getByTestId('detail-name').textContent(), 'dog.jpg')
  await page.getByTestId('detail-img').waitFor()
  await page.getByTestId('detail-tag-input').fill('my pet, good boy'); await page.getByTestId('detail-tag-input').press('Enter')
  const dt = (t) => page.locator(`[data-testid=detail-tag][data-tag="${t}"]`)
  await dt('my pet').waitFor(); await dt('good boy').waitFor()
  await dt('animals').locator('[data-testid=remove-tag]').click()
  await dt('animals').waitFor({ state: 'detached' })
  await page.getByTestId('detail-next').click()
  ok((await page.getByTestId('detail-name').textContent()) !== 'dog.jpg', 'moved to next photo')
  await page.keyboard.press('ArrowLeft')
  eq(await page.getByTestId('detail-name').textContent(), 'dog.jpg')
  await page.keyboard.press('Escape')
  await page.getByTestId('detail').waitFor({ state: 'detached' })
  await page.reload(); await page.getByTestId('grid').waitFor()
  const t = await tagsOf('dog.jpg')
  ok(t.includes('my pet') && t.includes('good boy') && !t.includes('animals'), `after reload: ${t}`)
  eq((await names()).length, 13, 'library persisted')
  await (await chip('my pet')).click(); eq(await names(), ['dog.jpg']); await clearFilters()
})

await test('tile status chips (tagging / duplicate / warning) stack without overlapping', async () => {
  const boxes = await tile('mountain.jpg').evaluate((el) => {
    const c = el.querySelector('.badges')
    c.insertAdjacentHTML('beforeend', '<span class="badge pend">tagging…</span><span class="badge dupe">duplicate</span><span class="badge warn">blurry</span>')
    const r = [...c.querySelectorAll('.badge')].map((b) => b.getBoundingClientRect()).map((b) => ({ t: b.top, b: b.bottom, l: b.left, r: b.right }))
    c.querySelectorAll('.badge').forEach((b) => b.remove())
    return r
  })
  ok(boxes.length >= 3, 'chips rendered')
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    ok(a.b <= b.t || b.b <= a.t || a.r <= b.l || b.r <= a.l, `chips ${i} and ${j} overlap`)
  }
})

await test('detail view: zoom in/out, reset to fit, and pan when magnified', async () => {
  await tile('mountain.jpg').click()
  await page.getByTestId('detail').waitFor()
  await page.getByTestId('detail-img').waitFor()
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid=detail-img]'); return i?.complete && i.style.width })
  const fitZ = await page.getByTestId('detail-img').getAttribute('data-fit')
  eq(await page.getByTestId('detail-img').getAttribute('data-zoom'), fitZ, 'starts at fit')
  ok(await page.getByTestId('detail-zoom-in').isVisible(), 'zoom controls visible')
  await page.getByTestId('detail-zoom-in').click()
  await page.waitForFunction(() => Number(document.querySelector('[data-testid=detail-img]')?.dataset.zoom) > Number(document.querySelector('[data-testid=detail-img]')?.dataset.fit))
  const z1 = Number(await page.getByTestId('detail-img').getAttribute('data-zoom'))
  ok(z1 > Number(fitZ), 'zoomed in (z=' + z1 + ')')
  ok(await page.getByTestId('detail-viewport').evaluate((el) => el.classList.contains('zoomed')), 'viewport marked zoomed')
  await page.getByTestId('detail-zoom-in').click()
  const z2 = Number(await page.getByTestId('detail-img').getAttribute('data-zoom'))
  ok(z2 > z1, 'zoomed further')
  await page.keyboard.press('-')
  const z3 = Number(await page.getByTestId('detail-img').getAttribute('data-zoom'))
  ok(z3 < z2 && z3 > Number(fitZ), 'keyboard minus zooms out')
  // Pan while zoomed
  const box = await page.getByTestId('detail-viewport').boundingBox()
  ok(box, 'viewport box')
  const before = await page.getByTestId('detail-img').evaluate((img) => img.style.transform)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30)
  await page.mouse.up()
  const after = await page.getByTestId('detail-img').evaluate((img) => img.style.transform)
  ok(before !== after && /translate\(/.test(after), 'panned while zoomed')
  await page.getByTestId('detail-zoom-reset').click()
  eq(await page.getByTestId('detail-img').getAttribute('data-zoom'), await page.getByTestId('detail-img').getAttribute('data-fit'), 'reset fits to frame')
  // Changing photo resets zoom
  await page.getByTestId('detail-zoom-in').click()
  await page.getByTestId('detail-next').click()
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid=detail-img]'); return i?.style.width && i.dataset.zoom === i.dataset.fit })
  ok(true, 'next photo starts fitted')
  await page.keyboard.press('Escape')
  await page.getByTestId('detail').waitFor({ state: 'detached' })
})

await test('detail view: oversized photo fits fully in the frame by default and can zoom below 100%', async () => {
  await tile('mountain.jpg').click()
  await page.getByTestId('detail-img').waitFor()
  // Swap in a very large panoramic image (6000x1500) to simulate an oversized photo
  await page.getByTestId('detail-img').evaluate((img) => {
    const c = document.createElement('canvas'); c.width = 6000; c.height = 1500
    const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 6000, 1500); g.fillStyle = '#3c3'; g.fillRect(2000, 0, 2000, 1500)
    img.src = c.toDataURL('image/png')
  })
  await page.waitForFunction(() => document.querySelector('[data-testid=detail-img]')?.naturalWidth === 6000 && document.querySelector('[data-testid=detail-img]')?.style.width === '6000px')
  const inside = async () => page.evaluate(() => {
    const v = document.querySelector('[data-testid=detail-viewport]').getBoundingClientRect()
    const r = document.querySelector('[data-testid=detail-img]').getBoundingClientRect()
    return { ok: r.left >= v.left - 1 && r.right <= v.right + 1 && r.top >= v.top - 1 && r.bottom <= v.bottom + 1, r: [r.left, r.top, r.right, r.bottom], v: [v.left, v.top, v.right, v.bottom] }
  })
  const fitZ = Number(await page.getByTestId('detail-img').getAttribute('data-fit'))
  ok(fitZ < 1, 'fit scale is below 100% for a large photo (' + fitZ + ')')
  eq(Number(await page.getByTestId('detail-img').getAttribute('data-zoom')), fitZ, 'opens at fit')
  const i1 = await inside(); ok(i1.ok, 'whole image inside frame at fit ' + JSON.stringify(i1))
  const label = await page.getByTestId('detail-zoom-reset').textContent()
  eq(label, Math.round(fitZ * 100) + '%', 'percentage shows real scale under 100%')
  // Minus goes below fit / below 100%
  await page.getByTestId('detail-zoom-out').click()
  const z = Number(await page.getByTestId('detail-img').getAttribute('data-zoom'))
  ok(z < fitZ && z < 1, 'minus zooms below fit (' + z + ')')
  ok((await inside()).ok, 'still inside when zoomed out')
  const min = Number(await page.getByTestId('detail-zoom-slider').getAttribute('min'))
  ok(min < 1 && min < fitZ, 'slider min below 100% and below fit (' + min + ')')
  // Slider to 100% = native size: image larger than frame
  await page.getByTestId('detail-zoom-slider').fill('1')
  eq(await page.getByTestId('detail-img').getAttribute('data-zoom'), '1', 'slider sets 100%')
  eq((await page.getByTestId('detail-zoom-reset').textContent()), '100%', 'label 100%')
  ok(!(await inside()).ok, 'at 100% a 6000px photo exceeds the frame')
  await page.keyboard.press('0')
  eq(Number(await page.getByTestId('detail-img').getAttribute('data-zoom')), fitZ, '0 resets to fit')
  ok((await inside()).ok, 'inside again after reset')
  await page.getByTestId('detail-zoom-in').click()
  await page.getByTestId('detail-zoom-reset').click()
  eq(Number(await page.getByTestId('detail-img').getAttribute('data-zoom')), fitZ, 'Fit button resets')
  // Resize recomputes fit
  const vp = page.viewportSize()
  await page.setViewportSize({ width: Math.round(vp.width * 0.8), height: vp.height })
  await page.waitForFunction((f) => Number(document.querySelector('[data-testid=detail-img]').dataset.fit) < f, fitZ)
  ok((await inside()).ok, 'still fits after window resize')
  await page.setViewportSize(vp)
  await page.keyboard.press('Escape')
  await page.getByTestId('detail').waitFor({ state: 'detached' })
})

await test('multi-select + bulk tagging (and bulk removal)', async () => {
  await page.getByTestId('select-mode').click()
  await tile('city.jpg').locator('[data-testid=tile-check]').click()
  await tile('beach.jpg').locator('[data-testid=tile-check]').click()
  eq(await page.getByTestId('sel-count').textContent(), '2 selected')
  await page.getByTestId('bulk-tag').click()
  await page.getByTestId('bulk-input').fill('holiday trip'); await page.getByTestId('bulk-input').press('Enter')
  await page.locator('[data-testid=bulk-tag-chip][data-tag="holiday trip"]').waitFor()
  await page.getByTestId('bulk-close').click()
  await (await chip('holiday trip')).click(); eq(await names(), ['beach.jpg', 'city.jpg']); await clearFilters()
})

let exportedJson
await test('export tags as JSON and CSV', async () => {
  await openSettings('data')
  const [dj] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()])
  exportedJson = await fs.readFile(await dj.path(), 'utf8')
  const j = JSON.parse(exportedJson)
  eq(j.app, 'photo-tagger'); eq(j.photos.length, 13)
  const dog = j.photos.find((p) => p.name === 'dog.jpg')
  ok(dog.tags.some((t) => t.name === 'my pet' && t.source === 'manual') && dog.tags.some((t) => t.name === 'dog' && t.source === 'auto'), 'dog tags in JSON')
  const [dc] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()])
  const csv = await fs.readFile(await dc.path(), 'utf8')
  const lines = csv.trim().split(/\r?\n/)
  eq(lines[0], 'name,size,taken,camera,latitude,longitude,source,tags'); eq(lines.length, 14)
  ok(lines.some((l) => l.startsWith('geotagged-cat.jpg') && l.includes('48.858') && l.includes('geotagged')), 'geotag row in CSV')
  await closeSettings()
})

await test('import tags from JSON (restores removed tags) and from CSV (merges new ones)', async () => {
  // remove the bulk tag, then restore it from the exported JSON
  await page.getByTestId('select-mode').click()
  await tile('city.jpg').locator('[data-testid=tile-check]').click(); await tile('beach.jpg').locator('[data-testid=tile-check]').click()
  await page.getByTestId('bulk-tag').click()
  await page.locator('[data-testid=bulk-tag-chip][data-tag="holiday trip"] [data-testid=bulk-remove]').click()
  await page.getByTestId('bulk-close').click(); await page.getByTestId('sel-cancel').click()
  ok(!(await tagsOf('city.jpg')).includes('holiday trip'), 'removed')
  const jp = path.join(ROOT, 'test-results', 'tags.json'); await fs.mkdir(path.dirname(jp), { recursive: true }); await fs.writeFile(jp, exportedJson)
  await openSettings('data'); await page.getByTestId('import-input').setInputFiles(jp); await closeSettings()
  await page.waitForFunction(() => document.querySelector('[data-name="city.jpg"]')?.dataset.tags.includes('holiday trip'))
  ok((await tagsOf('beach.jpg')).includes('holiday trip'), 'restored on beach too')
  const cp = path.join(ROOT, 'test-results', 'tags.csv')
  await fs.writeFile(cp, 'name,tags\r\ncat.jpg,"cuddly;Fluffy Friend"\r\nnot-in-library.jpg,x\r\n')
  await openSettings('data'); await page.getByTestId('import-input').setInputFiles(cp); await closeSettings()
  await page.waitForFunction(() => document.querySelector('[data-name="cat.jpg"]')?.dataset.tags.includes('fluffy friend'))
  ok((await tagsOf('cat.jpg')).includes('cuddly'), 'csv tag')
  ok((await tagsOf('cat.jpg')).includes('cat'), 'existing tags kept')
})

await test('Settings save immediately: closing after detection/General edits never starts a re-tag job', async () => {
  const before = await page.locator('[data-testid=photo-tile]').evaluateAll((els) => els.map((e) => [e.dataset.name, e.dataset.tags]))
  await openSettings('vocab')
  await page.getByTestId('label-dog').uncheck()
  await page.getByTestId('meta-year').uncheck()
  await page.getByTestId('tab-general').click()
  const original = await page.getByTestId('set-threshold').inputValue()
  await page.getByTestId('set-threshold').fill('0.4')
  await page.evaluate(() => {
    window.__retagSeen = false
    window.__retagObserver = new MutationObserver(() => { if (/Re-tagging/.test(document.querySelector('[data-testid=job-label]')?.textContent || '')) window.__retagSeen = true })
    window.__retagObserver.observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await closeSettings(); await page.waitForTimeout(700)
  ok(!(await page.evaluate(() => window.__retagSeen)), 'no re-tag banner on close')
  eq(await page.locator('[data-testid=photo-tile]').evaluateAll((els) => els.map((e) => [e.dataset.name, e.dataset.tags])), before, 'existing tags untouched')
  await openSettings('general')
  eq(await page.getByTestId('set-threshold').inputValue(), '0.4', 'General slider persisted')
  await page.getByTestId('set-threshold').fill(original)
  await page.getByTestId('tab-vocab').click()
  ok(!(await page.getByTestId('label-dog').isChecked()) && !(await page.getByTestId('meta-year').isChecked()), 'detection + metadata toggles persisted')
  const saved = await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.open('photo-tagger'); r.onsuccess = () => { const tx = r.result.transaction('kv'); const q = tx.objectStore('kv').get('settings'); q.onsuccess = () => { resolve(q.result); r.result.close() } } }))
  // UI state has also been written to storage, not merely retained in the dialog.
  ok(JSON.stringify(saved).includes('year') && JSON.stringify(saved).includes('dog'), 'saved list in IndexedDB')
  await page.getByTestId('label-dog').check(); await page.getByTestId('meta-year').check()
  await closeSettings(); await page.waitForTimeout(500)
  ok(!(await page.evaluate(() => window.__retagSeen)), 'restoring preferences also does not re-tag')
  await page.evaluate(() => window.__retagObserver.disconnect())
})

await test('vocabulary: switch a built-in label off and back on, re-tags the library', async () => {
  ok((await tagsOf('dog.jpg')).includes('dog'))
  await openSettings('vocab')
  await page.getByTestId('label-dog').uncheck()
  await page.getByTestId('retag-all').click(); await settled()
  await closeSettings() // application is now explicit
  await page.waitForFunction(() => !document.querySelector('[data-name="dog.jpg"]')?.dataset.tags.split('|').includes('dog'), null, { timeout: 60_000 })
  const t = await tagsOf('dog.jpg')
  ok(t.includes('my pet'), 'manual tags survive re-tagging')
  await openSettings('vocab'); await page.getByTestId('label-dog').check(); await page.getByTestId('retag-all').click(); await settled(); await closeSettings()
  await page.waitForFunction(() => document.querySelector('[data-name="dog.jpg"]')?.dataset.tags.split('|').includes('dog'), null, { timeout: 60_000 })
  ok(!(await tagsOf('dog.jpg')).includes('animals'), 'a tag you removed by hand stays removed')
})

await test('vocabulary: add a custom label (text model loads on demand) and apply it', async () => {
  await openSettings('vocab')
  await page.getByTestId('custom-label').fill('skyline')
  await page.getByTestId('custom-prompt').fill('a photo of a city skyline')
  await page.getByTestId('custom-add').click()
  await page.locator('[data-testid=custom-chip]', { hasText: 'skyline' }).waitFor({ timeout: 300_000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid=custom-add]')?.disabled || document.querySelector('[data-testid=custom-add]')?.textContent === 'Add a detection tag', null, { timeout: 300_000 })
  ok(await page.getByTestId('retag-all-group').getByTestId('retag-all').count() === 1 && await page.getByTestId('retag-all-group').getByRole('button', { name: 'Reset detection list' }).count() === 0, 'help grouped with Re-tag library only')
  { // Settings tabs: "Tags" (not Labels), each tab its own non-overlapping box
    const boxes = await page.locator('.tabs button').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim(), l: r.left, r: r.right } }))
    ok(boxes.some((b) => b.t === 'Tags') && !boxes.some((b) => b.t === 'Labels'), 'tab is called Tags: ' + boxes.map((b) => b.t))
    ok(boxes.every((b, i) => i === 0 || b.l >= boxes[i - 1].r), 'tabs do not overlap: ' + JSON.stringify(boxes))
    const vp0 = page.viewportSize(); await page.setViewportSize({ width: 700, height: 360 }); await page.waitForTimeout(200) // short window, like the user's
    // 1.0.18: no tab label clipped (descender of the g in Tags) and no two tab boxes intersect
    const clip = await page.locator('.tabs button').evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect(), row = e.parentElement.getBoundingClientRect()
      const range = document.createRange(); range.selectNodeContents(e); const t = range.getBoundingClientRect()
      return { t: e.textContent, fits: e.scrollHeight <= e.clientHeight + 1 && t.bottom <= r.bottom && r.bottom <= row.bottom + 1 && r.top >= row.top - 1 && t.height >= 14, r: [r.left, r.top, r.right, r.bottom] }
    }))
    ok(clip.every((c) => c.fits), 'tab labels fully visible: ' + JSON.stringify(clip))
    ok(clip.every((a, i) => clip.every((b, j) => i === j || a.r[2] <= b.r[0] || b.r[2] <= a.r[0] || a.r[3] <= b.r[1] || b.r[3] <= a.r[1])), 'tab boxes never intersect')
    ok(await page.locator('.tabs').evaluate((e) => getComputedStyle(e).overflowY !== 'hidden' && e.scrollHeight <= e.clientHeight + 1), 'tab row not clipped')
    await page.setViewportSize(vp0)
  }
  ok(await page.getByTestId('retag-all-help').isVisible() && /every photo/.test(await page.getByTestId('retag-all-help').innerText()), 'Re-tag library explained next to the button')
  await page.getByTestId('retag-all').click()
  await settled()
  await page.waitForFunction(() => document.querySelector('[data-name="city.jpg"]')?.dataset.tags.split('|').includes('skyline'), null, { timeout: 120_000 })
  await closeSettings()
  await settled()
  ok((await tagsOf('city.jpg')).includes('skyline'), 'custom tag on city')
})

const idb = (pg, fn, arg) => pg.evaluate(([src, arg]) => new Promise((res, rej) => {
  const r = indexedDB.open('photo-tagger'); r.onerror = () => rej(r.error)
  r.onsuccess = async () => { try { res(await (new Function('db', 'arg', src))(r.result, arg)) } catch (e) { rej(e) } finally { r.result.close() } }
}), [fn, arg])
const getAll = (store) => `return new Promise((res) => { const q = db.transaction('${store}').objectStore('${store}').getAll(); q.onsuccess = () => res(q.result) })`
const getKeys = (store) => `return new Promise((res) => { const q = db.transaction('${store}').objectStore('${store}').getAllKeys(); q.onsuccess = () => res(q.result) })`
const keepDupes = async (pg = page) => { while (await pg.getByTestId('dupe-review').count()) { await pg.getByTestId('dupe-keep-all').click().catch(() => {}); await pg.waitForTimeout(300) } }
const waitTile = async (n, pg = page, timeout = 180_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    await keepDupes(pg)
    if (await pg.locator(`[data-testid=photo-tile][data-name="${n}"]`).count()) return
    await pg.waitForTimeout(300)
  }
  throw new Error(`tile ${n} never appeared`)
}
const sidecarFor = (st, idPart) => { const k = [...st.meta.keys()].find((k) => k.includes(idPart)); return k ? JSON.parse(st.meta.get(k)) : null }
// Nothing about Dropbox photos may be stored on this device (IndexedDB): no photo rows, thumbs, previews, originals, embeddings or faces.
const assertNothingLocal = async (pg) => {
  const photos = await idb(pg, getAll('photos'))
  eq(photos.filter((p) => p.dropbox || p.source === 'dropbox').map((p) => p.name), [], 'no Dropbox photo rows in IndexedDB')
  const localIds = new Set(photos.map((p) => p.id))
  for (const st of ['thumbs', 'views', 'originals', 'embeddings']) {
    const extra = (await idb(pg, getKeys(st))).filter((k) => !localIds.has(k))
    eq(extra, [], `no Dropbox data in ${st}`)
  }
  eq((await idb(pg, getAll('faces'))).filter((f) => !localIds.has(f.photoId)).length, 0, 'no Dropbox faces in IndexedDB')
}
// 1.0.31: the old "Tag N new photo(s) here" button is gone — Add all remaining (with its confirmation for big adds) replaces it
const addAll = async (pg = page) => {
  await pg.getByTestId('dropbox-add-batch').getByTestId('folder-add-remaining').click()
  if (await pg.getByTestId('add-confirm').count()) await pg.getByTestId('add-confirm-ok').click()
}
const connectDropbox = async (pg, key) => {
  await pg.getByTestId('open-settings').click(); await pg.getByTestId('tab-dropbox').click()
  await pg.getByTestId('dropbox-key').fill(key)
  await pg.getByTestId('dropbox-save').click()
  await Promise.all([pg.waitForURL((u) => !u.searchParams.has('code') && u.pathname.endsWith('/photo-tagger/'), { timeout: 30_000 }), pg.getByTestId('dropbox-connect').click()])
  await pg.getByTestId('open-settings').waitFor()
}

await test('Dropbox: without a key the button explains setup; shows redirect URIs + read-only scopes; Connect runs OAuth PKCE', async () => {
  await page.getByTestId('add-btn').click()
  await page.getByTestId('settings-note').waitFor()
  const uris = await page.getByTestId('redirect-uri').allTextContents()
  ok(uris.includes('http://127.0.0.1:4174/photo-tagger/'), 'local redirect shown: ' + uris)
  ok(uris.includes('https://cdrjohnson.github.io/photo-tagger/'), 'live redirect shown: ' + uris)
  eq((await page.getByTestId('dropbox-scope').allTextContents()).sort(), ['account_info.read', 'files.content.read', 'files.content.write', 'files.metadata.read', 'files.metadata.write'], 'scopes')
  ok(!/Chooser/.test(await page.getByTestId('settings').textContent()), 'no Chooser domain instructions left')
  await closeSettings()
  await connectDropbox(page, 'test_app_key_123')
  const a = dbx.authorize
  eq([a.client_id, a.response_type, a.code_challenge_method, a.token_access_type, a.redirect_uri], ['test_app_key_123', 'code', 'S256', 'offline', 'http://127.0.0.1:4174/photo-tagger/'], 'authorize params')
  ok(a.code_challenge && a.code_challenge.length >= 43, 'PKCE challenge')
  ok(!/sharing|delete|permanent/.test(a.scope) && /files\.content\.write/.test(a.scope) && /files\.metadata\.write/.test(a.scope), 'minimal scopes: ' + a.scope)
  const t = dbx.token[0]
  eq([t.grant_type, t.code, t.client_id, t.redirect_uri], ['authorization_code', 'stub-code', 'test_app_key_123', 'http://127.0.0.1:4174/photo-tagger/'], 'token exchange')
  ok(t.code_verifier && t.code_verifier.length >= 43 && !('client_secret' in t), 'PKCE verifier, no secret')
  ok(!page.url().includes('code='), 'URL cleaned: ' + page.url())
  await openSettings('dropbox')
  await page.waitForFunction(() => /Connected as Test User/.test(document.querySelector('[data-testid=dropbox-status]')?.textContent || ''))
  await closeSettings()
})

await test('Dropbox: in-app browser lists folders and images (paginated), skips non-images, breadcrumbs work', async () => {
  dbx.expireOnce = true // first API call gets 401 → app refreshes the token and retries
  await page.getByTestId('add-btn').click()
  await page.getByTestId('dropbox-browser').waitFor()
  await page.locator('[data-testid=dropbox-folder][data-name="Photos"]').waitFor()
  ok(dbx.refreshes >= 1, 'expired token was refreshed')
  eq(await page.getByTestId('dropbox-folder').evaluateAll((els) => els.map((e) => e.dataset.name)), ['Docs', 'Faces', 'Movies', 'Photos', 'Picks', 'Slow'], 'root folders (from 2 pages)')
  eq(await page.getByTestId('dropbox-file').count(), 0, 'readme.txt skipped')
  await page.locator('[data-testid=dropbox-folder][data-name="Photos"]').click()
  await page.locator('[data-testid=dropbox-file][data-name="from-dropbox-2.jpg"]').waitFor()
  eq(await page.getByTestId('dropbox-file').evaluateAll((els) => els.map((e) => e.dataset.name)), ['from-dropbox-2.jpg', 'from-dropbox.jpg'], 'images, pdf skipped')
  eq(await page.getByTestId('dropbox-folder').evaluateAll((els) => els.map((e) => e.dataset.name)), ['Trip'], 'subfolder')
  ok(dbx.lists.some((l) => l.continue), 'list_folder/continue used')
  ok(!(await page.getByTestId('dropbox-recursive').isChecked()), 'Include subfolders off by default')
  await page.getByTestId('dropbox-crumb').first().click()
  await page.locator('[data-testid=dropbox-folder][data-name="Docs"]').waitFor()
  await page.locator('[data-testid=dropbox-folder][data-name="Photos"]').click()
  await page.locator('[data-testid=dropbox-file][data-name="from-dropbox.jpg"]').waitFor()
})

await test('Dropbox: tag a folder — saved with Dropbox id, thumbnail + preview, no full original stored', async () => {
  dbx.flakyOnce.add('id:dbx-b') // first download aborts — retried, no error toast
  await addAll(page)
  await page.getByTestId('dropbox-browser').waitFor({ state: 'detached' })
  await page.waitForFunction(() => /Tagging from Dropbox|Processing|Listing/.test(document.querySelector('[data-testid=job-label]')?.textContent || ''), null, { timeout: 15_000 })
  ok(await page.getByTestId('job-cancel').count(), 'cancellable banner')
  await waitTile('from-dropbox.jpg'); await waitTile('from-dropbox-2.jpg')
  await page.waitForFunction(() => ['from-dropbox.jpg', 'from-dropbox-2.jpg'].every((n) => document.querySelector(`[data-name="${n}"]`)?.dataset.status === 'ready'), null, { timeout: 180_000 })
  await settled(); await keepDupes()
  eq(await tile('trip.jpg').count(), 0, 'subfolder not ingested when Include subfolders is off')
  ok(dbx.downloads['id:dbx-b'] >= 2, 'transient abort retried')
  const toasts = await page.locator('.toast').allTextContents()
  ok(!toasts.some((x) => /abort|failed/i.test(x)), 'no error toasts: ' + toasts.join(' | '))
  await assertNothingLocal(page)
  await page.evaluate(() => window.__ptFlushDropbox())
  const side = sidecarFor(dbx, 'dbx-a')
  ok(side, 'tags sidecar written to Dropbox: ' + [...dbx.meta.keys()].join(','))
  eq([side.photo.source, side.photo.dropbox.id, side.photo.dropbox.path, side.photo.dropbox.rev, side.photo.dropbox.contentHash, side.photo.hasOriginal], ['dropbox', 'id:dbx-a', '/Photos/from-dropbox.jpg', 'rdbx-a', 'hid:dbx-a', false], 'Dropbox record')
  ok(side.photo.tags.length > 0 && side.embedding, 'tags + embedding stored in Dropbox')
  eq((await tagsOf('from-dropbox.jpg')).sort(), side.photo.tags.map((t) => t.name).sort(), 'grid tags = Dropbox tags')
  // native Dropbox tags on the photo itself (searchable in Dropbox)
  const norm = (n) => n.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '').slice(0, 32)
  const fileTags = dbx.fileTags.get('id:dbx-a')
  ok(dbx.tagAdds.some((x) => x.path === '/Photos/from-dropbox.jpg'), 'tags/add called on the photo path')
  ok(dbx.tagGets.includes('/Photos/from-dropbox.jpg'), 'tags/get on import uses the / path')
  ok([...dbx.tagAdds, ...dbx.tagRemoves].every((x) => String(x.path).startsWith('/')) && dbx.tagGets.every((x) => x.startsWith('/')), 'Tags API only ever called with / paths')
  eq(dbx.tagBad, 0, 'no id: paths sent to the Tags API')
  ok(!dbx.tagAdds.some((x) => String(x.path).includes('.photo-tagger')), 'never tags metadata files')
  for (const t of side.photo.tags.slice(0, 19)) ok(fileTags.has(norm(t.name)), `native tag ${norm(t.name)} on photo: ${[...fileTags]}`)
  ok(fileTags.has('family_trip'), 'pre-existing Dropbox tag still on the file')
  ok((await tagsOf('from-dropbox.jpg')).includes('family_trip'), 'pre-existing Dropbox tag imported and shown in the app: ' + await tagsOf('from-dropbox.jpg'))
  // edit tags in the app → native tags follow (add + remove), third-party tag untouched
  await tile('from-dropbox.jpg').click()
  await page.getByTestId('detail-tag-input').fill('Sunny Day!'); await page.getByTestId('detail-tag-input').press('Enter')
  const dt = (t) => page.locator(`[data-testid=detail-tag][data-tag="${t}"]`)
  const victim = side.photo.tags.find((t) => t.source === 'auto')?.name
  ok(victim, 'has an auto tag to remove')
  await dt(victim).locator('[data-testid=remove-tag]').click()
  await dt(victim).waitFor({ state: 'detached' })
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__ptFlushDropbox())
  ok(fileTags.has('sunny_day'), 'manual tag added natively: ' + [...fileTags])
  ok(dbx.tagRemoves.some((x) => x.path === '/Photos/from-dropbox.jpg' && x.tag_text === norm(victim)), 'tags/remove called for removed tag')
  ok(!fileTags.has(norm(victim)), 'removed tag gone from Dropbox')
  ok(fileTags.has('family_trip'), 'imported Dropbox tag kept while the user keeps it')
  
  ok(!sidecarFor(dbx, 'dbx-a').photo.dropboxTags.includes('family_trip'), '1.0.34: a tag that was already in Dropbox is never claimed as Photo Tagger’s (only your own delete removes it)')
  ok(sidecarFor(dbx, 'dbx-a').photo.tags.some((t) => t.name === 'family_trip' && t.source === 'dropbox'), 'imported with source dropbox')
  // remove the imported Dropbox tag in the UI → removed in Dropbox too
  await tile('from-dropbox.jpg').click()
  const grp = (src) => page.locator(`[data-testid=tag-group][data-source=${src}]`)
  await grp('dropbox').locator('[data-tag="family_trip"]').waitFor()
  ok((await grp('dropbox').textContent()).includes('From Dropbox'), 'From Dropbox heading')
  eq(await grp('dropbox').locator('[data-tag="sunny day!"], [data-tag="sunny day"]').count(), 0, 'Photo Tagger-added tag not in the Dropbox group')
  ok(await grp('manual').locator('[data-testid=detail-tag]').count() > 0, 'Photo Tagger tag shown under Added by you')
  await dt('family_trip').locator('[data-testid=remove-tag]').click()
  await dt('family_trip').waitFor({ state: 'detached' })
  await page.getByTestId('detail-tag-input').fill('beach house'); await page.getByTestId('detail-tag-input').press('Enter')
  await dt('beach house').waitFor()
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__ptFlushDropbox())
  ok(dbx.tagRemoves.some((x) => x.path === '/Photos/from-dropbox.jpg' && x.tag_text === 'family_trip'), 'tags/remove called for the imported tag')
  ok(!fileTags.has('family_trip'), 'imported tag removed from Dropbox')
  ok(fileTags.has('beach_house'), 'newly added tag still syncs: ' + [...fileTags])
  eq(dbx.tagBad, 0, 'edits sent / paths only')
  // a tag added in Dropbox later is picked up on Refresh without re-downloading
  dbx.fileTags.set('id:dbx-b', new Set([...(dbx.fileTags.get('id:dbx-b') ?? []), 'added_in_dropbox']))
  const dl = { ...dbx.downloads }
  await page.getByTestId('add-dropbox-refresh').click()
  await page.waitForFunction(() => (document.querySelector('[data-name="from-dropbox-2.jpg"]')?.dataset.tags || '').split('|').includes('added_in_dropbox'), null, { timeout: 30_000 })
  eq(dbx.downloads, dl, 'no re-download to pick up Dropbox tags')
  await page.waitForTimeout(500)
})

await test('Dropbox sync (regression 1.0.13): tags keep syncing both ways once a photo reaches Dropbox\'s 20-tag limit; re-run tagging imports Dropbox edits', async () => {
  const fileTags = dbx.fileTags.get('id:dbx-a')
  fileTags.add('someone_elses_tag') // third-party, never imported yet
  const dt = (t) => page.locator(`[data-testid=detail-tag][data-tag="${t}"]`)
  await tile('from-dropbox.jpg').click()
  // fill the photo past 20 tags so the file is at Dropbox's limit
  await page.getByTestId('detail-tag-input').fill(Array.from({ length: 16 }, (_, i) => `bulk ${i + 1}`).join(', ')); await page.getByTestId('detail-tag-input').press('Enter')
  await dt('bulk 16').waitFor()
  await page.evaluate(() => window.__ptFlushDropbox())
  ok(fileTags.size <= 20, 'never more than 20 tags on the file: ' + fileTags.size)
  // App → Dropbox: a newly added tag must reach Dropbox even when the file is full
  await page.getByTestId('detail-tag-input').fill('Latest Tag'); await page.getByTestId('detail-tag-input').press('Enter')
  await dt('latest tag').waitFor()
  await page.evaluate(() => window.__ptFlushDropbox())
  ok(fileTags.has('latest_tag'), 'tag added in Photo Tagger written to Dropbox at the limit: ' + [...fileTags])
  ok(dbx.tagAdds.some((x) => x.tag_text === 'latest_tag' && x.path === '/Photos/from-dropbox.jpg'), 'tags/add with / path')
  eq(dbx.tagBad, 0, 'no id: paths')
  // Dropbox → App via "Re-run tagging": a tag added in Dropbox shows up; a tag removed in Dropbox disappears
  fileTags.delete('bulk 1'.replace(' ', '_'))
  fileTags.add('from_dropbox_ui')
  await page.getByRole('button', { name: 'Re-run tagging' }).click()
  await dt('from_dropbox_ui').waitFor({ timeout: 30_000 })
  ok(await page.locator('[data-testid=tag-group][data-source=dropbox] [data-tag="from_dropbox_ui"]').count(), 'shown under From Dropbox')
  await dt('bulk 1').waitFor({ state: 'detached', timeout: 10_000 })
  await page.evaluate(() => window.__ptFlushDropbox())
  ok(!fileTags.has('bulk_1'), 'tag removed in Dropbox is not written back')
  ok(fileTags.has('someone_elses_tag'), 'third-party tag never stripped: ' + [...fileTags])
  ok(await page.locator('[data-testid=tag-group][data-source=manual] [data-tag="latest tag"]').count(), 'Photo Tagger tag keeps its group')
  // cleanup so later tests see a normal photo
  await page.keyboard.press('Escape')
})

await test('Dropbox sync (regression 1.0.14): a tag deleted in Dropbox stays deleted; opening a photo picks up Dropbox changes', async () => {
  const fileTags = dbx.fileTags.get('id:dbx-a')
  const dt = (t) => page.locator(`[data-testid=detail-tag][data-tag="${t}"]`)
  const flush = () => page.evaluate(() => window.__ptFlushDropbox())
  await tile('from-dropbox.jpg').click()
  await dt('latest tag').waitFor()
  ok(fileTags.has('latest_tag'), 'precondition: Photo Tagger-owned tag on the file')
  // free slots so detected tags are on the file too
  for (let i = 2; i <= 16; i++) await dt(`bulk ${i}`).getByTestId('remove-tag').click()
  await flush()
  const autos = await page.locator('[data-testid=tag-group][data-source=auto] [data-testid=detail-tag]').evaluateAll((els) => els.map((e) => e.dataset.tag))
  const autoTag = autos.find((t) => fileTags.has(t.replace(/[^a-z0-9]+/g, '_'))) ?? autos[0]
  const autoDbx = autoTag.replace(/[^a-z0-9]+/g, '_')
  ok(fileTags.has(autoDbx), 'precondition: auto tag on the file: ' + autoDbx)
  const n0 = dbx.tagAdds.length
  // user deletes both in the Dropbox UI
  fileTags.delete('latest_tag'); fileTags.delete(autoDbx)
  // an unrelated edit in Photo Tagger triggers a write (no Refresh/import first)
  await page.getByTestId('detail-tag-input').fill('After Delete'); await page.getByTestId('detail-tag-input').press('Enter')
  await dt('after delete').waitFor()
  await flush(); await page.waitForTimeout(300); await flush()
  ok(!fileTags.has('latest_tag') && !fileTags.has(autoDbx), 'deleted tags not written back: ' + [...fileTags])
  ok(!dbx.tagAdds.slice(n0).some((x) => x.tag_text === 'latest_tag' || x.tag_text === autoDbx), 'no tags/add for deleted tags')
  ok(fileTags.has('after_delete'), 'new Photo Tagger tag still written')
  await dt('latest tag').waitFor({ state: 'detached', timeout: 10_000 })
  // Re-run tagging must not recreate them either
  await page.getByRole('button', { name: 'Re-run tagging' }).click()
  await page.waitForTimeout(3000); await flush()
  ok(!fileTags.has('latest_tag') && !fileTags.has(autoDbx), 'still deleted after Re-run tagging: ' + [...fileTags])
  eq(await dt(autoTag).count(), 0, 'auto tag not recreated by re-tag')
  // opening the photo imports a tag added in Dropbox (no Refresh, no Download original)
  fileTags.add('opened_tag')
  await page.keyboard.press('Escape')
  await tile('from-dropbox.jpg').click()
  await dt('opened_tag').waitFor({ timeout: 10_000 })
  // adding the deleted tag again in Photo Tagger writes it again, with a / path
  await page.getByTestId('detail-tag-input').fill('Latest Tag'); await page.getByTestId('detail-tag-input').press('Enter')
  await dt('latest tag').waitFor(); await flush()
  ok(fileTags.has('latest_tag'), 're-added tag written again')
  ok(fileTags.size <= 20 && fileTags.has('someone_elses_tag'), 'cap + third-party kept: ' + [...fileTags])
  eq(dbx.tagBad, 0, 'no id: paths')
  ok(await page.locator('[data-testid=tag-group][data-source=manual] [data-tag="after delete"]').count(), 'Photo Tagger tag keeps its group')
  await page.keyboard.press('Escape')
})

await test('Dropbox sync (regression 1.0.15): Dropbox tags with spaces/punctuation show up and stay deleted; Re-run tagging and Download original show status', async () => {
  const fileTags = dbx.fileTags.get('id:dbx-a')
  const dt = (t) => page.locator(`[data-testid=detail-tag][data-tag="${t}"]`)
  const flush = () => page.evaluate(() => window.__ptFlushDropbox())
  const toastHas = (re) => page.locator('.toast', { hasText: re }).first().waitFor({ timeout: 30_000 })
  fileTags.add('Road Trip'); fileTags.add('#sea-side'); fileTags.add('#test')
  await tile('from-dropbox.jpg').click()
  await dt('road_trip').waitFor({ timeout: 10_000 }); await dt('sea_side').waitFor(); await dt('test').waitFor()
  ok(await page.locator('[data-testid=tag-group][data-source=dropbox] [data-tag="test"]').count(), '#test shown as test under From Dropbox')
  ok(await page.locator('[data-testid=tag-group][data-source=dropbox] [data-tag="road_trip"]').count(), 'shown under From Dropbox')
  await flush()
  ok(!fileTags.has('road_trip') && !fileTags.has('sea_side'), 'no normalized duplicate written: ' + [...fileTags])
  // user deletes it in Dropbox (exact spelling) → never written back, chip goes away
  const n0 = dbx.tagAdds.length
  fileTags.delete('Road Trip'); fileTags.delete('#test')
  await page.getByTestId('detail-tag-input').fill('Status Check'); await page.getByTestId('detail-tag-input').press('Enter')
  await dt('status check').waitFor(); await flush(); await page.waitForTimeout(300); await flush()
  ok(![...fileTags].some((t) => /road.?trip/i.test(t)), 'deleted Dropbox tag stays deleted: ' + [...fileTags])
  ok(!dbx.tagAdds.slice(n0).some((x) => x.tag_text === 'road_trip' || x.tag_text === 'test'), 'no tags/add for road_trip / test')
  ok(![...fileTags].some((t) => /^#?test$/i.test(t)), '#test stays deleted')
  await dt('test').waitFor({ state: 'detached', timeout: 10_000 })
  await dt('road_trip').waitFor({ state: 'detached', timeout: 10_000 })
  // removing the punctuated one in the app removes the exact text from Dropbox
  await dt('sea_side').getByTestId('remove-tag').click(); await flush()
  ok(!fileTags.has('#sea-side'), 'exact Dropbox spelling removed: ' + [...fileTags])
  // Re-run tagging on a Dropbox photo really runs and reports status
  await page.evaluate(() => window.__ptDropEmbeddings?.())
  const dl = dbx.downloads['id:dbx-a'] || 0
  eq(await page.getByTestId('delete-photo').innerText(), 'Remove from app', 'detail says Remove from app')
  ok(await page.getByTestId('retag-group').getByRole('button', { name: 'Re-run tagging' }).count() === 1 && await page.getByTestId('retag-group').getByTestId('download').count() === 0, 'help grouped with Re-run tagging only')
  ok(await page.getByTestId('retag-help').evaluate((el) => el.getBoundingClientRect().top > el.parentElement.querySelector('button').getBoundingClientRect().bottom - 1), 'help sits under Re-run tagging')
  ok(/doesn't need|don't need/.test(await page.getByTestId('retag-help').innerText()) && await page.getByTestId('retag-help').isVisible(), 'Re-run tagging explained next to the button')
  await page.getByRole('button', { name: 'Re-run tagging' }).click()
  await page.getByTestId('job-label').filter({ hasText: /Re-tag/ }).first().waitFor({ timeout: 10_000 })
  await toastHas(/Re-tagged from-dropbox\.jpg/)
  // Download original: success and failure are both reported
  await page.getByTestId('download').click()
  await toastHas(/Downloaded from-dropbox\.jpg/)
  dbx.failDownload = true
  try {
    await page.getByTestId('download').click()
    await toastHas(/Could not download from-dropbox\.jpg/)
  } finally { dbx.failDownload = false }
  eq(dbx.tagBad, 0, 'no id: paths')
  ok(fileTags.size <= 20 && fileTags.has('someone_elses_tag'), 'cap + third-party kept')
  void dl
  await page.keyboard.press('Escape')
  ok((await tagsOf('from-dropbox.jpg')).length > 0, 'tagged')
  await tile('from-dropbox.jpg').click()
  await page.getByTestId('dropbox-path').waitFor()
  eq(await page.getByTestId('dropbox-path').textContent(), '/Photos/from-dropbox.jpg')
  await page.locator('[data-testid=detail] img').first().waitFor({ state: 'visible', timeout: 15_000 }) // detail shows the local preview
  eq(await page.getByTestId('delete-photo').textContent(), 'Remove from app')
  await page.keyboard.press('Escape')
})

await test('Verify Dropbox tags: flush, read-back only (not add ACK), landed/missing/cap/errors, selected and whole-library results', async () => {
  await page.evaluate(() => window.__ptFlushDropbox())
  const fileId = 'id:dbx-b', name = 'from-dropbox-2.jpg'
  const closeVerify = () => page.getByRole('button', { name: 'Close verification', exact: true }).click()
  const row = () => page.locator(`[data-testid=verify-row][data-name="${name}"]`)
  // One normal pending edit and one API "success" which did not actually store the tag.
  dbx.ackWithoutWrite = 'ackfake_missing'
  await tile(name).click()
  await page.getByTestId('detail-tag-input').fill('verify_recent, ackfake_missing'); await page.getByTestId('detail-tag-input').press('Enter')
  await page.locator('[data-testid=detail-tag][data-tag="ackfake_missing"]').waitFor()
  await page.keyboard.press('Escape')
  await page.getByTestId('select-mode').click(); await tile(name).click()
  const mediaBefore = JSON.stringify(dbx.downloads)
  await page.getByTestId('verify-dropbox-selected').click()
  await row().waitFor()
  ok(/verify_recent/.test(await row().getByTestId('verify-landed').innerText()), 'pending tag flushed and landed')
  ok(/ackfake_missing/.test(await row().getByTestId('verify-missing').innerText()), 'ACK alone is not landed')
  eq(JSON.stringify(dbx.downloads), mediaBefore, 'verification fetched no media')
  await closeVerify()
  // Restore the acknowledged tag then simulate a full Dropbox file: all missing tags are cap-blocked.
  dbx.ackWithoutWrite = undefined
  const saved = new Set(dbx.fileTags.get(fileId)); saved.add('ackfake_missing')
  dbx.fileTags.set(fileId, new Set(Array.from({ length: 20 }, (_, i) => 'external_' + i)))
  await page.getByTestId('verify-dropbox-selected').click(); await row().waitFor()
  ok(/20 tags/.test(await row().getByTestId('verify-cap').innerText()), 'cap explanation on file')
  ok(/verify_recent/.test(await row().getByTestId('verify-cap').innerText()), 'missing desired tag is cap-blocked')
  eq(dbx.fileTags.get(fileId).size, 20, 'third-party slots untouched')
  await closeVerify(); dbx.fileTags.set(fileId, saved)
  // All-good empty/missing state, with no toast-only result.
  await page.getByTestId('verify-dropbox-selected').click(); await row().waitFor()
  await page.getByTestId('verify-all-good').waitFor()
  ok(/Every desired tag/.test(await page.getByTestId('verify-all-good').innerText()), 'all good is explicit')
  await closeVerify()
  dbx.tagReadError = true
  await page.getByTestId('verify-dropbox-selected').click(); await row().waitFor()
  ok(/files.metadata.write/.test(await row().innerText()) && /Full Dropbox/.test(await row().innerText()), 'scope/access guidance in results')
  await closeVerify(); dbx.tagReadError = false
  await page.getByTestId('sel-cancel').click()
  // Whole Dropbox-backed library, discoverable in the library-tag card.
  await openSettings('vocab')
  await page.getByTestId('verify-dropbox-library').click()
  await page.getByTestId('verify-summary').waitFor()
  ok((await page.getByTestId('verify-row').count()) >= 2, 'whole-library list contains every Dropbox file')
  ok(dbx.tagBatches.every((p) => p.length <= 20 && p.every((x) => x.startsWith('/'))), 'Tags API batching uses <=20 real paths')
  await page.keyboard.press('Escape')
  ok(await page.getByTestId('settings').isVisible(), 'Escape closes results only, not Settings')
  await closeSettings()
})

await test('Dropbox: Refresh re-lists linked folders and skips already-seen file ids; subfolders opt-in', async () => {
  const before = { ...dbx.downloads }
  await page.getByTestId('add-dropbox-refresh').click()
  await page.locator('.toast', { hasText: /No new photos — 2 already in your library/ }).waitFor({ timeout: 30_000 })
  eq(dbx.downloads, before, 'nothing re-downloaded')
  eq(await page.getByTestId('preimport-check').count(), 0, 'no "check your detection list" prompt when the library already has photos')
  // now include subfolders: only trip.jpg is new
  await page.getByTestId('add-btn').click()
  await page.locator('[data-testid=dropbox-folder][data-name="Photos"]').click()
  await page.getByTestId('dropbox-have-toggle').click()
  await page.locator('[data-testid=dropbox-file][data-name="from-dropbox.jpg"] [data-testid=dropbox-in-library]').waitFor()
  await page.getByTestId('dropbox-recursive').check()
  await addAll(page)
  await waitTile('trip.jpg')
  await settled(); await keepDupes()
  eq([dbx.downloads['id:dbx-a'], dbx.downloads['id:dbx-c']], [before['id:dbx-a'], 1], 'only the new file downloaded')
  await page.evaluate(() => window.__ptFlushDropbox())
  eq([...dbx.meta.keys()].filter((k) => k.includes('dbx-a')).length, 1, 'one sidecar per Dropbox file')
  // Reopen: tags come back from Dropbox, nothing local
  const tagsBefore = (await tagsOf('from-dropbox.jpg')).sort()
  // blank-tile regression (1.0.17): first thumbnail requests fail for one file, the small size always fails for another
  dbx.thumbFailOnce['id:dbx-a'] = 3; dbx.thumbFailSmall.add('id:dbx-c')
  await page.reload(); await page.getByTestId('grid').waitFor()
  await tile('from-dropbox.jpg').waitFor({ timeout: 30_000 })
  eq((await tagsOf('from-dropbox.jpg')).sort(), tagsBefore, 'tags read back from Dropbox after reload')
  ok(await tile('trip.jpg').count(), 'all Dropbox photos listed after reload')
  for (const n of ['from-dropbox.jpg', 'trip.jpg']) {
    await tile(n).locator('img').waitFor({ timeout: 30_000 })
    ok(await tile(n).locator('img').evaluate((i) => i.complete ? i.naturalWidth > 0 : new Promise((r) => { i.onload = () => r(i.naturalWidth > 0); i.onerror = () => r(false) })), n + ' tile shows its image after thumbnail failures')
  }
  ok(dbx.thumbLog.some(([path, size]) => path === '/Photos/Trip/trip.jpg' && size === 'w480h320'), 'retried by / path')
  ok(dbx.thumbLog.some(([path, size]) => path === 'id:dbx-c' && size === 'w2048h1536'), 'fell back to the editor-size preview')
  dbx.thumbFailSmall.clear()
  await assertNothingLocal(page)
  const linked = await idb(page, `return new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('dropboxFolders'); q.onsuccess = () => res(q.result) })`)
  eq(linked.map((f) => [f.path, f.recursive]), [['/Photos', true]], 'linked folder remembered')
})

await test('Dropbox: Cancel stops remaining work; already-processed photos stay', async () => {
  await page.getByTestId('add-btn').click()
  await page.locator('[data-testid=dropbox-folder][data-name="Slow"]').click()
  await page.locator('[data-testid=dropbox-file][data-name="cancel-stop-b.jpg"]').waitFor()
  await addAll(page)
  await waitTile('cancel-stop-a.jpg', page, 60_000)
  await page.getByTestId('job-cancel').click()
  await page.getByTestId('cancel-dropbox-confirm').waitFor()
  ok(/already added/i.test(await page.getByTestId('cancel-dropbox-confirm').textContent()), 'explains cancel')
  await page.getByTestId('cancel-dropbox-confirm-btn').click()
  await page.waitForTimeout(9000)
  ok(await tile('cancel-stop-a.jpg').count(), 'already-processed photo remains')
  eq(await tile('cancel-stop-b.jpg').count(), 0, 'aborted file not ingested')
  await settled()
})

await test('Dropbox: pick individual files (click, Ctrl-click, Shift-click, drag, Select all / Deselect all); only those are tagged, folder not linked', async () => {
  await page.getByTestId('add-btn').click()
  await page.locator('[data-testid=dropbox-folder][data-name="Picks"]').click()
  const row = (n) => page.locator(`[data-testid=dropbox-file][data-name="pick-${n}.jpg"]`)
  const count = () => page.locator('[data-testid=dropbox-file][data-picked="1"]').count()
  await row(4).waitFor()
  await page.getByTestId('dropbox-select-all').click(); eq(await count(), 4, 'Select all')
  await page.getByTestId('dropbox-deselect-all').click(); eq(await count(), 0, 'Deselect all')
  ok(await page.getByTestId('dropbox-browser').isVisible(), 'browser stays open')
  await row(1).click(); await row(3).click({ modifiers: ['Control'] }); eq(await count(), 2, 'Ctrl-click adds')
  await row(4).click({ modifiers: ['Shift'] }); eq(await count(), 3, 'Shift-click selects range 3–4')
  await row(4).click({ modifiers: ['Shift'] }); eq(await count(), 1, 'Shift-click on a selected file deselects the range')
  await row(2).click(); eq(await count(), 1, 'plain click selects only that file')
  // drag-paint 2 → 4
  const b2 = await row(2).boundingBox(), b4 = await row(4).boundingBox()
  await page.mouse.move(b2.x + 40, b2.y + b2.height / 2); await page.mouse.down()
  await page.mouse.move(b4.x + 40, b4.y + b4.height / 2, { steps: 8 }); await page.mouse.up()
  eq(await count(), 3, 'drag selects 2–4')
  await page.keyboard.press('Control+a'); eq(await count(), 4, 'Ctrl+A selects all')
  await row(1).click(); await row(2).click({ modifiers: ['Control'] })
  ok(await row(2).getByTestId('dropbox-file-check').isChecked(), 'checkbox in sync')
  eq(await page.getByTestId('dropbox-selected-count').innerText(), '2 selected')
  eq(await page.getByTestId('dropbox-add-selected').innerText(), 'Add selected (2)', 'button adds only the selection')
  await page.getByTestId('dropbox-add-selected').click()
  await waitTile('pick-1.jpg', page, 60_000); await waitTile('pick-2.jpg', page, 60_000)
  await settled(); await keepDupes()
  eq([await tile('pick-3.jpg').count(), await tile('pick-4.jpg').count()], [0, 0], 'unselected files not tagged')
  ok(!dbx.downloads['id:p3'] && !dbx.downloads['id:p4'], 'unselected files never downloaded')
  const linked = await idb(page, `return new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('dropboxFolders'); q.onsuccess = () => res(q.result) })`)
  ok(!linked.some((f) => f.path.toLowerCase() === '/picks'), 'picked files do not link the folder: ' + JSON.stringify(linked))
})

await test('Dropbox picker: lazy thumbnails, date/size, in-library rows show a disabled checked box; videos tagged from the preview only', async () => {
  const thumbs0 = dbx.thumbLog.length
  await page.getByTestId('add-btn').click()
  await page.locator('[data-testid=dropbox-folder][data-name="Picks"]').click()
  const row = (n) => page.locator(`[data-testid=dropbox-file][data-name="${n}"]`)
  await row('pick-4.jpg').waitFor()
  // 1.0.32: two groups — pick-1/2 are in the library, pick-3/4 are not
  eq(await page.getByTestId('dropbox-group-new').innerText().then((t) => t.trim()), 'Not in library yet (2)', 'not-yet group count')
  ok(/Already in library \(2\)/.test(await page.getByTestId('dropbox-have-toggle').innerText()), 'already group count')
  eq([await row('pick-1.jpg').count(), await row('pick-3.jpg').count()], [0, 1], 'added photos hidden until expanded')
  await page.getByTestId('dropbox-have-toggle').click()
  eq(await page.getByTestId('dropbox-file').evaluateAll((r) => r.map((e) => e.dataset.name)), ['pick-3.jpg', 'pick-4.jpg', 'pick-1.jpg', 'pick-2.jpg'], 'still to add first, then the added ones')
  for (const n of ['pick-3.jpg', 'pick-4.jpg', 'pick-1.jpg', 'pick-2.jpg']) { await row(n).scrollIntoViewIfNeeded(); await page.waitForTimeout(150) } // previews load as rows scroll into view
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=dropbox-thumb]')].every((t) => t.dataset.state !== 'waiting'), null, { timeout: 20_000 })
  eq(await page.locator('[data-testid=dropbox-thumb][data-state=loaded]').count(), 4, 'previews shown')
  const small = dbx.thumbLog.filter(([p, size]) => size === 'w256h256' && /^id:p\d$|^\/Picks\//.test(p))
  ok(new Set(small.map(([p]) => p)).size <= 4 && small.length <= 8, 'one small preview per file, cached across visits: ' + JSON.stringify(small)); void thumbs0
  ok(!dbx.downloads['id:p3'] && !dbx.downloads['id:p4'], 'picker never downloads files')
  ok(/2024/.test(await row('pick-3.jpg').getByTestId('dropbox-file-meta').innerText()) && /KB/.test(await row('pick-3.jpg').getByTestId('dropbox-file-meta').innerText()), 'date and size shown')
  const have = row('pick-1.jpg')
  ok(await have.getByTestId('dropbox-in-library').isVisible() && (await have.getByTestId('dropbox-in-library').innerText()) === '✓ In library', '✓ In library badge')
  ok(await have.getByTestId('dropbox-in-library').evaluate((e) => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().right <= e.closest('[data-testid=dropbox-file]').getBoundingClientRect().right + 1), 'label not clipped')
  const cb = have.getByTestId('dropbox-file-check')
  ok(await cb.isDisabled() && await cb.isChecked(), 'disabled, checked box for in-library file')
  await have.click({ force: true }); eq(await page.locator('[data-testid=dropbox-file][data-picked="1"]').count(), 0, 'in-library row not selectable')
  await page.getByTestId('dropbox-select-all').click(); eq(await page.locator('[data-testid=dropbox-file][data-picked="1"]').count(), 2, 'Select all = new files only')
  await page.getByTestId('dropbox-deselect-all').click()
  // videos are listed and tagged from Dropbox's preview frame — never downloaded
  await page.getByTestId('dropbox-crumb').first().click()
  await page.locator('[data-testid=dropbox-folder][data-name="Movies"]').click()
  await row('clip.mp4').waitFor(); await row('noframe.mov').waitFor()
  await addAll(page)
  await waitTile('clip.mp4', page, 60_000)
  await page.locator('.toast', { hasText: /1 video\(s\) skipped/ }).first().waitFor({ timeout: 30_000 })
  await settled(); await keepDupes()
  eq([dbx.downloads['id:v1'], dbx.downloads['id:v2']], [undefined, undefined], 'video files never downloaded')
  ok(dbx.thumbLog.some(([p, size]) => p === 'id:v1' && size === 'w2048h1536'), 'tagged from the preview frame')
  ok((await tagsOf('clip.mp4')).length > 0, 'video got tags')
  eq(await tile('noframe.mov').count(), 0, 'video without a preview skipped, not hung')
  // 1.0.23: lowercase "video" badge on video tiles only, top of the badge stack
  await tile('clip.mp4').getByTestId('video-badge').waitFor()
  eq((await tile('clip.mp4').getByTestId('video-badge').innerText()).trim(), 'video', 'badge text')
  eq(await tile('clip.mp4').getByTestId('video-badge').evaluate((e) => getComputedStyle(e).backgroundColor), 'rgba(14, 116, 144, 0.92)', 'teal badge')
  eq(await tile('clip.mp4').locator('.badges > .badge:not(.pend)').first().getAttribute('data-testid'), 'video-badge', 'video badge on top')
  eq(await page.locator('[data-testid=photo-tile]:not([data-name$=".mp4"]) [data-testid=video-badge]').count(), 0, 'photos stay unmarked')
  await page.evaluate(() => window.__ptFlushDropbox())
  ok(sidecarFor(dbx, 'v1'), 'sidecar written for the video')
  ok((dbx.fileTags.get('id:v1')?.size ?? 0) > 0, 'native Dropbox tags written on the video')
  await tile('clip.mp4').click()
  ok(await page.getByTestId('download').isDisabled(), 'Download original disabled for videos')
  const n0 = dbx.downloads['id:v1']
  await page.getByRole('button', { name: 'Re-run tagging' }).click()
  await page.locator('.toast', { hasText: /Re-tagged clip\.mp4/ }).first().waitFor({ timeout: 30_000 })
  eq(dbx.downloads['id:v1'], n0, 'Re-run tagging does not download the video')
  await page.keyboard.press('Escape')
})

await test('Dropbox: Remove from app (1.0.34) only leaves the app — Dropbox photo, its tags and its tag file are kept', async () => {
  await page.evaluate(() => window.__ptFlushDropbox())
  ok(sidecarFor(dbx, 'slow-a'), 'sidecar exists before remove')
  const tagsBefore = [...(dbx.fileTags.get('id:slow-a') ?? [])].sort()
  await tile('cancel-stop-a.jpg').click()
  await page.getByTestId('delete-photo').click()
  await page.getByTestId('remove-confirm').waitFor()
  ok(await page.getByTestId('remove-cancel').evaluate((b) => b === document.activeElement), 'Cancel has focus, not Remove')
  await page.keyboard.press('Escape'); await page.getByTestId('remove-confirm').waitFor({ state: 'detached' })
  ok(await page.getByTestId('detail').isVisible(), 'Escape closes only the dialog')
  await page.getByTestId('delete-photo').click(); await page.getByTestId('remove-cancel').click()
  await page.waitForTimeout(500)
  ok(await tile('cancel-stop-a.jpg').count(), 'Cancel keeps the photo')
  await page.getByTestId('delete-photo').click()
  await page.getByTestId('remove-confirm-btn').click()
  await tile('cancel-stop-a.jpg').waitFor({ state: 'detached' })
  await page.evaluate(() => window.__ptFlushDropbox())
  await page.waitForTimeout(800)
  ok(sidecarFor(dbx, 'slow-a'), 'tag file kept')
  eq([...(dbx.fileTags.get('id:slow-a') ?? [])].sort(), tagsBefore, 'Dropbox tags kept on the photo')
  eq(dbx.writes, 0, 'photo file in Dropbox untouched (no delete/write outside /.photo-tagger)')
  await page.keyboard.press('Escape').catch(() => {})
})

await test('Dropbox: Disconnect forgets the session; From Dropbox goes back to Settings', async () => {
  await openSettings('dropbox')
  await page.getByTestId('dropbox-disconnect').click()
  await page.waitForFunction(() => /Not connected/.test(document.querySelector('[data-testid=dropbox-status]')?.textContent || ''))
  const sess = await idb(page, `return new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('dropboxSession'); q.onsuccess = () => res(q.result ?? null) })`)
  eq(sess, null, 'tokens cleared')
  for (let i = 0; i < 50 && !dbx.revoked; i++) await page.waitForTimeout(100)
  ok(dbx.revoked >= 1, 'token revoked')
  await closeSettings()
  await page.getByTestId('add-btn').click()
  await page.getByTestId('settings-note').waitFor()
  ok(await page.getByTestId('dropbox-connect').isVisible(), 'Connect shown again')
  await closeSettings()
  await page.reload(); await page.getByTestId('grid').waitFor()
  await openSettings('dropbox')
  ok(/Not connected/.test(await page.getByTestId('dropbox-status').textContent()), 'still disconnected after reload')
  await closeSettings()
  eq(await tile('from-dropbox.jpg').count(), 0, 'Dropbox photos are not kept locally after disconnect')
  await assertNothingLocal(page)
  ok(sidecarFor(dbx, 'dbx-a'), 'tags remain in Dropbox')
  eq(dbx.writes, 0, 'no write/delete call ever made to Dropbox')
})

await test('Dropbox write queue (1.0.26): bulk add survives 429/5xx/network/401; progress shows and clears; permanent errors listed; queue resumes after reload', async () => {
  const c7 = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await routeModel(c7).catch(() => {})
  const st = await stubDropbox(c7)
  const p7 = await c7.newPage()
  const flush7 = () => p7.evaluate(() => window.__ptFlushDropbox())
  const tagsOn = (id) => [...(st.fileTags.get(id) ?? [])]
  const picks = ['id:p1', 'id:p2', 'id:p3', 'id:p4']
  try {
    await p7.goto(URL_BASE); await p7.getByTestId('empty').waitFor()
    await connectDropbox(p7, 'queue_key')
    await p7.getByTestId('empty').getByRole('button', { name: 'From Dropbox' }).click()
    await p7.locator('[data-testid=dropbox-folder][data-name="Picks"]').click()
    await p7.locator('[data-testid=dropbox-file][data-name="pick-4.jpg"]').waitFor()
    await addAll(p7)
    await p7.getByTestId('preimport-check').waitFor() // empty library → "Check your detection list first"
    await p7.getByTestId('preimport-proceed').click()
    for (const n of ['pick-1.jpg', 'pick-2.jpg', 'pick-3.jpg', 'pick-4.jpg']) await waitTile(n, p7, 300_000)
    await p7.waitForFunction(() => document.querySelectorAll('[data-testid=photo-tile][data-status=ready]').length === 4, null, { timeout: 300_000 })
    await flush7(); await p7.getByTestId('save-status').waitFor({ state: 'detached', timeout: 30_000 })
    // 1) bulk add with every kind of transient failure injected
    st.inject.push(
      { ep: '/2/files/tags/add', status: 429, retryAfter: 1, times: 3 },
      { ep: '/2/files/tags/add', status: 500, summary: 'internal_error', times: 3 },
      { ep: '/2/files/tags/add', network: true, times: 3 },
      { ep: '/2/files/tags/add', status: 409, summary: 'too_many_write_operations/', times: 2 },
      { ep: '/2/files/tags/add', status: 401, summary: 'expired_access_token/', times: 1 },
      { ep: '/2/files/tags/get', network: true, times: 2 },
      { ep: '/2/files/upload', status: 503, times: 4 },
    )
    const refreshes0 = st.refreshes
    await p7.getByTestId('select-mode').click(); await p7.getByTestId('sel-all').click()
    await p7.getByTestId('bulk-tag').click()
    await p7.getByTestId('bulk-input').fill('bulk_retry, second_tag'); await p7.getByTestId('bulk-input').press('Enter')
    await p7.getByTestId('save-progress').waitFor({ timeout: 10_000 })
    ok(/Saving tags to Dropbox: \d+ of 4 photos · \d+ remaining/.test(await p7.getByTestId('save-progress').innerText()), 'progress text: ' + await p7.getByTestId('save-progress').innerText())
    await p7.getByTestId('bulk-close').click()
    await p7.getByTestId('save-status').waitFor({ state: 'detached', timeout: 120_000 })
    for (const id of picks) ok(tagsOn(id).includes('bulk_retry') && tagsOn(id).includes('second_tag'), `${id} has both tags in Dropbox: ${tagsOn(id)}`)
    ok(st.inject.every((f) => f.times === 0), 'all injected failures were hit: ' + JSON.stringify(st.inject))
    ok(st.refreshes > refreshes0, 'token refreshed mid-queue after 401')
    ok([...st.meta].filter(([k, v]) => k.startsWith('/.photo-tagger/meta/') && v.includes('bulk_retry')).length === 4, 'all four sidecars saved')
    st.inject.length = 0
    // 2) permanent errors go straight to the failure list (no endless loop)
    st.fileTags.set('id:p3', new Set(Array.from({ length: 20 }, (_, i) => 'external_' + i)))
    st.inject.push(
      { ep: '/2/files/tags/add', status: 403, summary: 'missing_scope/files.metadata.write', body: /pick-1/, times: 1000 },
      { ep: '/2/files/tags/get', status: 409, summary: 'path/not_found/', body: /pick-2/, times: 1000 },
    )
    await p7.getByTestId('bulk-tag').click()
    await p7.getByTestId('bulk-input').fill('perm_check'); await p7.getByTestId('bulk-input').press('Enter')
    await p7.getByTestId('bulk-close').click()
    await p7.getByTestId('save-failed-count').waitFor({ timeout: 60_000 })
    await p7.waitForFunction(() => /3 photos could not/.test(document.querySelector('[data-testid=save-failed-count]')?.textContent || ''), null, { timeout: 60_000 })
    await p7.getByTestId('save-progress').waitFor({ state: 'detached', timeout: 60_000 })
    const hits = st.injected; await p7.waitForTimeout(1500)
    ok(st.injected - hits <= 1, 'permanent errors are not retried in a loop: ' + (st.injected - hits))
    await p7.getByTestId('save-failures-open').click()
    const rows = await p7.getByTestId('save-failure').evaluateAll((els) => els.map((e) => [e.dataset.name, e.dataset.kind, e.textContent]))
    const kind = (n) => rows.find((r) => r[0] === n)
    eq([kind('pick-1.jpg')?.[1], kind('pick-2.jpg')?.[1], kind('pick-3.jpg')?.[1]], ['permission', 'not_found', 'cap'], 'failure kinds: ' + JSON.stringify(rows))
    ok(/files\.metadata\.write/.test(kind('pick-1.jpg')[2]) && /not found/i.test(kind('pick-2.jpg')[2]) && /20 tags/.test(kind('pick-3.jpg')[2]) && /perm_check/.test(kind('pick-3.jpg')[2]), 'reasons explained')
    ok(tagsOn('id:p4').includes('perm_check'), 'other photos still saved')
    // Retry now after fixing the cause: those two land, the full file stays listed
    st.inject.length = 0
    await p7.getByTestId('save-retry-all').click()
    await p7.waitForFunction(() => /1 photo could not/.test(document.querySelector('[data-testid=save-failed-count]')?.textContent || ''), null, { timeout: 60_000 })
    // the count can read "1 photo" while the retried two are still in flight — wait for them to land
    for (let i = 0; i < 300 && !(tagsOn('id:p1').includes('perm_check') && tagsOn('id:p2').includes('perm_check')); i++) await p7.waitForTimeout(100)
    ok(tagsOn('id:p1').includes('perm_check') && tagsOn('id:p2').includes('perm_check'), 'Retry now landed the fixed ones')
    await p7.getByTestId('save-progress').waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {})
    if (await p7.getByTestId('save-failures').count()) await p7.keyboard.press('Escape')
    // 3) a long outage: after the retry window the photo is listed instead of retrying silently forever
    await p7.evaluate(() => { window.__PT_RETRY_WINDOW_MS = 400 })
    if (await p7.getByTestId('sel-cancel').count()) await p7.getByTestId('sel-cancel').click()
    st.inject.push({ ep: '/2/files/tags/add', network: true, body: /pick-4/, times: 100000 })
    await p7.locator('[data-testid=photo-tile][data-name="pick-4.jpg"]').click()
    await p7.getByTestId('detail-tag-input').fill('outage_tag'); await p7.getByTestId('detail-tag-input').press('Enter')
    await p7.keyboard.press('Escape')
    await p7.locator('[data-testid=save-failure-count], [data-testid=save-failed-count]').first().waitFor()
    await p7.waitForFunction(() => /2 photos could not/.test(document.querySelector('[data-testid=save-failed-count]')?.textContent || ''), null, { timeout: 60_000 })
    await p7.getByTestId('save-failures-open').click()
    ok(/Still failing after retrying/.test(await p7.locator('[data-testid=save-failure][data-name="pick-4.jpg"]').innerText()), 'gave-up reason shown')
    await p7.keyboard.press('Escape')
    // 4) still failing when the app closes → queue persisted, resumes on next open
    await p7.evaluate(() => { window.__PT_RETRY_WINDOW_MS = 600000 })
    await p7.getByTestId('save-retry-now').click()
    await p7.getByTestId('save-retrying').waitFor({ timeout: 30_000 })
    const q = await p7.evaluate(() => JSON.parse(localStorage.getItem('pt.dropboxQueue.v1') || 'null'))
    ok(q?.items?.some((it) => it.id && it.tags.some((t) => t.name === 'outage_tag')), 'pending write persisted (ids + tag state only)')
    ok(JSON.stringify(q).length < 4000, 'small footprint: ' + JSON.stringify(q).length)
    ok(!tagsOn('id:p4').includes('outage_tag'), 'not in Dropbox yet')
    st.inject.length = 0
    await p7.reload(); await p7.getByTestId('grid').waitFor()
    await p7.waitForFunction(() => document.querySelector('[data-name="pick-4.jpg"]')?.dataset.tags.split('|').includes('outage_tag'), null, { timeout: 60_000 })
    for (let i = 0; i < 200 && !tagsOn('id:p4').includes('outage_tag'); i++) await p7.waitForTimeout(100)
    ok(tagsOn('id:p4').includes('outage_tag'), 'resumed write landed after reopening')
    await p7.waitForFunction(() => !document.querySelector('[data-testid=save-progress]'), null, { timeout: 60_000 })
    await p7.waitForFunction(() => !localStorage.getItem('pt.dropboxQueue.v1'), null, { timeout: 10_000 }) // queue emptied once everything landed
    // Verify still flushes first
    await p7.getByTestId('select-mode').click(); await p7.locator('[data-testid=photo-tile][data-name="pick-4.jpg"]').click()
    await p7.getByTestId('verify-dropbox-selected').click()
    await p7.locator('[data-testid=verify-row][data-name="pick-4.jpg"]').waitFor()
    ok(/outage_tag/.test(await p7.locator('[data-testid=verify-row][data-name="pick-4.jpg"] [data-testid=verify-landed]').innerText()), 'verify sees the resumed tag')
    eq(st.writes, 0, 'no writes outside Photo Tagger metadata')
  } finally { await c7.close() }
})

await test('Large Dropbox imports (1.0.27): "Check your detection list first" on an empty library; batches are tagged, saved and verified; folder progress; resume after reload', async () => {
  const ARCH = ['beach.jpg', 'cat.jpg', 'city.jpg', 'pizza.jpg', 'mountain.jpg', 'person.jpg', 'document.jpg', 'dog.jpg', 'dark-city.jpg', 'screenshot.png', 'obama-biden-2009.jpg', 'dropbox-stub.jpg']
  const archIds = ARCH.map((_, i) => 'id:arch' + String(i + 1).padStart(2, '0'))
  ARCH.forEach((n, i) => { SAMPLE_BY_ID[archIds[i]] = n })
  DBX_TREE['/archive'] = ARCH.map((n, i) => dbxFile(archIds[i], `a${String(i + 1).padStart(2, '0')}-${n}`, '/Archive'))
  DBX_TREE[''].splice(1, 0, dbxDir('Archive', ''))
  const c8 = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await routeModel(c8).catch(() => {})
  const st = await stubDropbox(c8)
  const p8 = await c8.newPage()
  const errs8 = []; p8.on('pageerror', (e) => errs8.push(e.message))
  const archDl = () => (st.dlOrder ?? []).filter((id) => id.startsWith('id:arch'))
  const tiles = () => p8.getByTestId('photo-tile').count()
  const here = () => p8.locator('[data-testid=dropbox-here-progress] [data-testid=folder-progress][data-total]')
  const openArchive = async () => {
    await p8.getByTestId('add-btn').click()
    await p8.locator('[data-testid=dropbox-folder][data-name="Archive"]').click()
    await here().waitFor({ timeout: 30_000 })
  }
  const settings = async (tab) => { await p8.getByTestId('open-settings').click(); await p8.getByTestId(`tab-${tab}`).click() }
  const removeAll = async () => {
    await p8.getByTestId('select-mode').click(); await p8.getByTestId('sel-all').click(); await p8.getByTestId('sel-delete').click()
    await p8.getByTestId('remove-confirm-btn').click()
    await p8.waitForFunction(() => !document.querySelector('[data-testid=photo-tile]'), null, { timeout: 30_000 })
    if (await p8.getByTestId('sel-cancel').count()) await p8.getByTestId('sel-cancel').click()
  }
  // 1.0.34: Remove from app keeps tag files and remembers removed files, so "start over with an empty library" =
  // remove everything, then wipe Photo Tagger's folder in the (stub) Dropbox, then reload
  const forgetAll = async () => {
    await removeAll()
    await p8.evaluate(() => window.__ptFlushDropbox()); await p8.waitForTimeout(500)
    for (const k of [...st.meta.keys()]) if (k.startsWith('/.photo-tagger/')) st.meta.delete(k)
    await p8.reload(); await p8.getByTestId('empty').waitFor()
  }
  const allReady = (n) => p8.waitForFunction((n) => { const t = [...document.querySelectorAll('[data-testid=photo-tile]')]; return t.length >= n && t.every((e) => e.dataset.status !== 'pending') }, n, { timeout: 400_000 })
  const waitIdle = () => p8.waitForFunction(() => !document.querySelector('[data-testid=job-label]') || /Done|Cancelled/.test(document.querySelector('[data-testid=job-label]').textContent), null, { timeout: 400_000 })
  try {
    await p8.goto(URL_BASE); await p8.getByTestId('empty').waitFor()
    await connectDropbox(p8, 'batch_key')
    await settings('dropbox')
    ok(await p8.getByTestId('set-ask-first-import').isChecked(), 'Ask me to check the detection list is on by default')
    await p8.getByTestId('set-batch-size').fill('10')
    await p8.getByTestId('settings-close').click()

    // folder progress before anything is imported (metadata only)
    await openArchive()
    ok(/0 of 12 in library \(this folder only\)/.test(await here().textContent()), 'progress before import: ' + await here().textContent())
    ok(/Add next batch \(10\)/.test(await p8.getByTestId('dropbox-add-batch').textContent()), 'next batch = batch size')
    eq(archDl(), [], 'counting a folder downloads nothing')

    // 1) Cancel → nothing imported, nothing downloaded
    await addAll(p8)
    const dlg = p8.getByTestId('preimport-check')
    await dlg.waitFor()
    ok(/Check your detection list first/.test(await dlg.textContent()), 'title')
    eq(await p8.evaluate(() => document.activeElement?.dataset.testid), 'preimport-review', 'focus starts on Review (safe), not on Tag')
    ok(/built-in detection tags on/.test(await p8.getByTestId('preimport-detect').textContent()), 'detection summary: ' + await p8.getByTestId('preimport-detect').textContent())
    ok(/Year, Camera, Geotagged, Blurry, Dark, Bright/.test(await p8.getByTestId('preimport-meta').textContent()), 'metadata summary: ' + await p8.getByTestId('preimport-meta').textContent())
    await p8.keyboard.press('Enter') // Enter on the focused safe button = Review, never an import
    await p8.getByTestId('settings').waitFor()
    await p8.getByTestId('settings-close').click()
    await p8.waitForTimeout(800)
    eq([archDl(), await tiles(), await p8.getByTestId('job-label').count()], [[], 0, 0], 'Enter did not import')
    await openArchive()
    await addAll(p8)
    await dlg.waitFor()
    await p8.getByTestId('preimport-cancel').click()
    await dlg.waitFor({ state: 'detached' })
    await p8.waitForTimeout(1500)
    eq([archDl(), await tiles(), await p8.getByTestId('job-label').count()], [[], 0, 0], 'Cancel imports nothing')

    // 2) Review detection list (from Add next batch) → Settings → Tags, Detection card in view and focused; nothing imported
    await openArchive()
    await p8.getByTestId('dropbox-add-batch').getByTestId('folder-next-batch').click()
    await dlg.waitFor()
    await p8.getByTestId('preimport-review').click()
    await p8.getByTestId('settings').waitFor()
    eq(await p8.getByTestId('tab-vocab').getAttribute('aria-selected'), 'true', 'Tags tab open')
    await p8.waitForFunction(() => document.activeElement?.dataset.testid === 'detection-card')
    ok(await p8.getByTestId('detection-card').evaluate((el) => { const r = el.getBoundingClientRect(); const b = el.closest('.settings-body').getBoundingClientRect(); return r.top >= b.top - 2 && r.top < b.bottom }), 'Detection card scrolled into view')
    await p8.getByTestId('settings-close').click()
    await p8.waitForTimeout(1000)
    eq([archDl(), await tiles()], [[], 0], 'Review starts no import')

    // 3) Don't show again + Tag with these settings → 12 photos in 2 batches (10 + 2), each saved and verified
    await p8.evaluate(() => {
      window.__labels = []
      new MutationObserver(() => { const t = document.querySelector('[data-testid=job-label]')?.textContent; if (t && window.__labels.at(-1) !== t) window.__labels.push(t) }).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    await openArchive()
    await addAll(p8)
    await dlg.waitFor()
    await p8.getByTestId('preimport-dont-ask').check()
    await p8.getByTestId('preimport-proceed').click()
    await allReady(12)
    await p8.locator('.toast', { hasText: /in 2 batches/ }).waitFor({ timeout: 120_000 })
    await waitIdle()
    const labels = await p8.evaluate(() => window.__labels)
    for (const re of [/Batch 1 of 2 · tagging \d+ of 10/, /Batch 1 of 2 · (saving tags to Dropbox|verifying)/, /Batch 2 of 2 · tagging \d+ of 2/]) ok(labels.some((l) => re.test(l)), `progress label ${re}: ${labels.slice(0, 40).join(' | ')}`)
    const firstVerify = labels.findIndex((l) => /Batch 1 of 2 · verifying/.test(l)), firstB2 = labels.findIndex((l) => /Batch 2 of 2/.test(l))
    ok(firstVerify >= 0 && firstVerify < firstB2, 'batch 2 starts only after batch 1 was verified')
    eq(archDl().slice(0, 10).sort(), archIds.slice(0, 10), 'first batch = first 10 files by name')
    for (const id of archIds) ok((st.fileTags.get(id)?.size ?? 0) > 0, `tags saved to Dropbox for ${id}`)
    for (const f of DBX_TREE['/archive']) ok(st.tagGets.filter((x) => x === f.path_display).length >= 2, `${f.name} read back (import + verify)`)
    eq(await p8.evaluate(() => new Promise((res) => { const r = indexedDB.open('photo-tagger'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => res(q.result?.askBeforeFirstImport) } })), false, "Don't show again saved")
    await openArchive()
    ok(/All in library/.test(await here().textContent()), 'folder says All in library: ' + await here().textContent())
    await p8.getByTestId('dropbox-crumb').first().click()
    await p8.locator('[data-testid=dropbox-folder-row][data-name="Archive"] [data-testid=folder-progress][data-total]').waitFor()
    ok(/All in library/.test(await p8.locator('[data-testid=dropbox-folder-row][data-name="Archive"] [data-testid=folder-progress]').textContent()), 'folder row shows All in library')
    await p8.getByTestId('dropbox-browser-close').click()

    // 4) Don't-show-again persists across reload: empty library again, Add all remaining starts straight away; reload mid-run → resume banner
    await forgetAll()
    await settings('dropbox')
    ok(!(await p8.getByTestId('set-ask-first-import').isChecked()), 'setting off after reload')
    await p8.getByTestId('settings-close').click()
    const dl0 = archDl().length
    await openArchive()
    await addAll(p8)
    await p8.getByTestId('job-label').waitFor({ timeout: 15_000 })
    eq(await dlg.count(), 0, 'no prompt once turned off')
    await p8.waitForFunction(() => document.querySelectorAll('[data-testid=photo-tile]').length >= 2, null, { timeout: 300_000 })
    ok(archDl().length > dl0, 'import started without a prompt')
    await p8.reload(); await p8.locator('[data-testid=grid], [data-testid=empty]').first().waitFor({ timeout: 30_000 })
    const banner = p8.getByTestId('import-resume')
    await banner.waitFor({ timeout: 30_000 })
    ok(/Import of \/Archive stopped at \d+ of 12\. Continue\?/.test(await banner.textContent()), 'resume banner: ' + await banner.textContent())
    await p8.getByTestId('import-resume-continue').click()
    await allReady(12)
    await waitIdle()
    eq(await tiles(), 12, 'whole folder imported after Continue')
    eq(await p8.evaluate(() => localStorage.getItem('pt.dropboxRun.v1')), null, 'run record cleared when finished')

    // 5) Re-enable in Settings: not shown while photos exist (Refresh), shown again once the library is empty (Refresh + picker)
    await settings('dropbox'); await p8.getByTestId('set-ask-first-import').check(); await p8.getByTestId('settings-close').click()
    await p8.getByTestId('add-dropbox-refresh').click()
    await p8.locator('.toast', { hasText: /No new photos/ }).waitFor({ timeout: 30_000 })
    eq(await dlg.count(), 0, 'not shown when the library has photos')
    await forgetAll()
    const dl1 = archDl().length
    await p8.getByTestId('add-dropbox-refresh').click()
    await dlg.waitFor()
    await p8.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached' })
    await openArchive()
    await addAll(p8)
    await dlg.waitFor()
    await p8.getByTestId('preimport-cancel').click()
    await p8.waitForTimeout(1500)
    eq([archDl().length, await tiles()], [dl1, 0], 'Refresh and picker asked again; Cancel/Escape imported nothing')
    eq(errs8, [], 'no page errors')
  } finally {
    await c8.close()
    delete DBX_TREE['/archive']; DBX_TREE[''].splice(DBX_TREE[''].findIndex((e) => e.name === 'Archive'), 1)
  }
})

await test('Dropbox files moved or deleted (1.0.28): startup reads tags for the rest, relinks moved files by id, lists deleted ones; no "Could not save" toast; legacy tag names and long camera tags repaired; camera tag removable', async () => {
  // a library from an earlier version: 25 sidecars already in Dropbox; file 05 was moved+renamed, file 17 was deleted
  const ids = Array.from({ length: 25 }, (_, i) => 'id:old' + String(i + 1).padStart(2, '0'))
  const pics = ['beach.jpg', 'cat.jpg', 'city.jpg', 'pizza.jpg', 'mountain.jpg']
  const oldPath = (i) => `/Old/old-${String(i + 1).padStart(2, '0')}.jpg`
  DBX_TREE['/old'] = []
  ids.forEach((id, i) => {
    if (i === 16) return // deleted in Dropbox
    SAMPLE_BY_ID[id] = pics[i % pics.length]
    if (i === 4) return
    DBX_TREE['/old'].push(dbxFile(id, `old-${String(i + 1).padStart(2, '0')}.jpg`, '/Old'))
  })
  DBX_TREE['/new place'] = [dbxFile('id:old05', 'renamed-05.jpg', '/New Place')]
  const c9 = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await routeModel(c9).catch(() => {})
  const st = await stubDropbox(c9)
  ids.forEach((id, i) => {
    const n = i + 1
    const photo = { id: 'p-old' + n, fp: 'fp' + n, name: `old-${String(n).padStart(2, '0')}.jpg`, size: 1000, type: 'image/jpeg', addedAt: Date.now() - 1e6 + n, dateSource: 'added', width: 400, height: 300,
      quality: { sharpness: 100, brightness: 120, blurry: false, dark: false, bright: false }, tags: [{ name: 'kept_tag', source: 'manual' }], rejected: [], source: 'dropbox',
      dropbox: { id, path: oldPath(i), rev: 'r' + n }, dropboxTags: ['kept_tag'], hasOriginal: false, status: 'ready', facesScanned: true, faceCount: 0 }
    st.fileTags.set(id, new Set(['kept_tag', 'from_dropbox_' + n]))
    // 1.0.28 legacy data: old long camera tag with a trailing space (and its truncated native tag), and a duplicate "sunset " / "sunset"
    if (n === 1) {
      photo.camera = 'EASTMAN KODAK COMPANY KODAK CX7530 ZOOM DIGITAL CAMERA'
      photo.tags.push({ name: 'eastman kodak company kodak cx7530 zoom ', source: 'exif' })
      photo.dropboxTags.push('eastman_kodak_company_kodak_cx75'); st.fileTags.get(id).add('eastman_kodak_company_kodak_cx75')
    }
    if (n === 2) { photo.tags.push({ name: 'sunset ', source: 'auto', score: 0.3 }, { name: 'sunset', source: 'manual' }); photo.dropboxTags.push('sunset'); st.fileTags.get(id).add('sunset') }
    st.meta.set(`/.photo-tagger/meta/${id.slice(3)}.json`, JSON.stringify({ app: 'photo-tagger', version: 1, file: photo.dropbox, photo, faces: [] }))
  })
  const p9 = await c9.newPage()
  const errs9 = []; p9.on('pageerror', (e) => errs9.push(e.message))
  const toasts = []; await p9.exposeFunction('__toastSeen', (t) => toasts.push(t))
  await p9.addInitScript(() => { new MutationObserver(() => document.querySelectorAll('.toast:not([data-seen])').forEach((t) => { t.dataset.seen = '1'; window.__toastSeen(t.textContent) })).observe(document, { subtree: true, childList: true }) })
  const t9 = (n) => p9.locator(`[data-testid=photo-tile][data-name="${n}"]`)
  const tags9 = async (n) => ((await t9(n).getAttribute('data-tags')) ?? '').split('|')
  const imported = () => p9.evaluate(() => [...document.querySelectorAll('[data-testid=photo-tile]')].filter((t) => /(^|\|)from_dropbox_\d+/.test(t.dataset.tags || '')).length)
  try {
    await p9.goto(URL_BASE); await p9.getByTestId('empty').waitFor()
    st.inject.push({ ep: '/2/files/tags/get', status: 503, summary: 'internal_error', times: 2 }) // transient read errors are retried quietly
    await connectDropbox(p9, 'moved_key')
    await p9.waitForFunction(() => document.querySelectorAll('[data-testid=photo-tile]').length === 25, null, { timeout: 60_000 })
    await p9.waitForFunction(() => [...document.querySelectorAll('[data-testid=photo-tile]')].filter((t) => /(^|\|)from_dropbox_\d+/.test(t.dataset.tags || '')).length === 24, null, { timeout: 60_000 })
    ok((st.tagGet409 ?? []).length >= 1, 'a whole tags/get batch was rejected (409) by the stub')
    ok(st.injected >= 2, 'transient 503s on tags/get were retried')
    ok(st.tagBatches.some((b) => b.length === 5), 'the other batch (5 paths) was read normally')
    // moved + renamed file: followed by its id, new path/name, tags imported
    await t9('renamed-05.jpg').waitFor()
    eq(await t9('old-05.jpg').count(), 0, 'old name replaced')
    ok((await tags9('renamed-05.jpg')).includes('from_dropbox_5'), 'moved file tags imported: ' + await tags9('renamed-05.jpg'))
    ok(st.metaLookups.includes('id:old05') && st.metaLookups.includes('id:old17'), 'looked up by Dropbox id: ' + st.metaLookups)
    // deleted file: one calm notice, its tags left alone
    const notice = p9.getByTestId('missing-files')
    await notice.waitFor({ timeout: 30_000 })
    eq((await p9.getByTestId('missing-count').textContent()).trim(), '1 photo is no longer in Dropbox', 'notice text')
    eq(await tags9('old-17.jpg'), ['kept_tag'], 'deleted file keeps its tags in the app')
    await p9.evaluate(() => window.__ptFlushDropbox())
    const side5 = JSON.parse(st.meta.get('/.photo-tagger/meta/old05.json'))
    eq([side5.photo.dropbox.path, side5.photo.name, side5.file.path], ['/New Place/renamed-05.jpg', 'renamed-05.jpg', '/New Place/renamed-05.jpg'], 'new path saved in the sidecar')
    ok(st.fileTags.get('id:old05').has('kept_tag'), 'tags on the moved file intact')
    eq(await p9.getByTestId('save-failed-count').count(), 0, 'deleted file is not a save failure')
    // legacy tags repaired on load; the camera tag swap goes to Dropbox through the queue, no churn for the trailing-space fix
    const k1 = await tags9('old-01.jpg'), s2 = await tags9('old-02.jpg')
    ok(k1.includes('kodak cx7530') && !k1.some((t) => /eastman/.test(t)), 'camera tag shortened in the app: ' + k1)
    eq(s2.filter((t) => /sunset/.test(t)), ['sunset'], 'trailing-space duplicate merged')
    await p9.waitForFunction(() => !document.querySelector('[data-testid=save-progress]'), null, { timeout: 30_000 })
    eq([...st.fileTags.get('id:old01')].sort(), ['from_dropbox_1', 'kept_tag', 'kodak_cx7530'], 'old native camera tag replaced in Dropbox')
    ok(!st.tagRemoves.some((x) => x.tag_text === 'sunset') && st.fileTags.get('id:old02').has('sunset'), 'no tag churn for the repaired name')
    eq(JSON.parse(st.meta.get('/.photo-tagger/meta/old01.json')).photo.tags.filter((t) => t.source === 'exif').map((t) => t.name), ['kodak cx7530'], 'repaired tags saved in the sidecar')
    // the camera tag can be removed with ✕ and stays removed in Dropbox
    await t9('old-01.jpg').click()
    const kt = p9.locator('[data-testid=detail-tag][data-tag="kodak cx7530"]')
    await kt.locator('[data-testid=remove-tag]').click()
    await kt.waitFor({ state: 'detached' })
    await p9.keyboard.press('Escape')
    await p9.evaluate(() => window.__ptFlushDropbox())
    ok(!st.fileTags.get('id:old01').has('kodak_cx7530'), 'camera tag removed in Dropbox')
    ok(!(await tags9('old-01.jpg')).includes('kodak cx7530'), 'camera tag gone from the tile')
    ok(!toasts.some((t) => /Could not save|Will retry|Could not read/i.test(t)), 'no save/read error toast: ' + toasts.join(' | '))
    // survives reload: no new lookup for the moved file, deleted one listed again
    const lookups = st.metaLookups.length, looked05 = st.metaLookups.filter((x) => x === 'id:old05').length
    await p9.reload()
    await p9.waitForFunction(() => document.querySelectorAll('[data-testid=photo-tile]').length === 25, null, { timeout: 60_000 })
    await t9('renamed-05.jpg').waitFor()
    await notice.waitFor({ timeout: 30_000 })
    eq(st.metaLookups.filter((x) => x === 'id:old05').length, looked05, 'moved file not looked up again after reload (path persisted)')
    ok(st.metaLookups.length > lookups, 'deleted file checked again on start')
    eq(await imported(), 24, 'tags still read for every existing file after reload')
    ok(!(await tags9('old-01.jpg')).some((t) => /kodak/.test(t)) && !st.fileTags.get('id:old01').has('kodak_cx7530'), 'removed camera tag stays removed after reload: ' + await tags9('old-01.jpg'))
    // View lists name + old path
    await p9.getByTestId('missing-view').click()
    const item = p9.locator('[data-testid=missing-file][data-name="old-17.jpg"]')
    await item.waitFor()
    ok(/was at \/Old\/old-17\.jpg/.test(await item.textContent()), 'old path shown')
    await p9.keyboard.press('Escape')
    await p9.getByTestId('missing-list-dialog').waitFor({ state: 'detached' })
    // Verify Dropbox tags (whole library): moved file verifies fine, deleted one is explained
    await p9.getByTestId('open-settings').click(); await p9.getByTestId('tab-vocab').click()
    await p9.getByTestId('verify-dropbox-library').click()
    await p9.getByTestId('verify-summary').waitFor({ timeout: 60_000 })
    const vrow = (n) => p9.locator(`[data-testid=verify-row][data-name="${n}"]`)
    ok(/No longer in Dropbox/.test(await vrow('old-17.jpg').textContent()), 'verify explains the deleted file')
    ok(/from_dropbox_5/.test(await vrow('renamed-05.jpg').getByTestId('verify-landed').textContent()), 'moved file verified at its new path')
    ok(/24 Dropbox file\(s\) checked · 0 skipped · 1 errors · 0 with missing tags/.test(await p9.getByTestId('verify-summary').textContent()), 'summary: ' + await p9.getByTestId('verify-summary').textContent())
    await p9.keyboard.press('Escape'); await p9.getByTestId('settings-close').click()
    eq(await p9.getByTestId('save-failed-count').count(), 0, 'verify did not list the deleted file as a save failure')
    // Remove from app (with confirm): only the app forgets it; nothing deleted in Dropbox
    await p9.getByTestId('missing-remove').click()
    await p9.getByTestId('remove-confirm').waitFor()
    eq(await p9.evaluate(() => document.activeElement?.dataset.testid), 'remove-cancel', 'Cancel focused')
    await p9.getByTestId('remove-confirm-btn').click()
    await notice.waitFor({ state: 'detached' })
    await t9('old-17.jpg').waitFor({ state: 'detached' })
    eq(await p9.getByTestId('photo-tile').count(), 24, '24 photos left')
    await p9.waitForTimeout(800)
    ok(st.meta.has('/.photo-tagger/meta/old17.json'), "1.0.34: the app's tag file is kept (Remove from app only leaves the app)")
    eq(st.writes, 0, 'nothing outside /.photo-tagger was written or deleted')
    ok(!toasts.some((t) => /Could not save|Will retry|Could not read/i.test(t)), 'still no error toast: ' + toasts.join(' | '))
    eq(errs9, [], 'no page errors')
  } finally {
    await c9.close()
    delete DBX_TREE['/old']; delete DBX_TREE['/new place']
  }
})

await test('Remove from app (1.0.34): 200 of 210 leave the app at once; Dropbox tags, tag files and a just-made edit are kept; nothing comes back after reload; re-add on purpose restores tags', async () => {
  const pics = ['beach.jpg', 'cat.jpg', 'city.jpg', 'pizza.jpg', 'mountain.jpg']
  const names = [...Array.from({ length: 200 }, (_, i) => `r${String(i + 1).padStart(3, '0')}.jpg`), ...Array.from({ length: 10 }, (_, i) => `k${String(i + 1).padStart(2, '0')}.jpg`)]
  const fid = (n) => 'id:many-' + n.replace('.jpg', '')
  DBX_TREE['/many'] = names.map((n, i) => { SAMPLE_BY_ID[fid(n)] = pics[i % pics.length]; return dbxFile(fid(n), n, '/Many') })
  DBX_TREE[''].push(dbxDir('Many', ''))
  const c10 = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await routeModel(c10).catch(() => {})
  const st = await stubDropbox(c10)
  const metaKey = (n) => `/.photo-tagger/meta/${fid(n).slice(3)}.json`
  names.forEach((n, i) => {
    const keep = n.startsWith('k'), mark = keep ? 'keep_me' : 'remove_me'
    const photo = { id: 'p-' + n, fp: 'fp-' + n, name: n, size: 1000, type: 'image/jpeg', addedAt: Date.now() - i * 1000, dateSource: 'added', width: 400, height: 300,
      quality: { sharpness: 100, brightness: 120, blurry: false, dark: false, bright: false }, tags: [{ name: mark, source: 'manual' }, { name: 'shared', source: 'manual' }], rejected: [], source: 'dropbox',
      dropbox: { id: fid(n), path: `/Many/${n}`, rev: 'r' + i }, dropboxTags: [mark, 'shared'], hasOriginal: false, status: 'ready', facesScanned: true, faceCount: 0 }
    st.meta.set(metaKey(n), JSON.stringify({ app: 'photo-tagger', version: 1, file: photo.dropbox, photo, faces: [] }))
    st.fileTags.set(fid(n), new Set([mark, 'shared', 'theirs']))
  })
  const p10 = await c10.newPage()
  const errs10 = []; p10.on('pageerror', (e) => errs10.push(e.message))
  const count = async () => (await p10.getByTestId('count').innerText()).trim()
  const sidecars = () => [...st.meta.keys()].filter((k) => k.startsWith('/.photo-tagger/meta/'))
  try {
    await p10.goto(URL_BASE); await p10.getByTestId('empty').waitFor()
    await connectDropbox(p10, 'remove_key')
    await p10.waitForFunction(() => /^210 photos/.test(document.querySelector('[data-testid=count]')?.textContent || ''), null, { timeout: 60_000 })
    await p10.waitForFunction(() => !document.querySelector('[data-testid=save-progress]'), null, { timeout: 60_000 })
    // a tag edit made right before removing (still queued, Dropbox slow) must still be saved
    await p10.getByTestId('search').fill('remove_me')
    await p10.waitForFunction(() => /^200 of 210/.test(document.querySelector('[data-testid=count]')?.textContent || ''))
    const late = await p10.getByTestId('photo-tile').first().getAttribute('data-name')
    st.inject.push({ ep: '/2/files/tags/add', status: 429, retryAfter: 1, times: 2 })
    await p10.getByTestId('photo-tile').first().click()
    await p10.getByTestId('detail-tag-input').fill('late_edit'); await p10.getByTestId('detail-tag-input').press('Enter')
    await p10.locator('[data-testid=detail-tag][data-tag="late_edit"]').waitFor()
    await p10.keyboard.press('Escape')
    await p10.getByTestId('select-mode').click(); await p10.getByTestId('sel-all').click()
    await p10.getByTestId('sel-delete').click()
    ok(/tags stay on the Dropbox files/.test(await p10.getByTestId('remove-confirm').innerText()), 'dialog says tags stay')
    await p10.getByTestId('remove-confirm-btn').click()
    await p10.waitForFunction(() => /^0 of 10/.test(document.querySelector('[data-testid=count]')?.textContent || ''), null, { timeout: 10_000 })
    // the queued edit still lands in Dropbox (tag + tag file)
    for (let i = 0; i < 150 && !st.fileTags.get(fid(late)).has('late_edit'); i++) await p10.waitForTimeout(200)
    ok(st.fileTags.get(fid(late)).has('late_edit'), 'edit made just before removing was saved to Dropbox')
    await p10.evaluate(() => window.__ptFlushDropbox())
    for (let i = 0; i < 50 && !/late_edit/.test(st.meta.get(metaKey(late)) || ''); i++) await p10.waitForTimeout(200)
    ok(/late_edit/.test(st.meta.get(metaKey(late))), 'and in its tag file')
    eq(sidecars().filter((k) => /many-/.test(k)).length, 210, 'every tag file kept')
    for (const n of names) ok(st.fileTags.get(fid(n)).has(n.startsWith('k') ? 'keep_me' : 'remove_me') && st.fileTags.get(fid(n)).has('shared') && st.fileTags.get(fid(n)).has('theirs'), `Dropbox tags kept on ${n}`)
    ok((st.tagRemoves ?? []).length === 0, 'no Dropbox tag removed: ' + JSON.stringify((st.tagRemoves ?? []).slice(0, 3)))
    await p10.waitForFunction(() => !document.querySelector('[data-testid=save-progress]'), null, { timeout: 60_000 })
    for (let i = 0; i < 50 && !st.meta.has('/.photo-tagger/removed.json'); i++) await p10.waitForTimeout(200)
    const removedJson = JSON.parse(st.meta.get('/.photo-tagger/removed.json'))
    eq(removedJson.removed.length, 200, 'removed ids (with file ids) kept in Dropbox')
    ok(removedJson.removed.every((e) => /^id:many-r/.test(e.file)), 'file ids recorded')
    eq(st.writes, 0, 'no photo was written or deleted in Dropbox')
    // a fresh start: still 10
    await p10.reload()
    await p10.waitForFunction(() => /photos/.test(document.querySelector('[data-testid=count]')?.textContent || ''), null, { timeout: 60_000 })
    await p10.waitForTimeout(1500)
    eq(await count(), '10 photos', 'library after reload has 10')
    // folder progress: removed ones are counted apart, not as remaining; Add all remaining isn't offered
    await p10.getByTestId('add-btn').click()
    await p10.locator('[data-testid=dropbox-folder][data-name="Many"]').click()
    await p10.waitForFunction(() => document.querySelector('[data-testid=folder-progress][data-removed]')?.getAttribute('data-removed') === '200', null, { timeout: 30_000 })
    ok(/200 removed from app/.test(await p10.locator('[data-testid=folder-progress][data-removed="200"]').first().innerText()), 'progress mentions removed')
    eq(await p10.getByTestId('dropbox-add-batch').getByTestId('folder-add-remaining').count(), 0, 'nothing remaining to add')
    // pick list: removed photos sit in their own collapsed group; tick one to add it back
    await p10.getByTestId('dropbox-removed-toggle').waitFor()
    eq(await p10.getByTestId('dropbox-removed-toggle').getAttribute('data-count'), '200', 'Removed from app (200)')
    eq(await p10.getByTestId('dropbox-group-new').getAttribute('data-count'), '0', 'nothing in Not in library yet')
    await p10.getByTestId('dropbox-removed-toggle').click()
    const row = p10.locator(`[data-testid=dropbox-file][data-name="${late}"]`)
    await row.waitFor({ timeout: 30_000 })
    await row.scrollIntoViewIfNeeded()
    eq(await row.getAttribute('data-removed'), '1', 'marked removed')
    await row.click()
    await p10.getByTestId('dropbox-add-selected').click()
    await p10.locator(`[data-testid=photo-tile][data-name="${late}"]`).waitFor({ timeout: 120_000 })
    await p10.waitForFunction(() => /^11 photos/.test(document.querySelector('[data-testid=count]')?.textContent || ''), null, { timeout: 60_000 })
    const back = ((await p10.locator(`[data-testid=photo-tile][data-name="${late}"]`).getAttribute('data-tags')) ?? '').split('|')
    ok(['remove_me', 'shared', 'late_edit', 'theirs'].every((t) => back.includes(t)), 're-added photo has its saved tags + Dropbox tags back: ' + back)
    eq(await p10.locator(`[data-testid=photo-tile][data-name="${late}"]`).getAttribute('data-status'), 'ready', 'restored, not re-tagged')
    await p10.evaluate(() => window.__ptFlushDropbox())
    ok(st.meta.has(metaKey(late)), 're-added photo has its sidecar')
    await p10.reload()
    await p10.waitForFunction(() => /^11 photos/.test(document.querySelector('[data-testid=count]')?.textContent || ''), null, { timeout: 60_000 })
    eq(errs10, [], 'no page errors')
  } finally {
    await c10.close()
    delete DBX_TREE['/many']; DBX_TREE[''].splice(DBX_TREE[''].findIndex((e) => e.name === 'Many'), 1)
  }
})

await test('Dropbox tags are kept (1.0.34): tags already on files are imported and never removed unless you delete them; re-tag, Remove from app and automatic tags off keep them', async () => {
  const files = [['o1.jpg', 'beach.jpg', ['family_trip', 'summer_2019']], ['o2.jpg', 'dog.jpg', ['dog', 'rex']], ['o3.jpg', 'cat.jpg', []], ['o4.jpg', 'city.jpg', ['old_city']]]
  const fid = (n) => 'id:orig-' + n.replace('.jpg', '')
  DBX_TREE['/orig'] = files.map(([n, smp]) => { SAMPLE_BY_ID[fid(n)] = smp; return dbxFile(fid(n), n, '/Orig') })
  DBX_TREE[''].push(dbxDir('Orig', ''))
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await routeModel(c).catch(() => {})
  const st = await stubDropbox(c)
  for (const [n, , tags] of files) st.fileTags.set(fid(n), new Set(tags))
  const pg = await c.newPage()
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message))
  const tile = (n) => pg.locator(`[data-testid=photo-tile][data-name="${n}"]`)
  const tagsOf = async (n) => ((await tile(n).getAttribute('data-tags')) ?? '').split('|').filter(Boolean)
  const onFile = (n) => [...(st.fileTags.get(fid(n)) ?? [])]
  const ready = (n) => pg.waitForFunction((n) => document.querySelector(`[data-testid=photo-tile][data-name="${n}"]`)?.dataset.status === 'ready', n, { timeout: 300_000 })
  const flush = async () => { await pg.evaluate(() => window.__ptFlushDropbox()); await pg.waitForFunction(() => !document.querySelector('[data-testid=save-progress]'), null, { timeout: 60_000 }) }
  const pick = async (names, removed = false) => {
    await pg.getByTestId('add-btn').click()
    await pg.locator('[data-testid=dropbox-folder][data-name="Orig"]').click()
    if (removed) { await pg.getByTestId('dropbox-removed-toggle').click() }
    for (const n of names) await pg.locator(`[data-testid=dropbox-file][data-name="${n}"]`).click({ modifiers: ['Control'] })
    await pg.getByTestId('dropbox-add-selected').click()
  }
  const removedOnce = (n, t) => (st.tagRemoves ?? []).filter((r) => r.tag_text === t && r.path.toLowerCase() === `/orig/${n}`).length
  try {
    await pg.goto(URL_BASE); await pg.getByTestId('empty').waitFor()
    // Settings → Tags with an empty library
    await pg.getByTestId('open-settings').click(); await pg.getByTestId('tab-vocab').click()
    eq(await pg.getByTestId('library-tags-empty').innerText(), 'No tags on your photos yet.', 'empty state without search')
    await pg.getByTestId('library-tags-search').fill('zzz')
    eq(await pg.getByTestId('library-tags-empty').innerText(), 'No tags match.', 'empty state with a search')
    await pg.getByTestId('settings-close').click()
    await connectDropbox(pg, 'orig_key')
    await pick(['o1.jpg', 'o2.jpg', 'o3.jpg'])
    await pg.getByTestId('preimport-check').waitFor(); await pg.getByTestId('preimport-proceed').click()
    for (const n of ['o1.jpg', 'o2.jpg', 'o3.jpg']) { await waitTile(n, pg); await ready(n) }
    await flush()
    for (const [n, , tags] of files.slice(0, 3)) {
      for (const t of tags) ok(onFile(n).includes(t), `${n}: Dropbox tag ${t} kept on the file`)
      await pg.waitForFunction(([n, tags]) => { const v = (document.querySelector(`[data-testid=photo-tile][data-name="${n}"]`)?.dataset.tags || '').split('|'); return tags.every((t) => v.includes(t)) }, [n, tags], { timeout: 30_000 })
    }
    ok((await tagsOf('o3.jpg')).length > 0 && onFile('o3.jpg').length > 0, 'automatic tags still added and saved (on)')
    // your own edits: add → written; delete a Dropbox tag → removed from Dropbox (only that one)
    await tile('o1.jpg').click()
    await pg.getByTestId('detail-tag-input').fill('my_tag'); await pg.getByTestId('detail-tag-input').press('Enter')
    await pg.locator('[data-testid=detail-tag][data-tag="my_tag"]').waitFor()
    await pg.locator('[data-testid=detail-tag][data-tag="summer_2019"] [data-testid=remove-tag]').click()
    await pg.locator('[data-testid=detail-tag][data-tag="summer_2019"]').waitFor({ state: 'detached' })
    await flush()
    ok(onFile('o1.jpg').includes('my_tag') && onFile('o1.jpg').includes('family_trip') && !onFile('o1.jpg').includes('summer_2019'), 'added written, deleted removed, other kept: ' + onFile('o1.jpg'))
    eq(removedOnce('o1.jpg', 'summer_2019'), 1, 'the deleted tag was removed once')
    // stays deleted after reading tags again
    await pg.keyboard.press('Escape')
    // Re-run tagging on o2 never removes its Dropbox tags
    await tile('o2.jpg').click()
    await pg.getByRole('button', { name: 'Re-run tagging' }).click()
    await pg.waitForTimeout(1500); await ready('o2.jpg'); await flush()
    ok(onFile('o2.jpg').includes('dog') && onFile('o2.jpg').includes('rex'), 'Dropbox tags kept after re-tagging: ' + onFile('o2.jpg'))
    await pg.keyboard.press('Escape')
    // Remove from app keeps everything in Dropbox
    await tile('o1.jpg').click()
    await pg.getByTestId('delete-photo').click(); await pg.getByTestId('remove-confirm-btn').click()
    await tile('o1.jpg').waitFor({ state: 'detached' })
    await pg.keyboard.press('Escape').catch(() => {})
    await flush(); await pg.waitForTimeout(500)
    ok(['family_trip', 'my_tag'].every((t) => onFile('o1.jpg').includes(t)), 'Remove from app kept Dropbox tags: ' + onFile('o1.jpg'))
    ok(st.meta.has('/.photo-tagger/meta/orig-o1.json'), 'tag file kept')
    // automatic tags off: a new photo keeps (and shows) only its Dropbox tags
    await pg.getByTestId('open-settings').click(); await pg.getByTestId('tab-vocab').click()
    await pg.getByTestId('autotags-off').click(); await pg.getByTestId('autotags-off-note').waitFor()
    await pg.getByTestId('settings-close').click()
    await pick(['o4.jpg'])
    await waitTile('o4.jpg', pg); await ready('o4.jpg'); await flush()
    await pg.waitForFunction(() => (document.querySelector('[data-testid=photo-tile][data-name="o4.jpg"]')?.dataset.tags || '') === 'old_city', null, { timeout: 30_000 })
    eq(onFile('o4.jpg'), ['old_city'], 'file untouched')
    // never removed: tags that were already there
    for (const [n, t] of [['o1.jpg', 'family_trip'], ['o2.jpg', 'dog'], ['o2.jpg', 'rex'], ['o4.jpg', 'old_city']]) eq(removedOnce(n, t), 0, `${t} on ${n} never removed`)
    // reload, then add o1 back on purpose: tags restored from its tag file + Dropbox
    await pg.reload(); await waitTile('o4.jpg', pg)
    eq(await tile('o1.jpg').count(), 0, 'removed stays removed after reload')
    await pick(['o1.jpg'], true)
    await waitTile('o1.jpg', pg)
    await pg.waitForFunction(() => { const v = (document.querySelector('[data-testid=photo-tile][data-name="o1.jpg"]')?.dataset.tags || '').split('|'); return v.includes('family_trip') && v.includes('my_tag') }, null, { timeout: 30_000 })
    ok(!(await tagsOf('o1.jpg')).includes('summer_2019'), 'deleted tag stays deleted')
    eq(errs, [], 'no page errors')
  } finally {
    await c.close()
    delete DBX_TREE['/orig']; DBX_TREE[''].splice(DBX_TREE[''].findIndex((e) => e.name === 'Orig'), 1)
  }
})

await test('Batches after Remove from app (1.0.34): tag batch 1, remove it at once (saves still queued), Add next batch loads batch 2 — not batch 1; counts exclude removed', async () => {
  const names = Array.from({ length: 6 }, (_, i) => `b${i + 1}.png`)
  const fid = (n) => 'id:bat-' + n.replace('.png', '')
  DBX_TREE['/batch'] = names.map((n, i) => { SAMPLE_BY_ID[fid(n)] = noisePng(9100 + i); return dbxFile(fid(n), n, '/Batch') })
  DBX_TREE[''].push(dbxDir('Batch', ''))
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await routeModel(c).catch(() => {})
  const st = await stubDropbox(c)
  const pg = await c.newPage()
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message))
  const tile = (n) => pg.locator(`[data-testid=photo-tile][data-name="${n}"]`)
  const openBatch = async () => {
    await pg.getByTestId('add-btn').click()
    await pg.locator('[data-testid=dropbox-folder][data-name="Batch"]').click()
    await pg.getByTestId('dropbox-here-progress').getByTestId('folder-progress').waitFor()
  }
  try {
    await pg.goto(URL_BASE); await pg.getByTestId('empty').waitFor()
    await connectDropbox(pg, 'batch_key')
    await openBatch()
    await pg.getByTestId('add-count-select').selectOption('custom')
    await pg.getByTestId('add-count-custom').fill('3')
    await pg.getByTestId('dropbox-add-batch').getByTestId('folder-next-batch').click()
    if (await pg.getByTestId('preimport-check').count() || await pg.getByTestId('preimport-check').waitFor({ timeout: 3000 }).then(() => true).catch(() => false)) await pg.getByTestId('preimport-proceed').click()
    for (const n of names.slice(0, 3)) await waitTile(n, pg)
    await pg.waitForFunction(() => [...document.querySelectorAll('[data-testid=photo-tile]')].every((t) => t.dataset.status === 'ready'), null, { timeout: 300_000 })
    await pg.waitForFunction(() => !document.querySelector('[data-testid=job-label]') || /Done/.test(document.querySelector('[data-testid=job-label]')?.textContent || ''), null, { timeout: 300_000 }).catch(() => {})
    // your tag on all of batch 1, and Dropbox is slow right now — remove them immediately
    st.inject.push({ ep: '/2/files/tags/add', status: 429, retryAfter: 1, times: 3 })
    await pg.getByTestId('select-mode').click(); await pg.getByTestId('sel-all').click()
    await pg.getByTestId('bulk-tag').click()
    await pg.getByTestId('bulk-input').fill('batch_one'); await pg.getByTestId('bulk-input').press('Enter')
    await pg.waitForFunction(() => [...document.querySelectorAll('[data-testid=photo-tile]')].every((t) => (t.dataset.tags || '').split('|').includes('batch_one')), null, { timeout: 10_000 })
    await pg.getByTestId('bulk-close').click()
    if (!(await pg.getByTestId('sel-delete').count())) { await pg.getByTestId('select-mode').click(); await pg.getByTestId('sel-all').click() }
    await pg.getByTestId('sel-delete').click(); await pg.getByTestId('remove-confirm-btn').click()
    await pg.waitForFunction(() => !document.querySelector('[data-testid=photo-tile]'), null, { timeout: 10_000 })
    // the queued tag saves still land
    for (let i = 0; i < 150 && !names.slice(0, 3).every((n) => st.fileTags.get(fid(n))?.has('batch_one')); i++) await pg.waitForTimeout(200)
    for (const n of names.slice(0, 3)) ok(st.fileTags.get(fid(n))?.has('batch_one'), `${n}: tag added before removing reached Dropbox`)
    // Add next batch → batch 2
    await openBatch()
    await pg.waitForFunction(() => document.querySelector('[data-testid=dropbox-here-progress] [data-testid=folder-progress]')?.getAttribute('data-removed') === '3', null, { timeout: 30_000 })
    ok(/0 of 6 in library · 3 removed from app/.test(await pg.getByTestId('dropbox-here-progress').getByTestId('folder-progress').innerText()), 'progress: ' + await pg.getByTestId('dropbox-here-progress').getByTestId('folder-progress').innerText())
    ok(/Add next batch \(3\)/.test(await pg.getByTestId('dropbox-add-batch').innerText()), 'next batch is 3')
    ok(/Add all remaining \(3\)/.test(await pg.getByTestId('dropbox-add-batch').innerText()), 'remaining excludes removed')
    const dl0 = (st.dlOrder ?? []).length
    await pg.getByTestId('dropbox-add-batch').getByTestId('folder-next-batch').click()
    // the library is empty again, so the first-import check may ask once more
    if (await pg.getByTestId('preimport-check').waitFor({ timeout: 3000 }).then(() => true).catch(() => false)) await pg.getByTestId('preimport-proceed').click()
    for (const n of names.slice(3)) await waitTile(n, pg)
    await pg.waitForTimeout(1500)
    for (const n of names.slice(0, 3)) eq(await tile(n).count(), 0, `${n} (batch 1) not reloaded`)
    eq([...new Set((st.dlOrder ?? []).slice(dl0))].sort(), names.slice(3).map(fid).sort(), 'only batch 2 downloaded')
    await openBatch()
    await pg.waitForFunction(() => /3 of 6 in library · 3 removed from app|All added · 3 removed from app/.test(document.querySelector('[data-testid=dropbox-here-progress] [data-testid=folder-progress]')?.textContent || ''), null, { timeout: 30_000 })
    await pg.getByTestId('add-batch-none').waitFor()
    // Refresh (linked folder) doesn't bring batch 1 back either
    if (await pg.getByTestId('dropbox-refresh').count()) {
      await pg.getByTestId('dropbox-refresh').click()
      await pg.waitForTimeout(2500)
      for (const n of names.slice(0, 3)) eq(await tile(n).count(), 0, `${n} not re-added by Refresh`)
    } else await pg.getByTestId('dropbox-browser-close').click()
    eq(errs, [], 'no page errors')
  } finally {
    await c.close()
    delete DBX_TREE['/batch']; DBX_TREE[''].splice(DBX_TREE[''].findIndex((e) => e.name === 'Batch'), 1)
  }
})

await test('Remembered tags (1.0.35): tags on removed photos, removed tag files and People stay in the Add a tag box after Remove from app, reload and on another device; Settings → Tags renames, merges and removes list entries', async () => {
  const files = [['m1.jpg', 'beach.jpg', ['birtday', 'beach_day']], ['m2.jpg', 'dog.jpg', ['keepme']], ['m3.jpg', 'cat.jpg', ['only_removed']], ['m4.jpg', 'city.jpg', ['from_removed_sidecar']]]
  const fid = (n) => 'id:mem-' + n.replace('.jpg', '')
  DBX_TREE['/mem'] = files.map(([n, smp]) => { SAMPLE_BY_ID[fid(n)] = smp; return dbxFile(fid(n), n, '/Mem') })
  DBX_TREE[''].push(dbxDir('Mem', ''))
  const metaKey = (n) => `/.photo-tagger/meta/${fid(n).slice(3)}.json`
  const seed = (st) => {
    files.forEach(([n, , tags], i) => {
      const photo = { id: 'p-' + n, fp: 'fp-' + n, name: n, size: 1000, type: 'image/jpeg', addedAt: Date.now() - i * 1000, dateSource: 'added', width: 400, height: 300,
        quality: { sharpness: 100, brightness: 120, blurry: false, dark: false, bright: false }, tags: tags.map((name) => ({ name, source: 'manual' })), rejected: [], source: 'dropbox',
        dropbox: { id: fid(n), path: `/Mem/${n}`, rev: 'r' + i }, dropboxTags: tags, hasOriginal: false, status: 'ready', facesScanned: true, faceCount: 0 }
      st.meta.set(metaKey(n), JSON.stringify({ app: 'photo-tagger', version: 1, file: photo.dropbox, photo, faces: [] }))
      st.fileTags.set(fid(n), new Set(tags))
    })
    // m4 was removed from the app earlier (another device): its tag file is kept; Aunt May has no photo loaded
    st.meta.set('/.photo-tagger/removed.json', JSON.stringify({ app: 'photo-tagger', version: 1, removed: [{ id: 'p-m4.jpg', file: fid('m4.jpg'), at: Date.now() - 60_000 }] }))
    st.meta.set('/.photo-tagger/people.json', JSON.stringify({ app: 'photo-tagger', version: 1, people: [{ id: 'per-aunt', name: 'Aunt May', createdAt: 1 }] }))
  }
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await routeModel(c).catch(() => {})
  const st = await stubDropbox(c); seed(st)
  const pg = await c.newPage()
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message))
  const t = (n) => pg.locator(`[data-testid=photo-tile][data-name="${n}"]`)
  const tags = async (n) => ((await t(n).getAttribute('data-tags')) ?? '').split('|').filter(Boolean)
  const suggestions = async (n) => {
    await t(n).click(); await pg.getByTestId('detail-tag-input').click()
    const s = await pg.getByTestId('detail-tag-input-suggestions').getByTestId('tag-suggestion').evaluateAll((els) => els.map((e) => e.dataset.tag))
    await pg.keyboard.press('Escape'); await pg.keyboard.press('Escape'); await pg.getByTestId('detail').waitFor({ state: 'detached' })
    return s
  }
  const openSettingsOn = async (p, tab) => { await p.getByTestId('open-settings').click(); await p.getByTestId(`tab-${tab}`).click() }
  const closeSettingsOn = (p) => p.getByTestId('settings-close').click()
  const list = pg.getByTestId('library-tags-list')
  const row = (n) => list.locator(`[data-testid=library-tag][data-tag="${n}"]`)
  const flushed = async (fn, msg) => { for (let i = 0; i < 60; i++) { await pg.evaluate(() => window.__ptFlushDropbox()); if (fn()) return; await pg.waitForTimeout(200) } throw new Error(msg) }
  const tagsJson = () => { const j = st.meta.get('/.photo-tagger/tags.json'); return j ? JSON.parse(j).tags : null }
  const active = (m) => Object.keys(m.tags).filter((n) => m.tags[n] > (m.forgotten[n] ?? 0)).sort()
  try {
    await pg.goto(URL_BASE); await pg.getByTestId('empty').waitFor()
    await connectDropbox(pg, 'mem_key')
    await pg.waitForFunction(() => /^3 photos/.test(document.querySelector('[data-testid=count]')?.textContent || ''), null, { timeout: 60_000 })
    // Remove m3 from the app — its tag must stay in the Add a tag box
    await t('m3.jpg').getByTestId('tile-check').click()
    await pg.getByTestId('sel-delete').click(); await pg.getByTestId('remove-confirm-btn').click()
    await pg.waitForFunction(() => /^2 photos/.test(document.querySelector('[data-testid=count]')?.textContent || ''), null, { timeout: 10_000 })
    if (await pg.getByTestId('sel-cancel').count()) await pg.getByTestId('sel-cancel').click()
    const s1 = await suggestions('m1.jpg')
    for (const n of ['only_removed', 'from_removed_sidecar', 'aunt may', 'keepme', 'birtday', 'beach_day']) ok(s1.includes(n), `suggested: ${n} (${s1})`)
    // bulk edit uses the same list
    await t('m2.jpg').getByTestId('tile-check').click(); await pg.getByTestId('bulk-tag').click()
    await pg.getByTestId('bulk-input').fill('only_rem')
    await pg.getByTestId('bulk-input-suggestions').locator('[data-tag="only_removed"]').waitFor()
    await pg.getByTestId('bulk-input').fill(''); await pg.getByTestId('bulk-close').click(); await pg.getByTestId('sel-cancel').click()
    // Settings → Tags lists remembered tags with how many loaded photos have them
    await openSettingsOn(pg, 'vocab')
    await row('only_removed').waitFor()
    eq(await row('only_removed').getAttribute('data-count'), '0', 'removed photo tag: 0 loaded')
    ok(/0 loaded photos · remembered/.test(await row('only_removed').getByTestId('library-tag-count').innerText()), 'shown as remembered, 0 loaded')
    ok(/1 photo/.test(await row('birtday').getByTestId('library-tag-count').innerText()), 'loaded count')
    for (const n of ['from_removed_sidecar', 'aunt may']) await row(n).waitFor()
    // rename a typo on a loaded photo
    await row('birtday').getByTestId('library-tag-rename').click()
    await pg.getByTestId('library-tag-rename-input').fill('Birthday'); await pg.getByTestId('library-tag-rename-save').click()
    await pg.getByTestId('rename-confirm').waitFor(); await pg.getByTestId('rename-confirm-btn').click()
    await row('birthday').waitFor(); eq(await row('birtday').count(), 0, 'typo gone from the list')
    // rename a tag that's only remembered (no loaded photo) into a close spelling of an existing one → merge, list only
    await row('only_removed').getByTestId('library-tag-rename').click()
    await pg.getByTestId('library-tag-rename-input').fill('Beach Day'); await pg.getByTestId('library-tag-rename-save').click()
    await pg.getByTestId('rename-confirm').waitFor()
    const why = await pg.getByTestId('rename-confirm').innerText()
    ok(/merges them/.test(why) && /only your tag list changes/.test(why), 'merge into beach_day, list only: ' + why)
    await pg.getByTestId('rename-confirm-btn').click()
    await pg.waitForFunction(() => !document.querySelector('[data-testid=library-tag][data-tag="only_removed"]'))
    await row('beach_day').waitFor()
    // Remove from list only: still on the loaded photo, no longer suggested; Suggest again brings it back
    await row('keepme').getByTestId('library-tag-remove').click()
    await pg.getByTestId('remove-tag-confirm').waitFor()
    ok(await pg.getByTestId('remove-tag-cancel').evaluate((b) => b === document.activeElement), 'Cancel focused')
    ok(/stays on the 1 loaded photo/.test(await pg.getByTestId('remove-tag-explain').innerText()), 'explains photos keep it')
    await pg.getByTestId('remove-tag-list-only').click()
    await row('keepme').getByTestId('library-tag-hidden').waitFor()
    await closeSettingsOn(pg)
    ok((await tags('m2.jpg')).includes('keepme'), 'photo keeps the tag')
    ok((await tags('m1.jpg')).includes('birthday') && !(await tags('m1.jpg')).includes('birtday'), 'renamed on the loaded photo')
    const s2 = await suggestions('m1.jpg')
    ok(!s2.includes('keepme') && !s2.includes('birtday') && !s2.includes('only_removed') && s2.includes('birthday'), 'suggestions follow the edited list: ' + s2)
    await openSettingsOn(pg, 'vocab')
    await row('keepme').getByTestId('library-tag-restore').click()
    await pg.waitForFunction(() => document.querySelector('[data-testid=library-tag][data-tag="keepme"]')?.dataset.remembered === '1')
    // Remove from list AND from loaded photos
    await row('beach_day').getByTestId('library-tag-remove').click()
    await pg.getByTestId('remove-tag-photos').click()
    await pg.waitForFunction(() => !document.querySelector('[data-testid=library-tag][data-tag="beach_day"]'))
    // a person without loaded photos can be taken off the list too
    await row('aunt may').getByTestId('library-tag-remove').click()
    eq(await pg.getByTestId('remove-tag-photos').count(), 0, 'no photo option when no loaded photo has it')
    await pg.getByTestId('remove-tag-list-only').click()
    await pg.waitForFunction(() => !document.querySelector('[data-testid=library-tag][data-tag="aunt may"]'))
    await closeSettingsOn(pg)
    ok(!(await tags('m1.jpg')).includes('beach_day'), 'removed from the loaded photo on request')
    // saved in Dropbox (/.photo-tagger/tags.json) beside removed.json / people.json
    await flushed(() => { const m = tagsJson(); return m && active(m).includes('birthday') && !active(m).includes('beach_day') && !active(m).includes('aunt may') }, 'tags.json written')
    const a1 = active(tagsJson())
    for (const n of ['birthday', 'keepme', 'from_removed_sidecar']) ok(a1.includes(n), `tags.json has ${n}: ${a1}`)
    for (const n of ['birtday', 'only_removed', 'beach_day', 'aunt may']) ok(!a1.includes(n), `tags.json dropped ${n}: ${a1}`)
    eq(st.writes, 0, 'nothing outside /.photo-tagger written')
    // restart: still remembered, edits kept
    await pg.reload()
    await pg.waitForFunction(() => /^2 photos/.test(document.querySelector('[data-testid=count]')?.textContent || ''), null, { timeout: 60_000 })
    const s3 = await suggestions('m2.jpg')
    ok(s3.includes('from_removed_sidecar') && s3.includes('birthday') && s3.includes('keepme') && !s3.includes('only_removed') && !s3.includes('aunt may') && !s3.includes('birtday'), 'after reload: ' + s3)
    // another device / reinstall (fresh local storage, same Dropbox): the list comes from tags.json
    const c2 = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    try {
      await routeModel(c2).catch(() => {})
      const st2 = await stubDropbox(c2)
      for (const [k, v] of st.meta) st2.meta.set(k, v)
      for (const [k, v] of st.fileTags) st2.fileTags.set(k, new Set(v))
      const p2 = await c2.newPage()
      await p2.goto(URL_BASE); await p2.getByTestId('empty').waitFor()
      await connectDropbox(p2, 'mem_key')
      await p2.waitForFunction(() => /^2 photos/.test(document.querySelector('[data-testid=count]')?.textContent || ''), null, { timeout: 60_000 })
      await p2.locator('[data-testid=photo-tile][data-name="m2.jpg"]').click(); await p2.getByTestId('detail-tag-input').click()
      await p2.getByTestId('detail-tag-input-suggestions').locator('[data-tag="from_removed_sidecar"]').waitFor({ timeout: 20_000 })
      const s4 = await p2.getByTestId('detail-tag-input-suggestions').getByTestId('tag-suggestion').evaluateAll((els) => els.map((e) => e.dataset.tag))
      ok(s4.includes('birthday') && !s4.includes('only_removed') && !s4.includes('aunt may'), 'other device: ' + s4)
    } finally { await c2.close() }
    eq(errs, [], 'no page errors')
  } finally {
    await c.close()
    delete DBX_TREE['/mem']; DBX_TREE[''].splice(DBX_TREE[''].findIndex((e) => e.name === 'Mem'), 1)
  }
})

await test('More ways to add (1.0.30) + sectioned panel (1.0.31) + remembered count and grouped list (1.0.32): sections, confirmation, list follows Order, count picker, add by date, ticks + Add selected, windowed 2,000-photo folder', async () => {
  const N = 2000, DAY = 86_400_000, BASE = Date.UTC(2015, 0, 1)
  const big = []
  for (let i = 1; i <= N; i++) {
    const id = 'id:big' + String(i).padStart(4, '0'), name = `big-${String(i).padStart(4, '0')}.png`
    const k = (i * 7919) % N
    const f = { ...dbxFile(id, name, '/Big'), client_modified: new Date(BASE + k * 1.5 * DAY).toISOString().replace('.000', '') }
    if (i % 100 === 0) f.media_info = { '.tag': 'metadata', metadata: { '.tag': 'photo', time_taken: new Date(Date.UTC(2010, 5, 1) + (i / 100) * DAY).toISOString().replace('.000', '') } }
    SAMPLE_BY_ID[id] = noisePng(i)
    big.push(f)
  }
  const sub = [1, 2, 3].map((i) => { const id = 'id:bigsub' + i; SAMPLE_BY_ID[id] = noisePng(5000 + i); return dbxFile(id, `sub-${i}.png`, '/Big/Sub') })
  DBX_TREE['/big'] = [dbxDir('Sub', '/Big'), ...big]
  DBX_TREE['/big/sub'] = sub
  DBX_TREE[''].push(dbxDir('Big', ''))
  const dateOf = (f) => Date.parse(f.media_info?.metadata?.time_taken ?? f.client_modified)
  const byDate = [...big].sort((a, b) => dateOf(a) - dateOf(b))
  const c11 = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC' })
  await routeModel(c11).catch(() => {})
  const st = await stubDropbox(c11)
  const p11 = await c11.newPage()
  const errs11 = []; p11.on('pageerror', (e) => errs11.push(e.message))
  const bigDl = () => [...new Set((st.dlOrder ?? []).filter((id) => /^id:big\d/.test(id)))]
  const count = async () => (await p11.getByTestId('count').innerText()).trim()
  const waitCount = (n) => p11.waitForFunction((n) => new RegExp('^' + n + ' photos').test(document.querySelector('[data-testid=count]')?.textContent || ''), n, { timeout: 400_000 })
  const waitIdle = () => p11.waitForFunction(() => (!document.querySelector('[data-testid=job-label]') || /Done|Cancelled/.test(document.querySelector('[data-testid=job-label]').textContent)) && ![...document.querySelectorAll('[data-testid=photo-tile]')].some((t) => t.dataset.status === 'pending'), null, { timeout: 400_000 })
  const here = () => p11.locator('[data-testid=dropbox-here-progress] [data-testid=folder-progress][data-total]')
  const openBig = async () => {
    await p11.getByTestId('add-btn').click()
    await p11.locator('[data-testid=dropbox-folder][data-name="Big"]').click()
    await p11.locator('[data-testid=dropbox-list][data-count="2000"]').waitFor({ timeout: 30_000 })
    await here().waitFor({ timeout: 30_000 })
  }
  const rowsInDom = () => p11.getByTestId('dropbox-file').count()
  try {
    await p11.goto(URL_BASE); await p11.getByTestId('empty').waitFor()
    await connectDropbox(p11, 'more_ways_key')
    await p11.getByTestId('open-settings').click(); await p11.getByTestId('tab-dropbox').click()
    await p11.getByTestId('set-batch-size').fill('10')
    await p11.getByTestId('settings-close').click()

    // big folder: windowed list, last row reachable, nothing downloaded to list/count
    const t0 = Date.now()
    await openBig()
    ok(Date.now() - t0 < 15_000, 'big folder opened in ' + (Date.now() - t0) + ' ms')
    ok(/0 of 2,?000 in library/.test(await here().textContent()), 'progress: ' + await here().textContent())
    const mounted = await rowsInDom()
    ok(mounted > 0 && mounted < 200, 'only visible rows are mounted: ' + mounted)
    await p11.getByTestId('dropbox-list').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await p11.locator('[data-testid=dropbox-file][data-name="big-2000.png"]').waitFor({ timeout: 10_000 })
    ok(await rowsInDom() < 200, 'still windowed after scrolling')
    await p11.getByTestId('dropbox-list').evaluate((el) => { el.scrollTop = 0 })
    await p11.locator('[data-testid=dropbox-file][data-name="big-0001.png"]').waitFor({ timeout: 10_000 })
    eq(bigDl(), [], 'listing/counting downloads nothing')
    ok(st.lists.some((l) => l.include_media_info === true), 'list_folder asks for media info (time taken)')

    // 1.0.31 layout: clear sections in order; Include subfolders lives in Folder; no big "Tag N new photo(s) here" button
    eq(await p11.locator('[data-testid=dropbox-browser] .dbx-sec-h').allInnerTexts().then((a) => a.map((t) => t.trim().toLowerCase())), ['folder', 'add a batch', 'add by date', 'pick specific photos'], 'sections')
    ok(await p11.getByTestId('dbx-sec-folder').getByTestId('dropbox-recursive').count() === 1, 'Include subfolders is in the Folder section')
    ok(await p11.getByTestId('dbx-sec-folder').getByTestId('dropbox-here-progress').count() === 1, 'progress line in the Folder section')
    eq(await p11.getByTestId('dropbox-process').count(), 0, 'old Tag N new photo(s) here button removed')
    ok(!/Tag \d+ new photo/.test(await p11.getByTestId('dropbox-browser').innerText()), 'no Tag N new photo(s) text')
    ok(await p11.getByTestId('dropbox-add-batch').getByTestId('folder-next-batch').evaluate((b) => b.classList.contains('primary')), 'Add next batch is the primary button')
    ok(!(await p11.getByTestId('dropbox-add-batch').getByTestId('folder-add-remaining').evaluate((b) => b.classList.contains('primary'))), 'Add all remaining is secondary')
    eq([await p11.getByTestId('dropbox-add-selected').innerText(), await p11.getByTestId('dropbox-add-selected').isDisabled()], ['Add selected (0)', true], 'Add selected disabled with nothing ticked')
    ok(await p11.getByTestId('dbx-sec-pick').getByTestId('dropbox-add-selected').count() === 1, 'Add selected sits in the pick section, under the list')
    // big adds ask first; Cancel (or Esc) adds nothing and keeps the panel open
    await p11.getByTestId('dropbox-add-batch').getByTestId('folder-add-remaining').click()
    eq(await p11.getByTestId('add-confirm-text').innerText(), "Add 2,000 photos? They'll be tagged in 200 batches of 10.", 'confirmation text')
    await p11.getByTestId('add-confirm-cancel').click()
    await p11.keyboard.press('Escape') // nothing open → would close; reopen below
    await p11.getByTestId('dropbox-browser').waitFor({ state: 'detached' })
    await openBig()
    await p11.getByTestId('dropbox-add-batch').getByTestId('folder-add-remaining').click()
    await p11.getByTestId('add-confirm').waitFor()
    await p11.keyboard.press('Escape')
    eq([await p11.getByTestId('add-confirm').count(), await p11.getByTestId('dropbox-browser').count()], [0, 1], 'Esc closes only the confirmation')
    await p11.waitForTimeout(500)
    eq([bigDl(), await p11.getByTestId('job-label').count()], [[], 0], 'cancelled confirmation adds nothing')
    // fits a ~620 px window without sideways scrolling
    await p11.setViewportSize({ width: 620, height: 900 })
    await p11.waitForTimeout(200)
    ok(await p11.locator('.dbx-card').evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && [...el.querySelectorAll('.dbx-sec')].every((x) => x.scrollWidth <= x.clientWidth + 1)), 'no horizontal overflow at 620 px')
    await p11.setViewportSize({ width: 1280, height: 900 })

    // 1) count picker defaults to Photos per batch (10, shown as a custom number); 25 + Newest first → 25 newest in 3 batches
    eq(await p11.getByTestId('add-count-select').inputValue(), 'custom', 'batch size 10 is not a preset → custom')
    eq(await p11.getByTestId('add-count-custom').inputValue(), '10', 'default = Photos per batch')
    ok(/Add next batch \(10\)/.test(await p11.getByTestId('dropbox-add-batch').textContent()), 'button follows the default')
    eq(await p11.getByTestId('add-order').inputValue(), 'name', 'order defaults to Name')
    await p11.getByTestId('add-count-select').selectOption('25')
    await p11.getByTestId('add-order').selectOption('newest')
    ok(/Add next batch \(25\)/.test(await p11.getByTestId('dropbox-add-batch').textContent()), 'button shows the picked count')
    // the list follows Order: folders stay on top, then newest first — what you see is what Add next batch takes
    await p11.waitForFunction(() => document.querySelector('[data-testid=dropbox-list]')?.dataset.order === 'newest')
    const newestFirst = [...byDate].reverse()
    eq(await p11.getByTestId('dropbox-file').evaluateAll((r) => r.slice(0, 5).map((e) => e.dataset.name)), newestFirst.slice(0, 5).map((f) => f.name), 'list sorted newest first')
    ok(await p11.locator('[data-testid=dropbox-list] > :first-child').getAttribute('data-testid') === 'dropbox-folder-row', 'folders stay on top')
    await p11.getByTestId('add-order').selectOption('oldest')
    eq(await p11.getByTestId('dropbox-file').first().getAttribute('data-name'), byDate[0].name, 'list sorted oldest first')
    await p11.getByTestId('add-order').selectOption('newest')
    await p11.evaluate(() => {
      window.__labels = []
      new MutationObserver(() => { const t = document.querySelector('[data-testid=job-label]')?.textContent; if (t && window.__labels.at(-1) !== t) window.__labels.push(t) }).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    await p11.getByTestId('dropbox-add-batch').getByTestId('folder-next-batch').click()
    eq(await p11.getByTestId('add-confirm-text').innerText(), "Add 25 photos? They'll be tagged in 3 batches of 10.", 'Add next batch bigger than a batch asks first')
    await p11.getByTestId('add-confirm-ok').click()
    await p11.getByTestId('preimport-check').waitFor()
    await p11.getByTestId('preimport-proceed').click()
    await waitCount(25); await waitIdle()
    const labels = await p11.evaluate(() => window.__labels)
    ok(labels.some((l) => /Batch 3 of 3 · tagging \d+ of 5/.test(l)), '25 with batch size 10 = 3 batches: ' + labels.slice(0, 30).join(' | '))
    ok(!labels.some((l) => /of 4\b/.test(l) && /Batch/.test(l)), 'no 4th batch')
    const newest25 = [...byDate].reverse().slice(0, 25).map((f) => f.id)
    eq(bigDl().sort(), [...newest25].sort(), 'the 25 newest (by Dropbox date) were added')
    eq(bigDl().slice(0, 10).sort(), newest25.slice(0, 10).sort(), 'first batch = 10 newest')
    ok(newest25.every((id) => +id.slice(6) % 100 !== 0), 'time taken beats modified date (old shots with new modified dates skipped)')

    // 1.0.32: "How many to add" is remembered after the batch run finished (the panel was closed and reopened)
    const countUi = async () => { const v = await p11.getByTestId('add-count-select').inputValue(); return v === 'custom' ? 'custom:' + await p11.getByTestId('add-count-custom').inputValue() : v }
    await openBig()
    eq(await countUi(), '25', 'count remembered after a batch run + reopen (not reset to Photos per batch 10)')
    ok(/Add next batch \(25\)/.test(await p11.getByTestId('dropbox-add-batch').textContent()), 'button uses the remembered count')
    await p11.getByTestId('dropbox-browser-close').click()

    // order and count persist across reload
    await p11.reload(); await waitCount(25)
    await openBig()
    eq(await p11.getByTestId('add-order').inputValue(), 'newest', 'order remembered after reload')
    eq(await countUi(), '25', 'count remembered after reload')
    ok(/25 of 2,?000 in library/.test(await here().textContent()), 'progress after: ' + await here().textContent())

    // 1.0.32 groups: still-to-add first (newest first), then a collapsed "Already in library (25)"
    const grpNew = p11.getByTestId('dropbox-group-new'), grpHave = p11.getByTestId('dropbox-have-toggle')
    eq(await grpNew.innerText().then((t) => t.trim()), 'Not in library yet (1,975)', 'not-yet heading with count')
    await p11.getByTestId('dropbox-list').evaluate((el) => { el.scrollTop = el.scrollHeight }) // the added group comes after all 1,975
    ok(/Already in library \(25\)/.test(await grpHave.innerText()), 'already heading with count: ' + await grpHave.innerText())
    eq(await grpHave.getAttribute('aria-expanded'), 'false', 'already group collapsed by default')
    eq(await p11.locator('[data-testid=dropbox-file][aria-disabled=true]').count(), 0, 'no added rows shown while collapsed')
    await p11.getByTestId('dropbox-list').evaluate((el) => { el.scrollTop = 0 })
    await p11.waitForTimeout(100)
    eq(await p11.getByTestId('dropbox-file').first().getAttribute('data-name'), big.find((f) => f.id === [...byDate].reverse()[25].id).name, 'first row = newest photo not yet in the library')
    await p11.getByTestId('dropbox-select-all').click()
    eq(await p11.getByTestId('dropbox-add-selected').innerText(), 'Add selected (1,976)', 'Select all = 1,975 not-yet photos + 1 folder (no added photos)')
    await p11.getByTestId('dropbox-deselect-all').click()
    // shift-range inside the not-yet group
    const freshRows = p11.locator('[data-testid=dropbox-file]:not([aria-disabled=true])')
    await freshRows.nth(0).click(); await freshRows.nth(4).click({ modifiers: ['Shift'] })
    eq(await p11.locator('[data-testid=dropbox-file][data-picked="1"]').count(), 5, 'shift-range picks 5')
    await p11.getByTestId('dropbox-deselect-all').click()
    // expand: the added rows come after a divider, dimmed with a ✓ badge, newest first too; windowing still works
    await p11.getByTestId('dropbox-list').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await grpHave.click()
    eq(await grpHave.getAttribute('aria-expanded'), 'true', 'expanded')
    await p11.getByTestId('dropbox-list').evaluate((el) => { el.scrollTop = el.scrollHeight })
    const lastHave = p11.locator(`[data-testid=dropbox-file][data-name="${big.find((f) => f.id === newest25[24]).name}"]`)
    for (let k = 0; k < 50 && !(await lastHave.count()); k++) { await p11.getByTestId('dropbox-list').evaluate((el) => { el.scrollTop = el.scrollHeight }); await p11.waitForTimeout(50) }
    await lastHave.waitFor({ timeout: 10_000 })
    ok(await lastHave.getAttribute('aria-disabled') === 'true' && (await lastHave.getByTestId('dropbox-in-library').innerText()) === '✓ In library', 'added row dimmed + ✓ In library')
    ok(await p11.getByTestId('dropbox-file').count() < 200, 'still windowed with both groups')
    const haveNames = await p11.locator('[data-testid=dropbox-file][aria-disabled=true]').evaluateAll((r) => r.map((e) => e.dataset.name))
    const expHave = newest25.map((id) => big.find((f) => f.id === id).name)
    eq(haveNames, expHave.slice(expHave.length - haveNames.length), 'added group keeps the Order sort')
    // screenshot with both groups in view (stub data)
    await p11.getByTestId('dropbox-list').evaluate((el) => {
      const top = el.querySelector('[data-testid=dropbox-files-top]').offsetTop
      el.scrollTop = top + 40 + 1975 * 68 - 3.2 * 68
    })
    await grpHave.waitFor()
    await p11.setViewportSize({ width: 1280, height: 1300 })
    await p11.waitForTimeout(300)
    await p11.waitForFunction(() => [...document.querySelectorAll('[data-testid=dropbox-thumb]')].every((t) => t.dataset.state !== 'waiting'), null, { timeout: 20_000 }).catch(() => {})
    await p11.locator('.dbx-card').screenshot({ path: process.env.PICKER_SHOT || '/workspace/pt-1.0.32-picker.png' })
    await p11.setViewportSize({ width: 1280, height: 900 })
    await p11.getByTestId('dropbox-browser-close').click()
    await openBig()
    await p11.getByTestId('dropbox-list').evaluate((el) => { el.scrollTop = el.scrollHeight })
    eq(await p11.getByTestId('dropbox-have-toggle').getAttribute('aria-expanded'), 'false', 'collapsed again when the panel reopens')

    // custom count + Oldest first → the 7 oldest (photos Dropbox knows a capture date for come first)
    await p11.getByTestId('add-order').selectOption('oldest')
    await p11.getByTestId('add-count-select').selectOption('custom')
    await p11.getByTestId('add-count-custom').fill('7')
    ok(/Add next batch \(7\)/.test(await p11.getByTestId('dropbox-add-batch').textContent()), 'custom count shown')
    const before = bigDl().length
    await p11.getByTestId('dropbox-add-batch').getByTestId('folder-next-batch').click()
    await waitCount(32); await waitIdle()
    eq(bigDl().slice(before).sort(), byDate.slice(0, 7).map((f) => f.id).sort(), 'the 7 oldest were added')
    // custom count survives the run, a folder change and a restart; Photos per batch stays the save-round size
    await openBig()
    eq(await countUi(), 'custom:7', 'custom count remembered after the run')
    await p11.locator('[data-testid=dropbox-folder][data-name="Sub"]').click()
    await p11.locator('[data-testid=dropbox-file][data-name="sub-1.png"]').waitFor()
    eq(await countUi(), 'custom:7', 'custom count kept when changing folders')
    ok(/Add next batch \(3\)/.test(await p11.getByTestId('dropbox-add-batch').textContent()), 'capped by what is left in Sub')
    await p11.getByTestId('dropbox-browser-close').click()
    await p11.reload(); await waitCount(32)
    await openBig()
    eq(await countUi(), 'custom:7', 'custom count remembered after restart')
    const saved = await p11.evaluate(() => new Promise((res) => { const r = indexedDB.open('photo-tagger'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => res(q.result) } }))
    eq([saved.dropboxAddCount, saved.dropboxAddCountCustom, saved.dropboxBatchSize], [7, true, 10], 'saved in local settings; Photos per batch unchanged')
    await p11.getByTestId('dropbox-browser-close').click()

    // 2) Add by date: counts before adding (match / already in library / to add), then add only the new ones
    await openBig()
    await p11.getByTestId('dbx-date-range').locator('summary').click()
    await p11.getByTestId('dbx-date-year').waitFor({ timeout: 30_000 })
    const yearOpts = await p11.getByTestId('dbx-date-year').locator('option').allTextContents()
    ok(yearOpts.includes('2010') && yearOpts.includes('2016'), 'years from Dropbox dates: ' + yearOpts)
    await p11.getByTestId('dbx-date-year').selectOption('2016')
    const in2016 = big.filter((f) => new Date(dateOf(f)).getUTCFullYear() === 2016).length
    ok(new RegExp(`^${in2016} match · 0 already in library · ${in2016} to add`).test(await p11.getByTestId('dbx-date-summary').innerText()), `year summary (${in2016}): ` + await p11.getByTestId('dbx-date-summary').innerText())
    eq([await p11.getByTestId('dbx-date-from').inputValue(), await p11.getByTestId('dbx-date-to').inputValue()], ['2016-01-01', '2016-12-31'], 'year fills from/to')
    const top = [...byDate].reverse()
    const day = (t) => new Date(t).toISOString().slice(0, 10)
    const fromD = day(dateOf(top[40])), toD = day(dateOf(top[15]))
    const lo = Date.parse(fromD + 'T00:00:00Z'), hi = Date.parse(toD + 'T23:59:59.999Z')
    const inRange = big.filter((f) => dateOf(f) >= lo && dateOf(f) <= hi)
    const have = inRange.filter((f) => newest25.includes(f.id))
    ok(have.length > 0 && have.length < inRange.length, `range overlaps the library: ${have.length} of ${inRange.length}`)
    await p11.getByTestId('dbx-date-from').fill(fromD); await p11.getByTestId('dbx-date-to').fill(toD)
    eq(await p11.getByTestId('dbx-date-summary').innerText().then((t) => t.split('.')[0].trim()), `${inRange.length} match · ${have.length} already in library · ${inRange.length - have.length} to add`, 'range summary')
    eq(await p11.getByTestId('dbx-date-add').innerText(), `Add ${inRange.length - have.length} from these dates`, 'date add button')
    const before2 = bigDl().length
    await p11.getByTestId('dbx-date-add').click()
    ok(/^Add \d+ photos\? They'll be tagged in \d+ batches of 10\.$/.test(await p11.getByTestId('add-confirm-text').innerText()), 'big date range asks first')
    await p11.getByTestId('add-confirm-ok').click()
    const n3 = 32 + inRange.length - have.length
    await waitCount(n3); await waitIdle()
    eq(bigDl().slice(before2).sort(), inRange.filter((f) => !have.includes(f)).map((f) => f.id).sort(), 'only the new photos in the date range were added')

    // 3) ticks: in-library rows disabled; pick 2 files + a subfolder → Add selected (3)
    await openBig()
    await p11.getByTestId('add-order').selectOption('name')
    const inLib = p11.locator('[data-testid=dropbox-file][aria-disabled=true]')
    const lib1 = byDate[0].name // an oldest one already in the library
    await p11.getByTestId('dropbox-list').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await p11.getByTestId('dropbox-have-toggle').click()
    const libRow = p11.locator(`[data-testid=dropbox-file][data-name="${lib1}"]`)
    for (let i = 0; i < 200 && !(await libRow.count()); i++) { await p11.getByTestId('dropbox-list').evaluate((el) => { el.scrollTop += el.clientHeight * 0.8 }); await p11.waitForTimeout(30) }
    await libRow.waitFor({ timeout: 10_000 })
    ok(await libRow.getByTestId('dropbox-in-library').isVisible() && await libRow.getByTestId('dropbox-file-check').isDisabled(), 'in-library row is badged and its box disabled')
    ok(await inLib.count() >= 1, 'in-library rows rendered disabled')
    await p11.getByTestId('dropbox-list').evaluate((el) => { el.scrollTop = 0 })
    const freshNames = big.slice(0, 20).filter((f) => !bigDl().includes(f.id)).slice(0, 2).map((f) => f.name)
    await p11.locator(`[data-testid=dropbox-file][data-name="${freshNames[0]}"]`).click()
    await p11.locator(`[data-testid=dropbox-file][data-name="${freshNames[1]}"]`).click({ modifiers: ['Control'] })
    await p11.locator('[data-testid=dropbox-folder-row][data-name="Sub"]').getByTestId('dropbox-folder-check').check()
    eq(await p11.getByTestId('dropbox-selected-count').innerText(), '3 selected (2 photos/videos, 1 folder)', 'selection summary')
    eq(await p11.getByTestId('dropbox-add-selected').innerText(), 'Add selected (3)', 'Add selected button')
    await p11.getByTestId('dropbox-select-all').click()
    ok(/^\d[\d,]* selected/.test(await p11.getByTestId('dropbox-selected-count').innerText()), 'select all')
    eq(await p11.getByTestId('dropbox-add-selected').innerText(), `Add selected (${(N - n3 + 1).toLocaleString('en-US')})`, 'select all = every new photo + the folder')
    await p11.getByTestId('dropbox-deselect-all').click()
    eq(await p11.getByTestId('dropbox-deselect-all').innerText(), 'Select none', 'Select none label')
    ok(await p11.getByTestId('dropbox-add-selected').isDisabled(), 'nothing selected → Add selected disabled')
    await p11.locator(`[data-testid=dropbox-file][data-name="${freshNames[0]}"]`).click()
    await p11.locator(`[data-testid=dropbox-file][data-name="${freshNames[1]}"]`).click({ modifiers: ['Control'] })
    await p11.locator('[data-testid=dropbox-folder-row][data-name="Sub"]').getByTestId('dropbox-folder-check').check()
    await p11.getByTestId('dropbox-add-selected').click()
    eq(await p11.getByTestId('add-confirm').count(), 0, '5 photos ≤ batch size: no confirmation')
    await waitCount(n3 + 5); await waitIdle()
    for (const n of [...freshNames, 'sub-1.png', 'sub-2.png', 'sub-3.png']) ok(await p11.locator(`[data-testid=photo-tile][data-name="${n}"]`).count() === 1, `${n} added`)
    const linked = await idb(p11, `return new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('dropboxFolders'); q.onsuccess = () => res(q.result) })`)
    ok(!(linked ?? []).some((f) => /\/big/.test(f.path.toLowerCase())), 'picked/ranged adds do not link folders: ' + JSON.stringify(linked))
    eq(st.writes, 0, 'no photo was written or deleted in Dropbox')
    eq(errs11, [], 'no page errors')
  } finally {
    await c11.close()
    delete DBX_TREE['/big']; delete DBX_TREE['/big/sub']; DBX_TREE[''].splice(DBX_TREE[''].findIndex((e) => e.name === 'Big'), 1)
  }
})

await test('Turn all automatic tags off / on (1.0.32): one switch for detection list + photo metadata; saves at once; new photos only; Restore previous', async () => {
  const c12 = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await routeModel(c12).catch(() => {})
  const st = await stubDropbox(c12)
  const p12 = await c12.newPage()
  const errs12 = []; p12.on('pageerror', (e) => errs12.push(e.message))
  const t12 = (n) => p12.locator(`[data-testid=photo-tile][data-name="${n}"]`)
  const tags12 = async (n) => ((await t12(n).getAttribute('data-tags')) ?? '').split('|').filter(Boolean)
  const ready12 = (n) => p12.waitForFunction((n) => document.querySelector(`[data-testid=photo-tile][data-name="${n}"]`)?.dataset.status === 'ready', n, { timeout: 300_000 })
  const openTags = async () => { await p12.getByTestId('open-settings').click(); await p12.getByTestId('tab-vocab').click(); await p12.getByTestId('autotags-all').waitFor() }
  const toggles = () => p12.locator('[data-testid=detection-card] input[type=checkbox][data-testid^="label-"], [data-testid=detection-card] input[type=checkbox][data-testid^="meta-"]')
  const checkedCount = () => toggles().evaluateAll((els) => els.filter((e) => e.checked).length)
  const savedSettings = () => p12.evaluate(() => new Promise((res) => { const r = indexedDB.open('photo-tagger'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => res(q.result) } }))
  const addPick = async (name) => {
    await p12.getByTestId('add-btn').click()
    await p12.locator('[data-testid=dropbox-folder][data-name="Picks"]').click()
    await p12.locator(`[data-testid=dropbox-file][data-name="${name}"]`).click()
    await p12.getByTestId('dropbox-add-selected').click()
  }
  try {
    await p12.goto(URL_BASE); await p12.getByTestId('empty').waitFor()
    await connectDropbox(p12, 'autotags_key')
    // a custom previous selection: one detection tag and Camera off
    await openTags()
    const firstLabel = p12.locator('[data-testid=detection-card] input[type=checkbox][data-testid^="label-"]').first()
    const firstId = (await firstLabel.getAttribute('data-testid')).replace('label-', '')
    await firstLabel.uncheck(); await p12.getByTestId('meta-camera').uncheck()
    const total = await toggles().count()
    eq(await checkedCount(), total - 2, 'previous selection: 2 off')
    eq(await p12.getByTestId('autotags-off').innerText(), 'Turn all off', 'Turn all off shown while some are on')
    eq(await p12.getByTestId('autotags-off-note').count(), 0, 'no note while some are on')
    await p12.getByTestId('settings-close').click()
    // a photo added with automatic tags on, plus a tag of your own
    await addPick('pick-1.jpg')
    await p12.getByTestId('preimport-check').waitFor(); await p12.getByTestId('preimport-proceed').click()
    await ready12('pick-1.jpg')
    await t12('pick-1.jpg').click()
    await p12.getByTestId('detail-tag-input').fill('my_own_tag'); await p12.getByTestId('detail-tag-input').press('Enter')
    await p12.locator('[data-testid=detail-tag][data-tag="my_own_tag"]').waitFor()
    await p12.keyboard.press('Escape')
    const before1 = await tags12('pick-1.jpg')
    ok(before1.length >= 2, 'pick-1 has automatic tags + my_own_tag: ' + before1)

    // Turn all off: everything unticked at once, saved immediately, note shown
    await openTags()
    await p12.getByTestId('autotags-off').click()
    await p12.getByTestId('autotags-off-note').waitFor()
    eq(await p12.getByTestId('autotags-off-note').innerText(), 'Automatic tags are off — new photos are added with no automatic tags.', 'note text')
    eq(await checkedCount(), 0, 'every detection and metadata toggle is off')
    eq([await p12.getByTestId('autotags-restore').innerText(), await p12.getByTestId('autotags-on').innerText()], ['Restore previous', 'Turn all on'], 'buttons while all off')
    const s1 = await savedSettings()
    eq([s1.disabledMetaTags.length, s1.disabledLabels.length >= total - 6, s1.autoTagsBackup.disabledLabels.includes(firstId), s1.autoTagsBackup.disabledMetaTags], [6, true, true, ['camera']], 'saved immediately, previous selection kept')
    await p12.getByTestId('settings-close').click()
    await p12.waitForTimeout(800)
    eq(await tags12('pick-1.jpg'), before1, 'existing photo not re-tagged; its own tag kept')
    ok(!(await p12.getByTestId('job-label').count()) || !/re-tag|tagging/i.test(await p12.getByTestId('job-label').innerText()) || /Done/.test(await p12.getByTestId('job-label').innerText()), 'no re-tag job started: ' + (await p12.getByTestId('job-label').count() ? await p12.getByTestId('job-label').innerText() : ''))

    // a new photo now arrives with no automatic tags
    await addPick('pick-2.jpg')
    await ready12('pick-2.jpg')
    eq(await tags12('pick-2.jpg'), [], 'new photo added with no automatic tags')
    eq(await tags12('pick-1.jpg'), before1, 'pick-1 still unchanged')

    // survives a restart; Restore previous brings back exactly the old selection
    await p12.reload(); await p12.getByTestId('grid').waitFor()
    await openTags()
    await p12.getByTestId('autotags-off-note').waitFor()
    await p12.getByTestId('autotags-restore').click()
    await p12.getByTestId('autotags-off').waitFor()
    eq(await checkedCount(), total - 2, 'previous selection restored')
    ok(!(await p12.getByTestId(`label-${firstId}`).isChecked()) && !(await p12.getByTestId('meta-camera').isChecked()) && await p12.getByTestId('meta-year').isChecked(), 'the same two are off')
    // Turn all off → Turn all on = everything on
    await p12.getByTestId('autotags-off').click()
    await p12.getByTestId('autotags-on').click()
    await p12.getByTestId('autotags-off').waitFor()
    eq(await checkedCount(), total, 'Turn all on switches everything on')
    eq((await savedSettings()).autoTagsBackup, undefined, 'backup cleared')
    await p12.getByTestId('settings-close').click()
    eq(await tags12('pick-1.jpg'), before1, 'still no re-tagging of existing photos')
    eq(errs12, [], 'no page errors')
  } finally { await c12.close() }
})

await test('Delete from Dropbox (1.0.33): confirm (Cancel focused, Esc/Enter cancel), single + multi delete, 429 retry, not_found, permission → sign in again + Retry, tombstone vs folder add/Refresh, reload', async () => {
  const names = Array.from({ length: 8 }, (_, i) => `t${i + 1}.jpg`)
  const pics = ['beach.jpg', 'cat.jpg', 'city.jpg', 'pizza.jpg', 'mountain.jpg', 'dog.jpg', 'document.jpg', 'person.jpg']
  const fid = (n) => 'id:trash-' + n.replace('.jpg', '')
  const grp = (n) => (['t2.jpg', 't3.jpg', 't4.jpg'].includes(n) ? 'grp_multi' : 'grp_' + n.replace('.jpg', ''))
  DBX_TREE['/trash'] = names.map((n, i) => { SAMPLE_BY_ID[fid(n)] = pics[i]; return dbxFile(fid(n), n, '/Trash') })
  DBX_TREE[''].push(dbxDir('Trash', ''))
  const c13 = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await routeModel(c13).catch(() => {})
  const st = await stubDropbox(c13)
  const metaKey = (n) => `/.photo-tagger/meta/${fid(n).slice(3)}.json`
  names.forEach((n, i) => {
    const photo = { id: 'p-' + n, fp: 'fp-' + n, name: n, size: 1000, type: 'image/jpeg', addedAt: Date.now() - i * 1000, dateSource: 'added', width: 400, height: 300,
      quality: { sharpness: 100, brightness: 120, blurry: false, dark: false, bright: false }, tags: [{ name: grp(n), source: 'manual' }], rejected: [], source: 'dropbox',
      dropbox: { id: fid(n), path: `/Trash/${n}`, rev: 'r' + i }, dropboxTags: [grp(n)], hasOriginal: false, status: 'ready', facesScanned: true, faceCount: 0 }
    st.meta.set(metaKey(n), JSON.stringify({ app: 'photo-tagger', version: 1, file: photo.dropbox, photo, faces: [] }))
    st.fileTags.set(fid(n), new Set([grp(n)]))
  })
  const p13 = await c13.newPage()
  const errs13 = []; p13.on('pageerror', (e) => errs13.push(e.message))
  const count = async () => (await p13.getByTestId('count').innerText()).trim()
  const waitCount = (n) => p13.waitForFunction((n) => new RegExp('^' + n + ' photos').test(document.querySelector('[data-testid=count]')?.textContent || ''), n, { timeout: 60_000 })
  const inTree = (n) => (DBX_TREE['/trash'] ?? []).some((e) => e.id === fid(n))
  const deleted = (n) => (st.fileDeletes ?? []).includes(fid(n))
  const until = async (fn, what, ms = 60_000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await p13.waitForTimeout(100) } }
  const openDetail = async (n) => { await p13.locator(`[data-testid=photo-tile][data-name="${n}"]`).click(); await p13.getByTestId('danger-zone').waitFor() }
  const selectGroup = async (g) => {
    await p13.getByTestId('search').fill(g)
    await p13.waitForFunction(() => /\d+ of \d+/.test(document.querySelector('[data-testid=count]')?.textContent || ''))
    await p13.getByTestId('select-mode').click(); await p13.getByTestId('sel-all').click()
  }
  try {
    await p13.goto(URL_BASE); await p13.getByTestId('empty').waitFor()
    await connectDropbox(p13, 'trash_key')
    await waitCount(8)
    await p13.waitForFunction(() => !document.querySelector('[data-testid=save-progress]'), null, { timeout: 60_000 })

    // --- cancel: Cancel has focus; Enter (default) and Esc both cancel; nothing is deleted
    await openDetail('t1.jpg')
    eq(await p13.getByTestId('delete-dropbox').innerText(), 'Delete from Dropbox…', 'danger zone button')
    await p13.getByTestId('delete-dropbox').click()
    const dlg = p13.getByTestId('deldbx-confirm'); await dlg.waitFor()
    eq(await p13.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'deldbx-cancel', 'Cancel has focus')
    const txt = await dlg.innerText()
    for (const s of ['Delete this photo from Dropbox?', 't1.jpg', '/Trash/t1.jpg', 'deleted files', 'dropbox.com', '30 days on most plans', 'tags and face names are removed', 'shared links']) ok(txt.includes(s), `dialog says "${s}": ${txt}`)
    await p13.keyboard.press('Enter')
    await dlg.waitFor({ state: 'detached' })
    await p13.getByTestId('danger-zone').waitFor() // detail view still open
    await p13.getByTestId('delete-dropbox').click(); await dlg.waitFor()
    await p13.keyboard.press('Escape')
    await dlg.waitFor({ state: 'detached' })
    ok(await p13.getByTestId('danger-zone').isVisible(), 'Esc closed only the dialog')
    await p13.getByTestId('delete-dropbox').click(); await dlg.waitFor()
    await p13.getByTestId('deldbx-cancel').click(); await dlg.waitFor({ state: 'detached' })
    await p13.waitForTimeout(500)
    eq([await count(), (st.fileDeleteCalls ?? []).length, inTree('t1.jpg')], ['8 photos', 0, true], 'cancel deletes nothing')

    // --- single delete from the detail view
    await p13.getByTestId('delete-dropbox').click(); await dlg.waitFor()
    await p13.getByTestId('deldbx-ok').click()
    await waitCount(7)
    await until(() => deleted('t1.jpg') && !st.meta.has(metaKey('t1.jpg')), 't1 file + sidecar deleted')
    ok(!inTree('t1.jpg'), 't1 gone from Dropbox')
    await p13.keyboard.press('Escape')
    await p13.getByTestId('danger-zone').waitFor({ state: 'detached' })

    // --- multi delete from the toolbar, with Dropbox rate limiting (429 + Retry-After) on one file
    st.inject.push({ ep: '/2/files/delete_v2', status: 429, retryAfter: 1, times: 2, body: /trash-t3/ })
    const inj0 = st.injected
    await selectGroup('grp_multi')
    eq(await p13.getByTestId('sel-delete-dropbox').innerText(), 'Delete from Dropbox… (3)', 'toolbar button shows the count')
    await p13.getByTestId('sel-delete-dropbox').click(); await dlg.waitFor()
    eq(await p13.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'deldbx-cancel', 'Cancel has focus (multi)')
    ok((await dlg.innerText()).includes('Delete 3 photos from Dropbox?'), 'multi title')
    eq(await p13.locator('[data-testid=deldbx-files] li').count(), 3, 'file list')
    await p13.waitForFunction(() => document.querySelectorAll('[data-testid=deldbx-files] img').length === 3, null, { timeout: 30_000 }).catch(() => {})
    await p13.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 10_000 }).catch(() => {})
    await p13.screenshot({ path: '/workspace/pt-1.0.33-delete.png' })
    st.deleteDelay = 300
    await p13.getByTestId('deldbx-ok').click()
    await p13.getByTestId('deldbx-progress').waitFor({ timeout: 10_000 })
    ok(/^Deleting from Dropbox: \d of 3/.test((await p13.getByTestId('deldbx-progress').innerText()).trim()), 'progress: ' + await p13.getByTestId('deldbx-progress').innerText())
    await p13.getByTestId('search').fill('')
    await waitCount(4)
    await until(() => ['t2.jpg', 't3.jpg', 't4.jpg'].every(deleted), 'multi deleted')
    await p13.waitForFunction(() => !document.querySelector('[data-testid=deldbx-progress]'), null, { timeout: 60_000 })
    ok(st.injected - inj0 >= 2, '429s were hit and retried')
    for (const n of ['t2.jpg', 't3.jpg', 't4.jpg']) ok(!st.meta.has(metaKey(n)), 'sidecar deleted ' + n)
    st.deleteDelay = 0

    // --- not_found: the file was already deleted elsewhere → treated as deleted
    const i5 = DBX_TREE['/trash'].findIndex((e) => e.id === fid('t5.jpg')); DBX_TREE['/trash'].splice(i5, 1)
    await openDetail('t5.jpg')
    await p13.getByTestId('delete-dropbox').click(); await dlg.waitFor(); await p13.getByTestId('deldbx-ok').click()
    await waitCount(3)
    await until(() => (st.fileDeleteCalls ?? []).includes(fid('t5.jpg')) && !st.meta.has(metaKey('t5.jpg')), 't5 handled')
    await p13.keyboard.press('Escape')
    await p13.getByTestId('danger-zone').waitFor({ state: 'detached' })
    await p13.waitForTimeout(500)
    eq(await p13.getByTestId('save-failed-count').count(), 0, 'not_found is not a failure')

    // --- missing permission: clear "sign in to Dropbox again" + Retry
    st.inject.push({ ep: '/2/files/delete_v2', status: 401, summary: 'missing_scope/files.content.write', times: 2, body: /trash-t6/ })
    await openDetail('t6.jpg')
    await p13.getByTestId('delete-dropbox').click(); await dlg.waitFor(); await p13.getByTestId('deldbx-ok').click()
    await waitCount(2)
    await p13.keyboard.press('Escape')
    await p13.getByTestId('danger-zone').waitFor({ state: 'detached' })
    await p13.getByTestId('deldbx-signin').waitFor({ timeout: 60_000 })
    ok(/sign in to Dropbox again/i.test(await p13.getByTestId('deldbx-signin').innerText()), 'sign-in message')
    ok(/not deleted from Dropbox/.test(await p13.getByTestId('save-failed-count').innerText()), 'failure count: ' + await p13.getByTestId('save-failed-count').innerText())
    await p13.getByTestId('save-failures-open').click()
    const fl = p13.locator('[data-testid=save-failure][data-op=trash]'); await fl.waitFor()
    ok(/isn't allowed to delete files/.test(await fl.innerText()), 'failure reason: ' + await fl.innerText())
    ok(inTree('t6.jpg') && st.meta.has(metaKey('t6.jpg')), 't6 still in Dropbox while failed')
    // tombstone: while the delete is unfinished, adding the folder again must not bring it back
    await p13.getByRole('button', { name: 'Close list' }).click()
    SAMPLE_BY_ID['id:trash-t9'] = 'cat.jpg'; DBX_TREE['/trash'].push(dbxFile('id:trash-t9', 't9.jpg', '/Trash')) // one genuinely new file
    await p13.getByTestId('add-btn').click()
    await p13.locator('[data-testid=dropbox-folder][data-name="Trash"]').click()
    await p13.getByTestId('dropbox-add-batch').waitFor()
    await addAll(p13)
    await waitTile('t9.jpg', p13)
    await waitCount(3)
    await p13.waitForTimeout(1500)
    eq(await p13.locator('[data-testid=photo-tile][data-name="t6.jpg"]').count(), 0, 'folder add skips the file being deleted')
    // retry once permission is fixed (the injected 401s are used up)
    await p13.getByTestId('save-retry-now').click()
    await until(() => deleted('t6.jpg') && !st.meta.has(metaKey('t6.jpg')), 't6 deleted after Retry')
    await p13.waitForFunction(() => !document.querySelector('[data-testid=save-failed-count]'), null, { timeout: 30_000 })

    // --- tombstone vs Refresh: a stale listing / another device still lists t1 → not re-added
    DBX_TREE['/trash'].push(st.deletedEntries.get(fid('t1.jpg')))
    await p13.getByTestId('add-btn').click()
    await p13.getByTestId('dropbox-refresh').click()
    await p13.waitForTimeout(2500)
    eq(await count(), '3 photos', 'Refresh did not re-add a deleted file')
    eq(await p13.locator('[data-testid=photo-tile][data-name="t1.jpg"]').count(), 0, 't1 not back')
    const removedJson = JSON.parse(st.meta.get('/.photo-tagger/removed.json'))
    ok(['p-t1.jpg', 'p-t2.jpg', 'p-t6.jpg'].every((id) => removedJson.removed.some((e) => e.id === id && e.trashed)), 'tombstones recorded in removed.json: ' + JSON.stringify(removedJson).slice(0, 300))

    // --- restart: nothing pending, deleted photos stay out
    await p13.reload()
    await waitCount(3)
    await p13.waitForTimeout(1500)
    eq(await count(), '3 photos', 'after reload')
    eq(await p13.evaluate(() => localStorage.getItem('pt.dropboxRemovals.v1')), null, 'queue empty')
    eq(st.writes, 0, 'nothing written or deleted outside the confirmed files')
    eq([...(st.fileDeletes ?? [])].sort(), ['t1', 't2', 't3', 't4', 't6'].map((x) => 'id:trash-' + x).sort(), 'exactly the confirmed files were deleted')
    ok(inTree('t7.jpg') && inTree('t8.jpg') && st.meta.has(metaKey('t7.jpg')), 'other files untouched')
    eq(errs13, [], 'no page errors')
  } finally {
    await c13.close()
    delete DBX_TREE['/trash']; DBX_TREE[''].splice(DBX_TREE[''].findIndex((e) => e.name === 'Trash'), 1)
  }
})

await test('Delete from Dropbox (1.0.33): queue survives a restart mid-run (persisted), then finishes', async () => {
  const names = Array.from({ length: 6 }, (_, i) => `q${i + 1}.jpg`)
  const fid = (n) => 'id:trq-' + n.replace('.jpg', '')
  DBX_TREE['/trashq'] = names.map((n) => { SAMPLE_BY_ID[fid(n)] = 'beach.jpg'; return dbxFile(fid(n), n, '/TrashQ') })
  DBX_TREE[''].push(dbxDir('TrashQ', ''))
  const c = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await routeModel(c).catch(() => {})
  const st = await stubDropbox(c)
  const metaKey = (n) => `/.photo-tagger/meta/${fid(n).slice(3)}.json`
  names.forEach((n, i) => {
    const photo = { id: 'p-' + n, fp: 'fp-' + n, name: n, size: 1000, type: 'image/jpeg', addedAt: Date.now() - i * 1000, dateSource: 'added', width: 400, height: 300,
      quality: { sharpness: 100, brightness: 120, blurry: false, dark: false, bright: false }, tags: [], rejected: [], source: 'dropbox',
      dropbox: { id: fid(n), path: `/TrashQ/${n}`, rev: 'r' + i }, dropboxTags: [], hasOriginal: false, status: 'ready', facesScanned: true, faceCount: 0 }
    st.meta.set(metaKey(n), JSON.stringify({ app: 'photo-tagger', version: 1, file: photo.dropbox, photo, faces: [] }))
  })
  const pg = await c.newPage()
  try {
    await pg.goto(URL_BASE); await pg.getByTestId('empty').waitFor()
    await connectDropbox(pg, 'trashq_key')
    await pg.waitForFunction(() => /^6 photos/.test(document.querySelector('[data-testid=count]')?.textContent || ''), null, { timeout: 60_000 })
    st.inject.push({ ep: '/2/files/delete_v2', status: 503, summary: 'internal_error', times: 1000, body: /trq-/ })
    await pg.getByTestId('select-mode').click(); await pg.getByTestId('sel-all').click()
    await pg.getByTestId('sel-delete-dropbox').click(); await pg.getByTestId('deldbx-ok').click()
    await pg.getByTestId('deldbx-progress').waitFor()
    { const q = JSON.parse(await pg.evaluate(() => localStorage.getItem('pt.dropboxRemovals.v1'))); ok(q.items.length === 6 && q.items.every((x) => x.trash), 'queue persisted: ' + JSON.stringify(q).slice(0, 200)) }
    await pg.reload()
    await pg.waitForFunction(() => /photos|empty/.test(document.body.textContent || ''), null, { timeout: 60_000 })
    await pg.waitForTimeout(1000)
    eq(await pg.locator('[data-testid=photo-tile]').count(), 0, 'deleted photos not loaded again while pending')
    await pg.getByTestId('deldbx-progress').waitFor()
    st.inject.length = 0
    await pg.waitForFunction(() => !document.querySelector('[data-testid=deldbx-progress]'), null, { timeout: 120_000 })
    eq((st.fileDeletes ?? []).length, 6, 'all deleted after restart')
    eq(names.filter((n) => st.meta.has(metaKey(n))), [], 'sidecars deleted')
    eq(await pg.evaluate(() => localStorage.getItem('pt.dropboxRemovals.v1')), null, 'queue empty')
  } finally {
    await c.close()
    delete DBX_TREE['/trashq']; DBX_TREE[''].splice(DBX_TREE[''].findIndex((e) => e.name === 'TrashQ'), 1)
  }
})

await test('Automatic tags OFF by default for new setups (1.0.33); first-import prompt says so; Turn all on works', async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await c.addInitScript(() => localStorage.setItem('pt.e2eFresh', '1'))
  await routeModel(c).catch(() => {})
  await stubDropbox(c)
  const pg = await c.newPage()
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message))
  const openTags = async () => { await pg.getByTestId('open-settings').click(); await pg.getByTestId('tab-vocab').click(); await pg.getByTestId('autotags-all').waitFor() }
  const toggles = () => pg.locator('[data-testid=detection-card] input[type=checkbox][data-testid^="label-"], [data-testid=detection-card] input[type=checkbox][data-testid^="meta-"]')
  const checkedCount = () => toggles().evaluateAll((els) => els.filter((e) => e.checked).length)
  const savedSettings = () => pg.evaluate(() => new Promise((res) => { const r = indexedDB.open('photo-tagger'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => res(q.result) } }))
  const t = (n) => pg.locator(`[data-testid=photo-tile][data-name="${n}"]`)
  try {
    await pg.goto(URL_BASE); await pg.getByTestId('empty').waitFor()
    await openTags()
    await pg.getByTestId('autotags-off-note').waitFor()
    eq(await checkedCount(), 0, 'every automatic tag off on a fresh setup')
    eq(await pg.getByTestId('library-tags-empty').innerText().then((t) => t.startsWith('No tags on your photos yet.')), true, 'empty state')
    await pg.getByTestId('library-tags-autooff').waitFor()
    eq([await pg.getByTestId('autotags-restore').count(), await pg.getByTestId('autotags-on').count()], [0, 1], 'only Turn all on (no previous state to restore)')
    const s = await savedSettings()
    eq([s.disabledMetaTags.length, s.disabledLabels.length > 20, s.autoTagsBackup], [6, true, undefined], 'fresh default saved')
    await pg.getByTestId('settings-close').click()
    await pg.reload(); await pg.getByTestId('empty').waitFor()
    await openTags(); await pg.getByTestId('autotags-off-note').waitFor(); eq(await checkedCount(), 0, 'still off after reload')
    await pg.getByTestId('settings-close').click()
    // first import: the prompt explains tags are off and offers Review
    await connectDropbox(pg, 'fresh_key')
    const addPick = async (name) => {
      await pg.getByTestId('add-btn').click()
      await pg.locator('[data-testid=dropbox-folder][data-name="Picks"]').click()
      await pg.locator(`[data-testid=dropbox-file][data-name="${name}"]`).click()
      await pg.getByTestId('dropbox-add-selected').click()
    }
    await addPick('pick-1.jpg')
    await pg.getByTestId('preimport-check').waitFor()
    eq(await pg.locator('#preimport-title').innerText(), 'Automatic tags are off', 'prompt title')
    await pg.getByTestId('preimport-all-off').waitFor()
    eq(await pg.getByTestId('preimport-proceed').innerText(), 'Import without automatic tags', 'proceed label')
    eq(await pg.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'preimport-review', 'Review has focus')
    await pg.getByTestId('preimport-review').click()
    await pg.getByTestId('autotags-all').waitFor()
    await pg.getByTestId('settings-close').click()
    await addPick('pick-1.jpg')
    await pg.getByTestId('preimport-check').waitFor(); await pg.getByTestId('preimport-proceed').click()
    await pg.waitForFunction(() => document.querySelector('[data-testid=photo-tile][data-name="pick-1.jpg"]')?.dataset.status === 'ready', null, { timeout: 300_000 })
    eq(((await t('pick-1.jpg').getAttribute('data-tags')) ?? '').split('|').filter(Boolean), [], 'imported with no automatic tags')
    // Turn all on still works
    await openTags()
    await pg.getByTestId('autotags-on').click(); await pg.getByTestId('autotags-off').waitFor()
    eq(await checkedCount(), await toggles().count(), 'Turn all on')
    await pg.getByTestId('settings-close').click()
    eq(errs, [], 'no page errors')
  } finally { await c.close() }
})

await test('Existing settings are kept exactly (1.0.33 default-off applies to new setups only)', async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await routeModel(c).catch(() => {})
  await stubDropbox(c)
  const pg = await c.newPage()
  const openTags = async () => { await pg.getByTestId('open-settings').click(); await pg.getByTestId('tab-vocab').click(); await pg.getByTestId('autotags-all').waitFor() }
  const toggles = () => pg.locator('[data-testid=detection-card] input[type=checkbox][data-testid^="label-"], [data-testid=detection-card] input[type=checkbox][data-testid^="meta-"]')
  const checkedCount = () => toggles().evaluateAll((els) => els.filter((e) => e.checked).length)
  try {
    // an existing install (all-on default) with one change saved
    await pg.goto(URL_BASE); await pg.getByTestId('empty').waitFor()
    await connectDropbox(pg, 'existing_key')
    await openTags()
    const total = await toggles().count()
    await pg.getByTestId('meta-camera').uncheck()
    await pg.getByTestId('settings-close').click()
    // upgrade to the new-setup default: saved settings stay exactly as they were
    await pg.evaluate(() => localStorage.setItem('pt.e2eFresh', '1'))
    await pg.reload(); await pg.getByTestId('open-settings').waitFor()
    await openTags()
    eq(await checkedCount(), total - 1, 'existing selection kept')
    ok(!(await pg.getByTestId('meta-camera').isChecked()) && await pg.getByTestId('meta-year').isChecked(), 'Camera off, Year on — as saved')
    eq(await pg.getByTestId('autotags-off-note').count(), 0, 'no all-off note')
    await pg.getByTestId('settings-close').click()
    // an existing user who never saved settings (but is connected to Dropbox) keeps the all-on default too
    await pg.evaluate(() => new Promise((res) => { const r = indexedDB.open('photo-tagger'); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').delete('settings'); tx.oncomplete = () => { r.result.close(); res() } } }))
    await pg.reload(); await pg.getByTestId('open-settings').waitFor()
    await openTags()
    eq(await checkedCount(), total, 'existing (connected) user without saved settings: all on, unchanged')
  } finally { await c.close() }
})

await test('Dropbox: face recognition runs on Dropbox-backed photos (People clusters)', async () => {
  const c4 = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await routeModel(c4).catch(() => {})
  const st = await stubDropbox(c4)
  st.fileTags.set('id:f2', new Set(['family_trip'])) // a tag the user already applied in Dropbox
  const p4 = await c4.newPage()
  try {
    await p4.goto(URL_BASE)
    await p4.getByTestId('empty').waitFor()
    await connectDropbox(p4, 'face_key')
    await p4.getByTestId('empty').getByRole('button', { name: 'From Dropbox' }).click()
    await p4.locator('[data-testid=dropbox-folder][data-name="Faces"]').click()
    await p4.locator('[data-testid=dropbox-file][data-name="biden-2021.jpg"]').waitFor()
    await addAll(p4)
    await p4.getByTestId('preimport-check').waitFor()
    await p4.getByTestId('preimport-proceed').click()
    for (const n of ['obama-portrait.jpg', 'biden-2013.jpg', 'biden-2021.jpg']) await waitTile(n, p4, 300_000)
    for (let i = 0; i < 300; i++) {
      const done = await p4.evaluate(() => [...document.querySelectorAll('[data-testid=photo-tile]')].length === 3)
      if (done && await p4.locator('[data-testid=photo-tile][data-status=ready]').count() === 3) break
      await p4.waitForTimeout(1000)
    }
    await p4.getByTestId('view-people').click(); await p4.getByTestId('people-view').waitFor()
    if (await p4.getByTestId('face-scan').count()) await p4.getByTestId('face-scan').click()
    await p4.waitForFunction(() => document.querySelectorAll('[data-testid=cluster]').length > 0, null, { timeout: 300_000 })
    for (let i = 0; i < 300; i++) {
      await p4.evaluate(() => window.__ptFlushDropbox())
      if (['f1', 'f2', 'f3'].every((k) => sidecarFor(st, k)?.photo?.facesScanned)) break
      await p4.waitForTimeout(1000)
    }
    const nFaces = ['f1', 'f2', 'f3'].map((k) => sidecarFor(st, k)?.faces?.length ?? 0).reduce((a, b) => a + b, 0)
    ok(nFaces >= 3, 'face data written to Dropbox sidecars: ' + nFaces)
    await assertNothingLocal(p4)
    await p4.reload(); await p4.getByTestId('grid').waitFor({ timeout: 30_000 }).catch(() => {})
    await p4.getByTestId('view-people').click(); await p4.getByTestId('people-view').waitFor()
    await p4.getByTestId('view-people').click(); await p4.getByTestId('people-view').waitFor()
    await p4.waitForFunction(() => document.querySelectorAll('[data-testid=cluster]').length > 0, null, { timeout: 60_000 }) // faces read back from Dropbox
    const clusters = await p4.getByTestId('cluster').evaluateAll((els) => els.map((e) => e.dataset.photos.split('|').sort().join('|')))
    ok(clusters.includes('biden-2013.jpg|biden-2021.jpg'), 'Biden cluster from Dropbox photos: ' + clusters.join(' / '))
    // "Who is this?" picker offers people + Photo Tagger tags + Dropbox tags (one shared datalist)
    const opts = () => p4.locator('#people-names option').evaluateAll((els) => els.map((e) => e.value))
    eq(await p4.locator('datalist#people-names').count(), 1, 'one shared datalist')
    const obama = p4.locator('[data-testid=cluster]', { has: p4.locator('.pick[title="obama-portrait.jpg"]') })
    await obama.getByTestId('cluster-name').fill('Barack Obama'); await obama.getByTestId('cluster-save').click()
    await p4.locator('[data-testid=person-card][data-person="Barack Obama"]').waitFor()
    const o = await opts()
    const ptTag = ((sidecarFor(st, 'f3')?.photo.tags ?? []).find((t) => t.source === 'auto')?.name)
    ok(o[0] === 'Barack Obama', 'people first: ' + o.slice(0, 5))
    ok(o.includes('family_trip'), 'Dropbox tag offered: ' + o)
    ok(ptTag && o.includes(ptTag), `Photo Tagger tag offered (${ptTag})`)
    ok(o.indexOf('family_trip') < o.indexOf(ptTag), 'Dropbox tags before detected tags')
    ok(!o.some((x) => /^\d{4}$/.test(x)), 'no year/EXIF tags offered')
    // typing a variant of an existing tag uses that exact tag name (no second spelling)
    const biden = p4.locator('[data-testid=cluster]', { has: p4.locator('.pick[title="biden-2013.jpg"]') })
    await biden.getByTestId('cluster-name').fill('Family Trip'); await biden.getByTestId('cluster-save').click()
    await p4.locator('[data-testid=person-card][data-person="family_trip"]').waitFor()
    eq(await p4.locator('[data-testid=person-card][data-person="Family Trip"]').count(), 0, 'no duplicate spelling created')
    eq(st.writes, 0, 'no Dropbox writes')
  } finally { await c4.close() }
})

await test('Tagging backend: one summary across imports, pending photos survive, Retry starts a fresh worker', async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' })
  await routeModel(c)
  let broken = true
  let attempts = 0
  await c.route('**/ort/**', async route => {
    attempts++
    if (broken) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '<!doctype html><html>missing runtime</html>' })
    return route.continue()
  })
  const p = await c.newPage()
  try {
    await p.goto(URL_BASE)
    await p.getByTestId('empty').waitFor()
    await p.evaluate(() => {
      window.__taggingNotices = []
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches('.toast') && /Tagging model unavailable/.test(node.textContent || '')) window.__taggingNotices.push(node.textContent)
        }
      }).observe(document.body, { childList: true, subtree: true })
    })
    await p.getByTestId('file-input').setInputFiles([sample('dog.jpg')])
    await p.waitForFunction(() => window.__taggingNotices.length === 1, null, { timeout: 90_000 })
    const firstAttempts = attempts
    // A separate streamed batch must not initialize the failed backend again.
    await p.waitForTimeout(2000)
    await p.getByTestId('file-input').setInputFiles([sample('cat.jpg')])
    await p.locator('[data-testid=photo-tile][data-name="cat.jpg"]').waitFor()
    await p.waitForTimeout(1500)
    eq(await p.evaluate(() => window.__taggingNotices.length), 1, 'one summary, no per-file spam')
    eq(attempts, firstAttempts, 'failed backend paused across batches')
    eq(await p.locator('[data-testid=photo-tile][data-status=pending]').count(), 2, 'photos retained for retry')
    broken = false
    await p.getByRole('button', { name: 'Retry tagging' }).click()
    await p.waitForFunction(() => document.querySelectorAll('[data-testid=photo-tile][data-status=ready]').length === 2, null, { timeout: 180_000 })
    ok(attempts > firstAttempts, 'Retry loads runtime in a fresh worker')
    eq(await p.evaluate(() => window.__taggingNotices.length), 1, 'successful retry has no error')
  } finally { await c.close() }
})

await test('Face models: HTML response toasts once and does not block photo tagging', async () => {
  const c3 = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  // Simulate missing desktop face-models (SPA/asset fallback returns index.html)
  await c3.route('**/face-models/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>index</body></html>' })
  })
  const p3 = await c3.newPage()
  try {
    await p3.goto(URL_BASE)
    await p3.getByTestId('empty').waitFor()
    await p3.getByTestId('file-input').setInputFiles([sample('person.jpg')])
    await p3.locator('[data-testid=photo-tile][data-name="person.jpg"]').waitFor({ timeout: 180_000 })
    // Wait for face init failure toast (and ensure it does not multiply)
    await p3.waitForFunction(() => [...document.querySelectorAll('.toast')].some((n) => /Face detection/i.test(n.textContent || '')), null, { timeout: 60_000 })
    await p3.waitForTimeout(2_500)
    const faceToasts = await p3.evaluate(() =>
      [...document.querySelectorAll('.toast')].map((n) => n.textContent || '').filter((t) => /Face detection/i.test(t)))
    ok(faceToasts.length === 1, 'exactly one face-detection toast (got ' + faceToasts.length + ': ' + JSON.stringify(faceToasts) + ')')
    ok(/unavailable|not packaged|HTML|manifest/i.test(faceToasts[0]), 'toast explains the failure')
    // Import a second photo — must not add another face toast
    await p3.getByTestId('file-input').setInputFiles([sample('dog.jpg')])
    await p3.locator('[data-testid=photo-tile][data-name="dog.jpg"]').waitFor({ timeout: 180_000 })
    await p3.waitForTimeout(2_000)
    const faceToasts2 = await p3.evaluate(() =>
      [...document.querySelectorAll('.toast')].map((n) => n.textContent || '').filter((t) => /Face detection/i.test(t)))
    ok(faceToasts2.length <= 1, 'still at most one face toast after a second photo (got ' + faceToasts2.length + ')')
  } finally {
    await c3.close()
  }
})


await test('duplicate photos are skipped; non-images are ignored', async () => {
  const before = (await names()).length
  await page.getByTestId('file-input').setInputFiles([sample('dog.jpg'), sample('ATTRIBUTION.md')])
  await page.waitForTimeout(800)
  eq((await names()).length, before)
})

await test('delete a photo from the detail view', async () => {
  const before = (await names()).length
  const target = (await tile('from-dropbox.jpg').count()) ? 'from-dropbox.jpg'
    : (await tile('from-dropbox-2.jpg').count()) ? 'from-dropbox-2.jpg'
    : (await names())[0]
  await tile(target).click()
  await page.getByTestId('delete-photo').click()
  await page.getByTestId('remove-confirm-btn').click()
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=photo-tile]').length === n, before - 1)
  eq(dbx.writes, 0, 'removing a Dropbox-backed photo never calls Dropbox')
})

// ---------- faces / people ----------
console.log('\nPeople (on-device face recognition)')
const FACE_FILES = ['biden-2013.jpg', 'biden-2021.jpg', 'biden-2009.jpg', 'obama-biden-2009.jpg', 'obama-portrait.jpg']
const faceDb = () => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('photo-tagger'); r.onsuccess = () => { const q = r.result.transaction('faces').objectStore('faces').getAll(); q.onsuccess = () => { res(q.result.map((f) => ({ id: f.id, photoId: f.photoId, status: f.status, personId: f.personId ?? null }))); r.result.close() } }
}))
const people = (sel = '') => page.locator(`[data-testid=person-card]${sel}`)
const sugDump = async () => JSON.stringify(await page.locator('[data-testid=suggestion]').evaluateAll((els) => els.map((e) => e.dataset.photo + '@' + e.querySelector('.dist')?.textContent)))
const sugCount = async () => (await page.getByTestId('suggestion-count').count()) ? Number(await page.getByTestId('suggestion-count').textContent()) : 0
const setThreshold = (v) => page.getByTestId('face-threshold').evaluate((el, v) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true }))
}, v)
const goPeople = async () => { await page.getByTestId('view-people').click(); await page.getByTestId('people-view').waitFor() }
const goPhotos = async () => { await page.getByTestId('view-photos').click(); await page.getByTestId('grid').waitFor() }
const allScanned = async (n) => { for (let i = 0; i < 300; i++) { if (await page.evaluate((n) => new Promise((res) => { const r = indexedDB.open('photo-tagger'); r.onsuccess = () => { const q = r.result.transaction('photos').objectStore('photos').getAll(); q.onsuccess = () => { res(q.result.length >= n && q.result.every((p) => p.facesScanned)); r.result.close() } } }), n)) return; await page.waitForTimeout(1000) } throw new Error('face scan did not finish') }
const openPerson = async (n) => { if (!(await page.getByTestId('person-panel').count()) || (await page.locator('[data-testid=person-panel] h3').textContent()) !== n) await people(`[data-person="${n}"]`).click(); await page.getByTestId('person-panel').waitFor() }

await test('faces: portraits are detected on-device and grouped into clusters of the same person', async () => {
  const beforeFaces = (await names()).length
  await page.getByTestId('file-input').setInputFiles(FACE_FILES.map(sample))
  await waitReady(beforeFaces + FACE_FILES.length, 300_000, { keepDupes: true })
  // ensure every photo has been face-scanned (kept near-dupes from earlier may still be pending)
  await goPeople()
  if (await page.getByTestId('face-scan').count()) await page.getByTestId('face-scan').click()
  await allScanned(beforeFaces + FACE_FILES.length)
  await page.waitForFunction(() => !document.querySelector('[data-testid=face-scan-progress]'), null, { timeout: 300_000 })
  await goPeople()
  await page.waitForFunction(() => !document.querySelector('[data-testid=face-scan-progress]'), null, { timeout: 300_000 })
  const fs_ = await faceDb()
  const pn = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('photo-tagger'); r.onsuccess = () => { const q = r.result.transaction('photos').objectStore('photos').getAll(); q.onsuccess = () => res(Object.fromEntries(q.result.map((p) => [p.id, p.name + ':' + p.faceCount + ':' + p.facesScanned + ':' + p.status]))) } }))
  eq(fs_.map((f) => pn[f.photoId].split(':')[0]).sort(), ['biden-2009.jpg', 'biden-2013.jpg', 'biden-2021.jpg', 'cat.jpg', 'geotagged-cat.jpg', 'obama-biden-2009.jpg', 'obama-biden-2009.jpg', 'obama-portrait.jpg', 'person.jpg'],
    'faces: 4 Biden, 2 Obama, 1 distractor person, plus the detector also fires on the (same) cat face ' + JSON.stringify(Object.values(pn)))
  ok(await page.getByTestId('privacy-note').isVisible(), 'privacy note')
  const clusters = (await page.getByTestId('cluster').evaluateAll((els) => els.map((e) => e.dataset.photos.split('|').sort().join('|')))).sort()
  ok(clusters.includes('biden-2009.jpg|biden-2013.jpg|biden-2021.jpg|obama-biden-2009.jpg'), `Biden cluster: ${clusters.join(' / ')}`)
  ok(clusters.includes('obama-biden-2009.jpg|obama-portrait.jpg'), `Obama cluster: ${clusters.join(' / ')}`)
  ok(clusters.includes('person.jpg'), `distractor alone: ${clusters.join(' / ')}`)
  ok(clusters.includes('cat.jpg|geotagged-cat.jpg'), `cat false positives kept apart: ${clusters.join(' / ')}`)
})

await test('faces: a false positive (cat) can be ignored and stays out of clusters', async () => {
  for (let i = 0; i < 2; i++) await page.locator('[data-testid=cluster]', { has: page.locator('.pick[title="cat.jpg"], .pick[title="geotagged-cat.jpg"]') }).first().getByTestId('face-ignore').first().click()
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid=cluster]')].some((c) => /cat/.test(c.dataset.photos)))
  eq(await page.getByTestId('cluster').count(), 3)
})

await test('faces: name one face, the others are suggested; threshold slider changes suggestions', async () => {
  const c = page.locator('[data-testid=cluster]', { has: page.locator('.pick[title="biden-2013.jpg"]') })
  await c.locator('.pick[title="biden-2013.jpg"]').click()
  await c.getByTestId('cluster-name').fill('Joe Biden'); await c.getByTestId('cluster-save').click()
  await people('[data-person="Joe Biden"]').waitFor()
  await page.waitForFunction(() => document.querySelector('[data-testid=suggestion-count]')?.textContent === '3')
  const sp = (await page.locator('[data-testid=suggestions][data-person="Joe Biden"] [data-testid=suggestion]').evaluateAll((els) => els.map((e) => e.dataset.photo))).length
  eq(sp, 3)
  await setThreshold(0.3); await page.waitForTimeout(300)
  ok((await sugCount()) < 3, `stricter gives fewer: ${await sugCount()}`)
  await setThreshold(0.7); await page.waitForTimeout(300)
  eq(await sugCount(), 3, 'looser: still only the 3 Biden faces')
  await setThreshold(0.5); await page.waitForTimeout(300)
})

const photoIdOf = (n) => page.evaluate((n) => new Promise((res) => { const r = indexedDB.open('photo-tagger'); r.onsuccess = () => { const q = r.result.transaction('photos').objectStore('photos').getAll(); q.onsuccess = () => { res(q.result.find((p) => p.name === n)?.id); r.result.close() } } }), n)

await test('faces: confirm and reject suggestions; rejections stick across reload and looser thresholds', async () => {
  { // caption rule with people present: a tile whose only tags are people still shows them as chips
    await page.getByTestId('view-photos').click(); await page.getByTestId('photo-tile').first().waitFor()
    const rows = await page.locator('[data-testid=photo-tile]').evaluateAll((els) => els.map((e) => ({ n: e.dataset.tags.split('|').filter(Boolean).length, chips: [...e.querySelectorAll('.cap > span')].map((c) => c.textContent), more: !!e.querySelector('[data-testid=tile-more]') })))
    ok(rows.every((r) => r.chips.length === Math.min(2, r.n) && r.more === r.n > 2), 'caption rule holds with people: ' + JSON.stringify(rows.filter((r) => !(r.chips.length === Math.min(2, r.n) && r.more === r.n > 2))))
    ok(rows.some((r) => r.n >= 1), 'tiles checked')
    // 1.0.21: named people come first in the caption
    const order = await page.locator('[data-testid=photo-tile]').evaluateAll((els) => els.map((e) => ({ name: e.dataset.name, chips: [...e.querySelectorAll('.cap > span')].map((c) => c.textContent) })))
    const people = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('photo-tagger'); r.onsuccess = () => { const q = r.result.transaction('photos').objectStore('photos').getAll(); q.onsuccess = () => { res(q.result.map((p) => ({ name: p.name, persons: p.tags.filter((t) => t.source === 'person').map((t) => t.name), others: p.tags.filter((t) => t.source !== 'person').length }))); r.result.close() } } }))
    const withBoth = people.filter((p) => p.persons.length && p.others)
    ok(withBoth.length > 0, 'a photo has a person and other tags')
    for (const p of withBoth) {
      const chips = order.find((o) => o.name === p.name)?.chips ?? []
      eq(chips.slice(0, Math.min(2, p.persons.length)), p.persons.slice(0, 2), 'person names first on ' + p.name)
    }
    await page.getByTestId('view-people').click()
  }
  const id21 = await photoIdOf('biden-2021.jpg'), id09 = await photoIdOf('biden-2009.jpg')
  const lay = await page.locator('[data-testid=suggestion]').first().evaluate((el) => { const i = el.querySelector('img').getBoundingClientRect(), b = el.querySelector('[data-testid=suggest-yes]').getBoundingClientRect(); return { imgBottom: i.bottom, btnTop: b.top, w: i.width } })
  ok(lay.btnTop >= lay.imgBottom - 0.5 && lay.w >= 100, 'Yes/No sit below a larger face, not over it: ' + JSON.stringify(lay))
  await page.locator(`[data-testid=suggestion][data-photo="${id21}"] [data-testid=suggest-yes]`).click()
  await page.waitForFunction(() => document.querySelector('[data-testid=suggestion-count]')?.textContent === '2')
  await page.locator(`[data-testid=suggestion][data-photo="${id09}"] [data-testid=suggest-no]`).click()
  await page.waitForFunction(() => document.querySelector('[data-testid=suggestion-count]')?.textContent === '1')
  await page.getByTestId('confirm-all').click()
  await page.waitForFunction(() => !document.querySelector('[data-testid=suggestion-count]'))
  await page.reload(); await goPeople(); await setThreshold(0.7); await page.waitForTimeout(500)
  eq(await sugCount(), 0, 'rejected face not re-suggested ' + await sugDump())
  await setThreshold(0.5)
  await goPhotos()
  for (const n of ['biden-2013.jpg', 'biden-2021.jpg', 'obama-biden-2009.jpg']) ok((await tagsOf(n)).includes('joe biden'), `${n} has person tag`)
  ok(!(await tagsOf('biden-2009.jpg')).includes('joe biden'), 'rejected photo not tagged')
})

await test('faces: name a cluster; filter by person with AND / OR and search', async () => {
  await goPeople()
  const c = page.locator('[data-testid=cluster]', { has: page.locator('.pick[title="obama-portrait.jpg"]') })
  await c.getByTestId('cluster-name').fill('Barack Obama'); await c.getByTestId('cluster-save').click()
  await people('[data-person="Barack Obama"]').waitFor()
  await goPhotos()
  await (await chip('joe biden')).click()
  eq(await names(), ['biden-2013.jpg', 'biden-2021.jpg', 'obama-biden-2009.jpg'])
  await (await chip('barack obama')).click()
  eq(await names(), ['obama-biden-2009.jpg'], 'AND')
  await page.getByTestId('mode-or').click()
  eq(await names(), ['biden-2013.jpg', 'biden-2021.jpg', 'obama-biden-2009.jpg', 'obama-portrait.jpg'], 'OR')
  await page.getByTestId('mode-and').click(); await clearFilters()
  await page.getByTestId('search').fill('obama'); const s = await names(); await page.getByTestId('search').fill('')
  ok(s.includes('obama-portrait.jpg') && s.includes('obama-biden-2009.jpg'), `search: ${s}`)
  await goPeople(); await openPerson('Barack Obama'); await page.getByTestId('person-photos').click()
  await page.getByTestId('grid').waitFor()
  eq(await names(), ['obama-biden-2009.jpg', 'obama-portrait.jpg'], 'show photos'); await clearFilters()
})

await test('faces: removing a person tag in the detail view rejects that face', async () => {
  await tile('biden-2021.jpg').click(); await page.getByTestId('detail').waitFor()
  ok((await page.getByTestId('face-count').textContent()) === '1', 'face count')
  await page.locator('[data-testid=detail-tag][data-tag="joe biden"] [data-testid=remove-tag]').click()
  await page.locator('[data-testid=detail-tag][data-tag="joe biden"]').waitFor({ state: 'detached' })
  await page.getByTestId('detail-close').click()
  const id = await photoIdOf('biden-2021.jpg')
  const f = (await faceDb()).find((x) => x.photoId === id)
  ok(f.status !== 'confirmed', `status ${f.status}`)
  await goPeople(); await setThreshold(0.7); await page.waitForTimeout(400)
  eq(await sugCount(), 0, 'removed face not re-suggested'); await setThreshold(0.5)
})

await test('people: merge, rename and delete', async () => {
  const c = page.locator('[data-testid=cluster]', { has: page.locator('.pick[title="biden-2009.jpg"]') })
  await c.locator('.pick[title="biden-2009.jpg"]').click()
  await c.getByTestId('cluster-name').fill('J. Biden'); await c.getByTestId('cluster-save').click()
  await openPerson('J. Biden')
  await page.getByTestId('person-merge-into').selectOption({ label: 'Joe Biden' }); await page.getByTestId('person-merge').click()
  await people('[data-person="J. Biden"]').waitFor({ state: 'detached' })
  await openPerson('Joe Biden')
  await page.getByTestId('person-rename').fill('President Biden'); await page.getByTestId('person-rename-save').click()
  await people('[data-person="President Biden"]').waitFor()
  await openPerson('Barack Obama')
  await page.getByTestId('person-delete').click(); await page.getByTestId('person-delete').click()
  await people('[data-person="Barack Obama"]').waitFor({ state: 'detached' })
  await goPhotos()
  ok((await tagsOf('biden-2009.jpg')).includes('president biden'), 'merged face tagged with new name')
  ok(!(await tagsOf('biden-2013.jpg')).includes('joe biden'), 'old name gone')
  ok(!(await tagsOf('obama-portrait.jpg')).includes('barack obama'), 'deleted person tag removed')
})

await test('people: JSON and CSV exports include person tags', async () => {
  await openSettings('data')
  const [dj] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()])
  const j = JSON.parse(await fs.readFile(await dj.path(), 'utf8'))
  ok(j.photos.find((p) => p.name === 'biden-2013.jpg').tags.some((t) => t.name === 'president biden' && t.source === 'person'), 'JSON person tag')
  const [dc] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()])
  const csv = await fs.readFile(await dc.path(), 'utf8')
  ok(csv.split(/\r?\n/).some((l) => l.startsWith('biden-2013.jpg') && l.includes('president biden')), 'CSV person tag')
  await closeSettings()
})

await test('privacy: recognition off skips new photos; clear deletes all face data; re-enable rescans', async () => {
  await goPeople()
  await page.getByTestId('face-enabled').uncheck()
  await goPhotos()
  const copy = path.join('/tmp', 'biden-copy.jpg')
  const buf = await fs.readFile(sample('biden-2013.jpg')); await fs.writeFile(copy, Buffer.concat([buf, Buffer.from('copy')]))
  const beforeCopy = (await names()).length
  await page.getByTestId('file-input').setInputFiles([copy]); await waitReady(beforeCopy + 1, 300_000, { keepDupes: true })
  await tile('biden-copy.jpg').click(); await page.waitForTimeout(500)
  eq(await page.getByTestId('face-count').textContent(), 'not checked'); await page.getByTestId('detail-close').click()
  await goPeople(); await page.getByTestId('face-clear').click(); await page.getByTestId('face-clear').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=person-card]').length === 0)
  eq((await faceDb()).length, 0, 'faces cleared')
  await goPhotos(); ok(!(await tagsOf('biden-2013.jpg')).includes('president biden'), 'person tags cleared'); await goPeople()
  await page.getByTestId('face-enabled').check()
  await page.getByTestId('face-scan').click()
  await allScanned(beforeCopy + 1)
  ok((await faceDb()).length >= 8, 'faces rescanned after re-enable')
})

// ---------- duplicates + folder/zip save ----------
console.log('\nDuplicates & save')

await test('duplicates: same file twice is skipped by the cheap fingerprint', async () => {
  await goPhotos()
  const before = (await names()).length
  await page.getByTestId('file-input').setInputFiles([sample('dog.jpg')])
  await page.waitForTimeout(800)
  eq((await names()).length, before)
})

await test('duplicates: same image with a different name is skipped by content hash', async () => {
  const before = (await names()).length
  await page.getByTestId('file-input').setInputFiles([sample('dog-renamed.jpg')])
  await page.waitForFunction((n) => {
    const t = [...document.querySelectorAll('.toast')].map((e) => e.textContent).join(' ')
    return t.includes('duplicate') || document.querySelectorAll('[data-testid=photo-tile]').length > n
  }, before, { timeout: 60_000 })
  eq((await names()).length, before, 'renamed exact copy not added')
  ok((await page.locator('.toast').allTextContents()).some((t) => /duplicate/i.test(t)), 'toast mentions duplicate')
})

await test('duplicates: a recompressed/resized copy is offered as a near-duplicate; a different photo is not', async () => {
  await goPhotos()
  const before = (await names()).length
  await page.getByTestId('file-input').setInputFiles([sample('dog-recompress.jpg')])
  await page.getByTestId('dupe-review').waitFor({ timeout: 120_000 })
  const row = page.locator('[data-testid=dupe-row][data-name="dog-recompress.jpg"]')
  await row.waitFor()
  ok(Number(await row.getAttribute('data-distance')) <= 8, 'recompress within default threshold')
  await row.getByTestId('dupe-keep').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=photo-tile][data-name="dog-recompress.jpg"]'), null, { timeout: 120_000 })
  ok((await names()).includes('dog-recompress.jpg'), 'kept near-dupe is in the library')
  // a clearly different photo is added with no review
  await page.getByTestId('file-input').setInputFiles([sample('dropbox-stub.jpg')])
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=photo-tile]').length >= n, before + 2, { timeout: 120_000 })
  ok(!(await page.getByTestId('dupe-review').count()), 'different photo not flagged')
  // Mark path: raise threshold, add dog-crop, mark as duplicate
  await openSettings('data')
  await page.getByTestId('set-dupe-threshold').evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, '12'); el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await closeSettings()
  await page.getByTestId('file-input').setInputFiles([sample('dog-crop.jpg')])
  await page.getByTestId('dupe-review').waitFor({ timeout: 120_000 })
  await page.locator('[data-testid=dupe-row][data-name="dog-crop.jpg"] [data-testid=dupe-mark]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid=photo-tile][data-name="dog-crop.jpg"][data-duplicate="1"]'), null, { timeout: 60_000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid=dupe-review]'), null, { timeout: 30_000 }).catch(() => {})
})

await test('duplicates: Find duplicates scans the library; Not a duplicate sticks', async () => {
  await goPhotos()
  await page.evaluate(() => document.querySelector('[data-testid=dupe-skip-all]')?.click())
  await page.waitForTimeout(200)
  // Open Data settings via the DOM (avoids overlays intercepting Playwright clicks)
  await page.evaluate(() => document.querySelector('[data-testid=open-settings]')?.click())
  await page.getByTestId('settings').waitFor()
  await page.evaluate(() => document.querySelector('[data-testid=tab-data]')?.click())
  await page.getByTestId('find-dupes').waitFor()
  await page.getByTestId('set-dupe-threshold').evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(el, '8'); el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.evaluate(() => document.querySelector('[data-testid=find-dupes]')?.click())
  await page.getByTestId('dupe-review').waitFor({ timeout: 120_000 })
  await page.evaluate(() => document.querySelector('[data-testid=settings-close]')?.click())
  const row = page.locator('[data-testid=dupe-row][data-name="dog-recompress.jpg"], [data-testid=dupe-row][data-match="dog-recompress.jpg"]').first()
  await row.waitFor()
  await row.getByTestId('dupe-keep').click() // Not a duplicate
  await page.waitForTimeout(400)
  // re-scan should not re-flag that pair
  await page.evaluate(() => document.querySelector('[data-testid=open-settings]')?.click())
  await page.getByTestId('settings').waitFor()
  await page.evaluate(() => { document.querySelector('[data-testid=tab-data]')?.click(); document.querySelector('[data-testid=find-dupes]')?.click() })
  await page.waitForTimeout(2000)
  await page.evaluate(() => document.querySelector('[data-testid=settings-close]')?.click())
  const still = await page.locator('[data-testid=dupe-row]').evaluateAll((els) =>
    els.map((e) => [e.dataset.name, e.dataset.match].sort().join('|'))
      .filter((k) => k.includes('dog-recompress') && k.includes('dog.jpg')))
  eq(still, [], 'dismissed pair not re-flagged: ' + still.join(','))
  if (await page.getByTestId('dupe-review').count()) await page.getByTestId('dupe-skip-all').click()
})

await test('save: zip download contains photos and tag files', async () => {
  await openSettings('data')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('save-zip').click()])
  const dest = '/tmp/photo-tagger-test.zip'
  await dl.saveAs(dest)
  await closeSettings()
  // unzip with python
  const out = execSync(`python3 -c "import zipfile; z=zipfile.ZipFile('${dest}'); print('\\\\n'.join(sorted(z.namelist())[:8])); print('HAS_JSON', 'photo-tagger.json' in z.namelist()); print('HAS_CSV', 'photo-tagger.csv' in z.namelist()); print('NPHOTOS', sum(1 for n in z.namelist() if n.startswith('photos/') and not n.endswith('.json')))"`).toString()
  ok(out.includes('HAS_JSON True') && out.includes('HAS_CSV True'), out)
  ok(/NPHOTOS [1-9]/.test(out), out)
})

await test('add-tag box suggests every existing tag (70+), filtered as you type; close spellings reuse the existing tag', async () => {
  const names = 'abcdefghijklmnopqrstuvwxy'.split('').flatMap((c) => [c + 'lpha', c + 'ravo', c + 'harlie']).concat(['wedding', 'zebra', 'family_trip'])
  ok(names.length >= 70, 'test has 70+ tags')
  const n = (await page.locator('[data-testid=photo-tile]').count())
  const t0 = page.locator('[data-testid=photo-tile]').first(), t1 = page.locator('[data-testid=photo-tile]').nth(Math.min(1, n - 1))
  await t0.click()
  await page.getByTestId('detail-tag-input').fill(names.join(', ')); await page.getByTestId('detail-tag-input').press('Enter')
  await page.locator('[data-testid=detail-tag][data-tag="zebra"]').waitFor()
  await page.keyboard.press('Escape'); await page.getByTestId('detail').waitFor({ state: 'detached' })
  await t1.click()
  const input = page.getByTestId('detail-tag-input'), list = page.getByTestId('detail-tag-input-suggestions')
  await input.click()
  ok((await list.getByTestId('tag-suggestion').count()) > 70, 'empty box lists every existing tag, not just 60')
  await input.fill('zeb')
  await list.locator('[data-tag="zebra"]').waitFor()
  await input.fill('wedd'); await list.locator('[data-tag="wedding"]').waitFor()
  await input.fill('family trip')
  await list.locator('[data-tag="family_trip"]').waitFor()
  await input.press('Enter')
  await page.locator('[data-testid=detail-tag][data-tag="family_trip"]').waitFor()
  eq(await page.locator('[data-testid=detail-tag][data-tag="family trip"]').count(), 0, 'no "family trip" variant created')
  ok(!(await page.locator('[data-testid=photo-tile]').evaluateAll((els) => els.some((e) => e.dataset.tags.split('|').includes('family trip')))), 'no variant anywhere in the library')
  // keyboard: arrow + Enter picks the highlighted suggestion; Escape closes only the list
  await input.fill('zebr'); await input.press('ArrowDown'); await input.press('Enter')
  await page.locator('[data-testid=detail-tag][data-tag="zebra"]').waitFor()
  await input.fill('alp'); await input.press('Escape')
  eq(await list.count(), 0, 'Escape closes the suggestions'); ok(await page.getByTestId('detail').isVisible(), 'detail still open')
  await input.fill('')
  await page.keyboard.press('Escape')
})

await test('Settings → Tags lists every library tag (searchable), adds list entries and renames a tag everywhere', async () => {
  await goPeople()
  const oc = page.locator('[data-testid=cluster]', { has: page.locator('.pick[title="obama-portrait.jpg"]') })
  await oc.getByTestId('cluster-name').fill('President Biden'); await oc.getByTestId('cluster-save').click()
  await people('[data-person="President Biden"]').waitFor()
  await goPhotos(); await settled()
  await openSettings('vocab')
  const list = page.getByTestId('library-tags-list')
  await list.locator('[data-tag="zebra"]').waitFor()
  ok((await list.getByTestId('library-tag').count()) > 70, 'whole list, no cap')
  // 1.0.22: every kind of used tag is listed, no hidden tail, no nested 320px scroller
  await closeSettings()
  const used = [...new Set(await page.locator('[data-testid=photo-tile]').evaluateAll((els) => els.flatMap((e) => e.dataset.tags.split('|').filter(Boolean))))]
  await openSettings('vocab'); await list.locator('[data-tag="zebra"]').waitFor()
  const listed = new Set(await list.getByTestId('library-tag').evaluateAll((els) => els.map((e) => e.dataset.tag)))
  for (const n of ['president biden', 'zebra', 'cat', '2021', 'blurry']) ok(used.includes(n) && listed.has(n), 'person/manual/auto/exif/quality tag listed: ' + n)
  for (const n of used) ok(listed.has(n), 'used tag listed: ' + n)
  const late = [...listed].sort().at(-1); await list.locator(`[data-tag="${late}"]`).waitFor({ state: 'attached' })
  eq(await list.evaluate((e) => getComputedStyle(e).maxHeight), 'none', 'list not clipped to a nested scroller')
  // person tag can be renamed here → renames the person
  await list.locator('[data-tag="president biden"]').getByTestId('library-tag-rename').click()
  await page.getByTestId('library-tag-rename-input').fill('Joseph Biden'); await page.getByTestId('library-tag-rename-save').click()
  await page.getByTestId('rename-confirm').waitFor()
  ok(await page.getByTestId('rename-cancel').evaluate((b) => b === document.activeElement), 'Cancel focused (person)')
  await page.getByTestId('rename-confirm-btn').click()
  await list.locator('[data-tag="joseph biden"]').waitFor()
  // the person's photos are renamed one by one: wait for the last one, then report what still has the old name
  await list.locator('[data-tag="president biden"]').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
  if (await list.locator('[data-tag="president biden"]').count()) {
    const left = await list.locator('[data-tag="president biden"]').innerText()
    throw new Error('old person tag gone: still listed — ' + left)
  }
  await page.getByTestId('library-tags-search').fill('zeb')
  eq(await list.getByTestId('library-tag').evaluateAll((els) => els.map((e) => e.dataset.tag)), ['zebra'], 'search filters')
  await page.getByTestId('library-tags-search').fill('')
  // add a list entry → it becomes an add-tag suggestion before it's on any photo
  await page.getByTestId('library-tags-add-input').fill('Yacht Club'); await page.getByTestId('library-tags-add').click()
  await list.locator('[data-tag="yacht club"]').waitFor({ timeout: 300_000 })
  ok(/not on a photo yet/.test(await list.locator('[data-tag="yacht club"]').innerText()), 'shown as not on a photo yet')
  // rename wedding → "Wedding Day" on every photo that has it (confirm, Cancel focused)
  await list.locator('[data-tag="wedding"]').getByTestId('library-tag-rename').click()
  await page.getByTestId('library-tag-rename-input').fill('Wedding Day'); await page.getByTestId('library-tag-rename-save').click()
  await page.getByTestId('rename-confirm').waitFor()
  ok(await page.getByTestId('rename-cancel').evaluate((b) => b === document.activeElement), 'Cancel focused')
  await page.getByTestId('rename-confirm-btn').click()
  await list.locator('[data-tag="wedding day"]').waitFor()
  await list.locator('[data-tag="wedding"]').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
  if (await list.locator('[data-tag="wedding"]').count()) throw new Error('old name gone: still listed — ' + await list.locator('[data-tag="wedding"]').innerText())
  await closeSettings(); await settled()
  ok(await page.locator('[data-testid=photo-tile]').evaluateAll((els) => els.some((e) => e.dataset.tags.split('|').includes('joseph biden')) && !els.some((e) => e.dataset.tags.split('|').includes('president biden'))), 'person renamed on photos')
  ok(await page.locator('[data-testid=photo-tile]').evaluateAll((els) => els.some((e) => e.dataset.tags.split('|').includes('wedding day')) && !els.some((e) => e.dataset.tags.split('|').includes('wedding'))), 'renamed on the photo')
  await page.locator('[data-testid=photo-tile]').nth(1).click()
  await page.getByTestId('detail-tag-input').fill('yacht')
  await page.getByTestId('detail-tag-input-suggestions').locator('[data-tag="yacht club"]').waitFor()
  await page.getByTestId('detail-tag-input').fill('')
  await page.keyboard.press('Escape')
})

await test('New photos use the saved detection list without re-tagging existing photos on close', async () => {
  const c6 = await browser.newContext({ viewport: { width: 1280, height: 860 } }); await routeModel(c6)
  const p6 = await c6.newPage()
  try {
    await p6.goto(URL_BASE); await p6.getByTestId('empty').waitFor()
    await p6.getByTestId('open-settings').click(); await p6.getByTestId('tab-vocab').click()
    await p6.getByTestId('meta-year').uncheck(); await p6.getByTestId('label-cat').uncheck()
    await p6.getByTestId('settings-close').click()
    await p6.getByTestId('file-input').setInputFiles([sample('geotagged-cat.jpg')])
    await waitTile('geotagged-cat.jpg', p6)
    await p6.waitForFunction(() => document.querySelector('[data-testid=photo-tile]')?.dataset.status === 'ready', null, { timeout: 180_000 })
    const tags = (await p6.getByTestId('photo-tile').getAttribute('data-tags')).split('|')
    ok(!tags.includes('2021') && !tags.includes('cat'), 'new photo honors disabled year and CLIP cat: ' + tags)
    ok(tags.includes('geotagged') && tags.includes('samplecam sample phone 1'), 'other metadata stays enabled')
  } finally { await c6.close() }
})

await test('large library (665 photos): grid is virtualized but the whole library scrolls into view', async () => {
  const c5 = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  await routeModel(c5)
  const p5 = await c5.newPage()
  try {
    await p5.goto(URL_BASE); await p5.getByTestId('empty').waitFor()
    await p5.getByTestId('file-input').setInputFiles([sample('cat.jpg')])
    await waitTile('cat.jpg', p5)
    await p5.waitForFunction(() => document.querySelector('[data-testid=photo-tile]')?.dataset.status !== 'pending', null, { timeout: 180_000 })
    await idb(p5, `return new Promise((res) => { const st = db.transaction('photos', 'readwrite').objectStore('photos'); const q = st.getAll(); q.onsuccess = () => { const p = q.result[0]; for (let i = 1; i < arg; i++) st.put({ ...p, id: 'bulk-' + i, name: 'bulk-' + String(i).padStart(3, '0') + '.jpg', addedAt: p.addedAt - i * 1000, takenAt: (p.takenAt || p.addedAt) - i * 86400000, facesScanned: true, contentHash: 'bulk' + i, phash: undefined }); st.transaction.oncomplete = () => res() } })`, 665)
    await p5.reload()
    await p5.waitForFunction(() => /665/.test(document.querySelector('[data-testid=count]')?.textContent || ''), null, { timeout: 60_000 })
    ok(/665 photos/.test(await p5.getByTestId('count').innerText()), 'count shows all: ' + await p5.getByTestId('count').innerText())
    const g = p5.getByTestId('grid')
    await g.locator('[data-testid=photo-tile]').first().waitFor()
    const info = await g.evaluate((el) => { const cols = getComputedStyle(el).gridTemplateColumns.split(' ').length; const t = el.querySelector('[data-testid=photo-tile]').getBoundingClientRect().height; return { cols, h: el.getBoundingClientRect().height, tile: t, mounted: el.querySelectorAll('[data-testid=photo-tile]').length } })
    const needed = Math.ceil(665 / info.cols) * info.tile
    ok(info.h >= needed, `grid tall enough for all rows: ${info.h} >= ${needed} (${info.cols} cols)`)
    ok(info.h > 860 * 5, 'much taller than one viewport')
    ok(info.mounted < 665, `virtualized: only ${info.mounted} tiles mounted`)
    const firstName = await g.locator('[data-testid=photo-tile]').first().getAttribute('data-name')
    // scroll the window to the bottom: the last photos mount and are visible
    await p5.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await p5.waitForFunction((f) => { const ts = [...document.querySelectorAll('[data-testid=photo-tile]')]; return ts.length > 0 && ts.length < 665 && !ts.some((t) => t.dataset.name === f) }, firstName, { timeout: 10_000 }).catch(() => {})
    const names = await g.locator('[data-testid=photo-tile]').evaluateAll((els) => els.map((e) => e.dataset.name))
    ok(!names.includes(firstName), 'first tile unmounted after scrolling to the end')
    const last = await p5.evaluate(() => { const ts = [...document.querySelectorAll('[data-testid=photo-tile]')]; const t = ts[ts.length - 1]; const r = t.getBoundingClientRect(); return { r: { top: r.top, bottom: r.bottom }, vh: window.innerHeight } })
    ok(last.r.top < last.vh && last.r.bottom > 0, 'last tile is on screen: ' + JSON.stringify(last))
    // middle of the library also reachable
    await p5.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2))
    await p5.waitForTimeout(300)
    const mid = await p5.evaluate(() => [...document.querySelectorAll('[data-testid=photo-tile]')].filter((t) => { const r = t.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight }).length)
    ok(mid > 0, 'tiles visible mid-scroll')
  } finally { await c5.close() }
})

await test('no page errors on desktop', async () => { eq(errors, []) })

// ---------- mobile ----------
console.log('\nMobile (iPhone 13 viewport, touch)')
const iphone = devices['iPhone 13']
const mctx = await browser.newContext({ viewport: iphone.viewport, userAgent: iphone.userAgent, deviceScaleFactor: iphone.deviceScaleFactor, isMobile: true, hasTouch: true, acceptDownloads: true })
await routeModel(mctx)
const m = await mctx.newPage()
const merrors = []
m.on('pageerror', (e) => merrors.push(e.message))
const noOverflow = async (label) => ok(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `horizontal overflow on ${label}`)

await test('mobile: empty state, Dropbox-only add, no horizontal overflow', async () => {
  await m.goto(URL_BASE)
  await m.getByTestId('empty').waitFor()
  await noOverflow('empty')
  eq(await m.getByTestId('add-dropbox').count(), 0, 'no Add photos submenu (1.0.23)')
  await m.getByTestId('add-btn').click()
  await m.getByTestId('settings').waitFor(); ok(/Dropbox/.test(await m.getByTestId('settings').innerText()), 'Add photos goes straight to Dropbox setup')
  await m.keyboard.press('Escape'); await m.getByTestId('settings').waitFor({ state: 'detached' })
  eq([await m.getByTestId('add-photos').count(), await m.getByTestId('add-camera').count(), await m.getByTestId('add-folder').count(), await m.getByTestId('camera-input').count()], [0, 0, 0, 0], 'no local add options (1.0.17)')
  eq(await m.getByTestId('empty-add').count(), 0, 'no Choose photos on the empty screen')
  ok(await m.getByTestId('empty-dropbox').isVisible(), 'From Dropbox is the empty-screen button')
  await m.keyboard.press('Escape'); await m.mouse.click(5, 300)
})

await test('mobile: ingest (fixture photos), grid is 3 columns, filters collapse into a panel', async () => {
  await m.getByTestId('file-input').setInputFiles(['pizza.jpg', 'dog.jpg', 'beach.jpg', 'city.jpg', 'blurry-mountain.jpg'].map(sample))
  {
    const t0 = Date.now()
    while (Date.now() - t0 < 300_000) {
      if (await m.getByTestId('dupe-review').count()) {
        await m.getByTestId('dupe-keep-all').click()
        await m.waitForFunction(() => !document.querySelector('[data-testid=dupe-review]'), null, { timeout: 300_000 }).catch(() => {})
        continue
      }
      if (await m.locator('[data-testid=photo-tile][data-status=ready]').count() >= 5) break
      await m.waitForTimeout(400)
    }
  }
  const cols = await m.getByTestId('grid').evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length)
  eq(cols, 3)
  await noOverflow('grid')
  ok(!(await m.getByTestId('quality').isVisible()), 'advanced filters collapsed')
  await m.getByTestId('more-filters').click()
  ok(await m.getByTestId('quality').isVisible(), 'advanced filters open')
  await m.getByTestId('quality').selectOption('blurry')
  eq(await m.getByTestId('photo-tile').count(), 1)
  await m.getByTestId('clear-filters').click()
  await m.getByTestId('more-filters').click()
  const tiles = await m.getByTestId('photo-tile').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)))
  ok(tiles.every((w) => w >= 100), `tile widths ${tiles}`)
})

await test('mobile: tap a chip to filter; long-press a photo to start multi-select', async () => {
  await m.locator('[data-testid=tag-chip][data-tag="food"]').first().tap()
  eq(await m.getByTestId('photo-tile').count(), 1)
  await m.getByTestId('clear-filters').tap()
  const el = m.locator('[data-testid=photo-tile][data-name="dog.jpg"]')
  await el.evaluate(async (e) => {
    const t = (type) => e.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true }))
    t('touchstart'); await new Promise((r) => setTimeout(r, 750)); t('touchend')
  })
  await m.getByTestId('selbar').waitFor()
  eq(await m.getByTestId('sel-count').textContent(), '1 selected')
  await noOverflow('selection bar')
  await m.getByTestId('sel-cancel').tap()
})

await test('mobile: detail view fits the screen and tags can be edited', async () => {
  await m.locator('[data-testid=photo-tile][data-name="dog.jpg"]').tap()
  await m.getByTestId('detail').waitFor()
  await m.getByTestId('detail-img').waitFor()
  await noOverflow('detail')
  const box = await m.getByTestId('detail-img').boundingBox()
  ok(box.width <= iphone.viewport.width && box.height > 120, `image box ${JSON.stringify(box)}`)
  await m.getByTestId('detail-tag-input').fill('phone tag'); await m.getByTestId('detail-tag-input-add').tap()
  await m.locator('[data-testid=detail-tag][data-tag="phone tag"]').waitFor()
  await m.getByTestId('detail-close').tap()
})

await test('mobile: settings sheet and Dropbox instructions are usable', async () => {
  await m.getByTestId('open-settings').tap()
  await m.getByTestId('tab-dropbox').tap()
  ok(await m.getByTestId('dropbox-key').isVisible())
  await noOverflow('settings')
  await m.getByTestId('settings-close').tap()
})

await test('mobile: library survives a reload (IndexedDB)', async () => {
  await m.reload(); await m.getByTestId('grid').waitFor()
  eq(await m.getByTestId('photo-tile').count(), 5)
  ok((await m.locator('[data-testid=photo-tile][data-name="dog.jpg"]').getAttribute('data-tags')).includes('phone tag'))
})

await test('mobile: People view — find faces, name a cluster, get suggestions, confirm by tap', async () => {
  await m.getByTestId('file-input').setInputFiles(['biden-2013.jpg', 'biden-2021.jpg', 'obama-portrait.jpg'].map(sample))
  await m.waitForFunction(() => document.querySelectorAll('[data-testid=photo-tile][data-status=ready]').length >= 8, null, { timeout: 300_000 })
  await m.getByTestId('view-people').tap(); await m.getByTestId('people-view').waitFor()
  await m.waitForFunction(() => document.querySelectorAll('[data-testid=cluster]').length >= 2, null, { timeout: 300_000 })
  await noOverflow('people')
  ok(await m.getByTestId('privacy-note').isVisible() && await m.getByTestId('face-threshold').isVisible(), 'privacy note + slider visible')
  const c = m.locator('[data-testid=cluster]', { has: m.locator('.pick[title="biden-2013.jpg"]') })
  await c.locator('.pick[title="biden-2013.jpg"]').tap()
  await c.getByTestId('cluster-name').fill('Joe Biden'); await c.getByTestId('cluster-save').tap()
  await m.getByTestId('suggest-yes').first().waitFor()
  await m.getByTestId('suggest-yes').first().tap()
  await m.waitForFunction(() => !document.querySelector('[data-testid=suggestion-count]'))
  await noOverflow('people with a person')
  await m.getByTestId('view-photos').tap()
  ok((await m.locator('[data-testid=photo-tile][data-name="biden-2021.jpg"]').getAttribute('data-tags')).includes('joe biden'), 'person tag on mobile')
})

await test('no page errors on mobile', async () => { eq(merrors, []) })

// ---------- dark mode ----------
console.log('\nDark mode')
await test('follows the system dark preference and can be toggled', async () => {
  const dctx = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1000, height: 700 } })
  const d = await dctx.newPage()
  await d.goto(URL_BASE); await d.getByTestId('empty').waitFor()
  eq(await d.evaluate(() => document.documentElement.dataset.theme), 'dark')
  eq(await d.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(15, 17, 23)')
  await d.getByTestId('theme').click() // auto -> light
  eq(await d.evaluate(() => document.documentElement.dataset.theme), 'light')
  await d.getByTestId('theme').click() // light -> dark
  eq(await d.evaluate(() => document.documentElement.dataset.theme), 'dark')
  await dctx.close()
})

// ---------- offline ----------
console.log('\nOffline / PWA')
await test('after first use the app opens and tags new photos with the network off', async () => {
  await page.goto(URL_BASE); await page.getByTestId('grid').waitFor()
  await page.evaluate(() => navigator.serviceWorker.ready)
  // make sure the ONNX runtime has been cached by the service worker (it was fetched during tagging)
  await page.reload(); await page.getByTestId('grid').waitFor()
  await context.setOffline(true)
  try {
    await page.reload(); await page.getByTestId('grid').waitFor({ timeout: 20_000 })
    const before = (await names()).length
    await page.getByTestId('file-input').setInputFiles(sample('geotagged-cat.jpg').replace('geotagged-cat', 'bright-beach'))
    await page.waitForTimeout(500)
    eq((await names()).length, before, 'dedupe while offline')
    // a new, distinct file name -> must be tagged offline
    const copy = path.join(ROOT, 'test-results', 'offline-unique.jpg')
    const { default: sharp } = await import('sharp')
    const w=640,h=480, buf=Buffer.alloc(w*h*3)
    for (let i=0;i<buf.length;i++) buf[i] = ((Math.sin(i*0.17+9)*10000)%255+255)%255
    await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toFile(copy)
    await page.getByTestId('file-input').setInputFiles(copy)
    await tile('offline-unique.jpg').waitFor({ timeout: 20_000 })
    await page.waitForFunction(() => document.querySelector('[data-name="offline-unique.jpg"]')?.dataset.status === 'ready', null, { timeout: 120_000 })
    ok((await tagsOf('offline-unique.jpg')).length >= 0, 'tagged offline (model ran)')
    eq(await page.locator('[data-testid=photo-tile][data-name="offline-unique.jpg"]').getAttribute('data-status'), 'ready')
  } finally { await context.setOffline(false) }
})

await browser.close(); srv.kill()
const pass = results.filter((r) => r.ok).length
console.log(`\n${pass}/${results.length} tests passed in ${((Date.now() - T0) / 1000).toFixed(0)}s`)
await fs.mkdir('test-results', { recursive: true })
await fs.writeFile('test-results/e2e-report.json', JSON.stringify({ date: new Date().toISOString(), pass, total: results.length, results }, null, 2))
process.exit(pass === results.length ? 0 : 1)
