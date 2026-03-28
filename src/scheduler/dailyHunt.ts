// Daily rotating lead hunt schedule
// Runs every morning at 8am Sri Lanka time (UTC+5:30 = 2:30 UTC)

const LOCATIONS = [
  'Colombo', 'Kandy', 'Galle', 'Negombo',
  'Dehiwala', 'Moratuwa', 'Nugegoda',
  'Batticaloa', 'Jaffna', 'Matara'
]

// Rotating niches by day of week (0=Sunday, 1=Monday...)
const DAILY_NICHES: Record<number, string[]> = {
  1: ['restaurants', 'cafes'],
  2: ['gyms', 'fitness centres'],
  3: ['hotels', 'travel agencies'],
  4: ['salons', 'spas'],
  5: ['dental clinics', 'law firms'],
  6: ['real estate agencies', 'retail shops'],
  0: [] // Sunday — rest day
}

export function getTodaysNiches(): string[] {
  const day = new Date().getDay()
  return DAILY_NICHES[day] ?? []
}

export function getTodaysTargets(): { niche: string; location: string }[] {
  const niches = getTodaysNiches()
  const targets: { niche: string; location: string }[] = []
  for (const niche of niches) {
    for (const location of LOCATIONS) {
      targets.push({ niche, location })
    }
  }
  return targets
}

export { LOCATIONS }
