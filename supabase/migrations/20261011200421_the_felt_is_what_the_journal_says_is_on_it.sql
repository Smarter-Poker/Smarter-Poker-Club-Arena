-- the_felt_is_what_the_journal_says_is_on_it
--
-- THE FELT IS WHAT THE JOURNAL SAYS IS ON IT (2026-10-11). Full account:
-- docs/changelog/2026-10-11-the-felt-is-what-the-journal-says-is-on-it.md.
--
-- fn_ca_ledger_replay judges the cash felt (table_stack:...0fe17e:
-- table_seats.stack) by comparing how far fn_ca_account_balance says it moved
-- with the chip_ledger legs that moved it, both read under one snapshot. The
-- reader counted only open seats. Two kinds of chips are on the felt by the
-- journal while they are on no seat:
--   - a settled hand's rake and jackpot drop. The hand commit takes them off
--     the seats; the legs that carry them to the rake wallet and the jackpot
--     are written by the hand's post-commit obligations in the NEXT
--     transaction (fn_ca_process_hand_post_commit_obligations, about 0.2 s
--     later, stamping hand_atomic_commits.post_commit_completed_at);
--   - a mid-hand add-on. Its player_wallet -> table_stack leg is written when
--     it is bought; the seat is credited when the hand ends (the supply meter
--     already counts these, as pending_addons beside the felt).
-- A reading that fell between the two halves read the felt short of the
-- journal by exactly that amount, and the next reading read the difference
-- back as drift. Measured: the felt reading of 2026-10-09 16:43 (20261009164317)
-- caught six hands whose 13.86 of rake and drop were settled but not yet
-- journaled; the 2026-10-10 06:40 replay caught one such hand (4.10, table
-- bd52ccec); the 2026-10-11 06:40 replay caught none. Hence +9.76 (= 13.86 -
-- 4.10) and +4.10, cumulative 13.86 (incident 9294e359). No seat, wallet or
-- jackpot was ever short or long: every one of those legs committed within
-- ten seconds of its hand.
--
-- 1. fn_ca_account_balance('table_seats.stack') counts, beside the open seats,
--    the unresolved add-ons and the rake and drop of every settled hand whose
--    post-commit obligations have not committed, on the same tables (no
--    tournament, no Diamond club). Both reads use their partial indexes.
-- 2. The felt account takes one new reading on the new definition, in one
--    statement with the snapshot it read under (basis one-snapshot-v4,
--    cumulative 0), so the 13.86 the old reader's first reading put into the
--    cumulative is not carried. No other account is touched; no balance moves.
--
-- @live-proof: (SELECT position('THE FELT IS WHAT THE JOURNAL SAYS IS ON IT' IN pg_get_functiondef('public.fn_ca_account_balance(text,uuid,uuid,text)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'JOURNAL_FELT_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_ca_account_balance(text,uuid,uuid,text)'::regprocedure);
BEGIN
  IF position('THE FELT IS WHAT THE JOURNAL SAYS IS ON IT' IN v_src) > 0 THEN
    RAISE NOTICE 'JOURNAL_FELT already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM '437d6069822801da5b61035e41df1c48' THEN
    RAISE EXCEPTION 'JOURNAL_FELT_PREIMAGE_CHANGED';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$      v_rows := 1;  -- the felt always exists, even when every seat is empty
$a$,
$a$      v_rows := 1;  -- the felt always exists, even when every seat is empty
      /* THE FELT IS WHAT THE JOURNAL SAYS IS ON IT (2026-10-11). The journal
         puts two kinds of chips on the felt while no seat holds them: an
         add-on bought mid-hand (its leg is written at purchase, the seat is
         credited when the hand ends), and a settled hand's rake and jackpot
         drop (the seats paid them at commit, their legs are written by the
         hand's post-commit obligations in the next transaction). A reading
         between the two halves read the felt short of the journal, and the
         next reading read it back as drift (+9.76 and +4.10, 2026-10-10/11). */
      v := v
        + (SELECT COALESCE(sum(pa.amount), 0)
             FROM public.table_pending_addons pa
            WHERE pa.resolved_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.tables t
                               WHERE t.id = pa.table_id
                                 AND (t.tournament_id IS NOT NULL
                                      OR EXISTS (SELECT 1 FROM public.clubs cl
                                                  WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))))
        + (SELECT COALESCE(sum(COALESCE((c.post_commit_payload->'rake'->>'amount')::numeric, 0)
                               + COALESCE((c.post_commit_payload->'bbj_contribution'->>'amount')::numeric, 0)), 0)
             FROM public.hand_atomic_commits c
            WHERE c.post_commit_payload IS NOT NULL
              AND c.post_commit_completed_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.tables t
                               WHERE t.id = c.table_id
                                 AND (t.tournament_id IS NOT NULL
                                      OR EXISTS (SELECT 1 FROM public.clubs cl
                                                  WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))));
$a$, 'felt');
  EXECUTE v_src;
