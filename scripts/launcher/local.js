import { readFile, writeFile, mkdir, unlink, open } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { randomUUID, createHash } from 'node:crypto'
import { root, localDir, profileDir, readEnv, command, npmCommand, fingerprint } from './core.js'

const ps = (...args) => command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/process.ps1'), ...args], { capture: true })
export async function managedProcess(action = 'inspect') {
  try {
    const state = JSON.parse(await readFile(path.join(profileDir('local'), 'process.json'), 'utf8'))
    if (!Number.isInteger(state.pid) || !/^[a-f0-9-]{36}$/.test(state.instance) || !path.isAbsolute(state.node)) return null
    await ps('-Action', action, '-ProcessId', String(state.pid), '-NodePath', state.node, '-Instance', state.instance)
    return state
  } catch { return null }
}
export async function ensureBuild() {
  await mkdir(localDir, { recursive: true })
  const lockHash = createHash('sha256').update(await readFile(path.join(root, 'package-lock.json'))).update(process.version).digest('hex')
  const depsFile = path.join(localDir, 'dependencies.txt')
  if (!existsSync(path.join(root, 'node_modules/vue')) || (await readFile(depsFile, 'utf8').catch(() => '')) !== lockHash) {
    console.log('安装项目依赖…')
    await npmCommand(['ci', '--no-audit', '--no-fund'])
    await writeFile(depsFile, lockHash)
  }
  const buildHash = await fingerprint()
  const buildFile = path.join(localDir, 'build.txt')
  if (!existsSync(path.join(root, 'dist/index.html')) || (await readFile(buildFile, 'utf8').catch(() => '')) !== buildHash) {
    console.log('构建网页…'); await npmCommand(['run', 'build']); await writeFile(buildFile, buildHash)
  }
}
export function portFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', () => reject(new Error(`端口${port}已被占用，请在重新配置中更换端口；不会停止其他程序。`)))
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}
export async function localReady(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/order/`, { signal: AbortSignal.timeout(1500) })
    return res.ok && (await res.text()).includes('/order/assets/')
  } catch { return false }
}
export async function startLocal() {
  const running = await managedProcess()
  if (running) {
    if (!await localReady(running.port)) throw new Error('本机服务进程存在但尚未就绪，请查看日志。')
    return `http://localhost:${running.port}/order/`
  }
  const env = await readEnv(path.join(profileDir('local'), '.env'))
  await portFree(Number(env.PORT))
  await ensureBuild()
  const instance = randomUUID()
  await ps('-Action', 'start', '-NodePath', process.execPath, '-Instance', instance)
  for (let i = 0; i < 40; i++) {
    if (await localReady(Number(env.PORT)) && (await managedProcess())?.instance === instance) return `http://localhost:${env.PORT}/order/`
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const runningAfterTimeout = await managedProcess()
  if (runningAfterTimeout?.instance === instance) await stopLocal()
  throw new Error('服务未能启动，请查看.local/local/server.err.log，确认配置或端口。')
}
export async function stopLocal() {
  const owned = await managedProcess('stop')
  if (owned) await unlink(path.join(profileDir('local'), 'process.json')).catch(() => {})
  return Boolean(owned)
}
export async function openUrl(url) {
  await command('powershell.exe', ['-NoProfile', '-File', path.join(root, 'scripts/open-url.ps1'), '-Url', url])
}
export async function menuLock() {
  await mkdir(localDir, { recursive: true })
  const file = path.join(localDir, 'menu.lock')
  let handle
  try { handle = await open(file, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const pid = Number(await readFile(file, 'utf8').catch(() => ''))
    let alive = false
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true } catch {} }
    if (alive) throw new Error('另一个启动器已经运行，请使用已有窗口。')
    await unlink(file); handle = await open(file, 'wx', 0o600)
  }
  await handle.writeFile(String(process.pid)); await handle.close()
  return () => unlink(file).catch(() => {})
}
