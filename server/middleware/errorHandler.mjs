import crypto from 'node:crypto'

export function attachRequestId(req, res) {
  const reqId = req.headers['x-request-id'] || crypto.randomUUID()
  req.id = reqId
  res.setHeader('X-Request-Id', reqId)
  return reqId
}

export function handleServerError(err, req, res) {
  const reqId = req?.id || crypto.randomUUID()
  const timestamp = new Date().toISOString()

  console.error(`[ERROR ${timestamp}] [req:${reqId}] ${req?.method} ${req?.url} ->`, err?.stack || err)

  if (!res.headersSent) {
    const isClientError = err?.statusCode >= 400 && err?.statusCode < 500
    const statusCode = isClientError ? err.statusCode : 500
    let message = isClientError ? err.message : 'Internal Server Error'

    if (!isClientError && err?.message) {
      if (err.message.includes('relation') && err.message.includes('does not exist')) {
        message = 'Database tables not initialized. Please run npm run db:migrate.'
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.message.includes('connect')) {
        message = 'Cannot connect to database. Please verify TRAVELMINDS_DATABASE_URL.'
      } else if (err.code === '28P01' || err.message.includes('password authentication failed')) {
        message = 'Database authentication failed. Please check TRAVELMINDS_DATABASE_URL password.'
      }
    }

    const payload = JSON.stringify({
      error: message,
      requestId: reqId,
      details: err?.details || undefined,
    })

    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'X-Request-Id': reqId,
    })
    res.end(payload)
  }
}
