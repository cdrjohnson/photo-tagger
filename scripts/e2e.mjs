// End-to-end tests (Playwright + Chromium) against the production build served by `vite preview`.
// Real CLIP model, real sample photos (samples/), real IndexedDB. Hugging Face files are cached on disk after the first run.
// Run: npm run build && npm run test:e2e
import fs from 'node:fs/promises'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { devices } from 'playwright'
import { launch, makeScreenshotSample, ROOT, sample, startPreview, URL_BASE } from './testkit.mjs'

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

// Dropbox is stubbed: the Chooser script and the direct-link host are served locally.
await context.route('https://www.dropbox.com/static/api/2/dropins.js', (r) => r.fulfill({
  contentType: 'text/javascript',
  body: `window.__dbxKey = document.getElementById('dropboxjs').dataset.appKey;
         window.__dbxCancel = false;
         window.__dbxFiles = null;
         window.__dbxChooseCalls = 0;
         window.__dbxChooseStack = [];
         window.Dropbox = { choose(o){
           window.__dbxChooseCalls++;
           // Record that choose ran synchronously (same turn as the click handler)
           window.__dbxChooseStack.push('sync');
           // brief delay so the "Choose files…" banner is observable; cancel path resolves empty
           setTimeout(() => {
             if (window.__dbxCancel) { (o.cancel || (() => o.success([])))(); return }
             o.success(window.__dbxFiles || [
               { name: 'from-dropbox.jpg', link: 'https://dl.dropboxusercontent.com/s/test/from-dropbox.jpg', bytes: 1 },
               { name: 'from-dropbox-2.jpg', link: 'https://dl.dropboxusercontent.com/s/test/from-dropbox-2.jpg', bytes: 1 },
             ])
           }, 200)
         } }`,
}))
const dropboxFlaky = { n: 0 }
await context.route('https://dl.dropboxusercontent.com/**', async (r) => {
  const u = r.request().url()
  if (/flaky-retry/.test(u)) {
    dropboxFlaky.n++
    if (dropboxFlaky.n === 1) return r.abort('failed') // transient — app should retry
  }
  if (/from-dropbox-2|cancel-.*-b|stream-b|slow/.test(u)) await new Promise((res) => setTimeout(res, 8_000))
  let file = 'dropbox-import-a.jpg'
  if (u.includes('from-dropbox-2')) file = 'dropbox-import-b.jpg'
  else if (u.includes('cancel-keep-a')) file = 'dropbox-import-c.jpg'
  else if (u.includes('cancel-keep-b')) file = 'dropbox-import-d.jpg'
  else if (u.includes('cancel-stop-a')) file = 'dropbox-import-e.jpg'
  else if (u.includes('cancel-stop-b')) file = 'dropbox-import-f.jpg'
  else if (u.includes('stream-a')) file = 'dropbox-import-g.jpg'
  else if (u.includes('stream-b')) file = 'dropbox-import-h.jpg'
  else if (u.includes('flaky-retry')) file = 'dropbox-import-i.jpg'
  return r.fulfill({
    contentType: 'image/jpeg', headers: { 'access-control-allow-origin': '*' }, body: await fs.readFile(sample(file)),
  })
})

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
  const man = await (await fetch(URL_BASE + 'manifest.webmanifest')).json()
  eq(man.name, 'Photo Tagger'); eq(man.display, 'standalone')
  eq([man.start_url, man.scope], ['/photo-tagger/', '/photo-tagger/'], 'manifest start_url/scope')
  eq(await page.evaluate(() => navigator.serviceWorker.ready.then((r) => new URL(r.scope).pathname)), '/photo-tagger/', 'service worker scope')
  ok((await fetch(URL_BASE + 'ort/ort-wasm-simd-threaded.wasm')).ok && (await fetch(URL_BASE + 'ort/ort-wasm-simd-threaded.mjs')).ok, 'wasm under base')
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
  await page.getByTestId('retag-all').click()
  await settled()
  await page.waitForFunction(() => document.querySelector('[data-name="city.jpg"]')?.dataset.tags.split('|').includes('skyline'), null, { timeout: 120_000 })
  await closeSettings()
  await settled()
  ok((await tagsOf('city.jpg')).includes('skyline'), 'custom tag on city')
})

