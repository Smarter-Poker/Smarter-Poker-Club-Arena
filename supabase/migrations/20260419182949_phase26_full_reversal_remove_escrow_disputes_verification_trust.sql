-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419182949 "phase26_FULL_REVERSAL_remove_escrow_disputes_verification_trust"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9bba249a6a5524bb3a85e5b405514c66 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 26 FULL REVERSAL
--  Removes ALL Phase 26 artifacts: escrow, disputes, venue claims, 
--  verification tiers, trust scores, monetization metrics.
--  Smarter.Poker does NOT handle money for home games. Period.
-- =========================================================================

-- ─── 1. Unschedule cron ──────────────────────────────────────────────────
DO $$ BEGIN
    PERFORM cron.unschedule('user-trust-scores-refresh');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- ─── 2. Drop RPCs (with explicit signatures) ─────────────────────────────
DROP FUNCTION IF EXISTS public.submit_verification_request(uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public.approve_verification_submission(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.submit_venue_claim(integer, uuid, text, text, text, text, text[], text);
DROP FUNCTION IF EXISTS public.withdraw_venue_claim(uuid, uuid);
DROP FUNCTION IF EXISTS public.approve_venue_claim(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.create_home_game_escrow(uuid, uuid, numeric, numeric, numeric);
DROP FUNCTION IF EXISTS public.record_escrow_contribution(uuid, uuid, numeric, uuid, text, text, int);
DROP FUNCTION IF EXISTS public.transition_escrow_status(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.open_dispute(uuid, text, text, text, text, uuid, numeric, text[]);
DROP FUNCTION IF EXISTS public.post_dispute_message(uuid, uuid, text, text[]);
DROP FUNCTION IF EXISTS public.compute_user_trust_score(uuid);
DROP FUNCTION IF EXISTS public.fn_refresh_user_trust_scores(int);
DROP FUNCTION IF EXISTS public.get_monetization_metrics(uuid, int);

-- ─── 3. Drop tables (CASCADE handles triggers, indexes, policies, FKs) ──
DROP TABLE IF EXISTS commander_dispute_messages CASCADE;
DROP TABLE IF EXISTS commander_disputes CASCADE;
DROP TABLE IF EXISTS commander_home_game_escrow_settlements CASCADE;
DROP TABLE IF EXISTS commander_home_game_escrow_contributions CASCADE;
DROP TABLE IF EXISTS commander_home_game_escrow CASCADE;
DROP TABLE IF EXISTS commander_venue_claim_requests CASCADE;
DROP TABLE IF EXISTS commander_verification_submissions CASCADE;

-- ─── 4. Drop orphan helper function (trigger fn from escrow) ────────────
DROP FUNCTION IF EXISTS public.fn_sync_escrow_counters() CASCADE;

-- ─── 5. Remove Phase 26 columns from profiles ───────────────────────────
ALTER TABLE profiles 
    DROP COLUMN IF EXISTS verification_tier,
    DROP COLUMN IF EXISTS verified_at,
    DROP COLUMN IF EXISTS verified_by,
    DROP COLUMN IF EXISTS verification_note,
    DROP COLUMN IF EXISTS trust_score,
    DROP COLUMN IF EXISTS trust_score_refreshed_at;

-- Note: email_verified, phone_verified, phone were pre-existing — left intact.
