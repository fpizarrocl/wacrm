import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { supabaseAdmin } from './admin-client'

export type SocialChannel = 'instagram' | 'messenger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

/**
 * Find-or-create the contact for an inbound Instagram/Messenger
 * message, keyed by (account_id, channel, external_id) — the
 * IGSID/PSID Meta assigns per user per channel (migration 046).
 *
 * Deliberately separate from `findExistingContact` /
 * `findOrCreateContact` in the WhatsApp webhook: those are built
 * around phone-number matching (last-8-digit prefilter,
 * `phonesMatch`), which has no meaning for a channel-scoped id.
 * Same "duplicate now, diverge cleanly" precedent already used
 * between src/lib/flows/meta-send.ts and src/lib/automations/meta-send.ts.
 */
export async function findOrCreateSocialContact(
  accountId: string,
  configOwnerUserId: string,
  channel: SocialChannel,
  externalId: string,
  name: string,
): Promise<{ contact: Row; wasCreated: boolean } | null> {
  const db = supabaseAdmin()

  const { data: existing, error: findError } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel', channel)
    .eq('external_id', externalId)
    .maybeSingle()

  if (findError) {
    console.error('[social/inbound] error finding contact:', findError)
    return null
  }

  if (existing) {
    if (name && name !== existing.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return { contact: existing, wasCreated: false }
  }

  const { data: created, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      channel,
      external_id: externalId,
      name: name || externalId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race — same recovery as the WhatsApp webhook's
    // findOrCreateContact: re-resolve instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .eq('channel', channel)
        .eq('external_id', externalId)
        .maybeSingle()
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[social/inbound] error creating contact:', createError)
    return null
  }

  return { contact: created, wasCreated: true }
}

/**
 * Find-or-create the conversation for a social contact — same
 * one-per-(account, contact) convention and race-recovery shape as
 * the WhatsApp webhook's `findOrCreateConversation`, with `channel`
 * stamped so the inbox can badge/filter without a join.
 */
export async function findOrCreateSocialConversation(
  accountId: string,
  configOwnerUserId: string,
  channel: SocialChannel,
  contactId: string,
): Promise<{ conversation: Row; created: boolean } | null> {
  const db = supabaseAdmin()

  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[social/inbound] error finding conversation:', findError)
    return null
  }
  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: created, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      channel,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[social/inbound] error creating conversation:', createError)
    return null
  }

  return { conversation: created, created: true }
}
