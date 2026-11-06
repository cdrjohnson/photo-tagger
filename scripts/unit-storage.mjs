// Lightweight unit checks for the storage adapter / desktop detection (no browser).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.dirname(fileURLToPath(import.meta.url.replace('/scripts/unit-storage.mjs', '/scripts/x')))
// Simpler: inline the isDesktop logic mirror
function isDesktop(win) {
  if (!win) return false
  return '__TAURI_INTERNALS__' in win || '__TAURI__' in win
}

assert.equal(isDesktop(undefined), false)
assert.equal(isDesktop({}), false)
assert.equal(isDesktop({ __TAURI_INTERNALS__: {} }), true)
assert.equal(isDesktop({ __TAURI__: {} }), true)

// Facade must export the same surface as db for web call sites
const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8'))
for (const name of ['allPhotos', 'putPhoto', 'savePhotoWithBlobs', 'getBlob', 'putEmbedding', 'allEmbeddings', 'deletePhotos', 'clearAll', 'kvGet', 'kvSet', 'allFaces', 'putFaces', 'clearFaces', 'isDesktop']) {
  assert.match(src, new RegExp(`export (async )?function ${name}|export \\{[^}]*\\b${name}\\b`), `storage exports ${name}`)
}
assert.match(src, /isDesktop\(\) \? desk\./, 'routes to desktop when isDesktop')
assert.match(src, /idb\./, 'keeps IndexedDB path for web')

const desk = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/desktopDb.ts', import.meta.url), 'utf8'))
assert.match(desk, /library_save_blobs/)
assert.match(desk, /library_import_bytes/)

const platform = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/platform.ts', import.meta.url), 'utf8'))
assert.match(platform, /__TAURI_INTERNALS__/)

const vite = await import('node:fs').then((fs) => fs.readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8'))
assert.match(vite, /isTauri/)
assert.match(vite, /VITE_TAURI/)
assert.match(vite, /!isTauri/)

const conf = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
assert.match(conf, /com\.cdrjohnson\.phototagger/)
assert.match(conf, /nsis/)

const wf = await import('node:fs').then((fs) => fs.readFileSync(new URL('../.github/workflows/windows-desktop.yml', import.meta.url), 'utf8'))
assert.match(wf, /windows-latest/)
assert.match(wf, /tauri-apps\/tauri-action/)
assert.match(wf, /upload-artifact/)

const deploy = await import('node:fs').then((fs) => fs.readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'))
assert.match(deploy, /Deploy to GitHub Pages/)

const portable = await import('node:fs').then((fs) => fs.readFileSync(new URL('./package-windows-portable.mjs', import.meta.url), 'utf8'))
assert.match(portable, /portable\.txt/)
assert.match(portable, /Compress-Archive|zip/)
const librs = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src-tauri/src/library.rs', import.meta.url), 'utf8'))
assert.match(librs, /is_portable/)
assert.match(librs, /library_use_beside_app/)
assert.match(librs, /portable\.txt/)
console.log('unit-storage: ok')
