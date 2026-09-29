-- =====================================================================
-- THE CUSTODY GATE STOPS BEING A LIST OF NAMES
--
-- Four Spins cannot finish. Their winners - all horses, and under law 10.5
-- paid exactly as humans - are owed 322.00, and 38.64 of fee sits beside it:
--     f670ca7c 100 Chip Spin PLO5   200.00 prize / 24.00 fee  winner a666df27
--     5090c03b  50 Chip Spin PLO4   100.00 prize / 12.00 fee  winner 6cd9867c
--     18c95ce7  10 Chip Spin PLO6    20.00 prize /  2.40 fee  winner 8f4acae4
--     c59c8fe4   1 Chip Spin PLO5     2.00 prize /  0.24 fee  winner 3ebbefd2
-- Nothing has been paid: zero payouts, zero obligations, zero place batches,
-- zero terminal receipts, zero rake settlements, and a full untouched escrow
-- on all four. Measured 2026-09-21 01:10 UTC and asserted in section 0.
--
-- WHY THEY CANNOT FINISH (read from the live catalogue, and from a
-- rolled-back probe that called fn_complete_tournament_terminal on all four)
--   20260921001532 fixed their elimination sequence, so they now reach the
--   fee stage. Every one of them refuses there, verbatim:
--     "legacy fee custody requires exact unpaid named source and completed
--      player banks"                                            (P0404)
--   The layer underneath says why. Their fees were charged on 2026-09-08
--   between 13:37 and 14:52. public.accounting_agreement_history begins
--   2026-09-14 12:09:27.737434+00. So fn_accounting_terms_at finds NO
--   observed agreement at the moment the fee was charged, and the capture
--   refuses with accounting_terms_not_observed (55000) on two of them and
--   cash_commission_earning_club_not_observed (23514) on the other two,
--   depending on whether the club's union scope resolves at that instant.
--
--   THAT IS NOT A BUG AND IT IS NOT FIXED HERE. The terms that governed on
--   2026-09-08 were never recorded. Attributing the commission would mean
--   inventing them, which is the exact shape of the invented is_horse filter
--   law 10.5 was written about. The fee is genuinely unattributable, and
--   the platform already has one designed answer for that: custody, which
--   holds the fee in full with its complete evidence snapshot so that the
--   PRIZE can be paid now. The wider epoch question is task #68 and it is
--   Dan's, not this migration's.
--
-- THE DEFECT, THEN, IS THE GATE AND NOT THE ANSWER
--   fn_ca_hold_legacy_tournament_fee can only be entered by an event that a
--   human typed into fn_ca_legacy_fee_custody_cohort - a VALUES list of 14
--   uuids with pre-computed amounts, already appended to three times - and,
--   if it is a Spin, into the separate 5-uuid list that opens
--   fn_ca_sep8_spin_original_fee_proof. An event's ability to be paid should
--   not depend on whether somebody remembered its uuid. Appending a fourth
--   time is the band-aid law 10.12 forbids, so both gates are replaced with
--   a predicate READ FROM ROWS.
--
-- THE ADMITTED SET, MEASURED BEFORE ANYTHING WAS APPLIED
--   The naive predicate ("every positive fee predates the first observed
--   accounting agreement") admits 174,215 tournaments carrying 866,037.65.
--   That is not a gate, it is a hole. Bounded to events whose fees are ALL
--   pre-cutover and unbatched, with no rake settlement, no terminal receipt,
--   no fee recognition, no recognized source, no custody obligation already,
--   an intact escrow whose fee_balance equals the fee exactly, and which are
--   neither satellite nor diamond, it admits
--
--       30 tournaments carrying 133.06 of fees
--
--   and nothing else. Every one of the 30 was charged on 2026-09-08 between
--   13:36 and 14:51; 17 are Spins (all 17 prove out, section 4) and 13 are
--   SNGs. The four above are among them. The measurement was not a sample:
--   branch B can only admit an event with no terminal settlement, no rake
--   settlement, no obligation already and a positive tournament fee, which
--   is about 515 events platform wide, and the function itself was asked
--   about every one of them.
--
--   THE SET IS CLOSED AND CAN ONLY SHRINK. Admission requires every one of
--   the event's tournament fee records to predate the cutover instant
--   2026-09-17T18:24:02.831517Z, which is fixed and in the past. No fee
--   charged from now on can qualify, so no event can ever ENTER this set;
--   members leave it as they settle. That is the bound, and it is why this
--   is a generalisation rather than a widening.
--
-- WHAT THE GATE STILL REFUSES, so this is not a way around anything
--   fn_ca_hold_legacy_tournament_fee keeps every other condition it has:
--   status COMPLETING, prize_balance and bounty_balance exactly 0, fee
--   unpaid and equal to the cohort amount, no terminal or rake settlement,
--   no recognition, not a satellite, not a diamond - and, decisively, it
--   still asks fn_accounting_tournament_fee_net_plan FIRST and accepts only
--   a refusal in one of four exact words. A fee that CAN be attributed is
--   attributed; custody is reachable only by one that cannot.
--
-- WHAT IS DELIBERATELY NOT DONE
--   fn_ca_sep8_spin_original_fee_proof is NOT modified. Its result is read
--   by fn_ca_tournament_terminal_receipt, which demands an immutable
--   standings witness from smarter_private.spin_original_standings whenever
--   that proof is non-NULL. Only the 5 named Spins have such a row - they
--   were admitted on 2026-09-19 and are all COMPLETED and in custody - so
--   generalising sep8 in place would make these four fail at the terminal
--   receipt instead of the fee gate. Strictly worse. The generalised proof
--   is therefore a SEPARATE function, derived from sep8's own definition by
--   text substitution rather than retyped, and only the custody gate reads
--   it. Section 3 changes one line of one condition and nothing else.
--
--   It writes no wallet row and pays nobody. It replaces two functions,
--   creates one, and asserts that the escrow and every payout record are
--   exactly where section 0 found them. The 322.00 is released afterwards
--   by the platform's own idempotent entry point - see AFTER APPLYING.
--
-- DDL POLICY (Club Arena CLAUDE.md section 2)
--   One change, one transaction, one BEGIN/COMMIT: one PostgREST reload.
--   Do NOT apply between :50 and :03 UTC. Apply once; never in a retry loop.
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------
-- 0. PRE-CONDITIONS. Also the no-double-pay proof: this cannot make an
--    already-paid event payable twice, because none of the four has been
--    paid anything at all and that is asserted rather than asserted by
--    comment; and because the new predicate refuses any event that carries
--    a payout's downstream record - a rake settlement, a terminal receipt,
--    a recognition or a fee batch.
-- ---------------------------------------------------------------------
DO $pre$
DECLARE
  v_spins uuid[] := ARRAY['f670ca7c-5134-4a22-9426-eea2601c300a',
                          '5090c03b-2b36-456a-b301-485493280a51',
                          '18c95ce7-2cbc-4ca6-9133-36e3a21d9ab6',
                          'c59c8fe4-a6a8-41f5-b436-c9c55dc0f088']::uuid[];
  n bigint; v_prize numeric; v_fee numeric;
BEGIN
  SELECT count(*) INTO n FROM public.tournaments
   WHERE id = ANY(v_spins) AND upper(status) = 'RUNNING';
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 RUNNING Spins, found %', n; END IF;

  -- NOTHING HAS BEEN PAID. Six independent records, all empty.
  SELECT count(*) INTO n FROM public.tournament_payouts WHERE tournament_id = ANY(v_spins);
  IF n <> 0 THEN RAISE EXCEPTION 'a payout already exists (%); refusing', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_obligations WHERE tournament_id = ANY(v_spins);
  IF n <> 0 THEN RAISE EXCEPTION 'an obligation already exists (%); refusing', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_place_settlement_batches WHERE tournament_id = ANY(v_spins);
  IF n <> 0 THEN RAISE EXCEPTION 'a place batch already exists (%); refusing', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_terminal_settlements WHERE tournament_id = ANY(v_spins);
  IF n <> 0 THEN RAISE EXCEPTION 'a terminal receipt already exists (%); refusing', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_rake_settlements WHERE tournament_id = ANY(v_spins);
  IF n <> 0 THEN RAISE EXCEPTION 'a rake settlement already exists (%); refusing', n; END IF;
  SELECT count(*) INTO n FROM public.accounting_tournament_fee_batches WHERE tournament_id = ANY(v_spins);
  IF n <> 0 THEN RAISE EXCEPTION 'a fee batch already exists (%); refusing', n; END IF;

  -- the escrow is untouched and exactly equals the advertised pool
  SELECT count(*) INTO n
    FROM public.tournament_escrow e JOIN public.tournaments t ON t.id = e.tournament_id
   WHERE e.tournament_id = ANY(v_spins)
     AND e.enforced
     AND e.prize_out = 0 AND e.fee_out = 0
     AND e.refund_prize = 0 AND e.refund_fee = 0
     AND e.closed_at IS NULL AND e.terminal_closed_at IS NULL
     AND e.prize_balance = round(t.prize_pool, 2);
  IF n <> 4 THEN
    RAISE EXCEPTION 'escrow is not in the untouched state for all 4 (matched %)', n; END IF;

  SELECT sum(prize_balance), sum(fee_balance) INTO v_prize, v_fee
    FROM public.tournament_escrow WHERE tournament_id = ANY(v_spins);
  IF v_prize <> 322.00 OR v_fee <> 38.64 THEN
    RAISE EXCEPTION 'escrow totals moved: prize % (expected 322.00), fee % (expected 38.64)',
      v_prize, v_fee; END IF;

  -- each Spin has exactly one survivor to pay and a complete bust sequence
  SELECT count(*) INTO n FROM (
    SELECT tp.tournament_id FROM public.tournament_players tp
     WHERE tp.tournament_id = ANY(v_spins)
     GROUP BY tp.tournament_id
    HAVING count(*) = 3
       AND count(*) FILTER (WHERE tp.status = 'eliminated') = 2
       AND count(tp.elimination_sequence) FILTER (WHERE tp.status = 'eliminated') = 2
  ) q;
  IF n <> 4 THEN
    RAISE EXCEPTION 'the four Spins are not in the 3-seat one-survivor shape (matched %)', n; END IF;

  -- the 14 named events all hold a custody obligation whose stored identity
  -- equals the hard-coded row this migration is about to delete. That is what
  -- makes branch A below a rename rather than a change.
  SELECT count(*) INTO n
    FROM public.accounting_tournament_fee_custody_obligations o
    JOIN LATERAL public.fn_ca_legacy_fee_custody_cohort(o.tournament_id) c ON true
   WHERE o.amount = c.amount
     AND o.source_fingerprint = c.source_fingerprint
     AND jsonb_array_length(o.original_fees) = c.source_count;
  IF n <> 14 THEN
    RAISE EXCEPTION 'expected 14 named events whose obligation matches the list, found %', n; END IF;

  RAISE NOTICE 'pre-conditions hold: 4 Spins, 360.64 held, nothing paid, 14 named intact';
END
$pre$;

-- ---------------------------------------------------------------------
-- 0b. THE BOUNDED SUPERSET, BUILT ONCE.
--     Branch B of the cohort can only admit an event that has no terminal
--     settlement, no rake settlement, no custody obligation and a positive
--     tournament fee. That is ~515 events out of 205,281, so every "what
--     does this admit" question below is asked of the FUNCTION over all of
--     them rather than of a sample - and without making the planner call a STABLE
--     function once per tournament in the table, which does not finish inside
--     a sane statement_timeout. TEMP on purpose: pg_temp is filtered out of
--     pgrst_ddl_watch, so this costs no PostgREST reload (section 2, rule 3).
-- ---------------------------------------------------------------------
CREATE TEMP TABLE zz_custody_candidates ON COMMIT DROP AS
SELECT t.id FROM public.tournaments t
 WHERE NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements x WHERE x.tournament_id=t.id)
   AND NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements x WHERE x.tournament_id=t.id)
   AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_obligations o WHERE o.tournament_id=t.id)
   AND EXISTS(SELECT 1 FROM public.rake_records r WHERE r.tournament_id=t.id AND r.is_tournament AND r.rake_amount>0);
