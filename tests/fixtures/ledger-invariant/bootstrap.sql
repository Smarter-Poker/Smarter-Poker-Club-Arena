-- tests/fixtures/ledger-invariant/bootstrap.sql
--
-- The smallest real-shaped slice of production that the migration
-- a_balance_never_moves_without_its_ledger_row installs onto, so the invariant
-- can be executed (not read) on an isolated PostgreSQL 17 in CI and on the Mac.
-- Column names and types are production's (information_schema.columns, read
-- 2026-10-01). The one behaviour copied in is the platform's own autoledger
-- contract on club_members.chip_balance: a balance write journals itself
-- unless the caller stands the journal down with app.ledger_autoskip_<table>,
-- in which case the caller has promised to write the leg. That promise is what
-- the invariant verifies.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE TABLE public.clubs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text,
  asset         text,
  chip_treasury numeric NOT NULL DEFAULT 0,
  chip_pool     numeric NOT NULL DEFAULT 0
);

CREATE TABLE public.club_members (
  club_id      uuid NOT NULL REFERENCES public.clubs(id),
  user_id      uuid NOT NULL,
  chip_balance numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (club_id, user_id)
);

CREATE TABLE public.tables (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id       uuid REFERENCES public.clubs(id),
  tournament_id uuid
);

CREATE TABLE public.table_seats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    uuid NOT NULL REFERENCES public.tables(id),
  user_id     uuid,
  seat_number integer,
  stack       numeric NOT NULL DEFAULT 0,
  left_at     timestamptz
);

CREATE TABLE public.table_pending_addons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    uuid NOT NULL REFERENCES public.tables(id),
  user_id     uuid,
  amount      numeric NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  applied_to_stack numeric,
  refunded    numeric
);

CREATE TABLE public.union_wallets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  union_id            uuid NOT NULL UNIQUE,
  chip_balance        numeric NOT NULL DEFAULT 0,
  rake_wallet         numeric NOT NULL DEFAULT 0,
  bbj_wallet          numeric NOT NULL DEFAULT 0,
  promo_wallet        numeric NOT NULL DEFAULT 0,
  insurance_wallet    numeric NOT NULL DEFAULT 0,
  spin_reserve_wallet numeric,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bbj_pools (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id        uuid,
  union_id       uuid,
  main_balance   numeric NOT NULL DEFAULT 0,
  backup_balance numeric NOT NULL DEFAULT 0,
  promo_balance  numeric NOT NULL DEFAULT 0
);

CREATE TABLE public.chip_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  performed_by    uuid,
  from_type       text NOT NULL,
  from_entity_id  uuid,
  to_type         text NOT NULL,
  to_entity_id    uuid,
  amount          numeric NOT NULL,
  category        text NOT NULL,
  description     text,
  club_id         uuid,
  union_id        uuid,
  idempotency_key text,
  metadata        jsonb,
  status          text NOT NULL DEFAULT 'posted',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The registers the migration writes to, shaped as production has them.
CREATE TABLE public.ca_declared_money_triggers (
  table_name   text NOT NULL,
  trigger_name text NOT NULL,
  declared_at  timestamptz NOT NULL DEFAULT now(),
  note         text,
  PRIMARY KEY (table_name, trigger_name)
);

CREATE TABLE public.ca_guard_defs (
  proname      text PRIMARY KEY,
  def_hash     text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  declared_ref text,
  declared_at  timestamptz
);

CREATE TABLE public.ca_guard_def_history (
  id       bigserial PRIMARY KEY,
  proname  text NOT NULL,
  def_hash text NOT NULL,
  def_text text,
  UNIQUE (proname, def_hash)
);

-- Production's declaration door, verbatim in effect (20260910143032).
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

-- The watchlist as it stood before the migration (the migration replaces it).
CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['fn_ca_guard_watchlist']::text[] $$;

