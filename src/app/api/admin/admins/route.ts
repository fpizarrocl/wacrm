// ============================================================
// /api/admin/admins — platform admin only (migration 054).
//
//   GET  — list current platform admins (id, email, granted_at).
//   POST — grant platform admin to another user by email.
//
// Both the list (via list_platform_admins) and the grant (via
// grant_platform_admin) RPCs re-check is_platform_admin() themselves
// server-side — this route's own requirePlatformAdmin() call is
// belt-and-braces, not the sole gate.
// ============================================================

import { NextResponse } from "next/server";
import type { PostgrestError } from "@supabase/supabase-js";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform-admin";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

function rpcErrorToResponse(err: PostgrestError): NextResponse {
  if (err.code === "42501") {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === "22023") {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("[admin/admins] unexpected RPC error:", err);
  return NextResponse.json(
    { error: "Something went wrong" },
    { status: 500 },
  );
}

export async function GET() {
  try {
    const { supabase } = await requirePlatformAdmin();

    const { data, error } = await supabase.rpc("list_platform_admins");
    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ admins: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, userId } = await requirePlatformAdmin();

    // Granting root access is rare and high-stakes — a tight budget
    // bounds a compromised admin session from spamming grants.
    const limit = checkRateLimit(
      `admin:grantPlatformAdmin:${userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { email?: unknown }
      | null;
    const email = body?.email;
    if (typeof email !== "string" || !email.trim()) {
      return NextResponse.json(
        { error: "'email' is required" },
        { status: 400 },
      );
    }

    const { error } = await supabase.rpc("grant_platform_admin", {
      p_email: email.trim(),
    });
    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
