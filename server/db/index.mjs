import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { runMigrations } from './migrate.mjs'

const { Pool } = pg
const __dirname = dirname(fileURLToPath(import.meta.url))

let dbInstance = null
let currentDbIdentifier = null

export function toPgSql(sql) {
  let paramIndex = 1
  return sql.replace(/\?/g, () => `$${paramIndex++}`)
}

export function createPgDb(databaseUrl) {
  const isLocal = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  })

  return {
    isPostgres: true,
    pool,
    prepare(sql) {
      const pgSql = toPgSql(sql)
      return {
        async get(...params) {
          const res = await pool.query(pgSql, params)
          return res.rows[0]
        },
        async all(...params) {
          const res = await pool.query(pgSql, params)
          return res.rows
        },
        async run(...params) {
          const res = await pool.query(pgSql, params)
          return { changes: res.rowCount, rowCount: res.rowCount }
        },
      }
    },
    async exec(sql) {
      // Ignore SQLite PRAGMAs in Postgres
      const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && !s.toUpperCase().startsWith('PRAGMA'))

      for (const statement of statements) {
        await pool.query(statement)
      }
    },
    async close() {
      await pool.end()
    },
  }
}

export function getDatabaseUrl(options = {}) {
  const preferUnpooled = options.preferUnpooled ?? false

  if (preferUnpooled) {
    return (
      process.env.TRAVELMINDS_DATABASE_URL_UNPOOLED ||
      process.env.TRAVELMINDS_POSTGRES_URL_NON_POOLING ||
      process.env.DATABASE_URL_UNPOOLED ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.TRAVELMINDS_DATABASE_URL ||
      process.env.TRAVELMINDS_POSTGRES_URL ||
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL
    )
  }

  return (
    process.env.TRAVELMINDS_DATABASE_URL ||
    process.env.TRAVELMINDS_POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.TRAVELMINDS_DATABASE_URL_UNPOOLED ||
    process.env.TRAVELMINDS_POSTGRES_URL_NON_POOLING ||
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.POSTGRES_URL_NON_POOLING
  )
}

export function initDb(dbPathOrUrl = null, options = {}) {
  // 1. If Postgres URL is provided or available via env (TRAVELMINDS_DATABASE_URL or DATABASE_URL)
  const isExplicitPg =
    typeof dbPathOrUrl === 'string' &&
    (dbPathOrUrl.startsWith('postgres://') || dbPathOrUrl.startsWith('postgresql://'))

  const databaseUrl = isExplicitPg ? dbPathOrUrl : getDatabaseUrl(options)

  if (databaseUrl) {
    const identifier = 'postgres:' + databaseUrl

    if (dbInstance && currentDbIdentifier === identifier) {
      return dbInstance
    }

    if (dbInstance) {
      try {
        dbInstance.close()
      } catch {
        // ignore
      }
      dbInstance = null
    }

    const pgDb = createPgDb(databaseUrl)
    dbInstance = pgDb
    currentDbIdentifier = identifier
    return dbInstance
  }

  // 2. Otherwise fallback to local SQLite (for offline dev & vitest tests)
  const dbPath = dbPathOrUrl || ':memory:'
  if (dbInstance && currentDbIdentifier === dbPath) {
    return dbInstance
  }

  if (dbInstance) {
    try {
      dbInstance.close()
    } catch {
      // ignore
    }
    dbInstance = null
  }

  if (dbPath !== ':memory:') {
    const dir = join(dbPath, '..')
    mkdirSync(dir, { recursive: true })
  }

  const rawDb = new DatabaseSync(dbPath)
  rawDb.exec('PRAGMA foreign_keys = ON;')
  if (dbPath !== ':memory:') {
    try {
      rawDb.exec('PRAGMA journal_mode = WAL;')
    } catch {
      // ignore WAL errors
    }
  }

  runMigrations(rawDb)
  dbInstance = rawDb
  currentDbIdentifier = dbPath
  return dbInstance
}

export function getDb() {
  if (!dbInstance) {
    return initDb()
  }
  return dbInstance
}

export function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close()
    } catch {
      // ignore
    }
    dbInstance = null
    currentDbIdentifier = null
  }
}
