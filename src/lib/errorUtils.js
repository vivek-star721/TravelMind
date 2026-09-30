/**
 * Error formatting utility to ensure human-readable error messages
 * and completely prevent "[object Object]" in the UI.
 */

export function formatErrorMessage(err, fallback = 'An unexpected error occurred. Please try again.') {
  if (err === null || err === undefined) {
    return fallback
  }

  // If already a non-empty string
  if (typeof err === 'string') {
    const trimmed = err.trim()
    if (!trimmed || trimmed === '[object Object]') {
      return fallback
    }
    return trimmed
  }

  // 1. Check nested payload from API client or Axios/Fetch responses
  const payload = err.data || err.response?.data || err.payload

  if (payload) {
    if (typeof payload === 'string' && payload !== '[object Object]' && payload.trim()) {
      return payload.trim()
    }
    if (typeof payload === 'object') {
      // Vercel / Cloud error response: { error: { message: "The page could not be found", code: "404" } }
      if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string') {
        const msg = payload.error.message.trim()
        if (msg && msg !== '[object Object]') return msg
      }
      // Standard API response: { error: "Invalid credentials" }
      if (typeof payload.error === 'string' && payload.error !== '[object Object]') {
        const msg = payload.error.trim()
        if (msg) return msg
      }
      // Standard API response: { message: "User already exists" }
      if (typeof payload.message === 'string' && payload.message !== '[object Object]') {
        const msg = payload.message.trim()
        if (msg) return msg
      }
    }
  }

  // 2. Direct error property on err
  if (err.error) {
    if (typeof err.error === 'string' && err.error !== '[object Object]') {
      const msg = err.error.trim()
      if (msg) return msg
    }
    if (typeof err.error === 'object' && typeof err.error.message === 'string') {
      const msg = err.error.message.trim()
      if (msg && msg !== '[object Object]') return msg
    }
  }

  // 3. Standard Error instance message
  if (typeof err.message === 'string') {
    const msg = err.message.trim()
    if (msg && msg !== '[object Object]') {
      return msg
    }
  }

  // 4. Try parsing JSON if err is an object
  if (typeof err === 'object') {
    try {
      const json = JSON.stringify(err)
      if (json && json !== '{}' && json !== '[]') {
        // If it's a simple object with a message or error inside
        const parsed = JSON.parse(json)
        if (parsed.message && typeof parsed.message === 'string') return parsed.message
        if (parsed.error && typeof parsed.error === 'string') return parsed.error
      }
    } catch {
      // fallback
    }
  }

  return fallback
}
