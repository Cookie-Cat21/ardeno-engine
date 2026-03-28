// Competitor intelligence — scrapes rival agency websites, screenshots them,
// runs AI analysis, posts/updates a dedicated forum thread per competitor

import axios from 'axios'
import puppeteer from 'puppeteer'
import Groq from 'groq-sdk'
import {
  AttachmentBuilder, EmbedBuilder,
  ForumChannel, ChannelType, Client
} from 'discord.js'
import type { Competitor } from '../config/competitors'
import { ARDENO_POSITIONING } from '../config/competitors'
import { getCompetitorThread, upsertCompetitorThread, getCompetitorSnapshot, updateCompetitorSnapshot } from '../db/supabase'
import { trackInstagram, trackWebsiteChanges, buildInstagramEmbed, buildChangesEmbed } from './competitorTracking'

let _groq: Groq | null = null
const getGroq = () => _groq ??= new Groq({ apiKey: process.env.GROQ_API_KEY! })

export type ThreatLevel = 'threat' | 'watching' | 'weak' | 'inactive'

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
  threatLevel: ThreatLevel
  screenshot: Buffer | null
  error?: string
}

// Forum tag names — must match what we create in the forum
const THREAT_TAGS: Record<ThreatLevel, string> = {
  threat:   '🔴 Threat',
  watching: '🟡 Watching',
  weak:     '🟢 Weak',
  inactive: '⚫ Inactive',
}

const THREAT_COLORS: Record<ThreatLevel, number> = {
  threat:   0xED4245,  // red
  watching: 0xFEE75C,  // yellow
  weak:     0x57F287,  // green
  inactive: 0x4f545c,  // grey
}

// ─── Main entry point ──────────────────────────────────────────────────────────

export async function runCompetitorIntel(
  competitors: Competitor[],
  discordClient: Client
): Promise<void> {
  const forumId = process.env.DISCORD_COMPETITORS_FORUM_ID
  if (!forumId) {
    console.error('[Intel] DISCORD_COMPETITORS_FORUM_ID not set')
    return
  }

  const forum = await discordClient.channels.fetch(forumId).catch(() => null) as ForumChannel | null
  if (!forum || forum.type !== ChannelType.GuildForum) {
    console.error('[Intel] Competitors forum channel not found or wrong type')
    return
  }

  // Ensure all threat tags exist in the forum
  await ensureCompetitorTags(forum)

  console.log(`[Intel] Starting competitor intel on ${competitors.length} agencies`)

  for (const competitor of competitors) {
    console.log(`[Intel] Analysing ${competitor.name}...`)
    try {
      const profile = await analyseCompetitor(competitor)
      await postToForum(forum, profile, discordClient)
      console.log(`[Intel] ✅ ${competitor.name} — ${profile.threatLevel}`)
    } catch (err: any) {
      console.error(`[Intel] ❌ ${competitor.name}: ${err.message}`)
    }
    // Respectful delay between competitors
    await new Promise(r => setTimeout(r, 3000))
  }

  console.log('[Intel] ✅ All competitors analysed')
}

// ─── Forum thread management ───────────────────────────────────────────────────

async function ensureCompetitorTags(forum: ForumChannel): Promise<void> {
  const existing = forum.availableTags.map(t => t.name)
  const needed = Object.values(THREAT_TAGS).filter(t => !existing.includes(t))
  if (needed.length === 0) return

  try {
    const newTags = [
      ...forum.availableTags,
      ...needed.map(name => ({ name, moderated: false }))
    ]
    await forum.setAvailableTags(newTags)
    console.log(`[Intel] Created forum tags: ${needed.join(', ')}`)
  } catch (err: any) {
    console.error('[Intel] Could not create tags:', err.message)
  }
}

async function postToForum(
  forum: ForumChannel,
  profile: CompetitorProfile,
  client: Client
): Promise<void> {
  const { embeds, files } = buildProfileEmbed(profile)

  // Get the tag ID for this threat level
  const tagName = THREAT_TAGS[profile.threatLevel]
  const tag = forum.availableTags.find(t => t.name === tagName)
  const appliedTags = tag ? [tag.id] : []

  // Check if thread already exists
  const existingThreadId = await getCompetitorThread(profile.name)

  if (existingThreadId) {
    // Thread exists — post an update inside it
    try {
      const thread = await client.channels.fetch(existingThreadId) as any
      if (thread && thread.send) {
        await thread.send({ embeds, files })

        // Update the tag to reflect new threat level
        if (tag) await thread.setAppliedTags([tag.id]).catch(() => null)

        await upsertCompetitorThread(profile.name, profile.url, existingThreadId)
        return
      }
    } catch {
      // Thread was deleted — fall through to create a new one
    }
  }

  // Create a new thread
  const threadName = `${profile.name}`
  const thread = await forum.threads.create({
    name: threadName,
    appliedTags,
    message: { embeds, files }
  })

  await upsertCompetitorThread(profile.name, profile.url, thread.id)
}

// ─── Per-competitor analysis ───────────────────────────────────────────────────