ANALYZE zz_custody_candidates;

-- ---------------------------------------------------------------------
-- 1. THE COHORT BECOMES A PREDICATE.
--
--    Branch A - an obligation already exists. Its own stored snapshot IS
--    the pinned original identity: fn_ca_hold_legacy_tournament_fee wrote
--    it from the live rows at custody time, having first asserted it equal
--    to the hard-coded row, and the table is append-only by trigger. So
--    every one of the 14 named events keeps answering exactly what it
--    answers today - asserted immediately below, and again in section 4 -
--    and fn_ca_begin_legacy_fee_resolution keeps working for the 5 Spins
--    whose records now carry batches and a terminal receipt, which a purely
--    derived branch would have excluded.
--
--    Branch B - no obligation yet. Eligibility is read from rows.
--
--    ONE CHECK GENUINELY WEAKENS AND IT IS SAID PLAINLY: in branch B the
--    amount, fingerprint and count are derived from the same rake records
--    that fn_ca_hold_legacy_tournament_fee then re-derives and compares
--    them against, so that comparison becomes a tautology for a not-yet-
--    held event. What replaces it is not nothing. The amount must still
--    equal tournament_escrow.fee_balance, an independent witness of what
--    was actually collected; every fee record must still predate the
--    cutover and be unbatched and not terminal-closed; and the moment
--    custody is taken the derived values are persisted into the obligation,
--    after which branch A pins them for good.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_custody_cohort(p_tournament_id uuid)
 RETURNS TABLE(amount numeric, source_fingerprint text, source_count integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $cohort$
 SELECT o.amount,o.source_fingerprint,jsonb_array_length(o.original_fees)
   FROM public.accounting_tournament_fee_custody_obligations o
  WHERE o.tournament_id=p_tournament_id
 UNION ALL
 SELECT a.fee,a.fp,a.n FROM public.tournaments t
  JOIN LATERAL (SELECT sum(r.rake_amount) AS fee,
     md5(COALESCE(string_agg(public.fn_accounting_tournament_fee_fingerprint(r),':' ORDER BY r.id),'')) AS fp,
     count(*)::int AS n,
     bool_and(r.created_at<k.starts_at) AS all_pre,
     bool_and(r.terminal_closed_at IS NULL) AS none_closed,
     bool_or(EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id)) AS any_batched
    FROM public.rake_records r CROSS JOIN public.accounting_tournament_fee_cutover k
   WHERE r.tournament_id=t.id AND r.is_tournament AND k.singleton) a ON true
  WHERE t.id=p_tournament_id
    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_obligations o WHERE o.tournament_id=t.id)
    AND a.n>0 AND a.fee>0 AND a.fee=round(a.fee,2)
    AND a.all_pre AND a.none_closed AND NOT a.any_batched
    AND t.satellite_target_id IS NULL AND t.satellite_target IS NULL
    AND lower(COALESCE(t.variant,''))<>'satellite'
    AND NOT public.fn_poker_diamond_tournament(t.id)
    AND NOT EXISTS(SELECT 1 FROM public.tournament_rake_settlements x WHERE x.tournament_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements x WHERE x.tournament_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_recognitions x WHERE x.tournament_id=t.id)
    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_recognized_sources x WHERE x.tournament_id=t.id)
    AND EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=t.id AND e.enforced
               AND e.fee_out=0 AND e.refund_fee=0 AND e.fee_balance=a.fee
               AND e.closed_at IS NULL AND e.terminal_closed_at IS NULL)
