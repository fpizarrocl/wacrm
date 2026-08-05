// ============================================================
// /api/admin/accounts/[accountId] — platform admin only.
//
//   PATCH  — rename any account (migration 054). No service-role
//            client needed: `is_account_member()` treats a platform
//            admin as an 'admin'-role member of every account, so
//            `accounts_update` RLS already lets this UPDATE through
//            on the caller's own RLS-scoped client, same as the
//            self-service rename in /api/account.
//   DELETE — permanently delete any account (migration 055). Every
//            account-scoped table cascades off `accounts.id`, so
//            this tears down all of that account's data too — no
//            confirmation short of the one already required in the
//            UI before this request is sent.
// ============================================================

import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const MAX_NAME_LEN = 80;

// Crude shape check — full UUID validation happens DB-side.
function looksLikeUuid(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const { supabase, userId } = await requirePlatformAdmin();
    const { accountId } = await params;

    if (!looksLikeUuid(accountId)) {
      return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
    }

    const limit = checkRateLimit(`admin:rename:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { name?: unknown }
      | null;
    const rawName = body?.name;

    if (typeof rawName !== "string") {
      return NextResponse.json(
        { error: "'name' must be a string" },
        { status: 400 },
      );
    }

    const name = rawName.trim();
    if (name.length === 0) {
      return NextResponse.json(
        { error: "Account name cannot be empty" },
        { status: 400 },
      );
    }
    if (name.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `Account name must be ${MAX_NAME_LEN} characters or fewer` },
        { status: 400 },
      );
    }

    const { data, error } = await supabase
      .from("accounts")
      .update({ name })
      .eq("id", accountId)
      .select("id, name")
      .single();

    if (error) {
      console.error("[PATCH /api/admin/accounts/[accountId]] error:", error);
      return NextResponse.json(
        { error: "Failed to update account" },
        { status: 500 },
      );
    }

    return NextResponse.json({ account: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  try {
    const { supabase, userId } = await requirePlatformAdmin();
    const { accountId } = await params;

    if (!looksLikeUuid(accountId)) {
      return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
    }

    const limit = checkRateLimit(`admin:delete:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    // `.select("id")` isn't just the response payload — a plain
    // `.delete()` returns success with zero rows affected when RLS
    // filters the row out (unknown id, or the `accounts_delete`
    // policy from migration 055 hasn't been applied yet) instead of
    // erroring, so without it this would report "deleted" for a
    // no-op.
    const { data, error } = await supabase
      .from("accounts")
      .delete()
      .eq("id", accountId)
      .select("id");

    if (error) {
      console.error("[DELETE /api/admin/accounts/[accountId]] error:", error);
      return NextResponse.json(
        { error: "Failed to delete account" },
        { status: 500 },
      );
    }

    if (!data || data.length === 0) {
      return NextResponse.json(
        { error: "Account not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
