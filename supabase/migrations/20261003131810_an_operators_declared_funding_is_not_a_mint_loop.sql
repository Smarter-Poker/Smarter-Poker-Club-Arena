-- 20261003131810_an_operators_declared_funding_is_not_a_mint_loop.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- AN OPERATOR'S DECLARED FUNDING IS NOT A MINT LOOP (phase 6 of 9: money
-- edges). Full account:
-- docs/changelog/2026-10-03-an-operators-declared-funding-is-not-a-mint-loop.md.
--
-- fn_ca_mint_velocity_watch filed "a mint loop is running" warnings on
-- 2026-10-03 03:15 (607,265.09) and 10:30 (560,017.06). Both were reviewed,
-- one-off club fundings through fn_ca_fund_club: the standalone rake bank of
-- Deep Stack Society for weeks 09-14 and 09-21 (rake retired at the hand,
-- banked at the close; 20261002153151) and the owner-authorized funding of
-- its overdue agent commission (20261003092151). Each wrote a mint register
-- row with origin 'operator', op_id equal to the leg's idempotency key,
-- linked to the leg, with the same amount and a reason. The watch already
-- leaves out a new club's declared opening grant on the same evidence; it
-- now leaves out such an operator mint too, while at most three land in the
-- window. A fourth means a loop through the declaring door and all of them
-- count. Replayed over the two windows: 607,265.09 and 560,017.06 become 0;
-- an auto-registered mint (origin 'journal') is still counted.
--
-- fn_ca_mint_velocity_watch is a watched guard: the redefinition is declared
-- in this transaction. Refuses to run if the function is not the text
-- measured or its grants differ. No job is added. No chips move.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_mint_velocity_watch()'::regprocedure)) = 'c22bbee2e281142c032212d4220a0a17')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_mint_velocity_watch()'::regprocedure)) IS DISTINCT FROM '0d9601f47ad215035eaa01b7284c1cf4' THEN
    RAISE EXCEPTION 'MINT_WATCH_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_mint_velocity_watch()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'MINT_WATCH_AUTHORITY_CHANGED';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_ca_mint_velocity_watch()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_mint numeric; v_burn numeric; v_grants bigint; v_grant_chips numeric;
        v_ops bigint; v_op_chips numeric;
