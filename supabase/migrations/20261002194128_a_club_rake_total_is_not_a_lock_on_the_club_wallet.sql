-- ============================================================================
-- A CLUB'S RAKE TOTAL IS NOT A LOCK ON ITS WALLET
-- ============================================================================
--
-- WHAT WAS WRONG, MEASURED ON PRODUCTION 2026-10-02 18:00-19:45 UTC
--
-- Every raked cash hand ran, inside atomic_distribute_rake, inside the hand's
-- post-commit obligations transaction:
--
--     UPDATE public.club_wallets SET period_rake_collected = ... + p_rake,
--            lifetime_rake_collected = ... , chip_balance = chip_balance, ...
--      WHERE club_id = p_club_id
--
-- That is ONE row per club, and the transaction holds it to COMMIT: through the
-- BBJ, promo, insurance and add-on obligations, the stats projection and a
-- PostgREST round trip. So every raked hand at every table of a club queued
-- behind every other one, and behind every tournament finish of that club,
-- which takes the same row first and holds it for its whole body
-- (fn_complete_tournament_terminal_pre_seat_guard, 4-12 s each this evening).
--
--   * The postgres log has 1,518 "canceling statement due to statement
--     timeout" errors whose context is this UPDATE between 18:00 and 19:45, plus
--     ~100 more "while locking tuple (..) in relation club_wallets" - more than
--     every other timed-out statement on the platform put together (the next
--     is 85).
--   * pg_stat_activity at 19:33 showed chains of fn_ca_process_hand_post_commit
--     _obligations calls 3-8 s deep, each waiting on the one before, rooted in
--     a 15.6 s tournament finish.
--   * At 19:37:07 PostgREST began killing threads ("Thread killed by timeout
--     manager"); the shared client the lease heartbeats ride on starved, and at
--     19:37:26-32 the engine refused 180 hands on 116 tables as
--     lease_proof_expired. Those are the voided hands of Phase 2.
--   * The same wait is the bulk of the decided-tournament backlog: a finish
--     that waits on the club wallet holds its settlement lane, so the club's
--     other decided events queue behind it (244 decided and unfinished at
--     19:33, oldest bust 18:10, 45-60 min from last bust to payout).
--
-- WHY THE WRITE MOVES RATHER THAN GOES
--
-- The columns are a statistic, not a balance: the hand's rake leaves the felt
-- through rake_records and is routed to the union rake treasury or retired, and
-- the club share is paid weekly (2026-09-02 ruling - the UPDATE literally wrote
-- chip_balance = chip_balance). Three SQL functions read or write the columns
-- and nothing else does (no page, no engine code, no World Hub route; checked
-- on main and in pg_proc today):
--
--   atomic_distribute_rake     wrote them per hand              -> per table now
--   fn_settle_tournament_rake  adds tournament net rake          unchanged: the
--                              under the finish's own lock       finish already
--                                                                holds the row
--   fn_club_money_panel        shows period_rake_collected as    wallet column +
--                              a standalone club's rake treasury sum of tables
--
-- period_* has never been reset (no function writes it except the two adders),
-- so the panel figure stays exactly what it would have been: the wallet column
-- keeps everything up to this migration plus tournament rake, and the new
-- per-table rows carry every hand from here on. Nothing is backfilled and
-- nothing is repaired (CLAUDE.md 10.12).
--
-- THE NEW HOME: public.club_table_rake_totals, one row per (club, table). A
-- table deals one hand at a time and its post-commit obligations are already
-- serialised per table (hand-post-commit:<table>), so each row has one writer
-- and nothing waits on it. A NULL table (none seen; the function allows it)
-- shares the all-zero uuid row.
--
-- WHAT IT ALSO ENDS. 20261001000500 reverted a reorder because a raked hand
-- and a tournament finish took club_wallets and the players' VIP carry rows in
-- opposite orders (837 deadlocks a day) and moving the wallet earlier made the
-- finish wait on hands. A raked hand now never touches club_wallets except to
-- read it, so that pair has no club_wallets edge at all.
--
-- WHAT IS NOT CHANGED: union_wallets.rake_wallet is still one row per union and
-- is real money (the union rake treasury). It stays as it is.
--
-- Asserted substitutions over the pinned live text (pg_get_functiondef md5):
--   atomic_distribute_rake  0ef820b10c57d902b5ab2d5f9e2be8a6 -> 3cb33db39fdcf0359949f941a178158e
--   fn_club_money_panel     1374b5a7a5759e631a8f3ebda5199c91 -> b565ebe80035c2b1af996013c4489211
--
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '3cb33db39fdcf0359949f941a178158e' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.club_table_rake_totals (
  club_id          uuid        NOT NULL,
  table_id         uuid        NOT NULL,
  rake_collected   numeric     NOT NULL DEFAULT 0,
  bbj_contribution numeric     NOT NULL DEFAULT 0,
  hands            bigint      NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, table_id)
);
-- No foreign keys on purpose (CLAUDE.md section 2 rule 7): a statistic row
-- must never take a lock on clubs or tables.
COMMENT ON TABLE public.club_table_rake_totals IS
  'Raked cash-hand totals per (club, table), written by atomic_distribute_rake. A club''s rake collected = club_wallets.period_rake_collected (tournament rake and history to 2026-10-02) + the sum of its rows here. Statistic only: no chips are held here.';
