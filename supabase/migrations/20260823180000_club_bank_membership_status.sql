-- ═══════════════════════════════════════════════════════════════════════════
--  MEMBERSHIP STATUS CARRIES TWO WORDS (found by smoke test, 2026-08-23)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- APPLIED TO PRODUCTION via Supabase MCP as
-- `club_bank_membership_status_accepts_approved`. Mirror of what ran.
--
-- A club_members row means "in this club", and the column says so in two ways:
-- everything created before 2026-07-22 says 'approved', everything since says
-- 'active', and 1,480 of the 1,499 rows in production are the OLDER word. The
-- rule is named once in src/pages/CashierTradePage.tsx (MEMBER_IN_CLUB), again
-- in src/components/wallet/ClubBankCashierModal.tsx, and pinned in
-- tests/unit/clubMemberStatus.test.ts. The club-bank functions shipped in
-- 20260823140000 asking for 'active' alone.
--
-- WHAT THAT WOULD HAVE DONE, had it reached a person:
--
--   fn_club_bank_role  -> null for any owner, co-owner, admin or super agent
--                         whose membership row says 'approved'. So
--                         fn_can_use_club_bank refused them, the LEDGER refused
--                         them, and every send refused them. Only a club's
--                         literal clubs.owner_id would have got in - one person
--                         per club, and nobody else on the staff.
--
--   fn_club_bank_send  -> "Recipient Is Not An Active Member Of This Club" for
--                         essentially every real member in the database. The
--                         cashier would have listed 500 people and refused all
--                         of them.
--
-- It was caught before any human touched it because the verification ran
-- against a REAL club and a REAL agent instead of a fixture. A fixture would
-- have been created today, with status 'active', and passed.
--
-- ROLLBACK: re-apply 20260823140000_club_bank_cashier.sql part 0 and
--           20260823170000 part 2.

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

-- fn_club_bank_send: the recipient membership check, same correction. Patched
-- by text replacement on the live definition rather than retyped, so the
-- idempotency handling added in 20260823170000 cannot be lost by a stale copy.
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
