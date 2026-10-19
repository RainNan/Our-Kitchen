import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { writeFile, readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { hashSecret, normalizeAnswer, token } from '../server/security.js'

let previousEnv
let existingSendKey = ''
try {
  previousEnv = await readFile('.env', 'utf8')
  const existing = parseEnv(previousEnv)
  if (Object.keys(existing).some(key => key !== 'SERVERCHAN_SENDKEY')) {
    console.error('.env 已有厨房配置。为保护现有密钥，本工具不会覆盖；请手动备份后再初始化。')
    process.exit(1)
  }
  existingSendKey = existing.SERVERCHAN_SENDKEY || ''
} catch (error) { if (error.code !== 'ENOENT') throw error }
const rl = createInterface({ input: stdin, output: stdout })
try {
  console.log('初始化私人厨房。输入会在当前终端显示；请在自己的设备上运行。')
  const password = await rl.question('管理员密码（至少 12 位，与访客暗号不同）：')
  const confirm = await rl.question('再次输入管理员密码：')
  if (password.length < 12 || password.length > 128 || password !== confirm) throw new Error('密码长度不足或两次不一致。')
  const question = (await rl.question('访客安全问题（回车使用「我们的专属暗号是？」）：')).trim() || '我们的专属暗号是？'
  const answer = normalizeAnswer(await rl.question('访客暗号（4–128 位，与管理员密码不同）：'))
  if (answer.length < 4 || answer.length > 128 || answer === normalizeAnswer(password)) throw new Error('访客暗号至少 4 位，且不能与管理员密码相同。')
  if (question.length > 80 || /[\r\n]/.test(question)) throw new Error('安全问题最长 80 字。')
  const origin = (await rl.question('网站来源（本机回车使用 http://localhost:5173；上线填写 https://你的域名）：')).trim() || 'http://localhost:5173'
  const url = new URL(origin)
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('网站来源格式不正确。')
  const production = url.protocol === 'https:'
  if (!production && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('公网网站必须使用 HTTPS。')
  const content = [
    `NODE_ENV=${production ? 'production' : 'development'}`, 'HOST=127.0.0.1', 'PORT=3001',
    `PUBLIC_ORIGIN=${origin}`, `COOKIE_SECURE=${production}`, `APP_SECRET=${token()}`,
    `ADMIN_PASSWORD_HASH='${await hashSecret(password)}'`, `GUEST_ANSWER_HASH='${await hashSecret(answer)}'`,
    `GUEST_QUESTION=${JSON.stringify(question)}`, 'DATA_DIR=./data', 'TRUST_PROXY=', `SERVERCHAN_SENDKEY=${existingSendKey}`, '',
  ].join('\n')
  if (previousEnv !== undefined && await readFile('.env', 'utf8') !== previousEnv) throw new Error('.env 在初始化过程中被修改，请重新运行。')
  await writeFile('.env', content, { flag: previousEnv === undefined ? 'wx' : 'w', mode: 0o600 })
  console.log('已生成 .env（密码与暗号只保存 scrypt 哈希）。本机使用 npm run dev；上线请阅读 README.md。')
} catch (error) { console.error(error.message); process.exitCode = 1 } finally { rl.close() }
