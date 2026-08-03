-- ============================================================
-- 048_invite_account_precreate.sql
--
-- Supports creating the invitee's auth.users account at invite-
-- creation time (not at accept time) — see
-- src/app/api/account/invitations/route.ts. With Supabase's public
-- "Allow new users to sign up" toggle off, this is the only way an
-- invited person can ever get an account: we admin-create it up
-- front, so by the time they open the link they only ever need to
-- log in (password or Google), never sign up.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Tracks the auth.users row created for this invite, if any (null
-- when the invited email already had an account). Used to clean up
-- the precreated account if the invite is revoked before acceptance.
ALTER TABLE account_invitations
  ADD COLUMN IF NOT EXISTS created_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Set true when we generate a temporary password for a precreated
-- account. Checked once at password login (src/app/(auth)/login/page.tsx)
-- to force a real password before letting the session through —
-- there's no email service to deliver a normal "set your password"
-- link, so this is the substitute.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
