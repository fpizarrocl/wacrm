// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'gemini'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  /** Sampling temperature, clamped to [0, 1] — the range valid across
   *  all three providers (Anthropic caps at 1; OpenAI/Gemini allow up
   *  to 2 but 0–1 is the useful range for an on-brand support bot). */
  temperature: number
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
}

/** One piece of a multimodal turn — plain text, an inlined image, or
 *  (Gemini only — the one provider with native audio understanding)
 *  an inlined voice note. OpenAI/Anthropic never see an 'audio' part:
 *  their ingestion path transcribes with Whisper instead (see
 *  src/lib/ai/transcribe.ts) since Anthropic has no audio-input API
 *  at all and one shared behavior per non-Gemini provider is simpler
 *  than a per-provider audio story. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'audio'; mimeType: string; data: string }

/** A single conversation turn in the shape all three providers accept.
 *  `content` is a plain string for ordinary text turns, or an array of
 *  parts when the turn carries an inlined image (see `src/lib/ai/media.ts`). */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
}

/** The text of a turn, for callers that only care about words (KB
 *  retrieval query, the handoff summary quote) — an image-only turn
 *  has no caption text and yields ''. */
export function contentText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

/**
 * A function the model can call mid-reply (migration 042 — connected
 * Google Sheets). Translated into each provider's own wire format by
 * its adapter (`providers/{openai,anthropic,gemini}.ts`); `parameters`
 * is a JSON Schema object, the one shape all three accept.
 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
}

/** Executes a tool call by name and returns its result as text —
 *  never throws; failures are returned as a readable error string so
 *  the model can tell the customer it couldn't look something up. */
export type ExecuteTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