$cohort$;

REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_custody_cohort(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $chk1$
DECLARE n bigint; v_total numeric; v_late bigint;
BEGIN
  -- the 14 named answers are identical, one by one
  SELECT count(*) INTO n
    FROM public.accounting_tournament_fee_custody_obligations o
    JOIN LATERAL public.fn_ca_legacy_fee_custody_cohort(o.tournament_id) c ON true
   WHERE o.amount = c.amount
     AND o.source_fingerprint = c.source_fingerprint
     AND jsonb_array_length(o.original_fees) = c.source_count;
  IF n <> 14 THEN
    RAISE EXCEPTION 'the cohort changed a named answer: only % of 14 identical', n; END IF;

  -- what branch B admits, asked of the function over the whole bounded
  -- superset rather than a sample (see the header)
  SELECT count(*), COALESCE(round(sum(c.amount),2),0) INTO n, v_total
    FROM zz_custody_candidates q
    JOIN LATERAL public.fn_ca_legacy_fee_custody_cohort(q.id) c ON true;
  IF n <> 30 OR v_total <> 133.06 THEN
    RAISE EXCEPTION 'the admitted set is % events / % - measured 30 / 133.06; re-measure before applying', n, v_total; END IF;

  -- and it is closed: not one admitted event carries a fee at or after the
  -- cutover, so no event charged from now on can ever join it
  SELECT count(*) INTO v_late
    FROM zz_custody_candidates q
    JOIN LATERAL public.fn_ca_legacy_fee_custody_cohort(q.id) c ON true
   WHERE EXISTS(SELECT 1 FROM public.rake_records r JOIN public.accounting_tournament_fee_cutover k ON k.singleton
                 WHERE r.tournament_id=q.id AND r.is_tournament AND r.created_at >= k.starts_at);
  IF v_late <> 0 THEN
    RAISE EXCEPTION 'the admitted set is not closed: % member(s) carry a post-cutover fee', v_late; END IF;

  RAISE NOTICE 'cohort: 14/14 named identical; branch B admits 30 events / 133.06, all pre-cutover';
END
$chk1$;

-- ---------------------------------------------------------------------
-- 2. THE SPIN PROOF, DERIVED FROM THE AUDITED ONE RATHER THAN RETYPED.
--    Every one of its ~40 evidence checks - the single fn_spin_book_entry
--    record, the three equal paid contributors, each one's entitlement,
--    chip_ledger debit, the spin_reserve_ledger contribution and jackpot
--    draw with their ledger legs, and the immutable managed-game contract
--    scope - is carried over byte for byte. Only the way in changes: from
--    a list of five uuids to the cohort predicate of section 1, plus the
--    Spin's own shape. It still RAISES rather than returning NULL when an
--    eligible event's evidence disagrees, so nothing is hidden.
-- ---------------------------------------------------------------------
DO $mig2$
DECLARE src text; out text; a1 text; r1 text; a2 text; r2 text; hits int; expected int;
BEGIN
  src := pg_get_functiondef('public.fn_ca_sep8_spin_original_fee_proof(uuid)'::regprocedure);

  a1 := $a$CREATE OR REPLACE FUNCTION public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id uuid)$a$;
  hits := (length(src)-length(replace(src,a1,'')))/length(a1);
  IF hits <> 1 THEN RAISE EXCEPTION 'the rename anchor appears % times, expected 1', hits; END IF;
  r1 := $r$CREATE OR REPLACE FUNCTION public.fn_ca_legacy_spin_original_fee_proof(p_tournament_id uuid)$r$;

  a2 := $a$ IF p_tournament_id NOT IN (
 '199a71a9-f364-4e90-a3ba-3cdcfb7755bc'::uuid,'808ef798-0942-4ce0-9ae1-eeefaaf4b0a9',
 'b60c7add-6b38-4549-b091-601f64d118a0','e3f4e2ab-8397-43e8-8643-6cec3fff3a63',
 'f3f050f1-569e-4fb6-859f-86b6092e682e') THEN RETURN NULL; END IF;
