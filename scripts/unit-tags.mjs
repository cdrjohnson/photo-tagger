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
console.log('unit-tags: ok')
