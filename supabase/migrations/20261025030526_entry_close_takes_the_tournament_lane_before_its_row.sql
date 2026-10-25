-- 20261025030526_entry_close_takes_the_tournament_lane_before_its_row.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ENTRY CLOSE TAKES THE TOURNAMENT LANE BEFORE ITS ROW (2026-10-25).
--
-- THE DEFECT, READ FROM ROWS AND LOGS. Fourteen
-- 'tournament.real_time_payout_refused' alerts in three days, every one
-- {"error":"deadlock detected","sqlstate":"40P01"}. Every one of the fourteen
-- was raised by the transaction that closed the event's entry: its created_at
-- (transaction start) is 0.04 to 3.4 s before the same event's
-- tournament_entry_close_receipts.entry_closed_at (written inside that same
-- transaction), close_mode 'levels', 'minutes', 'immediate' and 'addon'. None
-- was raised by a bust. The postgres log at 2026-10-24 22:31:42-43 UTC
-- (Afternoon Free Buy, add-on close) shows the cycle exactly:
--   process 474478 (COMMIT of fn_close_tournament_addon_period) holds the
--     tournaments row (tuple 168782,2), and its deferred constraint trigger
--     zzz_pay_finishers_when_pool_finalizes -> trg_ca_pay_tournament_
--     finishers_at_commit -> fn_ca_pay_tournament_finishers_now ->
--     fn_ca_lock_settlement_lane_for_tournament waits for T(id) EXCLUSIVE;
--   process 474522 (process_tournament_rebuy, an add-on) holds T(id), taken
--     at its line 71 through the same helper, and waits at line 205 on
--     SELECT ... FROM tournaments FOR UPDATE for transaction 1927727902 (474478).
-- The same shape with other partners at 02:31, 06:04, 06:32, 18:31, 18:40,
-- 19:34, 20:20 and 23:34 UTC: fn_ca_retain_hand_submission (tournaments FOR
-- SHARE), f06_prefix via fn_f06_discover_breaks (tournaments FOR UPDATE),
-- fn_ca_lock_tournament_seat_acquisition inside a rebuy. The hand callers
-- queued SHARED behind the exclusive waiter (fn_f06_hand_number_state,
-- fn_f06_begin_hand, fn_project_hand_side_effects) were the ones killed when
-- the detector picked them.
--
-- THE LINE. Every other writer of this tournament takes the lane first: G
-- shared, then T(id), then the tournaments row (process_tournament_rebuy,
-- fn_eliminate_tournament_player_atomic, fn_ca_pay_tournament_finishers_now
-- itself, f06_prefix, fn_ca_f06_share_table_lane). The two entry-close doors
-- the engine calls, fn_close_tournament_entry_window and
-- fn_close_tournament_addon_period, open with SELECT * FROM tournaments FOR
-- UPDATE and take no lane; the pool finalization inside them
-- (fn_finalize_tournament_entry_pool_locked -> fn_apply_prize_guarantee)
-- flips prize_pool_finalized, so the pay-at-finalization trigger asks for
-- T(id) exclusive at COMMIT while the row is held: row then lane, the one
-- inversion in the lane's order. 20261022091134 already recorded that no
-- retry can resolve it, because the row is held at top level.
--
-- THE FIX. Both doors now take fn_ca_lock_settlement_lane_for_tournament(id)
-- (G shared, T(id) exclusive) as their first statement, before the row, as
-- fn_eliminate_tournament_player_atomic does. At COMMIT the payer's lane
-- request is then re-entrant (this backend already holds G shared and T(id)
-- exclusive), so it waits for no advisory lock while holding a row, and the
-- payer's own FOR UPDATE of the row is this transaction's. Every partner in
-- the log takes T(id) before the row, so with both sides lane-first the
-- closer and any partner meet at T(id) first and one simply waits for the
-- other: no cycle can form between them. The lane is requested by this
-- transaction no more often than before (it was always requested at
-- COMMIT whenever the pool finalized); it is only requested earlier, holding
-- nothing. A NULL id takes no lane (the helper would take the global lane);
-- the row read then answers not_found as before.
--
-- PAYOUTS. The payer, its idempotent obligation door and its exactly-once
-- place keys are not touched. The close of an event whose finalization
-- deadlocked still committed (the refusal is caught in a subtransaction), so
-- every place it could not pay at that moment was paid by the event's next
-- payer pass or its terminal settlement, both of which pay every unpaid
-- place through the same keys; all fourteen events are COMPLETED. Nothing is
-- owed by this migration.
--
-- NOT TOUCHED: fn_finalize_tournament_entry_pool_locked (pinned by the MTT
-- admission contract guard and only reached through these doors),
-- fn_apply_prize_guarantee and the terminal settlements that call it under
-- their own finish or global lane, the payer and its trigger, the lane
-- helpers and the lane doctrine (fn_ca_settlement_lane_doctrine() stays free
-- of violations: the walk from both doors reaches no global-lane caller
-- within four calls). No retry, sweep or cron (CLAUDE.md 10.12).
--
-- Proof: scripts/ci/test-entry-close-takes-the-lane-before-its-row.py
-- reproduces the 40P01 against the exact production definitions and shows it
-- gone after this file. Pinned by
-- tests/entry-close-takes-the-tournament-lane-before-its-row.law.test.ts.

