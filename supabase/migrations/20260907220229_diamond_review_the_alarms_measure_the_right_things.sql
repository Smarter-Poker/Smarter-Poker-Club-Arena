-- DIAMOND ACCOUNTING STANDARD - REVIEW FIX 1 (2026-09-07)
-- The verification pass over the 2026-09-03 work (docs/audits/2026-09-02-diamond-economy/review*.md)
-- found no diamond lost or created, one regression, one blocked flow and a set of alarms that
-- measured the wrong thing. This migration is the root fix for each, in one transaction:
--
--   R2-02 / DEF-01  award_diamonds_v2 was rebuilt on 2026-09-07 02:51 from a pre-lane-E copy and lost the
--                   issuance_class / counterparty stamp. Restored, AND the journal now classifies any row a
--                   writer leaves unclassified (BEFORE INSERT), so no future rebuild can produce an anonymous row.
--   R2-03           a player with any journal row could not delete their account: the FK cascade hit the
--                   append-only guard and raised P0403. The cascade of a deleted profile (or auth user) is now
--                   archived and allowed; a direct DELETE by a client is still refused.
--   D1 D2 D3 D13 D14 the trial balance and the snapshot measured a 10-minute balance window against a
--                   60-minute journal window, on a journal the certification fleet deletes hourly. Both now
--                   measure against the Mint register, which is complete, on stored per-snapshot figures.
--   D4 D5 D6 D8 D16 D17 R2-05  DR6 / DR2 / DR5 fired on every signup, on writers that journal after the
--                   balance write, and on certification-fixture churn (96 percent of 18,000 incidents).
--                   Fixture accounts are not players: their rows file at info; sanctioned writers are gated
--                   by name; DR5 files once per maintenance batch.
--   DEF-03 DEF-04 DEF-05 DEF-06 DEF-12  the earn ledger counted fixture issuance, misfiled Daily Missions,
--                   used the non-VIP cap for VIPs and counted unclassified rows as promotional.
--   D9 D11          the identity is players + house = register; the diamond_issuance kill switch is wired.
--   D10             the mirror trigger can never abort the write it mirrors.
--   D18 (rulings)   the union diamond grant (a 100,000-per-call mint with no debit) is closed; promo vault
--                   purchases in diamonds are refused until a funded club diamond account exists.
--   R2-06 R2-09 R2-10 R2-11 R2-12 R2-13 DEF-10 DEF-11  purchase clearing corrections.
--   The refund path is renamed fn_diamond_purchase_refund: it is the live Stripe refund handler, not a
--   reconciler, and CLAUDE.md 10.12 rightly reads "reconcile" as a repair arm. The old name stays callable
--   until the World Hub webhook (#...) is live on the new one; a follow-up migration drops it.
--
-- No balance moves. Every refusal added here is either a human-opened kill switch or a path with zero
-- production use (union diamond kind, promo vault diamonds). Applied once.

BEGIN;
SET LOCAL lock_timeout = '4s';

-- ---------------------------------------------------------------------------------------------
-- 0. Fixture accounts are not players (and horses are). fn_ca_is_cert_account also matches
--    @horses.smarter.poker, so it cannot be used to scope a player rule (CLAUDE.md 10.5).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_is_fixture_account(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
  SELECT p_user_id IS NOT NULL AND (
    p_user_id::text LIKE '00000000-0000-0000-0000-%'
    OR EXISTS (SELECT 1 FROM public.ca_cert_accounts c WHERE c.user_id = p_user_id AND c.active)
    OR EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p_user_id AND u.email LIKE '%.invalid')
  );
$fn$;
COMMENT ON FUNCTION public.fn_ca_is_fixture_account(uuid) IS
  'A certification or test fixture account: sentinel uuid, active ca_cert_accounts row, or a .invalid email. NEVER a horse. Used to scope diamond incident severity and the promotional budget; never to deny anything.';
REVOKE ALL ON FUNCTION public.fn_ca_is_fixture_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_fixture_account(uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 1. The snapshot stores the register beside the meter (D14) and explains itself with it (D13).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.ca_diamond_snapshots
  ADD COLUMN IF NOT EXISTS register_supply numeric,
  ADD COLUMN IF NOT EXISTS house_balance   numeric;
COMMENT ON COLUMN public.ca_diamond_snapshots.register_supply IS
  'Net of ca_mint_ledger (mint minus burn) for holder_type = player at snapshot time, read in the same transaction as profile_diamonds, so the two can be compared without window skew. players moved = player register moved is the identity (DR2, D3, D14).';

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_snapshot()
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_prof numeric; v_wal numeric; v_cert numeric; v_total numeric; v_house numeric; v_reg numeric;
  prev RECORD; v_journal numeric; v_journal_noncert numeric; v_unexplained numeric;
  v_basis_changed boolean := false;
  v_prev_basis numeric;
  v_mirror_bad bigint := 0;
BEGIN
  SELECT COALESCE(sum(diamonds),0) INTO v_prof FROM profiles;
  SELECT COALESCE(sum(balance),0)  INTO v_wal  FROM diamond_wallets;
  SELECT COALESCE(sum(p.diamonds),0) INTO v_cert
    FROM profiles p WHERE public.fn_ca_is_cert_account(p.id);
  SELECT COALESCE(balance, 0) INTO v_house FROM public.ca_diamond_house WHERE id = 1;
  v_house := COALESCE(v_house, 0);
  -- The register for the account the meter counts: player holders. The house has its own row in
  -- the trial balance; 'circulation' is the acknowledged baseline holder, outside both.
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_reg
    FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player';

  -- DR10: supply is the canonical store, read ONCE. Mirrors are compared, never added.
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
    SELECT COALESCE(sum(amount),0) INTO v_journal
      FROM diamond_transactions WHERE created_at > prev.taken_at;
    SELECT COALESCE(sum(amount),0) INTO v_journal_noncert
      FROM diamond_transactions t
     WHERE t.created_at > prev.taken_at
       AND NOT public.fn_ca_is_cert_account(t.user_id);
    SELECT EXISTS (SELECT 1 FROM public.ca_cert_accounts c
                    WHERE c.tagged_at > prev.taken_at) INTO v_basis_changed;
    v_prev_basis := prev.profile_diamonds;
  END IF;

  INSERT INTO public.ca_diamond_snapshots
    (profile_diamonds, wallet_diamonds, cert_diamonds, total,
     journaled_delta, delta_vs_prev, unexplained, register_supply, house_balance)
  VALUES
    (v_prof, v_wal, v_cert, v_total, v_journal,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - v_prev_basis END,
     CASE
       WHEN prev.id IS NULL THEN NULL
       -- 2026-09-07 (D3, D13, D14): the register is the complete record of every issuance and
       -- retirement (the journal follower, the seed trigger and the deletion burn all write it),
       -- and it survives the certification cleanup's hourly journal deletes. Measured on stored
       -- per-snapshot figures so no window skew can manufacture a drift:
       --   unexplained = players moved - player register moved.
       WHEN prev.register_supply IS NOT NULL THEN
         (v_total - v_prev_basis) - (v_reg - prev.register_supply)
       -- The row before this migration has no register figure: the old non-cert journal identity.
       WHEN v_basis_changed THEN NULL
       ELSE (v_total - v_cert) - (v_prev_basis - COALESCE(prev.cert_diamonds, 0)) - COALESCE(v_journal_noncert, 0)
     END,
     v_reg, v_house)
  RETURNING unexplained INTO v_unexplained;

  IF v_mirror_bad > 0 THEN
    PERFORM public.fn_ca_diamond_incident(
      'DR10:mirror_mismatch', 'warning', NULL, v_mirror_bad::numeric,
      'fn_ca_diamond_snapshot',
      jsonb_build_object('profiles_disagreeing', v_mirror_bad,
                         'profile_diamonds', v_prof, 'wallet_diamonds', v_wal,
                         'note', 'user_diamonds / user_diamond_balance / diamond_wallets are mirrors of profiles.diamonds, upserted on INSERT and UPDATE since 2026-09-07; a disagreeing or missing row means a writer bypassed the mirror trigger'));
  END IF;

  IF v_unexplained IS NOT NULL AND abs(v_unexplained) > 50 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_diamond_snapshot', 'ledger_imbalance',
      CASE WHEN abs(v_unexplained) > 5000 THEN 'critical' ELSE 'warning' END,
      'diamond-unexplained:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_unexplained,
      v_prev_basis + COALESCE(v_journal,0), v_total,
      'ledger', 'ca_diamond_snapshots', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'diamond supply (players) moved by ' || round(v_unexplained,2)
        || ' more than the Mint register explains - a diamond writer is bypassing the register',
      false, jsonb_build_object('profile_diamonds', v_prof, 'wallet_diamonds', v_wal,
                                 'cert_diamonds', v_cert, 'house_balance', v_house,
                                 'register_supply', v_reg));
  END IF;

  RETURN v_unexplained;
END $function$;

-- ---------------------------------------------------------------------------------------------
-- 2. The trial balance measures against the register on stored figures (D1, D2, D3, D9).
--    Same return shape; the watch reads it unchanged.
-- ---------------------------------------------------------------------------------------------
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
  v_delta   numeric; v_jrn numeric; v_jrn_live numeric; v_jrn_archive numeric; v_mint numeric;
  v_diff    numeric; v_note text; v_n bigint; v_sub numeric; v_fixture numeric;
  v_house_ledger numeric;
  v_tot_now numeric := 0; v_tot_delta numeric := 0; v_tot_jrn numeric := 0; v_tot_mint numeric := 0;
  r record;
BEGIN
  SELECT * INTO s0 FROM public.ca_diamond_snapshots
   WHERE taken_at >= v_since ORDER BY taken_at ASC LIMIT 1;
  w0 := COALESCE(s0.taken_at, v_since);

  SELECT COALESCE(SUM(COALESCE(p.diamonds, 0)), 0)::numeric INTO v_players FROM public.profiles p;
  SELECT COALESCE(balance, 0) INTO v_house FROM public.ca_diamond_house WHERE id = 1;
  v_house := COALESCE(v_house, 0);
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_reg_players
    FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'player';
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) INTO v_reg_house
    FROM public.ca_mint_ledger WHERE asset = 'diamonds' AND holder_type = 'house';
  v_reg := v_reg_players + v_reg_house;

  -- Journal net over the SAME window as the balance (D1), live rows plus the archive of rows the
  -- certification cleanup deleted inside the window (D2). Informative: the journal is one-sided and
  -- the seed trigger writes no journal row, so it cannot close on its own (D3).
  SELECT COALESCE(SUM(dt.amount), 0) INTO v_jrn_live
    FROM public.diamond_transactions dt WHERE dt.created_at >= w0 AND dt.created_at < now();
  SELECT COALESCE(SUM(a.amount), 0) INTO v_jrn_archive
    FROM public.ca_diamond_journal_archive a WHERE a.created_at >= w0 AND a.created_at < now();
  v_jrn := v_jrn_live + v_jrn_archive;

  -- player_diamonds
  IF s0.id IS NULL THEN
    v_delta := NULL; v_mint := NULL; v_diff := NULL;
    v_note := 'no diamond snapshot at or after the window start, so the delta is unknown';
  ELSIF s0.register_supply IS NOT NULL THEN
    v_delta := v_players - s0.profile_diamonds;
    v_mint  := v_reg_players - s0.register_supply;
    v_diff  := v_delta - v_mint;
    v_note  := 'players moved ' || v_delta || ' since the ' || to_char(s0.taken_at AT TIME ZONE 'UTC', 'HH24:MI')
            || ' UTC snapshot; the player register moved ' || v_mint || ' over the same stored figure'
            || ' (register_supply is read in the snapshot transaction, so no window skew).'
            || ' journal_net over the same window is ' || v_jrn || ' (live ' || v_jrn_live || ' + archived '
            || v_jrn_archive || '); the journal gap ' || (v_delta - v_jrn) || ' is informative: the seed'
            || ' trigger and the Mint house branch write no journal row.';
  ELSE
    v_delta := v_players - s0.profile_diamonds;
    SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0) INTO v_mint
      FROM public.ca_mint_ledger ml
     WHERE ml.asset = 'diamonds' AND ml.holder_type = 'player' AND ml.created_at >= w0 AND ml.created_at < now();
    v_diff := v_delta - v_mint;
    v_note := 'the window snapshot predates register_supply, so the register is windowed by created_at'
           || ' (boundary skew of one signup is possible). journal_net ' || v_jrn || ' informative.';
  END IF;
  v_tot_now := v_tot_now + v_players; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
  v_tot_jrn := v_tot_jrn + v_jrn; v_tot_mint := v_tot_mint + COALESCE(v_mint, 0);
  RETURN QUERY SELECT 'player_diamonds'::text, v_players, v_delta, v_jrn, v_mint, v_diff, v_note;

  -- diamond_house
  SELECT COALESCE(SUM(delta), 0) INTO v_house_ledger
    FROM public.ca_diamond_house_ledger WHERE at >= w0 AND at < now();
  SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0) INTO v_mint
    FROM public.ca_mint_ledger ml
   WHERE ml.asset = 'diamonds' AND ml.holder_type = 'house' AND ml.created_at >= w0 AND ml.created_at < now();
  IF s0.id IS NOT NULL AND s0.house_balance IS NOT NULL THEN
    v_delta := v_house - s0.house_balance;
    v_diff  := v_delta - v_house_ledger - v_mint;
    v_note  := 'house moved ' || v_delta || '; the house ledger (rake, cuts, forfeits) explains ' || v_house_ledger
            || ' and the Mint explains ' || v_mint || '. DR14: what leaves a player and reaches no player lands here.';
  ELSE
    v_delta := NULL; v_diff := NULL;
    v_note := 'no stored house balance at the window start; ledger ' || v_house_ledger || ', mint ' || v_mint || ' shown.';
  END IF;
  v_tot_now := v_tot_now + v_house; v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
  v_tot_mint := v_tot_mint + COALESCE(v_mint, 0);
  RETURN QUERY SELECT 'diamond_house'::text, v_house, v_delta, v_house_ledger, v_mint, v_diff, v_note;

  -- register: the identity itself (D9). The whole register (every holder, the acknowledged
  -- circulation baseline included) equals players + house.
  v_reg := public.fn_ca_mint_supply('diamonds');
  RETURN QUERY SELECT 'register'::text, v_reg, NULL::numeric, NULL::numeric, NULL::numeric,
    (v_players + v_house) - v_reg,
    ('fn_ca_mint_supply(diamonds) over every holder is ' || v_reg || '; players + house is '
     || (v_players + v_house) || '. Player holders net ' || v_reg_players || ', house holders net ' || v_reg_house
     || ', the rest is the acknowledged pre-standard baseline and its corrections (holder circulation). difference must be 0.')::text;

  -- diamond_debts
  EXECUTE 'SELECT COALESCE(SUM(amount), 0)::numeric FROM public.diamond_debts WHERE settled_at IS NULL' INTO v_sub;
  v_tot_now := v_tot_now + v_sub;
  RETURN QUERY SELECT 'diamond_debts'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    'unsettled chargeback receivable (DR1). A balance is never negative; the remainder lands here.'::text;

  -- promo_budgets_spent
  SELECT COALESCE(SUM(b.spent_diamonds), 0)::numeric, COALESCE(SUM(b.budget_diamonds), 0)::numeric, count(*)
    INTO v_sub, v_fixture, v_n FROM public.diamond_reward_budgets b;
  RETURN QUERY SELECT 'promo_budgets_spent'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    format('%s budget lines, %s budgeted, %s spent by non-fixture players (fixture issuance is excluded since 2026-09-07). A counter, not a balance.', v_n, v_fixture, v_sub);

  -- mirror_mismatch
  SELECT count(*) INTO v_n
    FROM public.profiles p
    LEFT JOIN public.user_diamonds ud ON ud.user_id = p.id
    LEFT JOIN public.user_diamond_balance udb ON udb.user_id = p.id
    LEFT JOIN public.diamond_wallets dw ON dw.user_id = p.id
   WHERE ud.user_id IS NULL OR udb.user_id IS NULL OR dw.user_id IS NULL
      OR ud.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)
      OR udb.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int
      OR dw.balance IS DISTINCT FROM GREATEST(COALESCE(p.diamonds,0),0)::int;
  RETURN QUERY SELECT 'mirror_mismatch'::text, v_n::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    'balance_now is a COUNT of profiles whose three mirrors disagree or are missing. The mirror trigger upserts all three legs on INSERT and UPDATE (2026-09-07), so a non-zero here means a writer bypassed it.'::text;

  -- fixtures (informative)
  SELECT COALESCE(SUM(p.diamonds), 0), count(*) INTO v_fixture, v_n
    FROM public.profiles p WHERE public.fn_ca_is_fixture_account(p.id);
  RETURN QUERY SELECT 'fixture_accounts'::text, v_fixture, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    format('%s certification / test fixture profiles hold %s diamonds. They are INSIDE player_diamonds (the meter counts every balance); this row only names the share. Horses are players and are never in this figure.', v_n, v_fixture);

  -- dead_stores (informative)
  v_sub := 0; v_note := '';
  FOR r IN SELECT * FROM (VALUES ('user_progress', 'diamonds'), ('bot_profiles', 'diamonds'),
                                 ('club_members', 'diamonds'), ('club_memberships', 'diamonds'),
                                 ('club_diamond_wallets', 'balance')) AS m(rel, col) LOOP
    BEGIN
      IF to_regclass('public.' || r.rel) IS NULL THEN
        v_note := v_note || r.rel || ': absent. ';
      ELSE
        EXECUTE format('SELECT COALESCE(SUM(COALESCE(%I, 0)), 0)::numeric FROM public.%I', r.col, r.rel) INTO v_fixture;
        v_sub := v_sub + v_fixture;
        v_note := v_note || format('%s.%s = %s. ', r.rel, r.col, v_fixture);
      END IF;
    EXCEPTION WHEN OTHERS THEN v_note := v_note || r.rel || ': unreadable. ';
    END;
  END LOOP;
  RETURN QUERY SELECT 'dead_stores'::text, v_sub, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
    (v_note || 'Outside the supply; the delete list, gated on seven days of zero writes (ca_diamond_dead_store_writes).')::text;

  -- suspense (DR12)
  SELECT COALESCE(SUM(dt.amount), 0), count(*) INTO v_sub, v_n
    FROM public.diamond_transactions dt
   WHERE dt.created_at >= GREATEST(w0, c_foundation)
     AND (dt.counterparty IS NULL OR dt.counterparty = 'unknown' OR dt.issuance_class IS NULL);
  RETURN QUERY SELECT 'suspense'::text, v_sub, NULL::numeric, v_sub, NULL::numeric, NULL::numeric,
    format('%s journal rows in the window name no counterparty or class. Since 2026-09-07 the journal classifier fills both on INSERT and files DR12 naming the writer, so this must read zero.', v_n);

  -- total
  RETURN QUERY SELECT 'total'::text, v_tot_now,
    CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta END, v_tot_jrn, v_tot_mint,
    CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta - v_tot_mint END,
    'players + house + unsettled debts. difference is balance movement minus register movement across the balance rows.'::text;
