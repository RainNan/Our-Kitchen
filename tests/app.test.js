import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import request from 'supertest'
import sharp from 'sharp'
import { createApp } from '../server/app.js'
import { loadConfig } from '../server/config.js'
import { hashSecret, normalizeAnswer } from '../server/security.js'
import { serverChanUrl, sendNotification, notificationText } from '../server/notifier.js'

const origin = 'http://localhost:5173'
let base
before(async () => {
  base = {
    demo: false, production: false, host: '127.0.0.1', port: 3001, origin, secure: false,
    secret: 'test-secret-'.repeat(5), adminHash: await hashSecret('test-admin-very-strong'),
    answerHash: await hashSecret(normalizeAnswer('our-secret-answer')), question: '暗号？',
    sendKey: '', trustProxy: [], frontendDir: path.resolve('dist'), demoAssets: path.resolve('seed-assets'),
  }
})
function fixture(t, overrides = {}, options = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'kitchen-test-'))
  const config = { ...base, dataDir, ...overrides }
  const context = createApp(config, options)
  t.after(() => {
    if (context.db.isOpen) context.db.close()
    assert.equal(path.dirname(dataDir), path.resolve(tmpdir()))
    assert.ok(path.basename(dataDir).startsWith('kitchen-test-'))
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { ...context, config }
}
async function client(app, role = 'guest', ip) {
  const agent = request.agent(app)
  let res = await agent.get('/order/api/session').set(ip ? { 'X-Forwarded-For': ip } : {})
  let csrf = res.body.csrf
  if (role !== 'anonymous') {
    res = await agent.post(role === 'admin' ? '/order/api/admin/login' : '/order/api/verify').set('Origin', origin).set('X-CSRF-Token', csrf).set(ip ? { 'X-Forwarded-For': ip } : {}).send(role === 'admin' ? { password: 'test-admin-very-strong' } : { answer: 'our-secret-answer' })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    csrf = res.body.csrf
  }
  return { agent, csrf, write(method, url, body) { return agent[method](url).set('Origin', origin).set('X-CSRF-Token', csrf).set(ip ? { 'X-Forwarded-For': ip } : {}).send(body) } }
}
async function addDish(admin, extra = {}) {
  const res = await admin.write('post', '/order/api/admin/dishes', { name: '糖醋排骨', category: '', ...extra })
  assert.equal(res.status, 201, JSON.stringify(res.body))
  return res.body
}
function orderBody(dish, extra = {}) { return { items: [{ id: dish.id, quantity: 2 }], note: '少糖', preferences: ['少油少盐'], idempotency: randomUUID(), ...extra } }

test('sales migration counts distinct historic orders and runs once without changing existing data', async t => {
  const first = fixture(t)
  const admin = await client(first.app, 'admin'); const guest = await client(first.app)
  const dish = await addDish(admin)
  const untouched = await addDish(admin, { name: '没点过的菜' })
  const order = await guest.write('post', '/order/api/orders', orderBody(dish))
  await guest.write('post', '/order/api/orders', orderBody(dish))
  first.db.prepare('UPDATE orders SET items=? WHERE id=?').run(JSON.stringify([...order.body.items, ...order.body.items]), order.body.id)
  first.db.exec("ALTER TABLE dishes DROP COLUMN sales_count; ALTER TABLE dishes DROP COLUMN liked; DELETE FROM metadata WHERE key='sales_backfilled_v1';")
  const beforeOrders = first.db.prepare('SELECT * FROM orders ORDER BY id').all()
  const beforeSessions = first.db.prepare('SELECT * FROM sessions ORDER BY hash').all()
  first.db.close()
  for (let restart = 0; restart < 2; restart++) {
    const reopened = createApp(first.config)
    try {
      assert.equal(reopened.db.prepare('SELECT sales_count FROM dishes WHERE id=?').get(dish.id).sales_count, 2)
      assert.equal(reopened.db.prepare('SELECT sales_count FROM dishes WHERE id=?').get(untouched.id).sales_count, restart === 0 ? 0 : 7)
      assert.equal(reopened.db.prepare('SELECT liked FROM dishes WHERE id=?').get(dish.id).liked, 0)
      assert.deepEqual(reopened.db.prepare('SELECT * FROM orders ORDER BY id').all(), beforeOrders)
      assert.deepEqual(reopened.db.prepare('SELECT * FROM sessions ORDER BY hash').all(), beforeSessions)
      if (restart === 0) reopened.db.prepare('UPDATE dishes SET sales_count=7 WHERE id=?').run(untouched.id)
      else assert.equal(reopened.db.prepare('SELECT sales_count FROM dishes WHERE id=?').get(untouched.id).sales_count, 7)
    } finally { reopened.db.close() }
  }
})

test('sales count successful orders once per dish and remain read-only through admin edits', async t => {
  const { app, db } = fixture(t)
  const admin = await client(app, 'admin'); const guest = await client(app)
  const first = await addDish(admin); const second = await addDish(admin, { name: '汤' })
  assert.equal(first.salesCount, 0); assert.equal(first.liked, false)
  assert.equal('sales_count' in first, false)
  const body = orderBody(first, { items: [{ id: first.id, quantity: 9 }, { id: second.id, quantity: 2 }] })
  const order = await guest.write('post', '/order/api/orders', body)
  assert.equal(order.status, 201)
  assert.equal((await guest.write('post', '/order/api/orders', body)).status, 200)
  assert.equal((await guest.write('post', '/order/api/orders', { ...body, note: '冲突' })).status, 409)
  assert.equal((await guest.write('post', '/order/api/orders', orderBody(first, { items: [{ id: first.id, quantity: 1 }, { id: 99999, quantity: 1 }] }))).status, 409)
  assert.equal((await admin.write('patch', `/order/api/admin/orders/${order.body.id}`, { status: 'done' })).status, 200)
  await guest.write('post', '/order/api/orders', orderBody(first))
  assert.deepEqual((await guest.agent.get('/order/api/menu')).body.map(d => d.salesCount), [2, 1])
  await guest.write('put', `/order/api/menu/${first.id}/like`, { liked: true })
  const changed = await admin.write('put', `/order/api/admin/dishes/${first.id}`, { name: '新菜名', available: false })
  assert.equal(changed.status, 200); assert.equal(changed.body.salesCount, 2); assert.equal(changed.body.liked, true)
  const restored = await admin.write('put', `/order/api/admin/dishes/${first.id}`, { name: '新菜名', available: true })
  assert.equal(restored.body.salesCount, 2); assert.equal(restored.body.liked, true)
  assert.equal((await admin.write('put', `/order/api/admin/dishes/${first.id}`, { name: '伪造销量', salesCount: 99 })).status, 400)
  assert.equal((await admin.write('post', '/order/api/admin/dishes', { name: '伪造喜欢', liked: true })).status, 400)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 2)
  await admin.write('delete', `/order/api/admin/dishes/${first.id}`)
  const replacement = await addDish(admin)
  assert.equal(replacement.salesCount, 0); assert.equal(replacement.liked, false)
})