END
$patch$;

-- One reading of the felt on the new definition: balance and snapshot in one
-- statement, so the next replay's journal window is exactly what it saw.
INSERT INTO public.ca_account_snapshots
  (account_key, account_type, entity_id, club_id, column_name, balance, taken_at,
   is_baseline, unexplained, cum_unexplained, basis_version, note, read_snapshot)
SELECT 'table_stack:00000000-0000-0000-0000-0000000fe17e:table_seats.stack', 'table_stack',
       '00000000-0000-0000-0000-0000000fe17e'::uuid, NULL, 'table_seats.stack',
       public.fn_ca_account_balance('table_stack', '00000000-0000-0000-0000-0000000fe17e'::uuid, NULL, 'table_seats.stack'),
       clock_timestamp(), true, NULL, 0, 'one-snapshot-v4',
       'new definition (20261011, the felt is what the journal says is on it): the felt also counts unresolved add-ons and the rake and jackpot drop of settled hands whose post-commit legs have not committed, so a reading between the two halves of a hand no longer reads as drift; the 13.86 the previous definition''s first reading left in the cumulative is not carried',
       pg_current_snapshot()::text;

DO $prove$
DECLARE v_fn numeric; v_seats numeric; v_addons numeric; v_owed numeric; v_last record;
BEGIN
  IF position('THE FELT IS WHAT THE JOURNAL SAYS IS ON IT' IN pg_get_functiondef('public.fn_ca_account_balance(text,uuid,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'JOURNAL_FELT_RESULT_CHANGED: not live';
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
         (SELECT COALESCE(sum(COALESCE((c.post_commit_payload->'rake'->>'amount')::numeric, 0)
                              + COALESCE((c.post_commit_payload->'bbj_contribution'->>'amount')::numeric, 0)), 0)
            FROM public.hand_atomic_commits c
           WHERE c.post_commit_payload IS NOT NULL AND c.post_commit_completed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM public.tables t
                              WHERE t.id = c.table_id
                                AND (t.tournament_id IS NOT NULL
                                     OR EXISTS (SELECT 1 FROM public.clubs cl
                                                 WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))))
    INTO v_fn, v_seats, v_addons, v_owed;
  IF v_fn IS DISTINCT FROM v_seats + v_addons + v_owed THEN
    RAISE EXCEPTION 'JOURNAL_FELT_RESULT_CHANGED: reader % seats % add-ons % owed %', v_fn, v_seats, v_addons, v_owed;
  END IF;
  SELECT * INTO v_last FROM public.ca_account_snapshots
   WHERE account_key = 'table_stack:00000000-0000-0000-0000-0000000fe17e:table_seats.stack'
   ORDER BY taken_at DESC LIMIT 1;
  IF v_last.basis_version IS DISTINCT FROM 'one-snapshot-v4' OR v_last.read_snapshot IS NULL
     OR NOT v_last.is_baseline OR v_last.cum_unexplained <> 0
     OR position('the felt is what the journal says is on it' IN v_last.note) = 0 THEN
    RAISE EXCEPTION 'JOURNAL_FELT_RESULT_CHANGED: no new reading';
  END IF;
END
$prove$;

COMMIT;