BEGIN
  /* THE NEW-CLUB OPENING GRANT IS NEVER DRIFT (2026-09-23). Creating a
     standalone chip club mints its declared 100,000-chip opening bank
     (fn_seed_new_club_opening_bank declares it, fn_record_new_club_opening_bank
     registers it). This sum had no entity dimension, so three new clubs
     inside ten minutes filed a warning and eleven a critical, and
     fn_ca_is_midway_scope files a raise with no dimension into Midway's own
     incident flow. A grant is left out ONLY in its exact declared shape:
     the journal leg issuance_reserve (system_mint before 2026-09-03) ->
     club_treasury, category mint, posted, exactly 100,000, landing in the
     club it names, keyed 'club-opening-grant:<that club>', AND linked from
     the mint register row the grant's own trigger wrote for that club and
     that amount. Short of all of it, the leg is still counted. What is
     left out rides along as metadata on any raise this watch still makes;
     it never makes one.

     AN OPERATOR'S DECLARED FUNDING IS NOT A LOOP EITHER (2026-10-03). Both
     mint warnings of 2026-10-03 were deliberate, reviewed settlements: the
     standalone rake bank of Deep Stack Society (607,265.09, two closed weeks
     of rake retired at the hand and banked at the close) and the owner's
     funding of its overdue agent commission (560,017.06). Each was minted
     through fn_ca_fund_club under its own operation key, and the mint
     register row fn_ca_fund_club wrote for it - origin 'operator', op_id
     equal to the leg's idempotency_key, linked to that leg, the same amount,
     with a reason - is the declaration a person has to read anyway. Such a
     mint is left out and rides along as metadata, but only while there are
     at most three of them in the window: a loop through the declaring door
     is still a loop. An auto-registered row (origin 'journal', op_id
     'ledger:<leg>') declares nothing and is still counted. */
  SELECT COALESCE(sum(l.amount) FILTER (WHERE l.from_type IN ('system_mint','issuance_reserve')
                                          AND NOT g.declared_opening_grant
                                          AND NOT o.declared_operator_mint), 0),
         COALESCE(sum(l.amount) FILTER (WHERE l.to_type   IN ('system_burn','chip_retirement')), 0),
         count(*) FILTER (WHERE g.declared_opening_grant),
         COALESCE(sum(l.amount) FILTER (WHERE g.declared_opening_grant), 0),
         count(*) FILTER (WHERE o.declared_operator_mint),
         COALESCE(sum(l.amount) FILTER (WHERE o.declared_operator_mint), 0)
    INTO v_mint, v_burn, v_grants, v_grant_chips, v_ops, v_op_chips
    FROM public.chip_ledger l
    CROSS JOIN LATERAL (
      SELECT (l.category = 'mint'
          AND l.from_type IN ('issuance_reserve', 'system_mint')
          AND l.to_type = 'club_treasury'
          AND l.status = 'posted'
          AND l.amount = 100000
          AND l.to_entity_id = l.club_id
          AND l.idempotency_key = 'club-opening-grant:' || l.to_entity_id::text
          AND EXISTS (
            SELECT 1 FROM public.ca_mint_ledger m
             WHERE m.op_id = l.idempotency_key
               AND m.chip_ledger_id = l.id
               AND m.action = 'mint' AND m.asset = 'chips'
               AND m.holder_type = 'club' AND m.holder_id = l.to_entity_id
               AND m.amount = 100000)) IS TRUE AS declared_opening_grant
    ) g
    CROSS JOIN LATERAL (
      SELECT (l.category = 'mint'
          AND l.from_type IN ('issuance_reserve', 'system_mint')
          AND l.status = 'posted'
          AND l.idempotency_key IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.ca_mint_ledger m
             WHERE m.op_id = l.idempotency_key
               AND m.chip_ledger_id = l.id
               AND m.origin = 'operator'
               AND m.performed_by_label = 'fn_ca_fund_club'
               AND m.action = 'mint' AND m.asset = 'chips'
               AND m.amount = l.amount
               AND COALESCE(btrim(m.reason), '') <> '')) IS TRUE AS declared_operator_mint
    ) o
   WHERE l.created_at > now() - interval '10 minutes';

  IF v_ops > 3 THEN
    v_mint := v_mint + v_op_chips;
  END IF;

  IF v_mint > 250000 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_mint_velocity_watch', 'ledger_imbalance',
      CASE WHEN v_mint > 1000000 THEN 'critical' ELSE 'warning' END,
      'mint-velocity:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_mint, 250000, v_mint, 'ledger', 'chip_ledger',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      round(v_mint, 2) || ' chips minted in 10 minutes, declared new-club opening grants and up to three declared operator mints not counted - far above the expected trickle; if this is not a deliberate batch (an epoch reset), a mint loop is running',
      true, jsonb_build_object('mint_10m', round(v_mint,2), 'burn_10m', round(v_burn,2),
                               'opening_grants_10m', v_grants,
                               'opening_grant_chips_10m', round(v_grant_chips,2),
                               'operator_mints_10m', v_ops,
                               'operator_mint_chips_10m', round(v_op_chips,2),
                               'operator_mints_counted', v_ops > 3));
  END IF;

  IF v_burn > 1000000 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_mint_velocity_watch', 'ledger_imbalance', 'warning',
      'burn-velocity:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_burn, 1000000, v_burn, 'ledger', 'chip_ledger',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      round(v_burn, 2) || ' chips burned in 10 minutes - expected only during an epoch reset or a mass cleanup; verify the operation is deliberate',
      true, jsonb_build_object('mint_10m', round(v_mint,2), 'burn_10m', round(v_burn,2)));
  END IF;

  RETURN v_mint;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_mint_velocity_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_velocity_watch() TO service_role;

SELECT public.fn_ca_declare_guard_redefinition('fn_ca_mint_velocity_watch', 'migration an_operators_declared_funding_is_not_a_mint_loop');

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_mint_velocity_watch()'::regprocedure)) IS DISTINCT FROM 'c22bbee2e281142c032212d4220a0a17'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_mint_velocity_watch()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'MINT_WATCH_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;
