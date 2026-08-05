// ============================================================
// GET /api/admin/accounts — platform admin only (migration 054).
//
// Lists every account in the instance. `is_account_member()` was
// extended to include an `is_platform_admin()` branch, and
// `accounts_select` RLS is `USING (is_account_member(id))` (migration
// 017) — so once `requirePlatformAdmin()` confirms the caller, a
// plain unfiltered select through their own RLS-scoped client already
// returns every account. No service-role client needed anywhere here.
// ============================================================

import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";

export async function GET() {
  try {
    const { supabase } = await requirePlatformAdmin();

    const { data, error } = await supabase
      .from("accounts")
      .select("id, name, owner_user_id, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[GET /api/admin/accounts] error:", error);
      return NextResponse.json(
        { error: "Failed to load accounts" },
        { status: 500 },
      );
    }

    return NextResponse.json({ accounts: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
