import { loadConfig } from './config.js'
import { createApp } from './app.js'

try {
  const config = await loadConfig()
  const { app, db, notifier } = createApp(config)
  const server = app.listen(config.port, config.host, () => {
    console.log(`我们的厨房服务：http://${config.host}:${config.port}`)
    console.log(config.demo ? '本机演示：访客暗号「一起好好吃饭」；管理员密码 demo-chef-2026。' : '我们的厨房已启动。')
    if (!config.sendKey) console.log('微信通知尚未配置；订单仍会保存，后台可查看。')
  })
  const timer = setInterval(() => void notifier.tick(), 15000)
  timer.unref()
  void notifier.tick()
  const shutdown = () => {
    clearInterval(timer)
    server.close(() => { db.close(); process.exit(0) })
    setTimeout(() => process.exit(1), 12000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} catch (error) { console.error(error.message); process.exit(1) }
