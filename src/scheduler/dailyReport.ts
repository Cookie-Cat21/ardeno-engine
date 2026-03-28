// Daily pipeline report — runs at 6pm Sri Lanka time (12:30 UTC)
// Shows today's stats vs yesterday with comparison arrows + AI commentary

import { supabase } from '../db/supabase'

export interface DailyStats {
  found: number
  approved: number
  contacted: number
  responded: number
  converted: number
  hotLeads: number
  topLead: { name: string; score: number; niche: string; location: string } | null
  allTimeTotal: number
  allTimeConverted: number
}

const SL_OFFSET_MS = 5.5 * 60 * 60 * 1000  // UTC+5:30

/**
 * Get the UTC start/end of a SL calendar day.
 * daysAgo=0 → today, daysAgo=1 → yesterday
 */
function slDayRange(daysAgo: number): { start: string; end: string } {
  const now = new Date()
  const slNow = new Date(now.getTime() + SL_OFFSET_MS)

  // Midnight of the target day in SL time
  const slMidnight = new Date(slNow)
  slMidnight.setUTCHours(0, 0, 0, 0)
  slMidnight.setUTCDate(slMidnight.getUTCDate() - daysAgo)

  const start = new Date(slMidnight.getTime() - SL_OFFSET_MS)
  const end   = new Date(start.getTime() + 24 * 60 * 60 * 1000)

  return { start: start.toISOString(), end: end.toISOString() }
}

async function fetchStatsForDay(daysAgo: number): Promise<DailyStats> {
  const { start, end } = slDayRange(daysAgo)

  const { data: leads } = await supabase
    .from('leads')
    .select('id, business_name, score, niche, location, status')
    .gte('created_at', start)
    .lt('created_at', end)
    .order('score', { ascending: false })

  const rows = leads ?? []

  const found     = rows.length
  const approved  = rows.filter(l => ['approved', 'emailed', 'contacted', 'responded', 'converted'].includes(l.status)).length
  const contacted = rows.filter(l => ['emailed', 'contacted', 'responded', 'converted'].includes(l.status)).length
  const responded = rows.filter(l => ['responded', 'converted'].includes(l.status)).length
  const converted = rows.filter(l => l.status === 'converted').length
  const hotLeads  = rows.filter(l => l.score >= 80).length
  const topLead   = rows[0] ? {
    name: rows[0].business_name,
    score: rows[0].score,
    niche: rows[0].niche,
    location: rows[0].location
  } : null

  const { count: allTimeTotal }     = await supabase.from('leads').select('*', { count: 'exact', head: true })
  const { count: allTimeConverted } = await supabase.from('leads').select('*', { count: 'exact', head: true }).eq('status', 'converted')

  return { found, approved, contacted, responded, converted, hotLeads, topLead, allTimeTotal: allTimeTotal ?? 0, allTimeConverted: allTimeConverted ?? 0 }
}

export async function getDailyStats(): Promise<DailyStats> {
  return fetchStatsForDay(0)
}

export async function getDailyStatsWithComparison(): Promise<{ today: DailyStats; yesterday: DailyStats }> {
  const [today, yesterday] = await Promise.all([
    fetchStatsForDay(0),
    fetchStatsForDay(1)
  ])
  return { today, yesterday }
}

// ─── Formatting ────────────────────────────────────────────────────────────────

/** Returns ↑ green, ↓ red, or → grey with the diff */
function diff(today: number, yesterday: number): string {
  if (yesterday === 0 && today === 0) return '`→ same`'
  if (yesterday === 0) return `\`↑ +${today} new\``
  const delta = today - yesterday
  if (delta > 0) return `\`↑ +${delta}\``
  if (delta < 0) return `\`↓ ${delta}\``
  return '`→ same`'
}

