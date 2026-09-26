-- scripts/dev/fixtures/lightning-phase6-matcher-fixture.sql
--
-- WHAT scripts/dev/test-lightning-phase6-matcher.sh NEEDS THAT NO EARLIER
-- LIGHTNING FIXTURE CREATES, in the shape production has it (read from the
-- live catalogue on 2026-09-26, bodies copied verbatim), and the writers the
-- harness drives its estate with.
--
--   responsible_gaming_limits and fn_rg_require_not_excluded: the
--     responsible-gaming reader the matcher's P0 reuses. Production's foreign
--     key to auth.users is left out; there is no auth schema here.
--   ca_player_restrictions, ca_operator_policy (its single row, enforcement
--     off, as production has it today), fn_ca_player_restricted and
--     fn_ca_player_restriction_for: the account-restriction reader and the
--     operator's enforcement switch the table_seats door
--     fn_ca_refuse_restricted_entry consults.
--
-- NOTHING HERE READS is_horse OR horse_id TO DECIDE ANYTHING. Law 10.5.

CREATE TABLE IF NOT EXISTS public.responsible_gaming_limits (
  user_id                        uuid PRIMARY KEY,
  daily_deposit_limit            numeric CHECK (daily_deposit_limit IS NULL OR daily_deposit_limit >= 0),
  weekly_deposit_limit           numeric CHECK (weekly_deposit_limit IS NULL OR weekly_deposit_limit >= 0),
  monthly_deposit_limit          numeric CHECK (monthly_deposit_limit IS NULL OR monthly_deposit_limit >= 0),
  daily_loss_limit               numeric CHECK (daily_loss_limit IS NULL OR daily_loss_limit >= 0),
  session_time_limit_minutes     integer CHECK (session_time_limit_minutes IS NULL OR (session_time_limit_minutes >= 15 AND session_time_limit_minutes <= 1440)),
  reality_check_interval_minutes integer NOT NULL DEFAULT 30 CHECK (reality_check_interval_minutes >= 5 AND reality_check_interval_minutes <= 240),
  self_excluded_until            timestamptz,
  cooling_off_until              timestamptz,
  limit_increase_available_at    timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  created_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.fn_rg_require_not_excluded(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limits public.responsible_gaming_limits%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'p_user_id required'; END IF;

  SELECT * INTO v_limits FROM public.responsible_gaming_limits WHERE user_id = p_user_id;

  IF v_limits.user_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'no_limits_set');
  END IF;

  IF v_limits.self_excluded_until IS NOT NULL AND v_limits.self_excluded_until > v_now THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self_excluded',
      'self_excluded_until', v_limits.self_excluded_until);
  END IF;
  IF v_limits.cooling_off_until IS NOT NULL AND v_limits.cooling_off_until > v_now THEN
    RETURN jsonb_build_object('ok', false, 'error', 'cooling_off',
      'cooling_off_until', v_limits.cooling_off_until);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE TABLE IF NOT EXISTS public.ca_player_restrictions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  scope       text NOT NULL CHECK (scope = ANY (ARRAY['account', 'cash', 'tournaments', 'transfers', 'social'])),
  reason_code text NOT NULL CHECK (reason_code = ANY (ARRAY['collusion_suspected', 'chip_dumping_suspected',
                'multi_accounting', 'bot_or_rta_suspected', 'abuse_or_harassment', 'payment_dispute',
                'kyc_incomplete', 'responsible_gaming', 'self_requested', 'security_compromise',
                'terms_violation', 'other'])),
  reason_note text,
  status      text NOT NULL DEFAULT 'active' CHECK (status = ANY (ARRAY['active', 'lifted', 'expired'])),
  applied_by  uuid,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  approval_id uuid,
  lifted_by   uuid,
  lifted_at   timestamptz,
  lift_note   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_player_restrictions_expiry_after_start CHECK (expires_at IS NULL OR expires_at > applied_at)
);

