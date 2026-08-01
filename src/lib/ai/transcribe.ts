// ============================================================
// Voice-note transcription (OpenAI Whisper) — runs once at inbound
// ingestion time (WhatsApp + Instagram/Messenger webhooks), not on
// every AI generation call. The transcript becomes the message's
// normal `content_text`, so it flows through the existing text
// pipeline unchanged (inbox display AND buildConversationContext both
// benefit for free) and needs no provider-specific audio handling —
// Claude has no audio-input API at all, so a shared transcription step
// is the only approach that works the same for every provider.
//
// Reuses the account's `embeddings_api_key` (ai_configs table) — an
// OpenAI-compatible key already kept separate from the main provider
// key for the knowledge base's semantic search, same trust boundary.
// ============================================================

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions'

interface WhisperResponse {
  text?: string
  error?: { message?: string }
}

/**
 * Transcribe an audio buffer with OpenAI Whisper. Throws on failure —
 * callers should catch and fall back to a placeholder rather than
 * fail the whole webhook delivery over a transcription error.
 */
export async function transcribeAudio(
  openAiKey: string,
  buffer: Buffer,
  mimeType: string,
  filename = 'audio',
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename)
  form.append('model', 'whisper-1')

  const response = await fetch(WHISPER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openAiKey}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  })

  const data = ((await response.json().catch(() => null)) as WhisperResponse | null) ?? {}
  if (!response.ok) {
    throw new Error(data.error?.message || `Whisper API error: ${response.status}`)
  }
  if (!data.text) {
    throw new Error('Whisper returned no transcript')
  }
  return data.text.trim()
}
