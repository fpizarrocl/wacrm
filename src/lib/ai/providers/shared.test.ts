import { describe, it, expect } from 'vitest'
import { mergeConsecutive } from './shared'

describe('mergeConsecutive', () => {
  it('joins consecutive same-role plain-text turns with a blank line', () => {
    const out = mergeConsecutive([
      { role: 'user', content: 'hola' },
      { role: 'user', content: 'como estas' },
    ])
    expect(out).toEqual([{ role: 'user', content: 'hola\n\ncomo estas' }])
  })

  it('normalizes to ContentPart[] when either side carries an image', () => {
    const out = mergeConsecutive([
      { role: 'user', content: 'mira esto' },
      { role: 'user', content: [{ type: 'image', mimeType: 'image/jpeg', data: 'AAAA' }] },
    ])
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'mira esto' },
          { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
        ],
      },
    ])
  })

  it('does not merge across different roles', () => {
    const out = mergeConsecutive([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'hey' },
    ])
    expect(out).toEqual([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: 'hey' },
    ])
  })
})
