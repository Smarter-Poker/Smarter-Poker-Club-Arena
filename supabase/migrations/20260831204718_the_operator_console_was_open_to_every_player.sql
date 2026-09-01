-- ===========================================================================
-- THE OPERATOR CONSOLE WAS OPEN TO EVERY PLAYER (2026-08-31)
--
-- fn_chip_integrity_report() is the platform's money posture in seven rows. It
-- is SECURITY DEFINER, so RLS does not apply to it, and `authenticated` could
-- execute it. Any account that could log in could read this:
--
--   ledger_liveness         Ledger recording normally: 44662 rows in 24h.
--   drift_since_baseline    0 member(s) drifting, worst 0.00.
--   unpriced_tournaments    WARN 31 COMPLETED tournament(s) took a buy-in and
--                           earned no rake, ~13.30 uncollected.
--   legacy_wallets_frozen   public.wallets holds 732591994.33 chips.
--
-- That is the total chip supply, the ledger's throughput, and - the part that
-- matters - a live list of WHICH INVARIANT IS CURRENTLY UNWATCHED. An operator
-- console is a fine thing to have. Serving it to the browser is reconnaissance.
--
-- Thirty-five functions are in this shape: platform-wide diagnostics with no
-- club or user scoping, SECURITY DEFINER, no caller check, executable by
-- `authenticated`. Money integrity, grant auditing, deal fairness, double-deal
-- detection, BBJ gap decomposition, hand-history bloat, ungated-money-RPC
-- listing. The last one is worth saying plainly: fn_ungated_money_rpcs() is the
-- function that lists which money RPCs have no gate, and a player could call it.
--
-- ---------------------------------------------------------------------------
-- NOBODY LOSES ANYTHING
--
-- Checked before writing this: ZERO of the thirty-five are called from browser
-- code. Three are called from the game server - fn_tournament_metrics,
-- fn_settlement_conservation_check and fn_nit_evictions - and server/src builds
-- its client with SUPABASE_SERVICE_ROLE_KEY, which this migration does not
-- touch. CI reads them as service_role too.
--
-- fn_nit_evictions is the one that could hurt if this were wrong: it is the
-- rule that evicts a nit mid-session, called by the engine every hand. Its
-- post-apply assertion therefore does not check a grant, it RUNS it.
-- ---------------------------------------------------------------------------

begin;

create temporary table _telemetry_surface(fname text primary key) on commit drop;
insert into _telemetry_surface(fname) values
  ('fn_chip_integrity_report'), ('fn_ledger_liveness'), ('fn_chip_drift_since_baseline'),
  ('fn_unpriced_tournaments'), ('fn_bot_flag_disagreement'), ('fn_audit_privileged_grants'),
  ('fn_verify_privileged_lock'), ('fn_grant_guard_health'), ('fn_ungated_money_rpcs'),
  ('fn_settlement_conservation_check'), ('fn_bbj_gap_decomposition'), ('fn_bbj_orphaned_payouts'),
  ('fn_bbj_promo_bank_check'), ('fn_deal_fairness'), ('fn_detect_double_dealing'),
  ('fn_audit_layer_silence'), ('fn_hand_history_bloat'), ('fn_hand_history_bloat_report'),
  ('fn_hand_history_prune_backlog'), ('fn_deprecated_table_usage'), ('fn_club_home_scope_parity'),
  ('fn_hg_text_writing_functions'), ('fn_leaderboard_snapshot_gaps'), ('fn_snapshot_health'),
  ('fn_recent_place_collisions'), ('fn_solver_v2_progress'), ('fn_tournament_metrics'),
  ('fn_strip_client_writes_from_new_views'), ('verify_home_games_health'),
  ('verify_home_games_health_addendum'), ('ca_brain_telemetry'), ('ca_horse_daily_audit'),
  ('fn_club_profit_conservation'), ('fn_club_profit_drift'), ('fn_nit_evictions');

