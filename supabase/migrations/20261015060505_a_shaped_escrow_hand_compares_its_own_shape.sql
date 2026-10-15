-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_union_pnl_posthand_escrow_touch(public.union_pnl_cash_outcome_touches)'::regprocedure))='e51decda42bbe46dd90aaf1bd3119023')
-- 20261015060505_a_shaped_escrow_hand_compares_its_own_shape.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The original week (union fade0000, 2026-10-05 -> 2026-10-12) can never
-- certify its club P&L. fn_union_pnl_week_hand_lines raises
-- posthand_escrow_projection_touch_disagrees for hand 31008564 of table
-- 1c531058 (2026-10-10 18:23 UTC), the only hand on the platform that carries a
-- posthand escrow certificate.
--
-- Read from rows: the hand's touch row (union_pnl_cash_outcome_touches) holds
-- its participants as fn_union_pnl_cash_outcome_touch_row writes them, through
-- fn_union_pnl_compact_participants (user_id, earning_club_id,
-- observed_stack_delta). fn_union_pnl_posthand_escrow_touch compared that compact
-- array with the outcome's FULL participants (is_horse, ownership_scope,
-- funding_receipt_ids, ownership_certified as well), so the two can never be
-- equal and the check refuses every shaped escrow hand, however correct it is.
-- compact(outcome participants) equals the touch exactly for this hand.
--
-- The root fix is the comparison: the touch is checked against the compact form
-- of the outcome's participants, the shape the touch was written in. Every other
-- refusal is unchanged: a missing outcome, a different recognized_at, union or
-- accepted rake, and any participant value that differs (proved in production
-- against a forged delta, a NULL touch and a shifted recognized_at, each still
-- refused with the same error). Owner, security definer, config and ACL are
-- unchanged. No row, certificate or money is written.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
SET LOCAL search_path=public;
DO $guard$BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'escrow_touch_shape_operator_refused' USING ERRCODE='42501';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL THEN RAISE EXCEPTION 'escrow_touch_shape_override_refused';END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'escrow_touch_shape_freeze_refused';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015060505') THEN RAISE EXCEPTION 'escrow_touch_shape_history_replay';END IF;
END $guard$;

DO $install$
DECLARE
 sig constant regprocedure:='public.fn_union_pnl_posthand_escrow_touch(public.union_pnl_cash_outcome_touches)'::regprocedure;
 def text:=pg_get_functiondef(sig);
 o text:=$anchor$  OR o.evidence->'participants' IS DISTINCT FROM h.participants THEN$anchor$;
 n text:=$anchor$  OR public.fn_union_pnl_compact_participants(o.evidence->'participants') IS DISTINCT FROM h.participants THEN$anchor$;
 before text;
BEGIN
 IF md5(def)<>'ea07d6fa0e981ae635e6c5a6f8aeb067' THEN RAISE EXCEPTION 'escrow_touch_shape_preimage_refused';END IF;
 IF (length(def)-length(replace(def,o,'')))/length(o)<>1 THEN RAISE EXCEPTION 'escrow_touch_shape_anchor_refused';END IF;
 SELECT concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')) INTO before FROM pg_proc p WHERE p.oid=sig;
 EXECUTE replace(def,o,n);
 IF md5(pg_get_functiondef(sig))<>'e51decda42bbe46dd90aaf1bd3119023' THEN RAISE EXCEPTION 'escrow_touch_shape_postimage_refused';END IF;
 IF (SELECT concat_ws('|',p.proowner::regrole,p.prosecdef,p.provolatile,array_to_string(p.proconfig,','),array_to_string(p.proacl,',')) FROM pg_proc p WHERE p.oid=sig) IS DISTINCT FROM before THEN RAISE EXCEPTION 'escrow_touch_shape_security_refused';END IF;
END $install$;

COMMIT;
