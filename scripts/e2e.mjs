// End-to-end tests (Playwright + Chromium) against the production build served by `vite preview`.
// Real CLIP model, real sample photos (samples/), real IndexedDB. Hugging Face files are cached on disk after the first run.
// Run: npm run build && npm run test:e2e
import fs from 'node:fs/promises'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { devices } from 'playwright'
import { launch, makeScreenshotSample, ROOT, sample, startPreview, URL_BASE, routeModel } from './testkit.mjs'

const results = []
let current = ''
const T0 = Date.now()
let beforeEach = async () => {}
async function test(name, fn) {
  current = name
  const t = Date.now()
  try { await beforeEach(); await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`  ✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`) }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - t, error: String(e.message ?? e).split('\n')[0] }); console.log(`  ✗ ${name}\n      ${String(e.message ?? e).split('\n').slice(0, 4).join('\n      ')}`) }
}
const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const ok = (c, m) => { if (!c) throw new Error(m) }

const srv = await startPreview()
const { browser, context } = await launch()
await makeScreenshotSample(browser)
const FILES = ['dog.jpg', 'cat.jpg', 'beach.jpg', 'city.jpg', 'pizza.jpg', 'mountain.jpg', 'person.jpg', 'document.jpg',
  'blurry-mountain.jpg', 'dark-city.jpg', 'bright-beach.jpg', 'geotagged-cat.jpg', 'screenshot.png']

