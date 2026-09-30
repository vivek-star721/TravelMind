/**
 * Vercel Serverless Function entry point for MyAI-SmarttripPlanner API.
 */

import { handleApiRequest } from '../server/app.mjs'

export default async function handler(req, res) {
  // Normalize req.url in case Vercel rewrite altered it
  if (req.url === '/api' || req.url === '/api/' || req.url.startsWith('/api/index')) {
    if (req.query?.path) {
      const subpath = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path
      const [_, queryStr] = req.url.split('?')
      req.url = `/api/${subpath}${queryStr ? '?' + queryStr : ''}`
    } else if (req.headers['x-matched-path']?.startsWith('/api/')) {
      const [_, queryStr] = req.url.split('?')
      req.url = `${req.headers['x-matched-path']}${queryStr ? '?' + queryStr : ''}`
    }
  }

  await handleApiRequest(req, res)
}
