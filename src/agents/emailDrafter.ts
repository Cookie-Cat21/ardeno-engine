import Groq from 'groq-sdk'
import nodemailer from 'nodemailer'
import type { Lead } from '../db/supabase'
import type { TeamMember } from '../config/team'

// Lazy init — avoids crashing at import time if env vars aren't set yet
let _groq: Groq | null = null
const getGroq = () => _groq ??= new Groq({ apiKey: process.env.GROQ_API_KEY })

let _transporter: nodemailer.Transporter | null = null
const getTransporter = () => _transporter ??= nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
})

export interface EmailDraft {
  subject: string
  body: string
  to: string
}

export async function draftOutreachEmail(lead: Lead, approver?: TeamMember | null): Promise<EmailDraft> {
  const sender = approver ?? { name: 'Ovindu', whatsapp: '+94 76 248 5456', role: 'Co-founder, Ardeno Studio' }

  const prompt = `You are a friendly, professional outreach specialist for Ardeno Studio, a web design agency.

Write a SHORT, personalised cold email to this business on behalf of ${sender.name}:

Business: ${lead.business_name}
Location: ${lead.location}
Niche: ${lead.niche}
Has website: ${lead.website ? 'Yes — ' + lead.website : 'No'}
Google rating: ${lead.google_rating ?? 'Unknown'}
Gap analysis: ${lead.gap_analysis}
Pitch angle: ${lead.pitch_angle}

Sender details:
- Name: ${sender.name}
- Role: ${sender.role}
- WhatsApp: ${sender.whatsapp}

Rules:
- Keep it under 130 words
- Sound human, warm and direct — not salesy
- Mention something specific about their business (rating, location, niche)
- Call to action: invite them to reply or WhatsApp ${sender.name} at ${sender.whatsapp}
- Sign off as "${sender.name}\nArdeno Studio"
- Do NOT use generic phrases like "hope this email finds you well"
- Do NOT mention you found them on Google Maps

Return ONLY a JSON object with exactly these fields:
{
  "subject": "email subject line",
  "body": "full email body with line breaks using \\n"
}`

  const completion = await getGroq().chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 500
  })

  const raw = completion.choices[0]?.message?.content ?? ''

  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON found')
    const parsed = JSON.parse(match[0])
    return {
      subject: parsed.subject,
      body: parsed.body,
      to: lead.email ?? ''
    }
  } catch {
    return {
      subject: `Quick question about ${lead.business_name}'s online presence`,
      body: `Hi,\n\nI came across ${lead.business_name} and was impressed by what you're doing in ${lead.location}.\n\n${lead.pitch_angle}\n\nWould you be open to a quick 10-minute call this week?\n\nBest,\nOvindu\nArdeno Studio`,
      to: lead.email ?? ''
    }
  }
}

export async function sendEmail(draft: EmailDraft): Promise<void> {
  await getTransporter().sendMail({
    from: `"Ardeno Studio" <${process.env.GMAIL_USER}>`,
    to: draft.to,
    subject: draft.subject,
    text: draft.body
  })
}
