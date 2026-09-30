/**
 * Migration runner for PostgreSQL (Neon / Vercel Postgres) and SQLite.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node server/db/run-migrations.mjs
 *   or: npm run db:migrate
 */

import { initDb, closeDb, getDatabaseUrl } from './index.mjs'
import { runMigrations } from './migrate.mjs'

async function main() {
  const url = getDatabaseUrl({ preferUnpooled: true })
  const isPostgres = !!url
  console.log(`[db:migrate] Running database migrations (${isPostgres ? 'PostgreSQL' : 'SQLite'})...`)
  if (isPostgres) {
    const masked = url.replace(/:([^:@]+)@/, ':****@')
    console.log(`[db:migrate] Connection: ${masked}`)
  }

  const db = initDb(url, { preferUnpooled: true })
  try {
    const applied = await runMigrations(db)
    console.log(`[db:migrate] Success! ${applied} migration(s) applied.`)
  } catch (err) {
    console.error('[db:migrate] Migration failed:', err)
    process.exitCode = 1
  } finally {
    await closeDb()
  }
}

main()
