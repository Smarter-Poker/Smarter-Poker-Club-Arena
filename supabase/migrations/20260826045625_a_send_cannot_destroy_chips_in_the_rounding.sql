-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826045625; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

do $migrate$
declare
  v_fn      text;
  v_def     text;
  v_new     text;
  v_anchor  text;
  v_added   text;
  v_patched int := 0;
begin
  v_anchor :=
    '  if p_amount is null or p_amount <= 0 then' || E'\n' ||
    '    return jsonb_build_object(''success'', false, ''error'', ''Amount Must Be Greater Than Zero'');' || E'\n' ||
    '  end if;';

  v_added := v_anchor || E'\n\n' ||
    '  -- p_amount is unbounded-scale numeric and the two sides of a transfer do' || E'\n' ||
    '  -- NOT share a scale: agents.agent_wallet_balance is numeric(18,4) and' || E'\n' ||
    '  -- club_members.chip_balance is numeric(20,2). An amount like 10.00005 is' || E'\n' ||
    '  -- debited as 10.0001 and credited as 10.00, so a ten-thousandth of a chip' || E'\n' ||
    '  -- is destroyed on every call and reconcile_ledger_nightly cannot see it -' || E'\n' ||
    '  -- it compares the ledger against stored balances, and both sides here are' || E'\n' ||
    '  -- written by the same rounded arithmetic. The cashier refuses fractions,' || E'\n' ||
    '  -- but a dropdown is not a rule: anything holding a session calls this RPC' || E'\n' ||
    '  -- directly. Two decimal places is the coarser of the two columns, so a' || E'\n' ||
    '  -- value that survives this guard survives both stores intact.' || E'\n' ||
    '  if p_amount <> round(p_amount, 2) then' || E'\n' ||
    '    return jsonb_build_object(''success'', false,' || E'\n' ||
    '      ''error'', ''Chips Move In Hundredths At Most'');' || E'\n' ||
    '  end if;';

  foreach v_fn in array array['fn_agent_wallet_send', 'fn_club_bank_send', 'fn_promo_wallet_send']
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;

    if v_def is null then
      raise exception '% not found - refusing to guess', v_fn;
    end if;

    -- Already carrying the guard? Leave it alone rather than double-inserting.
    if position('Chips Move In Hundredths At Most' in v_def) > 0 then
      continue;
    end if;

    if position(v_anchor in v_def) = 0 then
      raise exception 'amount guard not found in % - refusing to patch blind', v_fn;
    end if;

    v_new := replace(v_def, v_anchor, v_added);
    if v_new = v_def then
      raise exception 'replacement was a no-op in % - refusing to ship an unchanged function', v_fn;
    end if;

    execute v_new;
    v_patched := v_patched + 1;
  end loop;

  if v_patched = 0 then
    raise exception 'nothing was patched - the guard would be documented and unenforced';
  end if;
end
$migrate$;

do $verify$
declare v_fn text; v_def text;
begin
  foreach v_fn in array array['fn_agent_wallet_send', 'fn_club_bank_send', 'fn_promo_wallet_send']
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;
    if position('round(p_amount, 2)' in v_def) = 0 then
      raise exception '% can still destroy chips in the rounding', v_fn;
    end if;
    if position('Amount Must Be Greater Than Zero' in v_def) = 0 then
      raise exception 'the zero guard was lost from %', v_fn;
    end if;
  end loop;
end
$verify$;
