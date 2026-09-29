
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
-- Engine-path stub, the twin of auth.uid() above. fn_caller_is_engine reads
-- COALESCE(auth.role(),'service_role')='service_role', so NULL here is the
-- no-PostgREST-request context this probe runs in: psql, pg_cron, a
-- migration - the engine path, which is the path these money functions are
-- exercised on. Added when fn_cash_earning_club was finally declared in a
-- migration and joined the authoritative closure, bringing its caller guard
-- with it.
-- CREATE OR REPLACE, not CREATE: test_rebuy_receipts.py re-runs this whole
-- fixture against an already-bootstrapped database, neutralising only
-- 'CREATE SCHEMA auth;' and 'CREATE FUNCTION auth.uid()' by string
-- replacement. A plain CREATE here collides on that second pass with
-- 42723 function "role" already exists.
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS 'SELECT NULL::text';
CREATE TABLE chip_ledger(id uuid DEFAULT gen_random_uuid(), performed_by uuid,from_type text,from_entity_id uuid,from_label text,to_type text,to_entity_id uuid,to_label text,amount numeric CHECK(amount>0),category text,club_id uuid,union_id uuid,table_id uuid,hand_id uuid,tournament_id uuid,description text,pre_from_balance numeric,post_from_balance numeric,pre_to_balance numeric,post_to_balance numeric,idempotency_key text UNIQUE,metadata jsonb,created_at timestamptz DEFAULT now());
-- Read by fn_lock_cash_bank_accounting_week, which atomic_distribute_rake
-- reaches once this branch's rewrite of it lands. Empty is the honest state
-- for this probe: no agreement change has been captured for the fixture's
-- club, which is the ordinary case, and this probe is about the chip journal
-- surviving failure and replay rather than about agreement terms.
CREATE TABLE accounting_agreement_history(id bigint, entity_type text, entity_key text, club_id uuid, subject_user_id uuid, event_type text, observed_at timestamptz, transaction_id bigint, actor_id uuid, before_terms jsonb, after_terms jsonb, union_id uuid);
CREATE TABLE ca_ledger_write_failures(club_id uuid,user_id uuid,delta numeric,sqlstate text,message text);
CREATE TABLE clubs(id uuid PRIMARY KEY,name text,union_id uuid,chip_treasury numeric DEFAULT 100,total_rake numeric DEFAULT 0,updated_at timestamptz,asset text NOT NULL DEFAULT 'chips');
CREATE TABLE bbj_pools(id uuid PRIMARY KEY,club_id uuid,main_balance numeric DEFAULT 100,backup_balance numeric DEFAULT 10,promo_balance numeric DEFAULT 5);
CREATE TABLE club_members(id uuid PRIMARY KEY,user_id uuid,club_id uuid,chip_balance numeric DEFAULT 100);
CREATE TABLE tables(id uuid PRIMARY KEY,club_id uuid,min_buy_in numeric,max_buy_in numeric,is_private boolean DEFAULT true,union_id uuid,tournament_id uuid,is_template boolean DEFAULT false,current_players integer DEFAULT 0,updated_at timestamptz DEFAULT now());
CREATE TABLE table_seats(table_id uuid,user_id uuid,seat_number int,stack numeric,is_sitting_out boolean,left_at timestamptz,id uuid DEFAULT gen_random_uuid(),joined_at timestamptz DEFAULT now(),club_id uuid,status text DEFAULT 'active',is_away boolean DEFAULT false,leave_pending boolean DEFAULT false,scheduled_leave_hands integer DEFAULT 0,sit_out_at timestamptz,occupancy_id uuid NOT NULL DEFAULT gen_random_uuid(),UNIQUE(table_id,user_id),UNIQUE(table_id,seat_number));
CREATE TABLE chip_transactions(id uuid,club_id uuid,from_user_id uuid,to_user_id uuid,amount numeric,transaction_type text,notes text,balance_after numeric,created_at timestamptz);
CREATE TABLE cash_baselines(user_id uuid,table_id uuid,amount numeric);
CREATE TABLE engine_maintenance_break(
 id boolean PRIMARY KEY DEFAULT true,
 phase text NOT NULL,
 announced_at timestamptz NOT NULL,
 break_ends_at timestamptz,
 enforce_freeze boolean NOT NULL DEFAULT true
);
CREATE TABLE entry_purchase_idempotency_receipts(
 key_domain text NOT NULL,
 idempotency_key text NOT NULL,
 request jsonb NOT NULL,
 response jsonb,
 claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 completed_at timestamptz,
 CONSTRAINT entry_purchase_idempotency_receipts_pkey
  PRIMARY KEY(key_domain,idempotency_key),
 CONSTRAINT entry_purchase_idempotency_receipts_domain_nonempty
  CHECK (length(btrim(key_domain)) > 0),
 CONSTRAINT entry_purchase_idempotency_receipts_key_nonempty
  CHECK (length(btrim(idempotency_key)) > 0)
);
CREATE FUNCTION fn_actor_can_manage_club_treasury(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION fn_cash_rejoin_floor(uuid,uuid) RETURNS numeric LANGUAGE sql AS 'SELECT NULL::numeric';
CREATE FUNCTION fn_cash_session_open(uuid,uuid,numeric) RETURNS void LANGUAGE sql AS 'INSERT INTO cash_baselines VALUES($1,$2,$3)';
CREATE FUNCTION fn_cash_session_add_baseline(uuid,uuid,numeric) RETURNS void LANGUAGE sql AS 'INSERT INTO cash_baselines VALUES($1,$2,$3)';
CREATE TABLE hand_history(id uuid,table_id uuid,hand_number int,created_at timestamptz);
CREATE TABLE tournaments(id uuid,is_private boolean,union_id uuid,status text,prize_pool_finalized boolean,current_level integer,late_reg_levels integer,rebuy_levels integer,late_reg_mins integer,started_at timestamptz,max_players integer);
CREATE TABLE tournament_players(id uuid DEFAULT gen_random_uuid(), tournament_id uuid,user_id uuid,username text,chips numeric,status text,is_satellite_qualifier boolean,source_satellite_id uuid,current_bounty numeric DEFAULT 0,UNIQUE(tournament_id,user_id));
CREATE TABLE rake_records(id uuid DEFAULT gen_random_uuid(),hand_id uuid,table_id uuid,club_id uuid,rake_amount numeric,bbj_contribution numeric,pot_size numeric,num_players int,player_contributions jsonb,is_tournament boolean,tournament_id uuid,source text,metadata jsonb,rake_method text,returned_uncalled jsonb,created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX rake_hand ON rake_records(hand_id) WHERE hand_id IS NOT NULL;
CREATE TABLE rake_distribution_legs(leg_key uuid,leg text,club_id uuid,union_id uuid,amount numeric,UNIQUE(leg_key,leg));
CREATE TABLE club_wallets(club_id uuid PRIMARY KEY,chip_balance numeric DEFAULT 0,period_rake_collected numeric DEFAULT 0,period_bbj_contribution numeric DEFAULT 0,lifetime_rake_collected numeric DEFAULT 0,lifetime_bbj_contribution numeric DEFAULT 0,updated_at timestamptz);
CREATE TABLE club_wallet_transactions(club_id uuid,type text,amount numeric,balance_after numeric,related_id uuid,reason text);
CREATE TABLE union_wallets(union_id uuid PRIMARY KEY,chip_balance numeric,rake_wallet numeric,total_rake_collected numeric,updated_at timestamptz);
CREATE TABLE union_wallet_transactions(union_id uuid,club_id uuid,amount numeric,tx_type text,wallet text,direction text,balance_after numeric,notes text);
CREATE FUNCTION injected_journal_failure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fault text:=current_setting('test.journal_sqlstate',true);
BEGIN
 IF COALESCE(fault,'')<>'' THEN RAISE EXCEPTION 'injected journal failure' USING ERRCODE=fault; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fault BEFORE INSERT ON chip_ledger FOR EACH ROW EXECUTE FUNCTION injected_journal_failure();

-- Journal-only fixtures omit escrow; test_satellite_split.py exercises the real escrow.
-- The earning-club reader, stubbed. This probe is about chip-journal
-- atomicity - that a ledger write survives failure and replay - not about
-- which club a seat earned for. The real fn_cash_earning_club resolves that
-- from table_seats against the hand's start and drags accounting tables this
-- fixture has no reason to carry. Naming it here stops the closure walker at
-- this boundary, the same way auth.uid() and auth.role() are stopped above.
-- The ordinary answer is the club that hosted the hand.
CREATE FUNCTION public.fn_cash_earning_club(p_hand_id uuid, p_table_id uuid, p_player_id uuid, p_source_club uuid, p_union_id uuid)
  RETURNS uuid LANGUAGE sql AS 'SELECT $4';

-- The weekly accounting lane, stubbed at the fixture boundary. The real
-- fn_lock_cash_bank_accounting_week reads the accounting agreement and routed
-- settlement tables, and each one this fixture adds only reveals the next:
-- accounting_agreement_history, then accounting_routed_settlement_runs. That
-- whole subsystem is not what this probe proves. Naming the function here
-- stops the closure walker at it, the same way auth.uid() and auth.role() are
-- stopped above, and leaves the probe on its actual subject: a chip-journal
-- write surviving failure and replay. The lane's own lock mode is guarded by
-- scripts/ci/check-accounting-week-lock-mode.mjs and proved by
-- scripts/ci/test-accounting-week-lane-shared.py.
CREATE FUNCTION public.fn_lock_cash_bank_accounting_week(p_club_id uuid, p_game_union_id uuid, p_banked_at timestamptz)
  RETURNS void LANGUAGE sql AS 'SELECT NULL::void';

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric DEFAULT 0, p_fee_entries_in numeric DEFAULT 0, p_satellite_fee_in numeric DEFAULT 0, p_bounty_in numeric DEFAULT 0, p_overlay_in numeric DEFAULT 0, p_satellite_in numeric DEFAULT 0, p_prize_out numeric DEFAULT 0, p_bounty_out numeric DEFAULT 0, p_fee_out numeric DEFAULT 0, p_refund numeric DEFAULT 0, p_reserve_out numeric DEFAULT 0, p_reserve_in numeric DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ BEGIN RETURN; END; $function$;

-- The cash-rake bank receipt, the attribution rows and the credit allocator.
-- Two tables are deliberately NOT added here, because other probes
-- concatenate this fixture with their own DDL and a duplicate CREATE
-- aborts them: financial_alerts (test_satellite.py and
-- satellite-split-fixture.sql each create their own) and
-- rake_attributions (tests/fixtures/cash-participant-funding/bootstrap.sql
-- creates it, and scripts/dev/probe-cash-participant-funding.py loads that
-- straight after this file).
-- These are NOT boundary stubs. atomic_distribute_rake writes all three inside
-- the same transaction as the chip-journal leg, so they are part of what this
-- probe proves: if the receipt insert fails, the ledger write must roll back
-- with it. Stubbing them away would remove the failure this probe exists to
-- catch. Column shapes are production's, read from pg_attribute on
-- 2026-09-29, so a column the function writes cannot be silently absent.
CREATE TABLE public.accounting_cash_bank_receipts(
  rake_record_id uuid,
  union_id uuid,
  club_id uuid,
  union_transaction_id uuid,
  club_ledger_id uuid,
  banked_at timestamptz,
  amount numeric
);



-- The credit allocator, carried VERBATIM from production rather than stubbed.
-- It is pure SQL over jsonb and arithmetic with no table dependencies, so the
-- real body costs the fixture nothing and cannot drift from the rounding the
-- attribution rows are asserted on. A stub returning invented credits would
-- make those assertions measure the stub.
CREATE FUNCTION public.fn_allocate_rake_credits(p_amount numeric, p_contributions jsonb, p_method text)
RETURNS TABLE(user_id uuid, credit numeric, weight numeric)
LANGUAGE sql AS $fn$
  WITH c AS (
    SELECT (k.key)::uuid AS uid,
           round((k.value)::numeric * 100)::bigint AS cc
      FROM jsonb_each(COALESCE(p_contributions, '{}'::jsonb)) k
     WHERE jsonb_typeof(k.value) = 'number'
       AND (k.value)::numeric > 0
       AND k.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ),
  t AS (
    SELECT COALESCE(SUM(cc), 0)::bigint AS total,
           round(GREATEST(COALESCE(p_amount, 0), 0) * 100)::bigint AS amt,
           COUNT(*)::bigint AS n
      FROM c
  ),
  weighted AS (
    SELECT c.uid, c.cc,
           (t.amt * c.cc) / t.total AS fl,
           (t.amt * c.cc) % t.total AS rem,
           t.amt, t.total
      FROM c CROSS JOIN t
     WHERE t.total > 0
  ),
  weighted_ranked AS (
    SELECT w.*,
           row_number() OVER (ORDER BY w.rem DESC, w.uid ASC) AS rn,
           SUM(w.fl) OVER () AS fl_sum
      FROM weighted w
  ),
  equal_ranked AS (
    SELECT c.uid, c.cc, t.amt, t.total, t.n,
           row_number() OVER (ORDER BY c.uid ASC) AS rn
      FROM c CROSS JOIN t
     WHERE t.n > 0
  )
  SELECT uid,
         ((fl + CASE WHEN rn <= (amt - fl_sum) THEN 1 ELSE 0 END)::numeric / 100),
         round(cc::numeric / total, 8)
    FROM weighted_ranked
   WHERE COALESCE(p_method, 'WEIGHTED_CONTRIBUTED') = 'WEIGHTED_CONTRIBUTED'
  UNION ALL
  SELECT uid,
         (((amt / n) + CASE WHEN rn <= (amt % n) THEN 1 ELSE 0 END)::numeric / 100),
         round(cc::numeric / total, 8)
    FROM equal_ranked
   WHERE COALESCE(p_method, 'WEIGHTED_CONTRIBUTED') = 'DEALT_EQUAL';
$fn$;