$a$;
  hits := (length(src)-length(replace(src,a2,'')))/length(a2);
  IF hits <> 1 THEN RAISE EXCEPTION 'the named-list gate appears % times, expected 1', hits; END IF;
  -- zt/zo, not t/o: the body already declares t as a tournaments%ROWTYPE, and
  -- an alias that shadows it makes every reference ambiguous at runtime.
  r2 := $r$ IF NOT EXISTS(SELECT 1 FROM public.tournaments zt
  WHERE zt.id=p_tournament_id AND lower(COALESCE(zt.variant,''))='spin'
    AND zt.tournament_type='SPIN' AND zt.is_private IS FALSE
    AND zt.satellite_target_id IS NULL AND zt.satellite_target IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_obligations zo
                    WHERE zo.tournament_id=p_tournament_id)
    AND EXISTS(SELECT 1 FROM public.fn_ca_legacy_fee_custody_cohort(p_tournament_id)))
 THEN RETURN NULL; END IF;
$r$;

  expected := length(src)-length(a1)+length(r1)-length(a2)+length(r2);
  out := replace(replace(src,a1,r1),a2,r2);
  IF length(out) <> expected THEN
    RAISE EXCEPTION 'the spin proof substitution changed more than its two anchors'; END IF;
  IF position($g$fn_ca_sep8_spin_original_fee_proof$g$ in out) <> 0 THEN
    RAISE EXCEPTION 'the derived proof still carries the old name'; END IF;

  -- every evidence check survives verbatim
  IF position($g$named Spin original aggregate identity missing$g$ in out) = 0
     OR position($g$named Spin requires exactly three equal original paid contributors$g$ in out) = 0
     OR position($g$named Spin original paid entry ambiguous$g$ in out) = 0
     OR position($g$named Spin original debit evidence disagrees$g$ in out) = 0
     OR position($g$named Spin original reserve contribution disagrees$g$ in out) = 0
     OR position($g$named Spin reserve contribution debit disagrees$g$ in out) = 0
     OR position($g$named Spin original prize draw disagrees$g$ in out) = 0
     OR position($g$named Spin original prize draw credit disagrees$g$ in out) = 0
     OR position($g$named Spin original created scope missing$g$ in out) = 0
     OR position($g$named Spin immutable economic scope disagrees$g$ in out) = 0
     OR position($g$fn_spin_book_entry$g$ in out) = 0
     OR position($g$2026-09-17T18:24:02.831517Z$g$ in out) = 0
     OR position($g$fn_poker_diamond_tournament$g$ in out) = 0
     OR position($g$fn_managed_game_contract_hash$g$ in out) = 0
     OR position($g$spin_reserve_ledger$g$ in out) = 0
     OR position($g$managed_game_contract_versions$g$ in out) = 0 THEN
    RAISE EXCEPTION 'the spin proof substitution lost an evidence check'; END IF;

  EXECUTE out;
  RAISE NOTICE 'derived spin proof created: the way in is read, the evidence is unchanged';
