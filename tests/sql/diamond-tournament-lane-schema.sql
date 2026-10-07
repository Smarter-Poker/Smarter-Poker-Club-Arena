-- The fixture schema for tests/sql/run-diamond-tournament-lane-journal.py
-- (issue #6411, migration 20261007132503). Isolated PostgreSQL 17 only.
--
-- The tables the five tournament-lane functions touch, with production's CHECK
-- constraints as they stood BEFORE 20261007132503 (read 2026-10-07 with
-- pg_get_constraintdef), and the small readers those functions call, in
-- production's own text. Two pieces are fixture reductions and say so where
-- they are defined: the register follower and the arena float.

CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto SCHEMA extensions;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
-- The reconciliation is read as the service role in this fixture.
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{"role":"service_role"}'::jsonb $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, username text, full_name text, diamonds integer NOT NULL DEFAULT 0,
  is_horse boolean NOT NULL DEFAULT false, updated_at timestamptz);
CREATE TABLE public.clubs (id uuid PRIMARY KEY, name text, asset text, is_platform boolean, union_id uuid);
CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY, club_id uuid REFERENCES public.clubs(id), union_id uuid, name text,
  variant text, tournament_type text, max_players integer, format_contract text,
  buy_in_amount numeric, buy_in_fee numeric, bounty_amount numeric, status text,
  starting_chips integer, spin_multiplier numeric, prize_pool numeric, spin_locked_tiers jsonb,
  blind_structure text, payout_structure text);
CREATE TABLE public.tournament_players (id uuid PRIMARY KEY, tournament_id uuid, user_id uuid, status text);
CREATE TABLE public.table_seats (id uuid PRIMARY KEY, stack bigint, left_at timestamptz);

CREATE TABLE public.diamond_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, type text, transaction_type text,
  amount integer NOT NULL, balance_after bigint, reference_id text UNIQUE, description text, source text,
  issuance_class text, counterparty text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp());

CREATE TABLE public.ca_mint_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), op_id text NOT NULL UNIQUE,
  action text NOT NULL CHECK (action IN ('mint','burn')), asset text NOT NULL CHECK (asset IN ('chips','diamonds')),
  holder_type text NOT NULL CHECK (holder_type IN ('club','union','player','house','circulation')),
  holder_id uuid, holder_label text, amount numeric NOT NULL CHECK (amount > 0),
  balance_before numeric, balance_after numeric, supply_after numeric,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 10),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), diamond_tx_id uuid);

CREATE TABLE public.ca_diamond_house (id integer PRIMARY KEY, balance numeric, updated_at timestamptz);
CREATE TABLE public.ca_diamond_house_earmarks (
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), entry text NOT NULL, earmark_key text NOT NULL,
  purpose text NOT NULL, amount bigint NOT NULL, tournament_id uuid, holder_id uuid, expires_at timestamptz,
  recorded_by uuid, reason text NOT NULL);
CREATE TABLE public.tournament_escrow (tournament_id uuid PRIMARY KEY);

CREATE TABLE public.poker_diamond_custody (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES public.profiles(id),
  arena_id uuid NOT NULL, purpose text NOT NULL, target_id uuid NOT NULL, entry_key text NOT NULL,
  balance bigint NOT NULL, state text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz, seat_id uuid, seat_joined_at timestamptz, occupancy_id uuid);

CREATE TABLE public.poker_diamond_movements (
  request_id uuid PRIMARY KEY, custody_id uuid NOT NULL REFERENCES public.poker_diamond_custody(id),
  user_id uuid NOT NULL REFERENCES public.profiles(id), action text NOT NULL, amount bigint NOT NULL,
  source_account text NOT NULL, destination_account text NOT NULL, wallet_journal_id uuid,
  request jsonb NOT NULL, receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT poker_diamond_movements_action_check CHECK ((action = ANY (ARRAY['reserve'::text, 'release'::text]))),
  CONSTRAINT poker_diamond_movements_amount_check CHECK (((((amount >= 1) AND (amount <= 2147483647)) AND (wallet_journal_id IS NOT NULL)) OR ((action = 'release'::text) AND (amount = 0) AND (wallet_journal_id IS NULL)))),
  CONSTRAINT poker_diamond_movements_check CHECK ((source_account <> destination_account)));

