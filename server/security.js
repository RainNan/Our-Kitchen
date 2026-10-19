import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const options = { N: 65536, r: 8, p: 2, maxmem: 128 * 1024 * 1024 }
export const token = () => randomBytes(32).toString('hex')
export const digest = (value) => createHash('sha256').update(value).digest('hex')
export const normalizeAnswer = (value) => value.normalize('NFKC').trim().toLowerCase()

export async function hashSecret(value) {
  const salt = randomBytes(16).toString('hex')
  return `scrypt$${salt}$${(await scrypt(value, salt, 64, options)).toString('hex')}`
}
export function validHash(value) {
  return /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value || '')
}
export async function verifySecret(value, stored) {
  if (!validHash(stored)) return false
  const [, salt, expected] = stored.split('$')
  return timingSafeEqual(await scrypt(value, salt, 64, options), Buffer.from(expected, 'hex'))
}
export const sameToken = (a, b) => typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

// SQLite-backed fixed windows survive application restarts. Separate global and session budgets.
export function consumeLimit(db, key, limit, windowMs, now = Date.now()) {
  const window = Math.floor(now / windowMs)
  const row = db.prepare('SELECT * FROM rate_limits WHERE key = ?').get(key)
  if (row && row.window === window && row.count >= limit) throw new HttpError(429, '尝试太频繁，请稍后再试。')
  db.prepare(`INSERT INTO rate_limits(key, window, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END, window = excluded.window`).run(key, window)
}
