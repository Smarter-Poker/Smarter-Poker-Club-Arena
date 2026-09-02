-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825185251; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

do $$
declare d text;
begin
  select pg_get_functiondef(oid) into d
    from pg_proc
   where oid = 'public.fn_club_bank_send(uuid,uuid,numeric,text,text,uuid)'::regprocedure;

  if position('fn_club_cashier_can_transact' in d) = 0 then
    d := replace(d,
      'select coalesce(c.chip_treasury, 0) into v_bank_before',
      'if p_to_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_to_user_id) then
    return jsonb_build_object(''success'', false,
      ''error'', ''That Member Is Not In Your Downline'');
  end if;

  select coalesce(c.chip_treasury, 0) into v_bank_before');
    execute d;
  end if;
end $$;

do $$
declare d text;
begin
  select pg_get_functiondef(oid) into d
    from pg_proc
   where oid = 'public.fn_club_bank_claim_back(uuid,uuid,numeric,text,text,uuid)'::regprocedure;

  if position('fn_club_cashier_can_transact' in d) = 0 then
    d := replace(d,
      'select cm.role into v_holder_role',
      'if p_from_user_id <> v_actor
     and not public.fn_club_cashier_can_transact(p_club_id, v_actor, p_from_user_id) then
    return jsonb_build_object(''success'', false,
      ''error'', ''That Member Is Not In Your Downline'');
  end if;

  select cm.role into v_holder_role');
    execute d;
  end if;
end $$;
