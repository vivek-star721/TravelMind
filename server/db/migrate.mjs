import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { POSTGRES_SCHEMA_SQL } from './schema.postgres.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, 'migrations')

export async function runMigrations(db) {
  // If hosted Postgres (Neon / Vercel Postgres)
  if (db.isPostgres) {
    await db.exec(POSTGRES_SCHEMA_SQL)

    const appliedRows = await db.prepare('SELECT id FROM _migrations').all()
    const appliedSet = new Set((appliedRows || []).map((r) => r.id))

    const insertMigration = db.prepare(
      'INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)'
    )

    let count = 0
    if (!appliedSet.has('001_initial_schema')) {
      await insertMigration.run('001_initial_schema', '001_initial_schema.sql', new Date().toISOString())
      count++
    }
    if (!appliedSet.has('002_customer_profile')) {
      await insertMigration.run('002_customer_profile', '002_customer_profile.sql', new Date().toISOString())
      count++
    }

    return count
  }

  // SQLite execution
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const appliedRows = db.prepare('SELECT id FROM _migrations').all()
  const appliedSet = new Set(appliedRows.map((r) => r.id))

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)'
  )

  let count = 0
  for (const file of files) {
    const migrationId = file.replace(/\.sql$/, '')
    if (!appliedSet.has(migrationId)) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      db.exec(sql)
      insertMigration.run(migrationId, file, new Date().toISOString())
      count++
    }
  }

  return count
}
