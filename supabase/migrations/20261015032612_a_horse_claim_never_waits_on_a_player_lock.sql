-- 20261015032612_a_horse_claim_never_waits_on_a_player_lock
--
-- Reserved by scripts/new-migration.mjs on 2026-10-15 03:26:12 UTC.
--
-- A HORSE CLAIM NEVER WAITS ON A PLAYER LOCK (2026-10-15)
--
-- DatabaseDeadlocksElevated fired on 2026-10-15 at 00:13 UTC. postgres_logs
-- 00:03 to 00:15: 14 of the 16 deadlock reports name the pg_cron run
-- `SELECT public.fn_ca_horse_claim_due(500)`, waiting on a profiles row inside
-- claim_daily_challenge_serialized_body (UPDATE profiles SET diamonds),
-- fn_lock_daily_mission_user (its daily-missions advisory lock, then the row
-- FOR NO KEY UPDATE) or add_diamonds_to_balance (the row FOR UPDATE). The
-- other side of every cycle is the engine's PostgREST call
-- fn_credit_agent_commissions_batch -> fn_process_cash_accounting_source ->
-- apply_rakeback_player_stats, whose trigger fn_sync_profile_total_hands
-- updates profiles.total_hands_played for every player of a hand, in hand
-- order. Horses are players (CLAUDE.md 10.5), so both write the same rows.
--
-- THE CAUSE. fn_ca_horse_claim_due is one transaction: it claims up to 500
-- rows for up to 45 seconds, and every horse it has paid keeps its advisory
-- lock and its profiles row locked until the run ends. It then took the NEXT
-- horse's locks by WAITING. A run holding horse A and waiting for horse B met
-- a hand holding B and waiting for A. Postgres cancelled one side: either a
-- commission batch (the engine's accounting for a hand) or the claim's
-- subtransaction, which the EXCEPTION block filed as CH3:horse_claim_failed
-- and deferred ten minutes - while the run kept every lock it already held
-- and went on to the next horse, so the cycles repeated across the minute.
-- The challenge rows themselves were already safe (2026-09-24: primary key
-- order, SKIP LOCKED); the player locks behind them were not.
--
-- THE FIX, in that loop and nowhere else. Before a claim, the run takes the
-- horse's two player locks WITHOUT WAITING, in the order
-- fn_lock_daily_mission_user takes them: pg_try_advisory_xact_lock on the
-- daily-missions key, then the profiles row FOR UPDATE SKIP LOCKED. FOR
-- UPDATE is the strongest mode any step of the claim takes, so nothing inside
-- it has to upgrade and wait behind another writer's KEY SHARE. If either is
-- held by somebody else at that instant, the row is left exactly as it is:
-- not claimed, not deferred, not counted, and still the oldest thing owed a
-- minute later. A run that never waits on a player lock cannot be one side of
-- a cycle through one.
--
-- MONEY (10.9, 11.5). What each claim pays is unchanged: the same rows, the
-- same claim_daily_challenge_serialized_body, the same references, the same
-- refusal and deferral handling. The change only decides WHEN a row is
-- attempted. A row is paid at most once because the claim body still locks
-- it and refuses an already-claimed row, and no row is dropped because a
-- skipped row stays completed, unclaimed and undeferred, so the next run
-- chooses it again. Nothing here writes a wallet, a journal row or a
-- challenge row of its own.
--
-- HOW: the pinned-preimage exact-substitution pattern of 20261007212545. The
-- live text must hash to today's measured md5 (57b62c37..., read 2026-10-15),
-- the one anchor must occur exactly once (measured read-only on production:
-- 1), and the result must hash to the derived postimage (computed read-only
-- on production with replace()); owner, SECURITY DEFINER, proconfig and
-- grants must not move. The return type is unchanged, so this is a CREATE OR
-- REPLACE of the same signature.
--
-- Regression: scripts/ci/test-horse-claim-lock-order.py (native PostgreSQL,
-- two sessions provoking the production cycle against the live text, then the
-- same schedule against this migration), run by
-- .github/workflows/horse-claim-lock-order.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_horse_claim_due(integer)'::regprocedure)) = '4207064ff1b6bd00f8fb9470e40e6c10')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_horse_claim_subst(p_sig text, p_before text, p_after text,
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

SELECT pg_temp.ca_horse_claim_subst(
  'public.fn_ca_horse_claim_due(integer)',
  '57b62c3786f3120097abb919f880243c', '4207064ff1b6bd00f8fb9470e40e6c10',
  ARRAY[$o1$    EXIT WHEN clock_timestamp() - v_started > interval '45 seconds';
$o1$],
  ARRAY[$n1$    EXIT WHEN clock_timestamp() - v_started > interval '45 seconds';
    -- A HORSE CLAIM NEVER WAITS ON A PLAYER LOCK (2026-10-15).
    --
    -- This loop is one transaction, so every horse it has paid keeps its
    -- daily-missions advisory lock and its profiles row locked until the run
    -- ends. It used to take the next horse's locks by waiting, inside the claim
    -- (fn_lock_daily_mission_user, the diamond UPDATE, add_diamonds_to_balance),
    -- while the engine's commission batch locks the same profiles rows in hand
    -- order through fn_sync_profile_total_hands. Holding A and waiting for B
    -- against a hand holding B and waiting for A was 14 of the 16 deadlocks of
    -- 2026-10-15 00:03 to 00:15 UTC.
    --
    -- Both locks are taken here first, in fn_lock_daily_mission_user's order and
    -- without waiting. FOR UPDATE is the strongest mode the claim takes, so no
    -- step inside it upgrades and waits behind another writer's KEY SHARE. A
    -- horse somebody is writing right now is left exactly as it is - not claimed,
    -- not deferred, not counted - and is still the oldest thing owed a minute
    -- later. What a claim pays is unchanged.
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(
      hashtextextended('daily-missions-user:' || r.user_id::text, 0));
    PERFORM 1 FROM public.profiles p WHERE p.id = r.user_id FOR UPDATE SKIP LOCKED;
    CONTINUE WHEN NOT FOUND;
$n1$]
);

COMMIT;