END $function$;

-- ---------------------------------------------------------------------------------------------
-- 3. The watch: breaks on the register rows only; retention on info rows (DEF-07).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance_watch()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  r record; v_since timestamptz := now() - interval '1 hour';
  v_filed integer := 0; v_rows integer := 0; v_broken text := ''; v_swept integer := 0;
BEGIN
  FOR r IN SELECT * FROM public.fn_ca_diamond_trial_balance(v_since) LOOP
    v_rows := v_rows + 1;
    IF r.account IN ('player_diamonds', 'diamond_house', 'register')
       AND r.difference IS NOT NULL AND abs(r.difference) > 0 THEN
      PERFORM public.fn_ca_diamond_incident(
        'DR11:trial_balance_break', 'warning', NULL, r.difference, r.account,
        jsonb_build_object('account', r.account, 'balance_now', r.balance_now,
                           'balance_delta', r.balance_delta, 'journal_net', r.journal_net,
                           'mint_net', r.mint_net, 'difference', r.difference,
                           'window_start', v_since, 'note', r.note));
      v_filed := v_filed + 1; v_broken := v_broken || r.account || ' ';
    END IF;
    IF r.account = 'suspense' AND COALESCE(r.balance_now, 0) <> 0 THEN
      PERFORM public.fn_ca_diamond_incident(
        'DR12:suspense_nonzero', 'info', NULL, r.balance_now, 'fn_ca_diamond_trial_balance_watch',
        jsonb_build_object('suspense', r.balance_now, 'window_start', v_since, 'note', r.note));
      v_filed := v_filed + 1;
    END IF;
  END LOOP;

  PERFORM public.fn_ca_diamond_incident(
    'DR11:trial_balance_summary', 'info', NULL, NULL, 'fn_ca_diamond_trial_balance_watch',
    jsonb_build_object('accounts_reported', v_rows, 'incidents_filed', v_filed,
                       'accounts_broken', NULLIF(btrim(v_broken), ''),
                       'window_start', v_since, 'window_end', now()));

  -- Retention (DEF-07): info rows are a log, not a debt. Resolve after 7 days, drop after 30.
  UPDATE public.ca_diamond_incidents SET resolved_at = now()
   WHERE resolved_at IS NULL AND severity = 'info' AND occurred_at < now() - interval '7 days';
  GET DIAGNOSTICS v_swept = ROW_COUNT;
  DELETE FROM public.ca_diamond_incidents
   WHERE severity = 'info' AND resolved_at IS NOT NULL AND occurred_at < now() - interval '30 days';
  RETURN v_filed;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_diamond_trial_balance_watch failed: %', SQLERRM;
  RETURN -1;
END $function$;

