import puppeteer from 'puppeteer'
import axios from 'axios'
import Groq from 'groq-sdk'
import { getBrowserConfig } from '../utils/browser'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

/** Use Groq to extract phone + website from raw Google Maps page text */
async function extractDetailsWithAI(pageText: string): Promise<{ phone?: string; website?: string }> {
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{
        role: 'user',
        content: `Extract the phone number and website URL from this Google Maps business page text.

Return ONLY valid JSON in this exact format (use null if not found):
{"phone": "+94 XX XXX XXXX", "website": "https://example.com"}

Rules:
- Phone must be the main business phone (not whatsapp link text)
- Website must be a full URL starting with http
- If not found, use null

Page text:
${pageText.slice(0, 3000)}`
      }],
      temperature: 0,
      max_tokens: 80
    })

    const raw = res.choices[0].message.content?.trim() ?? '{}'
    const json = raw.match(/\{.*\}/s)?.[0] ?? '{}'
    const parsed = JSON.parse(json)
    return {
      phone: parsed.phone ?? undefined,
      website: parsed.website ?? undefined
    }
  } catch {
    return {}
  }
}

/**
 * Google search fallback — searches for a business and extracts BOTH
 * phone number and website from the knowledge panel / search results.
 */
async function googleSearchForDetails(
  businessName: string,
  location: string,
  page: any
): Promise<{ phone?: string; website?: string }> {
  try {
    const query = encodeURIComponent(`${businessName} ${location}`)
    await page.goto(`https://www.google.com/search?q=${query}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    })

    // Dismiss cookie consent (blocks knowledge panel from rendering on EU servers)
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => /accept all|i agree|agree|accept/i.test(b.textContent ?? ''))
      if (btn) (btn as HTMLElement).click()
    }).catch(() => {})

    // Wait for search results AND the knowledge panel to fully render
    // The phone number lives in JS-rendered content that loads after domcontentloaded
    await page.waitForSelector('#search', { timeout: 8000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 2500)) // let knowledge panel JS finish rendering

    // Pull full page text + non-Google links (for website detection)
    const searchData = await page.evaluate(() => {
      const text = document.body.innerText.slice(0, 4000)
      const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => (a as HTMLAnchorElement).href)
        .filter(h =>
          h.startsWith('http') &&
          !h.includes('google.com') &&
          !h.includes('maps.google') &&
          !h.includes('facebook.com') &&
          !h.includes('instagram.com') &&
          !h.includes('tripadvisor') &&
          !h.includes('yelp.com') &&
          !h.includes('booking.com')
        )
        .slice(0, 20)
      return { text, links }
    })

    const res = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{
        role: 'user',
        content: `Extract the phone number and official website for "${businessName}" in ${location} from this Google search page.

The knowledge panel on the right side of Google search results usually shows the phone number directly.

Links found on the page:
${searchData.links.join('\n')}

Full page text:
${searchData.text}

Rules:
- phone: the business phone number (any format is fine, e.g. "076 557 3360")
- website: their OWN domain only — NOT facebook, instagram, tripadvisor, yelp, booking, google, etc.
- Use null if not found

Return ONLY valid JSON:
{"phone": "076 557 3360", "website": "https://example.com"}`
      }],
      temperature: 0,
      max_tokens: 80
    })

    const raw = res.choices[0].message.content?.trim() ?? '{}'
    const json = raw.match(/\{.*\}/s)?.[0] ?? '{}'
    const parsed = JSON.parse(json)
    return {
      phone:   parsed.phone   ?? undefined,
      website: parsed.website ?? undefined
    }
  } catch {
    return {}
  }
}

export interface RawBusiness {
  name: string
  place_id: string
  address: string
  phone?: string
  email?: string
  website?: string
  socials?: string[]   // Instagram, Facebook, TikTok, etc. found on their website
  rating?: number
  review_count?: number
  google_maps_url: string
  types: string[]
}

export async function searchLeads(niche: string, location: string, limit = 20): Promise<RawBusiness[]> {
  console.log(`[Scraper] Opening Google Maps: "${niche}" in ${location}`)

  const browser = await puppeteer.launch(getBrowserConfig())

  try {
    const page = await browser.newPage()
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36')
    await page.setViewport({ width: 1280, height: 800 })

    const query = encodeURIComponent(`${niche} in ${location}`)
    await page.goto(`https://www.google.com/maps/search/${query}`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    })

    // Wait for results to load
    await page.waitForSelector('[role="feed"]', { timeout: 15000 }).catch(() => {})
    await sleep(2000)

    // Scroll to load more results
    await scrollResults(page, limit)

    // Extract business cards — only divs that have a real business link inside them
    const results = await page.evaluate((maxResults: number) => {
      const allCards = Array.from(document.querySelectorAll('[role="feed"] > div'))
      // Filter to only real business cards (have an anchor with aria-label)
      const cards = allCards.filter(el => el.querySelector('a[aria-label]') !== null)
      const businesses: any[] = []

      for (const card of cards.slice(0, maxResults)) {
        const nameEl = card.querySelector('a[aria-label]') as HTMLAnchorElement | null
        if (!nameEl) continue

        const name = nameEl.getAttribute('aria-label') ?? ''
        if (!name) continue

        const href = nameEl.href ?? ''
        const ratingEl = card.querySelector('[role="img"][aria-label*="star"]')
        const ratingText = ratingEl?.getAttribute('aria-label') ?? ''
        const ratingMatch = ratingText.match(/([\d.]+)/)
        const rating = ratingMatch ? parseFloat(ratingMatch[1]) : undefined

        const reviewEl = card.querySelector('span[aria-label*="review"]')
        const reviewText = reviewEl?.getAttribute('aria-label') ?? ''
        const reviewMatch = reviewText.match(/(\d[\d,]*)/)
        const review_count = reviewMatch ? parseInt(reviewMatch[1].replace(',', '')) : undefined

        const spans = Array.from(card.querySelectorAll('span'))
        const address = spans.find(s => s.textContent?.includes(','))?.textContent?.trim() ?? ''

        businesses.push({ name, href, rating, review_count, address })
      }

      return businesses
    }, limit)

    console.log(`[Scraper] Found ${results.length} businesses on Google Maps`)

    const businesses: RawBusiness[] = []

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      let phone: string | undefined
      let website: string | undefined

      try {
        // Navigate to the individual business page
        await page.goto(r.href, { waitUntil: 'domcontentloaded', timeout: 20000 })

        // Dismiss Google cookie consent if it appears (EU servers on Railway)
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'))
          const accept = buttons.find(b =>
            /accept all|i agree|agree|accept/i.test(b.textContent ?? '')
          )
          if (accept) (accept as HTMLElement).click()
        }).catch(() => {})

        // Wait for main content to settle
        await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {})

        // Dump visible page text and let AI extract phone + website
        const pageText = await page.evaluate(() => document.body.innerText)
        const details = await extractDetailsWithAI(pageText)

        phone = details.phone
        website = details.website

        // If Maps page is missing phone or website, fall back to a Google search
        if (!phone || !website) {
          console.log(`[Scraper] Missing details for ${r.name} — trying Google search fallback`)
          const googleDetails = await googleSearchForDetails(r.name, location, page)
          if (!phone && googleDetails.phone)     { phone   = googleDetails.phone;   console.log(`[Scraper] 📞 Found phone via Google: ${phone}`) }
          if (!website && googleDetails.website) { website = googleDetails.website; console.log(`[Scraper] 🌐 Found website via Google: ${website}`) }
        }
      } catch {
        // Non-critical — continue without these details
      }

      // Scrape email + socials from website in one fetch
      let email: string | undefined
      let socials: string[] | undefined
      if (website) {
        const contact = await scrapeContactInfo(website)
        email = contact.email
        socials = contact.socials.length > 0 ? contact.socials : undefined
      }

      businesses.push({
        name: r.name,
        place_id: `gmaps-${i}-${r.name.replace(/\s+/g, '-').toLowerCase()}`,
        address: r.address || location,
        phone,
        email,
        website,
        socials,
        rating: r.rating,
        review_count: r.review_count,
        google_maps_url: r.href || `https://www.google.com/maps/search/${encodeURIComponent(r.name + ' ' + location)}`,
        types: [niche]
      })

      console.log(`[Scraper] ${r.name} — phone: ${phone ?? 'none'}, website: ${website ?? 'none'}`)
    }

    return businesses
  } finally {
    await browser.close()
  }
}

