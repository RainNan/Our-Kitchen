import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { hashSecret, normalizeAnswer } from '../server/security.js'
const rl = createInterface({ input: stdin, output: stdout })
try {
  const mode = (await rl.question('类型（admin 或 guest）：')).trim()
  if (!['admin', 'guest'].includes(mode)) throw new Error('请选择 admin 或 guest。')
  const minimum = mode === 'admin' ? 12 : 4
  const raw = await rl.question(`输入新秘密（本机终端会显示，至少 ${minimum} 位）：`)
  const value = mode === 'guest' ? normalizeAnswer(raw) : raw
  if (value.length < minimum || value.length > 128) throw new Error(`长度必须在 ${minimum} 到 128 位之间。`)
  const confirm = await rl.question('再输入一次：')
  if ((mode === 'guest' ? normalizeAnswer(confirm) : confirm) !== value) throw new Error('两次输入不一致。')
  console.log(`${mode === 'admin' ? 'ADMIN_PASSWORD_HASH' : 'GUEST_ANSWER_HASH'}='${await hashSecret(value)}'`)
} catch (error) { console.error(error.message); process.exitCode = 1 } finally { rl.close() }
