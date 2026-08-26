do $mig$
declare
  v_def text;
  v_old text := 'status = ''active''';
  v_new text := 'status in (''active'', ''approved'')';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_cashier_send_chips';
  if v_def is not null then
    execute replace(v_def, v_old, v_new);
  end if;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_cashier_claim_back';
  if v_def is not null then
    execute replace(v_def, v_old, v_new);
  end if;
end $mig$;
do $mig2$
declare
  v_def text;
  v_old text := 'status = ''active''';
  v_new text := 'status in (''active'', ''approved'')';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_issue_tournament_ticket';
  if v_def is not null then
    execute replace(v_def, v_old, v_new);
  end if;
end $mig2$;
