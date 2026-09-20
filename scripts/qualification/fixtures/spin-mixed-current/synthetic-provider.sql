\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Isolated future-consumer model provider, not a migration.
-- This restores catalog objects only. It seeds no history, receipt, money,
-- player, session or result. Historical qualification and incident closure are false.
-- Authority: fifo5-mixed-basis-complete-authority-20260917.json, observed
-- 2026-09-17T05:34:28.225566+00:00. Raw SHA256:
-- 74d31b32ae7e19b00bebf3f0b87c6cdce209481c99ea1c485920134b9799c18d
-- Parsed SHA256: a45e35d26eb0494bd54297fe18be4e0d3a1eb96621ba9b72515c413bc771945b
-- Captured function definitions below retain their exact pg_get_functiondef
-- bytes, including final newline. DO delimiters/ACL statements are external.
-- See spin-mixed-basis-synthetic-fixture.md for incomplete callee/provider wiring.
-- Invoke only after genuine base schema, triggers, access/policies and roles.
-- Caller is fixture_bootstrap SET ROLE postgres; this file cannot elevate itself.
BEGIN;
SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = public, pg_temp;
SET LOCAL timezone = 'UTC';

DO $isolated_preimage$
DECLARE execution_id text := current_setting('spin_mixed_qualification.execution_uuid', true);
BEGIN
  IF execution_id IS NULL OR execution_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR current_database() IS DISTINCT FROM 'qual_spin_expiry_' || replace(lower(execution_id), '-', '')
     OR session_user IS DISTINCT FROM 'fixture_bootstrap'
     OR current_user IS DISTINCT FROM 'postgres'
     OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
     OR inet_server_addr() IS NOT NULL
     OR current_setting('listen_addresses') IS DISTINCT FROM ''
     OR current_setting('session_replication_role') IS DISTINCT FROM 'origin'
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='postgres' AND NOT rolsuper AND rolinherit AND rolbypassrls)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role' AND NOT rolsuper AND rolinherit AND rolbypassrls)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated' AND NOT rolsuper AND rolinherit AND NOT rolbypassrls)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon' AND NOT rolsuper AND rolinherit AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'synthetic mixed provider: exact isolated PG17 bootstrap/role boundary required' USING ERRCODE='55000';
  END IF;
  -- Refuse existing objects, including a wrong-kind relation or colliding type.
  -- Replay and replacement of a current-target body are intentionally refused.
  IF to_regclass('public.tournament_entry_close_receipts') IS NOT NULL
     OR to_regtype('public.tournament_entry_close_receipts') IS NOT NULL
     OR to_regclass('public.tournament_entry_close_receipts_pkey') IS NOT NULL
     OR to_regprocedure('public.trg_require_satellite_economics_at_entry_close()') IS NOT NULL
     OR to_regprocedure('public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'synthetic mixed provider: exact absent-object preimage required' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.tournaments')
       AND relkind='r' AND relowner='postgres'::regrole AND relrowsecurity AND NOT relforcerowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.tournaments')
       AND attname='id' AND atttypid='uuid'::regtype AND attnotnull AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.tournaments')
       AND attname='variant' AND atttypid='text'::regtype AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.tournaments')
       AND attname='tournament_type' AND atttypid='text'::regtype AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.tournaments')
       AND attname='satellite_target_id' AND atttypid='uuid'::regtype AND NOT attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=to_regclass('public.tournament_satellite_economic_snapshots')
       AND relkind='r' AND relowner='postgres'::regrole)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.tournament_satellite_economic_snapshots')
       AND attname='tournament_id' AND atttypid='uuid'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION 'synthetic mixed provider: authentic entry-close parent/trigger lookup relation missing' USING ERRCODE='55000';
  END IF;
END;
$isolated_preimage$;