export interface RescanUpdate {
  id: string
  business_name: string
  discord_message_id?: string
  phone?: string
  website?: string
}

/**
 * Re-visits Google Maps pages for leads that are missing phone/website
 * and fills them in using AI + Google search fallback.
 * Returns list of updated leads so the caller can refresh Discord embeds.
 */
export async function rescanMissingLeads(
  leads: Array<{ id: string; business_name: string; google_maps_url?: string; phone?: string; website?: string; discord_message_id?: string }>,
  onProgress: (msg: string) => Promise<void>
): Promise<{ updated: number; skipped: number; updatedLeads: RescanUpdate[] }> {
  const toScan = leads.filter(l => !l.phone || !l.website)
  if (toScan.length === 0) return { updated: 0, skipped: 0, updatedLeads: [] }

  const BATCH = 25  // restart browser every N leads to free memory
  let updated = 0
  let skipped = 0
  const updatedLeads: RescanUpdate[] = []
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

  const newBrowser = () => puppeteer.launch(getBrowserConfig())
  const newPage = async (br: any) => {
    const p = await br.newPage()
    await p.setUserAgent(UA)
    return p
  }

  // Helper — accept Google cookie consent once per browser session
  const acceptGoogleConsent = async (p: any) => {
    try {
      await p.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 10000 })
      await p.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /accept all|i agree|agree|accept/i.test(b.textContent ?? ''))
        if (btn) (btn as HTMLElement).click()
      })
      await new Promise(r => setTimeout(r, 1000))
    } catch {}
  }

  let browser = await newBrowser()
  let page    = await newPage(browser)
  await acceptGoogleConsent(page)

  try {
    for (let i = 0; i < toScan.length; i++) {
      const lead = toScan[i]
      if (!lead.google_maps_url) { skipped++; continue }

      // Restart browser every BATCH leads to prevent OOM
      if (i > 0 && i % BATCH === 0) {
        console.log(`[Rescan] ♻️ Restarting browser at lead ${i} to free memory`)
        try { await browser.close() } catch {}
        browser = await newBrowser()
        page    = await newPage(browser)
        await acceptGoogleConsent(page)
      }

      await onProgress(`🔍 [${i + 1}/${toScan.length}] Rescanning **${lead.business_name}**...`)

      try {
        await page.goto(lead.google_maps_url, { waitUntil: 'domcontentloaded', timeout: 20000 })

        // Dismiss cookie consent if on EU server
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button'))
            .find(b => /accept all|i agree|agree|accept/i.test(b.textContent ?? ''))
          if (btn) (btn as HTMLElement).click()
        }).catch(() => {})

        await page.waitForSelector('h1', { timeout: 8000 }).catch(() => {})

        const pageText = await page.evaluate(() => document.body.innerText)
        const details = await extractDetailsWithAI(pageText)

        // If Maps page is still missing phone or website, try Google search fallback
        if (!lead.phone && !details.phone || !lead.website && !details.website) {
          console.log(`[Rescan] Missing details for ${lead.business_name} — trying Google search`)
          const locationGuess = lead.google_maps_url?.match(/place\/[^/]+\/([^/]+)/)?.[1] ?? ''
          const googleDetails = await googleSearchForDetails(lead.business_name, locationGuess, page)
          if (!details.phone && googleDetails.phone)     { details.phone   = googleDetails.phone;   console.log(`[Rescan] 📞 Found phone via Google: ${details.phone}`) }
          if (!details.website && googleDetails.website) { details.website = googleDetails.website; console.log(`[Rescan] 🌐 Found website via Google: ${details.website}`) }
        }

        // Only patch fields that were missing
        const patch: Record<string, string> = {}
        if (!lead.phone && details.phone)     patch.phone   = details.phone
        if (!lead.website && details.website) patch.website = details.website

        if (Object.keys(patch).length > 0) {
          const { supabase } = await import('../db/supabase')
          await supabase.from('leads').update(patch).eq('id', lead.id)
          updated++
          console.log(`[Rescan] ✅ ${lead.business_name} — ${JSON.stringify(patch)}`)
          updatedLeads.push({
            id: lead.id,
            business_name: lead.business_name,
            discord_message_id: lead.discord_message_id,
            phone:   patch.phone   ?? lead.phone,
            website: patch.website ?? lead.website
          })
        } else {
          skipped++
          console.log(`[Rescan] ⬜ ${lead.business_name} — nothing new found`)
        }
      } catch (e: any) {
        console.log(`[Rescan] ❌ ${lead.business_name} — ${e.message}`)
        skipped++

        // If the frame detached (page crashed), open a fresh page and carry on
        if (e.message?.includes('detached Frame') || e.message?.includes('Target closed')) {
          console.log('[Rescan] Page crashed — opening fresh page and continuing')
          try { await page.close() } catch {}
          page = await newPage(browser)
        }
      }
    }
  } finally {
    await browser.close()
  }

  return { updated, skipped, updatedLeads }
}

