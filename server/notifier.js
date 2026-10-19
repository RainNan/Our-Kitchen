// API endpoints follow https://github.com/easychen/serverchan-sdk (Turbo + SC3).
export function serverChanUrl(sendKey) {
  const match = /^sctp(\d+)t[a-zA-Z0-9]+$/.exec(sendKey)
  if (match) return `https://${match[1]}.push.ft07.com/send/${sendKey}.send`
  if (/^SCT[a-zA-Z0-9]+$/.test(sendKey)) return `https://sctapi.ftqq.com/${sendKey}.send`
  throw new Error('Invalid SendKey')
}
const plain = (text) => text.replace(/[\[\]()*_`<>!#\\]/g, '').replace(/[\r\n]+/g, ' ')
export function notificationText(order) {
  const date = new Date(order.created).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  const items = order.items.map(item => `- ${plain(item.name)} × ${item.quantity}\n  原料：${plain(item.ingredients || '') || '未填写'}\n  做法：${plain(item.instructions || '') || '未填写'}`).join('\n\n')
  return `有一份新的想吃清单，请查收。\n\n${items}\n\n口味：${order.preferences.map(plain).join('、') || '家常口味'}\n\n备注：${plain(order.note) || '没有额外备注'}\n\n时间：${date}\n\n订单：${order.id}`
}
export async function sendNotification(sendKey, order, fetcher = fetch) {
  const response = await fetcher(serverChanUrl(sendKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify({ title: '我们的厨房收到新的点菜清单', desp: notificationText(order), noip: 1 }),
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
  })
  if (!response.ok) throw new Error('notification rejected')
  const data = await response.json()
  if (data.code !== 0) throw new Error('notification rejected')
}

export function createNotifier(db, config, fetcher) {
  let busy = false
  async function tick() {
    if (busy || !config.sendKey) return
    busy = true
    try {
      db.prepare("UPDATE orders SET notification='failed' WHERE notification IN ('pending','retrying') AND attempts >= 5 AND next_retry <= ?").run(Date.now())
      const rows = db.prepare("SELECT * FROM orders WHERE notification IN ('pending','retrying') AND next_retry <= ? AND attempts < 5 ORDER BY created LIMIT 5").all(Date.now())
      for (const row of rows) {
        const attempts = row.attempts + 1
        // Persist the attempt before network I/O. Recoverable after process restart.
        db.prepare("UPDATE orders SET attempts=?, notification='retrying', next_retry=? WHERE id=?").run(attempts, Date.now() + 60000, row.id)
        try {
          await sendNotification(config.sendKey, { ...row, items: JSON.parse(row.items), preferences: JSON.parse(row.preferences) }, fetcher)
          db.prepare("UPDATE orders SET notification='sent' WHERE id=?").run(row.id)
        } catch {
          // Never log provider URLs/responses: they can contain the SendKey.
          db.prepare('UPDATE orders SET notification=?, next_retry=? WHERE id=?').run(attempts >= 5 ? 'failed' : 'retrying', Date.now() + Math.min(60000 * 2 ** (attempts - 1), 15 * 60000), row.id)
        }
      }
    } finally { busy = false }
  }
  return { tick }
}
