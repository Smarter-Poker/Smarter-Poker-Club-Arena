-- a_diamond_place_and_entry_are_read_from_the_diamond_book
--
-- A DIAMOND PLACE AND A DIAMOND ENTRY ARE READ FROM THE DIAMOND BOOK
-- (2026-10-09). Full account:
-- docs/changelog/2026-10-09-the-money-checks-read-the-diamond-book.md.
--
-- A platform Diamond tournament writes no wallet_transactions row: every
-- entry, prize and bounty is a leg of poker_diamond_tournament_ledger. Three
-- checks read only the wallet, so every Diamond event looked unpaid:
--
--   * fn_payout_guarantee_check: 97 open earner_not_paid criticals, all on 27
--     Diamond events. 72 places were paid in full in the Diamond book; the
--     other 25 are whole-Diamond roundings of pools paid out to the last
--     Diamond. Rolled-back trial: 97 cleared, 0 raised.
--   * fn_ca_tournament_settlement_mismatch (ratchet tournament_underpaid_48h):
--     26 "underpaid" events, all Diamond, every escrow at balance 0.
--   * fn_uncollected_entry_check: 546 seats in one 24 h pass flagged as
--     unpaid; of 1,072 Diamond seats in 48 h, all 1,072 hold their entry leg.
--
-- Each check now adds the Diamond legs beside the wallet ones. Non-Diamond
-- events have no Diamond legs, so their arithmetic is unchanged. No money
-- moves.
--
-- @live-proof: (SELECT position('A DIAMOND PLACE IS PAID FROM THE DIAMOND BOOK' IN pg_get_functiondef('public.fn_payout_guarantee_check(integer)'::regprocedure)) > 0 AND position('A DIAMOND PLACE IS PAID FROM THE DIAMOND BOOK' IN pg_get_functiondef('public.fn_ca_tournament_settlement_mismatch(interval)'::regprocedure)) > 0 AND position('EXEMPTION 5' IN pg_get_functiondef('public.fn_uncollected_entry_check(integer)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'DIAMOND_PLACE_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch_guarantee$
DECLARE
  v_src text := pg_get_functiondef('public.fn_payout_guarantee_check(integer)'::regprocedure);
BEGIN
  IF position('A DIAMOND PLACE IS PAID FROM THE DIAMOND BOOK' IN v_src) > 0 THEN
    RAISE NOTICE 'DIAMOND_PLACE guarantee check already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM '7c57c1a27ae394f67010bf5f54cdab27' THEN
    RAISE EXCEPTION 'DIAMOND_PLACE_PREIMAGE_CHANGED: guarantee check';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$                        AND w.type = 'credit' AND w.category IN ('prize','bounty')), 0) AS credited,
$a$,
$a$                        AND w.type = 'credit' AND w.category IN ('prize','bounty')), 0)
           -- A DIAMOND PLACE IS PAID FROM THE DIAMOND BOOK (2026-10-09). A
           -- platform Diamond event never writes wallet_transactions: its
           -- prizes and bounties are poker_diamond_tournament_ledger legs. All
           -- 97 open earner_not_paid alerts on 2026-10-09 were Diamond places
           -- paid in full (72) or a whole-Diamond rounding of a pool paid out
           -- to the last Diamond (25).
           + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l
                        WHERE l.tournament_id = a.tid AND l.user_id = a.uid
                          AND l.kind IN ('prize','bounty')), 0) AS credited,
$a$, 'clear credited');
  v_src := pg_temp.ca_swap_once(v_src,
$a$                      WHERE w.related_entity_id = a.tid
                        AND w.type = 'credit' AND w.category = 'prize'), 0) AS pool_paid
$a$,
$a$                      WHERE w.related_entity_id = a.tid
                        AND w.type = 'credit' AND w.category = 'prize'), 0)
           + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l
                        WHERE l.tournament_id = a.tid AND l.kind = 'prize'), 0) AS pool_paid
$a$, 'clear pool_paid');
  v_src := pg_temp.ca_swap_once(v_src,
$a$                        WHERE w.related_entity_id = t.id
                          AND w.type = 'credit' AND w.category = 'prize'), 0) AS pool_paid
$a$,
$a$                        WHERE w.related_entity_id = t.id
                          AND w.type = 'credit' AND w.category = 'prize'), 0)
             -- A DIAMOND PLACE IS PAID FROM THE DIAMOND BOOK (2026-10-09).
             + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l
                          WHERE l.tournament_id = t.id AND l.kind = 'prize'), 0) AS pool_paid
$a$, 'detect pool_paid');
  v_src := pg_temp.ca_swap_once(v_src,
$a$                        AND w.category IN ('prize','bounty')), 0) AS credited,
$a$,
$a$                        AND w.category IN ('prize','bounty')), 0)
           + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l
                        WHERE l.tournament_id = o.id AND l.user_id = o.user_id
                          AND l.kind IN ('prize','bounty')), 0) AS credited,