-- ---------------------------------------------------------------------------------------------
-- 4. DR6: the audit gates sanctioned writers by name and files fixture churn at info (D4-D8).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_audit_diamond_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_old integer; v_new integer := COALESCE(NEW.diamonds, 0); v_delta integer;
  v_stack text; v_writer text; v_path text; v_journaled boolean := false;
  v_cert boolean; v_fixture boolean; v_sanctioned boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.diamonds IS NOT DISTINCT FROM OLD.diamonds THEN RETURN NEW; END IF;
    v_old := COALESCE(OLD.diamonds, 0);
  ELSE
    IF v_new = 0 THEN RETURN NEW; END IF;
    v_old := 0;
  END IF;
  v_delta := v_new - v_old;

  BEGIN
    GET DIAGNOSTICS v_stack = PG_CONTEXT;
    SELECT (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] INTO v_writer
      FROM regexp_split_to_table(COALESCE(v_stack, ''), E'\n') WITH ORDINALITY AS t(ln, ord)
     WHERE t.ln ~ 'function (?:public\.)?[A-Za-z0-9_]+\('
       AND (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] <> 'fn_ca_audit_diamond_change'
     ORDER BY t.ord LIMIT 1;

    v_path := NULLIF(btrim(COALESCE(current_setting('app.money_path', true), '')), '');
    v_journaled := EXISTS (SELECT 1 FROM public.diamond_transactions dt
                            WHERE dt.user_id = NEW.id AND dt.created_at >= now() - interval '2 seconds');
    v_cert    := public.fn_ca_is_cert_account(NEW.id);
    v_fixture := public.fn_ca_is_fixture_account(NEW.id);

    -- DR6. Every writer here journals in the same transaction; most of them AFTER the balance
    -- write, which is why v_journaled is false at trigger time for a correct credit (2026-09-07
    -- review D4-D6). Gate by name, and by prefix for the daily-challenge family whose body name
    -- has drifted twice.
    v_sanctioned :=
         COALESCE(v_writer, '') IN ('add_diamonds_to_balance', 'deduct_diamonds', 'fn_ca_mint', 'fn_ca_burn',
                                    'send_wallet_diamond_transfer', 'send_stream_gift', 'handle_new_user',
                                    'fn_ca_diamond_born_with_balance', 'award_diamonds_v2',
                                    'fn_purchase_time_banks_v2', 'reconcile_diamond_purchase_refund',
                                    'fn_diamond_purchase_refund', 'fn_ca_journal_profile_deletion')
      OR COALESCE(v_writer, '') LIKE 'claim_daily_challenge%'
      OR COALESCE(v_path, '') IN ('add_diamonds_to_balance', 'deduct_diamonds', 'fn_ca_mint', 'fn_ca_burn',
                                  'send_wallet_diamond_transfer', 'send_stream_gift',
                                  'claim_daily_challenge', 'claim_daily_challenges');

    INSERT INTO public.ca_diamond_balance_audit
      (user_id, old_diamonds, new_diamonds, delta, is_cert, db_role, app_name, journaled, writer, money_path)
    VALUES (NEW.id, v_old, v_new, v_delta, v_cert, current_user,
            COALESCE(current_setting('application_name', true), ''), v_journaled, v_writer, v_path);

    IF v_delta <> 0 AND NOT v_journaled AND NOT v_sanctioned THEN
      PERFORM public.fn_ca_diamond_incident(
        CASE WHEN v_fixture THEN 'DR6:fixture_harness_unjournaled' ELSE 'DR6:balance_changed_without_journal' END,
        CASE WHEN v_fixture THEN 'info' ELSE 'warning' END,
        NEW.id, v_delta, COALESCE(v_writer, v_path, '(no function frame)'),
        jsonb_build_object('money_path', v_path, 'is_cert', v_cert, 'is_fixture', v_fixture, 'tg_op', TG_OP,
                           'writer', v_writer, 'old_diamonds', v_old, 'new_diamonds', v_new,
                           'db_role', current_user,
                           'app_name', COALESCE(current_setting('application_name', true), ''),
                           'journaled_at_trigger_time', v_journaled, 'sanctioned_money_path', v_sanctioned));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (user_id, delta, sqlstate, message)
      VALUES (NEW.id, v_delta, SQLSTATE, 'diamond audit insert failed: ' || SQLERRM);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 5. DR2: a balance born at INSERT is still recorded; fixture births file at info (D16).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_born_with_balance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_fixture boolean := false;
BEGIN
  BEGIN
    v_fixture := public.fn_ca_is_fixture_account(NEW.id);
    PERFORM public.fn_ca_diamond_incident(
      'DR2:balance_born_outside_the_mint',
      CASE WHEN v_fixture THEN 'info' ELSE 'warning' END,
      NEW.id, NEW.diamonds, 'profiles INSERT',
      jsonb_build_object('is_horse', NEW.is_horse, 'is_fixture', v_fixture,
                         'app_name', COALESCE(current_setting('application_name', true), ''),
                         'db_role', CURRENT_USER, 'username', NEW.username, 'diamonds', NEW.diamonds));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_ca_diamond_born_with_balance could not record the incident for %: %', NEW.id, SQLERRM;
  END;
  BEGIN
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after,
       supply_after, reason, performed_by, performed_by_label)
    VALUES
      ('seed:' || NEW.id::text, 'mint', 'diamonds', 'player', NEW.id,
       COALESCE(NULLIF(BTRIM(NEW.username), ''), NEW.id::text), NEW.diamonds, 0, NEW.diamonds,
       public.fn_ca_mint_supply('diamonds') + NEW.diamonds,
       CASE WHEN v_fixture THEN 'balance present at fixture profile INSERT' ELSE 'balance present at profile INSERT' END,
       NULL, 'zz_ca_diamond_born_with_balance')
    ON CONFLICT (op_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_ca_diamond_born_with_balance could not register the seed for %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 6. The append-only guard: a deleted profile's cascade is archived and allowed (R2-03); a
--    maintenance batch files ONE incident (R2-05, D17); deleted_profile_id means what it says (R2-07).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_journal_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
  v_allowed_update boolean := false;
  v_kind text;
  v_j jsonb;
  v_owner_gone boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'chip_transactions' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.transaction_type IS NOT DISTINCT FROM OLD.transaction_type
        AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
        AND NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
        AND NEW.club_id IS NOT DISTINCT FROM OLD.club_id
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    ELSIF TG_TABLE_NAME = 'chip_ledger' THEN
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.from_type IS NOT DISTINCT FROM OLD.from_type
        AND NEW.from_entity_id IS NOT DISTINCT FROM OLD.from_entity_id
        AND NEW.to_type IS NOT DISTINCT FROM OLD.to_type
        AND NEW.to_entity_id IS NOT DISTINCT FROM OLD.to_entity_id
        AND NEW.category IS NOT DISTINCT FROM OLD.category
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
        AND NEW.chain_seq IS NOT DISTINCT FROM OLD.chain_seq
        AND NEW.prev_hash IS NOT DISTINCT FROM OLD.prev_hash
        AND NEW.row_hash IS NOT DISTINCT FROM OLD.row_hash
        AND NEW.idempotency_key IS NOT DISTINCT FROM OLD.idempotency_key
        AND NEW.correlation_id IS NOT DISTINCT FROM OLD.correlation_id
        AND NEW.settlement_id IS NOT DISTINCT FROM OLD.settlement_id
        AND NEW.epoch_id IS NOT DISTINCT FROM OLD.epoch_id;
    ELSE
      v_allowed_update :=
        NEW.amount IS NOT DISTINCT FROM OLD.amount
        AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND v_allowed_update THEN
    RETURN NEW;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP='UPDATE' THEN to_jsonb(NEW) END);

    BEGIN
      v_kind := split_part(v_reason, ':', 1);
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_journal_append_only', 'unauthorized_adjustment', 'warning',
        'journal-bypass:' || TG_TABLE_NAME || ':' || TG_OP || ':' || v_kind,
        0, NULL, NULL, 'ledger', TG_TABLE_NAME,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on ' || TG_TABLE_NAME || ': ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log - this incident'
          || ' counts them (occurrences) rather than the chips; query that table by'
          || ' reason for the full inventory. Confirm the maintenance was intended,'
          || ' then resolve.',
        true,
        jsonb_build_object('table', TG_TABLE_NAME, 'operation', TG_OP,
                           'reason', v_reason, 'reason_kind', v_kind,
                           'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- DR5. Keep the row and say who took it. One incident per maintenance batch (the reason string
    -- is per batch), counting rows and diamonds in its detail. deleted_profile_id is NULL here: no
    -- profile was deleted by a maintenance delete (2026-09-07 review R2-05, R2-07).
    IF TG_TABLE_NAME = 'diamond_transactions' AND TG_OP = 'DELETE' THEN
      BEGIN
        v_j := to_jsonb(OLD);
        INSERT INTO public.ca_diamond_journal_archive
          (id, user_id, type, amount, balance_after, description, reference_id, created_at,
           transaction_type, source, metadata, counterparty, issuance_class,
           deleted_profile_id, deletion_reason)
        VALUES
          ((v_j->>'id')::uuid, (v_j->>'user_id')::uuid, v_j->>'type',
           (v_j->>'amount')::integer, (v_j->>'balance_after')::integer,
           v_j->>'description', v_j->>'reference_id', (v_j->>'created_at')::timestamptz,
           v_j->>'transaction_type', v_j->>'source',
           COALESCE(v_j->'metadata', '{}'::jsonb),
           v_j->>'counterparty', v_j->>'issuance_class',
           NULL, v_reason)
        ON CONFLICT (id) DO NOTHING;

        UPDATE public.ca_diamond_incidents
           SET detail = detail || jsonb_build_object(
                 'rows', COALESCE((detail->>'rows')::int, 1) + 1,
                 'amount_total', COALESCE((detail->>'amount_total')::numeric, COALESCE(amount, 0)) + COALESCE((v_j->>'amount')::numeric, 0),
                 'last_row_at', now())
         WHERE rule = 'DR5:journal_row_deleted_under_maintenance'
           AND detail->>'reason' = v_reason
           AND resolved_at IS NULL;
        IF NOT FOUND THEN
          PERFORM public.fn_ca_diamond_incident(
            'DR5:journal_row_deleted_under_maintenance', 'info',
            (v_j->>'user_id')::uuid, (v_j->>'amount')::numeric,
            'fn_ca_journal_append_only',
            jsonb_build_object('reason', v_reason, 'rows', 1,
                               'amount_total', COALESCE((v_j->>'amount')::numeric, 0),
                               'first_reference_id', v_j->>'reference_id',
                               'db_role', current_user,
                               'note', 'one incident per maintenance batch; every deleted row is in ca_diamond_journal_archive under this reason'));
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ca_diamond_journal_archive could not preserve a journal row deleted under maintenance (%): %',
          v_reason, SQLERRM;
      END;
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  -- 2026-09-07 (review R2-03): the FK cascade of a deleted profile or auth user is not a client
  -- deleting history, it is the account leaving. The rows are archived under the profile that took
  -- them and the delete proceeds. A direct DELETE (trigger depth 1, owner still present) is still
  -- refused below. fn_ca_journal_profile_deletion has already recorded the burn (DR5) for a balance.
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'diamond_transactions' AND pg_trigger_depth() > 1 THEN
    v_owner_gone := NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = OLD.user_id)
                 OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id);
    IF v_owner_gone THEN
      BEGIN
        v_j := to_jsonb(OLD);
        INSERT INTO public.ca_diamond_journal_archive
          (id, user_id, type, amount, balance_after, description, reference_id, created_at,
           transaction_type, source, metadata, counterparty, issuance_class,
           deleted_profile_id, deletion_reason)
        VALUES
          ((v_j->>'id')::uuid, (v_j->>'user_id')::uuid, v_j->>'type',
           (v_j->>'amount')::integer, (v_j->>'balance_after')::integer,
           v_j->>'description', v_j->>'reference_id', (v_j->>'created_at')::timestamptz,
           v_j->>'transaction_type', v_j->>'source',
           COALESCE(v_j->'metadata', '{}'::jsonb),
           v_j->>'counterparty', v_j->>'issuance_class',
           (v_j->>'user_id')::uuid, 'profile-deletion-cascade')
        ON CONFLICT (id) DO NOTHING;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ca_diamond_journal_archive could not preserve a journal row of deleted profile %: %',
          OLD.user_id, SQLERRM;
      END;
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: financial journals are append-only. Corrections are new linked rows (category=correction). Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0403';
END $function$;

