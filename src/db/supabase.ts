import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config()

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

export type LeadStatus = 'found' | 'approved' | 'rejected' | 'emailed' | 'responded' | 'converted'

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
  status: LeadStatus
  discord_message_id?: string
  created_at?: string
}

export async function saveLead(lead: Lead): Promise<Lead> {
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
