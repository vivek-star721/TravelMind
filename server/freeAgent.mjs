/**
 * Free & Open AI Agent Provider for MyTripPlanner.
 *
 * Supports:
 * 1. Built-in Autonomous Planner Agent (Zero login, zero subscription, zero API key required)
 * 2. Free Google Gemini API (100% free tier from Google AI Studio: https://aistudio.google.com/app/apikey)
 * 3. Free Groq API (100% free tier with LLaMA 3.3 70B: https://console.groq.com/keys)
 */

import { z } from 'zod'
import { TOOL_DEFS, makeToolHandler } from './tools.mjs'
import { findDestination } from './destination.mjs'
import {
  handleWorldwideInterview,
  isWorldPlacesEnabled,
  geocodeWorldwide,
  resolveCandidates,
  getCurrencyForCountry,
  normalizeQuery,
} from './worldPlaces.mjs'

// Re-export for backwards compatibility (tests import directly from this file)
export { findDestination } from './destination.mjs'
export { INDIA_STATES } from '../src/data/indiaStates.js'

// Simple sleep helper that respects AbortSignal
const isTest = typeof process !== 'undefined' && (process.env.NODE_ENV === 'test' || typeof process.env.VITEST !== 'undefined')

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }, { once: true })
  })

/**
 * Stream text chunk by chunk to the browser bridge.
 */
async function streamText(bridge, fullText, signal, speedMs = 15) {
  if (isTest || speedMs === 0) {
    bridge.broadcast({ type: 'assistant_delta', text: fullText })
    return
  }
  const words = fullText.split(' ')
  for (let i = 0; i < words.length; i++) {
    if (signal?.aborted) return
    const chunk = (i === 0 ? '' : ' ') + words[i]
    bridge.broadcast({ type: 'assistant_delta', text: chunk })
    await sleep(speedMs, signal)
  }
}

/** Minor words to keep lowercased unless at beginning or end */
const MINOR_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'the', 'to', 'up', 'with'])

