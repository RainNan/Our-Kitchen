<script setup>
import { ref, watch, nextTick, onBeforeUnmount, useId } from 'vue'
import { X } from 'lucide-vue-next'
const props = defineProps({ open: Boolean, title: String, wide: Boolean, sheet: Boolean, busy: Boolean })
const emit = defineEmits(['close', 'closed'])
const dialog = ref()
const closing = ref(false)
const id = useId()
let closeTimer
let revision = 0
let restoreFocus
let ownsLock = false
let backdropPressed = false
function lock() {
  if (ownsLock) return
  ownsLock = true
  if (!document.querySelector('dialog[data-scroll-lock]')) document.body.dataset.dialogOverflow = document.body.style.overflow
  dialog.value.dataset.scrollLock = ''
  document.body.style.overflow = 'hidden'
}
function unlock() {
  if (!ownsLock) return
  ownsLock = false
  delete dialog.value.dataset.scrollLock
  if (!document.querySelector('dialog[data-scroll-lock]')) {
    document.body.style.overflow = document.body.dataset.dialogOverflow || ''
    delete document.body.dataset.dialogOverflow
  }
}
function finishClose() {
  clearTimeout(closeTimer)
  if (!dialog.value?.open) return
  dialog.value.close()
  closing.value = false
  unlock()
  if (!document.querySelector('dialog[open]') && restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true })
  emit('closed')
}
function requestClose() { if (!props.busy) emit('close') }
function outside(event) {
  const rect = dialog.value.getBoundingClientRect()
  return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
}
watch(() => props.open, async value => {
  const current = ++revision
  clearTimeout(closeTimer)
  await nextTick()
  if (current !== revision || !dialog.value) return
  if (value) {
    closing.value = false
    if (!dialog.value.open) {
      restoreFocus = document.activeElement
      dialog.value.showModal()
      lock()
    }
  } else if (dialog.value.open) {
    closing.value = true
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) finishClose()
    else closeTimer = setTimeout(finishClose, 240)
  }
}, { immediate: true })
onBeforeUnmount(() => { revision++; clearTimeout(closeTimer); dialog.value?.close(); unlock() })
</script>
<template>
  <dialog ref="dialog" :class="['modal', { wide, sheet, closing }]" :aria-labelledby="id" :aria-busy="busy || undefined" @cancel.prevent="requestClose" @pointerdown="backdropPressed = outside($event)" @click="backdropPressed && outside($event) && requestClose()" @animationend="closing && $event.target === dialog && finishClose()">
    <header class="modal-header"><h2 :id="id">{{ title }}</h2><button class="icon-button" :disabled="busy" aria-label="关闭窗口" @click="requestClose"><X aria-hidden="true" :size="20" /></button></header>
    <slot />
  </dialog>
</template>
