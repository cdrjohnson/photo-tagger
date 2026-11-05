// Takes the README / user-guide screenshots (desktop + mobile, light + dark) with real tagging.
// Run: npm run build && npm run screenshots
import { devices } from 'playwright'
import path from 'node:path'
import { launch, makeScreenshotSample, ROOT, routeModel, sample, startPreview, URL_BASE } from './testkit.mjs'

const OUT = path.join(ROOT, 'docs', 'images')
const FILES = ['dog.jpg', 'geotagged-cat.jpg', 'beach.jpg', 'city.jpg', 'pizza.jpg', 'mountain.jpg', 'person.jpg', 'document.jpg',
  'blurry-mountain.jpg', 'dark-city.jpg', 'bright-beach.jpg', 'cat.jpg', 'screenshot.png']
const srv = await startPreview()
const { browser, context } = await launch({ viewport: { width: 1440, height: 900 } })
await makeScreenshotSample(browser)
const shot = (p, name) => p.screenshot({ path: path.join(OUT, name) }).then(() => console.log('wrote', name))
const ready = (p, n) => p.waitForFunction((n) => document.querySelectorAll('[data-testid=photo-tile][data-status=ready]').length >= n, n, { timeout: 300_000 })
const idle = (p) => p.waitForFunction(() => !document.querySelector('[data-testid=banner]'), null, { timeout: 30_000 }).catch(() => {})

const FACES = ['biden-2013.jpg', 'biden-2021.jpg', 'biden-2009.jpg', 'obama-biden-2009.jpg', 'obama-portrait.jpg']
async function people(p, press) {
  await p.getByTestId('file-input').setInputFiles(FACES.map(sample))
  await ready(p, 18)
  await p.getByTestId('view-people').click()
  await p.waitForFunction(() => document.querySelectorAll('[data-testid=cluster]').length >= 3, null, { timeout: 300_000 })
  await p.waitForTimeout(8000) // let the last scan land
  for (let i = 0; i < 2; i++) { const cat = p.locator('[data-testid=cluster]', { has: p.locator('.pick[title*="cat"]') }).first(); if (await cat.count()) await press(cat, '[data-testid=face-ignore]') }
  const c = p.locator('[data-testid=cluster]', { has: p.locator('.pick[title="obama-portrait.jpg"]') })
  await c.getByTestId('cluster-name').fill('Barack Obama'); await press(c, '[data-testid=cluster-save]')
  const b = p.locator('[data-testid=cluster]', { has: p.locator('.pick[title="biden-2013.jpg"]') })
  await press(b, '.pick[title="biden-2013.jpg"]'); await press(b, '.pick[title="biden-2021.jpg"]')
  await b.getByTestId('cluster-name').fill('Joe Biden'); await press(b, '[data-testid=cluster-save]')
  await p.getByTestId('suggestion').first().waitFor(); await p.waitForTimeout(500)
}

// ---- desktop ----
const d = await context.newPage()
await d.goto(URL_BASE); await d.getByTestId('empty').waitFor()
await shot(d, 'desktop-empty.png')
await d.getByTestId('file-input').setInputFiles(FILES.map(sample))
await ready(d, 13); await idle(d)
await d.locator('[data-testid=tile-check]').first().hover()
await d.mouse.move(700, 880)
await shot(d, 'desktop-library.png')
await d.locator('[data-testid=tag-chip][data-tag="pets"]').click()
await shot(d, 'desktop-filtered.png')
await d.getByTestId('clear-filters').click()
await d.locator('[data-testid=photo-tile][data-name="geotagged-cat.jpg"]').click()
await d.getByTestId('detail-img').waitFor(); await d.waitForTimeout(300)
await shot(d, 'desktop-detail.png')
await d.keyboard.press('Escape')
await d.getByTestId('add-btn').click()
await shot(d, 'desktop-add-menu.png')
await d.getByTestId('add-btn').click()
await d.getByTestId('open-settings').click(); await d.getByTestId('tab-vocab').click(); await d.waitForTimeout(200)
await shot(d, 'desktop-labels.png')
await d.getByTestId('tab-dropbox').click(); await d.waitForTimeout(100)
await shot(d, 'desktop-dropbox.png')
await d.getByTestId('settings-close').click()
await d.getByTestId('select-mode').click()
for (const n of ['dog.jpg', 'cat.jpg']) await d.locator(`[data-testid=photo-tile][data-name="${n}"] [data-testid=tile-check]`).click()
await d.getByTestId('bulk-tag').click(); await d.getByTestId('bulk-input').fill('pets of 2026'); await d.getByTestId('bulk-input').press('Enter')
await d.waitForTimeout(200)
await shot(d, 'desktop-bulk.png')
await d.getByTestId('bulk-close').click(); await d.getByTestId('sel-cancel').click()
await people(d, (x, sel) => x.locator(sel).first().click())
await shot(d, 'desktop-people.png')
await d.getByTestId('view-photos').click()
await d.getByTestId('theme').click(); await d.getByTestId('theme').click() // auto -> light -> dark
await d.waitForTimeout(200)
await shot(d, 'desktop-dark.png')

// ---- mobile ----
const iphone = devices['iPhone 13']
const mctx = await browser.newContext({ viewport: iphone.viewport, userAgent: iphone.userAgent, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
await routeModel(mctx)
const m = await mctx.newPage()
await m.goto(URL_BASE); await m.getByTestId('empty').waitFor()
await shot(m, 'mobile-empty.png')
await m.getByTestId('file-input').setInputFiles(FILES.map(sample))
await ready(m, 13); await idle(m)
await shot(m, 'mobile-library.png')
await m.getByTestId('add-btn').tap(); await shot(m, 'mobile-add-menu.png'); await m.mouse.click(120, 20)
await m.locator('[data-testid=tag-chip][data-tag="cat"]').first().tap()
await m.getByTestId('more-filters').tap()
await shot(m, 'mobile-filters.png')
await m.getByTestId('clear-filters').tap(); await m.getByTestId('more-filters').tap()
await m.locator('[data-testid=photo-tile][data-name="geotagged-cat.jpg"]').tap()
await m.getByTestId('detail-img').waitFor(); await m.waitForTimeout(300)
await shot(m, 'mobile-detail.png')
await m.getByTestId('detail-close').tap()
await m.getByTestId('select-mode').tap()
await m.locator('[data-testid=photo-tile][data-name="dog.jpg"]').tap()
await m.locator('[data-testid=photo-tile][data-name="beach.jpg"]').tap()
await shot(m, 'mobile-select.png')
await m.getByTestId('sel-cancel').tap()
await people(m, (x, sel) => x.locator(sel).first().tap())
await m.evaluate(() => scrollTo(0, 0))
await shot(m, 'mobile-people.png')
await m.getByTestId('view-photos').tap()
await m.getByTestId('theme').tap(); await m.getByTestId('theme').tap()
await m.waitForTimeout(200)
await shot(m, 'mobile-dark.png')
await browser.close(); srv.kill()