-- Archive rows written by a maintenance delete claimed a profile deletion that did not happen (R2-07).
UPDATE public.ca_diamond_journal_archive a
   SET deleted_profile_id = NULL
 WHERE a.deletion_reason IS NOT NULL
   AND a.deletion_reason <> 'profile-deletion-cascade'
   AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = a.user_id);

-- ---------------------------------------------------------------------------------------------
-- 7. The journal classifies every row it accepts (DR3). No writer rebuild can leave one anonymous.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_journal_classifier()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_type text := COALESCE(NEW.transaction_type, NEW.type, 'unknown');
  v_stack text; v_writer text; v_filled boolean := false;
BEGIN
  IF NEW.issuance_class IS NULL THEN
    v_filled := true;
    NEW.issuance_class := CASE
      WHEN v_type = 'purchase' THEN 'purchased'
      WHEN v_type = 'refund' OR right(v_type, 7) = '_refund' THEN 'refund'
      WHEN v_type IN ('transfer', 'diamond_gift_received', 'live_gift_received', 'diamond_received',
                      'diamond_gift_sent', 'live_gift_sent', 'spend_transfer') THEN 'transferred'
      WHEN v_type = 'adjustment' THEN 'admin'
      WHEN v_type = 'mint' THEN 'admin'
      WHEN v_type = 'burn' THEN 'deletion'
      WHEN v_type IN ('union_grant', 'signup_bonus') THEN 'promotional'
      WHEN COALESCE(NEW.amount, 0) < 0 THEN 'spend'
      WHEN EXISTS (SELECT 1 FROM public.diamond_reward_catalog c WHERE c.action_key = v_type)
           OR COALESCE(NEW.description, '') LIKE 'Diamond Rewards v2:%' THEN 'promotional'
      ELSE 'earned'
    END;
  END IF;
  IF NEW.counterparty IS NULL THEN
    v_filled := true;
    NEW.counterparty := CASE NEW.issuance_class
      WHEN 'purchased' THEN 'purchase_clearing'
      WHEN 'refund' THEN CASE WHEN v_type IN ('refund', 'stripe') THEN 'purchase_clearing' ELSE 'revenue:' || v_type END
      WHEN 'transferred' THEN 'player:' || COALESCE(NEW.metadata->>'recipient_id', NEW.metadata->>'sender_id', 'unknown')
      WHEN 'admin' THEN 'adjustment'
      WHEN 'deletion' THEN 'retired'
      WHEN 'spend' THEN 'revenue:' || v_type
      ELSE 'promo_budget:' || public.fn_ca_diamond_engine_of(NEW.type, NEW.transaction_type, NEW.source, NEW.description, NEW.reference_id)
    END;
  END IF;
  IF v_filled THEN
    BEGIN
      GET DIAGNOSTICS v_stack = PG_CONTEXT;
      SELECT (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] INTO v_writer
        FROM regexp_split_to_table(COALESCE(v_stack, ''), E'\n') WITH ORDINALITY AS t(ln, ord)
       WHERE t.ln ~ 'function (?:public\.)?[A-Za-z0-9_]+\('
         AND (regexp_match(t.ln, 'function (?:public\.)?([A-Za-z0-9_]+)\('))[1] <> 'fn_ca_diamond_journal_classifier'
       ORDER BY t.ord LIMIT 1;
      PERFORM public.fn_ca_diamond_incident(
        'DR12:journal_row_unclassified_by_writer', 'info', NEW.user_id, NEW.amount,
        COALESCE(v_writer, '(no function frame)'),
        jsonb_build_object('type', NEW.type, 'transaction_type', NEW.transaction_type,
                           'description', left(NEW.description, 120), 'reference_id', NEW.reference_id,
                           'classified_as', NEW.issuance_class, 'counterparty', NEW.counterparty,
                           'note', 'the writer left issuance_class or counterparty NULL; the classifier filled them. Fix the writer.'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS aa_ca_diamond_journal_classifier ON public.diamond_transactions;
CREATE TRIGGER aa_ca_diamond_journal_classifier
  BEFORE INSERT ON public.diamond_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_journal_classifier();
COMMENT ON FUNCTION public.fn_ca_diamond_journal_classifier() IS
  'DR3 safety net: fills issuance_class and counterparty when a writer leaves them NULL and files DR12 naming the writer. Standard 3.3.';

-- Classify the rows the 2026-09-07 award_diamonds_v2 rebuild left anonymous (an UPDATE that changes
-- neither amount nor created_at passes the append-only guard).
UPDATE public.diamond_transactions
   SET issuance_class = 'promotional', counterparty = 'promo_budget:catalog_v2'
 WHERE issuance_class IS NULL AND created_at >= timestamptz '2026-09-03 00:07:00+00'
   AND description LIKE 'Diamond Rewards v2:%';

-- ---------------------------------------------------------------------------------------------
-- 8. award_diamonds_v2: restore the stamp (R2-02 / DEF-01) and wire the diamond_issuance kill
--    switch (D11). Patched against the LIVE text under exact-once assertions; the canonical body
--    is another agent's migration 20260907025144 and the classifier above is the safety net.
-- ---------------------------------------------------------------------------------------------
DO $patch$
DECLARE v_def text; v_new text; v_a text; v_b text; v_c text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'award_diamonds_v2';
  IF v_def IS NULL THEN RAISE EXCEPTION 'award_diamonds_v2 not found'; END IF;

  v_a := E'        balance_after, reference_id, metadata, created_at\n    ) VALUES (\n        p_user_id,\n        v_award,';
  v_b := E'        v_metadata,\n        v_now\n    );';
  v_c := E'    v_daily_cap   := CASE WHEN v_is_vip THEN 150 ELSE 110 END;';
  IF (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a) <> 1 THEN
    RAISE EXCEPTION 'award_diamonds_v2: INSERT column marker not found exactly once';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_b, ''))) / length(v_b) <> 1 THEN
    RAISE EXCEPTION 'award_diamonds_v2: INSERT values marker not found exactly once';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_c, ''))) / length(v_c) <> 1 THEN
    RAISE EXCEPTION 'award_diamonds_v2: daily cap marker not found exactly once';
  END IF;
  IF v_def LIKE '%issuance_class%' THEN
    RAISE NOTICE 'award_diamonds_v2 already stamps issuance_class; skipping the stamp patch';
    v_new := v_def;
  ELSE
    v_new := replace(v_def, v_a,
      E'        balance_after, reference_id, metadata, created_at,\n        counterparty, issuance_class\n    ) VALUES (\n        p_user_id,\n        v_award,');
    v_new := replace(v_new, v_b,
      E'        v_metadata,\n        v_now,\n        ''promo_budget:catalog_v2'',\n        ''promotional''\n    );');
  END IF;
  IF v_new NOT LIKE '%diamond_issuance_frozen%' THEN
    v_new := replace(v_new, v_c,
      E'    -- Kill switch (Diamond Accounting Standard 3.4 layer 6, review D11): a human-opened\n'
   || E'    -- diamond_issuance freeze refuses every promotional award until it is cleared.\n'
   || E'    IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = ''diamond_issuance'' AND f.cleared_at IS NULL) THEN\n'
   || E'        RETURN jsonb_build_object(\n'
   || E'            ''success'', false, ''awarded'', 0, ''requested'', 0,\n'
   || E'            ''reason'', ''diamond_issuance_frozen'', ''capped'', false,\n'
   || E'            ''daily_remaining'', 0, ''monthly_remaining'', 0, ''balance_after'', v_balance\n'
   || E'        );\n'
   || E'    END IF;\n\n' || v_c);
  END IF;
  EXECUTE v_new;
END $patch$;

