CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role BYPASSRLS;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
CREATE FUNCTION public.fn_is_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.fn_is_union_overseer(uuid,uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.fn_ca_house_board_allows_automation(uuid) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$;
CREATE FUNCTION public.fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$ SELECT coalesce(current_setting('test.frozen',true),'')='1' $$;
CREATE TABLE public.clubs (id uuid PRIMARY KEY,name text NOT NULL, owner_id uuid,chip_treasury numeric(20,2) NOT NULL DEFAULT 0 CHECK(chip_treasury>=0),updated_at timestamptz DEFAULT now());
CREATE TABLE public.tables(id uuid PRIMARY KEY,tournament_id uuid);
CREATE TABLE public.table_seats(table_id uuid,user_id uuid,club_id uuid,joined_at timestamptz DEFAULT now());
CREATE TABLE public.agents (
id uuid DEFAULT gen_random_uuid() NOT NULL,
user_id uuid NOT NULL,
club_id uuid NOT NULL,
membership_id uuid,
role text NOT NULL,
status text DEFAULT 'active'::text NOT NULL,
parent_agent_id uuid,
commission_rate numeric(5,4) NOT NULL,
player_rakeback_rate numeric(5,4) NOT NULL,
credit_limit numeric(15,2) DEFAULT 0 NOT NULL,
credit_used numeric(15,2) DEFAULT 0 NOT NULL,
is_prepaid boolean DEFAULT false NOT NULL,
business_balance numeric(15,2) DEFAULT 0 NOT NULL,
player_balance numeric(15,2) DEFAULT 0 NOT NULL,
promo_balance numeric(15,2) DEFAULT 0 NOT NULL,
total_players integer DEFAULT 0 NOT NULL,
active_player_count integer DEFAULT 0 NOT NULL,
sub_agent_count integer DEFAULT 0 NOT NULL,
weekly_rake_generated numeric(15,2) DEFAULT 0 NOT NULL,
lifetime_earnings numeric(15,2) DEFAULT 0 NOT NULL,
joined_at timestamp with time zone DEFAULT now() NOT NULL,
last_active_at timestamp with time zone,
created_at timestamp with time zone DEFAULT now() NOT NULL,
updated_at timestamp with time zone DEFAULT now() NOT NULL,
auto_rakeback_enabled boolean DEFAULT true,
rakeback_percentage numeric(5,4) DEFAULT 0.0000,
agent_wallet_balance numeric(18,2) DEFAULT 0,
player_wallet_balance numeric(18,4) DEFAULT 0,
promo_wallet_balance numeric(18,2) DEFAULT 0,
lifetime_rake_generated numeric(18,4) DEFAULT 0
);
CREATE TABLE public.chip_ledger (
id uuid DEFAULT gen_random_uuid() NOT NULL,
performed_by uuid NOT NULL,
from_type text NOT NULL,
from_entity_id uuid,
from_label text,
to_type text NOT NULL,
to_entity_id uuid,
to_label text,
amount numeric(15,2) NOT NULL,
category text DEFAULT 'transfer'::text NOT NULL,
description text,
notes text,
club_id uuid,
union_id uuid,
table_id uuid,
hand_id uuid,
tournament_id uuid,
created_at timestamp with time zone DEFAULT now() NOT NULL,
idempotency_key text,
correlation_id uuid,
causation_id uuid,
settlement_id text,
epoch_id integer,
actor_service text,
db_role text,
pre_from_balance numeric,
post_from_balance numeric,
pre_to_balance numeric,
post_to_balance numeric,
status text DEFAULT 'posted'::text NOT NULL,
metadata jsonb,
chain_seq bigint,
prev_hash text,
row_hash text
);
CREATE TABLE public.chip_transactions (
id uuid DEFAULT gen_random_uuid() NOT NULL,
club_id uuid NOT NULL,
from_user_id uuid,
to_user_id uuid,
amount numeric(14,2) NOT NULL,
transaction_type text NOT NULL,
notes text,
related_cashout_id uuid,
metadata jsonb DEFAULT '{}'::jsonb,
created_at timestamp with time zone DEFAULT now(),
balance_after numeric(14,2),
clawed_back boolean DEFAULT false,
reversible_until timestamp with time zone,
is_reversed boolean DEFAULT false,
table_id uuid
);
CREATE TABLE public.club_members (
club_id uuid NOT NULL,
user_id uuid NOT NULL,
role text DEFAULT 'player'::text,
agent_id uuid,
joined_at timestamp with time zone DEFAULT now(),
parent_agent_id uuid,
invited_by uuid,
notes text,
last_active_at timestamp with time zone,
created_at timestamp with time zone DEFAULT now(),
updated_at timestamp with time zone DEFAULT now(),
is_bot boolean DEFAULT false,
status text DEFAULT 'active'::text,
chip_balance numeric(20,2) DEFAULT 0 NOT NULL,
diamonds integer DEFAULT 0 NOT NULL,
is_active boolean DEFAULT true,
orange_ball_status text DEFAULT 'inactive'::text,
rank_level integer DEFAULT 1,
credit_limit numeric(15,2) DEFAULT 0,
credit_used numeric(15,2) DEFAULT 0,
nickname text,
last_active timestamp with time zone DEFAULT now(),
tier text DEFAULT 'bronze'::text,
trust_score integer DEFAULT 50,
sessions_played integer DEFAULT 0,
promo_balance numeric(14,2) DEFAULT 0,
chips_won bigint DEFAULT 0,
chips_lost bigint DEFAULT 0,
commission_rate numeric(5,2) DEFAULT 0,
rakeback_rate numeric(5,2) DEFAULT 0,
hands_played integer DEFAULT 0,
total_rake_paid bigint DEFAULT 0,
biggest_pot bigint DEFAULT 0,
locked_chips integer DEFAULT 0,
player_rakeback_pct numeric(5,4) DEFAULT 0.0000,
held_chips numeric DEFAULT 0,
display_name text,
is_prepaid boolean DEFAULT true,
promo_received_total numeric(14,2) DEFAULT 0,
promo_wagered numeric(14,2) DEFAULT 0,
promo_playthrough_required numeric(14,2) DEFAULT 0,
missions_completed integer DEFAULT 0,
membership_lifecycle_status text DEFAULT 'active'::text NOT NULL,
departed_at timestamp with time zone,
departed_by uuid,
departure_reason text
);
CREATE TABLE public.rakeback_daily_state (
club_id uuid NOT NULL,
day date NOT NULL,
rows_seen bigint NOT NULL,
computed_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.rakeback_daily_user (
club_id uuid NOT NULL,
day date NOT NULL,
user_id uuid NOT NULL,
cents bigint NOT NULL
);
CREATE TABLE public.rakeback_period_payouts (
id uuid DEFAULT gen_random_uuid() NOT NULL,
rakeback_period_id uuid NOT NULL,
club_id uuid NOT NULL,
user_id uuid NOT NULL,
user_rake_contribution numeric(20,4) NOT NULL,
rakeback_pct numeric(5,2) NOT NULL,
payout_amount numeric(20,4) NOT NULL,
currency text DEFAULT 'CHIPS'::text NOT NULL,
wallet_transaction_id uuid,
status text DEFAULT 'paid'::text NOT NULL,
paid_at timestamp with time zone,
failure_reason text,
created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.rakeback_periods (
id uuid DEFAULT gen_random_uuid() NOT NULL,
user_id uuid,
club_id uuid NOT NULL,
period_start date NOT NULL,
period_end date NOT NULL,
rake_generated numeric(15,2) DEFAULT 0,
rakeback_rate numeric(5,4) DEFAULT 0.10,
rakeback_amount numeric(15,2) DEFAULT 0,
status text DEFAULT 'pending'::text,
paid_at timestamp with time zone,
created_at timestamp with time zone DEFAULT now(),
rakeback_earned numeric(15,2) DEFAULT 0,
total_rake_paid numeric(15,2) DEFAULT 0,
deferred_reason text,
deferred_at timestamp with time zone,
defer_count integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.settlement_locks (
id uuid DEFAULT gen_random_uuid() NOT NULL,
club_id uuid NOT NULL,
lock_type text DEFAULT 'weekly_settlement'::text NOT NULL,
locked_at timestamp with time zone DEFAULT now() NOT NULL,
unlock_at timestamp with time zone NOT NULL,
unlocked_at timestamp with time zone,
is_active boolean DEFAULT true NOT NULL,
lock_reason text DEFAULT 'Weekly auto-settlement in progress'::text,
settlement_period_id uuid,
metadata jsonb DEFAULT '{}'::jsonb,
created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.union_clubs (
id uuid DEFAULT gen_random_uuid() NOT NULL,
union_id uuid NOT NULL,
club_id uuid NOT NULL,
joined_at timestamp with time zone DEFAULT now(),
club_commission_rate numeric(5,4) DEFAULT 0.9000,
rate_cash numeric,
rate_mtt numeric,
rate_sng numeric,
rate_spin numeric,
rate_satellite numeric
);
CREATE TABLE public.wallet_credit_idempotency (
key text NOT NULL,
user_id uuid,
amount numeric,
created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.wallet_transactions (
id uuid DEFAULT gen_random_uuid() NOT NULL,
user_id uuid NOT NULL,
wallet_type text NOT NULL,
amount numeric(15,2) NOT NULL,
type text NOT NULL,
category text NOT NULL,
description text,
related_entity_id uuid,
table_id uuid,
hand_id uuid,
created_at timestamp with time zone DEFAULT now(),
balance_after numeric,
terminal_closed_at timestamp with time zone
);
CREATE TABLE public.wallets (
id uuid DEFAULT gen_random_uuid() NOT NULL,
user_id uuid NOT NULL,
wallet_type text NOT NULL,
balance numeric(15,2) DEFAULT 0 NOT NULL,
locked_balance numeric(15,2) DEFAULT 0,
updated_at timestamp with time zone DEFAULT now(),
created_at timestamp with time zone DEFAULT now()
);
ALTER TABLE public.agents ADD CONSTRAINT agents_agent_wallet_balance_nonneg CHECK ((agent_wallet_balance >= (0)::numeric));
ALTER TABLE public.agents ADD CONSTRAINT agents_club_id_user_id_key UNIQUE (club_id, user_id);
ALTER TABLE public.agents ADD CONSTRAINT agents_commission_rate_check CHECK (((commission_rate >= (0)::numeric) AND (commission_rate <= 0.70)));
ALTER TABLE public.agents ADD CONSTRAINT agents_credit_used_check CHECK ((credit_used >= (0)::numeric));
ALTER TABLE public.agents ADD CONSTRAINT agents_pkey PRIMARY KEY (id);
ALTER TABLE public.agents ADD CONSTRAINT agents_player_rakeback_rate_check CHECK (((player_rakeback_rate >= (0)::numeric) AND (player_rakeback_rate <= 0.50)));
ALTER TABLE public.agents ADD CONSTRAINT agents_promo_wallet_balance_nonneg CHECK ((promo_wallet_balance >= (0)::numeric));
ALTER TABLE public.agents ADD CONSTRAINT agents_role_check CHECK ((role = ANY (ARRAY['super_agent'::text, 'agent'::text, 'sub_agent'::text])));
ALTER TABLE public.agents ADD CONSTRAINT agents_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'frozen'::text])));
ALTER TABLE public.agents ADD CONSTRAINT check_credit CHECK (((credit_used <= credit_limit) OR (is_prepaid = true)));
ALTER TABLE public.agents ADD CONSTRAINT chk_player_wallet_balance_is_two_decimal_places CHECK (((player_wallet_balance IS NULL) OR (player_wallet_balance = round(player_wallet_balance, 2))));
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_category_check CHECK ((category = ANY (ARRAY['buyin'::text, 'cashout'::text, 'rake'::text, 'commission'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'mint'::text, 'burn'::text, 'legacy_seed_reconcile'::text, 'rakeback'::text, 'settlement'::text, 'tournament_buyin'::text, 'tournament_prize'::text, 'bounty'::text, 'adjustment'::text, 'refund'::text, 'addon'::text, 'rebuy'::text, 'table_cashout'::text, 'tournament_refund'::text, 'bbj_contribution'::text, 'bbj_payout'::text, 'promo'::text, 'promo_release'::text, 'promo_send'::text, 'credit_draw'::text, 'credit_repayment'::text, 'insurance'::text, 'spin_entry'::text, 'spin_prize'::text, 'overlay'::text, 'correction'::text, 'reversal'::text, 'escrow_hold'::text, 'escrow_release'::text, 'treasury_transfer'::text, 'horse_funding'::text, 'fee'::text, 'eco'::text, 'pnl_settlement'::text, 'union_send'::text, 'cashier_send'::text, 'cashier_claim_back'::text, 'ticket_issue'::text, 'ticket_redeem'::text, 'club_opening_allocation'::text, 'leaderboard_payout'::text, 'club_bank_send'::text, 'club_bank_claim'::text, 'agent_send'::text, 'agent_claim'::text, 'union_settlement'::text, 'wheel_prize'::text, 'plinko_prize'::text, 'crash_prize'::text]))) NOT VALID;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_exact_scale CHECK ((amount = round(amount, 2))) NOT VALID;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_from_type_check CHECK ((from_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text, 'union_bank'::text, 'agent_wallet'::text, 'system_mint'::text, 'system_burn'::text, 'table_stack'::text, 'promo_wallet'::text, 'club_wallet'::text, 'union_wallet'::text, 'bbj_pool'::text, 'spin_reserve'::text, 'insurance_bank'::text, 'escrow'::text, 'prize_liability'::text, 'bounty_liability'::text, 'rakeback_payable'::text, 'refund_payable'::text, 'settlement_suspense'::text, 'issuance_reserve'::text, 'chip_retirement'::text, 'credit_facility'::text, 'credit_receivable'::text, 'opening_setup'::text, 'leaderboard_round'::text]))) NOT VALID;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_no_diamond_category_check CHECK (((category !~* '^diamond'::text) AND (category !~* '_diamond'::text)));
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_pkey PRIMARY KEY (id);
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_positive_amount CHECK ((amount > (0)::numeric));
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_status_check CHECK ((status = ANY (ARRAY['posted'::text, 'correction'::text, 'reversal'::text])));
ALTER TABLE public.chip_ledger ADD CONSTRAINT chip_ledger_to_type_check CHECK ((to_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text, 'union_bank'::text, 'agent_wallet'::text, 'system_mint'::text, 'system_burn'::text, 'table_stack'::text, 'promo_wallet'::text, 'club_wallet'::text, 'union_wallet'::text, 'bbj_pool'::text, 'spin_reserve'::text, 'insurance_bank'::text, 'escrow'::text, 'prize_liability'::text, 'bounty_liability'::text, 'rakeback_payable'::text, 'refund_payable'::text, 'settlement_suspense'::text, 'issuance_reserve'::text, 'chip_retirement'::text, 'credit_facility'::text, 'credit_receivable'::text, 'opening_setup'::text, 'leaderboard_round'::text]))) NOT VALID;
ALTER TABLE public.chip_ledger ADD CONSTRAINT chk_post_from_balance_is_two_decimal_places CHECK (((post_from_balance IS NULL) OR (post_from_balance = round(post_from_balance, 2))));
ALTER TABLE public.chip_ledger ADD CONSTRAINT chk_post_to_balance_is_two_decimal_places CHECK (((post_to_balance IS NULL) OR (post_to_balance = round(post_to_balance, 2))));
ALTER TABLE public.chip_ledger ADD CONSTRAINT chk_pre_from_balance_is_two_decimal_places CHECK (((pre_from_balance IS NULL) OR (pre_from_balance = round(pre_from_balance, 2))));
ALTER TABLE public.chip_ledger ADD CONSTRAINT chk_pre_to_balance_is_two_decimal_places CHECK (((pre_to_balance IS NULL) OR (pre_to_balance = round(pre_to_balance, 2))));
ALTER TABLE public.chip_ledger ADD CONSTRAINT ck_whole_cents CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR (amount = round(amount, 2)))) NOT VALID;
ALTER TABLE public.chip_transactions ADD CONSTRAINT chip_transactions_pkey PRIMARY KEY (id);
ALTER TABLE public.club_members ADD CONSTRAINT chk_held_chips_is_two_decimal_places CHECK (((held_chips IS NULL) OR (held_chips = round(held_chips, 2))));
ALTER TABLE public.club_members ADD CONSTRAINT club_members_bot_house_only CHECK (((NOT COALESCE(is_bot, false)) OR fn_ca_house_board_allows_automation(club_id)));
ALTER TABLE public.club_members ADD CONSTRAINT club_members_chip_balance_nonneg CHECK ((chip_balance >= (0)::numeric));
ALTER TABLE public.club_members ADD CONSTRAINT club_members_membership_lifecycle_check CHECK ((membership_lifecycle_status = ANY (ARRAY['active'::text, 'departed'::text])));
ALTER TABLE public.club_members ADD CONSTRAINT club_members_pkey PRIMARY KEY (club_id, user_id);
ALTER TABLE public.club_members ADD CONSTRAINT club_members_promo_balance_nonneg CHECK ((promo_balance >= (0)::numeric));
ALTER TABLE public.club_members ADD CONSTRAINT club_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text, 'super_agent'::text, 'agent'::text, 'sub_agent'::text, 'player'::text])));
ALTER TABLE public.rakeback_daily_state ADD CONSTRAINT rakeback_daily_state_pkey PRIMARY KEY (club_id, day);
ALTER TABLE public.rakeback_daily_user ADD CONSTRAINT rakeback_daily_user_pkey PRIMARY KEY (club_id, day, user_id);
ALTER TABLE public.rakeback_period_payouts ADD CONSTRAINT chk_payout_amount_is_two_decimal_places CHECK (((payout_amount IS NULL) OR (payout_amount = round(payout_amount, 2))));
ALTER TABLE public.rakeback_period_payouts ADD CONSTRAINT ck_whole_cents CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR (payout_amount = round(payout_amount, 2)))) NOT VALID;
ALTER TABLE public.rakeback_period_payouts ADD CONSTRAINT rakeback_period_payouts_payout_amount_check CHECK ((payout_amount >= (0)::numeric));
ALTER TABLE public.rakeback_period_payouts ADD CONSTRAINT rakeback_period_payouts_pkey PRIMARY KEY (id);
ALTER TABLE public.rakeback_period_payouts ADD CONSTRAINT rakeback_period_payouts_rakeback_pct_check CHECK (((rakeback_pct >= (0)::numeric) AND (rakeback_pct <= (100)::numeric)));
ALTER TABLE public.rakeback_period_payouts ADD CONSTRAINT rakeback_period_payouts_rakeback_period_id_user_id_key UNIQUE (rakeback_period_id, user_id);
ALTER TABLE public.rakeback_period_payouts ADD CONSTRAINT rakeback_period_payouts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'clawed_back'::text, 'failed'::text])));
ALTER TABLE public.rakeback_period_payouts ADD CONSTRAINT rakeback_period_payouts_user_rake_contribution_check CHECK ((user_rake_contribution >= (0)::numeric));
ALTER TABLE public.rakeback_periods ADD CONSTRAINT ck_whole_cents CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR ((rakeback_amount = round(rakeback_amount, 2)) AND (rake_generated = round(rake_generated, 2))))) NOT VALID;
ALTER TABLE public.rakeback_periods ADD CONSTRAINT rakeback_periods_pkey PRIMARY KEY (id);
ALTER TABLE public.rakeback_periods ADD CONSTRAINT rakeback_periods_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'open'::text, 'closed'::text, 'claiming'::text, 'claimed'::text, 'paid'::text, 'expired'::text])));
ALTER TABLE public.rakeback_periods ADD CONSTRAINT rakeback_periods_user_id_club_id_period_start_period_end_key UNIQUE (user_id, club_id, period_start, period_end);
ALTER TABLE public.settlement_locks ADD CONSTRAINT settlement_locks_pkey PRIMARY KEY (id);
ALTER TABLE public.union_clubs ADD CONSTRAINT union_clubs_game_rates_are_fractions CHECK ((((rate_cash IS NULL) OR ((rate_cash >= (0)::numeric) AND (rate_cash <= (1)::numeric))) AND ((rate_mtt IS NULL) OR ((rate_mtt >= (0)::numeric) AND (rate_mtt <= (1)::numeric))) AND ((rate_sng IS NULL) OR ((rate_sng >= (0)::numeric) AND (rate_sng <= (1)::numeric))) AND ((rate_spin IS NULL) OR ((rate_spin >= (0)::numeric) AND (rate_spin <= (1)::numeric))) AND ((rate_satellite IS NULL) OR ((rate_satellite >= (0)::numeric) AND (rate_satellite <= (1)::numeric)))));
ALTER TABLE public.union_clubs ADD CONSTRAINT union_clubs_pkey PRIMARY KEY (id);
ALTER TABLE public.union_clubs ADD CONSTRAINT union_clubs_union_id_club_id_key UNIQUE (union_id, club_id);
ALTER TABLE public.wallet_credit_idempotency ADD CONSTRAINT wallet_credit_idempotency_pkey PRIMARY KEY (key);
ALTER TABLE public.wallet_transactions ADD CONSTRAINT chk_balance_after_is_two_decimal_places CHECK (((balance_after IS NULL) OR (balance_after = round(balance_after, 2)))) NOT VALID;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_amount_non_negative CHECK ((amount >= (0)::numeric)) NOT VALID;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_category_check CHECK ((category = ANY (ARRAY['buyin'::text, 'cashout'::text, 'promo'::text, 'rake'::text, 'transfer'::text, 'tournament_buyin'::text, 'tournament_winnings'::text, 'tournament_cashout'::text, 'horse_refill'::text, 'deposit'::text, 'withdrawal'::text, 'refund'::text, 'bbj'::text, 'bonus'::text, 'mint'::text, 'settlement'::text, 'commission'::text, 'INSURANCE'::text, 'prize'::text, 'rebuy'::text, 'addon'::text, 'funding'::text, 'promotion'::text, 'rakeback'::text, 'bounty'::text, 'addon_refund'::text, 'bounty_own'::text, 'prize_reversal'::text, 'leaderboard_payout'::text]))) NOT VALID;
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_pkey PRIMARY KEY (id);
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_type_check CHECK ((type = ANY (ARRAY['credit'::text, 'debit'::text])));
ALTER TABLE public.wallet_transactions ADD CONSTRAINT wallet_transactions_wallet_type_check CHECK ((wallet_type = ANY (ARRAY['PLAYER'::text, 'BUSINESS'::text, 'PROMO'::text, 'CLUB'::text, 'UNION'::text, 'PLATFORM'::text])));
ALTER TABLE public.wallets ADD CONSTRAINT wallets_pkey PRIMARY KEY (id);
ALTER TABLE public.wallets ADD CONSTRAINT wallets_user_id_wallet_type_key UNIQUE (user_id, wallet_type);
ALTER TABLE public.wallets ADD CONSTRAINT wallets_wallet_type_check CHECK ((wallet_type = ANY (ARRAY['BUSINESS'::text, 'PLAYER'::text, 'PROMO'::text])));
CREATE UNIQUE INDEX chip_ledger_key_unique ON public.chip_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE public.ca_ledger_mutation_log(id bigserial PRIMARY KEY,source_table text,operation text,db_role text,application text,reason text,old_row jsonb,new_row jsonb);
CREATE TABLE public.ca_ledger_maintenance_kinds(kind text,severity text);
SET check_function_bodies=off;
CREATE OR REPLACE FUNCTION public.atomic_credit_wallet_and_log(p_user_id uuid, p_amount numeric, p_category text DEFAULT 'credit'::text, p_description text DEFAULT ''::text, p_table_id uuid DEFAULT NULL::uuid, p_hand_id uuid DEFAULT NULL::uuid, p_related_entity_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_inserted integer;
  v_new_balance numeric;
  v_has_club boolean;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO wallet_credit_idempotency (key, user_id, amount)
    VALUES (p_idempotency_key, p_user_id, p_amount)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN RETURN true; END IF;
  END IF;

  -- ZERO-DRIFT phase 5: tournament stacks are play chips and never cash
  -- out to a wallet. Blocked here exactly as in atomic_table_cashout.
  IF p_table_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.tables t WHERE t.id = p_table_id AND t.tournament_id IS NOT NULL) THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'atomic_credit_wallet_and_log:tournament_mint_blocked', 'unauthorized_adjustment', 'info',
      'tourney-cashout-blocked:' || to_char(now(), 'YYYY-MM-DD'),
      p_amount, 0, p_amount, 'ledger', 'tables', p_table_id, NULL,
      NULL, p_table_id, NULL, NULL, NULL, NULL, NULL,
      'a tournament-table stack was about to credit a real wallet via atomic_credit_wallet_and_log - blocked. Tournament chips are play chips. This now blocks EVERY category, not just cashout; the category the caller used is in the metadata.',
      NULL, jsonb_build_object('user_id', p_user_id, 'amount', p_amount, 'category', p_category));
    RETURN true;
  END IF;

  /* ZERO-DRIFT (2026-08-31): tell the club_members ledger writer what this
     credit IS. 'cashout' maps to the table_cashout flow off the felt. */
  PERFORM set_config('app.ledger_category',
    CASE WHEN p_category IN ('cashout') THEN 'table_cashout'
         WHEN p_category IN ('buyin','rake','commission','transfer','rakeback',
                             'settlement','tournament_buyin','tournament_prize',
                             'bounty','refund','addon','rebuy','promo')
              THEN p_category
         ELSE 'player_funding' END, true);
  IF p_table_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_table_id::text, true);
  END IF;

  IF p_table_id IS NOT NULL THEN
    SELECT ts.club_id INTO v_club_id
      FROM table_seats ts
     WHERE ts.table_id = p_table_id AND ts.user_id = p_user_id
     ORDER BY ts.joined_at DESC LIMIT 1;
  END IF;
  IF v_club_id IS NULL THEN
    -- A caller that KNOWS which club a credit belongs to says so in
    -- app.ledger_club_id. Rakeback earned at a club is paid into THAT
    -- club's wallet, not into whichever club the player joined first.
    -- Unset - which is every existing caller - is the old behaviour
    -- exactly, because fn_player_home_club ignores a NULL hint.
    v_club_id := public.fn_player_home_club(p_user_id,
      NULLIF(current_setting('app.ledger_club_id', true), '')::uuid);
  END IF;

  IF v_club_id IS NOT NULL THEN
    PERFORM public.fn_ensure_club_wallet(p_user_id, v_club_id);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance,0) + p_amount, updated_at = now()
     WHERE user_id = p_user_id AND club_id = v_club_id
     RETURNING chip_balance INTO v_new_balance;
    IF NOT FOUND THEN
      -- A credit is not complete unless its destination balance was written.
      -- Abort before journal rows or a caller's cashout/seat exit can commit.
      RAISE EXCEPTION 'CLUB_CREDIT_DESTINATION_MISSING: player %, club %', p_user_id, v_club_id
        USING ERRCODE = '23503';
    END IF;
  ELSE
    SELECT EXISTS (SELECT 1 FROM club_members m WHERE m.user_id = p_user_id) INTO v_has_club;
    IF v_has_club THEN
      RAISE EXCEPTION 'No club wallet resolves for Club Arena credit to player %', p_user_id;
    END IF;
    UPDATE wallets SET balance = COALESCE(balance,0) + p_amount, updated_at = now()
     WHERE user_id = p_user_id AND wallet_type = 'PLAYER'
     RETURNING balance INTO v_new_balance;
    IF NOT FOUND THEN
      INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
      VALUES (p_user_id, 'PLAYER', p_amount, 0)
      ON CONFLICT (user_id, wallet_type) DO UPDATE
        SET balance = wallets.balance + p_amount, updated_at = now()
      RETURNING balance INTO v_new_balance;
    END IF;
  END IF;

  IF p_category = 'cashout' THEN
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category,
                                     description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'credit', p_amount, 'cashout',
            COALESCE(NULLIF(p_description, ''), 'Cash-out to club wallet'),
            p_table_id, v_new_balance);
  END IF;

  IF v_club_id IS NOT NULL THEN
    INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type,
                                   notes, table_id, metadata)
    VALUES (v_club_id, p_user_id, p_amount, p_category,
            COALESCE(NULLIF(p_description, ''), 'Wallet credit'), p_table_id,
            CASE WHEN p_category = 'cashout'
                 THEN jsonb_build_object('mirrored_to_wallet', true)
                 ELSE '{}'::jsonb END);
  END IF;

  RETURN true;
