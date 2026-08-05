import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { loadAiTools } from '@/lib/ai/load-tools'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { latestUserMessage } from '@/lib/ai/query'
import { transcribeAudio } from '@/lib/ai/transcribe'
import { AiError, type ChatMessage, type ContentPart } from '@/lib/ai/types'

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

// Same ceiling as MAX_IMAGE_BYTES in src/lib/ai/media.ts / Whisper's own
// file-size cap — the client already blocks bigger picks, this is the
// server-side backstop.
const MAX_ATTACHMENT_BYTES = 5_000_000

interface RawAttachment {
  kind: 'image' | 'audio'
  mimeType: string
  /** base64, no `data:` prefix. */
  data: string
}

interface RawTurn {
  role: 'user' | 'assistant'
  content: string
  attachment?: RawAttachment
}

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * exact same path the auto-reply bot uses — knowledge-base retrieval +
 * `auto_reply` system prompt + the configured provider — so what you see
 * here is what a real customer would get. Reads the config even when the
 * master switch is off (requireActive:false) so you can try it before
 * going live. Stateless: the client sends the running transcript each turn.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 })
    }

    // Playground input is a text box + an optional attach button — a
    // turn is valid with just an attachment (no typed caption), so the
    // content-required check below only applies when there's no attachment.
    const rawTurns: RawTurn[] = rawMessages
      .filter((m: unknown): m is RawTurn => {
        if (!m || typeof m !== 'object') return false
        const { role, content, attachment } = m as {
          role?: unknown
          content?: unknown
          attachment?: unknown
        }
        if (role !== 'user' && role !== 'assistant') return false
        if (typeof content !== 'string') return false
        if (attachment !== undefined) {
          if (!attachment || typeof attachment !== 'object') return false
          const a = attachment as { kind?: unknown; mimeType?: unknown; data?: unknown }
          if (
            (a.kind !== 'image' && a.kind !== 'audio') ||
            typeof a.mimeType !== 'string' ||
            typeof a.data !== 'string'
          ) {
            return false
          }
          // Base64 inflates by ~4/3 — this is an approximation, good
          // enough as a sanity backstop.
          if (a.data.length > MAX_ATTACHMENT_BYTES * 1.4) return false
          return true
        }
        return content.trim().length > 0
      })
      .slice(-MAX_TURNS)

    if (rawTurns.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to test the agent.' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    // Fail loudly on the turn actually being sent right now — rather
    // than let a confusing "[Nota de voz — configura...]" placeholder
    // silently reach the model, which just produces a generic "I can't
    // process audio" reply that looks like a bug. Only applies to
    // OpenAI/Anthropic — Gemini understands audio natively below, no
    // key required at all. Older audio turns already in the history
    // still degrade gracefully further down — only the newest turn
    // blocks the request.
    const newestTurn = rawTurns[rawTurns.length - 1]
    if (
      newestTurn.attachment?.kind === 'audio' &&
      config.provider !== 'gemini' &&
      !config.embeddingsApiKey
    ) {
      return NextResponse.json(
        {
          error:
            'Para probar notas de voz con OpenAI o Anthropic, agrega tu "Clave de embeddings" (OpenAI) en Setup — se usa para transcribir el audio con Whisper. (Gemini no la necesita, entiende audio directamente.)',
          code: 'no_transcription_key',
        },
        { status: 400 },
      )
    }

    // Resolve attachments. Image turns become a ContentPart[] (text +
    // inline base64) for the providers' vision input — supported
    // natively by all three. Audio turns: Gemini also understands audio
    // natively, so its bytes go straight into a ContentPart too, no key
    // needed; OpenAI/Anthropic have no such path (Claude has no
    // audio-input API at all), so those are transcribed to plain text
    // with Whisper instead, reusing the same OpenAI-only embeddings key
    // already used for KB search (see src/lib/ai/transcribe.ts).
    const messages: ChatMessage[] = []
    for (const t of rawTurns) {
      if (!t.attachment) {
        messages.push({ role: t.role, content: t.content })
        continue
      }
      if (t.attachment.kind === 'image') {
        const parts: ContentPart[] = [
          { type: 'image', mimeType: t.attachment.mimeType, data: t.attachment.data },
        ]
        if (t.content.trim()) parts.unshift({ type: 'text', text: t.content.trim() })
        messages.push({ role: t.role, content: parts })
        continue
      }
      // audio
      if (config.provider === 'gemini') {
        const parts: ContentPart[] = [
          { type: 'audio', mimeType: t.attachment.mimeType, data: t.attachment.data },
        ]
        if (t.content.trim()) parts.unshift({ type: 'text', text: t.content.trim() })
        messages.push({ role: t.role, content: parts })
        continue
      }
      if (!config.embeddingsApiKey) {
        messages.push({ role: t.role, content: '[Nota de voz — configura una clave de OpenAI en "Clave de embeddings" para transcribirla]' })
        continue
      }
      try {
        const transcript = await transcribeAudio(
          config.embeddingsApiKey,
          Buffer.from(t.attachment.data, 'base64'),
          t.attachment.mimeType,
        )
        messages.push({ role: t.role, content: transcript })
      } catch (err) {
        console.error('[ai/playground] audio transcription failed:', err)
        messages.push({ role: t.role, content: '[Nota de voz — no se pudo transcribir]' })
      }
    }

    const knowledge = await retrieveKnowledge(
      supabase,
      accountId,
      config,
      latestUserMessage(messages),
    )
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      escalationCategories: config.escalationCategories,
    })

    const { definitions: tools, executeTool } = await loadAiTools(supabase, accountId)

    const { text, handoff, handoffCategory } = await generateReply({
      config,
      systemPrompt,
      messages,
      tools,
      executeTool,
    })

    // Mirror what a real customer would actually receive: a categorized
    // handoff never sends the model's own text (auto-reply.ts sends the
    // category's fixed closingPhrase instead, so the admin-written
    // phrase can never drift into something the model paraphrased).
    // Preview-only — unlike auto-reply.ts, this never applies the
    // category's tag; the Playground never sends or stores anything.
    const category = handoffCategory
      ? config.escalationCategories.find((c) => c.key === handoffCategory)
      : undefined
    const reply = category ? category.closingPhrase : text

    return NextResponse.json({ reply, handoff })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
