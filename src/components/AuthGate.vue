<script setup>
import { ref } from 'vue'
import { Heart, KeyRound, ArrowRight, ShieldCheck, ChefHat } from 'lucide-vue-next'
import { session, post } from '../api'
const props = defineProps({ admin: Boolean })
const value = ref('')
const error = ref('')
const busy = ref(false)
async function enter() {
  error.value = ''; busy.value = true
  try {
    const result = await post(props.admin ? '/api/admin/login' : '/api/verify', props.admin ? { password: value.value } : { answer: value.value })
    Object.assign(session, result)
  } catch (e) { error.value = e.message } finally { busy.value = false }
}
</script>
<template>
  <main class="gate-layout">
    <div class="gate-story"><span class="story-icon"><Heart aria-hidden="true" :size="30" /></span><h1>两个人，<br />一顿刚刚好的饭。</h1><p>你负责想吃什么，<br />我负责把它做成一顿好饭。</p><div class="table-drawing" aria-hidden="true"><div class="draw-plate"><Heart aria-hidden="true" :size="50" /></div><span class="draw-fork"></span><span class="draw-spoon"></span></div><span class="story-footer">留一张餐桌，只等你来。</span></div>
    <section class="gate-form">
      <div class="gate-symbol"><ChefHat aria-hidden="true" v-if="admin" :size="29" /><KeyRound aria-hidden="true" v-else :size="29" /></div>
      <h1>{{ admin ? '大厨，欢迎回来' : '欢迎来到我们的厨房' }}</h1>
      <p>{{ admin ? '登录后，就可以准备菜单和查看点菜清单。' : '进门前，先对一个只有我们知道的暗号。' }}</p>
      <form @submit.prevent="enter">
        <label :for="admin ? 'admin-password' : 'guest-answer'">{{ admin ? '管理员密码' : session.question }}</label>
        <input :id="admin ? 'admin-password' : 'guest-answer'" v-model="value" type="password" :autocomplete="admin ? 'current-password' : 'off'" maxlength="128" required autofocus :placeholder="admin ? '输入管理员密码' : '输入我们的暗号'" :aria-invalid="Boolean(error)" :aria-describedby="error ? 'gate-error' : undefined" />
        <p v-if="error" id="gate-error" class="form-error" role="alert">{{ error }}</p>
        <button class="button primary full" :disabled="busy || !value.trim()">{{ busy ? '正在验证…' : admin ? '进入厨房后台' : '开饭啦' }}<ArrowRight aria-hidden="true" :size="18" /></button>
      </form>
      <div class="gate-trust"><ShieldCheck aria-hidden="true" :size="16" /><span>{{ admin ? '管理员会话有效期为 8 小时' : '验证后，同一浏览器 30 天内免验证，切换网络无需重验' }}</span></div>
      <div v-if="session.demo" class="demo-help">本机演示<br />{{ admin ? '管理员密码：demo-chef-2026' : '访客暗号：一起好好吃饭' }}</div>
    </section>
  </main>
</template>
