\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

/* The real obligations-aware settlement resolves pgcrypto through the
   production `extensions` schema. Keep the focused fixture's historical
   public install, but expose the same bytea digest signature for the final
   surviving-door execution probe. */
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.digest(bytea, text)
RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT public.digest($1, $2)
$function$;

/* Stage B acquires the global Realtime catalog lock before any public
   relation lock or DDL. The focused database must carry that production
   relation so a missing or reordered lock cannot be hidden by the fixture. */
CREATE SCHEMA realtime;
CREATE TABLE realtime.subscription (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
);

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOLOGIN;
  END IF;
END;
$roles$;

CREATE SCHEMA auth;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$function$;

CREATE TABLE public.tournaments (
  id uuid PRIMARY KEY,
  club_id uuid,
  union_id uuid,
  name text NOT NULL,
  game_type text,
  variant text,
  tournament_type text,
  buy_in_amount numeric NOT NULL DEFAULT 0,
  buy_in_fee numeric NOT NULL DEFAULT 0,
  guaranteed_prize numeric NOT NULL DEFAULT 0,
  starting_chips integer,
  max_players integer,
  min_players integer,
  table_size integer,
  current_players integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  blind_structure text,
  payout_structure text,
  start_time timestamptz,
  late_reg_levels integer NOT NULL DEFAULT 0,
  late_reg_mins integer NOT NULL DEFAULT 0,
  satellite_target_id uuid,
  satellite_seats integer,
  short_description text,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid,
  tournament_id uuid REFERENCES public.tournaments(id) ON DELETE CASCADE,
  name text,
  game_type text,
  game_variant text,
  stakes text,
  small_blind numeric,
  big_blind numeric,
  min_buy_in numeric,
  max_buy_in numeric,
  status text NOT NULL,
  current_players integer NOT NULL DEFAULT 0,
  max_players integer NOT NULL DEFAULT 9,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

/* The focused rolling-cutover probe must reach the database admission guard
   as the same API roles PostgREST uses. Production RLS is outside this narrow
   fixture; these grants exercise the trigger rather than stopping at ACL. */
GRANT INSERT ON TABLE public.tables TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_entry_purchases_frozen()
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$ SELECT false $function$;

/* Model every legacy payout-repair dispatch surface that Stage A must preserve
   and Stage B must retire after the old engine has drained. */
CREATE TABLE public.ca_money_rpc_registry (
  proname text PRIMARY KEY
);
CREATE TABLE public.ca_settle_sources (
  source text PRIMARY KEY
);
CREATE TABLE public.ca_expected_cron_jobs (
  jobname text PRIMARY KEY
);
CREATE TABLE public.financial_alerts (
  source text NOT NULL,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  resolution text
);

CREATE OR REPLACE FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT '{}'::jsonb $function$;
CREATE OR REPLACE FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT '{}'::jsonb $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT '{}'::jsonb $function$;
CREATE OR REPLACE FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT '{}'::jsonb $function$;
CREATE OR REPLACE FUNCTION public.fn_backpay_hu_winner_shortfalls(integer)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT '{}'::jsonb $function$;
CREATE OR REPLACE PROCEDURE public.sp_ca_reconcile_backpaid_events(boolean)
LANGUAGE plpgsql SECURITY DEFINER
AS $procedure$ BEGIN NULL; END $procedure$;

GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_reconcile(uuid, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_pay_backed_payout_shortfalls(boolean, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_backpay_guarantee_shortfalls(boolean, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_payout_sweep(integer, boolean, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_backpay_hu_winner_shortfalls(integer)
  TO service_role;
GRANT EXECUTE ON PROCEDURE public.sp_ca_reconcile_backpaid_events(boolean)
  TO service_role;

INSERT INTO public.ca_money_rpc_registry(proname) VALUES
  ('fn_tournament_payout_reconcile'),
  ('fn_pay_backed_payout_shortfalls'),
  ('fn_ca_backpay_guarantee_shortfalls'),
  ('fn_tournament_payout_sweep'),
  ('sp_ca_reconcile_backpaid_events'),
  ('fn_backpay_hu_winner_shortfalls');
INSERT INTO public.ca_settle_sources(source) VALUES
  ('reconcile'),
  ('fn_tournament_payout_reconcile'),
  ('fn_pay_backed_payout_shortfalls'),
  ('fn_ca_backpay_guarantee_shortfalls'),
  ('fn_tournament_payout_sweep'),
  ('sp_ca_reconcile_backpaid_events'),
  ('fn_backpay_hu_winner_shortfalls');
INSERT INTO public.ca_expected_cron_jobs(jobname) VALUES ('ca-payout-sweep-hourly');
INSERT INTO public.financial_alerts(source) VALUES
  ('fn_tournament_payout_sweep'),
  ('fn_tournament_payout_sweep_truncated');

/* Stage B must exercise the real compatibility-door retirement, even though
   this narrow fixture does not need the historical repair implementation. */
CREATE OR REPLACE FUNCTION public.fn_repair_seat_first_games(integer)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
AS $function$
  SELECT jsonb_build_object('repaired', 0, 'horses_seated', 0)
$function$;

CREATE OR REPLACE FUNCTION public.fn_repair_seat_first_games_before_maintenance_gate(integer)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
AS $function$
  SELECT jsonb_build_object('repaired', 0, 'horses_seated', 0)
$function$;

CREATE TABLE public.tournament_players (
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  status text NOT NULL,
  position integer,
  chips numeric NOT NULL DEFAULT 0,
  table_id uuid REFERENCES public.tables(id) ON DELETE SET NULL,
  seat_number integer,
  PRIMARY KEY (tournament_id, user_id)
);

CREATE TABLE public.table_seats (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
  user_id uuid,
  seat_number integer NOT NULL,
  stack numeric NOT NULL DEFAULT 0,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  club_id uuid,
  left_at timestamptz,
  time_bank_uses_remaining integer,
  time_bank_remaining integer,
  PRIMARY KEY (table_id, seat_number)
);

/* Minimal durable receipt reached by the real obligations-aware 12-argument
   door during the final Stage-B execution probe. The owner-only core below
   creates the accepted-hand receipt; the exact outer function attaches its
   immutable envelope to these production-named columns. */
CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL UNIQUE,
  post_commit_payload jsonb,
  post_commit_request_hash text,
  post_commit_payload_hash text,
  post_commit_completed_at timestamptz,
  PRIMARY KEY (table_id, hand_number)
);

CREATE TABLE public.table_pending_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz
);

/* Prerequisites reached by the real zero-delta migration while constructing
   the exact predecessor definition inspected by 20260908161534. */
CREATE TABLE public.training_answers (
  user_id uuid,
  is_correct boolean,
  ev_loss numeric,
  level integer
);

CREATE OR REPLACE FUNCTION public.fn_ca_currency_meter()
RETURNS integer
LANGUAGE sql
AS $function$
  SELECT 1
$function$;

/* This authority probe exercises Stage B without replaying the unrelated
   4,000-line place-settlement migration. Model the exact Stage-A expand
   boundary that Stage B is allowed to contract: the private payer, its
   behavior-compatible public wrapper, and the installed-but-disabled terminal
   completion guard. Stage B proves these identities before replacing/enabling
   them, so a loose placeholder would make the probe less strict, not faster. */
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation_before_atomic_batch_gate(
  p_tournament_id uuid,
  p_kind text,
  p_place integer,
  p_user_id uuid,
  p_amount numeric,
  p_source text,
  p_description text DEFAULT NULL,
  p_adjustment_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object('ok', true, 'paid', round(COALESCE(p_amount, 0), 2))
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation_before_atomic_batch_gate(
  uuid, text, integer, uuid, numeric, text, text, uuid
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(
  p_tournament_id uuid,
  p_kind text,
  p_place integer,
  p_user_id uuid,
  p_amount numeric,
  p_source text,
  p_description text DEFAULT NULL,
  p_adjustment_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public.fn_settle_tournament_obligation_before_atomic_batch_gate(
    p_tournament_id, p_kind, p_place, p_user_id, p_amount, p_source,
    p_description, p_adjustment_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_obligation(
  uuid, text, integer, uuid, numeric, text, text, uuid
) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_tournament_atomic_place_completion_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE TRIGGER zzzz_tournaments_atomic_place_completion_guard
BEFORE UPDATE ON public.tournaments
FOR EACH ROW
WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED')
EXECUTE FUNCTION public.trg_tournament_atomic_place_completion_guard();

ALTER TABLE public.tournaments
  DISABLE TRIGGER zzzz_tournaments_atomic_place_completion_guard;

/* Model the remaining Stage-A tournament-finishing expand objects. The real
   migrations install these exact guards disabled so the old direct finish tail
   remains valid until the Stage-B contraction transaction. Empty batch tables
   are sufficient here because this probe tests catalog/request authority, not
   the independently rehearsed money plans. */
CREATE TABLE public.tournament_place_settlement_batches (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  settled_at timestamptz
);

CREATE TABLE public.tournament_final_table_deal_batches (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  chip_leader uuid,
  settled_at timestamptz
);

CREATE TABLE public.tournament_final_table_deal_receipts (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id)
);

CREATE TABLE public.tournament_satellite_settlement_batches (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  settled_at timestamptz
);

CREATE TABLE public.tournament_obligations (
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  kind text NOT NULL
);

CREATE TABLE public.tournament_payouts (
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
  source text NOT NULL
);

CREATE TABLE public.tournament_finish_receipts (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id),
  winner_user_id uuid NOT NULL,
  finish_kind text NOT NULL,
  claim_source text NOT NULL,
  certified_at timestamptz,
  completed_at timestamptz,
  evidence jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.fn_tournament_finish_kind(uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT 'normal'::text
$function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_finish_readiness(uuid, uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $function$
  SELECT jsonb_build_object('ok', true, 'failures', '[]'::jsonb)
$function$;

CREATE OR REPLACE FUNCTION public.fn_settle_satellite_cash_entitlement_exact(
  p_tournament_id uuid,
  p_kind text,
  p_place integer,
  p_user_id uuid,
  p_amount numeric,
  p_source text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public.fn_settle_tournament_obligation_before_atomic_batch_gate(
    p_tournament_id, p_kind, p_place, p_user_id, p_amount, p_source, NULL, NULL
  );
  RETURN p_user_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_settle_satellite_cash_entitlement_exact(
  uuid, text, integer, uuid, numeric, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trg_guard_atomic_satellite_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE TRIGGER aaa_guard_atomic_satellite_completion
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.trg_guard_atomic_satellite_completion();
ALTER TABLE public.tournaments
  DISABLE TRIGGER aaa_guard_atomic_satellite_completion;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_completing_claim()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE TRIGGER aa_guard_tournament_completing_claim
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_tournament_completing_claim();
ALTER TABLE public.tournaments
  DISABLE TRIGGER aa_guard_tournament_completing_claim;

CREATE OR REPLACE FUNCTION public.trg_atomic_final_table_deal_completion_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW
WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED')
EXECUTE FUNCTION public.trg_atomic_final_table_deal_completion_guard();
ALTER TABLE public.tournaments
  DISABLE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard;

CREATE OR REPLACE FUNCTION public.fn_guard_tournament_completed_certificate()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE TRIGGER zzzzzz_tournaments_financial_certificate
BEFORE UPDATE OF status ON public.tournaments
FOR EACH ROW
WHEN (NEW.status = 'COMPLETED' AND OLD.status IS DISTINCT FROM 'COMPLETED')
EXECUTE FUNCTION public.fn_guard_tournament_completed_certificate();
ALTER TABLE public.tournaments
  DISABLE TRIGGER zzzzzz_tournaments_financial_certificate;

CREATE OR REPLACE FUNCTION public.trg_tournament_pool_finalization_window_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE TRIGGER zzzz_tournament_pool_finalization_window_guard
BEFORE UPDATE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_pool_finalization_window_guard();
ALTER TABLE public.tournaments
  DISABLE TRIGGER zzzz_tournament_pool_finalization_window_guard;

CREATE OR REPLACE FUNCTION public.trg_freeze_finalized_tournament_prize_pool()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE TRIGGER zzzz_freeze_finalized_tournament_prize_pool
BEFORE UPDATE ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.trg_freeze_finalized_tournament_prize_pool();
ALTER TABLE public.tournaments
  DISABLE TRIGGER zzzz_freeze_finalized_tournament_prize_pool;

CREATE TABLE public.tournament_launch_receipts (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  launch_id uuid NOT NULL UNIQUE,
  lease_generation uuid NOT NULL,
  started_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  completed_at timestamptz
);

CREATE TABLE public.tournament_manager_wakes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (
    reason IN (
      'rebuy', 'reentry', 'addon', 'late_registration',
      'deal_vote', 'bounty_settled'
    )
  ),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_at timestamptz
);

CREATE UNIQUE INDEX uq_tournament_manager_wakes_pending_by_reason
  ON public.tournament_manager_wakes(tournament_id, reason)
  WHERE consumed_at IS NULL;

CREATE OR REPLACE FUNCTION public.fn_emit_tournament_manager_wake(
  p_tournament_id uuid,
  p_reason text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.tournament_manager_wakes AS pending (
    tournament_id,
    reason,
    generation
  ) VALUES (
    p_tournament_id,
    p_reason,
    1
  )
  ON CONFLICT (tournament_id, reason) WHERE consumed_at IS NULL
  DO UPDATE SET
    generation = pending.generation + 1,
    created_at = clock_timestamp()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

CREATE TABLE public.tournament_capacity_table_receipts (
  table_id uuid PRIMARY KEY REFERENCES public.tables(id) ON DELETE CASCADE,
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
  manager_wake_id bigint NOT NULL
    REFERENCES public.tournament_manager_wakes(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  manager_admitted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE CASCADE,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_version integer NOT NULL DEFAULT 2 CHECK (protocol_version IN (1, 2))
);

CREATE TABLE public.engine_table_leases (
  table_id uuid PRIMARY KEY REFERENCES public.tables(id) ON DELETE CASCADE,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_version integer NOT NULL DEFAULT 2 CHECK (protocol_version IN (1, 2))
);

CREATE OR REPLACE FUNCTION public.trg_one_live_seat_fixture()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_one_live_seat_per_tournament
  BEFORE INSERT OR UPDATE ON public.table_seats
  FOR EACH ROW EXECUTE FUNCTION public.trg_one_live_seat_fixture();

/* The launch-child migration asserts that the canonical capacity function
   creates a table before its same-transaction receipt. The probe never calls
   this minimal fixture implementation. */
CREATE OR REPLACE FUNCTION public.fn_ensure_late_registration_capacity(
  p_tournament_id uuid,
  p_required_seats integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_table_id uuid := gen_random_uuid();
  v_wake_id bigint;
BEGIN
  INSERT INTO public.tables (
    id, tournament_id, status, current_players, max_players
  ) VALUES (
    v_table_id, p_tournament_id, 'waiting', 0, greatest(p_required_seats, 1)
  );
  v_wake_id := public.fn_emit_tournament_manager_wake(
    p_tournament_id,
    'late_registration'
  );
  INSERT INTO public.tournament_capacity_table_receipts (
    table_id, tournament_id, manager_wake_id
  ) VALUES (
    v_table_id, p_tournament_id, v_wake_id
  );
  UPDATE public.tournament_capacity_table_receipts
     SET manager_wake_id = v_wake_id,
         updated_at = clock_timestamp()
   WHERE tournament_id = p_tournament_id
     AND manager_admitted_at IS NULL;
  RETURN jsonb_build_object('ok', true, 'table_id', v_table_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_tournament_lease(
  uuid, text, text, integer
) RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT false, NULL::text, NULL::numeric $function$;

CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v2(
  text, uuid[], integer
) RETURNS TABLE(tournament_id uuid, state text)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid, NULL::text WHERE false $function$;

CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases(
  text, uuid[]
) RETURNS TABLE(tournament_id uuid)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid WHERE false $function$;

CREATE OR REPLACE FUNCTION public.release_tournament_leases(
  text, uuid[]
) RETURNS integer
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT 0 $function$;

CREATE OR REPLACE FUNCTION public.claim_tournament_lease_v2(
  uuid, text, text, uuid, integer
) RETURNS TABLE(
  granted boolean,
  holder text,
  holder_age_seconds numeric,
  lease_generation uuid,
  protocol_version integer
)
LANGUAGE sql SECURITY DEFINER
AS $function$
  SELECT false, NULL::text, NULL::numeric, NULL::uuid, 2
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases_v3(
  text, jsonb, integer
) RETURNS TABLE(tournament_id uuid, state text, lease_generation uuid)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid, NULL::text, NULL::uuid WHERE false $function$;

CREATE OR REPLACE FUNCTION public.release_tournament_leases_v2(
  text, jsonb
) RETURNS integer
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT 0 $function$;

CREATE OR REPLACE FUNCTION public.claim_table_lease(
  uuid, text, text, integer
) RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT false, NULL::text, NULL::numeric $function$;

CREATE OR REPLACE FUNCTION public.heartbeat_table_leases_v2(
  text, uuid[], integer
) RETURNS TABLE(table_id uuid, state text)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid, NULL::text WHERE false $function$;

CREATE OR REPLACE FUNCTION public.heartbeat_table_leases(
  text, uuid[]
) RETURNS TABLE(table_id uuid)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid WHERE false $function$;

CREATE OR REPLACE FUNCTION public.release_table_leases(
  text, uuid[]
) RETURNS integer
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT 0 $function$;

CREATE OR REPLACE FUNCTION public.claim_table_lease_v2(
  uuid, text, text, uuid, integer
) RETURNS TABLE(
  granted boolean,
  holder text,
  holder_age_seconds numeric,
  lease_generation uuid,
  protocol_version integer
)
LANGUAGE sql SECURITY DEFINER
AS $function$
  SELECT false, NULL::text, NULL::numeric, NULL::uuid, 2
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_table_leases_v3(
  text, jsonb, integer
) RETURNS TABLE(table_id uuid, state text, lease_generation uuid)
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT NULL::uuid, NULL::text, NULL::uuid WHERE false $function$;

CREATE OR REPLACE FUNCTION public.release_table_leases_v2(
  text, jsonb
) RETURNS integer
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT 0 $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('success', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('success', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement_exact_before_obligations(
  uuid, bigint, jsonb, numeric, numeric, text, numeric, jsonb, jsonb, text, uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $function$
DECLARE
  v_hand_id uuid := '60000000-0000-4000-8000-000000000099';
  v_replay boolean;
BEGIN
  INSERT INTO public.hand_atomic_commits(table_id, hand_number, hand_id)
  VALUES ($1, $2, v_hand_id)
  ON CONFLICT (table_id, hand_number) DO NOTHING;
  v_replay := NOT FOUND;
  SELECT c.hand_id INTO v_hand_id
    FROM public.hand_atomic_commits c
   WHERE c.table_id = $1
     AND c.hand_number = $2;
  RETURN jsonb_build_object(
    'success', true,
    'atomic_hand_commit', true,
    'history_id', v_hand_id,
    'replay', v_replay
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(
  p_table_id uuid,
  p_hand_number bigint,
  p_stacks jsonb,
  p_rake numeric,
  p_bbj numeric,
  p_ref text,
  p_inflow numeric,
  p_hand_row jsonb,
  p_units jsonb,
  p_instance_id text,
  p_lease_generation uuid,
  p_post_commit_obligations jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_exact_seat_generation boolean := false;
  v_item jsonb;
  v_result jsonb;
  v_row_count integer;
  v_updated integer := 0;
BEGIN
  /* Model the real 20260908161534 expand contract, rather than satisfying
     Stage B with source-code marker strings. A request is wholly legacy or
     wholly exact, and an exact time-bank target must name the same immutable
     (seat id, joined_at) generation as its stack row. */
  IF jsonb_typeof(p_stacks) = 'array' AND jsonb_array_length(p_stacks) > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_stack_seat_generation)';
    END IF;
    IF EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id'
       ) AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')
       ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (mixed_stack_seat_generation_protocol)';
    END IF;

    SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
      INTO v_exact_seat_generation
      FROM jsonb_array_elements(p_stacks) x;

    IF jsonb_typeof(p_post_commit_obligations->'time_banks')
         IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_time_bank_seat_generation)';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
          OR (x ? 'seat_id') IS DISTINCT FROM v_exact_seat_generation
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_time_bank_seat_generation)';
    END IF;

    IF v_exact_seat_generation AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_stacks) s
          WHERE s->>'user_id' = x->>'user_id'
            AND s->>'seat_id' = x->>'seat_id'
            AND (s->>'seat_joined_at')::timestamptz =
                (x->>'seat_joined_at')::timestamptz
       )
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_generation_mismatch)';
    END IF;
  END IF;

  v_result := public.fn_ca_commit_hand_settlement_exact_before_obligations(
    p_table_id, p_hand_number, p_stacks, p_rake, p_bbj, p_ref, p_inflow,
    p_hand_row, p_units, p_instance_id, p_lease_generation
  );

  FOR v_item IN
    SELECT value
      FROM jsonb_array_elements(p_post_commit_obligations->'time_banks')
  LOOP
    UPDATE public.table_seats s
       SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
           time_bank_remaining = (v_item->>'seconds_remaining')::integer
     WHERE s.table_id = p_table_id
       AND s.user_id = (v_item->>'user_id')::uuid
       AND (
         (v_exact_seat_generation
           AND s.id = (v_item->>'seat_id')::uuid
           AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
         OR (NOT v_exact_seat_generation AND s.left_at IS NULL)
       );
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_updated := v_updated + v_row_count;
  END LOOP;

  IF v_updated IS DISTINCT FROM jsonb_array_length(
       p_post_commit_obligations->'time_banks'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (time_bank_seat_generation_mismatch)';
  END IF;

  RETURN v_result || jsonb_build_object('post_commit_obligations', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_process_hand_post_commit_obligations(
  uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('success', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('ok', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(
  uuid, uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('ok', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_begin_tournament_launch_atomic(
  uuid, uuid, timestamptz, uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('ok', true) $function$;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_launch_atomic(
  uuid, uuid, uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
AS $function$ SELECT jsonb_build_object('ok', true) $function$;

INSERT INTO public.tournaments (id, name, status) VALUES
  ('10000000-0000-4000-8000-000000000001', 'Fence A', 'RUNNING'),
  ('10000000-0000-4000-8000-000000000002', 'Fence B', 'RUNNING');

INSERT INTO public.tables (
  id, club_id, tournament_id, status, current_players, max_players
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'running', 0, 9
);

INSERT INTO public.tables (
  id, club_id, tournament_id, status, current_players, max_players
) VALUES (
  '20000000-0000-4000-8000-000000000002',
  '70000000-0000-4000-8000-000000000002',
  NULL,
  'running', 0, 9
);

INSERT INTO public.tournament_players (
  tournament_id, user_id, status, chips, table_id, seat_number
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001',
  'registered', 1000,
  '20000000-0000-4000-8000-000000000001', 1
);

INSERT INTO public.tournament_launch_receipts (
  tournament_id, launch_id, lease_generation, started_at, completed_at
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001',
  clock_timestamp() - interval '1 hour',
  clock_timestamp() - interval '59 minutes'
);

INSERT INTO public.engine_tournament_leases (
  tournament_id, instance_id, engine_version, heartbeat_at,
  lease_generation, protocol_version
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  'pg17-probe', 'probe', clock_timestamp(),
  '50000000-0000-4000-8000-000000000001', 2
);

INSERT INTO public.engine_table_leases (
  table_id, instance_id, engine_version, heartbeat_at,
  lease_generation, protocol_version
) VALUES (
  '20000000-0000-4000-8000-000000000002',
  'pg17-probe', 'probe', clock_timestamp(),
  '60000000-0000-4000-8000-000000000001', 2
);

/* Prove this focused postimage really enforces the exact-seat expansion that
   Stage B pins. A replaced same-row seat generation must roll its hand receipt
   back whole rather than mutate the new occupant's time bank. */
DO $exact_seat_postimage_is_behavioral$
DECLARE
  v_result jsonb;
  v_refused boolean := false;
  v_stacks jsonb := jsonb_build_array(jsonb_build_object(
    'user_id', '80000000-0000-4000-8000-000000000001',
    'seat_id', '81000000-0000-4000-8000-000000000001',
    'seat_joined_at', '2026-09-08T10:00:00Z',
    'stack_before', 100,
    'stack', 100
  ));
  v_obligations jsonb := jsonb_build_object(
    'time_banks', jsonb_build_array(jsonb_build_object(
      'user_id', '80000000-0000-4000-8000-000000000001',
      'seat_id', '81000000-0000-4000-8000-000000000001',
      'seat_joined_at', '2026-09-08T10:00:00Z',
      'uses_remaining', 3,
      'seconds_remaining', 30
    ))
  );
BEGIN
  INSERT INTO public.table_seats (
    id, table_id, user_id, seat_number, stack, joined_at,
    time_bank_uses_remaining, time_bank_remaining
  ) VALUES (
    '81000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '80000000-0000-4000-8000-000000000001',
    1, 100, '2026-09-08T10:00:00Z', 0, 0
  );

  v_result := public.fn_ca_commit_hand_settlement(
    '20000000-0000-4000-8000-000000000002', 9001, v_stacks,
    0, 0, 'fixture:exact-seat-valid', 0, '{}'::jsonb, '[]'::jsonb,
    'fixture', '60000000-0000-4000-8000-000000000001', v_obligations
  );
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id = '20000000-0000-4000-8000-000000000002'
          AND s.seat_number = 1
          AND s.time_bank_uses_remaining = 3
          AND s.time_bank_remaining = 30
     ) THEN
    RAISE EXCEPTION 'exact-seat fixture did not update the named generation';
  END IF;

  DELETE FROM public.hand_atomic_commits
   WHERE table_id = '20000000-0000-4000-8000-000000000002'
     AND hand_number = 9001;
  UPDATE public.table_seats
     SET joined_at = '2026-09-08T10:01:00Z',
         time_bank_uses_remaining = 0,
         time_bank_remaining = 0
   WHERE table_id = '20000000-0000-4000-8000-000000000002'
     AND seat_number = 1;

  BEGIN
    PERFORM public.fn_ca_commit_hand_settlement(
      '20000000-0000-4000-8000-000000000002', 9002, v_stacks,
      0, 0, 'fixture:replaced-seat-refused', 0, '{}'::jsonb, '[]'::jsonb,
      'fixture', '60000000-0000-4000-8000-000000000001', v_obligations
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%time_bank_seat_generation_mismatch%' THEN
      v_refused := true;
    ELSE
      RAISE;
    END IF;
  END;

  IF NOT v_refused
     OR EXISTS (
       SELECT 1 FROM public.hand_atomic_commits
        WHERE table_id = '20000000-0000-4000-8000-000000000002'
          AND hand_number = 9002
     )
     OR EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id = '20000000-0000-4000-8000-000000000002'
          AND s.seat_number = 1
          AND (s.time_bank_uses_remaining <> 0 OR s.time_bank_remaining <> 0)
     ) THEN
    RAISE EXCEPTION 'replaced exact-seat generation did not fail closed';
  END IF;

  DELETE FROM public.table_seats
   WHERE table_id = '20000000-0000-4000-8000-000000000002'
     AND seat_number = 1;
END;
$exact_seat_postimage_is_behavioral$;
