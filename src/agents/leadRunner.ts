import { searchLeads } from './scraper'
import { analyzeLead } from './analyzer'
import { saveLead } from '../db/supabase'
import type { Lead } from '../db/supabase'

export interface LeadRunResult {
  found: number
  saved: Lead[]
  errors: string[]
}

export async function runLeadEngine(
  niche: string,
  location: string,
  limit = 15,
  onProgress?: (msg: string) => void
): Promise<LeadRunResult> {
  const errors: string[] = []
  const saved: Lead[] = []

  onProgress?.(`Searching for "${niche}" businesses in ${location}...`)

  let businesses
  try {
    businesses = await searchLeads(niche, location, limit)
  } catch (e: any) {
    throw new Error(`Scraper failed: ${e.message}`)
  }

  if (businesses.length === 0) {
    return { found: 0, saved: [], errors: [] }
  }

  onProgress?.(`Found ${businesses.length} businesses. Analysing with AI...`)

  for (let i = 0; i < businesses.length; i++) {
    const biz = businesses[i]

    try {
      onProgress?.(`[${i + 1}/${businesses.length}] Scoring: ${biz.name}`)

      // Skip slow website audit — derive quality from whether they have a website at all
      const quickAudit = {
        hasWebsite: !!biz.website,
        isMobileFriendly: false,
        hasSSL: biz.website?.startsWith('https') ?? false,
        quality: biz.website ? 'average' as const : 'none' as const
      }

      // Add per-lead timeout to prevent hanging
      const lead = await Promise.race([
        analyzeLead(biz, quickAudit, niche, location),
        timeout(15000, `${biz.name} analysis timed out`)
      ])

      if (lead.score >= 0) {
        const saved_lead = await saveLead(lead)
        saved.push(saved_lead)
      }
    } catch (e: any) {
      console.error(`[LeadRunner] Error on ${biz.name}:`, e.message)
      errors.push(`${biz.name}: ${e.message}`)
    }
  }

  if (errors.length > 0) {
    console.error(`[LeadRunner] ${errors.length} errors:`, errors)
  }

  saved.sort((a, b) => b.score - a.score)
  return { found: businesses.length, saved, errors }
}

function timeout(ms: number, msg: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
}
