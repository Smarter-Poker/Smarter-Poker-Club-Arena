-- 20260905075122_the_journal_is_never_refused_by_the_freeze.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (chip standard, 2026-09-05):
--
-- Two bbj-meter incidents at hour 06 carried "3 ledger write failure(s)".
-- ca_ledger_write_failures held 104 rows with sqlstate 55006 PLATFORM_FROZEN
-- (9.69 chips in all; 13 of them since 09-04 18:25) on a chip_ledger INSERT made by fn_ca_autoledger for
-- a bbj_pools write at :55 or :00. The writer was fn_ca_auto_reconcile_tick
-- (pg_cron, every minute, runs as postgres with no service_role claim, does
-- not stop for the break) calling fn_bbj_repair_unbanked, which re-banks a
-- recorded drop into bbj_pools. bbj_pools is not one of the seven tables the
-- freeze guards, so the bank write stood; chip_ledger IS guarded, so the leg
-- was refused; the autoledger logged the refusal and let the write through,
-- as it is built to (a guard that can refuse a bank write mid-hand strands
-- a player). Result: a bank moved and the journal did not, which is exactly
-- the movement the BBJ meter flagged.
--
-- Two fixes, both sides:
--   1. fn_refuse_while_frozen lets a chip_ledger row through when it is
--      written from inside another trigger (pg_trigger_depth() > 1): that row
--      is the record of a write the freeze already permitted. A direct client
--      INSERT on chip_ledger (depth 1) is refused as before.
--   2. fn_bbj_repair_unbanked returns empty while the platform is frozen and
--      re-banks at the next tick after play resumes (section 13 rule 5).
-- Named for its owner: fn_redrive_unbanked_rake runs from the same tick with
-- the same exposure.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_refuse_while_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col  TEXT;
  changed BOOLEAN := FALSE;
  v_claims TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
        changed := TRUE;
        EXIT;
      END IF;
    END LOOP;
    IF NOT changed THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ONBOARDING NEVER FREEZES (to-do #2563 item 1). A membership row carrying
  -- no chips is identity, not money. This table, INSERT only, zero balance.
  IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'chip_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- CHIP STANDARD (2026-09-05): A JOURNAL ROW IS THE RECORD OF A WRITE, NOT A
  -- WRITE. When a balance write was permitted (a money table outside this
  -- guard, or a permitted role), its chip_ledger leg is written by the
  -- autoledger inside that same statement, at trigger depth 2 or more.
  -- Refusing the leg while the write stands is the one outcome the standard
  -- cannot allow: 104 BBJ bank moves (9.69 chips) lost their legs this way at :55 and
  -- :00 up to 09-05 06:58 (ca_ledger_write_failures, sqlstate 55006), each one an unexplained movement on the BBJ meter. A direct
  -- INSERT on chip_ledger from a client (depth 1) is still refused.
  IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. % on % was refused; it will succeed when play resumes.',
      TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55006',
            HINT = 'Scheduled maintenance breaks run from :55 to :00. Nothing is lost - retry after the break.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_bbj_repair_unbanked(p_since_hours integer DEFAULT 48, p_limit integer DEFAULT 200)
 RETURNS TABLE(hand_id uuid, table_id uuid, club_id uuid, pool_id uuid, amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_pool_id uuid; v_main numeric; v_backup numeric; v_promo numeric;
  v_current_main numeric; v_inserted uuid;
BEGIN
  -- CHIP STANDARD (2026-09-05): a sweep that moves money checks the freeze
  -- (CLAUDE.md section 13 rule 5). fn_ca_auto_reconcile_tick runs this every
  -- minute from pg_cron, which does not stop for the break, and bbj_pools is
  -- not under the freeze guard; the drops it re-banked at :55 and :00 were
  -- the ones whose legs the freeze refused. It returns empty during the break
  -- and re-banks them at the next tick after play resumes.
  IF public.fn_platform_frozen() THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT rr.hand_id AS h_id, rr.table_id AS t_id, rr.club_id AS c_id,
           SUM(rr.bbj_contribution) AS amt,
           MAX(COALESCE((rr.metadata->>'big_blind')::numeric, 0)) AS bb,
           MIN(rr.created_at) AS hand_at
    FROM public.rake_records rr
    WHERE rr.hand_id IS NOT NULL
      AND COALESCE(rr.bbj_contribution, 0) > 0
      AND rr.created_at > now() - make_interval(hours => p_since_hours)
      AND rr.created_at < now() - interval '5 minutes'
      AND NOT EXISTS (SELECT 1 FROM public.bbj_contributions bc WHERE bc.hand_id = rr.hand_id)
    GROUP BY rr.hand_id, rr.table_id, rr.club_id
    ORDER BY MIN(rr.created_at)
    LIMIT p_limit
  LOOP
    SELECT bp.id, bp.main_balance INTO v_pool_id, v_current_main
    FROM public.bbj_pools bp
    WHERE bp.status = 'active'
      AND ((bp.union_id = (SELECT c.union_id FROM public.clubs c WHERE c.id = r.c_id))
        OR (bp.club_id = r.c_id AND (SELECT c.union_id FROM public.clubs c WHERE c.id = r.c_id) IS NULL))
    ORDER BY (bp.union_id IS NOT NULL) DESC
    LIMIT 1
    FOR UPDATE OF bp;

    CONTINUE WHEN v_pool_id IS NULL;

    -- ONE ALLOCATOR (Phase 4.3): the same split the drop uses, residue carried.
    SELECT a.main_portion, a.backup_portion, a.promo_portion INTO v_main, v_backup, v_promo
      FROM public.fn_bbj_allocate(r.amt, v_current_main, v_pool_id) a;

    -- ZERO-DRIFT phase 2: repaired drops = bbj_contribution vs table_stack.
    PERFORM set_config('app.ledger_category', 'bbj_contribution', true);
    PERFORM set_config('app.ledger_counterparty', 'table_stack', true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(r.t_id::text, ''), true);

    WITH ins AS (
      INSERT INTO public.bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number, created_at
      )
      SELECT v_pool_id, r.h_id, r.t_id, r.c_id, r.amt,
             v_main, v_backup, v_promo, NULLIF(r.bb, 0), NULL, r.hand_at
      WHERE NOT EXISTS (SELECT 1 FROM public.bbj_contributions bc WHERE bc.hand_id = r.h_id)
      RETURNING id
    ),
    upd AS (
      UPDATE public.bbj_pools bp
      SET main_balance      = bp.main_balance + v_main,
          backup_balance    = bp.backup_balance + v_backup,
          promo_balance     = bp.promo_balance + v_promo,
          total_contributed = COALESCE(bp.total_contributed, 0) + r.amt,
          hands_contributed = COALESCE(bp.hands_contributed, 0) + 1,
          updated_at        = now()
      FROM ins WHERE bp.id = v_pool_id RETURNING bp.id
    )
    SELECT ins.id INTO v_inserted FROM ins;

    IF v_inserted IS NOT NULL THEN
      hand_id := r.h_id; table_id := r.t_id; club_id := r.c_id;
      pool_id := v_pool_id; amount := r.amt;
      RETURN NEXT;
    END IF;
  END LOOP;
  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_bbj_repair_unbanked(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_repair_unbanked(integer, integer) TO service_role;

UPDATE public.ca_drift_incidents
   SET status = 'resolved', resolved_at = now(),
       correction_ref = 'migration 20260905075122_the_journal_is_never_refused_by_the_freeze',
       root_cause = 'fn_ca_auto_reconcile_tick (pg_cron, no service_role claim) re-banked BBJ drops during the :55 freeze; bbj_pools is outside the freeze guard so the bank write stood while the chip_ledger leg it produced was refused as PLATFORM_FROZEN and logged to ca_ledger_write_failures',
       resolution = 'the freeze guard passes a chip_ledger row written from inside another trigger (the record of a permitted write), and fn_bbj_repair_unbanked does not move money while the platform is frozen; the 104 refused legs total 9.69 chips; the BBJ meter compares each interval against its own legs, so each one was flagged in its hour and none recurs'
 WHERE dedupe_key IN ('bbj-meter:9b73034b-2794-465c-9b13-19ee1d14b639:2026-09-05-06', 'bbj-meter:a7a65cfc-64e8-4134-afe5-68d3c1a86348:2026-09-05-06') AND status = 'open';

DO $$
DECLARE v_open int;
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_refuse_while_frozen') NOT LIKE '%pg_trigger_depth() > 1%' THEN
    RAISE EXCEPTION 'the freeze guard does not carry the journal exemption';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_bbj_repair_unbanked') NOT LIKE '%fn_platform_frozen()%' THEN
    RAISE EXCEPTION 'fn_bbj_repair_unbanked does not check the freeze';
  END IF;
END $$;

COMMIT;
