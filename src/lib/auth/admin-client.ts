import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for invitation account
// provisioning (auth.admin.createUser / deleteUser). Mirrors
// src/lib/social/admin-client.ts, src/lib/flows/admin-client.ts, and
// src/lib/automations/admin-client.ts — same shape so anyone reading
// any of them picks up the convention immediately.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
