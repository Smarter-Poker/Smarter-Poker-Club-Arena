-- 20261003201157_a_finish_waits_for_a_commission_key_holding_nothing
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 20:11:57 UTC.
--
-- WHAT WAS WRONG (measured on production, 2026-10-03)
--
-- A tournament finish waits for the club commission key
-- ('agent-commission:<club>') inside fn_recognize_accounting_tournament_fees,
-- at the rollup trigger of its first commission row, whenever a cash
-- commission batch (fn_credit_agent_commissions_batch) holds that key. By then
-- the finish already holds everything it will ever hold: the bank scope
-- finish lane, T(id), the club wallet and club rows, every player and payout
-- row, and - for a union event - the union's one union_wallets row, which
-- increment_union_wallet took a few statements earlier in
-- fn_settle_tournament_rake. Every raked hand of that union then queues on
-- the union row behind a finish that is itself only waiting for a cash batch.
--   Finish waits on the commission key (postgres log, "acquired ... after"):
--   18:05-18:35 UTC 28 waits / 42 s; 19:00-20:10 UTC 123 waits.
--   union_wallets statement timeouts (hands): 19:20-19:40 UTC 166.
--   Lock samples (hand-timeout agent, union_wallets.xmax every 0.2 s): a
--   finish holds the union row 1-6 s with 2-3 of the union's hands behind it.
--
-- The credit cannot move to the end of the transaction: recognition needs the
-- union_wallet_transactions id the credit writes (bank proof), and every rake
-- evidence row is refused once the tournament is COMPLETED
-- (fn_terminal_tournament_evidence_is_immutable), so the credit and
-- recognition must both precede the lifecycle update, exactly as now.
--
-- WHAT CHANGES. fn_ca_await_commission_keys_free(tournament) waits, holding
-- nothing, until no other transaction holds the commission key of any club
-- this event's fee sources pay commission in: a session-level SHARED advisory
-- lock is granted only when no exclusive holder (a batch, a rollup trigger, a
-- retry sweep) remains, and is released by the very next statement. It is
-- called twice:
--   1. by fn_complete_tournament_terminal before it asks for the finish lane,
--      so a busy key is waited for while the finish holds no lane, no bank
--      scope and no row, and
--   2. by fn_settle_tournament_rake immediately before increment_union_wallet,
--      so a batch that took the key in between is waited for before the union
--      row is taken, not after.
-- The commission keys are still TAKEN exactly where they were (the rollup
-- trigger, in club order) and still held to commit; nothing new is held. The
-- waits are a subset of the waits a finish already makes, taken while holding
-- a subset of what it already holds there, so no new lock cycle can form. A
-- lock_timeout or deadlock refusal of the wait itself is not an error: the key
-- is then taken where it always was. A cancellation releases the session lock
-- before it propagates, so a pooled connection can never keep it.
--
-- NOT CHANGED: what is credited, when, by whom; recognition, its bank proof
-- and retry loop; every escrow, conservation, settlement, receipt and F06
-- check; the cash batch; grants of existing functions. The engine is
-- unchanged.
--
-- @live-proof: (SELECT bool_and(x) FROM (VALUES ((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_ca_await_commission_keys_free(uuid)')) = '{postgres=X/postgres}'), (strpos(pg_get_functiondef('public.fn_settle_tournament_rake(uuid,text)'::regprocedure), 'PERFORM public.fn_ca_await_commission_keys_free(p_tournament_id);') > 0), (strpos(pg_get_functiondef('public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure), 'PERFORM public.fn_ca_await_commission_keys_free(p_tournament_id);') > 0)) v(x))

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION public.fn_ca_await_commission_keys_free(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club uuid;
  v_key bigint;
  v_waited integer := 0;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN 0;
  END IF;
  -- The clubs the rollup trigger will key on: every source's contract club
  -- with a positive tier, the predicate fn_post_accounting_commission_source
  -- and the owner path of fn_recognize_accounting_tournament_fees write by.
  -- A superset (a refunded source) only waits for a key no one holds long.
  FOR v_club IN
    SELECT DISTINCT (s.contract->>'club_id')::uuid
      FROM public.accounting_tournament_fee_sources s
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(s.contract->'tiers') = 'array'
             THEN s.contract->'tiers' ELSE '[]'::jsonb END) tier(value)
     WHERE s.tournament_id = p_tournament_id
       AND s.contract->>'club_id' ~ '^[0-9a-fA-F-]{36}$'
       AND CASE WHEN tier.value->>'amount' ~ '^[0-9]+(\.[0-9]+)?$'
                THEN (tier.value->>'amount')::numeric ELSE 0 END > 0
     ORDER BY 1
  LOOP
    v_key := hashtextextended('agent-commission:' || v_club::text, 0);
    BEGIN
      -- Granted only when no exclusive holder remains; released at once.
      IF NOT pg_try_advisory_lock_shared(v_key) THEN
        PERFORM pg_advisory_lock_shared(v_key);
        v_waited := v_waited + 1;
      END IF;
      PERFORM pg_advisory_unlock_shared(v_key);
    EXCEPTION
      WHEN lock_not_available OR deadlock_detected THEN
        -- Not granted: the key is taken where it always was, later.
        NULL;
      WHEN query_canceled THEN
        -- Never leave a session lock on a pooled connection.
        PERFORM pg_advisory_unlock_shared(v_key);
        RAISE;
    END;
  END LOOP;
  RETURN v_waited;
