-- 20261003112214_the_journal_can_be_read_for_the_accounts_that_ask.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE JOURNAL CAN BE READ FOR THE ACCOUNTS THAT ASK (phase 5 of 9). The first
-- of two migrations; the second, 20261003112219, points the nightly ledger replay at
-- this reader. Full account: docs/changelog/2026-10-03-the-ledger-replay-reads-only-the-legs-it-is-asked-about.md.
--
-- fn_ca_leg_accounts_since_snapshot_for(prev_at, snapshot, entities) is
-- fn_ca_leg_accounts_since_snapshot with one change: each side of a leg is
-- read only for the given entities, through the entity indexes, instead of
-- every leg since prev_at. Same visibility rule, same keying. Every account
-- owned by one of the entities gets exactly the legs the full reader gives it.
--
-- Measured on production 2026-10-03, under one REPEATABLE READ snapshot and
-- rolled back: over all 1,023 accounts the replay has ever read, the two
-- readers agree on every account (907 with legs, 187,515 legs, every account
-- type including union_bank and union_wallet), 3.8 s against 6.7 s.
--
-- Refuses to run if the full reader is not the text measured or its grants
-- differ, and refuses to commit unless both readers, in one statement, agree
-- on every account the replay has read over the last hour.
-- No job is added. Nothing is backfilled. No chips move.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[])'::regprocedure)) = '2994dc949e5ed22c3f8f0ef832652cb8')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot(timestamptz, pg_snapshot)'::regprocedure)) IS DISTINCT FROM 'ec36a30011e62e266e3385ef407fe064'
     OR to_regprocedure('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'LEDGER_REPLAY_WINDOW_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_leg_accounts_since_snapshot(timestamptz, pg_snapshot)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'LEDGER_REPLAY_WINDOW_AUTHORITY_CHANGED';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_ca_leg_accounts_since_snapshot_for(p_prev_at timestamp with time zone, p_prev_snapshot pg_snapshot, p_entities uuid[])
 RETURNS TABLE(account_key text, account_type text, entity_id uuid, club_id uuid, column_name text, net numeric, legs bigint, unkeyable bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  /* THE SAME JOURNAL, READ FOR THE ACCOUNTS THAT ASKED (2026-10-03). This is
     fn_ca_leg_accounts_since_snapshot with one difference: each side reads
     only the legs of the entities in p_entities, through the entity index,
     instead of every leg since p_prev_at. Every account owned by one of
     those entities gets exactly the legs the full reader would give it; the
     caller passes every owner and, for a union, its wallet row ids. */
  WITH sides AS (
    SELECT l.to_type AS t, l.to_entity_id AS id, l.to_label AS lbl, l.from_label AS other_lbl, l.amount AS amt
      FROM public.chip_ledger l
     WHERE l.created_at > p_prev_at - interval '15 minutes'
       AND NOT pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), p_prev_snapshot)
       AND l.to_entity_id = ANY (p_entities)
    UNION ALL
    SELECT l.from_type, l.from_entity_id, l.from_label, l.to_label, -l.amount
      FROM public.chip_ledger l
     WHERE l.created_at > p_prev_at - interval '15 minutes'
       AND NOT pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), p_prev_snapshot)
       AND l.from_entity_id = ANY (p_entities)
  ), resolved AS (
    SELECT s.*,
      CASE s.t
        WHEN 'player_wallet'  THEN 'club_members.chip_balance'
        WHEN 'table_stack'    THEN 'table_seats.stack'
        WHEN 'club_treasury'  THEN 'clubs.chip_treasury'
        WHEN 'union_bank'     THEN 'union_wallets.chip_balance'
        WHEN 'spin_reserve'   THEN 'spin_bonus_pools.balance'
        WHEN 'union_wallet'   THEN COALESCE(s.lbl,
               CASE WHEN s.other_lbl LIKE '%promo%'
                         AND (EXISTS (SELECT 1 FROM public.unions u WHERE u.id = s.id)
                              OR EXISTS (SELECT 1 FROM public.union_wallets w WHERE w.id = s.id))
                    THEN 'union_wallets.promo_wallet' END)
        WHEN 'bbj_pool'       THEN s.lbl
        WHEN 'promo_wallet'   THEN COALESCE(s.lbl,
               CASE WHEN s.other_lbl LIKE '%promo%' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = s.id)
                    THEN 'clubs.promo_balance'
                    WHEN s.other_lbl LIKE '%promo%' AND EXISTS (SELECT 1 FROM public.agents a WHERE a.id = s.id OR a.user_id = s.id)
                    THEN 'agents.promo_wallet_balance'
                    WHEN s.other_lbl LIKE '%promo%' AND EXISTS (SELECT 1 FROM public.unions u WHERE u.id = s.id)
                    THEN 'union_wallets.promo_wallet' END)
        WHEN 'agent_wallet'   THEN COALESCE(s.lbl, 'agents.agent_wallet_balance')
        ELSE NULL
      END AS col,
      CASE WHEN s.t = 'table_stack' THEN '00000000-0000-0000-0000-0000000fe17e'::uuid
           /* A UNION WALLET IS KEYED BY ITS UNION (2026-09-26). fn_ca_autoledger
              stamps a union_wallets leg with the wallet ROW id, a declaring payer
              stamps it with the union id, and fn_ca_account_balance reads the
              balance by union_id. Keyed as written, one wallet split into two
              accounts: the row-id half could never be read and was skipped, and
              the union-id half was judged without it. */
           WHEN s.t IN ('union_wallet', 'union_bank')
             THEN COALESCE((SELECT w.union_id FROM public.union_wallets w WHERE w.id = s.id), s.id)
           ELSE s.id END AS owner
      FROM sides s
     WHERE s.t <> 'prize_liability'
  )
  SELECT k.t || ':' || k.owner::text || ':' || k.col AS account_key,
         k.t, k.owner, NULL::uuid, k.col,
         round(sum(k.amt), 2), count(*), 0::bigint
    FROM resolved k
   WHERE k.col IS NOT NULL
   GROUP BY 1, 2, 3, 4, 5
  UNION ALL
  SELECT NULL, 'unkeyable', NULL, NULL, NULL, round(sum(k.amt), 2), count(*), count(*)
    FROM resolved k
   WHERE k.col IS NULL
  HAVING count(*) > 0;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[]) TO service_role;

