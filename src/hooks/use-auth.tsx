"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";
import {
  readActiveAccountCookieClient,
  writeActiveAccountCookie,
  type ResolvedAccount,
} from "@/lib/auth/active-account";

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  /**
   * Opted-in beta feature keys for this account. No current feature
   * reads this — Flows was the last user and went to soft-GA in PR
   * #134 — but the column survives for future beta gates.
   */
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  /** Default deal currency (ISO-4217). NOT NULL DEFAULT 'USD' in the
   *  DB (migration 021); narrowed to DEFAULT_CURRENCY when absent. */
  default_currency: string;
}

/** One entry in the account switcher (migration 054) — every account
 *  the caller can access: their home account plus any extra
 *  memberships (owner/platform-admin only; see list_my_accounts()). */
export interface AccountListEntry {
  id: string;
  name: string;
  role: AccountRole;
  isHome: boolean;
}

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  /**
   * Session-level loading. Flips to false as soon as we know whether
   * a user is signed in, *without* waiting for the profile row. Use
   * this for chrome (sidebar / header) that can render with just the
   * user object.
   */
  loading: boolean;
  /**
   * Profile-row loading. Stays true until `fetchProfile` settles
   * (success, missing row, or error). Code that branches on
   * `profile.beta_features` MUST gate on this — otherwise it sees the
   * `{ loading: false, profile: null }` window during initial load
   * and may take the "not opted in" branch incorrectly.
   */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  /** Re-fetch the current user's profile row — call after a save from
   *  the settings form so header/sidebar reflect the change without a
   *  full page reload. */
  refreshProfile: () => Promise<void>;

  // ----------------------------------------------------------
  // Account-scoped context (added by the account-sharing series)
  //
  // All of these are nullable until `profileLoading` is false.
  // After the profile resolves they're guaranteed to be set,
  // because migration 017 made `account_id` / `account_role`
  // NOT NULL on `profiles`.
  //
  // Since migration 054 these reflect the *active* account, not
  // necessarily the caller's home one — an owner/platform admin who
  // switched companies sees that company's id/role/name/currency
  // here, matching what the server resolves via
  // `getCurrentAccount()`/`resolve_active_account` for the same
  // request. Regular single-account users never notice a difference:
  // active === home always.
  // ----------------------------------------------------------

  /** Active account id (see note above). Null while loading. */
  accountId: string | null;
  /** Caller's role within the active account. Null while loading. */
  accountRole: AccountRole | null;
  /** Lightweight active-account meta — id + name + default_currency. Null while loading. */
  account: AccountSummary | null;
  /** Every account the caller can access — their home account plus
   *  any extra memberships (owner/platform-admin only). A single
   *  entry for everyone else. Empty while loading. */
  accounts: AccountListEntry[];
  /** True for a platform admin (migration 054) — can browse/enter any
   *  account in the instance via /admin, not just ones they own. */
  isPlatformAdmin: boolean;
  /** Switch the active account: writes the active_account_id cookie
   *  and reloads so every server-rendered/API-backed surface picks up
   *  the new scope. A no-op target (not in `accounts`, and the caller
   *  isn't a platform admin) is silently corrected back to home on
   *  the next request by `resolve_active_account` — this never grants
   *  access it shouldn't, it can just fail to switch. */
  switchAccount: (accountId: string) => void;
  /** Account default deal currency. Falls back to DEFAULT_CURRENCY
   *  while loading or when no account is resolved, so callers can use
   *  it unconditionally. */
  defaultCurrency: string;
  /** True if `accountRole === 'owner'`. */
  isOwner: boolean;
  /** True if `accountRole === 'admin'` (does NOT include owner — use canManageMembers for "admin or above"). */
  isAdmin: boolean;
  /** True if `accountRole === 'agent'`. */
  isAgent: boolean;
  /** True if `accountRole === 'viewer'`. */
  isViewer: boolean;
  /** True if the caller can manage members (admin+). */
  canManageMembers: boolean;
  /** True if the caller can edit account-wide settings (admin+). */
  canEditSettings: boolean;
  /** True if the caller can send messages and edit operational data (agent+). */
  canSendMessages: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * AuthProvider — wrap this around the dashboard layout.
 * Makes ONE getSession() call for the whole tree instead of one per
 * component, avoiding internal lock contention in the Supabase client.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  // Active-account state (migration 054) — see the AuthContextValue
  // doc comments. `accountRole` here is the caller's EFFECTIVE role
  // for the active account, which for a platform-admin viewing an
  // account they don't otherwise belong to is 'owner' (server-side
  // parity with resolve_active_account's own admin branch).
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [accountRole, setAccountRole] = useState<AccountRole | null>(null);
  const [accounts, setAccounts] = useState<AccountListEntry[]>([]);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  // Tracked separately from `loading`. The session settles fast (one
  // local cookie read); the profile fetch crosses the network and
  // settles later. Callers that gate on `profile.*` need to know which
  // window they're in — see the type doc above.
  const [profileLoading, setProfileLoading] = useState(true);

  // Tracks the user ID we've successfully initiated/completed fetching
  // a profile for. This prevents redundant re-fetches and toggling
  // profileLoading back to true on window focus events/token refresh.
  const lastFetchedUserIdRef = useRef<string | null>(null);

  // Shared across init, auth-state-change listener, and the exposed
  // refreshProfile() callback. Reads the current session's user id and
  // pulls the matching profile row along with its account summary.
  const fetchProfile = useCallback(async (userId: string) => {
    const supabase = createClient();
    setProfileLoading(true);
    lastFetchedUserIdRef.current = userId;
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select(
          "id, full_name, email, avatar_url, role, beta_features, account_id, account_role",
        )
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        console.error("[AuthProvider] fetchProfile error:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        lastFetchedUserIdRef.current = null;
        return;
      }

      if (data) {
        setProfile({
          id: data.id,
          full_name: data.full_name,
          email: data.email,
          avatar_url: data.avatar_url,
          role: data.role,
          // `beta_features` is `NOT NULL DEFAULT ARRAY[]` in the DB, but
          // narrow defensively in case the column hasn't been migrated yet
          // (older deployments running 011 lazily) — `null` reads as no
          // opt-ins, which is the safe default for any future beta gate.
          beta_features: data.beta_features ?? [],
          account_id: data.account_id ?? null,
          account_role: isAccountRole(data.account_role) ? data.account_role : null,
        });

        // Active-account resolution (migration 054) — mirrors the
        // server's getCurrentAccount()/resolve_active_account exactly,
        // reading the same cookie, so client and server never scope to
        // different accounts for the same request. Fired in parallel
        // with the switcher list + platform-admin flag; all three are
        // no-ops (empty/false) for the common single-account case.
        const [activeRes, accountsRes, adminRes] = (await Promise.all([
          supabase
            .rpc("resolve_active_account", {
              p_requested_account_id: readActiveAccountCookieClient(),
            })
            .maybeSingle(),
          supabase.rpc("list_my_accounts"),
          supabase.rpc("is_platform_admin"),
        ])) as [
          { data: ResolvedAccount | null; error: unknown },
          {
            data:
              | { account_id: string; account_name: string; role: string; is_home: boolean }[]
              | null;
            error: unknown;
          },
          { data: boolean | null; error: unknown },
        ];

        if (activeRes.error) {
          console.error("[AuthProvider] resolve_active_account error:", activeRes.error);
          setAccount(null);
          setAccountRole(null);
        } else if (activeRes.data) {
          setAccount({
            id: activeRes.data.account_id,
            name: activeRes.data.account_name,
            default_currency: activeRes.data.default_currency ?? DEFAULT_CURRENCY,
          });
          // Same defensive narrowing as account_role above.
          setAccountRole(
            isAccountRole(activeRes.data.effective_role) ? activeRes.data.effective_role : null,
          );
        }

        if (accountsRes.error) {
          console.error("[AuthProvider] list_my_accounts error:", accountsRes.error);
          setAccounts([]);
        } else {
          setAccounts(
            (accountsRes.data ?? [])
              .filter((row) => isAccountRole(row.role))
              .map((row) => ({
                id: row.account_id,
                name: row.account_name,
                role: row.role as AccountRole,
                isHome: row.is_home,
              })),
          );
        }

        if (adminRes.error) {
          console.error("[AuthProvider] is_platform_admin error:", adminRes.error);
          setIsPlatformAdmin(false);
        } else {
          setIsPlatformAdmin(adminRes.data === true);
        }
      } else {
        lastFetchedUserIdRef.current = null;
      }
    } catch (err) {
      console.error("[AuthProvider] fetchProfile threw:", err);
      lastFetchedUserIdRef.current = null;
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    const safetyTimer = setTimeout(() => {
      if (mounted) {
        console.warn("[AuthProvider] getSession() timed out after 3s");
        setLoading(false);
        setProfileLoading(false);
      }
    }, 3000);

    const init = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) console.error("[AuthProvider] getSession error:", error.message);

        if (!mounted) return;
        const currentUser = session?.user ?? null;
        setUser(currentUser);

        if (currentUser) {
          // Don't block session loading on profile fetch — chrome
          // (header, sidebar) can render from the user object alone,
          // profile enriches async. Callers that need to branch on
          // profile data gate on `profileLoading` instead.
          fetchProfile(currentUser.id);
        } else {
          // No user → no profile to load. Flip profileLoading off so
          // pages that gate on it don't wait forever on the logged-out
          // path (the route guard or redirect should fire instead).
          setProfileLoading(false);
        }
      } catch (err) {
        console.error("[AuthProvider] init threw:", err);
      } finally {
        if (mounted) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        if (currentUser.id !== lastFetchedUserIdRef.current) {
          fetchProfile(currentUser.id);
        }
      } else {
        lastFetchedUserIdRef.current = null;
        setProfile(null);
        setAccount(null);
        setAccountRole(null);
        setAccounts([]);
        setIsPlatformAdmin(false);
        setProfileLoading(false);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setAccount(null);
    setAccountRole(null);
    setAccounts([]);
    setIsPlatformAdmin(false);
    window.location.href = "/login";
  }, []);

  // Switch the active account (migration 054) — see the doc comment
  // on AuthContextValue.switchAccount. No server round trip needed:
  // resolve_active_account re-validates on every subsequent request
  // regardless of what this cookie claims, exactly like the language
  // switcher's NEXT_LOCALE write.
  const switchAccount = useCallback((nextAccountId: string) => {
    writeActiveAccountCookie(nextAccountId);
    window.location.reload();
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!user?.id) return;
    await fetchProfile(user.id);
  }, [user?.id, fetchProfile]);

  // Derive the role booleans once per active-account-role change
  // rather than on every consumer render. Cheap regardless, but the
  // memo also gives each derived value a stable identity for
  // React.memo / useEffect dependencies downstream.
  const derived = useMemo(() => {
    const role = accountRole;
    return {
      accountRole: role,
      accountId: account?.id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [accountRole, account?.id]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        accounts,
        isPlatformAdmin,
        switchAccount,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (shouldn't
    // happen in normal flow, but don't crash the page). Account state
    // collapses to least-privileged null — every `canX` boolean is
    // false so UI gates fail closed.
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      accounts: [],
      isPlatformAdmin: false,
      switchAccount: () => {},
      defaultCurrency: DEFAULT_CURRENCY,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
    };
  }
  return ctx;
}
