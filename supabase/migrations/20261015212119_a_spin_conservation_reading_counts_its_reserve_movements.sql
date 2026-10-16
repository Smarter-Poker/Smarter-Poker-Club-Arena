-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure))='6aeaa6643c320f8f12004d28bc45c928')
-- 20261015212119_a_spin_conservation_reading_counts_its_reserve_movements.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- The scalar reads Spin entries, prizes and rake but omitted reserve intake
-- and prize funding. Subtract contribution + jackpot_draw (signed amounts).
-- The set scan deliberately excludes spin, so its arithmetic is unaffected.
-- No payment, reserve, wallet, alert or historical settlement is changed.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $patch$
DECLARE sig regprocedure:='public.fn_tournament_conservation_delta(uuid)'::regprocedure;
 def text:=pg_get_functiondef(sig); prior jsonb;
 old text:=$old$    - m.seat_paid_out
$old$;
 new text:=$new$    - m.seat_paid_out
    -- A SPIN COUNTS ITS RESERVE MOVEMENTS (20261015212119). Contributions
    -- leave the event; jackpot draws fund it. Seed repayments and adjustments
    -- belong to the reserve owner, never to this event's prize book.
    - CASE WHEN (SELECT t.variant FROM public.tournaments t WHERE t.id=m.id)='spin'
           THEN COALESCE((SELECT sum(l.amount) FROM public.spin_reserve_ledger l
                          WHERE l.tournament_id=m.id
                            AND l.kind IN ('contribution','jackpot_draw')),0)
           ELSE 0 END
$new$;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN RAISE EXCEPTION 'spin_conservation_operator_refused'; END IF;
 IF public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'spin_conservation_freeze_refused'; END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261015212119') THEN RAISE EXCEPTION 'spin_conservation_replay_refused'; END IF;
 IF md5(def)<>'61f614307807f21710b51c8a881f91da' OR (length(def)-length(replace(def,old,'')))/length(old)<>1 THEN RAISE EXCEPTION 'spin_conservation_preimage_refused'; END IF;
 SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl) INTO prior FROM pg_proc WHERE oid=sig;
 EXECUTE replace(def,old,new);
 IF md5(pg_get_functiondef(sig))<>'6aeaa6643c320f8f12004d28bc45c928' THEN RAISE EXCEPTION 'spin_conservation_postimage_refused'; END IF;
 IF (SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl) FROM pg_proc WHERE oid=sig) IS DISTINCT FROM prior THEN RAISE EXCEPTION 'spin_conservation_security_refused'; END IF;
END $patch$;
COMMIT;