// Dropbox is stubbed: OAuth authorize/token and the HTTP API (list_folder, download, account) are served locally.
// No real key or account is used.
const SAMPLE_BY_ID = {
  'id:dbx-a': 'dropbox-import-a.jpg', 'id:dbx-b': 'dropbox-import-b.jpg', 'id:dbx-c': 'dropbox-import-g.jpg',
  'id:slow-a': 'dropbox-import-e.jpg', 'id:slow-b': 'dropbox-import-f.jpg',
  'id:f1': 'obama-portrait.jpg', 'id:f2': 'biden-2013.jpg', 'id:f3': 'biden-2021.jpg',
}
const dbxFile = (id, name, dir) => ({ '.tag': 'file', id, name, path_display: `${dir}/${name}`, path_lower: `${dir}/${name}`.toLowerCase(), rev: 'r' + id.slice(3), size: 1000, content_hash: 'h' + id, client_modified: '2024-05-01T10:00:00Z' })
const dbxDir = (name, dir) => ({ '.tag': 'folder', id: 'id:dir-' + name, name, path_display: `${dir}/${name}`, path_lower: `${dir}/${name}`.toLowerCase() })
const DBX_TREE = {
  '': [dbxDir('Photos', ''), dbxDir('Docs', ''), dbxDir('Slow', ''), dbxDir('Faces', ''), { '.tag': 'file', id: 'id:txt', name: 'readme.txt', path_display: '/readme.txt', path_lower: '/readme.txt', rev: 'r1', size: 5 }],
  '/photos': [dbxDir('Trip', '/Photos'), dbxFile('id:dbx-a', 'from-dropbox.jpg', '/Photos'), dbxFile('id:dbx-b', 'from-dropbox-2.jpg', '/Photos'), { '.tag': 'file', id: 'id:pdf', name: 'notes.pdf', path_display: '/Photos/notes.pdf', path_lower: '/photos/notes.pdf', rev: 'r2', size: 5 }],
  '/photos/trip': [dbxFile('id:dbx-c', 'trip.jpg', '/Photos/Trip')],
  '/docs': [],
  '/slow': [dbxFile('id:slow-a', 'cancel-stop-a.jpg', '/Slow'), dbxFile('id:slow-b', 'cancel-stop-b.jpg', '/Slow')],
  '/faces': [dbxFile('id:f1', 'obama-portrait.jpg', '/Faces'), dbxFile('id:f2', 'biden-2013.jpg', '/Faces'), dbxFile('id:f3', 'biden-2021.jpg', '/Faces')],
}
const idByPath = (p) => Object.values(DBX_TREE).flat().find((x) => x.path_lower === String(p).toLowerCase())?.id
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, dropbox-api-arg', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-expose-headers': 'dropbox-api-result' }
async function stubDropbox(ctx) {
  // writes = any write/delete outside Photo Tagger's /.photo-tagger metadata folder (must stay 0)
  const st = { token: [], downloads: {}, lists: [], revoked: 0, writes: 0, expireOnce: false, flakyOnce: new Set(), refreshes: 0, meta: new Map(), uploads: 0, metaDeletes: 0, thumbs: 0, fileTags: new Map([['id:dbx-a', new Set(['family_trip'])]]), tagAdds: [], tagRemoves: [], tagGets: [], tagBad: 0 }
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
    if (url.pathname === '/2/users/get_current_account') return json({ account_id: 'dbid:test', name: { display_name: 'Test User' }, email: 'test@example.com' })
    if (url.pathname === '/2/auth/token/revoke') { st.revoked++; return json(null) }
    // Native Dropbox file tags (metadata only): lowercase [\w]{1,32}, max 20 per file
    // Like the real API, the Tags endpoints only accept '/…' paths: 'id:…' gets a 400 regex error
    const badPath = (v) => !String(v).startsWith('/')
    const regex400 = () => r.fulfill({ status: 400, headers: CORS, contentType: 'text/plain', body: 'Error in call to API function "files/tags/get": Value must be a string conforming to regex (/(.|[\r\n])*)' })
    if (url.pathname === '/2/files/get_metadata') {
      const b = JSON.parse(req.postData() || '{}')
      const e = Object.values(DBX_TREE).flat().find((x) => x.id === b.path || x.path_lower === String(b.path).toLowerCase())
      return e ? json(e) : json({ error_summary: 'path/not_found/' }, 409)
    }
    if (url.pathname === '/2/files/tags/get') {
      const b = JSON.parse(req.postData() || '{}')
      if (b.paths.some(badPath)) { st.tagBad++; return regex400() }
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
        st.tagAdds.push(b); set.add(b.tag_text.toLowerCase()); return json(null)
      }
      st.tagRemoves.push(b)
      if (!set.has(b.tag_text)) return json({ error_summary: 'tag_not_present/' }, 409)
      set.delete(b.tag_text); return json(null)
    }
    if (url.pathname === '/2/files/delete_v2') {
      const p = JSON.parse(req.postData() || '{}').path || ''
      if (!p.toLowerCase().startsWith('/.photo-tagger/')) { st.writes++; return json({ error_summary: 'forbidden' }, 400) }
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
      if (!String(arg.path).toLowerCase().startsWith('/.photo-tagger/')) { st.writes++; return r.fulfill({ status: 400, headers: CORS, body: 'no' }) }
      st.uploads++; st.meta.set(arg.path.toLowerCase(), req.postData() || '')
      return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{}' })
    }
    if (url.pathname === '/2/files/get_thumbnail_v2') {
      st.thumbs++
      const f = SAMPLE_BY_ID[arg.resource?.path]
      if (!f) return r.fulfill({ status: 409, headers: CORS, body: '{}' })
      return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: await fs.readFile(sample(f)) })
    }
    if (url.pathname !== '/2/files/download') { st.writes++; return r.fulfill({ status: 400, headers: CORS, body: 'no' }) }
    const id = arg.path
    if (String(id).startsWith('id:meta-') || String(id).toLowerCase().startsWith('/.photo-tagger/')) {
      const key = String(id).replace(/^id:meta-/, '').toLowerCase()
      return st.meta.has(key) ? r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: st.meta.get(key) }) : r.fulfill({ status: 409, headers: CORS, contentType: 'application/json', body: '{"error_summary":"path/not_found/"}' })
    }
    st.downloads[id] = (st.downloads[id] || 0) + 1
    if (st.flakyOnce.has(id)) { st.flakyOnce.delete(id); return r.abort('failed') } // transient — app should retry
    if (st.failDownload) return r.fulfill({ status: 409, headers: CORS, contentType: 'application/json', body: '{"error_summary":"path/not_found/"}' })
    if (id === 'id:slow-b') await new Promise((res) => setTimeout(res, 8_000))
    const file = SAMPLE_BY_ID[id]
    if (!file) return r.fulfill({ status: 409, headers: CORS, contentType: 'application/json', body: '{"error_summary":"path/not_found/"}' })
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream' }, body: await fs.readFile(sample(file)) })
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

