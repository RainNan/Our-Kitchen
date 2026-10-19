<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { Heart, Search, Plus, Minus, Clock3, ShoppingBag, ArrowRight, Utensils, Check, CookingPot, RefreshCw, ChefHat } from 'lucide-vue-next'
import { api, post } from '../api'
import { createMotion } from '../motion'
import { useCategoryOrder } from '../category-order'
import FoodImage from './FoodImage.vue'
import CartPanel from './CartPanel.vue'
import Modal from './Modal.vue'

const dishes = ref([])
const loading = ref(true)
const loadError = ref('')
const search = ref('')
const filterMode = ref('all')
const category = ref('')
const liking = ref(new Set())
const likeError = ref('')
const refreshError = ref('')
const draft = ref({ quantities: {}, note: '', pending: null })
const cartOpen = ref(false)
const cartTarget = ref()
const detail = ref(null)
const detailOpen = ref(false)
const detailContent = ref(null)
const busy = ref(false)
const submitError = ref('')
const confirmation = ref(null)
const confirmationOpen = ref(false)
const pendingConfirmation = ref(null)
const toast = ref('')
const motion = createMotion()
let toastTimer
let disposed = false
let menuRevision = 0
let likeRevision = 0
const sidebar = ref(null)
const categoryOrder = ref([])
const categories = computed(() => {
  const available = [...new Set(dishes.value.map(x => x.category || '未分类'))]
  return [...categoryOrder.value.filter(x => available.includes(x)), ...available.filter(x => !categoryOrder.value.includes(x))]
})
const { dragging, sorting, sortMessage, touchStart, categoryClick, categoryKey, cancelDrag, dispose: disposeSorting } = useCategoryOrder({ sidebar, categories, categoryOrder, select: item => selectCategory('category', item), persist: order => api('/api/menu/categories/order', { method: 'PUT', body: JSON.stringify(order) }) })
const likedCount = computed(() => dishes.value.filter(d => d.liked).length)
const filtered = computed(() => dishes.value.filter(d => (filterMode.value === 'all' || (filterMode.value === 'liked' ? d.liked : (d.category || '未分类') === category.value)) && `${d.name} ${d.description} ${d.category}`.includes(search.value.trim())))
const cartItems = computed(() => dishes.value.filter(x => draft.value.quantities[x.id] > 0).map(x => ({ ...x, quantity: draft.value.quantities[x.id] })))
const total = computed(() => cartItems.value.reduce((n, x) => n + x.quantity, 0))
const heroDish = computed(() => dishes.value.find(x => x.featured && x.image) || dishes.value.find(x => x.image))
function readStorage(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback } }
function showToast(message) { toast.value = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.value = '' }, 3500) }
function saveDraft() { try { localStorage.setItem('kitchen-draft', JSON.stringify(draft.value)) } catch { /* Private modes may block storage. */ } }
watch(draft, saveDraft, { deep: true })
async function loadMenu(background = false) {
  background = background === true
  const revision = ++menuRevision
  const likesAtStart = likeRevision
  if (!background) { loading.value = true; loadError.value = '' }
  refreshError.value = ''
  try {
    const [menu, order] = await Promise.all([api('/api/menu'), api('/api/menu/categories')])
    if (disposed || revision !== menuRevision) return
    cancelDrag()
    if (!sorting.value) categoryOrder.value = order
    loadError.value = ''
    const current = new Map(dishes.value.map(d => [d.id, d]))
    dishes.value = menu.map(d => ({ ...d, liked: current.has(d.id) && (likesAtStart !== likeRevision || liking.value.has(d.id)) ? current.get(d.id).liked : d.liked }))
    if (detail.value) detail.value = dishes.value.find(d => d.id === detail.value.id) || detail.value
    const ids = new Set(dishes.value.map(d => String(d.id)))
    const before = Object.keys(draft.value.quantities).length
    draft.value.quantities = Object.fromEntries(Object.entries(draft.value.quantities).filter(([id]) => ids.has(id)))
    if (Object.keys(draft.value.quantities).length < before) showToast('已移除当前下架的菜品，请再确认一次清单。')
    if (filterMode.value === 'category' && !categories.value.includes(category.value)) filterMode.value = 'all'
  } catch (error) {
    if (!disposed && revision === menuRevision) {
      if (background) refreshError.value = error.message
      else loadError.value = error.message
    }
  } finally { if (!disposed && revision === menuRevision) loading.value = false }
}
function refreshOnFocus() { if (!sorting.value && !dragging.value && !loading.value && !busy.value && !liking.value.size) loadMenu(true) }
async function toggleLike(dish) {
  if (liking.value.has(dish.id)) return
  liking.value.add(dish.id); likeRevision++; likeError.value = ''
  try {
    const result = await api(`/api/menu/${dish.id}/like`, { method: 'PUT', body: JSON.stringify({ liked: !dish.liked }) })
    if (disposed) return
    const current = dishes.value.find(d => d.id === result.id)
    if (current) current.liked = result.liked
    likeRevision++
    if (filterMode.value === 'liked' && !result.liked) {
      await nextTick()
      document.querySelector('.category-sidebar .category.selected')?.focus()
    }
  } catch (error) { if (!disposed) likeError.value = error.message }
  finally { liking.value.delete(dish.id) }
}
async function change(id, delta, event) {
  if (busy.value) return
  const before = draft.value.quantities[id] || 0
  const quantity = Math.max(0, Math.min(9, before + delta))
  if (before === quantity) return
  if (delta > 0 && (total.value >= 30 || (!before && cartItems.value.length >= 20))) { showToast('一份清单最多选20道菜、共30份。'); return }
  const button = event?.currentTarget
  const source = button?.closest('.dish-card')?.querySelector('.dish-photo') || detailContent.value?.querySelector('.detail-photo')
  if (quantity) draft.value.quantities[id] = quantity
  else delete draft.value.quantities[id]
  submitError.value = ''
  if (button) motion.pulse(button)
  if (delta > 0 && source) {
    await nextTick()
    if (!disposed && total.value) motion.fly(source, cartTarget.value)
  }
}
function selectCategory(mode, value = '') { motion.cancelAll(); filterMode.value = mode; category.value = value }
function showAll() { search.value = ''; selectCategory('all') }
async function submit() {
  if (busy.value || !cartItems.value.length) return
  if (total.value > 30) { submitError.value = '一份清单最多选择30份菜。'; return }
  busy.value = true; submitError.value = ''; motion.cancelAll()
  const body = { items: cartItems.value.map(x => ({ id: x.id, quantity: x.quantity })), note: draft.value.note, preferences: [] }
  const fingerprint = JSON.stringify(body)
  if (draft.value.pending?.fingerprint !== fingerprint) draft.value.pending = { fingerprint, key: crypto.randomUUID() }
  saveDraft()
  try {
    const result = await post('/api/orders', { ...body, idempotency: draft.value.pending.key })
    pendingConfirmation.value = result
    cartOpen.value = false
    loadMenu(true)
  } catch (error) { submitError.value = error.message } finally { busy.value = false }
}
function cartClosed() {
  motion.cancelAll()
  if (pendingConfirmation.value) {
    confirmation.value = pendingConfirmation.value
    confirmationOpen.value = true
    pendingConfirmation.value = null
    draft.value = { quantities: {}, note: '', pending: null }
  }
}
function closeCart() { if (!busy.value) { motion.cancelAll(); cartOpen.value = false } }
function openDetail(dish) { detail.value = dish; detailOpen.value = true }
function closeDetail() { motion.cancelAll(); detailOpen.value = false }
function scrollToMenu() { document.getElementById('menu-start')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }
onMounted(() => {
  const stored = readStorage('kitchen-draft', {})
  if (stored && typeof stored === 'object') {
    const quantities = stored.quantities && typeof stored.quantities === 'object' ? Object.fromEntries(Object.entries(stored.quantities).filter(([id, q]) => /^\d+$/.test(id) && Number.isInteger(q) && q > 0 && q <= 9).slice(0, 20)) : {}
    draft.value = { quantities, note: typeof stored.note === 'string' ? stored.note.slice(0, 300) : '', pending: stored.pending && typeof stored.pending.key === 'string' && typeof stored.pending.fingerprint === 'string' ? stored.pending : null }
  }
  loadMenu()
  window.addEventListener('focus', refreshOnFocus)
})
onBeforeUnmount(() => { disposed = true; disposeSorting(); window.removeEventListener('focus', refreshOnFocus); clearTimeout(toastTimer); motion.dispose() })
</script>

