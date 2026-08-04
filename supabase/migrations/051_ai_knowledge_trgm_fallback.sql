-- ============================================================
-- 051_ai_knowledge_trgm_fallback.sql — fuzzy fallback for KB lexical
--                                       search misses on plural/gender/
--                                       accent variants
--
-- The problem
--
--   The lexical path (`match_ai_knowledge_fts`, migrations 030/038) uses
--   `to_tsvector('simple', content)` — deliberately no stemming, since
--   wacrm serves many languages. That means an exact-lexeme mismatch
--   returns zero rows even when the content is right there:
--
--     Document: "...Alojamiento (Cabañas): No contamos con alojamiento
--                 dentro del parque. Recomendamos: ..."
--     Customer: "alojamientos?"  (plural)
--       -> 'alojamientos' != 'alojamiento' under 'simple' (no stemming)
--       -> match_ai_knowledge_fts returns 0 rows, model answers generic
--
--   038 already fixed the "requires ALL query words" version of this
--   (AND -> OR matching) — that doesn't help here because a one-word
--   query has nothing to OR against; the single word itself just never
--   matches its own singular/plural/gender/accent variant.
--
-- The fix
--
--   pg_trgm as a third, fuzzy retrieval path — used only to top up
--   `retrieveKnowledge`'s result count when semantic + lexical already
--   came up short (src/lib/ai/knowledge.ts), same "top-up" pattern
--   already chaining semantic -> lexical. Trigram similarity tolerates
--   morphological variation (plural/singular, gender, accents, small
--   typos) without a per-language stemmer, consistent with the
--   deliberately language-neutral design.
--
--   Uses `word_similarity(query, content)`, not `similarity()`: chunks
--   run up to ~1200 chars (src/lib/ai/chunk.ts) and a plain whole-string
--   `similarity()` would dilute a short query's score against all the
--   unrelated text in the rest of a long chunk. `word_similarity` finds
--   the best-matching substring of `content` and normalizes by the
--   query's (short) length instead — the right tool for "does this
--   short phrase appear somewhere in this long text?".
--
--   Threshold 0.3 (looser than pg_trgm's `word_similarity_threshold`
--   GUC default of 0.6 — that GUC only gates the `<%` operator, which
--   this function doesn't use) is a deliberate recall-over-precision
--   choice: this is the last of three top-up layers, only reached once
--   semantic + exact-lexical already failed, so an occasional loosely-
--   relevant chunk costs far less than another silent zero-result miss.
--   If production feedback shows too much noise, 0.4-0.45 is the
--   natural next step.
--
--   No trigram index: per-account knowledge bases are small (dozens to
--   a few hundred chunks, not thousands), and the WHERE clause filters
--   on an explicit function call rather than an indexable operator
--   (`%`/`<%`), so a GiST/GIN trgm index wouldn't be used here anyway.
--
-- Security (do not regress — see 032_fix_ai_knowledge_membership.sql)
--
--   032 documents a real CVE (GHSA-fg5p-2qc3-jmxr): the original
--   retrieval RPCs were SECURITY DEFINER + GRANT ... TO authenticated,
--   letting any logged-in user read another account's knowledge base
--   by passing a foreign p_account_id straight through PostgREST. This
--   function follows the fixed pattern from the start: SECURITY
--   INVOKER, so the existing `ai_knowledge_chunks_select` RLS policy
--   (`is_account_member(account_id)`) actually gates the `authenticated`
--   role. `service_role` (the auto-reply bot) still bypasses RLS by
--   design, unchanged.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_trgm(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, similarity real) AS $$
  SELECT id, content, similarity
  FROM (
    SELECT c.id, c.content,
           word_similarity(regexp_replace(p_query, '[^\w\s]', ' ', 'g'), c.content) AS similarity
    FROM ai_knowledge_chunks c
    WHERE c.account_id = p_account_id
  ) scored
  WHERE similarity > 0.3
  ORDER BY similarity DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_trgm(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_trgm(uuid, text, integer) TO authenticated, service_role;

-- ============================================================
-- Manual validation (run against a live instance — no automated SQL
-- test harness exists in this repo):
--
--   1. select * from match_ai_knowledge_trgm(<account with the
--      "Alojamiento" doc>, 'alojamientos?', 5);
--        -> now returns the chunk containing "Alojamiento (Cabañas)"
--           instead of nothing.
--   2. As a non-member JWT, calling with a foreign p_account_id must
--      return zero rows (same check as 032):
--        POST /rest/v1/rpc/match_ai_knowledge_trgm
--          { "p_account_id": "<other-account>", "p_query": "alojamiento",
--            "p_match_count": 5 }              -> []
-- ============================================================
