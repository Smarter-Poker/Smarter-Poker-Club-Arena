-- 20261009134421_a_diamond_tournament_is_conserved_by_its_own_diamond_book.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A DIAMOND TOURNAMENT IS CONSERVED BY ITS OWN DIAMOND BOOK (2026-10-09).
-- Full account: docs/changelog/2026-10-09-the-money-checks-read-the-diamond-book.md.
--
-- fn_tournament_money_conservation held 7 open "paid out money it never
-- collected" warnings, every one a Diamond Arena "Sunday Deep Stack Satellite"
-- (deltas -200 and -600, one ticket value per seat). Every one was the delta,
-- not the money:
--
--   * A platform Diamond tournament keeps no chip book. Across all 85 Diamond
--     Arena events there is not one wallet_transactions, chip_ledger,
--     rake_records, tournament_guarantee_overlays or baseline row. Every entry,
--     overlay, prize, seat and fee is a leg of poker_diamond_tournament_ledger.
--   * fn_tournament_conservation_delta read the chip book (0 collected) and the
--     satellite's tournament_payouts seat rows (200 per seat paid out), so a
--     satellite that paid every seat read as unfunded.
--   * fn_poker_diamond_tournament_escrow, the Diamond book's own reader, shows
--     all seven at prize, bounty and fee balance 0: every Diamond collected was
--     paid out (prize_in + overlay_in = prize_out; fee_in = fee_out).
--
-- So for a Diamond event the delta is now its escrow balance: what the event
-- still holds after every leg. The scalar and the one-pass set function ask
-- the same question (they are compared over every Diamond event of the last
-- three days and every event of the last six hours below). Non-Diamond events
-- take the unchanged chip arithmetic through the ELSE branch.
--
-- fn_pay_backed_payout_shortfalls carries the chip arithmetic inline and
-- would read a Diamond target event as holding its satellite seats (the
-- Sunday $200 Deep Stack holds 11, 2,200.00, when it completes). That sweep
-- pays through the chip reconciler, so a Diamond event is now outside it; a
-- Diamond event is paid from its own escrow.
--
-- Production read before applying (one rolled-back transaction): all 7
-- reported satellites 0.00; 45-day scan flags 0 of 208,650 events (was 7);
-- the backed payout dry run unchanged (0 paid, 0 withheld, 0 refused). Pass 1
-- of fn_tournament_money_conservation re-asks the scalar about each open
-- alert, so the 7 close on its next hourly run. No money moves.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) = '17ae3dfd32d3cb1d2673a86c0d8d9426' AND md5(pg_get_functiondef('public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)'::regprocedure)) = '118b1c0bbf6f959809efe6b385d92bf9' AND md5(pg_get_functiondef('public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure)) = 'c9e67c9c7e42028543e39b18d29f02d3')

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'DIAMOND_BOOK_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_scalar text := pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure);
  v_set    text := pg_get_functiondef('public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)'::regprocedure);
  v_batch  text := pg_get_functiondef('public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure);
BEGIN
  IF position('diamond_book' IN v_scalar) > 0
     AND position('AS diamond' IN v_set) > 0
     AND position('A Diamond event is paid from its own diamond escrow' IN v_batch) > 0 THEN
    RAISE NOTICE 'DIAMOND_BOOK already applied';
    RETURN;
  END IF;

  IF md5(v_scalar) IS DISTINCT FROM 'bfbb3e617d7c8290ac8916e21bf0c2a4'
     OR md5(v_set) IS DISTINCT FROM '365e9948c804059253d73cd35ed6e3d4'
     OR md5(v_batch) IS DISTINCT FROM '10c5a2d39477380157d133a7b5bc113d' THEN
    RAISE EXCEPTION 'DIAMOND_BOOK_PREIMAGE_CHANGED';
  END IF;

  ---------------------------------------------------------------------------
  -- 1. The scalar: a Diamond event's delta is its own diamond escrow balance.
  ---------------------------------------------------------------------------
  v_scalar := pg_temp.ca_swap_once(v_scalar,
$a$    SELECT t.id, t.ended_at,
$a$,
$a$    SELECT t.id, t.ended_at,
      -- A DIAMOND EVENT KEEPS ITS OWN BOOK (2026-10-09). A platform Diamond
      -- tournament never touches wallet_transactions, chip_ledger or
      -- rake_records: every entry, overlay, prize, seat and fee is a leg of
      -- poker_diamond_tournament_ledger. Read through the chip book it shows
      -- nothing collected and a seat paid out, so seven fully paid Sunday
      -- Deep Stack satellites read as "paid out money it never collected".
      -- Its conservation is its escrow: what is still held after every leg.
      CASE WHEN EXISTS (SELECT 1 FROM public.clubs c
                         WHERE c.id = t.club_id AND c.asset = 'diamonds'
                           AND c.is_platform IS TRUE AND c.union_id IS NULL
                           AND t.union_id IS NULL)
           THEN (SELECT x.prize_balance + x.bounty_balance + x.fee_balance
                   FROM public.fn_poker_diamond_tournament_escrow(t.id) x)
      END AS diamond_book,
$a$, 'scalar head');

  v_scalar := pg_temp.ca_swap_once(v_scalar,
$a$  SELECT round(
      m.money_in - m.refunds - m.rake - m.prizes - m.bounties
$a$,
$a$  SELECT CASE WHEN m.diamond_book IS NOT NULL THEN round(m.diamond_book, 2) ELSE round(
      m.money_in - m.refunds - m.rake - m.prizes - m.bounties
$a$, 'scalar sum open');

  v_scalar := pg_temp.ca_swap_once(v_scalar,
$a$  , 2)
  FROM m;
$a$,
$a$  , 2) END
  FROM m;
$a$, 'scalar sum close');

  ---------------------------------------------------------------------------
  -- 2. The set function: the same question, asked once per window.
  ---------------------------------------------------------------------------
  v_set := pg_temp.ca_swap_once(v_set,
$a$    SELECT t.id, t.name, t.variant, t.ended_at
    FROM public.tournaments t
$a$,
$a$    SELECT t.id, t.name, t.variant, t.ended_at,
      -- A DIAMOND EVENT KEEPS ITS OWN BOOK (2026-10-09): see the scalar.
      EXISTS (SELECT 1 FROM public.clubs c
               WHERE c.id = t.club_id AND c.asset = 'diamonds'
                 AND c.is_platform IS TRUE AND c.union_id IS NULL
                 AND t.union_id IS NULL) AS diamond
    FROM public.tournaments t
$a$, 'set eligible');

  v_set := pg_temp.ca_swap_once(v_set,
$a$    round(COALESCE(w.money_in, 0)$a$,
$a$    CASE WHEN e.diamond THEN
      (SELECT round(x.prize_balance + x.bounty_balance + x.fee_balance, 2)
         FROM public.fn_poker_diamond_tournament_escrow(e.id) x)
    ELSE round(COALESCE(w.money_in, 0)$a$, 'set sum open');

  v_set := pg_temp.ca_swap_once(v_set,
$a$, 2) AS delta
$a$,
$a$, 2) END AS delta
$a$, 'set sum close');

  ---------------------------------------------------------------------------
  -- 3. The chip shortfall sweep never pays a Diamond event.
  ---------------------------------------------------------------------------
  v_batch := pg_temp.ca_swap_once(v_batch,
$a$        AND COALESCE(t.variant, '') <> 'spin'
$a$,
$a$        AND COALESCE(t.variant, '') <> 'spin'
        -- A Diamond event is paid from its own diamond escrow, never by this
        -- chip sweep (2026-10-09). Its chip-side delta is meaningless.
        AND NOT EXISTS (SELECT 1 FROM public.clubs c
                         WHERE c.id = t.club_id AND c.asset = 'diamonds'
                           AND c.is_platform IS TRUE AND c.union_id IS NULL
                           AND t.union_id IS NULL)
$a$, 'batch eligible');

  EXECUTE v_scalar;
  EXECUTE v_set;
  EXECUTE v_batch;
END
$patch$;

DO $prove$
DECLARE
  v_bad integer;
BEGIN
  IF position('diamond_book' IN pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) = 0
     OR position('AS diamond' IN pg_get_functiondef('public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)'::regprocedure)) = 0
     OR position('A Diamond event is paid from its own diamond escrow' IN pg_get_functiondef('public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'DIAMOND_BOOK_RESULT_CHANGED: not live';
  END IF;
  IF md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure)) IS DISTINCT FROM '17ae3dfd32d3cb1d2673a86c0d8d9426'
     OR md5(pg_get_functiondef('public.fn_tournament_conservation_deltas(timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '118b1c0bbf6f959809efe6b385d92bf9'
     OR md5(pg_get_functiondef('public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure)) IS DISTINCT FROM 'c9e67c9c7e42028543e39b18d29f02d3' THEN
    RAISE EXCEPTION 'DIAMOND_BOOK_RESULT_CHANGED: an unexpected definition is live';
  END IF;

  -- The seven events that were reported now balance.
  SELECT count(*) INTO v_bad
    FROM (VALUES ('410cfca4-77d9-4b9c-8f36-f20939c9d231'::uuid),('954625ef-0cde-40bf-a7a3-7be3e6348339'),
                 ('d4f08fba-72e9-470c-9ea5-8ac00f5243b6'),('82aa6c4f-ffc9-4eed-870b-2c257e10e6bf'),
                 ('7e56f752-e92b-4447-b12e-66d83d1c062a'),('3bea3ecb-9cb4-4a94-b5f4-69de2a697ec5'),
                 ('e2ea5f2a-da30-425b-96cb-88a19799e21f')) v(id)
   WHERE public.fn_tournament_conservation_delta(v.id) IS DISTINCT FROM 0;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'DIAMOND_BOOK_RESULT_CHANGED: % reported events still unbalanced', v_bad;
  END IF;

  -- Scalar and set agree on every Diamond event of the last three days and on
  -- every event, Diamond or not, that ended in the last six hours.
  SELECT count(*) INTO v_bad
    FROM public.fn_tournament_conservation_deltas(now() - interval '3 days', now() - interval '30 minutes') d
   WHERE (d.ended_at > now() - interval '6 hours' OR public.fn_poker_diamond_tournament(d.id))
     AND d.delta IS DISTINCT FROM public.fn_tournament_conservation_delta(d.id);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'DIAMOND_BOOK_RESULT_CHANGED: scalar and set disagree on % events', v_bad;
  END IF;
END
$prove$;

COMMIT;