CREATE TABLE public.poker_diamond_tournament_ledger (
  id bigserial PRIMARY KEY, tournament_id uuid NOT NULL REFERENCES public.tournaments(id), arena_id uuid NOT NULL,
  user_id uuid REFERENCES public.profiles(id), custody_id uuid REFERENCES public.poker_diamond_custody(id),
  kind text NOT NULL, amount bigint NOT NULL, prize_part bigint NOT NULL, bounty_part bigint NOT NULL,
  fee_part bigint NOT NULL, idempotency_key text NOT NULL UNIQUE, wallet_journal_id uuid, obligation_id uuid,
  registration_id uuid, request jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT poker_diamond_tournament_ledger_amount_check CHECK (((amount >= 1) AND (amount <= 2147483647))),
  CONSTRAINT poker_diamond_tournament_ledger_parts CHECK ((((prize_part + bounty_part) + fee_part) = amount)),
  CONSTRAINT poker_diamond_tournament_ledger_kind_check CHECK ((kind = ANY (ARRAY['entry'::text, 'rebuy'::text, 'reentry'::text, 'addon'::text, 'prize'::text, 'bounty'::text, 'fee'::text, 'refund'::text, 'spin_underwrite'::text, 'spin_surplus'::text, 'overlay'::text, 'overlay_return'::text]))),
  CONSTRAINT poker_diamond_tournament_ledger_inflow CHECK (((kind <> ALL (ARRAY['entry'::text, 'rebuy'::text, 'reentry'::text, 'addon'::text])) OR ((user_id IS NOT NULL) AND (custody_id IS NOT NULL) AND (wallet_journal_id IS NOT NULL)))),
  CONSTRAINT poker_diamond_tournament_ledger_outflow CHECK ((((kind = ANY (ARRAY['prize'::text, 'bounty'::text, 'refund'::text])) AND (user_id IS NOT NULL)) OR ((kind = 'fee'::text) AND (user_id IS NULL) AND (prize_part = 0) AND (bounty_part = 0)) OR (kind = ANY (ARRAY['entry'::text, 'rebuy'::text, 'reentry'::text, 'addon'::text])) OR ((kind = ANY (ARRAY['spin_underwrite'::text, 'spin_surplus'::text, 'overlay'::text, 'overlay_return'::text])) AND (user_id IS NOT NULL) AND (custody_id IS NOT NULL) AND (wallet_journal_id IS NOT NULL) AND (prize_part = amount) AND (bounty_part = 0) AND (fee_part = 0)))));

CREATE TABLE public.diamond_purchase_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, issued integer NOT NULL DEFAULT 0,
  consumed integer NOT NULL DEFAULT 0, refunded integer NOT NULL DEFAULT 0, arena_reserved bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), frozen_at timestamptz);
CREATE TABLE public.poker_diamond_lot_reservations (
  custody_id uuid NOT NULL, lot_id uuid NOT NULL, amount bigint NOT NULL, released_at timestamptz,
  consumed bigint NOT NULL DEFAULT 0);

CREATE TABLE public.poker_diamond_spin_contracts (
  tournament_id uuid PRIMARY KEY, buy_in bigint NOT NULL, starting_chips integer NOT NULL,
  rake_rate numeric NOT NULL DEFAULT 0, rule_manifest jsonb NOT NULL, rule_sha256 text NOT NULL,
  worst_excess bigint NOT NULL, required_cover bigint NOT NULL);
