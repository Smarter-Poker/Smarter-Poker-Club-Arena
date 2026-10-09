-- the_chip_felt_counts_no_diamond_seat
--
-- THE CHIP FELT COUNTS NO DIAMOND SEAT (2026-10-09). Full account:
-- docs/changelog/2026-10-09-the-chip-felt-counts-no-diamond-seat.md.
--
-- fn_ca_ledger_replay judges the whole cash felt as one account
-- (table_stack:...0fe17e:table_seats.stack), read by fn_ca_account_balance
-- "exactly as fn_ca_supply_snapshot defines it". The supply meter stopped
-- counting Diamond seats in Diamond Phase 9, step 0 (a Diamond seat holds
-- Diamonds that no chip_ledger row moves); this reader never did. Diamond cash
-- opened on 2026-10-06 (20261006154844), and from then on every Diamond buy-in,
-- pot and rake moved the felt with no chip leg. The nightly replay read it as
-- drift and tripped the kill switch three nights running: -4,860.88 on
-- 10-07, +117,689.83 on 10-08 and +42,309.60 on 10-09, while the Diamond felt
-- grew to about 186,700 Diamonds. No chip_ledger leg has ever named a Diamond
-- table, so the chip journal has nothing to say about those seats.
--
-- 1. fn_ca_account_balance reads the felt exactly as the supply meter does:
--    open seats at non-tournament tables of a chip club.
-- 2. The felt account gets one new reading on the new definition, taken by a
--    single statement together with the snapshot it read under, exactly as the
--    replay records its own readings (basis one-snapshot-v4, cumulative 0). The
--    next replay judges the felt from that reading, so the definition change is
--    not read as a one-time movement of the Diamond felt. No other account is
--    touched and no balance moves.
--
-- @live-proof: (SELECT position('THE CHIP FELT COUNTS NO DIAMOND SEAT' IN pg_get_functiondef('public.fn_ca_account_balance(text,uuid,uuid,text)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'CHIP_FELT_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_ca_account_balance(text,uuid,uuid,text)'::regprocedure);
BEGIN
  IF position('THE CHIP FELT COUNTS NO DIAMOND SEAT' IN v_src) > 0 THEN
    RAISE NOTICE 'CHIP_FELT already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM 'ff503f0f56f190fabc0af53d9f8b7703' THEN
    RAISE EXCEPTION 'CHIP_FELT_PREIMAGE_CHANGED';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$         AND NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.id = ts.table_id AND t.tournament_id IS NOT NULL);
$a$,
$a$         AND NOT EXISTS (SELECT 1 FROM public.tables t
                          WHERE t.id = ts.table_id
                            AND (t.tournament_id IS NOT NULL
                                 -- THE CHIP FELT COUNTS NO DIAMOND SEAT (2026-10-09): a
                                 -- Diamond seat holds Diamonds no chip_ledger leg moves.
                                 OR EXISTS (SELECT 1 FROM public.clubs cl
                                             WHERE cl.id = t.club_id AND cl.asset = 'diamonds')));
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
       (SELECT COALESCE(sum(ts.stack), 0) FROM public.table_seats ts
         WHERE ts.left_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.tables t
                            WHERE t.id = ts.table_id
                              AND (t.tournament_id IS NOT NULL
                                   OR EXISTS (SELECT 1 FROM public.clubs cl
                                               WHERE cl.id = t.club_id AND cl.asset = 'diamonds')))),
       clock_timestamp(), true, NULL, 0, 'one-snapshot-v4',
       'new definition (20261009, the chip felt counts no Diamond seat): the felt is read exactly as fn_ca_supply_snapshot reads it, so the Diamond seats that no chip leg moves leave it here, once, and are not judged as a movement',
       pg_current_snapshot()::text;

DO $prove$
DECLARE v_fn numeric; v_meter numeric; v_last record;
BEGIN
  IF position('THE CHIP FELT COUNTS NO DIAMOND SEAT' IN pg_get_functiondef('public.fn_ca_account_balance(text,uuid,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'CHIP_FELT_RESULT_CHANGED: not live';
  END IF;
  -- One statement, one snapshot: the reader is STABLE.
  SELECT public.fn_ca_account_balance('table_stack', '00000000-0000-0000-0000-0000000fe17e'::uuid, NULL, 'table_seats.stack'),
         (SELECT COALESCE(sum(ts.stack), 0) FROM public.table_seats ts
           WHERE ts.left_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM public.tables t
                              WHERE t.id = ts.table_id
                                AND (t.tournament_id IS NOT NULL
                                     OR EXISTS (SELECT 1 FROM public.clubs cl
                                                 WHERE cl.id = t.club_id AND cl.asset = 'diamonds'))))
    INTO v_fn, v_meter;
  IF v_fn IS DISTINCT FROM v_meter THEN
    RAISE EXCEPTION 'CHIP_FELT_RESULT_CHANGED: reader % meter %', v_fn, v_meter;
  END IF;
  SELECT * INTO v_last FROM public.ca_account_snapshots
   WHERE account_key = 'table_stack:00000000-0000-0000-0000-0000000fe17e:table_seats.stack'
   ORDER BY taken_at DESC LIMIT 1;
  IF v_last.basis_version IS DISTINCT FROM 'one-snapshot-v4' OR v_last.read_snapshot IS NULL
     OR NOT v_last.is_baseline OR v_last.cum_unexplained <> 0 THEN
    RAISE EXCEPTION 'CHIP_FELT_RESULT_CHANGED: no new reading';
  END IF;
END
$prove$;

COMMIT;
