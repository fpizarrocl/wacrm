-- ============================================================
-- 052_ai_escalation_categories.sql
--
-- Categorized handoff: lets the auto-reply agent recognize a specific
-- kind of request (complaint, partnership inquiry, special event...)
-- and escalate to a human with (a) a fixed, admin-written closing
-- message sent verbatim — never the model's own paraphrase — and (b) a
-- tag applied to the contact so the category is visible at a glance in
-- the inbox and can drive `tag_added` automations.
--
-- Shape: a JSON array of
--   { key: string, label: string, tagId: string, closingPhrase: string }
-- `key` is what the model references via the `[[HANDOFF:<key>]]`
-- sentinel (see src/lib/ai/defaults.ts); `tagId` must reference an
-- existing row in `tags` for the account (validated in
-- src/app/api/ai/config/route.ts, not here — same soft-reference
-- approach as quick_links, migration 049).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS escalation_categories JSONB NOT NULL DEFAULT '[]'::jsonb;
