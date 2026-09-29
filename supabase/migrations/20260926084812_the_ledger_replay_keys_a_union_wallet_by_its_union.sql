-- 20260926084812_the_ledger_replay_keys_a_union_wallet_by_its_union.sql
--
-- THE LEDGER REPLAY KEYS A UNION WALLET BY ITS UNION (2026-09-26)
--
-- THE FINDING. drift_incident:fn_ca_ledger_replay carried four open alerts,
-- the newest "ledger_imbalance drift -234.10 chips" on 2026-09-22 06:40. The
-- replay runs every night at 06:40 (cron ca-ledger-replay-nightly, jobid 286):
-- it failed 09-17..09-19 on "record w is not assigned yet", has succeeded every
-- night since 09-20, and on 09-26 checked 877 accounts with 0 disagreeing. So
-- the silence since 09-22 is not a stopped checker. It is also not a fix.
--
-- -109.14 (09-20 -> 09-21) and -234.10 (09-21 -> 09-22), both on
-- union_wallet:fade0000...:union_wallets.promo_wallet, are EXACTLY the Diamond
-- game prizes the Midway Union promo wallet paid in those intervals:
--   09-20 -> 09-21  crash 1.00+6.34, crossing 72.50, mines 0.20+0.10,
--                   wheel 3.00+25.00+1.00                        = 109.14
--   09-21 -> 09-22  plinko 38.80+102.90+1.40, crash 5.00+2.00+0.10,
--                   wheel 75.00+1.00+1.00+1.00, mines 5.00+0.20+0.10,
--                   crossing 0.20+0.20+0.20                      = 234.10
-- The replay's own readings close with them to the cent:
--   journal 369.21 - 109.14 = 260.07 = moved;  124.15 - 234.10 = -109.95 = moved.
-- No chip is missing. The prizes stopped after 09-22 00:30, which is why the
-- account has read 0.00 unexplained every night since.
--
-- THE DEFECT. fn_ca_autoledger stamps a union_wallets leg with the wallet ROW
-- id (union_wallets.id 059bb325-6eeb-4bbd-957d-3a82e755bb0c), while a payer
-- that declares its counterparty (the BBJ promo sweep) stamps the UNION id
-- (fade0000-0000-0000-0000-000000000001), and fn_ca_account_balance reads
-- union_wallets by union_id. fn_ca_leg_accounts keyed the account by whatever
-- id the leg carried, so one wallet became two accounts: the union-id half was
-- judged WITHOUT the row-id legs (the drift above), and the row-id half could
-- never be read and was silently skipped. That second half is every autoledgered
-- movement of the union bank, rake, promo, BBJ, insurance and spin-reserve
-- wallets: the union's whole rake wallet (3.1M chips) has never been replayed.
-- It recurs the moment the Diamond games pay again.
--
-- THE FIX. Both leg readers key union_wallet and union_bank legs by
-- union_wallets.union_id when the leg names a wallet row, exactly as the
-- 2026-09-06 fix keyed every other account "by what owns the chips". The
-- balance reader already reads by union_id and is unchanged. Accounts never
-- read before (the union rake wallet among them) are baselined on their first
-- reading and judged from the next, as the replay already does for any new key.
--
-- THE -2,624.78 / +2,624.78 PAIR (09-21, club_treasury 2a1132b9 and
-- spin_reserve 01810895) is the journal-only repair leg 0eb0f833 posted at
-- 01:05:15 by migration 20260921005621_spin_seed_return_journal_leg_and_
-- nondestructive_declaration: it journaled a spin-seed return whose balances
-- had moved earlier with no leg (treasury_error incident c4261d89, +2,624.78).
-- A journal-only restatement moves no balance, so the next reading of each side
-- disagreed by exactly the leg, once, in opposite signs, netting 0.00. Both
-- accounts have read 0.00 unexplained on every reading since.
--
-- DISCIPLINE: pre-image md5/owner/ACL/proconfig/prosecdef/provolatile guards;
-- one transaction; post-image assertions; explicit service_role grant.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $pre$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS h, p.proowner::regrole::text AS own,
           p.proacl::text AS acl, p.proconfig::text AS cfg, p.prosecdef, p.provolatile
      FROM pg_proc p
     WHERE p.oid IN ('public.fn_ca_leg_accounts(timestamptz,timestamptz)'::regprocedure,
                     'public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure)
  LOOP
    IF r.h NOT IN ('5f1a5e9507b9c9c11ae61b41fd842eaa', '05378ace9b11c3200a060458460d6f57')
       OR (r.sig LIKE '%since_snapshot%') <> (r.h = '05378ace9b11c3200a060458460d6f57') THEN
      RAISE EXCEPTION 'union-wallet keying pre-image: % md5 is %, not the definition this migration was written against', r.sig, r.h;
    END IF;
    IF r.own <> 'postgres' OR r.acl <> '{postgres=X/postgres,service_role=X/postgres}'
       OR r.cfg <> '{search_path=public}' OR r.prosecdef IS NOT TRUE OR r.provolatile <> 's' THEN
      RAISE EXCEPTION 'union-wallet keying pre-image: % owner/acl/config/secdef/volatility drifted (%, %, %, %, %)',
        r.sig, r.own, r.acl, r.cfg, r.prosecdef, r.provolatile;
    END IF;
  END LOOP;
END
$pre$;

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

CREATE OR REPLACE FUNCTION public.fn_ca_leg_accounts_since_snapshot(p_prev_at timestamp with time zone, p_prev_snapshot pg_snapshot)
 RETURNS TABLE(account_key text, account_type text, entity_id uuid, club_id uuid, column_name text, net numeric, legs bigint, unkeyable bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH sides AS (
    SELECT l.to_type AS t, l.to_entity_id AS id, l.to_label AS lbl, l.from_label AS other_lbl, l.amount AS amt
      FROM public.chip_ledger l
     WHERE l.created_at > p_prev_at - interval '15 minutes'
       AND NOT pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), p_prev_snapshot)
       AND l.to_entity_id IS NOT NULL
    UNION ALL
    SELECT l.from_type, l.from_entity_id, l.from_label, l.to_label, -l.amount
      FROM public.chip_ledger l
     WHERE l.created_at > p_prev_at - interval '15 minutes'
       AND NOT pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), p_prev_snapshot)
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

REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_leg_accounts_since_snapshot(timestamptz, pg_snapshot) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts(timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_leg_accounts_since_snapshot(timestamptz, pg_snapshot) TO service_role;

DO $post$
DECLARE
  r record; v_split int; v_row numeric; v_union numeric; v_after numeric;
  c_probe_from CONSTANT timestamptz := '2026-09-21 18:00:00+00';
  c_probe_to   CONSTANT timestamptz := '2026-09-21 19:00:00+00';
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, p.prosrc, p.proowner::regrole::text AS own,
           p.proacl::text AS acl, p.proconfig::text AS cfg, p.prosecdef, p.provolatile
      FROM pg_proc p
     WHERE p.oid IN ('public.fn_ca_leg_accounts(timestamptz,timestamptz)'::regprocedure,
                     'public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure)
  LOOP
    IF position('WHEN s.t IN (''union_wallet'', ''union_bank'')' IN r.prosrc) = 0
       OR position('SELECT w.union_id FROM public.union_wallets w WHERE w.id = s.id' IN r.prosrc) = 0
       OR position('OR EXISTS (SELECT 1 FROM public.union_wallets w WHERE w.id = s.id)' IN r.prosrc) = 0 THEN
      RAISE EXCEPTION 'union-wallet keying post-image: % does not carry the union keying', r.sig;
    END IF;
    IF r.own <> 'postgres' OR r.acl <> '{postgres=X/postgres,service_role=X/postgres}'
       OR r.cfg <> '{search_path=public}' OR r.prosecdef IS NOT TRUE OR r.provolatile <> 's' THEN
      RAISE EXCEPTION 'union-wallet keying post-image: % owner/acl/config/secdef/volatility is (%, %, %, %, %)',
        r.sig, r.own, r.acl, r.cfg, r.prosecdef, r.provolatile;
    END IF;
  END LOOP;

  -- Behaviour, on the hour of 09-21 that carried 225.10 of promo prizes: no
  -- account is keyed by a wallet row any more, and the union's promo account
  -- now carries exactly the legs its two halves carried between them.
  SELECT count(*) INTO v_split FROM public.fn_ca_leg_accounts(c_probe_from, c_probe_to) a
   WHERE a.entity_id IN (SELECT w.id FROM public.union_wallets w);
  IF v_split <> 0 THEN
    RAISE EXCEPTION 'union-wallet keying post-image: % account(s) are still keyed by a union_wallets row', v_split;
  END IF;
  SELECT COALESCE(sum(CASE WHEN l.to_type = 'union_wallet' AND l.to_entity_id = w.id THEN l.amount
                           WHEN l.from_type = 'union_wallet' AND l.from_entity_id = w.id THEN -l.amount END), 0),
         COALESCE(sum(CASE WHEN l.to_type = 'union_wallet' AND l.to_entity_id = w.union_id THEN l.amount
                           WHEN l.from_type = 'union_wallet' AND l.from_entity_id = w.union_id THEN -l.amount END), 0)
    INTO v_row, v_union
    FROM public.chip_ledger l
    JOIN public.union_wallets w ON w.union_id = 'fade0000-0000-0000-0000-000000000001'
   WHERE l.created_at > c_probe_from AND l.created_at <= c_probe_to
     AND ((l.from_type = 'union_wallet' AND l.from_label = 'union_wallets.promo_wallet')
       OR (l.to_type = 'union_wallet' AND COALESCE(l.to_label, CASE WHEN l.from_label LIKE '%promo%' THEN 'union_wallets.promo_wallet' END) = 'union_wallets.promo_wallet'));
  SELECT a.net INTO v_after FROM public.fn_ca_leg_accounts(c_probe_from, c_probe_to) a
   WHERE a.account_key = 'union_wallet:fade0000-0000-0000-0000-000000000001:union_wallets.promo_wallet';
  IF v_row >= 0 OR round(COALESCE(v_after, 0), 2) <> round(v_row + v_union, 2) THEN
    RAISE EXCEPTION 'union-wallet keying post-image: promo account reads % where its halves carry % + %', v_after, v_row, v_union;
  END IF;
  RAISE NOTICE 'union-wallet keying: promo 09-21 18:00-19:00 row-keyed %, union-keyed %, merged %', v_row, v_union, v_after;
END
$post$;

-- The four replay alerts, each with its receipt.
UPDATE public.financial_alerts
   SET resolved = true, resolved_at = now(), resolved_by = '2d1cd6c3-5700-4af9-a271-d4863fdab20d',
       resolution = CASE id
         WHEN '4aa2d9b1-8e41-42bc-98db-c25fc2f9a801' THEN
           'Explained to the cent, and its cause fixed by migration 20260926084812_the_ledger_replay_keys_a_union_wallet_by_its_union. The promo wallet moved +260.07 while the union-keyed journal said +369.21; the 109.14 between them is the eight Diamond game prizes it paid (crash 1.00+6.34, crossing 72.50, mines 0.20+0.10, wheel 3.00+25.00+1.00), journaled under the wallet ROW id 059bb325 by fn_ca_autoledger and so keyed into a second account the replay could never read. 369.21 - 109.14 = 260.07. No chip missing; the replay now keys every union_wallets leg by its union.'
         WHEN 'fcd6e42b-3860-415e-812f-7c94b3f13766' THEN
           'Explained to the cent, and its cause fixed by migration 20260926084812_the_ledger_replay_keys_a_union_wallet_by_its_union. The promo wallet moved -109.95 while the union-keyed journal said +124.15; the 234.10 between them is the sixteen Diamond game prizes it paid (plinko 38.80+102.90+1.40, crash 5.00+2.00+0.10, wheel 75.00+1.00+1.00+1.00, mines 5.00+0.20+0.10, crossing 0.20+0.20+0.20), journaled under the wallet ROW id 059bb325 and keyed into an account the replay could never read. 124.15 - 234.10 = -109.95. No chip missing. The account has read 0.00 unexplained every night since because the games paid nothing after 09-22 00:30; it would have recurred on their next prize, and now cannot.'
         WHEN '010060a5-c057-4e64-9851-49e05beff2f6' THEN
           'Not drift. The -2,624.78 on the Deep Stack Society treasury is one leg, 0eb0f833 (treasury_transfer spin_reserve 01810895 -> club_treasury 2a1132b9, 2,624.78, 2026-09-21 01:05:15), posted JOURNAL-ONLY by migration 20260921005621 to record a spin-seed return whose balances had already moved with no leg (incident c4261d89, stored treasury 2,624.78 above the journal). A journal-only restatement moves no balance, so the next reading of each side disagreed by exactly that leg, once. Its mirror f50a19cf reads +2,624.78 on the spin reserve; the pair nets 0.00, and both accounts have read 0.00 unexplained on every reading since (checked through 2026-09-26 06:43). Closed with migration 20260926084812.'
         WHEN 'f50a19cf-860c-47a1-8733-9e162cbd4379' THEN
           'Not drift. The +2,624.78 on spin reserve 01810895 is the other side of journal-only repair leg 0eb0f833 (migration 20260921005621, 2026-09-21 01:05:15), which recorded a spin-seed return to the Deep Stack Society treasury whose balances had moved earlier with no leg. The leg moved no balance, so this reading disagreed by exactly it, once; its mirror 010060a5 reads -2,624.78 on the treasury, netting 0.00. Both accounts have read 0.00 unexplained on every reading since. Closed with migration 20260926084812.'
       END
 WHERE source = 'drift_incident:fn_ca_ledger_replay'
   AND resolved IS NOT TRUE
   AND id IN ('4aa2d9b1-8e41-42bc-98db-c25fc2f9a801', 'fcd6e42b-3860-415e-812f-7c94b3f13766',
              '010060a5-c057-4e64-9851-49e05beff2f6', 'f50a19cf-860c-47a1-8733-9e162cbd4379');

COMMIT;
