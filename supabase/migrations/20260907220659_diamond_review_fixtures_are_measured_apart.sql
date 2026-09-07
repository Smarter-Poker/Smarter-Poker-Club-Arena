-- DIAMOND ACCOUNTING STANDARD - REVIEW FIX 2 (2026-09-07)
-- The certification harnesses write fixture balances directly through PostgREST (review D8: 151 direct
-- UPDATE profiles SET diamonds, 500 -> 0, -67,775 in five days, every one a fixture account, no journal
-- row, no register row). That is a real DR6 finding against the harness, filed at info since review fix 1.
-- It must not be able to arm the deploy gate or break the player trial balance, so the snapshot stores the
-- fixture share and the fixture register beside the meter, and both identities are measured on players
-- alone with the fixture movement reported on its own row. Horses are players and are never in the
-- fixture figure (fn_ca_is_fixture_account never matches a horse).
-- No balance moves. Applied once.

BEGIN;
SET LOCAL lock_timeout = '4s';

ALTER TABLE public.ca_diamond_snapshots
  ADD COLUMN IF NOT EXISTS fixture_diamonds numeric,
  ADD COLUMN IF NOT EXISTS register_fixture numeric;
COMMENT ON COLUMN public.ca_diamond_snapshots.fixture_diamonds IS
  'SUM(profiles.diamonds) over fn_ca_is_fixture_account at snapshot time. Inside profile_diamonds; stored so the player identity can be measured without the certification harness.';
COMMENT ON COLUMN public.ca_diamond_snapshots.register_fixture IS
  'Net of ca_mint_ledger player holders that are fixture accounts at snapshot time. Inside register_supply.';

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_snapshot()
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_prof numeric; v_wal numeric; v_cert numeric; v_total numeric; v_house numeric;
  v_reg numeric; v_fix numeric; v_reg_fix numeric;
  prev RECORD; v_journal numeric; v_journal_noncert numeric; v_unexplained numeric; v_fix_unexplained numeric;
  v_basis_changed boolean := false;
  v_prev_basis numeric;
  v_mirror_bad bigint := 0;