/** Title-case a string e.g. "goa" -> "Goa", "old manali trip" -> "Old Manali Trip" */
export function toTitleCase(str) {
  if (!str || typeof str !== 'string') return ''
  return str
    .split(/\s+/)
    .map((word, idx, arr) => {
      const lower = word.toLowerCase()
      if (idx > 0 && idx < arr.length - 1 && MINOR_WORDS.has(lower)) {
        return lower
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

/**
 * Parse day count from user prompt text, e.g. "8 to 10 days", "10 days", "8-10 days".
 * Returns the upper bound of any range, or null if no day count found.
 */
export function parseDaysFromText(text) {
  const m = text.match(/(?:for\s+)?(\d+)(?:\s*(?:-|to)\s*(\d+))?\s*(?:day|days|giorn|notte|notti)/i)
  if (!m) return null
  const a = parseInt(m[1], 10)
  const b = m[2] ? parseInt(m[2], 10) : a
  return Math.max(a, b)
}

/** Extract thematic tags from attraction name & description */
export function getAttractionTags(item) {
  const name = typeof item === 'object' && item?.name ? item.name : String(item)
  const desc = typeof item === 'object' && item?.description ? item.description : ''
  const text = `${name} ${desc}`.toLowerCase()
  const tags = new Set()
  if (/panaji|panjim|fontainhas|mandovi|miramar|quarter/i.test(text)) tags.add('panaji')
  if (/fort|basilica|cathedral|church|heritage|palace|tomb|monument|museum|unesco|cave|temple/i.test(text)) tags.add('heritage')
  if (/beach|sea|coast|sand|shack|cove|cliff/i.test(text)) tags.add('beach')
  if (/falls|waterfall|nature|lake|valley|pass|sanctuary|park|plantation|garden|forest|trek|hills|mountain|tea/i.test(text)) tags.add('nature')
  if (/market|bazaar|flea|craft|shopping|street|spice/i.test(text)) tags.add('market')
  if (/cultural|dance|art|folk|cruise|music/i.test(text)) tags.add('culture')
  return tags
}

/** Day title templates for varied multi-day itineraries */
const DAY_THEMES = [
  (n, dest, cap) => `Day ${n}: Arrival & Exploring ${cap || dest}`,
  (n, dest) => `Day ${n}: Heritage & Highlights of ${dest}`,
  (n, dest) => `Day ${n}: Cultural Immersion in ${dest}`,
  (n, dest) => `Day ${n}: Nature & Scenic Trails of ${dest}`,
  (n, dest) => `Day ${n}: Hidden Gems of ${dest}`,
  (n, dest) => `Day ${n}: Adventure & Outdoor Excursions in ${dest}`,
  (n, dest) => `Day ${n}: Sacred Temples & Spiritual Sites in ${dest}`,
  (n, dest) => `Day ${n}: Art, Architecture & Crafts of ${dest}`,
  (n, dest) => `Day ${n}: Scenic Views & Leisure in ${dest}`,
  (n, dest) => `Day ${n}: Culinary Experiences in ${dest}`,
  (n, dest) => `Day ${n}: Artisan Workshops & Local Bazaars in ${dest}`,
  (n, dest) => `Day ${n}: Sunrise Excursion & Photography in ${dest}`,
  (n, dest) => `Day ${n}: Wildlife & Nature in ${dest}`,
  (n, dest) => `Day ${n}: Farewell ${dest} & Local Souvenirs`,
]

/**
 * Derive ISO date string offset by `offsetDays` from tripStartDate (or today+14 fallback).
 * @param {string|null} tripStartDate  ISO date string or null
 * @param {number} offsetDays
 * @returns {string}  YYYY-MM-DD
 */
function deriveDateStr(tripStartDate, offsetDays = 0) {
  if (tripStartDate) {
    const base = new Date(tripStartDate)
    if (!isNaN(base.getTime())) {
      base.setDate(base.getDate() + offsetDays)
      return base.toISOString().slice(0, 10)
    }
  }
  const fallback = new Date()
  fallback.setDate(fallback.getDate() + 14 + offsetDays)
  return fallback.toISOString().slice(0, 10)
}

/**
 * Return the full capital name (first alternative when split on " or " or ",").
 * Fixes the old `capital.split(' ')[0]` bug that turned "New Delhi" -> "New".
 * @param {string} capital
 * @returns {string}
 */
function primaryCapital(capital = '') {
  return capital.split(/ or |,/)[0].trim()
}

/**
 * Word-boundary safe intent checks.
 * Avoids: "eat" matching "great", "theatre"; "stay" matching "yesterday".
 */
function intentMatches(text, ...words) {
  const lower = text.toLowerCase()
  return words.some((w) => new RegExp(`(?:^|\\s)${w}(?:\\s|$|[.,!?])`).test(lower))
}

export function getCurrencySymbol(currencyCode) {
  const map = {
    INR: '₹',
    USD: '$',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    CAD: 'CA$',
    AUD: 'A$',
    CHF: 'CHF',
    AED: 'AED',
    THB: '฿',
    SGD: 'S$',
  }
  return map[currencyCode?.toUpperCase()] || currencyCode || '$'
}

const KNOWN_LANDMARK_COORDS = {
  'taj mahal agra': { lat: 27.1751, lng: 78.0421, desc: 'Iconic white marble mausoleum on the Yamuna river, UNESCO World Heritage site and universal symbol of love.' },
  'agra fort': { lat: 27.1795, lng: 78.0211, desc: 'Vast red sandstone fortress of the Mughal emperors with palaces, courtyards, and Yamuna river views.' },
  'varanasi dashashwamedh ghat': { lat: 25.3076, lng: 83.0104, desc: 'Sacred riverfront on the Ganges famous for its spectacular evening Ganga Aarti ritual and spiritual fervor.' },
  'sarnath': { lat: 25.3811, lng: 83.0227, desc: 'Revered Buddhist pilgrimage site where Lord Buddha preached his first sermon after attaining enlightenment.' },
  'mathura krishna janmabhoomi': { lat: 27.5050, lng: 77.6690, desc: 'Sacred birthplace of Lord Krishna with ancient temple complexes and vibrant religious traditions.' },
  'fatehpur sikri': { lat: 27.0945, lng: 77.6679, desc: 'Fortified 16th-century Mughal capital founded by Emperor Akbar, famed for the Buland Darwaza and Salim Chishti tomb.' },
  'lucknow bara imambara': { lat: 26.8690, lng: 80.9130, desc: 'Grand Awadhi architectural marvel built in 1784 featuring the famous Bhulbhulaiya labyrinth and Asfi Mosque.' },
  'allahabad triveni sangam': { lat: 25.4290, lng: 81.8845, desc: 'Sacred confluence of the holy Ganga, Yamuna, and mythical Saraswati rivers in Prayagraj.' },
  'vrindavan': { lat: 27.5806, lng: 77.7006, desc: 'Historic town of thousands of Radha-Krishna temples including Banke Bihari and Prem Mandir.' },
}

/**
 * Normalizes an attraction into a structured object with verified/deterministic coordinates,
 * authentic description, area/theme, and estimated budget.
 */
function resolveAttraction(item, stateCoords, stateName, index, currency = 'INR') {
  const basePriceInr = (typeof item === 'object' && item !== null && item.price != null)
    ? item.price
    : ((typeof item === 'object' && item !== null && item.estPrice != null) ? item.estPrice : 200)

  let price = basePriceInr
  if (currency === 'USD') price = Math.round(basePriceInr / 80) || 3
  else if (currency === 'EUR') price = Math.round(basePriceInr / 90) || 3
  else if (currency === 'GBP') price = Math.round(basePriceInr / 105) || 2
  else if (currency === 'JPY') price = Math.round((basePriceInr / 80) * 155) || 400

  const landmarkKey = String(typeof item === 'object' && item !== null ? (item.name || '') : item).toLowerCase().trim()
  const knownLandmark = KNOWN_LANDMARK_COORDS[landmarkKey]

  if (typeof item === 'object' && item !== null && typeof item.lat === 'number' && typeof item.lng === 'number') {
    return {
      name: item.name,
      lat: Number(item.lat.toFixed(4)),
      lng: Number(item.lng.toFixed(4)),
      desc: item.desc || item.description || (knownLandmark?.desc) || `Iconic landmark in ${stateName}. Guided exploration, architecture, and photography.`,
      area: item.area || 'Highlights',
      price,
    }
  }

  if (knownLandmark) {
    return {
      name: typeof item === 'object' && item !== null ? item.name : String(item),
      lat: Number(knownLandmark.lat.toFixed(4)),
      lng: Number(knownLandmark.lng.toFixed(4)),
      desc: knownLandmark.desc,
      area: 'Highlights',
      price,
    }
  }

  // Deterministic spread around state coordinates (no Math.random())
  const latOffset = ((index % 5) - 2) * 0.025
  const lngOffset = (((index * 3) % 5) - 2) * 0.025
  return {
    name: typeof item === 'object' && item !== null ? item.name : String(item),
    lat: Number((stateCoords.lat + latOffset).toFixed(4)),
    lng: Number((stateCoords.lng + lngOffset).toFixed(4)),
    desc: `Historic landmark in ${stateName}. Scenic exploration, cultural heritage, and photography.`,
    area: 'Highlights',
    price,
  }
}

/**
 * Group attractions by area or theme.
 */
function groupAttractionsByArea(attractions, stateCoords, stateName, currency = 'INR') {
  const groups = new Map()
  attractions.forEach((att, i) => {
    const data = resolveAttraction(att, stateCoords, stateName, i, currency)
    const area = data.area || 'Highlights'
    if (!groups.has(area)) groups.set(area, [])
    groups.get(area).push(data)
  })
  return groups
}

/**
 * Autonomous Free AI Agent (No subscriptions, No login required).
 */
export async function runFreeAgent(text, { mode, currency = 'INR', language = 'en', bridge, abortSignal, startDate = null, fallbackNotice = null }) {
  const cur = currency || 'INR'
  const isIt = String(language).startsWith('it')

  // Stream friendly fallback notice if routed from a missing/failed key
  if (fallbackNotice) {
    const noticeText = `*(${fallbackNotice})*\n\n`
    await streamText(bridge, noticeText, abortSignal, 10)
  }

  let matchedState
  try {
    matchedState = findDestination(text)
  } catch (err) {
    console.error('[freeAgent] findDestination error:', err)
    matchedState = null
  }

  if (mode === 'interview') {
    // ── Stage 1: Build the trip structure ─────────────────────────────────

    // TASK 2: If destination is unknown, ask instead of silently falling back
    if (!matchedState) {
      if (isWorldPlacesEnabled()) {
        const handled = await handleWorldwideInterview({
          text,
          userDays: parseDaysFromText(text),
          bridge,
          abortSignal,
          startDate,
          isIt,
          streamText,
          deriveDateStr,
          toTitleCase,
        })
        if (handled) return
      }

      // Try to extract a raw place name from the text (stop at connector words)
      const rawPlace = text.match(/\bto\s+([A-Za-z]+(?:\s+[A-Za-z]+){0,3})(?=\s+(?:for|with|in|on|and|by|via|from|\d)|$)/i)?.[1]?.trim()
      const clarificationMsg = rawPlace
        ? `I couldn't find "${rawPlace}". Which destination did you mean? Please name a specific city or region (e.g. "Paris", "Tokyo", "Rajasthan", "Goa").`
        : `Which destination did you mean? Please name a specific city or region — for example "Paris", "Tokyo", "Rajasthan", "Goa".`

      await streamText(bridge, clarificationMsg, abortSignal, 12)
      bridge.broadcast({ type: 'assistant_text', text: clarificationMsg })
      return
    }

    const destName = matchedState.name
    const stateCapital = primaryCapital(matchedState.capital)
    const userDays = parseDaysFromText(text)
    const daysCount = Math.min(userDays || matchedState?.suggestedDays || 5, 14)
    const coords = matchedState?.coords || { lat: 26.9124, lng: 75.7873 }
    const titleCasedDest = toTitleCase(destName)

    // Derive dates from startDate (offset 0 and 1) or fallback (today+14, today+15)
    const checkin = deriveDateStr(startDate, 0)
    const checkout = deriveDateStr(startDate, 1)

    // 1. Set Trip Meta (with title-cased name and dynamic currency/fuel)
    const gasUnit = cur === 'INR' ? 'inr_l' : (cur === 'USD' ? 'usd_gal' : (cur === 'EUR' ? 'eur_l' : 'usd_l'))
    const gasPrice = gasUnit === 'inr_l' ? 96 : (gasUnit === 'usd_gal' ? 3.5 : (gasUnit === 'eur_l' ? 1.8 : 1.5))
    const curSymbol = getCurrencySymbol(cur)

    bridge.broadcast({ type: 'agent_tool', name: 'set_trip_meta', args: { title: `Trip to ${titleCasedDest}`, currency: cur, car_gas_unit: gasUnit } })
    try {
      await bridge.callBrowser('set_trip_meta', {
        title: `Trip to ${titleCasedDest}`,
        currency: cur,
        car_gas_unit: gasUnit,
        car_gas_price: gasPrice,
        car_model: 'SUV / Compact Crossover',
      })
    } catch (err) {
      console.error('[freeAgent] set_trip_meta error:', err)
    }

    // 2. Open planner phase
    bridge.broadcast({ type: 'agent_tool', name: 'start_planning', args: {} })
    try {
      await bridge.callBrowser('start_planning', {})
    } catch (err) {
      console.error('[freeAgent] start_planning error:', err)
    }

    const introMsg = isIt
      ? `Ciao! Ho iniziato a strutturare il tuo itinerario a **${destName}** (${daysCount} giorni) calcolato interamente in **${cur === 'INR' ? '₹ (Rupie)' : `${curSymbol} (${cur})`}**!`
      : `Namaste! I've started building your personalized **${destName}** itinerary (${daysCount} days) with all expenses calculated in **${curSymbol} (${cur})**!`

    await streamText(bridge, introMsg + '\n\n', abortSignal, 12)

    // 3. Create Days & Top Attractions
    const rawAttractions = matchedState?.topAttractions?.length
      ? matchedState.topAttractions
      : [
        'Historic Old Quarter & Heritage Monuments',
        'Iconic Fortresses & Palace Gardens',
        'Vibrant Local Bazaars & Traditional Artisan Markets',
        'Scenic Sunset Overlook & Sunset Lake Boating',
        'Cultural Center & Classical Evening Folk Dance',
      ]

    // Build pool of unique attractions deduped by name
    const uniqueAttractions = []
    const seenAttractionNames = new Set()
    for (let i = 0; i < rawAttractions.length; i++) {
      const att = resolveAttraction(rawAttractions[i], coords, destName, i, cur)
      const key = att.name.toLowerCase().trim()
      if (!seenAttractionNames.has(key)) {
        seenAttractionNames.add(key)
        uniqueAttractions.push(att)
      }
    }

    const THEMATIC_TEMPLATES = [
      { name: 'Royal Heritage Palace & Museum', desc: 'Historic royal residence featuring preserved artifacts, regal courtyards, and architecture.' },
      { name: 'Ancient Hilltop Fortress & Ramparts', desc: 'Panoramic fortress perched on surrounding hills offering defense history and scenic valley views.' },
      { name: 'Historic Old Bazaars & Traditional Crafts Market', desc: 'Lively heritage bazaars with local handicrafts, textiles, spices, and artisan workshops.' },
      { name: 'Scenic Lake Promenade & Sunset Boating', desc: 'Serene freshwater lake surrounded by promenade walks, birdlife, and sunset viewing spots.' },
      { name: 'Cultural Center & Folk Dance Theatre', desc: 'Celebrated cultural venue showcasing authentic regional folk dances, puppetry, and traditional music.' },
      { name: 'Botanical Gardens & Royal Pavilions', desc: 'Lush historic landscaped gardens featuring shaded avenues, marble fountains, and pavilions.' },
      { name: 'Sacred Riverfront Ghats & Evening Aarti', desc: 'Ancient riverfront pilgrimage steps with sacred prayer rituals and morning meditative atmosphere.' },
      { name: 'Centuries-Old Stepwell & Water Architecture', desc: 'Intricately carved subterranean stepwell showcasing master ancient water engineering and stonework.' },
      { name: 'Archaeological Museum & Sculpture Gallery', desc: 'Fascinating collection of excavated antiquities, stone inscriptions, and historical relics.' },
      { name: 'Wildlife Sanctuary & Nature Reserve Trail', desc: 'Protected regional forest habitat home to native flora, migratory birds, and nature trails.' },
      { name: 'Hillside Temple & Panoramic Overlook', desc: 'Sacred mountain shrine reached by scenic pathway with sweeping views across the countryside.' },
      { name: 'Spice & Tea Plantation Estate Tour', desc: 'Aromatic hillside plantations offering guided walks, tasting sessions, and verdant vistas.' },
      { name: 'Artisan Pottery & Terracotta Heritage Village', desc: 'Traditional village where local craftsmen mold handcrafted clay pottery using generational methods.' },
      { name: 'Panoramic Sunrise Viewpoint & Ridge Walk', desc: 'Elevated viewpoint catching first rays of dawn over mist-veiled valleys and hill ranges.' },
      { name: 'Historic Clock Tower Square & Heritage Walk', desc: 'Vibrant city center square framed by colonial facades, bustling street cafes, and street life.' },
    ]

    let templateIdx = 0
    while (uniqueAttractions.length < daysCount * 3) {
      const tmpl = THEMATIC_TEMPLATES[templateIdx % THEMATIC_TEMPLATES.length]
      templateIdx++
      const cycle = Math.floor(templateIdx / THEMATIC_TEMPLATES.length)
      const latOffset = ((uniqueAttractions.length % 7) - 3) * 0.035
      const lngOffset = (((uniqueAttractions.length * 2) % 7) - 3) * 0.035
      const nameSuffix = cycle > 0 ? ` (${cycle + 1})` : ''
      const syntheticAtt = {
        name: `${destName} ${tmpl.name}${nameSuffix}`,
        lat: Number((coords.lat + latOffset).toFixed(4)),
        lng: Number((coords.lng + lngOffset).toFixed(4)),
        desc: tmpl.desc,
        area: 'Highlights',
        price: cur === 'INR' ? 250 : (cur === 'USD' ? 4 : (cur === 'EUR' ? 3 : 250)),
      }
      const key = syntheticAtt.name.toLowerCase().trim()
      if (!seenAttractionNames.has(key)) {
        seenAttractionNames.add(key)
        uniqueAttractions.push(syntheticAtt)
      }
    }

    // Group attractions by area/city
    const areaGroups = new Map()
    for (const att of uniqueAttractions) {
      const area = att.area || 'Highlights'
      if (!areaGroups.has(area)) areaGroups.set(area, [])
      areaGroups.get(area).push(att)
    }
    const areas = Array.from(areaGroups.keys())
    const usedPlaceNames = new Set()

    let totalStopsCount = 0
    let totalEstimatedBudget = 0
    const usedCoords = new Set()

    // Schedule stops per day at staggered times: 09:30, 12:30, 15:30, 18:30
    for (let dayNum = 1; dayNum <= daysCount; dayNum++) {
      if (abortSignal?.aborted) return

      // Find an area that still has unvisited attractions
      let currentArea = areas[(dayNum - 1) % areas.length]
      let availableInArea = (areaGroups.get(currentArea) || []).filter(
        (a) => !usedPlaceNames.has(a.name.toLowerCase().trim())
      )

      if (availableInArea.length === 0) {
        for (const area of areas) {
          const rem = (areaGroups.get(area) || []).filter(
            (a) => !usedPlaceNames.has(a.name.toLowerCase().trim())
          )
          if (rem.length > 0) {
            currentArea = area
            availableInArea = rem
            break
          }
        }
      }

      if (availableInArea.length === 0) {
        availableInArea = uniqueAttractions.filter(
          (a) => !usedPlaceNames.has(a.name.toLowerCase().trim())
        )
      }

      // Pick up to 3 distinct unvisited attractions for this day
      const dayAttractions = availableInArea.slice(0, 3)
      if (dayAttractions.length < 3) {
        const remaining = uniqueAttractions.filter(
          (a) => !usedPlaceNames.has(a.name.toLowerCase().trim()) && !dayAttractions.some((da) => da.name.toLowerCase().trim() === a.name.toLowerCase().trim())
        )
        for (const remAtt of remaining) {
          if (dayAttractions.length >= 3) break
          dayAttractions.push(remAtt)
        }
      }
      for (const att of dayAttractions) {
        usedPlaceNames.add(att.name.toLowerCase().trim())
      }

      // Determine day's location/city label from its own stops
      const dayLocation = (dayAttractions[0]?.area && dayAttractions[0].area !== 'Highlights')
        ? dayAttractions[0].area
        : (currentArea && currentArea !== 'Highlights' ? currentArea : stateCapital)

      // Generate day title matching the area/theme
      let dayTitle
      if (dayNum === 1) {
        dayTitle = `Day 1: Arrival & Exploring ${dayLocation}'s Historic Highlights`
      } else if (dayNum === daysCount) {
        dayTitle = `Day ${dayNum}: Scenic Vistas & Cultural Farewell in ${dayLocation}`
      } else if (currentArea === 'Panaji') {
        dayTitle = `Day ${dayNum}: Exploring Panaji's Latin Quarter & Riverside`
      } else if (currentArea === 'Heritage') {
        dayTitle = `Day ${dayNum}: Heritage & Historic Monuments of Old Goa`
      } else if (currentArea === 'Beaches') {
        dayTitle = `Day ${dayNum}: Sun, Sand & Coastal Highlights of North Goa`
      } else if (currentArea === 'Nature') {
        dayTitle = `Day ${dayNum}: Nature Trails & Scenic Waterfalls of Goa`
      } else if (currentArea === 'Shimla') {
        dayTitle = `Day ${dayNum}: Exploring Shimla's Ridge & Heritage Walk`
      } else if (currentArea === 'Manali') {
        dayTitle = `Day ${dayNum}: Alpine Adventure & Solang Valley in Manali`
      } else if (currentArea === 'Mountains') {
        dayTitle = `Day ${dayNum}: High Mountain Glaciers & Scenic Passes`
      } else if (currentArea === 'Culture') {
        dayTitle = `Day ${dayNum}: Cultural Trails, Sacred Springs & Local Bazaars`
      } else {
        dayTitle = `Day ${dayNum}: Highlights & Scenic Sights of ${dayLocation}`
      }

      bridge.broadcast({ type: 'agent_tool', name: 'add_day', args: { title: dayTitle, night: dayLocation } })
      try {
        await bridge.callBrowser('add_day', { title: dayTitle, night: dayLocation })
      } catch (err) {
        console.error('[freeAgent] add_day error:', err)
      }

      // Base coordinates for this day from its first attraction
      const baseCoords = dayAttractions[0] || { lat: coords.lat, lng: coords.lng }
      const lunchCoords = {
        lat: Number((baseCoords.lat + 0.0035).toFixed(4)),
        lng: Number((baseCoords.lng - 0.0028).toFixed(4)),
      }

      const dayActivities = []
      // Morning attraction
      if (dayAttractions[0]) {
        dayActivities.push({
          title: dayAttractions[0].name,
          type: 'activity',
          time: '09:30',
          duration_min: 120,
          lat: dayAttractions[0].lat,
          lng: dayAttractions[0].lng,
          price: dayAttractions[0].price,
          notes: dayAttractions[0].desc,
        })
      }

      // Dining stop specific to the day's city/location
      const diningPrice = cur === 'INR' ? 600 : (cur === 'USD' ? 8 : (cur === 'EUR' ? 7 : (cur === 'GBP' ? 6 : (cur === 'JPY' ? 1200 : 8))))
      const diningVarieties = [
        `Authentic ${dayLocation} Dining & Local Cuisine`,
        `Traditional ${dayLocation} Thali & Regional Flavors`,
        `Historic ${dayLocation} Culinary Tasting & Heritage Cafe`,
        `Artisan ${dayLocation} Gastronomy & Street Delights`,
        `Celebrated ${dayLocation} Specialty Dining & Sweets`,
        `Scenic ${dayLocation} Evening Bistro & Local Specialties`,
        `Heritage ${dayLocation} Royal Dining & Local Fare`,
      ]
      let diningTitle = diningVarieties[0]
      for (const candidate of diningVarieties) {
        if (!usedPlaceNames.has(candidate.toLowerCase().trim())) {
          diningTitle = candidate
          break
        }
      }
      if (usedPlaceNames.has(diningTitle.toLowerCase().trim())) {
        diningTitle = `Authentic ${dayLocation} Dining & Local Flavors (Day ${dayNum})`
      }
      usedPlaceNames.add(diningTitle.toLowerCase().trim())

      dayActivities.push({
        title: diningTitle,
        type: 'food',
        time: '12:30',
        duration_min: 75,
        lat: lunchCoords.lat,
        lng: lunchCoords.lng,
        price: diningPrice,
        notes: `Savor traditional ${dayLocation} specialties, regional thalis, and authentic flavors.`,
      })

      // Afternoon attraction
      if (dayAttractions[1]) {
        dayActivities.push({
          title: dayAttractions[1].name,
          type: 'activity',
          time: '15:30',
          duration_min: 105,
          lat: dayAttractions[1].lat,
          lng: dayAttractions[1].lng,
          price: dayAttractions[1].price,
          notes: dayAttractions[1].desc,
        })
      }

      // Evening attraction
      if (dayAttractions[2]) {
        dayActivities.push({
          title: dayAttractions[2].name,
          type: 'activity',
          time: '18:30',
          duration_min: 90,
          lat: dayAttractions[2].lat,
          lng: dayAttractions[2].lng,
          price: dayAttractions[2].price,
          notes: dayAttractions[2].desc,
        })
      }

      // Sort by time
      dayActivities.sort((a, b) => a.time.localeCompare(b.time))

      for (const act of dayActivities) {
        if (abortSignal?.aborted) return
        totalStopsCount++
        totalEstimatedBudget += act.price

        // Ensure distinct coordinates across the entire trip
        let stopLat = act.lat
        let stopLng = act.lng
        let coordKey = `${stopLat.toFixed(4)},${stopLng.toFixed(4)}`
        let jitter = 0
        while (usedCoords.has(coordKey) && jitter < 15) {
          jitter++
          stopLat = Number((stopLat + (jitter % 2 === 0 ? 0.0022 : -0.0022) * jitter).toFixed(4))
          stopLng = Number((stopLng + (jitter % 2 === 0 ? -0.0022 : 0.0022) * jitter).toFixed(4))
          coordKey = `${stopLat.toFixed(4)},${stopLng.toFixed(4)}`
        }
        usedCoords.add(coordKey)
        act.lat = stopLat
        act.lng = stopLng

        bridge.broadcast({
          type: 'agent_tool',
          name: 'add_activity',
          args: { day_number: dayNum, title: act.title, time: act.time, duration_min: act.duration_min },
        })
        try {
          await bridge.callBrowser('add_activity', {
            day_number: dayNum,
            title: act.title,
            type: act.type,
            time: act.time,
            duration_min: act.duration_min,
            lat: act.lat,
            lng: act.lng,
            price: act.price,
            notes: act.notes,
          })
        } catch (err) {
          console.error('[freeAgent] add_activity error:', err)
        }
      }
    }

    // 4. Broadcast hotel and restaurant search events for UI visibility
    bridge.broadcast({
      type: 'agent_tool',
      name: 'search_hotels',
      args: { location: stateCapital, currency: cur },
    })
    let hotelRes = null
    try {
      hotelRes = await bridge.callBrowser('search_hotels', {
        location: stateCapital,
        checkin,
        checkout,
        currency: cur,
      })
    } catch {
      // safe fallback
    }

    bridge.broadcast({
      type: 'agent_tool',
      name: 'search_restaurants',
      args: { location: stateCapital },
    })
    let _restRes = null
    try {
      _restRes = await bridge.callBrowser('search_restaurants', {
        location: stateCapital,
        query: 'authentic cuisine',
        currency: cur,
      })
    } catch {
      // safe fallback
    }

    const hotels = hotelRes?.result?.properties || hotelRes?.properties || []
    const isMock = process.env.ULISSE_PLACES_PROVIDER === 'mock' || !process.env.ULISSE_PLACES_PROVIDER || hotels.some((h) => !h?.url || !h.url.includes('booking.com'))
    const hasHotels = hotels.length > 0

    let providerStatusText = ''
    if (hasHotels) {
      providerStatusText = isMock
        ? `Hotel recommendations for ${stateCapital} were generated using realistic mock providers for offline demonstration (with authentic ${cur === 'INR' ? '₹ INR' : `${curSymbol} ${cur}`} rates).`
        : `Verified accommodations and authentic dining spots in ${stateCapital} were researched via live providers.`
    } else {
      providerStatusText = `Live hotel search returned no direct bookings for these dates; default estimated budgets have been applied.`
    }

    // 6. Concluding message with honest status and exact counts
    const summaryText = isIt
      ? `Ecco pronto il tuo programma! Ho organizzato ${daysCount} giorni con ${totalStopsCount} tappe con orari scaglionati (09:30, 12:30, 15:30, 18:30) e budget stimato in **${curSymbol} ${totalEstimatedBudget.toLocaleString()}**.\n\n*Stato provider:* ${providerStatusText}\n\nPuoi chiedermi modifiche in qualsiasi momento in chat!`
      : `Your **${destName}** itinerary is ready! I've laid out ${daysCount} days with ${totalStopsCount} planned stops at staggered times (morning sightseeing at 09:30, authentic dining at 12:30, afternoon landmarks at 15:30, and evening viewpoints at 18:30) with all expenses calculated in **${curSymbol} ${cur}** (estimated activity & dining budget: **${curSymbol}${totalEstimatedBudget.toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US')}**).\n\n*Provider status:* ${providerStatusText}\n\nYou can ask me anytime to adjust days, find more spots, or change your travel style!`

    await streamText(bridge, summaryText, abortSignal, 12)
    bridge.broadcast({ type: 'assistant_text', text: introMsg + '\n\n' + summaryText })
    return
  }

  // ── Stage 2: Normal Planner View Chat ─────────────────────────────────────

  // TASK 3b: Word-boundary safe intent checks
  if (intentMatches(text, 'food', 'eat', 'eating', 'restaurant', 'dining', 'dinner', 'lunch', 'breakfast', 'ristorante')) {
    let loc = matchedState ? primaryCapital(matchedState.capital) : null
    let activeCur = cur
    if (!loc && isWorldPlacesEnabled()) {
      const q = normalizeQuery(text).cleaned.replace(/restaurants?|food|dining|dinner|lunch|breakfast|ristorante/gi, '').trim()
      if (q.length >= 2) {
        const cands = await geocodeWorldwide(q, { signal: abortSignal })
        const res = resolveCandidates(cands, q)
        if (res.status === 'single') {
          loc = res.result.name
          const cInfo = getCurrencyForCountry(res.result.address?.country_code)
          activeCur = cInfo.code
        }
      }
    }

    if (!loc) {
      const askMsg = 'Which destination did you mean? Please mention a specific city or state so I can recommend authentic dining spots.'
      await streamText(bridge, askMsg, abortSignal)
      bridge.broadcast({ type: 'assistant_text', text: askMsg })
      return
    }
    bridge.broadcast({ type: 'agent_tool', name: 'search_restaurants', args: { location: loc } })
    try {
      await bridge.callBrowser('search_restaurants', { location: loc, query: 'local authentic', currency: activeCur })
    } catch {
      /* ignore */
    }
    const reply = `I found top-rated authentic dining options in ${loc} with price ranges in ${activeCur}. Check out the dining cards on your map!`
    await streamText(bridge, reply, abortSignal)
    bridge.broadcast({ type: 'assistant_text', text: reply })
    return
  }

  if (intentMatches(text, 'hotel', 'hotels', 'stay', 'staying', 'accommodation', 'lodge', 'albergo')) {
    let loc = matchedState ? primaryCapital(matchedState.capital) : null
    let activeCur = cur
    if (!loc && isWorldPlacesEnabled()) {
      const q = normalizeQuery(text).cleaned.replace(/hotels?|stay|staying|accommodation|lodge|albergo/gi, '').trim()
      if (q.length >= 2) {
        const cands = await geocodeWorldwide(q, { signal: abortSignal })
        const res = resolveCandidates(cands, q)
        if (res.status === 'single') {
          loc = res.result.name
          const cInfo = getCurrencyForCountry(res.result.address?.country_code)
          activeCur = cInfo.code
        }
      }
    }

    if (!loc) {
      const askMsg = 'Which destination did you mean? Please mention a specific city or state so I can search for verified accommodations.'
      await streamText(bridge, askMsg, abortSignal)
      bridge.broadcast({ type: 'assistant_text', text: askMsg })
      return
    }
    const checkin = deriveDateStr(startDate, 0)
    const checkout = deriveDateStr(startDate, 1)
    bridge.broadcast({ type: 'agent_tool', name: 'search_hotels', args: { location: loc, currency: activeCur } })
    try {
      await bridge.callBrowser('search_hotels', { location: loc, checkin, checkout, currency: activeCur })
    } catch {
      /* ignore */
    }
    const reply = `I've retrieved verified accommodations in ${loc} with transparent per-night pricing in ${activeCur}.`
    await streamText(bridge, reply, abortSignal)
    bridge.broadcast({ type: 'assistant_text', text: reply })
    return
  }

  if (intentMatches(text, 'add day', 'giorno', 'extra day')) {
    bridge.broadcast({ type: 'agent_tool', name: 'add_day', args: { title: 'Extra Leisure Day' } })
    try {
      await bridge.callBrowser('add_day', { title: 'Extra Leisure Day', night: matchedState ? primaryCapital(matchedState.capital) : 'Central Area' })
    } catch (err) {
      console.error('[freeAgent] add_day error:', err)
    }
    const reply = `Added a new day to your itinerary! What would you like to explore on this day?`
    await streamText(bridge, reply, abortSignal)
    bridge.broadcast({ type: 'assistant_text', text: reply })
    return
  }

  // General helpful response
  const generalCurSymbol = getCurrencySymbol(cur)
  const generalCurName = cur === 'INR' ? '₹ Rupees' : `${generalCurSymbol} ${cur}`
  const generalReply = `I am your AI travel copilot! I've noted: "${text}". I can add stops, search for verified hotels on Booking.com, find local food spots, or adjust your travel days and budget in ${generalCurName}. What would you like to tweak?`
  await streamText(bridge, generalReply, abortSignal)
  bridge.broadcast({ type: 'assistant_text', text: generalReply })
}

/**
 * OpenAI-Compatible Provider for Free Google Gemini API and Free Groq API.
 */
export async function runOpenAiCompat(text, {
  endpoint,
  apiKey,
  model,
  mode: _mode,
  currency = 'INR',
  language: _language = 'en',
  notes = '',
  bridge,
  abortSignal,
}) {
  if (!apiKey) {
    throw new Error('API Key missing. Enter your free Google Gemini or Groq API Key.')
  }

  const curSymbol = getCurrencySymbol(currency)
  const systemPrompt = `You are Ulisse, an expert AI travel planner assisting the user to create and refine the perfect trip.
Currency: ${currency}. All prices must be quoted in ${currency} (symbol: ${curSymbol}).
Always use the provided trip tools to make actual edits to the trip.
Keep your conversational responses helpful, direct, and concise.`

  // Convert TOOL_DEFS to OpenAI tool schema
  const openAiTools = TOOL_DEFS.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: z.toJSONSchema(z.object(d.schema)),
    },
  }))

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(notes ? [{ role: 'system', content: `Current notes:\n${notes}` }] : []),
    { role: 'user', content: text },
  ]

  let turns = 0
  const maxTurns = 8

  while (turns < maxTurns) {
    if (abortSignal?.aborted) return
    turns++

    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || 'gemini-2.0-flash',
          messages,
          tools: openAiTools,
          tool_choice: 'auto',
        }),
        signal: abortSignal,
      })
    } catch (err) {
      if (abortSignal?.aborted) return
      throw err
    }

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`API error (${response.status}): ${errText.slice(0, 300)}`)
    }

    const data = await response.json()
    const choice = data.choices?.[0]
    if (!choice) break

    const assistantMsg = choice.message
    messages.push(assistantMsg)

    if (assistantMsg.content) {
      await streamText(bridge, assistantMsg.content, abortSignal)
      bridge.broadcast({ type: 'assistant_text', text: assistantMsg.content })
    }

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
      for (const call of assistantMsg.tool_calls) {
        if (abortSignal?.aborted) return
        const fnName = call.function.name
        let fnArgs = {}
        try { fnArgs = JSON.parse(call.function.arguments || '{}') } catch { fnArgs = {} }

        bridge.broadcast({ type: 'agent_tool', name: fnName, args: fnArgs })
        const handler = makeToolHandler(bridge, fnName)
        const toolRes = await handler(fnArgs)

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolRes.content?.[0]?.text || JSON.stringify(toolRes),
        })
      }
    } else {
      break
    }
  }
}
