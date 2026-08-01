import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateOpenAi } from './openai'

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
  model: 'gpt-5',
  systemPrompt: 'Be helpful.',
  timeoutMs: 5000,
  temperature: 0.2,
}

describe('generateOpenAi content blocks', () => {
  it('sends a plain string for a text-only turn', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'hi there' } }] }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await generateOpenAi({
      ...baseArgs,
      messages: [{ role: 'user', content: 'hola' }],
    })

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hola' })
  })

  it('sends a text+image_url content array for an image turn', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'nice photo' } }] }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await generateOpenAi({
      ...baseArgs,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'mira esto' },
            { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
          ],
        },
      ],
    })

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'mira esto' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      ],
    })
  })
})
