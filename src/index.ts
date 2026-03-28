import {
  Client,
  GatewayIntentBits,
  Events,
  Message,
  EmbedBuilder,
  Colors,
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextChannel,
  ForumChannel,
  ChannelType,
  AttachmentBuilder
} from 'discord.js'
import dotenv from 'dotenv'
import cron from 'node-cron'
import { think } from './bot/brain'
import { getConversation, updateConversation } from './bot/conversation'
import { runLeadEngine } from './agents/leadRunner'
import { updateLeadStatus, findLeadByPhone, supabase } from './db/supabase'
import { handleApproval } from './bot/handlers/approval'
import { draftOutreachEmail } from './agents/emailDrafter'
import { ensureForumTags, getTagIds, getNicheTagName } from './bot/forumTags'
import { TEAM } from './config/team'
import { initWhatsApp, onWhatsAppReply } from './whatsapp/WAManager'
import { getTodaysTargets, getTodaysNiches } from './scheduler/dailyHunt'
import { getDailyStats, formatDailyReport } from './scheduler/dailyReport'
import { lighthouseBlock, lighthouseSummary } from './agents/lighthouse'
import { analyzeWebsite, formatAuditEmbed } from './agents/websiteAnalyzer'

dotenv.config()

const PREFIX = 'ao'
const HOT_LEAD_SCORE = 80 // Ping founders when a lead hits this score

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

