import express from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import multer from 'multer'
import sharp from 'sharp'
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { openDatabase, dishJson, orderJson } from './database.js'
import { token, digest, sameToken, verifySecret, normalizeAnswer, consumeLimit, HttpError } from './security.js'
import { createNotifier } from './notifier.js'

const day = 86400000
const cookieName = 'kitchen_order_session'
export const preferences = ['少油少盐', '不吃辣', '微辣', '不要香菜']
const dishSchema = z.object({
  name: z.string().trim().min(1).max(40), description: z.string().trim().max(160).default(''),
  ingredients: z.string().trim().max(500).default(''),
  instructions: z.string().trim().max(500).default(''),
  category: z.string().trim().max(20).default(''), tag: z.string().trim().max(12).default(''),
  minutes: z.number().int().min(1).max(240).default(20),
  available: z.boolean().default(true), featured: z.boolean().default(false),
  image: z.string().regex(/^(|\/media\/[a-zA-Z0-9-]+\.webp)$/).default(''),
}).strict()
const orderSchema = z.object({
  items: z.array(z.object({ id: z.number().int().positive(), quantity: z.number().int().min(1).max(9) }).strict()).min(1).max(20),
  note: z.string().trim().max(300).default(''),
  preferences: z.array(z.enum(preferences)).max(4).default([]),
  idempotency: z.string().uuid(),
}).strict()
function parse(schema, body) {
  const result = schema.safeParse(body)
  if (!result.success) throw new HttpError(400, '填写内容不正确，请检查长度、数量和必填项。')
  return result.data
}
function validId(raw) {
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, '菜品编号不正确。')
  return id
}

