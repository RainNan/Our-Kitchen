import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { loadConfig } from '../server/config.js'
import { createApp } from '../server/app.js'
import { root, profileDir } from './launcher/core.js'
process.chdir(root)
const instance = process.argv[process.argv.indexOf('--instance') + 1]
if (!/^[a-f0-9-]{36}$/.test(instance || '')) throw new Error('Invalid managed instance')
const directory = profileDir('local')
try {
  const config = await loadConfig(parseEnv(await readFile(path.join(directory, '.env'), 'utf8')))
  if (config.production || config.host !== '127.0.0.1') throw new Error('Invalid local profile')
  const { app, db, notifier } = createApp(config)
  const server = app.listen(config.port, config.host, async () => {
    await writeFile(path.join(directory, 'process.json'), JSON.stringify({ pid: process.pid, node: process.execPath, instance, port: config.port }), { mode: 0o600 })
    console.log(`我们的厨房已启动：http://localhost:${config.port}/order/`)
  })
  server.on('error', () => { console.error('启动失败：端口被占用或服务不可用。'); db.close(); process.exit(1) })
  const timer = setInterval(() => void notifier.tick(), 15000)
  timer.unref(); void notifier.tick()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); server.close(() => { db.close(); process.exit(0) }) })
} catch { console.error('启动失败：请检查本机配置，或重新配置后重试。'); process.exitCode = 1 }
