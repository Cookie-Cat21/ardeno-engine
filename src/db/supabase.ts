import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

export type LeadStatus = 'found' | 'approved' | 'rejected' | 'contacted' | 'emailed' | 'responded' | 'converted'

export interface LighthouseScores {
  performance: number
  accessibility: number
  bestPractices: number
  seo: number
}

export interface Lead {
  id?: string
  business_name: string
  niche: string
  location: string
  email?: string
  phone?: string
  website?: string
  google_maps_url?: string
  google_rating?: number
  review_count?: number
  instagram?: string
  facebook?: string
  score: number
  score_reasons: string[]
  gap_analysis: string
  pitch_angle: string
  lighthouse_scores?: LighthouseScores | null
  status: LeadStatus
  discord_message_id?: string
  created_at?: string
}

/**
 * Find a lead by phone number. Handles format differences:
 * WhatsApp sends 94771234567, stored as "077 123 4567" or "0771234567" etc.
 * We strip everything to the last 9 digits and match loosely.
 */
export async function findLeadByPhone(waPhone: string): Promise<Lead | null> {
  // waPhone is like "94771234567" — get last 9 digits (core number without country code)
  const digits = waPhone.replace(/\D/g, '')
  const core = digits.length >= 9 ? digits.slice(-9) : digits  // e.g. "771234567"

  const { data } = await supabase
    .from('leads')
    .select('*')
    .ilike('phone', `%${core}%`)
    .not('discord_message_id', 'is', null)  // only leads with a Discord thread
    .order('created_at', { ascending: false })
    .limit(1)

  return data?.[0] ?? null
}

// ─── Competitor thread tracking ────────────────────────────────────────────────

export async function getCompetitorThread(name: string): Promise<string | null> {
  const { data } = await supabase
    .from('competitor_threads')
    .select('thread_id')
    .eq('name', name)
    .single()
  return data?.thread_id ?? null
}

export async function upsertCompetitorThread(name: string, url: string, threadId: string): Promise<void> {
  await supabase
    .from('competitor_threads')
    .upsert({ name, url, thread_id: threadId, last_run_at: new Date().toISOString() }, { onConflict: 'name' })
}

export interface CompetitorSnapshot {
  thread_id:          string | null
  ig_username:        string | null
  ig_post_count:      number | null
  site_snapshot:      string | null
  portfolio_snapshot: string | null
}

export async function getCompetitorSnapshot(name: string): Promise<CompetitorSnapshot> {
  const { data } = await supabase
    .from('competitor_threads')
    .select('thread_id, ig_username, ig_post_count, site_snapshot, portfolio_snapshot')
    .eq('name', name)
    .single()
  return {
    thread_id:          data?.thread_id          ?? null,
    ig_username:        data?.ig_username        ?? null,
    ig_post_count:      data?.ig_post_count      ?? null,
    site_snapshot:      data?.site_snapshot      ?? null,
    portfolio_snapshot: data?.portfolio_snapshot ?? null,
  }
}

export async function updateCompetitorSnapshot(name: string, data: Partial<{
  ig_username:        string
  ig_post_count:      number
  site_snapshot:      string
  portfolio_snapshot: string
}>): Promise<void> {
  await supabase
    .from('competitor_threads')
    .update({ ...data, last_run_at: new Date().toISOString() })
    .eq('name', name)
}

// ─── Lead helpers ──────────────────────────────────────────────────────────────

export async function isDuplicate(businessName: string, location: string): Promise<boolean> {
  const { data } = await supabase
    .from('leads')
    .select('id')
    .ilike('business_name', businessName.trim())
    .ilike('location', `%${location.trim()}%`)
    .limit(1)

  return (data?.length ?? 0) > 0
}

export async function saveLead(lead: Lead): Promise<Lead> {
  // De-duplicate before saving
  const dupe = await isDuplicate(lead.business_name, lead.location)
  if (dupe) throw new Error(`DUPLICATE: ${lead.business_name} already exists`)

  const { data, error } = await supabase
    .from('leads')
    .insert(lead)
    .select()
    .single()

  if (error) throw new Error(`Failed to save lead: ${error.message}`)
  return data
}

export async function updateLeadStatus(id: string, status: LeadStatus, messageId?: string) {
  const update: Partial<Lead> = { status }
  if (messageId) update.discord_message_id = messageId

  const { error } = await supabase
    .from('leads')
    .update(update)
    .eq('id', id)

  if (error) throw new Error(`Failed to update lead: ${error.message}`)
}

export async function getLeadByMessageId(messageId: string): Promise<Lead | null> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('discord_message_id', messageId)
    .single()

  if (error) return null
  return data
}

export async function getLeadById(id: string): Promise<Lead | null> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', id)
    .single()

  if (error) return null
  return data
}
