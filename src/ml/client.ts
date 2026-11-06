import { MODEL_ID } from '../labels'

export interface ModelProgress { phase: 'vision' | 'text'; loaded: number; total: number }
export type ModelState = 'idle' | 'loading' | 'ready' | 'error'

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

/** Thin promise wrapper around the CLIP web worker. */
export class MLClient {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private seq = 1
  private initPromise: Promise<void> | null = null
  state: ModelState = 'idle'
  error = ''
  onProgress: (p: ModelProgress) => void = () => {}
  onState: (s: ModelState) => void = () => {}

  private setState(s: ModelState) { this.state = s; this.onState(s) }

  private ensureWorker() {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev) => {
      const m = ev.data
      if (m.type === 'progress') { this.onProgress(m); return }
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.type === 'error') p.reject(new Error(m.message))
      else p.resolve(m)
    }
    w.onerror = (e) => {
      const err = new Error(e.message || 'worker error')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    }
    this.worker = w
    return w
  }

  private call<T = any>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = this.seq++
    const w = this.ensureWorker()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      w.postMessage({ ...msg, id }, transfer)
    })
  }

  /** ORT memoizes backend failures inside the worker; retry needs a fresh runtime. */
  resetFailed() {
    if (this.state !== 'error') return
    this.worker?.terminate()
    this.worker = null
    for (const p of this.pending.values()) p.reject(new Error('Tagging worker restarted'))
    this.pending.clear()
    this.initPromise = null
    this.error = ''
    this.setState('idle')
  }

  /** Load the vision model (downloads ~64 MB on first use, then served from the browser cache). */
  init(host: string): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.setState('loading')
    const base = new URL(import.meta.env.BASE_URL, document.baseURI).href
    this.initPromise = this.call({ type: 'init', modelId: MODEL_ID, host, base }).then(
      () => this.setState('ready'),
      (e) => { this.error = e.message; this.setState('error'); throw e },
    )
    return this.initPromise
  }

  async embedImage(rgb: Uint8ClampedArray, width: number, height: number): Promise<Float32Array> {
    const m = await this.call<{ embedding: Float32Array }>({ type: 'embed', width, height, rgb }, [rgb.buffer])
    return m.embedding
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    const m = await this.call<{ embeddings: Float32Array[] }>({ type: 'text', texts })
    return m.embeddings
  }
}

export const ml = new MLClient()