/** One-line summary: what was better/worse today vs yesterday */
function buildCommentary(today: DailyStats, yesterday: DailyStats): string {
  const wins: string[] = []
  const losses: string[] = []

  if (today.found > yesterday.found)     wins.push(`found more leads (${today.found} vs ${yesterday.found})`)
  if (today.found < yesterday.found)     losses.push(`found fewer leads (${today.found} vs ${yesterday.found})`)
  if (today.approved > yesterday.approved) wins.push(`more approved`)
  if (today.approved < yesterday.approved) losses.push(`fewer approved`)
  if (today.responded > yesterday.responded) wins.push(`more replies came in`)
  if (today.responded < yesterday.responded) losses.push(`fewer replies`)
  if (today.converted > yesterday.converted) wins.push(`converted a client 🎉`)
  if (today.hotLeads > yesterday.hotLeads)   wins.push(`more hot leads`)
  if (today.hotLeads < yesterday.hotLeads)   losses.push(`fewer hot leads`)

  if (wins.length === 0 && losses.length === 0) return `📊 Pretty even day compared to yesterday.`

  const parts: string[] = []
  if (wins.length > 0)   parts.push(`✅ Better: ${wins.join(', ')}.`)
  if (losses.length > 0) parts.push(`⚠️ Worse: ${losses.join(', ')}.`)
  return parts.join('  ')
}

export function formatDailyReport(
  today: DailyStats,
  yesterday: DailyStats,
  date: Date
): { title: string; description: string; color: number } {

  const dateStr = date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'Asia/Colombo'
  })

  // Funnel row: emoji | label | today count | bar | vs yesterday
  const row = (emoji: string, label: string, todayVal: number, yestVal: number) => {
    const bar = todayVal > 0 ? '`' + '█'.repeat(Math.min(todayVal, 10)) + '`' : '`—`'
    return `${emoji} **${label}** **${todayVal}** ${bar}  ${diff(todayVal, yestVal)}`
  }

  const lines: string[] = [
    `## 📅 ${dateStr}`,
    `*vs yesterday in brackets*`,
    '',
    row('🔍', 'Found    ', today.found,     yesterday.found),
    row('✅', 'Approved ', today.approved,  yesterday.approved),
    row('📤', 'Contacted', today.contacted, yesterday.contacted),
    row('💬', 'Responded', today.responded, yesterday.responded),
    row('🏆', 'Converted', today.converted, yesterday.converted),
  ]

  if (today.hotLeads > 0) {
    lines.push('')
    lines.push(`🔥 **${today.hotLeads} hot lead${today.hotLeads > 1 ? 's' : ''}** found today (80+)${today.hotLeads > yesterday.hotLeads ? ' — more than yesterday!' : ''}`)
  }

  if (today.topLead) {
    lines.push('')
    lines.push(`**⭐ Best lead today**`)
    lines.push(`${today.topLead.name} · ${today.topLead.niche} in ${today.topLead.location} · **${today.topLead.score}/100**`)
  }

  // Yesterday's best for comparison
  if (yesterday.topLead && yesterday.topLead.score !== today.topLead?.score) {
    lines.push(`*Yesterday's best: ${yesterday.topLead.name} · ${yesterday.topLead.score}/100*`)
  }

  lines.push('')
  lines.push(`─────────────────`)
  lines.push(buildCommentary(today, yesterday))
  lines.push('')
  lines.push(`📊 All time: **${today.allTimeTotal}** leads · **${today.allTimeConverted}** converted`)

  // Color based on how today went
  let color = 0x5865F2
  if (today.found === 0) color = 0x4f545c
  else if (today.converted > 0) color = 0x57F287
  else if (today.responded > 0) color = 0xFEE75C
  else if (today.hotLeads > 0) color = 0xEB459E
  else if (today.found > yesterday.found) color = 0x57F287      // better than yesterday
  else if (today.found < yesterday.found) color = 0xED4245      // worse than yesterday

  return { title: `📈 Daily Pipeline Report`, description: lines.join('\n'), color }
}