await test('Dropbox: without a key the button explains setup; with a key it imports via the Chooser', async () => {
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
  await page.getByTestId('settings-note').waitFor()
  eq(await page.getByTestId('origin').textContent(), '127.0.0.1', 'shows hostname (no https://) to whitelist')
  await page.getByTestId('dropbox-key').fill('test_app_key_123'); await page.getByTestId('dropbox-save').click()
  await closeSettings()
  await page.waitForFunction(() => window.__dbxKey === 'test_app_key_123')

  // Cancel path: waiting banner appears, then clears
  await page.evaluate(() => { window.__dbxCancel = true })
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
  await page.getByTestId('job-label').waitFor()
  ok(/Choose files in the Dropbox window/.test(await page.getByTestId('job-label').textContent()), 'waiting banner')
  await page.waitForFunction(() => !/Choose files in the Dropbox window/.test(document.querySelector('[data-testid=job-label]')?.textContent || ''), null, { timeout: 10_000 })
  ok(!/Choose files in the Dropbox window/.test((await page.getByTestId('job-label').textContent().catch(() => '')) || ''), 'waiting banner cleared on cancel')

  // Successful import: waiting → downloading → tagging banners
  await page.evaluate(() => { window.__dbxCancel = false })
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
  await page.getByTestId('job-label').waitFor()
  ok(/Choose files in the Dropbox window|Downloading from Dropbox|Processing /.test(await page.getByTestId('job-label').textContent()), 'progress banner during import')
  await page.waitForFunction(() => /Downloading from Dropbox|Processing /.test(document.querySelector('[data-testid=job-label]')?.textContent || ''), null, { timeout: 15_000 })
  // content may land in near-dupe review if it happens to match; keep any dropbox rows
  await Promise.race([
    tile('from-dropbox.jpg').waitFor({ timeout: 60_000 }),
    page.getByTestId('dupe-review').waitFor({ timeout: 60_000 }).then(async () => {
      while (await page.getByTestId('dupe-review').count()) {
        await page.getByTestId('dupe-keep-all').click()
        await page.waitForTimeout(200)
      }
      await tile('from-dropbox.jpg').waitFor({ timeout: 60_000 })
    }),
  ])
  await page.waitForFunction(() => document.querySelector('[data-name="from-dropbox.jpg"]')?.dataset.status === 'ready', null, { timeout: 120_000 })
  await tile('from-dropbox-2.jpg').waitFor({ timeout: 120_000 })
  await page.waitForFunction(() => document.querySelector('[data-name="from-dropbox-2.jpg"]')?.dataset.status === 'ready', null, { timeout: 180_000 })
  await settled()
  if (await page.getByTestId('dupe-review').count()) {
    await page.getByTestId('dupe-keep-all').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid=dupe-review]')).catch(() => {})
  }
  ok((await tagsOf('from-dropbox.jpg')).length > 0, 'tagged')
  await tile('from-dropbox.jpg').click()
  await page.getByText('Dropbox', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
})


await test('Dropbox: choose runs on the click turn without awaiting script load', async () => {
  // Preload must have completed after the key was saved in the previous test
  await page.waitForFunction(() => !!(window.Dropbox && window.Dropbox.choose), null, { timeout: 10_000 })
  const before = await page.evaluate(() => window.__dbxChooseCalls || 0)
  await page.evaluate(() => { window.__dbxCancel = true; window.__dbxChooseStack = [] })
  await page.getByTestId('add-btn').click()
  await page.getByTestId('add-dropbox').click()
  // choose() must have been invoked during the click handling (stack marker set synchronously)
  const after = await page.evaluate(() => ({ calls: window.__dbxChooseCalls || 0, stack: window.__dbxChooseStack || [] }))
  ok(after.calls === before + 1, 'Dropbox.choose called exactly once on click (before=' + before + ' after=' + after.calls + ')')
  ok(after.stack.includes('sync'), 'choose recorded as synchronous on the click turn')
  // Cancel path still clears the waiting banner
  await page.waitForFunction(() => !/Choose files in the Dropbox window/.test(document.querySelector('[data-testid=job-label]')?.textContent || ''), null, { timeout: 10_000 })
})

