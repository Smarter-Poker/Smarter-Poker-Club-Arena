-- 20261008043041_a_diamond_hand_is_priced_by_the_diamond_settler_not_the_chip
--
-- Reserved by scripts/new-migration.mjs on 2026-10-08 04:30:41 UTC.
--
-- A DIAMOND HAND IS PRICED BY THE DIAMOND SETTLER, NOT THE CHIP SPEC (2026-10-08)
--
-- WHAT FIRED. From 2026-10-07 04:40 UTC the hourly rake-law monitor
-- (fn_rake_law_check -> fn_rake_law_violations) wrote 2,278 critical
-- ledger_reconcile_log rows of kind over_spec, and they reached the board as
-- two alert classes: ledger_reconcile_log:over_spec (2,360 intake rows) and
-- ledger_reconcile_log:rake_law (194 intake rows). Every one of the 2,278 is
-- a cash hand on a Diamond table (clubs.asset = 'diamonds'), and every one
-- reads "took N where the spec says 0".
--
-- WHY. The owner published a Diamond cash rake on 2026-10-06/07, and the
-- engine now prices a Diamond hand from ca_diamond_economics
-- (server/src/domain/diamondCashRakeSchedule.ts). fn_poker_diamond_settle_cash_hand
-- recomputes that rake from the same published rows and REFUSES the hand
-- (diamond_cash_rake_disagrees) when the engine's number differs. A Diamond
-- table's rake_percent and rake_cap_bb are required to be EXPLICITLY ZERO
-- (DiamondCashBoundary.ts) so the chip economy can never leak into it, and
-- fn_rake_law_violations reads those two columns as a chip override of 0%:
-- the chip spec therefore allows 0 on every Diamond hand, and every raked
-- Diamond hand became over_spec. Measured read-only on production 2026-10-08:
-- all 2,278 flagged hands have a poker_diamond_hand_receipts row whose rake
-- equals hand_history.rake_amount, and ca_diamond_rake_accrual sums to that
-- rake for every one; across all 6,157 Diamond cash hands of the last two
-- days, 6,157 are receipted at exactly the recorded rake. Nobody was
-- over-raked. This is a detector defect, not a money defect.
--
-- WHY TWO CLASSES. fn_ca_reconcile_log_to_incident files a rake_law row under
-- 'ledger_reconcile_log:' || COALESCE(source, kind) = ...:over_spec, and
-- fn_ca_escalate_reconcile_criticals said it files "the same source the
-- trigger files under" but used COALESCE(source, entity_type) = ...:rake_law.
-- Once the over_spec source reached its storm cap of 25 open incidents, every
-- finding the escalator re-raised under a new key went round the cap under the
-- second name. One finding, two classes.
--
-- THE FIX, two pinned-text substitutions:
--   1. fn_rake_law_violations prices a Diamond hand against what the Diamond
--      settler accepted, not against the chip spec. Diamond hands leave the
--      chip pricing (over_spec, under_spec, bbj_over_spec, bbj_under_spec,
--      no_flop_no_drop) and gain their own kind, diamond_rake_unsettled: the
--      hand's recorded rake differs from the rake its settlement receipt
--      accepted, or the hand recorded a rake and has no receipt at all. The
--      record-integrity kinds (board_not_recorded, players_not_recorded,
--      impossible_showdown, bbj_club_switch_ignored) still read every hand.
--   2. fn_ca_escalate_reconcile_criticals files under the trigger's source
--      expression, COALESCE(source, kind, entity_type), so one finding is one
--      class and the storm cap holds.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545. The
-- live text must hash to today's measured pg_get_functiondef md5
-- (violations 812a6832..., escalator 0866dffd...), each anchor must occur
-- exactly once, and the result must hash to the derived postimage (computed
-- read-only on production with replace() on 2026-10-08); owner, SECURITY
-- DEFINER, proconfig and grants must not move.
--
-- Regression: scripts/ci/test-rake-law-diamond-hands.py (native PostgreSQL),
-- run by .github/workflows/rake-law-diamond-hands.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_rake_law_violations(interval)'::regprocedure)) = 'a3e1fde3f45140c91640389d419ed553' AND md5(pg_get_functiondef('public.fn_ca_escalate_reconcile_criticals(interval)'::regprocedure)) = '09419f2424c729220b8dbaf5475e60c5')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_rake_law_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_rake_law_subst(
  'public.fn_rake_law_violations(interval)',
  '812a68328e7f0aeeefe56205d337bf33', 'a3e1fde3f45140c91640389d419ed553',
  ARRAY[$vo1$           c.bbj_rake_enabled
      FROM public.hand_history hh$vo1$,
        $vo2$     WHERE h.board_n >= 3 AND h.dealt IS NOT NULL
$vo2$,
        $vo3$    FROM h WHERE board_n = 0 AND NOT has_showdown AND rake + bbj > 0.005
$vo3$,
        $vo4$             + COALESCE(array_length(hh.community_cards2, 1), 0) < 3
  )
