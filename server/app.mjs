/**
 * Core API request handler for MyAI-SmarttripPlanner.
 * Shared between standalone Node HTTP server (server/index.mjs) and
 * Vercel Serverless Function (api/index.js).
 */

import { getDb } from './db/index.mjs'
import { verifyCsrf, isOriginAllowed } from './auth/csrf.mjs'
import { createAuthRouter } from './auth/routes.mjs'
import { createAdminRouter } from './admin/routes.mjs'
import { createTripRouter } from './trips/routes.mjs'
import { handleWorldPlacesHttp } from './worldPlaces.mjs'
import { applySecurityHeaders } from './middleware/headers.mjs'
import { authRateLimiter, placesRateLimiter } from './middleware/rateLimit.mjs'
import { attachRequestId, handleServerError } from './middleware/errorHandler.mjs'

let cachedDb = null
let authRouter = null
let adminRouter = null
let tripRouter = null

export function getRouters(db = null) {
  const activeDb = db || getDb()
  if (!authRouter || cachedDb !== activeDb) {
    cachedDb = activeDb
    authRouter = createAuthRouter(activeDb)
    adminRouter = createAdminRouter(activeDb)
    tripRouter = createTripRouter(activeDb)
  }
  return { db: activeDb, authRouter, adminRouter, tripRouter }
}

export async function parseJsonBody(req, limit = 1024 * 1024) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null

  // If already parsed by host framework (e.g. Vercel body parser)
  if (req.body && typeof req.body === 'object') {
    return req.body
  }
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body)
    } catch (err) {
      const parseErr = new Error('Invalid JSON: ' + err.message)
      parseErr.statusCode = 400
      throw parseErr
    }
  }

  return new Promise((resolveBody, rejectBody) => {
    let body = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const err = new Error('Payload too large (max 1 MB)')
        err.statusCode = 413
        rejectBody(err)
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (!body) return resolveBody(null)
      try {
        resolveBody(JSON.parse(body))
      } catch (err) {
        const parseErr = new Error('Invalid JSON: ' + err.message)
        parseErr.statusCode = 400
        rejectBody(parseErr)
      }
    })
    req.on('error', rejectBody)
  })
}

export async function handleApiRequest(req, res, options = {}) {
  const port = options.port || Number(process.env.PORT || process.env.AGENT_PORT || 5200)
  const { db, authRouter: authR, adminRouter: adminR, tripRouter: tripR } = getRouters(options.db)

  try {
    // 0. CORS & Preflight (OPTIONS)
    const origin = req.headers['origin']
    if (origin && isOriginAllowed(origin, port, req)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Authorization, Accept')
      res.setHeader('Access-Control-Max-Age', '86400')
      res.setHeader('Vary', 'Origin')
    }

    if (req.method === 'OPTIONS') {
      if (origin && !isOriginAllowed(origin, port, req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Origin not allowed' }))
        return true
      }
      res.writeHead(204)
      res.end()
      return true
    }

    // 1. Attach unique Request ID & Apply Security Headers
    attachRequestId(req, res)
    applySecurityHeaders(res)

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = parsedUrl.pathname
    const forwarded = req.headers['x-forwarded-for']
    const clientIp = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) || req.socket?.remoteAddress || '127.0.0.1'

    // Health checks
    if (pathname === '/health' || pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, isPostgres: !!db.isPostgres }))
      return true
    }

    // Only process /api/ routes here
    if (!pathname.startsWith('/api/')) {
      return false
    }

    // 2. Rate limiting for sensitive endpoint namespaces
    if (pathname.startsWith('/api/auth/')) {
      const authLimit = authRateLimiter.consume(clientIp)
      if (!authLimit.allowed) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(authLimit.retryAfterSeconds),
        })
        res.end(JSON.stringify({ error: 'Too many requests. Please try again later.' }))
        return true
      }
    }

    if (pathname.startsWith('/api/places/')) {
      const placesLimit = placesRateLimiter.consume(clientIp)
      if (!placesLimit.allowed) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(placesLimit.retryAfterSeconds),
        })
        res.end(JSON.stringify({ error: 'Too many requests. Upstream rate limit respected.' }))
        return true
      }
    }

    // 3. Verify CSRF for mutation methods
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const csrf = verifyCsrf(req, port)
      if (!csrf.ok) {
        res.writeHead(csrf.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: csrf.error }))
        return true
      }
    }

    // 4. Body parsing with 1 MB limit for API calls
    let body = null
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      body = await parseJsonBody(req)
    }

    // 5. Route to respective sub-routers
    if (pathname.startsWith('/api/auth')) {
      const handled = await authR(req, res, pathname, body)
      if (handled !== null) return true
    }

    if (pathname.startsWith('/api/admin')) {
      const handled = await adminR(req, res, pathname, body)
      if (handled !== null) return true
    }

    if (pathname.startsWith('/api/trips')) {
      const handled = await tripR(req, res, pathname, body)
      if (handled !== null) return true
    }

    if (pathname.startsWith('/api/places')) {
      const handled = await handleWorldPlacesHttp(req, res)
      if (handled) return true
    }

    // Unmatched /api/* route
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Endpoint ${req.method} ${pathname} not found` }))
    return true
  } catch (err) {
    handleServerError(err, req, res)
    return true
  }
}
