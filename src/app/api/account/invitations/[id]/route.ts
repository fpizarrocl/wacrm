// ============================================================
// DELETE /api/account/invitations/[id]
//
// Admin+. Revokes a pending invitation by id. RLS on
// `account_invitations` already restricts the DELETE to admins
// of the inviting account; we lean on it and skip the explicit
// ownership check.
//
// We intentionally delete the row outright rather than soft-
// deleting (a "revoked_at" flag). Once revoked, an invite is
// dead forever — there's no UX where a former invite should be
// listed; the plaintext token is gone too. Hard delete keeps
// the table small.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/auth/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");

    const limit = checkRateLimit(
      `admin:inviteRevoke:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // No `eq('account_id', ctx.accountId)` — the RLS policy
    // (`is_account_member(account_id, 'admin')`) already scopes
    // the DELETE to invites in the caller's account. Adding the
    // filter would be redundant; omitting it surfaces a
    // cross-account attempt as a silent 0-row delete (which is
    // exactly what we want for a revocation endpoint).
    // `.select()` on the delete returns the deleted row(s) so we know
    // whether to clean up a precreated account below, without a
    // separate SELECT-then-DELETE round trip that could race.
    const { data, error } = await ctx.supabase
      .from("account_invitations")
      .delete()
      .eq("id", id)
      .select("accepted_at, created_user_id");

    if (error) {
      console.error("[DELETE /api/account/invitations/[id]] error:", error);
      return NextResponse.json(
        { error: "Failed to revoke invitation" },
        { status: 500 },
      );
    }

    if (!data || data.length === 0) {
      // Either the id doesn't exist or RLS hid it (different
      // account). 404 either way — surfacing "exists but not
      // yours" would leak existence.
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404 },
      );
    }

    const revoked = data[0];
    // Clean up the precreated account — but only pre-acceptance. Once
    // accepted, `created_user_id` is a real active team member; never
    // touch it (redeem_invitation is the only step that moves real
    // data/membership, so pre-acceptance the account is still just an
    // empty personal placeholder, safe to delete).
    if (!revoked.accepted_at && revoked.created_user_id) {
      const { error: deleteUserError } = await supabaseAdmin().auth.admin.deleteUser(
        revoked.created_user_id,
      );
      if (deleteUserError) {
        console.warn(
          "[DELETE /api/account/invitations/[id]] precreated-account cleanup failed (non-fatal):",
          deleteUserError,
        );
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
