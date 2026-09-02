-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826031606; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_club_chip_circulation was DEAD CODE. It was added on 2026-08-25 to print
-- the two pools reconciliation had never looked at (club_members.chip_balance
-- and table_seats.stack) and then nothing called it -- not the nightly run,
-- not the engine, not the client. A diagnostic nobody runs answers no
-- questions, and the playbook's own interrogation is right that dead code is
-- unacceptable.
--
-- It gets the caller it should have had. reconcile_ledger_nightly now records
-- one row per club per night with where that club's chips are, at severity
-- 'ok' -- these are OBSERVATIONS, not findings, and must never be confused
-- with the critical rows beside them.
--
-- WHY THIS IS WORTH A ROW A NIGHT. The seat-exit detector catches a stack that
-- vanishes in ONE event. It cannot see a slow leak -- a few chips per day from
-- some path nobody has thought of. A nightly circulation figure gives a trend
-- line, and a trend is the only way a slow leak is ever visible. The number is
-- carried in `stored_balance` with `ledger_balance` holding the felt alone, so
-- the existing two-column shape of the log still means something: "of this
-- much, this much is sitting on tables".

DO $$
DECLARE
  v_def text;
  v_anchor CONSTANT text := '  -- Recompute the summary counts from what we just inserted today';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reconcile_ledger_nightly';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly does not exist - refusing to guess';
  END IF;
  IF position('chip_circulation' in v_def) > 0 THEN
    RAISE NOTICE 'the nightly run already records circulation';
    RETURN;
  END IF;
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'reconcile_ledger_nightly is not the shape this patch expects';
  END IF;

  EXECUTE replace(v_def, v_anchor,
    E'  -- ── Where the chips actually are (added 2026-08-25) ─────────────────\n'
    || E'  -- OBSERVATIONS, not findings: severity ''ok'' always. The seat-exit\n'
    || E'  -- check above catches a stack that vanishes in one event; this is the\n'
    || E'  -- trend line that makes a SLOW leak visible.\n'
    || E'  INSERT INTO public.ledger_reconcile_log\n'
    || E'    (entity_type, entity_id, ledger_balance, stored_balance, severity, metadata)\n'
    || E'  SELECT ''chip_circulation'', c.club_id, c.on_the_felt, c.total, ''ok'',\n'
    || E'         jsonb_build_object(\n'
    || E'           ''source'', ''fn_club_chip_circulation'',\n'
    || E'           ''club_name'', c.club_name,\n'
    || E'           ''member_wallets'', c.member_wallets,\n'
    || E'           ''on_the_felt'', c.on_the_felt,\n'
    || E'           ''treasury'', c.treasury)\n'
    || E'  FROM public.fn_club_chip_circulation() c\n'
    || E'  WHERE c.total <> 0;\n\n'
    || v_anchor);
END $$;

DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconcile_ledger_nightly';
  IF position('fn_club_chip_circulation' in v_def) = 0 THEN
    RAISE EXCEPTION 'the circulation record did not reach the nightly run';
  END IF;
  -- Everything already in that function must have survived.
  IF position('seat_stack_exit' in v_def) = 0
     OR position('player_wallet' in v_def) = 0
     OR position('club_treasury' in v_def) = 0 THEN
    RAISE EXCEPTION 'an existing reconciliation was dropped by this patch';
  END IF;
END $$;