client.once(Events.ClientReady, async (c) => {
  console.log(`\n🚀 Ardeno OS online as ${c.user.tag}`)
  c.user.setActivity('ao help', { type: ActivityType.Listening })

  // Init WhatsApp sessions for all team members
  initWhatsApp(c).catch(console.error)

  // Handle incoming WhatsApp replies from leads
  onWhatsAppReply(async ({ discordId, senderPhone, body, timestamp }) => {
    try {
      const lead = await findLeadByPhone(senderPhone)
      if (!lead) return // not a lead we know about

      console.log(`[WhatsApp] 🎉 Reply from lead: ${lead.business_name} — "${body.slice(0, 60)}"`)

      // Update lead status
      await updateLeadStatus(lead.id!, 'responded')

      // Post in the lead's Discord forum thread
      if (lead.discord_message_id) {
        const thread = await c.channels.fetch(lead.discord_message_id).catch(() => null)
        if (thread && thread.isThread()) {
          await thread.send({
            content: `<@${discordId}> 🎉 **${lead.business_name} just replied on WhatsApp!**`,
            embeds: [new EmbedBuilder()
              .setColor(0x25D366)
              .setTitle('📱 WhatsApp Reply Received')
              .setDescription(`*"${body}"*`)
              .addFields({ name: '📍 Business', value: lead.business_name, inline: true })
              .setTimestamp(timestamp)
              .setFooter({ text: `Received on ${TEAM[discordId]?.name ?? 'your'} WhatsApp` })
            ]
          })
        }
      }

      // Also DM the founder directly so they never miss it
      try {
        const founder = await c.users.fetch(discordId)
        await founder.send(`📱 **${lead.business_name}** replied on WhatsApp:\n\n*"${body}"*\n\nCheck the lead thread to respond.`)
      } catch {}

    } catch (err: any) {
      console.error(`[WhatsApp] Error handling reply:`, err?.message)
    }
  })

  // Auto-create forum tags
  const forumId = process.env.DISCORD_LEADS_FORUM_ID
  if (forumId) {
    const forum = await c.channels.fetch(forumId).catch(() => null) as ForumChannel | null
    if (forum?.type === ChannelType.GuildForum) {
      await ensureForumTags(forum).catch(console.error)
    }
  }

  // Daily cron: 8am Sri Lanka time (UTC+5:30 = 2:30 UTC) — automated lead hunt
  cron.schedule('30 2 * * *', async () => {
    const targets = getTodaysTargets()
    const niches = getTodaysNiches()

    if (targets.length === 0) {
      console.log('[Cron] Sunday — rest day, no lead hunt')
      return
    }

    console.log(`[Cron] 🌅 Daily hunt starting — ${niches.join(' + ')} across ${targets.length / niches.length} locations`)

    const forumId = process.env.DISCORD_LEADS_FORUM_ID
    const forum = forumId ? await client.channels.fetch(forumId).catch(() => null) : null
    const generalId = process.env.DISCORD_APPROVAL_CHANNEL_ID
    const general = generalId ? await client.channels.fetch(generalId).catch(() => null) as TextChannel | null : null

    // Announce the hunt starting
    await general?.send({
      embeds: [new EmbedBuilder()
        .setColor(0xff4d30)
        .setTitle('🌅 Daily Lead Hunt Starting')
        .setDescription(`Searching for **${niches.join(' + ')}** across **${targets.length / niches.length} locations**.\nNew leads will appear in <#${forumId}> as they're found.`)
        .setFooter({ text: `Ardeno OS — Automated Hunt` })
      ]
    })

    let totalFound = 0
    let totalSaved = 0

    for (const { niche, location } of targets) {
      try {
        const result = await runLeadEngine(niche, location, 10)
        totalFound += result.found
        totalSaved += result.saved.length

        // Post leads to forum
        for (const [leadIdx, lead] of result.saved.slice(0, 10).entries()) {
          const scoreColor = lead.score >= 70 ? Colors.Green : lead.score >= 45 ? Colors.Yellow : Colors.Orange
          const scoreEmoji = lead.score >= 70 ? '🟢' : lead.score >= 45 ? '🟡' : '🟠'

          const lhField = lead.lighthouse_scores
            ? [{ name: '🏎️ Lighthouse (mobile)', value: lighthouseBlock(lead.lighthouse_scores) }]
            : []

          const embed = new EmbedBuilder()
            .setColor(scoreColor)
            .setTitle(lead.business_name)
            .setURL(lead.google_maps_url ?? '')
            .addFields(
              { name: '📍 Location', value: lead.location, inline: true },
              { name: '🏷️ Niche', value: lead.niche, inline: true },
              { name: '⭐ Score', value: `**${lead.score}/100**`, inline: true },
              { name: '📞 Phone', value: lead.phone ?? 'Not found', inline: true },
              { name: '📧 Email', value: (lead as any).email ?? 'Not found', inline: true },
              { name: '🌐 Website', value: lead.website ?? '❌ No website', inline: true },
              ...((() => {
                const links: string[] = []
                if (lead.instagram) links.push(`[Instagram](${lead.instagram})`)
                if (lead.facebook)  links.push(`[Facebook](${lead.facebook})`)
                return links.length > 0 ? [{ name: '📱 Socials', value: links.join(' · '), inline: true }] : []
              })()),
              ...lhField,
              { name: '🔍 Why this lead', value: lead.score_reasons.map((r: string) => `• ${r}`).join('\n') || 'No reasons' },
              { name: '📉 Their gaps', value: lead.gap_analysis },
              { name: '💬 Pitch angle', value: `*"${lead.pitch_angle}"*` }
            )
            .setFooter({ text: `Lead ID: ${lead.id} · Auto-found by Ardeno OS` })

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`approve_lead:${lead.id}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`reject_lead:${lead.id}`).setLabel('❌ Reject').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`later_lead:${lead.id}`).setLabel('⏳ Later').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`delete_lead:${lead.id}`).setLabel('🗑️ Delete').setStyle(ButtonStyle.Danger)
          )

          if (forum && forum.type === ChannelType.GuildForum) {
            const tagNames = [getNicheTagName(lead.niche)]
            const isHot = lead.score >= HOT_LEAD_SCORE
            if (isHot) tagNames.push('Hot Lead')
            const tagIds = getTagIds(forum as ForumChannel, ...tagNames)
            const thread = await (forum as ForumChannel).threads.create({
              name: `${scoreEmoji} ${lead.business_name} — ${lead.location}`,
              appliedTags: tagIds,
              message: { embeds: [embed], components: [row] }
            })
            await updateLeadStatus(lead.id!, 'found', thread.id)

            // Website audit — staggered 8s apart so Gemini Vision rate limit isn't hit
            if (lead.website) runWebsiteAudit(lead.website, lead.lighthouse_scores, thread, leadIdx * 8000)

            // 🔥 Hot lead ping — score >= 80 means this one's worth dropping everything for
            if (isHot) {
              const hotMentions = Object.values(TEAM).map(m => `<@${m.discordId}>`).join(' ')
              await general?.send({
                content: `${hotMentions} 🔥 **Hot lead just dropped — ${lead.score}/100!**`,
                embeds: [new EmbedBuilder()
                  .setColor(0xff4d30)
                  .setTitle(`🔥 ${lead.business_name}`)
                  .setDescription(`*"${lead.pitch_angle}"*\n\n→ [Open in #leads](${thread.url})`)
                  .addFields(
                    { name: '📍 Location', value: lead.location, inline: true },
                    { name: '🏷️ Niche', value: lead.niche, inline: true },
                    { name: '⭐ Score', value: `**${lead.score}/100**`, inline: true },
                    ...(lead.lighthouse_scores ? [{ name: '🏎️ Lighthouse', value: lighthouseSummary(lead.lighthouse_scores) }] : [])
                  )
                ]
              })
            }
          }
        }
      } catch (e: any) {
        console.error(`[Cron] Error for ${niche} in ${location}:`, e.message)
      }
    }

    // Summary ping
    const mentions = Object.values(TEAM).map(m => `<@${m.discordId}>`).join(' ')
    await general?.send({
      content: mentions,
      embeds: [new EmbedBuilder()
        .setColor(0xff4d30)
        .setTitle('✅ Daily Hunt Complete')
        .addFields(
          { name: '🔍 Scanned', value: `${totalFound} businesses`, inline: true },
          { name: '📋 New Leads', value: `${totalSaved} posted to forum`, inline: true },
          { name: '📅 Niches', value: niches.join(' + '), inline: true }
        )
        .setFooter({ text: 'Check #leads to review and approve' })
      ]
    })
  })

  // 9am Sri Lanka time (UTC+5:30 = 3:30 UTC) — snoozed lead reminders
  cron.schedule('30 3 * * *', async () => {
    console.log('[Cron] Checking for snoozed leads...')
    const now = new Date().toISOString()

    const { data: snoozed } = await supabase
      .from('leads')
      .select('*')
      .eq('status', 'found')
      .lte('remind_at', now)
      .not('remind_at', 'is', null)

    if (!snoozed?.length) return

    const generalChannelId = process.env.DISCORD_APPROVAL_CHANNEL_ID
    const channel = generalChannelId
      ? await c.channels.fetch(generalChannelId).catch(() => null) as TextChannel | null
      : null

    if (!channel) return

    for (const lead of snoozed) {
      // Ping both founders
      const mentions = Object.values(TEAM).map(m => `<@${m.discordId}>`).join(' ')
      await channel.send({
        content: mentions,
        embeds: [new EmbedBuilder()
          .setColor(0xff4d30)
          .setTitle('⏰ Snoozed Lead Reminder')
          .setDescription(`**${lead.business_name}** (${lead.niche} · ${lead.location}) has been sitting on Later for 3 days.\n\nScore: **${lead.score}/100** — time to action it!`)
          .setFooter({ text: 'Find it in the #leads forum to approve or reject' })
        ]
      })

      // Clear the reminder so it doesn't ping again
      await supabase.from('leads').update({ remind_at: null }).eq('id', lead.id)
    }
  })

  // 6pm Sri Lanka time (UTC+5:30 = 12:30 UTC) — daily pipeline report
  cron.schedule('30 12 * * *', async () => {
    console.log('[Cron] Generating daily pipeline report...')
    const generalChannelId = process.env.DISCORD_APPROVAL_CHANNEL_ID
    const channel = generalChannelId
      ? await c.channels.fetch(generalChannelId).catch(() => null) as TextChannel | null
      : null
    if (!channel) return

    try {
      const stats = await getDailyStats()
      const { title, description, color } = formatDailyReport(stats, new Date())
      const mentions = Object.values(TEAM).map(m => `<@${m.discordId}>`).join(' ')

      await channel.send({
        content: stats.found > 0 || stats.responded > 0 ? mentions : undefined,
        embeds: [new EmbedBuilder()
          .setColor(color)
          .setTitle(title)
          .setDescription(description)
          .setTimestamp()
        ]
      })
    } catch (err: any) {
      console.error('[Cron] Daily report failed:', err?.message)
    }
  })
})

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return

  const content = message.content.trim()
  const botMentioned = message.mentions.has(client.user!)
  const hasPrefix = content.toLowerCase().startsWith(PREFIX + ' ') || content.toLowerCase() === PREFIX

  if (!hasPrefix && !botMentioned) return

  // Strip prefix or mention to get the actual message
  let userText = content
  if (botMentioned) {
    userText = content.replace(/<@!?\d+>/g, '').trim()
  } else {
    userText = content.slice(PREFIX.length).trim()
  }

  if (!userText || userText.toLowerCase() === 'help') {
    await message.reply(buildHelpEmbed())
    return
  }

  // Get conversation state for this user/channel
  const state = getConversation(message.author.id, message.channelId)

  // Add user message to history
  updateConversation(message.author.id, message.channelId, {
    history: [...state.history, { role: 'user', content: userText }]
  })

  // Show typing indicator
  if ('sendTyping' in message.channel) await message.channel.sendTyping()

  // Shortcut: ao stats
  if (/\bstats?\b/i.test(userText) || /how (are we doing|many leads)/i.test(userText)) {
    const [total, approved, contacted, rejected, thisWeek] = await Promise.all([
      supabase.from('leads').select('id', { count: 'exact', head: true }),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'contacted'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
      supabase.from('leads').select('id', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
    ])

    const t = total.count ?? 0
    const a = approved.count ?? 0
    const c = contacted.count ?? 0
    const r = rejected.count ?? 0
    const w = thisWeek.count ?? 0
    const convRate = t > 0 ? Math.round((c / t) * 100) : 0

    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xff4d30)
        .setTitle('📊 Ardeno OS Stats')
        .addFields(
          { name: '🔍 Total Leads', value: `${t}`, inline: true },
          { name: '📅 This Week', value: `${w}`, inline: true },
          { name: '✅ Approved', value: `${a}`, inline: true },
          { name: '📤 Contacted', value: `${c}`, inline: true },
          { name: '❌ Rejected', value: `${r}`, inline: true },
          { name: '📈 Contact Rate', value: `${convRate}%`, inline: true }
        )
        .setFooter({ text: 'Ardeno OS — Lead Engine' })
      ]
    })
    return
  }

  // Shortcut: ao test email / ao test whatsapp
  if (/\btest\b.*(email|mail|whatsapp|wa|whats)/i.test(userText)) {
    const isEmail = /email|mail/i.test(userText)
    const isWA = /whatsapp|wa|whats/i.test(userText)
    const member = Object.values(TEAM).find(m => m.discordId === message.author.id)

    if (isEmail) {
      const statusMsg = await message.reply('📧 Sending test email...')
      try {
        const { sendEmail } = await import('./agents/emailDrafter')
        await sendEmail({
          subject: '✅ Ardeno OS — Email Test',
          body: `Hi ${member?.name ?? 'there'},\n\nThis is a test email from Ardeno OS to confirm your email outreach is working correctly.\n\nAll good! 🚀\n\n— Ardeno OS`,
          to: process.env.GMAIL_USER!
        })
        await statusMsg.edit('✅ **Email working!** Check ardenostudio@gmail.com for the test email.')
      } catch (e: any) {
        await statusMsg.edit(`❌ **Email failed:** ${e.message}`)
      }
    }

    if (isWA) {
      const statusMsg = await message.reply('📱 Testing WhatsApp...')
      const { sendWhatsAppMessage, isReady } = await import('./whatsapp/WAManager')

      if (!member) {
        await statusMsg.edit('❌ Your Discord account is not in the team config.')
        return
      }

      if (!isReady(member.discordId)) {
        await statusMsg.edit('❌ **WhatsApp not connected.** Check your DMs for the QR code to scan.')
        return
      }

      try {
        await sendWhatsAppMessage(
          member.discordId,
          member.whatsapp,
          `✅ Ardeno OS WhatsApp test — ${member.name}'s connection is working! 🚀`
        )
        await statusMsg.edit(`✅ **WhatsApp working!** Check ${member.name}'s WhatsApp for the test message.`)
      } catch (e: any) {
        await statusMsg.edit(`❌ **WhatsApp failed:** ${e.message}`)
      }
    }

    return
  }

  // Shortcut: ao clear leads
  if (/\bclear\b.*(lead|all)/i.test(userText) || /\bdelete\b.*(lead|all)/i.test(userText)) {
    const { count } = await supabase.from('leads').select('id', { count: 'exact', head: true })
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('confirm_clear_leads').setLabel(`🗑️ Yes, delete all ${count} leads`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('cancel_clear_leads').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    )
    await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle('⚠️ Clear All Leads?')
        .setDescription(`This will permanently delete **${count} leads** from the database **and** remove all threads from the #leads forum.\n\nAre you sure?`)
      ],
      components: [row]
    })
    return
  }

  // Shortcut: detect draft email intent
  const draftEmailIntent = /\b(draft|write|retry|resend|generate).*(email|outreach|mail)/i.test(userText)
    || /\bemail.*(draft|write|retry|for)\b/i.test(userText)

  if (draftEmailIntent) {
    // Extract business name from message
    const nameMatch = userText.match(/(?:for|to)\s+(.+)/i)
    const searchTerm = nameMatch?.[1]?.trim()

    const query = supabase.from('leads').select('*').eq('status', 'approved').order('created_at', { ascending: false })
    if (searchTerm) query.ilike('business_name', `%${searchTerm}%`)

    const { data: leads } = await query.limit(1)
    const lead = leads?.[0]

    if (!lead) {
      await message.reply(`No approved lead found${searchTerm ? ` matching "${searchTerm}"` : ''}. Approve a lead first.`)
      return
    }

    const statusMsg = await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xff4d30)
        .setTitle('✉️ Drafting email...')
        .setDescription(`Writing personalised outreach for **${lead.business_name}**`)
      ]
    })

    try {
      const draft = await draftOutreachEmail(lead)

      await supabase.from('leads').update({
        email_draft_subject: draft.subject,
        email_draft_body: draft.body,
        email_to: draft.to
      }).eq('id', lead.id)

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`send_email:${lead.id}`).setLabel('📤 Send Email').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`discard_email:${lead.id}`).setLabel('🗑️ Discard').setStyle(ButtonStyle.Danger)
      )

      await statusMsg.edit({
        embeds: [new EmbedBuilder()
          .setColor(0xff4d30)
          .setTitle(`✉️ Email Draft — ${lead.business_name}`)
          .addFields(
            { name: '📬 To', value: draft.to || '_No email found — add manually_' },
            { name: '📝 Subject', value: draft.subject },
            { name: '💬 Body', value: `\`\`\`${draft.body}\`\`\`` }
          )
          .setFooter({ text: 'Approve to send · Discard to cancel' })
        ],
        components: [row]
      })
    } catch (e: any) {
      await statusMsg.edit({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle('❌ Draft failed')
          .setDescription(e.message)
        ]
      })
    }
    return
  }

  // Shortcut: detect show_leads intent directly without LLM
  const showLeadsIntent = /\b(show|list|what|see|display|how many).*(lead|client|prospect)/i.test(userText)
    || /\b(lead|client|prospect).*(show|list|what|see|display|how many)/i.test(userText)

  if (showLeadsIntent) {
    const { data: leads, error } = await supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(15)

    if (error || !leads || leads.length === 0) {
      await message.reply('No leads in the database yet. Try `ao find leads` first.')
      return
    }

    const embed = new EmbedBuilder()
      .setColor(0xff4d30)
      .setTitle(`📋 ${leads.length} Leads`)
      .setDescription(leads.map((l: any) => {
        const emoji = l.score >= 70 ? '🟢' : l.score >= 45 ? '🟡' : '🟠'
        const statusIcon = l.status === 'approved' ? '✅' : l.status === 'rejected' ? '❌' : '🔍'
        return `${statusIcon} ${emoji} **${l.business_name}** — ${l.location} · ${l.score}/100`
      }).join('\n'))
      .setFooter({ text: `${leads.length} total · Use "ao find leads" to discover more` })

    await message.reply({ embeds: [embed] })
    return
  }

  // Bulk search: "ao find restaurants in Colombo 3, Kandy, Galle"
  const bulkMatch = userText.match(/find\s+(.+?)\s+in\s+(.+)/i)
  if (bulkMatch) {
    const niche = bulkMatch[1].trim()
    const locationsPart = bulkMatch[2].trim()
    const locations = locationsPart.split(',').map(l => l.trim()).filter(Boolean)

    if (locations.length > 1) {
      const statusMsg = await message.reply({
        embeds: [new EmbedBuilder()
          .setColor(0xff4d30)
          .setTitle(`🔍 Bulk Search — ${locations.length} locations`)
          .setDescription(`Searching for **${niche}** in: ${locations.map(l => `**${l}**`).join(', ')}\n\nThis will take a few minutes...`)
        ]
      })

      let totalFound = 0
      let totalSaved = 0

      for (let i = 0; i < locations.length; i++) {
        const loc = locations[i]
        await statusMsg.edit({
          embeds: [new EmbedBuilder()
            .setColor(0xff4d30)
            .setTitle(`🔍 Searching ${i + 1}/${locations.length}`)
            .setDescription(`Currently scanning **${niche}** in **${loc}**...`)
          ]
        })

        try {
          const result = await runLeadEngine(niche, loc, 10, async (progress) => {
            await statusMsg.edit({
              embeds: [new EmbedBuilder()
                .setColor(0xff4d30)
                .setTitle(`🔍 ${i + 1}/${locations.length} — ${loc}`)
                .setDescription(`\`${progress}\``)
              ]
            })
          })

          totalFound += result.found
          totalSaved += result.saved.length

          const forumId = process.env.DISCORD_LEADS_FORUM_ID
          const forum = forumId ? await client.channels.fetch(forumId).catch(() => null) : null

          for (const [leadIdx, lead] of result.saved.slice(0, 10).entries()) {
            const scoreColor = lead.score >= 70 ? Colors.Green : lead.score >= 45 ? Colors.Yellow : Colors.Orange
            const scoreEmoji = lead.score >= 70 ? '🟢' : lead.score >= 45 ? '🟡' : '🟠'
            const lhField = lead.lighthouse_scores
              ? [{ name: '🏎️ Lighthouse (mobile)', value: lighthouseBlock(lead.lighthouse_scores) }]
              : []
            const embed = new EmbedBuilder()
              .setColor(scoreColor)
              .setTitle(lead.business_name)
              .setURL(lead.google_maps_url ?? '')
              .addFields(
                { name: '📍 Location', value: lead.location, inline: true },
                { name: '🏷️ Niche', value: lead.niche, inline: true },
                { name: '⭐ Score', value: `**${lead.score}/100**`, inline: true },
                { name: '📞 Phone', value: lead.phone ?? 'Not found', inline: true },
                { name: '🌐 Website', value: lead.website ?? '❌ No website', inline: true },
                ...((() => {
                  const links: string[] = []
                  if (lead.instagram) links.push(`[Instagram](${lead.instagram})`)
                  if (lead.facebook)  links.push(`[Facebook](${lead.facebook})`)
                  return links.length > 0 ? [{ name: '📱 Socials', value: links.join(' · '), inline: true }] : []
                })()),
                ...lhField,
                { name: '🔍 Why this lead', value: lead.score_reasons.map((r: string) => `• ${r}`).join('\n') || 'No reasons' },
                { name: '📉 Their gaps', value: lead.gap_analysis },
                { name: '💬 Pitch angle', value: `*"${lead.pitch_angle}"*` }
              )
              .setFooter({ text: `Lead ID: ${lead.id}` })

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(`approve_lead:${lead.id}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`reject_lead:${lead.id}`).setLabel('❌ Reject').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId(`later_lead:${lead.id}`).setLabel('⏳ Later').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`delete_lead:${lead.id}`).setLabel('🗑️ Delete').setStyle(ButtonStyle.Danger)
            )

            if (forum && forum.type === ChannelType.GuildForum) {
              const tagNames = [getNicheTagName(lead.niche)]
              const isHot = lead.score >= HOT_LEAD_SCORE
              if (isHot) tagNames.push('Hot Lead')
              const tagIds = getTagIds(forum as ForumChannel, ...tagNames)
              const thread = await (forum as ForumChannel).threads.create({
                name: `${scoreEmoji} ${lead.business_name} — ${lead.location}`,
                appliedTags: tagIds,
                message: { embeds: [embed], components: [row] }
              })
              await updateLeadStatus(lead.id!, 'found', thread.id)

              // Website audit — staggered 8s apart so Gemini Vision rate limit isn't hit
              if (lead.website) runWebsiteAudit(lead.website, lead.lighthouse_scores, thread, leadIdx * 8000)

              // 🔥 Hot lead ping
              if (isHot) {
                const generalId = process.env.DISCORD_APPROVAL_CHANNEL_ID
                const generalCh = generalId ? await client.channels.fetch(generalId).catch(() => null) as TextChannel | null : null
                const hotMentions = Object.values(TEAM).map(m => `<@${m.discordId}>`).join(' ')
                await generalCh?.send({
                  content: `${hotMentions} 🔥 **Hot lead just dropped — ${lead.score}/100!**`,
                  embeds: [new EmbedBuilder()
                    .setColor(0xff4d30)
                    .setTitle(`🔥 ${lead.business_name}`)
                    .setDescription(`*"${lead.pitch_angle}"*\n\n→ [Open in #leads](${thread.url})`)
                    .addFields(
                      { name: '📍 Location', value: lead.location, inline: true },
                      { name: '🏷️ Niche', value: lead.niche, inline: true },
                      { name: '⭐ Score', value: `**${lead.score}/100**`, inline: true },
                      ...(lead.lighthouse_scores ? [{ name: '🏎️ Lighthouse', value: lighthouseSummary(lead.lighthouse_scores) }] : [])
                    )
                  ]
                })
              }
            }
          }
        } catch (e: any) {
          console.error(`[Bulk] Error for ${loc}:`, e.message)
        }
      }

      await statusMsg.edit({
        embeds: [new EmbedBuilder()
          .setColor(0xff4d30)
          .setTitle(`✅ Bulk Search Complete`)
          .setDescription(`Scanned **${totalFound}** businesses across **${locations.length}** locations.\n**${totalSaved}** leads posted to #leads forum.`)
        ]
      })
      return
    }
  }

  // Think
  const response = await think(userText, state)

  // Add bot response to history
  const updatedState = getConversation(message.author.id, message.channelId)
  updateConversation(message.author.id, message.channelId, {
    history: [...updatedState.history, { role: 'assistant', content: response.message }]
  })

  // Handle action
  if (response.type === 'action' && response.action === 'find_leads') {
    const { niche, location, limit = 10, quality } = response.params ?? {}

    if (!niche || !location) {
      await message.reply("What niche and location? e.g. `ao find restaurants in Colombo`")
      return
    }

    const statusMsg = await message.reply({
      embeds: [new EmbedBuilder()
        .setColor(0xff4d30)
        .setTitle('🔍 On it...')
        .setDescription(response.message)
      ]
    })

    try {
      const result = await runLeadEngine(niche, location, limit, async (progress) => {
        await statusMsg.edit({
          embeds: [new EmbedBuilder()
            .setColor(0xff4d30)
            .setTitle('🔍 Running...')
            .setDescription(`\`${progress}\``)
          ]
        })
      })

      if (result.saved.length === 0) {
        await statusMsg.edit({
          embeds: [new EmbedBuilder()
            .setColor(Colors.Yellow)
            .setTitle('Nothing found')
            .setDescription(`Scanned **${result.found}** businesses but none looked like good leads.\nTry a different area or niche.`)
          ]
        })
        return
      }

      await statusMsg.edit({
        embeds: [new EmbedBuilder()
          .setColor(0xff4d30)
          .setTitle(`✅ Found ${result.saved.length} leads`)
          .setDescription(`Scanned **${result.found}** businesses in **${niche}** / **${location}**. Posting below 👇`)
        ]
      })

      // Post each lead as a forum thread
      const forumId = process.env.DISCORD_LEADS_FORUM_ID
      const forum = forumId ? await client.channels.fetch(forumId).catch(() => null) : null

      for (const [leadIdx, lead] of result.saved.slice(0, 10).entries()) {
        const scoreColor = lead.score >= 70 ? Colors.Green : lead.score >= 45 ? Colors.Yellow : Colors.Orange
        const scoreEmoji = lead.score >= 70 ? '🟢' : lead.score >= 45 ? '🟡' : '🟠'
        const lhField = lead.lighthouse_scores
          ? [{ name: '🏎️ Lighthouse (mobile)', value: lighthouseBlock(lead.lighthouse_scores) }]
          : []

        const embed = new EmbedBuilder()
          .setColor(scoreColor)
          .setTitle(lead.business_name)
          .setURL(lead.google_maps_url ?? '')
          .addFields(
            { name: '📍 Location', value: lead.location, inline: true },
            { name: '🏷️ Niche', value: lead.niche, inline: true },
            { name: '⭐ Score', value: `**${lead.score}/100**`, inline: true },
            { name: '📞 Phone', value: lead.phone ?? 'Not found', inline: true },
            { name: '📧 Email', value: (lead as any).email ?? 'Not found', inline: true },
            { name: '🌐 Website', value: lead.website ?? '❌ No website', inline: true },
            ...((() => {
              const links: string[] = []
              if (lead.instagram) links.push(`[Instagram](${lead.instagram})`)
              if (lead.facebook)  links.push(`[Facebook](${lead.facebook})`)
              return links.length > 0 ? [{ name: '📱 Socials', value: links.join(' · '), inline: true }] : []
            })()),
            ...lhField,
            { name: '🔍 Why this lead', value: lead.score_reasons.map(r => `• ${r}`).join('\n') || 'No reasons' },
            { name: '📉 Their gaps', value: lead.gap_analysis },
            { name: '💬 Pitch angle', value: `*"${lead.pitch_angle}"*` }
          )
          .setFooter({ text: `Lead ID: ${lead.id}` })

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`approve_lead:${lead.id}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`reject_lead:${lead.id}`).setLabel('❌ Reject').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`later_lead:${lead.id}`).setLabel('⏳ Later').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`delete_lead:${lead.id}`).setLabel('🗑️ Delete').setStyle(ButtonStyle.Danger)
        )

        if (forum && forum.type === ChannelType.GuildForum) {
          // Build tag list: niche + hot if applicable
          const tagNames = [getNicheTagName(lead.niche)]
          const isHot = lead.score >= HOT_LEAD_SCORE
          if (isHot) tagNames.push('Hot Lead')
          const tagIds = getTagIds(forum as ForumChannel, ...tagNames)

          // Post as forum thread
          const thread = await (forum as ForumChannel).threads.create({
            name: `${scoreEmoji} ${lead.business_name} — ${lead.location}`,
            appliedTags: tagIds,
            message: { embeds: [embed], components: [row] }
          })
          await updateLeadStatus(lead.id!, 'found', thread.id)

          // Website audit — staggered 8s apart so Gemini Vision rate limit isn't hit
          if (lead.website) runWebsiteAudit(lead.website, lead.lighthouse_scores, thread, leadIdx * 8000)

          // 🔥 Hot lead ping
          if (isHot) {
            const generalId = process.env.DISCORD_APPROVAL_CHANNEL_ID
            const generalCh = generalId ? await client.channels.fetch(generalId).catch(() => null) as TextChannel | null : null
            const hotMentions = Object.values(TEAM).map(m => `<@${m.discordId}>`).join(' ')
            await generalCh?.send({
              content: `${hotMentions} 🔥 **Hot lead just dropped — ${lead.score}/100!**`,
              embeds: [new EmbedBuilder()
                .setColor(0xff4d30)
                .setTitle(`🔥 ${lead.business_name}`)
                .setDescription(`*"${lead.pitch_angle}"*\n\n→ [Open in #leads](${thread.url})`)
                .addFields(
                  { name: '📍 Location', value: lead.location, inline: true },
                  { name: '🏷️ Niche', value: lead.niche, inline: true },
                  { name: '⭐ Score', value: `**${lead.score}/100**`, inline: true },
                  ...(lead.lighthouse_scores ? [{ name: '🏎️ Lighthouse', value: lighthouseSummary(lead.lighthouse_scores) }] : [])
                )
              ]
            })
          }
        } else {
          // Fallback to regular channel
          if (!('send' in message.channel)) continue
          const msg = await message.channel.send({ embeds: [embed], components: [row] })
          await updateLeadStatus(lead.id!, 'found', msg.id)
        }
      }

    } catch (e: any) {
      await statusMsg.edit({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle('❌ Something went wrong')
          .setDescription(`\`${e.message}\``)
        ]
      })
    }

  } else if (response.type === 'action' && response.action === 'show_leads') {
    const { status, limit = 10 } = response.params ?? {}

    const query = supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (status) query.eq('status', status)

    const { data: leads, error } = await query

    if (error || !leads || leads.length === 0) {
      await message.reply('No leads found in the database yet. Try `ao find leads` first.')
      return
    }

    const embed = new EmbedBuilder()
      .setColor(0xff4d30)
      .setTitle(`📋 ${leads.length} Leads`)
      .setDescription(leads.map((l: any) => {
        const emoji = l.score >= 70 ? '🟢' : l.score >= 45 ? '🟡' : '🟠'
        const status = l.status === 'approved' ? '✅' : l.status === 'rejected' ? '❌' : '🔍'
        return `${status} ${emoji} **${l.business_name}** — ${l.location} (${l.score}/100)`
      }).join('\n'))
      .setFooter({ text: 'Use ao find leads to discover more' })

    await message.reply({ embeds: [embed] })

  } else {
    // Regular conversation reply
    await message.reply(response.message)
  }
})

