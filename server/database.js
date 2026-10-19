import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { digest } from './security.js'

export function openDatabase(config) {
  mkdirSync(config.dataDir, { recursive: true })
  mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true })
  const db = new DatabaseSync(path.join(config.dataDir, 'kitchen.sqlite'))
  db.exec(`PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dishes (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '',
      ingredients TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '',
      sales_count INTEGER NOT NULL DEFAULT 0, liked INTEGER NOT NULL DEFAULT 0,
      minutes INTEGER NOT NULL DEFAULT 20, available INTEGER NOT NULL DEFAULT 1,
      featured INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, role TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, idempotency TEXT NOT NULL, request_hash TEXT NOT NULL,
      items TEXT NOT NULL, note TEXT NOT NULL, preferences TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received',
      created INTEGER NOT NULL, notification TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_retry INTEGER NOT NULL DEFAULT 0, UNIQUE(owner, idempotency)
    );
    CREATE INDEX IF NOT EXISTS orders_created ON orders(created);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, event TEXT NOT NULL, created INTEGER NOT NULL);
  `)
  // Remove legacy network identifiers atomically, then purge freed pages and WAL.
  const legacyNetwork = db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'ip_hash') ||
    db.prepare('PRAGMA table_info(audit)').all().some(c => c.name === 'ip_label') ||
    Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name='trusted_ips'").get())
  if (legacyNetwork) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec("DELETE FROM sessions; DROP TABLE IF EXISTS trusted_ips; DELETE FROM rate_limits WHERE key NOT LIKE '%:global';")
      db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('network_cleanup_pending','1')").run()
      if (db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'ip_hash')) db.exec('ALTER TABLE sessions DROP COLUMN ip_hash')
      if (db.prepare('PRAGMA table_info(audit)').all().some(c => c.name === 'ip_label')) db.exec('ALTER TABLE audit DROP COLUMN ip_label')
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error }
  }
  if (db.prepare("SELECT value FROM metadata WHERE key='network_cleanup_pending'").get()) {
    for (const sql of ['PRAGMA wal_checkpoint(TRUNCATE)', 'VACUUM', 'PRAGMA wal_checkpoint(TRUNCATE)']) {
      const result = sql === 'VACUUM' ? (db.exec(sql), undefined) : db.prepare(sql).get()
      if (result?.busy) { db.close(); throw new Error('数据库正在使用，完成旧网络记录清理后才能启动。') }
    }
    db.prepare("DELETE FROM metadata WHERE key='network_cleanup_pending'").run()
  }
  db.exec('CREATE TABLE IF NOT EXISTS category_order (name TEXT PRIMARY KEY, position INTEGER NOT NULL)')
  // Additive migration: keep every existing dish, order and identifier intact.
  if (!db.prepare('PRAGMA table_info(dishes)').all().some(column => column.name === 'ingredients')) {
    db.exec("ALTER TABLE dishes ADD COLUMN ingredients TEXT NOT NULL DEFAULT ''")
  }
  if (!db.prepare('PRAGMA table_info(dishes)').all().some(column => column.name === 'instructions')) {
    db.exec("ALTER TABLE dishes ADD COLUMN instructions TEXT NOT NULL DEFAULT ''")
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(dishes)').all().map(column => column.name))
    if (!columns.has('sales_count')) db.exec('ALTER TABLE dishes ADD COLUMN sales_count INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('liked')) db.exec('ALTER TABLE dishes ADD COLUMN liked INTEGER NOT NULL DEFAULT 0')
    if (!db.prepare("SELECT value FROM metadata WHERE key='sales_backfilled_v1'").get()) {
      db.exec(`UPDATE dishes SET sales_count=(
        SELECT COUNT(DISTINCT orders.id) FROM orders, json_each(orders.items) AS item
        WHERE json_extract(item.value, '$.id')=dishes.id
      )`)
      db.prepare("INSERT INTO metadata(key,value) VALUES ('sales_backfilled_v1','1')").run()
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error }
  const fingerprint = digest(config.secret + config.adminHash + config.answerHash)
  const previous = db.prepare("SELECT value FROM metadata WHERE key = 'auth_fingerprint'").get()
  if (previous?.value !== fingerprint) {
    db.exec('DELETE FROM sessions;')
    db.prepare("INSERT INTO metadata(key,value) VALUES ('auth_fingerprint',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(fingerprint)
  }
  // Only the explicit loopback demo is seeded; production starts with an empty menu.
  if (config.demo && !db.prepare("SELECT value FROM metadata WHERE key='seeded'").get()) {
    const dishes = [
      ['糖醋排骨', '酸酸甜甜，连汤汁都想拌进米饭里。', '荤菜', 'ribs.webp', '拿手好菜', 40, 1],
      ['红烧肉', '小火慢炖的软糯，是认真做饭的味道。', '荤菜', 'pork.webp', '下饭必备', 60, 1],
      ['蒜香黄油虾', '虾的鲜甜，配一点恰到好处的蒜香。', '荤菜', 'shrimp.webp', '鲜香', 20, 0],
      ['麻婆豆腐', '滑嫩豆腐裹着酱汁，微辣也很满足。', '素菜', 'tofu.webp', '微辣', 20, 0],
      ['玉米排骨汤', '一碗热汤，把今天的疲惫都暖化。', '汤羹', 'soup.webp', '暖胃', 50, 0],
      ['空气炸锅鸡翅', '外皮焦香，里面还留着满满的肉汁。', '荤菜', 'wings.webp', '人气之选', 25, 0],
      ['巴斯克芝士蛋糕', '留一点胃口，吃今天的甜蜜收尾。', '甜点', 'cake.webp', '甜蜜收尾', 45, 0],
      ['百香果橙子气泡水', '清清爽爽的小气泡，快乐加一杯。', '饮品', 'drink.webp', '清爽', 5, 0],
    ]
    const insert = db.prepare('INSERT INTO dishes(name,description,category,image,tag,minutes,featured,position) VALUES (?,?,?,?,?,?,?,?)')
    dishes.forEach((dish, index) => insert.run(...dish, index))
    db.prepare("INSERT INTO metadata VALUES ('seeded','1')").run()
  }
  return db
}

export function dishJson(row) {
  const { sales_count, ...dish } = row
  return { ...dish, salesCount: sales_count, liked: Boolean(row.liked), available: Boolean(row.available), featured: Boolean(row.featured), image: row.image ? `/media/${row.image}` : '' }
}
export function orderJson(row) {
  return { id: row.id, items: JSON.parse(row.items), note: row.note, preferences: JSON.parse(row.preferences), status: row.status, created: row.created, notification: row.notification, attempts: row.attempts }
}