-- PRE-FLIGHT
do $$
declare
  v_missing text;
  v_open    bigint;
  v_no_svc  text;
begin
  select string_agg(t.fname, ', ') into v_missing
    from _telemetry_surface t
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = t.fname and p.prosecdef);
  if v_missing is not null then
    raise exception 'PRE-FLIGHT: not present as SECURITY DEFINER in public: %', v_missing;
  end if;

  -- The surface must actually be open, or this migration is describing a world
  -- that no longer exists and should be re-read before it is trusted.
  select count(*) into v_open
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join _telemetry_surface t on t.fname = p.proname
   where n.nspname = 'public' and p.prosecdef
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if v_open = 0 then
    raise exception 'PRE-FLIGHT: nothing is open - the surface was already closed';
  end if;
  raise notice 'PRE-FLIGHT: % browser-reachable telemetry function(s)', v_open;

  -- Revoking from browsers must not orphan the operator path.
  select string_agg(p.proname, ', ') into v_no_svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join _telemetry_surface t on t.fname = p.proname
   where n.nspname = 'public' and not has_function_privilege('service_role', p.oid, 'EXECUTE');
  if v_no_svc is not null then
    raise exception 'PRE-FLIGHT: service_role cannot execute %, closing it would orphan ops', v_no_svc;
  end if;
end $$;

-- THE CHANGE
do $$
declare
  r record;
  v_done int := 0;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      join _telemetry_surface t on t.fname = p.proname
     where n.nspname = 'public' and p.prosecdef
     order by 1
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    v_done := v_done + 1;
  end loop;
  raise notice 'CHANGE: closed % function signature(s) to the browser', v_done;
end $$;

-- POST-APPLY: BOTH HALVES
do $$
declare
  v_open   text;
  v_nosvc  text;
  v_nit    bigint;
  v_metric bigint;
  v_supply numeric;
begin
  -- HALF ONE: no browser role reaches any of them any more.
  select string_agg(p.proname, ', ') into v_open
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join _telemetry_surface t on t.fname = p.proname
   where n.nspname = 'public'
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if v_open is not null then
    raise exception 'POST-APPLY: still browser-reachable: %', v_open;
  end if;

  -- HALF TWO: the operator path is intact, asserted by RUNNING the three the
  -- game server actually calls, not by reading their grants. fn_nit_evictions
  -- is the eviction rule the engine consults every hand; a bogus table id
  -- returns zero rows, which is the point - it executes.
  select string_agg(p.proname, ', ') into v_nosvc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join _telemetry_surface t on t.fname = p.proname
   where n.nspname = 'public' and not has_function_privilege('service_role', p.oid, 'EXECUTE');
  if v_nosvc is not null then
    raise exception 'POST-APPLY: service_role lost %', v_nosvc;
  end if;

  select count(*) into v_nit
    from public.fn_nit_evictions('00000000-0000-0000-0000-000000000000'::uuid);
  select count(*) into v_metric from public.fn_tournament_metrics(30, 30, 24);
  if v_metric < 1 then
    raise exception 'POST-APPLY: fn_tournament_metrics returned no row, the server reads this every tick';
  end if;
  perform 1 from public.fn_settlement_conservation_check() limit 1;
  raise notice 'POST-APPLY: engine path live (nit rows %, metrics rows %)', v_nit, v_metric;

  -- ...and the money itself is untouched. A revoke cannot move chips, so this
  -- reads the supply rather than asserting a number that would rot: it proves
  -- the ledger is still answering after the change.
  select coalesce(sum(balance), 0) into v_supply from public.wallets;
  if v_supply is null then
    raise exception 'POST-APPLY: the wallet supply could not be read';
  end if;
  raise notice 'POST-APPLY: ledger still answering, legacy wallet pool %', v_supply;
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - reopens the operator console to every logged-in account:
--
--   GRANT EXECUTE ON FUNCTION public.fn_chip_integrity_report() TO authenticated;
--   ... and the same for the other thirty-four names listed above.
-- ===========================================================================