$vo4$,
        $vo5$    FROM h WHERE bbj_rake_enabled IS FALSE AND bbj > 0.005;
$vo5$],
  ARRAY[$vn1$           c.bbj_rake_enabled,
           hh.hand_number,
           /* A DIAMOND HAND IS NOT PRICED BY THE CHIP SPEC (2026-10-08). A
              Diamond table's rake_percent and rake_cap_bb are explicitly zero
              by rule (DiamondCashBoundary), so the chip spec reads them as a
              0% override; the hand is priced from ca_diamond_economics and
              fn_poker_diamond_settle_cash_hand refuses any other number. */
           COALESCE(c.asset = 'diamonds', false) AS diamond
      FROM public.hand_history hh$vn1$,
        $vn2$     WHERE h.board_n >= 3 AND h.dealt IS NOT NULL
       AND NOT h.diamond
$vn2$,
        $vn3$    FROM h WHERE board_n = 0 AND NOT has_showdown AND rake + bbj > 0.005
     AND NOT diamond
$vn3$,
        $vn4$             + COALESCE(array_length(hh.community_cards2, 1), 0) < 3
  ), hd AS (
    -- The Diamond rake law is the settler's recompute: the rake this hand
    -- recorded must be the rake its settlement receipt accepted.
    SELECT h.*,
           (SELECT (r.receipt->>'rake')::numeric
              FROM public.poker_diamond_hand_receipts r
             WHERE r.table_id = h.table_id AND r.hand_number = h.hand_number) AS settled_rake
      FROM h
     WHERE h.diamond
  )
$vn4$,
        $vn5$    FROM h WHERE bbj_rake_enabled IS FALSE AND bbj > 0.005
  UNION ALL
  SELECT 'diamond_rake_unsettled', id, table_id, created_at, sb, bb, pot, rake, settled_rake
    FROM hd WHERE settled_rake IS DISTINCT FROM rake AND (settled_rake IS NOT NULL OR rake > 0.005);
$vn5$]
);

SELECT pg_temp.ca_rake_law_subst(
  'public.fn_ca_escalate_reconcile_criticals(interval)',
  '0866dffd580904655904c7fb7fbc05c4', '09419f2424c729220b8dbaf5475e60c5',
  ARRAY[$eo1$      -- the same source the trigger files under, so one detector owns it
      'ledger_reconcile_log:' || COALESCE(r.metadata->>'source', r.entity_type),
$eo1$],
  ARRAY[$en1$      -- the same source the trigger files under, so one detector owns it.
      -- fn_ca_reconcile_log_to_incident reads COALESCE(source, kind); this
      -- read COALESCE(source, entity_type) until 2026-10-08, so a rake_law
      -- over_spec finding was over_spec from the trigger and rake_law from
      -- here: two classes for one finding, and the second name went round
      -- the first one's storm cap.
      'ledger_reconcile_log:' || COALESCE(r.metadata->>'source', r.metadata->>'kind', r.entity_type),
$en1$]
);

COMMIT;