-- @live-proof: (SELECT md5(prosrc)='508e59bc8d5be4439aac1e3054e7fe98' AND md5(pg_get_functiondef(oid))='8cb316d211658925f175131f07a5202a' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef FROM pg_proc WHERE oid='public.fn_close_tournament_entry_window(uuid,text)'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='c570c866b2c9446eed97916edda488a4' AND md5(pg_get_functiondef(oid))='d5e0ba63cb0540f4fbfa5b84563b7ca4' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND prosecdef FROM pg_proc WHERE oid='public.fn_close_tournament_addon_period(uuid,text)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $entry_close_lane$
DECLARE
  v_fn regprocedure;
  v_src text; v_find text; v_lane text; v_n integer;
  v_acl text; v_owner text; v_secdef boolean; v_config text[];
  r record;
BEGIN
  v_lane := '  /* THE LANE BEFORE THE ROW (2026-10-25). G shared, then T(id) exclusive,' || chr(10)
         || '     then the tournaments row: the order of every other writer of this' || chr(10)
         || '     event. Finalizing the pool here fires the deferred payer, which asks' || chr(10)
         || '     for T(id) exclusive at COMMIT; holding the row without the lane made' || chr(10)
         || '     that a deadlock with any rebuy, add-on or hand that holds T(id) and' || chr(10)
         || '     waits for the row. Taken first, the payer''s request is re-entrant. */' || chr(10)
         || '  IF p_tournament_id IS NOT NULL THEN' || chr(10)
         || '    PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);' || chr(10)
         || '  END IF;' || chr(10);

  FOR r IN
    SELECT * FROM (VALUES
      ('public.fn_close_tournament_entry_window(uuid,text)'::regprocedure,
       '45df22d088d6e1e82c7783ae32415112', '80ebd8b605e01996e0844344ba06e451',
       'BEGIN' || chr(10) || '  SELECT * INTO v_t' || chr(10)
         || '    FROM public.tournaments t' || chr(10)
         || '   WHERE t.id=p_tournament_id' || chr(10) || '   FOR UPDATE;' || chr(10),
       '8cb316d211658925f175131f07a5202a', '508e59bc8d5be4439aac1e3054e7fe98'),
      ('public.fn_close_tournament_addon_period(uuid,text)'::regprocedure,
       '385d1b85fd08702be6c9bd046c2a7e76', 'b503380118722ce9a5b8b4467f3c48fd',
       'BEGIN' || chr(10) || '  SELECT * INTO v_t' || chr(10)
         || '    FROM public.tournaments' || chr(10)
         || '   WHERE id=p_tournament_id' || chr(10) || '   FOR UPDATE;' || chr(10),
       'd5e0ba63cb0540f4fbfa5b84563b7ca4', 'c570c866b2c9446eed97916edda488a4')
    ) AS t(fn, pre_def, pre_src, anchor, post_def, post_src)
  LOOP
    v_fn := r.fn;
    SELECT pg_get_functiondef(p.oid), p.proacl::text, p.proowner::regrole::text, p.prosecdef, p.proconfig
      INTO v_src, v_acl, v_owner, v_secdef, v_config
      FROM pg_proc p WHERE p.oid = v_fn;
    IF md5(v_src) <> r.pre_def
       OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> r.pre_src THEN
      RAISE EXCEPTION 'ENTRY_CLOSE_LANE_PREIMAGE_DRIFT: % is %, read it before re-running', v_fn, md5(v_src);
    END IF;
    IF v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
       OR v_owner IS DISTINCT FROM 'postgres' OR v_secdef IS NOT TRUE THEN
      RAISE EXCEPTION 'ENTRY_CLOSE_LANE_PREIMAGE_DRIFT: % owner, ACL or security differ', v_fn;
    END IF;
    v_find := r.anchor;
    v_n := (length(v_src) - length(replace(v_src, v_find, ''))) / length(v_find);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'ENTRY_CLOSE_LANE_ANCHOR: the opening row lock of % was found % times, not once', v_fn, v_n;
    END IF;
    v_src := replace(v_src, v_find,
      'BEGIN' || chr(10) || v_lane || substr(v_find, length('BEGIN' || chr(10)) + 1));
    IF md5(v_src) <> r.post_def THEN
      RAISE EXCEPTION 'ENTRY_CLOSE_LANE_POSTIMAGE: the edited % is %, not the proved post-image', v_fn, md5(v_src);
    END IF;
    EXECUTE v_src;
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = v_fn) <> r.post_src
       OR (SELECT md5(pg_get_functiondef(oid)) FROM pg_proc WHERE oid = v_fn) <> r.post_def
       OR (SELECT proacl::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_acl
       OR (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_owner
       OR (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_secdef
       OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM v_config THEN
      RAISE EXCEPTION 'ENTRY_CLOSE_LANE_POSTIMAGE: installed %, owner, ACL or settings differ from the proved post-image', v_fn;
    END IF;
  END LOOP;
END
$entry_close_lane$;

COMMIT;