async function scrollResults(page: any, targetCount: number): Promise<void> {
  const PAUSE        = 1800   // ms to wait after each scroll for new cards to render
  const MAX_ATTEMPTS = 25     // hard cap — never scroll more than 25 times
  let lastCount      = 0
  let stuckFor       = 0      // how many scrolls in a row with no new results

  console.log(`[Scraper] Scrolling to load up to ${targetCount} results...`)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Count only real business cards (they always contain an anchor with aria-label)
    const currentCount = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="feed"] > div'))
        .filter(el => el.querySelector('a[aria-label]') !== null)
        .length
    )

    if (currentCount >= targetCount) {
      console.log(`[Scraper] Reached target (${currentCount} cards loaded)`)
      break
    }

    // Check if Google Maps says "You've reached the end of the list"
    const atEnd = await page.evaluate(() => {
      const text = document.body?.innerText ?? ''
      return text.includes("You've reached the end of the list") ||
             text.includes("Reached the end of the list")
    })

    if (atEnd) {
      console.log(`[Scraper] End of list reached (${currentCount} total)`)
      break
    }

    // Scroll to the absolute bottom of the feed to trigger lazy loading
    await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]')
      if (feed) {
        feed.scrollTop = feed.scrollHeight

        // Also nudge the last visible card into view (helps trigger loading)
        const cards = feed.querySelectorAll('div')
        const last  = cards[cards.length - 1] as HTMLElement | undefined
        last?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
      }
    })

    await sleep(PAUSE)

    // Detect if we're genuinely stuck — no new cards after 3 consecutive scrolls
    if (currentCount === lastCount) {
      stuckFor++
      if (stuckFor >= 3) {
        console.log(`[Scraper] No new results after ${stuckFor} scrolls — stopping at ${currentCount}`)
        break
      }
    } else {
      stuckFor = 0
    }

    lastCount = currentCount
  }
}

