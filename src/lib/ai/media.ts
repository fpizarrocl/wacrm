import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

// ============================================================
// Inline the newest inbound image/voice-note into a base64 ContentPart
// at generation time (not persisted — fetched fresh on every call,
// same spirit as the existing WhatsApp media proxy route). Used for:
//   - images, on every provider.
//   - audio, on Gemini only — the one provider with native audio
//     understanding; OpenAI/Anthropic transcribe with Whisper at
//     ingestion time instead (src/lib/ai/transcribe.ts), so their
//     content_text is already real text by the time it gets here.
// ============================================================

/** Skip anything bigger than this rather than fail the whole reply —
 *  mirrors the MAX_LOGO_BYTES pattern in branding-card.tsx, and is
 *  comfortably under Whisper's own 25 MB ceiling for the audio case. */
const MAX_MEDIA_BYTES = 5_000_000

export interface InboundMediaMessage {
  /** `messages.media_url` — WhatsApp: proxy path `/api/whatsapp/media/{id}`.
   *  Instagram/Messenger: a real, directly-fetchable Meta attachment URL. */
  mediaUrl: string
  channel: 'whatsapp' | 'instagram' | 'messenger'
}

const WHATSAPP_MEDIA_PATH_RE = /\/api\/whatsapp\/media\/([^/?]+)/

/**
 * Download + base64-encode the newest inbound image or voice note so
 * it can be inlined into the LLM call as a vision/audio content part.
 * Returns null on any failure (missing config, oversized file, network
 * error) — the caller falls back to a text placeholder rather than
 * failing the whole generation over one attachment.
 */
export async function fetchInboundMediaAsBase64(
  db: SupabaseClient,
  accountId: string,
  message: InboundMediaMessage,
  fallbackMimeType: string,
): Promise<{ mimeType: string; data: string } | null> {
  try {
    if (message.channel === 'whatsapp') {
      const match = message.mediaUrl.match(WHATSAPP_MEDIA_PATH_RE)
      if (!match) return null
      const mediaId = match[1]

      const { data: config, error } = await db
        .from('whatsapp_config')
        .select('access_token')
        .eq('account_id', accountId)
        .maybeSingle()
      if (error || !config?.access_token) return null

      const accessToken = decrypt(config.access_token)
      const { url, mimeType } = await getMediaUrl({ mediaId, accessToken })
      const { buffer, contentType } = await downloadMedia({ downloadUrl: url, accessToken })
      if (buffer.byteLength > MAX_MEDIA_BYTES) return null
      return { mimeType: mimeType || contentType, data: buffer.toString('base64') }
    }

    // Instagram/Messenger — media_url is a real, publicly fetchable
    // attachment URL once src/app/api/social/webhook/route.ts stores it.
    const response = await fetch(message.mediaUrl)
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') || fallbackMimeType
    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) return null
    return { mimeType: contentType, data: Buffer.from(arrayBuffer).toString('base64') }
  } catch (err) {
    console.error('[ai/media] failed to fetch inbound media:', err)
    return null
  }
}