await test('Dropbox: streamed ingest — first file appears before the slow second finishes', async () => {
  await page.evaluate(() => {
    window.__dbxCancel = false
    window.__dbxFiles = [
      { name: 'stream-a.jpg', link: 'https://dl.dropboxusercontent.com/s/test/stream-a.jpg', bytes: 1 },
      { name: 'stream-b.jpg', link: 'https://dl.dropboxusercontent.com/s/test/stream-b.jpg', bytes: 1 },
    ]
  })
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
  await page.waitForFunction(() => /Downloading from Dropbox|Processing /.test(document.querySelector('[data-testid=job-label]')?.textContent || ''), null, { timeout: 15_000 })
  // First (fast) file must land while the slow second is still going
  await tile('stream-a.jpg').waitFor({ timeout: 60_000 })
  // Slow b is still downloading — a already in the library proves stream ingest (not download-all-then-add)
  ok(await tile('stream-a.jpg').count(), 'streamed: first photo in library before batch ends')
  eq(await tile('stream-b.jpg').count(), 0, 'second (slow) file not yet present when first lands')
  await tile('stream-b.jpg').waitFor({ timeout: 120_000 })
  await settled()
})

await test('Dropbox: Cancel confirm dismiss keeps downloading', async () => {
  await page.evaluate(() => {
    window.__dbxCancel = false
    window.__dbxFiles = [
      { name: 'cancel-keep-a.jpg', link: 'https://dl.dropboxusercontent.com/s/test/cancel-keep-a.jpg', bytes: 1 },
      { name: 'cancel-keep-b.jpg', link: 'https://dl.dropboxusercontent.com/s/test/cancel-keep-b.jpg', bytes: 1 },
    ]
  })
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
  await page.waitForFunction(() => /Downloading from Dropbox|Processing /.test(document.querySelector('[data-testid=job-label]')?.textContent || ''), null, { timeout: 15_000 })
  await page.getByTestId('job-cancel').click()
  await page.getByTestId('cancel-dropbox-confirm').waitFor()
  ok(/already added|library stay|Remaining downloads will stop/i.test(await page.getByTestId('cancel-dropbox-confirm').textContent()), 'explains cancel')
  await page.getByTestId('cancel-dropbox-keep').click()
  await page.getByTestId('cancel-dropbox-confirm').waitFor({ state: 'detached' })
  ok(await page.getByTestId('job-cancel').count(), 'still cancellable — download continues')
  await tile('cancel-keep-a.jpg').waitFor({ timeout: 120_000 })
  await tile('cancel-keep-b.jpg').waitFor({ timeout: 120_000 })
  await settled()
})

await test('Dropbox: Cancel download stops remaining; already-ingested stay', async () => {
  await page.evaluate(() => {
    window.__dbxCancel = false
    window.__dbxFiles = [
      { name: 'cancel-stop-a.jpg', link: 'https://dl.dropboxusercontent.com/s/test/cancel-stop-a.jpg', bytes: 1 },
      { name: 'cancel-stop-b.jpg', link: 'https://dl.dropboxusercontent.com/s/test/cancel-stop-b.jpg', bytes: 1 },
    ]
  })
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
  await page.waitForFunction(() => /Downloading from Dropbox|Processing /.test(document.querySelector('[data-testid=job-label]')?.textContent || ''), null, { timeout: 15_000 })
  // Wait until first file is in the library (streamed) — proves cancel keeps what arrived
  await tile('cancel-stop-a.jpg').waitFor({ timeout: 60_000 })
  await page.getByTestId('job-cancel').click()
  await page.getByTestId('cancel-dropbox-confirm').waitFor()
  await page.getByTestId('cancel-dropbox-confirm-btn').click()
  await page.getByTestId('cancel-dropbox-confirm').waitFor({ state: 'detached' })
  await page.waitForTimeout(2500)
  ok(await tile('cancel-stop-a.jpg').count(), 'already-ingested photo remains')
  eq(await tile('cancel-stop-b.jpg').count(), 0, 'aborted slow file not ingested')
})

await test('Dropbox: aborted fetch is retried; no per-file abort toast spam', async () => {
  dropboxFlaky.n = 0
  await page.evaluate(() => {
    window.__dbxCancel = false
    window.__dbxFiles = [
      { name: 'flaky-retry.jpg', link: 'https://dl.dropboxusercontent.com/s/test/flaky-retry.jpg', bytes: 1 },
    ]
  })
  const abortToasts = []
  page.on('console', () => {})
  await page.getByTestId('add-btn').click(); await page.getByTestId('add-dropbox').click()
  await tile('flaky-retry.jpg').waitFor({ timeout: 60_000 })
  await settled()
  ok(dropboxFlaky.n >= 2, 'retried after first abort (attempts=' + dropboxFlaky.n + ')')
  const toasts = await page.locator('.toast').allTextContents()
  ok(!toasts.some((t) => /operation was aborted/i.test(t)), 'no per-file abort toast: ' + toasts.join(' | '))
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
const { routeModel } = await import('./testkit.mjs')
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
