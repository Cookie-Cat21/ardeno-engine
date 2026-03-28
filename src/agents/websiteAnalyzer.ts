import axios from 'axios'
import puppeteer from 'puppeteer'
import { GoogleGenerativeAI } from '@google/generative-ai'
import Groq from 'groq-sdk'
import type { LighthouseScores } from './lighthouse'

// Lazy clients — separate Groq key kept rate limits clean for scoring/email
let _gemini: GoogleGenerativeAI | null = null
let _groq: Groq | null = null
const getGemini = () => _gemini ??= new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
const getGroq   = () => _groq   ??= new Groq({ apiKey: process.env.GROQ_WEBSITE_KEY })

export interface WebsiteAudit {
  firstImpression: string
  criticalIssues: string[]
  quickWins: string[]
  workingWell: string[]
  ourAngle: string
}

export interface AnalysisResult {
  audit: WebsiteAudit
  screenshot: Buffer | null  // returned so Discord can display it
}

/**
 * Full website audit: screenshot + HTML analysis.
 * Tries Gemini Vision first (screenshot + HTML in one call).
 * Falls back to Groq text-only if Gemini fails or screenshot fails.
 * Soft fail — always returns null rather than throwing.
 */
export async function analyzeWebsite(
  url: string,
  lighthouse?: LighthouseScores | null
): Promise<AnalysisResult | null> {
  console.log(`[WebsiteAnalyzer] Starting analysis for ${url}`)
  try {
    // Run screenshot and HTML fetch in parallel — both can fail independently
    const [screenshotResult, htmlResult] = await Promise.allSettled([
      takeScreenshot(url),
      extractHtmlContent(url)
    ])

    const screenshot = screenshotResult.status === 'fulfilled' ? screenshotResult.value : null
    const html       = htmlResult.status       === 'fulfilled' ? htmlResult.value       : null

    console.log(`[WebsiteAnalyzer] screenshot=${screenshot ? '✅' : '❌'}  html=${html ? '✅' : '❌'}  lighthouse=${lighthouse ? '✅' : '❌'}`)

    if (!screenshot && !html) {
      console.log(`[WebsiteAnalyzer] Both screenshot and HTML failed — skipping`)
      return null
    }

    if (screenshot) {
      console.log(`[WebsiteAnalyzer] Running Gemini Vision analysis...`)
      const audit = await analyzeWithVision(url, html, screenshot, lighthouse)
      if (audit) {
        console.log(`[WebsiteAnalyzer] ✅ Vision analysis complete`)
        return { audit, screenshot }
      }
      console.log(`[WebsiteAnalyzer] Vision failed — falling back to Groq text`)
    }

    // Fallback: text-only via Groq
    if (html) {
      console.log(`[WebsiteAnalyzer] Running Groq text analysis...`)
      const audit = await analyzeWithText(url, html, lighthouse)
      if (audit) {
        console.log(`[WebsiteAnalyzer] ✅ Text analysis complete`)
        return { audit, screenshot: null }
      }
    }

    return null
  } catch (err: any) {
    console.log(`[WebsiteAnalyzer] ❌ Unexpected error: ${err.message}`)
    return null
  }
}

// ─── Screenshot ────────────────────────────────────────────────────────────────

async function takeScreenshot(url: string): Promise<Buffer | null> {
  let browser = null
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36')

    // Use 'load' — fires when HTML + images are done, doesn't wait for analytics/tracking
    // Squarespace/Wix sites have constant network pings so networkidle2 always times out
    await page.goto(url, { waitUntil: 'load', timeout: 20000 }).catch((err) => {
      // Timeout on 'load' is still fine — the page is likely rendered enough
      console.log(`[Screenshot] Load timeout for ${url} — taking screenshot anyway: ${err.message}`)
    })

    // Extra pause for hero images and JS-rendered content to settle
    await new Promise(r => setTimeout(r, 2500))

    const buffer = await page.screenshot({ type: 'jpeg', quality: 80 })
    console.log(`[Screenshot] ✅ Captured ${url} (${Math.round((buffer as Buffer).length / 1024)}KB)`)
    return buffer as Buffer
  } catch (err: any) {
    console.log(`[Screenshot] ❌ Failed for ${url}: ${err.message}`)
    return null
  } finally {
    await browser?.close().catch(() => null)
  }
}

// ─── HTML extraction ───────────────────────────────────────────────────────────

async function extractHtmlContent(url: string): Promise<string | null> {
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      maxContentLength: 500_000
    })
    const html = res.data as string

    const title      = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()
    const metaDesc   = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
    const h1s        = [...html.matchAll(/<h1[^>]*>([^<]*)<\/h1>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean)
    const h2s        = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean).slice(0, 6)
    const hasForm    = /<form[\s>]/i.test(html)
    const hasBooking = /book|reserv|appointment|schedule|order online/i.test(html)
    const hasSocial  = /instagram\.com|facebook\.com|twitter\.com|linkedin\.com|tiktok\.com/i.test(html)
    const hasTestimonials = /testimonial|what.*clients.*say|our.*review|happy.*customer/i.test(html)
    const hasHTTPS   = url.startsWith('https')
    const viewport   = /<meta[^>]+name=["']viewport["']/i.test(html)

    // Copyright year detection
    const yearMatch  = html.match(/©\s*(\d{4})|copyright[^>]*?>?[^<]*?(\d{4})/i)
    const copyrightYear = yearMatch?.[1] ?? yearMatch?.[2]

    // Visible text stripped of tags, truncated to 1500 chars
    const bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1500)

    return JSON.stringify({
      title, metaDesc, h1s, h2s,
      hasForm, hasBooking, hasSocial, hasTestimonials,
      hasHTTPS, hasViewportMeta: viewport,
      copyrightYear,
      bodyText
    })
  } catch {
    return null
  }
}

