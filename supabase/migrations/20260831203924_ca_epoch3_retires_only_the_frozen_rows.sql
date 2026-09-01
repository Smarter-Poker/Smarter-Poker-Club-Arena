-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 20:39:24 UTC on kuklfnapbkmacvwxktbh.

-- Audit follow-through (frozen-pool family): the epoch-3 reset retired every
-- nonzero public.wallets row. Since the certification harness legitimately
-- cycles chips through POST-freeze rows, an unlucky reset could have swept a
-- cert account mid-cycle. The retirement now targets exactly the frozen set:
-- rows created before 2026-08-22 (the 690 rows that sum to the 732,591,994.33
-- baseline, verified). Idempotent dynamic patch.
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_execute_epoch3_reset(text,boolean)'::regprocedure);
  IF v_def LIKE '%created_at < ''2026-08-22''%' THEN RETURN; END IF;
  v_new := replace(v_def,
    'SELECT count(*), COALESCE(round(sum(balance),2),0) INTO v_frozen_rows, v_frozen_total
    FROM public.wallets WHERE COALESCE(balance,0) <> 0;',
    'SELECT count(*), COALESCE(round(sum(balance),2),0) INTO v_frozen_rows, v_frozen_total
    FROM public.wallets WHERE COALESCE(balance,0) <> 0 AND created_at < ''2026-08-22'';');
  v_new := replace(v_new,
    'FROM public.wallets w WHERE COALESCE(w.balance, 0) > 0;',
    'FROM public.wallets w WHERE COALESCE(w.balance, 0) > 0 AND w.created_at < ''2026-08-22'';');
  v_new := replace(v_new,
    'UPDATE public.wallets SET balance = 0, updated_at = now() WHERE COALESCE(balance,0) <> 0;',
    'UPDATE public.wallets SET balance = 0, updated_at = now() WHERE COALESCE(balance,0) <> 0 AND created_at < ''2026-08-22'';');
  IF v_new = v_def THEN RAISE EXCEPTION 'epoch3 frozen-scope: anchors not found'; END IF;
  EXECUTE v_new;
END $$;;
