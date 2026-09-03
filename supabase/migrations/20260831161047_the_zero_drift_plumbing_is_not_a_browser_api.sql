-- ===========================================================================
-- THE ZERO-DRIFT PLUMBING IS NOT A BROWSER API (2026-08-31)
--
-- Found while landing the zero-drift bundle into the repo:
-- check-definer-authorization blocked the push, and on four functions it is
-- right about production, not merely about replay.
--
--   fn_ca_autoledger             trigger fn   anon YES   authenticated YES
--   fn_ca_chip_ledger_enrich     trigger fn   anon no    authenticated YES
--   fn_ca_journal_append_only    trigger fn   anon no    authenticated YES
--   fn_ca_supply_snapshot        writes       anon no    authenticated YES
--
-- The first three are TRIGGER functions - they return `trigger`, take no
-- arguments, and PostgREST never exposes them. This is precisely the class
-- phase 3 closed in 20260831d when it revoked 173 such grants ("a trigger
-- function is not an API"): the grant buys nothing and only widens the
-- surface. fn_ca_autoledger being anon-executable is the sharpest case - it is
-- the generic auto-ledger writer for every balance store on the platform.
--
-- fn_ca_supply_snapshot writes a chip-supply snapshot row. Its callers are
-- fn_ca_quick_reconcile and the cron ticks, all service_role. Nothing in
-- either repo calls any of the four from a browser - checked before revoking.
--
-- DELIBERATELY NOT TOUCHED: atomic_table_buyin and atomic_table_rebuy are also
-- SECURITY DEFINER and executable by `authenticated`, and they stay that way -
-- they ARE the browser's buy-in and rebuy API. Revoking them to satisfy a lint
-- would break the product to fix a warning.
--
-- VERIFIED AFTER APPLYING, in a rolled-back transaction: a real
-- club_members.chip_balance movement still wrote its ledger row
-- (chip_ledger 223,307 -> 223,308). Revoking EXECUTE does not stop a trigger
-- firing, because firing does not re-check the privilege - the same property
-- phase 3 probed for row triggers, re-proved here on the auto-ledger because
-- getting it wrong would silently stop journalling every balance change.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
declare r record;
begin
  for r in select unnest(array['fn_ca_autoledger','fn_ca_chip_ledger_enrich',
                               'fn_ca_journal_append_only','fn_ca_supply_snapshot']) as f
  loop
    if not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public' and p.proname=r.f) then
      raise exception 'PRE-FLIGHT: public.% does not exist', r.f;
    end if;
  end loop;

  if (select count(*) from pg_trigger t join pg_proc p on p.oid=t.tgfoid
       where not t.tgisinternal and p.proname='fn_ca_autoledger') = 0 then
    raise exception 'PRE-FLIGHT: fn_ca_autoledger is attached to no trigger - do not re-permission dead plumbing';
  end if;
end $$;

-- THE CHANGE
revoke all on function public.fn_ca_autoledger() from public, anon, authenticated;
revoke all on function public.fn_ca_chip_ledger_enrich() from public, anon, authenticated;
revoke all on function public.fn_ca_journal_append_only() from public, anon, authenticated;
revoke all on function public.fn_ca_supply_snapshot() from public, anon, authenticated;

-- POST-APPLY: BOTH HALVES
do $$
declare
  v_open text := '';
  r record;
begin
  -- HALF ONE: the browser is out of all four.
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public'
              and p.proname in ('fn_ca_autoledger','fn_ca_chip_ledger_enrich',
                                'fn_ca_journal_append_only','fn_ca_supply_snapshot')
  loop
    if has_function_privilege('anon', r.oid, 'EXECUTE')
       or has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      v_open := v_open || ' ' || r.proname;
    end if;
  end loop;
  if v_open <> '' then
    raise exception 'POST-APPLY: still browser-executable:%', v_open;
  end if;

  -- HALF TWO: the auto-ledger is still wired and enabled. Revoking EXECUTE
  -- from a trigger function must not stop it firing; if it did, every balance
  -- change on the platform would silently stop journalling.
  if exists (
    select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
     where not t.tgisinternal and p.proname = 'fn_ca_autoledger' and t.tgenabled = 'D'
  ) then
    raise exception 'POST-APPLY: an auto-ledger trigger is DISABLED';
  end if;

  if (select count(*) from pg_trigger t join pg_proc p on p.oid=t.tgfoid
       where not t.tgisinternal and p.proname='fn_ca_autoledger') = 0 then
    raise exception 'POST-APPLY: the auto-ledger triggers have gone';
  end if;

  raise notice 'POST-APPLY: four functions closed to the browser; % auto-ledger trigger(s) attached and enabled',
    (select count(*) from pg_trigger t join pg_proc p on p.oid=t.tgfoid
      where not t.tgisinternal and p.proname='fn_ca_autoledger');
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - restores grants that buy nothing:
--
--   GRANT EXECUTE ON FUNCTION public.fn_ca_autoledger()          TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_ca_chip_ledger_enrich()  TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_ca_journal_append_only() TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_ca_supply_snapshot()     TO authenticated;
-- ===========================================================================
