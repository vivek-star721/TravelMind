/**
 * Database Seed Script for MyAI-SmarttripPlanner.
 * Populates admin and demo customer accounts, preferences, and sample customer trips.
 * Supports both PostgreSQL (Neon / Vercel Postgres) via DATABASE_URL and local SQLite.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node server/db/seed.mjs
 *   or: npm run db:seed
 */

import { initDb, closeDb } from './index.mjs'
import { runMigrations } from './migrate.mjs'
import { bootstrapAdmin, bootstrapDemoUser } from '../auth/bootstrap.mjs'
import { hashPassword } from '../auth/password.mjs'

async function seed() {
  const isPostgres = !!process.env.DATABASE_URL
  console.log(`[seed] Connecting to ${isPostgres ? 'PostgreSQL (DATABASE_URL)' : 'SQLite'} database...`)

  const db = initDb()

  console.log('[seed] Ensuring schema migrations are up to date...')
  const migrationsApplied = await runMigrations(db)
  console.log(`[seed] Migrations applied: ${migrationsApplied}`)

  // 1. Bootstrap Admin user
  console.log('[seed] Bootstrapping administrator account...')
  const adminResult = await bootstrapAdmin(db)

  // 2. Bootstrap Demo Traveler user
  console.log('[seed] Bootstrapping demo traveler account...')
  await bootstrapDemoUser(db)

  const customerEmail = 'traveler@example.com'
  const customerPassword = process.env.DEMO_USER_PASSWORD || 'Traveler123!'
  const passwordHash = await hashPassword(customerPassword)
  const now = new Date().toISOString()

  const existingCustomer = await db.prepare('SELECT id FROM users WHERE email = ?').get(customerEmail)
  const targetUserId = existingCustomer ? existingCustomer.id : 'usr-demo-traveler'

  await db.prepare(`
    UPDATE users
    SET display_name = ?,
        password_hash = ?,
        phone = ?,
        home_city = ?,
        travel_style = ?,
        budget_pref = ?,
        preferences_json = ?,
        is_active = 1
    WHERE id = ?
  `).run(
    'Aarav Sharma',
    passwordHash,
    '+91 98765 43210',
    'Mumbai',
    'adventure',
    'medium',
    JSON.stringify({ foodPreference: 'vegetarian', preferredCurrency: 'INR', pace: 'moderate' }),
    targetUserId
  )

  // 3. Seed sample trips linked to customer
  const trip1Id = 'trip-himachal-demo'
  const trip2Id = 'trip-goa-demo'

  const sampleTrip1 = {
    id: trip1Id,
    title: 'Himachal Mountain Escape',
    subtitle: 'Scenic Himalayan viewpoints, valleys and cafe trails',
    startDate: '2026-10-15',
    phase: 'active',
    currency: 'INR',
    days: [
      {
        id: 'day-1',
        title: 'Arrival in Manali & Old Manali Cafes',
        night: 'Manali',
        color: '#4f46e5',
        items: [
          { id: 'act-1', type: 'activity', title: 'Hadimba Devi Temple', time: '10:00', dur: 90, price: 100, lat: 32.2483, lng: 77.1802 },
          { id: 'act-2', type: 'food', title: 'Old Manali Cafe Trail & Trout Lunch', time: '13:00', dur: 90, price: 800, lat: 32.2541, lng: 77.1754 },
          { id: 'act-3', type: 'hotel', title: 'Himalayan River Resort', time: '18:00', dur: 60, price: 4200, lat: 32.2432, lng: 77.1892 }
        ]
      },
      {
        id: 'day-2',
        title: 'Solang Valley & Rohtang Pass Drive',
        night: 'Manali',
        color: '#059669',
        items: [
          { id: 'act-4', type: 'activity', title: 'Solang Valley Paragliding', time: '09:30', dur: 180, price: 2500, lat: 32.3167, lng: 77.1583 },
          { id: 'act-5', type: 'drive', title: 'Atal Tunnel Drive', time: '14:00', dur: 120, price: 500, lat: 32.3667, lng: 77.1400 }
        ]
      }
    ],
    checklist: [
      { id: 'c-1', text: 'Pack warm windproof jackets', done: true },
      { id: 'c-2', text: 'Confirm Solang Valley adventure permit', done: false }
    ],
    suggestions: []
  }

  const sampleTrip2 = {
    id: trip2Id,
    title: 'Sunny Goa Coastal Retreat',
    subtitle: 'Sunsets, Portuguese heritage & beachside shacks',
    startDate: '2026-11-20',
    phase: 'active',
    currency: 'INR',
    days: [
      {
        id: 'day-g1',
        title: 'North Goa Beaches & Sunset',
        night: 'Anjuna',
        color: '#f59e0b',
        items: [
          { id: 'act-g1', type: 'activity', title: 'Anjuna Flea Market & Beach Walk', time: '11:00', dur: 120, price: 300, lat: 15.5733, lng: 73.7411 },
          { id: 'act-g2', type: 'food', title: 'Curlies Beach Shack Dinner', time: '19:00', dur: 120, price: 1500, lat: 15.5689, lng: 73.7425 }
        ]
      }
    ],
    checklist: [
      { id: 'c-g1', text: 'Rent a scooter at Dabolim airport', done: true }
    ],
    suggestions: []
  }

  const upsertTrip = async (trip) => {
    const existing = await db.prepare('SELECT id FROM trips WHERE id = ?').get(trip.id)
    if (existing) {
      await db.prepare('UPDATE trips SET user_id = ?, title = ?, data_json = ?, updated_at = ? WHERE id = ?')
        .run(targetUserId, trip.title, JSON.stringify(trip), now, trip.id)
    } else {
      await db.prepare('INSERT INTO trips (id, user_id, title, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(trip.id, targetUserId, trip.title, JSON.stringify(trip), now, now)
    }
  }

  await upsertTrip(sampleTrip1)
  await upsertTrip(sampleTrip2)

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@mytripplanner.local'
  const adminPassword = process.env.ADMIN_PASSWORD || 'AdminPass2026!'

  console.log('\n============================================================')
  console.log('[seed] Database seeded successfully!')
  console.log('------------------------------------------------------------')
  console.log('Demo Traveler Account:')
  console.log(`  Email:    ${customerEmail}`)
  console.log(`  Password: ${customerPassword}`)
  console.log('  Trips:    2 sample trips populated')
  console.log('------------------------------------------------------------')
  console.log('Administrator Account:')
  console.log(`  Email:    ${adminEmail}`)
  console.log(`  Password: ${adminPassword}`)
  console.log('============================================================\n')
}

seed()
  .catch((err) => {
    console.error('[seed] Error seeding database:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDb()
  })
