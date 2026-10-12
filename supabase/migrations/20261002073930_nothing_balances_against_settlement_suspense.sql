-- ===========================================================================
--  NOTHING BALANCES AGAINST SETTLEMENT SUSPENSE
-- ===========================================================================
--
-- Dan, 2026-10-01: "fix any and all issues with the chip drift ... chip
-- drifts should not be possible."
--
-- 20261002065836 (applied 07:36:04 UTC on 2026-10-02) taught the commit-time
-- ledger check one more question: did this transaction write a chip_ledger leg
-- against settlement_suspense - the journal triggers' default counterparty,
-- a label with no balance outside the supply count - AND move a covered chip
-- balance? It was installed in observe under its own
-- ca_ledger_invariant_store_mode row, 'settlement_suspense'. This is stage 2:
-- the row becomes 'refuse', so such a transaction no longer commits. A
-- journal-only correction (no covered balance moved) still commits.
--
-- WHAT THE WINDOW SAID (read from rows; the counts are in
-- docs/changelog/2026-10-02-no-balance-moves-against-settlement-suspense.md)
--   * From 07:36:04 to 08:06:40 UTC, across the 07:53 break, the 07:55
--     freeze and the 08:00 thaw: 7,609 chip_ledger legs (bbj_contribution
--     4,104, rake 1,349, tournament_buyin 657, burn 526, table_cashout 242,
--     buyin 182, spin_entry 174, spin_prize 174, tournament_prize 127, addon,
--     horse_funding, promo), 9,923 hands, zero settlement_suspense legs and
--     zero findings of any kind. Every live door declares its counterparty.
--     The preimage re-reads the window up to the moment this file applies,
--     and aborts on a single finding.
--   * Both modes were proved live, each in one rolled-back DO block, at
--     07:37 UTC: an undeclared +0.01 member-wallet credit (the journal trigger
--     booked it out of suspense) recorded settlement_suspense b=0.01 s=0.01
--     observe; with the row set to refuse inside the probe the same write was
--     refused, SQLSTATE 23514, "REFUSED: balance_moved_against_settlement_suspense
--     suspense_legs=0.01 moved=player_wallet:... 0.01".
--
-- The preimage aborts, applying nothing, if the row is not still observe, if
-- any settlement_suspense finding exists since 07:36:04, or if either function
-- is not the body 20261002065836 installed. A data change only: no lock, no
-- trigger, no function, nothing dropped. The open suspense balance is not
-- touched.
-- ===========================================================================
-- @live-proof: (SELECT mode FROM public.ca_ledger_invariant_store_mode WHERE store = 'settlement_suspense') = 'refuse'

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  r record;
  v_live text;
  v_since bigint;
BEGIN
  IF (SELECT mode FROM public.ca_ledger_invariant_store_mode WHERE store = 'settlement_suspense') IS DISTINCT FROM 'observe' THEN
    RAISE EXCEPTION 'preimage: the settlement_suspense judgement is not in observe; read the live row';
  END IF;
  SELECT count(*) INTO v_since FROM public.ca_ledger_invariant_findings
   WHERE account_key = 'settlement_suspense' AND found_at >= timestamptz '2026-10-02 07:36:04+00';
  IF v_since <> 0 THEN
    RAISE EXCEPTION 'preimage: % settlement_suspense findings since 07:36:04 UTC; a live writer still moves a balance against suspense and refusing would stop it - fix that writer first', v_since;
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('fn_ca_tally_ledger_leg',           '11a0ded53fabe6919d5083942e25dcf5'),
      ('fn_ca_balance_has_its_ledger_row', 'ddf1a2f088a47c1466d996efb7143e85')) AS x(f, m)
  LOOP
    SELECT md5(pg_get_functiondef(p.oid)) INTO v_live
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.f;
    IF v_live IS DISTINCT FROM r.m THEN
      RAISE EXCEPTION 'preimage: % is not the body 20261002065836 installed (md5 %, expected %); re-read it', r.f, v_live, r.m;
    END IF;
  END LOOP;
END $pre$;

UPDATE public.ca_ledger_invariant_store_mode
   SET mode = 'refuse',
       changed_at = now(),
       reason = '20261002073930: stage 2. Zero settlement_suspense findings from 07:36:04 UTC under live traffic; both modes proved live in rolled-back probes; a transaction that moves a covered balance against settlement_suspense no longer commits'
 WHERE store = 'settlement_suspense';

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ca_ledger_invariant_store_mode WHERE mode <> 'refuse')
     OR (SELECT count(*) FROM public.ca_ledger_invariant_store_mode) <> 16 THEN
    RAISE EXCEPTION 'the fifteen chip stores and the settlement_suspense judgement did not all read back refuse';
  END IF;
  IF (SELECT mode FROM public.ca_ledger_invariant_mode) IS DISTINCT FROM 'refuse' THEN
    RAISE EXCEPTION 'the global fallback must stay refuse';
  END IF;
  RAISE NOTICE 'nothing balances against settlement suspense: % judgements refuse', (SELECT count(*) FROM public.ca_ledger_invariant_store_mode);
END $post$;

COMMIT;