-- THE AUTOLEDGER CONTRACT, as production's fn_club_members_ledger_writer and
-- fn_ca_autoledger apply it: a balance write journals its own delta against the
-- declared (or suspense) counterparty, unless the caller has stood it down.
CREATE OR REPLACE FUNCTION public.fx_autoledger_club_members()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; cp text; cpid uuid;
BEGIN
  IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN RETURN NEW; END IF;
  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);
  IF d = 0 THEN RETURN NEW; END IF;
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL; END;
  INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, description)
  VALUES (CASE WHEN d > 0 THEN cp ELSE 'player_wallet' END,
          CASE WHEN d > 0 THEN cpid ELSE NEW.user_id END,
          CASE WHEN d > 0 THEN 'player_wallet' ELSE cp END,
          CASE WHEN d > 0 THEN NEW.user_id ELSE cpid END,
          abs(d), COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment'),
          NEW.club_id, 'auto-audited club_members.chip_balance delta ' || d::text);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_club_members_audit_chip_movement
  AFTER UPDATE OF chip_balance ON public.club_members
  FOR EACH ROW WHEN (OLD.chip_balance IS DISTINCT FROM NEW.chip_balance)
  EXECUTE FUNCTION public.fx_autoledger_club_members();

CREATE OR REPLACE FUNCTION public.fx_autoledger_union_wallets()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; cp text; cpid uuid; o jsonb; n jsonb; spec text; col text; acct text;
BEGIN
  IF current_setting('app.ledger_autoskip_union_wallets', true) = '1' THEN RETURN NEW; END IF;
  o := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  n := to_jsonb(NEW);
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL; END;
  FOREACH spec IN ARRAY ARRAY['chip_balance=union_bank','rake_wallet=union_wallet','bbj_wallet=union_wallet',
                              'promo_wallet=union_wallet','insurance_wallet=union_wallet','spin_reserve_wallet=union_wallet'] LOOP
    col := split_part(spec, '=', 1); acct := split_part(spec, '=', 2);
    d := round(COALESCE(NULLIF(n ->> col, '')::numeric, 0) - COALESCE(NULLIF(o ->> col, '')::numeric, 0), 2);
    CONTINUE WHEN d = 0;
    -- production stamps the union_wallets ROW id as the entity (fn_ca_autoledger v_entity = nn->>'id')
    INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, description)
    VALUES (CASE WHEN d > 0 THEN cp ELSE acct END, CASE WHEN d > 0 THEN cpid ELSE NEW.id END,
            CASE WHEN d > 0 THEN acct ELSE cp END, CASE WHEN d > 0 THEN NEW.id ELSE cpid END,
            abs(d), COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment'),
            'auto-ledgered union_wallets.' || col || ' delta ' || d::text);
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ca_autoledger
  AFTER INSERT OR UPDATE OF chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet, spin_reserve_wallet ON public.union_wallets
  FOR EACH ROW EXECUTE FUNCTION public.fx_autoledger_union_wallets();

CREATE OR REPLACE FUNCTION public.fx_autoledger_bbj_pools()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; cp text; cpid uuid; o jsonb; n jsonb; col text;
BEGIN
  IF current_setting('app.ledger_autoskip_bbj_pools', true) = '1' THEN RETURN NEW; END IF;
  o := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  n := to_jsonb(NEW);
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL; END;
  FOREACH col IN ARRAY ARRAY['main_balance','backup_balance','promo_balance'] LOOP
    d := round(COALESCE(NULLIF(n ->> col, '')::numeric, 0) - COALESCE(NULLIF(o ->> col, '')::numeric, 0), 2);
    CONTINUE WHEN d = 0;
    INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, description)
    VALUES (CASE WHEN d > 0 THEN cp ELSE 'bbj_pool' END, CASE WHEN d > 0 THEN cpid ELSE NEW.id END,
            CASE WHEN d > 0 THEN 'bbj_pool' ELSE cp END, CASE WHEN d > 0 THEN NEW.id ELSE cpid END,
            abs(d), COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment'),
            'auto-ledgered bbj_pools.' || col || ' delta ' || d::text);
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ca_autoledger
  AFTER INSERT OR UPDATE OF main_balance, backup_balance, promo_balance ON public.bbj_pools
  FOR EACH ROW EXECUTE FUNCTION public.fx_autoledger_bbj_pools();

