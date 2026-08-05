// ============================================================
// "Active account" selection — for owners/platform admins who can
// access more than one account (migration 054). Mirrors the
// LOCALE_COOKIE pattern in src/lib/i18n/locales.ts: a small,
// client-writable cookie read server-side in getCurrentAccount().
//
// Unlike locale, this one IS security-sensitive by face value — but
// it never needs to be trusted as-is: resolve_active_account (SQL)
// re-validates the caller's access to the requested account on
// every single request, silently falling back to their home account
// on anything invalid or unauthorized. This file only needs to
// guard against obviously-wrong input before the round trip, same
// as looksLikeUuid() in the transfer-ownership route.
// ============================================================

export const ACTIVE_ACCOUNT_COOKIE = "active_account_id";

/** Shape of a `resolve_active_account` RPC row (migration 054). The
 *  Supabase client here isn't generated-types-aware, so callers cast
 *  through this rather than each inlining the same shape. */
export interface ResolvedAccount {
  account_id: string;
  account_name: string;
  effective_role: string;
  default_currency: string;
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidAccountIdCookieValue(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Client-only. Mirrors LanguageSwitcher's `document.cookie` write —
 *  no server round trip needed since resolve_active_account
 *  re-validates on every request regardless of what this claims. */
export function writeActiveAccountCookie(accountId: string): void {
  document.cookie = `${ACTIVE_ACCOUNT_COOKIE}=${accountId}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}

/** Client-only cookie read, for the rare case a client component
 *  needs the raw value directly (e.g. `uploadAccountMedia` resolving
 *  the active account without a React hook available). Prefer
 *  `useAuth().accountId` wherever a component already has it. */
export function readActiveAccountCookieClient(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)active_account_id=([^;]+)/);
  const value = match ? decodeURIComponent(match[1]) : undefined;
  return isValidAccountIdCookieValue(value) ? value : null;
}
