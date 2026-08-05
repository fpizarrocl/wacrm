import { contentText, type ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/**
 * Structured data behind the short internal note the auto-reply bot
 * leaves on a conversation when it hands off to a human. Deterministic
 * — composed from context we already have (no extra LLM call / token
 * spend), so it can't fail or add latency to the handoff.
 *
 * Stored as JSON (in `conversations.ai_handoff_summary`, still a TEXT
 * column) rather than a pre-rendered English sentence, so the UI can
 * render it in the *viewer's* locale at display time — see
 * `handoff-display.ts` for the formatter, used by both the inbox
 * banner and the notifications page. The `on_ai_handoff_queue` /
 * `notify_conversation_assigned` triggers (migrations 039/053) also
 * parse this JSON to build `notifications.data`.
 */
export interface HandoffSummaryData {
  /** The bot's auto-reply tally for the thread (0 when it bailed on
   *  the very first inbound without answering). */
  replyCount: number
  /** Last thing the customer said, truncated — null when there's no
   *  customer turn at all. */
  lastCustomerMessage: string | null
  /** Set when the handoff matched a configured escalation category
   *  (see HANDOFF_SENTINEL_PATTERN in defaults.ts), so whoever triages
   *  the queue sees the topic without opening the chat. */
  categoryLabel?: string
}

export function buildHandoffData(args: {
  messages: ChatMessage[]
  replyCount: number
  categoryLabel?: string
}): HandoffSummaryData {
  const { messages, replyCount, categoryLabel } = args

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && contentText(m.content).trim())

  return {
    replyCount,
    lastCustomerMessage: lastCustomer
      ? truncate(contentText(lastCustomer.content).trim(), MAX_QUOTE_LEN)
      : null,
    ...(categoryLabel ? { categoryLabel } : {}),
  }
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}
