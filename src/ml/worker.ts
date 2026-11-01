/// <reference lib="webworker" />
// Runs CLIP (Transformers.js + ONNX Runtime Web, WebAssembly) off the main thread.
// Vision tower: used for every photo. Text tower: loaded lazily, only when you add custom labels.
import {
  env, AutoProcessor, AutoTokenizer, CLIPVisionModelWithProjection, CLIPTextModelWithProjection, RawImage,
} from '@huggingface/transformers'

type Req =
  | { type: 'init'; id: number; modelId: string; host: string; base: string }
  | { type: 'embed'; id: number; width: number; height: number; rgb: Uint8ClampedArray }
  | { type: 'text'; id: number; texts: string[] }

let modelId = ''
let processor: any, vision: any, tokenizer: any, textModel: any

const files = new Map<string, { loaded: number; total: number }>()
let phase = 'vision'
const progress = (e: any) => {
  if (e.status === 'progress' && e.file) {
    files.set(e.file, { loaded: e.loaded ?? 0, total: e.total ?? 0 })
    let l = 0, t = 0
    for (const v of files.values()) { l += v.loaded; t += v.total }
    postMessage({ type: 'progress', phase, loaded: l, total: t })
  } else if (e.status === 'done' && e.file) {
    const f = files.get(e.file)
    if (f) f.loaded = f.total
  }
}

const norm = (v: Float32Array) => {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

async function init(r: Extract<Req, { type: 'init' }>) {
  modelId = r.modelId
  env.allowLocalModels = false
  env.remoteHost = r.host.endsWith('/') ? r.host : r.host + '/'
  // Serve the ONNX Runtime wasm from our own origin (no CDN).
  const o = env.backends.onnx as any
  o.wasm.wasmPaths = { mjs: `${r.base}ort/ort-wasm-simd-threaded.mjs`, wasm: `${r.base}ort/ort-wasm-simd-threaded.wasm` }
  o.wasm.numThreads = 1
  if (vision) return
  phase = 'vision'
  processor = await AutoProcessor.from_pretrained(modelId, { progress_callback: progress })
  // q4: ~64 MB, closest to full-precision accuracy of the small quantisations, plain fp32 activations (safe on wasm)
  vision = await CLIPVisionModelWithProjection.from_pretrained(modelId, { dtype: 'q4', device: 'wasm', progress_callback: progress })
}

async function embed(r: Extract<Req, { type: 'embed' }>) {
  const img = new RawImage(r.rgb, r.width, r.height, 3)
  const inputs = await processor(img)
  const { image_embeds } = await vision(inputs)
  return norm(image_embeds.data as Float32Array)
}

async function text(r: Extract<Req, { type: 'text' }>) {
  if (!textModel) {
    phase = 'text'
    files.clear()
    tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback: progress })
    let err: unknown
    // q4f16 (~72 MB) first; plain q4 (~126 MB) if this browser can't run fp16 weights.
    for (const dtype of ['q4f16', 'q4'] as const) {
      try {
        textModel = await CLIPTextModelWithProjection.from_pretrained(modelId, { dtype, device: 'wasm', progress_callback: progress })
        const probe = await textModel(tokenizer(['a photo of a dog'], { padding: true, truncation: true }))
        if (!probe.text_embeds?.data?.every((x: number) => Number.isFinite(x))) throw new Error('bad output')
        err = undefined
        break
      } catch (e) { err = e; textModel = null }
    }
    if (!textModel) throw err
  }
  const out: Float32Array[] = []
  for (const t of r.texts) {
    const { text_embeds } = await textModel(tokenizer([t], { padding: true, truncation: true }))
    out.push(norm(text_embeds.data as Float32Array))
  }
  return out
}

let chain: Promise<unknown> = Promise.resolve()
self.onmessage = (ev: MessageEvent<Req>) => {
  const r = ev.data
  chain = chain.then(async () => {
    try {
      if (r.type === 'init') { await init(r); postMessage({ type: 'ready', id: r.id }) }
      else if (r.type === 'embed') {
        const e = await embed(r)
        postMessage({ type: 'result', id: r.id, embedding: e }, [e.buffer])
      } else if (r.type === 'text') {
        const es = await text(r)
        postMessage({ type: 'result', id: r.id, embeddings: es })
      }
    } catch (e: any) {
      postMessage({ type: 'error', id: r.id, message: String(e?.message ?? e) })
    }
  })
}