async function analyseCompetitor(competitor: Competitor): Promise<CompetitorProfile> {
  const [htmlResult, screenshotResult] = await Promise.allSettled([
    fetchHtml(competitor.url),
    takeScreenshot(competitor.url)
  ])

  const html = htmlResult.status === 'fulfilled' ? htmlResult.value : null
  const screenshot = screenshotResult.status === 'fulfilled' ? screenshotResult.value : null

  if (!html) {
    return {
      name: competitor.name, url: competitor.url,
      services: [], pricing: '—', portfolioCount: '—',
      positioning: '—', techStack: [], lastActivity: '—',
      ourEdge: '—', watchOut: '—', opportunities: [],
      threatLevel: 'inactive', screenshot,
      error: 'Could not access site'
    }
  }

  const analysis = await groqAnalyse(competitor, html)
  return { name: competitor.name, url: competitor.url, ...analysis, screenshot }
}

async function fetchHtml(url: string): Promise<string> {
  const res = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    maxRedirects: 3
  })
  return (res.data as string)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)
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
    return (await page.screenshot({ type: 'jpeg', quality: 75 })) as Buffer
  } catch {
    return null
  } finally {
    await browser?.close().catch(() => null)
  }
}

async function groqAnalyse(
  competitor: Competitor,
  htmlText: string
): Promise<Omit<CompetitorProfile, 'name' | 'url' | 'screenshot' | 'error'>> {
  const completion = await getGroq().chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.3,
    messages: [{
      role: 'user',
      content: `You are a strategic analyst for Ardeno Studio, a Sri Lankan web design agency.

Ardeno's positioning:
${ARDENO_POSITIONING}

Competitor being analysed:
Name: ${competitor.name}
URL: ${competitor.url}
Website content: ${htmlText}

Return ONLY valid JSON, no markdown:
{
  "services": ["service 1", "service 2", "max 6"],
  "pricing": "exact pricing if shown, or 'Not listed publicly'",
  "portfolioCount": "number visible or 'Not shown'",
  "positioning": "their brand message in one sentence",
  "techStack": ["tech 1", "tech 2", "max 4"],
  "lastActivity": "most recent blog/news date if visible, else 'Unknown'",
  "ourEdge": "one sentence — Ardeno's clear advantage over this competitor",
  "watchOut": "one sentence — something they do well Ardeno should note",
  "opportunities": ["gap Ardeno can exploit vs this competitor", "second gap", "max 3"],
  "threatLevel": "threat | watching | weak | inactive — threat=strong active competitor, watching=moderate, weak=poor web presence or niche, inactive=site down or abandoned"
}`
    }]
  })

  try {
    const raw = completion.choices[0].message.content ?? '{}'
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```\n?/g, '').trim()
    const p = JSON.parse(cleaned)
    const threatLevel: ThreatLevel = ['threat', 'watching', 'weak', 'inactive'].includes(p.threatLevel)
      ? p.threatLevel : 'watching'

    return {
      services:       Array.isArray(p.services)      ? p.services.slice(0, 6)      : [],
      pricing:        String(p.pricing       ?? 'Not listed publicly'),
      portfolioCount: String(p.portfolioCount ?? '—'),
      positioning:    String(p.positioning    ?? '—'),
      techStack:      Array.isArray(p.techStack)      ? p.techStack.slice(0, 4)      : [],
      lastActivity:   String(p.lastActivity   ?? 'Unknown'),
      ourEdge:        String(p.ourEdge        ?? '—'),
      watchOut:       String(p.watchOut       ?? '—'),
      opportunities:  Array.isArray(p.opportunities)  ? p.opportunities.slice(0, 3)  : [],
      threatLevel,
    }
  } catch {
    return {
      services: [], pricing: '—', portfolioCount: '—', positioning: '—',
      techStack: [], lastActivity: '—', ourEdge: '—', watchOut: '—',
      opportunities: [], threatLevel: 'watching'
    }
  }
}

// ─── Embed builder ─────────────────────────────────────────────────────────────

function buildProfileEmbed(profile: CompetitorProfile): {
  embeds: EmbedBuilder[]
  files: AttachmentBuilder[]
} {
  const color = THREAT_COLORS[profile.threatLevel]
  const files: AttachmentBuilder[] = []

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${THREAT_TAGS[profile.threatLevel]} — ${profile.name}`)
    .setURL(profile.url)

  if (profile.error && !profile.screenshot) {
    embed.setDescription(`❌ Could not access site: ${profile.error}`)
    return { embeds: [embed], files }
  }

  if (profile.positioning !== '—') {
    embed.setDescription(`*"${profile.positioning}"*`)
  }

  embed.addFields(
    {
      name: '🛠️ Services',
      value: profile.services.length > 0
        ? profile.services.map(s => `• ${s}`).join('\n')
        : '—',
      inline: true
    },
    {
      name: '📊 Info',
      value: [
        `💰 ${profile.pricing}`,
        `📁 Portfolio: ${profile.portfolioCount}`,
        `🔧 ${profile.techStack.join(', ') || '—'}`,
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

  embed.setTimestamp().setFooter({ text: `Updated by Ardeno OS · ${profile.url}` })

  if (profile.screenshot) {
    const filename = `${profile.name.toLowerCase().replace(/\s+/g, '-')}.jpg`
    files.push(new AttachmentBuilder(profile.screenshot, { name: filename }))
    embed.setImage(`attachment://${filename}`)
  }

  return { embeds: [embed], files }
}