CREATE TABLE public.tournament_entry_close_receipts (
  tournament_id uuid NOT NULL,
  close_mode text NOT NULL,
  entry_closed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  final_prize_pool numeric NOT NULL,
  payout_structure_snapshot jsonb NOT NULL,
  manager_wake_id bigint,
  reprice_completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT tournament_entry_close_receipts_close_mode_check CHECK ((close_mode = ANY (ARRAY['levels'::text, 'minutes'::text, 'immediate'::text, 'addon'::text]))),
  CONSTRAINT tournament_entry_close_receipts_final_prize_pool_check CHECK ((final_prize_pool >= (0)::numeric)),
  CONSTRAINT tournament_entry_close_receipts_pkey PRIMARY KEY (tournament_id),
  CONSTRAINT tournament_entry_close_receipts_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON DELETE RESTRICT
);
ALTER TABLE public.tournament_entry_close_receipts OWNER TO postgres;
ALTER TABLE public.tournament_entry_close_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_entry_close_receipts FROM PUBLIC, anon, authenticated, service_role, postgres;
GRANT ALL ON public.tournament_entry_close_receipts TO postgres;

-- Captured object 1: public.trg_require_satellite_economics_at_entry_close()
DO $restore_captured_1$
DECLARE source_definition constant text := $captured_definition$CREATE OR REPLACE FUNCTION public.trg_require_satellite_economics_at_entry_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.id=NEW.tournament_id
       AND (lower(COALESCE(t.variant,''))='satellite'
         OR upper(COALESCE(t.tournament_type,''))='SATELLITE'
         OR t.satellite_target_id IS NOT NULL)
  ) AND NOT EXISTS (
    SELECT 1 FROM public.tournament_satellite_economic_snapshots s
     WHERE s.tournament_id=NEW.tournament_id
  ) THEN
    RAISE EXCEPTION 'satellite entry close has no provable start-time economics'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$function$
$captured_definition$;
BEGIN
  IF md5(source_definition) IS DISTINCT FROM '1c93d532cd49329e3c7e11ee7f6de48b' THEN
    RAISE EXCEPTION 'synthetic mixed provider: captured function bytes differ (1)' USING ERRCODE='55000';
  END IF;
  EXECUTE source_definition;
END;
$restore_captured_1$;
ALTER FUNCTION public.trg_require_satellite_economics_at_entry_close() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_require_satellite_economics_at_entry_close() FROM PUBLIC, anon, authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.trg_require_satellite_economics_at_entry_close() TO postgres;

-- Captured object 2: public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)
DO $restore_captured_2$
DECLARE source_definition constant text := $captured_definition$CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb, p_instance_id text, p_lease_generation uuid, p_post_commit_obligations jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_diamond boolean := false;
  v_hand_id uuid;
  v_request_hash text;
  v_hash text;
  v_existing_request_hash text;
  v_existing_hash text;
  v_payload jsonb;
  v_club_id uuid;
  v_tournament_id uuid;
  v_item jsonb;
  v_expected integer;
  v_updated integer;
  v_row_count integer;
  v_exact_seat_generation boolean := false;
