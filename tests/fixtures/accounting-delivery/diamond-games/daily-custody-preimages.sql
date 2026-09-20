-- Exact installed preimages for the new daily custody migration.
SET check_function_bodies=off;
CREATE OR REPLACE FUNCTION public.fn_ca_arena_diamonds()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody;
$function$
;
REVOKE ALL ON FUNCTION public.fn_ca_arena_diamonds() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_arena_diamonds() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_arena_diamonds() TO service_role;
DO $w$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_arena_diamonds()'::regprocedure))<>'2dc836d3ae2a15e87f85ef35d88de1a5' THEN RAISE EXCEPTION 'Custody fixture preimage differs: public.fn_ca_arena_diamonds()'; END IF; END $w$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_snapshot()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prof numeric; v_wal numeric; v_cert numeric; v_total numeric; v_house numeric; v_arena_now numeric; v_arena_fix numeric;
  v_reg numeric; v_fix numeric; v_reg_fix numeric;
  prev RECORD; v_journal numeric; v_journal_noncert numeric; v_unexplained numeric; v_fix_unexplained numeric;
  v_basis_changed boolean := false;
  v_prev_basis numeric;
  v_mirror_bad bigint := 0;
BEGIN
  -- ONE statement, ONE snapshot (2026-09-07 review fix 4): the meter, the mirror, the fixture share,
  -- the house and the register are read together, so a signup committing between two reads cannot
  -- show as a 500 drift for one run.
  SELECT (SELECT COALESCE(sum(diamonds),0) FROM public.profiles),
         (SELECT COALESCE(sum(balance),0) FROM public.diamond_wallets),
         (SELECT COALESCE(sum(p.diamonds),0) FROM public.profiles p WHERE public.fn_ca_is_cert_account(p.id)),
         (SELECT COALESCE(sum(p.diamonds),0) FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id)),
         (SELECT COALESCE(balance, 0) FROM public.ca_diamond_house WHERE id = 1),
         (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
            FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player'),
         (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0)
            FROM public.ca_mint_ledger m
           WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND public.fn_ca_is_fixture_account(m.holder_id))
    , public.fn_ca_arena_diamonds(),
         (SELECT COALESCE(sum(balance),0) FROM public.poker_diamond_custody WHERE public.fn_ca_is_fixture_account(user_id))
    INTO v_prof, v_wal, v_cert, v_fix, v_house, v_reg, v_reg_fix, v_arena_now, v_arena_fix;
  v_house := COALESCE(v_house, 0);

  -- The basis is what players hold PLUS what they have parked on the arena felt. Both sides of
  -- the comparison below use the same basis, so a deposit nets to zero and the deploy gate keeps
  -- meaning "diamonds appeared or vanished" rather than "diamonds moved" (2026-09-08).
  -- Custody was read in the same SQL snapshot as player balances.
  v_total := v_prof + v_arena_now;

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
    v_prev_basis := prev.profile_diamonds + COALESCE(prev.arena_diamonds, 0);
  END IF;

  -- The player identity, on stored figures, fixtures apart (2026-09-07 review fix 2):
  --   unexplained = (players - fixtures) moved - (player register - fixture register) moved.
  -- The fixture share is measured the same way and reported as its own drift class, because the
  -- certification harness writes fixture balances directly (a harness defect, DR6 at info), and a
  -- harness defect must never arm the deploy gate that protects players.
  IF prev.id IS NOT NULL AND prev.register_supply IS NOT NULL AND prev.fixture_diamonds IS NOT NULL THEN
    v_unexplained     := ((v_total - v_fix - v_arena_fix) - (v_prev_basis - prev.fixture_diamonds - COALESCE(prev.arena_fixture_diamonds,0)))
                       - ((v_reg - v_reg_fix) - (prev.register_supply - COALESCE(prev.register_fixture, 0)));
    v_fix_unexplained := (v_fix + v_arena_fix - prev.fixture_diamonds - COALESCE(prev.arena_fixture_diamonds,0)) - (v_reg_fix - COALESCE(prev.register_fixture, 0));
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
    (arena_diamonds, profile_diamonds, wallet_diamonds, cert_diamonds, total, journaled_delta, delta_vs_prev, unexplained,
     register_supply, house_balance, fixture_diamonds, register_fixture, arena_fixture_diamonds)
  VALUES
    (v_arena_now, v_prof, v_wal, v_cert, v_total, v_journal,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - v_prev_basis END,
     v_unexplained, v_reg, v_house, v_fix, v_reg_fix, v_arena_fix);

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
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_snapshot() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_snapshot() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_snapshot() TO service_role;
DO $w$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_diamond_snapshot()'::regprocedure))<>'cd69f0dbdb7ead363220d4bc54c4277c' THEN RAISE EXCEPTION 'Custody fixture preimage differs: public.fn_ca_diamond_snapshot()'; END IF; END $w$;
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance(p_since timestamp with time zone DEFAULT (now() - '01:15:00'::interval))
 RETURNS TABLE(account text, balance_now numeric, balance_delta numeric, journal_net numeric, mint_net numeric, difference numeric, note text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_arena numeric; v_arena_fix numeric;
  v_tot_now numeric := 0; v_tot_delta numeric := 0; v_tot_jrn numeric := 0; v_tot_mint numeric := 0;
  r record;
BEGIN
  SELECT * INTO s0 FROM public.ca_diamond_snapshots WHERE taken_at >= v_since ORDER BY taken_at ASC LIMIT 1;
  w0 := COALESCE(s0.taken_at, v_since);

  -- ONE statement, ONE snapshot (2026-09-07 review fix 4), so a signup committing between two reads
  -- cannot show as a 500 break for one run.
  SELECT (SELECT COALESCE(SUM(COALESCE(p.diamonds, 0)), 0)::numeric FROM public.profiles p),
         (SELECT COALESCE(SUM(p.diamonds), 0) FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id)),
         (SELECT count(*) FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id)),
         (SELECT COALESCE(balance, 0) FROM public.ca_diamond_house WHERE id = 1),
         (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
            FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player'),
         (SELECT COALESCE(SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END), 0)
            FROM public.ca_mint_ledger m WHERE m.asset = 'diamonds' AND m.holder_type = 'player' AND public.fn_ca_is_fixture_account(m.holder_id)),
         (SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
            FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'house'),
         public.fn_ca_mint_supply('diamonds'), public.fn_ca_arena_diamonds(),
         (SELECT COALESCE(sum(balance),0) FROM public.poker_diamond_custody WHERE public.fn_ca_is_fixture_account(user_id))
    INTO v_players, v_fix, v_fix_n, v_house, v_reg_players, v_reg_fix, v_reg_house, v_reg, v_arena, v_arena_fix;
  v_house := COALESCE(v_house, 0);

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
    v_diff  := v_delta - v_mint + (v_arena - v_arena_fix - COALESCE(s0.arena_diamonds,0) + COALESCE(s0.arena_fixture_diamonds,0));
    v_note  := 'player balances (fixtures excluded) moved ' || v_delta || ' since the ' || to_char(s0.taken_at AT TIME ZONE 'UTC', 'HH24:MI')
            || ' UTC snapshot; the player register moved ' || v_mint || ' on the same stored figures (no window skew).'
            || ' journal_net over the window is ' || v_jrn || ' (live ' || v_jrn_live || ' + archived ' || v_jrn_archive
            || '), informative: the seed trigger and the Mint house branch write no journal row.';
  ELSIF s0.register_supply IS NOT NULL THEN
    v_delta := v_players - s0.profile_diamonds;
    v_mint  := v_reg_players - s0.register_supply;
    v_diff  := v_delta - v_mint + (v_arena - COALESCE(s0.arena_diamonds,0));
    v_note  := 'transitional: the window snapshot stored the register but not the fixture split, so this row includes the certification harness. journal_net ' || v_jrn || ' informative.';
  ELSE
    v_delta := v_players - s0.profile_diamonds;
    SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0) INTO v_mint
      FROM public.ca_mint_ledger ml WHERE ml.asset = 'diamonds' AND ml.holder_type = 'player' AND ml.created_at >= w0 AND ml.created_at < now();
    v_diff := v_delta - v_mint + (v_arena - COALESCE(s0.arena_diamonds,0));
    v_note := 'the window snapshot predates register_supply, so the register is windowed by created_at (boundary skew possible). journal_net ' || v_jrn || ' informative.';
  END IF;
  -- balance_now must be the SAME population balance_delta is measured on, or adding this row
  -- to fixture_accounts double counts the harness (found by the verification pass, 2026-09-08).
  DECLARE v_players_shown numeric := CASE
    WHEN s0.id IS NOT NULL AND s0.register_supply IS NOT NULL AND s0.fixture_diamonds IS NOT NULL
    THEN v_players - v_fix ELSE v_players END;
  BEGIN
    v_tot_now := v_tot_now + v_players_shown; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
    v_tot_jrn := v_tot_jrn + v_jrn; v_tot_mint := v_tot_mint + COALESCE(v_mint, 0);
    RETURN QUERY SELECT 'player_diamonds'::text, v_players_shown, v_delta, v_jrn, v_mint, v_diff,
      (v_note || CASE WHEN v_players_shown <> v_players
                      THEN ' balance_now is players WITHOUT the harness (' || v_fix || ' shown on the fixture_accounts row), so the two rows add up.'
                      ELSE '' END)::text;
  END;

  -- fixture_accounts: the certification harness, measured the same way, reported apart.
  IF s0.id IS NOT NULL AND s0.fixture_diamonds IS NOT NULL THEN
    v_delta := v_fix - s0.fixture_diamonds;
    v_mint  := v_reg_fix - COALESCE(s0.register_fixture, 0);
    v_diff  := v_delta - v_mint + (v_arena_fix - COALESCE(s0.arena_fixture_diamonds,0));
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

  -- arena_wallets: diamonds a player has deposited onto the platform club's felt. Still theirs,
  -- still in the supply, and in neither profiles nor the house - so the identity below has to
  -- count them or a deposit reads as a break (2026-09-08).
  -- Custody was read with balances and register above.
  IF s0.id IS NOT NULL AND s0.arena_diamonds IS NOT NULL THEN
    v_delta := v_arena - s0.arena_diamonds;
  ELSE
    v_delta := NULL;
  END IF;
  v_tot_now := v_tot_now + v_arena; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
  RETURN QUERY SELECT 'arena_wallets'::text, v_arena, v_delta, NULL::numeric, NULL::numeric, NULL::numeric,
    ('diamonds on the Diamond Arena felt (dedicated diamond custody). A deposit moves them out of '
     || 'profiles.diamonds without changing the supply, so they are counted here and in the register '
     || 'identity below. The Mint issues nothing for a deposit and retires nothing for a withdrawal.')::text;

  -- register: the identity over every holder (D9), read in the same snapshot as the balances.
  RETURN QUERY SELECT 'register'::text, v_reg, NULL::numeric, NULL::numeric, NULL::numeric, (v_players + v_house + v_arena) - v_reg,
    ('fn_ca_mint_supply(diamonds) over every holder is ' || v_reg || '; players + house + arena is ' || (v_players + v_house + v_arena)
     || '. Player holders net ' || v_reg_players || ' (fixtures ' || v_reg_fix || '), house holders net ' || v_reg_house
     || ', the rest is the acknowledged pre-standard baseline and its corrections (holder circulation). difference must be 0.')::text;

  -- diamond_debts
  EXECUTE 'SELECT COALESCE(SUM(amount), 0)::numeric FROM public.diamond_debts WHERE settled_at IS NULL' INTO v_sub;
  v_tot_now := v_tot_now + v_sub;
  RETURN QUERY SELECT 'diamond_debts'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    'unsettled chargeback receivable (DR1). A balance is never negative; the remainder lands here.'::text;

  -- promo_budgets_spent
  SELECT COALESCE(SUM(public.fn_ca_diamond_engine_spent(b.period, b.engine)), 0)::numeric, COALESCE(SUM(b.budget_diamonds), 0)::numeric, count(*) INTO v_sub, v_tmp, v_n
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
      ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns c
                         WHERE c.table_schema = 'public' AND c.table_name = r.rel AND c.column_name = r.col) THEN
        -- Dropped on purpose (20260908033824), which is not the same thing as a query that
        -- broke. This line exists to tell those two apart, so it has to say which one it is.
        v_note := v_note || format('%s.%s: dropped. ', r.rel, r.col);
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
    'players + custody + house + unsettled debts. difference is player-and-house movement minus register movement (fixtures apart).'::text;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_trial_balance(timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance(timestamp with time zone) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance(timestamp with time zone) TO service_role;
DO $w$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_diamond_trial_balance(timestamp with time zone)'::regprocedure))<>'52bc0ea036ad5dcbc2662376c2dfefff' THEN RAISE EXCEPTION 'Custody fixture preimage differs: public.fn_ca_diamond_trial_balance(timestamp with time zone)'; END IF; END $w$;
CREATE OR REPLACE FUNCTION public.fn_diamond_game_take_bet(p_user uuid, p_bet integer, p_purchased_only boolean, p_type text, p_description text, p_reference text, p_meta jsonb, p_owner uuid, p_owner_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_deduct jsonb; v_credit jsonb; v_remaining integer; v_take integer; v_lot record;
BEGIN
  p_bet:=public.fn_wheel_bonus_player_debit(p_bet);
  IF p_bet=0 THEN RETURN jsonb_build_object('success',true,'funded_by_wheel',true); END IF;
  -- THE BET GOES TO THE HOST'S OWNER (Dan 2026-09-10: "all diamonds 'taken in' get
  -- credited to the union owners wallet, or the club owners wallet"). Two legs, one
  -- transaction, both transfers: the player's diamonds leave as a transfer to the owner
  -- (source diamond_game, the recipient in the metadata), and the owner's wallet takes
  -- them as a transfer. Nothing is retired and nothing is minted.
  IF p_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'This Host Has No Owner Wallet To Pay');
  END IF;
  v_deduct := public.deduct_diamonds(p_user, p_bet, p_description, p_type, 'diamond_game',
                p_meta || jsonb_build_object('recipient_id', p_owner, 'bet_type', p_type), p_reference, 0);
  IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
    RETURN v_deduct;
  END IF;
  IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
    RETURN v_deduct;
  END IF;
  IF p_purchased_only THEN
    v_remaining := p_bet;
    FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                  WHERE l.user_id = p_user AND l.frozen_at IS NULL
                    AND (l.issued - l.consumed - l.refunded) > 0
                  ORDER BY l.created_at, l.id FOR UPDATE LOOP
      EXIT WHEN v_remaining <= 0;
      v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
      UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
      v_remaining := v_remaining - v_take;
    END LOOP;
    IF v_remaining > 0 THEN
      RAISE EXCEPTION 'diamond games: purchased lots could not cover the bet (% short) after the availability check passed', v_remaining;
    END IF;
  END IF;
  v_credit := public.add_diamonds_to_balance(p_owner, p_bet, 'transfer', p_owner_note, p_reference || ':intake', p_user);
  IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
    RAISE EXCEPTION 'diamond games: the bet could not be credited to the host owner (%): %', p_reference, v_credit->>'error';
  END IF;
  RETURN v_deduct || jsonb_build_object('owner_id', p_owner, 'owner_balance', v_credit->'new_balance');
END $function$
;
REVOKE ALL ON FUNCTION public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text) TO service_role;
DO $w$ BEGIN IF md5(pg_get_functiondef('public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text)'::regprocedure))<>'4ea1b34c9b4cf97c9d69ab5669ee0bb7' THEN RAISE EXCEPTION 'Custody fixture preimage differs: public.fn_diamond_game_take_bet(uuid,integer,boolean,text,text,text,jsonb,uuid,text)'; END IF; END $w$;
CREATE OR REPLACE FUNCTION public.fn_wheel_spin_v2(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_entry_diamonds integer, p_mode text DEFAULT 'paid'::text, p_bonus_ticket_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  c_two48 constant numeric := 281474976710656;   -- 2^48
  p_welcome boolean:=p_mode='welcome';
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  cm public.wheel_seed_commits%ROWTYPE;
  prior public.wheel_spins%ROWTYPE;
  a record;
  v_rate integer := public.fn_ca_bridge_rate();
  v_price integer; v_mult integer; v_intake numeric;
  v_dia_now numeric; v_intake_chips numeric;
  v_owner uuid; v_owner_dia numeric;
  v_bank numeric; v_bank_after numeric;
  v_promo numeric; v_bank_only numeric; v_pay record;
  v_client text := left(btrim(COALESCE(p_client_seed, '')), 64);
  v_nonce bigint; v_hmac bytea; v_roll numeric; v_point numeric;
  v_total integer := 0; v_acc integer := 0;
  v_eligible smallint[] := '{}'; v_locked jsonb := '[]'::jsonb;
  seg record; v_pick record; v_found boolean := false;
  v_value_chips numeric := 0; v_prize_chips numeric := 0; v_prize_dia integer := 0;
  v_today integer; v_last timestamptz;
  v_spendable integer; v_diamonds numeric; v_purchased integer;
  v_lot record; v_remaining integer; v_take integer;
  v_deduct jsonb; v_credit jsonb;
  v_member_after numeric; v_dia_after numeric;
  v_spin_id uuid := gen_random_uuid();
  v_is_fixture boolean := false;
  v_result jsonb;
  v_ticket public.diamond_bonus_spin_tickets;
  -- The welcome budget is a window, not a lifetime total, and a welcome spin is
  -- the whole wheel or it is not offered. Both figures are measured once, up
  -- front, under the config lock that serialises every spin on this host.
  v_welcome_spent numeric := 0; v_welcome_top numeric := 0;
  v_gcfg public.diamond_game_configs; v_gpool public.diamond_game_pools; v_caps jsonb:='{}';
  v_boost integer; v_budget integer; v_cap integer; v_hold numeric; v_reserved numeric;
  v_game text; v_award public.wheel_bonus_awards; v_secondary jsonb; v_secondary_segments jsonb; v_segments jsonb;
  v_second_hmac bytea; v_second_roll numeric; v_second_ord integer; v_outcome jsonb;
  v_second_point numeric; v_second_acc integer:=0; v_second_outcome jsonb;
  v_prize_multiplier numeric; v_prize_label text;
  v_feature text; v_cost integer:=0; v_unit integer; v_uses integer; v_remainder integer; v_grants jsonb:='[]';

BEGIN
  IF p_mode IS NULL OR p_mode NOT IN('paid','welcome','daily') OR p_entry_diamonds IS NULL OR p_entry_diamonds NOT BETWEEN 25 AND 2500
   OR (p_mode<>'paid' AND p_entry_diamonds<>100) OR (p_mode='daily')<>(p_bonus_ticket_id IS NOT NULL)
   OR p_commit_id IS NULL OR p_client_seed IS NULL OR length(p_client_seed) NOT BETWEEN 1 AND 64 OR p_client_seed<>btrim(p_client_seed) THEN
   RETURN jsonb_build_object('ok',false,'error','Choose A Valid Diamond Spins Entry'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_commit_id::text,94613));
  -- ── who and where ──────────────────────────────────────────────────────────
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set');
  END IF;
  IF length(v_client) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required');
  END IF;

  -- ── replay: a commit is spent once; the second call returns the first spin ─
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Spin Belongs To Another Player');
    END IF;
    IF prior.receipt_v2 IS NULL OR (prior.receipt_v2->>'entry_value_diamonds')::integer IS DISTINCT FROM p_entry_diamonds OR prior.club_id IS DISTINCT FROM p_club_id OR prior.client_seed IS DISTINCT FROM v_client
       OR prior.is_welcome IS DISTINCT FROM p_welcome OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  IF NOT public.fn_wheel_v2_enabled() THEN RETURN jsonb_build_object('ok',false,'error','The New Wheel Is Not Open Yet'); END IF;

  IF p_bonus_ticket_id IS NOT NULL THEN
    IF p_welcome THEN RETURN jsonb_build_object('ok',false,'error','Choose One Free Spin Reward'); END IF;
    SELECT * INTO v_ticket FROM public.diamond_bonus_spin_tickets WHERE id=p_bonus_ticket_id FOR UPDATE;
    IF v_ticket.id IS NULL OR v_ticket.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok',false,'error','Claim This Bonus Spin In Daily Bonus First');
    END IF;
    IF v_ticket.redeemed_spin_id IS NOT NULL THEN
      SELECT * INTO prior FROM public.wheel_spins WHERE id=v_ticket.redeemed_spin_id;
      IF prior.user_id=v_user AND prior.club_id=p_club_id AND prior.commit_id=p_commit_id
         AND prior.client_seed=v_client AND prior.bonus_ticket_id=p_bonus_ticket_id AND NOT prior.is_welcome THEN
        RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
      END IF;
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
    IF v_ticket.funded_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
  END IF;

  IF p_bonus_ticket_id IS NOT NULL THEN
    -- Match the canonical Mint's lock order before taking host/owner rows.
    PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:diamonds'));
  END IF;

  -- ── the freeze and the kill switch, before any money moves ─────────────────
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Spin Again In A Few Minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Paused');
  END IF;

  -- ── the host, its table, its pool: one lock serialises every spin on it ────
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id=p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.receipt_v2 IS NULL OR (prior.receipt_v2->>'entry_value_diamonds')::integer IS DISTINCT FROM p_entry_diamonds OR prior.user_id IS DISTINCT FROM v_user OR prior.club_id IS DISTINCT FROM p_club_id
       OR prior.client_seed IS DISTINCT FROM v_client OR prior.is_welcome IS DISTINCT FROM p_welcome
       OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
  END IF;
  IF cfg.host_id IS NULL OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Not Open Here');
  END IF;
  INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host FOR UPDATE;

  IF (SELECT sum(weight) FROM public.fn_wheel_v3_model())<>100000 OR (SELECT count(*) FROM public.fn_wheel_v3_model())<>12 THEN
   RAISE EXCEPTION 'The Wheel Model Is Invalid'; END IF;
  v_mult:=1; v_price:=p_entry_diamonds;
  v_segments:=public.fn_wheel_v3_segments(v_price,v_rate);
  v_intake := v_price::numeric / v_rate;
  -- THE HOST IS THE HOUSE (Dan 2026-09-10). Nothing is minted: the whole price
  -- is taken in by the host's owner, and the prize is paid out of what the host
  -- holds. The chip side is bounded by the chips this wheel has taken in (this
  -- spin included) plus the host's allowance; the diamond side by the diamonds
  -- it has taken in plus the seed the host put up. Both are "never more than
  -- taken in", stated on the money that actually moved.
  -- A WELCOME SPIN TAKES NOTHING IN (Dan 2026-09-10: the owner "simply receives
  -- no diamonds"). So it adds nothing to the float and nothing to the intake the
  -- paid game's invariant is stated on; its payout is charged to the welcome
  -- budget instead, a few lines below.
  v_dia_now      := CASE WHEN p_welcome THEN 0 ELSE v_price END;
  v_intake_chips := round((pool.intake_diamonds + v_dia_now)::numeric / v_rate, 2);
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'This Host Has No Owner Wallet To Pay');
  END IF;

  IF NOT public.fn_diamond_spins_owner_agreed(v_host,v_kind) THEN
   RETURN jsonb_build_object('ok',false,'error','The Host Wallet Owner Must Accept Diamond Spins Before Play Opens'); END IF;
  -- ── the player: member, not a fixture, inside the limits, able to pay ──────
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Join The Club Before You Spin');
  END IF;
  v_is_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF v_is_fixture AND NOT cfg.allow_fixture_accounts THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Spin This Wheel');
  END IF;

  -- ── the welcome spin: once per member, ever, and only out of a real budget ─
  IF p_welcome THEN
    IF NOT cfg.welcome_spin_enabled THEN
      RETURN jsonb_build_object('ok', false, 'error', 'There Is No Welcome Spin Here');
    END IF;
    IF COALESCE(cfg.welcome_budget_chips, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spin Is Not Funded Here Yet');
    END IF;
    IF v_user = v_owner THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Host Does Not Take Its Own Welcome Spin');
    END IF;
    -- The unique index is what actually enforces this; the check is here to
    -- answer the player in words rather than with a constraint violation.
    IF EXISTS (SELECT 1 FROM public.wheel_spins s
                WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'You Have Already Taken Your Welcome Spin Here');
    END IF;
    -- A WELCOME SPIN IS THE WHOLE WHEEL OR IT IS NOT OFFERED (2026-09-11).
    -- The budget used to be checked tier by tier, so as the spend approached it
    -- the top prizes locked one after another and the last new members to
    -- arrive were handed a visibly worse wheel than the first ones. A gift that
    -- gets meaner the longer you take to join is not the gift Dan described.
    -- So the budget is asked ONE question before anything is offered: can it
    -- still cover the biggest prize on this table? If it can, every tier is
    -- live. If it cannot, there is no welcome spin here until the window turns.
    -- ONE DEFINITION OF THE QUESTION (2026-09-11). The door, the page and the
    -- entry read all asked it, and the entry read asked a DIFFERENT one, so a
    -- player could be told "Welcome Spin Ready" and then be refused by the
    -- door. There is one helper now and three callers.
    v_welcome_spent:=public.fn_wheel_v2_welcome_spent(v_host);
  END IF;
  SELECT * INTO cm FROM public.wheel_seed_commits
   WHERE id = p_commit_id AND user_id = v_user AND consumed_by IS NULL FOR UPDATE;
  IF cm.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again');
  END IF;
  IF cm.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Expired. Open The Wheel Again');
  END IF;
  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_today >= cfg.max_spins_per_player_per_day THEN
    RETURN jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Spins', cfg.max_spins_per_player_per_day));
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'One Moment Between Spins');
  END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;
  IF NOT p_welcome AND p_bonus_ticket_id IS NULL AND v_spendable < v_price THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN cfg.purchased_only AND v_diamonds >= v_price
                    THEN 'This Wheel Spins Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For A Spin' END,
      'diamonds', v_diamonds, 'spendable', v_spendable, 'spin_price_diamonds', v_price);
  END IF;

  -- ── the host's cover and its owner's diamonds, locked ─────────────────────
  -- The promo wallet pays first and the host's own chip bank stands behind it
  -- (Dan 2026-09-10). v_bank is the two together: what a prize may draw on.
  -- Take game configuration and pools before the shared host wallet, matching game entry.
  PERFORM 1 FROM public.diamond_game_configs WHERE host_id=v_host ORDER BY game FOR UPDATE;
  PERFORM 1 FROM public.diamond_game_pools WHERE host_id=v_host ORDER BY game FOR UPDATE;
  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_promo, v_bank_only, v_bank
    FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;

  SELECT COALESCE(sum(reserved_chips),0) INTO v_reserved FROM public.diamond_game_pools WHERE host_id=v_host;
  IF v_bank-v_reserved < ceil(v_price::numeric/v_rate*100*100)/100 OR v_owner_dia+v_dia_now<ceil(v_price*.5) OR (NOT p_welcome AND pool.diamond_float+v_dia_now<ceil(v_price*.5)) THEN
   RETURN jsonb_build_object('ok',false,'error','The Host Must Fund Every Prize Before A Spin'); END IF;
  IF p_welcome AND cfg.welcome_budget_chips-v_welcome_spent<100*v_price::numeric/v_rate THEN
   RETURN jsonb_build_object('ok',false,'error','The Welcome Spins Here Are Gone For Now'); END IF;
  -- Fixed odds require the entire 100x secondary prize to fit the configured
  -- exposure policy before reading the seed. Never silently remove a prize.
  IF NOT p_welcome AND pool.chips_paid+ceil(100*v_price::numeric/v_rate*100)/100>v_intake_chips+cfg.exposure_allowance_chips THEN
   RETURN jsonb_build_object('ok',false,'error','The Host Must Fund Every Prize Before A Spin'); END IF;
  IF (SELECT count(*) FROM public.fn_wheel_v3_upgrade_model())<>8 OR (SELECT sum(weight) FROM public.fn_wheel_v3_upgrade_model())<>100000 THEN
   RAISE EXCEPTION 'The Upgrade Model Is Invalid'; END IF;
  -- Every possible game/upgrade is admitted before looking at the random seed.
  -- All game locks use the same order; one admitted outcome reserves its promise.
  FOR v_game IN SELECT unnest(ARRAY['crash','crossing','mines','plinko']) LOOP
   SELECT * INTO v_gcfg FROM public.diamond_game_configs WHERE host_id=v_host AND game=v_game FOR UPDATE;
   IF NOT FOUND OR NOT v_gcfg.enabled OR (v_is_fixture AND NOT v_gcfg.allow_fixture_accounts) OR EXISTS(SELECT 1 FROM public.ca_payout_freeze WHERE scope=v_game AND cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'error','Every Bonus Game Must Be Open Before A Spin'); END IF;
   INSERT INTO public.diamond_game_pools(host_id,game) VALUES(v_host,v_game) ON CONFLICT DO NOTHING;
   SELECT * INTO v_gpool FROM public.diamond_game_pools WHERE host_id=v_host AND game=v_game FOR UPDATE;
   FOR v_boost IN 1..2 LOOP
    v_budget:=v_price*v_boost;
    v_cap:=public.fn_diamond_game_cap_cents(v_gcfg,v_gpool,v_bank,v_budget::numeric/v_rate,v_gcfg.max_multiplier_cents);
    IF p_welcome THEN v_cap:=LEAST(v_cap,floor((cfg.welcome_budget_chips-v_welcome_spent)/(v_budget::numeric/v_rate)*100)::integer); END IF;
    -- Steady20x covers base plus one original entry:40x ordinary,30x upgraded.
    IF v_cap<2000*(v_boost+1)/v_boost THEN RETURN jsonb_build_object('ok',false,'error','The Host Must Fund Every Bonus Before A Spin'); END IF;
    v_caps:=jsonb_set(v_caps,ARRAY[v_game||':'||v_boost],to_jsonb(v_cap));
   END LOOP;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.plinko_tables WHERE activated_at IS NOT NULL AND max_multiplier_cents<=2000) THEN
   RETURN jsonb_build_object('ok',false,'error','An Approved Plinko Table Must Be Open Before A Spin'); END IF;
  IF EXISTS(SELECT 1 FROM (VALUES('throwable',1),('rabbit_hunt',5),('time_bank_seconds',5)) expected(feature,cost)
    LEFT JOIN public.feature_pricing actual ON actual.feature=expected.feature
    WHERE actual.feature IS NULL OR actual.diamond_cost<>expected.cost OR actual.usage_type<>'per_use') THEN
   RETURN jsonb_build_object('ok',false,'error','The Reward Prices Changed. The Wheel Must Be Requalified'); END IF;
  SELECT count(*)+1 INTO v_nonce FROM public.wheel_spins WHERE user_id=v_user;
  v_hmac:=extensions.hmac(convert_to('wheel-v3:'||v_client||':'||v_nonce,'UTF8'),convert_to(cm.server_seed,'UTF8'),'sha256');
  v_roll:=(('x'||encode(substring(v_hmac from 1 for 6),'hex'))::bit(48)::bigint)::numeric;
  v_total:=100000; v_eligible:=ARRAY[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[];
  v_point:=floor(v_roll*v_total/c_two48);
  FOR seg IN SELECT * FROM public.fn_wheel_v3_model() ORDER BY ord LOOP
   v_acc:=v_acc+seg.weight;
   IF v_point<v_acc THEN v_pick:=seg;v_found:=true;EXIT;END IF;
  END LOOP;
  IF NOT v_found THEN RAISE EXCEPTION 'The Wheel Draw Is Invalid'; END IF;
  SELECT value INTO v_outcome FROM jsonb_array_elements(v_segments) WHERE (value->>'ord')::integer=v_pick.ord;
  IF v_pick.kind='upgrade' THEN
   v_secondary_segments:=public.fn_wheel_v3_segments(v_price,v_rate,true);
   v_second_hmac:=extensions.hmac(convert_to('wheel-v3-upgrade:'||v_client||':'||v_nonce,'UTF8'),convert_to(cm.server_seed,'UTF8'),'sha256');
   v_second_roll:=(('x'||encode(substring(v_second_hmac from 1 for 6),'hex'))::bit(48)::bigint)::numeric;
   v_second_point:=floor(v_second_roll*100000/c_two48);
   FOR seg IN SELECT * FROM public.fn_wheel_v3_upgrade_model() ORDER BY ord LOOP
    v_second_acc:=v_second_acc+seg.weight;
    IF v_second_point<v_second_acc THEN v_second_ord:=seg.ord;EXIT;END IF;
   END LOOP;
   IF v_second_ord IS NULL THEN RAISE EXCEPTION 'The Upgrade Draw Is Invalid'; END IF;
   v_second_outcome:=v_secondary_segments->(v_second_ord-1);
   IF v_second_outcome->>'kind'='bonus' THEN v_game:=v_second_outcome->>'game';
   ELSE v_prize_multiplier:=(v_second_outcome->>'multiplier')::numeric;v_prize_label:=v_second_outcome->>'label'; END IF;
   v_secondary:=jsonb_build_object('segments',v_secondary_segments,'outcome',v_secondary_segments->(v_second_ord-1),
    'fairness',jsonb_build_object('commit_id',p_commit_id,'server_seed_hash',cm.server_seed_hash,'server_seed',cm.server_seed,'client_seed',v_client,'nonce',v_nonce,'roll',v_second_roll,'weight_total',100000,'eligible_ords',jsonb_build_array(1,2,3,4,5,6,7,8),'locked','[]'::jsonb,'domain','wheel-v3-upgrade'));
  ELSIF v_pick.kind='bonus' THEN v_game:=v_pick.game;
  ELSIF v_pick.kind='chips' THEN v_prize_multiplier:=v_pick.multiplier;v_prize_label:=v_pick.label; END IF;

  -- ── 1. the spin is paid for, unless it is the welcome ─────────────────────
  -- THE OWNER SIMPLY RECEIVES NO DIAMONDS (Dan 2026-09-10). Not a refund, not a
  -- credit and back out again: on a welcome spin no diamond moves anywhere. The
  -- player pays nothing, the owner takes nothing, and what the host gives up is
  -- exactly the spin price it would have been paid.
  IF p_bonus_ticket_id IS NOT NULL THEN
    BEGIN
      UPDATE public.diamond_bonus_spin_tickets SET club_id=p_club_id,host_id=v_host,host_kind=v_kind,
        owner_id=v_owner,commit_id=p_commit_id,client_seed=v_client,
        funded_at=transaction_timestamp(),mint_op_id='daily-bonus-spin:'||p_bonus_ticket_id::text
       WHERE id=p_bonus_ticket_id RETURNING * INTO v_ticket;
    EXCEPTION WHEN SQLSTATE 'PDS01' THEN
      RETURN jsonb_build_object('ok',false,'error',SQLERRM);
    END;
  ELSIF NOT p_welcome THEN
    v_deduct := public.deduct_diamonds(
      v_user, v_price,
      format('Diamond Wheel Spin (%s Diamonds)', v_price),
      'wheel_spin', 'wheel_spin',
      jsonb_build_object('spin_id', v_spin_id, 'club_id', p_club_id, 'host_id', v_host,
                         'commit_id', p_commit_id, 'segment_version', cfg.segment_version,
                         'recipient_id', v_owner),
      'wheel:' || v_spin_id::text, 0);
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For A Spin',
                                'detail', v_deduct->>'error');
    END IF;
    -- The intake is the host owner's (Dan 2026-09-10): a transfer, not an issuance.
    v_credit := public.add_diamonds_to_balance(v_owner, v_price, 'transfer',
                  format('Diamond Wheel Intake (%s Diamonds)', v_price), 'wheel:' || v_spin_id::text || ':intake', v_user);
    IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the spin price could not be credited to the host owner: %', v_credit->>'error';
    END IF;
    IF cfg.purchased_only THEN
      v_remaining := v_price;
      FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                    WHERE l.user_id = v_user AND l.frozen_at IS NULL
                      AND (l.issued - l.consumed - l.refunded) > 0
                    ORDER BY l.created_at, l.id FOR UPDATE LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
        UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
        v_remaining := v_remaining - v_take;
      END LOOP;
      IF v_remaining > 0 THEN
        RAISE EXCEPTION 'fn_wheel_spin_core: purchased lots could not cover the spin (% short) after the availability check passed', v_remaining;
      END IF;
    END IF;
  END IF;

  IF v_prize_multiplier IS NOT NULL THEN
   v_prize_chips:=public.fn_diamond_round_chip_cents(v_price::numeric*v_prize_multiplier/v_rate,cm.server_seed,'wheel-v3-rounding:'||v_client||':'||v_nonce);
   v_value_chips:=v_prize_chips;
   SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips('wheel_prize',v_host,v_kind,p_club_id,v_user,v_prize_chips,
    'wheel-prize:'||v_spin_id,'Diamond Spins: '||v_prize_label,jsonb_build_object('spin_id',v_spin_id,'host_id',v_host,'host_kind',v_kind,'welcome',p_welcome,'bonus_ticket_id',p_bonus_ticket_id,'contract_version',3,'multiplier',v_prize_multiplier,'secondary_ord',v_second_ord));
   v_member_after:=v_pay.member_after;
   IF v_pick.kind='chips' THEN v_outcome:=v_outcome||jsonb_build_object('amount',v_prize_chips,'value_chips',v_prize_chips);
   ELSE v_secondary:=jsonb_set(v_secondary,'{outcome}',v_second_outcome||jsonb_build_object('amount',v_prize_chips,'value_chips',v_prize_chips)); END IF;
  ELSIF v_pick.kind='diamonds' THEN
   v_prize_dia:=(public.fn_diamond_round_chip_cents(v_price*.5/100,cm.server_seed,'wheel-v3-diamonds:'||v_client||':'||v_nonce)*100)::integer; v_value_chips:=v_prize_dia::numeric/v_rate;
   PERFORM public.fn_diamond_game_pay_diamonds(v_owner,v_user,v_prize_dia,'Diamond Spins: Diamonds','wheel:'||v_spin_id||':prize');
   v_outcome:=v_outcome||jsonb_build_object('amount',v_prize_dia,'value_chips',v_value_chips);
  ELSIF v_pick.kind IN('throwables','time_bank','rabbit_hunt') THEN
   v_feature:=CASE v_pick.kind WHEN 'throwables' THEN 'throwable' WHEN 'time_bank' THEN 'time_bank_seconds' ELSE 'rabbit_hunt' END;
   v_cost:=(public.fn_diamond_round_chip_cents(v_price*.5/100,cm.server_seed,'wheel-v3-consumable:'||v_client||':'||v_nonce)*100)::integer;
   SELECT diamond_cost INTO v_unit FROM public.feature_pricing WHERE feature=v_feature;
   v_uses:=v_cost/v_unit;v_remainder:=v_cost%v_unit;
   v_deduct:=public.add_diamonds_to_balance(v_owner,-v_cost,'deduction',
    'Diamond Spins: '||v_pick.label||' for '||v_user,'wheel:'||v_spin_id||':inventory',NULL);
   IF COALESCE((v_deduct->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'The Owner Reward Debit Failed'; END IF;
   INSERT INTO public.feature_purchases(user_id,feature,cost,usage_type,uses_remaining,source) VALUES(v_user,v_feature,v_uses*v_unit,'per_use',v_uses,'diamond_wheel');
   v_grants:=jsonb_build_array(jsonb_build_object('feature',v_feature,'uses',v_uses));
   IF v_remainder>0 THEN
    INSERT INTO public.feature_purchases(user_id,feature,cost,usage_type,uses_remaining,source) VALUES(v_user,'throwable',v_remainder,'per_use',v_remainder,'diamond_wheel');
    v_grants:=v_grants||jsonb_build_object('feature','throwable','uses',v_remainder);
   END IF;
   v_value_chips:=v_cost::numeric/v_rate;
   v_outcome:=v_outcome||jsonb_build_object('amount',v_uses,'value_chips',v_value_chips,'grants',v_grants);
  ELSE
   v_boost:=CASE WHEN v_pick.kind='upgrade' THEN 2 ELSE 1 END;v_budget:=v_price*v_boost;
   v_cap:=(v_caps->>(v_game||':'||v_boost))::integer;v_hold:=ceil(v_budget::numeric/v_rate*v_cap)/100;
   INSERT INTO public.wheel_bonus_awards(spin_id,user_id,club_id,host_id,host_kind,game,entry_diamonds,boost_multiplier,base_diamonds,cap_cents,reserved_chips)
   VALUES(v_spin_id,v_user,p_club_id,v_host,v_kind,v_game,v_price,v_boost,v_budget,v_cap,v_hold) RETURNING * INTO v_award;
   UPDATE public.diamond_game_pools SET wheel_allocated_diamonds=wheel_allocated_diamonds+v_budget,reserved_chips=reserved_chips+v_hold,updated_at=now() WHERE host_id=v_host AND game=v_game;
   -- The welcome budget reserves the full liability until the awarded round settles.
   v_value_chips:=v_hold;
  END IF;

  -- ── 4. the pool remembers, on the right side of the books ─────────────────
  -- A welcome payout NEVER enters chips_paid. chips_paid is bounded by what the
  -- paid game took in; the welcome is bounded by the budget the host declared.
  -- Two promises, kept apart, both checked below.
  UPDATE public.wheel_pools
     SET spins = spins + CASE WHEN p_welcome THEN 0 ELSE 1 END,
         welcome_spins = welcome_spins + CASE WHEN p_welcome THEN 1 ELSE 0 END,
         intake_diamonds = intake_diamonds + v_dia_now,
         chips_paid = chips_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_chips END,
         welcome_chips_paid = welcome_chips_paid + CASE WHEN p_welcome THEN v_value_chips ELSE 0 END,
         diamond_float = diamond_float + v_dia_now
                       - CASE WHEN p_welcome THEN 0 ELSE v_prize_dia+v_cost END,
         diamonds_paid = diamonds_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         -- constrained_spins is a rate over `spins`, and a welcome spin is not
         -- one of those, so counting it here made the operator's lock rate able
         -- to exceed 1 (audit 2026-09-11).
         constrained_spins = constrained_spins
                           + CASE WHEN NOT p_welcome AND jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF NOT p_welcome AND pool.chips_paid>pool.intake_diamonds/v_rate+cfg.exposure_allowance_chips THEN RAISE EXCEPTION 'The Wheel Exposure Limit Was Exceeded'; END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  IF v_member_after IS NULL THEN
    SELECT COALESCE(m.chip_balance, 0) INTO v_member_after FROM public.club_members m
     WHERE m.club_id = p_club_id AND m.user_id = v_user LIMIT 1;
  END IF;

  v_result:=jsonb_build_object('ok',true,'contract_version',3,'welcome',p_welcome,'daily_bonus',p_mode='daily','bonus_ticket_id',p_bonus_ticket_id,
   'player_cost_diamonds',CASE WHEN p_mode='paid' THEN v_price ELSE 0 END,'entry_value_diamonds',v_price,
   'entry_funded_by',CASE p_mode WHEN 'daily' THEN 'mint' WHEN 'welcome' THEN 'welcome' ELSE 'player' END,
   'spin_id',v_spin_id,'club_id',p_club_id,'host_id',v_host,'segment_version',3,'spin_price_diamonds',CASE WHEN p_welcome THEN 0 ELSE v_price END,
   'diamonds_per_chip',v_rate,'segments',v_segments,'outcome',v_outcome,
   'fairness',jsonb_build_object('commit_id',p_commit_id,'server_seed_hash',cm.server_seed_hash,'server_seed',cm.server_seed,'client_seed',v_client,'nonce',v_nonce,'roll',v_roll,'weight_total',v_total,'eligible_ords',to_jsonb(v_eligible),'locked','[]'::jsonb,'domain','wheel-v3'),
   'balances',jsonb_build_object('diamonds',v_dia_after,'member_chips',v_member_after),'pool',jsonb_build_object('chips_paid',pool.chips_paid,'diamond_float',pool.diamond_float),'created_at',transaction_timestamp());
  IF v_award.id IS NOT NULL THEN v_result:=v_result||jsonb_build_object('bonus',jsonb_build_object('id',v_award.id,'game',v_award.game,'club_id',v_award.club_id,'base_diamonds',v_award.base_diamonds,'entry_diamonds',v_award.entry_diamonds,'boost_multiplier',v_award.boost_multiplier,'cap_cents',v_award.cap_cents)); END IF;
  IF v_secondary IS NOT NULL THEN v_result:=v_result||jsonb_build_object('secondary',v_secondary); END IF;
  INSERT INTO public.wheel_spins
    (id, host_id, host_kind, club_id, user_id, segment_version, spin_price_diamonds, multiplier, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, weight_total, eligible_ords, locked,
     outcome_ord, outcome_kind, outcome_amount, prize_value_chips, chips_minted, diamond_accrual,
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after,
     is_fixture, is_welcome, bonus_ticket_id,receipt_v2)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, 3,
     CASE WHEN p_welcome THEN 0 ELSE v_price END, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, (v_outcome->>'amount')::numeric, v_value_chips, 0, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after,
     v_is_fixture, p_welcome, p_bonus_ticket_id,v_result)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  IF p_bonus_ticket_id IS NOT NULL THEN
    UPDATE public.diamond_bonus_spin_tickets SET redeemed_spin_id=v_spin_id,redeemed_at=transaction_timestamp()
     WHERE id=p_bonus_ticket_id;
  END IF;
  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid) TO authenticated;
