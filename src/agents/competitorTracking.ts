// Competitor change tracking — Instagram new posts, website diffs, new portfolio projects
// Runs as part of the weekly intel scan and posts separate embeds per update type

import axios from 'axios'
import puppeteer from 'puppeteer'
import Groq from 'groq-sdk'
import { AttachmentBuilder, EmbedBuilder } from 'discord.js'

let _groq: Groq | null = null
const getGroq = () => _groq ??= new Groq({ apiKey: process.env.GROQ_API_KEY! })

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InstagramResult {
  username:     string
  postCount:    number | null
  followers:    string | null   // "1.2K" etc — kept as string since Instagram formats it
  newPosts:     number | null   // null if we can't compare (first run)
  screenshot:   Buffer | null
  accessible:   boolean         // false = login wall or blocked
}

export interface WebsiteChangeResult {
  changed:       boolean
  summary:       string         // Groq plain-English summary of what changed
  newProjects:   string[]       // newly detected portfolio items
  lostProjects:  string[]       // items no longer on the site
  newSnapshot:   string         // store this for next week's comparison
  newPortfolioSnapshot: string  // store portfolio list separately
}

// ─── Instagram tracking ────────────────────────────────────────────────────────

/**
 * Try to get Instagram profile info without needing a login.
 * Uses Puppeteer to visit the profile and extract meta/page data.
 * Falls back gracefully — always returns something useful.
 */
