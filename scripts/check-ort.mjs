// Validate the *built* runtime graph, not just that copy-ort ran. Tauri serves
// index.html for missing assets, so checking HTTP 200 alone is not sufficient.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { parse } from 'acorn'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = path.join(root, 'node_modules/onnxruntime-web/dist')
const dist = path.join(root, 'dist')
const visited = new Set()
const builtins = new Set(['module', 'worker_threads']) // Node-only branches in Emscripten
function walk(node, fn) {
  if (!node || typeof node !== 'object') return
  fn(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(v => walk(v, fn))
    else if (value && typeof value === 'object') walk(value, fn)
  }
}
async function check(file) {
  if (visited.has(file)) return
  visited.add(file)
  const body = await fs.readFile(path.join(dist, 'ort', file))
  assert(body.equals(await fs.readFile(path.join(source, file))), `${file}: must match installed ORT byte-for-byte (missing, corrupt, or HTML asset)`)
  if (file.endsWith('.wasm')) {
    assert.equal(body.subarray(0, 8).toString('hex'), '0061736d01000000', `${file}: invalid WASM header / HTML fallback`)
    return
  }
  const ast = parse(body.toString(), { ecmaVersion: 'latest', sourceType: 'module' })
  const deps = new Set()
  walk(ast, node => {
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type) && node.source) {
      assert.equal(node.source.type, 'Literal', `${file}: review new computed runtime import`)
      const spec = node.source.value
      if (!builtins.has(spec)) {
        assert.match(spec, /^\.\.?\//, `${file}: unexpected external dependency ${spec}`)
        deps.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)))
      }
    }
    // Emscripten's locateFile()/new URL() references to binary or sibling factories.
    if (node.type === 'Literal' && typeof node.value === 'string' && /ort-wasm[^/]*\.(?:wasm|mjs)$/.test(node.value)) {
      deps.add(path.posix.join(path.posix.dirname(file), node.value))
    }
  })
  for (const dep of deps) {
    assert(!dep.startsWith('../') && !path.isAbsolute(dep), `runtime escaped ort/: ${dep}`)
    await check(dep)
  }
}
await check('ort-wasm-simd-threaded.mjs')
await check('ort-wasm-simd-threaded.wasm')
// Do not prune WASM emitted by Vite from bundled runtime fallbacks. Every static
// WASM asset reference in either worker must resolve, even if normally overridden.
for (const file of await fs.readdir(path.join(dist, 'assets'))) {
  if (!/^worker-.*\.js$/.test(file)) continue
  const js = await fs.readFile(path.join(dist, 'assets', file), 'utf8')
  for (const [, ref] of js.matchAll(/["']([^"']*ort-wasm[^"']*\.wasm)["']/g)) {
    if (!ref.includes('-') || !/-[A-Za-z0-9_-]{8}\.wasm$/.test(ref)) continue // ignore locateFile basename
    const name = path.posix.basename(ref)
    const wasm = await fs.readFile(path.join(dist, 'assets', name))
    assert.equal(wasm.subarray(0, 4).toString('hex'), '0061736d', `${name}: invalid fallback WASM`)
  }
}
console.log(`ORT packaging graph verified: ${[...visited].join(', ')}; bundled WASM fallbacks present`)
