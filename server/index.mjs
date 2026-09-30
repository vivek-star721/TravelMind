/* MyTripPlanner agent server: WebSocket bridge to the browser + Claude Agent
   SDK chat sessions. Run alongside Vite with `npm run dev`, or standalone
   with `npm start`: when a production build exists in dist/, this server
   also serves the app itself, so one port runs everything. */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, extname, normalize, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridge } from './bridge.mjs'
import { createAgent, CODEX_BIN } from './agent.mjs'
import { createAuth } from './auth.mjs'
import { createMcpHandler } from './mcp-http.mjs'
import { createStorage, documentsDir } from './storage.mjs'
import { initDb } from './db/index.mjs'
import { bootstrapAdmin, bootstrapDemoUser } from './auth/bootstrap.mjs'
import { migrateFileTripsToDb } from './db/migrate-files.mjs'
import { parseCookies, getSession } from './auth/session.mjs'
import { handleApiRequest } from './app.mjs'
import { handleServerError } from './middleware/errorHandler.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || process.env.AGENT_PORT || 5200)
/* 127.0.0.1 by default; Docker sets AGENT_HOST=0.0.0.0 */
const HOST = process.env.AGENT_HOST || '127.0.0.1'
const DIST = join(__dirname, '..', 'dist')
let mcpHandler = null

// Fail fast in production if required secrets are missing
if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET && !process.env.ENCRYPTION_KEY) {
    console.warn('[SECURITY WARNING] Running in production without ENCRYPTION_KEY set. Sensitive settings will use default fallback.')
  }
}

// Initialize persistent SQLite database
const dataDir = process.env.ULISSE_DATA_DIR || join(documentsDir(), 'Ulisse')
const db = initDb(join(dataDir, 'ulisse.db'))
await bootstrapAdmin(db)
await bootstrapDemoUser(db)
migrateFileTripsToDb(db, dataDir)

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.webp': 'image/webp', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

/* serve the built SPA with path traversal protection and SPA fallback */
function serveStatic(req, res) {
  if (!existsSync(DIST)) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'No production build found. Run `npm run build`.' }))
    return
  }

  const cleanUrl = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  const resolvedDist = resolve(DIST)
  const filePath = resolve(DIST, cleanUrl === '/' ? 'index.html' : '.' + cleanUrl)

  // Strict path traversal verification
  if (!filePath.startsWith(resolvedDist)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Access forbidden' }))
    return
  }

  if (existsSync(filePath) && !statSync(filePath).isDirectory()) {
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' })
    createReadStream(filePath).pipe(res)
    return
  }

  // SPA fallback only for GET requests that accept HTML
  if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
    const indexPath = join(resolvedDist, 'index.html')
    if (existsSync(indexPath)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      createReadStream(indexPath).pipe(res)
      return
    }
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
}

async function parseJsonBody(req, limit = 1024 * 1024) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return null
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

/* storage broadcasts through the bridge, which is created after the server:
   route through a late-bound proxy */
const storage = createStorage({ broadcast: (o) => bridge?.broadcast(o) })

const http = createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = parsedUrl.pathname

    // 1. Process API and Health routes via shared API handler
    if (pathname.startsWith('/api/') || pathname === '/health') {
      const handled = await handleApiRequest(req, res, { db, port: PORT })
      if (handled) return
    }

    /* Debug hook: disabled in production; in development, requires admin session */
    if (req.method === 'POST' && pathname === '/debug/tool') {
      if (process.env.NODE_ENV === 'production') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Endpoint not found' }))
        return
      }

      const cookies = parseCookies(req.headers.cookie)
      const session = getSession(db, cookies.sid)
      if (!session || session.role !== 'admin') {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Administrator session required for debug/tool' }))
        return
      }

      const { name, args } = body || {}
      const result = await bridge.callBrowser(name, args ?? {})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }

    serveStatic(req, res)
  } catch (err) {
    handleServerError(err, req, res)
  }
})

const bridge = createBridge(http, { db, port: PORT })
mcpHandler = createMcpHandler(bridge)
const auth = createAuth(bridge, { codexBin: process.env.CODEX_BIN || CODEX_BIN, getAuthPath: storage.getAuthPath })
createAgent(bridge, { mcpPort: PORT, auth })

http.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(
      `[agent-server] port ${PORT} is already in use: another \`npm run dev\` is probably still running.\n` +
      `[agent-server] close it, or free the port with:  lsof -ti tcp:${PORT} | xargs kill`,
    )
    process.exit(1)
  }
  throw e
})

http.listen(PORT, HOST, () => {
  console.log(`[agent-server] ready on ws://${HOST}:${PORT}/agent (MCP: http://${HOST}:${PORT}/mcp)`)
  if (existsSync(DIST)) console.log(`[agent-server] serving the app → http://${HOST}:${PORT}`)
})
