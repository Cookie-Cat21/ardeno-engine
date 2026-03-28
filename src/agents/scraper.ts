import puppeteer from 'puppeteer'

export interface RawBusiness {
  name: string
  place_id: string
  address: string
  phone?: string
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

    const businesses: RawBusiness[] = results.map((r: any, i: number) => ({
      name: r.name,
      place_id: `gmaps-${i}-${r.name.replace(/\s+/g, '-').toLowerCase()}`,
      address: r.address || location,
      phone: undefined,
      website: undefined,
      rating: r.rating,
      review_count: r.review_count,
      google_maps_url: r.href || `https://www.google.com/maps/search/${encodeURIComponent(r.name + ' ' + location)}`,
      types: [niche]
    }))

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
