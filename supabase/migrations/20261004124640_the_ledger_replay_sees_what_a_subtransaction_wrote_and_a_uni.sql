-- 20261004124640_the_ledger_replay_sees_what_a_subtransaction_wrote_and_a_uni.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE LEDGER REPLAY SEES WHAT A SUBTRANSACTION WROTE, AND A UNION RAKE PAYMENT
-- NAMES ITS COLUMN (chip drift). Full account:
-- docs/changelog/2026-10-04-the-ledger-replay-sees-what-a-subtransaction-wrote.md.
--
-- The 2026-10-04 06:40 replay tripped the kill switch at -1,489,348.47 on
-- Midway's union rake wallet and filed 190.00 on one player wallet and a
-- 6.21 pair across a jackpot pool and a club promo bank. None of it was a
-- lost chip. Two defects, one in the payers and one in the reader:
--
-- 1. A UNION RAKE PAYMENT DID NOT SAY WHICH COLUMN IT LEFT. A union wallet
--    row holds six balances, so its side of a leg must carry a label; the
--    weekly close, its retained-share transfer and the owner-authorized
--    legacy week wrote union_wallet legs with none. The replay cannot key
--    such a leg (it counts it as `unkeyable`), so the rake wallet saw
--    734,884.10 of rake in and none of the 590 payments out:
--    1,446,346.26 of rakeback to clubs and players and 43,012.21 retained
--    share = 1,489,358.47, all of it debited from rake_wallet in the same
--    transactions (union_wallet_transactions agrees to the cent). The three
--    writers now stamp from_label 'union_wallets.rake_wallet'.
--
-- 2. THE REPLAY JUDGED A LEG BY ITS SUBTRANSACTION. Every BEGIN ... EXCEPTION
--    block runs as a subtransaction, so a leg inserted inside one (the
--    autoledger's insert always is) carries the subtransaction's id as xmin.
--    pg_visible_in_snapshot cannot judge a subtransaction id: a leg whose
--    parent was still running at the previous reading reads as visible in
--    it, so it was outside the next window, and it was also invisible to the
--    reading that took it. The balance moved and no reading counted the leg.
--    Read from production: the 190.00 prize leg of 2026-10-01 06:39:52
--    (xmin 750498527) sits inside the 06:47 reading's xmin..xmax band, is
--    not in its in-progress list, and was in neither window. A probe in one
--    rolled-back call confirmed the mechanism (row xmin 878999716 under top
--    transaction 878999714; pg_current_xact_id() inside the block returned
--    the top id). chip_ledger gains top_xid, stamped by the enrichment
--    trigger with pg_current_xact_id(), and both journal readers judge
--    COALESCE(top_xid, xmin).
--
-- Every preimage is asserted by md5 and every result is asserted by md5; the
-- grants are asserted unchanged (the two readers' are restated). No chips
-- move, no job is added, nothing is backfilled. The readings this replay
-- already filed are corrected in 20261004125201 (records only).
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure)) = 'fddb201e23c57a4f1de95940325ea646')

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure)) IS DISTINCT FROM 'ec36a30011e62e266e3385ef407fe064'
     OR md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure)) IS DISTINCT FROM '2994dc949e5ed22c3f8f0ef832652cb8'
     OR md5(pg_get_functiondef('public.fn_ca_chip_ledger_enrich()'::regprocedure)) IS DISTINCT FROM '5931f47d922eea26ab1ea2b12f3f7c8c'
     OR md5(pg_get_functiondef('public.fn_union_close_post_rake_debit(jsonb)'::regprocedure)) IS DISTINCT FROM 'ecbe8d54d177c002b4bd9c76770ac11a'
     OR md5(pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM '6cb1cce06a2f553697e434d8004d64b8'
     OR md5(pg_get_functiondef('public.fn_accounting_legacy_pay_week(uuid)'::regprocedure)) IS DISTINCT FROM 'c2d44f4f6462a307228673452cf993dc'
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.chip_ledger'::regclass AND attname = 'top_xid') THEN
    RAISE EXCEPTION 'SUBXACT_LEG_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT array_agg(p.proacl::text ORDER BY p.oid::regprocedure::text)
        FROM pg_proc p
       WHERE p.oid IN ('public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure,
                       'public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure,
                       'public.fn_ca_chip_ledger_enrich()'::regprocedure,
                       'public.fn_accounting_legacy_pay_week(uuid)'::regprocedure))
     IS DISTINCT FROM ARRAY['{postgres=X/postgres,service_role=X/postgres}','{postgres=X/postgres,service_role=X/postgres}',
                            '{postgres=X/postgres,service_role=X/postgres}','{postgres=X/postgres,service_role=X/postgres}']
     OR (SELECT array_agg(p.proacl::text)
           FROM pg_proc p
          WHERE p.oid IN ('public.fn_union_close_post_rake_debit(jsonb)'::regprocedure,
                          'public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure))
        IS DISTINCT FROM ARRAY['{postgres=X/postgres}','{postgres=X/postgres}'] THEN
    RAISE EXCEPTION 'SUBXACT_LEG_AUTHORITY_CHANGED';
  END IF;
END
$pre$;

-- The top-level transaction that commits the leg. Nullable, no default: an
-- added column with no default is a catalogue change, not a rewrite of the
-- journal. Legs written before this migration keep NULL and are judged by
-- xmin, as before.
ALTER TABLE public.chip_ledger ADD COLUMN top_xid xid8;
COMMENT ON COLUMN public.chip_ledger.top_xid IS
  'The top-level transaction that inserted this leg (pg_current_xact_id(), set by fn_ca_chip_ledger_enrich). xmin names the subtransaction when the writer ran inside a BEGIN ... EXCEPTION block, and pg_visible_in_snapshot cannot judge a subtransaction id; the ledger replay judges this instead. NULL on legs written before 2026-10-04.';

CREATE OR REPLACE FUNCTION public.fn_ca_leg_accounts_since_snapshot(p_prev_at timestamp with time zone, p_prev_snapshot pg_snapshot)
 RETURNS TABLE(account_key text, account_type text, entity_id uuid, club_id uuid, column_name text, net numeric, legs bigint, unkeyable bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH sides AS (
    /* A LEG IS JUDGED BY THE TRANSACTION THAT COMMITS IT (2026-10-04). xmin
       is the SUBTRANSACTION that inserted the row whenever the writer ran
       inside a BEGIN ... EXCEPTION block (the autoledger always does), and
       pg_visible_in_snapshot cannot judge a subtransaction id: one inserted
       under a parent still running at the previous reading came back
       visible, so the leg fell out of both readings. top_xid is the parent,
       stamped by fn_ca_chip_ledger_enrich; xmin is the fallback for legs
       written before that column existed. */
    SELECT l.to_type AS t, l.to_entity_id AS id, l.to_label AS lbl, l.from_label AS other_lbl, l.amount AS amt
      FROM public.chip_ledger l
     WHERE l.created_at > p_prev_at - interval '15 minutes'
       AND NOT pg_visible_in_snapshot(COALESCE(l.top_xid, public.fn_ca_xid8(l.xmin)), p_prev_snapshot)
       AND l.to_entity_id IS NOT NULL
    UNION ALL
    SELECT l.from_type, l.from_entity_id, l.from_label, l.to_label, -l.amount
      FROM public.chip_ledger l
     WHERE l.created_at > p_prev_at - interval '15 minutes'
       AND NOT pg_visible_in_snapshot(COALESCE(l.top_xid, public.fn_ca_xid8(l.xmin)), p_prev_snapshot)
       AND l.from_entity_id IS NOT NULL
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
    /* A LEG IS JUDGED BY THE TRANSACTION THAT COMMITS IT (2026-10-04). xmin
       is the SUBTRANSACTION that inserted the row whenever the writer ran
       inside a BEGIN ... EXCEPTION block (the autoledger always does), and
       pg_visible_in_snapshot cannot judge a subtransaction id: one inserted
       under a parent still running at the previous reading came back
       visible, so the leg fell out of both readings. top_xid is the parent,
       stamped by fn_ca_chip_ledger_enrich; xmin is the fallback for legs
       written before that column existed. */
    SELECT l.to_type AS t, l.to_entity_id AS id, l.to_label AS lbl, l.from_label AS other_lbl, l.amount AS amt
      FROM public.chip_ledger l
     WHERE l.created_at > p_prev_at - interval '15 minutes'
       AND NOT pg_visible_in_snapshot(COALESCE(l.top_xid, public.fn_ca_xid8(l.xmin)), p_prev_snapshot)
       AND l.to_entity_id = ANY (p_entities)
    UNION ALL
    SELECT l.from_type, l.from_entity_id, l.from_label, l.to_label, -l.amount
      FROM public.chip_ledger l
     WHERE l.created_at > p_prev_at - interval '15 minutes'
       AND NOT pg_visible_in_snapshot(COALESCE(l.top_xid, public.fn_ca_xid8(l.xmin)), p_prev_snapshot)
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

-- CREATE OR REPLACE keeps the live grants; both readers are restated closed
-- to every browser role, exactly as they are live (service_role only).
REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts_since_snapshot(timestamptz, pg_snapshot) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts_since_snapshot(timestamptz, pg_snapshot) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[]) TO service_role;

DO $patch$
DECLARE
  v_def text; v_new text;
  c_post_old CONSTANT text := $o1$(performed_by, from_type, from_entity_id, to_type, to_entity_id,
     amount, category, union_id, description, idempotency_key, metadata)
  VALUES
    (v_actor, 'union_wallet', u, 'union_bank', u,$o1$;
  c_post_new CONSTANT text := $n1$(performed_by, from_type, from_entity_id, from_label, to_type, to_entity_id,
     amount, category, union_id, description, idempotency_key, metadata)
  VALUES
    (v_actor, 'union_wallet', u, 'union_wallets.rake_wallet', 'union_bank', u,$n1$;
  c_week_old CONSTANT text := $o2$INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,
        club_id,union_id,description,idempotency_key,metadata,pre_to_balance,post_to_balance)
      VALUES(v_actor,'union_wallet',p_union_id,'club_treasury',$o2$;
  c_week_new CONSTANT text := $n2$INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,amount,category,
        club_id,union_id,description,idempotency_key,metadata,pre_to_balance,post_to_balance)
      VALUES(v_actor,'union_wallet',p_union_id,'union_wallets.rake_wallet','club_treasury',$n2$;
  c_lclub_old CONSTANT text := $o3$  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,pre_to_balance,post_to_balance)
  VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),'union_wallet',op.union_id,'club_treasury',$o3$;
  c_lclub_new CONSTANT text := $n3$  INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,pre_to_balance,post_to_balance)
  VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),'union_wallet',op.union_id,'union_wallets.rake_wallet','club_treasury',$n3$;
  c_lplay_old CONSTANT text := $o4$   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
     pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    CASE r.payer_kind WHEN 'club' THEN 'club_treasury' WHEN 'agent' THEN 'player_wallet' ELSE 'union_wallet' END,r.payer_entity_id,
    'player_wallet',$o4$;
  c_lplay_new CONSTANT text := $n4$   INSERT INTO public.chip_ledger(performed_by,from_type,from_entity_id,from_label,to_type,to_entity_id,amount,category,club_id,union_id,description,idempotency_key,metadata,
     pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    CASE r.payer_kind WHEN 'club' THEN 'club_treasury' WHEN 'agent' THEN 'player_wallet' ELSE 'union_wallet' END,r.payer_entity_id,
    CASE r.payer_kind WHEN 'club' THEN NULL WHEN 'agent' THEN NULL ELSE 'union_wallets.rake_wallet' END,
    'player_wallet',$n4$;
  c_enr_old CONSTANT text := $o5$  NEW.created_at := COALESCE(NEW.created_at, now());
$o5$;
  c_enr_new CONSTANT text := $n5$  NEW.created_at := COALESCE(NEW.created_at, now());
  /* THE TRANSACTION THAT COMMITS THE LEG (2026-10-04). A row inserted inside
     a subtransaction (every BEGIN ... EXCEPTION block, the autoledger's own
     insert among them) carries the SUBTRANSACTION's id as its xmin, and
     pg_visible_in_snapshot cannot judge a subtransaction id: a leg whose
     parent was still running when the ledger replay read the books came back
     "already visible", fell out of both readings, and its balance move read
     as drift (190.00 on one wallet, 6.21 across a jackpot pool and a club
     promo bank, at the 2026-10-04 reading). The top-level id is what commits,
     so it is what the replay judges by. Set here, never by the writer. */
  NEW.top_xid := pg_current_xact_id();
$n5$;
BEGIN
  -- 1. The retained share leaves the rake wallet for the union bank.
  v_def := pg_get_functiondef('public.fn_union_close_post_rake_debit(jsonb)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, c_post_old, ''))) / length(c_post_old) <> 1 THEN
    RAISE EXCEPTION 'SUBXACT_LEG_PREIMAGE_CHANGED: fn_union_close_post_rake_debit';
  END IF;
  v_new := replace(v_def, c_post_old, c_post_new);
  IF md5(v_new) IS DISTINCT FROM '59de5c620c40dc3acb319c3f6b2b82e3' THEN
    RAISE EXCEPTION 'SUBXACT_LEG_RESULT_CHANGED: fn_union_close_post_rake_debit';
  END IF;
  EXECUTE v_new;

  -- 2. The weekly close pays each club from the rake wallet.
  v_def := pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, c_week_old, ''))) / length(c_week_old) <> 1 THEN
    RAISE EXCEPTION 'SUBXACT_LEG_PREIMAGE_CHANGED: fn_union_weekly_rakeback_close';
  END IF;
  v_new := replace(v_def, c_week_old, c_week_new);
  IF md5(v_new) IS DISTINCT FROM '051c8a58a9092aa912e11e5391cf8e73' THEN
    RAISE EXCEPTION 'SUBXACT_LEG_RESULT_CHANGED: fn_union_weekly_rakeback_close';
  END IF;
  EXECUTE v_new;

  -- 3. The legacy week pays clubs (round 1) and players (round 3, union
  --    payer) from the rake wallet, debited once after every leg.
  v_def := pg_get_functiondef('public.fn_accounting_legacy_pay_week(uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, c_lclub_old, ''))) / length(c_lclub_old) <> 1
     OR (length(v_def) - length(replace(v_def, c_lplay_old, ''))) / length(c_lplay_old) <> 1 THEN
    RAISE EXCEPTION 'SUBXACT_LEG_PREIMAGE_CHANGED: fn_accounting_legacy_pay_week';
  END IF;
  v_new := replace(replace(v_def, c_lclub_old, c_lclub_new), c_lplay_old, c_lplay_new);
  IF md5(v_new) IS DISTINCT FROM '87c4c1050d711ec8f65a3949e0171b24' THEN
    RAISE EXCEPTION 'SUBXACT_LEG_RESULT_CHANGED: fn_accounting_legacy_pay_week';
  END IF;
  EXECUTE v_new;

  -- 4. Every leg records the transaction that commits it.
  v_def := pg_get_functiondef('public.fn_ca_chip_ledger_enrich()'::regprocedure);
  IF (length(v_def) - length(replace(v_def, c_enr_old, ''))) / length(c_enr_old) <> 1 THEN
    RAISE EXCEPTION 'SUBXACT_LEG_PREIMAGE_CHANGED: fn_ca_chip_ledger_enrich';
  END IF;
  v_new := replace(v_def, c_enr_old, c_enr_new);
  IF md5(v_new) IS DISTINCT FROM '8d2fc088741a7cc63a9ea6adcb2a9e29' THEN
    RAISE EXCEPTION 'SUBXACT_LEG_RESULT_CHANGED: fn_ca_chip_ledger_enrich';
  END IF;
  EXECUTE v_new;
END
$patch$;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_chip_ledger_enrich', 'migration 20261004124640_the_ledger_replay_sees_what_a_subtransaction_wrote_and_a_uni');

-- The grants every function had before are the grants it has now.
DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure)) IS DISTINCT FROM 'cf5ae457ca0f7543d26f2f65b6812916'
     OR md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure)) IS DISTINCT FROM 'fddb201e23c57a4f1de95940325ea646'
     OR md5(pg_get_functiondef('public.fn_ca_chip_ledger_enrich()'::regprocedure)) IS DISTINCT FROM '8d2fc088741a7cc63a9ea6adcb2a9e29'
     OR md5(pg_get_functiondef('public.fn_union_close_post_rake_debit(jsonb)'::regprocedure)) IS DISTINCT FROM '59de5c620c40dc3acb319c3f6b2b82e3'
     OR md5(pg_get_functiondef('public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM '051c8a58a9092aa912e11e5391cf8e73'
     OR md5(pg_get_functiondef('public.fn_accounting_legacy_pay_week(uuid)'::regprocedure)) IS DISTINCT FROM '87c4c1050d711ec8f65a3949e0171b24' THEN
    RAISE EXCEPTION 'SUBXACT_LEG_RESULT_CHANGED';
  END IF;
  IF (SELECT array_agg(p.proacl::text ORDER BY p.oid::regprocedure::text)
        FROM pg_proc p
       WHERE p.oid IN ('public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure,
                       'public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure,
                       'public.fn_ca_chip_ledger_enrich()'::regprocedure,
                       'public.fn_accounting_legacy_pay_week(uuid)'::regprocedure))
     IS DISTINCT FROM ARRAY['{postgres=X/postgres,service_role=X/postgres}','{postgres=X/postgres,service_role=X/postgres}',
                            '{postgres=X/postgres,service_role=X/postgres}','{postgres=X/postgres,service_role=X/postgres}']
     OR (SELECT array_agg(p.proacl::text)
           FROM pg_proc p
          WHERE p.oid IN ('public.fn_union_close_post_rake_debit(jsonb)'::regprocedure,
                          'public.fn_union_weekly_rakeback_close(uuid,timestamptz,timestamptz)'::regprocedure))
        IS DISTINCT FROM ARRAY['{postgres=X/postgres}','{postgres=X/postgres}'] THEN
    RAISE EXCEPTION 'SUBXACT_LEG_AUTHORITY_CHANGED';
  END IF;
END
$post$;

COMMIT;
