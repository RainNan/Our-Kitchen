import path from 'node:path'
import { readFile, writeFile, mkdir, rename, copyFile, realpath, readdir, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { spawn } from 'node:child_process'
import { hashSecret, normalizeAnswer, token, verifySecret } from '../../server/security.js'
import { loadConfig } from '../../server/config.js'

export const root = path.resolve(import.meta.dirname, '../..')
export const localDir = path.join(root, '.local')
export const profileDir = mode => {
  if (!['local', 'server'].includes(mode)) throw new Error('无效的运行方式。')
  return path.join(localDir, mode)
}
export async function readEnv(file) {
  try { return parseEnv(await readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return {}; throw error }
}
export function envText(values) {
  return Object.entries(values).map(([key, raw]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('配置键不正确。')
    const value = String(raw)
    if (/[\r\n\0]/.test(value)) throw new Error('配置不允许换行。')
    const quote = ['"', "'", '`'].find(q => !value.includes(q))
    if (!quote) throw new Error('配置内容不能同时包含三种引号。')
    return `${key}=${quote}${value}${quote}`
  }).join('\n') + '\n'
}
export async function atomicWrite(file, text, expected) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const current = await readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return undefined; throw e })
  if (arguments.length >= 3 && current !== expected) throw new Error('配置已被其他进程修改，请重新配置。')
  const temporary = file + '.next-' + randomUUID()
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
  try {
    if (current !== undefined) await copyFile(file, file + '.backup-' + randomUUID())
    await rename(temporary, file)
  } catch (error) { const { unlink } = await import('node:fs/promises'); await unlink(temporary).catch(() => {}); throw error }
}
export async function makeEnvironment(mode, input, previous = {}) {
  const password = input.password || ''
  const answer = input.answer ? normalizeAnswer(input.answer) : ''
  if ((!previous.ADMIN_PASSWORD_HASH || password) && (password.length < 12 || password.length > 128)) throw new Error('管理员密码需要12–128位。')
  if ((!previous.GUEST_ANSWER_HASH || answer) && (answer.length < 4 || answer.length > 128)) throw new Error('访客暗语需要4–128位。')
  const adminHash = password ? await hashSecret(password) : previous.ADMIN_PASSWORD_HASH
  const answerHash = answer ? await hashSecret(answer) : previous.GUEST_ANSWER_HASH
  if ((password && await verifySecret(normalizeAnswer(password), answerHash)) || (answer && await verifySecret(answer, adminHash))) throw new Error('管理员密码与访客暗语必须不同。')
  const question = (input.question ?? previous.GUEST_QUESTION ?? '我们的专属暗号是？').trim()
  if (!question || question.length > 80) throw new Error('访客问题需要1–80字。')
  const port = Number(input.port || previous.PORT || 3001)
  const origin = mode === 'local' ? `http://localhost:${port}` : input.origin || previous.PUBLIC_ORIGIN
  if (mode === 'server') validateSite(origin)
  const values = {
    NODE_ENV: mode === 'local' ? 'development' : 'production', HOST: '127.0.0.1', PORT: String(port),
    PUBLIC_ORIGIN: origin, COOKIE_SECURE: String(mode === 'server'), APP_SECRET: previous.APP_SECRET || token(),
    ADMIN_PASSWORD_HASH: adminHash, GUEST_ANSWER_HASH: answerHash, GUEST_QUESTION: question,
    DATA_DIR: mode === 'local' ? './.local/local/data' : '/var/lib/our-kitchen',
    TRUST_PROXY: '', SERVERCHAN_SENDKEY: input.sendKey ?? previous.SERVERCHAN_SENDKEY ?? '',
  }
  envText(values)
  await loadConfig(values)
  return values
}
export function validateSite(origin) {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin || url.port || url.username || url.password) throw new Error('服务器网站需为不带路径和端口的HTTPS域名或公网IP。')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!isIP(host) && !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(host)) throw new Error('网站域名或IP不正确。')
  if (host === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || host === '::1' || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^(fc|fd|fe80):/i.test(host)) throw new Error('服务器访问地址需要公网IP或域名。')
  return host
}
export function validateSSH(profile) {
  if (typeof profile.host !== 'string' || !(isIP(profile.host) || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(profile.host))) throw new Error('SSH地址不正确。')
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(profile.user)) throw new Error('SSH用户名不正确。')
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new Error('SSH端口不正确。')
  if (profile.identity && (!path.isAbsolute(profile.identity) || !existsSync(profile.identity))) throw new Error('私钥文件不存在，请填写完整路径。')
  if (profile.email && !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(profile.email)) throw new Error('证书联系邮箱不正确。')
  return profile
}
export function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, windowsHide: true, stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...options })
    let output = ''
    if (options.capture) { child.stdout.on('data', b => { output += b }); child.stderr.on('data', () => {}) }
    child.on('error', () => reject(new Error(`无法启动 ${path.basename(program)}，请检查安装与权限。`)))
    child.on('exit', code => setImmediate(() => {
      child.stdout?.destroy(); child.stderr?.destroy()
      if (code === 0) resolve(output.trim())
      else reject(new Error(`${path.basename(program)} 执行失败（${code}），请查看上方提示。`))
    }))
  })
}
export function npmCommand(args, options) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  if (!existsSync(cli)) throw new Error('Node安装缺少npm，请通过start.bat安装完整运行环境。')
  return command(process.execPath, [cli, ...args], options)
}
export const sourceRoots = ['package.json', 'package-lock.json', 'index.html', 'vite.config.js', 'src', 'server', 'public', 'scripts', 'deploy', 'tests', 'seed-assets', 'third_party', '.env.example', '.gitignore', '.dockerignore', 'DESIGN.md', 'README.md', 'LICENSE', 'Dockerfile', 'compose.yaml', 'start.bat', 'deploy.bat']
export async function sourceFiles(base = root) {
  const result = []
  async function visit(relative) {
    const info = await lstat(path.join(base, relative))
    if (info.isSymbolicLink()) throw new Error('发布文件包含符号链接，停止打包。')
    if (info.isDirectory()) {
      for (const name of (await readdir(path.join(base, relative))).sort()) {
        if (['originals', 'node_modules', '.git', '.local'].includes(name)) continue
        await visit(path.join(relative, name))
      }
    } else {
      if (/(^|[\\/])\.env(?!\.example$)|\.(?:key|pem|pfx|p12|sqlite|log|bak|backup)(?:$|[.-])/i.test(relative)) throw new Error('发布列表含私密或运行文件，停止打包。')
      result.push(relative)
    }
  }
  for (const item of sourceRoots) if (existsSync(path.join(base, item))) await visit(item)
  return result
}
export async function repositoryBoundary(base = root) {
  try {
    const gitRoot = await command('git', ['-C', base, 'rev-parse', '--show-toplevel'], { capture: true })
    if ((await realpath(gitRoot)).toLowerCase() !== (await realpath(base)).toLowerCase()) throw new Error('Git根目录不是项目目录。请把项目放入独立仓库；不会在父仓库中打包或提交。')
  } catch (error) {
    if (error.message.startsWith('Git根目录')) throw error
    // A ZIP download without Git is supported, but a parent .git must never be ignored.
    let parent = path.dirname(base)
    while (parent !== path.dirname(parent)) {
      if (existsSync(path.join(parent, '.git'))) throw new Error('检测到父目录Git仓库，请在项目目录建立独立仓库。')
      parent = path.dirname(parent)
    }
  }
}
export async function fingerprint() {
  const hash = createHash('sha256')
  for (const file of await sourceFiles()) { hash.update(file); hash.update(await readFile(path.join(root, file))) }
  return hash.digest('hex')
}
