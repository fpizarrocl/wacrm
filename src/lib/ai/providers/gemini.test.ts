import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateGemini } from './gemini'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const baseArgs = {
  apiKey: 'key-1',
  model: 'gemini-3.1-flash-lite',
  systemPrompt: 'Be helpful.',
  timeoutMs: 5000,
  temperature: 0.2,
}

describe('generateGemini content parts', () => {
  it('sends a text part for a text-only turn', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await generateGemini({ ...baseArgs, messages: [{ role: 'user', content: 'hola' }] })

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hola' }] })
  })

  it('sends text + inlineData parts for an image turn', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await generateGemini({
      ...baseArgs,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'mira esto' },
            { type: 'image', mimeType: 'image/webp', data: 'CCCC' },
          ],
        },
      ],
    })

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.contents[0]).toEqual({
      role: 'user',
      parts: [{ text: 'mira esto' }, { inlineData: { mimeType: 'image/webp', data: 'CCCC' } }],
    })
  })

  it('sends inlineData for a voice-note turn — Gemini understands audio natively', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await generateGemini({
      ...baseArgs,
      messages: [
        {
          role: 'user',
          content: [{ type: 'audio', mimeType: 'audio/ogg', data: 'DDDD' }],
        },
      ],
    })

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.contents[0]).toEqual({
      role: 'user',
      parts: [{ inlineData: { mimeType: 'audio/ogg', data: 'DDDD' } }],
    })
  })
})
