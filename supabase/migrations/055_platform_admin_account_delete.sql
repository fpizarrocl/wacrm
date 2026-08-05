-- ============================================================
-- 055_platform_admin_account_delete.sql
--
-- Lets a platform admin delete any account from the Administración
-- console. Deliberately its own policy rather than folding into
-- `accounts_update`'s `is_account_member(id, 'admin')` check —
-- that would also hand delete rights to every regular account
-- owner/admin (is_account_member is true for their own account at
-- 'admin' rank), which is not what's being asked for here. Only
-- `is_platform_admin()` grants DELETE.
--
-- Every account-scoped table's `account_id` FK is already
-- `ON DELETE CASCADE` (migration 017 onward), so this one DELETE
-- tears down the account's contacts, conversations, deals,
-- automations, flows, memberships, etc. along with it. It also
-- cascades `profiles.account_id` (017) — any user whose HOME
-- account is the one being deleted loses their profile row too,
-- which is the correct outcome for "this company no longer exists,"
-- not a bug to guard against.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DROP POLICY IF EXISTS accounts_delete ON accounts;
CREATE POLICY accounts_delete ON accounts FOR DELETE
  USING (is_platform_admin());
