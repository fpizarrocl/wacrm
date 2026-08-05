import type { HandoffSummaryData } from './handoff'

/**
 * `conversations.ai_handoff_summary` is stored as JSON (see
 * `buildHandoffData` in `handoff.ts`) so it can be rendered in the
 * viewer's own locale — parse it back here. Rows written before this
 * migration (or a corrupt value) hold plain English text instead;
 * those aren't valid JSON, so this returns null and callers fall back
 * to showing the raw string as-is.
 */
export function parseHandoffSummary(
  raw: string | null | undefined,
): HandoffSummaryData | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'replyCount' in parsed) {
      return parsed as HandoffSummaryData
    }
    return null
  } catch {
    return null
  }
}

/**
 * Render a `HandoffSummaryData` as the one-line note shown in the
 * inbox banner and the notifications list — e.g. "[Complaints] 🤖 AI
 * agent handed off after 2 replies. Last customer message: “…”".
 * `t` must be scoped to the `HandoffSummary` message namespace (used
 * identically from `AiThreadBanner` and the notifications page, so the
 * two surfaces can't drift in wording).
 */
export function formatHandoffSummary(
  t: (key: string, values?: Record<string, string | number>) => string,
  data: HandoffSummaryData,
): string {
  const prefix = data.categoryLabel
    ? t('categoryPrefix', { category: data.categoryLabel })
    : ''
  const replies = t('repliesCount', { count: data.replyCount })
  const quote = data.lastCustomerMessage
    ? t('lastMessage', { quote: data.lastCustomerMessage })
    : ''
  return `${prefix}${replies}${quote}`
}
