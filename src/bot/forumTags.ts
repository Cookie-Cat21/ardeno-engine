import { ForumChannel, ChannelType } from 'discord.js'

// All tags we want in the leads forum
export const DESIRED_TAGS = [
  // Niche tags
  { name: 'Restaurant', emoji: '🍽️' },
  { name: 'Gym', emoji: '💪' },
  { name: 'Cafe', emoji: '☕' },
  { name: 'Hotel', emoji: '🏨' },
  { name: 'Salon', emoji: '💆' },
  { name: 'Retail', emoji: '🛍️' },
  { name: 'Other', emoji: '🏢' },
  // Priority tags
  { name: 'Hot Lead', emoji: '⚡' },
  { name: 'Later', emoji: '⏳' },
]

// Niche keyword → tag name mapping
const NICHE_MAP: Record<string, string> = {
  restaurant: 'Restaurant',
  restaurants: 'Restaurant',
  cafe: 'Cafe',
  cafes: 'Cafe',
  coffee: 'Cafe',
  gym: 'Gym',
  gyms: 'Gym',
  fitness: 'Gym',
  hotel: 'Hotel',
  hotels: 'Hotel',
  salon: 'Salon',
  salons: 'Salon',
  spa: 'Salon',
  retail: 'Retail',
  shop: 'Retail',
  store: 'Retail',
}

export function getNicheTagName(niche: string): string {
  const key = niche.toLowerCase().trim()
  for (const [keyword, tagName] of Object.entries(NICHE_MAP)) {
    if (key.includes(keyword)) return tagName
  }
  return 'Other'
}

// Ensure all tags exist in the forum, create missing ones
export async function ensureForumTags(forum: ForumChannel): Promise<void> {
  const existing = forum.availableTags.map(t => t.name)
  const missing = DESIRED_TAGS.filter(t => !existing.includes(t.name))

  if (missing.length === 0) return

  const updatedTags = [
    ...forum.availableTags,
    ...missing.map(t => ({ name: t.name, emoji: { name: t.emoji } }))
  ]

  await forum.setAvailableTags(updatedTags as any)
  console.log(`[ForumTags] Created ${missing.length} missing tags: ${missing.map(t => t.name).join(', ')}`)
}

// Get tag IDs by name from a forum channel
export function getTagIds(forum: ForumChannel, ...names: string[]): string[] {
  return names
    .map(name => forum.availableTags.find(t => t.name === name)?.id)
    .filter((id): id is string => !!id)
}
