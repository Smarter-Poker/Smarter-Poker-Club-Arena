-- a_chip_week_reads_no_diamond_event
--
-- A CHIP WEEK READS NO DIAMOND EVENT (2026-10-12). Full account:
-- docs/changelog/2026-10-12-a-chip-week-reads-no-diamond-event.md.
--
-- The chip week ending 2026-10-12 07:00 UTC was the first that held Diamond
-- Arena tournaments. fn_settle_tournament_rake gives a Diamond event its
-- tournament_rake_settlements row (destination diamond_house, union_id NULL)
-- and pays its fee to the Diamond house; it never writes a chip
-- accounting_tournament_fee_recognitions row, because no chip moved and no
-- chip rakeback or commission is owed on it. 95 such rows exist (54,739
-- Diamonds of fees, 2026-10-07 to now).
--
-- fn_accounting_tournament_week_quality gathers every event settled in the
-- week, and its last survivors clause keeps an event of UNKNOWN scope (no
-- union, no recognition, a positive bank amount, no chip rake record) for
-- EVERY club and union. So each Diamond event answered
-- tournament_terminal_recognition_missing to every chip club's week: Deep
-- Stack Society's weekly accounting failed twice (critical
-- weekly_club_accounting), SHARK CLUB's period recompute was refused 1,446
-- times, and the rakeback settler held its watermark (settler_lag).
--
-- The week's candidates now leave out Diamond Arena events, read by the same
-- definition as fn_poker_diamond_tournament (platform club, asset diamonds, no
-- union). The Diamond book settles them (poker_diamond_tournament_ledger,
-- ca_diamond_house); nothing in the chip week is owed on them. Every chip event
-- is read exactly as before.
--
-- @live-proof: (SELECT position('A CHIP WEEK READS NO DIAMOND EVENT' IN pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'CHIP_WEEK_DIAMOND_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure);
BEGIN
  IF position('A CHIP WEEK READS NO DIAMOND EVENT' IN v_src) > 0 THEN
    RAISE NOTICE 'CHIP_WEEK_DIAMOND already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM '0d3dc681a14fa6b6b027f8ee6677bb41' THEN
    RAISE EXCEPTION 'CHIP_WEEK_DIAMOND_PREIMAGE_CHANGED';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src, $a$  WITH candidates AS (
$a$, $a$  WITH candidates_all AS (
$a$, 'candidates');
  v_src := pg_temp.ca_swap_once(v_src, $a$  ), ev AS (
$a$, $a$  ), candidates AS (
   -- A CHIP WEEK READS NO DIAMOND EVENT (2026-10-12): a Diamond Arena event's
   -- fee is settled in Diamonds to the Diamond house and owes no chip rakeback
   -- or commission, so it has no chip recognition and is no chip week's
   -- business (the definition of fn_poker_diamond_tournament).
   SELECT a.tournament_id FROM candidates_all a
    WHERE a.tournament_id NOT IN(SELECT t.id FROM public.tournaments t JOIN public.clubs c ON c.id=t.club_id
     WHERE c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL)
  ), ev AS (
$a$, 'ev');
  EXECUTE v_src;
END
$patch$;

DO $prove$
DECLARE v_src text := pg_get_functiondef('public.fn_accounting_tournament_week_quality(uuid,timestamptz,timestamptz)'::regprocedure);
BEGIN
  IF position('A CHIP WEEK READS NO DIAMOND EVENT' IN v_src) = 0
     OR position('WITH candidates_all AS (' IN v_src) = 0
     OR position('SECURITY DEFINER' IN v_src) = 0
     OR position('STABLE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'CHIP_WEEK_DIAMOND_RESULT_CHANGED';
  END IF;
END
$prove$;

COMMIT;
