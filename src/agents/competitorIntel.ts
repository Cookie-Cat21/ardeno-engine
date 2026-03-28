// Competitor intelligence — scrapes rival agency websites, screenshots them,
// runs AI analysis comparing to Ardeno Studio, posts report to Discord

import axios from 'axios'
import puppeteer from 'puppeteer'
import Groq from 'groq-sdk'
import { AttachmentBuilder, EmbedBuilder, TextChannel } from 'discord.js'
import type { Competitor } from '../config/competitors'
import { ARDENO_POSITIONING } from '../config/competitors'

let _groq: Groq | null = null
const getGroq = () => _groq ??= new Groq({ apiKey: process.env.GROQ_API_KEY! })

export interface CompetitorProfile {
  name: string
  url: string
  services: string[]
  pricing: string
  portfolioCount: string
  positioning: string
  techStack: string[]
  lastActivity: string
  ourEdge: string
  watchOut: string
  opportunities: string[]
  screenshot: Buffer | null
  error?: string
}

// ─── Main entry point ──────────────────────────────────────────────────────────

export async function runCompetitorIntel(
  competitors: Competitor[]
): Promise<CompetitorProfile[]> {
  console.log(`[Intel] Starting competitor intel on ${competitors.length} agencies`)
  const results: CompetitorProfile[] = []

  for (const competitor of competitors) {
    console.log(`[Intel] Analysing ${competitor.name} — ${competitor.url}`)
    try {
      const profile = await analyseCompetitor(competitor)
      results.push(profile)
      console.log(`[Intel] ✅ Done: ${competitor.name}`)
    } catch (err: any) {
      console.log(`[Intel] ❌ Failed: ${competitor.name} — ${err.message}`)
      results.push({
        name: competitor.name,
        url: competitor.url,
        services: [],
        pricing: 'Could not fetch',
        portfolioCount: '—',
        positioning: '—',
        techStack: [],
        lastActivity: '—',
        ourEdge: '—',
        watchOut: '—',
        opportunities: [],
        screenshot: null,
        error: err.message
      })
    }
    // Small delay between competitors to be respectful
    await new Promise(r => setTimeout(r, 3000))
  }

  return results
}

// ─── Per-competitor analysis ───────────────────────────────────────────────────

async function analyseCompetitor(competitor: Competitor): Promise<CompetitorProfile> {
  const [html, screenshot] = await Promise.allSettled([
    fetchHtml(competitor.url),
    takeScreenshot(competitor.url)
  ])

  const htmlContent = html.status === 'fulfilled' ? html.value : null
  const screenshotBuf = screenshot.status === 'fulfilled' ? screenshot.value : null

  if (!htmlContent) {
    return {
      name: competitor.name,
      url: competitor.url,
      services: [],
      pricing: 'Could not access site',
      portfolioCount: '—',
      positioning: '—',
      techStack: [],
      lastActivity: '—',
      ourEdge: '—',
      watchOut: '—',
      opportunities: [],
      screenshot: screenshotBuf,
      error: 'HTML unavailable'
    }
  }

  const analysis = await groqAnalyse(competitor, htmlContent)

  return {
    name: competitor.name,
    url: competitor.url,
    ...analysis,
    screenshot: screenshotBuf
  }
}

async function fetchHtml(url: string): Promise<string> {
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    maxRedirects: 3
  })
  const html = res.data as string

  // Extract readable text only — strip scripts, styles
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)  // keep it under token limit
}

async function takeScreenshot(url: string): Promise<Buffer | null> {
  let browser = null
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 }).catch(async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 })
      await new Promise(r => setTimeout(r, 2000))
    })
    await new Promise(r => setTimeout(r, 1500))
    const buf = await page.screenshot({ type: 'jpeg', quality: 75 })
    return buf as Buffer
  } catch {
    return null
  } finally {
    await browser?.close().catch(() => null)
  }
}

