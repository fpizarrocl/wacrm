import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

// ============================================================
// Inline the newest inbound image into a base64 ContentPart at
// generation time (not persisted — fetched fresh on every call, same
// spirit as the existing WhatsApp media proxy route).
// ============================================================

/** Skip anything bigger than this rather than fail the whole reply —
 *  mirrors the MAX_LOGO_BYTES pattern in branding-card.tsx. */
const MAX_IMAGE_BYTES = 5_000_000

export interface InboundImageMessage {
  /** `messages.media_url` — WhatsApp: proxy path `/api/whatsapp/media/{id}`.
   *  Instagram/Messenger: a real, directly-fetchable Meta attachment URL. */
  mediaUrl: string
  channel: 'whatsapp' | 'instagram' | 'messenger'
}

const WHATSAPP_MEDIA_PATH_RE = /\/api\/whatsapp\/media\/([^/?]+)/

/**
 * Download + base64-encode the newest inbound image so it can be
 * inlined into the LLM call as a vision content part. Returns null on
 * any failure (missing config, oversized file, network error) — the
 * caller falls back to a text placeholder rather than failing the
 * whole generation over one image.
 */
export async function fetchInboundImageAsBase64(
  db: SupabaseClient,
  accountId: string,
  message: InboundImageMessage,
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
      if (buffer.byteLength > MAX_IMAGE_BYTES) return null
      return { mimeType: mimeType || contentType, data: buffer.toString('base64') }
    }

    // Instagram/Messenger — media_url is a real, publicly fetchable
    // attachment URL once src/app/api/social/webhook/route.ts stores it.
    const response = await fetch(message.mediaUrl)
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') || 'image/jpeg'
    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) return null
    return { mimeType: contentType, data: Buffer.from(arrayBuffer).toString('base64') }
  } catch (err) {
    console.error('[ai/media] failed to fetch inbound image:', err)
    return null
  }
}
