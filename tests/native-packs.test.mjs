import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

test('native packs are built into dist with a consumer-valid index entry', () => {
  execFileSync('node', ['scripts/build-index.mjs', '--no-sign'], { env: { ...process.env, GITHUB_REF_NAME: 'v2026.11.22' } })
  const index = JSON.parse(readFileSync('dist/index.json', 'utf8'))
  assert.ok(Array.isArray(index.native) && index.native.length >= 1)
  for (const e of index.native) {
    assert.equal(e.kind, 'content')
    assert.equal(e.url, 'https://github.com/yuhina0515/IRMS-Modules/releases/download/v2026.11.22/')
    const all = createHash('sha256')
    for (const f of e.files) {
      assert.equal(f.name, `${e.id}-${e.version}-${f.path}`)
      assert.ok(existsSync(`dist/${f.name}`))
      const data = readFileSync(`dist/${f.name}`)
      assert.equal(data.length, f.size)
      assert.equal(createHash('sha256').update(data).digest('hex'), f.sha256)
      all.update(data)
    }
    assert.equal(all.digest('hex'), e.sha256)
  }
  const tips = JSON.parse(readFileSync('dist/session-tips-1.0.0-tips.json', 'utf8'))
  assert.equal(tips.tips.length, 3)
})
