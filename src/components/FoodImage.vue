<script setup>
import { ref, watch } from 'vue'
import { CookingPot } from 'lucide-vue-next'
import { imagePath } from '../api'
const props = defineProps({ src: String, alt: String, eager: Boolean })
const failed = ref(false)
watch(() => props.src, () => { failed.value = false })
</script>
<template>
  <img v-if="src && !failed" :src="imagePath(src)" :alt="alt" :loading="eager ? 'eager' : 'lazy'" decoding="async" @error="failed = true" />
  <div v-else class="food-placeholder" role="img" :aria-label="`${alt || '菜品'}，暂无照片`"><CookingPot aria-hidden="true" :size="36" /><span>等一张好吃的照片</span></div>
</template>
