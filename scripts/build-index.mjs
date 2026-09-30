// Builds dist/: one file per module plus index.json, and (unless --no-sign) index.json.sig.
// Env: MODULES_SIGNING_KEY (PKCS#8 PEM). The IRMS app verifies the exact bytes of index.json
// against index.json.sig with the public key in IRMS_App_Tauri/src-tauri/src/modules.rs, then
// checks each module file's SHA-256 before loading it.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const noSign = process.argv.includes('--no-sign')
const ID = /^[a-z][a-z0-9-]{1,40}$/
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist')

const modules = readdirSync('modules').sort().map((dir) => {
  const meta = JSON.parse(readFileSync(join('modules', dir, 'module.json'), 'utf8'))
  if (meta.id !== dir || !ID.test(meta.id)) throw new Error(`${dir}: id must equal folder name and match ${ID}`)
  if (!SEMVER.test(meta.version)) throw new Error(`${dir}: bad version ${meta.version}`)
  const code = readFileSync(join('modules', dir, 'index.js'))
  if (/\bimport\s*[({'"]|\bimport\s+[\w{*]/.test(code.toString())) throw new Error(`${dir}: modules must not import anything`)
  const file = `${meta.id}-${meta.version}.js`
  writeFileSync(join('dist', file), code)
  return {
    id: meta.id,
    version: meta.version,
    name: meta.name,
    description: meta.description ?? '',
    file,
    size: code.length,
    sha256: createHash('sha256').update(code).digest('hex'),
    ...(meta.minAppVersion ? { minAppVersion: meta.minAppVersion } : {})
  }
})

const bytes = Buffer.from(JSON.stringify({ schema: 1, modules }, null, 2) + '\n')
writeFileSync('dist/index.json', bytes)
if (!noSign) {
  const key = createPrivateKey(process.env.MODULES_SIGNING_KEY ?? '')
  const signature = sign(null, bytes, key)
  if (!verify(null, bytes, createPublicKey(key), signature)) throw new Error('self-verification failed')
  writeFileSync('dist/index.json.sig', signature.toString('base64') + '\n')
}
console.log(`${modules.length} module(s): ${modules.map((m) => `${m.id}@${m.version}`).join(', ')}${noSign ? ' (unsigned check)' : ''}`)
