import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { validHash } from '../server/security.js'

test('initialization preserves a preconfigured SendKey and refuses to overwrite existing credentials', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'kitchen-setup-test-'))
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('kitchen-setup-test-'))
    rmSync(directory, { recursive: true, force: true })
  })
  writeFileSync(path.join(directory, '.env'), 'SERVERCHAN_SENDKEY=SCTtestfixture\n')
  const script = path.resolve('scripts/setup.js')
  const prompts = [
    ['管理员密码（至少 12 位，与访客暗号不同）：', 'test-admin-password-long'],
    ['再次输入管理员密码：', 'test-admin-password-long'],
    ['访客安全问题（回车使用「我们的专属暗号是？」）：', ''],
    ['访客暗号（4–128 位，与管理员密码不同）：', 'test'],
    ['网站来源（本机回车使用 http://localhost:5173；上线填写 https://你的域名）：', 'https://kitchen.example.com'],
  ]
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', cursor = 0
    const timeout = setTimeout(() => { child.kill(); reject(new Error('setup timeout')) }, 15000)
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      while (cursor < prompts.length && output.includes(prompts[cursor][0])) child.stdin.write(prompts[cursor++][1] + '\n')
    })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  assert.equal((await run()).code, 0)
  const content = readFileSync(path.join(directory, '.env'), 'utf8')
  const config = parseEnv(content)
  assert.equal(config.SERVERCHAN_SENDKEY, 'SCTtestfixture')
  assert.equal(config.NODE_ENV, 'production')
  assert.equal(config.PUBLIC_ORIGIN, 'https://kitchen.example.com')
  assert.ok(validHash(config.ADMIN_PASSWORD_HASH))
  assert.ok(validHash(config.GUEST_ANSWER_HASH))
  assert.ok(config.APP_SECRET.length >= 32)
  assert.equal((await run()).code, 1)
  assert.equal(readFileSync(path.join(directory, '.env'), 'utf8'), content)
})
