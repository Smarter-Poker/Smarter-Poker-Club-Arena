-- 20261025000729_lightning_hands_reach_the_stats_facts_and_the_collusion_scan.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A LIGHTNING HAND IS A HAND IN THE STATS, AND IN THE COLLUSION SCAN.
-- Production 2026-10-24: 0 of 40 sampled settled Lightning hands had a
-- ca_hand_facts row or a ca_hand_transfers row; 40 of 40 physical hands of the
-- same hour had both. fn_ca_collusion_scan reads only ca_hand_transfers, the
-- player statistics and fn_lightning_session_stats' own VPIP/PFR read
-- ca_hand_facts, and fn_cash_vpip_status / fn_nit_check judge the VPIP floor
-- from it - so every fast-fold hand was invisible to all of them.
--
-- The cause: the physical engine puts its private per-hand facts in the hand
-- row's `_accepted_post_commit_facts.stats_facts`, the accepted-hand door
-- stores them in hand_atomic_commits, and the post-commit projector
-- (ca_project_hand_stats_facts) writes ca_hand_facts and ca_hand_transfers
-- from that receipt. fn_lightning_settle_hand rebuilds
-- `_accepted_post_commit_facts` from its own contributions and drops
-- everything else, and it strips the row id the facts are keyed by.
--
-- The engine now builds the facts with the same builder as a physical hand
-- (services/supabase/handFacts.ts writeHandFacts collectOnly), keyed by the
-- Lightning hand id. This keeps them, and only when they name exactly this
-- hand, this host table and its club, in the exact shape the projector accepts
-- (the projector RAISES on anything else, and a refused projection would hold
-- the hand's other side effects). A kept set also gives the hand row this
-- hand's id, so the facts and the row agree. Anything else is dropped, exactly
-- as today: an engine that sends no facts settles byte-for-byte as before.
--
-- No chip, stack, rake, seat or session row is touched; one function is added
-- and one expression inside the settlement function grows by one optional
-- object. Not a hot-table lock: plain function DDL, applied on merge.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)) = 'e6cc04d7031ed3fa1454df89c45533a1') AND to_regprocedure('public.fn_lightning_hand_stats_facts(jsonb,uuid,uuid,uuid)') IS NOT NULL

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';

CREATE FUNCTION public.fn_lightning_hand_stats_facts(
  p_row jsonb, p_hand_id uuid, p_table_id uuid, p_club_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp AS $function$
DECLARE
  s jsonb;
  n integer;
  m integer;
BEGIN
  s := p_row #> '{_accepted_post_commit_facts,stats_facts}';
  IF jsonb_typeof(s) IS DISTINCT FROM 'object'
     OR p_hand_id IS NULL OR p_table_id IS NULL OR p_club_id IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;
  BEGIN
    -- ca_project_hand_stats_facts' own checks, in its own order and casts.
    IF coalesce(s->>'version','') NOT IN ('1','2')
       OR jsonb_typeof(s->'facts') IS DISTINCT FROM 'array'
       OR jsonb_typeof(s->'transfers') IS DISTINCT FROM 'array' THEN
      RETURN '{}'::jsonb;
    END IF;
    n := jsonb_array_length(s->'facts');
    m := jsonb_array_length(s->'transfers');
    IF n NOT BETWEEN 1 AND 10 OR m NOT BETWEEN 0 AND 90 THEN
      RETURN '{}'::jsonb;
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(s->'facts') f
       WHERE jsonb_typeof(f) IS DISTINCT FROM 'object'
          OR (f->>'hand_id')::uuid IS DISTINCT FROM p_hand_id
          OR (f->>'table_id')::uuid IS DISTINCT FROM p_table_id
          OR (f->>'club_id')::uuid IS DISTINCT FROM p_club_id
          OR coalesce(f->>'tournament_id','') <> ''
          OR (f->>'user_id')::uuid IS NULL
    ) OR (
      SELECT count(DISTINCT (f->>'user_id')::uuid) FROM jsonb_array_elements(s->'facts') f
    ) IS DISTINCT FROM n THEN
      RETURN '{}'::jsonb;
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(s->'transfers') x
       WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
          OR (x->>'hand_id')::uuid IS DISTINCT FROM p_hand_id
          OR (x->>'table_id')::uuid IS DISTINCT FROM p_table_id
          OR (x->>'club_id')::uuid IS DISTINCT FROM p_club_id
    ) THEN
      RETURN '{}'::jsonb;
    END IF;
    -- Unknown keys cannot survive the projector's exact readback comparison.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(s->'facts') f,
                    LATERAL jsonb_object_keys(f) k
      WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = 'public.ca_hand_facts'::regclass
          AND a.attname = k AND a.attnum > 0 AND NOT a.attisdropped)
        AND k <> 'all_in_equity_owed'
    ) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(s->'transfers') x,
                    LATERAL jsonb_object_keys(x) k
      WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = 'public.ca_hand_transfers'::regclass
          AND a.attname = k AND a.attnum > 0 AND NOT a.attisdropped)
    ) THEN
      RETURN '{}'::jsonb;
    END IF;
    -- The projector's row types: a value it cannot read is refused here, not
    -- after the hand has committed.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(s->'facts') raw,
        LATERAL jsonb_populate_record(NULL::public.ca_hand_facts, raw) f
      WHERE NOT ((to_jsonb(f)-'played_at'-'created_at'-'source_hash'-'all_in_equity_owed')
              @> (raw-'played_at'-'created_at'-'source_hash'-'all_in_equity_owed'))
    ) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(s->'transfers') raw,
        LATERAL jsonb_populate_record(NULL::public.ca_hand_transfers, raw) x
      WHERE NOT ((to_jsonb(x)-'played_at'-'created_at')
              @> (raw-'played_at'-'created_at'))
    ) THEN
      RETURN '{}'::jsonb;
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_populate_recordset(NULL::public.ca_hand_facts, s->'facts') f
      WHERE f.played_at IS NULL OR f.game_variant IS NULL OR f.big_blind IS NULL
         OR f.position IS NULL OR f.players_dealt IS NULL
         OR f.invested IS NULL OR f.returned IS NULL OR f.net IS NULL
         OR f.net_bb IS NULL OR f.rake_paid IS NULL
         OR f.vpip IS NULL OR f.pfr IS NULL OR f.three_bet IS NULL OR f.four_bet IS NULL
         OR f.faced_three_bet IS NULL OR f.folded_to_three_bet IS NULL
         OR f.had_cbet_flop_opp IS NULL OR f.cbet_flop IS NULL
         OR f.saw_flop IS NULL OR f.went_to_showdown IS NULL
         OR f.won_at_showdown IS NULL OR f.aggressive_actions IS NULL
         OR f.passive_actions IS NULL OR f.was_all_in IS NULL
         OR f.ev_net IS NULL OR f.ev_net_bb IS NULL
         OR (f.all_in_equity IS NOT NULL AND NOT (f.all_in_equity BETWEEN 0 AND 1))
    ) OR EXISTS (
      SELECT 1 FROM jsonb_populate_recordset(NULL::public.ca_hand_transfers, s->'transfers') x
      WHERE x.winner_id IS NULL OR x.loser_id IS NULL OR x.played_at IS NULL
         OR x.amount IS NULL OR NOT (x.amount > 0) OR x.winner_id = x.loser_id
         OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'facts') f
                        WHERE (f->>'user_id')::uuid = x.winner_id)
         OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s->'facts') f
                        WHERE (f->>'user_id')::uuid = x.loser_id)
    ) OR (SELECT count(DISTINCT ((x->>'winner_id')::uuid, (x->>'loser_id')::uuid))
            FROM jsonb_array_elements(s->'transfers') x) IS DISTINCT FROM m THEN
      RETURN '{}'::jsonb;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN '{}'::jsonb;
  END;
  RETURN jsonb_build_object('stats_facts', s);
