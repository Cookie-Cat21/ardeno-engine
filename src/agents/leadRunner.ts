import { searchLeads } from './scraper'
import { analyzeLead } from './analyzer'
import { saveLead } from '../db/supabase'
import type { Lead } from '../db/supabase'
import { getLighthouseScores } from './lighthouse'
import { isChainOrFranchise } from '../config/chains'

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

      // Run Lighthouse audit if the business has a website (soft fail — never blocks)
      const lighthouseScores = biz.website
        ? await Promise.race([
            getLighthouseScores(biz.website),
            timeout(12000, 'lighthouse timeout').catch(() => null) as Promise<null>
          ]).catch(() => null)
        : null

      if (lighthouseScores) {
        onProgress?.(`[${i + 1}/${businesses.length}] Lighthouse: ${biz.name} — Perf ${lighthouseScores.performance}/100`)
      }

      // Derive quality from Lighthouse scores (or fall back to "average" guess)
      let quality: 'none' | 'poor' | 'average' | 'good' = 'none'
      if (biz.website) {
        if (lighthouseScores) {
          const avg = (lighthouseScores.performance + lighthouseScores.seo) / 2
          quality = avg >= 80 ? 'good' : avg >= 50 ? 'average' : 'poor'
        } else {
          quality = 'average'
        }
      }

      const quickAudit = {
        hasWebsite: !!biz.website,
        hasSSL: biz.website?.startsWith('https') ?? false,
        quality,
        lighthouse: lighthouseScores
      }

      // Bump timeout to 30s since lighthouse already used up to 12s
      const lead = await Promise.race([
        analyzeLead(biz, quickAudit, niche, location),
        timeout(30000, `${biz.name} analysis timed out`)
      ])

      if (lead.score >= 0) {
        const saved_lead = await saveLead(lead)
        saved.push(saved_lead)
      }
    } catch (e: any) {
      // Silently skip duplicates — not an error
      if (e.message?.startsWith('DUPLICATE:')) {
        console.log(`[LeadRunner] Skipping duplicate: ${biz.name}`)
        continue
      }
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
