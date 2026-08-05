-- ============================================================
-- Structured notification data, for locale-aware rendering.
--
-- `title`/`body` were pre-rendered English sentences written by the
-- trigger functions below — fine for a single-locale deployment, but
-- the UI has no way to show them in the viewer's own language. This
-- adds a `data` JSONB column carrying the raw values instead, and the
-- client (src/app/(dashboard)/notifications/page.tsx,
-- src/lib/ai/handoff-display.ts) renders title/body from it via
-- next-intl. `title`/`body` are kept and still populated — they're the
-- fallback for rows written before this migration (where `data` is
-- null) and a plain-English audit trail either way.
--
-- `conversations.ai_handoff_summary` changes in lockstep: as of this
-- migration, application code (src/lib/ai/handoff.ts, auto-reply.ts)
-- writes it as a JSON-encoded `HandoffSummaryData` object rather than
-- a formatted sentence. `notify_ai_handoff_queue` /
-- `notify_conversation_assigned` below parse that JSON to build the
-- `ai_handoff` notification's `data`; a value that fails to parse
-- (an older, pre-migration plain-text summary) is treated as absent
-- rather than erroring, so no historical handoff is lost, just
-- unstructured (and still shown, via the raw `body` fallback).
-- ============================================================

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data JSONB;

CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
  v_is_handoff BOOLEAN;
  v_body TEXT;
  v_handoff_data JSONB;
  v_data JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
    v_is_handoff := NEW.ai_handoff_summary IS NOT NULL;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
    v_is_handoff := NEW.ai_handoff_summary IS NOT NULL
      AND NEW.ai_handoff_summary IS DISTINCT FROM OLD.ai_handoff_summary;
  END IF;

  -- Skip self-assignment — nothing to notify the agent about.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  IF v_is_handoff THEN
    v_body := NEW.ai_handoff_summary;
    BEGIN
      v_handoff_data := NEW.ai_handoff_summary::jsonb;
    EXCEPTION WHEN OTHERS THEN
      v_handoff_data := NULL;
    END;
    v_data := COALESCE(v_handoff_data, '{}'::jsonb)
      || jsonb_build_object('contactName', v_contact_name);
  ELSE
    v_body := COALESCE(v_actor_name, 'Someone') || ' assigned you a conversation with '
      || COALESCE(v_contact_name, 'a contact');
    v_data := jsonb_build_object('actorName', v_actor_name, 'contactName', v_contact_name);
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body, data
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    CASE WHEN v_is_handoff THEN 'ai_handoff' ELSE 'conversation_assigned' END,
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    CASE WHEN v_is_handoff THEN 'AI handed off a conversation to you' ELSE 'New conversation assigned' END,
    v_body,
    v_data
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the assignment itself.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;

CREATE OR REPLACE FUNCTION notify_ai_handoff_queue()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_handoff_data JSONB;
  v_data JSONB;
BEGIN
  -- Only the queue case: a specific assignee is covered by
  -- `notify_conversation_assigned` in the same UPDATE.
  IF NEW.assigned_agent_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.ai_handoff_summary IS NULL
     OR NEW.ai_handoff_summary IS NOT DISTINCT FROM OLD.ai_handoff_summary THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  BEGIN
    v_handoff_data := NEW.ai_handoff_summary::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_handoff_data := NULL;
  END;
  v_data := COALESCE(v_handoff_data, '{}'::jsonb)
    || jsonb_build_object('contactName', v_contact_name);

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id, title, body, data
  )
  SELECT
    NEW.account_id,
    p.user_id,
    'ai_handoff',
    NEW.id,
    NEW.contact_id,
    'AI handed off a conversation with ' || COALESCE(v_contact_name, 'a contact'),
    NEW.ai_handoff_summary,
    v_data
  FROM profiles p
  WHERE p.account_id = NEW.account_id;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create queue handoff notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_ai_handoff_queue() OWNER TO postgres;