test('order and every sales increment roll back together on a database failure', async t => {
  const { app, db } = fixture(t)
  const admin = await client(app, 'admin'); const guest = await client(app)
  const first = await addDish(admin); const second = await addDish(admin)
  db.exec(`CREATE TRIGGER fail_sales BEFORE UPDATE OF sales_count ON dishes WHEN NEW.id=${second.id} BEGIN SELECT RAISE(ABORT, 'test failure'); END;`)
  const body = orderBody(first, { items: [{ id: first.id, quantity: 2 }, { id: second.id, quantity: 1 }] })
  assert.equal((await guest.write('post', '/order/api/orders', body)).status, 500)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0)
  assert.deepEqual(db.prepare('SELECT sales_count FROM dishes ORDER BY id').all().map(d => d.sales_count), [0, 0])
  db.exec('DROP TRIGGER fail_sales')
  assert.equal((await guest.write('post', '/order/api/orders', body)).status, 201)
  assert.deepEqual(db.prepare('SELECT sales_count FROM dishes ORDER BY id').all().map(d => d.sales_count), [1, 1])
})

test('likes are shared, idempotent, persisted and protected by authorization, CSRF and validation', async t => {
  const first = fixture(t)
  const admin = await client(first.app, 'admin'); const guest = await client(first.app)
  const other = await client(first.app); const anonymous = await client(first.app, 'anonymous')
  const dish = await addDish(admin); const url = `/order/api/menu/${dish.id}/like`
  assert.equal((await anonymous.write('put', url, { liked: true })).status, 401)
  assert.equal((await guest.agent.put(url).set('Origin', origin).send({ liked: true })).status, 403)
  assert.equal((await guest.agent.put(url).set('Origin', 'https://evil.example').set('X-CSRF-Token', guest.csrf).send({ liked: true })).status, 403)
  for (const body of [{}, { liked: 1 }, { liked: 'true' }, { liked: true, salesCount: 10 }]) assert.equal((await guest.write('put', url, body)).status, 400)
  assert.equal((await guest.write('put', '/order/api/menu/nope/like', { liked: true })).status, 400)
  assert.equal((await guest.write('put', '/order/api/menu/9999/like', { liked: true })).status, 404)
  for (let i = 0; i < 2; i++) {
    const liked = await guest.write('put', url, { liked: true })
    assert.equal(liked.status, 200); assert.deepEqual(liked.body, { id: dish.id, liked: true })
  }
  assert.equal((await other.agent.get('/order/api/menu')).body[0].liked, true)
  assert.equal((await admin.agent.get('/order/api/admin/dishes')).body[0].liked, true)
  await admin.write('put', `/order/api/admin/dishes/${dish.id}`, { name: dish.name, available: false })
  assert.equal((await guest.write('put', url, { liked: false })).status, 409)
  await admin.write('put', `/order/api/admin/dishes/${dish.id}`, { name: dish.name, available: true })
  first.db.close()
  const reopened = createApp(first.config)
  try {
    const again = await client(reopened.app)
    assert.equal((await again.agent.get('/order/api/menu')).body[0].liked, true)
    assert.equal((await again.write('put', url, { liked: false })).status, 200)
    assert.equal((await again.agent.get('/order/api/menu')).body[0].liked, false)
    reopened.db.prepare("UPDATE rate_limits SET count=120 WHERE key LIKE 'read:%'").run()
    assert.equal((await again.write('put', url, { liked: true })).status, 429)
    assert.equal(reopened.db.prepare('SELECT liked FROM dishes WHERE id=?').get(dish.id).liked, 0)
  } finally { reopened.db.close() }
})

