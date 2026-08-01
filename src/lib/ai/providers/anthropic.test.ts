import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateAnthropic } from './anthropic'

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
  model: 'claude-sonnet-5',
  systemPrompt: 'Be helpful.',
  timeoutMs: 5000,
  temperature: 0.2,
}

describe('generateAnthropic content blocks', () => {
  it('sends a plain string for a text-only turn', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: 'hi' }] }))
    vi.stubGlobal('fetch', fetchSpy)

    await generateAnthropic({ ...baseArgs, messages: [{ role: 'user', content: 'hola' }] })

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hola' })
  })

  it('sends text + base64 image blocks for an image turn', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchSpy)

    await generateAnthropic({
      ...baseArgs,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'mira esto' },
            { type: 'image', mimeType: 'image/png', data: 'BBBB' },
          ],
        },
      ],
    })

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'mira esto' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
      ],
    })
  })
})
