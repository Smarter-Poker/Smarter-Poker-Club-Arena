DO $mig$
DECLARE
  c_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
  c_from  constant timestamptz := '2026-08-10 00:00:00+00';
  c_to    constant timestamptz := '2026-08-17 00:00:00+00';
  v_owed numeric; v_pairs int; v_res jsonb; v_row record; v_n int; i int;
  v_jaqk_before numeric; v_shark_before numeric;
  v_jaqk_after numeric; v_shark_after numeric;
BEGIN
  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '240s';
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  /* =================================================================== */
  /* THE AGENTS OF THE WEEK OF 10 AUGUST ARE PAID.                       */
  /*                                                                     */
  /* Two settlement periods have sat at "processing" since 2026-08-20:    */
  /* Club JAQK and SHARK CLUB, week 2026-08-10 to 08-17. The cascade      */
  /* stopped halfway through them and nothing has moved since.            */
  /*                                                                     */
  /* What actually happened to that week:                                 */
  /*   Round 1  union -> clubs      PAID  162,644.52 on 2026-08-20 17:10  */
  /*   Round 2  clubs -> agents     NEVER RAN                             */
  /*   Round 3  agents -> players   PAID   48,349.04, every period 'paid' */
  /*                                                                     */
  /* The clubs were paid their rakeback, the agents paid their players    */
  /* out of their own balances, and the agents were never paid the        */
  /* commission that funds it. 28 club-agent pairs, 27 people:            */
  /*   Club JAQK    10 pairs   11,471.83   over 24,029 commission rows    */
  /*   SHARK CLUB   18 pairs    8,905.66   over 20,315 commission rows    */
  /*   total                   20,377.49                                  */
  /* against treasuries of 948,969.06 and 894,721.67. They can pay.       */
  /*                                                                     */
  /* This week is NOT one the settlement floor quarantines. The floor     */
  /* (Dan, 2026-09-02) names the weeks of 08-17, 08-24 and 08-31, which   */
  /* would pay union-to-club rakeback on the broken attribution. This is  */
  /* the week before them, its Round 1 was paid before the floor existed, */
  /* and Round 2 does not touch union attribution at all: an              */
  /* agent_commissions row is stamped with the club the hand was played   */
  /* at, by the rake path, at the moment the hand ended.                  */
  /*                                                                     */
  /* The first attempt at this deadlocked against a live rake             */
  /* distribution holding the same club row - the same 40P01 the weekly   */
  /* cascade has been failing on. A deadlock is the database choosing a   */
  /* victim, not a refusal, so it is retried; the whole payment is one    */
  /* transaction either way.                                              */
  /* =================================================================== */

  SELECT count(*), round(sum(owed), 2) INTO v_pairs, v_owed FROM (
    SELECT ac.club_id, ac.user_id, sum(ac.amount) AS owed
      FROM agent_commissions ac
      JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = c_union
      JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status = 'active'
     WHERE ac.created_at >= c_from AND ac.created_at < c_to
       AND ac.settled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
     GROUP BY 1, 2 HAVING sum(ac.amount) > 0
  ) x;
  IF round(COALESCE(v_owed, 0), 2) <> 20377.49 THEN
    RAISE EXCEPTION 'the owed figure moved since it was read: expected 20377.49, found %', v_owed;
  END IF;
  IF v_pairs <> 28 THEN RAISE EXCEPTION 'expected 28 club-agent pairs, found %', v_pairs; END IF;

  SELECT chip_treasury INTO v_jaqk_before FROM clubs WHERE id = 'a0000000-0000-0000-0000-000000000001';
  SELECT chip_treasury INTO v_shark_before FROM clubs WHERE id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  IF v_jaqk_before < 11471.83 OR v_shark_before < 8905.66 THEN
    RAISE EXCEPTION 'a club cannot cover its agents: JAQK % SHARK %', v_jaqk_before, v_shark_before;
  END IF;

  v_res := NULL;
  FOR i IN 1..6 LOOP
    BEGIN
      v_res := public.fn_settle_round2_club_to_agents(c_union, c_from, c_to);
      EXIT;
    EXCEPTION WHEN deadlock_detected OR lock_not_available THEN
      v_res := NULL;
      PERFORM pg_sleep(2 * i);
    END;
  END LOOP;
  IF v_res IS NULL THEN RAISE EXCEPTION 'round 2 could not get the treasury lock in six tries'; END IF;
  RAISE NOTICE 'round 2: %', v_res;

  IF COALESCE((v_res->>'payees')::int, 0) <> 28 THEN
    RAISE EXCEPTION 'round 2 paid % pair(s), expected 28: %', v_res->>'payees', v_res;
  END IF;
  IF round(COALESCE((v_res->>'amount')::numeric, 0), 2) <> 20377.49 THEN
    RAISE EXCEPTION 'round 2 moved %, expected 20377.49', v_res->>'amount';
  END IF;
  IF COALESCE((v_res->>'shortfalls')::int, 0) <> 0 THEN
    RAISE EXCEPTION 'round 2 reported % shortfall(s): %', v_res->>'shortfalls', v_res->'detail';
  END IF;

  SELECT count(*), round(sum(amount), 2) INTO v_n, v_owed
    FROM public.chip_ledger
   WHERE category = 'commission' AND from_type = 'club_treasury'
     AND idempotency_key LIKE 'round2:' || c_union::text || ':2026-08-10:%';
  IF v_n <> 28 OR v_owed <> 20377.49 THEN
    RAISE EXCEPTION 'the journal shows % leg(s) for %, expected 28 for 20377.49', v_n, v_owed;
  END IF;

  /* =================================================================== */
  /* A PERIOD THAT WILL NEVER BE SETTLED GETS A DOOR OF ITS OWN.         */
  /*                                                                     */
  /* fn_set_settlement_period_status refuses 'closed' on purpose, and     */
  /* fn_close_due_settlement_periods only closes what is already          */
  /* 'settled'. So a period the platform has decided will never be        */
  /* settled has no way out at all, and the one precedent on file was a   */
  /* hand-written UPDATE whose only trace is a sentence in a notes        */
  /* column. This is that door: service-only, and it refuses to open      */
  /* without a real reason, which it keeps.                               */
  /* =================================================================== */
  CREATE OR REPLACE FUNCTION public.fn_union_close_unsettleable_period(p_period_id uuid, p_reason text)
   RETURNS jsonb
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path TO 'public'
  AS $function$
  DECLARE v public.settlement_periods%ROWTYPE;
  BEGIN
    IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
      RAISE EXCEPTION 'fn_union_close_unsettleable_period is service only' USING ERRCODE = '42501';
    END IF;
    IF COALESCE(btrim(p_reason), '') = '' OR length(p_reason) < 60 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'a_period_closed_without_settling_needs_a_real_reason');
    END IF;
    SELECT * INTO v FROM public.settlement_periods WHERE id = p_period_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'period_not_found'); END IF;
    IF v.status NOT IN ('open', 'processing') THEN
      RETURN jsonb_build_object('ok', true, 'already', v.status, 'changed', false);
    END IF;
    UPDATE public.settlement_periods
       SET status = 'closed',
           notes = COALESCE(notes || E'\n', '') || p_reason,
           updated_at = now()
     WHERE id = p_period_id;
    RETURN jsonb_build_object('ok', true, 'closed', p_period_id, 'was', v.status, 'changed', true);
  END $function$;
  REVOKE ALL ON FUNCTION public.fn_union_close_unsettleable_period(uuid, text) FROM PUBLIC;

  FOR v_row IN
    SELECT id, club_id FROM public.settlement_periods
     WHERE status IN ('open', 'processing')
       AND start_at = c_from AND end_at = c_to
       AND club_id IN ('a0000000-0000-0000-0000-000000000001', 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4')
  LOOP
    v_res := public.fn_union_close_unsettleable_period(v_row.id,
      'Closed 2026-09-09. Round 1 (union to clubs) paid 162,644.52 on 2026-08-20 17:10. Round 3 (agents to players) paid 48,349.04, every period marked paid. Round 2 (clubs to agents) never ran and was settled today for 20,377.49 across 28 club-agent pairs - Club JAQK 11,471.83, SHARK CLUB 8,905.66 - by fn_settle_round2_club_to_agents, with both journal legs. Round 4 (invoices) is off for this union by setting. Nothing further is owed for this week and the cascade can never reach it: the stored UTC-midnight boundary does not match fn_union_week_start, and union_settlement_floor starts at 2026-09-07. Left unsettled rather than marked settled, because the cascade conservation assertion never ran over it.');
    IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'could not close period %: %', v_row.id, v_res;
    END IF;
  END LOOP;

  FOR v_row IN
    SELECT id FROM public.settlement_periods
     WHERE status IN ('open', 'processing') AND club_id IS NULL AND union_id = c_union
  LOOP
    v_res := public.fn_union_close_unsettleable_period(v_row.id,
      'Closed 2026-09-09. This period was minted by the zero-argument get_current_settlement_period fallback, which computes a Sunday-to-Sunday week while the union settles on the fn_union_week_start Monday-midnight-Pacific boundary. It carries no club, zero totals, and no rakeback, commission, invoice or journal row references it or its date range. It is a period no settlement function can recognise, and closing it strands nothing.');
    IF COALESCE((v_res->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'could not close the union-level period %: %', v_row.id, v_res;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_n FROM public.settlement_periods
   WHERE status IN ('open', 'processing') AND end_at < now() - interval '24 hours';
  IF v_n <> 0 THEN RAISE EXCEPTION '% period(s) are still open past their end', v_n; END IF;
END
$mig$;
