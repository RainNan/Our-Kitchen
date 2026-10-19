import path from 'node:path'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isIP } from 'node:net'
import { root, profileDir, readEnv, validateSSH, validateSite, command, sourceFiles } from './core.js'
import { checkPublic } from '../check-public.js'
import { ensureBuild } from './local.js'
function sshTool(name) {
  const native = process.platform === 'win32' && path.join(process.env.WINDIR || 'C:/Windows', 'System32', 'OpenSSH', name + '.exe')
  return native && existsSync(native) ? native : name + (process.platform === 'win32' ? '.exe' : '')
}
export function sshArguments(profile, scp = false) {
  validateSSH(profile)
  return [scp ? '-P' : '-p', String(profile.port), '-o', 'StrictHostKeyChecking=ask', '-o', 'ConnectTimeout=15', ...(profile.identity ? ['-i', profile.identity, '-o', 'IdentitiesOnly=yes'] : [])]
}
export async function remoteProfile() {
  const profile = validateSSH(JSON.parse(await readFile(path.join(profileDir('server'), 'site.json'), 'utf8')))
  const env = await readEnv(path.join(profileDir('server'), '.env'))
  validateSite(env.PUBLIC_ORIGIN)
  return { profile, env }
}
export async function remoteStatus() {
  const { profile } = await remoteProfile()
  await command(sshTool('ssh'), [...sshArguments(profile), `${profile.user}@${profile.host}`, "systemctl is-active our-kitchen.service our-kitchen-caddy.service; if systemctl is-enabled --quiet our-kitchen-renew.timer; then echo 'IP certificate timer enabled'; else echo 'Domain renewal is managed by Caddy'; fi"])
  return '服务器状态检查完成。' 
}
export async function deployServer() {
  await command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/ensure-ssh.ps1')])
  await checkPublic()
  const { profile, env } = await remoteProfile()
  if (!profile.terms) throw new Error('请在重新配置中确认HTTPS证书服务条款。')
  await ensureBuild()
  console.log('运行发布前测试…'); await command(process.execPath, ['--test', '--test-concurrency=1', ...((await sourceFiles()).filter(f => /^tests[\\/].*\.test\.js$/.test(f)))])
  const id = randomUUID()
  const stage = '/tmp/our-kitchen-' + id
  const folder = path.join(profileDir('server'), 'staging-' + id)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const archive = path.join(folder, 'source.tar.gz'), list = path.join(folder, 'files.txt')
  const files = (await sourceFiles()).map(f => f.replaceAll('\\', '/'))
  if (files.some(f => /[\r\n]/.test(f))) throw new Error('发布文件名含换行。')
  await writeFile(list, files.join('\n') + '\n')
  const host = `${profile.user}@${profile.host}`
  const scpHost = `${profile.user}@${isIP(profile.host) === 6 ? '[' + profile.host + ']' : profile.host}`
  const ssh = text => command(sshTool('ssh'), [...sshArguments(profile), host, text])
  let staged = false
  try {
    await command('tar.exe', ['-czf', archive, '-T', list])
    console.log('连接服务器：首次连接请核对SSH主机指纹。')
    await ssh(`umask 077; mkdir '${stage}'`); staged = true
    const metadata = path.join(folder, 'site.json')
    await writeFile(metadata, JSON.stringify({ host: validateSite(env.PUBLIC_ORIGIN), email: profile.email, terms: profile.terms }), { mode: 0o600 })
    for (const [file, name] of [[archive, 'source.tar.gz'], [path.join(profileDir('server'), '.env'), 'app.env'], [metadata, 'site.json'], [path.join(root, 'deploy/remote.sh'), 'remote.sh']]) {
      await command(sshTool('scp'), [...sshArguments(profile, true), file, `${scpHost}:${stage}/${name}`])
    }
    await ssh(`if [ "$(id -u)" -eq 0 ]; then bash '${stage}/remote.sh' '${id}'; else sudo -n bash '${stage}/remote.sh' '${id}'; fi`)
    const response = await fetch(env.PUBLIC_ORIGIN + '/order/', { signal: AbortSignal.timeout(15000) })
    if (!response.ok || !(await response.text()).includes('/order/assets/')) throw new Error('外网HTTPS检查失败，请检查安全组、DNS和证书；未确认部署成功。')
    console.log('部署成功：' + env.PUBLIC_ORIGIN + '/order/')
    return env.PUBLIC_ORIGIN + '/order/'
  } finally {
    if (staged) await ssh(`case '${stage}' in /tmp/our-kitchen-${id}) rm -rf -- '${stage}' ;; esac`).catch(() => console.error('远端临时目录清理失败，请检查SSH连接。'))
    // Each generated staging path is confined to the selected profile.
    const { rm } = await import('node:fs/promises')
    if (path.dirname(folder) === profileDir('server') && path.basename(folder) === 'staging-' + id) await rm(folder, { recursive: true, force: true })
  }
}
