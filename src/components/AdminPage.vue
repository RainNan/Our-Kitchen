<script setup>
import { ref, computed, onMounted } from 'vue'
import { Plus, Pencil, Trash2, ImagePlus, ChefHat, ClipboardList, ShieldCheck, Check, RefreshCw, Bell, Eye, EyeOff } from 'lucide-vue-next'
import { api, post } from '../api'
import FoodImage from './FoodImage.vue'
import Modal from './Modal.vue'
import CategoryPicker from './CategoryPicker.vue'
const tab = ref('dishes')
const dishes = ref([])
const orders = ref([])
const security = ref({ events: [], notificationConfigured: false })
const loading = ref(true)
const error = ref('')
const formError = ref('')
const saving = ref(false)
const uploading = ref(false)
const editing = ref(false)
const editingId = ref(null)
const draft = ref({})
const pendingDelete = ref(null)
const pendingRevoke = ref(null)
const busyAction = ref('')
const toast = ref('')
const categories = computed(() => [...new Set(dishes.value.map(x => x.category).filter(Boolean))])
const statusText = { received: '已收到', cooking: '正在做饭', done: '已完成' }
const notifyText = { pending: '等待发送', retrying: '正在重试', sent: '提醒已发送', failed: '发送失败', unconfigured: '尚未配置微信' }
const dateText = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
function editableDish(dish) {
  const { name, description, ingredients, instructions, category, image, tag, minutes, available, featured } = dish
  return { name, description, ingredients: ingredients || '', instructions: instructions || '', category, image, tag, minutes, available, featured }
}
async function load() {
  loading.value = true; error.value = ''
  try {
    if (tab.value === 'dishes') dishes.value = await api('/api/admin/dishes')
    else if (tab.value === 'orders') orders.value = await api('/api/admin/orders')
    else security.value = await api('/api/admin/security')
  } catch (e) { error.value = e.message } finally { loading.value = false }
}
function switchTab(value) { tab.value = value; toast.value = ''; load() }
function edit(dish) {
  editingId.value = dish?.id || null
  draft.value = dish ? { name: dish.name, description: dish.description, ingredients: dish.ingredients || '', instructions: dish.instructions || '', category: dish.category, image: dish.image, tag: dish.tag, minutes: dish.minutes, available: dish.available, featured: dish.featured } : { name: '', description: '', ingredients: '', instructions: '', category: '', image: '', tag: '', minutes: 20, available: true, featured: false }
  formError.value = ''; editing.value = true
}
async function upload(event) {
  const file = event.target.files?.[0]
  if (!file) return
  formError.value = ''
  if (file.size > 5 * 1024 * 1024) { formError.value = '图片最大 5 MB，请压缩后上传。'; return }
  uploading.value = true
  const body = new FormData(); body.append('image', file)
  try { draft.value.image = (await api('/api/admin/uploads', { method: 'POST', body })).image }
  catch (e) { formError.value = e.message } finally { uploading.value = false; event.target.value = '' }
}
async function save() {
  saving.value = true; formError.value = ''
  try {
    await api(editingId.value ? `/api/admin/dishes/${editingId.value}` : '/api/admin/dishes', { method: editingId.value ? 'PUT' : 'POST', body: JSON.stringify(editableDish(draft.value)) })
    editing.value = false; toast.value = '菜品已保存，菜单已经更新。'; await load()
  } catch (e) { formError.value = e.message } finally { saving.value = false }
}
async function remove() {
  saving.value = true; formError.value = ''
  try { await api(`/api/admin/dishes/${pendingDelete.value.id}`, { method: 'DELETE' }); pendingDelete.value = null; toast.value = '菜品已删除。'; await load() }
  catch (e) { formError.value = e.message } finally { saving.value = false }
}
async function toggleAvailable(dish) {
  if (busyAction.value) return
  busyAction.value = `dish-${dish.id}`; error.value = ''
  try {
    const body = editableDish(dish)
    await api(`/api/admin/dishes/${dish.id}`, { method: 'PUT', body: JSON.stringify({ ...body, available: !dish.available }) })
    await load()
  } catch (e) { error.value = e.message } finally { busyAction.value = '' }
}
async function status(order, value) {
  busyAction.value = order.id; error.value = ''
  try { await api(`/api/admin/orders/${order.id}`, { method: 'PATCH', body: JSON.stringify({ status: value }) }); await load() }
  catch (e) { error.value = e.message } finally { busyAction.value = '' }
}
async function retry(order) {
  busyAction.value = order.id; error.value = ''
  try { await post(`/api/admin/orders/${order.id}/retry`, {}); toast.value = '提醒已加入发送队列。'; await load() }
  catch (e) { error.value = e.message } finally { busyAction.value = '' }
}
async function revoke() {
  saving.value = true; formError.value = ''
  try {
    await post('/api/admin/security/revoke-all', {})
    pendingRevoke.value = null; toast.value = '权限已撤销，下次访问需要重新验证。'; await load()
  } catch (e) { formError.value = e.message } finally { saving.value = false }
}
onMounted(load)
</script>