// Button interactions (approve/reject leads)
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return
  const [action, leadId] = interaction.customId.split(':')

  if (['approve_lead', 'reject_lead', 'later_lead', 'send_email', 'discard_email', 'send_wa'].includes(action)) {

    await handleApproval(interaction)

    // When Later is clicked, set a 3-day reminder
    if (action === 'later_lead' && leadId) {
      const remindAt = new Date(Date.now() + 3 * 86400000).toISOString()
      await supabase.from('leads').update({ remind_at: remindAt }).eq('id', leadId)
    }
  }

  // Clear leads confirmation
  if (action === 'confirm_clear_leads') {
    await interaction.deferUpdate()

    // Delete all forum threads first
    const forumId = process.env.DISCORD_LEADS_FORUM_ID
    let deletedThreads = 0
    if (forumId) {
      const forum = await client.channels.fetch(forumId).catch(() => null) as ForumChannel | null
      if (forum?.type === ChannelType.GuildForum) {
        // Fetch active threads
        const active = await forum.threads.fetchActive()
        for (const [, thread] of active.threads) {
          await thread.delete().catch(() => null)
          deletedThreads++
        }
        // Fetch archived threads
        const archived = await forum.threads.fetchArchived()
        for (const [, thread] of archived.threads) {
          await thread.delete().catch(() => null)
          deletedThreads++
        }
      }
    }

    // Wipe Supabase
    await supabase.from('leads').delete().neq('id', '00000000-0000-0000-0000-000000000000')

    await interaction.message.edit({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle('✅ All Cleared')
        .setDescription(`Deleted **${deletedThreads}** forum threads and wiped all leads from the database.\n\nFresh start 🧹`)
      ],
      components: []
    })
  }

  // Delete individual lead
  if (action === 'delete_lead') {
    await interaction.deferUpdate()
    await supabase.from('leads').delete().eq('id', leadId)
    // Delete the forum thread
    const thread = interaction.channel
    if (thread && 'delete' in thread) {
      await (thread as any).delete().catch(() => null)
    } else {
      await interaction.message.delete().catch(() => null)
    }
  }

  if (action === 'cancel_clear_leads') {
    await interaction.deferUpdate()
    await interaction.message.edit({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Grey)
        .setTitle('Cancelled')
        .setDescription('No leads were deleted.')
      ],
      components: []
    })
  }
})