END
$function$;

REVOKE ALL ON FUNCTION public.fn_lightning_hand_stats_facts(jsonb,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_lightning_hand_stats_facts(jsonb,uuid,uuid,uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_lightning_hand_stats_facts(jsonb,uuid,uuid,uuid) TO service_role;

DO $patch$
DECLARE
  sig constant regprocedure := 'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure;
  before text := pg_get_functiondef(sig);
  after text;
  security_before jsonb;
  a text := $a$                  '_accepted_post_commit_facts', jsonb_build_object(
                    'contributions', v_contrib, 'returned_uncalled', v_returned, 'insurance', '[]'::jsonb));$a$;
  b text := $b$                  '_accepted_post_commit_facts', jsonb_build_object(
                    'contributions', v_contrib, 'returned_uncalled', v_returned, 'insurance', '[]'::jsonb)
                    -- A LIGHTNING HAND IS A HAND IN THE STATS (20261025000729): the
                    -- engine's private per-hand facts, kept only when they name exactly
                    -- this hand, host table and club; the row then takes this hand's id
                    -- so the facts and the row agree. Otherwise dropped, as before.
                    || public.fn_lightning_hand_stats_facts(v_row_in, p_hand_id, p_host_table_id, t.club_id))
             || CASE WHEN public.fn_lightning_hand_stats_facts(v_row_in, p_hand_id, p_host_table_id, t.club_id) = '{}'::jsonb
                     THEN '{}'::jsonb ELSE jsonb_build_object('id', p_hand_id) END;$b$;
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres'
     OR NULLIF(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'lightning_settlement_operator_refused';
  END IF;
  IF NULLIF(current_setting('ca.break_window_migration_override', true), '') IS NOT NULL
     OR public.fn_platform_frozen() IS DISTINCT FROM false
     OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
    RAISE EXCEPTION 'lightning_settlement_freeze_or_override_refused';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261025000729') THEN
    RAISE EXCEPTION 'lightning_settlement_migration_replay_refused';
  END IF;
  IF md5(before) <> '0670ed75762f05e7ad3346a1c95e84dc' THEN
    RAISE EXCEPTION 'lightning_settlement_preimage_refused: %', md5(before);
  END IF;
  SELECT jsonb_build_array(proowner, prosecdef, provolatile, proconfig, proacl)
    INTO security_before FROM pg_proc WHERE oid = sig;
  IF (length(before) - length(replace(before, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION 'lightning_settlement_anchor_refused';
  END IF;
  after := replace(before, a, b);
  IF md5(after) <> 'e6cc04d7031ed3fa1454df89c45533a1' THEN
    RAISE EXCEPTION 'lightning_settlement_derived_postimage_refused: %', md5(after);
  END IF;
  EXECUTE after;
  IF md5(pg_get_functiondef(sig)) <> 'e6cc04d7031ed3fa1454df89c45533a1'
     OR (SELECT jsonb_build_array(proowner, prosecdef, provolatile, proconfig, proacl)
           FROM pg_proc WHERE oid = sig) IS DISTINCT FROM security_before THEN
    RAISE EXCEPTION 'lightning_settlement_postimage_or_security_refused';
  END IF;
END $patch$;

COMMIT;
