/// <reference lib="webworker" />
// Face detection (SSD MobileNet v1) + 68-point landmarks + 128-d face descriptors (ResNet-34, dlib-derived)
// using @vladmandic/face-api (TensorFlow.js) in a worker. Models (~12 MB) are served from /face-models/.
import * as faceapi from '@vladmandic/face-api'

type Req =
  | { type: 'init'; id: number; base: string }
  | { type: 'detect'; id: number; bitmap: ImageBitmap; minConfidence: number }

let ready: Promise<string> | null = null

async function init(base: string) {
  // face-api expects a DOM-ish environment; give it OffscreenCanvas in the worker.
  faceapi.env.setEnv({
    Canvas: OffscreenCanvas,
    CanvasRenderingContext2D: OffscreenCanvasRenderingContext2D,
    Image: class {},
    ImageData,
    Video: class {},
    createCanvasElement: () => new OffscreenCanvas(1, 1),
    createImageElement: () => { throw new Error('no images in worker') },
    createVideoElement: () => { throw new Error('no video in worker') },
    fetch: (url: string, init?: RequestInit) => fetch(url, init),
    readFile: () => { throw new Error('readFile not available') },
  } as any)
  const tf = faceapi.tf as any
  let backend = 'cpu'
  for (const b of ['webgl', 'cpu']) {
    try { if (await tf.setBackend(b)) { await tf.ready(); backend = b; break } } catch { /* try next */ }
  }
  // Trailing slash so getModelUris joins cleanly; absolute base comes from the main thread.
  const uri = `${base}face-models/`
  // Fail fast with a clear message if the bundle is missing models (Tauri used to ship without copy-ort).
  const probe = new URL('ssd_mobilenetv1_model-weights_manifest.json', uri).href
  const res = await fetch(probe)
  const raw = await res.text()
  if (!res.ok) throw new Error(`Face models missing (${res.status}) at ${probe}`)
  const head = raw.trimStart().slice(0, 15).toLowerCase()
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    throw new Error(`Face models not packaged (got HTML instead of JSON from ${probe}). Reinstall the latest desktop build.`)
  }
  try { JSON.parse(raw) } catch { throw new Error(`Face model manifest is not JSON at ${probe}`) }
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri(uri),
    faceapi.nets.faceLandmark68Net.loadFromUri(uri),
    faceapi.nets.faceRecognitionNet.loadFromUri(uri),
  ])
  return backend
}

async function detect(r: Extract<Req, { type: 'detect' }>) {
  const tf = faceapi.tf as any
  const t = tf.tidy(() => tf.browser.fromPixels(r.bitmap).toFloat())
  const w = r.bitmap.width, h = r.bitmap.height
  r.bitmap.close()
  try {
    const res = await faceapi
      .detectAllFaces(t, new faceapi.SsdMobilenetv1Options({ minConfidence: r.minConfidence, maxResults: 30 }))
      .withFaceLandmarks()
      .withFaceDescriptors()
    return res
      .map((f) => {
        const b = f.detection.box
        return {
          box: { x: b.x / w, y: b.y / h, w: b.width / w, h: b.height / h },
          score: f.detection.score,
          descriptor: Float32Array.from(f.descriptor),
        }
      })
      // ignore tiny faces (unreliable descriptors)
      .filter((f) => f.box.w * w >= 36 && f.box.h * h >= 36)
  } finally {
    t.dispose()
  }
}

let chain: Promise<unknown> = Promise.resolve()
self.onmessage = (ev: MessageEvent<Req>) => {
  const r = ev.data
  chain = chain.then(async () => {
    try {
      if (r.type === 'init') {
        ready ??= init(r.base)
        postMessage({ type: 'result', id: r.id, backend: await ready })
      } else {
        await ready
        const faces = await detect(r)
        postMessage({ type: 'result', id: r.id, faces })
      }
    } catch (e: any) {
      if (r.type === 'init') ready = null
      postMessage({ type: 'error', id: r.id, message: String(e?.message ?? e) })
    }
  })
}