END; $function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
  v_kind text;
  v_sev text;
  v_j jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'chip_transactions' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type
        AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
        AND NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSIF TG_TABLE_NAME = 'chip_ledger' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.from_type IS NOT DISTINCT FROM OLD.from_type
        AND NEW.from_entity_id IS NOT DISTINCT FROM OLD.from_entity_id
        AND NEW.to_type IS NOT DISTINCT FROM OLD.to_type
        AND NEW.to_entity_id IS NOT DISTINCT FROM OLD.to_entity_id
        AND NEW.category IS NOT DISTINCT FROM OLD.category
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.chain_seq IS NOT DISTINCT FROM OLD.chain_seq
        AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
        AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
        AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
        AND NEW.epoch_id IS NOT DISTINCT FROM OLD.epoch_id;
    ELSIF TG_TABLE_NAME = 'vip_points_ledger' THEN
      /* Phase 8 (2026-09-08). A VIP leg is written once, final: the award
         writer no longer inserts 0 and updates it afterwards. Nothing on this
         table may change. */
      v_allowed_update := false;
    ELSIF TG_TABLE_NAME = 'agent_commissions' THEN
      /* Phase 8. A commission row is what was earned on one hand. The only
         thing that happens to it afterwards is being settled, once. */
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.source_type IS NOT DISTINCT FROM OLD.source_type
        AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
        AND NEW.commission_rate IS NOT DISTINCT FROM OLD.commission_rate
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND (OLD.settled_at IS NULL OR NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at);
    ELSIF TG_TABLE_NAME = 'rakeback_period_payouts' THEN
      /* Phase 8. What was paid, to whom, for which period, never changes;
         status, paid_at, wallet_transaction_id and failure_reason are the
         payout's own bookkeeping. */
      v_allowed_update :=
        NEW.payout_amount IS NOT DISTINCT FROM OLD.payout_amount
        AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.rakeback_period_id IS NOT DISTINCT FROM OLD.rakeback_period_id
        AND NEW.currency IS NOT DISTINCT FROM OLD.currency
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSE
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_allowed_update THEN
    RETURN NEW;
  END IF;

  /* Phase 8. fn_close_settlement_period inserts a payout row as its
     idempotency claim BEFORE debiting the treasury and deletes it again on a
     shortfall, inside the same transaction. That is a compensation, not a
     mutation of history, so this table's DELETE is allowed - and RECORDED,
     every time, so a person can tell a compensation from a hand on the
     table. The meter counts these. */
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'rakeback_period_payouts' THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true),
            COALESCE(v_reason, 'rakeback-payout-delete: compensation on a treasury shortfall, or maintenance without app.ledger_maintenance'),
            to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) END);

    BEGIN
      v_kind := split_part(v_reason, ':', 1);
      -- a routine, recorded maintenance is filed, not shouted about
      SELECT k.severity INTO v_sev
        FROM public.ca_ledger_maintenance_kinds k WHERE k.kind = v_kind;
      v_sev := COALESCE(v_sev, 'warning');
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_journal_append_only', 'unauthorized_adjustment', v_sev,
        'journal-bypass:' || TG_TABLE_NAME || ':' || TG_OP || ':' || v_kind,
        0, NULL, NULL, 'ledger', TG_TABLE_NAME,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on ' || TG_TABLE_NAME || ': ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log - this incident'
          || ' counts them (occurrences) rather than the chips; query that table by'
          || ' reason for the full inventory. Confirm the maintenance was intended,'
          || ' then resolve.',
        true,
        jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
                           'reason', v_reason, 'reason_kind', v_kind,
                           'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- DR5. The diamond journal is deleted from on an hourly cadence by the
    -- certification fleet. Keep the row and say who took it. Nothing here can
    -- refuse the DELETE the branch above has already permitted.
    IF TG_TABLE_NAME = 'diamond_transactions' AND TG_OP = 'DELETE' THEN
      BEGIN
        v_j := to_jsonb(OLD);
        INSERT INTO public.ca_diamond_journal_archive
          (id, user_id, type, amount, balance_after, description, reference_id, created_at,
           transaction_type, source, metadata, counterparty, issuance_class,
           deleted_profile_id, deletion_reason)
        VALUES
          ((v_j->>'id')::uuid, (v_j->>'user_id')::uuid, v_j->>'type',
           (v_j->>'amount')::integer, (v_j->>'balance_after')::integer,
           v_j->>'description', v_j->>'reference_id', (v_j->>'created_at')::timestamptz,
           v_j->>'transaction_type', v_j->>'source',
           COALESCE(v_j->'metadata', '{}'::jsonb),
           v_j->>'counterparty', v_j->>'issuance_class',
           (v_j->>'user_id')::uuid, v_reason)
        ON CONFLICT (id) DO NOTHING;

        PERFORM public.fn_ca_diamond_incident(
          'DR5:journal_row_deleted_under_maintenance', 'info',
          (v_j->>'user_id')::uuid, (v_j->>'amount')::numeric,
          'fn_ca_journal_append_only',
          jsonb_build_object('reason', v_reason,
                             'reference_id', v_j->>'reference_id',
                             'type', v_j->>'type',
                             'db_role', current_user));
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ca_diamond_journal_archive could not preserve a journal row deleted under maintenance (%): %',
          v_reason, SQLERRM;
      END;
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: financial journals are append-only. Corrections are new linked rows (category=correction). Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_caller_is_engine()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'auth'
AS $function$
  -- The engine and every server-side job authenticate as service_role. A NULL
  -- means there is no PostgREST request context at all - psql, pg_cron, a
  -- migration - which is equally trusted. A browser can never produce NULL:
  -- reaching `authenticated` requires a verified JWT and PostgREST always sets
  -- request.jwt.claims from it.
  --
  -- NOT current_user. Inside a SECURITY DEFINER body current_user is the
  -- function OWNER for the browser and the engine alike, which is what made an
  -- earlier guard on club_members a silent no-op.
  SELECT COALESCE(auth.role(), 'service_role') = 'service_role';