BEGIN
  -- This public 12-argument door is the outermost accepted-hand authority.
  -- Take the lifecycle root before its preserved exact-generation core can
  -- lock a lease, tournament or table. The owner-only nine-argument core
  -- re-enters this shared transaction lock defensively; that acquisition is
  -- harmless and keeps the private core safe from future owner-only callers.
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM smarter_private.f06_hand_dispatch_guard(p_table_id,p_hand_number);

  IF jsonb_typeof(p_post_commit_obligations) IS DISTINCT FROM 'object'
     OR p_post_commit_obligations->>'version' <> '1'
     OR jsonb_typeof(p_post_commit_obligations->'time_banks') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'promo_playthrough') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'insurance') IS DISTINCT FROM 'array'
     OR NOT (p_post_commit_obligations ? 'pending_addons')
     OR NOT (p_post_commit_obligations ? 'rake')
     OR NOT (p_post_commit_obligations ? 'bbj_contribution')
     OR p_post_commit_obligations ? 'accepted_hand_facts'
     OR jsonb_typeof(p_post_commit_obligations->'rake') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'pending_addons') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_obligations)';
  END IF;

  -- Database-first expansion. The previous engine may send an entirely legacy
  -- roster while it drains, but exact and legacy identities never mix.
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
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (mixed_stack_seat_generation_protocol)';
    END IF;
    SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
      INTO v_exact_seat_generation
      FROM jsonb_array_elements(p_stacks) x;

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

  IF jsonb_typeof(p_hand_row->'_accepted_post_commit_facts') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'pot_size') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_hand_row->'big_blind') IS DISTINCT FROM 'number'
     OR COALESCE(p_rake, 0) < 0
     OR COALESCE(p_bbj, 0) < 0
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'contributions')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'insurance')
          IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     )
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_accepted_post_commit_facts)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'uses_remaining') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'seconds_remaining') IS DISTINCT FROM 'number'
        OR (x->>'uses_remaining') !~ '^[0-9]+$'
        OR (x->>'seconds_remaining') !~ '^[0-9]+$'
        OR CASE WHEN (x->>'uses_remaining') ~ '^[0-9]+$'
                THEN (x->>'uses_remaining')::numeric > 2147483647 ELSE false END
        OR CASE WHEN (x->>'seconds_remaining') ~ '^[0-9]+$'
                THEN (x->>'seconds_remaining')::numeric > 2147483647 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'wagered') IS DISTINCT FROM 'number'
        OR CASE WHEN jsonb_typeof(x->'wagered') = 'number'
                THEN (x->>'wagered')::numeric <= 0 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'player_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'equity_percent') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'premium') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'insured_amount') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'payout') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'player_won') IS DISTINCT FROM 'boolean'
        OR COALESCE(x->>'kind', '') NOT IN ('insurance', 'ev_cashout')
        OR CASE WHEN jsonb_typeof(x->'equity_percent') = 'number'
                THEN (x->>'equity_percent')::numeric NOT BETWEEN 0 AND 100 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'premium') = 'number'
                THEN (x->>'premium')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'insured_amount') = 'number'
                THEN (x->>'insured_amount')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'payout') = 'number'
                THEN (x->>'payout')::numeric < 0 ELSE false END
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_item)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake'->'amount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'bbj') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'pot') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'num_players') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'contributions') IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'returned_uncalled') IS DISTINCT FROM 'object'
       OR (p_post_commit_obligations->'rake'->>'num_players') !~ '^[0-9]+$'
       OR COALESCE((p_post_commit_obligations->'rake'->>'amount')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'bbj')::numeric, 0) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'pot')::numeric, -1) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0)
            > 2147483647
       OR (p_post_commit_obligations->'rake'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_rake)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'amount')
         IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'big_blind')
         IS DISTINCT FROM 'number'
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric, 0)
            <= 0
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric, 0)
            <= 0
       OR (p_post_commit_obligations->'bbj_contribution'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_bbj)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled')
         IS DISTINCT FROM 'boolean'
       OR CASE
            WHEN jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled') = 'boolean'
            THEN COALESCE(
              (p_post_commit_obligations->'pending_addons'->>'enabled')::boolean,
              false
            ) IS NOT TRUE
            ELSE false
          END
       OR jsonb_typeof(p_post_commit_obligations->'pending_addons'->'max_buy_in')
            IS DISTINCT FROM 'number'
       OR COALESCE(
            (p_post_commit_obligations->'pending_addons'->>'max_buy_in')::numeric,
            0
          ) <= 0
       OR p_post_commit_obligations->'pending_addons' ? 'ids'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_addons)';
  END IF;

  IF p_hand_number > 2147483647
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
       OR jsonb_array_length(p_post_commit_obligations->'insurance') > 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_hand_number_out_of_range)';
  END IF;

  -- DIAMOND PHASE 8: the Diamond cash rules below are cash rules; a Diamond
  -- tournament hand carries a tournament rake scope and no add-on lane, and
  -- is judged by the tournament rules exactly as a chip tournament hand is.
  SELECT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
    WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL) INTO v_diamond;
  IF v_diamond AND (
    jsonb_array_length(p_post_commit_obligations->'promo_playthrough')<>0
    OR jsonb_array_length(p_post_commit_obligations->'insurance')<>0
    OR jsonb_typeof(p_post_commit_obligations->'rake') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'pending_addons') IS DISTINCT FROM 'null'
    OR p_hand_row->>'game_variant' IS DISTINCT FROM 'nlh'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_units,'[]'::jsonb)) u
      WHERE (u->>'amount') IS NULL
         OR (u->>'amount')::numeric<>trunc((u->>'amount')::numeric))
    OR COALESCE(NULLIF(p_hand_row->'daily_mission_events','null'::jsonb),'[]'::jsonb)<>'[]'::jsonb
    OR (p_hand_row->>'pot_size')::numeric<>trunc((p_hand_row->>'pot_size')::numeric)
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
  ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (diamond_chip_obligation_or_fractional_fact)';
  END IF;

  v_request_hash := encode(
    extensions.digest(convert_to(p_post_commit_obligations::text, 'UTF8'), 'sha256'),
    'hex'
  );

  /* ONE SEAT WRITE PER HAND (2026-09-10). The time-bank items above are
     already proven well formed and bound to the exact stack roster. Publish
     them for this exact table+hand in a transaction-local setting so the
     stack core (fn_ca_settle_hand_stacks_absolute) can carry the two
     time-bank columns on its stack write instead of this door writing every
     seat row a second time. The setting is cleared as soon as the core
     returns; a stale value can only name a hand the core refuses as a
     replay. The loop below still proves the resulting seat state before it
     counts it, and still writes any seat the core did not carry. */
  PERFORM set_config(
    'app.ca_hand_time_banks',
    jsonb_build_object(
      'table_id', p_table_id,
      'hand_number', p_hand_number,
      'exact', v_exact_seat_generation,
      'items', p_post_commit_obligations->'time_banks'
    )::text,
    true
  );

  /* The owner-only exact-generation core locks and proves the cash-table or
     tournament generation, then runs the unchanged accepted-hand core. Its
     lease/table locks remain held until this outer transaction commits. */
  v_result := public.fn_ca_commit_hand_settlement_exact_before_obligations(
    p_table_id,
    p_hand_number,
    p_stacks,
    p_rake,
    p_bbj,
    p_ref,
    p_inflow,
    p_hand_row,
    p_units,
    p_instance_id,
    p_lease_generation
  );
  PERFORM set_config('app.ca_hand_time_banks', '', true);

  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  BEGIN
    v_hand_id := (v_result->>'history_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_history_receipt)';
  END;
  IF v_hand_id IS NULL THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_history_receipt)';
  END IF;

  SELECT t.club_id, t.tournament_id
    INTO v_club_id, v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND OR v_club_id IS NULL THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_table_scope_missing)';
  END IF;

  /* The envelope cannot contradict the accepted hand. Amounts bind to the
     settlement arguments; every per-player item binds to its authoritative
     stack roster; every money item binds to the table's club. */
  IF (COALESCE(p_rake, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'rake') = 'object')
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'amount')::numeric
             IS DISTINCT FROM p_rake
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'bbj')::numeric
             IS DISTINCT FROM COALESCE(p_bbj, 0)
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'pot')::numeric
             IS DISTINCT FROM (p_hand_row->>'pot_size')::numeric
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'num_players')::integer
             IS DISTINCT FROM (
               SELECT count(*)::integer
                 FROM jsonb_object_keys(
                   p_hand_row->'_accepted_post_commit_facts'->'contributions'
                 )
             )
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'contributions'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'contributions'
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'returned_uncalled'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
     )
     OR (COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object')
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric
             IS DISTINCT FROM p_bbj
     )
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric
             IS DISTINCT FROM (p_hand_row->>'big_blind')::numeric
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_fee_mismatch)';
  END IF;

  IF p_post_commit_obligations->'insurance' IS DISTINCT FROM
       p_hand_row->'_accepted_post_commit_facts'->'insurance' THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_insurance_fact_mismatch)';
  END IF;

  IF (
       v_tournament_id IS NULL AND NOT v_diamond
       AND (
         jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
           IS DISTINCT FROM (
             SELECT count(*)::integer
               FROM jsonb_each(
                 p_hand_row->'_accepted_post_commit_facts'->'contributions'
               ) e
              WHERE (e.value::text)::numeric > 0
           )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
            WHERE (x->>'wagered')::numeric IS DISTINCT FROM
                  (
                    p_hand_row->'_accepted_post_commit_facts'->'contributions'->>
                    (x->>'user_id')
                  )::numeric
         )
       )
     ) OR (
       (v_tournament_id IS NOT NULL OR v_diamond)
       AND jsonb_array_length(p_post_commit_obligations->'promo_playthrough') <> 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_promo_fact_mismatch)';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
        WHERE s->>'user_id' = x->>'user_id'
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'contributions'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'user_id'
        )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'player_id'
        )
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_player_or_club_mismatch)';
  END IF;

  /* Repeated recipients would turn one accepted-hand fact into two additive
     mutations. Time-bank rows are exhaustive because omitting one would make
     the accepted seat state depend on whichever process ran before this one. */
  IF jsonb_array_length(p_post_commit_obligations->'time_banks')
       IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     ) IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
     OR (
       /* The durable insurance writer is unique per table/hand/player. Two
          different kinds for one player would look like two obligations here
          but collapse to one receipt downstream. Refuse that ambiguity. */
       SELECT count(DISTINCT x->>'player_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'insurance') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_duplicate_or_missing_recipient)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'contributions', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'returned_uncalled', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_rake_recipient_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND p_post_commit_obligations->'rake'->>'club_id' IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND p_post_commit_obligations->'bbj_contribution'->>'club_id'
           IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_bbj_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       COALESCE(p_post_commit_obligations->'rake'->>'tournament_id', '')
         IS DISTINCT FROM COALESCE(v_tournament_id::text, '')
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_scope_mismatch)';
  END IF;
  IF (v_tournament_id IS NULL AND NOT v_diamond) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object') THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_addon_scope_mismatch)';
  END IF;

  SELECT c.post_commit_request_hash, c.post_commit_payload_hash
    INTO v_existing_request_hash, v_existing_hash
    FROM public.hand_atomic_commits c
   WHERE c.table_id = p_table_id
     AND c.hand_number = p_hand_number
     AND c.hand_id = v_hand_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_atomic_receipt)';
  END IF;
  IF v_existing_request_hash IS NOT NULL
     AND v_existing_request_hash IS DISTINCT FROM v_request_hash THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_payload_conflict)';
  END IF;

  IF v_existing_request_hash IS NULL THEN
    /* A rolling 11-argument engine may already have committed this hand and
       run its legacy post-commit steps. Never attach a new additive envelope
       to that receipt. A response-loss replay from this 12-argument door
       always finds the request hash written by its first transaction. */
    IF COALESCE((v_result->>'replay')::boolean, false) IS TRUE THEN
      RAISE EXCEPTION
        'atomic hand commit refused (legacy_receipt_has_no_post_commit_envelope)';
    END IF;

    /* Copy the independently accepted facts into the immutable stored envelope.
       The caller is forbidden from supplying this key itself. Besides the core
       hand hash, the durable processor/audit row can therefore show exactly
       which first-narrative facts every derived obligation was checked against. */
    v_payload := jsonb_set(
      p_post_commit_obligations,
      '{accepted_hand_facts}',
      p_hand_row->'_accepted_post_commit_facts',
      true
    );
    IF jsonb_typeof(v_payload->'pending_addons') = 'object' THEN
      /* Own the exact eligible rows through commit. A legacy/manual resolver
         cannot consume one after it was frozen but before the obligation
         transaction gets its causal wake. */
      PERFORM 1
        FROM public.table_pending_addons a
       WHERE a.table_id = p_table_id
         AND a.resolved_at IS NULL
         AND a.created_at <= transaction_timestamp()
       ORDER BY a.created_at, a.id
       FOR UPDATE;
      v_payload := jsonb_set(
        v_payload,
        '{pending_addons,ids}',
        COALESCE((
          SELECT jsonb_agg(a.id ORDER BY a.created_at, a.id)
            FROM public.table_pending_addons a
           WHERE a.table_id = p_table_id
             AND a.resolved_at IS NULL
             AND a.created_at <= transaction_timestamp()
        ), '[]'::jsonb),
        true
      );
    END IF;
    v_hash := encode(
      extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
      'hex'
    );

    /* Time-bank state belongs to the accepted-hand boundary itself. Apply it
       while the exact lease/table/seat locks inherited from the owner-only
       exact-generation core are still held, never later from a stale envelope. */
    v_expected := jsonb_array_length(v_payload->'time_banks');
    v_updated := 0;
    FOR v_item IN
      SELECT value FROM jsonb_array_elements(v_payload->'time_banks')
       ORDER BY value->>'user_id'
    LOOP
      IF (v_item->>'user_id') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR (v_item->>'uses_remaining') !~ '^[0-9]+$'
         OR (v_item->>'seconds_remaining') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION
          'atomic hand commit refused (invalid_time_bank_obligation)';
      END IF;
      /* ONE SEAT WRITE PER HAND (2026-09-10). The stack core carried these
         two columns on its stack write from the envelope published above.
         Prove that exact state on the exact row first (the same predicate
         the lawful-noop rule below has always used) and count it without a
         second write. Only a seat the core did not carry - a cash seat that
         left during the hand is settled against its wallet and gets no stack
         write - takes the UPDATE, exactly as before. */
      SELECT count(*)::integer INTO v_row_count
        FROM public.table_seats s
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
         AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      IF v_row_count = 0 THEN
      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      /* Preserve the stack writer's lawful-noop rule. If a redundant-update
         suppressor is installed, ROW_COUNT may be zero even though the exact
         row already stores the requested state. Prove that exact state before
         counting it; a missing or replaced generation still refuses whole. */
      IF v_row_count = 0 AND EXISTS (
        SELECT 1
          FROM public.table_seats s
         WHERE s.table_id = p_table_id
           AND s.user_id = (v_item->>'user_id')::uuid
           AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
           AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
           AND (
             (v_exact_seat_generation
               AND s.id = (v_item->>'seat_id')::uuid
               AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
             OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
           )
      ) THEN
        v_row_count := 1;
      END IF;
      END IF;
      v_updated := v_updated + v_row_count;
    END LOOP;
    IF v_updated IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_mismatch)';
    END IF;

    UPDATE public.hand_atomic_commits c
       SET post_commit_payload = v_payload,
           post_commit_request_hash = v_request_hash,
           post_commit_payload_hash = v_hash
     WHERE c.table_id = p_table_id
       AND c.hand_number = p_hand_number
       AND c.hand_id = v_hand_id
       AND c.post_commit_request_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_receipt_raced)';
    END IF;
  ELSE
    v_hash := v_existing_hash;
    IF v_hash IS NULL THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_payload_hash_missing)';
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object(
    'post_commit_obligations', true,
    'post_commit_payload_hash', v_hash
  );
