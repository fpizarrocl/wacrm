import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt, isAutoReplyWindowExpired } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { loadAiTools } from './load-tools'
import { engineSendText, engineSendInteractiveCtaUrl } from '@/lib/flows/meta-send'
import { sendSocialReplyText } from '@/lib/social/reply'
import type { SocialChannel } from '@/lib/social/inbound'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'

export interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta phone_number_id — only needed when typingIndicatorEnabled. */
  phoneNumberId?: string
  /** Decrypted Meta access token — only needed when typingIndicatorEnabled. */
  accessToken?: string
  /** Show the "escribiendo..." bubble while this reply is generated. */
  typingIndicatorEnabled?: boolean
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select(
        'assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_reply_window_started_at, channel, status',
      )
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap+reset check is the atomic
    // claim below (this read can race a concurrent inbound). Mirrors
    // claim_ai_reply_slot's own reset-window logic (migration 050) so a
    // capped thread isn't stuck bailing here forever once its window
    // has actually expired.
    if (
      conv.ai_reply_count >= config.autoReplyMaxPerConversation &&
      !isAutoReplyWindowExpired(conv.ai_reply_window_started_at, config.autoReplyResetHours)
    ) {
      // The AI can no longer resolve this on its own — same as a real
      // handoff, a human needs to see it. Unconditional (unlike the
      // pending-downgrade below): the cap is a hard stop, so it reopens
      // even a conversation an agent had closed.
      if (conv.status !== 'open') {
        const { error: statusErr } = await db
          .from('conversations')
          .update({ status: 'open' })
          .eq('id', conversationId)
        if (statusErr) {
          console.warn('[ai auto-reply] failed to reopen a capped conversation:', statusErr)
        }
      }
      return
    }

    // WhatsApp keeps its existing send path (phone-variant retry,
    // template plumbing via engineSendText). Instagram/Messenger
    // (migration 046) route through the Send API instead — no phone,
    // no templates, just the IGSID/PSID captured on the way in.
    const channel = (conv.channel ?? 'whatsapp') as SocialChannel | 'whatsapp'
    const sendReply = (text: string) =>
      channel === 'whatsapp'
        ? engineSendText({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            text,
            aiGenerated: true,
          })
        : sendSocialReplyText({
            accountId,
            conversationId,
            contactId,
            channel,
            text,
            senderType: 'bot',
            aiGenerated: true,
          })

    const messages = await buildConversationContext(db, accountId, conversationId, config.provider)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      quickLinks: config.quickLinks,
      escalationCategories: config.escalationCategories,
    })

    // Best-effort typing indicator. Meta ties it to the most recent
    // inbound message from this customer — a failure here (e.g. a
    // transient Meta error) must never block the actual reply.
    if (args.typingIndicatorEnabled && args.phoneNumberId && args.accessToken) {
      const { data: lastInbound } = await db
        .from('messages')
        .select('message_id')
        .eq('conversation_id', conversationId)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (lastInbound?.message_id) {
        try {
          await sendTypingIndicator({
            phoneNumberId: args.phoneNumberId,
            accessToken: args.accessToken,
            messageId: lastInbound.message_id,
          })
        } catch (err) {
          console.warn(
            '[ai auto-reply] typing indicator failed:',
            err instanceof Error ? err.message : err,
          )
        }
      }
    }

    const { definitions: tools, executeTool } = await loadAiTools(db, accountId)

    const { text, handoff, handoffCategory, linkKeys, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
      tools,
      executeTool,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. A categorized handoff (the
      // model matched one of the account's configured escalation
      // categories — a bad/hallucinated key just falls through to the
      // generic path below) sends that category's admin-written
      // closing phrase VERBATIM instead of the model's own text — the
      // whole point of a fixed phrase is that the model never gets to
      // paraphrase it — and tags the contact so the topic is visible in
      // the inbox without opening the chat.
      const category = handoffCategory
        ? config.escalationCategories.find((c) => c.key === handoffCategory)
        : undefined
      const replyText = category ? category.closingPhrase : text

      // We (a) send the closing text — the category's fixed phrase, or
      // whatever customer-facing text the model wrote before the plain
      // sentinel (the system prompt asks it to keep the reply feeling
      // human rather than going silent) — (b) pause the bot here
      // (sticky until re-enabled), (c) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (d) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent; the shared-queue case is notified
      // separately by the `ai_handoff_summary` trigger.
      if (replyText) {
        await sendReply(replyText)
      }

      if (category) {
        try {
          await addContactTagAndDispatch({
            db,
            accountId,
            contactId,
            tagId: category.tagId,
          })
        } catch (err) {
          console.warn(
            `[ai auto-reply] failed to apply escalation tag for "${category.key}":`,
            err instanceof Error ? err.message : err,
          )
        }
      }

      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
        categoryLabel: category?.label,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
        // A handoff always needs a human's eyes, even if the AI had
        // quietly downgraded this thread to 'pending' while it was
        // resolving things on its own — unconditional, unlike the
        // downgrade below, which never touches an agent's own 'closed'.
        status: 'open',
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
        reset_after_hours:
          config.autoReplyResetHours > 0 ? config.autoReplyResetHours : null,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await sendReply(text)

    // The AI just answered this on its own — the customer's inbound
    // that bumped unread_count no longer needs a human's eyes, so clear
    // it every time. Status only downgrades from 'open' (never touches
    // 'pending' — already there — or 'closed', an agent's own call, not
    // ours to override), but unread_count resets regardless of status:
    // it isn't ours to leave stale just because the thread is closed.
    // Best-effort — a failure here must never roll back the reply that
    // already sent.
    const readUpdate: Record<string, unknown> = { unread_count: 0 }
    if (conv.status === 'open') readUpdate.status = 'pending'
    const { error: readErr } = await db
      .from('conversations')
      .update(readUpdate)
      .eq('id', conversationId)
    if (readErr) {
      console.warn('[ai auto-reply] failed to mark conversation as read:', readErr)
    }

    // Quick-link buttons (WhatsApp only — IG/Messenger have no interactive
    // send path yet). Sent as separate follow-up messages, one per link,
    // after the text reply. Only keys matching a configured link go out —
    // the system prompt tells the model never to invent one, but a bad
    // key from the model must not turn into a broken send. Best-effort:
    // one failing link doesn't roll back the reply that already sent or
    // block the rest.
    if (channel === 'whatsapp' && linkKeys.length > 0 && config.quickLinks.length > 0) {
      const byKey = new Map(config.quickLinks.map((l) => [l.key, l]))
      for (const key of linkKeys) {
        const link = byKey.get(key)
        if (!link) continue
        try {
          await engineSendInteractiveCtaUrl({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            bodyText: link.label,
            displayText: link.label,
            url: link.url,
          })
        } catch (err) {
          console.warn(
            `[ai auto-reply] failed to send quick link "${key}":`,
            err instanceof Error ? err.message : err,
          )
        }
      }
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
