// Adapted from Skylarrkuo/family-meal-order frontend/src/services/api.js, GPL-3.0.
// See README.md (third-party notices). Tokens now come from a private session API instead of HTML metadata.
import { reactive } from 'vue'
export const session = reactive({ role: 'anonymous', csrf: '', question: '', demo: false })
export const appPath = path => `${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`
export const imagePath = path => path?.startsWith('/media/') ? appPath(path) : path

export async function refreshSession() {
  const response = await fetch(appPath('/api/session'), { credentials: 'same-origin', cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '暂时无法连接小厨房。')
  Object.assign(session, data)
}
export async function api(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const headers = new Headers(options.headers || {})
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) headers.set('X-CSRF-Token', session.csrf)
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  let response
  try { response = await fetch(appPath(url), { ...options, credentials: 'same-origin', headers }) }
  catch { throw new Error('网络连接不稳定，请检查网络后重试。') }
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && !url.includes('login') && url !== '/api/verify') await refreshSession()
  if (!response.ok) throw new Error(data.error || '操作失败，请稍后重试。')
  return data
}
export const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) })
