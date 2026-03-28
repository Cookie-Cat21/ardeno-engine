import { searchLeads } from './scraper'
import { searchFacebookLeads } from './facebookScraper'
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

  // Run Google Maps + Facebook in parallel
  const [gmapsResult, fbResult] = await Promise.allSettled([
    searchLeads(niche, location, limit),
    searchFacebookLeads(niche, location, limit),
  ])

  const gmaps = gmapsResult.status === 'fulfilled' ? gmapsResult.value : []
  const fb    = fbResult.status    === 'fulfilled' ? fbResult.value    : []

  if (gmapsResult.status === 'rejected') {
    throw new Error(`Scraper failed: ${(gmapsResult as any).reason?.message}`)
  }

  // Merge + deduplicate by normalised name
  // (same business might appear on both Google Maps and Facebook)
  const seen  = new Set<string>()
  const businesses = [...gmaps, ...fb].filter(biz => {
    const key = biz.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)
    if (seen.has(key)) {
      console.log(`[LeadRunner] Deduped cross-source: ${biz.name}`)
      return false
    }
    seen.add(key)
    return true
  })

  if (fb.length > 0) {
    console.log(`[LeadRunner] Sources: ${gmaps.length} Google Maps + ${fb.length} Facebook = ${businesses.length} total`)
  }

  if (businesses.length === 0) {
    return { found: 0, saved: [], errors: [] }
  }

  onProgress?.(`Found ${businesses.length} businesses (Maps + Facebook). Analysing with AI...`)

  // Filter out chains and franchises before spending any API calls on them
  const filtered = businesses.filter(biz => {
    if (isChainOrFranchise(biz.name)) {
      console.log(`[LeadRunner] Skipping chain/franchise: ${biz.name}`)
      return false
    }
    return true
  })

  if (filtered.length < businesses.length) {
    const skipped = businesses.length - filtered.length
    console.log(`[LeadRunner] Filtered out ${skipped} chain(s)/franchise(s) — ${filtered.length} remaining`)
    onProgress?.(`Filtered out ${skipped} chain(s) — analysing ${filtered.length} real leads...`)
  }

  for (let i = 0; i < filtered.length; i++) {
    const biz = filtered[i]

    try {
      onProgress?.(`[${i + 1}/${filtered.length}] Scoring: ${biz.name}`)

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
  return { found: filtered.length, saved, errors }
}

function timeout(ms: number, msg: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
}
