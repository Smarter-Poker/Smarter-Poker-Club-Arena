-- ============================================================================
-- A RAKED HAND TAKES ITS CLUB WALLET WHERE IT DID
-- ============================================================================
--
-- Reverses ONE of the eight changes of 20261001000000_the_chip_estate_takes_its_locks_in_one_order:
-- atomic_distribute_rake returns, byte for byte, to the body it had before (md5
-- 0ef820b10c57d902b5ab2d5f9e2be8a6). The other seven changes stand.
--
-- WHAT HAPPENED. 20261001000000 (applied 2026-10-01 00:05:08 UTC) had atomic_distribute_rake
-- lock the club wallet before the rake record, so a raked hand and a tournament finish would
-- take club_wallets before the players' VIP carry rows - the finish's order. It ended that
-- deadlock pair. But a hand's obligations then HELD the club wallet through everything the
-- rake record's insert waits on, including the foreign-key checks on profiles that the horse
-- claims (fn_ca_horse_claim_due, one transaction of up to 500 claims, 80 s at 00:20) hold
-- FOR UPDATE. The club's other hands queued on the wallet instead of on its day rake row, and
-- the finishes - which take the wallet first - queued behind them: in the ten minutes after
-- the apply, finishes waited on club_wallets 80 times and two hit their 45 s statement timeout,
-- against 0 to 15 waits an hour and no timeout in the 24 hours before (production log). A
-- finish holds the global settlement lane while it waits, so that is a regression on the
-- tournament settlement path, and it is worse than the deadlocks it removed. Restored now.
--
-- The finish x raked-hand pair (837 deadlocks a day) is open again and reported; the order
-- that ends it must not make the finish wait on a hand that waits on the horse claims.
--
-- An asserted substitution over the pinned live text, the exact reverse of the one applied.
--
-- PINNED LIVE md5(pg_get_functiondef(oid)), read 2026-10-01, and AFTER:
--   atomic_distribute_rake   ea7a4a403969a0fbe69f2216d63a0436 -> 0ef820b10c57d902b5ab2d5f9e2be8a6
--
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '0ef820b10c57d902b5ab2d5f9e2be8a6' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  v_def text; v_old text; v_new text; v_n integer; v_after text; v_acl text;
BEGIN
  v_def := pg_get_functiondef('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure);
  IF md5(v_def) <> 'ea7a4a403969a0fbe69f2216d63a0436' THEN
    RAISE EXCEPTION 'atomic_distribute_rake is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'  PERFORM public.fn_lock_cash_bank_accounting_week(p_club_id,v_union_id,transaction_timestamp());\n'
         || E'\n'
         || E'  /* THE CLUB WALLET BEFORE THE RAKE RECORD (2026-10-01). The rake record''s\n'
         || E'     insert triggers take the hand''s players'' VIP carry rows and the club''s\n'
         || E'     daily rake row, and the wallet UPDATE below came after them. A tournament\n'
         || E'     finish takes this same club_wallets row first (tournament, club_wallets,\n'
         || E'     union_wallets, clubs - fn_complete_tournament_terminal_pre_seat_guard)\n'
         || E'     and credits its players'' VIP carry rows last, so a finish and a raked\n'
         || E'     hand of one club took the same rows in opposite orders and deadlocked\n'
         || E'     (vip_points_carry, club_wallets, ca_club_rake_daily). Taken bare, here,\n'
         || E'     the wallet comes first as it does for the finish; the UPDATE below\n'
         || E'     re-takes a lock this transaction already holds. Only the order changes. */\n'
         || E'  PERFORM 1 FROM public.club_wallets WHERE club_id = p_club_id FOR NO KEY UPDATE;\n'
         || E'\n'
         || E'  INSERT INTO public.rake_records (\n';
  v_new := E'  PERFORM public.fn_lock_cash_bank_accounting_week(p_club_id,v_union_id,transaction_timestamp());\n'
         || E'\n'
         || E'  INSERT INTO public.rake_records (\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the wallet-first clause occurs % times in atomic_distribute_rake, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p
   WHERE p.oid = 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef('public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure);
  IF md5(v_after) <> '0ef820b10c57d902b5ab2d5f9e2be8a6' THEN
    RAISE EXCEPTION 'atomic_distribute_rake is not its body of before 20261001000000 (md5 %)', md5(v_after);
  END IF;
  IF md5(replace(v_after, v_new, v_old)) <> 'ea7a4a403969a0fbe69f2216d63a0436' THEN
    RAISE EXCEPTION 'atomic_distribute_rake: the reverse substitution does not reproduce the pinned text';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p
       WHERE p.oid = 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure)
     IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'atomic_distribute_rake: grants moved';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE cash_games_enabled OR tournaments_enabled) THEN
    RAISE EXCEPTION 'this migration must not open an arena switch';
  END IF;
  RAISE NOTICE 'a raked hand takes its club wallet where it did: atomic_distribute_rake restored, nothing else changed';
END $subs$;

COMMIT;
