import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'
import { verifyPage, subscribePageApp } from '@/lib/social/send-api'

type Channel = 'instagram' | 'messenger'

function parseChannel(raw: unknown): Channel | null {
  return raw === 'instagram' || raw === 'messenger' ? raw : null
}

/**
 * GET /api/social/config?channel=instagram|messenger
 *
 * Connection status for one channel (any member). Never returns the
 * decrypted access_token — `has_access_token` tells the UI whether
 * one is stored.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const channel = parseChannel(new URL(request.url).searchParams.get('channel'))
    if (!channel) {
      return NextResponse.json({ error: 'channel must be instagram or messenger' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('social_channel_config')
      .select('page_id, ig_business_id, status, connected_at, access_token')
      .eq('account_id', accountId)
      .eq('channel', channel)
      .maybeSingle()

    if (error) {
      console.error('[social/config GET] error:', error)
      return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ connected: false })
    }

    const { access_token, ...rest } = data
    return NextResponse.json({
      connected: rest.status === 'connected',
      has_access_token: !!access_token,
      ...rest,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/social/config  (admin+)
 *
 * Save/update the Instagram or Messenger connection for this account.
 * Manual entry — Page ID / IG Business ID + Page Access Token, same
 * UX as whatsapp_config. Verifies the token against Meta before
 * saving, then best-effort subscribes the Page to this app's webhook.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`social-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const channel = parseChannel(body?.channel)
    const pageId = typeof body?.page_id === 'string' ? body.page_id.trim() : ''
    const igBusinessId = typeof body?.ig_business_id === 'string' ? body.ig_business_id.trim() : ''
    const accessToken = typeof body?.access_token === 'string' ? body.access_token.trim() : ''
    const verifyToken = typeof body?.verify_token === 'string' ? body.verify_token.trim() : ''

    if (!channel) {
      return NextResponse.json({ error: 'channel must be instagram or messenger' }, { status: 400 })
    }
    if (!pageId || !accessToken) {
      return NextResponse.json({ error: 'page_id and access_token are required' }, { status: 400 })
    }

    try {
      await verifyPage({ pageId, accessToken })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 })
    }

    // Best-effort — some setups pre-subscribe the Page via the App
    // Dashboard, so a failure here shouldn't block saving valid creds.
    let subscribeError: string | null = null
    try {
      await subscribePageApp({ pageId, accessToken })
    } catch (err) {
      subscribeError = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.warn('[social/config POST] subscribed_apps failed (non-fatal):', subscribeError)
    }

    const { error: upsertError } = await supabase
      .from('social_channel_config')
      .upsert(
        {
          account_id: accountId,
          created_by: userId,
          channel,
          page_id: pageId,
          ig_business_id: igBusinessId || null,
          access_token: encrypt(accessToken),
          verify_token: verifyToken ? encrypt(verifyToken) : null,
          status: 'connected',
          connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id,channel' },
      )

    if (upsertError) {
      console.error('[social/config POST] upsert error:', upsertError)
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
    }

    return NextResponse.json({ success: true, subscribe_warning: subscribeError })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/social/config?channel=instagram|messenger  (admin+)
 */
export async function DELETE(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const channel = parseChannel(new URL(request.url).searchParams.get('channel'))
    if (!channel) {
      return NextResponse.json({ error: 'channel must be instagram or messenger' }, { status: 400 })
    }

    const { error } = await supabase
      .from('social_channel_config')
      .delete()
      .eq('account_id', accountId)
      .eq('channel', channel)

    if (error) {
      console.error('[social/config DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
