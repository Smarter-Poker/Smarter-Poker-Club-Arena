-- 20261016103238_a_rake_finding_is_measured_again_from_the_hands_dealt_list
--
-- Reserved by scripts/new-migration.mjs on 2026-10-16 10:32:38 UTC.
--
-- A RAKE FINDING IS MEASURED AGAIN FROM THE HAND'S DEALT LIST (2026-10-16)
--
-- The recurrence. ledger_reconcile_log:bbj_over_spec (15 alert rows) and
-- ledger_reconcile_log:over_spec (3) kept arriving at :52 every hour on
-- 2026-10-16, after #7034 (20261015222121, installed about 00:10) fixed the
-- Lightning writer. No new finding exists: the last rake_law row was written at
-- 2026-10-15 21:40, fn_rake_law_violations over the 10 hours to 10:20 finds
-- nothing, and the 07:50 wide run filed nothing. The :52 job is
-- fn_ca_escalate_reconcile_criticals. It takes the newest ledger_reconcile_log
-- row per entity within 36 hours, measures the entity again, and files on the
-- stored row when it cannot measure. fn_ca_remeasure_entity could measure a
-- club treasury and (since 20261009180352) a Diamond cash table, but a
-- rake_law finding on a chip table was "cannot measure", so the newest
-- 2026-10-15 21:40 row of each Lightning pilot table was filed again every
-- hour, adding one occurrence to each storm incident, until it would leave the
-- lookback on 2026-10-17 at 09:40. Not an r5 install: this is the 2026-10-09
-- branch's stated gap.
--
-- The money is right. The 176 findings are 88 hands each (over_spec and
-- bbj_over_spec), all on "Lightning Pilot NLH 9" and "Lightning Pilot NLH 6"
-- between 2026-10-15 20:12:23 and 20:53:11 UTC. Priced with the players
-- actually dealt in (hand_history.players), 0 are over spec, 0 under, 0 BBJ
-- over and 0 BBJ under: over_spec hands took 7.43 rake and 1.65 drop against a
-- spec of 7.43 and 1.65, bbj_over_spec hands took 4.66 and 1.60 against 4.66
-- and 1.60. In every one rake_records.num_players is below the dealt count
-- (the payer count the old Lightning writer booked). Over 72 hours the two
-- tables' 5,874 cash hands record 149.63 of rake and drop against a spec of
-- 149.63. Nobody was over-raked; there is nothing to settle.
--
-- The lines.
-- 1. fn_rake_law_violations priced a hand by COALESCE(rr.num_players, the
--    length of hand_history.players): the copy first, the witness second. The
--    hand's own dealt list now comes first (a zero-length list falls through
--    to the copy). On the 133,614 cash hands of the 40 hours to 10:20 the two
--    agree on all but the 148 Lightning hands of 2026-10-15, so no other
--    verdict moves.
-- 2. fn_ca_remeasure_entity gains the chip rake law: a rake_law finding on a
--    cash table is measured again over the table's cash hands of the last 72
--    hours exactly as fn_rake_law_violations prices them (rake and BBJ drop
--    against the spec for the players dealt in, no-flop-no-drop, a showdown
--    with no board and no rake). Any disagreeing hand keeps it critical, so a
--    real over-rake is still filed on fresh numbers every hour. Measured
--    read-only on production at 10:32 with this exact query: both pilot
--    tables "ok", 111.65 against 111.65 and 37.98 against 37.98, about two
--    seconds each.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261007212545 and
-- 20261015222121. Each live text must hash to the md5 measured on production
-- on 2026-10-16 (a3e1fde3... and 03e547f6...), each anchor must occur exactly
-- once, and each result must hash to the postimage derived read-only on
-- production with replace() (e64d0cfd... and 6619b6b5...); owner, SECURITY
-- DEFINER, proconfig and grants must not move.
--
-- Regression: scripts/ci/test-a-rake-finding-is-measured-again.py (native
-- PostgreSQL), run by .github/workflows/a-rake-finding-is-measured-again.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_remeasure_entity(text,uuid)'::regprocedure)) = '6619b6b524cde561636e4d451cd0ee2c' AND md5(pg_get_functiondef('public.fn_rake_law_violations(interval)'::regprocedure)) = 'e64d0cfdbcb494a2230db017fff390e1')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_audit_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_audit_subst(
  'public.fn_rake_law_violations(interval)',
  'a3e1fde3f45140c91640389d419ed553', 'e64d0cfdbcb494a2230db017fff390e1',
  ARRAY[$o$           COALESCE(rr.num_players, jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END)) AS dealt,
$o$],
  ARRAY[$n$           /* THE HAND'S OWN DEALT LIST FIRST (2026-10-16). hand_history.players
              is every player dealt in, written by the hand itself;
              rake_records.num_players is a copy of that count, and on
              2026-10-15 fn_lightning_settle_hand booked payers there instead
              (148 hands, fixed by 20261015222121). In the 40 hours to
              2026-10-16 10:20 UTC the two agreed on 133,466 of 133,614 cash
              hands; the 148 are exactly those. Price by the witness. */
           COALESCE(NULLIF(jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END), 0),
                    rr.num_players) AS dealt,
