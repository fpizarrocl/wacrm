import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { transcribeAudio } from '@/lib/ai/transcribe'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import {
  findOrCreateSocialContact,
  findOrCreateSocialConversation,
  type SocialChannel,
} from '@/lib/social/inbound'

// Instagram DM + Facebook Messenger inbound (migration 046). Deliberately
// a separate route from src/app/api/whatsapp/webhook/route.ts rather than
// a refactor of it — same "duplicate now, diverge cleanly" precedent as
// src/lib/flows/meta-send.ts vs src/lib/automations/meta-send.ts. v1 scope
// is inbox + AI auto-reply only: no Flows/Automations dispatch here.
export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

// Meta's Messenger Platform payload shape — shared by the "page" object
// (Messenger) and "instagram" object (Instagram Messaging via the
// Page-linked model); both deliver `entry[].messaging[]` with the same
// sender/recipient/message shape.
interface MessagingEvent {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    is_echo?: boolean
    attachments?: Array<{ type?: string; payload?: { url?: string } }>
  }
}

interface WebhookEntry {
  id?: string // the Page ID (or IG-linked Page ID) the event is for
  messaging?: MessagingEvent[]
}

interface WebhookBody {
  object?: string
  entry?: WebhookEntry[]
}

// GET — webhook verification, same loop-all-configs-and-match pattern as
// the WhatsApp handler (each account brings its own Meta app credentials).
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
    }

    const { data: configs, error } = await supabaseAdmin()
      .from('social_channel_config')
      .select('id, verify_token')

    if (error || !configs) {
      console.error('[social webhook] error fetching configs for verification:', error)
      return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
    }

    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          return new Response(challenge, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          })
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  } catch (error) {
    console.error('[social webhook] error in GET verification:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST — receive messages
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[social webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: WebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ack Meta immediately, process after — same rationale as the WhatsApp
  // webhook: a slow ack triggers Meta retries + duplicate inserts, and a
  // floating (non-`after()`) promise isn't guaranteed to finish on a
  // serverless runtime once the response is sent.
  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('[social webhook] error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: WebhookBody) {
  const channel: SocialChannel | null =
    body.object === 'instagram' ? 'instagram' : body.object === 'page' ? 'messenger' : null
  if (!channel || !body.entry) return

  for (const entry of body.entry) {
    const pageId = entry.id
    if (!pageId || !entry.messaging) continue

    const { data: config, error: configError } = await supabaseAdmin()
      .from('social_channel_config')
      .select('*')
      .eq('channel', channel)
      .eq('page_id', pageId)
      .maybeSingle()

    if (configError) {
      console.error('[social webhook] error fetching config for page_id:', pageId, configError)
      continue
    }
    if (!config) {
      console.error(`[social webhook] no ${channel} config found for page_id:`, pageId)
      continue
    }

    for (const event of entry.messaging) {
      await processMessagingEvent(event, channel, config)
    }
  }
}

// Meta's Messenger/Instagram attachment `type` values mapped onto the
// messages.content_type CHECK constraint (migration 001 + 010:
// text, image, document, audio, video, location, template, interactive).
// Anything unmapped (template, fallback, story_mention, ...) falls back
// to 'text' with a placeholder — same spirit as the WhatsApp webhook's
// "[Unsupported message type]" fallback.
const ATTACHMENT_TYPE_MAP: Record<string, string> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
  file: 'document',
  location: 'location',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processMessagingEvent(event: MessagingEvent, channel: SocialChannel, config: any) {
  // Echoes are our own outbound messages bouncing back through the same
  // webhook subscription — not a customer message, and already persisted
  // by the send path. Skip them or every reply would double itself.
  if (event.message?.is_echo) return

  const senderId = event.sender?.id
  const message = event.message
  if (!senderId || !message) return

  const attachment = message.attachments?.[0]
  const mediaUrl = attachment?.payload?.url ?? null
  const contentType = message.text
    ? 'text'
    : (attachment?.type && ATTACHMENT_TYPE_MAP[attachment.type]) || 'text'

  let contentText = message.text || (attachment ? `[${attachment.type || 'attachment'}]` : null)

  // Same rationale as the WhatsApp webhook: Messenger/Instagram voice
  // messages carry no text of their own, and Claude has no audio-input
  // API — a shared transcription step at ingestion time is what makes
  // audio work the same for every provider, and it's a bonus for the
  // human inbox view too (no more blank bubble under the audio player).
  if (contentType === 'audio' && mediaUrl) {
    try {
      const { key: openAiKey } = await loadEmbeddingsKey(supabaseAdmin(), config.account_id)
      if (openAiKey) {
        const audioRes = await fetch(mediaUrl)
        if (audioRes.ok) {
          const buffer = Buffer.from(await audioRes.arrayBuffer())
          const mimeType = audioRes.headers.get('content-type') || 'audio/mpeg'
          contentText = await transcribeAudio(openAiKey, buffer, mimeType)
        } else {
          contentText = '[Nota de voz]'
        }
      } else {
        contentText = '[Nota de voz]'
      }
    } catch (err) {
      console.error('[social webhook] audio transcription failed:', err)
      contentText = '[Nota de voz]'
    }
  }

  if (!contentText) return

  const contactOutcome = await findOrCreateSocialContact(
    config.account_id,
    config.created_by,
    channel,
    senderId,
    senderId,
  )
  if (!contactOutcome) return

  const conversationOutcome = await findOrCreateSocialConversation(
    config.account_id,
    config.created_by,
    channel,
    contactOutcome.contact.id,
  )
  if (!conversationOutcome) return

  const { error: msgErr } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversationOutcome.conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.mid ?? null,
    status: 'delivered',
  })
  if (msgErr) {
    console.error('[social webhook] error inserting message:', msgErr)
    return
  }

  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText,
      last_message_at: new Date().toISOString(),
      unread_count: (conversationOutcome.conversation.unread_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationOutcome.conversation.id)

  // v1 scope: AI auto-reply only — no Flows/Automations dispatch for
  // Instagram/Messenger yet (see plan).
  await dispatchInboundToAiReply({
    accountId: config.account_id,
    conversationId: conversationOutcome.conversation.id,
    contactId: contactOutcome.contact.id,
    configOwnerUserId: config.created_by,
  })
}
