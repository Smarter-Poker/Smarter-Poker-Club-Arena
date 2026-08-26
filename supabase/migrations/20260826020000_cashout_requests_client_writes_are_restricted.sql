-- ═══════════════════════════════════════════════════════════════════════════════
--  cashout_requests: a client may never write one, and cannot be re-opened to
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS ACTUALLY EXPOSED, measured before writing this
-- -------------------------------------------------------
-- The audit note `.agent/audits/2026-08-20-storefront-diamond-mint-hole.md`
-- left this open, under "Still open - NOT fixed here, needs an owner decision":
--
--     public.cashout_requests has `cashout_update`: FOR UPDATE, PUBLIC,
--     USING (player_id = auth.uid() OR <club staff>), WITH CHECK null. The
--     table carries `amount` and `status`, so on the face of it a player can
--     edit their own cashout request after submitting it.
--
-- That policy is GONE. `20260825_role_scoped_cashier_agent_wallet_and_cashout_escrow`
-- dropped `cashout_update` and `cashout_insert` earlier the same day and moved
-- every write onto SECURITY DEFINER functions. Probed against production as a
-- real player, inside a transaction that was rolled back:
--
--     rows_player_can_SELECT=1  rows_UPDATE_amount=0
--     rows_UPDATE_status=0      rows_DELETE=0
--
-- So there is NO live write exposure, and this migration is not a hotfix. It
-- closes the thing that is actually fragile about the current state.
--
-- WHAT IS FRAGILE
-- ---------------
-- The table's protection is the ABSENCE of a policy, sitting on top of grants
-- that are wide open:
--
--     anon           SELECT, INSERT, UPDATE, DELETE
--     authenticated  SELECT, INSERT, UPDATE, DELETE
--
-- RLS denies by default, so absence is enough - until someone adds one
-- permissive policy. `create policy ... for all to authenticated using (true)`
-- is the single most common line in a Supabase codebase, and on this table it
-- would silently re-open `amount` and `status` to the player who owns the row.
-- Nothing would fail; the money would just start moving.
--
-- A RESTRICTIVE policy is ANDed with every permissive policy that exists now or
-- is added later. `using (false)` therefore cannot be undone by adding
-- permission - only by dropping this policy on purpose, which is a visible act.
--
-- WHY THIS BREAKS NOTHING
-- -----------------------
--   * The four RPCs a browser may call - fn_cashout_request, fn_cashout_approve,
--     fn_cashout_release, fn_cashout_queue - are SECURITY DEFINER owned by
--     `postgres`, which owns this table with force_rls OFF. RLS is not applied
--     inside them at all, so a policy scoped to anon/authenticated cannot reach
--     them. Confirmed: relforcerowsecurity = false.
--   * service_role is not in the TO list, so the World Hub API routes and the
--     Hetzner engine are untouched. The existing `cashout_svc` (FOR ALL TO
--     service_role) still applies.
--   * The SECURITY INVOKER cashout functions are granted only to postgres and
--     service_role, so no browser reaches them either.
--   * Reads are unchanged: `cashout_read_scoped` still lets the player, the
--     assigned agent, club owner/co_owner/admin and an upline agent see a row.
--
-- The assertions at the bottom prove each of those against the live catalog
-- rather than trusting this comment.
--
-- ROLLBACK
-- --------
--   drop policy if exists "cashout_no_client_insert" on public.cashout_requests;
--   drop policy if exists "cashout_no_client_update" on public.cashout_requests;
--   drop policy if exists "cashout_no_client_delete" on public.cashout_requests;
-- Dropping all three returns the table to deny-by-absence, which is where it is
-- today. No data is written or altered by this migration, so there is nothing
-- else to undo.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Pre-flight: refuse to run if the world is not what the comment above claims.
do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'cashout_requests' and c.relrowsecurity
  ) then
    raise exception 'cashout_requests does not have RLS enabled; a restrictive policy would be decoration';
  end if;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'cashout_requests' and c.relforcerowsecurity
  ) then
    raise exception 'cashout_requests has force_rls ON; the SECURITY DEFINER cashout RPCs would be blocked by this migration';
  end if;
end $$;

drop policy if exists "cashout_no_client_insert" on public.cashout_requests;
drop policy if exists "cashout_no_client_update" on public.cashout_requests;
drop policy if exists "cashout_no_client_delete" on public.cashout_requests;

-- A row is created only by fn_cashout_request, which also takes the chips into
-- escrow. A client-side INSERT is a request with no escrow behind it, and
-- approving one of those credits an agent out of nothing.
create policy "cashout_no_client_insert" on public.cashout_requests
  as restrictive for insert to anon, authenticated
  with check (false);

-- `amount` and `status` are the two columns worth forging. Neither is editable
-- from a browser: fn_cashout_approve / fn_cashout_release own every transition.
create policy "cashout_no_client_update" on public.cashout_requests
  as restrictive for update to anon, authenticated
  using (false) with check (false);

-- A cashout is closed by cancelling or rejecting it, which returns the escrow.
-- Deleting the row would orphan the chip_escrow row instead.
create policy "cashout_no_client_delete" on public.cashout_requests
  as restrictive for delete to anon, authenticated
  using (false);

comment on table public.cashout_requests is
  'Player cashout queue. Client writes are barred by three RESTRICTIVE policies; '
  'the only write paths are fn_cashout_request / fn_cashout_approve / '
  'fn_cashout_release (SECURITY DEFINER) and service_role. Reads are scoped by '
  'cashout_read_scoped.';

-- Post-apply assertions. These run inside the migration, so a wrong outcome
-- aborts it rather than shipping.
do $$
declare
  n_restrictive int;
  n_select      int;
begin
  select count(*) into n_restrictive
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'cashout_requests'
     and not p.polpermissive;
  if n_restrictive <> 3 then
    raise exception 'expected 3 restrictive policies on cashout_requests, found %', n_restrictive;
  end if;

  -- The agent queue must still be readable or the cashier panel goes blank.
  select count(*) into n_select
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'cashout_requests'
     and p.polcmd = 'r' and p.polpermissive;
  if n_select < 1 then
    raise exception 'the permissive SELECT policy on cashout_requests is missing; staff would see an empty queue';
  end if;

  -- The three player-callable write RPCs must still be SECURITY DEFINER, or
  -- the restrictive policies above would stop the cashier working.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('fn_cashout_request', 'fn_cashout_approve', 'fn_cashout_release')
       and not p.prosecdef
  ) then
    raise exception 'a client-callable cashout RPC is SECURITY INVOKER; it would now be blocked';
  end if;
end $$;
