-- ============================================================================
-- A FINISH DOES NOT HOLD THE UNION WALLET
-- ============================================================================
--
-- WHAT WAS WRONG, MEASURED ON PRODUCTION 2026-10-03 03:00-05:20 UTC
--
-- The postgres log carries 3,469 "canceling statement due to statement
-- timeout" errors from 03:00 to 05:04, and 1,100+ of them (plus 31 "deadlock
-- detected") have the same innermost statement: the raked cash hand's credit
-- of the union rake treasury inside atomic_distribute_rake, called from
-- fn_ca_process_hand_post_commit_obligations,
--
--     INSERT INTO public.union_wallets (...) ON CONFLICT (union_id) DO UPDATE
--        SET rake_wallet = rake_wallet + p_rake, ...
--
-- 977 of them carry no "while locking tuple" line at all: they were queued
-- for the tuple lock behind a waiter that was. union_wallets has ONE live row.
--
-- Who holds that row. Ten pg_stat_activity samples between 05:16 and 05:18
-- found it held by fn_complete_tournament_terminal in seven, for 0.3 to 6.1 s
-- of transaction age, with the union's raked hands waiting on its
-- transactionid; and EVERY one of the 31 union_wallets deadlocks pairs a hand
-- with fn_complete_tournament_terminal. The finish takes the row here,
--
--     PERFORM 1 FROM public.union_wallets uw WHERE uw.union_id IN (...)
--      ORDER BY uw.union_id FOR NO KEY UPDATE;
--
-- near the top of fn_complete_tournament_terminal_pre_seat_guard, before its
-- evidence locks, and keeps it to COMMIT: through the evidence locks on the
-- event's tables and seats (which wait on in-flight hands), the cash
-- authority, the bounty close, the rake settlement with its bounded
-- recognition retry, the escrow close and the lifecycle. About 230 finishes
-- every ten minutes (3-player spins, all in the one union) each hold the
-- union's one wallet for their whole body, so the union's ~1.5 raked hands a
-- second spent most of the wall clock queued behind finishes, and an episode
-- of slow finishes pushed the queue past the 8 s service_role timeout. While a
-- finish waited on a hand's VIP carry row it held the wallet the hand was
-- waiting for: those are the deadlocks.
--
-- WHY THE LOCK MOVES AND NOTHING ELSE DOES
--
-- The finish reads nothing from union_wallets and writes it in exactly two
-- places, both of which lock the row themselves before they read it:
--
--   fn_ca_return_excess_start_overlay_locked / fn_ca_apply_prize_guarantee_core
--       SELECT ... FROM public.union_wallets ... FOR UPDATE, then UPDATE
--       (only for an event that carries a guarantee overlay)
--   fn_settle_tournament_rake -> increment_union_wallet
--       INSERT ... ON CONFLICT DO UPDATE rake_wallet = rake_wallet + fee
--
-- So the pre-lock is not a balance guard. Its job, stated beside it, is ORDER:
-- "Pre-owning both paths prevents two same-scope finishes from taking those
-- shared banks in opposite order." That job is kept exactly: every finish of
-- a union still takes one exclusive lock per union, sorted, at the same point
-- (after its club wallet, before its club row), so finishes of a union are
-- serialized precisely as before. The lock is an advisory lock that ONLY
-- finishes take - 'ca:union-finish-bank:v1:<union>' - instead of the wallet
-- row that every raked hand, tournament start and union transfer must also
-- write. The row is then held from the finish's first real write of it (the
-- guarantee, or the fee credit) to COMMIT, not for the whole body.
--
-- What this also ends: the start guard (fn_guard_tournament_start_readiness)
-- takes clubs then union_wallets; the finish took union_wallets then clubs.
-- The finish now takes clubs first too.
--
-- Money: no balance, journal, receipt, idempotency key or conservation check
-- changes. No row is written by this migration. Nothing is backfilled and
-- nothing is repaired (CLAUDE.md 10.12).
--
-- Asserted substitution over the pinned live text (pg_get_functiondef md5):
--   fn_complete_tournament_terminal_pre_seat_guard
--     de4a79604fed8edcd5b94aea968516bc -> 587f4eb17a08a0b2a2570be1662071a6
--
-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '587f4eb17a08a0b2a2570be1662071a6' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fn_complete_tournament_terminal_pre_seat_guard')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

