-- ═══════════════════════════════════════════════════════════════════════════
-- upsert_horse_mind_stats IS ENGINE-ONLY (2026-09-02)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The sibling migration (20260902232420) re-created this SECURITY DEFINER
-- writer. CREATE OR REPLACE keeps the grants a function already has, and in
-- production those are already postgres + service_role only (the 2026-08-27
-- definer sweep closed it) — but the pre-push definer gate reads migration
-- text, not the live catalogue, and a declaration with no revoke beside it
-- reads as open. So the closure is stated here, explicitly, per role, the way
-- the gate and the sweep both require: PUBLIC named alongside the browser
-- roles, because revoking one while PUBLIC still holds EXECUTE does nothing.
--
-- Only the Hetzner engine flushes opponent stats. A browser that could call
-- this could inflate any player's observed counters (the merge is GREATEST-
-- monotonic, so the inflation would be permanent) and steer every horse read
-- of that player. Idempotent; TIER 1.

begin;

revoke all on function public.upsert_horse_mind_stats(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_horse_mind_stats(jsonb) to service_role;

do $$
declare v_n integer;
begin
  select count(*) into v_n from information_schema.routine_privileges
   where routine_schema = 'public' and routine_name = 'upsert_horse_mind_stats'
     and grantee in ('anon', 'authenticated', 'PUBLIC');
  if v_n <> 0 then raise exception 'upsert_horse_mind_stats still reachable by a browser role'; end if;
end $$;

commit;