BEGIN
  SELECT COALESCE(sum(diamonds),0) INTO v_prof FROM profiles;
  SELECT COALESCE(sum(balance),0)  INTO v_wal  FROM diamond_wallets;
  SELECT COALESCE(sum(p.diamonds),0) INTO v_cert FROM profiles p WHERE public.fn_ca_is_cert_account(p.id);
  SELECT COALESCE(sum(p.diamonds),0) INTO v_fix  FROM profiles p WHERE public.fn_ca_is_fixture_account(p.id);
  SELECT COALESCE(balance, 0) INTO v_house FROM public.ca_diamond_house WHERE id = 1;
  v_house := COALESCE(v_house, 0);
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_reg
    FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player';
  SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) INTO v_reg_fix
    FROM public.ca_mint_ledger m
   WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND public.fn_ca_is_fixture_account(m.holder_id);

  v_total := v_prof;

  SELECT count(*) INTO v_mirror_bad
    FROM profiles p
    LEFT JOIN user_diamonds        ud  ON ud.user_id  = p.id
    LEFT JOIN user_diamond_balance udb ON udb.user_id = p.id
    LEFT JOIN diamond_wallets      dw  ON dw.user_id  = p.id
   WHERE ud.user_id IS NULL OR udb.user_id IS NULL OR dw.user_id IS NULL
      OR ud.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)
      OR udb.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int
      OR dw.balance  IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int;

  SELECT * INTO prev FROM public.ca_diamond_snapshots ORDER BY taken_at DESC LIMIT 1;
  IF prev.id IS NOT NULL THEN
    SELECT COALESCE(sum(amount),0) INTO v_journal FROM diamond_transactions WHERE created_at > prev.taken_at;
    SELECT COALESCE(sum(amount),0) INTO v_journal_noncert
      FROM diamond_transactions t WHERE t.created_at > prev.taken_at AND NOT public.fn_ca_is_cert_account(t.user_id);
    SELECT EXISTS (SELECT 1 FROM public.ca_cert_accounts c WHERE c.tagged_at > prev.taken_at) INTO v_basis_changed;
    v_prev_basis := prev.profile_diamonds;
  END IF;

  -- The player identity, on stored figures, fixtures apart (2026-09-07 review fix 2):
  --   unexplained = (players - fixtures) moved - (player register - fixture register) moved.
  -- The fixture share is measured the same way and reported as its own drift class, because the
  -- certification harness writes fixture balances directly (a harness defect, DR6 at info), and a
  -- harness defect must never arm the deploy gate that protects players.
  IF prev.id IS NOT NULL AND prev.register_supply IS NOT NULL AND prev.fixture_diamonds IS NOT NULL THEN
    v_unexplained     := ((v_total - v_fix) - (v_prev_basis - prev.fixture_diamonds))
                       - ((v_reg - v_reg_fix) - (prev.register_supply - COALESCE(prev.register_fixture, 0)));
    v_fix_unexplained := (v_fix - prev.fixture_diamonds) - (v_reg_fix - COALESCE(prev.register_fixture, 0));
  ELSIF prev.id IS NOT NULL AND prev.register_supply IS NOT NULL THEN
    -- One transitional row: the previous snapshot stored the register but not the fixture split.
    v_unexplained := NULL; v_fix_unexplained := NULL;
  ELSIF prev.id IS NOT NULL AND NOT v_basis_changed THEN
    v_unexplained := (v_total - v_cert) - (v_prev_basis - COALESCE(prev.cert_diamonds, 0)) - COALESCE(v_journal_noncert, 0);
    v_fix_unexplained := NULL;
  ELSE
    v_unexplained := NULL; v_fix_unexplained := NULL;
  END IF;

  INSERT INTO public.ca_diamond_snapshots
    (profile_diamonds, wallet_diamonds, cert_diamonds, total, journaled_delta, delta_vs_prev, unexplained,
     register_supply, house_balance, fixture_diamonds, register_fixture)
  VALUES
    (v_prof, v_wal, v_cert, v_total, v_journal,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - v_prev_basis END,
     v_unexplained, v_reg, v_house, v_fix, v_reg_fix);

  IF v_mirror_bad > 0 THEN
    PERFORM public.fn_ca_diamond_incident('DR10:mirror_mismatch', 'warning', NULL, v_mirror_bad::numeric,
      'fn_ca_diamond_snapshot',
      jsonb_build_object('profiles_disagreeing', v_mirror_bad, 'profile_diamonds', v_prof, 'wallet_diamonds', v_wal,
        'note', 'the three mirrors are upserted on INSERT and UPDATE since 2026-09-07; a disagreeing or missing row means a writer bypassed the mirror trigger'));
  END IF;

  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 50 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_diamond_snapshot', 'ledger_imbalance',
      CASE WHEN abs(v_unexplained) > 5000 THEN 'critical' ELSE 'warning' END,
      'diamond-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained, v_prev_basis + COALESCE(v_journal,0), v_total,
      'ledger', 'ca_diamond_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'player diamond supply (fixtures excluded) moved by ' || round(v_unexplained,2)
        || ' more than the Mint register explains - a diamond writer is bypassing the register',
      false, jsonb_build_object('profile_diamonds', v_prof, 'fixture_diamonds', v_fix, 'register_supply', v_reg,
                                 'register_fixture', v_reg_fix, 'house_balance', v_house));
  END IF;

  IF v_fix_unexplained IS NOT NULL AND v_fix_unexplained <> 0 THEN
    PERFORM public.fn_ca_diamond_incident('DR6:fixture_harness_unregistered_movement', 'info', NULL, v_fix_unexplained,
      'fn_ca_diamond_snapshot',
      jsonb_build_object('fixture_diamonds', v_fix, 'prev_fixture_diamonds', prev.fixture_diamonds,
        'register_fixture', v_reg_fix, 'prev_register_fixture', prev.register_fixture,
        'note', 'certification fixture balances moved outside the journal and the register (the harness writes profiles.diamonds directly). Not a player movement. The root fix is the harness funding through fn_ca_mint and spending through deduct_diamonds.'));
  END IF;

  RETURN v_unexplained;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance(p_since timestamptz DEFAULT (now() - interval '75 minutes'))