for (const missingFields of [['ingredients'], ['instructions'], ['ingredients', 'instructions']]) {
test(`additive ${missingFields.join(' and ')} migration preserves populated legacy database across repeated restarts`, async t => {
  const first = fixture(t)
  const admin = await client(first.app, 'admin'); const guest = await client(first.app)
  const dish = await addDish(admin, { description: '已有介绍', ingredients: '已有原料', instructions: '已有做法', category: '荤菜', tag: '拿手菜', minutes: 42, featured: true })
  await guest.write('post', '/order/api/orders', orderBody(dish))
  first.db.prepare('UPDATE dishes SET id=77,position=17,image=? WHERE id=?').run('existing.webp', dish.id)
  mkdirSync(path.join(first.config.dataDir, 'uploads'), { recursive: true })
  writeFileSync(path.join(first.config.dataDir, 'uploads', 'existing.webp'), 'existing-image')
  // Model the actual schema before this release, with real orders and sessions.
  for (const field of missingFields) first.db.exec(`ALTER TABLE dishes DROP COLUMN ${field}`)
  const previousDish = first.db.prepare('SELECT * FROM dishes').get()
  const tables = ['orders', 'sessions', 'metadata', 'rate_limits', 'audit']
  const before = Object.fromEntries(tables.map(table => [table, first.db.prepare(`SELECT * FROM ${table}`).all()]))
  first.db.close()
  for (let i = 0; i < 2; i++) {
    const reopened = createApp(first.config)
    try {
      const preserved = { ...reopened.db.prepare('SELECT * FROM dishes').get() }
      for (const field of missingFields) {
        assert.equal(preserved[field], '')
        delete preserved[field]
        assert.equal(reopened.db.prepare('PRAGMA table_info(dishes)').all().filter(c => c.name === field).length, 1)
      }
      assert.deepEqual(preserved, { ...previousDish })
      for (const table of tables) assert.deepEqual(reopened.db.prepare(`SELECT * FROM ${table}`).all(), before[table])
      assert.ok(existsSync(path.join(first.config.dataDir, 'uploads', 'existing.webp')))
    } finally { reopened.db.close() }
  }
})
}

for (const field of ['ingredients', 'instructions']) {
test(`${field} CRUD accepts empty and multiline text, validates bounds and preserves availability changes`, async t => {
  let notifications = 0
  const { app, db, notifier } = fixture(t, { sendKey: 'SCTtestkey' }, { fetcher: async () => {
    notifications++
    return { ok: true, json: async () => ({ code: 0 }) }
  } })
  const admin = await client(app, 'admin'); const guest = await client(app)
  const empty = await addDish(admin)
  assert.equal(empty[field], '')
  const dish = await addDish(admin, { [field]: '  第一行\n第二行  ' })
  assert.equal(dish[field], '第一行\n第二行')
  assert.equal((await admin.agent.get('/order/api/admin/dishes')).body.find(d => d.id === dish.id)[field], dish[field])
  for (const value of ['x'.repeat(501), ['排骨'], 3, null]) {
    assert.equal((await admin.write('post', '/order/api/admin/dishes', { name: '文本校验', [field]: value })).status, 400)
    assert.equal((await admin.write('put', `/order/api/admin/dishes/${dish.id}`, { name: dish.name, [field]: value })).status, 400)
  }
  const { id, position, salesCount, liked, ...body } = dish
  const off = await admin.write('put', `/order/api/admin/dishes/${id}`, { ...body, available: false })
  assert.equal(off.status, 200); assert.equal(off.body[field], dish[field])
  const restored = await admin.write('put', `/order/api/admin/dishes/${id}`, { ...body, available: true })
  assert.equal(restored.status, 200); assert.equal(restored.body[field], dish[field])
  const on = await admin.write('put', `/order/api/admin/dishes/${id}`, { ...body, [field]: 'x'.repeat(500) })
  assert.equal(on.status, 200); assert.equal(on.body[field].length, 500)
  const cleared = await admin.write('put', `/order/api/admin/dishes/${id}`, { ...body, [field]: ' \n ' })
  assert.equal(cleared.status, 200); assert.equal(cleared.body[field], '')
  assert.equal((await guest.write('put', `/order/api/admin/dishes/${id}`, body)).status, 403)
  assert.equal((await guest.write('post', '/order/api/admin/dishes', { name: '越权菜', [field]: '文本' })).status, 403)
  const anonymous = await client(app, 'anonymous')
  assert.equal((await anonymous.write('post', '/order/api/admin/dishes', { name: '越权菜', [field]: '文本' })).status, 401)
  assert.equal((await admin.agent.put(`/order/api/admin/dishes/${id}`).set('Origin', origin).send(body)).status, 403)
  assert.equal((await admin.agent.put(`/order/api/admin/dishes/${id}`).set('Origin', 'https://evil.example').set('X-CSRF-Token', admin.csrf).send(body)).status, 403)
  await notifier.tick()
  assert.equal(notifications, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0)
})
}