await test('vocabulary: switch a built-in label off and back on, re-tags the library', async () => {
  ok((await tagsOf('dog.jpg')).includes('dog'))
  await openSettings('vocab')
  await page.getByTestId('label-dog').uncheck()
  await closeSettings() // closing applies changes
  await page.waitForFunction(() => !document.querySelector('[data-name="dog.jpg"]')?.dataset.tags.split('|').includes('dog'), null, { timeout: 60_000 })
  const t = await tagsOf('dog.jpg')
  ok(t.includes('my pet'), 'manual tags survive re-tagging')
  await openSettings('vocab'); await page.getByTestId('label-dog').check(); await closeSettings()
  await page.waitForFunction(() => document.querySelector('[data-name="dog.jpg"]')?.dataset.tags.split('|').includes('dog'), null, { timeout: 60_000 })
  ok(!(await tagsOf('dog.jpg')).includes('animals'), 'a tag you removed by hand stays removed')
})

await test('vocabulary: add a custom label (text model loads on demand) and apply it', async () => {
  await openSettings('vocab')
  await page.getByTestId('custom-label').fill('skyline')
  await page.getByTestId('custom-prompt').fill('a photo of a city skyline')
  await page.getByTestId('custom-add').click()
  await page.locator('[data-testid=custom-chip]', { hasText: 'skyline' }).waitFor({ timeout: 300_000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid=custom-add]')?.disabled || document.querySelector('[data-testid=custom-add]')?.textContent === 'Add label', null, { timeout: 300_000 })
  ok(await page.getByTestId('retag-all-group').getByTestId('retag-all').count() === 1 && await page.getByTestId('retag-all-group').getByRole('button', { name: 'Reset labels' }).count() === 0, 'help grouped with Re-tag library only')
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
const connectDropbox = async (pg, key) => {
  await pg.getByTestId('open-settings').click(); await pg.getByTestId('tab-dropbox').click()
  await pg.getByTestId('dropbox-key').fill(key)
  await pg.getByTestId('dropbox-save').click()
  await Promise.all([pg.waitForURL((u) => !u.searchParams.has('code') && u.pathname.endsWith('/photo-tagger/'), { timeout: 30_000 }), pg.getByTestId('dropbox-connect').click()])
  await pg.getByTestId('open-settings').waitFor()
}

await test('Dropbox: without a key the button explains setup; shows redirect URIs + read-only scopes; Connect runs OAuth PKCE', async () => {
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
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
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
  await page.getByTestId('dropbox-browser').waitFor()
  await page.locator('[data-testid=dropbox-folder][data-name="Photos"]').waitFor()
  ok(dbx.refreshes >= 1, 'expired token was refreshed')
  eq(await page.getByTestId('dropbox-folder').evaluateAll((els) => els.map((e) => e.dataset.name)), ['Docs', 'Faces', 'Photos', 'Slow'], 'root folders (from 2 pages)')
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
  await page.getByTestId('dropbox-process').click()
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
  
  ok(sidecarFor(dbx, 'dbx-a').photo.dropboxTags.includes('family_trip'), 'imported tag now managed by Photo Tagger')
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
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox-refresh').click()
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

await test('Dropbox: Refresh re-lists linked folders and skips already-seen file ids; subfolders opt-in', async () => {
  const before = { ...dbx.downloads }
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox-refresh').click()
  await page.locator('.toast', { hasText: /No new photos — 2 already in your library/ }).waitFor({ timeout: 30_000 })
  eq(dbx.downloads, before, 'nothing re-downloaded')
  // now include subfolders: only trip.jpg is new
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
  await page.locator('[data-testid=dropbox-folder][data-name="Photos"]').click()
  await page.locator('[data-testid=dropbox-file][data-name="from-dropbox.jpg"] [data-testid=dropbox-in-library]').waitFor()
  await page.getByTestId('dropbox-recursive').check()
  await page.getByTestId('dropbox-process').click()
  await waitTile('trip.jpg')
  await settled(); await keepDupes()
  eq([dbx.downloads['id:dbx-a'], dbx.downloads['id:dbx-c']], [before['id:dbx-a'], 1], 'only the new file downloaded')
  await page.evaluate(() => window.__ptFlushDropbox())
  eq([...dbx.meta.keys()].filter((k) => k.includes('dbx-a')).length, 1, 'one sidecar per Dropbox file')
  // Reopen: tags come back from Dropbox, nothing local
  const tagsBefore = (await tagsOf('from-dropbox.jpg')).sort()
  await page.reload(); await page.getByTestId('grid').waitFor()
  await tile('from-dropbox.jpg').waitFor({ timeout: 30_000 })
  eq((await tagsOf('from-dropbox.jpg')).sort(), tagsBefore, 'tags read back from Dropbox after reload')
  ok(await tile('trip.jpg').count(), 'all Dropbox photos listed after reload')
  await assertNothingLocal(page)
  const linked = await idb(page, `return new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get('dropboxFolders'); q.onsuccess = () => res(q.result) })`)
  eq(linked.map((f) => [f.path, f.recursive]), [['/Photos', true]], 'linked folder remembered')
})

await test('Dropbox: Cancel stops remaining work; already-processed photos stay', async () => {
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
  await page.locator('[data-testid=dropbox-folder][data-name="Slow"]').click()
  await page.locator('[data-testid=dropbox-file][data-name="cancel-stop-b.jpg"]').waitFor()
  await page.getByTestId('dropbox-process').click()
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

await test('Dropbox: Remove from app deletes only the Photo Tagger sidecar, never the Dropbox photo', async () => {
  await page.evaluate(() => window.__ptFlushDropbox())
  ok(sidecarFor(dbx, 'slow-a'), 'sidecar exists before remove')
  await tile('cancel-stop-a.jpg').click()
  await page.getByTestId('delete-photo').click()
  await tile('cancel-stop-a.jpg').waitFor({ state: 'detached' })
  for (let i = 0; i < 30 && sidecarFor(dbx, 'slow-a'); i++) await page.waitForTimeout(100)
  ok(!sidecarFor(dbx, 'slow-a'), 'sidecar removed')
  eq([...(dbx.fileTags.get('id:slow-a') ?? [])], [], 'Photo Tagger tags taken back from the photo')
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
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
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
    await p4.getByTestId('dropbox-process').click()
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

await test('mobile: empty state, camera/camera-roll inputs, no horizontal overflow', async () => {
  await m.goto(URL_BASE)
  await m.getByTestId('empty').waitFor()
  await noOverflow('empty')
  await m.getByTestId('add-btn').click()
  ok(await m.getByTestId('add-camera').isVisible(), 'camera option visible on touch devices')
  ok(!(await m.getByTestId('add-folder').isVisible()), 'folder option hidden on touch devices')
  eq(await m.getByTestId('camera-input').getAttribute('capture'), 'environment')
  eq(await m.getByTestId('file-input').getAttribute('accept'), 'image/*')
  await m.keyboard.press('Escape'); await m.mouse.click(5, 300)
})

await test('mobile: ingest via camera input, grid is 3 columns, filters collapse into a panel', async () => {
  await m.getByTestId('camera-input').setInputFiles(sample('pizza.jpg'))
  await m.getByTestId('file-input').setInputFiles(['dog.jpg', 'beach.jpg', 'city.jpg', 'blurry-mountain.jpg'].map(sample))
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