DO $w$ BEGIN IF md5(pg_get_functiondef('public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)'::regprocedure))<>'3532309ad4075bbfdcc0a3029e4cbad8' THEN RAISE EXCEPTION 'Custody fixture preimage differs: public.fn_wheel_spin_v2(uuid,uuid,text,integer,text,uuid)'; END IF; END $w$;
CREATE OR REPLACE FUNCTION public.fn_wheel_state_v2(p_club_id uuid, p_entry_diamonds integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE s jsonb;h uuid;k text;cfg public.wheel_configs;gcfg public.diamond_game_configs;gp public.diamond_game_pools;
 rate integer;cover numeric;held numeric;owner uuid;owner_diamonds numeric;room numeric;v_game text;boost integer;cap integer;funded boolean:=true;reason text;awards jsonb;welcome boolean;max_funded integer;headroom numeric;minimum_cap integer;welcome_funded boolean:=true;welcome_cap integer;
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 IF p_entry_diamonds IS NULL OR p_entry_diamonds NOT BETWEEN 25 AND 2500 THEN RETURN jsonb_build_object('ok',false,'error','Choose 25 To 2,500 Diamonds'); END IF;
 IF NOT public.fn_wheel_v2_enabled() THEN RETURN jsonb_build_object('ok',true,'contract_version',3,'enabled',false); END IF;
 s:=public.fn_wheel_state(p_club_id);
 IF s->>'ok' IS DISTINCT FROM 'true' THEN RETURN s; END IF;
 SELECT host_id,host_kind INTO h,k FROM public.fn_wheel_host(p_club_id);
 SELECT * INTO cfg FROM public.wheel_configs WHERE host_id=h;
 IF NOT FOUND THEN RETURN s||jsonb_build_object('contract_version',3,'enabled',true); END IF;
 rate:=public.fn_ca_bridge_rate();cover:=public.fn_diamond_game_cover(h,k);
 SELECT COALESCE(sum(reserved_chips),0) INTO held FROM public.diamond_game_pools WHERE host_id=h;
 owner:=public.fn_diamond_game_owner(h,k);SELECT COALESCE(diamonds,0) INTO owner_diamonds FROM public.profiles WHERE id=owner;
 max_funded:=GREATEST(0,LEAST(2500,floor((cover-held)*rate/100),floor((cfg.exposure_allowance_chips+COALESCE((s#>>'{pool,intake_diamonds}')::numeric,0)/rate-COALESCE((s#>>'{pool,chips_paid}')::numeric,0))*rate/99)))::integer;
 room:=cfg.welcome_budget_chips-public.fn_wheel_v2_welcome_spent(h);
 IF NOT public.fn_diamond_spins_owner_agreed(h,k) THEN funded:=false;welcome_funded:=false;reason:='The Host Wallet Owner Must Accept Diamond Spins Before Play Opens'; END IF;
 IF cover-held<ceil(p_entry_diamonds::numeric/rate*100*100)/100 OR COALESCE(owner_diamonds,0)+p_entry_diamonds<ceil(p_entry_diamonds*.5) OR COALESCE((s#>>'{pool,diamond_float}')::numeric,0)+p_entry_diamonds<ceil(p_entry_diamonds*.5) THEN funded:=false;reason:='The Host Must Fund Every Prize Before A Spin'; END IF;
 IF COALESCE((s#>>'{pool,chips_paid}')::numeric,0)+ceil(100*p_entry_diamonds::numeric/rate*100)/100>round((COALESCE((s#>>'{pool,intake_diamonds}')::numeric,0)+p_entry_diamonds)/rate,2)+cfg.exposure_allowance_chips THEN funded:=false;reason:='The Host Must Fund Every Prize Before A Spin'; END IF;
 FOR v_game IN SELECT unnest(ARRAY['crash','crossing','mines','plinko']) LOOP
  SELECT * INTO gcfg FROM public.diamond_game_configs WHERE host_id=h AND game=v_game;
  SELECT * INTO gp FROM public.diamond_game_pools WHERE host_id=h AND game=v_game;
  IF gcfg.host_id IS NULL OR NOT gcfg.enabled OR ((public.fn_ca_is_fixture_account(auth.uid()) OR public.fn_ca_is_cert_account(auth.uid())) AND NOT gcfg.allow_fixture_accounts) OR EXISTS(SELECT 1 FROM public.ca_payout_freeze WHERE scope=v_game AND cleared_at IS NULL) THEN funded:=false;welcome_funded:=false;max_funded:=0;reason:='Every Bonus Game Must Be Open Before A Spin';
  ELSE
   headroom:=(COALESCE(gp.intake_diamonds,0)+COALESCE(gp.wheel_allocated_diamonds,0))::numeric/rate+gcfg.exposure_allowance_chips-COALESCE(gp.chips_paid,0)-COALESCE(gp.reserved_chips,0);
   FOR boost IN 1..2 LOOP
    minimum_cap:=2000*(boost+1)/boost;
    welcome_cap:=LEAST(public.fn_diamond_game_cap_cents(gcfg,gp,cover,100*boost::numeric/rate,gcfg.max_multiplier_cents),floor(room/(100*boost::numeric/rate)*100)::integer);
    IF welcome_cap<minimum_cap THEN welcome_funded:=false; END IF;
    IF gcfg.max_multiplier_cents<minimum_cap THEN max_funded:=0;
    ELSE max_funded:=LEAST(max_funded,GREATEST(0,floor(rate*gcfg.cap_fraction*headroom/(minimum_cap::numeric/100-gcfg.cap_fraction)/boost))::integer); END IF;
    cap:=public.fn_diamond_game_cap_cents(gcfg,gp,cover,p_entry_diamonds*boost::numeric/rate,gcfg.max_multiplier_cents);
    IF cap<2000*(boost+1)/boost THEN funded:=false;reason:='The Host Must Fund Every Bonus Before A Spin'; END IF;
   END LOOP;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.plinko_tables WHERE activated_at IS NOT NULL AND max_multiplier_cents<=2000) THEN
  funded:=false;welcome_funded:=false;max_funded:=0;reason:='An Approved Plinko Table Must Be Open Before A Spin'; END IF;
 IF EXISTS(SELECT 1 FROM (VALUES('throwable',1),('rabbit_hunt',5),('time_bank_seconds',5)) expected(feature,cost)
  LEFT JOIN public.feature_pricing actual ON actual.feature=expected.feature
  WHERE actual.feature IS NULL OR actual.diamond_cost<>expected.cost OR actual.usage_type<>'per_use') THEN
  funded:=false;welcome_funded:=false;max_funded:=0;reason:='The Reward Prices Changed. The Wheel Must Be Requalified'; END IF;
 SELECT COALESCE(jsonb_agg(public.fn_wheel_bonus_public_award(a,false) ORDER BY a.created_at),'[]') INTO awards FROM public.wheel_bonus_awards a WHERE a.user_id=auth.uid() AND a.club_id=p_club_id AND a.status='pending';
 room:=cfg.welcome_budget_chips-public.fn_wheel_v2_welcome_spent(h);
 welcome:=cfg.enabled AND welcome_funded AND cfg.welcome_spin_enabled AND owner IS DISTINCT FROM auth.uid() AND room>=100*100::numeric/rate AND cover-held>=100*100::numeric/rate AND owner_diamonds>=50
  AND NOT EXISTS(SELECT 1 FROM public.wheel_spins WHERE host_id=h AND user_id=auth.uid() AND is_welcome);
 s:=jsonb_set(s,'{config}',(s->'config')-ARRAY['spec_rtp','chip_share','diamond_share','house_share','hit_rate']||jsonb_build_object('spin_price_diamonds',p_entry_diamonds,'spin_price_chips',p_entry_diamonds::numeric/rate,'segment_version',3,'multiplier',1,'min_entry',25,'max_entry',2500));
 RETURN s||jsonb_build_object('contract_version',3,'enabled',true,'available',COALESCE(cfg.enabled,false) AND funded,'reason',reason,
  'min_entry',25,'max_entry',2500,'max_funded_entry',max_funded,'segments',public.fn_wheel_v3_segments(p_entry_diamonds,rate),'upgrade_segments',public.fn_wheel_v3_segments(p_entry_diamonds,rate,true),'awards',awards,
  'welcome',jsonb_build_object('available',welcome,'eligible',welcome,'entry_diamonds',100));
END $function$
;
REVOKE ALL ON FUNCTION public.fn_wheel_state_v2(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_state_v2(uuid,integer) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_wheel_state_v2(uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_state_v2(uuid,integer) TO authenticated;
DO $w$ BEGIN IF md5(pg_get_functiondef('public.fn_wheel_state_v2(uuid,integer)'::regprocedure))<>'1844d82495f45b1970100b2025d7817f' THEN RAISE EXCEPTION 'Custody fixture preimage differs: public.fn_wheel_state_v2(uuid,integer)'; END IF; END $w$;
CREATE OR REPLACE FUNCTION public.fn_diamond_bonus_spin_ticket_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE h record; m jsonb; c public.ca_daily_bonus_claims; s public.wheel_spins;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bonus Spin Tickets Are Permanent Receipts'; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO c FROM public.ca_daily_bonus_claims WHERE id=NEW.claim_id;
  IF c.id IS NULL OR c.user_id IS DISTINCT FROM NEW.user_id OR c.bonus_date IS DISTINCT FROM NEW.bonus_date
     OR c.slot<>7 OR c.granted->>'kind' IS DISTINCT FROM 'free_spin'
     OR c.granted->>'ticket_id' IS DISTINCT FROM NEW.id::text
     OR c.granted->>'funded_by' IS DISTINCT FROM 'mint'
     OR (c.granted->>'entry_diamonds')::integer IS DISTINCT FROM 100
     OR (c.granted->>'quantity')::integer IS DISTINCT FROM 1
     OR (c.result->>'streak')::integer IS DISTINCT FROM NEW.streak
     OR NEW.funded_at IS NOT NULL OR NEW.redeemed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A Bonus Spin Requires Its Claimed Daily Reward';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.user_id,NEW.claim_id,NEW.bonus_date,NEW.streak,NEW.entry_diamonds,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.claim_id,OLD.bonus_date,OLD.streak,OLD.entry_diamonds,OLD.created_at)
    OR OLD.redeemed_spin_id IS NOT NULL THEN
  RAISE EXCEPTION 'A Bonus Spin Receipt Cannot Be Rewritten';
 END IF;
 IF auth.uid() IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'That Bonus Spin Belongs To Another Player' USING ERRCODE='42501'; END IF;
 IF OLD.funded_at IS NULL THEN
  IF NEW.funded_at IS NULL OR NEW.redeemed_spin_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid Bonus Spin Funding Transition'; END IF;
  SELECT * INTO h FROM public.fn_wheel_host(NEW.club_id);
  IF h.host_id IS DISTINCT FROM NEW.host_id OR h.host_kind IS DISTINCT FROM NEW.host_kind
     OR public.fn_diamond_game_owner(h.host_id,h.host_kind) IS DISTINCT FROM NEW.owner_id
     OR NOT EXISTS(SELECT 1 FROM public.club_members WHERE club_id=NEW.club_id AND user_id=NEW.user_id AND COALESCE(status,'active') IN('active','approved'))
     OR NOT EXISTS(SELECT 1 FROM public.wheel_seed_commits WHERE id=NEW.commit_id AND user_id=NEW.user_id AND consumed_by IS NULL AND expires_at>=now()) THEN
    RAISE EXCEPTION 'Bonus Spin Funding Does Not Match Its Member And Host';
  END IF;
  NEW.mint_op_id := 'daily-bonus-spin:'||NEW.id::text;
  NEW.funded_at := transaction_timestamp();
  m := public.fn_ca_mint('diamonds','player',NEW.owner_id,100,
        'Daily Bonus 100 Diamond Spin Entry For Claimed Ticket '||NEW.id::text,NEW.mint_op_id,'promotional');
  IF NOT COALESCE((m->>'ok')::boolean,false) OR (m->>'amount')::numeric IS DISTINCT FROM 100
     OR m->>'target_id' IS DISTINCT FROM NEW.owner_id::text THEN
   RAISE EXCEPTION 'Daily Bonus Spin Funding Is Unavailable: %',COALESCE(m->>'reason','mint_refused') USING ERRCODE='PDS01';
  END IF;
 ELSE
  IF (NEW.club_id,NEW.host_id,NEW.host_kind,NEW.owner_id,NEW.commit_id,NEW.client_seed,NEW.mint_op_id,NEW.funded_at)
     IS DISTINCT FROM (OLD.club_id,OLD.host_id,OLD.host_kind,OLD.owner_id,OLD.commit_id,OLD.client_seed,OLD.mint_op_id,OLD.funded_at)
     OR NEW.redeemed_spin_id IS NULL THEN RAISE EXCEPTION 'Bonus Spin Funding Cannot Be Changed'; END IF;
  SELECT * INTO s FROM public.wheel_spins WHERE id=NEW.redeemed_spin_id;
  IF s.id IS NULL OR s.bonus_ticket_id IS DISTINCT FROM NEW.id OR s.user_id IS DISTINCT FROM NEW.user_id
     OR s.club_id IS DISTINCT FROM NEW.club_id OR s.host_id IS DISTINCT FROM NEW.host_id
     OR s.commit_id IS DISTINCT FROM NEW.commit_id OR s.client_seed IS DISTINCT FROM NEW.client_seed
     OR s.is_welcome OR s.spin_price_diamonds<>100 OR s.diamond_accrual<>100 THEN
    RAISE EXCEPTION 'Bonus Spin Redemption Does Not Match Its Funded Entry';
  END IF;
  NEW.redeemed_at := transaction_timestamp();
 END IF;
 RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION public.fn_diamond_bonus_spin_ticket_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_spin_ticket_guard() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_diamond_bonus_spin_ticket_guard() TO service_role;
DO $w$ BEGIN IF md5(pg_get_functiondef('public.fn_diamond_bonus_spin_ticket_guard()'::regprocedure))<>'16a8ef3f7495b24ffa41b78289e75249' THEN RAISE EXCEPTION 'Custody fixture preimage differs: public.fn_diamond_bonus_spin_ticket_guard()'; END IF; END $w$;
CREATE OR REPLACE FUNCTION public.fn_ca_mint_supply(p_asset text)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
    FROM public.ca_mint_ledger WHERE asset = p_asset;
$function$
;
REVOKE ALL ON FUNCTION public.fn_ca_mint_supply(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_supply(text) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_supply(text) TO service_role;
DO $w$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_mint_supply(text)'::regprocedure))<>'b735bae7649d0b0753352abf5439f8d9' THEN RAISE EXCEPTION 'Custody fixture preimage differs: public.fn_ca_mint_supply(text)'; END IF; END $w$;
CREATE OR REPLACE FUNCTION public.fn_wheel_spin_core(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_welcome boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
 IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To Spin'); END IF;
 RETURN public.fn_wheel_spin_core(p_club_id,p_commit_id,p_client_seed,p_welcome,NULL);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean) TO service_role;
DO $w$ BEGIN IF md5(pg_get_functiondef('public.fn_wheel_spin_core(uuid,uuid,text,boolean)'::regprocedure))<>'4c9c2645c10f7440951f15ffeca63d68' THEN RAISE EXCEPTION 'Custody fixture preimage differs: public.fn_wheel_spin_core(uuid,uuid,text,boolean)'; END IF; END $w$;
CREATE OR REPLACE FUNCTION public.fn_wheel_spin_core(p_club_id uuid, p_commit_id uuid, p_client_seed text, p_welcome boolean, p_bonus_ticket_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  c_two48 constant numeric := 281474976710656;   -- 2^48
  v_user uuid := auth.uid();
  v_host uuid; v_kind text;
  cfg public.wheel_configs%ROWTYPE;
  pool public.wheel_pools%ROWTYPE;
  cm public.wheel_seed_commits%ROWTYPE;
  prior public.wheel_spins%ROWTYPE;
  a record;
  v_rate integer := public.fn_ca_bridge_rate();
  v_price integer; v_mult integer; v_intake numeric;
  v_dia_now numeric; v_intake_chips numeric;
  v_owner uuid; v_owner_dia numeric;
  v_bank numeric; v_bank_after numeric;
  v_promo numeric; v_bank_only numeric; v_pay record;
  v_client text := left(btrim(COALESCE(p_client_seed, '')), 64);
  v_nonce bigint; v_hmac bytea; v_roll numeric; v_point numeric;
  v_total integer := 0; v_acc integer := 0;
  v_eligible smallint[] := '{}'; v_locked jsonb := '[]'::jsonb;
  seg record; v_pick record; v_found boolean := false;
  v_value_chips numeric := 0; v_prize_chips numeric := 0; v_prize_dia integer := 0;
  v_today integer; v_last timestamptz;
  v_spendable integer; v_diamonds numeric; v_purchased integer;
  v_lot record; v_remaining integer; v_take integer;
  v_deduct jsonb; v_credit jsonb;
  v_member_after numeric; v_dia_after numeric;
  v_spin_id uuid := gen_random_uuid();
  v_is_fixture boolean := false;
  v_result jsonb;
  v_ticket public.diamond_bonus_spin_tickets;
  -- The welcome budget is a window, not a lifetime total, and a welcome spin is
  -- the whole wheel or it is not offered. Both figures are measured once, up
  -- front, under the config lock that serialises every spin on this host.
  v_welcome_spent numeric := 0; v_welcome_top numeric := 0;
BEGIN
  -- ── who and where ──────────────────────────────────────────────────────────
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Sign In To Spin');
  END IF;
  SELECT h.host_id, h.host_kind INTO v_host, v_kind FROM public.fn_wheel_host(p_club_id) h;
  IF v_host IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Club Could Not Be Found');
  END IF;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Bridge Rate Is Not Set');
  END IF;
  IF length(v_client) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'A Client Seed Is Required');
  END IF;

  -- ── replay: a commit is spent once; the second call returns the first spin ─
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id = p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok', false, 'error', 'That Spin Belongs To Another Player');
    END IF;
    IF prior.club_id IS DISTINCT FROM p_club_id OR prior.client_seed IS DISTINCT FROM v_client
       OR prior.is_welcome IS DISTINCT FROM p_welcome OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', true);
  END IF;

  IF public.fn_wheel_v2_enabled() THEN RETURN jsonb_build_object('ok',false,'error','Refresh Diamond Spins To Use The New Wheel'); END IF;

  IF p_bonus_ticket_id IS NOT NULL THEN
    IF p_welcome THEN RETURN jsonb_build_object('ok',false,'error','Choose One Free Spin Reward'); END IF;
    SELECT * INTO v_ticket FROM public.diamond_bonus_spin_tickets WHERE id=p_bonus_ticket_id FOR UPDATE;
    IF v_ticket.id IS NULL OR v_ticket.user_id IS DISTINCT FROM v_user THEN
      RETURN jsonb_build_object('ok',false,'error','Claim This Bonus Spin In Daily Bonus First');
    END IF;
    IF v_ticket.redeemed_spin_id IS NOT NULL THEN
      SELECT * INTO prior FROM public.wheel_spins WHERE id=v_ticket.redeemed_spin_id;
      IF prior.user_id=v_user AND prior.club_id=p_club_id AND prior.commit_id=p_commit_id
         AND prior.client_seed=v_client AND prior.bonus_ticket_id=p_bonus_ticket_id AND NOT prior.is_welcome THEN
        RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
      END IF;
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
    IF v_ticket.funded_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'error','That Bonus Spin Was Already Used');
    END IF;
  END IF;

  IF p_bonus_ticket_id IS NOT NULL THEN
    -- Match the canonical Mint's lock order before taking host/owner rows.
    PERFORM pg_advisory_xact_lock(hashtext('ca_mint_ledger:diamonds'));
  END IF;

  -- ── the freeze and the kill switch, before any money moves ─────────────────
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Platform Is In Its Maintenance Break. Spin Again In A Few Minutes');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'wheel' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Paused');
  END IF;

  -- ── the host, its table, its pool: one lock serialises every spin on it ────
  SELECT * INTO cfg FROM public.wheel_configs WHERE host_id = v_host FOR UPDATE;
  SELECT * INTO prior FROM public.wheel_spins WHERE commit_id=p_commit_id;
  IF prior.id IS NOT NULL THEN
    IF prior.user_id IS DISTINCT FROM v_user OR prior.club_id IS DISTINCT FROM p_club_id
       OR prior.client_seed IS DISTINCT FROM v_client OR prior.is_welcome IS DISTINCT FROM p_welcome
       OR prior.bonus_ticket_id IS DISTINCT FROM p_bonus_ticket_id THEN
      RETURN jsonb_build_object('ok',false,'error','That Spin Request Does Not Match Its Receipt');
    END IF;
    RETURN public.fn_wheel_spin_result(prior)||jsonb_build_object('replayed',true);
  END IF;
  IF cfg.host_id IS NULL OR NOT cfg.enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Diamond Wheel Is Not Open Here');
  END IF;
  INSERT INTO public.wheel_pools (host_id) VALUES (v_host) ON CONFLICT (host_id) DO NOTHING;
  SELECT * INTO pool FROM public.wheel_pools WHERE host_id = v_host FOR UPDATE;

  SELECT x.* INTO a FROM public.fn_wheel_segments_audit(cfg.segment_version) x;
  IF a.weight_total IS DISTINCT FROM 100000 OR a.spec_rtp IS DISTINCT FROM 0.800000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'The Prize Table Failed Its Audit. The Wheel Is Closed Until It Is Fixed');
  END IF;
  SELECT (CASE WHEN p_welcome OR p_bonus_ticket_id IS NOT NULL THEN 100 ELSE cfg.spin_price_diamonds END) / v.spin_price_diamonds INTO v_mult
    FROM public.wheel_segment_versions v WHERE v.version = cfg.segment_version;
  IF p_bonus_ticket_id IS NOT NULL AND cfg.spin_price_diamonds<>100 THEN RETURN jsonb_build_object('ok',false,'error','The 100 Diamond Reward Table Is Unavailable'); END IF;
  v_price  := CASE WHEN p_welcome OR p_bonus_ticket_id IS NOT NULL THEN 100 ELSE cfg.spin_price_diamonds END;
  IF v_mult IS NULL OR v_mult<1 THEN RETURN jsonb_build_object('ok',false,'error','The 100 Diamond Reward Table Is Unavailable'); END IF;
  v_intake := v_price::numeric / v_rate;
  -- THE HOST IS THE HOUSE (Dan 2026-09-10). Nothing is minted: the whole price
  -- is taken in by the host's owner, and the prize is paid out of what the host
  -- holds. The chip side is bounded by the chips this wheel has taken in (this
  -- spin included) plus the host's allowance; the diamond side by the diamonds
  -- it has taken in plus the seed the host put up. Both are "never more than
  -- taken in", stated on the money that actually moved.
  -- A WELCOME SPIN TAKES NOTHING IN (Dan 2026-09-10: the owner "simply receives
  -- no diamonds"). So it adds nothing to the float and nothing to the intake the
  -- paid game's invariant is stated on; its payout is charged to the welcome
  -- budget instead, a few lines below.
  v_dia_now      := CASE WHEN p_welcome THEN 0 ELSE v_price END;
  v_intake_chips := round((pool.intake_diamonds + v_dia_now)::numeric / v_rate, 2);
  v_owner := public.fn_diamond_game_owner(v_host, v_kind);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'This Host Has No Owner Wallet To Pay');
  END IF;

  -- ── the player: member, not a fixture, inside the limits, able to pay ──────
  IF NOT EXISTS (SELECT 1 FROM public.club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = v_user
                    AND COALESCE(m.status, 'active') IN ('active', 'approved')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Join The Club Before You Spin');
  END IF;
  v_is_fixture := public.fn_ca_is_fixture_account(v_user) OR public.fn_ca_is_cert_account(v_user);
  IF v_is_fixture AND NOT cfg.allow_fixture_accounts THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Certification Accounts Do Not Spin This Wheel');
  END IF;

  -- ── the welcome spin: once per member, ever, and only out of a real budget ─
  IF p_welcome THEN
    IF NOT cfg.welcome_spin_enabled THEN
      RETURN jsonb_build_object('ok', false, 'error', 'There Is No Welcome Spin Here');
    END IF;
    IF COALESCE(cfg.welcome_budget_chips, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spin Is Not Funded Here Yet');
    END IF;
    IF v_user = v_owner THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Host Does Not Take Its Own Welcome Spin');
    END IF;
    -- The unique index is what actually enforces this; the check is here to
    -- answer the player in words rather than with a constraint violation.
    IF EXISTS (SELECT 1 FROM public.wheel_spins s
                WHERE s.host_id = v_host AND s.user_id = v_user AND s.is_welcome) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'You Have Already Taken Your Welcome Spin Here');
    END IF;
    -- A WELCOME SPIN IS THE WHOLE WHEEL OR IT IS NOT OFFERED (2026-09-11).
    -- The budget used to be checked tier by tier, so as the spend approached it
    -- the top prizes locked one after another and the last new members to
    -- arrive were handed a visibly worse wheel than the first ones. A gift that
    -- gets meaner the longer you take to join is not the gift Dan described.
    -- So the budget is asked ONE question before anything is offered: can it
    -- still cover the biggest prize on this table? If it can, every tier is
    -- live. If it cannot, there is no welcome spin here until the window turns.
    -- ONE DEFINITION OF THE QUESTION (2026-09-11). The door, the page and the
    -- entry read all asked it, and the entry read asked a DIFFERENT one, so a
    -- player could be told "Welcome Spin Ready" and then be refused by the
    -- door. There is one helper now and three callers.
    SELECT r.o_spent, r.o_top INTO v_welcome_spent, v_welcome_top
      FROM public.fn_wheel_welcome_room(v_host) r;
    IF v_welcome_spent + v_welcome_top > cfg.welcome_budget_chips THEN
      RETURN jsonb_build_object('ok', false, 'error', 'The Welcome Spins Here Are Gone For Now');
    END IF;
  END IF;
  SELECT * INTO cm FROM public.wheel_seed_commits
   WHERE id = p_commit_id AND user_id = v_user AND consumed_by IS NULL FOR UPDATE;
  IF cm.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again');
  END IF;
  IF cm.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'That Spin Ticket Expired. Open The Wheel Again');
  END IF;
  SELECT count(*)::integer, max(s.created_at) INTO v_today, v_last
    FROM public.wheel_spins s
   WHERE s.user_id = v_user AND s.host_id = v_host
     AND (s.created_at AT TIME ZONE 'America/Chicago')::date = (now() AT TIME ZONE 'America/Chicago')::date;
  IF v_today >= cfg.max_spins_per_player_per_day THEN
    RETURN jsonb_build_object('ok', false, 'error', format('You Have Reached Today''s Limit Of %s Spins', cfg.max_spins_per_player_per_day));
  END IF;
  IF v_last IS NOT NULL AND now() - v_last < make_interval(secs => cfg.min_seconds_between_spins) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'One Moment Between Spins');
  END IF;
  SELECT COALESCE(p.diamonds, 0) INTO v_diamonds FROM public.profiles p WHERE p.id = v_user;
  v_purchased := public.fn_wheel_purchased_available(v_user);
  v_spendable := CASE WHEN cfg.purchased_only THEN LEAST(v_diamonds, v_purchased)::integer ELSE v_diamonds::integer END;
  IF NOT p_welcome AND p_bonus_ticket_id IS NULL AND v_spendable < v_price THEN
    RETURN jsonb_build_object('ok', false,
      'error', CASE WHEN cfg.purchased_only AND v_diamonds >= v_price
                    THEN 'This Wheel Spins Purchased Diamonds Only'
                    ELSE 'Not Enough Diamonds For A Spin' END,
      'diamonds', v_diamonds, 'spendable', v_spendable, 'spin_price_diamonds', v_price);
  END IF;

  -- ── the host's cover and its owner's diamonds, locked ─────────────────────
  -- The promo wallet pays first and the host's own chip bank stands behind it
  -- (Dan 2026-09-10). v_bank is the two together: what a prize may draw on.
  SELECT c.o_promo, c.o_bank, c.o_cover INTO v_promo, v_bank_only, v_bank
    FROM public.fn_diamond_game_cover_lock(v_host, v_kind) c;
  SELECT COALESCE(p.diamonds, 0) INTO v_owner_dia FROM public.profiles p WHERE p.id = v_owner;

  -- ── eligibility: the affordability gate ────────────────────────────────────
  FOR seg IN SELECT * FROM public.wheel_segments g WHERE g.version = cfg.segment_version ORDER BY g.ord LOOP
    IF seg.kind = 'chips' THEN
      -- There is no welcome branch here any more. The budget was asked about
      -- the WHOLE table before the spin was allowed, so on a welcome spin every
      -- tier is affordable by construction and none of them may be locked for
      -- being expensive. The exposure gate below is the paid wheel's alone: a
      -- welcome spin took nothing in, so it may not lean on what the paid game
      -- took in either.
      IF NOT p_welcome AND pool.chips_paid + seg.amount * v_mult > v_intake_chips + cfg.exposure_allowance_chips THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'exposure',
                      'unlocks_at', round(pool.chips_paid + seg.amount * v_mult - cfg.exposure_allowance_chips, 2));
        CONTINUE;
      END IF;
      IF v_bank < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'cover', 'unlocks_at', round(seg.amount * v_mult, 2));
        CONTINUE;
      END IF;
    ELSIF seg.kind = 'diamonds' THEN
      -- THE PAID WHEEL'S FLOAT IS NOT THE GIFT'S TO SPEND (audit 2026-09-11).
      -- A welcome diamond prize comes from the owner and is charged to the
      -- welcome budget, which was checked just above. Gating it on the paid
      -- float as well locked tiers a club had every right to give away, and
      -- draining that float for it made the paid wheel pay for the welcome.
      IF NOT p_welcome AND pool.diamond_float + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'diamond_float',
                      'unlocks_at', round(seg.amount * v_mult - v_dia_now, 0));
        CONTINUE;
      END IF;
      IF v_owner_dia + v_dia_now < seg.amount * v_mult THEN
        v_locked := v_locked || jsonb_build_object('ord', seg.ord, 'reason', 'owner_diamonds',
                      'unlocks_at', round(seg.amount * v_mult, 0));
        CONTINUE;
      END IF;
    END IF;
    v_eligible := v_eligible || seg.ord;
    v_total := v_total + seg.weight;
  END LOOP;
  IF p_bonus_ticket_id IS NOT NULL AND jsonb_array_length(v_locked)>0 THEN
    RETURN jsonb_build_object('ok',false,'error','The Host Must Cover The Whole Bonus Spin Table','locked',v_locked);
  END IF;
  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'No Prize Can Be Paid Right Now. Try Again Shortly', 'locked', v_locked);
  END IF;

  -- ── the roll: committed seed, player seed, per-player nonce ────────────────
  SELECT count(*) + 1 INTO v_nonce FROM public.wheel_spins s WHERE s.user_id = v_user;
  v_hmac := extensions.hmac(convert_to(v_client || ':' || v_nonce::text, 'UTF8'),
                            convert_to(cm.server_seed, 'UTF8'), 'sha256');
  v_roll  := (('x' || encode(substring(v_hmac from 1 for 6), 'hex'))::bit(48)::bigint)::numeric;
  v_point := floor(v_roll * v_total / c_two48);
  v_acc := 0;
  FOR seg IN SELECT * FROM public.wheel_segments g
              WHERE g.version = cfg.segment_version AND g.ord = ANY (v_eligible) ORDER BY g.ord LOOP
    v_acc := v_acc + seg.weight;
    IF v_point < v_acc THEN v_pick := seg; v_found := true; EXIT; END IF;
  END LOOP;
  IF NOT v_found THEN
    SELECT * INTO v_pick FROM public.wheel_segments g
     WHERE g.version = cfg.segment_version AND g.ord = v_eligible[array_length(v_eligible, 1)];
  END IF;

  -- ── 1. the spin is paid for, unless it is the welcome ─────────────────────
  -- THE OWNER SIMPLY RECEIVES NO DIAMONDS (Dan 2026-09-10). Not a refund, not a
  -- credit and back out again: on a welcome spin no diamond moves anywhere. The
  -- player pays nothing, the owner takes nothing, and what the host gives up is
  -- exactly the spin price it would have been paid.
  IF p_bonus_ticket_id IS NOT NULL THEN
    BEGIN
      UPDATE public.diamond_bonus_spin_tickets SET club_id=p_club_id,host_id=v_host,host_kind=v_kind,
        owner_id=v_owner,commit_id=p_commit_id,client_seed=v_client,
        funded_at=transaction_timestamp(),mint_op_id='daily-bonus-spin:'||p_bonus_ticket_id::text
       WHERE id=p_bonus_ticket_id RETURNING * INTO v_ticket;
    EXCEPTION WHEN SQLSTATE 'PDS01' THEN
      RETURN jsonb_build_object('ok',false,'error',SQLERRM);
    END;
  ELSIF NOT p_welcome THEN
    v_deduct := public.deduct_diamonds(
      v_user, v_price,
      format('Diamond Wheel Spin (%s Diamonds)', v_price),
      'wheel_spin', 'wheel_spin',
      jsonb_build_object('spin_id', v_spin_id, 'club_id', p_club_id, 'host_id', v_host,
                         'commit_id', p_commit_id, 'segment_version', cfg.segment_version,
                         'recipient_id', v_owner),
      'wheel:' || v_spin_id::text, 0);
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Not Enough Diamonds For A Spin',
                                'detail', v_deduct->>'error');
    END IF;
    -- The intake is the host owner's (Dan 2026-09-10): a transfer, not an issuance.
    v_credit := public.add_diamonds_to_balance(v_owner, v_price, 'transfer',
                  format('Diamond Wheel Intake (%s Diamonds)', v_price), 'wheel:' || v_spin_id::text || ':intake', v_user);
    IF COALESCE((v_credit->>'success')::boolean, false) = false THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the spin price could not be credited to the host owner: %', v_credit->>'error';
    END IF;
    IF cfg.purchased_only THEN
      v_remaining := v_price;
      FOR v_lot IN SELECT * FROM public.diamond_purchase_lots l
                    WHERE l.user_id = v_user AND l.frozen_at IS NULL
                      AND (l.issued - l.consumed - l.refunded) > 0
                    ORDER BY l.created_at, l.id FOR UPDATE LOOP
        EXIT WHEN v_remaining <= 0;
        v_take := LEAST(v_remaining, v_lot.issued - v_lot.consumed - v_lot.refunded);
        UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
        v_remaining := v_remaining - v_take;
      END LOOP;
      IF v_remaining > 0 THEN
        RAISE EXCEPTION 'fn_wheel_spin_core: purchased lots could not cover the spin (% short) after the availability check passed', v_remaining;
      END IF;
    END IF;
  END IF;

  -- ── 2. the prize ───────────────────────────────────────────────────────────
  IF v_pick.kind = 'chips' THEN
    v_prize_chips := round(v_pick.amount * v_mult, 2);
    v_value_chips := v_prize_chips;
    IF v_bank < v_prize_chips THEN
      RAISE EXCEPTION 'fn_wheel_spin_core: the host cover % is below the prize % after the gate passed', v_bank, v_prize_chips;
    END IF;
    -- ONE PAYER FOR EVERY CHIP THE DIAMOND GAMES PAY. The promo wallet goes
    -- first and the host's own bank covers whatever is left (Dan 2026-09-10),
    -- journaled from the paying side so each row names the column the chips
    -- left, and the member side stands down so nothing is journaled twice.
    SELECT * INTO v_pay FROM public.fn_diamond_game_pay_chips(
      'wheel_prize', v_host, v_kind, p_club_id, v_user, v_prize_chips,
      'wheel-prize:' || v_spin_id::text,
      format('Diamond Wheel: %s', v_pick.label),
      jsonb_build_object('spin_id', v_spin_id, 'host_id', v_host, 'host_kind', v_kind,
                         'segment_version', cfg.segment_version, 'ord', v_pick.ord,
                         'welcome', p_welcome,'bonus_ticket_id',p_bonus_ticket_id,
                         'entry_funded_by',CASE WHEN p_bonus_ticket_id IS NOT NULL THEN 'mint' ELSE 'player' END));
    v_member_after := v_pay.member_after;
    v_bank_after   := v_pay.cover_after;
    v_promo        := v_pay.promo_after;
    v_bank_only    := v_pay.bank_after;
    v_bank := v_bank_after;
  ELSIF v_pick.kind = 'diamonds' THEN
    v_prize_dia := (v_pick.amount * v_mult)::integer;
    v_value_chips := round(v_prize_dia::numeric / v_rate, 4);
    -- The diamond prize is paid BY THE HOST'S OWNER, out of what the wheel took
    -- in (Dan 2026-09-10). Two transfer legs, one transaction; nothing is issued.
    PERFORM public.fn_diamond_game_pay_diamonds(v_owner, v_user, v_prize_dia,
              format('Diamond Wheel: %s', v_pick.label), 'wheel:' || v_spin_id::text || ':prize');
  END IF;

  -- ── 4. the pool remembers, on the right side of the books ─────────────────
  -- A welcome payout NEVER enters chips_paid. chips_paid is bounded by what the
  -- paid game took in; the welcome is bounded by the budget the host declared.
  -- Two promises, kept apart, both checked below.
  UPDATE public.wheel_pools
     SET spins = spins + CASE WHEN p_welcome THEN 0 ELSE 1 END,
         welcome_spins = welcome_spins + CASE WHEN p_welcome THEN 1 ELSE 0 END,
         intake_diamonds = intake_diamonds + v_dia_now,
         chips_paid = chips_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_chips END,
         welcome_chips_paid = welcome_chips_paid + CASE WHEN p_welcome THEN v_value_chips ELSE 0 END,
         diamond_float = diamond_float + v_dia_now
                       - CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         diamonds_paid = diamonds_paid + CASE WHEN p_welcome THEN 0 ELSE v_prize_dia END,
         -- constrained_spins is a rate over `spins`, and a welcome spin is not
         -- one of those, so counting it here made the operator's lock rate able
         -- to exceed 1 (audit 2026-09-11).
         constrained_spins = constrained_spins
                           + CASE WHEN NOT p_welcome AND jsonb_array_length(v_locked) > 0 THEN 1 ELSE 0 END,
         updated_at = now()
   WHERE host_id = v_host
   RETURNING * INTO pool;
  IF pool.chips_paid > round(pool.intake_diamonds::numeric / v_rate, 2) + cfg.exposure_allowance_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: chips_paid % would exceed the chips taken in % + allowance % - the gate was bypassed',
      pool.chips_paid, round(pool.intake_diamonds::numeric / v_rate, 2), cfg.exposure_allowance_chips;
  END IF;
  -- The window is what is bounded now, not the lifetime total, and the row for
  -- THIS spin is not written until a few lines below - so the assertion is made
  -- on the figure the gate used plus what this spin just paid. Both were read
  -- under the config lock, so no other spin on this host can have moved them.
  IF p_welcome AND v_welcome_spent + v_value_chips > cfg.welcome_budget_chips THEN
    RAISE EXCEPTION 'fn_wheel_spin_core: the welcome window has paid % against a budget of % - the gate was bypassed',
      v_welcome_spent + v_value_chips, cfg.welcome_budget_chips;
  END IF;

  SELECT COALESCE(p.diamonds, 0) INTO v_dia_after FROM public.profiles p WHERE p.id = v_user;
  IF v_member_after IS NULL THEN
    SELECT COALESCE(m.chip_balance, 0) INTO v_member_after FROM public.club_members m
     WHERE m.club_id = p_club_id AND m.user_id = v_user LIMIT 1;
  END IF;

  INSERT INTO public.wheel_spins
    (id, host_id, host_kind, club_id, user_id, segment_version, spin_price_diamonds, multiplier, diamonds_per_chip,
     commit_id, server_seed_hash, server_seed, client_seed, nonce, roll, weight_total, eligible_ords, locked,
     outcome_ord, outcome_kind, outcome_amount, prize_value_chips, chips_minted, diamond_accrual,
     pool_chips_minted_after, pool_chips_paid_after, pool_diamond_float_after, diamonds_after, member_chips_after,
     is_fixture, is_welcome, bonus_ticket_id)
  VALUES
    (v_spin_id, v_host, v_kind, p_club_id, v_user, cfg.segment_version,
     CASE WHEN p_welcome THEN 0 ELSE v_price END, v_mult, v_rate,
     cm.id, cm.server_seed_hash, cm.server_seed, v_client, v_nonce, v_roll, v_total, v_eligible, v_locked,
     v_pick.ord, v_pick.kind, v_pick.amount * v_mult, v_value_chips, 0, v_dia_now,
     pool.chips_minted, pool.chips_paid, pool.diamond_float, v_dia_after, v_member_after,
     v_is_fixture, p_welcome, p_bonus_ticket_id)
  RETURNING * INTO prior;
  UPDATE public.wheel_seed_commits SET consumed_by = v_spin_id WHERE id = cm.id;

  IF p_bonus_ticket_id IS NOT NULL THEN
    UPDATE public.diamond_bonus_spin_tickets SET redeemed_spin_id=v_spin_id,redeemed_at=transaction_timestamp()
     WHERE id=p_bonus_ticket_id;
  END IF;
  RETURN public.fn_wheel_spin_result(prior) || jsonb_build_object('replayed', false);
END $function$
;
REVOKE ALL ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean,uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_wheel_spin_core(uuid,uuid,text,boolean,uuid) TO service_role;
DO $w$ BEGIN IF md5(pg_get_functiondef('public.fn_wheel_spin_core(uuid,uuid,text,boolean,uuid)'::regprocedure))<>'f9e14bfc80321ea10e999f37a15ac450' THEN RAISE EXCEPTION 'Custody fixture preimage differs: public.fn_wheel_spin_core(uuid,uuid,text,boolean,uuid)'; END IF; END $w$;
CREATE OR REPLACE FUNCTION public.deduct_diamonds(p_user_id uuid, p_amount integer, p_description text DEFAULT ''::text, p_transaction_type text DEFAULT 'game_cost'::text, p_source text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_reference_id text DEFAULT NULL::text, p_cooldown_seconds integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_current integer;
    v_new_balance integer;
    v_effective_type text;
    v_issuance_class text;
    v_counterparty text;
    v_existing_amount numeric;
    v_existing_type text;
    v_existing_counterparty text;
    v_existing_issuance_class text;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Amount must be a positive integer');
    END IF;
    IF COALESCE(auth.role(), '') <> 'service_role'
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Cannot deduct diamonds for another user');
    END IF;

    v_effective_type := COALESCE(p_source, p_transaction_type);

    -- Derive the destination before the replay check so the same reference
    -- cannot be moved to another recipient or revenue account.
    -- A DEBIT THAT NAMES WHERE THE MONEY WENT IS A TRANSFER. This used to be
    -- decided by the source list below alone, so every new transfer path had to
    -- remember to add itself to it - and on 2026-09-11 the Diamond Wheel did not,
    -- so its spin price was journaled a spend, the register retired 100 diamonds
    -- that were sitting in the host owner's balance, and the hourly detector read
    -- 100 of unexplained supply. The classification follows the money now.
    IF COALESCE(p_metadata->>'recipient_id', '') <> ''
       OR COALESCE(p_source, '') IN ('wallet_transfer', 'wallet_diamond_transfer', 'stream_gift')
       OR COALESCE(p_transaction_type, '') IN ('diamond_gift_sent', 'live_gift_sent') THEN
        v_issuance_class := 'transferred';
        v_counterparty := 'player:' || COALESCE(p_metadata->>'recipient_id', 'unknown');
    ELSE
        v_issuance_class := 'spend';
        v_counterparty := 'revenue:' || COALESCE(p_source, p_transaction_type, 'unknown');
    END IF;

    -- The profile lock serializes the first attempt and every concurrent
    -- replay. A second request cannot pass an early lookup, wait for the first
    -- debit to commit, and then fall through to a duplicate insert error.
    SELECT COALESCE(diamonds, 0)
      INTO v_current
      FROM public.profiles
     WHERE id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User not found');
    END IF;

    IF p_reference_id IS NOT NULL THEN
        SELECT dt.amount,
               COALESCE(dt.transaction_type, dt.type),
               dt.counterparty,
               dt.issuance_class
          INTO v_existing_amount,
               v_existing_type,
               v_existing_counterparty,
               v_existing_issuance_class
          FROM public.diamond_transactions AS dt
         WHERE dt.reference_id = p_reference_id
           AND dt.user_id = p_user_id
         LIMIT 1;

        IF FOUND THEN
            IF v_existing_amount IS DISTINCT FROM -p_amount
               OR v_existing_type IS DISTINCT FROM v_effective_type
               OR v_existing_counterparty IS DISTINCT FROM v_counterparty
               OR v_existing_issuance_class IS DISTINCT FROM v_issuance_class THEN
                RETURN jsonb_build_object(
                    'success', false,
                    'error', 'idempotency_conflict',
                    'balance', v_current,
                    'reference_id', p_reference_id
                );
            END IF;

            RETURN jsonb_build_object(
                'success', true,
                'balance', v_current,
                'charged', (-v_existing_amount)::integer,
                'transaction_type', v_existing_type,
                'reference_id', p_reference_id,
                'counterparty', v_existing_counterparty,
                'issuance_class', v_existing_issuance_class,
                'idempotent', true
            );
        END IF;
    END IF;

    IF v_current < p_amount THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Insufficient diamonds',
            'balance', v_current
        );
    END IF;

    IF p_cooldown_seconds > 0 THEN
        IF EXISTS (
            SELECT 1
              FROM public.diamond_transactions
             WHERE user_id = p_user_id
               AND transaction_type = v_effective_type
               AND created_at >= now() - make_interval(secs => p_cooldown_seconds)
        ) THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'Please wait before sending again',
                'cooldown_active', true
            );
        END IF;
    END IF;

    UPDATE public.profiles
       SET diamonds = diamonds - p_amount,
           diamond_balance = diamonds - p_amount,
           updated_at = now()
     WHERE id = p_user_id
     RETURNING diamonds INTO v_new_balance;

    -- DIAMOND-RULINGS 1: purchased lots are consumed FIFO before promotional balance at every
    -- sink, so a refund or chargeback knows what is left of what was paid for.
    PERFORM public.fn_ca_consume_purchase_lots(p_user_id, p_amount);

    INSERT INTO public.diamond_transactions
        (user_id, amount, transaction_type, type, description, balance_after, metadata,
         reference_id, created_at, counterparty, issuance_class)
    VALUES
        (p_user_id, -p_amount, v_effective_type, v_effective_type, p_description,
         v_new_balance, p_metadata, p_reference_id, now(), v_counterparty, v_issuance_class);

    RETURN jsonb_build_object(
        'success', true,
        'balance', v_new_balance,
        'charged', p_amount,
        'transaction_type', v_effective_type,
        'reference_id', p_reference_id,
        'counterparty', v_counterparty,
        'issuance_class', v_issuance_class,
        'idempotent', false
    );
END;
$function$
;
DO $w$ BEGIN IF md5(pg_get_functiondef('public.deduct_diamonds(uuid,integer,text,text,text,jsonb,text,integer)'::regprocedure))<>'2e09367262d69d11380e3b649c3235c1' THEN RAISE EXCEPTION 'Deduct preimage differs'; END IF; END $w$;