test('ingredients and instructions snapshots come from server and survive edits, deletion, idempotency and notification retries', async t => {
  const messages = []
  const { app, db, notifier } = fixture(t, { sendKey: 'SCTtestkey' }, { fetcher: async (_url, options) => {
    messages.push(JSON.parse(options.body).desp)
    if (messages.length === 1) throw new Error('offline')
    return { ok: true, json: async () => ({ code: 0 }) }
  } })
  const admin = await client(app, 'admin'); const guest = await client(app)
  const dish = await addDish(admin, { ingredients: '排骨500g\n姜、糖', instructions: '排骨焯水\n炒糖色后炖煮收汁' })
  const body = orderBody(dish, { preferences: [] })
  assert.equal((await guest.write('post', '/order/api/orders', { ...body, items: [{ id: dish.id, quantity: 2, ingredients: '伪造原料' }] })).status, 400)
  assert.equal((await guest.write('post', '/order/api/orders', { ...body, items: [{ id: dish.id, quantity: 2, instructions: '伪造做法' }] })).status, 400)
  const first = await guest.write('post', '/order/api/orders', body)
  assert.equal(first.status, 201); assert.equal(first.body.items[0].ingredients, dish.ingredients)
  assert.equal(first.body.items[0].instructions, dish.instructions)
  const { id, position, salesCount, liked, ...edited } = dish
  const changed = await admin.write('put', `/order/api/admin/dishes/${id}`, { ...edited, ingredients: '修改后的原料', instructions: '修改后的做法' })
  assert.equal(changed.status, 200)
  assert.equal(changed.body.instructions, '修改后的做法')
  await notifier.tick()
  assert.equal((await admin.write('delete', `/order/api/admin/dishes/${id}`)).status, 200)
  db.prepare('UPDATE orders SET next_retry=0').run()
  await notifier.tick()
  assert.equal(messages.length, 2); assert.equal(messages[0], messages[1])
  assert.match(messages[1], /糖醋排骨 × 2\n  原料：排骨500g 姜、糖\n  做法：排骨焯水 炒糖色后炖煮收汁/)
  assert.ok(!messages[1].includes('修改后的原料'))
  assert.ok(!messages[1].includes('修改后的做法'))
  assert.equal(db.prepare('SELECT notification FROM orders').get().notification, 'sent')
  const repeat = await guest.write('post', '/order/api/orders', body)
  assert.equal(repeat.body.id, first.body.id); assert.equal(repeat.body.items[0].ingredients, dish.ingredients)
  assert.equal(repeat.body.items[0].instructions, dish.instructions)
  assert.equal((await admin.agent.get('/order/api/admin/orders')).body[0].items[0].ingredients, dish.ingredients)
  assert.equal((await admin.agent.get('/order/api/admin/orders')).body[0].items[0].instructions, dish.instructions)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1)
})

test('legacy order notifications tolerate absent ingredients and instructions without rewriting snapshots', async t => {
  const { app, db } = fixture(t)
  const admin = await client(app, 'admin'); const guest = await client(app)
  const dish = await addDish(admin, { ingredients: '现在的原料', instructions: '现在的做法' })
  const order = await guest.write('post', '/order/api/orders', orderBody(dish))
  const legacy = [{ id: dish.id, name: dish.name, quantity: 2 }]
  db.prepare('UPDATE orders SET items=? WHERE id=?').run(JSON.stringify(legacy), order.body.id)
  const returned = (await admin.agent.get('/order/api/admin/orders')).body[0]
  assert.deepEqual(returned.items, legacy)
  const text = notificationText(returned)
  assert.match(text, /原料：未填写/); assert.ok(!text.includes('现在的原料'))
  assert.match(text, /做法：未填写/); assert.ok(!text.includes('现在的做法'))
  assert.match(text, /备注：少糖/); assert.match(text, /口味：少油少盐/)
  assert.match(notificationText({ ...returned, items: [{ name: '菜', quantity: 1, ingredients: '[原料](地址)\n#标记' }] }), /原料：原料地址 标记/)
  assert.match(notificationText({ ...returned, items: [{ name: '菜', quantity: 1, instructions: '[焯水](地址)\n#收汁' }] }), /做法：焯水地址 收汁/)
  const withIngredients = [{ id: dish.id, name: dish.name, quantity: 2, ingredients: '下单时的原料' }]
  db.prepare('UPDATE orders SET items=? WHERE id=?').run(JSON.stringify(withIngredients), order.body.id)
  const previousVersion = (await admin.agent.get('/order/api/admin/orders')).body[0]
  assert.deepEqual(previousVersion.items, withIngredients)
  assert.match(notificationText(previousVersion), /原料：下单时的原料\n  做法：未填写/)
  assert.equal(db.prepare('SELECT items FROM orders WHERE id=?').get(order.body.id).items, JSON.stringify(withIngredients))
})

