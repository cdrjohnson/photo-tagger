// Unit check for tag matching (1.0.20): flexible match + reuse of an existing tag name
import { build } from 'esbuild'
const out = await build({ entryPoints: ['src/tags.ts'], bundle: true, format: 'esm', write: false, platform: 'neutral' })
const m = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('unit-tags FAIL:', msg, JSON.stringify(a), '!=', JSON.stringify(b)); process.exit(1) } }
eq(m.looseTagKey('Family Trip'), 'family_trip', 'loose key spaces')
eq(m.looseTagKey(' family-trip '), 'family_trip', 'loose key hyphen')
eq(m.resolveTagName('family trip', ['beach', 'family_trip']), 'family_trip', 'reuse existing underscore tag')
eq(m.resolveTagName('Family-Trip', ['family_trip']), 'family_trip', 'hyphen/case variant')
eq(m.resolveTagName('family trip', ['family trip', 'family_trip']), 'family trip', 'exact match wins')
eq(m.resolveTagName('Beach', ['beach']), 'beach', 'case')
eq(m.resolveTagName('sunset', ['beach']), 'sunset', 'new tag stays as typed')
const many = Array.from({ length: 80 }, (_, i) => 'tag' + String(i).padStart(2, '0')).concat(['wedding', 'zebra'])
eq(m.matchTags('zeb', many), ['zebra'], 'late-alphabet tag found')
eq(m.matchTags('', many).length, 82, 'empty query lists all (no 60 cap)')
eq(m.matchTags('family trip', ['family_trip', 'trip']), ['family_trip'], 'loose filter')

// 1.0.23: metadata toggles
const ph = { takenAt: Date.UTC(2021, 5, 1), dateSource: 'exif', camera: 'SampleCam X', gps: { lat: 1, lon: 2 }, quality: { blurry: true, dark: false, bright: true } }
eq(m.exifAndQualityTags(ph).map((t) => t.name), ['2021', 'samplecam x', 'geotagged', 'blurry', 'bright'], 'all on by default')
eq(m.exifAndQualityTags(ph, ['year', 'blurry']).map((t) => t.name), ['samplecam x', 'geotagged', 'bright'], 'disabled ones dropped')
const ap = m.applyMetaTags({ ...ph, tags: [{ name: '2021', source: 'exif' }, { name: 'jane', source: 'person' }, { name: 'beach', source: 'auto' }] }, ['year', 'camera'])
eq(ap.tags.map((t) => t.name), ['jane', 'beach', 'geotagged', 'blurry', 'bright'], 'applyMetaTags strips/re-applies only exif+quality')
// 1.0.25: actual read-back determines landed; missing tags on full files are cap-blocked.
const verification = await build({ entryPoints: ['src/tagVerification.ts'], bundle: true, format: 'esm', write: false, platform: 'neutral' })
const v = await import('data:text/javascript;base64,' + Buffer.from(verification.outputFiles[0].text).toString('base64'))
eq(v.compareDropboxTags(['jane', 'beach', 'beach'], ['jane', 'third_party']), { landed: ['jane'], missing: ['beach'], atCap: [] }, 'landed vs missing, other apps retained')
eq(v.compareDropboxTags(['jane', 'beach'], ['jane'], 20), { landed: ['jane'], missing: ['beach'], atCap: ['beach'] }, 'full native count caps missing only')
eq(v.compareDropboxTags([], Array.from({ length: 20 }, (_, i) => 'external_' + i)), { landed: [], missing: [], atCap: [] }, 'no desired tags is all good')
eq(v.compareDropboxTags(['beach'], ['beach']), { landed: ['beach'], missing: [], atCap: [] }, 'all landed')
if (!v.tagVerificationError(new Error('403 missing_scope')).includes('Full Dropbox')) throw new Error('scope hint missing')
// 1.0.26: Dropbox retry policy
const rb = await build({ entryPoints: ['src/dbxRetry.ts'], bundle: true, format: 'esm', write: false, platform: 'neutral' })
const r = await import('data:text/javascript;base64,' + Buffer.from(rb.outputFiles[0].text).toString('base64'))
const T = (status, message) => r.isTransientDropboxError({ status, message })
eq([T(429, 'too_many_requests'), T(500, 'x'), T(503, 'x'), T(0, 'Network error'), T(409, 'too_many_write_operations/')], [true, true, true, true, true], 'transient errors')
eq([T(403, 'missing_scope'), T(409, 'path/not_found/'), T(409, 'too_many_tags/'), T(400, 'bad'), T(401, 'invalid_access_token')], [false, false, false, false, false], 'permanent errors')
for (let a = 0; a < 20; a++) { const ms = r.backoffMs(a, 1000, 60000); if (ms < 500 || ms > 60000) throw new Error('backoff out of range ' + ms) }
if (!(r.backoffMs(10, 1000, 60000) >= 30000)) throw new Error('backoff grows to the cap')
// 1.0.28: normTag never leaves stray spaces; short camera tags; load repair; robust removeTag
const kodak = 'EASTMAN KODAK COMPANY KODAK CX7530 ZOOM DIGITAL CAMERA'
for (const x of [kodak, '  a  b  ', 'x'.repeat(39) + ' yz', 'Abcdefghij Abcdefghij Abcdefghij Abcdefgh ij']) {
  const n = m.normTag(x); eq([n === n.trim(), n.length <= 40, /\s\s/.test(n)], [true, true, false], 'normTag clean: ' + JSON.stringify(n))
}
eq(m.normTag(kodak), 'eastman kodak company kodak cx7530 zoom', 'Kodak name: cut then trimmed')
const cams = {
  [kodak]: 'kodak cx7530', 'Canon PowerShot SD1000': 'canon powershot sd1000', 'Canon Canon EOS 5D': 'canon eos 5d',
  'NIKON D70': 'nikon d70', 'NIKON CORPORATION NIKON D70': 'nikon d70', 'OLYMPUS IMAGING CORP. E-M5': 'olympus e-m5',
  'OLYMPUS OPTICAL CO.,LTD C2500L': 'olympus c2500l', 'iPhone 12': 'iphone 12', 'Apple iPhone 12 Pro Max': 'apple iphone 12 pro max',
  'SAMSUNG SM-G991B': 'samsung sm-g991b', 'Samsung Electronics Galaxy S21': 'samsung galaxy s21', 'Hewlett-Packard HP PhotoSmart 320': 'hp photosmart 320',
  'SampleCam X': 'samplecam x',
}
for (const [c, want] of Object.entries(cams)) { eq(m.cameraTag(c), want, 'camera ' + c); if (m.cameraTag(c).length > 32) throw new Error('camera tag too long') }
const longCam = m.cameraTag('Superlongbrandname Ultrazoom Professional Model Mark Seven Edition')
eq([longCam.length <= 32, longCam === longCam.trim(), /\s\S+$/.test(longCam) || !longCam.includes(' ')], [true, true, true], 'long camera cut at a word: ' + longCam)
const legacy = { camera: kodak, rejected: ['blurry '], dropboxRemoved: [], tags: [
  { name: 'eastman kodak company kodak cx7530 zoom ', source: 'exif' }, { name: 'beach ', source: 'auto', score: 0.4 }, { name: 'beach', source: 'manual' },
  { name: 'jane', source: 'person' }, { name: 'eastman kodak company kodak cx7530 zoom digital', source: 'manual' }] }
