-- ============================================================
-- 054_multi_account_platform_admin.sql
--
-- Lets a single login own/switch between MULTIPLE independent
-- accounts (companies), and adds a platform-level "super admin"
-- role that can view/manage ANY account in the instance.
--
-- Additive, not a replacement: `profiles.account_id`/`account_role`
-- (migration 017's single-membership column) is untouched and keeps
-- driving the common case exactly as before. A new
-- `account_memberships` table holds EXTRA memberships, for
-- owner/platform-admin use only — regular invited agents never get
-- rows here, so their behavior is bit-for-bit identical to today.
--
-- `is_account_member()` — the one choke-point function ~15 prior
-- migrations' RLS policies already call across ~25 tables — is
-- extended (CREATE OR REPLACE, same signature) with two more OR
-- branches rather than rewritten, so every existing policy keeps
-- working untouched.
--
-- Security convention this migration follows throughout (the exact
-- lesson from two historical fixes in this repo — 032, GHSA-fg5p-
-- 2qc3-jmxr: a SECURITY DEFINER RPC trusted a caller-supplied
-- account id without re-checking membership; 034: a profiles UPDATE
-- policy didn't restrict which columns could be self-written):
-- every SECURITY DEFINER function here derives authority ONLY from
-- auth.uid(), never from a caller-supplied id/role/email used as a
-- trust signal.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- Drop the one-account-per-owner lock (017's
-- idx_accounts_one_per_owner) — this is the exact relaxation point
-- its own comment anticipated.
-- ------------------------------------------------------------
DROP INDEX IF EXISTS idx_accounts_one_per_owner;
CREATE INDEX IF NOT EXISTS idx_accounts_owner_user_id ON accounts(owner_user_id);

-- ------------------------------------------------------------
-- New tables. RLS-enabled with NO policies for `authenticated` —
-- deliberate default-deny. All access goes through the SECURITY
-- DEFINER functions below (same pattern already used for
-- automation_pending_executions / flow_runs' write side).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role account_role_enum NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, account_id)
);
ALTER TABLE account_memberships ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS platform_admins (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- role_rank — small IMMUTABLE helper, dedupes the CASE-based rank
-- comparison now used across is_account_member and elsewhere.
-- Mirrors roleRank() in src/lib/auth/roles.ts.
-- ============================================================
CREATE OR REPLACE FUNCTION role_rank(r account_role_enum)
RETURNS INT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE r
    WHEN 'owner' THEN 4
    WHEN 'admin' THEN 3
    WHEN 'agent' THEN 2
    WHEN 'viewer' THEN 1
  END;
$$;

ALTER FUNCTION role_rank(account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION role_rank(account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION role_rank(account_role_enum) TO authenticated, service_role;

-- ============================================================
-- is_platform_admin — zero-arg, keyed off auth.uid() only. Taking a
-- caller-supplied id here would let any user enumerate who else is
-- a platform admin (the exact GHSA-fg5p-2qc3-jmxr anti-pattern).
-- ============================================================
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = auth.uid());
$$;

ALTER FUNCTION is_platform_admin() OWNER TO postgres;
REVOKE ALL ON FUNCTION is_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_platform_admin() TO authenticated, service_role;

-- ============================================================
-- is_account_member — extended with two more OR branches (extra
-- memberships, platform admin). Same signature, so every existing
-- RLS policy across ~25 tables keeps working untouched. A
-- single-account user with zero account_memberships rows and no
-- platform_admins row gets the exact same result as before this
-- migration.
--
-- Because accounts_select RLS is already USING (is_account_member(id))
-- (017), this one change is also what lets a platform admin read
-- every accounts row (and, once an account is active, every other
-- tenant table for it) with zero service-role bypass anywhere.
-- ============================================================
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id = target_account_id
        AND role_rank(p.account_role) >= role_rank(min_role)
    )
    OR EXISTS (
      SELECT 1 FROM account_memberships m
      WHERE m.user_id = auth.uid()
        AND m.account_id = target_account_id
        AND role_rank(m.role) >= role_rank(min_role)
    )
    -- Rare path, checked last.
    OR is_platform_admin();
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION is_account_member(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum) TO authenticated, service_role;

-- ============================================================
-- resolve_active_account — the caller's home account, or (if a
-- different account is requested and they're actually authorized
-- for it) that one instead. Never errors and never leaks: an
-- invalid/unauthorized request silently falls back to the home
-- account, mirroring this codebase's established safe-fallback
-- pattern (e.g. getBranding()).
-- ============================================================
CREATE OR REPLACE FUNCTION resolve_active_account(p_requested_account_id UUID DEFAULT NULL)
RETURNS TABLE(account_id UUID, account_name TEXT, effective_role account_role_enum, default_currency TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_home_id UUID;
  v_home_role account_role_enum;
BEGIN
  SELECT p.account_id, p.account_role INTO v_home_id, v_home_role
  FROM profiles p WHERE p.user_id = auth.uid();

  IF p_requested_account_id IS NULL OR p_requested_account_id = v_home_id THEN
    RETURN QUERY SELECT a.id, a.name, v_home_role, a.default_currency FROM accounts a WHERE a.id = v_home_id;
    RETURN;
  END IF;

  IF is_platform_admin() THEN
    RETURN QUERY
      SELECT a.id, a.name, 'owner'::account_role_enum, a.default_currency
      FROM accounts a WHERE a.id = p_requested_account_id;
    IF FOUND THEN RETURN; END IF;
  END IF;

  RETURN QUERY
    SELECT a.id, a.name, m.role, a.default_currency
    FROM account_memberships m
    JOIN accounts a ON a.id = m.account_id
    WHERE m.user_id = auth.uid() AND m.account_id = p_requested_account_id;
  IF FOUND THEN RETURN; END IF;

  -- Not authorized for the requested account — fall back to home.
  RETURN QUERY SELECT a.id, a.name, v_home_role, a.default_currency FROM accounts a WHERE a.id = v_home_id;
END;
$$;

ALTER FUNCTION resolve_active_account(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION resolve_active_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_active_account(UUID) TO authenticated, service_role;

-- ============================================================
-- list_my_accounts — home account (profiles) UNION extra
-- memberships, for the sidebar switcher.
-- ============================================================
CREATE OR REPLACE FUNCTION list_my_accounts()
RETURNS TABLE(account_id UUID, account_name TEXT, role account_role_enum, is_home BOOLEAN)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.name, p.account_role, true
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = auth.uid()
  UNION
  SELECT a.id, a.name, m.role, false
  FROM account_memberships m
  JOIN accounts a ON a.id = m.account_id
  WHERE m.user_id = auth.uid()
  ORDER BY 4 DESC, 2;
$$;

ALTER FUNCTION list_my_accounts() OWNER TO postgres;
REVOKE ALL ON FUNCTION list_my_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_my_accounts() TO authenticated, service_role;

-- ============================================================
-- create_additional_account — owner/platform-admin only. Without
-- this role check, any invited agent could call the RPC directly
-- via PostgREST and mint themselves a brand-new owned account.
-- ============================================================
CREATE OR REPLACE FUNCTION create_additional_account(p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_role account_role_enum;
  v_new_id UUID;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_role INTO v_role FROM profiles WHERE user_id = v_caller_id;

  IF v_role IS DISTINCT FROM 'owner' AND NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Only account owners can create an additional company'
      USING ERRCODE = '42501';
  END IF;

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'Name is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO accounts (name, owner_user_id)
  VALUES (btrim(p_name), v_caller_id)
  RETURNING id INTO v_new_id;

  INSERT INTO account_memberships (user_id, account_id, role)
  VALUES (v_caller_id, v_new_id, 'owner');

  RETURN v_new_id;
END;
$$;

ALTER FUNCTION create_additional_account(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION create_additional_account(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_additional_account(TEXT) TO authenticated;

-- ============================================================
-- Platform-admin management. Both gated on is_platform_admin() —
-- only an existing platform admin can grant/revoke another.
-- ============================================================
CREATE OR REPLACE FUNCTION grant_platform_admin(p_email TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_id UUID;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_target_id FROM auth.users WHERE lower(email) = lower(p_email);

  IF v_target_id IS NULL THEN
    RAISE EXCEPTION 'No user found with that email' USING ERRCODE = '22023';
  END IF;

  INSERT INTO platform_admins (user_id, granted_by)
  VALUES (v_target_id, auth.uid())
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

ALTER FUNCTION grant_platform_admin(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION grant_platform_admin(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION grant_platform_admin(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION revoke_platform_admin(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin access required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM platform_admins WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION revoke_platform_admin(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION revoke_platform_admin(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_platform_admin(UUID) TO authenticated;

-- list_platform_admins — auth.users isn't directly queryable by
-- `authenticated`, so this joins in email server-side.
CREATE OR REPLACE FUNCTION list_platform_admins()
RETURNS TABLE(user_id UUID, email TEXT, granted_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin access required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT pa.user_id, u.email::TEXT, pa.created_at
    FROM platform_admins pa
    JOIN auth.users u ON u.id = pa.user_id
    ORDER BY pa.created_at;
END;
$$;

ALTER FUNCTION list_platform_admins() OWNER TO postgres;
REVOKE ALL ON FUNCTION list_platform_admins() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_platform_admins() TO authenticated;

-- ============================================================
-- Seed the first platform admin. Harmless no-op on any other clone
-- of this template — the SELECT returns zero rows if this email
-- hasn't signed up on that deployment.
-- ============================================================
INSERT INTO platform_admins (user_id)
SELECT id FROM auth.users WHERE email = 'fpizarrosil@gmail.com'
ON CONFLICT DO NOTHING;

-- ============================================================
-- redeem_invitation — patched on top of migration 047's version
-- (preserves the email-binding check added there). One new branch,
-- inserted after the existing self-collision check and before the
-- sole-owner/no-data checks: a multi-account owner (has at least
-- one account_memberships row already) redeeming an invite gains an
-- ADDITIONAL membership, leaving their home account and every other
-- owned account untouched — instead of the single-account move-and-
-- retire-the-old-account behavior below, which stays exactly as it
-- was for the common case (zero account_memberships rows).
--
-- accepted_at is stamped in this new branch too — without that the
-- same invite link would stay redeemable forever for multi-account
-- owners, breaking single-use.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  IF v_inv.email IS NOT NULL AND lower(v_inv.email) <> lower(auth.email()) THEN
    RAISE EXCEPTION 'This invitation is for %, not the account you are signed in as', v_inv.email
      USING ERRCODE = '28000';
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Edge case: the inviter sent themselves a link, or the
  -- caller is somehow already in the inviter's account.
  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  -- Multi-account owner: grant an additional membership instead of
  -- moving/retiring their home account. See migration header.
  IF EXISTS (SELECT 1 FROM account_memberships WHERE user_id = v_caller_id) THEN
    INSERT INTO account_memberships (user_id, account_id, role)
    VALUES (v_caller_id, v_inv.account_id, v_inv.role)
    ON CONFLICT (user_id, account_id) DO UPDATE SET role = EXCLUDED.role;

    UPDATE account_invitations
    SET accepted_at = NOW(),
        accepted_by_user_id = v_caller_id
    WHERE id = v_inv.id;

    RETURN v_inv.account_id;
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior removal). Any other state means they're either:
  --   - a member of another shared account (joining a second
  --     would silently orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Belt: even if they own their account, refuse if it has any
  -- domain data — joining would orphan their contacts, deals,
  -- broadcasts, automations, flows, templates, etc.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Clean up the orphan personal account. Empty by the checks
  -- above, so this is purely housekeeping — no cascades fire
  -- because no other rows reference it.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
