import { GoogleGenerativeAI } from '@google/generative-ai'
import Groq from 'groq-sdk'
import type { RawBusiness } from './scraper'
import type { Lead } from '../db/supabase'

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
  websiteAudit: { hasWebsite: boolean; quality: string },
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

  return {
    business_name: business.name,
    niche,
    location,
    phone: business.phone,
    website: business.website,
    google_maps_url: business.google_maps_url,
    google_rating: business.rating,
    review_count: business.review_count,
    score: parsed.score,
    score_reasons: parsed.reasons,
    gap_analysis: parsed.gaps,
    pitch_angle: parsed.pitch,
    status: 'found'
  }
}

function buildPrompt(
  b: RawBusiness,
  audit: { hasWebsite: boolean; quality: string },
  niche: string,
  location: string
): string {
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
- Has Website: ${audit.hasWebsite}

SCORING CRITERIA (0-100):
- No website = +40 points (massive opportunity)
- Poor/outdated website = +30 points
- Good reviews but bad web presence = +20 points
- Active business (many reviews) = +10 points
- High rating = +10 points

Return ONLY valid JSON, no markdown:
{
  "score": <number 0-100>,
  "reasons": [<2-4 short bullet strings explaining the score>],
  "gaps": "<1-2 sentences describing what they're missing online>",
  "pitch": "<1 sentence — the single most compelling reason they need Ardeno Studio right now>"
}`
}

async function callGemini(prompt: string): Promise<string> {
  const model = getGemini().getGenerativeModel({ model: 'gemini-1.5-flash' })
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
