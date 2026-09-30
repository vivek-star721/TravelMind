/**
 * Migration runner for PostgreSQL (Neon / Vercel Postgres) and SQLite.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node server/db/run-migrations.mjs
 *   or: npm run db:migrate
 */

import { initDb, closeDb } from './index.mjs'
import { runMigrations } from './migrate.mjs'

async function main() {
  const isPostgres = !!process.env.DATABASE_URL
  console.log(`[db:migrate] Running database migrations (${isPostgres ? 'PostgreSQL' : 'SQLite'})...`)

  const db = initDb()
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
