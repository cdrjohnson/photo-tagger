// Copies runtime assets next to the app so they are served from our own origin (no CDN) and can be
// cached for offline use: the ONNX Runtime wasm (CLIP) and the face-api models. Runs before dev/build.
import fs from 'node:fs/promises'
const copy = async (from, to, files) => {
  const src = new URL(from, import.meta.url), dst = new URL(to, import.meta.url)
  await fs.mkdir(dst, { recursive: true })
  for (const f of files) await fs.copyFile(new URL(f, src), new URL(f, dst))
}
await copy('../node_modules/onnxruntime-web/dist/', '../public/ort/', ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'])
const nets = ['ssd_mobilenetv1_model', 'face_landmark_68_model', 'face_recognition_model']
await copy('../node_modules/@vladmandic/face-api/model/', '../public/face-models/', nets.flatMap((n) => [`${n}-weights_manifest.json`, `${n}.bin`]))
console.log('copied ONNX Runtime wasm to public/ort and face models to public/face-models')