END
$mig2$;

-- The database's default privileges grant EXECUTE on every new function to
-- anon, authenticated and service_role. fn_ca_sep8_spin_original_fee_proof,
-- the function this one is derived from, is postgres-only, and a
-- SECURITY DEFINER reader of the fee ledger has no business being reachable
-- from a browser. Measured in the dry run: without this line the new function
-- lands as {postgres,anon,authenticated,service_role}. Its only callers are
-- SECURITY DEFINER functions owned by postgres, so they are unaffected.
REVOKE ALL ON FUNCTION public.fn_ca_legacy_spin_original_fee_proof(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. CUSTODY ACCEPTS EITHER PROOF. One condition, one extra conjunct: a
--    Spin is refused only when NEITHER proof holds. The sep8 branch is
--    untouched and is still tried first, so the 5 named Spins and every
--    reader of their result behave exactly as they do today.
-- ---------------------------------------------------------------------
DO $mig3$
DECLARE src text; out text; a text; r text; hits int;
BEGIN
  src := pg_get_functiondef('public.fn_ca_hold_legacy_tournament_fee(uuid,text)'::regprocedure);
  a := $a$
  OR (lower(COALESCE(t.variant,''))='spin' AND public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NULL)
$a$;
  hits := (length(src)-length(replace(src,a,'')))/length(a);
  IF hits <> 1 THEN RAISE EXCEPTION 'the custody spin gate appears % times, expected 1', hits; END IF;
  r := $r$
  OR (lower(COALESCE(t.variant,''))='spin' AND public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NULL
      AND public.fn_ca_legacy_spin_original_fee_proof(p_tournament_id) IS NULL)
$r$;
  out := replace(src,a,r);
  IF length(out) <> length(src)-length(a)+length(r) THEN
    RAISE EXCEPTION 'the custody substitution changed more than the anchor'; END IF;

  -- The escrow_snapshot scope build is NOT touched. fn_ca_tournament_fee_
  -- custody_receipt recomputes original_scope with sep8 alone and compares
  -- it to the stored value, so adding the derived proof there would make
  -- custody refuse its own receipt in the same transaction.
  hits := (length(out)-length(replace(out,
    $g$CASE WHEN public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('spin_original',public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id)) END$g$,'')))/
    length($g$CASE WHEN public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id) IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('spin_original',public.fn_ca_sep8_spin_original_fee_proof(p_tournament_id)) END$g$);
  IF hits <> 1 THEN RAISE EXCEPTION 'the custody scope build was disturbed (% hits)', hits; END IF;

  -- every other guard in the custody gate survives verbatim
  IF position($g$legacy fee custody requires exact unpaid named source and completed player banks$g$ in out) = 0
     OR position($g$legacy fee custody original source identity changed$g$ in out) = 0
     OR position($g$legacy fee custody requires the original missing attribution refusal$g$ in out) = 0
     OR position($g$fn_accounting_tournament_fee_net_plan$g$ in out) = 0
     OR position($g$tournament_fee_sources_require_reconciliation$g$ in out) = 0
     OR position($g$accounting_terms_not_observed$g$ in out) = 0
     OR position($g$accounting_terms_not_active$g$ in out) = 0
     OR position($g$tournament_fee_not_captured_by_original_producer$g$ in out) = 0
     OR position($g$fn_ca_lock_settlement_lane_global$g$ in out) = 0
     OR position($g$upper(t.status) <> 'COMPLETING'$g$ in out) = 0
     OR position($g$t.satellite_target_id IS NOT NULL$g$ in out) = 0
     OR position($g$fn_poker_diamond_tournament$g$ in out) = 0
     OR position($g$e.prize_balance IS DISTINCT FROM 0::numeric$g$ in out) = 0
     OR position($g$e.bounty_balance IS DISTINCT FROM 0::numeric$g$ in out) = 0
     OR position($g$e.fee_balance IS DISTINCT FROM c.amount$g$ in out) = 0
     OR position($g$2026-09-17T18:24:02.831517Z$g$ in out) = 0
     OR position($g$fn_ca_tournament_fee_custody_receipt$g$ in out) = 0 THEN
    RAISE EXCEPTION 'the custody substitution lost a guard'; END IF;

  EXECUTE out;
  RAISE NOTICE 'custody now accepts either proof for a Spin';