END;
$function$
$captured_definition$;
BEGIN
  IF md5(source_definition) IS DISTINCT FROM '8c0acda3b19e958ecd5bbbc07c845afe' THEN
    RAISE EXCEPTION 'synthetic mixed provider: captured function bytes differ (2)' USING ERRCODE='55000';
  END IF;
  EXECUTE source_definition;
END;
$restore_captured_2$;
ALTER FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) TO service_role;

CREATE TRIGGER aaa_require_satellite_economics_at_entry_close BEFORE INSERT ON public.tournament_entry_close_receipts FOR EACH ROW EXECUTE FUNCTION trg_require_satellite_economics_at_entry_close();

DO $captured_postimage$
DECLARE expected jsonb; actual jsonb; relation_oid oid;
BEGIN
  FOR expected IN SELECT value FROM jsonb_array_elements($function_authority$[{"acl":"{postgres=X/postgres}","owner":"postgres","config":["search_path=public, pg_temp"],"signature":"trg_require_satellite_economics_at_entry_close()","prosrc_md5":"9a4609444e1300d2b05b1cc3f32963c7","volatility":"v","ordinary_execute":{"anon":false,"service_role":false,"authenticated":false},"security_definer":true,"full_definition_md5":"1c93d532cd49329e3c7e11ee7f6de48b"},{"acl":"{postgres=X/postgres,service_role=X/postgres}","owner":"postgres","config":["search_path=public, extensions, pg_temp"],"signature":"fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)","prosrc_md5":"47e924f08a43c440d2711e6e38378371","volatility":"v","ordinary_execute":{"anon":false,"service_role":true,"authenticated":false},"security_definer":true,"full_definition_md5":"8c0acda3b19e958ecd5bbbc07c845afe"}]$function_authority$::jsonb) LOOP
    SELECT jsonb_build_object(
      'signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),
      'security_definer',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,
      'acl',p.proacl::text,'prosrc_md5',md5(p.prosrc),
      'full_definition_md5',md5(pg_get_functiondef(p.oid)),
      'ordinary_execute',jsonb_build_object(
        'anon',has_function_privilege('anon',p.oid,'EXECUTE'),
        'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),
        'service_role',has_function_privilege('service_role',p.oid,'EXECUTE')))
      INTO actual FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||(expected->>'signature'));
    IF actual IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'synthetic mixed provider: function postimage differs: %',expected->>'signature' USING ERRCODE='55000';
    END IF;
  END LOOP;
  relation_oid := 'public.tournament_entry_close_receipts'::regclass;
  expected := $relation_authority${"acl":"{postgres=arwdDxtm/postgres}","rls":true,"kind":"r","name":"tournament_entry_close_receipts","owner":"postgres","columns":[{"acl":null,"name":"tournament_id","type":"uuid","default":null,"ordinal":1,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"close_mode","type":"text","default":null,"ordinal":2,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"entry_closed_at","type":"timestamp with time zone","default":"clock_timestamp()","ordinal":3,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"final_prize_pool","type":"numeric","default":null,"ordinal":4,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"payout_structure_snapshot","type":"jsonb","default":null,"ordinal":5,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"manager_wake_id","type":"bigint","default":null,"ordinal":6,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"reprice_completed_at","type":"timestamp with time zone","default":null,"ordinal":7,"identity":"","not_null":false,"generated":""},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"clock_timestamp()","ordinal":8,"identity":"","not_null":true,"generated":""},{"acl":null,"name":"updated_at","type":"timestamp with time zone","default":"clock_timestamp()","ordinal":9,"identity":"","not_null":true,"generated":""}],"present":true,"policies":null,"triggers":[{"name":"aaa_require_satellite_economics_at_entry_close","enabled":"O","function":"trg_require_satellite_economics_at_entry_close()","definition":"CREATE TRIGGER aaa_require_satellite_economics_at_entry_close BEFORE INSERT ON public.tournament_entry_close_receipts FOR EACH ROW EXECUTE FUNCTION trg_require_satellite_economics_at_entry_close()","function_prosrc_md5":"9a4609444e1300d2b05b1cc3f32963c7"}],"force_rls":false,"constraints":[{"name":"tournament_entry_close_receipts_close_mode_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((close_mode = ANY (ARRAY['levels'::text, 'minutes'::text, 'immediate'::text, 'addon'::text])))"},{"name":"tournament_entry_close_receipts_final_prize_pool_check","type":"c","deferred":false,"validated":true,"deferrable":false,"definition":"CHECK ((final_prize_pool >= (0)::numeric))"},{"name":"tournament_entry_close_receipts_pkey","type":"p","deferred":false,"validated":true,"deferrable":false,"definition":"PRIMARY KEY (tournament_id)"},{"name":"tournament_entry_close_receipts_tournament_id_fkey","type":"f","deferred":false,"validated":true,"deferrable":false,"definition":"FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE RESTRICT"}],"service_privileges":{"DELETE":false,"INSERT":false,"SELECT":false,"UPDATE":false,"TRIGGER":false,"TRUNCATE":false}}$relation_authority$::jsonb;
  -- This is the original capture's projection and default (non-pretty)
  -- pg_get_constraintdef/pg_get_triggerdef domain, not a text-normalized proxy.
  SELECT jsonb_build_object(
    'name',c.relname,'present',true,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
    'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl::text,
    'service_privileges',(SELECT jsonb_object_agg(v,has_table_privilege('service_role',c.oid,v))
      FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER']) v),
    'columns',(SELECT jsonb_agg(jsonb_build_object('ordinal',a.attnum,'name',a.attname,
      'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
      'identity',a.attidentity,'generated',a.attgenerated,'acl',a.attacl::text,
      'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,
      'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
      'definition',pg_get_constraintdef(k.oid)) ORDER BY k.conname)
      FROM pg_constraint k WHERE k.conrelid=c.oid),
    'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'roles',p.polroles::text,
      'command',p.polcmd,'permissive',p.polpermissive,'using',pg_get_expr(p.polqual,p.polrelid),
      'with_check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
      FROM pg_policy p WHERE p.polrelid=c.oid),
    'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,
      'function',t.tgfoid::regprocedure::text,'definition',pg_get_triggerdef(t.oid),
      'function_prosrc_md5',(SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid=t.tgfoid)) ORDER BY t.tgname)
      FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal))
    INTO actual FROM pg_class c WHERE c.oid=relation_oid;
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'synthetic mixed provider: entry-close captured relation postimage differs' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_entry_close_receipts) THEN
    RAISE EXCEPTION 'synthetic mixed provider: catalog restoration seeded an entry-close row' USING ERRCODE='55000';
  END IF;
END;
$captured_postimage$;
COMMIT;

-- Catalog restoration is not a successful business call or a complete provider.
SELECT jsonb_build_object('synthetic_mixed_catalog_objects_restored',true,
  'business_execution_qualified',false,'historical_qualification',false,
  'incident_closed',false) AS synthetic_mixed_provider_catalog_only;
