// Builds dist/: one file per module plus index.json, and (unless --no-sign) index.json.sig.
// Env: MODULES_SIGNING_KEY (PKCS#8 PEM). The IRMS app verifies the exact bytes of index.json
// against index.json.sig with the public key in IRMS_App_Tauri/src-tauri/src/modules.rs, then
// checks each module file's SHA-256 before loading it.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
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

// Native content packs (consumed by IRMS_Core/src/modules.rs). Same rules as validate_entry there.
const RELEASES = 'https://github.com/yuhina0515/IRMS-Modules/releases'
const MAX_FILE_BYTES = 256 * 1024
const MAX_FILES = 8
const MAX_INDEX_BYTES = 128 * 1024
const MAX_TIPS = 20
const MAX_TIP_CHARS = 300
const NATIVE_ID = /^[a-z][a-z0-9-]{1,40}$/
const NATIVE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/
const INSTALLER_FILES = ['index.json', 'index.json.sig', 'meta.json', 'active.json']
// Only a tag push names the real release; branch and pull-request runs (GITHUB_REF_NAME such as
// 1/merge) validate against a placeholder tag.
const tag = process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME ? process.env.GITHUB_REF_NAME : 'v0.0.0-check'
if (!/^[A-Za-z0-9._-]{1,40}$/.test(tag) || tag.includes('..')) throw new Error(`release tag ${tag} is not accepted by the app`)

function checkFileName(owner, n) {
  const stem = n.split('.')[0].toUpperCase()
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(n) || n.startsWith('.') || n.endsWith('.') || n.includes('..') || RESERVED.test(stem)) {
    throw new Error(`${owner}: bad file name ${n}`)
  }
}

const native = existsSync('native') ? readdirSync('native').sort().map((dir) => {
  const meta = JSON.parse(readFileSync(join('native', dir, 'pack.json'), 'utf8'))
  if (meta.id !== dir || !NATIVE_ID.test(meta.id)) throw new Error(`native/${dir}: id must equal folder name and match ${NATIVE_ID}`)
  if (!NATIVE_VERSION.test(meta.version)) throw new Error(`native/${dir}: bad version ${meta.version}`)
  if (meta.kind !== 'content') throw new Error(`native/${dir}: kind must be "content"`)
  if (!Number.isInteger(meta.schemaVersion) || meta.schemaVersion < 1) throw new Error(`native/${dir}: bad schemaVersion`)
  if (meta.minApp !== undefined && !NATIVE_VERSION.test(meta.minApp)) throw new Error(`native/${dir}: bad minApp`)
  if (!meta.name?.trim() || meta.name.length > 80) throw new Error(`native/${dir}: bad name`)
  if (!Array.isArray(meta.files) || meta.files.length < 1 || meta.files.length > MAX_FILES) throw new Error(`native/${dir}: bad files list`)
  const seen = new Set()
  const digest = createHash('sha256')
  const files = meta.files.map((path) => {
    checkFileName(`native/${dir}`, path)
    if (INSTALLER_FILES.includes(path.toLowerCase()) || seen.has(path.toLowerCase())) throw new Error(`native/${dir}: reserved or duplicate path ${path}`)
    seen.add(path.toLowerCase())
    const data = readFileSync(join('native', dir, path))
    if (data.length === 0 || data.length > MAX_FILE_BYTES) throw new Error(`native/${dir}/${path}: size must be 1..${MAX_FILE_BYTES}`)
    const name = `${meta.id}-${meta.version}-${path}`
    checkFileName(`native/${dir}`, name)
    if (meta.id === 'session-tips' && path === 'tips.json') {
      const tips = JSON.parse(data.toString('utf8'))
      if (tips.schema_version !== 1 || !Array.isArray(tips.tips) || tips.tips.length < 1 || tips.tips.length > MAX_TIPS ||
        tips.tips.some((t) => typeof t !== 'string' || !t.trim() || [...t].length > MAX_TIP_CHARS)) {
        throw new Error(`native/${dir}/tips.json: invalid tips`)
      }
    }
    writeFileSync(join('dist', name), data)
    digest.update(data)
    return { name, path, size: data.length, sha256: createHash('sha256').update(data).digest('hex') }
  })
  return {
    id: meta.id,
    version: meta.version,
    name: meta.name,
    description: meta.description ?? '',
    kind: 'content',
    schemaVersion: meta.schemaVersion,
    ...(meta.minApp ? { minApp: meta.minApp } : {}),
    sha256: digest.digest('hex'),
    url: `${RELEASES}/download/${tag}/`,
    files
  }
}) : []

const bytes = Buffer.from(JSON.stringify({ schema: 1, modules, native }, null, 2) + '\n')
if (bytes.length > MAX_INDEX_BYTES) throw new Error('index.json exceeds the 128 KiB limit the app accepts')
writeFileSync('dist/index.json', bytes)
if (!noSign) {
  const key = createPrivateKey(process.env.MODULES_SIGNING_KEY ?? '')
  const signature = sign(null, bytes, key)
  if (!verify(null, bytes, createPublicKey(key), signature)) throw new Error('self-verification failed')
  writeFileSync('dist/index.json.sig', signature.toString('base64') + '\n')
}
console.log(`${modules.length} module(s): ${modules.map((m) => `${m.id}@${m.version}`).join(', ')}; ${native.length} native pack(s): ${native.map((m) => `${m.id}@${m.version}`).join(', ')}${noSign ? ' (unsigned check)' : ''}`)