CREATE OR REPLACE FUNCTION public.fx_autoledger_clubs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; cp text; cpid uuid;
BEGIN
  IF current_setting('app.ledger_autoskip_clubs', true) = '1' THEN RETURN NEW; END IF;
  d := round((COALESCE(NEW.chip_treasury, 0) + COALESCE(NEW.chip_pool, 0))
           - (COALESCE(OLD.chip_treasury, 0) + COALESCE(OLD.chip_pool, 0)), 2);
  IF d = 0 THEN RETURN NEW; END IF;
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL; END;
  INSERT INTO public.chip_ledger (from_type, from_entity_id, to_type, to_entity_id, amount, category, club_id, description)
  VALUES (CASE WHEN d > 0 THEN cp ELSE 'club_treasury' END, CASE WHEN d > 0 THEN cpid ELSE NEW.id END,
          CASE WHEN d > 0 THEN 'club_treasury' ELSE cp END, CASE WHEN d > 0 THEN NEW.id ELSE cpid END,
          abs(d), COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment'),
          NEW.id, 'auto-ledgered clubs.chip_treasury delta ' || d::text);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ca_autoledger
  AFTER UPDATE OF chip_treasury, chip_pool ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.fx_autoledger_clubs();

-- The live promo_apply_playthrough body as read on 2026-10-01 (md5 of
-- pg_get_functiondef = ee9bcdf31b5f212b67e0ff536033f20c), so the migration's
-- pinned redefinition is exercised here exactly as it will be on production.
-- It references player_stats, chip_transactions and auth.role(), which this
-- fixture does not have; plpgsql resolves those at call time and the fixture
-- never calls it.
CREATE OR REPLACE FUNCTION public.promo_apply_playthrough(p_club_id uuid, p_user_id uuid, p_wagered numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_promo    numeric;
  v_required numeric;
  v_wagered  numeric;
  v_released numeric := 0;
  v_caller   text := COALESCE(auth.role(), '');
BEGIN
  /* ZERO-DRIFT (2026-08-31): the wager figure is engine truth. Only the
     engine (service_role) or trusted admin context may apply playthrough -
     an authenticated user could previously release ANY member's locked promo
     by claiming an arbitrary wager. Fail closed. */
  IF NOT (v_caller = 'service_role'
          OR (v_caller = '' AND current_user IN ('postgres', 'supabase_admin'))) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'engine_only');
  END IF;

  IF p_wagered IS NULL OR p_wagered <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_wager');
  END IF;

  BEGIN
    INSERT INTO player_stats (id, user_id, club_id, total_losses, updated_at)
    VALUES (gen_random_uuid(), p_user_id, p_club_id, p_wagered, now())
    ON CONFLICT (user_id, club_id) DO UPDATE
       SET total_losses = player_stats.total_losses + EXCLUDED.total_losses,
           updated_at   = now();
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  SELECT COALESCE(promo_balance, 0), COALESCE(promo_playthrough_required, 0), COALESCE(promo_wagered, 0)
    INTO v_promo, v_required, v_wagered
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_user_id
   FOR UPDATE;

  IF v_promo IS NULL OR v_promo <= 0 OR v_required <= 0 THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_outstanding_promo');
  END IF;

  v_wagered := v_wagered + p_wagered;

  IF v_wagered >= v_required THEN
    /* Exact release - the old v_promo::integer truncated fractions into
       nothing while promo_balance was zeroed in full. */
    v_released := round(v_promo, 2);

    PERFORM set_config('app.ledger_category', 'promo_release', true);
    PERFORM set_config('app.ledger_counterparty', 'promo_wallet', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_user_id::text, true);
    PERFORM set_config('app.ledger_autoskip_club_members', '1', true);
    UPDATE club_members
       SET chip_balance               = COALESCE(chip_balance, 0) + v_released,
           promo_balance              = 0,
           promo_playthrough_required = 0,
           promo_wagered              = 0,
           updated_at                 = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;
    PERFORM set_config('app.ledger_autoskip_club_members', '0', true);

    INSERT INTO chip_transactions (id, club_id, to_user_id, amount, transaction_type, notes, created_at)
    VALUES (gen_random_uuid(), p_club_id, p_user_id, v_released, 'promo_released',
            'Promo bonus released to cashable balance after playthrough met', NOW());
  ELSE
    UPDATE club_members
       SET promo_wagered = v_wagered, updated_at = NOW()
     WHERE club_id = p_club_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('applied', true, 'released', v_released,
                            'wagered', v_wagered, 'required', v_required);
END;
$function$;
