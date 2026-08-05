import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import {
  clampTemperature,
  DEFAULT_TEMPERATURE,
  clampAutoReplyResetHours,
} from '@/lib/ai/defaults'
import {
  AiError,
  type AiProvider,
  type QuickLink,
  type EscalationCategory,
} from '@/lib/ai/types'
import { INTERACTIVE_LIMITS } from '@/lib/whatsapp/meta-api'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

const QUICK_LINK_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/
const MAX_QUICK_LINKS = 10

/**
 * Validate + normalize the account's quick-link buttons (Settings →
 * Agente IA — see `src/lib/ai/auto-reply.ts` / `defaults.ts`). `key` is
 * what the model references via the `[[LINK:<key>]]` sentinel; `label`
 * becomes a WhatsApp CTA-URL button's visible text, so it shares Meta's
 * `buttonTitleMaxLength` (20 chars) limit.
 *
 * Absent `raw` (form didn't send the field) → `[]`, same "leave it
 * empty" default as a brand-new config. Anything malformed → an error
 * string the route surfaces as a 400 before touching the DB.
 */
function parseQuickLinks(raw: unknown): QuickLink[] | { error: string } {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return { error: 'quick_links must be an array' }
  if (raw.length > MAX_QUICK_LINKS) {
    return { error: `quick_links allows at most ${MAX_QUICK_LINKS} links` }
  }
  const seen = new Set<string>()
  const links: QuickLink[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { error: 'Each quick link must be an object' }
    }
    const record = item as Record<string, unknown>
    const key = typeof record.key === 'string' ? record.key.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const url = typeof record.url === 'string' ? record.url.trim() : ''

    if (!key || !QUICK_LINK_KEY_PATTERN.test(key)) {
      return {
        error: `Quick link key "${key}" must be non-empty and contain only letters, numbers, "_" or "-"`,
      }
    }
    if (seen.has(key)) return { error: `Duplicate quick link key "${key}"` }
    seen.add(key)

    if (!label) return { error: 'Every quick link needs a label' }
    if (label.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      return {
        error: `Quick link label "${label}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} characters`,
      }
    }

    if (!url) return { error: 'Every quick link needs a url' }
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: `Quick link url "${url}" must be http(s)` }
      }
    } catch {
      return { error: `Quick link url "${url}" is not a valid URL` }
    }

    links.push({ key, label, url })
  }
  return links
}

const ESCALATION_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/
const MAX_ESCALATION_CATEGORIES = 10

/**
 * Validate + normalize the account's escalation categories (Settings →
 * Agente IA — see `src/lib/ai/auto-reply.ts` / `defaults.ts`). `key` is
 * what the model references via the `[[HANDOFF:<key>]]` sentinel;
 * `tagId` must reference an existing tag in this account (checked in
 * one round-trip below — this is the one field `parseQuickLinks`
 * doesn't need to touch the DB for); `closingPhrase` is sent to the
 * customer verbatim, never written by the model, so it's required
 * up front rather than falling back to anything.
 *
 * Absent `raw` → `[]`, same "leave it empty" default as quick links.
 */
async function parseEscalationCategories(
  raw: unknown,
  accountId: string,
  supabase: SupabaseClient,
): Promise<EscalationCategory[] | { error: string }> {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return { error: 'escalation_categories must be an array' }
  if (raw.length > MAX_ESCALATION_CATEGORIES) {
    return {
      error: `escalation_categories allows at most ${MAX_ESCALATION_CATEGORIES} categories`,
    }
  }
  const seen = new Set<string>()
  const categories: EscalationCategory[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { error: 'Each escalation category must be an object' }
    }
    const record = item as Record<string, unknown>
    const key = typeof record.key === 'string' ? record.key.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const tagId = typeof record.tagId === 'string' ? record.tagId.trim() : ''
    const closingPhrase =
      typeof record.closingPhrase === 'string' ? record.closingPhrase.trim() : ''

    if (!key || !ESCALATION_KEY_PATTERN.test(key)) {
      return {
        error: `Escalation category key "${key}" must be non-empty and contain only letters, numbers, "_" or "-"`,
      }
    }
    if (seen.has(key)) return { error: `Duplicate escalation category key "${key}"` }
    seen.add(key)

    if (!label) return { error: 'Every escalation category needs a name' }
    if (!tagId) return { error: `Escalation category "${label}" needs a tag` }
    if (!closingPhrase) {
      return { error: `Escalation category "${label}" needs a closing phrase` }
    }

    categories.push({ key, label, tagId, closingPhrase })
  }

  if (categories.length === 0) return categories

  const { data: tags, error } = await supabase
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .in(
      'id',
      categories.map((c) => c.tagId),
    )
  if (error) return { error: 'Could not verify escalation category tags' }
  const validIds = new Set((tags ?? []).map((t) => t.id as string))
  for (const c of categories) {
    if (!validIds.has(c.tagId)) {
      return { error: `Tag for escalation category "${c.label}" was not found in this account` }
    }
  }

  return categories
}