ALTER TABLE public.club_table_rake_totals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.club_table_rake_totals FROM PUBLIC;
REVOKE ALL ON TABLE public.club_table_rake_totals FROM anon;  -- public-ok: the statement above revokes PUBLIC
REVOKE ALL ON TABLE public.club_table_rake_totals FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.club_table_rake_totals TO service_role;

DO $subs$
DECLARE
  v_def text; v_old text; v_new text; v_n integer; v_after text; v_acl text;
BEGIN
  v_def := pg_get_functiondef('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure);
  IF md5(v_def) <> '0ef820b10c57d902b5ab2d5f9e2be8a6' THEN
    RAISE EXCEPTION 'atomic_distribute_rake is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'    UPDATE public.club_wallets\n'
         || E'       SET period_rake_collected     = period_rake_collected     + p_rake,\n'
         || E'           period_bbj_contribution   = period_bbj_contribution   + v_bbj,\n'
         || E'           lifetime_rake_collected   = lifetime_rake_collected   + p_rake,\n'
         || E'           lifetime_bbj_contribution = lifetime_bbj_contribution + v_bbj,\n'
         || E'           chip_balance              = chip_balance,  -- 2026-09-02 ruling: the club share is paid weekly from the rake treasury, not per hand\n'
         || E'           updated_at                = NOW()\n'
         || E'     WHERE club_id = p_club_id\n'
         || E'     RETURNING chip_balance INTO v_cw_after;\n'
         || E'\n'
         || E'    IF v_cw_after IS NULL THEN\n'
         || E'      INSERT INTO public.club_wallets (\n'
         || E'        club_id, chip_balance, period_rake_collected, period_bbj_contribution,\n'
         || E'        lifetime_rake_collected, lifetime_bbj_contribution\n'
         || E'      ) VALUES (\n'
         || E'        p_club_id, 0, p_rake, v_bbj, p_rake, v_bbj\n'
         || E'      )\n'
         || E'      ON CONFLICT (club_id) DO UPDATE SET\n'
         || E'        period_rake_collected     = club_wallets.period_rake_collected     + EXCLUDED.period_rake_collected,\n'
         || E'        period_bbj_contribution   = club_wallets.period_bbj_contribution   + EXCLUDED.period_bbj_contribution,\n'
         || E'        lifetime_rake_collected   = club_wallets.lifetime_rake_collected   + EXCLUDED.lifetime_rake_collected,\n'
         || E'        lifetime_bbj_contribution = club_wallets.lifetime_bbj_contribution + EXCLUDED.lifetime_bbj_contribution,\n'
         || E'        chip_balance              = club_wallets.chip_balance              + EXCLUDED.chip_balance,\n'
         || E'        updated_at                = NOW()\n'
         || E'      RETURNING chip_balance INTO v_cw_after;\n'
         || E'    END IF;\n'
         || E'\n';
  v_new := E'    /* A CLUB''S RAKE TOTAL IS NOT A LOCK ON ITS WALLET (2026-10-02). This used\n'
         || E'       to be an UPDATE of the club''s one club_wallets row, held to COMMIT by\n'
         || E'       every raked hand of every table in the club, and by every tournament\n'
         || E'       finish of the club (which takes the same row first). It was the\n'
         || E'       statement behind 1,518 of the platform''s statement timeouts between\n'
         || E'       18:00 and 19:45 UTC on 2026-10-02 and the lease_proof_expired burst\n'
         || E'       that voided 180 hands at 19:37. The running total is kept per TABLE:\n'
         || E'       a table deals one hand at a time, so its row has one writer. The club\n'
         || E'       figure is the wallet''s own column (tournament rake and history) plus\n'
         || E'       the sum of its tables (fn_club_money_panel). No chip moves here; the\n'
         || E'       club share is paid weekly from the rake treasury (2026-09-02 ruling). */\n'
         || E'    INSERT INTO public.club_table_rake_totals AS t\n'
         || E'           (club_id, table_id, rake_collected, bbj_contribution, hands, updated_at)\n'
         || E'    VALUES (p_club_id, COALESCE(p_table_id, ''00000000-0000-0000-0000-000000000000''::uuid),\n'
         || E'            p_rake, v_bbj, 1, now())\n'
         || E'    ON CONFLICT (club_id, table_id) DO UPDATE\n'
         || E'       SET rake_collected   = t.rake_collected   + EXCLUDED.rake_collected,\n'
         || E'           bbj_contribution = t.bbj_contribution + EXCLUDED.bbj_contribution,\n'
         || E'           hands            = t.hands + 1,\n'
         || E'           updated_at       = now();\n'
         || E'\n'
         || E'    -- The receipt shows the wallet as it stands. Reading it takes no lock.\n'
         || E'    SELECT w.chip_balance INTO v_cw_after\n'
         || E'      FROM public.club_wallets w WHERE w.club_id = p_club_id;\n'
         || E'    IF NOT FOUND THEN\n'
         || E'      INSERT INTO public.club_wallets (club_id, chip_balance) VALUES (p_club_id, 0)\n'
         || E'      ON CONFLICT (club_id) DO NOTHING;\n'
         || E'      SELECT w.chip_balance INTO v_cw_after\n'
         || E'        FROM public.club_wallets w WHERE w.club_id = p_club_id;\n'
         || E'    END IF;\n'
         || E'\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the replaced clause occurs % times in atomic_distribute_rake, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure);
  IF md5(v_after) <> '3cb33db39fdcf0359949f941a178158e' THEN
    RAISE EXCEPTION 'atomic_distribute_rake is not its intended post-image (md5 %)', md5(v_after);
  END IF;
  IF md5(replace(v_after, v_new, v_old)) <> '0ef820b10c57d902b5ab2d5f9e2be8a6' THEN
    RAISE EXCEPTION 'atomic_distribute_rake: the reverse substitution does not reproduce the pinned text';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'atomic_distribute_rake: its privileges changed';
  END IF;
END $subs$;

DO $subs$
DECLARE
  v_def text; v_old text; v_new text; v_n integer; v_after text; v_acl text;
BEGIN
  v_def := pg_get_functiondef('public.fn_club_money_panel(uuid)'::regprocedure);
  IF md5(v_def) <> '1374b5a7a5759e631a8f3ebda5199c91' THEN
    RAISE EXCEPTION 'fn_club_money_panel is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'      SELECT round(COALESCE(w.period_rake_collected, 0), 2) INTO v_club_rake\n'
         || E'        FROM club_wallets w WHERE w.club_id = p_club_id;\n';
  v_new := E'      -- The hand path keeps its share per table (club_table_rake_totals,\n'
         || E'      -- 2026-10-02); the wallet column carries tournament rake and history.\n'
         || E'      SELECT round(COALESCE(w.period_rake_collected, 0)\n'
         || E'                 + COALESCE((SELECT sum(t.rake_collected)\n'
         || E'                               FROM public.club_table_rake_totals t\n'
         || E'                              WHERE t.club_id = p_club_id), 0), 2) INTO v_club_rake\n'
         || E'        FROM club_wallets w WHERE w.club_id = p_club_id;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the replaced clause occurs % times in fn_club_money_panel, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = 'public.fn_club_money_panel(uuid)'::regprocedure;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef('public.fn_club_money_panel(uuid)'::regprocedure);
  IF md5(v_after) <> 'b565ebe80035c2b1af996013c4489211' THEN
    RAISE EXCEPTION 'fn_club_money_panel is not its intended post-image (md5 %)', md5(v_after);
  END IF;
  IF md5(replace(v_after, v_new, v_old)) <> '1374b5a7a5759e631a8f3ebda5199c91' THEN
    RAISE EXCEPTION 'fn_club_money_panel: the reverse substitution does not reproduce the pinned text';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = 'public.fn_club_money_panel(uuid)'::regprocedure) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', 'public.fn_club_money_panel(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_club_money_panel: its privileges changed';
  END IF;
END $subs$;

DO $post$
BEGIN
  IF (SELECT p.prosrc ~ '(?n)^[[:space:]]*UPDATE[[:space:]]+public\.club_wallets'
        FROM pg_proc p WHERE p.oid = 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure) THEN
    RAISE EXCEPTION 'RAKE_STILL_LOCKS_THE_CLUB_WALLET: atomic_distribute_rake';
  END IF;
  IF NOT (SELECT p.prosrc LIKE '%INSERT INTO public.club_table_rake_totals%'
            FROM pg_proc p WHERE p.oid = 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure) THEN
    RAISE EXCEPTION 'RAKE_TOTAL_HAS_NO_HOME: atomic_distribute_rake';
  END IF;
  IF NOT (SELECT p.prosrc LIKE '%public.club_table_rake_totals%'
            FROM pg_proc p WHERE p.oid = 'public.fn_club_money_panel(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'PANEL_DOES_NOT_READ_THE_TABLE_TOTALS: fn_club_money_panel';
  END IF;
END
$post$;

COMMIT;
