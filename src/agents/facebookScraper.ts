// Facebook Places Search via Graph API
// Uses App Access Token (APP_ID|APP_SECRET) — no user login required
// Returns businesses near a city's coordinates that match the niche query
// Free tier: 200 API calls/hour — more than enough for daily hunts

import axios from 'axios'
import type { RawBusiness } from './scraper'
import { scrapeContactInfo } from './scraper'

const FB_API  = 'https://graph.facebook.com/v20.0'
const RADIUS  = 10000  // 10km search radius per location (metres)

// GPS coordinates for each hunted city
const CITY_COORDS: Record<string, [number, number]> = {
  'Colombo':    [ 6.9271,  79.8612 ],
  'Kandy':      [ 7.2906,  80.6337 ],
  'Galle':      [ 6.0535,  80.2210 ],
  'Negombo':    [ 7.2094,  79.8386 ],
  'Dehiwala':   [ 6.8478,  79.8657 ],
  'Moratuwa':   [ 6.7728,  79.8819 ],
  'Nugegoda':   [ 6.8764,  79.8871 ],
  'Batticaloa': [ 7.7171,  81.6974 ],
  'Jaffna':     [ 9.6615,  80.0255 ],
  'Matara':     [ 5.9549,  80.5550 ],
}

function getAppToken(): string | null {
  const id  = process.env.FACEBOOK_APP_ID
  const sec = process.env.FACEBOOK_APP_SECRET
  if (!id || !sec) return null
  return `${id}|${sec}`
}

export async function searchFacebookLeads(
  niche:    string,
  location: string,
  limit     = 20
): Promise<RawBusiness[]> {
  const token = getAppToken()
  if (!token) {
    console.log('[Facebook] Skipping — FACEBOOK_APP_ID/SECRET not set')
    return []
  }

  const coords = CITY_COORDS[location]
  if (!coords) {
    console.log(`[Facebook] No coordinates for "${location}" — skipping`)
    return []
  }

  const [lat, lng] = coords
  console.log(`[Facebook] Searching "${niche}" near ${location} (${lat}, ${lng})`)

  try {
    const res = await axios.get(`${FB_API}/search`, {
      timeout: 15000,
      params: {
        type:         'place',
        q:            niche,
        center:       `${lat},${lng}`,
        distance:     RADIUS,
        fields:       'name,phone,website,location,categories,link',
        limit:        limit,
        access_token: token,
      }
    })

    const places: any[] = res.data?.data ?? []
    console.log(`[Facebook] Found ${places.length} places for "${niche}" in ${location}`)

    const businesses: RawBusiness[] = []

    for (const place of places) {
      const name: string  = place.name ?? ''
      if (!name) continue

      const rawPhone = place.phone as string | undefined
      const phone: string | undefined = rawPhone
        ? rawPhone.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD\u00A0]/g, '').trim() || undefined
        : undefined
      const website: string | undefined = place.website ?? undefined
      const fbUrl:   string             = place.link    ?? `https://www.facebook.com/${place.id}`

      const city    = place.location?.city    ?? location
      const street  = place.location?.street  ?? ''
      const address = [street, city].filter(Boolean).join(', ')

      // Category comes as array: [{ id, name }]
      const category = place.categories?.[0]?.name ?? niche

      // Scrape email + socials from website if available
      let email:   string | undefined
      let socials: string[] | undefined
      if (website) {
        const contact = await scrapeContactInfo(website)
        email   = contact.email
        socials = contact.socials.length > 0 ? contact.socials : [fbUrl]
      } else {
        // No website — Facebook page IS their online presence
        socials = [fbUrl]
      }

      businesses.push({
        name,
        place_id:        `fb-${place.id}`,
        address:         address || location,
        phone,
        email,
        website,
        socials,
        rating:          undefined,    // Facebook doesn't return ratings in this API
        review_count:    undefined,
        google_maps_url: fbUrl,        // We store the FB page link here for outreach
        types:           [category],
      })

      console.log(`[Facebook] ${name} — phone: ${phone ?? 'none'}, website: ${website ?? 'none'}`)
    }

    return businesses
  } catch (err: any) {
    const status = err.response?.status
    const msg    = err.response?.data?.error?.message ?? err.message

    if (status === 400) {
      console.log(`[Facebook] API error (400) — check App ID/Secret: ${msg}`)
    } else if (status === 401 || status === 403) {
      console.log(`[Facebook] Auth error — token may be invalid: ${msg}`)
    } else if (status === 429) {
      console.log(`[Facebook] Rate limited — will retry next hunt`)
    } else {
      console.log(`[Facebook] Error: ${msg}`)
    }
    return []
  }
}
