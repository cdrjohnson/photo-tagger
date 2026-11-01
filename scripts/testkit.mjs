// Shared helpers for the e2e and screenshot scripts.
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

export const PORT = 4174
export const URL_BASE = `http://127.0.0.1:${PORT}/photo-tagger/`
export const ROOT = path.resolve(new URL('..', import.meta.url).pathname)
export const SAMPLES = path.join(ROOT, 'samples')
const CACHE = path.join(ROOT, '.model-cache')

export async function startPreview() {
  const p = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(URL_BASE)).ok) return p } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  p.kill(); throw new Error('preview server did not start (run npm run build first)')
}

/** Serve Hugging Face model files from a local disk cache (downloaded once through the browser, byte-for-byte). */
export async function routeModel(context, log = () => {}) {
  await fs.mkdir(CACHE, { recursive: true })
  await context.route('https://huggingface.co/**', async (route) => {
    const u = new URL(route.request().url())
    const file = path.join(CACHE, u.pathname.replace(/[^\w.-]/g, '_'))
    const cors = { 'access-control-allow-origin': '*' }
    try {
      const body = await fs.readFile(file)
      return route.fulfill({ status: 200, body, headers: { ...cors, 'content-type': 'application/octet-stream' } })
    } catch {}
    log('downloading', u.pathname)
    const res = await route.fetch({ timeout: 600_000 })
    const body = await res.body()
    if (res.status() === 200) await fs.writeFile(file, body)
    return route.fulfill({ status: res.status(), body, headers: { ...cors, 'content-type': res.headers()['content-type'] ?? 'application/octet-stream' } })
  })
}

export async function launch(opts = {}) {
  const browser = await chromium.launch()
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 860 }, ...opts })
  await routeModel(context)
  return { browser, context }
}

export const sample = (n) => path.join(SAMPLES, n)

/** Generates samples/screenshot.png: a screenshot of a made-up chat/settings UI, rendered by Chromium. */
export async function makeScreenshotSample(browser) {
  const out = path.join(SAMPLES, 'screenshot.png')
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  await page.setContent(`<body style="margin:0;font:16px system-ui;background:#f2f2f7">
    <div style="background:#fff;padding:14px 16px;font-weight:600;border-bottom:1px solid #ddd;display:flex;justify-content:space-between"><span>9:41</span><span>Settings</span><span>🔋 87%</span></div>
    ${['Wi-Fi', 'Bluetooth', 'Notifications', 'Sounds & Haptics', 'Focus', 'Screen Time', 'General', 'Control Center', 'Display & Brightness', 'Home Screen', 'Accessibility', 'Wallpaper', 'Siri & Search', 'Privacy & Security'].map((x) => `<div style="background:#fff;padding:16px;border-bottom:1px solid #eee;display:flex;justify-content:space-between"><span>${x}</span><span style="color:#999">›</span></div>`).join('')}
  </body>`)
  await page.screenshot({ path: out })
  await page.close()
  return out
}
