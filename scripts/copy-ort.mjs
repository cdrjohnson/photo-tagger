// Copies the ONNX Runtime WebAssembly files next to the app so the model runtime is served
// from your own origin (no CDN) and can be cached for offline use. Runs before dev/build.
import fs from 'node:fs/promises'
const src = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url)
const dst = new URL('../public/ort/', import.meta.url)
await fs.mkdir(dst, { recursive: true })
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await fs.copyFile(new URL(f, src), new URL(f, dst))
}
console.log('copied ONNX Runtime wasm to public/ort')
