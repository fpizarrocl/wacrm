// ============================================================
// DELETE /api/admin/admins/[userId] — revoke platform admin.
// Platform admin only (migration 054) — re-checked inside
// revoke_platform_admin() itself too.
// ============================================================

import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";

// Crude shape check — full UUID validation happens DB-side.
function looksLikeUuid(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const { supabase } = await requirePlatformAdmin();
    const { userId: targetUserId } = await params;

    if (!looksLikeUuid(targetUserId)) {
      return NextResponse.json(
        { error: "Invalid user id" },
        { status: 400 },
      );
    }

    const { error } = await supabase.rpc("revoke_platform_admin", {
      p_user_id: targetUserId,
    });
    if (error) {
      console.error("[DELETE /api/admin/admins/[userId]] error:", error);
      return NextResponse.json(
        { error: "Failed to revoke platform admin" },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
