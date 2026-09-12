INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
SELECT u.table_name,
       u.trigger_name,
       'In service on 2026-09-12, declared as the baseline for '
         || 'check-money-trigger-declared. Records that it was live and known at that '
         || 'date, not that it was re-reviewed then. Anything created after this date '
         || 'declares itself in its own migration.'
  FROM public.fn_undeclared_money_triggers() u
ON CONFLICT (table_name, trigger_name) DO NOTHING;

DO $$
DECLARE
  v_left integer;
  v_total integer;
BEGIN
  SELECT count(*)::int INTO v_left FROM public.fn_undeclared_money_triggers();
  SELECT count(*)::int INTO v_total FROM public.ca_declared_money_triggers;

  IF v_left <> 0 THEN
    RAISE EXCEPTION
      'ca_declared_money_triggers still reports % undeclared money trigger(s) after the baseline',
      v_left;
  END IF;

  RAISE NOTICE
    'money trigger register: 0 undeclared, % declared in total. UndeclaredTriggerOnAMoneyTable can fire on the next one.',
    v_total;
END $$;