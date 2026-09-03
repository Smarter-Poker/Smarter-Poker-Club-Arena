-- ═══════════════════════════════════════════════════════════════════════════
--  ZERO IS NOT SUCCESS — tournament rake attribution
--  2026-08-31, spins end-to-end audit
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_settle_tournament_rake stamped attributed_at whenever attribution
-- returned ok:true — and attribution returns ok:true when it credits NOBODY.
-- fn_repair_tournament_rake_attribution selects on attributed_at IS NULL, so
-- it was structurally blind to exactly this failure: 21,562 settlements,
-- 21,080 chips of banked rake that earned no VIP credit, no agent commission
-- and no rakeback basis for anyone.
--
-- CAUSE. Until 2026-08-31 ~10:00 UTC fn_award_vip_credit dropped a credit that
-- did not round to a whole point. A Spin's rake is 8% of three buy-ins split
-- three ways — 0.08 x buy-in each — so every Spin at a buy-in of 10 or less
-- credited 0.80 or less and vanished. Buy-ins 1-10 attributed 4-9% of the
-- time; buy-ins 20-100 attributed 100%. The fractional-carry fix closed the
-- live bug; the settlements it had already swallowed stayed invisible.
--
-- HORSES (CLAUDE.md 10.5): nothing here filters on is_horse in either
-- direction. A horse generates the same rake and earns the same credit.
--
-- APPLY HISTORY. Applied to production 2026-08-31 13:50 UTC as migration
-- 20260831135007. Verified within six minutes against live traffic: every
-- settlement written after the change carries attributed_users 2-3, stamped,
-- with no attribution_error. The historical debt was drained by repeated
-- bounded calls to fn_backpay_tournament_rake_attribution.
ALTER TABLE public.tournament_rake_settlements
  ADD COLUMN IF NOT EXISTS attributed_users integer;

COMMENT ON COLUMN public.tournament_rake_settlements.attributed_users IS
  'How many players this settlement actually credited. NULL = never measured (pre-2026-08-31 rows, drained by fn_backpay_tournament_rake_attribution). 0 with members present is a FAILURE, not a completed attribution.';

CREATE INDEX IF NOT EXISTS idx_rake_settlements_unmeasured
  ON public.tournament_rake_settlements (settled_at)
  WHERE attributed_users IS NULL AND amount > 0;

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

/* OPERATOR PLUMBING, NOT PUBLIC SURFACE. This is a SECURITY DEFINER writer
   that moves VIP credit, agent commission and rakeback basis; it must never be
   reachable from a browser. Production already holds exactly this ACL - the
   REVOKE is a no-op against reality and is written down so the migration says
   so, and so check-definer-authorization can see it. PUBLIC is named as well
   as the roles: anon inherits whatever PUBLIC holds, so revoking anon alone
   reads as a fix and does nothing. */
