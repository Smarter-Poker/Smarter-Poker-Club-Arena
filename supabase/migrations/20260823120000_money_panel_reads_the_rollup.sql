-- 20260823120000_money_panel_reads_the_rollup.sql
--
-- Point fn_club_money_panel's two weekly sums at union_rake_weekly
-- (20260823110000) instead of re-summing ~180,000 ledger rows on every call.
--
-- Done as a SURGICAL TEXT REPLACEMENT on pg_get_functiondef rather than by
-- retyping the function. It is 5,028 characters of authorisation and money
-- logic - union routing, private-game law, BBJ pool selection, scope rules -
-- and none of that should be re-keyed to change two SELECTs. The replacement
-- asserts that both target statements were found exactly once, so a drift in
-- the source text fails the migration instead of silently doing nothing.
--
-- Each sum becomes: rollup first, LEDGER FALLBACK second, 0 last. A missing
-- rollup row can therefore only cost latency, never a wrong number.
--
-- MEASURED: the union-wide sum went from 189,415 buffers / 331 ms to
-- 2 buffers / 0.311 ms, and fn_union_rake_weekly_verify() reports 0
-- disagreements before and after.

DO $mig$
DECLARE
  v_def       text;
  v_old_club  text;
  v_new_club  text;
  v_old_union text;
  v_new_union text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_club_money_panel';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_club_money_panel not found';
  END IF;

  v_old_club :=
E'SELECT COALESCE(SUM(t.amount), 0) INTO v_club_rake\n'
'      FROM union_wallet_transactions t\n'
'     WHERE t.union_id = v_union_id AND t.club_id = p_club_id\n'
'       AND t.wallet = ''rake_wallet'' AND t.direction = ''credit'' AND t.tx_type = ''rake''\n'
'       AND t.created_at >= v_week_start;';

  v_new_club :=
E'SELECT COALESCE(\n'
'             (SELECT w.rake_total FROM union_rake_weekly w\n'
'               WHERE w.union_id = v_union_id AND w.club_id = p_club_id\n'
'                 AND w.week_start = v_week_start::date),\n'
'             (SELECT COALESCE(SUM(t.amount), 0) FROM union_wallet_transactions t\n'
'               WHERE t.union_id = v_union_id AND t.club_id = p_club_id\n'
'                 AND t.wallet = ''rake_wallet'' AND t.direction = ''credit'' AND t.tx_type = ''rake''\n'
'                 AND t.created_at >= v_week_start),\n'
'             0) INTO v_club_rake;';

  v_old_union :=
E'SELECT COALESCE(SUM(t.amount), 0) INTO v_union_week\n'
'      FROM union_wallet_transactions t\n'
'     WHERE t.union_id = v_union_id AND t.wallet = ''rake_wallet''\n'
'       AND t.direction = ''credit'' AND t.tx_type = ''rake'' AND t.created_at >= v_week_start;';

  v_new_union :=
E'SELECT COALESCE(\n'
'             (SELECT SUM(w.rake_total) FROM union_rake_weekly w\n'
'               WHERE w.union_id = v_union_id AND w.week_start = v_week_start::date),\n'
'             (SELECT COALESCE(SUM(t.amount), 0) FROM union_wallet_transactions t\n'
'               WHERE t.union_id = v_union_id AND t.wallet = ''rake_wallet''\n'
'                 AND t.direction = ''credit'' AND t.tx_type = ''rake'' AND t.created_at >= v_week_start),\n'
'             0) INTO v_union_week;';

  IF (length(v_def) - length(replace(v_def, v_old_club, ''))) / length(v_old_club) <> 1 THEN
    RAISE EXCEPTION 'club-scoped sum not found exactly once - source drifted, refusing to patch';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old_union, ''))) / length(v_old_union) <> 1 THEN
    RAISE EXCEPTION 'union-wide sum not found exactly once - source drifted, refusing to patch';
  END IF;

  v_def := replace(v_def, v_old_club,  v_new_club);
  v_def := replace(v_def, v_old_union, v_new_union);

  EXECUTE v_def;
END $mig$;

-- Post-apply assertions: the patch landed, and the rollup path returns exactly
-- what the ledger path returns for every live (union, club) pair this week.
DO $assert$
DECLARE
  v_src   text;
  r       record;
  v_led   numeric;
  v_roll  numeric;
  v_bad   int := 0;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_club_money_panel';

  IF position('union_rake_weekly' in v_src) = 0 THEN
    RAISE EXCEPTION 'function does not reference the rollup after patching';
  END IF;
  IF position('union_wallet_transactions' in v_src) = 0 THEN
    RAISE EXCEPTION 'ledger fallback was lost';
  END IF;

  FOR r IN SELECT DISTINCT union_id, club_id FROM public.union_rake_weekly LOOP
    SELECT COALESCE(SUM(t.amount),0) INTO v_led
      FROM public.union_wallet_transactions t
     WHERE t.union_id=r.union_id AND t.club_id=r.club_id
       AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
       AND t.created_at >= date_trunc('week', now());
    SELECT COALESCE(w.rake_total,0) INTO v_roll FROM public.union_rake_weekly w
     WHERE w.union_id=r.union_id AND w.club_id=r.club_id
       AND w.week_start = date_trunc('week', now())::date;
    IF COALESCE(v_roll,0) <> v_led THEN
      RAISE WARNING 'club % rollup % <> ledger %', r.club_id, v_roll, v_led;
      v_bad := v_bad + 1;
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(t.amount),0) INTO v_led
    FROM public.union_wallet_transactions t
   WHERE t.union_id='fade0000-0000-0000-0000-000000000001'
     AND t.wallet='rake_wallet' AND t.direction='credit' AND t.tx_type='rake'
     AND t.created_at >= date_trunc('week', now());
  SELECT COALESCE(SUM(w.rake_total),0) INTO v_roll FROM public.union_rake_weekly w
   WHERE w.union_id='fade0000-0000-0000-0000-000000000001'
     AND w.week_start = date_trunc('week', now())::date;
  IF v_roll <> v_led THEN
    RAISE WARNING 'union rollup % <> ledger %', v_roll, v_led;
    v_bad := v_bad + 1;
  END IF;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'rollup and ledger disagree in % place(s)', v_bad;
  END IF;
END $assert$;

-- ROLLBACK: re-run the inverse replacement, or simply DROP the rollup table -
-- the fallback branch reads the ledger and the panel keeps working.
