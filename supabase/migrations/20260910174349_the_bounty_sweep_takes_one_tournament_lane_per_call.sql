-- 20260910174349_the_bounty_sweep_takes_one_tournament_lane_per_call.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE BOUNTY SWEEP TAKES ONE TOURNAMENT'S LANE PER CALL.
--
-- Follow-up to 20260910173147 (the settlement lane is per tournament for
-- rolling authorities), same programme, same day.
--
-- WHAT WAS WRONG. The engine calls fn_sweep_pending_tournament_bounties with
-- p_tournament_id NULL on every INSERT/UPDATE of a pending
-- tournament_bounty_obligations row - every bounty bust (GameServer
-- onObligationChange -> requestPendingTournamentBountyRecovery). With no
-- tournament, the lane helper takes the WHOLE lane: G exclusive, then B
-- exclusive. B exclusive waits for every in-flight hand settlement on the
-- platform and holds every new one behind it; G exclusive holds every rolling
-- authority. pg_stat_statements since 02:34 UTC: 4,555 sweep calls, mean
-- 547 ms, max 7.8 s. Observed 17:34:56-17:35:19 UTC, six minutes after the
-- rolling lane went per tournament: one NULL sweep waiting on B, sixteen hand
-- settlements queued behind it, nineteen statement timeouts in that minute.
--
-- WHAT THIS CHANGES. Called without a tournament, the sweep picks the
-- tournament of the first order-eligible due obligation (the same order its
-- candidate query always used), takes that tournament's lane (G shared, T(id)
-- exclusive) and settles that tournament's candidates only. 'pending' and
-- 'retry_after_ms' still describe the whole platform, so the engine's loop
-- (GameServer.sweepPendingTournamentBounties) calls again immediately while
-- other tournaments have due work - it already continues on processed > 0 and
-- retry_after_ms <= 25. Nothing due: no lane at all, and the same answer.
-- Called with a tournament: unchanged (that tournament's lane).
--
-- Every obligation is settled by exactly the code that settled it before; only
-- the lane and the per-call scope change. A transaction never holds two
-- tournaments' lanes, so the sweep cannot deadlock against rolling
-- authorities of other tournaments.
--
-- The precondition refuses to run unless the sweep and the lane helper are
-- byte-identical (md5 of prosrc) to the reviewed ones.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DO $sweep_pre$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = 'public.fn_sweep_pending_tournament_bounties(uuid,integer)'::regprocedure)
     IS DISTINCT FROM 'a98c1071136d10b85f34a907da702b48' THEN
    RAISE EXCEPTION 'bounty sweep migration refused: fn_sweep_pending_tournament_bounties changed since review';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = 'public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'::regprocedure)
     IS DISTINCT FROM '3acb4c1d763181905cf5b64287f8f28f' THEN
    RAISE EXCEPTION 'bounty sweep migration refused: the rolling lane changed since review';
  END IF;
END;
$sweep_pre$;