END
$mig3$;

-- ---------------------------------------------------------------------
-- 4. POST-CONDITIONS. Prove the three functions are what we meant, prove
--    sep8 was NOT touched, and - the important one - prove this migration
--    moved no money.
-- ---------------------------------------------------------------------
DO $post$
DECLARE
  v_spins uuid[] := ARRAY['f670ca7c-5134-4a22-9426-eea2601c300a',
                          '5090c03b-2b36-456a-b301-485493280a51',
                          '18c95ce7-2cbc-4ca6-9133-36e3a21d9ab6',
                          'c59c8fe4-a6a8-41f5-b436-c9c55dc0f088']::uuid[];
  n bigint; v_prize numeric; v_fee numeric; d text;
BEGIN
  -- sep8 is exactly as it was: still named by its list, still without the gate
  d := pg_get_functiondef('public.fn_ca_sep8_spin_original_fee_proof(uuid)'::regprocedure);
  IF position($g$IF p_tournament_id NOT IN ($g$ in d) = 0
     OR position($g$'f3f050f1-569e-4fb6-859f-86b6092e682e') THEN RETURN NULL; END IF;$g$ in d) = 0
     OR position($g$fn_ca_legacy_fee_custody_cohort(p_tournament_id)))$g$ in d) <> 0 THEN
    RAISE EXCEPTION 'fn_ca_sep8_spin_original_fee_proof was modified; it must not be'; END IF;

  d := pg_get_functiondef('public.fn_ca_legacy_fee_custody_cohort(uuid)'::regprocedure);
  IF position($g$accounting_tournament_fee_custody_obligations$g$ in d) = 0
     OR position($g$accounting_tournament_fee_cutover$g$ in d) = 0
     OR position($g$VALUES$g$ in d) <> 0 THEN
    RAISE EXCEPTION 'the cohort is not in its intended state'; END IF;

  d := pg_get_functiondef('public.fn_ca_hold_legacy_tournament_fee(uuid,text)'::regprocedure);
  IF position($g$fn_ca_legacy_spin_original_fee_proof(p_tournament_id) IS NULL)$g$ in d) = 0 THEN
    RAISE EXCEPTION 'the custody gate is not in its intended state'; END IF;

  -- the three functions are owned and reachable exactly as their neighbours
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public'
     AND p.proname IN ('fn_ca_legacy_fee_custody_cohort','fn_ca_legacy_spin_original_fee_proof',
                       'fn_ca_hold_legacy_tournament_fee','fn_ca_sep8_spin_original_fee_proof')
     AND pg_get_userbyid(p.proowner)='postgres'
     AND COALESCE(p.proacl::text,'') = '{postgres=X/postgres}';
  IF n <> 4 THEN RAISE EXCEPTION 'owner/ACL is not postgres-only on all 4 (matched %)', n; END IF;

  -- all four Spins now clear the gate: each is admitted, and each proves out
  SELECT count(*) INTO n FROM unnest(v_spins) s
   WHERE EXISTS(SELECT 1 FROM public.fn_ca_legacy_fee_custody_cohort(s))
     AND public.fn_ca_legacy_spin_original_fee_proof(s) IS NOT NULL;
  IF n <> 4 THEN
    RAISE EXCEPTION 'only % of the 4 Spins are admitted and proven', n; END IF;

  -- every admitted Spin proves out, not just ours: 17 of the 30, and not
  -- one of them newly RAISES where sep8 quietly returned NULL
  SELECT count(*) INTO n
    FROM zz_custody_candidates q
    JOIN public.tournaments t ON t.id = q.id
    JOIN LATERAL public.fn_ca_legacy_fee_custody_cohort(q.id) c ON true
   WHERE lower(COALESCE(t.variant,''))='spin'
     AND public.fn_ca_legacy_spin_original_fee_proof(q.id) IS NOT NULL;
  IF n <> 17 THEN
    RAISE EXCEPTION 'expected all 17 admitted Spins to prove out, got %', n; END IF;

  -- NO MONEY MOVED.
  SELECT count(*) INTO n FROM public.tournament_payouts WHERE tournament_id = ANY(v_spins);
  IF n <> 0 THEN RAISE EXCEPTION 'this migration created % payout row(s)', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_obligations WHERE tournament_id = ANY(v_spins);
  IF n <> 0 THEN RAISE EXCEPTION 'this migration created % obligation row(s)', n; END IF;
  SELECT count(*) INTO n FROM public.tournament_rake_settlements WHERE tournament_id = ANY(v_spins);
  IF n <> 0 THEN RAISE EXCEPTION 'this migration created % rake settlement(s)', n; END IF;
  SELECT count(*) INTO n FROM public.accounting_tournament_fee_batches WHERE tournament_id = ANY(v_spins);
  IF n <> 0 THEN RAISE EXCEPTION 'this migration created % fee batch(es)', n; END IF;
  SELECT count(*) INTO n FROM public.accounting_tournament_fee_custody_obligations;
  IF n <> 14 THEN RAISE EXCEPTION 'the custody obligation count changed: % (expected 14)', n; END IF;
  SELECT count(*) INTO n FROM public.accounting_tournament_fee_custody_resolutions;
  IF n <> 0 THEN RAISE EXCEPTION 'this migration created % custody resolution(s)', n; END IF;

  SELECT sum(prize_balance), sum(fee_balance) INTO v_prize, v_fee
    FROM public.tournament_escrow WHERE tournament_id = ANY(v_spins);
  IF v_prize <> 322.00 OR v_fee <> 38.64 THEN
    RAISE EXCEPTION 'this migration moved escrow: prize %, fee %', v_prize, v_fee; END IF;

  SELECT count(*) INTO n FROM public.tournaments
   WHERE id = ANY(v_spins) AND upper(status) = 'RUNNING';
  IF n <> 4 THEN RAISE EXCEPTION 'this migration changed a tournament status'; END IF;

  RAISE NOTICE 'post-conditions hold: 2 functions replaced, 1 created, sep8 untouched, 0.00 moved';
  RAISE NOTICE 'the four Spins now clear the custody gate; settle them one per transaction';
