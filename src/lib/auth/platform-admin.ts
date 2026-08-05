// ============================================================
// Platform-admin-only server context (migration 054) — for the
// small set of routes under /api/admin/**. Deliberately separate
// from getCurrentAccount()/requireRole(): platform-admin-ness isn't
// account-scoped at all, so there's no "active account" to resolve
// here. RLS (via the extended is_account_member — see migration 054)
// already lets a platform admin's own RLS-scoped client read every
// account once this check passes, so no service-role client is
// needed anywhere in the admin routes.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { ForbiddenError, UnauthorizedError } from "./account";

export interface PlatformAdminContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  userId: string;
}

/**
 * Throws `UnauthorizedError` with no session, `ForbiddenError` if
 * the caller isn't a platform admin.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  const { data: isAdmin, error } = await supabase.rpc("is_platform_admin");
  if (error) {
    console.error("[requirePlatformAdmin] is_platform_admin error:", error);
    throw new ForbiddenError("Could not verify platform admin access");
  }
  if (!isAdmin) {
    throw new ForbiddenError("Platform admin access required");
  }

  return { supabase, userId: user.id };
}
