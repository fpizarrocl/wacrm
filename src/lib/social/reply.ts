import { decrypt } from '@/lib/whatsapp/encryption'
import { sendSocialText } from './send-api'
import type { SocialChannel } from './inbound'
import { supabaseAdmin } from './admin-client'

export interface SendSocialReplyArgs {
  accountId: string
  conversationId: string
  contactId: string
  channel: SocialChannel
  text: string
  /** 'bot' for AI auto-reply, 'agent' for a human replying from the
   *  inbox — same distinction the WhatsApp send paths make. */
  senderType?: 'bot' | 'agent'
  /** Marks the persisted message `ai_generated = true`, same
   *  convention as engineSendText (src/lib/flows/meta-send.ts) so the
   *  inbox badges it as an AI reply. */
  aiGenerated?: boolean
}

/**
 * Send a plain-text Instagram/Messenger reply and persist it —
 * the Instagram/Messenger counterpart to `engineSendText`
 * (src/lib/flows/meta-send.ts), used by both the AI auto-reply
 * pipeline and manual "agent replies from inbox" sends.
 *
 * No phone-variant retry (that's a WhatsApp-number quirk) — the
 * recipient id is the exact IGSID/PSID Meta gave us on the way in.
 */
export async function sendSocialReplyText(
  args: SendSocialReplyArgs,
): Promise<{ id: string; message_id: string }> {
  const db = supabaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, external_id')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact?.external_id) {
    throw new Error('contact not found for this account')
  }

  const { data: config, error: configErr } = await db
    .from('social_channel_config')
    .select('*')
    .eq('account_id', args.accountId)
    .eq('channel', args.channel)
    .single()
  if (configErr || !config) {
    throw new Error(`${args.channel} not configured for this account`)
  }

  const accessToken = decrypt(config.access_token)

  const { messageId } = await sendSocialText({
    channel: args.channel,
    pageId: config.page_id,
    accessToken,
    recipientId: contact.external_id,
    text: args.text,
  })

  const { data: messageRow, error: msgErr } = await db
    .from('messages')
    .insert({
      conversation_id: args.conversationId,
      sender_type: args.senderType ?? 'bot',
      content_type: 'text',
      content_text: args.text,
      message_id: messageId,
      status: 'sent',
      ai_generated: args.aiGenerated ?? false,
    })
    .select()
    .single()
  if (msgErr) {
    throw new Error(`sent to Meta but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)

  return { id: messageRow.id, message_id: messageId }
}