const fixed = m.repairPhotoTags(legacy)
eq(fixed.tags.map((t) => [t.name, t.source]), [['kodak cx7530', 'exif'], ['beach', 'manual'], ['jane', 'person'], ['eastman kodak company kodak cx7530 zoom', 'manual']], 'repair: trimmed, merged (manual wins), camera shortened, manual untouched apart from trim')
eq(fixed.rejected, ['blurry'], 'rejected trimmed')
const clean = { camera: 'NIKON D70', rejected: [], tags: [{ name: 'nikon d70', source: 'exif' }, { name: 'dog', source: 'auto', score: 0.5 }] }
if (m.repairPhotoTags(clean) !== clean) throw new Error('repair must return the same object when nothing changes')
const withSpace = { tags: [{ name: 'eastman kodak company kodak cx7530 zoom ', source: 'exif' }, { name: 'dog', source: 'auto' }], rejected: [] }
eq(m.removeTag(withSpace, 'eastman kodak company kodak cx7530 zoom').tags.map((t) => t.name), ['dog'], 'removeTag matches a trailing-space variant')
eq(m.removeTag(withSpace, 'dog').rejected, ['dog'], 'removed auto tag is rejected')
// 1.0.30: Dropbox dates + add order (time taken > modified > date in name; undated last; ties by path)
const dbxB = await build({ entryPoints: ['src/dropbox.ts'], bundle: true, format: 'esm', write: false, platform: 'browser', define: { 'import.meta.env': '{}' } })
const d = await import('data:text/javascript;base64,' + Buffer.from(dbxB.outputFiles[0].text).toString('base64'))
eq(d.dropboxFileDate({ name: 'a.jpg', takenAt: '2010-06-01T10:00:00Z', clientModified: '2024-01-01T00:00:00Z' }), Date.UTC(2010, 5, 1, 10), 'time taken wins')
eq(d.dropboxFileDate({ name: 'a.jpg', clientModified: '2024-01-01T00:00:00Z' }), Date.UTC(2024, 0, 1), 'else modified')
eq(d.dropboxFileDate({ name: 'IMG_2019-07-04_x.jpg' }), Date.UTC(2019, 6, 4), 'else date in name')
eq(d.dropboxFileDate({ name: 'x.jpg' }), 0, 'undated')
const f = (n, t) => ({ id: 'id:' + n, name: n, pathLower: '/' + n, clientModified: t })
const files = [f('c.jpg', '2020-01-01T00:00:00Z'), f('a.jpg', '2022-01-01T00:00:00Z'), f('z.jpg'), f('b.jpg', '2020-01-01T00:00:00Z'), { ...f('d.jpg', '2025-01-01T00:00:00Z'), takenAt: '2001-01-01T00:00:00Z' }]
eq(d.orderDropboxFiles(files, 'name').map((x) => x.name), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'z.jpg'], 'name order')
eq(d.orderDropboxFiles(files, 'oldest').map((x) => x.name), ['d.jpg', 'b.jpg', 'c.jpg', 'a.jpg', 'z.jpg'], 'oldest first, undated last, ties by path')
eq(d.orderDropboxFiles(files, 'newest').map((x) => x.name), ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'z.jpg'], 'newest first, undated last, ties by path')
eq(files.map((x) => x.name), ['c.jpg', 'a.jpg', 'z.jpg', 'b.jpg', 'd.jpg'], 'input not mutated')
console.log('unit-tags: ok')