CREATE TABLE public.poker_diamond_spin_reserve_source (
  id smallint PRIMARY KEY, source_account text NOT NULL, max_underwrite_per_spin bigint NOT NULL,
  authorized_by text NOT NULL, ruling text NOT NULL, authorized_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.spin_draw_receipts (
  tournament_id uuid PRIMARY KEY, launch_id uuid NOT NULL, lease_generation uuid NOT NULL,
  rule_manifest jsonb NOT NULL, rule_sha256 text NOT NULL, entrants jsonb NOT NULL, receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.ca_guard_defs (proname text PRIMARY KEY, def_hash text, updated_at timestamptz DEFAULT now(),
  declared_ref text, declared_at timestamptz);
CREATE TABLE public.ca_guard_def_history (proname text, def_hash text, def_text text, PRIMARY KEY (proname, def_hash));
-- Reduced: the two names on production's watchlist that 20261007132503 declares.
CREATE FUNCTION public.fn_ca_guard_watchlist() RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT ARRAY['fn_poker_diamond_tournament_drain','fn_poker_diamond_tournament_settle_fee']::text[] $$;

-- FIXTURE REDUCTION of fn_ca_diamond_register_follows_journal: every non-zero
-- journal row except the arena doors and journal backfills becomes a
-- player-holder register row with balance_before derived from the row's
-- balance_after, as production derives it.
CREATE FUNCTION public.fixture_register_follows_journal() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE v_supply numeric;
BEGIN
  IF NEW.amount = 0 OR COALESCE(NEW.source,'') IN ('journal_backfill','the_mint')
     OR lower(COALESCE(NEW.transaction_type, NEW.type)) IN ('arena_deposit','arena_withdraw') THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(SUM(CASE WHEN action='mint' THEN amount ELSE -amount END),0) INTO v_supply
    FROM public.ca_mint_ledger WHERE asset='diamonds';
  INSERT INTO public.ca_mint_ledger(op_id, action, asset, holder_type, holder_id, holder_label, amount,
    balance_before, balance_after, supply_after, reason, diamond_tx_id)
  VALUES ('diamond-journal:'||CASE WHEN NEW.amount<0 THEN 'spend' ELSE 'credit' END||':'||NEW.id,
    CASE WHEN NEW.amount<0 THEN 'burn' ELSE 'mint' END, 'diamonds', 'player', NEW.user_id, NEW.user_id::text,
    abs(NEW.amount), NEW.balance_after - NEW.amount, NEW.balance_after, v_supply + NEW.amount,
    'The register follows the journal: '||COALESCE(NEW.description,'a journal row'), NEW.id);
  RETURN NEW;
END $f$;
CREATE TRIGGER trg_ca_diamond_register_follows_journal AFTER INSERT ON public.diamond_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fixture_register_follows_journal();

-- FIXTURE REDUCTION of fn_ca_arena_diamonds: the arena float is what the
-- entries hold in custody (the only arena pool these doors move).
CREATE FUNCTION public.fn_ca_arena_diamonds() RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody WHERE state <> 'released' $$;

-- Production's own text from here.
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_register_vs_supply()
 RETURNS TABLE(register_net numeric, meter_total numeric, player_diamonds numeric, house_diamonds numeric, difference numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH r AS (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) AS net
               FROM public.ca_mint_ledger WHERE asset = 'diamonds'),
       p AS (SELECT COALESCE(SUM(COALESCE(diamonds, 0)), 0)::numeric AS held FROM public.profiles),
       h AS (SELECT COALESCE(SUM(COALESCE(balance, 0)), 0)::numeric AS held FROM public.ca_diamond_house)
  SELECT round(r.net, 2), round(p.held + h.held + public.fn_ca_arena_diamonds(), 2), round(p.held, 2), round(h.held, 2),
         round(p.held + h.held + public.fn_ca_arena_diamonds() - r.net, 2)
    FROM r, p, h;
$function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH l AS (
    SELECT
      COALESCE(sum(prize_part)  FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS prize_in,
      COALESCE(sum(bounty_part) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS bounty_in,
      COALESCE(sum(fee_part)    FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')),0) AS fee_in,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'prize'),0)  AS prize_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'bounty'),0) AS bounty_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'fee'),0)    AS fee_out,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'refund'),0) AS refund_out,
      COALESCE(sum(prize_part)  FILTER (WHERE kind = 'refund'),0) AS refund_prize,
      COALESCE(sum(bounty_part) FILTER (WHERE kind = 'refund'),0) AS refund_bounty,
      COALESCE(sum(fee_part)    FILTER (WHERE kind = 'refund'),0) AS refund_fee,
      -- DIAMOND PHASE 9: a Spin's reserve legs move its prize bank, whole.
      COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_underwrite'),0) AS spin_underwrite,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'spin_surplus'),0) AS spin_surplus,
      -- 2026-10-06: a guarantee's overlay legs move it too, whole.
      COALESCE(sum(amount)      FILTER (WHERE kind = 'overlay'),0) AS overlay,
      COALESCE(sum(amount)      FILTER (WHERE kind = 'overlay_return'),0) AS overlay_return
    FROM public.poker_diamond_tournament_ledger WHERE tournament_id = p_tournament_id)
  SELECT prize_in::numeric, bounty_in::numeric, fee_in::numeric, (overlay - overlay_return)::numeric, 0::numeric,
         prize_out::numeric, bounty_out::numeric, fee_out::numeric, refund_out::numeric,
         (prize_in + spin_underwrite - spin_surplus + overlay - overlay_return - prize_out - refund_prize)::numeric,
         (bounty_in - bounty_out - refund_bounty)::numeric,
         (fee_in - fee_out - refund_fee)::numeric
  FROM l;
$function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament_custody(p_tournament_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(sum(balance),0)::bigint FROM public.poker_diamond_custody
   WHERE purpose = 'tournament_entry' AND target_id = p_tournament_id AND state <> 'released';
$function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_tournament(p_tournament_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.tournaments t JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
       AND c.union_id IS NULL AND t.union_id IS NULL);
$function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_entry_custody_is_the_entry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_moved bigint;
BEGIN
 -- OLD is only touched inside the UPDATE branch; a BEFORE/AFTER INSERT has none.
 IF TG_OP='UPDATE' THEN
   IF OLD.purpose='tournament_entry' OR NEW.purpose='tournament_entry' THEN
     IF NEW.user_id IS DISTINCT FROM OLD.user_id
        OR NEW.target_id IS DISTINCT FROM OLD.target_id
        OR NEW.arena_id IS DISTINCT FROM OLD.arena_id
        OR NEW.entry_key IS DISTINCT FROM OLD.entry_key
        OR NEW.purpose IS DISTINCT FROM OLD.purpose THEN
       RAISE EXCEPTION 'A Diamond Tournament Entry Is Fixed To The Player And Event It Paid For'
         USING ERRCODE='P0815';
     END IF;
   END IF;
 END IF;
 IF NEW.purpose <> 'tournament_entry' THEN RETURN NULL; END IF;

 IF NEW.seat_id IS NOT NULL OR NEW.seat_joined_at IS NOT NULL OR NEW.occupancy_id IS NOT NULL THEN
   RAISE EXCEPTION 'A Diamond Tournament Entry Never Binds To A Seat' USING ERRCODE='P0813';
 END IF;

 SELECT COALESCE(sum(CASE WHEN m.action='reserve' THEN m.amount ELSE -m.amount END),0)
   INTO v_moved FROM public.poker_diamond_movements m WHERE m.custody_id=NEW.id;
 IF NEW.balance IS DISTINCT FROM v_moved THEN
   RAISE EXCEPTION 'A Diamond Tournament Entry Holds Only What Was Reserved For It'
     USING ERRCODE='P0814';
 END IF;

 RETURN NULL;
END $function$;
CREATE CONSTRAINT TRIGGER zzz_diamond_entry_custody_is_the_entry AFTER INSERT OR UPDATE ON public.poker_diamond_custody
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_poker_diamond_entry_custody_is_the_entry();

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earmark_open(p_key text)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(CASE e.entry WHEN 'open' THEN e.amount ELSE -e.amount END), 0)::bigint
    FROM public.ca_diamond_house_earmarks e
   WHERE e.earmark_key = p_key
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_unit_floor_cents(p_cents bigint, p_unit_cents integer DEFAULT 1)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_cents IS NULL THEN NULL
    WHEN p_cents <= 0 THEN 0
    ELSE (trunc(p_cents::numeric
                / (CASE WHEN p_unit_cents IS NOT NULL AND p_unit_cents >= 1
                        THEN p_unit_cents::numeric ELSE 1 END))
          * (CASE WHEN p_unit_cents IS NOT NULL AND p_unit_cents >= 1
                  THEN p_unit_cents::numeric ELSE 1 END))::bigint
  END;
$function$;

-- (production's own text, its explanatory comment block omitted)
CREATE OR REPLACE FUNCTION public.fn_ca_declare_guard_redefinition(p_proname text, p_ref text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hash text;
  v_def text;
BEGIN
  IF COALESCE(btrim(p_ref), '') = '' THEN
    RAISE EXCEPTION 'a guard redefinition must name the migration that made it';
  END IF;
  IF NOT (p_proname = ANY (public.fn_ca_guard_watchlist())) THEN
    RAISE EXCEPTION 'fn_ca_declare_guard_redefinition called for %, which is not on the guard watchlist', p_proname;
  END IF;

  SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)),
         string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)
    INTO v_hash, v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_proname;

  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'guard function % does not exist; a declaration cannot baseline an absent guard', p_proname;
  END IF;

  INSERT INTO public.ca_guard_def_history (proname, def_hash, def_text)
  VALUES (p_proname, v_hash, v_def)
  ON CONFLICT (proname, def_hash) DO NOTHING;

  INSERT INTO public.ca_guard_defs (proname, def_hash, declared_ref, declared_at)
  VALUES (p_proname, v_hash, p_ref, now())
  ON CONFLICT (proname) DO UPDATE
    SET def_hash = EXCLUDED.def_hash,
        declared_ref = EXCLUDED.declared_ref,
        declared_at = EXCLUDED.declared_at,
        updated_at = now();

  RETURN v_hash;
END;
$function$;

-- The fixture's own readers for the cases.
CREATE FUNCTION public.fixture_journal_gaps() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM public.profiles p
   WHERE p.diamonds::bigint <> COALESCE((SELECT SUM(t.amount) FROM public.diamond_transactions t WHERE t.user_id = p.id),0) $$;
CREATE FUNCTION public.fixture_identity() RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT difference FROM public.fn_ca_diamond_register_vs_supply() $$;
CREATE FUNCTION public.fixture_house_leg_journals() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM public.diamond_transactions
   WHERE transaction_type IN ('tournament_fee','arena_spin_surplus','arena_guarantee_overlay_return',
                              'arena_guarantee_overlay','arena_spin_underwrite') $$;
