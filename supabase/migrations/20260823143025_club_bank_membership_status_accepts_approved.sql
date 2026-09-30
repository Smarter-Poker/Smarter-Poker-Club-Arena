-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260823143025 as "club_bank_membership_status_accepts_approved"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- MEMBERSHIP STATUS CARRIES TWO WORDS (found by smoke test, 2026-08-23)
--
-- A club_members row means "in this club", and the column says so in two ways:
-- everything created before 2026-07-22 says 'approved', everything since says
-- 'active', and 1,480 of the 1,499 rows in production are the OLDER word. The
-- rule is named once in src/pages/CashierTradePage.tsx (MEMBER_IN_CLUB) and
-- pinned in tests/unit/clubMemberStatus.test.ts; the club-bank functions
-- shipped asking for 'active' alone.
--
-- The damage that would have caused:
--   fn_club_bank_role  -> null for any owner/admin/super agent whose row says
--                         'approved', so fn_can_use_club_bank refused them,
--                         the LEDGER refused them, and every send refused them.
--                         Only a club's literal owner_id would have got in.
--   fn_club_bank_send  -> "Recipient Is Not An Active Member Of This Club" for
--                         essentially every real member in the database.
--
-- Caught before any human touched it because the smoke test used a REAL club
-- and a REAL agent rather than a fixture.
--
-- ROLLBACK: re-apply club_bank_cashier_access_and_send +
--           club_bank_idempotency_and_reversal.

create or replace function public.fn_club_bank_role(p_club_id uuid, p_user_id uuid default null)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_club_id is null then null
    when exists (select 1 from public.clubs c
                  where c.id = p_club_id
                    and c.owner_id = coalesce(p_user_id, auth.uid())) then 'owner'
    else (select cm.role from public.club_members cm
           where cm.club_id = p_club_id
             and cm.user_id = coalesce(p_user_id, auth.uid())
             and coalesce(cm.status, 'active') in ('active', 'approved')
           limit 1)
  end;
$$;

-- fn_club_bank_send: the recipient membership check, same correction.
do $mig$
declare
  v_def text;
  v_old text := 'and coalesce(cm.status, ''active'') = ''active''
   for update;';
  v_new text := 'and coalesce(cm.status, ''active'') in (''active'', ''approved'')
   for update;';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_club_bank_send';
  if v_def is null then raise exception 'fn_club_bank_send not found'; end if;
  if position(v_old in v_def) = 0 then
    if position('in (''active'', ''approved'')' in v_def) > 0 then
      raise notice 'already corrected';
      return;
    end if;
    raise exception 'recipient status check not found - refusing to patch';
  end if;
  execute replace(v_def, v_old, v_new);
end $mig$;

-- ── ASSERTIONS ──────────────────────────────────────────────────────────────
do $assert$
declare v_src text; v_bad int := 0;
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_club_bank_role';
  if position('''approved''' in v_src) = 0 then
    raise warning 'fn_club_bank_role still refuses approved memberships'; v_bad := v_bad + 1;
  end if;
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_club_bank_send';
  if position('''approved''' in v_src) = 0 then
    raise warning 'fn_club_bank_send still refuses approved recipients'; v_bad := v_bad + 1;
  end if;
  if position('op_id' in v_src) = 0 then
    raise warning 'idempotency key was lost by the patch'; v_bad := v_bad + 1;
  end if;
  if v_bad > 0 then raise exception 'status fix failed % assertion(s)', v_bad; end if;
end $assert$;
