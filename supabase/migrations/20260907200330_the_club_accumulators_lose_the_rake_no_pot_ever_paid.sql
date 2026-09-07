BEGIN;
SET LOCAL statement_timeout = '110s';

/* SETTLING THE DOUBLE BANK THAT 20260907195116 STOPPED (CLAUDE.md 10.9).
   ---------------------------------------------------------------------------
   WHAT HAPPENED. Until the engine minted the hand's uuid at settlement, a hand
   whose `hand_history` insert had not come back yet banked its rake with
   `p_hand_id => NULL`. `atomic_distribute_rake` derives the wallet's
   idempotency key as

       v_leg_key := COALESCE(p_hand_id, md5('rake:'||table||':'||hand_number))

   so the live call took the md5 key and `fn_redrive_unbanked_rake`, running at
   7,22,37,52 with the hand id it had since resolved, took the uuid key. Two
   different keys, `rake_distribution_legs` deduped neither, and `club_wallets`
   was incremented twice for one pot.

   THE MEASUREMENT, 2026-09-07 20:0x UTC. Ninety-nine hands, both leg rows
   present, first 2026-09-06 10:08:54, last 2026-09-07 18:26:38:

     Midway Union        79 hands   150.25 rake   21.27 bbj
     Deep Stack Society  20 hands    16.13 rake    4.91 bbj
     ----------------------------------------------------------
                         99 hands   166.38 rake   26.18 bbj

   The window starts on 2026-09-06 because `rake_distribution_legs` does: before
   it there was no per-leg record to compare, and the earlier population of this
   same defect (4,452 rows, 2026-04-16 to 2026-09-05, 16,426.46 of rake) is
   already named in `atomic_distribute_rake`'s own header and is not re-settled
   here.

   WHAT IS CORRECTED, AND WHAT IS DELIBERATELY NOT.

   * `club_wallets` accumulators: corrected, below. They are what
     `fn_club_money_panel` shows an operator. Nothing pays from them - measured:
     `period_rake_collected = lifetime_rake_collected` on both clubs, so no
     period has ever been closed against them - so this is a number being made
     true, not money being moved. `chip_balance` is untouched (the 2026-09-02
     ruling pays the club share weekly from the rake treasury, not per hand).

   * The ghost `rake_records` rows: LEFT ALONE. They are the true record of
     what the platform did, `ca_reporting_rake_change` is a FOR EACH ROW trigger
     that rebuilds a whole day's reporting per row touched (a probe of 99
     updates timed out at 110s), and they carry no `rake_attributions` at all -
     which is the same null that caused this - so nothing per-player reads them.

   * `ca_club_rake_daily`: LEFT ALONE, because a rolled-back probe showed the
     subtraction would take Midway Union's daily rake NEGATIVE (33.91 recorded
     against 45.05 of ghosts on 2026-09-06). That rollup is not a sum of
     `rake_records.club_id`, and 10.9 rule 1 says read the outcome rather than
     assume it. It is `fn_club_rake_rollup_day`'s to derive, not mine to adjust.

   * The doubled VIP points: LEFT WITH THE PLAYERS. `fn_award_vip_points_from_rake`
     fires on INSERT and reads `NEW.player_contributions`, which both rows
     carried, so both awarded. CLAUDE.md 10.9 rule 3 is explicit: overpay caused
     by our defect is absorbed by the house, reported, and left alone. It is
     reported here and in the changelog.

   THE ASSERTION. New ghosts can still appear until the engine deploy lands, so
   this does not pin the total to 166.38 - it recomputes the set, refuses
   anything beyond a 400-chip band (roughly two and a half times the measured
   figure), and records exactly what it corrected in the alert's context. */

CREATE TEMP TABLE zz_ghosts ON COMMIT DROP AS
WITH orphans AS (
  SELECT rr.id AS orphan_id, rr.table_id, rr.club_id, rr.rake_amount,
         COALESCE(rr.bbj_contribution,0) AS bbj,
         (rr.metadata->>'hand_number')::bigint AS hand_number
    FROM public.rake_records rr
   WHERE rr.hand_id IS NULL AND rr.tournament_id IS NULL
     AND rr.metadata->>'hand_number' IS NOT NULL
     AND rr.created_at >= '2026-08-01'
)
SELECT o.orphan_id, o.club_id, o.rake_amount, o.bbj, hh.id AS good_hand_id
  FROM orphans o
  JOIN public.hand_history hh ON hh.table_id=o.table_id AND hh.hand_number=o.hand_number
  JOIN public.rake_distribution_legs ol
    ON ol.leg_key = md5('rake:'||o.table_id::text||':'||o.hand_number::text)::uuid
   AND ol.leg = 'club_accumulator'
  JOIN public.rake_distribution_legs hl
    ON hl.leg_key = hh.id AND hl.leg = 'club_accumulator'
 WHERE EXISTS (SELECT 1 FROM public.rake_records s WHERE s.hand_id = hh.id);

