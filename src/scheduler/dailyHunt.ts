// Daily rotating lead hunt schedule
// Runs every morning at 8am Sri Lanka time (UTC+5:30 = 2:30 UTC)
//
// Uses a 3-week rotating cycle so the same niches aren't hunted every week.
// Each cycle = 18 niche pairs × 10 locations = 180 unique searches before repeating.

const LOCATIONS = [
  'Colombo', 'Kandy', 'Galle', 'Negombo',
  'Dehiwala', 'Moratuwa', 'Nugegoda',
  'Batticaloa', 'Jaffna', 'Matara'
]

// 3-week rotation indexed by [weekCycle 0|1|2][dayOfWeek 1-6]
// Each day gets 2-3 niches × 10 locations
const ROTATION: Record<number, Record<number, string[]>> = {

  // ── Week A ────────────────────────────────────────────────────────────────
  0: {
    1: ['restaurants', 'cafes'],
    2: ['gyms', 'fitness centres'],
    3: ['hotels', 'travel agencies'],
    4: ['salons', 'spas'],
    5: ['dental clinics', 'law firms'],
    6: ['real estate agencies', 'interior designers'],
    0: [],  // Sunday — rest
  },

  // ── Week B ────────────────────────────────────────────────────────────────
  1: {
    1: ['bakeries', 'catering services'],
    2: ['yoga studios', 'pilates studios'],
    3: ['guesthouses', 'villa rentals'],
    4: ['nail salons', 'barbershops'],
    5: ['accounting firms', 'consulting firms'],
    6: ['clothing boutiques', 'jewelry stores'],
    0: [],
  },

  // ── Week C ────────────────────────────────────────────────────────────────
  2: {
    1: ['photographers', 'event planners'],
    2: ['physiotherapy clinics', 'wellness centres'],
    3: ['tour operators', 'event venues'],
    4: ['bridal studios', 'beauty clinics'],
    5: ['marketing agencies', 'insurance companies'],
    6: ['furniture shops', 'electronics shops'],
    0: [],
  },
}

// Bonus niches added to the daily hunt once every 3 weeks (week C, extra pass)
// These supplement the main rotation with high-value Sri Lankan niches
export const BONUS_NICHES: Record<number, string[]> = {
  1: ['wedding planners', 'florists'],
  2: ['ayurvedic clinics', 'nutritionists'],
  3: ['car dealerships', 'driving schools'],
  4: ['pet shops', 'gift shops'],
  5: ['architects', 'construction companies'],
  6: ['sports shops', 'bookshops'],
}

/** ISO week number (1-52) */
function getISOWeek(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 4 - (d.getDay() || 7))
  const yearStart = new Date(d.getFullYear(), 0, 1)
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
}

export function getTodaysNiches(): string[] {
  const day       = new Date().getDay()
  const weekCycle = getISOWeek() % 3   // 0, 1, or 2
  const niches    = ROTATION[weekCycle]?.[day] ?? []

  // On week C, append bonus niches for the day
  if (weekCycle === 2) {
    const bonus = BONUS_NICHES[day] ?? []
    return [...niches, ...bonus]
  }

  return niches
}

export function getTodaysTargets(): { niche: string; location: string }[] {
  const niches  = getTodaysNiches()
  const targets: { niche: string; location: string }[] = []
  for (const niche of niches) {
    for (const location of LOCATIONS) {
      targets.push({ niche, location })
    }
  }
  return targets
}

/** Human-readable summary of today's hunt */
export function getTodaysSummary(): string {
  const niches    = getTodaysNiches()
  const weekCycle = getISOWeek() % 3
  const weekLabel = ['A', 'B', 'C'][weekCycle]
  if (niches.length === 0) return 'Rest day — no hunt today.'
  return `Week ${weekLabel} · ${niches.join(', ')} · ${LOCATIONS.length} locations · ${niches.length * LOCATIONS.length} searches`
}

// Every niche across all weeks + bonus — used for mega hunts
export const ALL_NICHES: string[] = [
  // Week A
  'restaurants', 'cafes',
  'gyms', 'fitness centres',
  'hotels', 'travel agencies',
  'salons', 'spas',
  'dental clinics', 'law firms',
  'real estate agencies', 'interior designers',
  // Week B
  'bakeries', 'catering services',
  'yoga studios', 'pilates studios',
  'guesthouses', 'villa rentals',
  'nail salons', 'barbershops',
  'accounting firms', 'consulting firms',
  'clothing boutiques', 'jewelry stores',
  // Week C
  'photographers', 'event planners',
  'physiotherapy clinics', 'wellness centres',
  'tour operators', 'event venues',
  'bridal studios', 'beauty clinics',
  'marketing agencies', 'insurance companies',
  'furniture shops', 'electronics shops',
  // Bonus
  'wedding planners', 'florists',
  'ayurvedic clinics', 'nutritionists',
  'car dealerships', 'driving schools',
  'pet shops', 'gift shops',
  'architects', 'construction companies',
  'sports shops', 'bookshops',
]

export { LOCATIONS }
