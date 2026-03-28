import { GoogleGenerativeAI } from '@google/generative-ai'
import Groq from 'groq-sdk'
import type { RawBusiness } from './scraper'
import type { Lead } from '../db/supabase'
import type { LighthouseScores } from './lighthouse'

// Lazy clients — initialized on first use so dotenv has time to load
let _gemini: GoogleGenerativeAI | null = null
let _groq: Groq | null = null
const getGemini = () => _gemini ??= new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
const getGroq = () => _groq ??= new Groq({ apiKey: process.env.GROQ_API_KEY })

/**
 * Use LLM to score and build a full dossier for a lead.
 * Tries Gemini first (free 1500/day), falls back to Groq (free).
 */
export async function analyzeLead(
  business: RawBusiness,
  websiteAudit: { hasWebsite: boolean; quality: string; hasSSL?: boolean; lighthouse?: LighthouseScores | null },
  niche: string,
  location: string
): Promise<Omit<Lead, 'id' | 'created_at'>> {
  const prompt = buildPrompt(business, websiteAudit, niche, location)

  let raw: string
  try {
    raw = await callGemini(prompt)
  } catch {
    raw = await callGroq(prompt)
  }

  const parsed = parseAnalysis(raw)

  // Map socials array to individual fields
  const socials = business.socials ?? []
  const instagram = socials.find(s => s.includes('instagram.com'))
  const facebook  = socials.find(s => s.includes('facebook.com'))

  return {
    business_name: business.name,
    niche,
    location,
    phone: business.phone,
    email: business.email,
    website: business.website,
    google_maps_url: business.google_maps_url,
    google_rating: business.rating,
    review_count: business.review_count,
    instagram,
    facebook,
    score: parsed.score,
    score_reasons: parsed.reasons,
    gap_analysis: parsed.gaps,
    pitch_angle: parsed.pitch,
    lighthouse_scores: websiteAudit.lighthouse ?? null,
    status: 'found'
  }
}

function buildPrompt(
  b: RawBusiness,
  audit: { hasWebsite: boolean; quality: string; hasSSL?: boolean; lighthouse?: LighthouseScores | null },
  niche: string,
  location: string
): string {
  const lh = audit.lighthouse
  const lighthouseSection = lh
    ? `- Lighthouse Performance: ${lh.performance}/100${lh.performance < 50 ? ' ⚠️ SLOW' : ''}
- Lighthouse SEO: ${lh.seo}/100${lh.seo < 50 ? ' ⚠️ INVISIBLE' : ''}
- Lighthouse Accessibility: ${lh.accessibility}/100
- Lighthouse Best Practices: ${lh.bestPractices}/100
- HTTPS: ${audit.hasSSL ? 'Yes' : 'No ⚠️'}`
    : audit.hasWebsite
      ? '- Lighthouse: Could not audit (site may be slow/blocked)'
      : '- Lighthouse: N/A (no website)'

  return `You are a web agency sales analyst for Ardeno Studio, a premium web design agency.

Analyze this business as a potential client and return a JSON object.

BUSINESS INFO:
- Name: ${b.name}
- Niche: ${niche}
- Location: ${location}
- Phone: ${b.phone ?? 'Unknown'}
- Website: ${b.website ?? 'None'}
- Google Rating: ${b.rating ?? 'N/A'} (${b.review_count ?? 0} reviews)
- Website Quality: ${audit.quality}
${lighthouseSection}

SCORING CRITERIA (0-100):
- No website at all = +40 points (massive opportunity)
- Has website but Lighthouse Performance < 50 = +25 points (terrible speed — easy sell)
- Has website but Lighthouse SEO < 50 = +20 points (invisible to Google)
- Has website but poor overall quality = +15 points
- Good reviews but bad web presence = +15 points
- Active business (many reviews) = +10 points
- High Google rating (4.5+) = +10 points
- No HTTPS = +5 points

Return ONLY valid JSON, no markdown:
{
  "score": <number 0-100>,
  "reasons": [<2-4 short bullet strings explaining the score, mention specific Lighthouse numbers if available>],
  "gaps": "<1-2 sentences describing exactly what they're missing online, be specific with scores if available>",
  "pitch": "<1 sentence — the single most compelling reason they need Ardeno Studio right now, use real numbers if available>"
}`
}

async function callGemini(prompt: string): Promise<string> {
  const model = getGemini().getGenerativeModel({ model: 'gemini-2.0-flash' })
  const result = await model.generateContent(prompt)
  return result.response.text()
}

async function callGroq(prompt: string): Promise<string> {
  const completion = await getGroq().chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3
  })
  return completion.choices[0].message.content ?? '{}'
}

function parseAnalysis(raw: string): {
  score: number
  reasons: string[]
  gaps: string
  pitch: string
} {
  try {
    // Strip markdown code blocks if present
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed = JSON.parse(cleaned)
    return {
      score: Math.min(100, Math.max(0, Number(parsed.score) || 50)),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
      gaps: parsed.gaps ?? 'No detailed gap analysis available.',
      pitch: parsed.pitch ?? 'This business could benefit from a modern web presence.'
    }
  } catch {
    return {
      score: 50,
      reasons: ['Analysis parsing failed — manual review recommended'],
      gaps: 'Could not determine gaps automatically.',
      pitch: 'Potential client — requires manual review.'
    }
  }
}
