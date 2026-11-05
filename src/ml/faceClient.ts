export interface DetectedFace { box: { x: number; y: number; w: number; h: number }; score: number; descriptor: Float32Array }

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

class FaceClient {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private seq = 1
  private initP: Promise<string> | null = null
  backend = ''

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./faceWorker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev) => {
        const p = this.pending.get(ev.data.id)
        if (!p) return
        this.pending.delete(ev.data.id)
        if (ev.data.type === 'error') p.reject(new Error(ev.data.message)); else p.resolve(ev.data)
      }
      this.worker.onerror = (e) => { for (const p of this.pending.values()) p.reject(new Error(e.message || 'face worker error')); this.pending.clear() }
    }
    const id = this.seq++
    return new Promise<T>((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker!.postMessage({ ...msg, id }, transfer) })
  }

  /** Loads the face models (~12 MB, cached by the browser / service worker after the first time). */
  init(): Promise<string> {
    if (!this.initP) {
      const base = new URL(import.meta.env.BASE_URL, document.baseURI).href
      this.initP = this.call<{ backend: string }>({ type: 'init', base }).then(
        (m) => (this.backend = m.backend),
        (e) => { this.initP = null; throw e },
      )
    }
    return this.initP
  }

  async detect(bitmap: ImageBitmap, minConfidence = 0.5): Promise<DetectedFace[]> {
    await this.init()
    const m = await this.call<{ faces: DetectedFace[] }>({ type: 'detect', bitmap, minConfidence }, [bitmap])
    return m.faces
  }
}

export const faces = new FaceClient()
