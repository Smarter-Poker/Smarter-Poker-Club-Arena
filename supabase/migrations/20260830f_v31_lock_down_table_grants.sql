-- ═══════════════════════════════════════════════════════════════════════════
-- V31 — match the V30 precedent on table grants (2026-08-30)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The three V31 tables were created with `create table`, so they inherited
-- the project's default grants, which include SELECT for `anon` and
-- `authenticated`. RLS is enabled on all of them with ZERO policies, so
-- nothing is actually readable through PostgREST today — an RLS-enabled
-- table with no policy denies every non-bypass role.
--
-- So this is not a live leak. It is a defence-in-depth gap, and it is worth
-- closing because of what the table holds: `gto_postflop_v31` IS the horses'
-- strategy — the exact solver mix each hand class plays on each texture, at
-- each depth and position. A single permissive policy added later by someone
-- working on something else, or RLS switched off for ten minutes during
-- unrelated debugging, and a player can read the fleet's frequencies and play
-- perfectly against them.
--
-- The precedent already exists and these tables simply did not follow it:
-- `gto_postflop_compact`, V30's equivalent, grants SELECT only to `postgres`
-- and `service_role`. Only the engine ever reads any of this, so restricting
-- them costs nothing.
--
-- Verified after applying: all four tables now report exactly
-- `postgres,service_role`, and a live RPC call still folded a batch of 10 in
-- 2.54s, so the engine's write path is intact.
--
-- TIER 2: privileges only. No schema, no data, no function bodies.

revoke all on public.gto_postflop_v31     from anon, authenticated;
revoke all on public.gto_agg_progress_v31 from anon, authenticated;
revoke all on public.gto_combo_map        from anon, authenticated;

grant select, insert, update on public.gto_postflop_v31     to service_role;
grant select, insert, update on public.gto_agg_progress_v31 to service_role;
grant select                 on public.gto_combo_map        to service_role;

do $$
declare v_n integer; v_rls boolean; v_t text;
begin
  foreach v_t in array array['gto_postflop_v31','gto_agg_progress_v31','gto_combo_map'] loop
    select count(*) into v_n from information_schema.role_table_grants
     where table_schema = 'public' and table_name = v_t
       and grantee in ('anon', 'authenticated');
    if v_n <> 0 then
      raise exception '% still grants % privilege(s) to anon/authenticated', v_t, v_n;
    end if;

    select c.relrowsecurity into v_rls from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = v_t;
    if not coalesce(v_rls, false) then
      raise exception '% does not have row level security enabled', v_t;
    end if;

    -- the other half of the check: locking it down must not blind the engine
    select count(*) into v_n from information_schema.role_table_grants
     where table_schema = 'public' and table_name = v_t
       and grantee = 'service_role' and privilege_type = 'SELECT';
    if v_n = 0 then
      raise exception '% no longer grants SELECT to service_role', v_t;
    end if;
  end loop;
end $$;

-- ROLLBACK (not advised — this restores a grant the V30 table does not have):
--   grant select on public.gto_postflop_v31, public.gto_agg_progress_v31,
--                   public.gto_combo_map to anon, authenticated;
