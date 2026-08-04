-- ============================================================
-- 049_ai_quick_links.sql
--
-- Quick links (Google Maps, "how to get there" video, booking site,
-- accommodations, etc.) the auto-reply agent can offer as tappable
-- WhatsApp CTA-URL buttons. Configured once in Settings; the model
-- references one by `key` via the `[[LINK:<key>]]` sentinel in its
-- reply (see src/lib/ai/defaults.ts), and src/lib/ai/auto-reply.ts
-- sends the matching link as its own interactive message.
--
-- Shape: a JSON array of { key: string, label: string, url: string }.
-- `key` is the stable id the model emits; `label` is the button's
-- visible text (<= Meta's 20-char button-title limit, enforced in
-- src/app/api/ai/config/route.ts, not here). No SQL CHECK constraint
-- on the array shape — validated at the API layer so it can evolve
-- without a migration.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS quick_links JSONB NOT NULL DEFAULT '[]'::jsonb;
