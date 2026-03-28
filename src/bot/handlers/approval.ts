import { ButtonInteraction, EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, ForumChannel, ThreadChannel, ChannelType } from 'discord.js'
import { getLeadById, updateLeadStatus, supabase } from '../../db/supabase'
import { draftOutreachEmail, sendEmail } from '../../agents/emailDrafter'
import { getMember } from '../../config/team'
import { draftWhatsAppMessage, sendWhatsAppMessage, isReady } from '../../whatsapp/WAManager'

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
      const hasEmail = !!lead.email
      const hasPhone = !!lead.phone
      const waReady = approver ? isReady(approver.discordId) : false

      // Draft both email and WhatsApp message in parallel
      const [emailDraft, waDraft] = await Promise.all([
        hasEmail ? draftOutreachEmail(lead, approver) : null,
        hasPhone && waReady ? draftWhatsAppMessage(lead, approver!) : null
      ])

      if (emailDraft) {
        await supabase.from('leads').update({
          email_draft_subject: emailDraft.subject,
          email_draft_body: emailDraft.body,
          email_to: emailDraft.to
        }).eq('id', leadId)
      }

      if (waDraft) {
        await supabase.from('leads').update({ wa_draft: waDraft }).eq('id', leadId)
      }

      // Build outreach embed
      const fields: any[] = []
      if (emailDraft) {
        fields.push(
          { name: '📝 Email Subject', value: emailDraft.subject },
          { name: '✉️ Email Body', value: `\`\`\`${emailDraft.body}\`\`\`` }
        )
      }
      if (waDraft) {
        fields.push({ name: '📱 WhatsApp Message', value: `\`\`\`${waDraft}\`\`\`` })
      }
      if (!emailDraft && !waDraft) {
        fields.push({ name: '⚠️ No contact info', value: 'No email or phone found for this lead.' })
      }

      const outreachEmbed = new EmbedBuilder()
        .setColor(0xff4d30)
        .setTitle(`📬 Outreach Draft — ${lead.business_name}`)
        .addFields(fields)
        .setFooter({ text: `Drafted for ${approver?.name ?? 'you'} · Choose how to reach out` })

      // Build buttons based on available contact info
      const buttons: ButtonBuilder[] = []
      if (hasEmail) {
        buttons.push(new ButtonBuilder()
          .setCustomId(`send_email:${leadId}`)
          .setLabel('📤 Send Email')
          .setStyle(ButtonStyle.Primary))
      }
      if (hasPhone && waReady) {
        buttons.push(new ButtonBuilder()
          .setCustomId(`send_wa:${leadId}`)
          .setLabel('📱 Send WhatsApp')
          .setStyle(ButtonStyle.Success))
      } else if (hasPhone && !waReady) {
        buttons.push(new ButtonBuilder()
          .setCustomId(`send_wa:${leadId}`)
          .setLabel('📱 WhatsApp (not connected)')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true))
      }
      buttons.push(new ButtonBuilder()
        .setCustomId(`discard_email:${leadId}`)
        .setLabel('🗑️ Discard')
        .setStyle(ButtonStyle.Danger))

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)
      await interaction.followUp({ embeds: [outreachEmbed], components: [row] })

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

  } else if (action === 'send_wa') {
    const approver = getMember(interaction.user.id)
    if (!approver) {
      await interaction.followUp({ content: '❌ Your Discord account is not in the team config.', ephemeral: true })
      return
    }

    const { data } = await supabase
      .from('leads')
      .select('wa_draft, phone, business_name')
      .eq('id', leadId)
      .single()

    if (!data?.phone) {
      await interaction.followUp({ content: '⚠️ No phone number found for this lead.', ephemeral: true })
      return
    }

    try {
      await sendWhatsAppMessage(approver.discordId, data.phone, data.wa_draft)
      await updateLeadStatus(leadId, 'contacted')
      await applyForumTag(interaction, 'Reached Out')

      await interaction.message.edit({
        embeds: [EmbedBuilder.from(interaction.message.embeds[0])
          .setColor(Colors.Green)
          .setTitle(`✅ WhatsApp Sent — ${data.business_name}`)
          .setFooter({ text: `Sent from ${approver.name}'s WhatsApp` })
        ],
        components: []
      })
    } catch (e: any) {
      await interaction.followUp({ content: `❌ WhatsApp send failed: ${e.message}`, ephemeral: true })
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
