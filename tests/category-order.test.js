import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { useCategoryOrder } from '../src/category-order.js'

function harness(t, persist = async order => order) {
  const listeners = new Map(), frames = new Map()
  const document = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) }
  const globals = ['document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame']
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: undefined })
  globalThis.document = document
  globalThis.window = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) }
  let id = 0
  globalThis.requestAnimationFrame = fn => { frames.set(++id, fn); return id }
  globalThis.cancelAnimationFrame = id => frames.delete(id)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const categoryOrder = ref(['荤菜', '素菜', '汤羹'])
  const sidebar = ref({ scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 200 }), querySelectorAll: () => categoryOrder.value.map((name, i) => ({ dataset: { category: name }, getBoundingClientRect: () => ({ top: i * 50, bottom: (i + 1) * 50 }), focus() {} })) })
  const selected = [], saved = []
  const state = useCategoryOrder({ sidebar, categoryOrder, categories: categoryOrder, select: name => selected.push(name), persist: async order => { saved.push(order); return persist(order) } })
  const touch = (x, y) => ({ identifier: 1, clientX: x, clientY: y })
  const start = name => state.touchStart(name, { touches: [touch(10, 25)] })
  let prevented = false
  const move = (x, y) => listeners.get('touchmove')?.({ touches: [touch(x, y)], cancelable: true, preventDefault() { prevented = true } })
  const end = () => listeners.get('touchend')?.({ changedTouches: [touch(10, 125)] })
  t.after(() => { state.dispose(); for (const key of globals) delete globalThis[key] })
  return { state, listeners, frames, categoryOrder, sidebar, selected, saved, start, move, end, prevented: () => prevented }
}

test('touch scroll before hold cancels drag and does not block scrolling', t => {
  const h = harness(t)
  h.start('荤菜'); h.move(10, 34)
  t.mock.timers.tick(500)
  assert.equal(h.state.dragging.value, '')
  assert.equal(h.prevented(), false)
  assert.equal(h.listeners.has('touchmove'), false)
  assert.equal(h.saved.length, 0)
})

test('400ms hold reorders, scrolls edges, saves once and suppresses accidental click', async t => {
  const h = harness(t)
  h.start('荤菜'); t.mock.timers.tick(399)
  assert.equal(h.state.dragging.value, '')
  t.mock.timers.tick(1)
  assert.equal(h.state.dragging.value, '荤菜')
  h.move(10, 195)
  assert.equal(h.prevented(), true)
  const tick = [...h.frames.values()][0]; tick()
  assert.equal(h.sidebar.value.scrollTop, 5)
  assert.deepEqual(h.categoryOrder.value, ['素菜', '汤羹', '荤菜'])
  h.end()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(h.saved.length, 1)
  h.state.categoryClick('荤菜', { preventDefault() {} })
  assert.deepEqual(h.selected, [])
  assert.match(h.state.sortMessage.value, /顺序已保存/)
  assert.equal(h.listeners.size, 0)
})

test('touch cancellation restores order and clears listeners without saving', t => {
  const h = harness(t)
  h.start('荤菜'); t.mock.timers.tick(400); h.move(10, 125)
  h.listeners.get('touchcancel')()
  assert.deepEqual(h.categoryOrder.value, ['荤菜', '素菜', '汤羹'])
  assert.equal(h.saved.length, 0)
  assert.equal(h.listeners.size, 0)
  assert.equal(h.frames.size, 0)
})

test('keyboard save failure restores order and reports actionable error', async t => {
  const h = harness(t, async () => { throw new Error('连接失败') })
  await h.state.categoryKey('荤菜', { altKey: true, key: 'ArrowDown', preventDefault() {} })
  assert.deepEqual(h.categoryOrder.value, ['荤菜', '素菜', '汤羹'])
  assert.match(h.state.sortMessage.value, /排序未保存：连接失败/)
  assert.equal(h.state.sorting.value, false)
})

test('pending save blocks further gestures and keyboard writes', async t => {
  let resolve
  const h = harness(t, () => new Promise(done => { resolve = done }))
  const pending = h.state.categoryKey('荤菜', { altKey: true, key: 'ArrowDown', preventDefault() {} })
  assert.equal(h.state.sorting.value, true)
  h.start('汤羹'); t.mock.timers.tick(500)
  await h.state.categoryKey('汤羹', { altKey: true, key: 'ArrowUp', preventDefault() {} })
  assert.equal(h.state.dragging.value, '')
  assert.equal(h.saved.length, 1)
  resolve(['素菜', '荤菜', '汤羹']); await pending
})