export async function auditWebsite(url: string): Promise<{
  hasWebsite: boolean
  isMobileFriendly: boolean
  hasSSL: boolean
  quality: 'none' | 'poor' | 'average' | 'good'
}> {
  if (!url) return { hasWebsite: false, isMobileFriendly: false, hasSSL: false, quality: 'none' }
  const hasSSL = url.startsWith('https')
  return { hasWebsite: true, isMobileFriendly: false, hasSSL, quality: hasSSL ? 'average' : 'poor' }
}

const SOCIAL_PATTERNS: { regex: RegExp }[] = [
  { regex: /https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._]+/g },
  { regex: /https?:\/\/(www\.)?facebook\.com\/[a-zA-Z0-9._%\-]+/g },
  { regex: /https?:\/\/(www\.)?tiktok\.com\/@?[a-zA-Z0-9._]+/g },
  { regex: /https?:\/\/(www\.)?(twitter|x)\.com\/[a-zA-Z0-9_]+/g },
  { regex: /https?:\/\/(www\.)?linkedin\.com\/company\/[a-zA-Z0-9._-]+/g },
  { regex: /https?:\/\/(www\.)?youtube\.com\/(channel|c|@)[a-zA-Z0-9._-]+/g },
]

// Scrape a business website for email + social links
// Checks homepage first, then hunts for a contact page if no email found
export async function scrapeContactInfo(url: string): Promise<{ email?: string; socials: string[] }> {
  if (!url) return { socials: [] }

  try {
    const homepage = await fetchHtml(url)
    if (!homepage) return { socials: [] }

    const socials  = extractSocials(homepage)
    let   email    = extractEmail(homepage)

    // If no email on homepage, try to find a contact/about page
    if (!email) {
      const contactUrl = findContactPageUrl(url, homepage)
      if (contactUrl) {
        console.log(`[Scraper] No email on homepage — checking contact page: ${contactUrl}`)
        const contactHtml = await fetchHtml(contactUrl)
        if (contactHtml) email = extractEmail(contactHtml)
      }
    }

    // Last resort: try common contact URL patterns
    if (!email) {
      const base = new URL(url).origin
      for (const path of ['/contact', '/contact-us', '/contacts', '/reach-us', '/get-in-touch', '/about']) {
        const tryUrl = base + path
        if (tryUrl === url) continue  // already checked
        const html = await fetchHtml(tryUrl)
        if (html) {
          email = extractEmail(html)
          if (email) {
            console.log(`[Scraper] Found email on ${path}: ${email}`)
            break
          }
        }
      }
    }

    return { email, socials }
  } catch {
    return { socials: [] }
  }
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      maxRedirects: 3
    })
    return res.data as string
  } catch {
    return null
  }
}