END;
$function$;

-- Executable by its owner only: both callers are SECURITY DEFINER functions
-- owned by postgres.
REVOKE ALL ON FUNCTION public.fn_ca_await_commission_keys_free(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
  -- the finish wrapper: wait before the finish lane
  s := 'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;
  d := pg_get_functiondef(s);
  IF md5(d) <> 'c64e049911fd99c1d784cdb042ca714b' THEN
    RAISE EXCEPTION 'finish wrapper preimage %', md5(d);
  END IF;
  a := E'  PERFORM public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id);\n';
  r := E'  -- A busy commission key is waited for here, holding nothing (2026-10-03).\n'
    || E'  PERFORM public.fn_ca_await_commission_keys_free(p_tournament_id);\n'
    || E'  PERFORM public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id);\n';
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION 'finish wrapper anchor count';
  END IF;
  d := replace(d, a, r);
  EXECUTE d;
  IF pg_get_functiondef(s) <> d THEN
    RAISE EXCEPTION 'finish wrapper postimage differs from the substituted text';
  END IF;

  -- the rake settle: wait again before the union row is taken
  s := 'public.fn_settle_tournament_rake(uuid,text)'::regprocedure;
  d := pg_get_functiondef(s);
  IF md5(d) <> '15acb041213e75e30cefdff37e04179b' THEN
    RAISE EXCEPTION 'rake settle preimage %', md5(d);
  END IF;
  a := E'  IF v_union IS NOT NULL THEN\n'
    || E'   v_res:=public.increment_union_wallet(v_union,v_net,v_t.club_id,\n';
  r := E'  IF v_union IS NOT NULL THEN\n'
    || E'   -- THE UNION ROW IS NOT HELD THROUGH A WAIT FOR A CASH BATCH (2026-10-03):\n'
    || E'   -- recognition below takes the commission keys; wait for them first,\n'
    || E'   -- holding nothing new, so the union row is taken last.\n'
    || E'   PERFORM public.fn_ca_await_commission_keys_free(p_tournament_id);\n'
    || E'   v_res:=public.increment_union_wallet(v_union,v_net,v_t.club_id,\n';
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION 'rake settle anchor count';
  END IF;
  d := replace(d, a, r);
  EXECUTE d;
  IF pg_get_functiondef(s) <> d THEN
    RAISE EXCEPTION 'rake settle postimage differs from the substituted text';
  END IF;
END
$mig$;

-- The lane doctrine and the accounting week lock mode are unchanged.
DO $post$
DECLARE v jsonb := public.fn_ca_settlement_lane_doctrine();
BEGIN
  IF COALESCE((v->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'settlement lane doctrine refused: %', v->'violations' USING ERRCODE = '55000';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p
       WHERE p.oid = 'public.fn_ca_await_commission_keys_free(uuid)'::regprocedure)
     IS DISTINCT FROM '{postgres=X/postgres}' THEN
    RAISE EXCEPTION 'commission key wait is executable beyond its owner' USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
