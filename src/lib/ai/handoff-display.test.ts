import { describe, it, expect } from 'vitest'
import { formatHandoffSummary, parseHandoffSummary } from './handoff-display'

// Minimal stand-in for next-intl's `useTranslations` return value,
// covering only the keys `formatHandoffSummary` actually calls —
// mirrors the real `HandoffSummary` messages closely enough to catch
// wiring bugs without pulling in the full i18n stack.
function fakeT(key: string, values?: Record<string, string | number>): string {
  switch (key) {
    case 'categoryPrefix':
      return `[${values?.category}] `
    case 'repliesCount': {
      const count = Number(values?.count)
      if (count === 0) return '🤖 AI agent handed off without replying.'
      if (count === 1) return '🤖 AI agent handed off after 1 reply.'
      return `🤖 AI agent handed off after ${count} replies.`
    }
    case 'lastMessage':
      return ` Last customer message: "${values?.quote}"`
    default:
      return key
  }
}

describe('formatHandoffSummary', () => {
  it('renders reply count and quoted last message', () => {
    const text = formatHandoffSummary(fakeT, { replyCount: 2, lastCustomerMessage: 'refund please' })
    expect(text).toBe('🤖 AI agent handed off after 2 replies. Last customer message: "refund please"')
  })

  it('renders the "without replying" form for a zero count', () => {
    const text = formatHandoffSummary(fakeT, { replyCount: 0, lastCustomerMessage: null })
    expect(text).toBe('🤖 AI agent handed off without replying.')
  })

  it('prepends the category prefix when present', () => {
    const text = formatHandoffSummary(fakeT, {
      replyCount: 1,
      lastCustomerMessage: 'quiero un reclamo',
      categoryLabel: 'Reclamos',
    })
    expect(text).toBe(
      '[Reclamos] 🤖 AI agent handed off after 1 reply. Last customer message: "quiero un reclamo"',
    )
  })

  it('omits the quote clause when there is no last customer message', () => {
    const text = formatHandoffSummary(fakeT, { replyCount: 3, lastCustomerMessage: null })
    expect(text).toBe('🤖 AI agent handed off after 3 replies.')
  })
})

describe('parseHandoffSummary', () => {
  it('parses a JSON-encoded HandoffSummaryData', () => {
    const raw = JSON.stringify({ replyCount: 2, lastCustomerMessage: 'hi', categoryLabel: 'Reclamos' })
    expect(parseHandoffSummary(raw)).toEqual({
      replyCount: 2,
      lastCustomerMessage: 'hi',
      categoryLabel: 'Reclamos',
    })
  })

  it('returns null for a pre-migration plain-English summary', () => {
    expect(parseHandoffSummary('🤖 AI agent handed off after 2 replies.')).toBeNull()
  })

  it('returns null for null/undefined/empty input', () => {
    expect(parseHandoffSummary(null)).toBeNull()
    expect(parseHandoffSummary(undefined)).toBeNull()
    expect(parseHandoffSummary('')).toBeNull()
  })

  it('returns null for valid JSON that is not shaped like HandoffSummaryData', () => {
    expect(parseHandoffSummary(JSON.stringify({ foo: 'bar' }))).toBeNull()
    expect(parseHandoffSummary(JSON.stringify('just a string'))).toBeNull()
  })
})