END
$post$;

COMMIT;

-- =====================================================================
-- AFTER APPLYING
--
--   These four are NOT retried by the engine. Their tables are long gone
--   and tournaments.updated_at on all four is still 2026-09-08 - unlike the
--   three MTTs of 20260921001532, which were being refused every few
--   minutes. So the close has to be asked for once, through the platform's
--   own idempotent entry point, and fn_ca_lock_settlement_lane_global holds
--   the finish lane for ONE tournament per transaction, so it is four
--   separate transactions, not one loop:
--
--     SELECT public.fn_complete_tournament_terminal(
--       'f670ca7c-5134-4a22-9426-eea2601c300a','a666df27-...','places');
--     SELECT public.fn_complete_tournament_terminal(
--       '5090c03b-2b36-456a-b301-485493280a51','6cd9867c-...','places');
--     SELECT public.fn_complete_tournament_terminal(
--       '18c95ce7-2cbc-4ca6-9133-36e3a21d9ab6','8f4acae4-...','places');
--     SELECT public.fn_complete_tournament_terminal(
--       'c59c8fe4-a6a8-41f5-b436-c9c55dc0f088','3ebbefd2-...','places');
--
--   The winner of each is its one surviving tournament_players row. All
--   twelve seats are horses and are paid exactly as humans (law 10.5).
--   This is the platform's own settlement path invoked once, not a repair
--   job: law 10.12 forbids building a cron, sweep or back-pay to do it.
--
--   Watch, do not assume. Completion means status COMPLETED, prize_balance
--   0.00, a tournament_payouts row for the full pool, a
--   tournament_terminal_settlements row, and the fee in custody:
--     SELECT left(t.id::text,8), t.status, e.prize_balance, e.prize_out,
--            (SELECT count(*) FROM tournament_payouts p WHERE p.tournament_id=t.id),
--            (SELECT sum(o.amount) FROM accounting_tournament_fee_custody_obligations o
--              WHERE o.tournament_id=t.id)
--       FROM tournaments t JOIN tournament_escrow e ON e.tournament_id=t.id
--      WHERE t.id IN (the four);
--
--   STILL OPEN AFTER THIS (report, not paperwork):
--     * 26 further events, 94.42 of fees, are now admitted by the same
--       predicate. They are all REGISTERING zombies from the same
--       2026-09-08 window and nothing closes them today; when something
--       does, their pre-epoch fee will go to custody instead of blocking
--       the close. That is the point, and the number is bounded and shrinks.
--     * 4 satellites from that window (19.50) remain refused, because
--       fn_ca_hold_legacy_tournament_fee excludes a satellite outright and
--       this migration did not change that.
--     * 18 fees will then sit in custody, none resolved. Custody is a hold,
--       not an answer: what the fee EARNS for whom is still unknown, and it
--       is unknown because accounting_agreement_history does not reach back
--       to 2026-09-08. That epoch decision is task #68 and it is Dan's.
-- =====================================================================
