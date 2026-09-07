-- A BANK THAT IS SHORT PAYS WHAT IT HOLDS. IT DOES NOT PAY NOTHING.
--
-- Phase 4. Three finished tournaments are holding 21,419.57 that belongs to
-- three winners, and the oldest has been unpaid since 13:11 yesterday.
--
--   f7412940  Sunday $200 Deep Stack  196 entrants  winner owed 13,441.68
--             ended 09-07 00:16       escrow prize bank holds 13,261.68
--   a449e853  Sunday $200 Deep Stack   81 entrants  winner owed  8,282.69
--             ended 09-06 23:43       escrow prize bank holds  8,102.69
--   afa045db  20 Chip Spin PLO4         3 entrants  winner owed     60.00
--             ended 09-06 13:11       escrow prize bank holds     55.20
--
-- Every other place in all three events was paid, to the cent, from the same
-- bank. The winner was paid nothing.
--
-- WHY, in the platform's own words. `fn_settle_tournament_obligation` filed
-- this at 00:16:
--
--   "Refused 13441.68 to a2bd256e-... for place: the escrow holds 13261.68
--    for that bank (Sunday $200 Deep Stack)"
--
-- The bank is 180.00 short of the obligation, so the settlement refused the
-- WHOLE payment. A shortfall of 180 turned into a non-payment of 13,261.68 -
-- and because the last place paid in a tournament is always first place, it is
-- always the winner who absorbs it.
--
-- WHERE THE 180.00 WENT, read from the rows rather than guessed. Both Deep
-- Stacks carry `bubble_protection = true` and each holds one payout row:
--
--   source 'bubble_protection', 180.00, no position, recorded_by credit_and_log
--
-- 180.00 is the buy-in: the bubble finisher gets their entry back. The
-- settlement function already knows that comes out of the prize pool -
-- `bubble_protection` is in its own `v_pool_kinds` list - but the payout
-- STRUCTURE does not. Measured: the structure percentages sum to exactly
-- 100.0000% and the sum of every player's `prize` equals `prize_pool` to the
-- cent in both events. So the pool promises 100% of itself to the places AND a
-- 180.00 refund to the bubble out of the same money. It cannot do both. The
-- spin is the same arithmetic in a different dress: its winner's obligation is
-- 100% of `prize_pool` (60.00) while the prize bank only ever received 55.20,
-- because the 4.80 of rake never entered it.
--
-- THIS MIGRATION FIXES THE AMPLIFIER, WHICH IS MINE TO FIX. It does not decide
-- who funds bubble protection: reducing the structure's pool, or funding the
-- refund from rake, changes what players are owed in FUTURE events, and
-- CLAUDE.md 10.9 reserves that for Dan. It is written up with costs and a
-- recommendation in the changelog.
--
-- What changes is one thing only: when the bank is short but holds something,
-- the settlement PAYS WHAT THE BANK HOLDS and records the remainder as still
-- owed, instead of paying nothing. The obligation's `amount_owed` is
-- untouched, so the 180.00 stays visible and payable; `amount_paid` rises by
-- what actually moved; and the alert says what it did rather than what it
-- refused. When the bank holds nothing at all, the refusal is unchanged.
--
-- IT CANNOT OVERPAY. The new amount is `LEAST(what was asked, what the bank
-- holds)`, the escrow trigger still refuses inside the credit if a race gets
-- past this read, and every other guard in this function is untouched: the
-- kill switch, the manual-adjustment requirement for a caller from outside the
-- platform, one-finisher-one-place, and the counter cap for an event the
-- escrow has never seen.
--
-- HOW IT IS EDITED, and why not by retyping. The function is 15,900
-- characters. Re-typing it here would put every one of those guards at risk of
-- a transcription error for the sake of a nine-line change, so the body is
-- READ from the catalogue with `pg_get_functiondef`, ONE substitution is made
-- against text this migration asserts appears exactly once, and the result is
-- executed. Anything this migration did not intend to change cannot drift,
-- because it is the same bytes. The assertions below then prove the other
-- guards are still present in the body that was installed.

BEGIN;

SET LOCAL lock_timeout = '4s';