$function$
;

CREATE OR REPLACE FUNCTION public.fn_claim_rakeback(p_club_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user    uuid := (SELECT auth.uid());
  v_period  record;
  v_res     jsonb;
  v_count   int := 0;
  v_total   numeric := 0;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;

  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE user_id = v_user
       AND status = 'pending'
       AND (p_club_id IS NULL OR club_id = p_club_id)
     ORDER BY period_start
     FOR UPDATE
  LOOP
    v_res := public.fn_close_settlement_period(v_period.id);
    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_total := v_total + COALESCE((v_res->>'payout')::numeric, 0);
      IF COALESCE((v_res->>'payout')::numeric, 0) > 0 THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'periods_claimed', v_count, 'total_payout', v_total);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period         record;
  v_rake_total     numeric;
  v_rate           numeric;
  v_payout         numeric;
  v_payout_id      uuid;
  v_days_needed    int;
  v_days_have      int;
  v_from_rollup    boolean := true;
  v_is_member      boolean;
  v_balance        numeric;
  v_debit          jsonb;
  v_treasury       numeric;
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status, 'period_id', p_period_id);
  END IF;

  -- WHO IS ASKING. A grant is not an authorization check: it lives outside
  -- the function and CREATE OR REPLACE carries it forward unexamined. This
  -- function debits a treasury and credits a wallet, so it asks.
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL
          OR (auth.uid() <> v_period.user_id
              AND NOT public.fn_is_platform_admin()
              AND NOT EXISTS (SELECT 1 FROM public.clubs c
                               WHERE c.id = v_period.club_id
                                 AND c.owner_id = auth.uid()))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
  END IF;

  -- ---- EVERY CHEAP REFUSAL FIRST -------------------------------------------
  -- Each of these is one indexed lookup. The basis below is a rollup sum at
  -- best and a full rake_records scan at worst, and there is no reason to pay
  -- for it on a period that cannot be paid out either way.

  -- CLAUDE.md 13 rule 5: a sweep that moves money checks the freeze first.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', false, 'deferred', 'platform_frozen',
                              'period_id', p_period_id);
  END IF;

  -- Rakeback is earned at a club and belongs in that club's wallet. A player
  -- with no membership there is not quietly paid somewhere else, and is not
  -- worth a rake scan to discover that.
  SELECT EXISTS (SELECT 1 FROM public.club_members cm
                  WHERE cm.user_id = v_period.user_id
                    AND cm.club_id = v_period.club_id
                    AND cm.status IN ('active','approved'))
    INTO v_is_member;

  IF NOT v_is_member THEN
    UPDATE public.rakeback_periods
       SET deferred_reason = 'no_membership_at_earning_club',
           deferred_at = NOW(), defer_count = defer_count + 1
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', false, 'deferred', 'no_membership_at_earning_club',
      'period_id', p_period_id, 'club_id', v_period.club_id, 'user_id', v_period.user_id);
  END IF;

  -- Can this club fund what this period is already believed to be worth? The
  -- estimate is the writer's own last computation, it is used ONLY to refuse,
  -- and refusing here costs one indexed row where continuing costs a full rake
  -- scan for a payment fn_debit_treasury would decline at the end of it.
  IF COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) > 0 THEN
    SELECT COALESCE(c.chip_treasury, 0) INTO v_treasury
      FROM public.clubs c WHERE c.id = v_period.club_id;
    IF v_treasury < COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) THEN
      UPDATE public.rakeback_periods
         SET deferred_reason = 'insufficient_club_treasury',
             deferred_at = NOW(), defer_count = defer_count + 1
       WHERE id = p_period_id;
      RETURN jsonb_build_object('success', false, 'deferred', 'insufficient_club_treasury',
        'period_id', p_period_id, 'club_id', v_period.club_id,
        'estimated_payout', COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0),
        'treasury', round(v_treasury, 2), 'checked', 'before_basis');
    END IF;
  END IF;

  -- ---- NOW THE WORK ---------------------------------------------------------
  -- rakeback_daily_user is the same allocation the writer used, computed once
  -- per club-day for every player. Where it does not cover the period - it
  -- began 2026-08-31 and the backlog reaches to 2026-07-20 - fall back to the
  -- original scan rather than pay somebody zero because a cache is cold.
  v_days_needed := (v_period.period_end - v_period.period_start) + 1;
  SELECT count(*) INTO v_days_have FROM public.rakeback_daily_state s
   WHERE s.club_id = v_period.club_id
     AND s.day BETWEEN v_period.period_start AND v_period.period_end;

  IF v_days_have >= v_days_needed THEN
    SELECT ROUND(COALESCE(SUM(d.cents), 0)::numeric / 100, 2)
      INTO v_rake_total
      FROM public.rakeback_daily_user d
     WHERE d.club_id = v_period.club_id
       AND d.user_id = v_period.user_id
       AND d.day BETWEEN v_period.period_start AND v_period.period_end;
  ELSE
    v_from_rollup := false;
    SELECT ROUND(COALESCE(SUM(s.credit), 0), 2)
      INTO v_rake_total
      FROM public.rake_records r
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        r.hand_id, r.rake_amount, r.player_contributions, COALESCE(r.rake_method, 'DEALT_EQUAL')
      ) s
     WHERE r.club_id = v_period.club_id
       AND r.created_at >= v_period.period_start::timestamptz
       AND r.created_at <  (v_period.period_end + 1)::timestamptz
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
       AND (r.player_contributions ? v_period.user_id::text)
       AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata)
       AND s.user_id = v_period.user_id;
  END IF;

  -- One source of truth for the rate: the player's own deal, else their agent's
  -- standing offer, else the legacy volume ladder, never more than the upline
  -- earns less ten points.
  v_rate   := public.fn_player_rakeback_rate(v_period.user_id, v_period.club_id, v_rake_total);
  v_payout := ROUND(v_rake_total * v_rate, 2);

  UPDATE public.rakeback_periods
     SET rake_generated  = v_rake_total,
         total_rake_paid = v_rake_total,
         rakeback_rate   = v_rate,
         rakeback_amount = v_payout,
         rakeback_earned = v_payout
   WHERE id = p_period_id;

  IF v_payout <= 0 THEN
    UPDATE public.rakeback_periods
       SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'period_id', p_period_id, 'payout', 0,
                              'rake_total', v_rake_total, 'rakeback_rate', v_rate,
                              'from_rollup', v_from_rollup);
  END IF;

  INSERT INTO public.rakeback_period_payouts
    (rakeback_period_id, club_id, user_id, user_rake_contribution,
     rakeback_pct, payout_amount, status, paid_at)
  VALUES
    (p_period_id, v_period.club_id, v_period.user_id, v_rake_total,
     ROUND(v_rate * 100, 2), round(v_payout, 2), 'paid', NOW())
  ON CONFLICT (rakeback_period_id, user_id) DO NOTHING
  RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    UPDATE public.rakeback_periods
       SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'skipped', 'payout_exists', 'period_id', p_period_id);
  END IF;

  v_debit := public.fn_debit_treasury(
    v_period.club_id, v_payout,
    'Player rakeback ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    jsonb_build_object('period_id', p_period_id, 'user_id', v_period.user_id,
                       'rake_basis', v_rake_total, 'rate', v_rate));

  IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
    DELETE FROM public.rakeback_period_payouts WHERE id = v_payout_id;
    UPDATE public.rakeback_periods
       SET deferred_reason = 'insufficient_club_treasury',
           deferred_at = NOW(), defer_count = defer_count + 1
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', false, 'deferred', 'insufficient_club_treasury',
      'period_id', p_period_id, 'club_id', v_period.club_id, 'payout', v_payout,
      'treasury', v_debit->'balance');
  END IF;

  PERFORM set_config('app.ledger_club_id', v_period.club_id::text, true);

  PERFORM public.atomic_credit_wallet_and_log(
    v_period.user_id, v_payout, 'rakeback',
    'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    NULL, NULL, v_payout_id, 'rakeback:' || p_period_id::text
  );
  /* THE POINTER IS WRITTEN WHERE THE MONEY MOVED (2026-09-08). The credit
     above already stamps related_entity_id = this payout, so the link has
     always existed in ONE direction. rakeback_period_payouts.wallet_
     transaction_id was never written back, on any of 2,704 rows since the
     table was created, and fn_ca_settlement_correctness_check reads that
     direction - so every paid rakeback looked like money with no evidence.
     PERFORM discards what the credit returns and the function returns only
     a boolean, so the id is read back from the row it just stamped. */
  PERFORM set_config('app.ledger_maintenance',
                     'rakeback payout evidence pointer', true);
  UPDATE public.rakeback_period_payouts p
     SET wallet_transaction_id = w.id
    FROM public.wallet_transactions w
   WHERE p.id = v_payout_id AND w.related_entity_id = v_payout_id
     AND p.wallet_transaction_id IS NULL;
  PERFORM set_config('app.ledger_maintenance', '', true);

  PERFORM set_config('app.ledger_club_id', '', true);

  SELECT cm.chip_balance INTO v_balance
    FROM public.club_members cm
   WHERE cm.user_id = v_period.user_id AND cm.club_id = v_period.club_id;

  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, amount, type, category, description, related_entity_id, balance_after)
  VALUES
    (v_period.user_id, 'PLAYER', v_payout, 'credit', 'rakeback',
     'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
     v_payout_id, v_balance);

  UPDATE public.rakeback_periods
     SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
   WHERE id = p_period_id;

  RETURN jsonb_build_object('success', true, 'period_id', p_period_id,
    'rake_total', v_rake_total, 'rakeback_rate', v_rate,
    'payout', v_payout, 'payout_id', v_payout_id, 'club_id', v_period.club_id,
    'from_rollup', v_from_rollup, 'funded_from', 'club_chip_treasury');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_debit_treasury(p_club_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_before numeric;
  v_after numeric;
BEGIN
  IF p_club_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid parameters');
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_before
  FROM clubs WHERE id = p_club_id FOR UPDATE;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;

  IF v_before < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient treasury',
      'balance', v_before,
      'requested', p_amount
    );
  END IF;

  UPDATE clubs
  SET chip_treasury = chip_treasury - p_amount,
      updated_at = NOW()
  WHERE id = p_club_id;
  v_after := v_before - p_amount;

  INSERT INTO chip_transactions (
    id, club_id, amount, transaction_type, notes, metadata, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_amount,
    'treasury_debit', COALESCE(p_reason, 'Treasury debit'), p_metadata, v_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'balance_before', v_before,
    'balance_after', v_after
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND cm.club_id = p_club_id
       AND cm.status IN ('active', 'approved')
  );
