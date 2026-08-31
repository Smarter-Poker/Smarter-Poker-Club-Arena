-- ═══════════════════════════════════════════════════════════════════════════
--  ATTRIBUTION TAKES ITS LOCKS IN A FIXED ORDER
--  2026-08-31, spins audit part 3
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_attribute_tournament_rake` loops over the players who generated a
-- tournament's rake and, for each one, writes three rows keyed on that USER:
-- vip_points_carry, agent_commissions and player_stats. Two settlements that
-- share a player therefore contend for the same rows — and the loop's driving
-- query had no ORDER BY, so each one took its locks in whatever order the
-- hash aggregate happened to produce.
--
-- Two transactions acquiring the same locks in different orders is the
-- textbook deadlock, and it is exactly what production shows: `deadlock
-- detected` is the ONLY attribution error recorded in the last 24 hours, and
-- 18 of them fired in one afternoon when the back-pay was replaying history
-- alongside live traffic. The platform is horse-heavy and a horse plays many
-- tournaments, so overlapping player sets are the normal case rather than the
-- unlucky one.
--
-- `ORDER BY x.uid` is the whole fix. Every caller now walks the same users in
-- the same order, so concurrent settlements queue behind one another instead
-- of grabbing each other's rows. It changes nothing about WHAT is credited —
-- the loop body, the amounts and the idempotency keys are untouched.
--
-- Deadlocks were never a money loss: the settle path leaves the row unstamped
-- and the 15-minute repair drains it (as it did for the one recorded today,
-- 23.00 chips on Afternoon Bounty). This removes the failure rather than
-- relying on the recovery, and it is what makes a large replay safe to run at
-- volume — which matters now that fn_backpay_tournament_rake_attribution
-- exists to do exactly that.
--
-- APPLIED to production 2026-08-31 as migration 20260831154912, and probed
-- afterwards inside a rolled-back transaction (CLAUDE.md 11.5): 3 members,
-- 3 users, 4.80 chips, unchanged behaviour.
CREATE OR REPLACE FUNCTION public.fn_attribute_tournament_rake(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_club uuid; v_att record; v_users integer := 0; v_chips numeric := 0;
  v_members integer := 0;
BEGIN
  SELECT t.club_id INTO v_club FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_club IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_club');
  END IF;

  /* The denominator the userless spread divides by, surfaced so a caller can
     tell "credited nobody" from "there was nobody to credit". Without it a
     settlement that FAILED and one that had nothing to do look identical, and
     the repair queue cannot decide whether retrying is worth anything. */
  SELECT count(*) INTO v_members
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id AND tp.user_id IS NOT NULL;

  FOR v_att IN
    WITH per_user AS (
      SELECT (r.metadata->>'user_id')::uuid AS uid,
             sum(r.rake_amount) AS amt, min(r.id::text)::uuid AS row_id
        FROM public.rake_records r
       WHERE r.tournament_id = p_tournament_id AND r.is_tournament
         AND r.metadata->>'user_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       GROUP BY 1
    ),
    userless AS (
      SELECT sum(r.rake_amount) AS amt, min(r.id::text)::uuid AS row_id
        FROM public.rake_records r
       WHERE r.tournament_id = p_tournament_id AND r.is_tournament
         AND (r.metadata->>'user_id') IS NULL
      HAVING sum(r.rake_amount) > 0
    ),
    members AS (
      SELECT tp.user_id FROM public.tournament_players tp
       WHERE tp.tournament_id = p_tournament_id AND tp.user_id IS NOT NULL
    ),
    spread AS (
      SELECT m.user_id AS uid,
             round(u.amt / NULLIF((SELECT count(*) FROM members), 0), 2) AS amt,
             u.row_id
        FROM userless u CROSS JOIN members m
    )
    SELECT x.uid, round(sum(x.amt), 2) AS amt, min(x.row_id::text)::uuid AS row_id
      FROM (SELECT * FROM per_user UNION ALL SELECT * FROM spread) x
     WHERE x.uid IS NOT NULL
     GROUP BY x.uid
    HAVING round(sum(x.amt), 2) > 0
     /* FIXED LOCK ORDER. Every row written in this loop is keyed on the user,
        so two settlements that share a player contend. Walking them in a
        deterministic order turns a deadlock into a wait. Do not remove. */
     ORDER BY x.uid
  LOOP
    v_users := v_users + 1;
    v_chips := v_chips + v_att.amt;

    PERFORM public.fn_award_vip_credit(
      v_att.uid, v_att.amt, 'tournament_rake', p_tournament_id, 'Tournament rake generated');

    PERFORM public.credit_agent_commission_from_rake(
      v_att.uid, v_club, v_att.amt,
      'tournament_rake_settlement',
      md5('trs:' || p_tournament_id::text || ':' || v_att.uid::text)::uuid,
      'tournament rake settlement');

    PERFORM public.apply_rakeback_player_stats(
      v_att.row_id, v_att.uid, v_club, 0, v_att.amt);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'attributed_users', v_users,
                            'members', v_members,
                            'attributed_chips', round(v_chips, 2));
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_attribute_tournament_rake(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_attribute_tournament_rake(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_attribute_tournament_rake(uuid) TO service_role;

DO $$
BEGIN
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_attribute_tournament_rake')
     NOT LIKE '%ORDER BY x.uid%' THEN
    RAISE EXCEPTION 'the fixed lock order was not applied';
  END IF;
  -- The contract the settle path and both sweeps read must survive.
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_attribute_tournament_rake')
     NOT LIKE '%''members'', v_members%' THEN
    RAISE EXCEPTION 'members is no longer reported';
  END IF;
END $$;
