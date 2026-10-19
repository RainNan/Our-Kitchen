<script setup>
import { useId } from 'vue'
import { Plus, Minus, Send, LoaderCircle } from 'lucide-vue-next'
defineProps({ items: Array, note: String, busy: Boolean, error: String })
const emit = defineEmits(['change', 'update:note', 'submit'])
const noteId = useId()
</script>
<template>
  <div class="cart-scroll">
    <TransitionGroup name="cart-row" tag="div" class="cart-items">
      <div v-for="item in items" :key="item.id" class="cart-row">
        <div><strong>{{ item.name }}</strong><small>{{ item.category || '家常菜' }}</small></div>
        <div class="quantity compact">
          <button :aria-label="`减少${item.name}`" :disabled="busy" @click="emit('change', item.id, -1)"><Minus aria-hidden="true" :size="16" /></button>
          <Transition name="count" mode="out-in"><span :key="item.quantity">{{ item.quantity }}</span></Transition>
          <button :aria-label="`增加${item.name}`" :disabled="busy || item.quantity >= 9" @click="emit('change', item.id, 1)"><Plus aria-hidden="true" :size="16" /></button>
        </div>
      </div>
    </TransitionGroup>
    <p v-if="!items.length" class="cart-empty-copy">清单空了，关掉窗口再选几道菜吧。</p>
    <div class="cart-options"><label :for="noteId">备注</label><textarea :id="noteId" :value="note" maxlength="300" rows="2" :disabled="busy" @input="emit('update:note', $event.target.value)"></textarea><small class="note-count">{{ note.length }}/300</small></div>
    <Transition name="feedback"><p v-if="error" class="form-error" role="alert">{{ error }}</p></Transition>
  </div>
  <div class="cart-submit"><div class="cart-total"><span>共 {{ items.length }} 道菜</span><strong>{{ items.reduce((sum, item) => sum + item.quantity, 0) }} 份</strong></div><button class="button primary" :disabled="busy || !items.length" @click="emit('submit')"><LoaderCircle v-if="busy" class="loading-spin" aria-hidden="true" :size="18" /><Send v-else aria-hidden="true" :size="18" />{{ busy ? '下单中…' : '下单' }}</button></div>
</template>