function buildHelpEmbed() {
  return {
    embeds: [new EmbedBuilder()
      .setColor(0xff4d30)
      .setTitle('Ardeno OS')
      .setDescription('Just talk to me naturally. Start your message with `ao` or @mention me.')
      .addFields(
        { name: 'Find leads', value: '`ao find restaurant leads in Colombo`' },
        { name: 'Get specific', value: '`ao find mid-range gyms in Kandy`' },
        { name: 'Check status', value: '`ao what leads do we have?`' },
        { name: 'Ask anything', value: '`ao how many leads did we get this week?`' }
      )
      .setFooter({ text: 'Ardeno OS — Your 3rd founder' })
    ]
  }
}

/**
 * Fire-and-forget website audit.
 * Runs in the background and posts as a follow-up message in the forum thread.
 * Never throws — all errors are silently swallowed.
 */
function lhBadge(score: number | undefined | null): string {
  if (score === undefined || score === null) return '`—`'
  const icon = score >= 90 ? '🟢' : score >= 50 ? '🟡' : '🔴'
  return `${icon} **${score}**/100`
}

function runWebsiteAudit(
  website: string,
  lighthouse: any,
  thread: { send: (opts: any) => Promise<any> },
  delayMs = 0
): void {
  const doAudit = async () => {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
    return analyzeWebsite(website, lighthouse)
  }

  doAudit()
    .then(async (result) => {
      if (!result) return
      const { audit, screenshot } = result

      const embed = new EmbedBuilder()
        .setColor(0x1c1c1e)
        .setTitle(`🔍 AI Website Audit`)
        .setURL(website)
        .setDescription(formatAuditEmbed(audit))

      // Always show Lighthouse section — shows N/A if scores unavailable
      embed.addFields({
        name: '📊 Lighthouse Scores (Mobile)',
        value: lighthouse ? [
          `🏎️ Performance    ${lhBadge(lighthouse.performance)}`,
          `🔍 SEO                ${lhBadge(lighthouse.seo)}`,
          `♿ Accessibility   ${lhBadge(lighthouse.accessibility)}`,
          `✅ Best Practices  ${lhBadge(lighthouse.bestPractices)}`
        ].join('\n') : `*⏱️ Timed out — site may be blocking Google's servers*`,
        inline: false
      })

      // Attach screenshot as the embed image — shows the site right in Discord
      const msgOptions: any = { embeds: [embed] }
      if (screenshot) {
        const attachment = new AttachmentBuilder(screenshot, { name: 'site-preview.jpg' })
        embed.setImage('attachment://site-preview.jpg')
        msgOptions.files = [attachment]
      }

      embed.setFooter({ text: `${website} · Ardeno OS` })

      await thread.send(msgOptions)
    })
    .catch(() => null)
}

client.login(process.env.DISCORD_TOKEN)