// ─── Analysis — Vision (Gemini) ────────────────────────────────────────────────

async function analyzeWithVision(
  url: string,
  html: string | null,
  screenshot: Buffer,
  lighthouse?: LighthouseScores | null
): Promise<WebsiteAudit | null> {
  try {
    const model = getGemini().getGenerativeModel({ model: 'gemini-2.0-flash' })

    const lhContext = lighthouse
      ? `\nLighthouse (mobile): Performance ${lighthouse.performance}/100 · SEO ${lighthouse.seo}/100 · Accessibility ${lighthouse.accessibility}/100 · Best Practices ${lighthouse.bestPractices}/100`
      : ''

    const htmlContext = html
      ? `\nHTML data: ${html}`
      : ''

    const prompt = `You are a senior web designer at Ardeno Studio, a premium web agency in Sri Lanka. You are analyzing a potential client's website to find genuine sales opportunities.

Website: ${url}
${lhContext}${htmlContext}

CRITICAL RULES:
- Only report issues you can ACTUALLY SEE in the screenshot or confirmed in the HTML data
- Do NOT assume problems that aren't visible — if the site looks modern and clean, say so
- If HTTPS is missing (url starts with http://), that is a real critical issue
- Judge the design as it actually appears, not generically
- If the site is genuinely good-looking, acknowledge it — our pitch then becomes "enhancement" not "rescue"

Return ONLY valid JSON, no markdown:
{
  "firstImpression": "<2 honest sentences about what you actually see — design quality, photography, layout clarity, overall feel>",
  "criticalIssues": ["<only real problems you can see/confirm — e.g. no HTTPS, no contact form, broken layout, PDF menu. Leave array short if the site is decent>"],
  "quickWins": ["<specific improvements with clear ROI — e.g. 'Add online booking widget', 'Speed optimisation could cut load time in half'>"],
  "workingWell": ["<what's genuinely good — photography, branding, navigation. Be honest.>"],
  "ourAngle": "<1 sentence: the most compelling reason for THIS specific business to work with Ardeno Studio, based on what you actually saw>"
}`

    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { data: screenshot.toString('base64'), mimeType: 'image/jpeg' } }
        ]
      }]
    })

    return parseAudit(result.response.text())
  } catch (err: any) {
    console.log(`[WebsiteAnalyzer] ❌ Gemini Vision error: ${err.message}`)
    return null // let caller try text fallback
  }
}

// ─── Analysis — Text only (Groq fallback) ─────────────────────────────────────

async function analyzeWithText(
  url: string,
  html: string,
  lighthouse?: LighthouseScores | null
): Promise<WebsiteAudit | null> {
  try {
    const lhContext = lighthouse
      ? `Lighthouse: Performance ${lighthouse.performance}/100, SEO ${lighthouse.seo}/100, Accessibility ${lighthouse.accessibility}/100`
      : ''

    const completion = await getGroq().chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      messages: [{
        role: 'user',
        content: `You are a senior web designer at Ardeno Studio analyzing a potential client's website.

Website: ${url}
${lhContext}
HTML data: ${html}

RULES: Only report issues confirmed by the HTML data. Don't assume visual problems you can't verify. If HTTPS is missing (http:// url), flag it. Be accurate, not generically critical.

Return ONLY valid JSON, no markdown:
{
  "firstImpression": "<honest assessment based on the HTML structure and content — what type of site is this, what's the overall feel>",
  "criticalIssues": ["<only confirmed issues — no HTTPS, no contact form, no meta description, outdated copyright year, etc>"],
  "quickWins": ["<specific improvements with clear ROI for this business type>"],
  "workingWell": ["<what the HTML confirms is good — booking system, social links, clear content, etc>"],
  "ourAngle": "<1 sentence: most compelling sales argument based on what the data actually shows>"
}`
      }]
    })

    return parseAudit(completion.choices[0].message.content ?? '{}')
  } catch {
    return null
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseAudit(raw: string): WebsiteAudit | null {
  try {
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed  = JSON.parse(cleaned)
    return {
      firstImpression: String(parsed.firstImpression ?? ''),
      criticalIssues:  Array.isArray(parsed.criticalIssues) ? parsed.criticalIssues.slice(0, 3).map(String) : [],
      quickWins:       Array.isArray(parsed.quickWins)      ? parsed.quickWins.slice(0, 3).map(String)      : [],
      workingWell:     Array.isArray(parsed.workingWell)    ? parsed.workingWell.slice(0, 2).map(String)     : [],
      ourAngle:        String(parsed.ourAngle ?? '')
    }
  } catch {
    return null
  }
}

/** Format audit as a Discord embed description */
export function formatAuditEmbed(audit: WebsiteAudit): string {
  const lines: string[] = []

  lines.push('📝 **First Impression**')
  lines.push(audit.firstImpression)

  if (audit.criticalIssues.length > 0) {
    lines.push('')
    lines.push('❌ **Critical Issues**')
    audit.criticalIssues.forEach(i => lines.push(`• ${i}`))
  }

  if (audit.quickWins.length > 0) {
    lines.push('')
    lines.push('⚡ **Quick Wins for Us**')
    audit.quickWins.forEach(w => lines.push(`• ${w}`))
  }

  if (audit.workingWell.length > 0) {
    lines.push('')
    lines.push('✅ **What\'s Working**')
    audit.workingWell.forEach(w => lines.push(`• ${w}`))
  }

  if (audit.ourAngle) {
    lines.push('')
    lines.push('💰 **Our Angle**')
    lines.push(`*"${audit.ourAngle}"*`)
  }

  return lines.join('\n')
}
