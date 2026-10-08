-- 20261008050323_the_ledger_replay_felt_counts_no_diamond_seat
--
-- Reserved by scripts/new-migration.mjs on 2026-10-08 05:03:23 UTC.
--
-- THE LEDGER REPLAY FELT COUNTS NO DIAMOND SEAT (2026-10-08)
--
-- fn_ca_ledger_replay judges the cash felt as one account,
-- table_stack:00000000-0000-0000-0000-0000000fe17e:table_seats.stack. Its
-- balance comes from fn_ca_account_balance('table_stack', ...,
-- 'table_seats.stack'), whose own comment says it is "the whole cash felt,
-- exactly as fn_ca_supply_snapshot defines it". It is not: since Diamond
-- Phase 9 step 0 (2026-09-29) the supply meter's felt excludes every seat at a
-- table of a club whose asset is 'diamonds', and this reader still counts
-- them. A Diamond seat holds Diamonds that no chip_ledger row moves (custody
-- in poker_diamond_custody, rake in ca_diamond_rake_accrual), so with the
-- Diamond cash felt open every Diamond buy-in, cash-out and raked pot reads
-- as chip drift on the felt, and the replay passes the worst of them to
-- fn_ca_kill_switch_trip.
--
-- Read on production 2026-10-08 (SELECTs only):
--   * the 2026-10-07 06:40 reading of the felt: moved 21660.30, journal
--     26521.18, unexplained -4860.88 (kill switch UNCONFIRMED). That figure is
--     two things added together: a chip felt loss of -14081.45 at the
--     2026-10-06 15:33 account retirement (the supply meter read the same
--     -14081.45 at 16:05; 12235.58 of it was restored to the original funding
--     wallets on 2026-10-07 01:14 to 03:11 by the retired-cash-hand
--     migrations, 1845.87 is still unresolved and is NOT touched here), plus
--     about +9.2k of Diamond seats that sat down after the Diamond cash felt
--     reopened on 2026-10-07 (ca_diamond_snapshots arena_diamonds 0 at
--     2026-10-06 06:10, about 20.8k with tournament custody at 2026-10-07
--     06:10). No chip_ledger row names any of the seven Diamond cash tables.
--   * now: 41 active Diamond cash_seat custodies hold 140006, equal to the
--     live Diamond seat stacks, so the next nightly reading would add about
--     +130k of Diamonds to the chip felt and trip the kill switch again.
--
-- The fix: the felt branch of fn_ca_account_balance gains the supply meter's
-- Diamond clause, and fn_ca_ledger_replay moves to basis one-snapshot-v5 so
-- every account rebaselines once (its own "A CHANGE OF BASIS IS NOT DRIFT"
-- rule): a felt balance read under v4 includes Diamond seats and must not be
-- judged against a v5 one. No money is moved and no reading is rewritten.
--
-- HOW: the pinned-preimage exact-substitution pattern of 20261007212545. The
-- live text must hash to today's measured md5 (balance ff503f0f..., replay
-- a6dd975e...), each anchor must occur exactly once (measured read-only on
-- production 2026-10-08: 1 and 1), and the result must hash to the postimage
-- derived read-only on production with replace(); owner, SECURITY DEFINER,
-- proconfig and grants must not move.
--
-- Regression: scripts/ci/test-ledger-replay-felt-no-diamond.py (native
-- PostgreSQL), run by .github/workflows/ledger-replay-felt-no-diamond.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_account_balance(text,uuid,uuid,text)'::regprocedure)) = '87c04e23118c9d8e05716ac032d30bbb' AND md5(pg_get_functiondef('public.fn_ca_ledger_replay(integer)'::regprocedure)) = '667ce8ace7773451a7969d0ad5f55729')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_felt_subst(p_sig text, p_before text, p_after text,
                                      p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_felt_subst(
  'public.fn_ca_account_balance(text,uuid,uuid,text)',
  'ff503f0f56f190fabc0af53d9f8b7703', '87c04e23118c9d8e05716ac032d30bbb',
  ARRAY[$bo1$         AND NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.id = ts.table_id AND t.tournament_id IS NOT NULL);$bo1$],
  ARRAY[$bn1$         AND NOT EXISTS (SELECT 1 FROM public.tables t
                          WHERE t.id = ts.table_id
                            AND (t.tournament_id IS NOT NULL
                                 /* A DIAMOND SEAT IS NOT CHIP FELT (2026-10-08). It holds
                                    Diamonds that no chip_ledger row moves (custody in
                                    poker_diamond_custody, rake in ca_diamond_rake_accrual),
                                    so counted here every Diamond buy-in, cash-out and raked
                                    pot reads as chip drift on the felt. The same clause
                                    fn_ca_supply_snapshot applies to its felt. */
                                 OR EXISTS (SELECT 1 FROM public.clubs cl
                                             WHERE cl.id = t.club_id AND cl.asset = 'diamonds')));$bn1$]
);

SELECT pg_temp.ca_felt_subst(
  'public.fn_ca_ledger_replay(integer)',
  'a6dd975e58b6dd8043d2771d9505fc6d', '667ce8ace7773451a7969d0ad5f55729',
  ARRAY[$ro1$    v_basis text := 'one-snapshot-v4';$ro1$],
  ARRAY[$rn1$    /* v5 (2026-10-08): THE FELT COUNTS NO DIAMOND SEAT. fn_ca_account_balance
       reads table_seats.stack without Diamond seats from this version on, as
       fn_ca_supply_snapshot does. A felt balance read under v4 includes them,
       so every account rebaselines once onto v5 instead of judging a v4
       balance against a v5 one ("A CHANGE OF BASIS IS NOT DRIFT"). */
    v_basis text := 'one-snapshot-v5';$rn1$]
);

COMMIT;