RETURNS TABLE(account text, balance_now numeric, balance_delta numeric, journal_net numeric,
              mint_net numeric, difference numeric, note text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  c_foundation constant timestamptz := timestamptz '2026-09-03 00:07:00+00';
  v_since   timestamptz := COALESCE(p_since, now() - interval '75 minutes');
  s0        public.ca_diamond_snapshots%ROWTYPE;
  w0        timestamptz;
  v_players numeric; v_house numeric; v_reg numeric; v_reg_players numeric; v_reg_house numeric;
  v_fix numeric; v_reg_fix numeric; v_fix_n bigint;
  v_delta   numeric; v_jrn numeric; v_jrn_live numeric; v_jrn_archive numeric; v_mint numeric;
  v_diff    numeric; v_note text; v_n bigint; v_sub numeric; v_tmp numeric;
  v_house_ledger numeric;
  v_tot_now numeric := 0; v_tot_delta numeric := 0; v_tot_jrn numeric := 0; v_tot_mint numeric := 0;
  r record;
BEGIN
  SELECT * INTO s0 FROM public.ca_diamond_snapshots WHERE taken_at >= v_since ORDER BY taken_at ASC LIMIT 1;
  w0 := COALESCE(s0.taken_at, v_since);

  SELECT COALESCE(SUM(COALESCE(p.diamonds, 0)), 0)::numeric INTO v_players FROM public.profiles p;
  SELECT COALESCE(SUM(p.diamonds), 0), count(*) INTO v_fix, v_fix_n FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id);
  SELECT COALESCE(balance, 0) INTO v_house FROM public.ca_diamond_house WHERE id = 1;
  v_house := COALESCE(v_house, 0);
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_reg_players
    FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player';
  SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0) INTO v_reg_fix
    FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND public.fn_ca_is_fixture_account(m.holder_id);
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_reg_house
    FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'house';

  SELECT COALESCE(SUM(dt.amount), 0) INTO v_jrn_live FROM public.diamond_transactions dt WHERE dt.created_at >= w0 AND dt.created_at < now();
  SELECT COALESCE(SUM(a.amount), 0) INTO v_jrn_archive FROM public.ca_diamond_journal_archive a WHERE a.created_at >= w0 AND a.created_at < now();
  v_jrn := v_jrn_live + v_jrn_archive;

  -- player_diamonds: players without the fixture harness, on stored figures.
  IF s0.id IS NULL THEN
    v_delta := NULL; v_mint := NULL; v_diff := NULL;
    v_note := 'no diamond snapshot at or after the window start, so the delta is unknown';
  ELSIF s0.register_supply IS NOT NULL AND s0.fixture_diamonds IS NOT NULL THEN
    v_delta := (v_players - v_fix) - (s0.profile_diamonds - s0.fixture_diamonds);
    v_mint  := (v_reg_players - v_reg_fix) - (s0.register_supply - COALESCE(s0.register_fixture, 0));
    v_diff  := v_delta - v_mint;
    v_note  := 'player balances (fixtures excluded) moved ' || v_delta || ' since the ' || to_char(s0.taken_at AT TIME ZONE 'UTC', 'HH24:MI')
            || ' UTC snapshot; the player register moved ' || v_mint || ' on the same stored figures (no window skew).'
            || ' journal_net over the window is ' || v_jrn || ' (live ' || v_jrn_live || ' + archived ' || v_jrn_archive
            || '), informative: the seed trigger and the Mint house branch write no journal row.';
  ELSIF s0.register_supply IS NOT NULL THEN
    v_delta := v_players - s0.profile_diamonds;
    v_mint  := v_reg_players - s0.register_supply;
    v_diff  := v_delta - v_mint;
    v_note  := 'transitional: the window snapshot stored the register but not the fixture split, so this row includes the certification harness. journal_net ' || v_jrn || ' informative.';
  ELSE
    v_delta := v_players - s0.profile_diamonds;
    SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0) INTO v_mint
      FROM public.ca_mint_ledger ml WHERE ml.asset = 'diamonds' AND ml.holder_type = 'player' AND ml.created_at >= w0 AND ml.created_at < now();
    v_diff := v_delta - v_mint;
    v_note := 'the window snapshot predates register_supply, so the register is windowed by created_at (boundary skew possible). journal_net ' || v_jrn || ' informative.';
  END IF;
  v_tot_now := v_tot_now + v_players; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
  v_tot_jrn := v_tot_jrn + v_jrn; v_tot_mint := v_tot_mint + COALESCE(v_mint, 0);
  RETURN QUERY SELECT 'player_diamonds'::text, v_players, v_delta, v_jrn, v_mint, v_diff, v_note;

  -- fixture_accounts: the certification harness, measured the same way, reported apart.
  IF s0.id IS NOT NULL AND s0.fixture_diamonds IS NOT NULL THEN
    v_delta := v_fix - s0.fixture_diamonds;
    v_mint  := v_reg_fix - COALESCE(s0.register_fixture, 0);
    v_diff  := v_delta - v_mint;
    v_note  := format('%s fixture profiles hold %s. Their balances moved %s and their register moved %s; a non-zero difference is the harness writing profiles.diamonds directly (DR6 at info). Never a player, never a horse.', v_fix_n, v_fix, v_delta, v_mint);
  ELSE
    v_delta := NULL; v_mint := NULL; v_diff := NULL;
    v_note := format('%s fixture profiles hold %s diamonds (inside player_diamonds). No stored fixture figure at the window start yet.', v_fix_n, v_fix);
  END IF;
  RETURN QUERY SELECT 'fixture_accounts'::text, v_fix, v_delta, NULL::numeric, v_mint, v_diff, v_note;

  -- diamond_house
  SELECT COALESCE(SUM(delta), 0) INTO v_house_ledger FROM public.ca_diamond_house_ledger WHERE at >= w0 AND at < now();
  SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0) INTO v_mint
    FROM public.ca_mint_ledger ml WHERE ml.asset = 'diamonds' AND ml.holder_type = 'house' AND ml.created_at >= w0 AND ml.created_at < now();
  IF s0.id IS NOT NULL AND s0.house_balance IS NOT NULL THEN
    v_delta := v_house - s0.house_balance; v_diff := v_delta - v_house_ledger - v_mint;
    v_note := 'house moved ' || v_delta || '; the house ledger (rake, cuts, forfeits) explains ' || v_house_ledger || ' and the Mint explains ' || v_mint || '. DR14: what leaves a player and reaches no player lands here.';
  ELSE
    v_delta := NULL; v_diff := NULL;
    v_note := 'no stored house balance at the window start; ledger ' || v_house_ledger || ', mint ' || v_mint || ' shown.';
  END IF;
  v_tot_now := v_tot_now + v_house; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0); v_tot_mint := v_tot_mint + COALESCE(v_mint, 0);
  RETURN QUERY SELECT 'diamond_house'::text, v_house, v_delta, v_house_ledger, v_mint, v_diff, v_note;

  -- register: the identity over every holder (D9).
  v_reg := public.fn_ca_mint_supply('diamonds');
  RETURN QUERY SELECT 'register'::text, v_reg, NULL::numeric, NULL::numeric, NULL::numeric, (v_players + v_house) - v_reg,
    ('fn_ca_mint_supply(diamonds) over every holder is ' || v_reg || '; players + house is ' || (v_players + v_house)
     || '. Player holders net ' || v_reg_players || ' (fixtures ' || v_reg_fix || '), house holders net ' || v_reg_house
     || ', the rest is the acknowledged pre-standard baseline and its corrections (holder circulation). difference must be 0.')::text;

  -- diamond_debts
  EXECUTE 'SELECT COALESCE(SUM(amount), 0)::numeric FROM public.diamond_debts WHERE settled_at IS NULL' INTO v_sub;
  v_tot_now := v_tot_now + v_sub;
  RETURN QUERY SELECT 'diamond_debts'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    'unsettled chargeback receivable (DR1). A balance is never negative; the remainder lands here.'::text;

  -- promo_budgets_spent
  SELECT COALESCE(SUM(b.spent_diamonds), 0)::numeric, COALESCE(SUM(b.budget_diamonds), 0)::numeric, count(*) INTO v_sub, v_tmp, v_n
    FROM public.diamond_reward_budgets b;
  RETURN QUERY SELECT 'promo_budgets_spent'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    format('%s budget lines, %s budgeted, %s spent by players (fixture issuance excluded since 2026-09-07). A counter, not a balance.', v_n, v_tmp, v_sub);

  -- mirror_mismatch
  SELECT count(*) INTO v_n FROM public.profiles p
    LEFT JOIN public.user_diamonds ud ON ud.user_id = p.id
    LEFT JOIN public.user_diamond_balance udb ON udb.user_id = p.id
    LEFT JOIN public.diamond_wallets dw ON dw.user_id = p.id
   WHERE ud.user_id IS NULL OR udb.user_id IS NULL OR dw.user_id IS NULL
      OR ud.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)
      OR udb.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int
      OR dw.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int;
  RETURN QUERY SELECT 'mirror_mismatch'::text, v_n::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    'COUNT of profiles whose three mirrors disagree or are missing. The mirror trigger upserts all three legs on INSERT and UPDATE (2026-09-07); non-zero means a writer bypassed it.'::text;

  -- dead_stores
  v_sub := 0; v_note := '';
  FOR r IN SELECT * FROM (VALUES ('user_progress', 'diamonds'), ('bot_profiles', 'diamonds'), ('club_members', 'diamonds'),
                                 ('club_memberships', 'diamonds'), ('club_diamond_wallets', 'balance')) AS m(rel, col) LOOP
    BEGIN
      IF to_regclass('public.' || r.rel) IS NULL THEN v_note := v_note || r.rel || ': absent. ';
      ELSE
        EXECUTE format('SELECT COALESCE(SUM(COALESCE(%I, 0)), 0)::numeric FROM public.%I', r.col, r.rel) INTO v_tmp;
        v_sub := v_sub + v_tmp; v_note := v_note || format('%s.%s = %s. ', r.rel, r.col, v_tmp);
      END IF;
    EXCEPTION WHEN OTHERS THEN v_note := v_note || r.rel || ': unreadable. ';
    END;
  END LOOP;
  RETURN QUERY SELECT 'dead_stores'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    (v_note || 'Outside the supply; the delete list, gated on seven days of zero writes (ca_diamond_dead_store_writes).')::text;

  -- suspense (DR12)
  SELECT COALESCE(SUM(dt.amount), 0), count(*) INTO v_sub, v_n FROM public.diamond_transactions dt
   WHERE dt.created_at >= GREATEST(w0, c_foundation) AND (dt.counterparty IS NULL OR dt.counterparty = 'unknown' OR dt.issuance_class IS NULL);
  RETURN QUERY SELECT 'suspense'::text, v_sub, NULL::numeric, v_sub, NULL::numeric, NULL::numeric,
    format('%s journal rows in the window name no counterparty or class. The journal classifier fills both on INSERT since 2026-09-07 and files DR12 naming the writer, so this must read zero.', v_n);

  -- total
  RETURN QUERY SELECT 'total'::text, v_tot_now, CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta END, v_tot_jrn, v_tot_mint,
    CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta - v_tot_mint END,
    'players + house + unsettled debts. difference is player-and-house movement minus register movement (fixtures apart).'::text;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance_watch()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  r record; v_since timestamptz := now() - interval '1 hour';
  v_filed integer := 0; v_rows integer := 0; v_broken text := '';
