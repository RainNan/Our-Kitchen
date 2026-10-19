import path from 'node:path'
import { isIP } from 'node:net'
import { hashSecret, token, validHash } from './security.js'

export async function loadConfig(env = process.env) {
  const demo = env.KITCHEN_DEMO === '1'
  const production = env.NODE_ENV === 'production'
  if (demo && production) throw new Error('演示模式禁止在生产环境启动。')
  const config = {
    demo, production,
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3001),
    origin: env.PUBLIC_ORIGIN || 'http://localhost:5173',
    secure: env.COOKIE_SECURE === 'true',
    secret: env.APP_SECRET || (demo ? token() : ''),
    adminHash: env.ADMIN_PASSWORD_HASH || (demo ? await hashSecret('demo-chef-2026') : ''),
    answerHash: env.GUEST_ANSWER_HASH || (demo ? await hashSecret('一起好好吃饭') : ''),
    question: env.GUEST_QUESTION || '我们的专属暗号是？',
    dataDir: path.resolve(env.DATA_DIR || (demo ? 'data-demo' : 'data')),
    sendKey: env.SERVERCHAN_SENDKEY || '',
    trustProxy: (env.TRUST_PROXY || '').split(',').map(x => x.trim()).filter(Boolean),
    frontendDir: path.resolve('dist'),
    demoAssets: path.resolve('seed-assets'),
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('PORT 必须是有效端口。')
  if (demo && !['127.0.0.1', '::1'].includes(config.host)) throw new Error('演示模式仅允许绑定本机。')
  if (config.secret.length < 32 || !validHash(config.adminHash) || !validHash(config.answerHash)) throw new Error('请先运行 npm run setup，设置独立管理员密码和访客暗号。')
  const origin = new URL(config.origin)
  if (origin.origin !== config.origin || !['http:', 'https:'].includes(origin.protocol)) throw new Error('PUBLIC_ORIGIN 必须是完整来源，如 https://kitchen.example.com。')
  if (production && (!config.secure || origin.protocol !== 'https:')) throw new Error('生产环境必须配置 HTTPS PUBLIC_ORIGIN 和 COOKIE_SECURE=true。')
  for (const proxy of config.trustProxy) {
    const [address, bits, extra] = proxy.split('/')
    const version = isIP(address)
    if (!version || extra || (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) > (version === 4 ? 32 : 128)))) throw new Error('TRUST_PROXY 仅支持明确的 IP/CIDR，禁止 true 或任意跳数。')
  }
  if (config.sendKey && !/^(SCT[a-zA-Z0-9]+|sctp\d+t[a-zA-Z0-9]+)$/.test(config.sendKey)) throw new Error('Server酱 SendKey 格式不正确。')
  return config
}
