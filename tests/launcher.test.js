import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, cp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { parseEnv } from 'node:util'
import { root, makeEnvironment, envText, atomicWrite, sourceFiles, repositoryBoundary, validateSSH, validateSite, command, sourceRoots } from '../scripts/launcher/core.js'
import { verifySecret } from '../server/security.js'
import { checkPublic } from '../scripts/check-public.js'
import { sshArguments } from '../scripts/launcher/remote.js'

async function temporary(t, cleanup = true) {
  const folder = await mkdtemp(path.join(tmpdir(), 'our-kitchen 测试 '))
  if (cleanup) t.after(async () => { assert.equal(path.dirname(folder), path.resolve(tmpdir())); assert.ok(path.basename(folder).startsWith('our-kitchen ')); await rm(folder, { recursive: true, force: true }) })
  return folder
}
const input = { password: 'test-admin-long-enough', answer: 'guest-fixture', question: '今天吃什么？' }
test('local and server environments are isolated; reconfiguration preserves credentials and data path', async () => {
  const local = await makeEnvironment('local', input)
  const server = await makeEnvironment('server', { ...input, origin: 'https://kitchen.example.com' })
  assert.equal(local.PUBLIC_ORIGIN, 'http://localhost:3001')
  assert.equal(local.COOKIE_SECURE, 'false'); assert.equal(server.COOKIE_SECURE, 'true')
  assert.notEqual(local.DATA_DIR, server.DATA_DIR)
  assert.ok(await verifySecret(input.password, local.ADMIN_PASSWORD_HASH))
  assert.ok(await verifySecret(input.answer, local.GUEST_ANSWER_HASH))
  assert.ok(!envText(local).includes(input.password)); assert.ok(!envText(local).includes(input.answer))
  assert.deepEqual(parseEnv(envText(local)), local)
  const revised = await makeEnvironment('local', { port: '3019' }, local)
  for (const key of ['APP_SECRET', 'ADMIN_PASSWORD_HASH', 'GUEST_ANSWER_HASH', 'DATA_DIR']) assert.equal(local[key], revised[key])
  assert.equal(revised.PUBLIC_ORIGIN, 'http://localhost:3019')
  await assert.rejects(makeEnvironment('local', { ...input, password: 'short' }))
  await assert.rejects(makeEnvironment('local', { password: 'same-password-long', answer: 'same-password-long' }))
  await assert.rejects(makeEnvironment('local', { port: 'bad' }, local))
})
test('atomic configuration refuses stale edits and preserves previous file on failure', async t => {
  const folder = await temporary(t), file = path.join(folder, '.env')
  await atomicWrite(file, 'FIRST=1\n', undefined)
  await assert.rejects(atomicWrite(file, 'BAD=1', undefined))
  assert.equal(await readFile(file, 'utf8'), 'FIRST=1\n')
  await atomicWrite(file, 'SECOND=2\n', 'FIRST=1\n')
  assert.ok((await readdir(folder)).some(f => f.startsWith('.env.backup-')))
  await assert.rejects(atomicWrite(file, 'BAD=1', 'FIRST=1\n'))
  assert.equal(await readFile(file, 'utf8'), 'SECOND=2\n')
})
test('SSH and website input cannot become shell options or commands', () => {
  for (const host of ['-oProxyCommand=x', 'host;echo x', 'user@host', 'x y', 'https://example.com']) assert.throws(() => validateSSH({ host, user: 'root', port: 22 }))
  assert.throws(() => validateSSH({ host: 'example.com', user: 'root;id', port: 22 }))
  assert.throws(() => validateSSH({ host: 'example.com', user: 'root', port: 0 }))
  const args = sshArguments({ host: 'example.com', user: 'root', port: 2222 })
  assert.ok(args.includes('StrictHostKeyChecking=ask')); assert.ok(!args.includes('BatchMode=yes'))
  assert.equal(validateSite('https://kitchen.example.com'), 'kitchen.example.com')
  assert.equal(validateSite('https://203.0.113.9'), '203.0.113.9')
  for (const site of ['http://example.com', 'https://example.com/path', 'https://example.com:444', 'https://127.0.0.1', 'https://user:pass@example.com']) assert.throws(() => validateSite(site))
})
test('release whitelist excludes private profiles and rejects symlinks; source notice references remain valid', async t => {
  const files = await sourceFiles()
  for (const name of ['README.md', 'LICENSE', 'DESIGN.md', '.env.example', 'start.bat', 'package-lock.json']) assert.ok(files.includes(name))
  assert.ok(!files.some(f => /(^|[\\/])(?:\.local|node_modules|data-demo|dist|artifacts|test-results)(?:[\\/]|$)/.test(f)))
  assert.ok(!files.includes('.env')); assert.ok(!files.includes('.env.credentials'))
  assert.ok(files.includes(path.join('third_party','family-meal-order','LICENSE')))
  assert.ok((await readFile(path.join(root, 'README.md'), 'utf8')).includes('55a46cb0ee3cbf117f668aad58737294470f0fba'))
  assert.equal(await checkPublic(root, false), files.length)
  const folder = await temporary(t)
  await mkdir(path.join(folder,'src'))
  await writeFile(path.join(folder,'src','bad.js'), 'scrypt$' + 'a'.repeat(32) + '$' + 'b'.repeat(128))
  await assert.rejects(checkPublic(folder, false), /bad.js/)
  await mkdir(path.join(folder,'target'))
  await symlink(path.join(folder,'target'),path.join(folder,'src','link'),process.platform==='win32'?'junction':'dir')
  await assert.rejects(sourceFiles(folder), /符号链接/)
})
test('repository boundary refuses a parent Git repository and ignores runtime data in an independent fixture', async t => {
  try { await command('git',['--version'],{capture:true}) } catch { t.skip('Git not installed'); return }
  const parent = await temporary(t)
  await command('git', ['init','-q',parent], { capture:true })
  const project=path.join(parent,'project'); await mkdir(project)
  await assert.rejects(repositoryBoundary(project), /根目录|父目录/)
  await command('git', ['init','-q',project], { capture:true })
  await repositoryBoundary(project)
  await cp(path.join(root,'.gitignore'),path.join(project,'.gitignore'))
  for (const file of ['.env','.env.credentials','.local/server/.env','data/kitchen.sqlite','artifacts/menu.jpg','node_modules/vue/package.json','backup.key']) {
    const output=await command('git',['-C',project,'check-ignore','--no-index',file],{capture:true})
    assert.equal(output,file)
  }
  await assert.rejects(command('git',['-C',project,'check-ignore','--no-index','.env.example'],{capture:true}))
})