CREATE TABLE IF NOT EXISTS public.ca_operator_policy (
  id                            boolean PRIMARY KEY DEFAULT true CHECK (id),
  approvals_enabled             boolean NOT NULL DEFAULT false,
  allow_self_approve_when_alone boolean NOT NULL DEFAULT true,
  enforce_named_roles           boolean NOT NULL DEFAULT false,
  mint_threshold                numeric NOT NULL DEFAULT 0,
  fund_threshold                numeric NOT NULL DEFAULT 0,
  cashout_threshold             numeric NOT NULL DEFAULT 0,
  approval_ttl_minutes          integer NOT NULL DEFAULT 1440 CHECK (approval_ttl_minutes > 0),
  updated_by                    uuid,
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  restrictions_enforced         boolean NOT NULL DEFAULT false
);
INSERT INTO public.ca_operator_policy (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_player_restricted(p_user_id uuid, p_scope text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if p_user_id is null or p_scope is null then
    return false;
  end if;

  return exists (
    select 1
      from public.ca_player_restrictions r
     where r.user_id = p_user_id
       and r.status = 'active'
       and (r.expires_at is null or r.expires_at > now())
       and (r.scope = p_scope or r.scope = 'account')
  );
exception
  when others then
    return false;
end;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_player_restriction_for(p_user_id uuid, p_scope text)
 RETURNS public.ca_player_restrictions
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select r.*
    from public.ca_player_restrictions r
   where r.user_id = p_user_id
     and r.status = 'active'
     and (r.expires_at is null or r.expires_at > now())
     and (r.scope = p_scope or r.scope = 'account')
   order by (r.scope = 'account') desc, r.applied_at asc
   limit 1;
$function$;

-- PRODUCTION'S GRANTS on what the matcher calls and reads.
REVOKE ALL ON FUNCTION public.fn_ca_player_restricted(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_player_restriction_for(uuid, text) FROM PUBLIC;
DO $roles$
BEGIN
  GRANT EXECUTE ON FUNCTION public.fn_ca_player_restricted(uuid, text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.fn_ca_player_restriction_for(uuid, text) TO service_role;
  GRANT SELECT ON public.responsible_gaming_limits, public.ca_player_restrictions, public.ca_operator_policy TO service_role;
  -- Supabase gives service_role every table of public; the earlier fixtures
  -- grant it only the Lightning ones, so section 17's "service_role plans as
  -- itself" needs production's read access to the tables the plan reads.
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
END
$roles$;
-- AND BYPASSES ROW LEVEL SECURITY, as Supabase's service_role does: every
-- Lightning table has RLS enabled and no policy, so a service_role without it
-- would read nothing at all.
ALTER ROLE service_role BYPASSRLS;

-- ===========================================================================
-- THE WRITERS.
-- ===========================================================================

-- A CONVERTED LIGHTNING CLUSTER, built only through the real doors: the Phase
-- 9 fixture's cluster and seat writers, the REAL conversion (fx9_convert
-- raises unless it converted) and the REAL slot sync. p_horses of the players
-- are horses, seated through table_seats.horse_id and never mentioned again.
CREATE FUNCTION public.fx6_cluster(p_key text, p_handed integer, p_humans integer,
                                   p_horses integer DEFAULT 0, p_cap integer DEFAULT 80)
RETURNS uuid LANGUAGE plpgsql AS $fx$
DECLARE v_g uuid;
BEGIN
  v_g := public.fx9_cluster(p_key, p_handed, p_cap, true);
  PERFORM public.fx9_seat(v_g, p_humans, 1, false);
  IF p_horses > 0 THEN
    PERFORM public.fx9_seat(v_g, p_horses, p_humans + 1, true);
  END IF;
  PERFORM public.fx9_convert(v_g);
  PERFORM public.fx9_pool(v_g);
  RETURN v_g;
END $fx$;

-- THE MATCHER'S CONFIGURATION IS THE RULESET, so this is how a harness sets
-- it: merged into cash_games.ruleset_snapshot -> 'lightning'.
CREATE FUNCTION public.fx6_set(p_game uuid, p_cfg jsonb)
RETURNS void LANGUAGE plpgsql AS $fx$
BEGIN
  UPDATE public.cash_games
     SET ruleset_snapshot = jsonb_set(coalesce(ruleset_snapshot, '{}'::jsonb), '{lightning}',
                                      coalesce(ruleset_snapshot -> 'lightning', '{}'::jsonb) || p_cfg)
   WHERE id = p_game;
END $fx$;

CREATE FUNCTION public.fx6_reset(p_game uuid, p_cfg jsonb)
RETURNS void LANGUAGE plpgsql AS $fx$
BEGIN
  UPDATE public.cash_games
     SET ruleset_snapshot = jsonb_set(coalesce(ruleset_snapshot, '{}'::jsonb), '{lightning}', p_cfg)
   WHERE id = p_game;
END $fx$;

-- THE TERMINAL PATH, as the settlement will walk it: the REAL begin_dealing,
-- then settling, then complete, through the instance discipline trigger; the
-- release trigger hands the players back.
CREATE FUNCTION public.fx6_complete(p_instance uuid)
RETURNS void LANGUAGE plpgsql AS $fx$
DECLARE v jsonb;
BEGIN
  v := public.fn_lightning_instance_begin_dealing(p_instance);
  IF coalesce((v ->> 'dealing')::boolean, false) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FIXTURE: begin_dealing refused instance %: %', p_instance, v;
  END IF;
  UPDATE public.lightning_instance SET state = 'settling' WHERE id = p_instance;
  UPDATE public.lightning_hand SET settled_at = clock_timestamp()
   WHERE hand_id = (SELECT hand_id FROM public.lightning_instance WHERE id = p_instance);
  UPDATE public.lightning_instance SET state = 'complete', completed_at = clock_timestamp() WHERE id = p_instance;
END $fx$;

CREATE FUNCTION public.fx6_complete_all(p_game uuid)
RETURNS integer LANGUAGE plpgsql AS $fx$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT li.id FROM public.lightning_instance li
            WHERE li.cluster_id = p_game AND li.state = 'reserved' ORDER BY li.created_at, li.id LOOP
    PERFORM public.fx6_complete(r.id);
    n := n + 1;
  END LOOP;
  RETURN n;
END $fx$;

-- A STATEMENT, THEN A QUESTION, THEN EVERYTHING UNDONE. Returns the answer
-- the question got while the statement's effect was in place, or the error
-- the statement raised. Deferred triggers never fire, because nothing
-- commits.
CREATE FUNCTION public.fx6_after(p_sql text, p_ask text)
RETURNS text LANGUAGE plpgsql AS $fx$
DECLARE v text; v_state text; v_msg text;
BEGIN
  IF p_sql IS NOT NULL AND p_sql <> '' THEN EXECUTE p_sql; END IF;
  EXECUTE p_ask INTO v;
  RAISE EXCEPTION USING ERRCODE = 'PX601', MESSAGE = coalesce(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  IF v_state = 'PX601' THEN RETURN v_msg; END IF;
  RETURN 'ERROR ' || v_state || ': ' || v_msg;
END $fx$;

-- ONE PLAYER'S P0 ANSWER. PL/pgSQL, because it is created before the
-- function it asks.
CREATE FUNCTION public.fx6_reason(p_game uuid, p_player uuid, p_disconnected uuid[] DEFAULT NULL)
RETURNS text LANGUAGE plpgsql STABLE AS $fx$
BEGIN
  RETURN (SELECT coalesce(l.reason_code, 'LEGAL')
            FROM public.fn_lightning_player_legality(p_game, clock_timestamp(), p_disconnected) l
           WHERE l.player_id = p_player);
END $fx$;

-- THE OPEN POOL OF A CLUSTER, in a deterministic order.
CREATE FUNCTION public.fx6_players(p_game uuid)
RETURNS uuid[] LANGUAGE sql STABLE AS $fx$
  SELECT coalesce(array_agg(ps.player_id ORDER BY ps.entered_at, ps.player_id), ARRAY[]::uuid[])
    FROM public.lightning_pool_session ps WHERE ps.cluster_id = p_game AND ps.exited_at IS NULL;
$fx$;

-- A FAULT OF A NAMED CLASS AND CONSTRAINT, for the barrier's freeze-or-retry
-- decision inside a matcher pass, fired a counted number of times. The count
-- is a SEQUENCE because the barrier rolls its failed attempt back, and a GUC
-- or a row written inside that attempt would be rolled back with it; nextval
-- is not. fx6_arm(class, constraint, shots) arms it for the next shots
-- inserts; nothing fires once they are spent.
CREATE SEQUENCE public.fx6_shots;
CREATE FUNCTION public.fx6_arm(p_class text, p_constraint text, p_shots integer)
RETURNS void LANGUAGE plpgsql AS $fx$
DECLARE v bigint := nextval('public.fx6_shots');
BEGIN
  PERFORM set_config('fx6.raise', coalesce(p_class, ''), false);
  PERFORM set_config('fx6.raise_constraint', coalesce(p_constraint, ''), false);
  PERFORM set_config('fx6.raise_until', (v + p_shots)::text, false);
END $fx$;
CREATE FUNCTION public.fx6_raise() RETURNS trigger LANGUAGE plpgsql AS $fx$
DECLARE
  v text := coalesce(current_setting('fx6.raise', true), '');
  c text := coalesce(current_setting('fx6.raise_constraint', true), '');
BEGIN
  IF v <> '' AND nextval('public.fx6_shots') <= coalesce(nullif(current_setting('fx6.raise_until', true), ''), '0')::bigint THEN
    IF c <> '' THEN
      RAISE EXCEPTION USING ERRCODE = v, CONSTRAINT = c, MESSAGE = 'FX6_INJECTED ' || v || ' on ' || c;
    END IF;
    RAISE EXCEPTION USING ERRCODE = v, MESSAGE = 'FX6_INJECTED ' || v;
  END IF;
  RETURN NEW;
END $fx$;

-- A WRITE THAT TAKES A WHILE, switched by a GUC, for the time budget.
CREATE FUNCTION public.fx6_slow() RETURNS trigger LANGUAGE plpgsql AS $fx$
BEGIN
  IF coalesce(current_setting('fx6.slow_ms', true), '') <> '' THEN
    PERFORM pg_sleep(current_setting('fx6.slow_ms')::numeric / 1000);
  END IF;
  RETURN NEW;
END $fx$;