DO $$
DECLARE v_n int; v_rake numeric; v_bbj numeric; v_detail jsonb; v_bad int;
BEGIN
  SELECT count(*), COALESCE(round(sum(rake_amount),2),0), COALESCE(round(sum(bbj),2),0)
    INTO v_n, v_rake, v_bbj FROM zz_ghosts;

  IF v_n = 0 THEN
    RAISE EXCEPTION 'no double-banked hands found - the set this migration was written against is gone, so it must not guess';
  END IF;
  IF v_rake > 400 THEN
    RAISE EXCEPTION 'excess rake % is far beyond the measured 166.38 - the board moved, re-measure before correcting', v_rake;
  END IF;

  SELECT count(*) INTO v_bad FROM (
    SELECT g.club_id, sum(g.rake_amount) AS rake, sum(g.bbj) AS bbj
      FROM zz_ghosts g GROUP BY g.club_id) x
    JOIN public.club_wallets cw ON cw.club_id = x.club_id
   WHERE x.rake > cw.period_rake_collected OR x.bbj > cw.period_bbj_contribution
      OR x.rake > cw.lifetime_rake_collected OR x.bbj > cw.lifetime_bbj_contribution;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'a correction would take % club accumulator(s) negative - refusing', v_bad;
  END IF;

  UPDATE public.club_wallets cw
     SET period_rake_collected     = cw.period_rake_collected     - x.rake,
         period_bbj_contribution   = cw.period_bbj_contribution   - x.bbj,
         lifetime_rake_collected   = cw.lifetime_rake_collected   - x.rake,
         lifetime_bbj_contribution = cw.lifetime_bbj_contribution - x.bbj,
         updated_at = now()
    FROM (SELECT g.club_id, sum(g.rake_amount) AS rake, sum(g.bbj) AS bbj
            FROM zz_ghosts g GROUP BY g.club_id) x
   WHERE cw.club_id = x.club_id;

  SELECT jsonb_agg(jsonb_build_object('club_id', s.club_id, 'club', c.name,
                                      'hands', s.n, 'rake', s.rake, 'bbj', s.bbj)
                   ORDER BY s.rake DESC)
    INTO v_detail
    FROM (SELECT g.club_id, count(*) AS n, round(sum(g.rake_amount),2) AS rake,
                 round(sum(g.bbj),2) AS bbj
            FROM zz_ghosts g GROUP BY g.club_id) s
    JOIN public.clubs c ON c.id = s.club_id;

  INSERT INTO public.financial_alerts (severity, source, message, context, resolved, resolved_at, resolution)
  VALUES ('warning', 'atomic_distribute_rake.double_leg_key',
          v_n || ' cash hands credited their club wallet twice between 2026-09-06 and 2026-09-07: '
            || v_rake || ' chips of rake and ' || v_bbj || ' of BBJ drop that no pot ever paid. '
            || 'The live path banked each hand with p_hand_id NULL before hand_history returned an id, '
            || 'so v_leg_key was md5(rake:table:hand); fn_redrive_unbanked_rake then banked it again '
            || 'under the hand uuid and rake_distribution_legs could not see they were the same hand.',
          jsonb_build_object('hands', v_n, 'excess_rake', v_rake, 'excess_bbj', v_bbj,
                             'by_club', v_detail,
                             'root_fix', 'the engine mints the hand uuid at settlement (20260907195116)'),
          true, now(),
          'club_wallets accumulators corrected down by exactly the excess. Ghost rake_records rows left as history '
            || '(no rake_attributions, so nothing per-player reads them). ca_club_rake_daily left to '
            || 'fn_club_rake_rollup_day - a rolled-back probe showed a direct subtraction would go negative. '
            || 'Doubled VIP points left with the players under CLAUDE.md 10.9 rule 3.');

  RAISE NOTICE 'corrected % hands, % rake, % bbj', v_n, v_rake, v_bbj;
END $$;

COMMIT;
