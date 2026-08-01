import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiProvider, ChatMessage, ContentPart } from './types'
import { aiContextMessageLimit } from './defaults'
import { fetchInboundMediaAsBase64 } from './media'

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
 * text rows use their `content_text` as-is. image rows: only the
 * newest one in the window is downloaded and inlined as a vision
 * content part (bounds cost/latency — a long thread doesn't re-bill
 * every old photo on every turn); older images fall back to a
 * placeholder. audio rows: on OpenAI/Anthropic, the webhook already
 * transcribed them with Whisper at ingestion time, so `content_text`
 * is real text here — no special handling needed. On Gemini (native
 * audio understanding, no Whisper key required), ingestion leaves
 * `content_text` empty and only the newest such row gets downloaded
 * and inlined as an audio content part, same cost-bounding rule as
 * images. Templates/interactive/location/video/document messages are
 * excluded — no text or vision/audio content to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  provider: AiProvider,
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

  // Only the last image row gets the full download-and-inline
  // treatment. Same for the last *untranscribed* audio row (empty
  // content_text — i.e. a Gemini-account voice note that skipped
  // Whisper at ingestion), and only when the account is on Gemini.
  let newestImageIndex = -1
  let newestAudioIndex = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (newestImageIndex === -1 && rows[i].content_type === 'image') newestImageIndex = i
    if (
      provider === 'gemini' &&
      newestAudioIndex === -1 &&
      rows[i].content_type === 'audio' &&
      !rows[i].content_text?.trim()
    ) {
      newestAudioIndex = i
    }
    if (newestImageIndex !== -1 && (provider !== 'gemini' || newestAudioIndex !== -1)) break
  }

  let channel: 'whatsapp' | 'instagram' | 'messenger' | null = null
  if (newestImageIndex !== -1 || newestAudioIndex !== -1) {
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
        const image = await fetchInboundMediaAsBase64(
          db,
          accountId,
          { mediaUrl: m.media_url, channel },
          'image/jpeg',
        )
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

    if (m.content_type === 'audio' && i === newestAudioIndex && m.media_url && channel) {
      const audio = await fetchInboundMediaAsBase64(
        db,
        accountId,
        { mediaUrl: m.media_url, channel },
        'audio/ogg',
      )
      if (audio) {
        out.push({ role, content: [{ type: 'audio', mimeType: audio.mimeType, data: audio.data }] })
        continue
      }
      out.push({ role, content: '[Nota de voz]' })
      continue
    }

    if (m.content_text && m.content_text.trim()) {
      out.push({ role, content: m.content_text.trim() })
    }
  }
  return out
}
