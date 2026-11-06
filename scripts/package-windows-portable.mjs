#!/usr/bin/env node
/**
 * Pack a portable Windows zip from a finished `tauri build`.
 * Layout:
 *   Photo Tagger.exe
 *   portable.txt          (enables config-beside-exe)
 *   README-portable.txt
 *   library/              (empty starter library folder)
 *   data/                 (created at runtime for settings)
 *   + any sibling .dll next to the release binary
 *
 * Output: src-tauri/target/release/bundle/portable/Photo.Tagger_<ver>_x64_portable.zip
 * (also copied beside NSIS artifacts so release globs can pick it up)
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version || '1.0.0'
const productName = 'Photo Tagger'
const cargoExe = 'photo-tagger.exe' // Cargo package name
const releaseDir = path.join(root, 'src-tauri', 'target', 'release')
const exeSrc = path.join(releaseDir, cargoExe)

if (!fs.existsSync(exeSrc)) {
  console.error(`[portable] missing ${exeSrc} — run tauri build first`)
  process.exit(1)
}

const stagingRoot = path.join(releaseDir, 'portable-staging')
const folderName = `Photo.Tagger_${version}_x64_portable`
const staging = path.join(stagingRoot, folderName)
fs.rmSync(stagingRoot, { recursive: true, force: true })
fs.mkdirSync(staging, { recursive: true })
fs.mkdirSync(path.join(staging, 'library'), { recursive: true })
fs.mkdirSync(path.join(staging, 'data'), { recursive: true })

fs.copyFileSync(exeSrc, path.join(staging, `${productName}.exe`))

// Sibling DLLs (WebView2Loader etc. if present)
for (const name of fs.readdirSync(releaseDir)) {
  if (name.toLowerCase().endsWith('.dll')) {
    fs.copyFileSync(path.join(releaseDir, name), path.join(staging, name))
  }
}

// resources/ if the bundle created one beside the exe
const res = path.join(releaseDir, 'resources')
if (fs.existsSync(res)) {
  fs.cpSync(res, path.join(staging, 'resources'), { recursive: true })
}

fs.writeFileSync(path.join(staging, 'portable.txt'), 'Photo Tagger portable mode\n', 'utf8')
fs.writeFileSync(
  path.join(staging, 'README-portable.txt'),
  `${productName} — portable Windows build
=====================================

Unzip this folder anywhere (USB drive, Documents, Desktop) and run
"${productName}.exe". No installer and no admin rights required.

Requirements
- Windows 10 or 11 with Microsoft Edge WebView2 Runtime
  (built into Windows 11 and most Windows 10 PCs).
- Unsigned builds may show SmartScreen: More info → Run anyway.

Portable behaviour
- A portable.txt marker tells the app to keep settings in the data/
  folder beside this executable (not only in %APPDATA%).
- An empty library/ folder is included. On first launch you can click
  "Use folder next to the app" to use it, or choose any other folder.
- Original photos you add are copied into your library folder; tags,
  thumbnails and faces live under library/.photo-tagger/.

Upgrading
- Download a newer portable zip and replace this folder (keep your
  library/ and data/ if you want to preserve settings and photos).

Installer alternative
- A classic NSIS/MSI installer is also published on the same GitHub
  Release if you prefer a normal install.
`,
  'utf8',
)

const outDir = path.join(releaseDir, 'bundle', 'portable')
fs.mkdirSync(outDir, { recursive: true })
const zipPath = path.join(outDir, `${folderName}.zip`)
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath)

const isWin = process.platform === 'win32'
let status
if (isWin) {
  // Compress contents so unzipping yields the folder with the exe at the top level of the named folder
  const ps = `Compress-Archive -Path '${staging.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
  status = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' }).status
} else {
  status = spawnSync('zip', ['-r', zipPath, folderName], { cwd: stagingRoot, stdio: 'inherit' }).status
  if (status !== 0) {
    // fallback: tar.gz if zip missing (CI Windows uses powershell)
    const tar = path.join(outDir, `${folderName}.tar.gz`)
    status = spawnSync('tar', ['-czf', tar, folderName], { cwd: stagingRoot, stdio: 'inherit' }).status
    if (status === 0) {
      console.log(`[portable] wrote ${tar} (zip unavailable on this host)`)
      process.exit(0)
    }
  }
}

if (status !== 0) {
  console.error('[portable] compress failed')
  process.exit(status || 1)
}

// Also copy next to nsis so some release globs find it
const nsisDir = path.join(releaseDir, 'bundle', 'nsis')
if (fs.existsSync(nsisDir)) {
  fs.copyFileSync(zipPath, path.join(nsisDir, path.basename(zipPath)))
}

const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)
console.log(`[portable] wrote ${zipPath} (${mb} MB)`)