async function groqAnalyse(competitor: Competitor, htmlText: string): Promise<Omit<CompetitorProfile, 'name' | 'url' | 'screenshot' | 'error'>> {
  const completion = await getGroq().chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.3,
    messages: [{
      role: 'user',
      content: `You are a strategic analyst for Ardeno Studio, a Sri Lankan web design agency.

Ardeno's positioning:
${ARDENO_POSITIONING}

You are analysing a COMPETITOR agency:
Name: ${competitor.name}
URL: ${competitor.url}

Website text content:
${htmlText}

Analyse this competitor and return ONLY valid JSON, no markdown:
{
  "services": ["list of services they offer, max 6"],
  "pricing": "exact pricing if listed, or 'Not listed publicly'",
  "portfolioCount": "approximate number of portfolio pieces shown, or 'Not shown'",
  "positioning": "their main brand message or tagline in one sentence",
  "techStack": ["technologies they mention or you can infer, max 4"],
  "lastActivity": "most recent blog post date or content update if visible, else 'Unknown'",
  "ourEdge": "one sentence — where Ardeno Studio has a clear advantage over this competitor",
  "watchOut": "one sentence — something this competitor does well that Ardeno should note",
  "opportunities": ["specific gap or opportunity Ardeno can exploit vs this competitor", "second opportunity, max 3 total"]
}`
    }]
  })

  try {
    const raw = completion.choices[0].message.content ?? '{}'
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed = JSON.parse(cleaned)
    return {
      services:       Array.isArray(parsed.services)      ? parsed.services.slice(0, 6)      : [],
      pricing:        String(parsed.pricing       ?? 'Not listed publicly'),
      portfolioCount: String(parsed.portfolioCount ?? '—'),
      positioning:    String(parsed.positioning    ?? '—'),
      techStack:      Array.isArray(parsed.techStack)      ? parsed.techStack.slice(0, 4)      : [],
      lastActivity:   String(parsed.lastActivity   ?? 'Unknown'),
      ourEdge:        String(parsed.ourEdge        ?? '—'),
      watchOut:       String(parsed.watchOut       ?? '—'),
      opportunities:  Array.isArray(parsed.opportunities)  ? parsed.opportunities.slice(0, 3)  : [],
    }
  } catch {
    return {
      services: [], pricing: '—', portfolioCount: '—', positioning: '—',
      techStack: [], lastActivity: '—', ourEdge: '—', watchOut: '—', opportunities: []
    }
  }
}

// ─── Discord formatting ────────────────────────────────────────────────────────

export function buildCompetitorEmbeds(profile: CompetitorProfile): {
  embeds: EmbedBuilder[]
  files: AttachmentBuilder[]
} {
  const embeds: EmbedBuilder[] = []
  const files: AttachmentBuilder[] = []

  if (profile.error && !profile.screenshot) {
    // Couldn't reach site at all
    embeds.push(new EmbedBuilder()
      .setColor(0x4f545c)
      .setTitle(`🏢 ${profile.name}`)
      .setURL(profile.url)
      .setDescription(`❌ Could not access: ${profile.error}`)
    )
    return { embeds, files }
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`🏢 ${profile.name}`)
    .setURL(profile.url)

  if (profile.positioning !== '—') {
    embed.setDescription(`*"${profile.positioning}"*`)
  }

  embed.addFields(
    {
      name: '🛠️ Services',
      value: profile.services.length > 0 ? profile.services.map(s => `• ${s}`).join('\n') : '—',
      inline: true
    },
    {
      name: '📊 Info',
      value: [
        `💰 Pricing: ${profile.pricing}`,
        `📁 Portfolio: ${profile.portfolioCount}`,
        `🔧 Tech: ${profile.techStack.join(', ') || '—'}`,
        `📝 Last active: ${profile.lastActivity}`
      ].join('\n'),
      inline: true
    },
    {
      name: '⚔️ vs Ardeno',
      value: [
        `✅ **Our edge:** ${profile.ourEdge}`,
        `👀 **Watch out:** ${profile.watchOut}`
      ].join('\n'),
      inline: false
    }
  )

  if (profile.opportunities.length > 0) {
    embed.addFields({
      name: '🎯 Opportunities for us',
      value: profile.opportunities.map(o => `• ${o}`).join('\n'),
      inline: false
    })
  }

  // Attach screenshot
  if (profile.screenshot) {
    const filename = `${profile.name.toLowerCase().replace(/\s+/g, '-')}-preview.jpg`
    const attachment = new AttachmentBuilder(profile.screenshot, { name: filename })
    embed.setImage(`attachment://${filename}`)
    files.push(attachment)
  }

  embed.setFooter({ text: profile.url })
  embeds.push(embed)

  return { embeds, files }
}
