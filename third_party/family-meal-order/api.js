function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content || ''
}

export async function api(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const headers = new Headers(options.headers || {})
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) headers.set('X-CSRF-Token', csrfToken())
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')

  const response = await fetch(url, { ...options, headers })
  if (response.status === 401) {
    const next = `${location.pathname}${location.search}${location.hash}`
    location.href = `/login?next=${encodeURIComponent(next)}`
    throw new Error('登录状态已失效')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || '操作失败，请稍后重试')
  return data
}

export function getCsrfToken() {
  return csrfToken()
}