export function createApp(config, options = {}) {
  const db = openDatabase(config)
  const app = express()
  const notifier = createNotifier(db, config, options.fetcher)
  let lastCleanup = 0
  app.disable('x-powered-by')
  app.set('trust proxy', config.trustProxy.length ? config.trustProxy : false)
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'blob:', 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: config.production ? [] : null } }, strictTransportSecurity: config.production ? undefined : false }))
  // Private kitchen routes live under /order; the homepage stays public.
  const kitchen = express.Router()
  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store')
    res.sendFile(path.join(import.meta.dirname, 'portal.html'))
  })
  app.get(/^\/order$/, (req, res) => res.redirect(308, '/order/' + req.url.slice('/order'.length)))
  app.get('/admin', (req, res) => res.redirect(308, '/order/admin'))
  app.use('/order', kitchen)
  kitchen.use(cookieParser())
  kitchen.use('/api', express.json({ limit: '24kb' }))
  kitchen.use(['/api', '/media'], (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    const now = Date.now()
    if (now - lastCleanup > 60000) {
      db.prepare('DELETE FROM sessions WHERE expires < ?').run(now)
      db.prepare('DELETE FROM audit WHERE created < ?').run(now - 90 * day)
      // All limits have a maximum one-hour window; drop inactive windows after two hours.
      db.prepare("DELETE FROM rate_limits WHERE window < ? AND (key LIKE ? OR key LIKE 'categories:%')").run(Math.floor(now / 60000) - 2, 'read:%')
      db.prepare("DELETE FROM rate_limits WHERE window < ? AND (key LIKE 'verify:%' OR key LIKE 'login:%')").run(Math.floor(now / (15 * 60000)) - 1)
      db.prepare("DELETE FROM rate_limits WHERE window < ? AND (key LIKE 'orders:%' OR key LIKE 'sessions:%' OR key LIKE 'uploads:%' OR key LIKE 'notify:%')").run(Math.floor(now / 3600000) - 1)
      lastCleanup = now
    }
    const raw = req.cookies[cookieName]
    req.session = typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw) ? db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(digest(raw), now) : undefined
    next()
  })
  const audit = (event, req) => db.prepare('INSERT INTO audit(event,created) VALUES (?,?)').run(event, Date.now())
  function issueSession(req, res, role, lifetime) {
    if (req.session) db.prepare('DELETE FROM sessions WHERE hash=?').run(req.session.hash)
    const raw = token()
    const session = { hash: digest(raw), role, csrf: token(), expires: Date.now() + lifetime, created: Date.now() }
    db.prepare('INSERT INTO sessions(hash,role,csrf,expires,created) VALUES (?,?,?,?,?)').run(...Object.values(session))
    res.cookie(cookieName, raw, { httpOnly: true, secure: config.secure, sameSite: 'lax', maxAge: lifetime, path: '/order' })
    req.session = session
    return session
  }
  const sessionJson = session => ({ role: session.role, csrf: session.csrf, expires: session.expires, question: config.question, demo: config.demo, notificationConfigured: session.role === 'admin' ? Boolean(config.sendKey) : undefined })
  kitchen.get('/api/session', (req, res) => {
    consumeLimit(db, `read:${req.session?.hash || 'anonymous'}`, 120, 60000)
    if (!req.session) consumeLimit(db, 'sessions:global', 1000, 3600000)
    const session = req.session || issueSession(req, res, 'anonymous', 3600000)
    res.json(sessionJson(session))
  })
  kitchen.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origins = [config.origin]
      if (!config.production) origins.push('http://127.0.0.1:5173', 'http://localhost:5173')
      if (!origins.includes(req.get('Origin')) || !req.session || !sameToken(req.get('X-CSRF-Token'), req.session.csrf)) throw new HttpError(403, '页面验证已失效，请刷新页面后重试。')
    }
    next()
  })
  kitchen.post('/api/verify', async (req, res) => {
    consumeLimit(db, `verify:${req.session.hash}`, 5, 15 * 60000)
    consumeLimit(db, 'verify:global', 40, 15 * 60000)
    const body = parse(z.object({ answer: z.string().min(1).max(128) }).strict(), req.body)
    if (!await verifySecret(normalizeAnswer(body.answer), config.answerHash)) {
      audit('访客验证失败', req)
      throw new HttpError(401, '暗号不对，再想一想吧。')
    }
    const session = issueSession(req, res, 'guest', 30 * day)
    audit('访客验证成功', req)
    res.json(sessionJson(session))
  })
  kitchen.post('/api/admin/login', async (req, res) => {
    consumeLimit(db, `login:${req.session.hash}`, 8, 15 * 60000)
    consumeLimit(db, 'login:global', 40, 15 * 60000)
    const body = parse(z.object({ password: z.string().min(1).max(128) }).strict(), req.body)
    if (!await verifySecret(body.password, config.adminHash)) {
      audit('管理员登录失败', req)
      throw new HttpError(401, '密码不正确。')
    }
    audit('管理员登录成功', req)
    res.json(sessionJson(issueSession(req, res, 'admin', 8 * 3600000)))
  })
  kitchen.post('/api/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE hash=?').run(req.session.hash)
    res.clearCookie(cookieName, { httpOnly: true, secure: config.secure, sameSite: 'lax', path: '/order' })
    res.json({ ok: true })
  })
  const authenticated = (req, res, next) => {
    if (!['guest', 'admin'].includes(req.session?.role)) throw new HttpError(401, '请先验证暗号，再进入小厨房。')
    consumeLimit(db, `read:${req.session?.hash || 'anonymous'}`, 120, 60000)
    next()
  }
  const admin = (req, res, next) => {
    if (req.session?.role !== 'admin') throw new HttpError(403, '只有管理员可以进行这项操作。')
    next()
  }
  function menuCategories() {
    const names = db.prepare("SELECT COALESCE(NULLIF(category,''),'未分类') AS name, MIN(position) AS first_position FROM dishes GROUP BY COALESCE(NULLIF(category,''),'未分类') ORDER BY first_position,MIN(id)").all()
    db.exec('BEGIN IMMEDIATE')
    try {
      const insert = db.prepare('INSERT OR IGNORE INTO category_order(name,position) VALUES (?,(SELECT COALESCE(MAX(position),-1)+1 FROM category_order))')
      for (const { name } of names) insert.run(name)
      db.exec("DELETE FROM category_order WHERE name NOT IN (SELECT COALESCE(NULLIF(category,''),'未分类') FROM dishes)")
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    return db.prepare("SELECT name FROM category_order WHERE name IN (SELECT COALESCE(NULLIF(category,''),'未分类') FROM dishes WHERE available=1) ORDER BY position,name").all().map(x => x.name)
  }
  kitchen.get('/api/menu/categories', authenticated, (req, res) => res.json(menuCategories()))
  kitchen.put('/api/menu/categories/order', authenticated, (req, res) => {
    consumeLimit(db, `categories:${req.session.hash}`, 30, 60000)
    const names = parse(z.array(z.string().min(1).max(20)), req.body)
    const current = menuCategories()
    if (names.length !== current.length || new Set(names).size !== names.length || names.some(name => !current.includes(name))) throw new HttpError(409, '分类已变化，请刷新菜单后重新排序。')
    // Replace visible slots only; hidden categories keep their positions.
    const positions = current.map(name => db.prepare('SELECT position FROM category_order WHERE name=?').get(name).position)
    db.exec('BEGIN IMMEDIATE')
    try {
      const update = db.prepare('UPDATE category_order SET position=? WHERE name=?')
      names.forEach((name, i) => update.run(positions[i], name))
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    res.json(names)
  })
  kitchen.get('/api/menu', authenticated, (req, res) => res.json(db.prepare('SELECT * FROM dishes WHERE available=1 ORDER BY position,id').all().map(dishJson)))
  kitchen.put('/api/menu/:id/like', authenticated, (req, res) => {
    const id = validId(req.params.id)
    const { liked } = parse(z.object({ liked: z.boolean() }).strict(), req.body)
    const dish = db.prepare('SELECT available FROM dishes WHERE id=?').get(id)
    if (!dish) throw new HttpError(404, '菜品不存在。')
    if (!dish.available) throw new HttpError(409, '这道菜已经下架，请刷新菜单。')
    db.prepare('UPDATE dishes SET liked=? WHERE id=?').run(Number(liked), id)
    res.json({ id, liked })
  })
  kitchen.get('/media/:filename', authenticated, (req, res) => {
    const name = req.params.filename
    if (!/^[a-zA-Z0-9-]+\.webp$/.test(name)) throw new HttpError(404, '图片不存在。')
    const upload = path.join(config.dataDir, 'uploads', name)
    const source = existsSync(upload) ? upload : config.demo ? path.join(config.demoAssets, name) : ''
    if (!source || !existsSync(source)) throw new HttpError(404, '图片不存在。')
    res.type('image/webp').sendFile(source)
  })
  kitchen.get('/api/orders', authenticated, (req, res) => res.json(db.prepare('SELECT * FROM orders WHERE owner=? ORDER BY created DESC LIMIT 30').all(req.session.hash).map(orderJson)))
  kitchen.post('/api/orders', authenticated, (req, res) => {
    const body = parse(orderSchema, req.body)
    if (new Set(body.items.map(x => x.id)).size !== body.items.length) throw new HttpError(400, '同一道菜请直接调整份数。')
    if (body.items.reduce((sum, x) => sum + x.quantity, 0) > 30) throw new HttpError(400, '一份清单最多选择 30 份菜。')
    if (body.preferences.includes('不吃辣') && body.preferences.includes('微辣')) throw new HttpError(400, '不吃辣和微辣请选择其中一种。')
    const requestHash = digest(JSON.stringify({ items: body.items, note: body.note, preferences: body.preferences }))
    const existing = db.prepare('SELECT * FROM orders WHERE owner=? AND idempotency=?').get(req.session.hash, body.idempotency)
    if (existing) {
      if (existing.request_hash !== requestHash) throw new HttpError(409, '这份清单已提交，请重新确认菜品后发送。')
      return res.json(orderJson(existing))
    }
    consumeLimit(db, `orders:device:${req.session.hash}`, 10, 3600000)
    consumeLimit(db, 'orders:global', 50, 3600000)
    // Snapshot names, ingredients and instructions from the database; clients only select IDs and quantities.
    const items = body.items.map(item => {
      const dish = db.prepare('SELECT id,name,ingredients,instructions FROM dishes WHERE id=? AND available=1').get(item.id)
      if (!dish) throw new HttpError(409, '有菜品已经下架，请刷新菜单再选一次。')
      return { id: dish.id, name: dish.name, ingredients: dish.ingredients, instructions: dish.instructions, quantity: item.quantity }
    })
    const id = `K${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replaceAll('-', '')}-${token().slice(0, 8).toUpperCase()}`
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('INSERT INTO orders(id,owner,idempotency,request_hash,items,note,preferences,created,notification) VALUES (?,?,?,?,?,?,?,?,?)').run(id, req.session.hash, body.idempotency, requestHash, JSON.stringify(items), body.note, JSON.stringify(body.preferences), Date.now(), config.sendKey ? 'pending' : 'unconfigured')
      const increment = db.prepare('UPDATE dishes SET sales_count=sales_count+1 WHERE id=?')
      for (const item of items) increment.run(item.id)
      audit('收到点菜清单', req)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
    res.status(201).json(orderJson(db.prepare('SELECT * FROM orders WHERE id=?').get(id)))
  })
  kitchen.use('/api/admin', authenticated, admin)
  kitchen.get('/api/admin/dishes', (req, res) => res.json(db.prepare('SELECT * FROM dishes ORDER BY position,id').all().map(dishJson)))
  const imageName = image => image.replace(/^\/media\//, '')
  function checkImage(image) {
    const name = imageName(image)
    if (name && !existsSync(path.join(config.dataDir, 'uploads', name)) && !(config.demo && existsSync(path.join(config.demoAssets, name)))) throw new HttpError(400, '图片不存在，请重新上传。')
  }
  kitchen.post('/api/admin/dishes', (req, res) => {
    const dish = parse(dishSchema, req.body)
    checkImage(dish.image)
    const result = db.prepare('INSERT INTO dishes(name,description,category,image,tag,minutes,available,featured,ingredients,instructions,position) VALUES (?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM dishes))').run(dish.name, dish.description, dish.category, imageName(dish.image), dish.tag, dish.minutes, Number(dish.available), Number(dish.featured), dish.ingredients, dish.instructions)
    menuCategories()
    res.status(201).json(dishJson(db.prepare('SELECT * FROM dishes WHERE id=?').get(result.lastInsertRowid)))
  })
  kitchen.put('/api/admin/dishes/:id', (req, res) => {
    const id = validId(req.params.id)
    const dish = parse(dishSchema, req.body)
    checkImage(dish.image)
    const result = db.prepare('UPDATE dishes SET name=?,description=?,category=?,image=?,tag=?,minutes=?,available=?,featured=?,ingredients=?,instructions=? WHERE id=?').run(dish.name, dish.description, dish.category, imageName(dish.image), dish.tag, dish.minutes, Number(dish.available), Number(dish.featured), dish.ingredients, dish.instructions, id)
    if (!result.changes) throw new HttpError(404, '菜品不存在。')
    menuCategories()
    res.json(dishJson(db.prepare('SELECT * FROM dishes WHERE id=?').get(id)))
  })
  kitchen.delete('/api/admin/dishes/:id', (req, res) => {
    const result = db.prepare('DELETE FROM dishes WHERE id=?').run(validId(req.params.id))
    if (!result.changes) throw new HttpError(404, '菜品不存在。')
    menuCategories()
    res.json({ ok: true })
  })
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 } })
  kitchen.post('/api/admin/uploads', (req, res, next) => {
    consumeLimit(db, `uploads:${req.session.hash}`, 30, 3600000)
    next()
  }, upload.single('image'), async (req, res) => {
    if (!req.file) throw new HttpError(400, '请选择一张图片。')
    let buffer
    try {
      const image = sharp(req.file.buffer, { limitInputPixels: 20000000, animated: false })
      const meta = await image.metadata()
      if (!['jpeg', 'png', 'webp'].includes(meta.format) || (meta.pages || 1) > 1) throw new Error('unsupported')
      buffer = await image.rotate().resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
    } catch { throw new HttpError(400, '请上传有效的 JPG、PNG 或 WebP 静态图片，最大 5 MB、2000 万像素。') }
    const name = `${token()}.webp`
    await writeFile(path.join(config.dataDir, 'uploads', name), buffer, { flag: 'wx' })
    res.status(201).json({ image: `/media/${name}` })
  })
  kitchen.get('/api/admin/orders', (req, res) => res.json(db.prepare('SELECT * FROM orders ORDER BY created DESC LIMIT 100').all().map(orderJson)))
  kitchen.patch('/api/admin/orders/:id', (req, res) => {
    const body = parse(z.object({ status: z.enum(['received', 'cooking', 'done']) }).strict(), req.body)
    if (!db.prepare('UPDATE orders SET status=? WHERE id=?').run(body.status, req.params.id).changes) throw new HttpError(404, '清单不存在。')
    res.json({ ok: true })
  })
  kitchen.post('/api/admin/orders/:id/retry', (req, res) => {
    if (!config.sendKey) throw new HttpError(409, '请先在服务器配置 Server酱 SendKey，并重启服务。')
    consumeLimit(db, `notify:${req.session.hash}`, 5, 3600000)
    const row = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id)
    if (!row) throw new HttpError(404, '清单不存在。')
    if (['sent', 'pending', 'retrying'].includes(row.notification)) throw new HttpError(409, '该通知已发送或正在发送，请稍候。')
    db.prepare("UPDATE orders SET notification='pending',attempts=0,next_retry=0 WHERE id=?").run(row.id)
    res.json({ ok: true })
  })
  kitchen.get('/api/admin/security', (req, res) => {
    res.json({ events: db.prepare('SELECT event,created FROM audit ORDER BY id DESC LIMIT 30').all(), notificationConfigured: Boolean(config.sendKey) })
  })
  kitchen.post('/api/admin/security/revoke-all', (req, res) => {
    db.exec("BEGIN; DELETE FROM sessions WHERE role='guest'; COMMIT;")
    audit('撤销所有访客权限', req)
    res.json({ ok: true })
  })
  kitchen.use('/api', (req, res) => res.status(404).json({ error: '接口不存在。' }))
  if (existsSync(config.frontendDir)) {
    kitchen.use(express.static(config.frontendDir, { index: false }))
    kitchen.get(['/', '/admin'], (req, res) => res.sendFile(path.join(config.frontendDir, 'index.html')))
  }
  app.use((error, req, res, next) => {
    const status = error.status || (error instanceof multer.MulterError ? 400 : 500)
    if (status === 429) res.set('Retry-After', '900')
    res.status(status).json({ error: error instanceof multer.MulterError ? '图片过大或上传内容不正确，最大 5 MB。' : status < 500 ? error.message : '服务器暂时开小差，请稍后再试。' })
  })
  return { app, db, notifier }
}