DO $subs$
DECLARE
  v_sig regprocedure := 'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure;
  v_def text; v_old text; v_new text; v_n integer; v_after text; v_acl text;
BEGIN
  v_def := pg_get_functiondef(v_sig);
  IF md5(v_def) <> 'de4a79604fed8edcd5b94aea968516bc' THEN
    RAISE EXCEPTION 'fn_complete_tournament_terminal_pre_seat_guard is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'    PERFORM 1 FROM public.union_wallets uw\n'
        || E'     WHERE uw.union_id IN (\n'
        || E'       SELECT DISTINCT x.union_id\n'
        || E'         FROM unnest(ARRAY[v_event_union_id,v_current_union_id]::uuid[]) x(union_id)\n'
        || E'        WHERE x.union_id IS NOT NULL)\n'
        || E'     ORDER BY uw.union_id FOR NO KEY UPDATE;\n';
  v_new := E'    /* A FINISH DOES NOT HOLD THE UNION WALLET (2026-10-03). This was a\n'
        || E'       NO KEY UPDATE pre-lock of union_wallets - the union\'s one\n'
        || E'       wallet row - held from here to COMMIT through the\n'
        || E'       whole finish, so every raked cash hand of the union queued at\n'
        || E'       its rake credit behind every finish (1,100+ statement timeouts\n'
        || E'       and 31 deadlocks, 03:00-05:04 UTC). Finishes of a union still\n'
        || E'       serialize here, sorted, at this same point, on a lock only\n'
        || E'       finishes take. The wallet row is locked where it is written:\n'
        || E'       the guarantee core and the excess-overlay return lock it\n'
        || E'       before they read it, and increment_union_wallet credits the\n'
        || E'       fee. */\n'
        || E'    IF LEAST(v_event_union_id,v_current_union_id) IS NOT NULL THEN\n'
        || E'      PERFORM pg_advisory_xact_lock(hashtextextended(\n'
        || E'        \'ca:union-finish-bank:v1:\' || LEAST(v_event_union_id,v_current_union_id)::text, 0));\n'
        || E'    END IF;\n'
        || E'    IF GREATEST(v_event_union_id,v_current_union_id)\n'
        || E'         IS DISTINCT FROM LEAST(v_event_union_id,v_current_union_id) THEN\n'
        || E'      PERFORM pg_advisory_xact_lock(hashtextextended(\n'
        || E'        \'ca:union-finish-bank:v1:\' || GREATEST(v_event_union_id,v_current_union_id)::text, 0));\n'
        || E'    END IF;\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the replaced union pre-lock occurs % times, expected exactly 1', v_n;
  END IF;
  SELECT p.proacl::text INTO v_acl FROM pg_proc p WHERE p.oid = v_sig;
  EXECUTE replace(v_def, v_old, v_new);
  v_after := pg_get_functiondef(v_sig);
  IF md5(v_after) <> '587f4eb17a08a0b2a2570be1662071a6' THEN
    RAISE EXCEPTION 'fn_complete_tournament_terminal_pre_seat_guard is not its intended post-image (md5 %)', md5(v_after);
  END IF;
  IF md5(replace(v_after, v_new, v_old)) <> 'de4a79604fed8edcd5b94aea968516bc' THEN
    RAISE EXCEPTION 'the reverse substitution does not reproduce the pinned text';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_sig) IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_complete_tournament_terminal_pre_seat_guard: its privileges changed';
  END IF;
END $subs$;

DO $post$
DECLARE
  v_src text := (SELECT p.prosrc FROM pg_proc p
                  WHERE p.oid = 'public.fn_complete_tournament_terminal_pre_seat_guard(uuid,uuid,text)'::regprocedure);
BEGIN
  IF v_src ~ 'FROM public\.union_wallets[^;]*FOR (NO KEY )?UPDATE' THEN
    RAISE EXCEPTION 'FINISH_STILL_HOLDS_THE_UNION_WALLET';
  END IF;
  IF position('ca:union-finish-bank:v1:' IN v_src) = 0
     OR position('ca:union-finish-bank:v1:' IN v_src) > position('public.fn_settle_tournament_places(' IN v_src)
     OR position('PERFORM 1 FROM public.club_wallets cw' IN v_src) > position('ca:union-finish-bank:v1:' IN v_src) THEN
    RAISE EXCEPTION 'FINISH_UNION_ORDER_LOST: the union claim must follow the club wallet and precede the cash authority';
  END IF;
END
$post$;

COMMIT;