$n$]
);

SELECT pg_temp.ca_audit_subst(
  'public.fn_ca_remeasure_entity(text,uuid)',
  '03e547f65a2d4c43fd52ac92787111ba', '6619b6b524cde561636e4d451cd0ee2c',
  ARRAY[$o$  RETURN QUERY SELECT false, NULL::numeric, NULL::numeric, NULL::text;
$o$],
  ARRAY[$n$  /* A CHIP RAKE FINDING IS MEASURED AGAIN TOO (2026-10-16). Until today a
     rake_law finding on a chip table was "cannot measure", so the escalator
     re-filed the stored row from history every hour for 36 hours after the
     cause was fixed: the 2026-10-15 Lightning pilot findings (88 over_spec, 88
     bbj_over_spec, every hand priced to spec by the players dealt in) went on
     being filed into their storm incidents at :52 until 2026-10-17. Measure
     the table again exactly as fn_rake_law_violations prices a chip hand,
     over every cash hand of the last 72 hours (the escalator's 36-hour
     lookback plus the 26-hour wide window the finding can come from, with
     margin): rake and BBJ drop against the spec for the players dealt in,
     no-flop-no-drop, and a showdown with no board and no rake. Any hand
     that disagrees keeps it critical. ledger_balance is the spec rake plus
     drop, stored_balance the recorded rake plus drop. */
  IF p_entity_type = 'rake_law' AND p_entity_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tables t WHERE t.id = p_entity_id AND t.tournament_id IS NULL) THEN
    RETURN QUERY
      WITH h AS (
        SELECT COALESCE(hh.rake_amount, 0) AS rake,
               COALESCE(rr.bbj_contribution, hh.bbj_amount, 0) AS bbj,
               hh.pot_size AS pot, t.small_blind AS sb, t.big_blind AS bb,
               t.club_id, t.id AS tid, t.max_players AS seats,
               lower(COALESCE(hh.game_variant, t.game_variant::text)) AS variant,
               COALESCE(NULLIF(jsonb_array_length(CASE WHEN jsonb_typeof(hh.players) = 'array' THEN hh.players END), 0),
                        rr.num_players) AS dealt,
               COALESCE(array_length(hh.community_cards, 1), 0)
                 + COALESCE(array_length(hh.community_cards2, 1), 0) AS board_n,
               hh.showdown IS NOT NULL AS has_showdown,
               CASE WHEN t.rake_percent >= 0 THEN t.rake_percent
                    WHEN c.default_rake_percent >= 0 THEN c.default_rake_percent END AS ov_pct,
               CASE WHEN t.rake_cap_bb >= 0 THEN t.rake_cap_bb
                    WHEN c.rake_cap >= 0 THEN c.rake_cap END AS ov_cap_bb
          FROM public.hand_history hh
          JOIN public.tables t ON t.id = hh.table_id
          LEFT JOIN public.clubs c ON c.id = t.club_id
          LEFT JOIN public.rake_records rr ON rr.hand_id = hh.id
         WHERE hh.table_id = p_entity_id
           AND hh.tournament_id IS NULL
           AND hh.created_at > now() - interval '72 hours'
           AND hh.created_at < now() - interval '5 minutes'
      ), f AS (
        SELECT h.*, e.rake AS exp_rake,
               public.fn_effective_bbj_drop(h.bb, h.dealt, true, h.club_id, h.tid, h.variant, h.sb, h.pot, h.rake) AS exp_bbj
          FROM h
          CROSS JOIN LATERAL public.fn_effective_rake(h.bb, h.pot, h.dealt, true, h.sb, h.ov_pct, h.ov_cap_bb, h.seats) e
         WHERE h.board_n >= 3 AND h.dealt IS NOT NULL
      )
      SELECT true,
             COALESCE((SELECT sum(f.exp_rake + f.exp_bbj) FROM f), 0),
             COALESCE((SELECT sum(f.rake + f.bbj) FROM f), 0),
             CASE WHEN EXISTS (SELECT 1 FROM f WHERE abs(f.rake - f.exp_rake) > 0.005
                                                  OR abs(f.bbj - f.exp_bbj) > 0.005)
                    OR EXISTS (SELECT 1 FROM h WHERE h.board_n = 0 AND NOT h.has_showdown
                                                 AND h.rake + h.bbj > 0.005)
                    OR EXISTS (SELECT 1 FROM h WHERE h.rake = 0 AND h.has_showdown AND h.board_n < 3)
                  THEN 'critical' ELSE 'ok' END;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, NULL::numeric, NULL::numeric, NULL::text;
$n$]
);

COMMIT;
