-- THE TOURNAMENT POOLS (AND ITS RAKE) TAKE THEIR SCALE IN THE MAINTENANCE FREEZE.
--
-- The other half of 20260906162156. That migration gave eight unconstrained
-- money columns a scale of 2; these two were in it and had to come out,
-- because a rewrite of `tournaments` cannot be slipped in beside live play:
--
--   2026-09-06 16:25:18  deadlock detected
--   Process A waits for AccessExclusiveLock on relation tournaments;
--   blocked by process B.  Process B waits for RowShareLock on auth.users;
--   blocked by process A.
--
-- Nothing was applied - the transaction rolled back whole, which is the
-- design. `tournaments` is 147 MB and every seat, every registration and
-- every finish writes it; ALTER TYPE rewrites the table under ACCESS
-- EXCLUSIVE, so at ~460 hands a minute it is competing with the platform for
-- the one lock nothing else can share.
--
-- SO IT GOES IN THE WINDOW BUILT FOR EXACTLY THIS. CLAUDE.md 13: at :53 every
-- table is told to finish its hand, at :55 the platform FREEZES - no buy-ins,
-- no chip movements, horses do not stand up or rotate - and at :00 the thaw
-- gives every in-flight deadline back the frozen minutes. Between :55 and :00
-- there is no money write to deadlock against. That is when this runs.
--
-- WHAT IT CHANGES, and it is only the storage: both columns hold whole cents
-- today (116,380 rows, zero sub-cent values, maximum 44,640.00 - five integer
-- digits against the eighteen given here). Declaring the scale means a JS
-- double handed to either one is ROUNDED on write instead of stored as its
-- full binary expansion - the way tournament_payouts came to hold
-- 55.629999999999995. No value moves; the door closes.
--
-- AND total_rake RIDES ALONG, because the rewrite is already being paid for.
-- It is scale 4, not unconstrained, so it rounds on write and cannot hold a
-- JS float's expansion - but numeric(18,4) rounds at the FOURTH place, which
-- means it can still store a genuine sub-cent like 0.1665 if a rake
-- calculation ever stops rounding. That is a dormant leak vector (0 of
-- 116,453 rows hold one today, maximum 4,960.0000), and closing it here costs
-- nothing: the same single rewrite of the same table. The other scale-4
-- columns are NOT here - notably rake_records, whose two columns would mean
-- rewriting 1.5 GB, which needs its own decision rather than a free ride.
--
-- All three columns in ONE statement so the table is rewritten once, not three
-- times.
-- `lock_timeout` is deliberately short: inside the freeze the lock should be
-- free, so a long wait means something is holding the table and the migration
-- should abort rather than queue behind it.
--
-- ==========================================================================
-- WHAT THE FIRST FREEZE ATTEMPT TAUGHT, 2026-09-06 23:55-23:57 (both facts
-- were found by running it, and both are why this file changed):
--
-- 1. THE FREEZE IS NOT THE SAME THING AS AN IDLE TABLE. Four consecutive
--    attempts died on `55P03 canceling statement due to lock timeout` while
--    `fn_platform_frozen()` was true the whole time. The holder was not live
--    play at all: pg_cron pid 1035737, `tourney-payout-sweep-hourly`, running
--    244 seconds into a `statement_timeout = 300s` and holding RowShare +
--    AccessShare on `tournaments`. pg_cron does not stop for the freeze -
--    CLAUDE.md 13 says as much, and this is the cost of it. The sweep starts
--    around :51 and can run to :56, so the ACCESS EXCLUSIVE window inside a
--    five-minute freeze is realistically :57 to :00. A retry loop that waits
--    it out lands; widening lock_timeout would only mean queueing behind it,
--    which is what the short timeout exists to prevent.
--
-- 2. A VIEW OWNS A COPY OF THE COLUMN TYPE. Once the lock was granted at
--    23:57:13 the real error arrived: `0A000 cannot alter type of a column
--    used by a view or rule`. `public.tournament_escrow_shadow` selects
--    prize_pool, bounty_pool and total_rake, and Postgres will not retype a
--    column a view reads. Nothing was applied; the transaction rolled back
--    whole, exactly as the deadlock had.
--
--    So the view stands aside and comes back EXACTLY as it was, by the same
--    rule 20260906162156 used for the union auto-ledger trigger: its
--    definition, its options, its comment and its grants are READ FROM THE
--    CATALOGUE, not retyped here, and the recreation cannot drift from the
--    original because it IS the original. It is the escrow shadow - the
--    report that phase 2 used to tell a stale counter from a real gap - so
--    losing or altering it silently would blind exactly the check that finds
--    money problems. The verify block below compares the restored definition
--    against the captured one character for character and aborts if they
--    differ.
-- ==========================================================================
--
-- RUN IT BETWEEN :55 AND :00. If it aborts on lock_timeout, that is the guard
-- telling you something still holds `tournaments` - check
-- `select public.fn_platform_frozen()`, look for the payout sweep in
-- pg_stat_activity, and retry inside the same freeze or take the next break.
-- Never by widening the timeout.

BEGIN;

SET LOCAL lock_timeout = '4s';