BEGIN
  FOR r IN SELECT * FROM public.fn_ca_diamond_trial_balance(v_since) LOOP
    v_rows := v_rows + 1;
    IF r.account IN ('player_diamonds', 'diamond_house', 'register') AND r.difference IS NOT NULL AND abs(r.difference) > 0 THEN
      PERFORM public.fn_ca_diamond_incident('DR11:trial_balance_break', 'warning', NULL, r.difference, r.account,
        jsonb_build_object('account', r.account, 'balance_now', r.balance_now, 'balance_delta', r.balance_delta,
                           'journal_net', r.journal_net, 'mint_net', r.mint_net, 'difference', r.difference,
                           'window_start', v_since, 'note', r.note));
      v_filed := v_filed + 1; v_broken := v_broken || r.account || ' ';
    END IF;
    IF r.account = 'fixture_accounts' AND r.difference IS NOT NULL AND abs(r.difference) > 0 THEN
      PERFORM public.fn_ca_diamond_incident('DR6:fixture_harness_unregistered_movement', 'info', NULL, r.difference,
        'fn_ca_diamond_trial_balance_watch',
        jsonb_build_object('balance_delta', r.balance_delta, 'mint_net', r.mint_net, 'window_start', v_since, 'note', r.note));
    END IF;
    IF r.account = 'suspense' AND COALESCE(r.balance_now, 0) <> 0 THEN
      PERFORM public.fn_ca_diamond_incident('DR12:suspense_nonzero', 'info', NULL, r.balance_now, 'fn_ca_diamond_trial_balance_watch',
        jsonb_build_object('suspense', r.balance_now, 'window_start', v_since, 'note', r.note));
      v_filed := v_filed + 1;
    END IF;
  END LOOP;

  PERFORM public.fn_ca_diamond_incident('DR11:trial_balance_summary', 'info', NULL, NULL, 'fn_ca_diamond_trial_balance_watch',
    jsonb_build_object('accounts_reported', v_rows, 'incidents_filed', v_filed, 'accounts_broken', NULLIF(btrim(v_broken), ''),
                       'window_start', v_since, 'window_end', now()));

  UPDATE public.ca_diamond_incidents SET resolved_at = now()
   WHERE resolved_at IS NULL AND severity = 'info' AND occurred_at < now() - interval '7 days';
  DELETE FROM public.ca_diamond_incidents
   WHERE severity = 'info' AND resolved_at IS NOT NULL AND occurred_at < now() - interval '30 days';
  RETURN v_filed;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_diamond_trial_balance_watch failed: %', SQLERRM;
  RETURN -1;
END $function$;

-- Backfill the two stored fixture figures on the snapshot rows written since review fix 1 (there is at
-- most one), so the identity has a basis from the very next run instead of one transitional row.
UPDATE public.ca_diamond_snapshots s
   SET fixture_diamonds = (SELECT COALESCE(sum(p.diamonds), 0) FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id)),
       register_fixture = (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0)
                             FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND public.fn_ca_is_fixture_account(m.holder_id))
 WHERE s.register_supply IS NOT NULL AND s.fixture_diamonds IS NULL AND s.taken_at > now() - interval '30 minutes';

DO $assert$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.fn_ca_diamond_trial_balance(now() - interval '2 hours') t WHERE t.account IN ('fixture_accounts', 'register', 'total');
  IF n <> 3 THEN RAISE EXCEPTION 'assert: trial balance shape'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ca_diamond_snapshots' AND column_name = 'register_fixture') THEN
    RAISE EXCEPTION 'assert: register_fixture column missing';
  END IF;
END $assert$;

COMMIT;
