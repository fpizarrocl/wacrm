// ============================================================
// /api/account
//
//   GET   — current caller's (active) account + role. Any member.
//   PATCH — rename the active account.             Admin+.
//   POST  — create an ADDITIONAL company (migration 054).
//           Owner (of their home account) or platform admin only —
//           enforced inside the `create_additional_account` RPC
//           itself, not just here, so a direct PostgREST call can't
//           bypass it.
//
// Why all three verbs share a route file
//   They speak about the same singular resource (the caller's
//   account(s)) and reuse the same `requireRole`/auth plumbing.
//   Splitting them across files would duplicate the `account_id`
//   lookup without buying anything.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";

import {
  requireRole,
  getCurrentAccount,
  toErrorResponse,
  UnauthorizedError,
} from "@/lib/auth/account";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({
      account: ctx.account,
      role: ctx.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const MAX_NAME_LEN = 80;

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole("admin");

    // Per-user limit on admin-class mutations. Bounds accidental
    // abuse (script run in a loop) and a compromised admin session
    // spamming renames. Each admin endpoint keys its own bucket so
    // one route doesn't starve another.
    const limit = checkRateLimit(
      `admin:rename:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
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

    // RLS allows this UPDATE because accounts_update requires
    // `is_account_member(id, 'admin')`, and requireRole already
    // guaranteed the caller is admin+.
    const { data, error } = await ctx.supabase
      .from("accounts")
      .update({ name })
      .eq("id", ctx.accountId)
      .select("id, name")
      .single();

    if (error) {
      console.error("[PATCH /api/account] update error:", error);
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

const MAX_COMPANY_NAME_LEN = 80;

function createErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[POST /api/account] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Failed to create company" },
    { status: 500 },
  );
}

export async function POST(request: Request) {
  try {
    // Not `requireRole` — that resolves the *active* account, but
    // creating a new company is authorized off the caller's HOME
    // role (or platform-admin status), not whichever company happens
    // to be active. `create_additional_account` re-derives and
    // enforces that itself; this route only needs a real session.
    const supabase = await createClient();
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();
    if (userErr || !user) throw new UnauthorizedError();

    const limit = checkRateLimit(
      `account:create:${user.id}`,
      RATE_LIMITS.adminAction,
    );
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
        { error: "Company name cannot be empty" },
        { status: 400 },
      );
    }
    if (name.length > MAX_COMPANY_NAME_LEN) {
      return NextResponse.json(
        { error: `Company name must be ${MAX_COMPANY_NAME_LEN} characters or fewer` },
        { status: 400 },
      );
    }

    const { data: newAccountId, error } = await supabase.rpc(
      "create_additional_account",
      { p_name: name },
    );
    if (error) return createErrorToResponse(error);

    return NextResponse.json({ accountId: newAccountId });
  } catch (err) {
    return toErrorResponse(err);
  }
}
