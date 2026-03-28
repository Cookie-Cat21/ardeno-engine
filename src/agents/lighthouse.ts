import axios from 'axios'

export interface LighthouseScores {
  performance: number    // 0-100
  accessibility: number
  bestPractices: number
  seo: number
}

/**
 * Fetch Lighthouse scores via Google PageSpeed Insights API.
 * Free tier — no billing required. Uses GOOGLE_PLACES_API_KEY if available
 * for higher quota (25k/day vs 400/day unauthenticated).
 * Returns null if the URL is unreachable or the API fails.
 */
// Social media sites always return 429 or block PageSpeed API — skip them
const SKIP_DOMAINS = ['instagram.com', 'facebook.com', 'tiktok.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com']

export function isSocialMediaUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return SKIP_DOMAINS.some(d => hostname.includes(d))
  } catch {
    return false
  }
}

export async function getLighthouseScores(url: string): Promise<LighthouseScores | null> {
  try {
    if (isSocialMediaUrl(url)) {
      console.log(`[Lighthouse] Skipping social media URL: ${url}`)
      return null
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY ?? process.env.PAGESPEED_API_KEY
    console.log(`[Lighthouse] Checking ${url} (key: ${apiKey ? '✅' : '❌ no key'})`)

    const base = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
    const query = [
      `url=${encodeURIComponent(url)}`,
      'strategy=mobile',
      'category=performance',
      'category=accessibility',
      'category=best-practices',
      'category=seo',
      ...(apiKey ? [`key=${apiKey}`] : [])
    ].join('&')

    const res = await axios.get(`${base}?${query}`, { timeout: 20000 })
    const cats = res.data?.lighthouseResult?.categories

    if (!cats) {
      console.log(`[Lighthouse] ❌ No categories in response`)
      return null
    }

    const scores = {
      performance:   Math.round((cats.performance?.score   ?? 0) * 100),
      accessibility: Math.round((cats.accessibility?.score ?? 0) * 100),
      bestPractices: Math.round((cats['best-practices']?.score ?? 0) * 100),
      seo:           Math.round((cats.seo?.score           ?? 0) * 100),
    }
    console.log(`[Lighthouse] ✅ ${url} — Perf:${scores.performance} SEO:${scores.seo} A11y:${scores.accessibility} BP:${scores.bestPractices}`)
    return scores
  } catch (err: any) {
    console.log(`[Lighthouse] ❌ Failed for ${url}: ${err.message}`)
    return null // soft fail — don't block the lead engine
  }
}

/** Emoji dot for a Lighthouse score */
export function scoreDot(n: number): string {
  return n >= 90 ? '🟢' : n >= 50 ? '🟡' : '🔴'
}

/** One-liner summary for embeds e.g. "🔴 24 · 🟡 62 · 🟡 58 · 🟢 91" */
export function lighthouseSummary(s: LighthouseScores): string {
  return [
    `${scoreDot(s.performance)} Perf **${s.performance}**`,
    `${scoreDot(s.seo)} SEO **${s.seo}**`,
    `${scoreDot(s.accessibility)} A11y **${s.accessibility}**`,
    `${scoreDot(s.bestPractices)} BP **${s.bestPractices}**`,
  ].join('  ·  ')
}

/** Full multi-line block for detailed embeds */
export function lighthouseBlock(s: LighthouseScores): string {
  return [
    `${scoreDot(s.performance)} Performance:    **${s.performance}**/100`,
    `${scoreDot(s.seo)} SEO:            **${s.seo}**/100`,
    `${scoreDot(s.accessibility)} Accessibility:  **${s.accessibility}**/100`,
    `${scoreDot(s.bestPractices)} Best Practices: **${s.bestPractices}**/100`,
  ].join('\n')
}