test('start.bat completes first-run local configuration, serves the app, reuses and stops its own process', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const folder = await temporary(t, false)
  for (const name of sourceRoots) { try { await cp(path.join(root,name),path.join(folder,name),{recursive:true}) } catch(e) { if(e.code!=='ENOENT') throw e } }
  await cp(path.join(root,'dist'),path.join(folder,'dist'),{recursive:true})
  await symlink(path.join(root,'node_modules'),path.join(folder,'node_modules'),'junction')
  await mkdir(path.join(folder,'.local'),{recursive:true})
  // Keep browser-opening as an observable boundary during automated tests.
  await writeFile(path.join(folder,'scripts/open-url.ps1'), 'param([string]$Url)\n$Url | Set-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) ".local/opened.txt")\n')
  const deps=createHash('sha256').update(await readFile(path.join(folder,'package-lock.json'))).update(process.version).digest('hex')
  await writeFile(path.join(folder,'.local/dependencies.txt'),deps)
  const build=createHash('sha256')
  for(const file of await sourceFiles(folder)){build.update(file);build.update(await readFile(path.join(folder,file)))}
  await writeFile(path.join(folder,'.local/build.txt'),build.digest('hex'))
  const server=net.createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve))
  const prompts=[['主菜单选项','1'],['0 返回','1'],['管理员密码（12–128位）','test-admin-fixture-long'],['再次输入管理员密码','test-admin-fixture-long'],['访客问题',''],['访客暗语（4–128位）','guest-fixture'],['再次输入访客暗语','guest-fixture'],['Server酱SendKey',''],['本机端口',String(port)],['主菜单选项','1'],['0 返回','1'],['主菜单选项','3'],['7 更新服务器','3'],['主菜单选项','0']]
  const child=spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`""${path.join(folder,'start.bat')}""`],{cwd:folder,env:{...process.env,OUR_KITCHEN_NO_PAUSE:'1'},windowsVerbatimArguments:true,windowsHide:true,stdio:['pipe','pipe','pipe']})
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8')
  let output='',cursor=0,offset=0,checked=false,pageCheck
  const completion=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)})
  child.stdout.on('data',chunk=>{output+=chunk;if(!checked&&output.includes('厨房地址：')){checked=true;pageCheck=fetch(`http://127.0.0.1:${port}/order/`).then(r=>r.text())}while(cursor<prompts.length){const at=output.indexOf(prompts[cursor][0],offset);if(at<0)break;offset=at+prompts[cursor][0].length;child.stdin.write(prompts[cursor++][1]+'\n')}})
  child.stderr.on('data',chunk=>{output+=chunk})
  t.after(async()=>{
    if (child.exitCode === null) child.kill()
    const state=await readFile(path.join(folder,'.local/local/process.json'),'utf8').then(JSON.parse).catch(()=>null)
    if(state) await command('powershell.exe',['-NoProfile','-File',path.join(folder,'scripts/process.ps1'),'-Action','stop','-ProcessId',String(state.pid),'-NodePath',state.node,'-Instance',state.instance],{capture:true}).catch(()=>{})
    assert.equal(path.dirname(folder), path.resolve(tmpdir())); await rm(folder,{recursive:true,force:true})
  })
  const timer=setTimeout(()=>child.kill(),45000)
  const code=await completion;clearTimeout(timer)
  assert.equal(code,0,output)
  assert.equal(cursor,prompts.length,output)
  assert.match(await pageCheck, /<title>我们的厨房<\/title>/)
  assert.ok(output.includes('本机服务已停止'),output)
  assert.equal(output.match(/厨房地址：/g)?.length,2,output)
  assert.ok((await readFile(path.join(folder,'.local/opened.txt'),'utf8')).includes(`localhost:${port}/order/`))
  const env=parseEnv(await readFile(path.join(folder,'.local/local/.env'),'utf8'))
  assert.ok(await verifySecret('guest-fixture',env.GUEST_ANSWER_HASH))
  assert.equal(env.DATA_DIR,'./.local/local/data')
  assert.ok(!output.includes('test-admin-fixture-long'));assert.ok(!output.includes('guest-fixture'))
})


