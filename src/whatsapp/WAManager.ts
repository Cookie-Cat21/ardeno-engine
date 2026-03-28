import { Client as WAClient, LocalAuth, MessageMedia } from 'whatsapp-web.js'
import QRCode from 'qrcode'
import { AttachmentBuilder } from 'discord.js'
import { Client as DiscordClient } from 'discord.js'
import { TEAM, TeamMember } from '../config/team'

// One WhatsApp client per team member
const sessions: Map<string, WAClient> = new Map()
const ready: Map<string, boolean> = new Map()

// Track phones we've actually sent outreach to — only notify for replies from these
const outreachedPhones = new Set<string>()

// Deduplicate message IDs — prevent same message firing twice
const processedMsgIds = new Set<string>()

// Ignore any message received before this timestamp (startup replays)
const BOT_START_MS = Date.now()

// Reply handler — registered from index.ts after bot is ready
export type WAReplyHandler = (params: {
  discordId: string   // which founder's WhatsApp received the reply
  senderPhone: string // normalized phone (digits only, e.g. 94771234567)
  body: string        // message text
  timestamp: Date
}) => Promise<void>

let _replyHandler: WAReplyHandler | null = null

export function onWhatsAppReply(handler: WAReplyHandler): void {
  _replyHandler = handler
}

/**
 * Call this whenever we send a WhatsApp outreach to a lead.
 * Only numbers registered here will trigger reply notifications.
 */
export function markPhoneSent(phone: string): void {
  const normalized = normalizePhone(phone)
  outreachedPhones.add(normalized)
  console.log(`[WhatsApp] 📋 Tracking replies from: ${normalized}`)
}

export async function initWhatsApp(discordClient: DiscordClient): Promise<void> {
  for (const member of Object.values(TEAM)) {
    await initSession(member, discordClient)
  }
}

async function initSession(member: TeamMember, discordClient: DiscordClient): Promise<void> {
  const wa = new WAClient({
    authStrategy: new LocalAuth({ clientId: member.discordId }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  })

  wa.on('qr', async (qr) => {
    console.log(`[WhatsApp] QR for ${member.name} — sending via Discord DM`)

    try {
      // Generate QR code as PNG image buffer
      const qrBuffer = await QRCode.toBuffer(qr, { width: 400, margin: 2 })
      const attachment = new AttachmentBuilder(qrBuffer, { name: 'whatsapp-qr.png' })

      const user = await discordClient.users.fetch(member.discordId)
      await user.send({
        content: `**Ardeno OS — WhatsApp Setup for ${member.name}**\n\nScan this QR code with **your** WhatsApp:\n> WhatsApp → Linked Devices → Link a Device\n\nYou only need to do this once.`,
        files: [attachment]
      })
    } catch (e) {
      console.error(`[WhatsApp] Could not DM ${member.name}:`, e)
    }
  })

  wa.on('ready', async () => {
    ready.set(member.discordId, true)
    console.log(`[WhatsApp] ✅ ${member.name}'s WhatsApp connected`)

    try {
      const user = await discordClient.users.fetch(member.discordId)
      await user.send(`✅ **WhatsApp connected!** Ardeno OS can now send messages from your number.`)
    } catch {}
  })

  wa.on('disconnected', (reason) => {
    ready.set(member.discordId, false)
    console.log(`[WhatsApp] ❌ ${member.name} disconnected: ${reason}`)
  })

  wa.on('auth_failure', (msg) => {
    ready.set(member.discordId, false)
    console.error(`[WhatsApp] Auth failed for ${member.name}:`, msg)
  })

  // Listen for incoming messages — only notify for leads we've reached out to
  wa.on('message', async (msg) => {
    try {
      // ── Basic filters ───────────────────────────────────────────────────
      if (msg.fromMe) return                    // our own messages
      if (msg.from.includes('@g.us')) return    // group chats
      if (!_replyHandler) return

      // ── Startup replay guard ────────────────────────────────────────────
      // whatsapp-web.js replays recent messages on init — skip anything
      // that arrived before this bot session started
      const msgTimeMs = (msg.timestamp ?? 0) * 1000
      if (msgTimeMs < BOT_START_MS) return

      // ── Deduplication ───────────────────────────────────────────────────
      const msgId = (msg.id as any)?._serialized ?? msg.id
      if (msgId && processedMsgIds.has(msgId)) return
      if (msgId) processedMsgIds.add(msgId)

      // ── Outreach filter — only notify for numbers we messaged ───────────
      const senderPhone = msg.from.replace('@c.us', '')
      const normalized  = normalizePhone(senderPhone)

      if (!outreachedPhones.has(normalized)) {
        // Not a lead we contacted — silently ignore
        console.log(`[WhatsApp] 📩 Ignored message from ${normalized} (not in outreach list)`)
        return
      }

      const body = msg.hasMedia ? `📎 [Sent a ${msg.type}]` : (msg.body || '').trim()
      if (!body) return

      console.log(`[WhatsApp] 🎉 Lead reply from ${normalized} on ${member.name}'s account`)

      await _replyHandler({
        discordId:   member.discordId,
        senderPhone: normalized,
        body,
        timestamp:   new Date(msgTimeMs)
      })
    } catch (err: any) {
      console.error(`[WhatsApp] Reply handler error:`, err?.message)
    }
  })

  sessions.set(member.discordId, wa)
  ready.set(member.discordId, false)

  await wa.initialize()
}

export function isReady(discordId: string): boolean {
  return ready.get(discordId) === true
}

export async function sendWhatsAppMessage(
  discordId: string,
  phone: string,
  message: string
): Promise<void> {
  const wa = sessions.get(discordId)
  if (!wa) throw new Error(`No WhatsApp session for this user`)
  if (!isReady(discordId)) throw new Error(`WhatsApp not connected yet — scan the QR code first`)

  // Format phone number — strip spaces, dashes, add country code
  const formatted = formatPhone(phone)
  const chatId = `${formatted}@c.us`

  await wa.sendMessage(chatId, message)
}

function formatPhone(phone: string): string {
  // Remove all non-digits
  let digits = phone.replace(/\D/g, '')

  // Sri Lanka: if starts with 0, replace with 94
  if (digits.startsWith('0')) {
    digits = '94' + digits.slice(1)
  }

  // If no country code, assume Sri Lanka
  if (!digits.startsWith('94') && digits.length === 9) {
    digits = '94' + digits
  }

  return digits
}

export async function draftWhatsAppMessage(lead: any, member: TeamMember): Promise<string> {
  const Groq = (await import('groq-sdk')).default
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! })

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{
      role: 'user',
      content: `Write a SHORT WhatsApp message for ${member.name} from Ardeno Studio to send to this business:

Business: ${lead.business_name}
Location: ${lead.location}
Niche: ${lead.niche}
Has website: ${lead.website ? 'Yes' : 'No'}
Google rating: ${lead.google_rating ?? 'Unknown'}
Pitch: ${lead.pitch_angle}

Rules:
- Max 3 sentences
- Casual and friendly — WhatsApp is informal
- Mention one specific thing about their business
- End with a simple question to get a reply
- Sign off as "${member.name} from Ardeno Studio"
- Do NOT use formal email language
- No subject line needed

Return ONLY the message text, nothing else.`
    }],
    temperature: 0.8,
    max_tokens: 200
  })

  return completion.choices[0]?.message?.content?.trim() ??
    `Hi! I noticed ${lead.business_name} and love what you're doing in ${lead.location}. We help businesses like yours get a stronger online presence — would you be open to a quick chat? 😊\n\n— ${member.name}, Ardeno Studio`
}
