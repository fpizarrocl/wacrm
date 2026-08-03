import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Standard @supabase/ssr OAuth callback: Supabase redirects the browser
// here with a `code` after the provider (Google) round-trip completes.
// Exchanging it for a session writes the auth cookies via the server
// client's cookies().set() calls — Route Handlers (unlike Server
// Components) can set cookies directly, so no middleware involvement
// is needed here.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Where signInWithOAuth's redirectTo pointed us after success —
  // `/dashboard` by default, or `/join/<token>` when a team invite is
  // in play (see the same inviteToken logic in login/signup pages).
  // Only accept a same-origin relative path: `next` is a query param,
  // so a crafted link could otherwise turn this into an open redirect
  // (`//evil.com` is protocol-relative, not "relative" in the safe sense).
  const rawNext = searchParams.get("next") ?? "/dashboard";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    console.error("[auth/callback] exchangeCodeForSession failed:", error.message);
  }

  return NextResponse.redirect(`${origin}/login?error=oauth_failed`);
}