$function$
;

CREATE OR REPLACE FUNCTION public.fn_player_rakeback_rate(p_user_id uuid, p_club_id uuid, p_volume numeric DEFAULT 0)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deal numeric; v_agent_default numeric; v_upline_rate numeric; v_rate numeric; v_cap numeric;
BEGIN
  SELECT COALESCE(cm.player_rakeback_pct, 0),
         COALESCE(a.player_rakeback_rate, 0),
         COALESCE(a.commission_rate, 0)
    INTO v_deal, v_agent_default, v_upline_rate
    FROM club_members cm
    LEFT JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id AND a.status = 'active'
   WHERE cm.user_id = p_user_id AND cm.club_id = p_club_id
   LIMIT 1;

  -- 1. the player's own negotiated deal
  IF COALESCE(v_deal,0) > 0 THEN
    v_rate := v_deal;
  -- 2. their agent's standing offer
  ELSIF COALESCE(v_agent_default,0) > 0 THEN
    v_rate := v_agent_default;
  -- 3. legacy volume ladder (players with no agent)
  ELSE
    v_rate := CASE WHEN p_volume >= 10000 THEN 0.30
                   WHEN p_volume >=  2000 THEN 0.20
                   WHEN p_volume >=   500 THEN 0.15
                   WHEN p_volume >=   100 THEN 0.10
                   ELSE 0.05 END;
  END IF;

  -- Never more than the upline receives, less the ten-point gap.
  IF COALESCE(v_upline_rate,0) > 0 THEN
    v_cap := GREATEST(v_upline_rate - 0.10, 0);
    v_rate := LEAST(v_rate, v_cap);
  END IF;

  RETURN GREATEST(ROUND(COALESCE(v_rate,0), 4), 0);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(p_union_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_agent_bal numeric; v_paid numeric := 0;
  v_payees int := 0; v_short int := 0; v_detail jsonb := '[]'::jsonb;
BEGIN

  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;
  FOR r IN
    SELECT rp.user_id AS player_id, rp.club_id, cm.agent_id AS agent_user,
           SUM(rp.rakeback_amount) AS owed
      FROM rakeback_periods rp
      JOIN union_clubs uc ON uc.club_id = rp.club_id AND uc.union_id = p_union_id
      JOIN club_members cm ON cm.user_id = rp.user_id AND cm.club_id = rp.club_id
     WHERE rp.status = 'pending'
       AND rp.period_start >= p_period_start::date
       AND rp.period_start <  p_period_end::date + 1
       AND cm.agent_id IS NOT NULL
     GROUP BY rp.user_id, rp.club_id, cm.agent_id
    HAVING SUM(rp.rakeback_amount) > 0
     ORDER BY 2,3,1
  LOOP
    SELECT chip_balance INTO v_agent_bal
      FROM club_members WHERE user_id = r.agent_user AND club_id = r.club_id FOR UPDATE;

    IF COALESCE(v_agent_bal,0) < r.owed THEN
      v_short := v_short + 1;
      v_detail := v_detail || jsonb_build_object('agent', r.agent_user, 'player', r.player_id,
                    'owed', r.owed, 'agent_balance', COALESCE(v_agent_bal,0), 'skipped', true);
      CONTINUE;
    END IF;

    /* ONE MOVEMENT, ONE LEG (2026-09-09). Both sides of this transfer live
       in club_members, and the leg that names them - agent wallet to player
       wallet - is written by hand below. Without these stand-downs the
       club_members trigger fired twice per payment, once for the debit and
       once for the credit, and neither knew the counterparty, so a single
       rakeback payment reached the journal as an anonymous pair through
       settlement_suspense PLUS the named leg. */
    PERFORM set_config('app.ledger_autoskip_club_members', '1', true);
    UPDATE club_members SET chip_balance = chip_balance - r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id;

    PERFORM public.fn_ensure_club_wallet(r.player_id, r.club_id);
    UPDATE club_members SET chip_balance = COALESCE(chip_balance,0) + r.owed, updated_at = now()
     WHERE user_id = r.player_id AND club_id = r.club_id;
    PERFORM set_config('app.ledger_autoskip_club_members', '', true);

    UPDATE rakeback_periods
       SET status = 'paid', paid_at = now()
     WHERE user_id = r.player_id AND club_id = r.club_id AND status = 'pending'
       AND period_start >= p_period_start::date AND period_start < p_period_end::date + 1;

    INSERT INTO wallet_transactions
      (user_id, wallet_type, type, amount, category, description, balance_after)
    SELECT r.player_id, 'PLAYER', 'credit', r.owed, 'rakeback',
           'Round 3: agent -> player rakeback [club wallet]', cm.chip_balance
      FROM club_members cm WHERE cm.user_id = r.player_id AND cm.club_id = r.club_id;

    /* CONTROL (phase 8): the same movement as a balanced leg on the journal.
       Both sides are member wallets, so the trial balance nets them to zero
       and cannot see this; fn_ca_ledger_replay is per account owner and can. */
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, union_id, description, idempotency_key, metadata)
    VALUES
      (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
       'player_wallet', r.agent_user, 'player_wallet', r.player_id,
       round(r.owed, 2), 'rakeback', r.club_id, p_union_id,
       'Round 3: agent -> player rakeback (period '
         || to_char(p_period_start, 'YYYY-MM-DD') || '..'
         || to_char(p_period_end, 'YYYY-MM-DD') || ')',
       'round3:' || p_union_id::text || ':'
         || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD') || ':'
         || r.club_id::text || ':' || r.agent_user::text || ':' || r.player_id::text,
       jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end))
    ON CONFLICT DO NOTHING;

    v_paid := v_paid + r.owed;
    v_payees := v_payees + 1;
  END LOOP;

  RETURN jsonb_build_object('round', 3, 'name', 'agents_to_players',
    'payees', v_payees, 'amount', round(v_paid,2), 'shortfalls', v_short, 'detail', v_detail);
END $function$
;

CREATE OR REPLACE FUNCTION public.fn_player_home_club(p_user_id uuid, p_club_hint uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_club uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;
  IF p_club_hint IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND cm.club_id = p_club_hint
       AND cm.status IN ('active','approved')
  ) THEN RETURN p_club_hint; END IF;
  SELECT cm.club_id INTO v_club
    FROM public.club_members cm
   WHERE cm.user_id = p_user_id AND cm.status IN ('active','approved')
   ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
   LIMIT 1;
  RETURN v_club;
END;
$function$
;
CREATE TRIGGER trg_ca_append_only BEFORE UPDATE OR DELETE ON public.rakeback_period_payouts FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();
CREATE TRIGGER trg_ca_append_only BEFORE UPDATE OR DELETE ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();
CREATE TRIGGER trg_ca_append_only BEFORE UPDATE OR DELETE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.fn_ca_journal_append_only();
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_claim_rakeback(uuid) TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
CREATE FUNCTION public.test_journal_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF coalesce(current_setting('test.fail_journal',true),'')='1' THEN RAISE EXCEPTION 'injected final journal failure'; END IF; RETURN NEW; END $$;
CREATE TRIGGER test_final_leg_failure BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.test_journal_failure();
