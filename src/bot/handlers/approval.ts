import { ButtonInteraction, EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, ForumChannel, ThreadChannel, ChannelType } from 'discord.js'
import { getLeadById, updateLeadStatus, supabase } from '../../db/supabase'
import { draftOutreachEmail, sendEmail } from '../../agents/emailDrafter'
import { getMember } from '../../config/team'

// Apply a forum tag by name to the current thread
async function applyForumTag(interaction: ButtonInteraction, tagName: string) {
  try {
    const thread = interaction.channel as ThreadChannel
    if (!thread || thread.type !== ChannelType.PublicThread) return

    const forum = thread.parent as ForumChannel
    if (!forum || forum.type !== ChannelType.GuildForum) return

    const tag = forum.availableTags.find(t => t.name.toLowerCase().includes(tagName.toLowerCase()))
    if (!tag) return

    await thread.setAppliedTags([tag.id])
  } catch (e) {
    // Non-critical — don't break the flow if tagging fails
  }
}

export async function handleApproval(interaction: ButtonInteraction) {
  const [action, leadId] = interaction.customId.split(':')

  await interaction.deferUpdate()

  // Fetch lead from DB
  const lead = await getLeadById(leadId)
  if (!lead) {
    await interaction.followUp({ content: 'Could not find lead data.', ephemeral: true })
    return
  }

  if (action === 'approve_lead') {
    await updateLeadStatus(leadId, 'approved')
    await applyForumTag(interaction, 'Approved')

    // Who approved this?
    const approver = getMember(interaction.user.id)

    // Update the lead card
    const updated = interaction.message.embeds[0]
    await interaction.message.edit({
      embeds: [EmbedBuilder.from(updated)
        .setColor(Colors.Green)
        .setFooter({ text: `✅ Approved by ${approver?.name ?? interaction.user.username} — Drafting email...` })
      ],
      components: []
    })

    // Draft the email with Groq, personalised for the approver
    try {
      const draft = await draftOutreachEmail(lead, approver)

      const emailEmbed = new EmbedBuilder()
        .setColor(0xff4d30)
        .setTitle(`✉️ Email Draft — ${lead.business_name}`)
        .addFields(
          { name: '📬 To', value: draft.to || '_No email found — add manually_' },
          { name: '📝 Subject', value: draft.subject },
          { name: '💬 Body', value: `\`\`\`${draft.body}\`\`\`` }
        )
        .setFooter({ text: `Drafted for ${approver?.name ?? 'you'} · Approve to send · Discard to cancel` })

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`send_email:${leadId}`)
          .setLabel('📤 Send Email')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`discard_email:${leadId}`)
          .setLabel('🗑️ Discard')
          .setStyle(ButtonStyle.Danger)
      )

      // Store draft in DB temporarily
      await supabase.from('leads').update({
        email_draft_subject: draft.subject,
        email_draft_body: draft.body,
        email_to: draft.to
      }).eq('id', leadId)

      await interaction.followUp({ embeds: [emailEmbed], components: [row] })

    } catch (e: any) {
      await interaction.followUp({
        embeds: [new EmbedBuilder()
          .setColor(Colors.Red)
          .setTitle('❌ Draft failed')
          .setDescription(`Could not draft email: ${e.message}`)
        ]
      })
    }

  } else if (action === 'send_email') {
    await applyForumTag(interaction, 'Reached Out')
    // Fetch draft from DB and send
    const { data } = await supabase
      .from('leads')
      .select('email_draft_subject, email_draft_body, email_to, business_name')
      .eq('id', leadId)
      .single()

    if (!data?.email_to) {
      await interaction.followUp({
        content: '⚠️ No email address found for this lead. Add it manually in Supabase.',
        ephemeral: true
      })
      return
    }

    try {
      await sendEmail({
        subject: data.email_draft_subject,
        body: data.email_draft_body,
        to: data.email_to
      })

      await updateLeadStatus(leadId, 'contacted')

      await interaction.message.edit({
        embeds: [EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(Colors.Green)
          .setTitle(`✅ Email Sent — ${data.business_name}`)
          .setFooter({ text: 'Outreach sent via ardenostudio@gmail.com' })
        ],
        components: []
      })

    } catch (e: any) {
      await interaction.followUp({
        content: `❌ Failed to send: ${e.message}`,
        ephemeral: true
      })
    }

  } else if (action === 'discard_email') {
    await interaction.message.edit({
      embeds: [EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(Colors.Grey)
        .setTitle('🗑️ Email Discarded')
      ],
      components: []
    })

  } else if (action === 'reject_lead') {
    await updateLeadStatus(leadId, 'rejected')
    await applyForumTag(interaction, 'Denied')

    const updated = interaction.message.embeds[0]
    await interaction.message.edit({
      embeds: [EmbedBuilder.from(updated)
        .setColor(Colors.Red)
        .setFooter({ text: `❌ REJECTED` })
      ],
      components: []
    })

  } else if (action === 'later_lead') {
    await applyForumTag(interaction, 'Later')
    const updated = interaction.message.embeds[0]
    await interaction.message.edit({
      embeds: [EmbedBuilder.from(updated)
        .setColor(Colors.Grey)
        .setFooter({ text: `⏳ SAVED FOR LATER — Reminder in 3 days` })
      ],
      components: []
    })
  }
}