DO $pools$
DECLARE
  v_def     text;
  v_opts    text;
  v_comment text;
  v_acl     aclitem[];
  v_back    text;
  r         record;
BEGIN
  -- ------------------------------------------------------------------
  -- CAPTURE. Everything that makes the view what it is, from the catalogue.
  -- ------------------------------------------------------------------
  SELECT pg_get_viewdef(c.oid, true),
         array_to_string(c.reloptions, ', '),
         obj_description(c.oid, 'pg_class'),
         c.relacl
    INTO v_def, v_opts, v_comment, v_acl
    FROM pg_class c
   WHERE c.oid = 'public.tournament_escrow_shadow'::regclass;

  IF v_def IS NULL OR length(v_def) = 0 THEN
    RAISE EXCEPTION 'ABORT: tournament_escrow_shadow has no definition to restore - do not proceed blind, read the catalogue first';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_depend d
               JOIN pg_rewrite rw ON rw.oid = d.objid
               JOIN pg_class dep ON dep.oid = rw.ev_class
              WHERE d.refobjid = 'public.tournament_escrow_shadow'::regclass
                AND dep.oid <> 'public.tournament_escrow_shadow'::regclass) THEN
    RAISE EXCEPTION 'ABORT: something now depends on tournament_escrow_shadow; this migration only knows how to restore the view itself';
  END IF;

  DROP VIEW public.tournament_escrow_shadow;

  ALTER TABLE public.tournaments
    ALTER COLUMN prize_pool  TYPE numeric(18,2),
    ALTER COLUMN bounty_pool TYPE numeric(18,2),
    ALTER COLUMN total_rake  TYPE numeric(18,2);

  -- ------------------------------------------------------------------
  -- RESTORE, from the captured strings and nothing else.
  -- ------------------------------------------------------------------
  EXECUTE format('CREATE VIEW public.tournament_escrow_shadow %s AS %s',
                 CASE WHEN COALESCE(v_opts, '') <> '' THEN 'WITH (' || v_opts || ')' ELSE '' END,
                 v_def);

  IF v_comment IS NOT NULL THEN
    EXECUTE format('COMMENT ON VIEW public.tournament_escrow_shadow IS %L', v_comment);
  END IF;

  FOR r IN
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
           string_agg(a.privilege_type, ', ') AS privs
      FROM aclexplode(v_acl) a
     WHERE a.grantee <> 'postgres'::regrole::oid          -- the owner holds them anyway
     GROUP BY 1
  LOOP
    EXECUTE format('GRANT %s ON public.tournament_escrow_shadow TO %s', r.privs, r.grantee);
  END LOOP;

  -- ------------------------------------------------------------------
  -- IT CAME BACK THE SAME, or this migration does not commit.
  -- ------------------------------------------------------------------
  SELECT pg_get_viewdef('public.tournament_escrow_shadow'::regclass, true) INTO v_back;
  IF v_back IS DISTINCT FROM v_def THEN
    RAISE EXCEPTION 'VERIFY FAILED: the escrow shadow came back DIFFERENT from how it went away';
  END IF;

  IF COALESCE((SELECT array_to_string(reloptions, ', ') FROM pg_class
                WHERE oid = 'public.tournament_escrow_shadow'::regclass), '')
     IS DISTINCT FROM COALESCE(v_opts, '') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the escrow shadow lost its options (security_invoker)';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.tournament_escrow_shadow', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the engine can no longer read the escrow shadow';
  END IF;
END $pools$;

DO $verify$
DECLARE v_notscaled int; v_bad int;
BEGIN
  SELECT count(*) INTO v_notscaled FROM information_schema.columns
   WHERE table_schema='public' AND table_name='tournaments'
     AND column_name IN ('prize_pool','bounty_pool','total_rake')
     AND numeric_scale IS DISTINCT FROM 2;
  IF v_notscaled <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % tournament pool column(s) still carry no scale', v_notscaled;
  END IF;

  SELECT count(*) INTO v_bad FROM public.tournaments
   WHERE prize_pool <> round(prize_pool,2) OR bounty_pool <> round(bounty_pool,2)
      OR total_rake <> round(total_rake,2);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % tournament row(s) hold a sub-cent pool', v_bad;
  END IF;

  /* The whole conservation set, in one place, now that both halves are in. */
  SELECT count(*) INTO v_notscaled FROM information_schema.columns
   WHERE table_schema='public' AND (table_name,column_name) IN (
     ('bomb_pot_award_units','amount'),('tournament_escrow','prize_balance'),
     ('tournament_escrow','fee_balance'),('tournament_escrow','bounty_balance'),
     ('tournament_payouts','amount'),('tournaments','prize_pool'),('tournaments','bounty_pool'),
     ('union_wallets','chip_balance'),('union_wallets','rake_wallet'),
     ('union_wallets','total_rake_collected'))
     AND numeric_scale IS DISTINCT FROM 2;
  IF v_notscaled <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED: % of the ten formerly-unconstrained columns is/are not scale 2', v_notscaled;
  END IF;

  RAISE NOTICE 'CHIP_SCALE_TWO_COMPLETE all ten formerly-unconstrained money columns carry scale 2, and the escrow shadow is back as it was';
END $verify$;

COMMIT;
