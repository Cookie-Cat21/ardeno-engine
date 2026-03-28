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

  // Register this phone so we watch for their reply
  markPhoneSent(formatted)
}

function formatPhone(phone: string): string {
  return normalizePhone(phone)
}

function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D/g, '')
  // Sri Lanka: 0XX → 94XX
  if (digits.startsWith('0')) digits = '94' + digits.slice(1)
  // No country code + 9 digits → assume Sri Lanka
  if (!digits.startsWith('94') && digits.length === 9) digits = '94' + digits
  return digits
}

export async function draftWhatsAppMessage(lead: any, member: TeamMember): Promise<string> {
  const Groq = (await import('groq-sdk')).default
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! })

  const hasWebsite  = !!lead.website
  const noWebsite   = !hasWebsite
  const rating      = lead.google_rating
  const gap         = lead.gap_analysis ?? ''
  const pitch       = lead.pitch_angle  ?? ''

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{
      role: 'user',
      content: `You are ${member.name} from Ardeno Studio, a web design agency in Sri Lanka. Write a WhatsApp cold outreach message to this business.

Business: ${lead.business_name}
Niche: ${lead.niche}
Location: ${lead.location}
Has website: ${hasWebsite ? `Yes — ${lead.website}` : 'No website found'}
Google rating: ${rating ? `${rating}/5` : 'Unknown'}
Their main gap: ${gap}
Our angle: ${pitch}

TONE: Sound like a real person texting, NOT a sales bot. Curious and helpful, not pitchy.

STRUCTURE (follow this exactly):
1. One specific observation about THEIR business (not generic flattery) — reference their actual situation e.g. no website, or something about their niche
2. One sentence that hints at the opportunity without being salesy
3. A soft question that's easy to reply yes/no to

STRICT RULES:
- Max 3 sentences total
- NO words like: "partnership", "revenue", "customers", "boost", "grow", "solutions", "services"
- NO "I noticed you don't have a website" (too blunt) — be subtle
- DO NOT say "Ardeno Studio can help" — just ask the question
- Sign off with just "— ${member.name}, Ardeno" on a new line
- Use 1 emoji max, naturally placed
- Sound like ${member.name} is a 23 year old Sri Lankan guy texting from his phone

GOOD EXAMPLE (restaurant with no website):
"Hey! Tried to find ${lead.business_name} online to check the menu before visiting — couldn't find much 😅 Are you guys planning to get a proper site up anytime?
— ${member.name}, Ardeno"

BAD EXAMPLE (do NOT do this):
"Hey, loved your 4.4 rating! By partnering with us you could attract more customers. Can we chat about how Ardeno Studio can help you grow?"

Return ONLY the message, nothing else.`
    }],
    temperature: 0.85,
    max_tokens: 220
  })

  return completion.choices[0]?.message?.content?.trim() ??
    `Hi! I noticed ${lead.business_name} and love what you're doing in ${lead.location}. We help businesses like yours get a stronger online presence — would you be open to a quick chat? 😊\n\n— ${member.name}, Ardeno Studio`
}