test('Windows helper scripts parse without executing setup or elevation', { skip: process.platform !== 'win32' }, async t => {
  const folder=await temporary(t)
  const parser=path.join(folder,'parse.ps1')
  const scriptPath=path.join(root,'scripts').replaceAll("'","''")
  await writeFile(parser,`$failed=$false
Get-ChildItem -LiteralPath '${scriptPath}' -Filter *.ps1 -Recurse | ForEach-Object { $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$null,[ref]$errors) | Out-Null; if($errors) { $failed=$true; $errors | ForEach-Object { Write-Output $_.Message } } }
if($failed){exit 1}
`)
  await command('powershell.exe',['-NoProfile','-File',parser],{capture:true})
})

test('IP certificate adapter selects the certificate without SNI and leaves domain policy unchanged', async t => {
  try { await command(process.platform==='win32'?'python':'python3',['--version'],{capture:true}) } catch { t.skip('Python is only needed by the server adapter'); return }
  const folder=await temporary(t), file=path.join(folder,'caddy.json')
  const initial={apps:{http:{servers:{https:{tls_connection_policies:[{match:{sni:['203.0.113.9']},certificate_selection:{any_tag:['certificate']}}]},http:{listen:[':80']}}}}}
  await writeFile(file,JSON.stringify(initial))
  await command(process.platform==='win32'?'python':'python3',[path.join(root,'deploy/ip-config.py'),file,'203.0.113.9'],{capture:true})
  const result=JSON.parse(await readFile(file,'utf8'))
  assert.equal(result.apps.http.servers.https.tls_connection_policies[0].default_sni,'203.0.113.9')
  assert.equal('match' in result.apps.http.servers.https.tls_connection_policies[0],false)
  assert.deepEqual(result.apps.http.servers.https.tls_connection_policies[0].certificate_selection,{any_tag:['certificate']})
  const before=await readFile(file,'utf8')
  await command(process.platform==='win32'?'python':'python3',[path.join(root,'deploy/ip-config.py'),file,'kitchen.example.com'],{capture:true})
  assert.equal(await readFile(file,'utf8'),before)
})
