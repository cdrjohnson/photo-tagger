import sharp from 'sharp'
import fs from 'node:fs/promises'
const svg = await fs.readFile('public/favicon.svg')
const out = (n, s) => sharp(svg, { density: 384 }).resize(s, s).png().toFile(`public/${n}`)
await out('icon-192.png', 192)
await out('icon-512.png', 512)
await out('apple-touch-icon.png', 180)
// maskable: full-bleed background with the glyph inside the safe zone
const bg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#4f46e5"/></svg>')
const glyph = await sharp(svg, { density: 384 }).resize(300, 300).png().toBuffer()
await sharp(bg).composite([{ input: glyph, top: 106, left: 106 }]).png().toFile('public/icon-maskable-512.png')
console.log('icons written')