REVOKE ALL ON FUNCTION public.fn_attribute_tournament_rake(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_attribute_tournament_rake(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_attribute_tournament_rake(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(
  p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_t record; v_union uuid; v_net numeric; v_dest text; v_res jsonb;
  v_claimed integer; v_prior record; v_att jsonb; v_att_ok boolean := false;
  v_att_err text; v_users integer; v_members integer; v_done boolean := false;
BEGIN
  SELECT t.id, t.status, t.club_id, t.name, t.current_players
    INTO v_t FROM public.tournaments t WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF upper(COALESCE(v_t.status, '')) NOT IN ('COMPLETING', 'COMPLETED', 'CANCELLED', 'CANCELED') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_terminal', 'status', v_t.status);
  END IF;

  INSERT INTO public.tournament_rake_settlements (tournament_id, club_id, amount, destination, source)
  VALUES (p_tournament_id, v_t.club_id, 0, 'pending', COALESCE(p_source, 'engine'))
  ON CONFLICT (tournament_id) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT amount, destination, settled_at INTO v_prior
      FROM public.tournament_rake_settlements WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'already_settled', true,
      'amount', v_prior.amount, 'destination', v_prior.destination,
      'settled_at', v_prior.settled_at);
  END IF;

  SELECT round(COALESCE(sum(r.rake_amount), 0), 2) INTO v_net
    FROM public.rake_records r
   WHERE r.tournament_id = p_tournament_id AND r.is_tournament;

  IF v_net <= 0 OR v_t.club_id IS NULL THEN
    UPDATE public.tournament_rake_settlements
       SET amount = GREATEST(v_net, 0),
           destination = CASE WHEN v_t.club_id IS NULL THEN 'no_club' ELSE 'none' END,
           settled_at = now(),
           attributed_at = now(),
           attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    RETURN jsonb_build_object('ok', true, 'amount', GREATEST(v_net, 0), 'destination', 'none');
  END IF;

  SELECT c.union_id INTO v_union FROM public.clubs c WHERE c.id = v_t.club_id;

  IF v_union IS NOT NULL THEN
    v_res := public.increment_union_wallet(
      v_union, v_net, v_t.club_id,
      'Tournament rake: ' || COALESCE(v_t.name, 'tournament')
        || ' (' || COALESCE(v_t.current_players, 0) || ' entries)'
        || ' [tournament ' || p_tournament_id || ']');
    IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'fn_settle_tournament_rake: union wallet credit failed for %: %',
        p_tournament_id, v_res;
    END IF;
    v_dest := 'union:' || v_union;
  ELSE
    PERFORM public.credit_club_rake_to_treasury(v_t.club_id, v_net);
    v_dest := 'club_treasury:' || v_t.club_id;
  END IF;

  UPDATE public.club_wallets
     SET period_rake_collected   = COALESCE(period_rake_collected, 0) + v_net,
         lifetime_rake_collected = COALESCE(lifetime_rake_collected, 0) + v_net,
         updated_at = now()
   WHERE club_id = v_t.club_id;

  BEGIN
    v_att := public.fn_attribute_tournament_rake(p_tournament_id);
    v_att_ok := COALESCE((v_att->>'ok')::boolean, false);
    IF NOT v_att_ok THEN
      v_att_err := COALESCE(v_att->>'reason', 'attribution returned ok=false');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_att_err := SQLERRM;
    v_att := jsonb_build_object('ok', false, 'reason', v_att_err);
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_settle_tournament_rake',
            'Rake settled but attribution failed: ' || v_att_err,
            jsonb_build_object('tournament_id', p_tournament_id, 'net', v_net));
  END;

  v_users   := COALESCE((v_att->>'attributed_users')::int, 0);
  v_members := COALESCE((v_att->>'members')::int, 0);

  /* ZERO IS NOT SUCCESS. Banked rake that credited nobody, while there were
     players to credit, is a FAILURE: it stays in the repair queue
     (attributed_at IS NULL) instead of being stamped as done. A settlement
     with no members is terminal — retrying it forever would pin the head of
     that queue, which is the failure mode the Heads-Up back-pay hit. */
  v_done := v_att_ok AND (v_users > 0 OR v_members = 0);
  IF v_att_ok AND v_users = 0 AND v_members > 0 THEN
    v_att_err := 'attributed_nobody';
  END IF;

  UPDATE public.tournament_rake_settlements
     SET amount = v_net, union_id = v_union, destination = v_dest, settled_at = now(),
         attributed_at = CASE WHEN v_done THEN now() ELSE NULL END,
         attributed_users = v_users,
         attribution_error = v_att_err
   WHERE tournament_id = p_tournament_id;

  RETURN jsonb_build_object('ok', true, 'amount', v_net, 'destination', v_dest,
                            'attributed', v_done,
                            'attributed_users', v_users, 'members', v_members);
END;
$fn$;


/* Same rule as fn_attribute_tournament_rake above: a SECURITY DEFINER writer
   on a money path is engine plumbing and must not be reachable from a browser.
   Production already holds exactly this ACL; writing it here makes the
   migration self-describing rather than dependent on what a previous one did. */
REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_repair_tournament_rake_attribution(p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row record; v_att jsonb; v_msg text;
  v_repaired integer := 0; v_failed integer := 0;
  v_before integer; v_after integer;
  v_users integer; v_members integer;
BEGIN
  SELECT count(*) INTO v_before
    FROM public.tournament_rake_settlements
   WHERE attributed_at IS NULL AND settled_at IS NOT NULL AND amount > 0;

  FOR v_row IN
    SELECT tournament_id
      FROM public.tournament_rake_settlements
     WHERE attributed_at IS NULL AND settled_at IS NOT NULL AND amount > 0
     ORDER BY settled_at ASC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    BEGIN
      v_att := public.fn_attribute_tournament_rake(v_row.tournament_id);
      v_users   := COALESCE((v_att->>'attributed_users')::int, 0);
      v_members := COALESCE((v_att->>'members')::int, 0);

      IF COALESCE((v_att->>'ok')::boolean, false) AND (v_users > 0 OR v_members = 0) THEN
        UPDATE public.tournament_rake_settlements
           SET attributed_at = now(), attribution_error = NULL, attributed_users = v_users
         WHERE tournament_id = v_row.tournament_id;
        v_repaired := v_repaired + 1;

        UPDATE public.financial_alerts
           SET resolved = true, resolved_at = now()
         WHERE source = 'fn_settle_tournament_rake'
           AND resolved IS NOT TRUE
           AND message LIKE 'Rake settled but attribution failed%'
           AND (context->>'tournament_id')::uuid = v_row.tournament_id;
      ELSE
        IF v_att->>'reason' = 'no_club' THEN
          UPDATE public.tournament_rake_settlements
             SET attributed_at = now(), attribution_error = 'no_club', attributed_users = 0
           WHERE tournament_id = v_row.tournament_id;
        ELSE
          UPDATE public.tournament_rake_settlements
             SET attribution_error = COALESCE(v_att->>'reason', 'attributed_nobody'),
                 attributed_users = v_users
           WHERE tournament_id = v_row.tournament_id;
          v_failed := v_failed + 1;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      UPDATE public.tournament_rake_settlements
         SET attribution_error = v_msg
       WHERE tournament_id = v_row.tournament_id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  SELECT count(*) INTO v_after
    FROM public.tournament_rake_settlements
   WHERE attributed_at IS NULL AND settled_at IS NOT NULL AND amount > 0;

  RETURN jsonb_build_object('ok', true, 'queue_before', v_before,
    'queue_after', v_after, 'repaired', v_repaired, 'still_failing', v_failed);
END;
$fn$;


/* Same rule as fn_attribute_tournament_rake above: a SECURITY DEFINER writer
   on a money path is engine plumbing and must not be reachable from a browser.
   Production already holds exactly this ACL; writing it here makes the
   migration self-describing rather than dependent on what a previous one did. */
REVOKE ALL ON FUNCTION public.fn_repair_tournament_rake_attribution(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_repair_tournament_rake_attribution(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_repair_tournament_rake_attribution(integer) TO service_role;

/* THE BACK-PAY. Drains attributed_users IS NULL — every row it touches gets a
   non-null value, so the queue is monotone and a re-run never revisits work.
   Replay is safe because all three credit paths are idempotent on their own
   unique keys: vip_points_ledger(user_id, source_type, source_id),
   agent_commissions(user_id, source_id, source_type) and
   rakeback_stats_applied(rake_record_id, user_id). */
CREATE OR REPLACE FUNCTION public.fn_backpay_tournament_rake_attribution(
  p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row record; v_att jsonb; v_msg text;
  v_users integer; v_members integer;
  v_paid integer := 0; v_chips numeric := 0; v_seen integer := 0;
  v_requeued integer := 0; v_errors integer := 0; v_left integer;
BEGIN
  FOR v_row IN
    SELECT tournament_id
      FROM public.tournament_rake_settlements
     WHERE attributed_users IS NULL AND amount > 0 AND settled_at IS NOT NULL
     ORDER BY settled_at ASC
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_seen := v_seen + 1;
    BEGIN
      v_att := public.fn_attribute_tournament_rake(v_row.tournament_id);
      v_users   := COALESCE((v_att->>'attributed_users')::int, 0);
      v_members := COALESCE((v_att->>'members')::int, 0);

      UPDATE public.tournament_rake_settlements
         SET attributed_users = v_users,
             attributed_at = CASE WHEN v_users = 0 AND v_members > 0
                                  THEN NULL ELSE COALESCE(attributed_at, now()) END,
             attribution_error = CASE WHEN v_users = 0 AND v_members > 0
                                      THEN 'attributed_nobody' ELSE attribution_error END
       WHERE tournament_id = v_row.tournament_id;

      IF v_users > 0 THEN
        v_paid  := v_paid + 1;
        v_chips := v_chips + COALESCE((v_att->>'attributed_chips')::numeric, 0);
      ELSIF v_members > 0 THEN
        v_requeued := v_requeued + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      /* -1 means "tried, threw": measured, so it cannot pin the queue, and
         still findable in v_tournament_rake_attribution_gaps. */
      UPDATE public.tournament_rake_settlements
         SET attributed_users = -1, attribution_error = v_msg
       WHERE tournament_id = v_row.tournament_id;
      v_errors := v_errors + 1;
    END;
  END LOOP;

  SELECT count(*) INTO v_left
    FROM public.tournament_rake_settlements
   WHERE attributed_users IS NULL AND amount > 0 AND settled_at IS NOT NULL;

  RETURN jsonb_build_object('ok', true, 'scanned', v_seen, 'paid', v_paid,
    'chips', round(v_chips, 2), 'requeued', v_requeued, 'errors', v_errors,
    'remaining', v_left);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_backpay_tournament_rake_attribution(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_backpay_tournament_rake_attribution(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_backpay_tournament_rake_attribution(integer) TO service_role;

CREATE OR REPLACE VIEW public.v_tournament_rake_attribution_gaps AS
SELECT r.tournament_id, r.club_id, r.amount, r.source, r.settled_at,
       r.attributed_at, r.attributed_users, r.attribution_error,
       t.tournament_type, t.variant, t.name, t.buy_in_amount,
       CASE WHEN r.attributed_users IS NULL THEN 'never_measured'
            WHEN r.attributed_users = -1     THEN 'attribution_threw'
            WHEN r.attributed_users = 0      THEN 'credited_nobody'
            ELSE 'ok' END AS verdict
  FROM public.tournament_rake_settlements r
  LEFT JOIN public.tournaments t ON t.id = r.tournament_id
 WHERE r.settled_at IS NOT NULL
   AND r.amount > 0
   AND (r.attributed_users IS NULL OR r.attributed_users <= 0);

REVOKE ALL ON public.v_tournament_rake_attribution_gaps FROM PUBLIC;
REVOKE ALL ON public.v_tournament_rake_attribution_gaps FROM anon, authenticated;
GRANT SELECT ON public.v_tournament_rake_attribution_gaps TO service_role;

COMMENT ON VIEW public.v_tournament_rake_attribution_gaps IS
  'Settled rake that reached nobody. Before 2026-08-31 this shape was invisible: fn_settle_tournament_rake stamped attributed_at whenever attribution returned ok, including when it credited zero players, so the repair sweep (which selects attributed_at IS NULL) could never see it.';

DO $$
DECLARE n integer;
BEGIN
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='tournament_rake_settlements'
     AND column_name='attributed_users';
  IF NOT FOUND THEN RAISE EXCEPTION 'attributed_users column missing'; END IF;

  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public' AND p.proname='fn_backpay_tournament_rake_attribution';
  IF n <> 1 THEN RAISE EXCEPTION 'fn_backpay_tournament_rake_attribution not created (found %)', n; END IF;

  PERFORM 1 FROM pg_views WHERE schemaname='public' AND viewname='v_tournament_rake_attribution_gaps';
  IF NOT FOUND THEN RAISE EXCEPTION 'gap view missing'; END IF;

  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
       WHERE ns.nspname='public' AND p.proname='fn_attribute_tournament_rake') NOT LIKE '%members%' THEN
    RAISE EXCEPTION 'fn_attribute_tournament_rake does not report members';
  END IF;

  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
       WHERE ns.nspname='public' AND p.proname='fn_settle_tournament_rake') NOT LIKE '%v_done%' THEN
    RAISE EXCEPTION 'fn_settle_tournament_rake still stamps attributed_at unconditionally';
  END IF;
END $$;
