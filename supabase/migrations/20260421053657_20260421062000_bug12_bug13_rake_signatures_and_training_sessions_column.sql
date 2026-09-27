-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260421053657 "20260421062000_bug12_bug13_rake_signatures_and_training_sessions_column"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 196def53826e4fc502a14a1cc00005fa of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ══════════════════════════════════════════════════════════════════════════
-- BUG-12 (HIGH — every hand + every tournament registration errors)
-- ══════════════════════════════════════════════════════════════════════════
-- The 20260314_phantom_rpcs migration created intentional no-op stubs for
-- record_rake and calculate_cascading_commission, but the stub signatures
-- DO NOT MATCH the caller signatures, so PostgreSQL function resolution
-- fails with 42883 "function does not exist" on every call.
--
-- Verified live via probe:
--   record_rake(p_hand_id, p_club_id, p_table_id, p_rake_amount,
--               p_pot_size, p_num_players) → 42883
--   calculate_cascading_commission(p_hand_id, p_club_id,
--               p_player_user_id, p_rake_amount) → 42883
--
-- Callers:
--   pages/api/club-arena/record-rake.js          (API route)
--   pages/api/cron/auto-settlement.js            (cron only references)
--   src/lib/poker-engine/LobbyManager.js:832,893 (every hand concluded)
--   src/lib/poker-engine/TournamentController.js:507 (every tourney reg)
--   pages/api/club-arena/union-games.js          (tournament flows)
--
-- Intent per the phantom_rpcs migration is that these are no-ops until
-- the real commission/rake pipeline is built. Fix = add overloads that
-- match the ACTUAL caller signatures and return the same no-op shape.
-- Keep the old overloads in place (they are independently callable by
-- other code paths still using the old signatures, if any).
--
-- record_rake also increments clubs.total_rake per the original design,
-- so this overload performs that single real side-effect to preserve
-- at least partial correctness until the full pipeline is written.

CREATE OR REPLACE FUNCTION public.record_rake(
  p_hand_id text DEFAULT NULL,
  p_club_id uuid DEFAULT NULL,
  p_table_id uuid DEFAULT NULL,
  p_rake_amount numeric DEFAULT 0,
  p_pot_size numeric DEFAULT 0,
  p_num_players integer DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Minimal real work: roll up club-level rake so dashboards aren't frozen.
  -- Remaining work (BBJ contribution, commission posting, settlement
  -- counters) is a separate unresolved feature — returning a no-op success
  -- preserves the intent of the 20260314 phantom-stub migration.
  IF p_club_id IS NOT NULL AND p_rake_amount > 0 THEN
    BEGIN
      UPDATE public.clubs
         SET total_rake = COALESCE(total_rake, 0) + p_rake_amount,
             updated_at = now()
       WHERE id = p_club_id;
    EXCEPTION WHEN undefined_column OR undefined_table THEN
      NULL;
    END;
  END IF;
  RETURN jsonb_build_object('success', true, 'hand_id', p_hand_id, 'rake', p_rake_amount);
END;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_cascading_commission(
  p_hand_id text DEFAULT NULL,
  p_club_id uuid DEFAULT NULL,
  p_player_user_id uuid DEFAULT NULL,
  p_rake_amount numeric DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Intentional stub matching the 20260314 phantom-rpcs pattern — the
  -- real cascade logic isn't built; return the shape callers check
  -- for (`success=true`, empty commissions). Callers that previously
  -- hit 42883 and landed in console.error will now silently succeed.
  RETURN jsonb_build_object(
    'success', true,
    'hand_id', p_hand_id,
    'club_id', p_club_id,
    'player_user_id', p_player_user_id,
    'rake_amount', p_rake_amount,
    'commissions', '[]'::jsonb
  );
END;
$function$;

-- ══════════════════════════════════════════════════════════════════════════
-- BUG-13 (HIGH — every training-session write AND every training-analytics
-- read in prod errors; live-tailing Vercel showed /api/gto/get-weak-spots
-- firing 500s at a steady cadence across the past 72h)
-- ══════════════════════════════════════════════════════════════════════════
-- The jarvis_training_sessions table has column `answers` (jsonb).
-- SEVEN distinct API routes refer to the column as `answers_data`:
--   pages/api/jarvis/training-session.js:86     (INSERT: answers_data: ...)
--   pages/api/gto/get-weak-spots.js:42,96       (SELECT + use)
--   pages/api/gto/generate-adaptive.js:94,107   (SELECT + use)
--   pages/api/gto/session-recommendations.js:97 (SELECT)
--   pages/api/cron/training-daily-report.js:49  (SELECT)
-- Zero code files read or write the bare name `answers`. Every call to
-- any of these five routes has been failing since this table was made.
--
-- Fix: rename the column to match what the entire codebase expects.
-- This is the one-shot DB fix; no code deploy required.

ALTER TABLE public.jarvis_training_sessions
  RENAME COLUMN answers TO answers_data;
