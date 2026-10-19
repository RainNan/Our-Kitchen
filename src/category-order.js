import { ref, nextTick } from 'vue'

export function moveCategory(names, name, target) {
  const result = [...names]
  const from = result.indexOf(name)
  if (from < 0 || target < 0 || target >= result.length) return result
  result.splice(from, 1)
  result.splice(target, 0, name)
  return result
}

export function useCategoryOrder({ sidebar, categories, categoryOrder, select, persist }) {
  const dragging = ref('')
  const sorting = ref(false)
  const sortMessage = ref('')
  let gesture, timer, frame, suppressClickUntil = 0, disposed = false
  function clearGesture() {
    clearTimeout(timer); cancelAnimationFrame(frame)
    document.removeEventListener('touchmove', move)
    document.removeEventListener('touchend', end)
    document.removeEventListener('touchcancel', cancelDrag)
    window.removeEventListener('blur', cancelDrag)
    dragging.value = ''; gesture = undefined
  }
  function cancelDrag() {
    if (gesture && dragging.value) {
      categoryOrder.value = gesture.before
      suppressClickUntil = Date.now() + 600
      sortMessage.value = '已取消排序'
    }
    clearGesture()
  }
  function reorderAt(y) {
    if (!gesture || !dragging.value) return
    const buttons = [...sidebar.value.querySelectorAll('[data-category]')]
    const target = buttons.findIndex(button => y < button.getBoundingClientRect().bottom)
    categoryOrder.value = moveCategory(categories.value, dragging.value, target < 0 ? buttons.length - 1 : target)
  }
  function autoScroll() {
    if (!gesture || !dragging.value || !sidebar.value) return
    const bounds = sidebar.value.getBoundingClientRect()
    const y = gesture.y
    const delta = y < bounds.top + 40 ? -5 : y > bounds.bottom - 40 ? 5 : 0
    if (delta) { sidebar.value.scrollTop += delta; reorderAt(y) }
    frame = requestAnimationFrame(autoScroll)
  }
  function touchStart(name, event) {
    if (sorting.value || event.touches.length !== 1) { cancelDrag(); return }
    cancelDrag()
    const touch = event.touches[0]
    gesture = { name, id: touch.identifier, x: touch.clientX, y: touch.clientY, startY: touch.clientY, before: [...categories.value] }
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', end)
    document.addEventListener('touchcancel', cancelDrag)
    window.addEventListener('blur', cancelDrag)
    timer = setTimeout(() => {
      if (!gesture) return
      dragging.value = name
      sortMessage.value = `正在移动${name}，松开保存`
      frame = requestAnimationFrame(autoScroll)
    }, 400)
  }
  function move(event) {
    if (!gesture) return
    if (event.touches.length !== 1) { cancelDrag(); return }
    const touch = [...event.touches].find(t => t.identifier === gesture.id)
    if (!touch) { cancelDrag(); return }
    if (!dragging.value) {
      if (Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.startY) > 8) clearGesture()
      return
    }
    if (event.cancelable) event.preventDefault()
    gesture.y = touch.clientY
    reorderAt(touch.clientY)
  }
  async function save(before, name) {
    const order = [...categories.value]
    if (JSON.stringify(before) === JSON.stringify(order)) { sortMessage.value = '分类顺序未改变'; return }
    sorting.value = true
    try {
      const saved = await persist(order)
      if (!disposed) { categoryOrder.value = saved; sortMessage.value = `${name}已移至第${saved.indexOf(name) + 1}个分类，顺序已保存` }
    } catch (error) {
      if (!disposed) { categoryOrder.value = before; sortMessage.value = `排序未保存：${error.message}` }
    } finally { sorting.value = false }
  }
  function end(event) {
    if (!gesture || ![...event.changedTouches].some(t => t.identifier === gesture.id)) return
    const before = gesture.before, name = gesture.name, active = Boolean(dragging.value)
    if (active) suppressClickUntil = Date.now() + 600
    clearGesture()
    if (active) save(before, name)
  }
  function categoryClick(name, event) {
    if (Date.now() < suppressClickUntil || dragging.value || sorting.value) { event.preventDefault(); return }
    select(name)
  }
  async function categoryKey(name, event) {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    if (sorting.value || dragging.value) return
    const before = [...categories.value]
    const target = before.indexOf(name) + (event.key === 'ArrowUp' ? -1 : 1)
    categoryOrder.value = moveCategory(before, name, target)
    await save(before, name)
    if (!disposed) {
      await nextTick()
      ;[...sidebar.value.querySelectorAll('[data-category]')].find(button => button.dataset.category === name)?.focus()
    }
  }
  return { dragging, sorting, sortMessage, touchStart, categoryClick, categoryKey, cancelDrag, dispose() { disposed = true; cancelDrag() } }
}
