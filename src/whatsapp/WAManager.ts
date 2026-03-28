import { Client as WAClient, LocalAuth, MessageMedia } from 'whatsapp-web.js'
// @ts-ignore
import qrcode from 'qrcode-terminal'
import { Client as DiscordClient } from 'discord.js'
import { TEAM, TeamMember } from '../config/team'

// One WhatsApp client per team member
const sessions: Map<string, WAClient> = new Map()
const ready: Map<string, boolean> = new Map()

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
    qrcode.generate(qr, { small: true })

    try {
      // DM the QR code to the team member
      const user = await discordClient.users.fetch(member.discordId)
      await user.send(
        `**Ardeno OS — WhatsApp Setup for ${member.name}**\n\n` +
        `Scan this QR code with **your** WhatsApp to connect your account:\n\n` +
        `\`\`\`${qr}\`\`\`\n\n` +
        `Or go to **WhatsApp → Linked Devices → Link a Device** and scan.\n` +
        `You only need to do this once.`
      )
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
