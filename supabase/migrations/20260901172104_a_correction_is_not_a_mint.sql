-- A ledger-only correction is not chip issuance.
--
-- fn_ca_supply_snapshot computes
--
--     unexplained = delta(measured balances) - mint + burn
--
-- and since the 2026-09-01 12:25 rewrite it derives mint and burn
-- symmetrically: anything leaving a non-circulating store
-- (system_mint, system_burn, issuance_reserve, chip_retirement) is issuance,
-- anything entering one is retirement. That rule is right for real movements.
--
-- It is wrong for corrections. fn_ca_post_correction writes a linked,
-- balance-neutral row - it moves no chips at all, by construction; its whole
-- job is to make the books agree with balances that already moved. Feeding a
-- balance-neutral row into a formula whose other term is a balance DELTA
-- guarantees a spurious unexplained exactly equal to the correction.
--
-- That is what happened today. Three corrections were posted reversing the
-- portions of the 11:00:37 Deep Stack teardown retirement that the restores had
-- undone (4,159,644.00 + 3,340,000.00 + 2,401,355.48). Each one moved nothing.
-- The 14:05 snapshot nevertheless reported -5,743,762.70 unexplained, which is
-- the interval's real movement of -2,407.22 minus the 5,741,355.48 of
-- corrections posted inside it, to the cent. That number then sat in the
-- trailing-4h window and turned the 15:05 interval - a -1,529.72 wobble, which
-- is ordinary play - into a CRITICAL under the same-sign rule.
--
-- So a correct correction manufactured a four-hour run of false alarms, and the
-- more diligently drift is corrected the noisier the detector becomes. That is
-- backwards.
--
-- The fix is one clause: mint and burn ignore rows that fn_ca_post_correction
-- wrote. It is deliberately narrow - only the sanctioned, linkage-checked,
-- balance-neutral path is excluded. A correction posted any other way, or a
-- real movement that happens to carry category='correction', still counts.
--
-- Applied as a targeted patch of the live definition rather than a retyped
-- 5.4KB body, because transcribing the supply watcher by hand to change one
-- WHERE clause is the riskier of the two. The marker is asserted unique before
-- the substitution and the result is asserted after.

DO $patch$
DECLARE
  v_def text;
  v_marker text := 'WHERE created_at > prev.taken_at;';
  v_replacement text :=
    'WHERE created_at > prev.taken_at' || E'\n' ||
    '       /* A correction moves no balance (see a_correction_is_not_a_mint):' || E'\n' ||
    '          counting it as issuance invents drift equal to itself. */' || E'\n' ||
    '       AND NOT (category = ''correction''' || E'\n' ||
    '                AND metadata->>''posted_via'' = ''fn_ca_post_correction'');';
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_supply_snapshot';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_ca_supply_snapshot does not exist';
  END IF;

  SELECT count(*) INTO v_hits FROM regexp_matches(v_def, 'WHERE created_at > prev\.taken_at;', 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'expected exactly one mint/burn window clause to patch, found % - the function changed shape, patch it by hand', v_hits;
  END IF;

  IF position('posted_via' in v_def) > 0 THEN
    RAISE EXCEPTION 'fn_ca_supply_snapshot already excludes corrections - nothing to do';
  END IF;

  v_def := replace(v_def, v_marker, v_replacement);
  EXECUTE v_def;
END $patch$;

-- Re-baseline in the same migration that changed it, so the guard watcher does
-- not raise a notice about a change that is already documented here.
UPDATE public.ca_guard_defs d
   SET def_hash = (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = 'fn_ca_supply_snapshot'),
       updated_at = now()
 WHERE d.proname = 'fn_ca_supply_snapshot';

DO $$
DECLARE v_src text; v_base int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_supply_snapshot';
  IF v_src NOT LIKE '%posted_via%' THEN
    RAISE EXCEPTION 'the correction exclusion did not land in fn_ca_supply_snapshot';
  END IF;
  IF v_src NOT LIKE '%fn_ca_noncirculating_chip_stores%' THEN
    RAISE EXCEPTION 'the patch damaged the mint/burn rule - it no longer reads the non-circulating store list';
  END IF;

  SELECT count(*) INTO v_base
    FROM public.ca_guard_defs d
   WHERE d.proname = 'fn_ca_supply_snapshot'
     AND d.def_hash = (SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid))
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = 'fn_ca_supply_snapshot');
  IF v_base <> 1 THEN
    RAISE EXCEPTION 'fn_ca_supply_snapshot was not re-baselined and will raise a guard notice about this migration';
  END IF;
END $$;