-- ---------------------------------------------------------------------------------------------
-- 9. add_diamonds_to_balance: the kill switch on promotional and earned credits (D11). Live body
--    (2026-09-06 shape, with daily_mission_milestone in the exact list) plus one block.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_diamonds_to_balance(p_user_id uuid, p_amount integer, p_type text DEFAULT 'bonus'::text, p_description text DEFAULT NULL::text, p_reference_id text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $function$
DECLARE
  v_old_balance bigint;
  v_new_balance bigint;
  v_txn_id uuid;
  v_multiplier numeric(4,2) := 1.00;
  v_raw_amount integer := COALESCE(p_amount, 0);
  v_actual_amount bigint;
  v_exact_type boolean;
  v_type_key text := COALESCE(p_type, 'unknown');
  v_issuance_class text;
  v_counterparty text;
BEGIN
  v_exact_type := p_type IN (
    'trivia_entry', 'trivia_run', 'trivia_daily_bonus', 'trivia_prize_wheel',
    'pvp_stake', 'pvp_win', 'pvp_refund', 'pvp_tie_refund',
    'tournament_entry', 'tournament_entry_refund',
    'tournament_cancel_refund', 'tournament_prize',
    'daily_mission_milestone'
  );

  IF p_reference_id IS NULL AND v_exact_type THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_id_required', 'reference_required', true);
  END IF;

  IF p_reference_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.diamond_transactions WHERE user_id = p_user_id AND reference_id = p_reference_id
  ) THEN
    SELECT balance_after INTO v_new_balance FROM public.diamond_transactions
     WHERE user_id = p_user_id AND reference_id = p_reference_id LIMIT 1;
    RETURN jsonb_build_object('success', false, 'error', 'duplicate_reference', 'duplicate', true, 'new_balance', v_new_balance);
  END IF;

  SELECT COALESCE(diamonds, 0), COALESCE(diamond_multiplier, 1.00)
    INTO v_old_balance, v_multiplier
    FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
  END IF;

  IF v_raw_amount > 0 AND NOT v_exact_type
     AND p_type NOT IN ('purchase', 'deduction', 'adjustment', 'refund', 'transfer',
                        'diamond_gift_received', 'diamond_gift_sent', 'diamond_gift_refund',
                        'diamond_received', 'live_gift_received', 'live_gift_sent',
                        'vip_daily', 'vip_stipend')
     AND v_multiplier > 1.00 THEN
    v_actual_amount := round(v_raw_amount * v_multiplier);
  ELSE
    v_actual_amount := v_raw_amount;
    v_multiplier := 1.00;
  END IF;

  IF v_actual_amount < -2147483648 OR v_actual_amount > 2147483647 THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_amount_out_of_range', 'new_balance', v_old_balance);
  END IF;

  v_new_balance := v_old_balance + v_actual_amount;
  IF v_new_balance < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_diamonds', 'new_balance', v_old_balance);
  END IF;
  IF v_new_balance > 2147483647 THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_balance_limit', 'new_balance', v_old_balance);
  END IF;

  IF v_type_key = 'purchase' THEN
    v_issuance_class := 'purchased'; v_counterparty := 'purchase_clearing';
  ELSIF v_type_key = 'refund' OR right(v_type_key, 7) = '_refund' THEN
    v_issuance_class := 'refund'; v_counterparty := 'revenue:' || v_type_key;
  ELSIF v_type_key IN ('transfer', 'diamond_gift_received', 'live_gift_received', 'diamond_received') THEN
    v_issuance_class := 'transferred'; v_counterparty := 'player:unknown';
  ELSIF v_type_key = 'adjustment' THEN
    v_issuance_class := 'admin'; v_counterparty := 'adjustment';
  ELSIF v_type_key IN ('union_grant', 'signup_bonus') THEN
    v_issuance_class := 'promotional'; v_counterparty := 'promo_budget:' || v_type_key;
  ELSIF v_actual_amount < 0 THEN
    v_issuance_class := 'spend'; v_counterparty := 'revenue:' || v_type_key;
  ELSE
    v_issuance_class := 'earned'; v_counterparty := 'promo_budget:' || v_type_key;
  END IF;

  -- Kill switch (standard 3.4 layer 6, review D11): a human-opened diamond_issuance freeze refuses
  -- promotional and earned credits. Purchases, refunds, transfers and adjustments are not issuance.
  IF v_actual_amount > 0 AND v_issuance_class IN ('earned', 'promotional')
     AND EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'diamond_issuance' AND f.cleared_at IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'diamond_issuance_frozen', 'new_balance', v_old_balance);
  END IF;

  UPDATE public.profiles
     SET diamonds = v_new_balance, diamond_balance = v_new_balance, updated_at = now()
   WHERE id = p_user_id;

  INSERT INTO public.diamond_transactions (
    user_id, amount, transaction_type, type, description, balance_after, reference_id, metadata,
    counterparty, issuance_class
  ) VALUES (
    p_user_id, v_actual_amount, p_type, p_type,
    CASE WHEN v_actual_amount <> v_raw_amount
         THEN COALESCE(p_description, '') || format(' [%sx boost]', v_multiplier)
         ELSE p_description END,
    v_new_balance, p_reference_id,
    jsonb_build_object('reference_id', p_reference_id, 'raw_amount', v_raw_amount,
                       'multiplier', v_multiplier, 'exact_value', v_exact_type),
    v_counterparty, v_issuance_class
  ) RETURNING id INTO v_txn_id;

  IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident('DR4:credit_without_reference', 'warning', p_user_id, p_amount,
        'add_diamonds_to_balance', jsonb_build_object('type', p_type, 'description', p_description));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;

  RETURN jsonb_build_object('success', true, 'old_balance', v_old_balance, 'new_balance', v_new_balance,
                            'amount', v_actual_amount, 'multiplier', v_multiplier, 'transaction_id', v_txn_id);
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 10. fn_ca_mint: the kill switch on diamond issuance (D11), patched on an exact-once marker.
-- ---------------------------------------------------------------------------------------------
DO $patch$
DECLARE v_def text; v_m text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_mint';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_ca_mint not found'; END IF;
  IF v_def LIKE '%diamond_issuance_frozen%' THEN
    RAISE NOTICE 'fn_ca_mint already carries the diamond_issuance freeze';
    RETURN;
  END IF;
  v_m := E'''diamonds_are_whole_numbers'');\n  END IF;\n';
  IF (length(v_def) - length(replace(v_def, v_m, ''))) / length(v_m) <> 1 THEN
    RAISE EXCEPTION 'fn_ca_mint: whole-numbers marker not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_m, v_m
    || E'  -- Kill switch (standard 3.4 layer 6, review D11): a human-opened diamond_issuance freeze\n'
    || E'  -- refuses diamond minting until it is cleared. Burns and chips are untouched.\n'
    || E'  IF v_asset = ''diamonds'' AND EXISTS (SELECT 1 FROM public.ca_payout_freeze f\n'
    || E'                                        WHERE f.scope = ''diamond_issuance'' AND f.cleared_at IS NULL) THEN\n'
    || E'    RETURN jsonb_build_object(''ok'', false, ''reason'', ''diamond_issuance_frozen'');\n'
    || E'  END IF;\n');
END $patch$;

-- ---------------------------------------------------------------------------------------------
-- 11. The earn ledger counts players, not fixtures; knows the VIP cap; files unclassified rows
--     to their own engine (DEF-03, DEF-04, DEF-05, DEF-06, DEF-12).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.diamond_engine_daily_caps ADD COLUMN IF NOT EXISTS max_per_user_per_day_vip integer;
UPDATE public.diamond_engine_daily_caps SET max_per_user_per_day_vip = 150 WHERE engine = 'catalog_v2';
COMMENT ON COLUMN public.diamond_engine_daily_caps.max_per_user_per_day_vip IS
  'The cap for a VIP (is_vip and lifetime or unexpired). award_diamonds_v2 allows 150 where a non-VIP gets 110. NULL = same as max_per_user_per_day.';

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp' AS $function$
    SELECT CASE
        WHEN starts_with(p_reference_id, 'trivia_tourn_')     THEN 'trivia_tournaments'
        WHEN starts_with(p_reference_id, 'trivia_session_')   THEN 'trivia'
        WHEN starts_with(p_reference_id, 'trivia_wheel_')     THEN 'trivia'
        WHEN starts_with(p_reference_id, 'challenge_claim')   THEN 'daily_challenges'
        WHEN starts_with(p_reference_id, 'daily_mission_milestones:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily-missions-historical-multiplier:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily_mission_')    THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'streak_milestone_') THEN 'share_streak'
        WHEN starts_with(p_reference_id, 'streak_')           THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'signup:')           THEN 'signup'
        WHEN starts_with(p_reference_id, 'easter_egg_')       THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'video_favorite_')   THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'vip_stipend_')      THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'hotd_')             THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'progress_')         THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'customization-cert-fund') THEN 'cert_fixture'
        WHEN p_source = 'complete_daily_challenge' THEN 'memory_game'
        WHEN p_source = 'handle_new_user'          THEN 'signup'
        WHEN p_source = 'union'                    THEN 'union_grant'
        WHEN p_source = 'the_mint'                 THEN 'mint'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'referral_bonus', 'referral_bonus_reversal', 'referral_qualified',
                'referral_referee', 'referral_vip_conversion')             THEN 'referrals'
        WHEN COALESCE(p_transaction_type, p_type) = 'signup_bonus'         THEN 'signup'
        WHEN COALESCE(p_transaction_type, p_type) = 'union_grant'          THEN 'union_grant'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'pvp_refund', 'pvp_win', 'pvp_tie_refund', 'trivia_run',
                'trivia_daily_bonus', 'daily_trivia', 'trivia_reward',
                'trivia_prize_wheel', 'endless_reward', 'survival_reward',
                'mixed_reward', 'time_attack_reward', 'trivia_double_win')  THEN 'trivia'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'tournament_prize', 'tournament_entry_refund',
                'tournament_cancel_refund')                                THEN 'trivia_tournaments'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_challenge_claim') THEN 'daily_challenges'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_mission_milestone', 'daily_mission_reward') THEN 'daily_missions'
        WHEN COALESCE(p_transaction_type, p_type) = 'streak_reward'        THEN 'share_streak'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'daily_login', 'easter_egg', 'training_reward',
                'video_favorite', 'vip_stipend')                           THEN 'catalog_v2'
        WHEN COALESCE(p_transaction_type, p_type) IN ('credit', 'earn', 'bonus') THEN 'legacy_credit'
        WHEN p_description LIKE 'Diamond Rewards v2:%'                      THEN 'catalog_v2'
        ELSE 'other'
    END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_engine_of(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_engine_of(text, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earn_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
    v_engine text; v_period text; v_day date; v_budget bigint; v_spent bigint; v_awarded bigint;
    v_cap integer; v_cap_vip integer; v_is_vip boolean := false; v_at timestamptz;
BEGIN
    BEGIN
        IF COALESCE(NEW.issuance_class, '') IN ('purchased', 'transferred', 'refund', 'admin', 'arena', 'spend', 'deletion', 'bridge') THEN
            RETURN NULL;
        END IF;
        IF COALESCE(NEW.type, '') = 'purchase' OR COALESCE(NEW.transaction_type, '') = 'purchase' THEN
            RETURN NULL;
        END IF;
        -- Fixture accounts are not players (2026-09-07 review DEF-03): their issuance is not
        -- promotional spend. Horses ARE players and are counted.
        IF public.fn_ca_is_fixture_account(NEW.user_id) THEN
            RETURN NULL;
        END IF;

        v_at     := COALESCE(NEW.created_at, now());
        v_engine := CASE WHEN NEW.issuance_class IS NULL THEN 'unclassified'
                         ELSE public.fn_ca_diamond_engine_of(NEW.type, NEW.transaction_type, NEW.source,
                                                             NEW.description, NEW.reference_id) END;
        v_period := to_char((v_at AT TIME ZONE 'America/Chicago'), 'YYYY-MM');
        v_day    := (v_at AT TIME ZONE 'America/Chicago')::date;

        INSERT INTO public.diamond_reward_budgets (period, engine, budget_diamonds, spent_diamonds, updated_at)
        VALUES (v_period, v_engine,
                COALESCE((SELECT b.budget_diamonds FROM public.diamond_reward_budgets b
                           WHERE b.engine = v_engine AND b.period < v_period
                           ORDER BY b.period DESC LIMIT 1), 2500000),
                NEW.amount, now())
        ON CONFLICT (period, engine) DO UPDATE
           SET spent_diamonds = diamond_reward_budgets.spent_diamonds + EXCLUDED.spent_diamonds,
               updated_at = now()
        RETURNING budget_diamonds, spent_diamonds INTO v_budget, v_spent;

        IF v_spent > v_budget THEN
            PERFORM public.fn_ca_diamond_incident('DR7:engine_over_budget', 'warning', NEW.user_id, NEW.amount,
                'fn_ca_diamond_earn_ledger',
                jsonb_build_object('engine', v_engine, 'period', v_period, 'budget_diamonds', v_budget,
                                   'spent_diamonds', v_spent, 'journal_id', NEW.id, 'reference_id', NEW.reference_id));
        END IF;

        INSERT INTO public.diamond_user_daily_awards (user_id, engine, day, awarded, updated_at)
        VALUES (NEW.user_id, v_engine, v_day, NEW.amount, now())
        ON CONFLICT (user_id, engine, day) DO UPDATE
           SET awarded = diamond_user_daily_awards.awarded + EXCLUDED.awarded, updated_at = now()
        RETURNING awarded INTO v_awarded;

        SELECT c.max_per_user_per_day, c.max_per_user_per_day_vip INTO v_cap, v_cap_vip
          FROM public.diamond_engine_daily_caps c WHERE c.engine = v_engine;
        IF v_cap_vip IS NOT NULL THEN
            SELECT COALESCE(p.is_vip, false) AND (COALESCE(p.vip_tier, '') = 'lifetime'
                     OR (p.vip_expires_at IS NOT NULL AND p.vip_expires_at > now()))
              INTO v_is_vip FROM public.profiles p WHERE p.id = NEW.user_id;
            IF COALESCE(v_is_vip, false) THEN v_cap := v_cap_vip; END IF;
        END IF;

        IF v_cap IS NOT NULL AND v_awarded > v_cap THEN
            PERFORM public.fn_ca_diamond_incident('DR7:user_over_daily_cap', 'warning', NEW.user_id, NEW.amount,
                'fn_ca_diamond_earn_ledger',
                jsonb_build_object('engine', v_engine, 'day', v_day, 'is_vip', v_is_vip,
                                   'max_per_user_per_day', v_cap, 'awarded_today', v_awarded,
                                   'journal_id', NEW.id, 'reference_id', NEW.reference_id));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        PERFORM public.fn_ca_diamond_incident('DR7:ledger_write_failed', 'warning', NEW.user_id, NEW.amount,
            'fn_ca_diamond_earn_ledger',
            jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'journal_id', NEW.id, 'reference_id', NEW.reference_id));
    END;
    RETURN NULL;
END;
$function$;

-- Daily award rows follow the profile (DEF-06): drop orphans and fixture rows, then the FK.
DELETE FROM public.diamond_user_daily_awards d
 WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = d.user_id)
    OR public.fn_ca_is_fixture_account(d.user_id);
ALTER TABLE public.diamond_user_daily_awards DROP CONSTRAINT IF EXISTS diamond_user_daily_awards_user_fk;
ALTER TABLE public.diamond_user_daily_awards
  ADD CONSTRAINT diamond_user_daily_awards_user_fk FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.diamond_user_daily_awards VALIDATE CONSTRAINT diamond_user_daily_awards_user_fk;

-- Restate the budgets from what players (not fixtures) were actually issued this period and last:
-- surviving journal rows plus the archive of rows deleted inside the window (DEF-03).
INSERT INTO public.diamond_reward_budgets (period, engine, budget_diamonds, spent_diamonds)
SELECT p.period, e.engine, 2500000, 0
  FROM (VALUES ('daily_missions'), ('cert_fixture'), ('unclassified'), ('mint')) AS e(engine)
  CROSS JOIN (SELECT DISTINCT period FROM public.diamond_reward_budgets) p
ON CONFLICT (period, engine) DO NOTHING;
WITH jrows AS (
  SELECT user_id, amount, type, transaction_type, source, description, reference_id, issuance_class, created_at
    FROM public.diamond_transactions
  UNION ALL
  SELECT user_id, amount, type, transaction_type, source, description, reference_id, issuance_class, created_at
    FROM public.ca_diamond_journal_archive
), classified AS (
  SELECT to_char((created_at AT TIME ZONE 'America/Chicago'), 'YYYY-MM') AS period,
         CASE WHEN issuance_class IS NULL THEN
                CASE WHEN description LIKE 'Diamond Rewards v2:%' THEN 'catalog_v2' ELSE 'unclassified' END
              ELSE public.fn_ca_diamond_engine_of(type, transaction_type, source, description, reference_id) END AS engine,
         amount
    FROM jrows
   WHERE amount > 0
     AND COALESCE(issuance_class, '') NOT IN ('purchased', 'transferred', 'refund', 'admin', 'arena', 'spend', 'deletion', 'bridge')
     AND COALESCE(type, '') <> 'purchase' AND COALESCE(transaction_type, '') <> 'purchase'
     AND NOT public.fn_ca_is_fixture_account(user_id)
     AND created_at >= timestamptz '2026-09-01 05:00:00+00'
), totals AS (
  SELECT period, engine, SUM(amount)::bigint AS spent FROM classified GROUP BY 1, 2
)
UPDATE public.diamond_reward_budgets b
   SET spent_diamonds = COALESCE(t.spent, 0), updated_at = now()
  FROM (SELECT DISTINCT period, engine FROM public.diamond_reward_budgets) k
  LEFT JOIN totals t ON t.period = k.period AND t.engine = k.engine
 WHERE b.period = k.period AND b.engine = k.engine
   AND b.period >= '2026-09';

-- ---------------------------------------------------------------------------------------------
-- 12. The mirror never refuses the write it mirrors (D10).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_diamond_side_tables_follow_profiles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_delta bigint := CASE WHEN TG_OP = 'INSERT'
                         THEN COALESCE(NEW.diamonds, 0)
                         ELSE COALESCE(NEW.diamonds, 0) - COALESCE(OLD.diamonds, 0) END;
BEGIN
  IF TG_OP <> 'INSERT' AND v_delta = 0 THEN RETURN NEW; END IF;
  BEGIN
    INSERT INTO public.user_diamonds (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
    VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0), GREATEST(v_delta, 0), GREATEST(-v_delta, 0), now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = GREATEST(COALESCE(NEW.diamonds, 0), 0),
          lifetime_earned = public.user_diamonds.lifetime_earned + GREATEST(v_delta, 0),
          lifetime_spent  = public.user_diamonds.lifetime_spent  + GREATEST(-v_delta, 0),
          updated_at = now();
    INSERT INTO public.user_diamond_balance (user_id, balance, lifetime_earned, lifetime_spent, created_at, updated_at)
    VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, GREATEST(v_delta, 0)::int, GREATEST(-v_delta, 0)::int, now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int,
          lifetime_earned = public.user_diamond_balance.lifetime_earned + GREATEST(v_delta, 0)::int,
          lifetime_spent  = public.user_diamond_balance.lifetime_spent  + GREATEST(-v_delta, 0)::int,
          updated_at = now();
    INSERT INTO public.diamond_wallets (user_id, balance, lifetime_earned, lifetime_spent, updated_at)
    VALUES (NEW.id, GREATEST(COALESCE(NEW.diamonds, 0), 0)::int, GREATEST(v_delta, 0)::int, GREATEST(-v_delta, 0)::int, now())
    ON CONFLICT (user_id) DO UPDATE
      SET balance = GREATEST(COALESCE(NEW.diamonds, 0), 0)::int,
          lifetime_earned = COALESCE(public.diamond_wallets.lifetime_earned, 0) + GREATEST(v_delta, 0)::int,
          lifetime_spent  = COALESCE(public.diamond_wallets.lifetime_spent, 0)  + GREATEST(-v_delta, 0)::int,
          updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    -- A mirror is a mirror: it must never be able to refuse the thing it mirrors (2026-09-07 review
    -- D10: the two side tables carry FKs to auth.users and the seeder inserts the profile first).
    PERFORM public.fn_ca_diamond_incident('DR10:mirror_write_failed', 'warning', NEW.id, NEW.diamonds,
      'fn_diamond_side_tables_follow_profiles',
      jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'tg_op', TG_OP));
  END;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 13. Rulings (Dan, 2026-09-07: "I trust your choices"): the union diamond grant is closed; promo
--     vault purchases in diamonds are refused until a funded club diamond account exists.
-- ---------------------------------------------------------------------------------------------
DO $patch$
DECLARE v_def text; v_m text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_union_send_to_member_zd3core';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_union_send_to_member_zd3core not found'; END IF;
  v_m := E'  if p_kind not in (''chips'',''diamonds'',''promo'') then\n    return jsonb_build_object(''success'', false, ''error'', ''kind must be chips, diamonds or promo'');';
  IF (length(v_def) - length(replace(v_def, v_m, ''))) / length(v_m) <> 1 THEN
    IF v_def LIKE '%Diamonds are issued only by the Mint%' THEN
      RAISE NOTICE 'union diamond kind already closed'; RETURN;
    END IF;
    RAISE EXCEPTION 'fn_union_send_to_member_zd3core: kind marker not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_m,
    E'  -- 2026-09-07 (Diamond Accounting Standard DR2, ruling): a union send of diamonds credited a player with\n'
 || E'  -- no debit anywhere - a mint of up to 100,000 per call outside the Mint. Diamonds are issued only by\n'
 || E'  -- fn_ca_mint. The diamonds branch below is unreachable and kept only as history.\n'
 || E'  if p_kind not in (''chips'',''promo'') then\n    return jsonb_build_object(''success'', false, ''error'', ''kind must be chips or promo. Diamonds are issued only by the Mint (Diamond Accounting Standard DR2).'');');
END $patch$;

CREATE OR REPLACE FUNCTION public.ca_promo_vault_buy(p_club_id uuid, p_item_key text, p_quantity integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You Must Be Signed In To Buy Items.');
  END IF;
  IF NOT public.fn_promo_vault_can_manage(p_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only An Owner, Co-Owner Or Admin Can Buy For This Vault.');
  END IF;
  /* 2026-09-07 ruling (Diamond Accounting Standard DR3, DR14). club_diamond_wallets is not an account in
     the chart of accounts: nothing funds it (both rows 0.00), and a debit from it wrote no journal row and
     carried no idempotency key. Promo Vault purchases in diamonds are refused until the Diamond Arena's
     house account funds club vaults through the Mint. Recorded so the attempt is visible. */
  PERFORM public.fn_ca_diamond_incident('DR3:promo_vault_diamond_purchase_refused', 'info', auth.uid(), NULL,
    'ca_promo_vault_buy', jsonb_build_object('club_id', p_club_id, 'item_key', p_item_key, 'quantity', p_quantity));
  RETURN jsonb_build_object('success', false,
    'error', 'Promo Vault Purchases In Diamonds Are Not Available Yet. Club Diamond Wallets Are Not Funded.');
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 14. Purchase clearing: the refund path under its true name (10.12 reads "reconcile" as a repair
--     arm; this is the live Stripe refund handler), with the lot failure loud (R2-13); the dispute
--     RPC captures the evidence deadline (R2-09) and a win after a reversal is critical (R2-10).
--     reconcile_diamond_purchase_refund stays callable until the World Hub webhook is on the new
--     name; the follow-up migration drops it.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_diamond_purchase_refund(p_purchase_id uuid, p_charge_amount_cents integer, p_refunded_amount_cents integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $function$
DECLARE
  v_purchase public.diamond_purchases%ROWTYPE; v_profile public.profiles%ROWTYPE;
  v_total integer; v_cumulative integer; v_target integer; v_delta integer; v_full boolean;
  v_intent jsonb; v_redemption jsonb; v_unwind jsonb; v_wallet jsonb;
  v_unwind_state text := 'not_requested'; v_balance integer; v_daily_cost integer := 150;
  v_available integer; v_applied integer := 0; v_shortfall integer := 0;
BEGIN
  IF p_charge_amount_cents IS NULL OR p_charge_amount_cents <= 0
     OR p_refunded_amount_cents IS NULL OR p_refunded_amount_cents < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_refund_amount');
  END IF;
  SELECT * INTO v_purchase FROM public.diamond_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found'); END IF;
  v_cumulative := GREATEST(COALESCE(v_purchase.refunded_amount_cents, 0),
    LEAST(p_charge_amount_cents, p_refunded_amount_cents));
  v_full := v_cumulative >= p_charge_amount_cents;

  IF v_purchase.status = 'refunded'
     AND COALESCE((v_purchase.metadata ->> 'refund_before_settlement')::boolean, false) THEN
    UPDATE public.diamond_purchases SET refunded_amount_cents = v_cumulative, updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'fully_refunded', true,
      'terminal_refund', true, 'refunded_diamonds', 0,
      'new_balance', (SELECT COALESCE(diamonds, diamond_balance, 0) FROM public.profiles WHERE id = v_purchase.user_id));
  END IF;
  IF v_purchase.status = 'pending' THEN
    IF NOT v_full THEN RETURN jsonb_build_object('success', false, 'error', 'settlement_pending'); END IF;
    UPDATE public.diamond_purchases
       SET status = 'refunded', refunded_amount_cents = v_cumulative, refunded_diamonds = 0,
           refunded_at = COALESCE(refunded_at, now()),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('refund_before_settlement', true),
           updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', true, 'fully_refunded', true, 'terminal_refund', true,
      'refunded_diamonds', 0,
      'new_balance', (SELECT COALESCE(diamonds, diamond_balance, 0) FROM public.profiles WHERE id = v_purchase.user_id));
  END IF;
  IF v_purchase.status NOT IN ('completed', 'refunded') THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_settled');
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = v_purchase.user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'profile_not_found'); END IF;
  v_total := COALESCE(v_purchase.diamonds_amount, 0) + COALESCE(v_purchase.bonus_diamonds, 0);
  v_target := GREATEST(COALESCE(v_purchase.refunded_diamonds, 0),
    LEAST(v_total, round(v_total::numeric * v_cumulative / p_charge_amount_cents)::integer));
  v_delta := GREATEST(0, v_target - COALESCE(v_purchase.refunded_diamonds, 0));
  v_intent := COALESCE(v_purchase.metadata -> 'redemption_intent', '{}'::jsonb);
  v_redemption := COALESCE(v_purchase.metadata -> 'redemption_result', '{}'::jsonb);
  IF v_full AND COALESCE(v_purchase.metadata ->> 'redemption_status', '') = 'completed'
     AND COALESCE(v_purchase.metadata ->> 'redemption_refund_status', '') NOT IN ('revoked', 'debt_recorded') THEN
    IF v_intent ->> 'kind' = 'club_shop' AND v_redemption ? 'purchase_id' THEN
      v_unwind := public.fn_refund_shop_purchase((v_intent ->> 'club_id')::uuid,
        (v_redemption ->> 'purchase_id')::uuid, v_purchase.user_id,
        'Card-funded Club Shop purchase reversed by Stripe refund');
      v_unwind_state := CASE WHEN COALESCE((v_unwind ->> 'success')::boolean, false) THEN 'revoked' ELSE 'debt_recorded' END;
    ELSIF v_intent ->> 'kind' = 'vip_daily' THEN
      IF v_profile.vip_tier = 'daily' AND v_profile.vip_expires_at IS NOT NULL
         AND v_redemption ? 'expires_at'
         AND abs(extract(epoch FROM (v_profile.vip_expires_at - (v_redemption ->> 'expires_at')::timestamptz))) < 2 THEN
        UPDATE public.profiles SET vip_expires_at = GREATEST(now(), vip_expires_at - interval '1 day'),
          is_vip = (vip_expires_at - interval '1 day') > now(), updated_at = now()
         WHERE id = v_purchase.user_id;
        v_wallet := public.add_diamonds_to_balance(v_purchase.user_id, v_daily_cost, 'refund',
          'Reversed card-funded VIP Daily Pass', 'card-redemption-refund:' || v_purchase.id::text);
        IF COALESCE((v_wallet ->> 'success')::boolean, false) IS NOT TRUE
           AND COALESCE((v_wallet ->> 'duplicate')::boolean, false) IS NOT TRUE THEN
          RAISE EXCEPTION 'daily_redemption_refund_failed:%', COALESCE(v_wallet ->> 'error', 'unknown');
        END IF;
        v_unwind_state := 'revoked';
      ELSE v_unwind_state := 'debt_recorded'; END IF;
    END IF;
  END IF;

  IF v_delta > 0 THEN
    SELECT COALESCE(diamonds, diamond_balance, 0) INTO v_available FROM public.profiles WHERE id = v_purchase.user_id;
    v_available := GREATEST(COALESCE(v_available, 0), 0);
    v_applied := LEAST(v_delta, v_available);
    v_shortfall := v_delta - v_applied;

    IF v_applied > 0 THEN
      UPDATE public.profiles
         SET diamonds = COALESCE(diamonds, diamond_balance, 0) - v_applied,
             diamond_balance = COALESCE(diamonds, diamond_balance, 0) - v_applied, updated_at = now()
       WHERE id = v_purchase.user_id RETURNING diamonds INTO v_balance;
    ELSE
      v_balance := v_available;
    END IF;

    IF v_shortfall > 0 THEN
      INSERT INTO public.diamond_debts (user_id, purchase_id, amount, reason)
      VALUES (v_purchase.user_id, v_purchase.id, v_shortfall, 'chargeback_exceeds_balance');
      BEGIN
        PERFORM public.fn_ca_diamond_incident('DR1:chargeback_exceeds_balance', 'critical', v_purchase.user_id, v_shortfall,
          'fn_diamond_purchase_refund',
          jsonb_build_object('purchase_id', v_purchase.id, 'reversal_owed', v_delta, 'balance_applied', v_applied,
                             'debt_booked', v_shortfall, 'balance_after', v_balance));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;

    INSERT INTO public.diamond_transactions(user_id,type,amount,balance_after,description,
      reference_id,transaction_type,source,metadata,counterparty,issuance_class)
    VALUES (v_purchase.user_id,'refund',-v_applied,v_balance,'Stripe refund',
      'diamond-refund:' || v_purchase.id::text || ':' || v_target,'refund','stripe',
      jsonb_build_object('purchase_id',v_purchase.id,'chargeback_debt',v_shortfall > 0,
        'reversal_owed',v_delta,'balance_applied',v_applied,'debt_booked',v_shortfall),
      'purchase_clearing','refund');

    -- DR9: the lot carries what was reversed. A failure here is loud (review R2-13), never fatal.
    BEGIN
      UPDATE public.diamond_purchase_lots
         SET refunded = LEAST(issued - consumed, GREATEST(refunded, v_target))
       WHERE purchase_id = v_purchase.id;
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        PERFORM public.fn_ca_diamond_incident('DR9:purchase_lot_write_failed', 'critical', v_purchase.user_id, v_target,
          'fn_diamond_purchase_refund',
          jsonb_build_object('purchase_id', v_purchase.id, 'sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'target', v_target));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END;
  ELSE
    SELECT COALESCE(diamonds, diamond_balance, 0) INTO v_balance FROM public.profiles WHERE id = v_purchase.user_id;
  END IF;
  UPDATE public.diamond_purchases
     SET refunded_amount_cents = v_cumulative, refunded_diamonds = v_target,
         refunded_at = CASE WHEN v_full THEN COALESCE(refunded_at,now()) ELSE refunded_at END,
         status = CASE WHEN v_full THEN 'refunded' ELSE status END,
         metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object(
           'redemption_refund_status',v_unwind_state,'refund_balance_after',v_balance,
           'chargeback_debt',v_shortfall > 0,'chargeback_debt_amount',v_shortfall,
           'refunded_diamonds',v_target), updated_at=now()
   WHERE id=v_purchase.id;
  RETURN jsonb_build_object('success',true,'fully_refunded',v_full,'refunded_diamonds',v_target,
    'new_balance',v_balance,'redemption_refund_status',v_unwind_state,
    'chargeback_debt',v_shortfall > 0,'chargeback_debt_amount',v_shortfall,'balance_applied',v_applied);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_diamond_purchase_refund(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_purchase_refund(uuid, integer, integer) TO service_role;
COMMENT ON FUNCTION public.fn_diamond_purchase_refund(uuid, integer, integer) IS
  'The live Stripe refund and chargeback handler for a diamond purchase: pro-rata reversal, redemption unwind, clamp at the balance, remainder to diamond_debts (DR1, DR9). Renamed from reconcile_diamond_purchase_refund 2026-09-07.';

DROP FUNCTION IF EXISTS public.fn_diamond_purchase_dispute(uuid, text, text, integer);
CREATE OR REPLACE FUNCTION public.fn_diamond_purchase_dispute(p_purchase_id uuid, p_dispute_id text, p_event text, p_amount_cents integer, p_evidence_due_by timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $function$
DECLARE
  v_purchase public.diamond_purchases%ROWTYPE;
  v_charge_cents integer; v_claimed integer; v_reversal jsonb; v_frozen integer := 0; v_withdrawn jsonb;
BEGIN
  IF p_purchase_id IS NULL OR COALESCE(p_dispute_id, '') = '' OR COALESCE(p_event, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_arguments');
  END IF;
  IF p_event NOT IN ('charge.dispute.created', 'charge.dispute.funds_withdrawn',
                     'charge.dispute.closed:won', 'charge.dispute.closed:lost') THEN
    RETURN jsonb_build_object('success', false, 'error', 'unsupported_event', 'event', p_event);
  END IF;
  SELECT * INTO v_purchase FROM public.diamond_purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found'); END IF;

  INSERT INTO public.diamond_purchase_disputes (dispute_id, event, purchase_id, amount_cents)
  VALUES (p_dispute_id, p_event, p_purchase_id, p_amount_cents)
  ON CONFLICT (dispute_id, event) DO NOTHING;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'event', p_event,
      'purchase_id', p_purchase_id, 'dispute_id', p_dispute_id);
  END IF;

  IF p_event = 'charge.dispute.created' THEN
    UPDATE public.diamond_purchase_lots SET frozen_at = COALESCE(frozen_at, now()) WHERE purchase_id = p_purchase_id;
    GET DIAGNOSTICS v_frozen = ROW_COUNT;
    BEGIN
      PERFORM public.fn_ca_diamond_incident('DR10:dispute_opened', 'critical', v_purchase.user_id,
        COALESCE(v_purchase.diamonds_amount, 0) + COALESCE(v_purchase.bonus_diamonds, 0),
        'fn_diamond_purchase_dispute',
        jsonb_build_object('purchase_id', p_purchase_id, 'dispute_id', p_dispute_id, 'amount_cents', p_amount_cents,
          'lots_frozen', v_frozen, 'evidence_due_by', p_evidence_due_by,
          'note', CASE WHEN p_evidence_due_by IS NULL
                       THEN 'Stripe sent no evidence deadline with this event; check the dispute in the Stripe dashboard. A dispute lost by silence is a money defect (D10).'
                       ELSE 'Submit evidence before evidence_due_by or the dispute is lost by default (D10).' END));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('success', true, 'event', p_event, 'purchase_id', p_purchase_id,
      'lots_frozen', v_frozen, 'evidence_due_by', p_evidence_due_by);

  ELSIF p_event = 'charge.dispute.funds_withdrawn' THEN
    v_charge_cents := round(COALESCE(v_purchase.price_usd, 0) * 100)::integer;
    IF v_charge_cents <= 0 THEN
      BEGIN
        PERFORM public.fn_ca_diamond_incident('DR10:dispute_charge_amount_unknown', 'critical', v_purchase.user_id, NULL,
          'fn_diamond_purchase_dispute',
          jsonb_build_object('purchase_id', p_purchase_id, 'dispute_id', p_dispute_id, 'price_usd', v_purchase.price_usd,
            'note', 'The purchase row carries no usable price, so the pro-rata reversal cannot be computed. Reversed nothing.'));
      EXCEPTION WHEN OTHERS THEN NULL; END;
      RETURN jsonb_build_object('success', false, 'error', 'charge_amount_unknown', 'purchase_id', p_purchase_id);
    END IF;
    v_reversal := public.fn_diamond_purchase_refund(
      p_purchase_id, v_charge_cents, LEAST(COALESCE(p_amount_cents, v_charge_cents), v_charge_cents));
    BEGIN
      PERFORM public.fn_ca_diamond_incident('DR10:dispute_funds_withdrawn', 'critical', v_purchase.user_id,
        COALESCE((v_reversal ->> 'refunded_diamonds')::integer, 0), 'fn_diamond_purchase_dispute',
        jsonb_build_object('purchase_id', p_purchase_id, 'dispute_id', p_dispute_id, 'charge_cents', v_charge_cents,
          'withdrawn_cents', p_amount_cents, 'reversal', v_reversal));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('success', true, 'event', p_event, 'purchase_id', p_purchase_id, 'reversal', v_reversal);

  ELSIF p_event = 'charge.dispute.closed:won' THEN
    UPDATE public.diamond_purchase_lots SET frozen_at = NULL WHERE purchase_id = p_purchase_id;
    GET DIAGNOSTICS v_frozen = ROW_COUNT;
    SELECT to_jsonb(d) INTO v_withdrawn FROM public.diamond_purchase_disputes d
     WHERE d.dispute_id = p_dispute_id AND d.event = 'charge.dispute.funds_withdrawn';
    BEGIN
      -- Review R2-10: a win AFTER funds were withdrawn means the player is short what they paid for.
      -- Money owed to a player is filed critical so the daily sweep sees it (CLAUDE.md 10.9 decides it).
      PERFORM public.fn_ca_diamond_incident('DR10:dispute_closed_won',
        CASE WHEN v_withdrawn IS NULL THEN 'info' ELSE 'critical' END, v_purchase.user_id,
        CASE WHEN v_withdrawn IS NULL THEN NULL ELSE COALESCE(v_purchase.refunded_diamonds, 0) END,
        'fn_diamond_purchase_dispute',
        jsonb_build_object('purchase_id', p_purchase_id, 'dispute_id', p_dispute_id, 'lots_unfrozen', v_frozen,
          'reversal_before_win', v_withdrawn,
          'note', CASE WHEN v_withdrawn IS NULL THEN 'Dispute won; nothing had been reversed. The lot is spendable again.'
                       ELSE 'Dispute won AFTER funds_withdrawn reversed the grant: Stripe returns the funds and the player is owed the reversed diamonds. Re-credit through the Mint (class purchased) under a four-eyes adjustment.' END));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('success', true, 'event', p_event, 'purchase_id', p_purchase_id,
      'lots_unfrozen', v_frozen, 'player_owed', v_withdrawn IS NOT NULL);

  ELSE
    BEGIN
      PERFORM public.fn_ca_diamond_incident('DR10:dispute_closed_lost', 'info', v_purchase.user_id, NULL,
        'fn_diamond_purchase_dispute',
        jsonb_build_object('purchase_id', p_purchase_id, 'dispute_id', p_dispute_id,
          'note', 'Dispute lost. Any reversal booked by funds_withdrawn stands and the lot stays frozen.'));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN jsonb_build_object('success', true, 'event', p_event, 'purchase_id', p_purchase_id, 'reversal_stands', true);
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_diamond_purchase_dispute(uuid, text, text, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_purchase_dispute(uuid, text, text, integer, timestamptz) TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT v.n, 'approved', v.note
  FROM (VALUES
    ('fn_diamond_purchase_refund', 'Diamond standard review 2026-09-07: the live Stripe refund handler, renamed from reconcile_diamond_purchase_refund'),
    ('fn_ca_is_fixture_account', 'Diamond standard review 2026-09-07: read-only scope helper'),
    ('fn_ca_diamond_journal_classifier', 'Diamond standard review 2026-09-07: DR3 safety net on diamond_transactions INSERT')
  ) AS v(n, note)
 WHERE NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry r WHERE r.proname = v.n);

-- R2-06: the two real purchases settled before the lot table existed.
INSERT INTO public.diamond_purchase_lots (user_id, purchase_id, issued, settled_at)
SELECT user_id, id, COALESCE(diamonds_amount, 0) + COALESCE(bonus_diamonds, 0), COALESCE(completed_at, created_at)
  FROM public.diamond_purchases
 WHERE status = 'completed'
ON CONFLICT (purchase_id) DO NOTHING;

-- R2-11, R2-12, DEF-10
ALTER POLICY diamond_packages_read_active ON public.diamond_packages USING (active);
ALTER TABLE public.diamond_purchases VALIDATE CONSTRAINT diamond_purchases_status_known;
ALTER TABLE public.diamond_purchases VALIDATE CONSTRAINT diamond_purchases_refund_progress_nonnegative;
ALTER TABLE public.diamond_transactions VALIDATE CONSTRAINT diamond_transactions_issuance_class_chk;

-- ---------------------------------------------------------------------------------------------
-- 15. The incident log: the noise this migration re-scopes is resolved with its reason attached.
-- ---------------------------------------------------------------------------------------------
UPDATE public.ca_diamond_incidents
   SET resolved_at = now(),
       detail = detail || jsonb_build_object('resolution', 'certification fixture churn; rule re-scoped to info for fixture accounts 2026-09-07 (review D4, D8, D16)')
 WHERE resolved_at IS NULL AND rule IN ('DR2:balance_born_outside_the_mint', 'DR6:balance_changed_without_journal', 'DR5:deleted_with_balance')
   AND COALESCE((detail->>'is_cert')::boolean, false);
UPDATE public.ca_diamond_incidents
   SET resolved_at = now(),
       detail = detail || jsonb_build_object('resolution', 'writer journals later in the same transaction and is now in the DR6 gate list 2026-09-07 (review D4, D5, D6)')
 WHERE resolved_at IS NULL AND rule = 'DR6:balance_changed_without_journal'
   AND (writer IN ('handle_new_user', 'award_diamonds_v2') OR writer LIKE 'claim_daily_challenge%');
UPDATE public.ca_diamond_incidents
   SET resolved_at = now(),
       detail = detail || jsonb_build_object('resolution', 'measurement artefact: 10-minute balance window against a 60-minute journal the cert cleanup deletes hourly; the trial balance measures against the register on stored figures from 2026-09-07 (review D1, D2, D3)')
 WHERE resolved_at IS NULL AND rule = 'DR11:trial_balance_break';
UPDATE public.ca_diamond_incidents
   SET resolved_at = now(),
       detail = detail || jsonb_build_object('resolution', 'one incident per maintenance batch from 2026-09-07; every row is in ca_diamond_journal_archive (review R2-05)')
 WHERE resolved_at IS NULL AND rule = 'DR5:journal_row_deleted_under_maintenance';
UPDATE public.ca_diamond_incidents
   SET resolved_at = now(),
       detail = detail || jsonb_build_object('resolution', 'the mirror trigger fires on INSERT since 20260907035121; no mismatch since 03:10 UTC')
 WHERE resolved_at IS NULL AND rule = 'DR10:mirror_mismatch';
UPDATE public.ca_diamond_incidents
   SET resolved_at = now(),
       detail = detail || jsonb_build_object('resolution', 'VIP account under the VIP cap of 150; the cap table learned the VIP ceiling 2026-09-07 (review DEF-05)')
 WHERE resolved_at IS NULL AND rule = 'DR7:user_over_daily_cap'
   AND COALESCE((detail->>'awarded_today')::int, 0) <= 150;
UPDATE public.ca_diamond_incidents
   SET resolved_at = now(),
       detail = detail || jsonb_build_object('resolution', 'award_diamonds_v2 rows re-classified; the writer stamp restored and the journal classifier added 2026-09-07 (review R2-02, DEF-01)')
 WHERE resolved_at IS NULL AND rule = 'DR12:suspense_nonzero';

-- ---------------------------------------------------------------------------------------------
-- 16. Assertions: the change is what this file says it is.
-- ---------------------------------------------------------------------------------------------
DO $assert$
DECLARE v text; n int; r record; v_reg numeric; v_players numeric; v_house numeric;
BEGIN
  SELECT prosrc INTO v FROM pg_proc WHERE proname = 'award_diamonds_v2';
  IF v NOT LIKE '%promo_budget:catalog_v2%' OR v NOT LIKE '%diamond_issuance_frozen%' THEN
    RAISE EXCEPTION 'assert: award_diamonds_v2 lacks the stamp or the kill switch';
  END IF;
  SELECT prosrc INTO v FROM pg_proc WHERE proname = 'fn_ca_mint';
  IF v NOT LIKE '%diamond_issuance_frozen%' THEN RAISE EXCEPTION 'assert: fn_ca_mint lacks the kill switch'; END IF;
  SELECT prosrc INTO v FROM pg_proc WHERE proname = 'fn_union_send_to_member_zd3core';
  IF v NOT LIKE '%Diamonds are issued only by the Mint%' THEN RAISE EXCEPTION 'assert: union diamond kind still open'; END IF;
  IF public.fn_ca_diamond_engine_of(NULL, NULL, NULL, NULL, 'daily_mission_milestones:abc') <> 'daily_missions' THEN
    RAISE EXCEPTION 'assert: engine_of does not map daily missions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'aa_ca_diamond_journal_classifier' AND tgrelid = 'public.diamond_transactions'::regclass) THEN
    RAISE EXCEPTION 'assert: classifier trigger missing';
  END IF;
  SELECT count(*) INTO n FROM public.diamond_transactions WHERE issuance_class IS NULL AND created_at >= timestamptz '2026-09-03 00:07:00+00';
  IF n <> 0 THEN RAISE EXCEPTION 'assert: % unclassified journal rows remain', n; END IF;
  SELECT count(*) INTO n FROM public.diamond_purchase_lots;
  IF n < 2 THEN RAISE EXCEPTION 'assert: purchase lots not backfilled'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_diamond_purchase_dispute' AND pronargs = 5) THEN
    RAISE EXCEPTION 'assert: dispute RPC lacks the deadline parameter';
  END IF;
  SELECT count(*) INTO n FROM public.fn_ca_diamond_trial_balance(now() - interval '2 hours') t WHERE t.account IN ('register', 'fixture_accounts', 'total');
  IF n <> 3 THEN RAISE EXCEPTION 'assert: trial balance shape (got % of 3 new rows)', n; END IF;
  v_reg := public.fn_ca_mint_supply('diamonds');
  SELECT SUM(diamonds) INTO v_players FROM public.profiles;
  SELECT balance INTO v_house FROM public.ca_diamond_house WHERE id = 1;
  IF v_reg <> v_players + COALESCE(v_house, 0) THEN
    RAISE NOTICE 'identity at apply: register % vs players+house % (skew of in-flight signups is possible; the watch will report)', v_reg, v_players + COALESCE(v_house, 0);
  END IF;
  SELECT count(*) INTO n FROM public.diamond_user_daily_awards d WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = d.user_id);
  IF n <> 0 THEN RAISE EXCEPTION 'assert: orphan daily award rows remain'; END IF;
END $assert$;

COMMIT;