export async function trackInstagram(
  instagramUrl: string,
  previousPostCount: number | null
): Promise<InstagramResult> {
  // Extract username from URL (handles /username/ or /username)
  const usernameMatch = instagramUrl.match(/instagram\.com\/([a-zA-Z0-9._]+)\/?/)
  const username = usernameMatch?.[1] ?? ''
  if (!username) return { username: '', postCount: null, followers: null, newPosts: null, screenshot: null, accessible: false }

  let browser = null
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    })
    const page = await browser.newPage()

    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1')
    await page.setViewport({ width: 390, height: 844 })  // iPhone viewport — more likely to work

    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'networkidle2',
      timeout: 20000
    }).catch(async () => {
      await page.goto(`https://www.instagram.com/${username}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 10000
      })
    })

    await new Promise(r => setTimeout(r, 3000))

    // Try to extract post count + followers from the page
    const pageData = await page.evaluate(() => {
      // Try og:description meta tag (has "X Posts, X Followers" format)
      const ogDesc = document.querySelector('meta[property="og:description"]')?.getAttribute('content') ?? ''

      // Try to find the numbers in page text
      const bodyText = document.body?.innerText ?? ''

      // Check if we hit a login wall
      const isLoginWall = bodyText.includes('Log in to Instagram') || bodyText.includes('Create an account')

      return { ogDesc, bodyText: bodyText.slice(0, 3000), isLoginWall }
    })

    let postCount: number | null = null
    let followers: string | null = null

    if (!pageData.isLoginWall) {
      // Try og:description: "1.2K Followers, 234 Following, 89 Posts"
      const postMatch   = pageData.ogDesc.match(/(\d[\d,]*)\s+Posts?/i)
      const followMatch = pageData.ogDesc.match(/([\d.,]+[KkMm]?)\s+Followers?/i)
      if (postMatch)   postCount = parseInt(postMatch[1].replace(/,/g, ''))
      if (followMatch) followers = followMatch[1]

      // Fallback: try extracting from body text (profile pages sometimes show counts)
      if (!postCount) {
        const bodyPostMatch = pageData.bodyText.match(/(\d+)\s+posts?/i)
        if (bodyPostMatch) postCount = parseInt(bodyPostMatch[1])
      }
    }

    // Screenshot — even a login wall screenshot is useful (confirms account exists)
    const screenshot = (await page.screenshot({ type: 'jpeg', quality: 70 })) as Buffer

    const newPosts = (postCount !== null && previousPostCount !== null && postCount > previousPostCount)
      ? postCount - previousPostCount
      : null

    return {
      username,
      postCount,
      followers,
      newPosts,
      screenshot,
      accessible: !pageData.isLoginWall
    }
  } catch (err: any) {
    console.log(`[Intel] Instagram scrape failed for @${username}: ${err.message}`)
    return { username, postCount: null, followers: null, newPosts: null, screenshot: null, accessible: false }
  } finally {
    await browser?.close().catch(() => null)
  }
}

// ─── Website change detection ─────────────────────────────────────────────────

/**
 * Fetch the competitor's site, extract key sections, compare to stored snapshot.
 * Uses Groq to describe what changed in plain English.
 */
export async function trackWebsiteChanges(
  url: string,
  previousSnapshot: string | null,
  previousPortfolioSnapshot: string | null
): Promise<WebsiteChangeResult> {
  let html: string
  try {
    const res = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      maxRedirects: 3
    })
    html = res.data as string
  } catch {
    return {
      changed: false,
      summary: 'Could not access site this week.',
      newProjects: [],
      lostProjects: [],
      newSnapshot: previousSnapshot ?? '',
      newPortfolioSnapshot: previousPortfolioSnapshot ?? ''
    }
  }

  // Strip scripts/styles, extract clean text
  const clean = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Extract structured snapshot — key content sections
  const snapshot = extractSnapshot(html, clean)
  const portfolioItems = extractPortfolioItems(html, clean)
  const portfolioSnapshot = JSON.stringify(portfolioItems)

  // First run — nothing to compare yet
  if (!previousSnapshot) {
    return {
      changed: false,
      summary: 'First scan — baseline captured for future comparisons.',
      newProjects: portfolioItems,
      lostProjects: [],
      newSnapshot: snapshot,
      newPortfolioSnapshot: portfolioSnapshot
    }
  }

  // Compare snapshots
  if (snapshot === previousSnapshot && portfolioSnapshot === previousPortfolioSnapshot) {
    return {
      changed: false,
      summary: 'No changes detected this week.',
      newProjects: [],
      lostProjects: [],
      newSnapshot: snapshot,
      newPortfolioSnapshot: portfolioSnapshot
    }
  }

  // Something changed — ask Groq to explain it
  const summary = await groqDiffSummary(url, previousSnapshot, snapshot)

  // Portfolio diff
  const prevPortfolio: string[] = previousPortfolioSnapshot ? JSON.parse(previousPortfolioSnapshot).catch?.(() => []) ?? tryParse(previousPortfolioSnapshot) : []
  const newProjects  = portfolioItems.filter(p => !prevPortfolio.includes(p))
  const lostProjects = prevPortfolio.filter(p => !portfolioItems.includes(p))

  return {
    changed: true,
    summary,
    newProjects,
    lostProjects,
    newSnapshot: snapshot,
    newPortfolioSnapshot: portfolioSnapshot
  }
}

function extractSnapshot(html: string, cleanText: string): string {
  const data: Record<string, string> = {}

  // Page title
  data.title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? ''

  // Main headings
  const h1s = [...html.matchAll(/<h1[^>]*>([^<]*)<\/h1>/gi)].map(m => m[1].trim()).filter(Boolean)
  const h2s = [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/gi)].map(m => m[1].trim()).filter(Boolean)
  data.headings = [...h1s, ...h2s].slice(0, 10).join(' | ')

  // Services keywords (look for list items and service sections)
  const services = [...html.matchAll(/<li[^>]*>([^<]{5,80})<\/li>/gi)]
    .map(m => m[1].trim())
    .filter(t => /service|design|develop|market|seo|app|brand/i.test(t))
    .slice(0, 8)
  data.services = services.join(' | ')

  // Meta description
  data.metaDesc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)?.[1] ?? ''

  // First 1500 chars of visible text (catches pricing, about, CTA changes)
  data.bodyStart = cleanText.slice(0, 1500)

  return JSON.stringify(data)
}

function extractPortfolioItems(html: string, cleanText: string): string[] {
  const items = new Set<string>()

  // Look for elements that commonly contain portfolio/case study titles
  const patterns = [
    /<(?:h[2-4]|figcaption|strong)[^>]*class="[^"]*(?:project|work|portfolio|case|client)[^"]*"[^>]*>([^<]{3,80})<\//gi,
    /(?:project|work|portfolio|client|case study)[^<>]{0,30}>\s*([A-Z][^<]{5,60})/gi,
  ]

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const item = match[1].trim().replace(/\s+/g, ' ')
      if (item.length > 3 && item.length < 80) items.add(item)
    }
  }

  // Fallback: look for portfolio/work section headings in clean text
  const workSection = cleanText.match(/(?:our work|portfolio|projects|case studies)[^]{0,2000}/i)?.[0] ?? ''
  const lines = workSection.split(/\n|\./).map(l => l.trim()).filter(l => l.length > 5 && l.length < 60 && /^[A-Z]/.test(l))
  lines.slice(0, 10).forEach(l => items.add(l))

  return [...items].slice(0, 20)
}

function tryParse(str: string): string[] {
  try { return JSON.parse(str) } catch { return [] }
}

async function groqDiffSummary(url: string, prev: string, curr: string): Promise<string> {
  try {
    const completion = await getGroq().chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `A competitor's website (${url}) has changed. Compare these two snapshots and describe what changed in 2-3 bullet points. Be specific — mention actual content differences, not just "the site changed". If it's a minor change say so.

Previous snapshot:
${prev.slice(0, 1500)}

Current snapshot:
${curr.slice(0, 1500)}

Return 2-3 bullet points starting with • describing what actually changed. Be concise.`
      }]
    })
    return completion.choices[0].message.content?.trim() ?? 'Changes detected but could not summarise.'
  } catch {
    return 'Site content changed since last scan — check the thread for details.'
  }
}

// ─── Discord embeds ───────────────────────────────────────────────────────────

export function buildInstagramEmbed(
  result: InstagramResult,
  competitorName: string
): { embeds: EmbedBuilder[]; files: AttachmentBuilder[] } {
  const files: AttachmentBuilder[] = []

  const embed = new EmbedBuilder()
    .setColor(result.newPosts && result.newPosts > 0 ? 0xE1306C : 0x833AB4)  // Instagram pink/purple
    .setTitle(`📸 Instagram — @${result.username}`)
    .setURL(`https://www.instagram.com/${result.username}/`)

  if (!result.accessible && !result.screenshot) {
    embed.setDescription('❌ Instagram blocked access this week.')
    return { embeds: [embed], files }
  }

  const lines: string[] = []

  if (result.followers)  lines.push(`👥 **Followers:** ${result.followers}`)
  if (result.postCount !== null) lines.push(`📷 **Posts:** ${result.postCount}`)

  if (result.newPosts && result.newPosts > 0) {
    lines.push(`\n🔔 **${result.newPosts} new post${result.newPosts > 1 ? 's' : ''} since last week!**`)
  } else if (result.postCount !== null) {
    lines.push(`\n✅ No new posts this week`)
  }

  if (!result.accessible) {
    lines.push(`\n*Instagram showing login wall — screenshot may be limited*`)
  }

  embed.setDescription(lines.join('\n') || 'Profile scanned — see screenshot below.')

  if (result.screenshot) {
    const filename = `ig-${result.username}.jpg`
    files.push(new AttachmentBuilder(result.screenshot, { name: filename }))
    embed.setImage(`attachment://${filename}`)
  }

  embed.setFooter({ text: `@${result.username} · Scanned by Ardeno OS` }).setTimestamp()

  return { embeds: [embed], files }
}

export function buildChangesEmbed(
  changes: WebsiteChangeResult,
  competitorName: string
): EmbedBuilder | null {
  // Don't post if nothing changed and it's not the first run
  if (!changes.changed && changes.summary === 'No changes detected this week.') return null

  const embed = new EmbedBuilder()
    .setColor(changes.changed ? 0xFEE75C : 0x4f545c)
    .setTitle(changes.changed ? `🔄 Website Changes — ${competitorName}` : `🔍 Website — ${competitorName}`)
    .setTimestamp()

  const lines: string[] = []

  if (changes.changed) {
    lines.push('**What changed:**')
    lines.push(changes.summary)
  } else {
    lines.push(changes.summary)
  }

  if (changes.newProjects.length > 0) {
    lines.push('')
    lines.push(`**🆕 New projects detected (${changes.newProjects.length}):**`)
    changes.newProjects.slice(0, 5).forEach(p => lines.push(`• ${p}`))
  }

  if (changes.lostProjects.length > 0) {
    lines.push('')
    lines.push(`**🗑️ Projects removed:**`)
    changes.lostProjects.slice(0, 3).forEach(p => lines.push(`• ${p}`))
  }

  embed.setDescription(lines.join('\n'))
  embed.setFooter({ text: 'Ardeno OS · Website diff tracker' })

  return embed
}
