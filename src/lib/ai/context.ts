import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage, ContentPart } from './types'
import { aiContextMessageLimit } from './defaults'
import { fetchInboundImageAsBase64 } from './media'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  media_url: string | null
}

/**
 * Fetch the last N messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`.
 *
 * text + audio rows use their `content_text` as-is — audio is
 * transcribed at ingestion time (see the WhatsApp/social webhooks), so
 * by the time it reaches here it's just text, no special handling
 * needed. image rows: only the newest one in the window is downloaded
 * and inlined as a vision content part (bounds cost/latency — a long
 * thread doesn't re-bill every old photo on every turn); older images
 * fall back to a placeholder. Templates/interactive/location/video/
 * document messages are excluded — no text or vision content to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, media_url')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'audio', 'image'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()

  // Only the last image row (by position in the already-chronological
  // list) gets the full download-and-inline treatment.
  let newestImageIndex = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].content_type === 'image') {
      newestImageIndex = i
      break
    }
  }

  let channel: 'whatsapp' | 'instagram' | 'messenger' | null = null
  if (newestImageIndex !== -1) {
    const { data: conv } = await db
      .from('conversations')
      .select('channel')
      .eq('id', conversationId)
      .maybeSingle()
    channel = (conv?.channel as typeof channel) ?? 'whatsapp'
  }

  const out: ChatMessage[] = []
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i]
    const role = m.sender_type === 'customer' ? 'user' : 'assistant'

    if (m.content_type === 'image') {
      if (i === newestImageIndex && m.media_url && channel) {
        const image = await fetchInboundImageAsBase64(db, accountId, {
          mediaUrl: m.media_url,
          channel,
        })
        if (image) {
          const parts: ContentPart[] = [{ type: 'image', mimeType: image.mimeType, data: image.data }]
          if (m.content_text?.trim()) parts.unshift({ type: 'text', text: m.content_text.trim() })
          out.push({ role, content: parts })
          continue
        }
      }
      out.push({ role, content: '[Imagen enviada anteriormente]' })
      continue
    }

    if (m.content_text && m.content_text.trim()) {
      out.push({ role, content: m.content_text.trim() })
    }
  }
  return out
}
