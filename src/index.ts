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
  ChannelType
} from 'discord.js'
import dotenv from 'dotenv'
import { think } from './bot/brain'
import { getConversation, updateConversation } from './bot/conversation'
import { runLeadEngine } from './agents/leadRunner'
import { updateLeadStatus, supabase } from './db/supabase'
import { handleApproval } from './bot/handlers/approval'

dotenv.config()

const PREFIX = 'ao'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

client.once(Events.ClientReady, (c) => {
  console.log(`\n🚀 Ardeno OS online as ${c.user.tag}`)
  c.user.setActivity('ao help', { type: ActivityType.Listening })
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

      for (const lead of result.saved.slice(0, 10)) {
        const scoreColor = lead.score >= 70 ? Colors.Green : lead.score >= 45 ? Colors.Yellow : Colors.Orange
        const scoreEmoji = lead.score >= 70 ? '🟢' : lead.score >= 45 ? '🟡' : '🟠'

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
            { name: '🔍 Why this lead', value: lead.score_reasons.map(r => `• ${r}`).join('\n') || 'No reasons' },
            { name: '📉 Their gaps', value: lead.gap_analysis },
            { name: '💬 Pitch angle', value: `*"${lead.pitch_angle}"*` }
          )
          .setFooter({ text: `Lead ID: ${lead.id}` })

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`approve_lead:${lead.id}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`reject_lead:${lead.id}`).setLabel('❌ Reject').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`later_lead:${lead.id}`).setLabel('⏳ Later').setStyle(ButtonStyle.Secondary)
        )

        if (forum && forum.type === ChannelType.GuildForum) {
          // Post as forum thread
          const thread = await (forum as ForumChannel).threads.create({
            name: `${scoreEmoji} ${lead.business_name} — ${lead.location}`,
            message: { embeds: [embed], components: [row] }
          })
          await updateLeadStatus(lead.id!, 'found', thread.id)
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
  if (interaction.isButton()) {
    const [action] = interaction.customId.split(':')
    if (['approve_lead', 'reject_lead', 'later_lead'].includes(action)) {
      await handleApproval(interaction)
    }
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

client.login(process.env.DISCORD_TOKEN)
