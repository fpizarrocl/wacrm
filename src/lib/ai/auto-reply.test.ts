import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  engineSendInteractiveCtaUrl: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  engineSendInteractiveCtaUrl: h.engineSendInteractiveCtaUrl,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'ai_tools') {
        // .select().eq('account_id').eq('is_active') → connected tools
        // (loadAiTools). Empty by default — no test in this file
        // configures any tools, so generateReply should see tools: [].
        const chain = {
          select: () => chain,
          eq: () => chain,
          then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
            resolve({ data: [], error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    temperature: 1,
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    autoReplyResetHours: 0,
    handoffAgentId: null,
    embeddingsApiKey: null,
    quickLinks: [],
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, linkKeys: [] })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.engineSendInteractiveCtaUrl.mockResolvedValue({ whatsapp_message_id: 'm2' })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3, reset_after_hours: null },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('passes reset_after_hours to the atomic claim (null when auto-reset is off)', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'claim_ai_reply_slot',
      args: expect.objectContaining({ reset_after_hours: null }),
    })
  })

  it('still skips a capped conversation when the reset window has not expired yet', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyResetHours: 24 }))
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
      ai_reply_window_started_at: new Date().toISOString(),
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('lets a capped conversation reply again once its reset window has expired', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyResetHours: 24 }))
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
      ai_reply_window_started_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'claim_ai_reply_slot',
      args: expect.objectContaining({ reset_after_hours: 24 }),
    })
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  it('sends the model-written text to the customer before pausing, on handoff', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Let me look into that and get back to you.',
      handoff: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        text: 'Let me look into that and get back to you.',
        aiGenerated: true,
      }),
    )
    expect(h.state.rpcCalls).toHaveLength(0) // no reply-slot claim on handoff
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })
})

describe('dispatchInboundToAiReply — quick links', () => {
  const QUICK_LINKS = [
    { key: 'maps', label: 'Cómo llegar', url: 'https://maps.example.com/x' },
    { key: 'booking', label: 'Reservar', url: 'https://booking.example.com' },
  ]

  it('sends a CTA-URL message per link key the model emitted, after the text reply', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ quickLinks: QUICK_LINKS }))
    h.generateReply.mockResolvedValue({
      text: 'Here you go!',
      handoff: false,
      linkKeys: ['maps', 'booking'],
    })
    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Here you go!' }),
    )
    expect(h.engineSendInteractiveCtaUrl).toHaveBeenCalledTimes(2)
    expect(h.engineSendInteractiveCtaUrl).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        conversationId: 'conv-1',
        contactId: 'contact-1',
        displayText: 'Cómo llegar',
        url: 'https://maps.example.com/x',
      }),
    )
    expect(h.engineSendInteractiveCtaUrl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        displayText: 'Reservar',
        url: 'https://booking.example.com',
      }),
    )
  })

  it('ignores a link key the model invented that is not configured', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ quickLinks: QUICK_LINKS }))
    h.generateReply.mockResolvedValue({
      text: 'Here you go!',
      handoff: false,
      linkKeys: ['maps', 'made-up'],
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendInteractiveCtaUrl).toHaveBeenCalledTimes(1)
    expect(h.engineSendInteractiveCtaUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://maps.example.com/x' }),
    )
  })

  it('does not send any link when the account has none configured, even if the model emits a key', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Here you go!',
      handoff: false,
      linkKeys: ['maps'],
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendInteractiveCtaUrl).not.toHaveBeenCalled()
  })

  it('keeps sending the rest of the links when one fails', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ quickLinks: QUICK_LINKS }))
    h.generateReply.mockResolvedValue({
      text: 'Here you go!',
      handoff: false,
      linkKeys: ['maps', 'booking'],
    })
    h.engineSendInteractiveCtaUrl.mockRejectedValueOnce(new Error('Meta 500'))
    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()
    expect(h.engineSendInteractiveCtaUrl).toHaveBeenCalledTimes(2)
  })
})