$a$, 'detect credited');
  v_src := pg_temp.ca_swap_once(v_src,
$a$                        AND w.category IN ('prize','bounty')), 0) + 0.05 < o.place_worth
$a$,
$a$                        AND w.category IN ('prize','bounty')), 0)
          + COALESCE((SELECT sum(l.amount) FROM public.poker_diamond_tournament_ledger l
                       WHERE l.tournament_id = o.id AND l.user_id = o.user_id
                         AND l.kind IN ('prize','bounty')), 0) + 0.05 < o.place_worth
$a$, 'detect test');
  EXECUTE v_src;
END
$patch_guarantee$;

DO $patch_mismatch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_ca_tournament_settlement_mismatch(interval)'::regprocedure);
BEGIN
  IF position('A DIAMOND PLACE IS PAID FROM THE DIAMOND BOOK' IN v_src) > 0 THEN
    RAISE NOTICE 'DIAMOND_PLACE mismatch already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM '7900253b783a7e6ce94b9f3b6ff92598' THEN
    RAISE EXCEPTION 'DIAMOND_PLACE_PREIMAGE_CHANGED: settlement mismatch';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$                        AND COALESCE(w.category, '') <> 'bounty'), 0) AS paid
$a$,
$a$                        AND COALESCE(w.category, '') <> 'bounty'), 0)
           -- A DIAMOND PLACE IS PAID FROM THE DIAMOND BOOK (2026-10-09). A
           -- platform Diamond event writes no wallet credit; its places are
           -- 'prize' legs of poker_diamond_tournament_ledger. All 26 events
           -- this read as "underpaid" on 2026-10-09 were Diamond events whose
           -- escrow had paid out to the last Diamond.
           + COALESCE((SELECT round(sum(l.amount), 2)
                         FROM public.poker_diamond_tournament_ledger l
                        WHERE l.tournament_id = t.id AND l.kind = 'prize'), 0) AS paid
$a$, 'mismatch paid');
  EXECUTE v_src;
END
$patch_mismatch$;

DO $patch_entry$
DECLARE
  v_src text := pg_get_functiondef('public.fn_uncollected_entry_check(integer)'::regprocedure);
BEGIN
  IF position('EXEMPTION 5' IN v_src) > 0 THEN
    RAISE NOTICE 'DIAMOND_PLACE entry check already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM 'c3966d8199946984955a38d8e5298ca5' THEN
    RAISE EXCEPTION 'DIAMOND_PLACE_PREIMAGE_CHANGED: uncollected entry';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$  bad AS (
    SELECT s.*
      FROM seats s
$a$,
$a$  -- EXEMPTION 5 (2026-10-09): a Diamond entry is paid into the Diamond
  -- book. A platform Diamond event never writes wallet_transactions, so all
  -- 1,072 Diamond seats of the last 48 hours read as unpaid here (546 in one
  -- 24-hour pass); every one of them holds its entry leg in
  -- poker_diamond_tournament_ledger, written in the same transaction as the
  -- seat. Same buffer as the other two witnesses.
  diamond_paid AS (
    SELECT DISTINCT l.tournament_id, l.user_id
      FROM public.poker_diamond_tournament_ledger l
     WHERE l.kind IN ('entry','rebuy','reentry','addon')
       AND l.created_at >= v_since - c_evidence_buffer
  ),
  bad AS (
    SELECT s.*
      FROM seats s
$a$, 'entry cte');
  v_src := pg_temp.ca_swap_once(v_src,
$a$      LEFT JOIN awards a ON a.tournament_id = s.tournament_id AND a.user_id = s.user_id
$a$,
$a$      LEFT JOIN awards a ON a.tournament_id = s.tournament_id AND a.user_id = s.user_id
      LEFT JOIN diamond_paid d ON d.tournament_id = s.tournament_id AND d.user_id = s.user_id
$a$, 'entry join');
  v_src := pg_temp.ca_swap_once(v_src,
$a$       AND a.user_id IS NULL
$a$,
$a$       AND a.user_id IS NULL
       AND d.user_id IS NULL
$a$, 'entry where');
  EXECUTE v_src;
END
$patch_entry$;

DO $prove$
DECLARE v_bad integer;
BEGIN
  IF position('A DIAMOND PLACE IS PAID FROM THE DIAMOND BOOK' IN pg_get_functiondef('public.fn_payout_guarantee_check(integer)'::regprocedure)) = 0
     OR position('A DIAMOND PLACE IS PAID FROM THE DIAMOND BOOK' IN pg_get_functiondef('public.fn_ca_tournament_settlement_mismatch(interval)'::regprocedure)) = 0
     OR position('EXEMPTION 5' IN pg_get_functiondef('public.fn_uncollected_entry_check(integer)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'DIAMOND_PLACE_RESULT_CHANGED: not live';
  END IF;
  SELECT count(*) INTO v_bad
    FROM public.fn_ca_tournament_settlement_mismatch('48 hours'::interval) m
   WHERE public.fn_poker_diamond_tournament(m.tournament_id);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'DIAMOND_PLACE_RESULT_CHANGED: % Diamond events still mismatched', v_bad;
  END IF;
END
$prove$;

COMMIT;
