import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { stdin, stdout } from 'node:process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { root, profileDir, readEnv, atomicWrite, envText, makeEnvironment, validateSSH, validateSite, command } from './launcher/core.js'
import { loadConfig } from '../server/config.js'
import { startLocal, stopLocal, managedProcess, openUrl, menuLock } from './launcher/local.js'
import { deployServer, remoteStatus, remoteProfile } from './launcher/remote.js'
import { checkPublic } from './check-public.js'

export function createConsole() {
  let hidden = false
  const output = new Writable({ write(chunk, encoding, done) { if (!hidden) stdout.write(chunk, encoding); done() } })
  output.isTTY = stdout.isTTY; output.columns = stdout.columns
  const rl = createInterface({ input: stdin, output, terminal: Boolean(stdin.isTTY) })
  const controller = new AbortController()
  rl.on('SIGINT', () => { controller.abort(); rl.close() })
  rl.on('close', () => controller.abort())
  return {
    async ask(label, fallback = '', secret = false) {
      stdout.write(label + (fallback && !secret ? ` [${fallback}]` : '') + '：')
      hidden = secret && Boolean(stdin.isTTY)
      let value
      try { value = await rl.question('', { signal: controller.signal }) }
      finally { if (hidden) stdout.write('\n'); hidden = false }
      if (value === ':back') throw new Error('已取消，配置未保存。')
      return value || fallback
    },
    close() { rl.close() },
  }
}
export async function configure(mode, io) {
  const directory = profileDir(mode)
  const file = path.join(directory, '.env')
  const before = await readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return undefined; throw e })
  const previous = await readEnv(file)
  console.log('输入 :back 返回菜单；已有配置留空保留。密码和暗语输入隐藏。')
  let site = {}, origin
  if (mode === 'server') {
    site = JSON.parse(await readFile(path.join(directory, 'site.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return '{}'; throw e }))
    site.host = await io.ask('SSH地址', site.host || '')
    site.port = Number(await io.ask('SSH端口', String(site.port || 22)))
    site.user = await io.ask('SSH用户（root或免密码sudo）', site.user || 'root')
    site.identity = await io.ask('私钥完整路径（留空使用SSH默认认证；-清空）', site.identity || '')
    if (site.identity === '-') site.identity = ''
    origin = await io.ask('网站来源（https://域名 或 https://公网IP）', previous.PUBLIC_ORIGIN || '')
    validateSite(origin)
    site.email = await io.ask('HTTPS证书联系邮箱', site.email || '')
    if (!site.email) throw new Error('证书联系邮箱必填。')
    validateSSH(site)
    console.log('将向Let’s Encrypt提交网站地址和联系邮箱以申请证书。条款：https://letsencrypt.org/repository/')
    site.terms = (await io.ask('同意证书服务条款？输入yes，其他返回', site.terms ? 'yes' : 'no')) === 'yes'
    if (!site.terms) throw new Error('未同意证书服务条款，未保存或部署。')
  }
  const password = await io.ask(previous.ADMIN_PASSWORD_HASH ? '新管理员密码（留空保留）' : '管理员密码（12–128位）', '', true)
  if (password && await io.ask('再次输入管理员密码', '', true) !== password) throw new Error('两次管理员密码不一致。')
  const question = await io.ask('访客问题', previous.GUEST_QUESTION || '我们的专属暗号是？')
  const answer = await io.ask(previous.GUEST_ANSWER_HASH ? '新访客暗语（留空保留）' : '访客暗语（4–128位）', '', true)
  if (answer && await io.ask('再次输入访客暗语', '', true) !== answer) throw new Error('两次访客暗语不一致。')
  const sendKey = await io.ask('Server酱SendKey（可留空；留空保留，-清空）', '', true)
  const port = mode === 'local' ? await io.ask('本机端口', previous.PORT || '3001') : '3001'
  const values = await makeEnvironment(mode, { password, answer, question, origin, port, sendKey: sendKey === '-' ? '' : sendKey || previous.SERVERCHAN_SENDKEY || '' }, previous)
  if (mode === 'local' && await managedProcess()) { await stopLocal(); console.log('已停止旧本机服务，下次开始会使用新配置。') }
  await atomicWrite(file, envText(values), before)
  if (mode === 'server') await atomicWrite(path.join(directory, 'site.json'), JSON.stringify(site, null, 2) + '\n')
  console.log('配置已保存，数据库与图片未清空。')
  return values
}
async function validProfile(mode) {
  try { await loadConfig(await readEnv(path.join(profileDir(mode), '.env'))); if (mode === 'server') await remoteProfile(); return true } catch { return false }
}
async function chooseMode(io) {
  const value = await io.ask('1 本机运行（本机数据库）  2 服务器运行（新服务器）  0 返回')
  return value === '1' ? 'local' : value === '2' ? 'server' : null
}
async function start(mode, io) {
  if (!await validProfile(mode)) await configure(mode, io)
  const url = mode === 'local' ? await startLocal() : await deployServer()
  console.log('厨房地址：' + url)
  await openUrl(url)
  if (mode === 'local') console.log('服务在后台运行。可在“运行管理”停止；退出启动器不会关闭服务。')
}
async function manage(io) {
  const choice = await io.ask('1 本机状态  2 打开本机网页  3 停止本机  4 本机日志  5 服务器状态  6 打开服务器网页  7 更新服务器  0 返回')
  if (choice === '1') { const state = await managedProcess(); console.log(state ? `本机服务运行中，端口${state.port}` : '本机服务未运行。') }
  if (choice === '2') { const state = await managedProcess(); if (!state) throw new Error('请先开始本机运行。'); await openUrl(`http://localhost:${state.port}/order/`) }
  if (choice === '3') console.log(await stopLocal() ? '本机服务已停止。' : '没有找到本启动器管理的服务，未停止其他程序。')
  if (choice === '4') for (const name of ['server.log', 'server.err.log']) console.log((await readFile(path.join(profileDir('local'), name), 'utf8').catch(() => '暂无日志')).split('\n').slice(-30).join('\n'))
  if (choice === '5') console.log(await remoteStatus())
  if (choice === '6') await openUrl((await remoteProfile()).env.PUBLIC_ORIGIN + '/order/')
  if (choice === '7') await start('server', io)
}
export async function main() {
  process.chdir(root)
  const release = await menuLock()
  const io = createConsole()
  try {
    if (process.argv.includes('--check')) { console.log(`发布检查通过：${await checkPublic()}个文件。`); return }
    if (process.argv.includes('--server')) { try { await start('server', io) } catch (error) { console.error(error.message) } }
    while (true) {
      console.log(String.raw`
   ___              _  ___ _       _
  / _ \ _   _ _ __ | |/ (_) |_ ___| |__   ___ _ __
 | | | | | | | '__|| ' /| | __/ __| '_ \ / _ \ '_ \
 | |_| | |_| | |   | . \| | || (__| | | |  __/ | | |
  \___/ \__,_|_|   |_|\_\_|\__\___|_| |_|\___|_| |_|
                  我们的厨房
  1. 开始       2. 重新配置       3. 运行管理
  4. 环境检查   0. 退出
`)
      const choice = await io.ask('主菜单选项')
      if (choice === '0') break
      try {
        if (choice === '1' || choice === '2') { const mode = await chooseMode(io); if (mode) await (choice === '1' ? start(mode, io) : configure(mode, io)) }
        else if (choice === '3') await manage(io)
        else if (choice === '4') {
          console.log('Node：' + process.version + '；项目目录：' + root)
          console.log('本机配置：' + await validProfile('local') + '；服务器配置：' + await validProfile('server'))
          console.log(`开源检查通过：${await checkPublic()}个发布文件。`)
        } else console.log('请选择菜单中的数字。')
      } catch (error) { if (error.name === 'AbortError') break; console.error(error.message) }
    }
  } finally { io.close(); await release() }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.name === 'AbortError' ? '已退出。' : error.message); process.exitCode = error.name === 'AbortError' ? 0 : 1 })
