<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount, useId } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

const props = defineProps({ modelValue: { type: String, default: '' }, categories: { type: Array, default: () => [] }, disabled: Boolean })
const emit = defineEmits(['update:modelValue'])
const id = useId()
const root = ref(null)
const input = ref(null)
const editing = ref(false)
const open = ref(false)
const active = ref(-1)
const options = computed(() => ['', ...props.categories])
function openList() {
  open.value = true
  active.value = Math.max(0, options.value.indexOf(props.modelValue))
}
async function activate() {
  if (props.disabled || editing.value) return
  if (!open.value) openList()
  else {
    open.value = false; editing.value = true
    await nextTick()
    input.value?.focus()
  }
}
function choose(value) { emit('update:modelValue', value); open.value = false; input.value?.focus() }
async function returnToList() {
  editing.value = false; open.value = false
  await nextTick()
  input.value?.focus()
  openList()
}
function keydown(event) {
  if (event.key === 'Escape' && open.value) { event.preventDefault(); event.stopPropagation(); open.value = false; return }
  if (editing.value || props.disabled) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!open.value) openList()
    else active.value = (active.value + (event.key === 'ArrowDown' ? 1 : -1) + options.value.length) % options.value.length
    nextTick(() => document.getElementById(`${id}-option-${active.value}`)?.scrollIntoView({ block: 'nearest' }))
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (open.value && active.value >= 0) choose(options.value[active.value])
    else activate()
  } else if (event.key === 'Tab') open.value = false
}
function outside(event) { if (!root.value?.contains(event.target)) open.value = false }
function focusout(event) { if (!root.value?.contains(event.relatedTarget)) open.value = false }
onMounted(() => document.addEventListener('pointerdown', outside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside))
</script>

<template>
  <div ref="root" class="category-picker" @focusout="focusout">
    <label :for="`${id}-input`">分类（可留空）</label>
    <div class="category-picker-field">
      <input :id="`${id}-input`" ref="input" :value="modelValue" :readonly="!editing" :disabled="disabled" maxlength="20" :placeholder="editing ? '输入新分类' : '点击选择已有分类'" :role="editing ? undefined : 'combobox'" :aria-expanded="editing ? undefined : open" :aria-controls="editing ? undefined : `${id}-list`" :aria-activedescendant="open && active >= 0 ? `${id}-option-${active}` : undefined" :aria-describedby="`${id}-hint`" :aria-autocomplete="editing ? undefined : 'none'" @input="emit('update:modelValue', $event.target.value)" @click="activate" @keydown="keydown" />
      <ChevronDown v-if="!editing" aria-hidden="true" :size="16" />
    </div>
    <div v-if="open && !disabled" :id="`${id}-list`" class="category-picker-list" role="listbox" aria-label="已有分类">
      <div v-for="(option, index) in options" :id="`${id}-option-${index}`" :key="option" role="option" :aria-selected="modelValue === option" :class="{ active: active === index }" @pointerdown.prevent @click.stop="choose(option)">{{ option || '不分类' }}</div>
      <p v-if="!categories.length">暂无已有分类，再点分类框输入新分类。</p>
    </div>
    <small :id="`${id}-hint`" class="category-picker-hint">{{ editing ? '正在输入新分类，最多20字' : '再点分类框可输入新分类' }}</small>
    <button v-if="editing" type="button" class="text-button category-picker-return" :disabled="disabled" @click="returnToList">选择已有分类</button>
  </div>
</template>
