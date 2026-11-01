// Precomputes CLIP text embeddings for the built-in label vocabulary so the app only needs the
// vision model (~89 MB) at runtime. Output: src/ml/labelEmbeddings.json
// Run: npm run labels:embed   (needs internet once, to fetch the text model from Hugging Face)
import fs from 'node:fs/promises'
import { env, AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers'
import { DEFAULT_LABELS, MODEL_ID } from '../src/labels.ts'

env.cacheDir = './.model-cache-node'
const tok = await AutoTokenizer.from_pretrained(MODEL_ID)
const model = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { dtype: process.env.TEXT_DTYPE || 'fp32' })

const norm = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n) }
async function embed(text) {
  const inputs = tok([text], { padding: true, truncation: true })
  const { text_embeds } = await model(inputs)
  return norm(Array.from(text_embeds.data))
}
const out = { model: MODEL_ID, dim: 512, labels: {} }
for (const l of DEFAULT_LABELS) {
  const vs = []
  for (const pr of l.prompts) vs.push(await embed(pr))
  const mean = vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length)
  const e = norm(mean)
  out.labels[l.id] = Buffer.from(new Float32Array(e).buffer).toString('base64')
}
await fs.writeFile('src/ml/labelEmbeddings.json', JSON.stringify(out))
console.log('wrote', Object.keys(out.labels).length, 'label embeddings')
