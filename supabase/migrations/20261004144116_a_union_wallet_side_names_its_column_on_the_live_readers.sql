-- 20261004144116_a_union_wallet_side_names_its_column_on_the_live_readers.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A UNION WALLET SIDE NAMES ITS COLUMN, ON THE LIVE READERS (chip drift,
-- second cut). Replaces 20261004133333, which was written on the readers of
-- 20261004124640; that migration was superseded before it ran because
-- 20261004123650 and 20261004135607 fixed the same defects live first, so the
-- snapshot readers are patched here where they stand instead of redefined.
-- Full account: docs/changelog/2026-10-04-a-union-wallet-side-always-names-its-column.md.
--
-- 20261004123650 fixed the three payers that wrote 1,489,358.47 of union
-- rake payments with no column, which the ledger replay read as a kill-switch
-- drift. The same bare side can still be written wherever a payer declares a
-- union wallet as the AUTOLEDGER counterparty: the trigger writes the side of
-- the balance it watched and leaves the counterparty's side unlabelled, and a
-- union_wallets row holds six balances. Read from production: union send to
-- a member, union player P&L, spin seed repayment, BBJ funding, BBJ backup to
-- promo, union promo to the jackpot, promo rain and promo disbursement to a
-- player all do. None has run in 60 days; the next one would have been read
-- as drift on the wrong account, or on no account.
--
-- 1. The counterparty names its column. fn_ca_declare_ledger clears
--    app.ledger_counterparty_label; a caller whose counterparty is a union
--    wallet or a promo bank sets it; fn_ca_autoledger writes it on that side,
--    and only when it can belong to the declared counterparty. The save and
--    restore helpers carry it like the other declaration settings.
-- 2. Each payer above names the column it moves.
-- 3. The union bank is one account whoever names it: a union_wallet side
--    labelled union_wallets.chip_balance is the union_bank account in all
--    three journal readers (fn_ca_account_balance reads it by column).
-- 4. chip_ledger refuses a union_wallet side with no label, unless the other
--    side names a promo bank (the replay's exact rule, 20260906011010) or the
--    leg is a journal-only correction posted by fn_ca_post_correction. NOT
--    VALID: the legs already written stay as they are (the journal is
--    append-only); every new one is held to it.
--
-- Every preimage is asserted by md5, every result by md5, and every grant is
-- asserted unchanged. No chips move, no job is added, nothing is backfilled.
--
-- @live-proof: position('''union_bank'' ELSE k.t END' in pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure)) > 0
-- @live-proof: (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.chip_ledger'::regclass AND conname = 'chip_ledger_a_union_wallet_side_names_its_column') = 1

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $pre$
BEGIN
  IF to_regclass('public.ca_ledger_replay_readings') IS NULL
     OR position('ca_ledger_replay_readings' in pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_NEEDS_20261004135607';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chip_ledger'::regclass
              AND conname = 'chip_ledger_a_union_wallet_side_names_its_column')
     OR md5(pg_get_functiondef('public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])'::regprocedure)) IS DISTINCT FROM '1991d9f52317f33a4b9cf560d6fc91d5'
     OR md5(pg_get_functiondef('public.fn_ca_autoledger()'::regprocedure)) IS DISTINCT FROM '53f9d85b88cc86b807f7ea5b80d7bd4e'
     OR md5(pg_get_functiondef('public.fn_ca_ledger_declaration_save(text[])'::regprocedure)) IS DISTINCT FROM '00a5a179af5c4bc68bf5647a2dcb2527'
     OR md5(pg_get_functiondef('public.fn_ca_ledger_declaration_restore(jsonb)'::regprocedure)) IS DISTINCT FROM '45897bbf6170d40051dfa6a09abaf3c4'
     OR md5(pg_get_functiondef('public.fn_bbj_promo_payout_atomic(uuid,numeric,uuid[],text,text)'::regprocedure)) IS DISTINCT FROM '1d750b55324337e5620472cf25231c01'
     OR md5(pg_get_functiondef('public.fn_promo_disburse(text,uuid,text,uuid,numeric,text,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '8884bce4d86035c996359f90f8d76c78'
     OR md5(pg_get_functiondef('public.fn_union_bbj_backup_transfer(uuid,numeric,text,uuid,uuid,text)'::regprocedure)) IS DISTINCT FROM '84730e3bc9b8da36ce8fac36e96bfe81'
     OR md5(pg_get_functiondef('public.fn_union_promo_send(uuid,numeric,text,uuid,uuid,uuid,text)'::regprocedure)) IS DISTINCT FROM 'e23fb3565c07f30c7ad267b3727c53b3'
     OR md5(pg_get_functiondef('public.fn_union_fund_bbj_pool(uuid,numeric,numeric,numeric,numeric,text,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '48f11b031b14b0b603ee52646a57a0ec'
     OR md5(pg_get_functiondef('public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)'::regprocedure)) IS DISTINCT FROM '0622761d01cce3ff085ea57264921983'
     OR md5(pg_get_functiondef('public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM 'da88b1d58a018aca7577219bb719afbb'
     OR md5(pg_get_functiondef('public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'::regprocedure)) IS DISTINCT FROM '5f2e4d85865fff45a2b819d73a87bd17'
     OR md5(pg_get_functiondef('public.fn_ca_leg_accounts(timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM 'df28bab6a2cc5f2cb1b7138ff27f47f8'
     OR md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure)) IS DISTINCT FROM 'eb9826835bb4673f878d620650d0aee0'
     OR md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure)) IS DISTINCT FROM '6b3f35a67bae2879c0b439cd0813289c' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_declare_ledger';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_autoledger()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_autoledger';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_ledger_declaration_save(text[])'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_ledger_declaration_save';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_ledger_declaration_restore(jsonb)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_ledger_declaration_restore';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_bbj_promo_payout_atomic(uuid,numeric,uuid[],text,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_bbj_promo_payout_atomic';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_promo_disburse(text,uuid,text,uuid,numeric,text,uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_promo_disburse';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_bbj_backup_transfer(uuid,numeric,text,uuid,uuid,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_union_bbj_backup_transfer';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_promo_send(uuid,numeric,text,uuid,uuid,uuid,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_union_promo_send';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_fund_bbj_pool(uuid,numeric,numeric,numeric,numeric,text,uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_union_fund_bbj_pool';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_union_send_to_member_zd3core';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_union_settle_player_pnl';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_spin_settle_game';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_leg_accounts(timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_leg_accounts';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_leg_accounts_since_snapshot';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_leg_accounts_since_snapshot_for';
  END IF;
END
$pre$;

-- 3. The union bank is one account whoever names it, in all three readers.
CREATE OR REPLACE FUNCTION public.fn_ca_leg_accounts(p_since timestamp with time zone, p_until timestamp with time zone)
 RETURNS TABLE(account_key text, account_type text, entity_id uuid, club_id uuid, column_name text, net numeric, legs bigint, unkeyable bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH sides AS (
    /* Each side carries the OTHER side's label, because that is what names
       the column when this side has none. */
    SELECT l.to_type AS t, l.to_entity_id AS id, l.to_label AS lbl, l.from_label AS other_lbl, l.amount AS amt
      FROM public.chip_ledger l
     WHERE l.created_at > p_since AND l.created_at <= p_until AND l.to_entity_id IS NOT NULL
    UNION ALL
    SELECT l.from_type, l.from_entity_id, l.from_label, l.to_label, -l.amount
      FROM public.chip_ledger l
     WHERE l.created_at > p_since AND l.created_at <= p_until AND l.from_entity_id IS NOT NULL
  ), resolved AS (
    SELECT s.*,
      CASE s.t
        WHEN 'player_wallet'  THEN 'club_members.chip_balance'
        WHEN 'table_stack'    THEN 'table_seats.stack'
        WHEN 'club_treasury'  THEN 'clubs.chip_treasury'
        WHEN 'union_bank'     THEN 'union_wallets.chip_balance'
        WHEN 'spin_reserve'   THEN 'spin_bonus_pools.balance'
        WHEN 'union_wallet'   THEN COALESCE(s.lbl,
               /* THE OTHER SIDE NAMES WHAT MOVED: out of a promo bank, into a
                  promo bank. The entity decides which promo column. */
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
  /* THE UNION BANK IS ONE ACCOUNT, WHOEVER NAMES IT (2026-10-04). A payer
     that declares a union wallet and names union_wallets.chip_balance moved
     the union bank, whose own legs say union_bank. fn_ca_account_balance
     reads both by column, so they are one balance and one account. */
  SELECT CASE WHEN k.t = 'union_wallet' AND k.col = 'union_wallets.chip_balance' THEN 'union_bank' ELSE k.t END
           || ':' || k.owner::text || ':' || k.col AS account_key,
         CASE WHEN k.t = 'union_wallet' AND k.col = 'union_wallets.chip_balance' THEN 'union_bank' ELSE k.t END,
         k.owner, NULL::uuid, k.col,
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

-- The two snapshot readers are patched where they stand: 20261004135607
-- changed how they judge a window and that stays exactly as it is; only the
-- account key and type of the final SELECT change.
DO $readers$
DECLARE
  v_def text; v_new text;
  c_old CONSTANT text := $o$  SELECT k.t || ':' || k.owner::text || ':' || k.col AS account_key,
         k.t, k.owner, NULL::uuid, k.col,
$o$;
  c_new CONSTANT text := $n$  /* THE UNION BANK IS ONE ACCOUNT, WHOEVER NAMES IT (2026-10-04). A payer
     that declares a union wallet and names union_wallets.chip_balance moved
     the union bank, whose own legs say union_bank. fn_ca_account_balance
     reads both by column, so they are one balance and one account. */
  SELECT CASE WHEN k.t = 'union_wallet' AND k.col = 'union_wallets.chip_balance' THEN 'union_bank' ELSE k.t END
           || ':' || k.owner::text || ':' || k.col AS account_key,
         CASE WHEN k.t = 'union_wallet' AND k.col = 'union_wallets.chip_balance' THEN 'union_bank' ELSE k.t END,
         k.owner, NULL::uuid, k.col,
$n$;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_ca_leg_accounts_since_snapshot';
  END IF;
  v_new := replace(v_def, c_old, c_new);
  IF md5(v_new) IS DISTINCT FROM '7aaf8013079ea67adfc18a26691bf8a6' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_ca_leg_accounts_since_snapshot';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure);
  IF (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old) <> 1 THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_ca_leg_accounts_since_snapshot_for';
  END IF;
  v_new := replace(v_def, c_old, c_new);
  IF md5(v_new) IS DISTINCT FROM '0aa811df7bbdb1716dec7f6793c1f42e' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_ca_leg_accounts_since_snapshot_for';
  END IF;
  EXECUTE v_new;
END
$readers$;

REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts(timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts_since_snapshot(timestamptz, pg_snapshot) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts_since_snapshot(timestamptz, pg_snapshot) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[]) TO service_role;

-- 1 and 2. The counterparty names its column, and every payer names it.
DO $patch$
DECLARE
  v_def text; v_new text; v_n int;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o1$  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(p_counterparty_entity::text, ''), true);
$o1$, ''))) / length($o1$  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(p_counterparty_entity::text, ''), true);
$o1$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_ca_declare_ledger'; END IF;
  v_new := replace(v_new, $o1$  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(p_counterparty_entity::text, ''), true);
$o1$, $n1$  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(p_counterparty_entity::text, ''), true);
  /* A COUNTERPARTY NAMES ITS COLUMN, AND A NEW DECLARATION FORGETS THE LAST
     ONE'S (2026-10-04). A union wallet holds six balances; the caller whose
     counterparty is one of them names it on app.ledger_counterparty_label
     after this call, and fn_ca_autoledger writes it on that side. */
  PERFORM set_config('app.ledger_counterparty_label', '', true);
$n1$);
  IF md5(v_new) IS DISTINCT FROM '2eb458ce27b0116d2f7ad4603ca719dd' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_ca_declare_ledger';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_ca_autoledger()'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o2$  cat text; cp text; cpid uuid;
$o2$, ''))) / length($o2$  cat text; cp text; cpid uuid;
$o2$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_ca_autoledger'; END IF;
  v_new := replace(v_new, $o2$  cat text; cp text; cpid uuid;
$o2$, $n2$  cat text; cp text; cpid uuid; cplbl text;
$n2$);
  v_n := (length(v_new) - length(replace(v_new, $o3$  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
$o3$, ''))) / length($o3$  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
$o3$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_ca_autoledger'; END IF;
  v_new := replace(v_new, $o3$  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
$o3$, $n3$  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
  /* THE COUNTERPARTY NAMES ITS COLUMN (2026-10-04). A union wallet holds six
     balances and a promo bank lives on three kinds of owner, so the side this
     trigger writes for a declared union_wallet or promo_wallet counterparty
     carries the column the caller declared on app.ledger_counterparty_label.
     A label that cannot belong to the declared counterparty is not written:
     a stale declaration never names the wrong account. */
  cplbl := NULLIF(current_setting('app.ledger_counterparty_label', true), '');
  cplbl := CASE
    WHEN cp = 'union_wallet' AND cplbl LIKE 'union_wallets.%' THEN cplbl
    WHEN cp = 'promo_wallet' AND cplbl IN ('clubs.promo_balance', 'agents.promo_wallet_balance',
                                           'union_wallets.promo_wallet') THEN cplbl
    ELSE NULL END;
$n3$);
  v_n := (length(v_new) - length(replace(v_new, $o4$        CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME || '.' || col END,
$o4$, ''))) / length($o4$        CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME || '.' || col END,
$o4$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_ca_autoledger'; END IF;
  v_new := replace(v_new, $o4$        CASE WHEN d > 0 THEN NULL ELSE TG_TABLE_NAME || '.' || col END,
$o4$, $n4$        CASE WHEN d > 0 THEN cplbl ELSE TG_TABLE_NAME || '.' || col END,
$n4$);
  v_n := (length(v_new) - length(replace(v_new, $o5$        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE NULL END,
$o5$, ''))) / length($o5$        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE NULL END,
$o5$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_ca_autoledger'; END IF;
  v_new := replace(v_new, $o5$        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE NULL END,
$o5$, $n5$        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE cplbl END,
$n5$);
  IF md5(v_new) IS DISTINCT FROM '852f2e9b202459d7450407b71b7cb6f8' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_ca_autoledger';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_ca_ledger_declaration_save(text[])'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o6$    'app.ledger_counterparty_entity', COALESCE(current_setting('app.ledger_counterparty_entity', true), ''));
$o6$, ''))) / length($o6$    'app.ledger_counterparty_entity', COALESCE(current_setting('app.ledger_counterparty_entity', true), ''));
$o6$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_ca_ledger_declaration_save'; END IF;
  v_new := replace(v_new, $o6$    'app.ledger_counterparty_entity', COALESCE(current_setting('app.ledger_counterparty_entity', true), ''));
$o6$, $n6$    'app.ledger_counterparty_entity', COALESCE(current_setting('app.ledger_counterparty_entity', true), ''),
    'app.ledger_counterparty_label',  COALESCE(current_setting('app.ledger_counterparty_label', true), ''));
$n6$);
  IF md5(v_new) IS DISTINCT FROM 'a11c4a4d59384037d4fdc62a1c9ba899' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_ca_ledger_declaration_save';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_ca_ledger_declaration_restore(jsonb)'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o7$counterparty_entity|autoskip_$o7$, ''))) / length($o7$counterparty_entity|autoskip_$o7$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_ca_ledger_declaration_restore'; END IF;
  v_new := replace(v_new, $o7$counterparty_entity|autoskip_$o7$, $n7$counterparty_entity|counterparty_label|autoskip_$n7$);
  IF md5(v_new) IS DISTINCT FROM 'ead8093832ebe1845217bbe91ba81361' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_ca_ledger_declaration_restore';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_bbj_promo_payout_atomic(uuid,numeric,uuid[],text,text)'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o8$    PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', v_union, NULL,
                                        'promo_rain:' || left(v_op_key, 180), ARRAY['union_wallets']);
$o8$, ''))) / length($o8$    PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', v_union, NULL,
                                        'promo_rain:' || left(v_op_key, 180), ARRAY['union_wallets']);
$o8$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_bbj_promo_payout_atomic'; END IF;
  v_new := replace(v_new, $o8$    PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', v_union, NULL,
                                        'promo_rain:' || left(v_op_key, 180), ARRAY['union_wallets']);
$o8$, $n8$    PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', v_union, NULL,
                                        'promo_rain:' || left(v_op_key, 180), ARRAY['union_wallets']);
    PERFORM set_config('app.ledger_counterparty_label', 'union_wallets.promo_wallet', true);
$n8$);
  v_n := (length(v_new) - length(replace(v_new, $o9$    PERFORM public.fn_ca_declare_ledger('promo', 'promo_wallet', v_pool.club_id, NULL,
                                        'promo_rain:' || left(v_op_key, 180), ARRAY['clubs']);
$o9$, ''))) / length($o9$    PERFORM public.fn_ca_declare_ledger('promo', 'promo_wallet', v_pool.club_id, NULL,
                                        'promo_rain:' || left(v_op_key, 180), ARRAY['clubs']);
$o9$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_bbj_promo_payout_atomic'; END IF;
  v_new := replace(v_new, $o9$    PERFORM public.fn_ca_declare_ledger('promo', 'promo_wallet', v_pool.club_id, NULL,
                                        'promo_rain:' || left(v_op_key, 180), ARRAY['clubs']);
$o9$, $n9$    PERFORM public.fn_ca_declare_ledger('promo', 'promo_wallet', v_pool.club_id, NULL,
                                        'promo_rain:' || left(v_op_key, 180), ARRAY['clubs']);
    PERFORM set_config('app.ledger_counterparty_label', 'clubs.promo_balance', true);
$n9$);
  IF md5(v_new) IS DISTINCT FROM 'f9379afc5c4f6ec712f0e854e4c09082' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_bbj_promo_payout_atomic';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_promo_disburse(text,uuid,text,uuid,numeric,text,uuid,uuid)'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o10$    PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', v_union, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['union_wallets']);
$o10$, ''))) / length($o10$    PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', v_union, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['union_wallets']);
$o10$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_promo_disburse'; END IF;
  v_new := replace(v_new, $o10$    PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', v_union, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['union_wallets']);
$o10$, $n10$    PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', v_union, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['union_wallets']);
    PERFORM set_config('app.ledger_counterparty_label', 'union_wallets.promo_wallet', true);
$n10$);
  v_n := (length(v_new) - length(replace(v_new, $o11$    PERFORM public.fn_ca_declare_ledger('promo', 'promo_wallet', v_club, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['clubs']);
$o11$, ''))) / length($o11$    PERFORM public.fn_ca_declare_ledger('promo', 'promo_wallet', v_club, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['clubs']);
$o11$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_promo_disburse'; END IF;
  v_new := replace(v_new, $o11$    PERFORM public.fn_ca_declare_ledger('promo', 'promo_wallet', v_club, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['clubs']);
$o11$, $n11$    PERFORM public.fn_ca_declare_ledger('promo', 'promo_wallet', v_club, NULL,
                                        'promo_disburse:' || v_op::text, ARRAY['clubs']);
    PERFORM set_config('app.ledger_counterparty_label', 'clubs.promo_balance', true);
$n11$);
  IF md5(v_new) IS DISTINCT FROM '54539cb4d66ffdcdacd85521e5fbb929' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_promo_disburse';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_union_bbj_backup_transfer(uuid,numeric,text,uuid,uuid,text)'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o12$  PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', p_union_id, NULL,
                                      'bbj_backup_to_promo:' || p_op_id::text, ARRAY['union_wallets']);
$o12$, ''))) / length($o12$  PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', p_union_id, NULL,
                                      'bbj_backup_to_promo:' || p_op_id::text, ARRAY['union_wallets']);
$o12$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_union_bbj_backup_transfer'; END IF;
  v_new := replace(v_new, $o12$  PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', p_union_id, NULL,
                                      'bbj_backup_to_promo:' || p_op_id::text, ARRAY['union_wallets']);
$o12$, $n12$  PERFORM public.fn_ca_declare_ledger('promo', 'union_wallet', p_union_id, NULL,
                                      'bbj_backup_to_promo:' || p_op_id::text, ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_counterparty_label', 'union_wallets.promo_wallet', true);
$n12$);
  IF md5(v_new) IS DISTINCT FROM '007ba53b1442b0e6f8215c8359c4633b' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_union_bbj_backup_transfer';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_union_promo_send(uuid,numeric,text,uuid,uuid,uuid,text)'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o13$    PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', p_union_id, NULL,
      'union_promo_to_club:' || p_op_id::text, ARRAY['union_wallets']);
$o13$, ''))) / length($o13$    PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', p_union_id, NULL,
      'union_promo_to_club:' || p_op_id::text, ARRAY['union_wallets']);
$o13$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_union_promo_send'; END IF;
  v_new := replace(v_new, $o13$    PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', p_union_id, NULL,
      'union_promo_to_club:' || p_op_id::text, ARRAY['union_wallets']);
$o13$, $n13$    PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', p_union_id, NULL,
      'union_promo_to_club:' || p_op_id::text, ARRAY['union_wallets']);
    PERFORM set_config('app.ledger_counterparty_label', 'union_wallets.promo_wallet', true);
$n13$);
  v_n := (length(v_new) - length(replace(v_new, $o14$  PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', p_union_id, NULL,
    'union_promo_to_bbj:' || p_op_id::text, ARRAY['union_wallets']);
$o14$, ''))) / length($o14$  PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', p_union_id, NULL,
    'union_promo_to_bbj:' || p_op_id::text, ARRAY['union_wallets']);
$o14$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_union_promo_send'; END IF;
  v_new := replace(v_new, $o14$  PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', p_union_id, NULL,
    'union_promo_to_bbj:' || p_op_id::text, ARRAY['union_wallets']);
$o14$, $n14$  PERFORM public.fn_ca_declare_ledger('promo_send', 'union_wallet', p_union_id, NULL,
    'union_promo_to_bbj:' || p_op_id::text, ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_counterparty_label', 'union_wallets.promo_wallet', true);
$n14$);
  IF md5(v_new) IS DISTINCT FROM '2681694e62f1b5f858245d011bf763c3' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_union_promo_send';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_union_fund_bbj_pool(uuid,numeric,numeric,numeric,numeric,text,uuid,uuid)'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o15$  PERFORM public.fn_ca_declare_ledger('transfer', 'union_wallet', p_union_id, NULL,
                                      CASE WHEN p_op_id IS NULL THEN NULL ELSE 'bbj_fund:' || p_op_id::text END, NULL);
$o15$, ''))) / length($o15$  PERFORM public.fn_ca_declare_ledger('transfer', 'union_wallet', p_union_id, NULL,
                                      CASE WHEN p_op_id IS NULL THEN NULL ELSE 'bbj_fund:' || p_op_id::text END, NULL);
$o15$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_union_fund_bbj_pool'; END IF;
  v_new := replace(v_new, $o15$  PERFORM public.fn_ca_declare_ledger('transfer', 'union_wallet', p_union_id, NULL,
                                      CASE WHEN p_op_id IS NULL THEN NULL ELSE 'bbj_fund:' || p_op_id::text END, NULL);
$o15$, $n15$  PERFORM public.fn_ca_declare_ledger('transfer', 'union_wallet', p_union_id, NULL,
                                      CASE WHEN p_op_id IS NULL THEN NULL ELSE 'bbj_fund:' || p_op_id::text END, NULL);
  PERFORM set_config('app.ledger_counterparty_label', 'union_wallets.chip_balance', true);
$n15$);
  IF md5(v_new) IS DISTINCT FROM '9f42e8cbfbec83827f34c2dc376954e1' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_union_fund_bbj_pool';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o16$  perform set_config('app.ledger_autoskip_union_wallets', '1', true);

  if p_kind = 'promo' then
$o16$, ''))) / length($o16$  perform set_config('app.ledger_autoskip_union_wallets', '1', true);

  if p_kind = 'promo' then
$o16$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_union_send_to_member_zd3core'; END IF;
  v_new := replace(v_new, $o16$  perform set_config('app.ledger_autoskip_union_wallets', '1', true);

  if p_kind = 'promo' then
$o16$, $n16$  perform set_config('app.ledger_autoskip_union_wallets', '1', true);
  perform set_config('app.ledger_counterparty_label',
                     case when p_kind = 'promo' then 'union_wallets.promo_wallet' else '' end, true);

  if p_kind = 'promo' then
$n16$);
  v_n := (length(v_new) - length(replace(v_new, $o17$  if v_source = 'chips' then
    update union_wallets set chip_balance = chip_balance - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(chip_balance, 0) >= p_amount
    returning chip_balance into v_after;
$o17$, ''))) / length($o17$  if v_source = 'chips' then
    update union_wallets set chip_balance = chip_balance - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(chip_balance, 0) >= p_amount
    returning chip_balance into v_after;
$o17$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_union_send_to_member_zd3core'; END IF;
  v_new := replace(v_new, $o17$  if v_source = 'chips' then
    update union_wallets set chip_balance = chip_balance - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(chip_balance, 0) >= p_amount
    returning chip_balance into v_after;
$o17$, $n17$  perform set_config('app.ledger_counterparty_label',
                     case v_source when 'chips' then 'union_wallets.chip_balance'
                                   when 'rake' then 'union_wallets.rake_wallet'
                                   else 'union_wallets.promo_wallet' end, true);
  if v_source = 'chips' then
    update union_wallets set chip_balance = chip_balance - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(chip_balance, 0) >= p_amount
    returning chip_balance into v_after;
$n17$);
  IF md5(v_new) IS DISTINCT FROM 'fcb71e70f696bed13717951c73f0eb98' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_union_send_to_member_zd3core';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o18$    PERFORM set_config('app.ledger_counterparty', 'union_wallet', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_union_id::text, true);
$o18$, ''))) / length($o18$    PERFORM set_config('app.ledger_counterparty', 'union_wallet', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_union_id::text, true);
$o18$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_union_settle_player_pnl'; END IF;
  v_new := replace(v_new, $o18$    PERFORM set_config('app.ledger_counterparty', 'union_wallet', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_union_id::text, true);
$o18$, $n18$    PERFORM set_config('app.ledger_counterparty', 'union_wallet', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_union_id::text, true);
    PERFORM set_config('app.ledger_counterparty_label', 'union_wallets.chip_balance', true);
$n18$);
  v_n := (length(v_new) - length(replace(v_new, $o19$    PERFORM set_config('app.ledger_autoskip_union_wallets',COALESCE(v_prior_ledger->>'autoskip',''),true);
$o19$, ''))) / length($o19$    PERFORM set_config('app.ledger_autoskip_union_wallets',COALESCE(v_prior_ledger->>'autoskip',''),true);
$o19$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_union_settle_player_pnl'; END IF;
  v_new := replace(v_new, $o19$    PERFORM set_config('app.ledger_autoskip_union_wallets',COALESCE(v_prior_ledger->>'autoskip',''),true);
$o19$, $n19$    PERFORM set_config('app.ledger_autoskip_union_wallets',COALESCE(v_prior_ledger->>'autoskip',''),true);
    PERFORM set_config('app.ledger_counterparty_label','',true);
$n19$);
  IF md5(v_new) IS DISTINCT FROM '978f2d1df3a8c1b0865776a6ff108dae' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_union_settle_player_pnl';
  END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'::regprocedure);
  v_new := v_def;
  v_n := (length(v_new) - length(replace(v_new, $o20$    PERFORM set_config('app.ledger_counterparty',
      CASE WHEN v_kind = 'union' THEN 'union_wallet' ELSE 'club_treasury' END, true);
$o20$, ''))) / length($o20$    PERFORM set_config('app.ledger_counterparty',
      CASE WHEN v_kind = 'union' THEN 'union_wallet' ELSE 'club_treasury' END, true);
$o20$);
  IF v_n <> 1 THEN RAISE EXCEPTION 'UNION_SIDE_LABEL_PREIMAGE_CHANGED: fn_spin_settle_game'; END IF;
  v_new := replace(v_new, $o20$    PERFORM set_config('app.ledger_counterparty',
      CASE WHEN v_kind = 'union' THEN 'union_wallet' ELSE 'club_treasury' END, true);
$o20$, $n20$    PERFORM set_config('app.ledger_counterparty',
      CASE WHEN v_kind = 'union' THEN 'union_wallet' ELSE 'club_treasury' END, true);
    PERFORM set_config('app.ledger_counterparty_label',
      CASE WHEN v_kind = 'union' THEN 'union_wallets.' || v_wallet ELSE '' END, true);
$n20$);
  IF md5(v_new) IS DISTINCT FROM 'b23d00581f4f577d345c0319f928653f' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED: fn_spin_settle_game';
  END IF;
  EXECUTE v_new;

END
$patch$;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_autoledger', 'migration 20261004144116_a_union_wallet_side_names_its_column_on_the_live_readers');

-- 4. A bare union wallet side cannot be written.
ALTER TABLE public.chip_ledger
  ADD CONSTRAINT chip_ledger_a_union_wallet_side_names_its_column CHECK (
    (from_type IS DISTINCT FROM 'union_wallet'
       OR from_label IS NOT NULL
       OR COALESCE(to_label, '') LIKE '%promo%'
       OR (COALESCE(category, '') = 'correction'
           AND COALESCE(metadata ->> 'posted_via', '') = 'fn_ca_post_correction'))
    AND
    (to_type IS DISTINCT FROM 'union_wallet'
       OR to_label IS NOT NULL
       OR COALESCE(from_label, '') LIKE '%promo%'
       OR (COALESCE(category, '') = 'correction'
           AND COALESCE(metadata ->> 'posted_via', '') = 'fn_ca_post_correction'))
  ) NOT VALID;
COMMENT ON CONSTRAINT chip_ledger_a_union_wallet_side_names_its_column ON public.chip_ledger IS
  'A union_wallets row holds six balances, so a union_wallet side of a leg names the one that moved (from_label / to_label), unless the other side names a promo bank or the leg is a journal-only correction. Without it the ledger replay cannot key the leg: 1,489,358.47 of rake payments read as kill-switch drift on 2026-10-04. NOT VALID: legs written before 2026-10-04 are kept as they are.';

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])'::regprocedure)) IS DISTINCT FROM '2eb458ce27b0116d2f7ad4603ca719dd'
     OR md5(pg_get_functiondef('public.fn_ca_autoledger()'::regprocedure)) IS DISTINCT FROM '852f2e9b202459d7450407b71b7cb6f8'
     OR md5(pg_get_functiondef('public.fn_ca_ledger_declaration_save(text[])'::regprocedure)) IS DISTINCT FROM 'a11c4a4d59384037d4fdc62a1c9ba899'
     OR md5(pg_get_functiondef('public.fn_ca_ledger_declaration_restore(jsonb)'::regprocedure)) IS DISTINCT FROM 'ead8093832ebe1845217bbe91ba81361'
     OR md5(pg_get_functiondef('public.fn_bbj_promo_payout_atomic(uuid,numeric,uuid[],text,text)'::regprocedure)) IS DISTINCT FROM 'f9379afc5c4f6ec712f0e854e4c09082'
     OR md5(pg_get_functiondef('public.fn_promo_disburse(text,uuid,text,uuid,numeric,text,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '54539cb4d66ffdcdacd85521e5fbb929'
     OR md5(pg_get_functiondef('public.fn_union_bbj_backup_transfer(uuid,numeric,text,uuid,uuid,text)'::regprocedure)) IS DISTINCT FROM '007ba53b1442b0e6f8215c8359c4633b'
     OR md5(pg_get_functiondef('public.fn_union_promo_send(uuid,numeric,text,uuid,uuid,uuid,text)'::regprocedure)) IS DISTINCT FROM '2681694e62f1b5f858245d011bf763c3'
     OR md5(pg_get_functiondef('public.fn_union_fund_bbj_pool(uuid,numeric,numeric,numeric,numeric,text,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '9f42e8cbfbec83827f34c2dc376954e1'
     OR md5(pg_get_functiondef('public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)'::regprocedure)) IS DISTINCT FROM 'fcb71e70f696bed13717951c73f0eb98'
     OR md5(pg_get_functiondef('public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure)) IS DISTINCT FROM '978f2d1df3a8c1b0865776a6ff108dae'
     OR md5(pg_get_functiondef('public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'::regprocedure)) IS DISTINCT FROM 'b23d00581f4f577d345c0319f928653f'
     OR md5(pg_get_functiondef('public.fn_ca_leg_accounts(timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM '2bce91eca31c328175d430f78273ab76'
     OR md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure)) IS DISTINCT FROM '7aaf8013079ea67adfc18a26691bf8a6'
     OR md5(pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure)) IS DISTINCT FROM '0aa811df7bbdb1716dec7f6793c1f42e'
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.chip_ledger'::regclass
                     AND conname = 'chip_ledger_a_union_wallet_side_names_its_column' AND NOT convalidated) THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_RESULT_CHANGED';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[])'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_declare_ledger';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_autoledger()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_autoledger';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_ledger_declaration_save(text[])'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_ledger_declaration_save';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_ledger_declaration_restore(jsonb)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_ledger_declaration_restore';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_bbj_promo_payout_atomic(uuid,numeric,uuid[],text,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_bbj_promo_payout_atomic';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_promo_disburse(text,uuid,text,uuid,numeric,text,uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_promo_disburse';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_bbj_backup_transfer(uuid,numeric,text,uuid,uuid,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_union_bbj_backup_transfer';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_promo_send(uuid,numeric,text,uuid,uuid,uuid,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_union_promo_send';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_fund_bbj_pool(uuid,numeric,numeric,numeric,numeric,text,uuid,uuid)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_union_fund_bbj_pool';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_send_to_member_zd3core(uuid,uuid,text,numeric,text,text)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_union_send_to_member_zd3core';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_union_settle_player_pnl';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_spin_settle_game(uuid,uuid,numeric,integer,numeric,numeric)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_spin_settle_game';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_leg_accounts(timestamptz,timestamptz)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_leg_accounts';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_leg_accounts_since_snapshot';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'UNION_SIDE_LABEL_AUTHORITY_CHANGED: fn_ca_leg_accounts_since_snapshot_for';
  END IF;
END
$post$;

COMMIT;