CREATE OR REPLACE FUNCTION public.fn_sweep_pending_tournament_bounties(p_tournament_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.tournament_bounty_obligations%ROWTYPE;
  candidate record;
  v_result jsonb;
  v_reserved jsonb;
  v_award_id uuid;
  v_processed integer := 0;
  v_settled integer := 0;
  v_failed integer := 0;
  v_settled_tournament_ids uuid[] := ARRAY[]::uuid[];
  v_recipients jsonb;
  v_op_hex text;
  v_op_id uuid;
  v_limit integer := GREATEST(1,LEAST(COALESCE(p_limit,20),100));
  v_scope uuid := p_tournament_id;
BEGIN
  -- ONE TOURNAMENT'S LANE PER CALL (2026-09-10). Called without a tournament
  -- (the engine does that on every pending-obligation notification, i.e. on
  -- every bounty bust) this used to take the WHOLE lane - G and B exclusive -
  -- which held every hand settlement and every rolling authority on the
  -- platform for the length of the sweep. It now settles the tournament of
  -- the first order-eligible due obligation under that tournament's lane (G
  -- shared, T(id) exclusive) and nothing else. 'pending' and 'retry_after_ms'
  -- below still describe the whole platform, so the engine calls again at
  -- once while other tournaments have due work. One tournament per call also
  -- means a transaction never holds two tournaments' lanes.
  IF v_scope IS NULL THEN
    SELECT bo.tournament_id INTO v_scope
      FROM public.tournament_bounty_obligations bo
     WHERE bo.state = 'pending'
       AND bo.next_attempt_at <= now()
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations prior
          WHERE prior.tournament_id=bo.tournament_id AND prior.state='pending'
            AND prior.mode='pko'
            AND (prior.hand_number < bo.hand_number
                 OR (prior.hand_number=bo.hand_number
                     AND prior.eliminated_user_id::text < bo.eliminated_user_id::text))
       )
     ORDER BY bo.next_attempt_at, bo.tournament_id, bo.hand_number,
              bo.eliminated_user_id
     LIMIT 1;
  END IF;
  IF v_scope IS NOT NULL THEN
    PERFORM public.fn_ca_lock_settlement_lane_for_tournament(v_scope);
  END IF;
  FOR candidate IN
    SELECT bo.id, bo.tournament_id FROM public.tournament_bounty_obligations bo
     WHERE bo.state = 'pending'
       AND bo.next_attempt_at <= now()
       AND bo.tournament_id = v_scope
       AND NOT EXISTS (
         SELECT 1 FROM public.tournament_bounty_obligations prior
          WHERE prior.tournament_id=bo.tournament_id AND prior.state='pending'
            AND prior.mode='pko'
            AND (prior.hand_number < bo.hand_number
                 OR (prior.hand_number=bo.hand_number
                     AND prior.eliminated_user_id::text < bo.eliminated_user_id::text))
       )
     ORDER BY bo.next_attempt_at, bo.tournament_id, bo.hand_number,
              bo.eliminated_user_id
     LIMIT v_limit
  LOOP
    BEGIN
      -- One lock order everywhere: tournament then obligation. Direct manager
      -- collection also locks tournament before its ledger trigger touches the
      -- outbox, so the global lane cannot deadlock it outbox->tournament.
      PERFORM 1 FROM public.tournaments t WHERE t.id=candidate.tournament_id FOR UPDATE;
      SELECT * INTO o FROM public.tournament_bounty_obligations bo
       WHERE bo.id=candidate.id AND bo.state='pending' AND bo.next_attempt_at<=now()
       FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN CONTINUE; END IF;
      -- The candidate query ran before these locks. Re-prove ordering after the
      -- tournament and exact obligation are locked so a predecessor committed
      -- in that window cannot be skipped.
      IF o.mode='pko' AND EXISTS (
        SELECT 1 FROM public.tournament_bounty_obligations prior
         WHERE prior.tournament_id=o.tournament_id AND prior.mode='pko'
           AND prior.state='pending'
           AND (prior.hand_number<o.hand_number
                OR (prior.hand_number=o.hand_number
                    AND prior.eliminated_user_id::text<o.eliminated_user_id::text))
      ) THEN
        CONTINUE;
      END IF;
      v_processed := v_processed + 1;

      -- Response-loss reconciliation before another call.
      IF o.mode <> 'mystery_chest'
         AND public.fn_bounty_obligation_has_complete_marker(o.id) THEN
        UPDATE public.tournament_bounty_obligations SET state='settled', settled_at=now(), last_error=NULL
         WHERE id=o.id;
        v_settled := v_settled + 1;
        IF NOT o.tournament_id=ANY(v_settled_tournament_ids) THEN
          v_settled_tournament_ids := array_append(v_settled_tournament_ids,o.tournament_id);
        END IF;
        CONTINUE;
      ELSIF o.mode = 'mystery_chest'
         AND public.fn_bounty_obligation_has_complete_marker(o.id) THEN
        UPDATE public.tournament_bounty_obligations SET state='settled', settled_at=now(), last_error=NULL
         WHERE id=o.id;
        v_settled := v_settled + 1;
        IF NOT o.tournament_id=ANY(v_settled_tournament_ids) THEN
          v_settled_tournament_ids := array_append(v_settled_tournament_ids,o.tournament_id);
        END IF;
        CONTINUE;
      END IF;

      IF o.mode = 'mystery_chest' THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'user_id', x.user_id, 'weight', x.weight,
          'is_designated_revealer', x.user_id = o.knocker_user_id
        )), '[]'::jsonb)
        INTO v_recipients
        FROM (
          SELECT (e->>'user_id')::uuid AS user_id,
                 GREATEST(COALESCE((e->>'weight')::numeric, 0), 0) AS weight
            FROM jsonb_array_elements(o.claimants) e
           WHERE NULLIF(e->>'user_id','') IS NOT NULL
        ) x;
        v_op_hex := md5('mb:' || o.id::text);
        v_op_id := (substr(v_op_hex,1,8)||'-'||substr(v_op_hex,9,4)||'-4'||substr(v_op_hex,14,3)
          ||'-8'||substr(v_op_hex,18,3)||'-'||substr(v_op_hex,21,12))::uuid;
        v_reserved := public.fn_mystery_bounty_reserve(
          o.tournament_id, o.eliminated_user_id, v_recipients, o.table_id,
          o.hand_id::text, v_op_id, 1);
        IF NOT COALESCE((v_reserved->>'ok')::boolean, false) THEN
          RAISE EXCEPTION 'reserve refused: %', COALESCE(v_reserved->>'reason','unknown');
        END IF;
        v_award_id := (v_reserved->>'award_id')::uuid;
        IF COALESCE(v_reserved->>'status','') <> 'completed' THEN
          v_result := public.fn_mystery_bounty_reveal(v_award_id, NULL, true);
          IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
            RAISE EXCEPTION 'reveal refused';
          END IF;
          v_result := public.fn_mystery_bounty_pay(v_award_id);
          IF NOT COALESCE((v_result->>'ok')::boolean, false)
             OR COALESCE((v_result->>'refused_recipients')::integer,0) > 0 THEN
            RAISE EXCEPTION 'pay refused or incomplete';
          END IF;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.tournament_bounty_awards a
                        WHERE a.bounty_obligation_id=o.id AND a.status='completed') THEN
          RAISE EXCEPTION 'mystery payout has no completed award marker';
        END IF;
      ELSE
        v_result := public.fn_collect_bounty_obligation(o.id);
        IF NOT COALESCE((v_result->>'ok')::boolean, false)
           AND COALESCE(v_result->>'reason','') <> 'already_collected' THEN
          RAISE EXCEPTION 'collect refused: %', COALESCE(v_result->>'reason','unknown');
        END IF;
        IF NOT public.fn_bounty_obligation_has_complete_marker(o.id) THEN
          RAISE EXCEPTION 'fixed/PKO payout markers do not conserve the full generation head';
        END IF;
      END IF;

      -- Triggers settle only after every canonical claimant (or the completed
      -- award) is durable. Never infer success from an RPC transport response.
      IF NOT EXISTS (SELECT 1 FROM public.tournament_bounty_obligations x
                      WHERE x.id=o.id AND x.state='settled') THEN
        RAISE EXCEPTION 'payout marker did not acknowledge obligation';
      END IF;
      UPDATE public.tournament_bounty_obligations
         SET last_error=NULL, attempt_count=attempt_count+1
       WHERE id=o.id;
      v_settled := v_settled + 1;
      IF NOT o.tournament_id=ANY(v_settled_tournament_ids) THEN
        v_settled_tournament_ids := array_append(v_settled_tournament_ids,o.tournament_id);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.tournament_bounty_obligations
       SET attempt_count=attempt_count+1, last_error=left(SQLERRM,1000),
             next_attempt_at=clock_timestamp()
               + make_interval(secs => LEAST(60, 5 * (attempt_count + 1)))
       WHERE id=candidate.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'processed', v_processed,
    'settled', v_settled, 'failed', v_failed,
    'settled_tournament_ids',to_jsonb(v_settled_tournament_ids),
    'pending', (SELECT count(*) FROM public.tournament_bounty_obligations
      WHERE state='pending' AND (p_tournament_id IS NULL OR tournament_id=p_tournament_id)),
    -- Return a DATABASE-CLOCK RELATIVE delay for the first order-eligible
    -- head. A later PKO row can have due=now while an earlier generation is
    -- backed off; using the raw minimum would spin the engine until the head
    -- became due. A host timestamp would repeat that bug under clock skew.
    'retry_after_ms',(
      SELECT CASE WHEN due_at IS NULL THEN NULL ELSE
        GREATEST(0,ceil(extract(epoch FROM (due_at-clock_timestamp()))*1000)::bigint)
      END
      FROM (
        SELECT min(bo.next_attempt_at) AS due_at
          FROM public.tournament_bounty_obligations bo
         WHERE bo.state='pending'
           AND (p_tournament_id IS NULL OR bo.tournament_id=p_tournament_id)
           AND NOT EXISTS (
             SELECT 1 FROM public.tournament_bounty_obligations prior
              WHERE prior.tournament_id=bo.tournament_id AND prior.state='pending'
                AND prior.mode='pko'
                AND (prior.hand_number<bo.hand_number
                     OR (prior.hand_number=bo.hand_number
                         AND prior.eliminated_user_id::text<bo.eliminated_user_id::text))
           )
      ) eligible_head
    ));
END;
$function$;

-- Unchanged grants, stated so the migration says them: the engine's service
-- identity and the owner, never a browser.
REVOKE ALL ON FUNCTION public.fn_sweep_pending_tournament_bounties(uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_pending_tournament_bounties(uuid,integer) TO service_role;

DO $sweep_post$
DECLARE
  v_src text := (SELECT p.prosrc FROM pg_catalog.pg_proc p
                  WHERE p.oid = 'public.fn_sweep_pending_tournament_bounties(uuid,integer)'::regprocedure);
BEGIN
  IF strpos(v_src, 'fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)') > 0
     OR strpos(v_src, 'fn_ca_lock_settlement_lane_for_tournament(v_scope)') = 0
     OR strpos(v_src, 'AND bo.tournament_id = v_scope') = 0 THEN
    RAISE EXCEPTION 'bounty sweep migration: the sweep is not scoped to one tournament lane';
  END IF;
END;
$sweep_post$;

COMMIT;