<template>
  <main :class="['kitchen-main', 'menu-redesign', { 'has-cart': total > 0 }]">
    <section class="hero">
      <div class="hero-copy"><span class="welcome-pill"><span></span>今天也要好好吃饭</span><h1>今天，想吃点什么？</h1><p>菜单给你，围裙给我。<br />选好喜欢的菜，等一顿为你做的饭。</p><button class="hero-link" @click="scrollToMenu">看看今天的菜单<ArrowRight aria-hidden="true" :size="17" /></button></div>
      <div class="hero-table" aria-hidden="true"><span class="hero-orbit"></span><div class="hero-plate"><FoodImage v-if="heroDish" :src="heroDish.image" :alt="heroDish.name" eager /><Utensils aria-hidden="true" v-else :size="75" /></div><div class="love-note"><Heart aria-hidden="true" :size="15" />只为你开的小厨房</div><span class="hero-spark spark-one">✧</span><span class="hero-spark spark-two">✧</span></div>
    </section>
    <div id="menu-start" class="menu-layout">
      <nav ref="sidebar" class="category-sidebar" aria-label="菜品分类" :aria-busy="sorting" @contextmenu="dragging && $event.preventDefault()">
        <button :class="['category', { selected: filterMode === 'all' }]" :aria-pressed="filterMode === 'all'" @click="selectCategory('all')"><span>全部菜品</span><small>{{ dishes.length }}</small></button>
        <button :class="['category', { selected: filterMode === 'liked' }]" :aria-pressed="filterMode === 'liked'" @click="selectCategory('liked')"><span>我喜欢</span><small>{{ likedCount }}</small></button>
        <hr class="category-divider" /><span class="sr-only" role="status" aria-live="polite">{{ sortMessage }}</span><span id="category-key-help" class="sr-only">按 Alt 加上下方向键调整分类顺序。</span>
        <button v-for="item in categories" :key="item" :data-category="item" aria-describedby="category-key-help" :class="['category', { dragging: dragging === item, selected: filterMode === 'category' && category === item }]" :aria-pressed="filterMode === 'category' && category === item" @touchstart.passive="touchStart(item, $event)" @click="categoryClick(item, $event)" @keydown="categoryKey(item, $event)"><span>{{ item }}</span><small>{{ dishes.filter(d => (d.category || '未分类') === item).length }}</small></button>
      </nav>
      <section class="menu-content" aria-label="菜品">
        <div class="menu-toolbar"><label class="search-box"><Search aria-hidden="true" :size="18" /><input v-model="search" type="search" placeholder="找一道想吃的菜" aria-label="搜索菜品" /></label><button class="menu-refresh icon-button" :disabled="loading" aria-label="刷新菜单" title="刷新菜单" @click="loadMenu(true)"><RefreshCw aria-hidden="true" :size="17" /></button></div>
        <p v-if="sortMessage.startsWith('排序未保存')" class="menu-feedback" role="alert">{{ sortMessage }}</p>
        <p v-if="likeError || refreshError" class="menu-feedback" role="alert">{{ likeError || refreshError }}</p>
        <div v-if="loading" class="dish-grid" aria-label="正在加载菜品"><div v-for="n in 6" :key="n" class="dish-skeleton"><div></div><span></span><small></small></div></div>
        <div v-else-if="loadError" class="empty-state"><p role="alert">{{ loadError }}</p><button class="button secondary" @click="loadMenu">重新加载菜单</button></div>
        <div v-else-if="!dishes.length" class="empty-state"><CookingPot aria-hidden="true" :size="42" /><h3>大厨正在准备菜单</h3><p>在厨房后台添加几道拿手菜吧。</p><button class="button secondary" @click="loadMenu"><RefreshCw aria-hidden="true" :size="16" />刷新菜单</button></div>
        <div v-else-if="!filtered.length" class="empty-state"><Heart v-if="filterMode === 'liked' && !likedCount" aria-hidden="true" :size="36" /><Search v-else aria-hidden="true" :size="36" /><h3>{{ filterMode === 'liked' && !likedCount ? '还没有喜欢的菜' : '还没找到这道菜' }}</h3><p>{{ filterMode === 'liked' && !likedCount ? '点一下菜品右上角的心形，记下想吃的菜。' : '换个关键词，或者看看其他分类吧。' }}</p><button class="button secondary" @click="showAll">查看全部菜品</button></div>
        <TransitionGroup v-else name="dish-list" tag="div" class="dish-grid">
          <article v-for="dish in filtered" :key="dish.id" class="dish-card">
            <button :class="['dish-like', { liked: dish.liked }]" :aria-label="`${dish.liked ? '取消喜欢' : '喜欢'}${dish.name}`" :aria-pressed="dish.liked" :disabled="liking.has(dish.id)" :title="dish.liked ? '取消喜欢' : '喜欢'" @click="toggleLike(dish)"><Heart aria-hidden="true" :size="19" :fill="dish.liked ? 'currentColor' : 'none'" /></button>
            <div class="dish-photo"><button class="photo-detail" :aria-label="`查看${dish.name}详情`" @click="openDetail(dish)"><FoodImage :src="dish.image" :alt="dish.name" /></button><span v-if="dish.featured" class="dish-badge"><ChefHat aria-hidden="true" :size="12" />推荐</span></div>
            <div class="dish-body"><button class="dish-name" @click="openDetail(dish)"><h3>{{ dish.name }}</h3></button><p>{{ dish.description || '一道为你准备的家常菜。' }}</p><div class="dish-meta"><span v-if="dish.tag" class="dish-tag">{{ dish.tag }}</span><span class="dish-time"><Clock3 aria-hidden="true" :size="12" />{{ dish.minutes }}分钟</span></div>
              <div class="dish-footer"><span class="dish-sales">销量 {{ dish.salesCount }}</span><div class="quantity"><button v-show="draft.quantities[dish.id]" :aria-label="`减少${dish.name}`" :disabled="busy" @click="change(dish.id, -1, $event)"><Minus aria-hidden="true" :size="16" /></button><Transition name="count" mode="out-in"><span v-if="draft.quantities[dish.id]" :key="draft.quantities[dish.id]">{{ draft.quantities[dish.id] }}</span></Transition><button class="add-button" :aria-label="`${draft.quantities[dish.id] ? '增加' : '添加'}${dish.name}`" :disabled="busy || draft.quantities[dish.id] >= 9" @click="change(dish.id, 1, $event)"><Plus aria-hidden="true" :size="20" /></button></div></div>
            </div>
          </article>
        </TransitionGroup>
        <p v-if="dishes.length && !loading" class="menu-end"><span></span>菜单不大，每一道都认真<span></span></p>
      </section>
    </div>
  </main>
  <Transition name="cart-bar"><button v-if="total > 0" class="cart-bar" :disabled="busy" aria-haspopup="dialog" :aria-expanded="cartOpen" @click="cartOpen = true"><span class="cart-bar-summary"><span ref="cartTarget" class="cart-bag"><ShoppingBag aria-hidden="true" :size="24" /></span><span><strong>今天想吃</strong><span class="cart-bar-count" aria-live="polite">{{ cartItems.length }}道菜 · {{ total }}份</span></span></span><span class="cart-bar-action">去下单<ArrowRight aria-hidden="true" :size="20" /></span></button></Transition>
  <Modal :open="cartOpen" title="今天想吃" sheet :busy="busy" @close="closeCart" @closed="cartClosed"><CartPanel :items="cartItems" v-model:note="draft.note" :busy="busy" :error="submitError" @change="change" @submit="submit" /></Modal>
  <Modal :open="detailOpen" :title="detail?.name || '菜品详情'" @close="closeDetail" @closed="detail = null"><div v-if="detail" ref="detailContent"><div class="detail-photo"><FoodImage class="detail-image" :src="detail.image" :alt="detail.name" eager /></div><p class="detail-description">{{ detail.description || '一道为你准备的家常菜。' }}</p><div class="detail-meta"><span>{{ detail.category || '未分类' }}</span><span><Clock3 aria-hidden="true" :size="15" />大约{{ detail.minutes }}分钟</span></div><button class="button primary full" :disabled="busy || (draft.quantities[detail.id] || 0) >= 9" @click="change(detail.id, 1, $event)"><Plus aria-hidden="true" :size="18" />加入今天想吃<span v-if="draft.quantities[detail.id]">（{{ draft.quantities[detail.id] }}份）</span></button></div></Modal>
  <Modal :open="confirmationOpen" title="清单已经送到厨房" @close="confirmationOpen = false" @closed="confirmation = null"><template v-if="confirmation"><div class="success-symbol"><Check aria-hidden="true" :size="30" /></div><h3 class="success-title">想吃的，记在心里了。</h3><p class="success-copy">{{ confirmation.items.map(x => `${x.name} × ${x.quantity}`).join('、') }}</p><p class="success-hint">{{ confirmation.notification === 'unconfigured' ? '清单已保存。大厨可以在后台查看，微信提醒尚未开启。' : '清单已保存，厨房正在发送微信提醒。' }}</p><small class="success-order">{{ confirmation.id }}</small><button class="button primary full" @click="confirmationOpen = false">继续选菜</button></template></Modal>
  <Transition name="feedback"><div v-if="toast" class="toast" role="status"><Check aria-hidden="true" :size="17" />{{ toast }}</div></Transition>
</template>
