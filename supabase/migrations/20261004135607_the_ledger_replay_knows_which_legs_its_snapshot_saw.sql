-- 20261004135607_the_ledger_replay_knows_which_legs_its_snapshot_saw.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE LEDGER REPLAY KNOWS WHICH LEGS ITS SNAPSHOT SAW
--
-- What happened. The nightly replay (fn_ca_ledger_replay, job 286) judges each
-- account by the legs committed after its previous reading, and since v4
-- (2026-09-10) it decides "after" with
--   NOT pg_visible_in_snapshot(fn_ca_xid8(l.xmin), <previous read_snapshot>).
-- A pg_snapshot carries only TOP-LEVEL in-progress xids. A leg written inside a
-- subtransaction (any plpgsql BEGIN ... EXCEPTION block: tournament payouts,
-- the promo sweep) has a SUBTRANSACTION xid as its xmin. If its top-level
-- transaction was still running when the previous reading was taken, the
-- subxid is above the snapshot's xmin, below its xmax and absent from xip, so
-- pg_visible_in_snapshot calls it visible: the leg is treated as already
-- counted by the previous reading although the balance that reading recorded
-- did not include it. It is then excluded from BOTH windows and reads as drift
-- for ever.
--
-- Measured on the reading of 2026-10-01 06:47 (snapshot xmin 750496174,
-- xmax 750500872), judged on 2026-10-04 06:41:
--   - tournament a7f2e09c's finish (txn timestamp 06:39:52.967498) wrote its
--     190.00 prize leg as xid 750498527 and its 10.00 rake leg as 750498599:
--     two xids, one transaction - subtransactions - both "visible", neither in
--     the balances. Player 70fa710b read +190.00 unexplained (critical incident
--     c8a4dcb2) and Midway's rake treasury +10.00 (the residual on incident
--     30bf6669 after its unlabeled legs, 20261004123650).
--   - the 06:40:00.71 promo sweep of 6.21 (xid 750500000) read the same way:
--     the jackpot pool's promo -6.21 (f972f5db) and Deep Stack's club promo
--     +6.21 (89f91485), each other's mirror.
-- Proved by pg_visible_in_snapshot on the stored snapshot: true for all three
-- xids; the top-level xids of that window (750498100, 750498145, 750499996)
-- are in xip.
--
-- The fix, at the reader. Postgres cannot map a subxid to its top-level xid
-- in SQL, but the reading itself can see exactly which rows were committed:
-- the replay runs in REPEATABLE READ (job 286), so every statement of the run
-- shares the one snapshot it stores. Before it returns, the run records the ids
-- of every leg it can see whose xid is at or above that snapshot's xmin - the
-- only xids pg_visible_in_snapshot can misjudge - in
-- public.ca_ledger_replay_readings. The next run treats a leg as already
-- counted only when it is visible in the previous snapshot AND (its xid is
-- below that snapshot's xmin, where a subxid can never be in progress, OR the
-- previous run saw it). A previous reading with no recorded row (every reading
-- before this migration, or one taken outside REPEATABLE READ) keeps the v4
-- rule exactly, so this changes nothing until the next run has recorded one.
--
-- @live-proof: to_regclass('public.ca_ledger_replay_readings') IS NOT NULL
-- @live-proof: position('ca_ledger_replay_readings' in pg_get_functiondef('public.fn_ca_ledger_replay(integer)'::regprocedure)) > 0
-- @live-proof: position('ca_ledger_replay_readings' in pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure)) > 0
-- @live-proof: position('ca_ledger_replay_readings' in pg_get_functiondef('public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.ca_ledger_replay_readings (
  read_snapshot  text PRIMARY KEY,
  read_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_legs uuid[] NOT NULL
);
ALTER TABLE public.ca_ledger_replay_readings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_ledger_replay_readings FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.ca_ledger_replay_readings IS
  'Ledger replay (20261004135607): for each reading snapshot, the chip_ledger legs with xid >= the snapshot xmin that the reading could actually see. A subtransaction xid of a running transaction reads as visible to pg_visible_in_snapshot; this list is the reading''s own answer.';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
 -- 1 and 2. The two window readers.
 a:=$a$       AND NOT pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), p_prev_snapshot)
$a$;
 r:=$r$       AND NOT (pg_visible_in_snapshot(public.fn_ca_xid8(l.xmin), p_prev_snapshot)
                AND (public.fn_ca_xid8(l.xmin) < pg_snapshot_xmin(p_prev_snapshot)
                     OR NOT EXISTS (SELECT 1 FROM public.ca_ledger_replay_readings rr
                                     WHERE rr.read_snapshot = p_prev_snapshot::text)
                     OR l.id = ANY (SELECT unnest(rr.committed_legs) FROM public.ca_ledger_replay_readings rr
                                     WHERE rr.read_snapshot = p_prev_snapshot::text)))
$r$;
 s:='public.fn_ca_leg_accounts_since_snapshot(timestamptz,pg_snapshot)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'ec36a30011e62e266e3385ef407fe064' THEN RAISE EXCEPTION 'since preimage %',md5(d); END IF;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>2 THEN RAISE EXCEPTION 'since anchor count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'since postimage differs from the substituted text'; END IF;

 s:='public.fn_ca_leg_accounts_since_snapshot_for(timestamptz,pg_snapshot,uuid[])'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'2994dc949e5ed22c3f8f0ef832652cb8' THEN RAISE EXCEPTION 'since_for preimage %',md5(d); END IF;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>2 THEN RAISE EXCEPTION 'since_for anchor count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'since_for postimage differs from the substituted text'; END IF;

 -- 3. The replay records what its snapshot saw.
 s:='public.fn_ca_ledger_replay(integer)'::regprocedure;
 d:=pg_get_functiondef(s);
 IF md5(d)<>'8bd897bd17bde110e610ef3d3564f25e' THEN RAISE EXCEPTION 'replay preimage %',md5(d); END IF;
 a:=$a$    PERFORM public.fn_ca_kill_switch_trip('fn_ca_ledger_replay', v_worst,$a$;
 r:=$r$    /* WHAT THIS SNAPSHOT SAW (20261004135607). Under REPEATABLE READ every
       statement of this run reads the snapshot stored on its readings, so the
       legs this statement can see ARE the legs that reading saw. Only xids at
       or above the snapshot's xmin can be misjudged by pg_visible_in_snapshot
       (a subtransaction of a running transaction), and the next window only
       looks back to its previous reading minus 15 minutes. */
    IF current_setting('transaction_isolation') = 'repeatable read' THEN
      INSERT INTO public.ca_ledger_replay_readings (read_snapshot, read_at, committed_legs)
      SELECT pg_current_snapshot()::text, clock_timestamp(), COALESCE(array_agg(l.id ORDER BY l.id), '{}')
        FROM public.chip_ledger l
       WHERE l.created_at > v_now - interval '30 minutes'
         AND public.fn_ca_xid8(l.xmin) >= pg_snapshot_xmin(pg_current_snapshot())
      ON CONFLICT (read_snapshot) DO NOTHING;
    END IF;

    PERFORM public.fn_ca_kill_switch_trip('fn_ca_ledger_replay', v_worst,$r$;
 IF (length(d)-length(replace(d,a,'')))/length(a)<>1 THEN RAISE EXCEPTION 'replay anchor count'; END IF;
 d:=replace(d,a,r);
 EXECUTE d;
 IF pg_get_functiondef(s)<>d THEN RAISE EXCEPTION 'replay postimage differs from the substituted text'; END IF;
END
$mig$;

COMMIT;
