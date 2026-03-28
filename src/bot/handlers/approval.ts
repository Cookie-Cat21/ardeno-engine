import { ButtonInteraction, EmbedBuilder, Colors } from 'discord.js'
import { getLeadByMessageId, updateLeadStatus } from '../../db/supabase'

export async function handleApproval(interaction: ButtonInteraction) {
  const [action, leadId] = interaction.customId.split(':')

  await interaction.deferUpdate()

  const lead = await getLeadByMessageId(interaction.message.id)
  if (!lead && !leadId) {
    await interaction.followUp({ content: 'Could not find lead data.', ephemeral: true })
    return
  }

  const id = leadId || lead?.id!

  if (action === 'approve_lead') {
    await updateLeadStatus(id, 'approved')

    const updated = interaction.message.embeds[0]
    await interaction.message.edit({
      embeds: [EmbedBuilder.from(updated)
        .setColor(Colors.Green)
        .setFooter({ text: `✅ APPROVED — Queued for outreach | Lead ID: ${id}` })
      ],
      components: [] // Remove buttons
    })

    await interaction.followUp({
      embeds: [new EmbedBuilder()
        .setColor(0xff4d30)
        .setTitle('Lead Approved')
        .setDescription(`**${lead?.business_name ?? 'Lead'}** has been approved and queued for outreach.\n\n> Coming soon: Auto-draft personalised email ✉️`)
      ]
    })

  } else if (action === 'reject_lead') {
    await updateLeadStatus(id, 'rejected')

    const updated = interaction.message.embeds[0]
    await interaction.message.edit({
      embeds: [EmbedBuilder.from(updated)
        .setColor(Colors.Red)
        .setFooter({ text: `❌ REJECTED | Lead ID: ${id}` })
      ],
      components: []
    })

  } else if (action === 'later_lead') {
    const updated = interaction.message.embeds[0]
    await interaction.message.edit({
      embeds: [EmbedBuilder.from(updated)
        .setColor(Colors.Grey)
        .setFooter({ text: `⏳ SAVED FOR LATER | Lead ID: ${id}` })
      ],
      components: []
    })
  }
}
