import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors
} from 'discord.js'
import { runLeadEngine } from '../../agents/leadRunner'
import { updateLeadStatus } from '../../db/supabase'
import type { Lead } from '../../db/supabase'

export const data = new SlashCommandBuilder()
  .setName('findleads')
  .setDescription('Find potential clients in a niche and location')
  .addStringOption(opt =>
    opt.setName('niche')
      .setDescription('Business type (e.g. restaurant, gym, salon)')
      .setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName('location')
      .setDescription('City or area (e.g. Colombo, Melbourne)')
      .setRequired(true)
  )
  .addIntegerOption(opt =>
    opt.setName('limit')
      .setDescription('Max businesses to scan (default 15)')
      .setMinValue(5)
      .setMaxValue(30)
  )

export async function execute(interaction: ChatInputCommandInteraction) {
  const niche = interaction.options.getString('niche', true)
  const location = interaction.options.getString('location', true)
  const limit = interaction.options.getInteger('limit') ?? 15

  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0xff4d30)
      .setTitle('🔍 Lead Engine Running...')
      .setDescription(`Searching for **${niche}** businesses in **${location}**.\nThis takes 1-3 minutes. I'll update you as I go.`)
    ]
  })

  try {
    const result = await runLeadEngine(niche, location, limit, async (msg) => {
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0xff4d30)
          .setTitle('🔍 Lead Engine Running...')
          .setDescription(`\`${msg}\``)
        ]
      })
    })

    if (result.saved.length === 0) {
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Yellow)
          .setTitle('No Leads Found')
          .setDescription(`Scanned ${result.found} businesses but none scored high enough.\nTry a different niche or location.`)
        ]
      })
      return
    }

    // Post summary first
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0xff4d30)
        .setTitle(`✅ Found ${result.saved.length} Hot Leads`)
        .setDescription(`Scanned **${result.found}** businesses in **${niche}** / **${location}**.\nPosting top leads below for approval 👇`)
        .addFields({ name: 'Errors', value: result.errors.length > 0 ? result.errors.slice(0, 3).join('\n') : 'None' })
      ]
    })

    // Post each lead as a separate approval card
    const channel = interaction.channel
    if (!channel || !('send' in channel)) return
    for (const lead of result.saved.slice(0, 10)) {
      const msg = await channel.send(buildLeadCard(lead))
      await updateLeadStatus(lead.id!, 'found', msg.id)
    }

  } catch (e: any) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle('❌ Lead Engine Failed')
        .setDescription(`Error: \`${e.message}\``)
      ]
    })
  }
}

function buildLeadCard(lead: Lead) {
  const scoreColor = lead.score >= 80 ? Colors.Green : lead.score >= 60 ? Colors.Yellow : Colors.Orange

  const embed = new EmbedBuilder()
    .setColor(scoreColor)
    .setTitle(`${lead.business_name}`)
    .setURL(lead.google_maps_url ?? '')
    .addFields(
      { name: '📍 Location', value: lead.location, inline: true },
      { name: '🏷️ Niche', value: lead.niche, inline: true },
      { name: '⭐ Score', value: `**${lead.score}/100**`, inline: true },
      { name: '📞 Phone', value: lead.phone ?? 'Not found', inline: true },
      { name: '🌐 Website', value: lead.website ?? '❌ No website', inline: true },
      { name: '⭐ Google', value: lead.google_rating ? `${lead.google_rating} (${lead.review_count} reviews)` : 'No data', inline: true },
      { name: '🔍 Why This Lead', value: lead.score_reasons.map(r => `• ${r}`).join('\n') },
      { name: '📉 Their Gaps', value: lead.gap_analysis },
      { name: '💬 Pitch Angle', value: `*"${lead.pitch_angle}"*` }
    )
    .setFooter({ text: `Lead ID: ${lead.id}` })

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_lead:${lead.id}`)
      .setLabel('✅ Approve — Send Outreach')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject_lead:${lead.id}`)
      .setLabel('❌ Reject')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`later_lead:${lead.id}`)
      .setLabel('⏳ Later')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`delete_lead:${lead.id}`)
      .setLabel('🗑️ Delete')
      .setStyle(ButtonStyle.Danger)
  )

  return { embeds: [embed], components: [row] }
}
