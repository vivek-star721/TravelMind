/**
 * Serverless HTTP & SSE Chat Handler for Ulisse AI Agent.
 * Powers the AI travel planner on Vercel and local environments without persistent WebSockets.
 */

import crypto from 'node:crypto'
import { parseCookies, getSession } from '../auth/session.mjs'
import { runFreeAgent, runOpenAiCompat } from '../freeAgent.mjs'

export function getGeminiApiKey() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_AI_KEY ||
    process.env.TRAVELMINDS_GEMINI_API_KEY ||
    process.env.TRAVELMINDS_GOOGLE_API_KEY ||
    null
  )
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export function handleAgentStatus(req, res) {
  const geminiKey = getGeminiApiKey()
  const hasGemini = Boolean(geminiKey)

  return sendJson(res, 200, {
    ok: true,
    connected: true,
    mode: 'serverless-sse',
    providers: {
      free: {
        ready: true,
        message: 'Ulisse Free Autonomous Planner (Built-in)',
      },
      gemini: {
        ready: hasGemini,
        configured: hasGemini,
        message: hasGemini ? 'Google Gemini AI ready' : 'GEMINI_API_KEY not configured on server',
      },
      claude: {
        ready: false,
        message: 'Requires local Claude CLI',
      },
      codex: {
        ready: false,
        message: 'Requires local OpenAI Codex CLI',
      },
    },
    models: [
      { id: 'smart-planner', label: 'Ulisse Autonomous Planner' },
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Recommended)' },
      { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    ],
  })
}

export async function handleAgentChat(req, res, db, body) {
  const cookies = parseCookies(req.headers.cookie)
  const token = cookies.sid
  const session = db ? await getSession(db, token) : null
  const userId = session?.user_id || 'anonymous'

  // Initialize Server-Sent Events (SSE) stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const sendSse = (event) => {
    if (res.writableEnded) return
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  const {
    text = '',
    engine = 'free',
    model = 'gemini-2.0-flash',
    trip = null,
    notes = '',
    currency = 'INR',
    language = 'en',
    mode = 'planner',
    sessionId = null,
  } = body || {}

  if (!text || typeof text !== 'string' || !text.trim()) {
    sendSse({ type: 'agent_error', error: 'User message text is required' })
    sendSse({ type: 'turn_end' })
    res.end()
    return
  }

  const currentTrip = trip ? structuredClone(trip) : {}
  let rpcId = 1
  const abortController = new AbortController()

  req.on('close', () => {
    abortController.abort()
  })

  // Bridge adapter mimicking the WebSocket bridge for agent executors
  const bridge = {
    broadcast: (event) => {
      sendSse(event)
    },
    callBrowser: async (name, args) => {
      if (name === 'get_trip') {
        return { ok: true, result: currentTrip }
      }
      const id = rpcId++
      // Stream tool calls to browser client so live store executes them
      sendSse({ type: 'tool_call', id, name, args: args || {} })
      sendSse({ type: 'agent_tool', name, args: args || {} })
      return { ok: true, result: { ok: true } }
    },
  }

  sendSse({ type: 'turn_start' })
  if (sessionId) {
    sendSse({ type: 'session', sessionId })
  }

  try {
    const serverGeminiKey = getGeminiApiKey()
    const activeApiKey = serverGeminiKey || body?.apiKey

    if (engine === 'gemini') {
      if (!activeApiKey) {
        console.warn('[agent/chat] GEMINI_API_KEY missing on server. Falling back to Free Autonomous Planner.')
        sendSse({
          type: 'assistant_text',
          text: 'Google Gemini API key not found on server. Using Free AI Agent (Ulisse AI Planner).\n\n',
        })
        await runFreeAgent(text.trim(), {
          model: 'smart-planner',
          sessionId,
          mode,
          notes,
          currency,
          language,
          bridge,
          abortSignal: abortController.signal,
        })
      } else {
        await runOpenAiCompat(text.trim(), {
          endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
          apiKey: activeApiKey,
          model: model || 'gemini-2.0-flash',
          currency,
          language,
          notes,
          bridge,
          abortSignal: abortController.signal,
        })
      }
    } else {
      // Default to Free Autonomous Planner
      await runFreeAgent(text.trim(), {
        model: 'smart-planner',
        sessionId,
        mode,
        notes,
        currency,
        language,
        bridge,
        abortSignal: abortController.signal,
      })
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      console.error(`[agent/chat] [user:${userId}] Execution failure:`, err?.stack || err)
      sendSse({
        type: 'agent_error',
        error: String(err?.message || 'Failed to complete itinerary turn. Please try again.'),
        canUseFree: true,
      })
    }
  } finally {
    sendSse({ type: 'turn_end' })
    res.end()
  }
}

export function createChatsRouter(db) {
  return async function handleChatsRoute(req, res, pathname, body) {
    if (!pathname.startsWith('/api/chats')) {
      return null
    }

    const cookies = parseCookies(req.headers.cookie)
    const token = cookies.sid
    const session = db ? await getSession(db, token) : null

    if (!session || !session.user_id) {
      return sendJson(res, 401, { error: 'Authentication required for saved chats' })
    }

    const userId = session.user_id
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const tripId = parsedUrl.searchParams.get('tripId')

    // GET /api/chats
    if (req.method === 'GET' && pathname === '/api/chats') {
      const sql = tripId
        ? 'SELECT id, user_id, trip_id, title, messages_json, created_at, updated_at FROM chats WHERE user_id = ? AND trip_id = ? ORDER BY updated_at DESC'
        : 'SELECT id, user_id, trip_id, title, messages_json, created_at, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC'
      const params = tripId ? [userId, tripId] : [userId]

      const rows = await db.prepare(sql).all(...params)
      const chats = (rows || []).map((r) => {
        try {
          return {
            id: r.id,
            tripId: r.trip_id,
            title: r.title,
            messages: JSON.parse(r.messages_json),
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          }
        } catch {
          return {
            id: r.id,
            tripId: r.trip_id,
            title: r.title,
            messages: [],
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          }
        }
      })

      return sendJson(res, 200, { chats })
    }

    // POST /api/chats (Save or update chat)
    if (req.method === 'POST' && pathname === '/api/chats') {
      const { id, tripId: chatTripId, title = 'Chat', messages = [] } = body || {}
      const chatId = id || 'chat-' + crypto.randomUUID()
      const now = new Date().toISOString()
      const messagesJson = JSON.stringify(messages)

      await db.prepare(`
        INSERT INTO chats (id, user_id, trip_id, title, messages_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          trip_id = excluded.trip_id,
          title = excluded.title,
          messages_json = excluded.messages_json,
          updated_at = excluded.updated_at
      `).run(chatId, userId, chatTripId || null, title, messagesJson, now, now)

      return sendJson(res, 200, { success: true, id: chatId })
    }

    // DELETE /api/chats/:id
    const chatMatch = pathname.match(/^\/api\/chats\/([^/]+)$/)
    if (req.method === 'DELETE' && chatMatch) {
      const targetId = chatMatch[1]
      await db.prepare('DELETE FROM chats WHERE id = ? AND user_id = ?').run(targetId, userId)
      return sendJson(res, 200, { success: true })
    }

    return null
  }
}
