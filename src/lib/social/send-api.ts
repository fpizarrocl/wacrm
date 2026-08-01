import type { SocialChannel } from './inbound'

/**
 * Meta Send API helper for Instagram + Messenger.
 *
 * Same base URL/version as src/lib/whatsapp/meta-api.ts. Both
 * channels send through the linked Facebook Page's node
 * (`/{page_id}/messages`) — the Page-linked messaging model, not the
 * newer standalone "Instagram API with Instagram Login". Recipient id
 * is a PSID for Messenger, an IGSID for Instagram; the endpoint and
 * payload shape are otherwise identical. `ig_business_id` is stored
 * on `social_channel_config` for reference/validation but isn't part
 * of the request — revisit if a future account needs the standalone
 * IG API instead of a Page-linked one.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export interface SocialSendResult {
  messageId: string
}

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string }
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as MetaErrorResponse
    if (data.error?.message) message = data.error.message
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

export interface SendSocialTextArgs {
  channel: SocialChannel
  pageId: string
  accessToken: string
  /** IGSID (instagram) or PSID (messenger). */
  recipientId: string
  text: string
}

export async function sendSocialText(args: SendSocialTextArgs): Promise<SocialSendResult> {
  const { pageId, accessToken, recipientId, text } = args
  const url = `${META_API_BASE}/${pageId}/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text },
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.message_id }
}

export interface VerifyPageArgs {
  pageId: string
  accessToken: string
}

export interface PageInfo {
  id: string
  name?: string
}

/** Verify a Page ID + Page Access Token pair by fetching public
 *  metadata — same role as whatsapp/meta-api.ts's verifyPhoneNumber,
 *  called before saving credentials so a typo'd id/token fails loudly
 *  at save time instead of silently at first send. */
export async function verifyPage(args: VerifyPageArgs): Promise<PageInfo> {
  const { pageId, accessToken } = args
  const url = `${META_API_BASE}/${pageId}?fields=id,name`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  return response.json()
}

export interface SubscribePageAppArgs {
  pageId: string
  accessToken: string
}

/** Subscribe the Page to this app's webhook for `messages` events —
 *  the Messenger/Instagram equivalent of WhatsApp's
 *  `subscribeWabaToApp`. Without this, Meta won't route inbound DMs
 *  to our webhook even with a valid token. Best-effort — callers
 *  should treat failure as non-fatal (save the config anyway) since
 *  some setups pre-subscribe the page via the App Dashboard. */
export async function subscribePageApp(args: SubscribePageAppArgs): Promise<void> {
  const { pageId, accessToken } = args
  const url = `${META_API_BASE}/${pageId}/subscribed_apps?subscribed_fields=messages,messaging_postbacks`
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
}