function extractEmail(html: string): string | undefined {
  // Priority 1: mailto links (most reliable)
  const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
  if (mailtoMatch) return mailtoMatch[1].toLowerCase()

  // Priority 2: raw email pattern in HTML
  const emailMatches = html.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g)
  if (!emailMatches) return undefined

  const JUNK_DOMAINS = [
    'example.com', 'sentry.io', 'w3.org', 'schema.org',
    'wixpress.com', 'squarespace.com', 'wordpress.com',
    'jquery.com', 'bootstrapcdn.com', 'cloudflare.com',
    'google.com', 'facebook.com', 'instagram.com',
    'amazonaws.com', 'fontawesome.com', 'gravatar.com'
  ]
  const JUNK_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.woff', '.ttf']

  const filtered = emailMatches.filter(e => {
    const lower = e.toLowerCase()
    if (JUNK_EXTENSIONS.some(ext => lower.includes(ext))) return false
    if (JUNK_DOMAINS.some(d => lower.endsWith(d)))        return false
    if (lower.includes('noreply') || lower.includes('no-reply')) return false
    if (lower.startsWith('support@') && lower.includes('wix'))   return false
    return true
  })

  return filtered[0]?.toLowerCase()
}

function findContactPageUrl(baseUrl: string, html: string): string | null {
  try {
    const base   = new URL(baseUrl).origin
    // Look for links that say "contact", "reach", "get in touch"
    const matches = [...html.matchAll(/href=["']([^"']+)["'][^>]*>([^<]{0,50})/gi)]
    for (const m of matches) {
      const href = m[1]
      const text = m[2].toLowerCase()
      if (/(contact|reach us|get in touch|enquir|email us)/i.test(text)) {
        if (href.startsWith('http')) return href
        if (href.startsWith('/'))    return base + href
      }
    }
    // Also look for hrefs that contain "contact" in the path
    const hrefMatches = [...html.matchAll(/href=["']([^"']*contact[^"']*)["']/gi)]
    if (hrefMatches.length > 0) {
      const href = hrefMatches[0][1]
      if (href.startsWith('http')) return href
      if (href.startsWith('/'))    return new URL(baseUrl).origin + href
    }
  } catch {}
  return null
}

function extractSocials(html: string): string[] {
  const socials: string[] = []
  const seen = new Set<string>()
  for (const { regex } of SOCIAL_PATTERNS) {
    const matches = html.match(regex) ?? []
    for (const match of matches) {
      const clean = match.toLowerCase().replace(/\/$/, '')
      if (!seen.has(clean)) {
        seen.add(clean)
        socials.push(match.replace(/\/$/, ''))
      }
    }
  }
  return socials
}

// Keep old export name for any remaining references
export async function scrapeEmailFromWebsite(url: string): Promise<string | undefined> {
  const { email } = await scrapeContactInfo(url)
  return email
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
