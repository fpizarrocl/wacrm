"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

// lucide-react dropped brand/logo icons — Google's own publicly
// documented 4-color "G" mark for sign-in buttons, inlined so the
// button doesn't need an external icon library for one glyph.
function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.87c2.27-2.09 3.58-5.17 3.58-8.82Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.87-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.28v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28V6.61H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.39l3.99-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61l3.99 3.11C6.22 6.88 8.87 4.77 12 4.77Z"
      />
    </svg>
  );
}

/**
 * "Continue with Google" — shared by /login and /signup (Supabase
 * auto-creates the auth.users row on first Google sign-in, so one
 * button covers both flows; see src/app/auth/callback/route.ts for
 * the code-exchange half of the round-trip).
 */
export function GoogleSignInButton({
  next,
  label,
  disabled,
  onError,
}: {
  /** Same-origin path to land on after a successful sign-in — e.g.
   *  `/dashboard` or `/join/<token>` when a team invite is in play. */
  next: string;
  label: string;
  disabled?: boolean;
  onError: (message: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const handleClick = async () => {
    onError("");
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (error) {
      onError(error.message);
      setLoading(false);
    }
    // On success the browser navigates away to Google — no further
    // state update needed (and none would run after the redirect).
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleClick}
      disabled={disabled || loading}
      className="h-10 w-full gap-2 border-border text-foreground hover:bg-muted disabled:opacity-50"
    >
      <GoogleIcon />
      {label}
    </Button>
  );
}
