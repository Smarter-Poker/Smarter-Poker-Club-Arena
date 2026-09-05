-- HORSE HAND FACTS GO EVERYWHERE, AND GET A RETENTION (Dan, 2026-09-05)
--
-- Dan, asked whether horse fact rows should be written platform-wide rather
-- than only at NIT tables: "YES PLATFORM WIDE."
--
-- WHY IT WAS SCOPED. writeHandFacts wrote horse rows only where tables.nit_game
-- was true, because that is where fn_nit_check judges VPIP and a rule needs its
-- evidence. The cost of the scoping was that a horse's VPIP was measurable ONLY
-- where a floor already forced it. Asked "do horses play a realistic spread on
-- ordinary tables", the honest answer was that nobody could see: 163 of 153,658
-- tables run NIT Game, so 99.9% of horse play left no per-hand trace.
--
-- WHY THIS MIGRATION EXISTS AT ALL. Switching the writer on is one line in
-- handFacts.ts. It is shipped WITH this migration because ca_hand_facts had no
-- retention of any kind - nothing prunes it, and nothing ever has - and
-- platform-wide without a prune is an unbounded table. Measured 2026-09-05
-- before the change:
--
--   ca_hand_facts today            77,052 rows / 42 MB  (575 bytes a row)
--   hands in the last 24h         653,719
--   average seats per hand           3.41
--   => platform-wide              ~2.23M rows a day, ~1.28 GB a day, ~38 GB/mo
--
-- So the prune below, on the SAME policy hand_history already uses: horse rows
-- age out after hand_history_retention_policy.horse_retention_days (7 today),
-- human rows are kept forever. Steady state lands near 9 GB instead of growing
-- without limit. That policy row is the one dial, and changing it changes both
-- tables together, which is the point of reading it rather than hardcoding 7.
--
-- HUMAN ROWS ARE NEVER TOUCHED. Same line hand_history draws, and the reason is
-- the same: a human's hand history is theirs and there is no volume argument
-- for dropping it.

BEGIN;

-- ── The prune ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_prune_ca_hand_facts(p_limit integer DEFAULT 200000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_days    integer;
  v_cutoff  timestamptz;
  v_deleted integer;
BEGIN
  SELECT COALESCE(horse_retention_days, 7) INTO v_days
    FROM public.hand_history_retention_policy LIMIT 1;
  v_days := GREATEST(COALESCE(v_days, 7), 1);
  v_cutoff := now() - make_interval(days => v_days);

  -- Bounded per call. A single unbounded DELETE over a table this size takes a
  -- lock long enough to matter to live dealing, and the caller runs often
  -- enough that a ceiling per pass costs nothing.
  WITH doomed AS (
    SELECT f.hand_id, f.user_id
      FROM public.ca_hand_facts f
      JOIN public.profiles p ON p.id = f.user_id
     WHERE COALESCE(p.is_horse, false)      -- HORSE ROWS ONLY. 10.5 is about
                                            -- not DENYING horses things; a
                                            -- retention window is a storage
                                            -- policy on our own telemetry, and
                                            -- hand_history already draws this
                                            -- exact line with Dan's sign-off.
       AND f.played_at < v_cutoff
     LIMIT GREATEST(COALESCE(p_limit, 200000), 1)
  )
  DELETE FROM public.ca_hand_facts f
   USING doomed d
   WHERE f.hand_id = d.hand_id AND f.user_id = d.user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'deleted', v_deleted,
    'cutoff', v_cutoff,
    'retention_days', v_days,
    'more', v_deleted >= GREATEST(COALESCE(p_limit, 200000), 1)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_prune_ca_hand_facts(integer) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.fn_prune_ca_hand_facts(integer) IS
  'Ages horse ca_hand_facts rows out on hand_history_retention_policy.horse_retention_days. Human rows are never deleted. Bounded per call; re-run while it answers more=true.';

-- The index the prune needs. Without it the DELETE seq-scans a table that is
-- about to become 2.23M rows a day.
CREATE INDEX IF NOT EXISTS ca_hand_facts_played_at_idx
  ON public.ca_hand_facts (played_at);

-- ── Schedule it ────────────────────────────────────────────────────────────
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('prune-ca-hand-facts')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-ca-hand-facts');
    PERFORM cron.schedule(
      'prune-ca-hand-facts',
      '17 * * * *',
      $cron$SELECT public.fn_prune_ca_hand_facts(200000);$cron$
    );
    RAISE NOTICE 'scheduled prune-ca-hand-facts hourly at :17';
  ELSE
    RAISE NOTICE 'pg_cron absent - fn_prune_ca_hand_facts must be driven by the worker fleet';
  END IF;
END
$sched$;

-- ── Prove the prune before trusting it ─────────────────────────────────────
-- Runs with a limit of zero-effect: a cutoff far in the future would delete
-- everything, so instead assert the function is callable and returns the shape
-- the caller expects, without deleting anything it would not have deleted
-- anyway on its own schedule.
DO $verify$
DECLARE r jsonb;
BEGIN
  r := public.fn_prune_ca_hand_facts(0);   -- clamps to 1 row max
  IF r ? 'deleted' AND r ? 'cutoff' AND r ? 'retention_days' THEN
    RAISE NOTICE 'prune smoke test ok: %', r;
  ELSE
    RAISE EXCEPTION 'fn_prune_ca_hand_facts returned an unexpected shape: %', r;
  END IF;
END
$verify$;

COMMIT;
