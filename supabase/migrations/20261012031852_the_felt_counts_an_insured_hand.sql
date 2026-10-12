-- the_felt_counts_an_insured_hand
--
-- AN INSURED HAND IS ON THE FELT BY ITS JOURNAL TOO (2026-10-12). Full account:
-- docs/changelog/2026-10-12-the-felt-counts-an-insured-hand.md.
--
-- Account: table_stack:00000000-0000-0000-0000-0000000fe17e:table_seats.stack,
-- read by fn_ca_account_balance('table_seats.stack') for fn_ca_ledger_replay.
--
-- 20261011200421 made the felt reader count, beside the open seats, the rake
-- and jackpot drop of every settled hand whose post-commit obligations have not
-- committed, read from the hand's post_commit_payload. That explains incident
-- 9294e359 (+9.76 and +4.10, each one hand's fees caught between the two
-- halves; re-measured to the cent against the replay's own snapshots). It left
-- out the third leg the second half posts. The hand commit moves the seats by
-- inflow - rake - bbj (the database asserts it on every hand), and
-- fn_ca_process_hand_post_commit_obligations posts the rake, the drop AND the
-- insurance bank's leg (record_insurance_transaction, counterparty table_stack)
-- in the next transaction. A reading between the halves of an insured hand
-- would read the felt long of its journal by the inflow, and the next reading
-- would report it as drift. The per-transaction ledger invariant already
-- carries an unposted hand as rake + bbj - inflow from its stack result
-- (fn_ca_tally_balance_move, 20261001231409); the replay's reader now counts
-- the same quantity from the same column, so the two definitions of the felt
-- cannot disagree.
--
-- 1. fn_ca_account_balance('table_seats.stack'): the unposted hand term reads
--    stack_result rake + bbj - inflow instead of the payload's rake and drop.
--    On every chip hand the two agree to the cent when inflow is 0 (82,666 of
--    82,666 measured 2026-10-12); insurance last paid on 2026-08-29.
-- 2. No new reading is taken and the cumulative is not reset: the proof
--    refuses to apply while an insured hand is between its halves, so the
--    previous reading is exactly what the new reader would have read.
--
-- @live-proof: (SELECT position('AN INSURED HAND IS ON THE FELT BY ITS JOURNAL TOO' IN pg_get_functiondef('public.fn_ca_account_balance(text,uuid,uuid,text)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'INSURED_FELT_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_ca_account_balance(text,uuid,uuid,text)'::regprocedure);
BEGIN
  IF position('AN INSURED HAND IS ON THE FELT BY ITS JOURNAL TOO' IN v_src) > 0 THEN
    RAISE NOTICE 'INSURED_FELT already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM '3b5ade0f0b3e026e9fe037bbeb7d3dbe' THEN
    RAISE EXCEPTION 'INSURED_FELT_PREIMAGE_CHANGED';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$        + (SELECT COALESCE(sum(COALESCE((c.post_commit_payload->'rake'->>'amount')::numeric, 0)
                               + COALESCE((c.post_commit_payload->'bbj_contribution'->>'amount')::numeric, 0)), 0)
$a$,
$a$        /* AN INSURED HAND IS ON THE FELT BY ITS JOURNAL TOO (2026-10-12). The
           commit moves the seats by inflow - rake - bbj, and the post-commit
           obligations post the rake, the drop and the insurance bank's leg.
           So an unposted hand is on the felt by rake + bbj - inflow, read
           from the stack result the seats were moved by: the quantity
           fn_ca_tally_balance_move carries for the hand (20261001231409). */
        + (SELECT COALESCE(sum(COALESCE((c.stack_result->>'rake')::numeric, 0)
                               + COALESCE((c.stack_result->>'bbj')::numeric, 0)
                               - COALESCE((c.stack_result->>'inflow')::numeric, 0)), 0)
$a$, 'unposted hand');
  EXECUTE v_src;
END
$patch$;

DO $prove$
DECLARE v_fn numeric; v_seats numeric; v_addons numeric; v_owed numeric; v_inflow numeric;
BEGIN
  IF position('AN INSURED HAND IS ON THE FELT BY ITS JOURNAL TOO' IN pg_get_functiondef('public.fn_ca_account_balance(text,uuid,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'INSURED_FELT_RESULT_CHANGED: not live';
  END IF;
  -- One statement, one snapshot: the reader is STABLE.
  SELECT public.fn_ca_account_balance('table_stack', '00000000-0000-0000-0000-0000000fe17e'::uuid, NULL, 'table_seats.stack'),
         (SELECT COALESCE(sum(ts.stack), 0) FROM public.table_seats ts
           WHERE ts.left_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM public.tables t
                              WHERE t.id = ts.table_id
                                AND (t.tournament_id IS NOT NULL
                                     OR EXISTS (SELECT 1 FROM public.clubs cl
                                                 WHERE cl.id = t.club_id AND cl.asset = 'diamonds')))),
         (SELECT COALESCE(sum(pa.amount), 0) FROM public.table_pending_addons pa
           WHERE pa.resolved_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM public.tables t
                              WHERE t.id = pa.table_id
                                AND (t.tournament_id IS NOT NULL
                                     OR EXISTS (SELECT 1 FROM public.clubs cl
                                                 WHERE cl.id = t.club_id AND cl.asset = 'diamonds')))),
         (SELECT COALESCE(sum(COALESCE((c.stack_result->>'rake')::numeric, 0)
                              + COALESCE((c.stack_result->>'bbj')::numeric, 0)
                              - COALESCE((c.stack_result->>'inflow')::numeric, 0)), 0)
            FROM public.hand_atomic_commits c
           WHERE c.post_commit_payload IS NOT NULL AND c.post_commit_completed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM public.tables t
                              WHERE t.id = c.table_id
                                AND (t.tournament_id IS NOT NULL
                                     OR EXISTS (SELECT 1 FROM public.clubs cl
                                                 WHERE cl.id = t.club_id AND cl.asset = 'diamonds')))),
         (SELECT COALESCE(sum(COALESCE((c.stack_result->>'inflow')::numeric, 0)), 0)
            FROM public.hand_atomic_commits c
           WHERE c.post_commit_payload IS NOT NULL AND c.post_commit_completed_at IS NULL)
    INTO v_fn, v_seats, v_addons, v_owed, v_inflow;
  IF v_fn IS DISTINCT FROM v_seats + v_addons + v_owed THEN
    RAISE EXCEPTION 'INSURED_FELT_RESULT_CHANGED: reader % seats % add-ons % owed %', v_fn, v_seats, v_addons, v_owed;
  END IF;
  -- An insured hand between its halves would make the previous reading
  -- incomparable with this reader; apply again once it has posted.
  IF v_inflow <> 0 THEN
    RAISE EXCEPTION 'INSURED_FELT_RESULT_CHANGED: an insured hand is between its halves (inflow %)', v_inflow;
  END IF;
END
$prove$;

COMMIT;
