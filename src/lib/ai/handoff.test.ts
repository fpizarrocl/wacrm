import { describe, it, expect } from 'vitest'
import { buildHandoffData } from './handoff'

describe('buildHandoffData', () => {
  it('captures the reply count and the last customer message', () => {
    const data = buildHandoffData({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'I want a refund' },
      ],
      replyCount: 2,
    })
    expect(data).toEqual({ replyCount: 2, lastCustomerMessage: 'I want a refund' })
  })

  it('carries replyCount 0 when the bot bailed on the first inbound', () => {
    const data = buildHandoffData({
      messages: [{ role: 'user', content: 'agent please' }],
      replyCount: 0,
    })
    expect(data.replyCount).toBe(0)
    expect(data.lastCustomerMessage).toBe('agent please')
  })

  it('picks the most recent customer turn, ignoring assistant turns', () => {
    const data = buildHandoffData({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a reply' },
      ],
      replyCount: 1,
    })
    expect(data.lastCustomerMessage).toBe('second')
  })

  it('collapses whitespace and truncates a long message', () => {
    const long = 'x'.repeat(300)
    const data = buildHandoffData({
      messages: [{ role: 'user', content: long }],
      replyCount: 0,
    })
    expect(data.lastCustomerMessage).toContain('…')
    expect(data.lastCustomerMessage!.length).toBeLessThan(200)
  })

  it('sets lastCustomerMessage to null when there is no customer message', () => {
    const data = buildHandoffData({
      messages: [{ role: 'assistant', content: 'greeting' }],
      replyCount: 0,
    })
    expect(data).toEqual({ replyCount: 0, lastCustomerMessage: null })
  })

  it('includes categoryLabel only when the handoff matched a category', () => {
    const withCategory = buildHandoffData({
      messages: [{ role: 'user', content: 'quiero hacer un reclamo' }],
      replyCount: 1,
      categoryLabel: 'Reclamos',
    })
    expect(withCategory.categoryLabel).toBe('Reclamos')

    const without = buildHandoffData({
      messages: [{ role: 'user', content: 'hola' }],
      replyCount: 1,
    })
    expect(without).not.toHaveProperty('categoryLabel')
  })
})