DO $edit$
DECLARE
  v_def   text;
  v_new   text;
  v_decl  text := '  v_can         jsonb;';
  v_anchor text := '  v_can := public.fn_ca_escrow_can_pay(p_tournament_id, v_row_kind, v_pay);
  IF (v_can->>''known'')::boolean AND NOT (v_can->>''ok'')::boolean THEN';
  v_insert text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'fn_settle_tournament_obligation';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ABORT: fn_settle_tournament_obligation is not there to edit';
  END IF;

  /* Both anchors must be unique, or this is not the function this migration
     was written against and it must be read again rather than edited blind. */
  IF (length(v_def) - length(replace(v_def, v_decl, ''))) / length(v_decl) <> 1 THEN
    RAISE EXCEPTION 'ABORT: the v_can declaration is not unique in the body';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'ABORT: the escrow-check anchor is not unique in the body';
  END IF;

  v_insert := '  v_can := public.fn_ca_escrow_can_pay(p_tournament_id, v_row_kind, v_pay);

  /* A BANK THAT IS SHORT PAYS WHAT IT HOLDS (2026-09-07). This used to refuse
     the whole payment, so a bank 180.00 short of a 13,441.68 obligation paid
     the winner nothing and froze 13,261.68 - three events were sitting like
     that when this was written. Paying what is there takes nothing from
     anybody: amount_owed is untouched, so the remainder stays owed and
     payable, and the credit is still capped by the bank and refused again by
     the escrow trigger if a race gets past this read. */
  IF (v_can->>''known'')::boolean AND NOT (v_can->>''ok'')::boolean
     AND COALESCE((v_can->>''available'')::numeric, 0) >= 0.01 THEN
    v_short := round(v_pay - (v_can->>''available'')::numeric, 2);
    v_pay   := round((v_can->>''available'')::numeric, 2);
    v_alert_ctx := jsonb_build_object(''kind'',''escrow_short_paid_what_it_holds'',
      ''tournament_id'',p_tournament_id,''tournament'',v_t.name,''user_id'',p_user_id,
      ''obligation_kind'',v_kind,''place'',v_place,''paid'',v_pay,''still_owed'',v_short,
      ''prize_balance'',(v_can->>''prize_balance'')::numeric,
      ''bounty_balance'',(v_can->>''bounty_balance'')::numeric,
      ''fee_balance'',(v_can->>''fee_balance'')::numeric,''source'',p_source);
    PERFORM public.fn_raise_server_financial_alert(''critical'',''fn_settle_tournament_obligation'',
      format(''Paid %s of %s to %s for %s and %s is still owed: the escrow bank was short (%s)'',
             v_pay, v_pay + v_short, p_user_id, v_kind, v_short, v_t.name),
      v_alert_ctx, ''obl:escrow_short_partial:'' || v_ob.id::text);
    v_can := public.fn_ca_escrow_can_pay(p_tournament_id, v_row_kind, v_pay);
  END IF;

  IF (v_can->>''known'')::boolean AND NOT (v_can->>''ok'')::boolean THEN';

  v_new := replace(v_def, v_decl, v_decl || E'\n  v_short       numeric;');
  v_new := replace(v_new, v_anchor, v_insert);

  IF v_new = v_def THEN
    RAISE EXCEPTION 'ABORT: the substitution changed nothing';
  END IF;

  EXECUTE v_new;
END $edit$;

-- ---------------------------------------------------------------------------
-- PROVE IT, against the real obligation that is frozen right now, inside a
-- subtransaction that is ROLLED BACK (CLAUDE.md 11.5). The settlement is then
-- made deliberately, outside this migration, through the platform's own
-- reconciler.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_src   text;
  v_res   jsonb;
  v_paid  numeric := -1;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'fn_settle_tournament_obligation';

  /* Every other guard survived the edit. */
  IF v_src !~ 'payout_frozen' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the kill-switch guard is gone';
  END IF;
  IF v_src !~ 'player_already_holds_a_place' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the one-finisher-one-place guard is gone';
  END IF;
  IF v_src !~ 'ca_manual_adjustments' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the manual-adjustment requirement is gone';
  END IF;
  IF v_src !~ 'escrow_short_paid_what_it_holds' THEN
    RAISE EXCEPTION 'VERIFY FAILED: the new partial-payment branch is not in the body';
  END IF;

  /* The frozen winner is paid what the bank holds. */
  BEGIN
    v_res := public.fn_settle_tournament_obligation(
      p_tournament_id => 'f7412940-5644-4194-8d57-4a97c182bf04',
      p_user_id       => 'a2bd256e-014c-4504-97c7-6bc43242fef1',
      p_kind          => 'place',
      p_amount        => 13441.68,
      p_place         => 1,
      p_source        => 'fn_tournament_payout_reconcile');
    v_paid := COALESCE((v_res->>'paid')::numeric, -1);
    RAISE EXCEPTION 'zz_rollback_the_probe';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'zz_rollback_the_probe' THEN RAISE; END IF;
  END;

  IF v_paid <> 13261.68 THEN
    RAISE EXCEPTION 'VERIFY FAILED: the short bank paid % instead of the 13261.68 it holds', v_paid;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tournament_payouts
              WHERE tournament_id = 'f7412940-5644-4194-8d57-4a97c182bf04'
                AND user_id = 'a2bd256e-014c-4504-97c7-6bc43242fef1') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the probe payment survived its own rollback';
  END IF;

  RAISE NOTICE 'A_SHORT_BANK_PAYS_WHAT_IT_HOLDS the frozen winner would receive 13261.68 instead of nothing, and the remaining 180.00 stays owed';
END $verify$;

COMMIT;
