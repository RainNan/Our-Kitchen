<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { Heart, ChefHat, ArrowLeft, LogOut } from 'lucide-vue-next'
import { session, refreshSession, post, appPath } from './api'
import AuthGate from './components/AuthGate.vue'
import MenuPage from './components/MenuPage.vue'
import AdminPage from './components/AdminPage.vue'
const loading = ref(true)
const error = ref('')
const isAdmin = ref(location.pathname.startsWith(appPath('/admin')))
function navigate(admin) { isAdmin.value = admin; history.pushState({}, '', appPath(admin ? '/admin' : '/')) }
function pop() { isAdmin.value = location.pathname.startsWith(appPath('/admin')) }
async function initialize() {
  loading.value = true; error.value = ''
  try { await refreshSession() } catch (e) { error.value = e.message } finally { loading.value = false }
}
async function logout() {
  try { await post('/api/logout', {}); await initialize() } catch (e) { error.value = e.message }
}
onMounted(() => { initialize(); window.addEventListener('popstate', pop) })
onBeforeUnmount(() => window.removeEventListener('popstate', pop))
</script>
<template>
  <div v-if="session.demo" class="demo-banner">本机演示厨房 · 示例菜单 · 微信通知未连接</div>
  <header class="site-header"><div class="header-inner">
    <button class="brand" aria-label="返回我们的厨房菜单" @click="navigate(false)"><span class="brand-mark"><Heart :size="23" /></span><span><strong>我们的厨房</strong><small>把喜欢，做成一顿饭。</small></span></button>
    <div class="header-actions">
      <a class="text-button" href="/">首页</a>
      <button v-if="isAdmin" class="text-button" @click="navigate(false)"><ArrowLeft :size="16" />返回菜单</button>
      <button v-else class="text-button" @click="navigate(true)"><ChefHat :size="17" />厨房后台</button>
      <button v-if="session.role !== 'anonymous'" class="icon-button" aria-label="退出登录" title="退出登录" @click="logout"><LogOut :size="18" /></button>
    </div>
  </div></header>
  <main v-if="loading" class="initial-state" aria-live="polite"><div class="skeleton-line"></div><p>正在打开小厨房…</p></main>
  <main v-else-if="error" class="initial-state"><p role="alert">{{ error }}</p><button class="button primary" @click="initialize">重新连接</button></main>
  <AuthGate v-else-if="session.role === 'anonymous' || (isAdmin && session.role !== 'admin')" :key="isAdmin ? 'admin' : 'guest'" :admin="isAdmin" />
  <AdminPage v-else-if="isAdmin && session.role === 'admin'" />
  <MenuPage v-else />
  <footer class="site-footer"><Heart :size="13" /><span>一日三餐，想和你一起好好吃饭。</span></footer>
</template>