test('homepage is public, order redirects preserve queries, and legacy API paths are isolated', async t => {
  const { app } = fixture(t)
  const home = await request(app).get('/')
  assert.equal(home.status, 200)
  assert.match(home.text, /<title>功能导航<\/title>/)
  assert.match(home.text, /href="\/order\/"/)
  assert.equal(home.headers['set-cookie'], undefined)
  assert.equal((await request(app).get('/order?from=home')).headers.location, '/order/?from=home')
  assert.equal((await request(app).get('/admin')).headers.location, '/order/admin')
  for (const oldPath of ['/api/session', '/api/menu', '/media/secret.webp', '/assets/private.js']) {
    assert.equal((await request(app).get(oldPath)).status, 404)
  }
})

test('kitchen shell and assets are served only inside order, while APIs and media remain private', async t => {
  const frontendDir = mkdtempSync(path.join(tmpdir(), 'kitchen-front-'))
  t.after(() => {
    assert.equal(path.dirname(frontendDir), path.resolve(tmpdir()))
    assert.ok(path.basename(frontendDir).startsWith('kitchen-front-'))
    rmSync(frontendDir, { recursive: true, force: true })
  })
  mkdirSync(path.join(frontendDir, 'assets'))
  writeFileSync(path.join(frontendDir, 'index.html'), '<html><script src="/order/assets/app.js"></script></html>')
  writeFileSync(path.join(frontendDir, 'assets/app.js'), 'window.kitchen=true')
  const { app } = fixture(t, { frontendDir })
  for (const page of ['/order/', '/order/admin']) {
    const response = await request(app).get(page)
    assert.equal(response.status, 200)
    assert.match(response.text, /\/order\/assets\/app.js/)
  }
  assert.equal((await request(app).get('/order/assets/app.js')).status, 200)
  assert.equal((await request(app).get('/assets/app.js')).status, 404)
  assert.equal((await request(app).get('/order/api/menu')).status, 401)
  assert.equal((await request(app).get('/order/media/private.webp')).status, 401)
  assert.equal((await request(app).get('/order/.env')).status, 404)
})

