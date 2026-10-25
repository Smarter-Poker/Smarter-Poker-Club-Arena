-- 20261025035247_prize_guarantee_takes_the_tournament_lane_before_its_row.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE PRIZE GUARANTEE TAKES THE TOURNAMENT LANE BEFORE ITS ROW (2026-10-25).
--
-- Companion to 20261025030526 (entry close takes the tournament lane before
-- its row). That migration fixed the 40P01 behind every
-- tournament.real_time_payout_refused alert of 2026-10-22..24: the two
-- entry-close doors locked the tournaments row, finalized the pool, and the
-- deferred payer (zzz_pay_finishers_when_pool_finalizes ->
-- fn_ca_pay_tournament_finishers_now) then asked for T(id) EXCLUSIVE at
-- COMMIT while a rebuy, add-on or hand held T(id) and waited for that row.
--
-- public.fn_apply_prize_guarantee is the same inversion behind a third door.
-- It is EXECUTE-granted to service_role, so it is a standalone RPC entry, and
-- it opens (fn_ca_return_excess_start_overlay_locked, then
-- fn_ca_apply_prize_guarantee_core -> fn_apply_prize_guarantee_before_atomic_
-- proof) with SELECT ... FROM tournaments FOR UPDATE and publishes
-- prize_pool_finalized = true without any lane. Called directly over RPC it
-- forms exactly the cycle above with process_tournament_rebuy (lane at its
-- line 71, row at line 205). No production caller uses it that way today (the
-- engine's applyPrizeGuarantee method has no caller), so no alert came from
-- it; this closes the door rather than waiting for one.
--
-- THE FIX. fn_ca_lock_settlement_lane_for_tournament(p_tournament_id) (G
-- shared, then T(id) exclusive) becomes the first statement of the body,
-- before the overlay-return/finalization subtransaction and before any row,
-- only for a non-NULL id (the helper would otherwise take the global lane).
--
-- WHY THIS IS SAFE FOR EVERY CALLER, read from the live catalog:
--   * fn_settle_tournament_places and fn_settle_tournament_final_table_deal
--     call fn_ca_lock_settlement_lane_global before this function. Inside a
--     non-satellite finish that re-enters the finish lane, which already holds
--     G shared and T(id) exclusive: the new request is re-entrant. On the true
--     global path they hold G EXCLUSIVE; every T(id) taker in public and
--     smarter_private takes G (shared) first (fn_ca_lock_satellite_answer_lane
--     through the finish re-entry), so while G exclusive is held no other
--     backend can hold any T key and the request is granted at once.
--   * fn_finalize_tournament_entry_pool_locked (reached only through the two
--     entry-close doors) already holds T(id) once 20261025030526 is installed,
--     so the request is re-entrant. Before that, it is the same T(id) request
--     the deferred payer makes at this transaction's COMMIT whenever the pool
--     finalizes, made earlier with no more locks held: never worse.
--   * A direct RPC call now takes the lane before the row, the order of every
--     other writer of the event.
--
-- The lane doctrine walk (fn_ca_settlement_lane_doctrine rule 4's own
-- regexes, read-only on production) from this function reaches 14 functions
-- within four calls and no global-lane caller; a broader walk counting every
-- `public.name(` mention to depth six reaches 20 and none either. No G
-- exclusive, F or global-lane call is added.
--
-- NOT TOUCHED: the overlay return, the guarantee core and its atomic proof,
-- the payer and its trigger, the lane helpers and the doctrine. Payouts and
-- overlay funding are unchanged and stay idempotent (overlay row ON CONFLICT,
-- journal key, already_finalized). No retry, sweep or cron (CLAUDE.md 10.12).
-- Nothing is owed.
--
-- Pinned by tests/a-prize-guarantee-takes-the-tournament-lane-before-its-row.law.test.ts.

-- @live-proof: (SELECT md5(prosrc)='3d004922f96e428db0df48ecf444750f' AND md5(pg_get_functiondef(oid))='8a2517fe8bdbff92348821650c418507' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef AND proconfig=ARRAY['search_path=public, pg_temp'] FROM pg_proc WHERE oid='public.fn_apply_prize_guarantee(uuid,text)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $guarantee_lane$
DECLARE
  v_fn regprocedure := 'public.fn_apply_prize_guarantee(uuid,text)'::regprocedure;
  v_src text; v_find text; v_n integer;
  v_acl text; v_owner text; v_secdef boolean; v_config text[];
BEGIN
  SELECT pg_get_functiondef(p.oid), p.proacl::text, p.proowner::regrole::text, p.prosecdef, p.proconfig
    INTO v_src, v_acl, v_owner, v_secdef, v_config
    FROM pg_proc p WHERE p.oid = v_fn;
  IF md5(v_src) <> 'c11535297ab88cfdc254f9336fdc5110'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> 'f9ffce0850c1a8df64405a056a9c7648' THEN
    RAISE EXCEPTION 'PRIZE_GUARANTEE_LANE_PREIMAGE_DRIFT: fn_apply_prize_guarantee is %, read it before re-running', md5(v_src);
  END IF;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR v_owner IS DISTINCT FROM 'postgres' OR v_secdef IS NOT TRUE
     OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'PRIZE_GUARANTEE_LANE_PREIMAGE_DRIFT: owner, ACL, security or settings differ';
  END IF;
  v_find := 'BEGIN' || chr(10)
         || '  /* A GUARANTEE IS A FLOOR (2026-10-01). The start-time overlay part that' || chr(10);
  v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'PRIZE_GUARANTEE_LANE_ANCHOR: the body opening was found % times, not once', v_n;
  END IF;
  v_src := replace(v_src, v_find,
       'BEGIN' || chr(10)
    || '  /* THE LANE BEFORE THE ROW (2026-10-25). G shared, then T(id) exclusive,' || chr(10)
    || '     then the tournaments row: the order of every other writer of this' || chr(10)
    || '     event. Finalizing the pool here fires the deferred payer, which asks' || chr(10)
    || '     for T(id) exclusive at COMMIT; holding the row without the lane made' || chr(10)
    || '     that a deadlock with any rebuy, add-on or hand that holds T(id) and' || chr(10)
    || '     waits for the row. Re-entrant for callers that already hold it. */' || chr(10)
    || '  IF p_tournament_id IS NOT NULL THEN' || chr(10)
    || '    PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);' || chr(10)
    || '  END IF;' || chr(10)
    || '  /* A GUARANTEE IS A FLOOR (2026-10-01). The start-time overlay part that' || chr(10));
  IF md5(v_src) <> '8a2517fe8bdbff92348821650c418507' THEN
    RAISE EXCEPTION 'PRIZE_GUARANTEE_LANE_POSTIMAGE: the edited definition is %, not the proved post-image', md5(v_src);
  END IF;
  EXECUTE v_src;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> '3d004922f96e428db0df48ecf444750f'
     OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid = v_fn) <> '8a2517fe8bdbff92348821650c418507'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_acl
     OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_owner
     OR (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_secdef
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_config THEN
    RAISE EXCEPTION 'PRIZE_GUARANTEE_LANE_POSTIMAGE: installed body, owner, ACL or settings differ from the proved post-image';
  END IF;
END
$guarantee_lane$;

COMMIT;