<template>
  <main class="admin-main"><div class="admin-heading"><div><span class="admin-eyebrow"><ChefHat aria-hidden="true" :size="17" />大厨的工作台</span><h1>准备好今天的拿手菜</h1><p>管理菜单、看看她想吃什么，再把心意端上桌。</p></div><button v-if="tab === 'dishes'" class="button primary" @click="edit()"><Plus aria-hidden="true" :size="18" />新增菜品</button></div>
    <nav class="admin-tabs" aria-label="后台功能"><button :class="{ active: tab === 'dishes' }" @click="switchTab('dishes')"><ChefHat aria-hidden="true" :size="17" />菜品管理</button><button :class="{ active: tab === 'orders' }" @click="switchTab('orders')"><ClipboardList aria-hidden="true" :size="17" />点菜清单</button><button :class="{ active: tab === 'security' }" @click="switchTab('security')"><ShieldCheck aria-hidden="true" :size="17" />访问与通知</button></nav>
    <p v-if="toast" class="inline-success" role="status"><Check aria-hidden="true" :size="16" />{{ toast }}</p><div v-if="error" class="error-panel" role="alert">{{ error }}<button class="text-button" @click="load">重新加载</button></div>
    <div class="admin-toolbar"><span>{{ tab === 'dishes' ? `共 ${dishes.length} 道菜，上架 ${dishes.filter(x => x.available).length} 道` : tab === 'orders' ? '最近 100 份清单，按时间倒序' : '访客权限与最近的访问记录' }}</span><button class="text-button" :disabled="loading" @click="load"><RefreshCw aria-hidden="true" :size="15" />刷新</button></div>
    <p v-if="loading" class="loading-copy">正在打开工作台…</p>
    <template v-else-if="tab === 'dishes'"><div v-if="!dishes.length" class="empty-state admin-empty"><ChefHat aria-hidden="true" :size="42" /><h3>先添加一道拿手菜吧</h3><p>上传照片，写一句介绍，就可以开始点菜了。</p><button class="button primary" @click="edit()"><Plus aria-hidden="true" :size="17" />新增第一道菜</button></div><div v-else class="admin-dish-list"><article v-for="dish in dishes" :key="dish.id" :class="['admin-dish', { unavailable: !dish.available }]"><FoodImage class="admin-dish-image" :src="dish.image" :alt="dish.name" /><div class="admin-dish-info"><div><h3>{{ dish.name }}</h3><span v-if="dish.featured" class="small-label">推荐</span></div><p>{{ dish.description || '还没有写菜品介绍' }}</p><p class="admin-ingredients">原料：{{ dish.ingredients || '未填写' }}</p><p class="admin-instructions">做法：{{ dish.instructions || '未填写' }}</p><small>{{ dish.category || '未分类' }} · {{ dish.minutes }} 分钟</small></div><span :class="['availability', { off: !dish.available }]">{{ dish.available ? '已上架' : '已下架' }}</span><div class="admin-dish-actions"><button class="icon-button" :aria-label="`编辑${dish.name}`" title="编辑" @click="edit(dish)"><Pencil aria-hidden="true" :size="17" /></button><button class="icon-button" :disabled="Boolean(busyAction)" :aria-label="`${dish.available ? '下架' : '上架'}${dish.name}`" :title="dish.available ? '下架' : '上架'" @click="toggleAvailable(dish)"><EyeOff aria-hidden="true" v-if="dish.available" :size="17" /><Eye aria-hidden="true" v-else :size="17" /></button><button class="icon-button danger-text" :aria-label="`删除${dish.name}`" title="删除" @click="pendingDelete = dish; formError = ''"><Trash2 aria-hidden="true" :size="17" /></button></div></article></div></template>
    <template v-else-if="tab === 'orders'"><div v-if="!orders.length" class="empty-state"><ClipboardList aria-hidden="true" :size="42" /><h3>还没有收到点菜清单</h3><p>等她选好喜欢的菜，清单就会出现在这里。</p></div><div v-else class="order-list"><article v-for="order in orders" :key="order.id" class="order-card"><div class="order-card-top"><span>{{ dateText(order.created) }}</span><span :class="['status-pill', order.status]">{{ statusText[order.status] }}</span></div><h3>{{ order.items.map(x => `${x.name} × ${x.quantity}`).join('、') }}</h3><div class="order-ingredients"><div v-for="item in order.items" :key="item.id"><p><strong>{{ item.name }}原料：</strong><span>{{ item.ingredients || '未填写' }}</span></p><p><strong>{{ item.name }}做法：</strong><span>{{ item.instructions || '未填写' }}</span></p></div></div><p>口味：{{ order.preferences.join('、') || '家常口味' }}</p><p v-if="order.note">备注：{{ order.note }}</p><div class="order-admin-bottom"><small>{{ order.id }}</small><span :class="['notification-state', order.notification]"><Bell aria-hidden="true" :size="13" />{{ notifyText[order.notification] }}</span></div><div class="order-actions"><button v-for="value in ['received', 'cooking', 'done']" :key="value" :class="['button small', order.status === value ? 'secondary selected' : 'secondary']" :disabled="Boolean(busyAction) || order.status === value" @click="status(order, value)">{{ statusText[value] }}</button><button v-if="['failed', 'unconfigured'].includes(order.notification)" class="button secondary small" :disabled="Boolean(busyAction)" @click="retry(order)"><RefreshCw aria-hidden="true" :size="14" />重试微信提醒</button></div></article></div></template>
    <template v-else><section class="security-panel"><div class="security-title"><Bell aria-hidden="true" :size="21" /><h2>微信提醒</h2><span :class="['availability', { off: !security.notificationConfigured }]">{{ security.notificationConfigured ? '已配置' : '未配置' }}</span></div><p>{{ security.notificationConfigured ? '服务器已配置 Server酱。实际发送结果可以在点菜清单里查看。' : '在服务器 .env 中填写 SERVERCHAN_SENDKEY，重启服务后启用提醒。清单始终会保存在后台。' }}</p></section><section class="security-panel"><div class="security-title"><ShieldCheck aria-hidden="true" :size="21" /><h2>访客权限</h2></div><p>暗号验证后，同一浏览器 30 天内免验证，切换网络无需重验。可以撤销全部访客权限，让访客重新验证。</p><button class="text-button danger-text" @click="pendingRevoke = 'all'; formError = ''">撤销全部访客权限</button></section><section class="security-panel"><h2>最近的访问记录</h2><p>记录验证和权限变化，不记录密码、暗号或真实 IP。记录保留 90 天。</p><div v-for="(event, index) in security.events" :key="index" class="audit-row"><span>{{ event.event }}</span><time>{{ dateText(event.created) }}</time></div><p v-if="!security.events.length" class="security-empty">暂无访问记录。</p></section></template>
  </main>
  <Modal :open="editing" :title="editingId ? '修改这道菜' : '新增一道拿手菜'" wide :busy="saving || uploading" @close="!saving && !uploading && (editing = false)"><form class="dish-form" @submit.prevent="save"><div class="image-upload"><FoodImage v-if="draft.image" :src="draft.image" :alt="draft.name || '菜品照片'" /><label :class="['upload-label', { 'has-image': draft.image }]"><ImagePlus aria-hidden="true" :size="26" /><span>{{ uploading ? '上传中…' : draft.image ? '换一张照片' : '上传菜品照片' }}</span><small>JPG、PNG、WebP，最大 5 MB</small><input type="file" accept="image/jpeg,image/png,image/webp" aria-label="上传菜品照片" :disabled="uploading || saving" @change="upload" /></label><button v-if="draft.image" type="button" class="text-button" :disabled="uploading || saving" @click="draft.image = ''">移除图片</button></div><div class="form-fields"><label>菜品名称<input v-model="draft.name" maxlength="40" required autofocus placeholder="比如：糖醋排骨" /></label><label>一句话介绍<textarea v-model="draft.description" maxlength="160" rows="2" placeholder="写一点让她想吃的理由" /></label><label>原料（可留空）<textarea v-model="draft.ingredients" maxlength="500" rows="3" placeholder="比如：排骨500g、姜、糖" /><small>{{ (draft.ingredients?.length || 0) }}/500 · 下单后随微信提醒发送</small></label><label>做法（可留空）<textarea v-model="draft.instructions" maxlength="500" rows="3" aria-describedby="dish-instructions-help" placeholder="比如：排骨焯水后炒糖色，加水炖煮，最后收汁" /><small id="dish-instructions-help">{{ (draft.instructions?.length || 0) }}/500 · 下单后随微信提醒发送</small></label><div class="form-grid"><CategoryPicker v-if="editing" :key="editingId ?? 'new'" v-model="draft.category" :categories="categories" :disabled="saving || uploading" /><label>预计制作时间（分钟）<input v-model.number="draft.minutes" type="number" min="1" max="240" required /></label></div><label>小标签（可留空）<input v-model="draft.tag" maxlength="12" placeholder="比如：拿手好菜、微辣" /></label><div class="check-row"><label><input v-model="draft.available" type="checkbox" />上架，允许点菜</label><label><input v-model="draft.featured" type="checkbox" />大厨推荐</label></div></div><p v-if="formError" class="form-error form-full" role="alert">{{ formError }}</p><div class="modal-actions form-full"><button type="button" class="button secondary" :disabled="saving || uploading" @click="editing = false">取消</button><button class="button primary" :disabled="saving || uploading">{{ saving ? '保存中…' : '保存菜品' }}</button></div></form></Modal>
  <Modal :open="Boolean(pendingDelete)" title="删除这道菜？" :busy="saving" @close="!saving && (pendingDelete = null)"><p class="confirm-copy">「{{ pendingDelete?.name }}」会从菜单中删除。已经提交的点菜清单会保留原来的菜名。也可以先下架，之后再上架。</p><p v-if="formError" class="form-error" role="alert">{{ formError }}</p><div class="modal-actions"><button class="button secondary" :disabled="saving" @click="pendingDelete = null">保留菜品</button><button class="button danger" :disabled="saving" @click="remove">{{ saving ? '删除中…' : '确认删除' }}</button></div></Modal>
  <Modal :open="Boolean(pendingRevoke)" title="撤销访问权限？" :busy="saving" @close="!saving && (pendingRevoke = null)"><p class="confirm-copy">所有访客下次进入小厨房时，需要重新回答暗号。你的管理员会话继续有效。</p><p v-if="formError" class="form-error" role="alert">{{ formError }}</p><div class="modal-actions"><button class="button secondary" :disabled="saving" @click="pendingRevoke = null">取消</button><button class="button danger" :disabled="saving" @click="revoke">{{ saving ? '撤销中…' : '确认撤销' }}</button></div></Modal>
</template>