/**
 * GET /api/ai/config
 *
 * Any member may read the config so the inbox/settings can reflect
 * whether AI is set up. The encrypted key is NEVER returned — only a
 * `has_key` flag; the settings form shows a masked placeholder.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('ai_configs')
      // `api_key` is selected only to derive `has_key` — it is stripped
      // out below and never returned to the client.
      .select(
        'provider, model, temperature, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, auto_reply_reset_hours, handoff_agent_id, api_key, embeddings_api_key, quick_links, escalation_categories',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[ai/config GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load AI configuration' },
        { status: 500 },
      )
    }

    if (!data) return NextResponse.json({ configured: false })
    // The keys are selected only to derive the has_* flags; neither is
    // returned to the client.
    const { api_key, embeddings_api_key, ...safe } = data
    return NextResponse.json({
      configured: true,
      has_key: !!api_key,
      has_embeddings_key: !!embeddings_api_key,
      ...safe,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/config  (admin+)
 *
 * Upsert the account's AI config. Validates the key with the provider
 * before persisting (mirrors the WhatsApp config verifying with Meta
 * first), then stores the key AES-256-GCM-encrypted. When `api_key` is
 * omitted the existing stored key is reused (the form sends it only
 * when the user re-enters it).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const provider = body.provider as AiProvider
    if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'gemini') {
      return bad('provider must be "openai", "anthropic", or "gemini"')
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad('model is required')

    const temperature =
      body.temperature === undefined
        ? DEFAULT_TEMPERATURE
        : clampTemperature(Number(body.temperature))

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null
    const isActive = body.is_active === true
    const autoReplyEnabled = body.auto_reply_enabled === true

    let maxPer = Number(body.auto_reply_max_per_conversation)
    if (!Number.isFinite(maxPer)) maxPer = 3
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)))

    const resetHours = clampAutoReplyResetHours(Number(body.auto_reply_reset_hours))

    const quickLinksResult = parseQuickLinks(body.quick_links)
    if ('error' in quickLinksResult) return bad(quickLinksResult.error)
    const quickLinks = quickLinksResult

    const escalationCategoriesResult = await parseEscalationCategories(
      body.escalation_categories,
      accountId,
      supabase,
    )
    if ('error' in escalationCategoriesResult) return bad(escalationCategoriesResult.error)
    const escalationCategories = escalationCategoriesResult

    // Handoff routing target for auto-reply. A non-empty string must be a
    // member of this account (else the conversation would be assigned to a
    // stranger); an empty string / null means "leave unassigned" (the
    // shared queue). Absent → left unchanged on update below.
    const rawHandoff =
      typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
    const handoffProvided = 'handoff_agent_id' in body
    let handoffAgentId: string | null = null
    if (rawHandoff) {
      const { data: member } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('user_id', rawHandoff)
        .maybeSingle()
      if (!member) return bad('handoff_agent_id must be a member of this account')
      handoffAgentId = rawHandoff
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

    // Embeddings key (optional, for semantic KB search): a non-empty
    // string sets/replaces it; an explicit null clears it; absent leaves
    // it unchanged. The form only sends it when the admin edits it.
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null

    // Reuse the stored key when the form didn't send a fresh one.
    const { data: existing } = await supabase
      .from('ai_configs')
      .select('id, provider, model, api_key')
      .eq('account_id', accountId)
      .maybeSingle()

    let apiKeyPlain: string
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing?.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return bad('Stored API key could not be decrypted — re-enter your key.')
      }
    } else {
      return bad('api_key is required')
    }

    // Only spend a provider round-trip when the credentials that affect
    // reachability actually changed. A save that just flips a toggle or
    // edits the system prompt on an existing, already-validated config
    // skips the call — no wasted token/latency on the account's key.
    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      provider !== existing.provider ||
      model !== existing.model

    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          temperature,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          autoReplyResetHours: resetHours,
          handoffAgentId: null,
          embeddingsApiKey: null,
          quickLinks: [],
          escalationCategories: [],
        })
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] validation error:', err)
        return bad('Could not validate the API key with the provider.')
      }
    }

    // Validate a new embeddings key before storing (a cheap 1-input
    // embed), same "verify before save" discipline as the chat key.
    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'])
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] embeddings validation error:', err)
        return bad('Could not validate the embeddings key.')
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null
    const shared: Record<string, unknown> = {
      provider,
      model,
      temperature,
      system_prompt: systemPrompt,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPer,
      auto_reply_reset_hours: resetHours,
      quick_links: quickLinks,
      escalation_categories: escalationCategories,
    }
    // Only touch the handoff target when the form actually sent the field,
    // so a partial save (e.g. flipping a toggle) doesn't wipe it.
    if (handoffProvided) shared.handoff_agent_id = handoffAgentId
    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey)
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null
    }

    if (existing) {
      const { error: upErr } = await supabase
        .from('ai_configs')
        .update(encryptedKey ? { ...shared, api_key: encryptedKey } : shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[ai/config POST] update error:', upErr)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    } else {
      const { error: insErr } = await supabase.from('ai_configs').insert({
        account_id: accountId,
        created_by: userId,
        api_key: encryptedKey, // guaranteed non-null: rawKey required when no existing row
        ...shared,
      })
      if (insErr) {
        console.error('[ai/config POST] insert error:', insErr)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/config  (admin+)
 *
 * Removes the account's AI config (turns everything off and forgets the
 * key). Also used to recover from a corrupted encrypted key.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('ai_configs')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/config DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete AI configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
