import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMotion } from '../src/motion.js'

function environment(t, reduced = false) {
  const listeners = new Map()
  const query = { matches: reduced, addEventListener: (name, callback) => listeners.set(`media:${name}`, callback), removeEventListener: name => listeners.delete(`media:${name}`) }
  const children = []
  const animations = []
  const element = () => ({
    style: {}, classList: { add() {} }, setAttribute() {}, append() {}, showPopover() {},
    isConnected: true, getBoundingClientRect: () => ({ left: 20, top: 20, width: 80, height: 80 }),
    querySelector: () => null,
    remove() { this.isConnected = false; const index = children.indexOf(this); if (index >= 0) children.splice(index, 1) },
    animate() {
      let resolve, reject
      const finished = new Promise((ok, fail) => { resolve = ok; reject = fail })
      const animation = { finished, cancelled: false, complete: resolve, cancel() { this.cancelled = true; reject(new Error('cancelled')) } }
      animations.push(animation)
      return animation
    },
  })
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  globalThis.window = { matchMedia: () => query, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) }
  globalThis.document = { createElement: element, body: { append: node => children.push(node) } }
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete globalThis.window
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document
  })
  return { listeners, query, children, animations, element }
}

test('reduced motion skips flights and pulses and runtime preference changes cancel existing motion', async t => {
  const env = environment(t, true)
  const motion = createMotion()
  const source = env.element(), target = env.element()
  motion.pulse(target); motion.fly(source, target)
  assert.equal(env.animations.length, 0); assert.equal(env.children.length, 0)
  env.query.matches = false
  motion.fly(source, target)
  assert.equal(env.children.length, 1)
  env.query.matches = true
  env.listeners.get('media:change')()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(env.children.length, 0); assert.equal(env.animations[0].cancelled, true)
  motion.dispose(); assert.equal(env.listeners.size, 0)
})

test('rapid clicks interrupt pulses; scroll and disposal remove every temporary flight', async t => {
  const env = environment(t)
  const motion = createMotion()
  const source = env.element(), target = env.element()
  motion.pulse(target); motion.pulse(target)
  assert.equal(env.animations[0].cancelled, true)
  motion.fly(source, target); motion.fly(source, target)
  assert.equal(env.children.length, 2)
  env.listeners.get('scroll')()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(env.children.length, 0)
  motion.fly(source, target)
  env.animations.at(-1).complete()
  await Promise.resolve()
  assert.equal(env.children.length, 0)
  motion.fly(source, target)
  motion.dispose()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(env.children.length, 0); assert.equal(env.listeners.size, 0)
})
