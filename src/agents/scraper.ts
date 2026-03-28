import puppeteer from 'puppeteer'
import axios from 'axios'

export interface RawBusiness {
  name: string
  place_id: string
  address: string
  phone?: string
  email?: string
  website?: string
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

    // Extract business cards
    const results = await page.evaluate((maxResults: number) => {
      const cards = Array.from(document.querySelectorAll('[role="feed"] > div'))
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

      // Scrape email from website
      let email: string | undefined
      if (website) {
        email = await scrapeEmailFromWebsite(website)
      }

      businesses.push({
        name: r.name,
        place_id: `gmaps-${i}-${r.name.replace(/\s+/g, '-').toLowerCase()}`,
        address: r.address || location,
        phone,
        email,
        website,
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

async function scrollResults(page: any, targetCount: number) {
  const maxScrolls = Math.ceil(targetCount / 5)
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => {
      const feed = document.querySelector('[role="feed"]')
      if (feed) feed.scrollTop += 600
    })
    await sleep(1200)
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

// Scrape a business website for contact email
export async function scrapeEmailFromWebsite(url: string): Promise<string | undefined> {
  if (!url) return undefined
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      maxRedirects: 3
    })
    const html = res.data as string

    // Find mailto: links first (most reliable)
    const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
    if (mailtoMatch) return mailtoMatch[1]

    // Fallback: find raw email patterns in HTML
    const emailMatch = html.match(/\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g)
    if (emailMatch) {
      // Filter out common false positives
      const filtered = emailMatch.filter(e =>
        !e.includes('example.com') &&
        !e.includes('sentry.io') &&
        !e.includes('w3.org') &&
        !e.includes('schema.org') &&
        !e.includes('.png') &&
        !e.includes('.jpg')
      )
      return filtered[0]
    }
  } catch {
    // Non-critical
  }
  return undefined
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
