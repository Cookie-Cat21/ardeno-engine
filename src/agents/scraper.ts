import puppeteer from 'puppeteer'
import axios from 'axios'
import { getBrowserConfig } from '../utils/browser'

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

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  })

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
        // Click into each business to get phone + website
        await page.goto(r.href, { waitUntil: 'domcontentloaded', timeout: 15000 })
        await sleep(2000)

        const details = await page.evaluate(() => {
          let phone: string | undefined
          let website: string | undefined

          // Phone number
          const phoneEl = document.querySelector('button[data-tooltip="Copy phone number"] div')
            ?? document.querySelector('[data-item-id^="phone"] div')
            ?? Array.from(document.querySelectorAll('button[aria-label*="phone"]'))[0]
          if (phoneEl) phone = phoneEl.textContent?.trim()

          // Phone fallback — look for tel: links
          if (!phone) {
            const telLink = document.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null
            if (telLink) phone = telLink.href.replace('tel:', '')
          }

          // Strip invisible/special Unicode characters Google Maps injects
          // (zero-width spaces, LTR marks, non-breaking spaces, etc.)
          if (phone) {
            phone = phone
              .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '') // invisible chars
              .replace(/\u00A0/g, ' ') // non-breaking space → regular space
              .trim()
          }

          // Website
          const webEl = document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null
            ?? document.querySelector('a[aria-label*="website"]') as HTMLAnchorElement | null
          if (webEl) website = webEl.href

          return { phone, website }
        })

        phone = details.phone
        website = details.website
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
