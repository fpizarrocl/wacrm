-- ============================================================
-- 050_ai_reply_window.sql
--
-- Time-windowed reset for the per-conversation auto-reply cap
-- (029_ai_reply.sql). Until now, `conversations.ai_reply_count` was
-- permanent — once a thread hit `auto_reply_max_per_conversation`, the
-- only way back was a human manually resuming the bot (POST
-- /api/ai/autoreply/[conversationId], which zeroes the count). That
-- silently mutes the bot forever on a long-lived contact, and the
-- inbox banner had no way to tell the difference between "off" and
-- "capped" — see src/components/inbox/ai-thread-banner.tsx.
--
-- `auto_reply_reset_hours` (account-level, default 24h — matches
-- WhatsApp's own 24h session window) makes the cap a rolling quota
-- instead of a one-time budget: it renews `auto_reply_reset_hours`
-- hours after the FIRST reply of the current window, not on
-- inactivity. 0 disables auto-reset, preserving the old permanent-cap
-- behavior as an explicit opt-out.
--
-- `ai_reply_window_started_at` starts NULL and is stamped on the first
-- successful claim — no backfill needed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS auto_reply_reset_hours integer NOT NULL DEFAULT 24
    CHECK (auto_reply_reset_hours BETWEEN 0 AND 168);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_reply_window_started_at timestamptz;

-- Changing the parameter list makes this a distinct function by
-- Postgres identity — drop the old 2-arg signature first so it doesn't
-- linger orphaned, then recreate with the optional third parameter.
-- `reset_after_hours IS NULL` reproduces the exact pre-migration
-- behavior (never auto-reset).
DROP FUNCTION IF EXISTS public.claim_ai_reply_slot(uuid, integer);

CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid,
  max_replies integer,
  reset_after_hours integer DEFAULT NULL
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET
      ai_reply_count = CASE
        WHEN reset_after_hours IS NOT NULL
          AND ai_reply_window_started_at IS NOT NULL
          AND now() - ai_reply_window_started_at > make_interval(hours => reset_after_hours)
        THEN 1
        ELSE ai_reply_count + 1
      END,
      ai_reply_window_started_at = CASE
        WHEN ai_reply_window_started_at IS NULL
          OR (reset_after_hours IS NOT NULL
              AND now() - ai_reply_window_started_at > make_interval(hours => reset_after_hours))
        THEN now()
        ELSE ai_reply_window_started_at
      END
    WHERE id = conversation_id
      AND (
        ai_reply_count < max_replies
        OR (
          reset_after_hours IS NOT NULL
          AND ai_reply_window_started_at IS NOT NULL
          AND now() - ai_reply_window_started_at > make_interval(hours => reset_after_hours)
        )
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- Grants are per-signature, not inherited across an identity change —
-- re-grant explicitly (mirrors 029_ai_reply.sql's own note on why this
-- grant exists at all: the auto-reply bot runs under the service-role
-- client, which has no implicit EXECUTE on a hardened/self-hosted
-- Supabase instance).
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer, integer) TO service_role;
