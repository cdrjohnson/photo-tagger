// Copies runtime assets next to the app so they are served from our own origin (no CDN) and can be
// cached for offline use: the ONNX Runtime wasm (CLIP) and the face-api models. Runs before dev/build
// (including Tauri's build:tauri / dev:tauri — without this, desktop ships index.html for /face-models/*).
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const copy = async (from, to, files) => {
  const src = path.resolve(here, from)
  const dst = path.resolve(here, to)
  await fs.mkdir(dst, { recursive: true })
  for (const f of files) {
    const s = path.join(src, f)
    const d = path.join(dst, f)
    await fs.copyFile(s, d)
    const st = await fs.stat(d)
    if (st.size < 100) throw new Error(`copied asset too small: ${d} (${st.size} bytes)`)
  }
}
await copy('../node_modules/onnxruntime-web/dist/', '../public/ort/', ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'])
const nets = ['ssd_mobilenetv1_model', 'face_landmark_68_model', 'face_recognition_model']
await copy('../node_modules/@vladmandic/face-api/model/', '../public/face-models/', nets.flatMap((n) => [`${n}-weights_manifest.json`, `${n}.bin`]))
// Sanity: manifests must be JSON (guards against a bad copy)
for (const n of nets) {
  const p = path.resolve(here, '../public/face-models', `${n}-weights_manifest.json`)
  const raw = await fs.readFile(p, 'utf8')
  if (raw.trimStart().toLowerCase().startsWith('<!doctype') || raw.trimStart().toLowerCase().startsWith('<html')) {
    throw new Error(`${p} looks like HTML, not a weights manifest`)
  }
  JSON.parse(raw)
}
console.log('copied ONNX Runtime wasm to public/ort and face models to public/face-models')
