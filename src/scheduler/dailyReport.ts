// Daily pipeline report — runs at 6pm Sri Lanka time (12:30 UTC)
// Shows what happened today: leads found, approved, contacted, responded, converted

import { supabase } from '../db/supabase'

export interface DailyStats {
  found: number
  approved: number
  contacted: number   // emailed + contacted
  responded: number
  converted: number
  hotLeads: number    // score >= 80 found today
  topLead: { name: string; score: number; niche: string; location: string } | null
  allTimeTotal: number
  allTimeConverted: number
}

/**
 * Fetch today's stats from Supabase.
 * "Today" = midnight to now in Sri Lanka time (UTC+5:30).
 */
export async function getDailyStats(): Promise<DailyStats> {
  // Sri Lanka is UTC+5:30 — calculate today's midnight in UTC
  const now = new Date()
  const slOffset = 5.5 * 60 * 60 * 1000  // 5h30m in ms
  const slNow = new Date(now.getTime() + slOffset)

  // Midnight SL time → convert back to UTC for DB query
  const slMidnight = new Date(slNow)
  slMidnight.setUTCHours(0, 0, 0, 0)
  const todayStart = new Date(slMidnight.getTime() - slOffset).toISOString()

  // Leads found today
  const { data: todayLeads } = await supabase
    .from('leads')
    .select('id, business_name, score, niche, location, status')
    .gte('created_at', todayStart)
    .order('score', { ascending: false })

  const leads = todayLeads ?? []

  const found     = leads.length
  const approved  = leads.filter(l => ['approved', 'emailed', 'contacted', 'responded', 'converted'].includes(l.status)).length
  const contacted = leads.filter(l => ['emailed', 'contacted', 'responded', 'converted'].includes(l.status)).length
  const responded = leads.filter(l => ['responded', 'converted'].includes(l.status)).length
  const converted = leads.filter(l => l.status === 'converted').length
  const hotLeads  = leads.filter(l => l.score >= 80).length
  const topLead   = leads.length > 0 ? {
    name: leads[0].business_name,
    score: leads[0].score,
    niche: leads[0].niche,
    location: leads[0].location
  } : null

  // All-time totals
  const { count: allTimeTotal } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })

  const { count: allTimeConverted } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'converted')

  return {
    found,
    approved,
    contacted,
    responded,
    converted,
    hotLeads,
    topLead,
    allTimeTotal: allTimeTotal ?? 0,
    allTimeConverted: allTimeConverted ?? 0
  }
}

/**
 * Format the daily report as a Discord embed description.
 */
export function formatDailyReport(stats: DailyStats, date: Date): {
  title: string
  description: string
  color: number
} {
  const dateStr = date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Asia/Colombo'
  })

  // Funnel bar — visual pipeline
  const funnelLine = (label: string, value: number, emoji: string) => {
    const bar = value > 0 ? '█'.repeat(Math.min(value, 10)) : '—'
    return `${emoji} **${label}** ${value > 0 ? `**${value}**` : '0'} ${value > 0 ? `\`${bar}\`` : ''}`
  }

  const lines: string[] = [
    `## 📅 ${dateStr}`,
    '',
    funnelLine('Found', stats.found, '🔍'),
    funnelLine('Approved', stats.approved, '✅'),
    funnelLine('Contacted', stats.contacted, '📤'),
    funnelLine('Responded', stats.responded, '💬'),
    funnelLine('Converted', stats.converted, '🏆'),
  ]

  if (stats.hotLeads > 0) {
    lines.push('')
    lines.push(`🔥 **${stats.hotLeads} hot lead${stats.hotLeads > 1 ? 's' : ''}** found today (score 80+)`)
  }

  if (stats.topLead) {
    lines.push('')
    lines.push(`**⭐ Best lead today**`)
    lines.push(`${stats.topLead.name} · ${stats.topLead.niche} in ${stats.topLead.location} · **${stats.topLead.score}/100**`)
  }

  lines.push('')
  lines.push(`─────────────────`)
  lines.push(`📊 All time: **${stats.allTimeTotal}** leads · **${stats.allTimeConverted}** converted`)

  // Pick embed color based on how the day went
  let color = 0x5865F2  // default blurple
  if (stats.found === 0) color = 0x4f545c  // grey — no activity
  else if (stats.converted > 0) color = 0x57F287  // green — a win!
  else if (stats.responded > 0) color = 0xFEE75C  // yellow — progress
  else if (stats.hotLeads > 0) color = 0xEB459E  // pink — hot leads found

  return {
    title: `📈 Daily Pipeline Report`,
    description: lines.join('\n'),
    color
  }
}
