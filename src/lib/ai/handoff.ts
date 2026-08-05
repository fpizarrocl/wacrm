import { contentText, type ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering). `categoryLabel`,
 * when the handoff matched a configured escalation category (see
 * HANDOFF_SENTINEL_PATTERN in defaults.ts), is prepended so whoever
 * triages the queue sees the topic without opening the chat.
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
  categoryLabel?: string
}): string {
  const { messages, replyCount, categoryLabel } = args

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && contentText(m.content).trim())

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`

  const prefix = categoryLabel ? `[${categoryLabel}] ` : ''
  const base = `${prefix}🤖 AI agent handed off ${replies}.`

  if (!lastCustomer) return base

  const quote = truncate(contentText(lastCustomer.content).trim(), MAX_QUOTE_LEN)
  return `${base} Last customer message: “${quote}”`
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}