test('private menu, media and orders reject anonymous clients; IP headers cannot grant access', async t => {
  const { app } = fixture(t)
  for (const url of ['/order/api/menu', '/order/api/orders', '/order/media/secret.webp']) assert.equal((await request(app).get(url).set('X-Forwarded-For', '127.0.0.1')).status, 401)
  const anonymous = await client(app, 'anonymous')
  assert.equal((await anonymous.write('post', '/order/api/orders', {})).status, 401)
})
test('verification persists the browser but a different browser must verify', async t => {
  const { app } = fixture(t)
  const guest = await client(app)
  assert.equal((await guest.agent.get('/order/api/session')).body.role, 'guest')
  assert.equal((await request(app).get('/order/api/session')).body.role, 'anonymous')
  assert.equal((await guest.agent.get('/order/api/admin/dishes')).status, 403)
  assert.equal((await guest.write('post', '/order/api/admin/dishes', { name: '越权菜' })).status, 403)
})
test('network changes do not invalidate browser authorization and forwarded IP cannot authorize', async t => {
  const { app } = fixture(t, { trustProxy: ['127.0.0.1', '::1'] })
  const guest = await client(app, 'guest', '203.0.113.1')
  assert.equal((await guest.agent.get('/order/api/menu').set('X-Forwarded-For', '203.0.113.1')).status, 200)
  assert.equal((await guest.agent.get('/order/api/menu').set('X-Forwarded-For', '203.0.113.2')).status, 200)
  const second = fixture(t)
  const noProxy = await client(second.app)
  assert.equal((await noProxy.agent.get('/order/api/menu').set('X-Forwarded-For', '203.0.113.200')).status, 200)
})
test('all mutations require matching CSRF token and configured Origin', async t => {
  const { app } = fixture(t)
  const admin = await client(app, 'admin')
  assert.equal((await admin.agent.post('/order/api/admin/dishes').set('Origin', origin).send({ name: 'bad' })).status, 403)
  assert.equal((await admin.agent.post('/order/api/admin/dishes').set('Origin', 'https://evil.example').set('X-CSRF-Token', admin.csrf).send({ name: 'bad' })).status, 403)
  assert.equal((await admin.agent.post('/order/api/admin/dishes').set('Origin', origin).set('X-CSRF-Token', 'z'.repeat(64)).send({ name: 'bad' })).status, 403)
})
test('CRUD supports uncategorized dishes, unavailable dishes stay out of public menu', async t => {
  const { app } = fixture(t)
  const admin = await client(app, 'admin')
  const guest = await client(app)
  const dish = await addDish(admin)
  assert.equal((await guest.agent.get('/order/api/menu')).body[0].category, '')
  assert.equal((await admin.write('put', `/order/api/admin/dishes/${dish.id}`, { name: '新名字', available: false })).status, 200)
  assert.equal((await guest.agent.get('/order/api/menu')).body.length, 0)
  assert.equal((await admin.write('delete', `/order/api/admin/dishes/${dish.id}`)).status, 200)
  assert.equal((await admin.agent.get('/order/api/admin/dishes')).body.length, 0)
})
test('orders validate server-side items, quantities, duplicate items, text bounds and conflicting preferences', async t => {
  const { app } = fixture(t)
  const admin = await client(app, 'admin'); const guest = await client(app)
  const dish = await addDish(admin)
  for (const extra of [{ items: [] }, { items: [{ id: dish.id, quantity: 0 }] }, { items: [{ id: dish.id, quantity: 99 }] }, { items: [{ id: dish.id, quantity: 1 }, { id: dish.id, quantity: 1 }] }, { note: 'x'.repeat(301) }, { preferences: ['微辣', '不吃辣'] }]) assert.equal((await guest.write('post', '/order/api/orders', orderBody(dish, extra))).status, 400)
  assert.equal((await guest.write('post', '/order/api/orders', orderBody({ id: 9999 }))).status, 409)
  assert.equal((await guest.write('post', '/order/api/orders', { ...orderBody(dish), name: '伪造' })).status, 400)
})
test('idempotent submission creates one snapshot, survives menu deletion, and rejects key reuse with different payload', async t => {
  const { app, db } = fixture(t)
  const admin = await client(app, 'admin'); const guest = await client(app)
  const dish = await addDish(admin)
  const body = orderBody(dish)
  const first = await guest.write('post', '/order/api/orders', body)
  assert.equal(first.status, 201); assert.equal(first.body.notification, 'unconfigured')
  await admin.write('delete', `/order/api/admin/dishes/${dish.id}`)
  const second = await guest.write('post', '/order/api/orders', body)
  assert.equal(second.status, 200); assert.equal(second.body.id, first.body.id)
  assert.equal(second.body.items[0].name, '糖醋排骨')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1)
  assert.equal((await guest.write('post', '/order/api/orders', { ...body, note: '另一份' })).status, 409)
  assert.equal((await admin.agent.get('/order/api/admin/orders')).body[0].items[0].name, '糖醋排骨')
  const otherGuest = await client(app)
  assert.equal((await otherGuest.agent.get('/order/api/orders')).body.length, 0)
})
test('real image decoding rejects disguised SVG and rewrites valid image as private WebP', async t => {
  const { app, config } = fixture(t)
  const admin = await client(app, 'admin')
  const forged = await admin.agent.post('/order/api/admin/uploads').set('Origin', origin).set('X-CSRF-Token', admin.csrf).attach('image', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'), { filename: 'dish.jpg', contentType: 'image/jpeg' })
  assert.equal(forged.status, 400)
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#dd3388' } }).png().toBuffer()
  const valid = await admin.agent.post('/order/api/admin/uploads').set('Origin', origin).set('X-CSRF-Token', admin.csrf).attach('image', png, { filename: '../../dish.png', contentType: 'image/png' })
  assert.equal(valid.status, 201)
  assert.match(valid.body.image, /^\/media\/[a-f0-9]{64}\.webp$/)
  assert.ok(existsSync(path.join(config.dataDir, 'uploads', path.basename(valid.body.image))))
  assert.equal((await request(app).get('/order' + valid.body.image)).status, 401)
  assert.equal((await admin.agent.get('/order' + valid.body.image)).status, 200)
})
test('revoke-all invalidates guests while preserving admin; IP API is removed', async t => {
  const { app } = fixture(t)
  const admin = await client(app, 'admin'); const guest = await client(app)
  const security = (await admin.agent.get('/order/api/admin/security')).body
  assert.equal('ips' in security, false)
  assert.ok(security.events.every(event => !('ip_label' in event)))
  assert.equal((await admin.write('delete', '/order/api/admin/security/ips/anything')).status, 404)
  assert.equal((await admin.write('post', '/order/api/admin/security/revoke-all', {})).status, 200)
  assert.equal((await guest.agent.get('/order/api/menu')).status, 401)
  assert.equal((await admin.agent.get('/order/api/admin/dishes')).status, 200)
})

test('failed verification budget is stored in SQLite and blocks later attempts', async t => {
  const frozenTime = Math.floor(Date.now() / (15 * 60000)) * (15 * 60000) + 1000
  t.mock.method(Date, 'now', () => frozenTime)
  const { app, db } = fixture(t)
  const anonymous = await client(app, 'anonymous')
  for (let n = 0; n < 5; n++) assert.equal((await anonymous.write('post', '/order/api/verify', { answer: 'wrong' })).status, 401)
  assert.equal((await anonymous.write('post', '/order/api/verify', { answer: 'our-secret-answer' })).status, 429)
  assert.ok(db.prepare("SELECT count FROM rate_limits WHERE key LIKE 'verify:%' AND key != 'verify:global'").get().count >= 5)
})
test('expiring a browser session requires verification', async t => {
  const { app, db } = fixture(t)
  const guest = await client(app)
  db.prepare("UPDATE sessions SET expires=0 WHERE role='guest'").run()
  assert.equal((await guest.agent.get('/order/api/menu')).status, 401)
})

test('notification outbox persists failures, retries, then marks provider acceptance', async t => {
  let calls = 0
  const { app, db, notifier } = fixture(t, { sendKey: 'SCTtestkey' }, { fetcher: async () => { calls++; if (calls === 1) throw new Error('offline'); return { ok: true, json: async () => ({ code: 0 }) } } })
  const admin = await client(app, 'admin'); const guest = await client(app)
  const dish = await addDish(admin)
  const response = await guest.write('post', '/order/api/orders', orderBody(dish))
  assert.equal(response.status, 201); assert.equal(response.body.notification, 'pending')
  await notifier.tick()
  let order = db.prepare('SELECT * FROM orders').get()
  assert.equal(order.notification, 'retrying'); assert.equal(order.attempts, 1)
  db.prepare('UPDATE orders SET next_retry=0').run()
  await notifier.tick(); order = db.prepare('SELECT * FROM orders').get()
  assert.equal(order.notification, 'sent'); assert.equal(order.attempts, 2)
  await notifier.tick(); assert.equal(calls, 2)
})
test('Server酱 Turbo and SC3 use fixed validated endpoints and nonzero codes fail', async () => {
  assert.equal(serverChanUrl('SCTabc123'), 'https://sctapi.ftqq.com/SCTabc123.send')
  assert.equal(serverChanUrl('sctp123tabc'), 'https://123.push.ft07.com/send/sctp123tabc.send')
  assert.throws(() => serverChanUrl('https://evil.example'))
  const order = { id: 'K1', created: Date.now(), items: [{ name: '[排骨](https://evil)', quantity: 1 }], note: 'hello', preferences: [] }
  await assert.rejects(() => sendNotification('SCTabc', order, async () => ({ ok: true, json: async () => ({ code: 1 }) })))
})
test('exhausted notification attempts become retryable failures, including an interrupted last attempt', async t => {
  let calls = 0
  const { app, db, notifier } = fixture(t, { sendKey: 'SCTtestkey' }, { fetcher: async () => { calls++; throw new Error('offline') } })
  const admin = await client(app, 'admin'); const guest = await client(app)
  const dish = await addDish(admin)
  await guest.write('post', '/order/api/orders', orderBody(dish))
  for (let i = 0; i < 5; i++) { db.prepare('UPDATE orders SET next_retry=0').run(); await notifier.tick() }
  assert.equal(db.prepare('SELECT notification FROM orders').get().notification, 'failed')
  assert.equal(calls, 5)
  db.prepare("UPDATE orders SET notification='retrying',attempts=5,next_retry=0").run()
  await notifier.tick()
  assert.equal(db.prepare('SELECT notification FROM orders').get().notification, 'failed')
  assert.equal(calls, 5)
})
test('verification limit survives an actual database close and application restart', async t => {
  const frozenTime = Math.floor(Date.now() / (15 * 60000)) * (15 * 60000) + 1000
  t.mock.method(Date, 'now', () => frozenTime)
  const first = fixture(t)
  const anonymous = await client(first.app, 'anonymous')
  for (let i = 0; i < 5; i++) await anonymous.write('post', '/order/api/verify', { answer: 'wrong' })
  first.db.prepare("UPDATE rate_limits SET count=40 WHERE key='verify:global'").run()
  first.db.close()
  const restarted = createApp(first.config)
  try {
    const again = await client(restarted.app, 'anonymous')
    assert.equal((await again.write('post', '/order/api/verify', { answer: 'our-secret-answer' })).status, 429)
  } finally { restarted.db.close() }
})
test('production pre-auth cookies are Secure, HttpOnly and SameSite=Lax', async t => {
  const { app } = fixture(t, { production: true, secure: true, origin: 'https://kitchen.example.com' })
  const response = await request(app).get('/order/api/session')
  assert.equal(response.status, 200)
  const cookie = response.headers['set-cookie'][0]
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/order']) assert.ok(cookie.includes(flag))
  assert.ok(response.headers['content-security-policy'].includes("frame-ancestors 'none'"))
  assert.equal(response.headers['cache-control'], 'no-store')
})
test('production fails closed without secrets/HTTPS; demo cannot bind publicly', async () => {
  await assert.rejects(loadConfig({ NODE_ENV: 'production' }))
  await assert.rejects(loadConfig({ KITCHEN_DEMO: '1', HOST: '0.0.0.0' }))
  await assert.rejects(loadConfig({ NODE_ENV: 'production', APP_SECRET: base.secret, ADMIN_PASSWORD_HASH: base.adminHash, GUEST_ANSWER_HASH: base.answerHash, PUBLIC_ORIGIN: origin, COOKIE_SECURE: 'false' }))
  await assert.rejects(loadConfig({ APP_SECRET: base.secret, ADMIN_PASSWORD_HASH: base.adminHash, GUEST_ANSWER_HASH: base.answerHash, TRUST_PROXY: 'true' }))
})


test('category order is shared, authorized, validated and persisted across restarts', async t => {
  const first = fixture(t)
  const admin = await client(first.app, 'admin'); const guest = await client(first.app)
  const other = await client(first.app); const anonymous = await client(first.app, 'anonymous')
  const meat = await addDish(admin, { category: '荤菜' })
  const vegetable = await addDish(admin, { category: '素菜' })
  const soup = await addDish(admin, { category: '汤羹' })
  const read = '/order/api/menu/categories', write = '/order/api/menu/categories/order'
  assert.deepEqual((await guest.agent.get(read)).body, ['荤菜', '素菜', '汤羹'])
  assert.equal((await anonymous.agent.get(read)).status, 401)
  assert.equal((await anonymous.write('put', write, [])).status, 401)
  assert.equal((await guest.agent.put(write).set('Origin', origin).send([])).status, 403)
  assert.equal((await guest.agent.put(write).set('Origin', 'https://evil.example').set('X-CSRF-Token', guest.csrf).send([])).status, 403)
  for (const invalid of [{ order: [] }, [1], ['x'.repeat(21)]]) assert.equal((await guest.write('put', write, invalid)).status, 400)
  for (const invalid of [[], ['荤菜', '荤菜', '汤羹'], ['荤菜', '素菜', '未知']]) assert.equal((await guest.write('put', write, invalid)).status, 409)
  assert.equal((await guest.write('put', write, ['汤羹', '荤菜', '素菜'])).status, 200)
  assert.deepEqual((await other.agent.get(read)).body, ['汤羹', '荤菜', '素菜'])
  await admin.write('put', `/order/api/admin/dishes/${meat.id}`, { name: meat.name, category: '荤菜', available: false })
  assert.deepEqual((await other.agent.get(read)).body, ['汤羹', '素菜'])
  await guest.write('put', write, ['素菜', '汤羹'])
  await admin.write('put', `/order/api/admin/dishes/${meat.id}`, { name: meat.name, category: '荤菜', available: true })
  assert.deepEqual((await other.agent.get(read)).body, ['素菜', '荤菜', '汤羹'])
  await addDish(admin, { category: '甜点' })
  await admin.write('delete', `/order/api/admin/dishes/${soup.id}`)
  await admin.write('put', `/order/api/admin/dishes/${vegetable.id}`, { name: vegetable.name, category: '蔬菜' })
  assert.deepEqual((await other.agent.get(read)).body, ['荤菜', '甜点', '蔬菜'])
  await guest.write('put', write, ['甜点', '蔬菜', '荤菜'])
  first.db.close()
  const reopened = createApp(first.config)
  try {
    const again = await client(reopened.app)
    assert.deepEqual((await again.agent.get(read)).body, ['甜点', '蔬菜', '荤菜'])
    await again.write('put', write, ['甜点', '蔬菜', '荤菜'])
    reopened.db.prepare("UPDATE rate_limits SET count=30 WHERE key LIKE 'categories:%'").run()
    assert.equal((await again.write('put', write, ['荤菜', '蔬菜', '甜点'])).status, 429)
    assert.deepEqual((await again.agent.get(read)).body, ['甜点', '蔬菜', '荤菜'])
  } finally { reopened.db.close() }
})

test('legacy IP migration removes identifiers and purges active SQLite files without losing orders', async t => {
  const first = fixture(t)
  const admin = await client(first.app, 'admin'); const guest = await client(first.app)
  const dish = await addDish(admin)
  await guest.write('post', '/order/api/orders', orderBody(dish))
  const orders = first.db.prepare('SELECT * FROM orders').all()
  const dishes = first.db.prepare('SELECT * FROM dishes').all()
  first.db.exec(`CREATE TABLE trusted_ips(hash TEXT PRIMARY KEY,label TEXT,expires INTEGER,last_seen INTEGER);
    INSERT INTO trusted_ips VALUES ('legacy-ip-marker','network',9999999999999,0);
    ALTER TABLE sessions ADD COLUMN ip_hash TEXT NOT NULL DEFAULT 'legacy-ip-marker';
    ALTER TABLE audit ADD COLUMN ip_label TEXT NOT NULL DEFAULT 'legacy-ip-marker';
    INSERT INTO rate_limits VALUES ('verify:legacy-ip-marker',1,1);
    INSERT OR REPLACE INTO rate_limits VALUES ('verify:global',1,7);`)
  first.db.close()
  for (let i = 0; i < 2; i++) {
    const reopened = createApp(first.config)
    try {
      assert.deepEqual(reopened.db.prepare('SELECT * FROM orders').all(), orders)
      assert.deepEqual(reopened.db.prepare('SELECT * FROM dishes').all(), dishes)
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0)
      assert.equal(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name='trusted_ips'").get(), undefined)
      for (const table of ['sessions', 'audit']) assert.ok(reopened.db.prepare(`PRAGMA table_info(${table})`).all().every(c => !c.name.startsWith('ip_')))
      assert.equal(reopened.db.prepare("SELECT key FROM rate_limits WHERE key LIKE '%legacy-ip-marker%'").get(), undefined)
      assert.equal(reopened.db.prepare("SELECT count FROM rate_limits WHERE key='verify:global'").get().count, 7)
    } finally { reopened.db.close() }
  }
  const { readFileSync } = await import('node:fs')
  for (const suffix of ['', '-wal']) {
    const file = path.join(first.config.dataDir, 'kitchen.sqlite' + suffix)
    if (existsSync(file)) assert.equal(readFileSync(file).includes(Buffer.from('legacy-ip-marker')), false)
  }
})


test('global verification budget blocks a fresh browser after restart', async t => {
  const first = fixture(t)
  await client(first.app, 'anonymous')
  first.db.prepare("INSERT OR REPLACE INTO rate_limits(key,window,count) VALUES ('verify:global',?,40)").run(Math.floor(Date.now() / 900000))
  first.db.close()
  const reopened = createApp(first.config)
  try {
    const fresh = await client(reopened.app, 'anonymous')
    assert.equal((await fresh.write('post', '/order/api/verify', { answer: 'our-secret-answer' })).status, 429)
  } finally { reopened.db.close() }
})