DO $post$
DECLARE
  v_snap pg_snapshot;
  v_owners uuid[];
  v_differ bigint;
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[])'::regprocedure)) IS DISTINCT FROM '2994dc949e5ed22c3f8f0ef832652cb8'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[])'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'LEDGER_REPLAY_WINDOW_RESULT_CHANGED';
  END IF;

  -- Both readers, one statement, so one snapshot: over the last hour, every
  -- account the replay has read must get the same legs from each. Every
  -- reader is MATERIALIZED so it runs once, not once per account it is
  -- joined to.
  SELECT x.read_snapshot::pg_snapshot INTO v_snap
    FROM public.ca_account_snapshots x
   WHERE x.read_snapshot IS NOT NULL
   ORDER BY x.taken_at DESC LIMIT 1;
  SELECT array_agg(DISTINCT x.entity_id) INTO v_owners
    FROM public.ca_account_snapshots x
   WHERE x.account_type <> 'table_stack' AND x.entity_id IS NOT NULL;
  WITH ents AS MATERIALIZED (
    SELECT v_owners || ARRAY(SELECT uw.id FROM public.union_wallets uw WHERE uw.union_id = ANY (v_owners)) AS a
  ), accts AS MATERIALIZED (
    SELECT DISTINCT x.account_key FROM public.ca_account_snapshots x WHERE x.account_type <> 'table_stack'
  ), full_reader AS MATERIALIZED (
    SELECT f.account_key, f.net, f.legs
      FROM public.fn_ca_leg_accounts_since_snapshot(now() - interval '1 hour', v_snap) f
     WHERE f.account_key IS NOT NULL
  ), entity_reader AS MATERIALIZED (
    SELECT e.account_key, e.net, e.legs
      FROM ents, public.fn_ca_leg_accounts_since_snapshot_for(now() - interval '1 hour', v_snap, ents.a) e
     WHERE e.account_key IS NOT NULL
  )
  SELECT count(*) INTO v_differ
    FROM accts a
    LEFT JOIN full_reader f ON f.account_key = a.account_key
    LEFT JOIN entity_reader e ON e.account_key = a.account_key
   WHERE f.net IS DISTINCT FROM e.net OR f.legs IS DISTINCT FROM e.legs;
  IF v_differ <> 0 THEN
    RAISE EXCEPTION 'LEDGER_REPLAY_WINDOW_RESULT_CHANGED: % accounts read differently', v_differ;
  END IF;
END
$post$;

COMMIT;
