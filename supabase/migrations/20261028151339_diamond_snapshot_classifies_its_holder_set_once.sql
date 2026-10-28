CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_mint_diamond_holder_net_idx
 ON public.ca_mint_ledger(holder_type,holder_id) INCLUDE(action,amount) WHERE asset='diamonds';
-- Diamond snapshot job201 timed out repeatedly on October27 and11:10UTC October28.
-- Preserve the same statement snapshot and exact fixture/cert predicates,
-- including unprofiled holders and the horse exception. The classifiers are
-- pinned with the caller so a later classifier change refuses this install.
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_diamond_snapshot()'::regprocedure))='2ccb2a15dc8f9af4c144ccb71d914a9b' AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.ca_mint_diamond_holder_net_idx') AND indisvalid AND indisready)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.ca_mint_diamond_holder_net_idx') AND indisvalid AND indisready)
 OR pg_get_indexdef('public.ca_mint_diamond_holder_net_idx'::regclass) IS DISTINCT FROM
 'CREATE INDEX ca_mint_diamond_holder_net_idx ON public.ca_mint_ledger USING btree (holder_type, holder_id) INCLUDE (action, amount) WHERE (asset = ''diamonds''::text)' THEN
 RAISE EXCEPTION 'diamond holder cover differs from qualified index'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_is_cert_account(uuid)'::regprocedure)) IS DISTINCT FROM 'fc72ec9fdc035fb51d052eefa9308e74' THEN RAISE EXCEPTION 'diamond snapshot/classifier source changed'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_diamond_snapshot()'::regprocedure)) IS DISTINCT FROM 'aa1954aa21ebf672e454fba810d89e8d' THEN RAISE EXCEPTION 'diamond snapshot/classifier source changed'; END IF;
 IF md5(pg_get_functiondef('public.fn_ca_is_fixture_account(uuid)'::regprocedure)) IS DISTINCT FROM 'e848c01dd4b6c7a3ad1f93ea66b645ee' THEN RAISE EXCEPTION 'diamond snapshot/classifier source changed'; END IF;
END $guard$;
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
  v_house_reg numeric; v_house_ledger_total numeric;
BEGIN
  -- ONE statement, ONE snapshot (2026-09-07 review fix 4): the meter, the mirror, the fixture share,
  -- the house and the register are read together, so a signup committing between two reads cannot
  -- show as a 500 drift for one run.
  -- THE REGISTER IS READ ONCE, AND THE FIXTURE QUESTION IS ASKED ONCE PER HOLDER
  -- (2026-10-04). This statement used to read the player register twice, and the
  -- second read called fn_ca_is_fixture_account for every ledger ROW: 209,249 calls
  -- and 855,590 of the statement's 917,586 buffer reads (measured 2026-10-04), to
  -- keep 23 rows. On
  -- 2026-10-01 17:10 UTC that read was cancelled at the 120 s statement timeout,
  -- no snapshot was stored, and the trial balance read 'unknown' for two hours.
  -- The register is now netted per holder in one pass (8,404 holders then) and the
  -- fixture question is put to each holder once. Same rows, same sums, same SQL
  -- snapshot as the balances beside it; fn_ca_is_fixture_account is still the
  -- only definition of a fixture.
  WITH reg AS MATERIALIZED (
    SELECT m.holder_id,
           SUM(CASE WHEN m.action = 'mint' THEN m.amount ELSE -m.amount END) AS net
      FROM public.ca_mint_ledger m
     WHERE m.asset = 'diamonds' AND m.holder_type = 'player'
     GROUP BY m.holder_id),
  holder_ids AS MATERIALIZED (
    SELECT id FROM public.profiles
    UNION SELECT holder_id FROM reg
    UNION SELECT user_id FROM public.poker_diamond_custody
    UNION SELECT owner_id FROM public.diamond_spin_days WHERE status='open'
  ), account_classes AS MATERIALIZED (
    -- Ask the authoritative classifiers once per distinct holder, not once
    -- per historical custody row. Both flags stay in this statement snapshot.
    SELECT h.id,public.fn_ca_is_fixture_account(h.id) AS fixture,
           public.fn_ca_is_cert_account(h.id) AS cert
    FROM holder_ids h
  )
  SELECT (SELECT COALESCE(sum(diamonds),0) FROM public.profiles),
         (SELECT COALESCE(sum(balance),0) FROM public.diamond_wallets),
         (SELECT COALESCE(sum(p.diamonds),0) FROM public.profiles p WHERE EXISTS(SELECT 1 FROM account_classes ac WHERE ac.id=p.id AND ac.cert)),
         (SELECT COALESCE(sum(p.diamonds),0) FROM public.profiles p WHERE EXISTS(SELECT 1 FROM account_classes ac WHERE ac.id=p.id AND ac.fixture)),
         (SELECT COALESCE(balance, 0) FROM public.ca_diamond_house WHERE id = 1),
         (SELECT COALESCE(SUM(g.net), 0) FROM reg g),
         (SELECT COALESCE(SUM(g.net), 0) FROM reg g WHERE EXISTS(SELECT 1 FROM account_classes ac WHERE ac.id=g.holder_id AND ac.fixture))
    , public.fn_ca_arena_diamonds(),
         ((SELECT COALESCE(sum(balance),0) FROM public.poker_diamond_custody WHERE EXISTS(SELECT 1 FROM account_classes ac WHERE ac.id=user_id AND ac.fixture)) + (SELECT COALESCE(sum(pending_diamonds),0) FROM public.diamond_spin_days WHERE status='open' AND EXISTS(SELECT 1 FROM account_classes ac WHERE ac.id=owner_id AND ac.fixture))),
         -- THE HOUSE IS READ AT ONE INSTANT (2026-10-25): the house holders' Mint
         -- net and the cumulative house ledger are stored beside house_balance,
         -- from this same statement, so the trial balance measures the house
         -- movement and what explains it at one instant at each end instead of
         -- windowing rows by created_at, which is a transaction's START time.
         (SELECT COALESCE(SUM(CASE WHEN h.action = 'mint' THEN h.amount ELSE -h.amount END), 0)
            FROM public.ca_mint_ledger h WHERE h.asset = 'diamonds' AND h.holder_type = 'house'),
         (SELECT COALESCE(SUM(hl.delta), 0) FROM public.ca_diamond_house_ledger hl)
    INTO v_prof, v_wal, v_cert, v_fix, v_house, v_reg, v_reg_fix, v_arena_now, v_arena_fix,
         v_house_reg, v_house_ledger_total;
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
     register_supply, house_balance, fixture_diamonds, register_fixture, arena_fixture_diamonds,
     house_register, house_ledger_total)
  VALUES
    (v_arena_now, v_prof, v_wal, v_cert, v_total, v_journal,
     CASE WHEN prev.id IS NULL THEN NULL ELSE v_total - v_prev_basis END,
     v_unexplained, v_reg, v_house, v_fix, v_reg_fix, v_arena_fix,
     v_house_reg, v_house_ledger_total);

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
      -- Diamond Phase 10: tagged, so it is recorded and worded in Diamonds.
      false, jsonb_build_object('asset', 'diamonds', 'profile_diamonds', v_prof, 'fixture_diamonds', v_fix, 'register_supply', v_reg,
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
REVOKE ALL ON FUNCTION public.fn_ca_diamond_snapshot() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_snapshot() TO service_role;
COMMIT;
