-- ============================================================
-- 046_social_channels — Instagram DM + Facebook Messenger as
-- additional inbound/outbound channels alongside WhatsApp.
--
-- Every table so far assumes WhatsApp: `contacts.phone` is the sole
-- identity key (migration 022's dedup unique index), and
-- `whatsapp_config` holds exactly one connection per account. This
-- migration widens `contacts`/`conversations` with a `channel`
-- discriminator (same pattern as `ai_tools.type`, migration 044) and
-- adds a new `social_channel_config` table for Instagram/Messenger
-- credentials, entered manually (Page ID / IG Business ID + Page
-- Access Token) the same way `whatsapp_config` is today — no OAuth.
--
-- Scope: inbound webhook + AI auto-reply + manual agent reply only.
-- Flows/Automations/templates/interactive messages stay WhatsApp-only
-- for now — see src/app/api/social/webhook/route.ts.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---- contacts: channel + external_id ---------------------------
-- `phone` was NOT NULL — Instagram/Messenger contacts have no phone,
-- only a channel-scoped id Meta assigns (IGSID/PSID). Existing rows
-- are unaffected: they keep 'whatsapp' + NULL external_id, and
-- `phone_normalized` (migration 022) already tolerates NULL phone
-- (regexp_replace(NULL, ...) = NULL, excluded by that index's
-- `WHERE phone_normalized <> ''` the same way empty string is).
ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_channel_check;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_channel_check CHECK (channel IN ('whatsapp', 'instagram', 'messenger'));

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS external_id TEXT;

-- One identity per channel per account. Partial — only applies to
-- rows that actually have an external_id (Instagram/Messenger);
-- WhatsApp contacts keep using the phone_normalized unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_channel_external_id
  ON contacts (account_id, channel, external_id)
  WHERE external_id IS NOT NULL;

-- ---- conversations: channel (denormalized from contact) --------
-- Lets the inbox filter/badge by channel without joining contacts,
-- same denormalization style as `last_message_text`.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('whatsapp', 'instagram', 'messenger'));

-- ---- social_channel_config ---------------------------------------
-- One row per (account, channel) — mirrors whatsapp_config's shape
-- and RLS pattern (migration 001 + 017) rather than one table per
-- channel, following the ai_tools discriminator precedent.
CREATE TABLE IF NOT EXISTS social_channel_config (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Audit owner, same NOT NULL contract as whatsapp_config.user_id —
  -- inbound contact/conversation inserts need a valid auth.users id
  -- for their own NOT NULL user_id column.
  created_by   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL CHECK (channel IN ('instagram', 'messenger')),
  -- Messenger sends via the Facebook Page node; Instagram messaging
  -- (Page-linked) also sends via the Page node but reads/validates
  -- against the linked IG professional account id.
  page_id      TEXT NOT NULL,
  ig_business_id TEXT,
  access_token TEXT NOT NULL,
  verify_token TEXT,
  status       TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
  connected_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_social_channel_config_account ON social_channel_config(account_id);

ALTER TABLE social_channel_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS social_channel_config_select ON social_channel_config;
CREATE POLICY social_channel_config_select ON social_channel_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS social_channel_config_insert ON social_channel_config;
CREATE POLICY social_channel_config_insert ON social_channel_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS social_channel_config_update ON social_channel_config;
CREATE POLICY social_channel_config_update ON social_channel_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS social_channel_config_delete ON social_channel_config;
CREATE POLICY social_channel_config_delete ON social_channel_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_social_channel_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_channel_config_updated_at ON social_channel_config;
CREATE TRIGGER social_channel_config_updated_at
  BEFORE UPDATE ON social_channel_config
  FOR EACH ROW
  EXECUTE FUNCTION public.update_social_channel_config_updated_at();
