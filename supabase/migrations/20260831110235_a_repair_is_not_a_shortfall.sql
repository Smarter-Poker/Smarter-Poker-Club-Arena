-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831110235; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
-- 20260831070000_a_repair_is_not_a_shortfall.sql
-- TIER: 2 | AFFECTS: v_spin_reserve_health.shortfall_events
--
-- FOUND while verifying PHASE 2 (2026-08-31). The spin-sweep cron has been
-- returning HTTP 500 on EVERY run, and cron_health_log has read 'error' for
-- spin-sweep continuously, for a condition that was resolved on 2026-08-23.
--
-- shortfall_events counted EVERY row of kind='adjustment', all-time, with no
-- note filter:
--
--     (SELECT count(*) FROM spin_reserve_ledger l
--       WHERE fn_spin_reserve_owner(l.club_id) = p.club_id
--         AND l.kind = 'adjustment') AS shortfall_events
--
-- but 'adjustment' is the kind fn_spin_settle_game uses for a SHORTFALL note
-- AND the kind the 2026-08-23 duplicate-settlement REPAIR used. There has
-- never been an actual shortfall on this platform; the single row says
-- "REPAIR: removed 5 duplicate settlement pair(s)...". So the alarm was
-- reporting a fixed maintenance event as a live money emergency, for ever.
--
-- Its three sibling counters on this same view (unbooked_24h,
-- null_multiplier_24h, fee_violations_24h) are all bounded to 24 hours.
-- shortfall_events alone was not - which is what made it permanent rather
-- than merely noisy.
--
-- WHY IT MATTERS BEYOND TIDINESS. The handler alerts on shortfall_events > 0
-- and returns 500 when any alert is set, so the endpoint could not report
-- anything else: a genuine thin pool, an unbooked game, or the new
-- expired-unfilled counts from phase 2 all arrive on a channel that has been
-- crying wolf since 2026-08-23. An alarm that is always red is not an alarm.
--
-- FIX: count only rows whose note actually says SHORTFALL, and bound it to
-- 24h like its siblings. Nothing is deleted - every adjustment row, repair or
-- otherwise, is still in spin_reserve_ledger and still readable.
--
-- ROLLBACK: restore the previous definition (count all 'adjustment', no bound).
-- ============================================================================

CREATE OR REPLACE VIEW public.v_spin_reserve_health AS
 SELECT p.club_id,
    COALESCE(c.name, u.name) AS club_name,
    p.balance,
    p.seeded_amount,
    p.highest_stake,
    p.ceiling_amount,
    p.spin_count,
    p.total_deposited,
    p.total_drawn,
    round(p.highest_stake * 100::numeric * 1.5, 2) AS need_for_100x,
    p.balance >= (p.highest_stake * 100::numeric * 1.5) AS can_draw_100x,
    p.balance < (p.highest_stake * 10::numeric) AS is_thin,
    ( SELECT count(*) AS count
        FROM spin_reserve_ledger l
       WHERE fn_spin_reserve_owner(l.club_id) = p.club_id
         AND l.kind = 'adjustment'::text
         -- A REPAIR IS NOT A SHORTFALL (2026-08-31). fn_spin_settle_game
         -- writes 'SHORTFALL <n> covered by operator' into the note when the
         -- pool could not cover a prize; maintenance writes other notes under
         -- the same kind. Only the former is an operator emergency.
         AND l.note ILIKE '%SHORTFALL%'
         -- Bounded like every sibling counter on this view, so a real event
         -- raises the alarm and then lets it fall again once it is handled.
         AND l.created_at > (now() - '24:00:00'::interval)) AS shortfall_events,
    ( SELECT count(*) AS count
        FROM tournaments t
       WHERE fn_spin_reserve_owner(t.club_id) = p.club_id
         AND t.variant = 'spin'::text
         AND (t.status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text]))
         AND COALESCE(t.buy_in_fee, 0::numeric) = 0::numeric
         AND t.started_at > (now() - '24:00:00'::interval)
         AND NOT (EXISTS ( SELECT 1 FROM spin_reserve_ledger l2
                            WHERE l2.tournament_id = t.id))) AS unbooked_24h,
    ( SELECT count(*) AS count
        FROM tournaments t
       WHERE fn_spin_reserve_owner(t.club_id) = p.club_id
         AND t.variant = 'spin'::text
         AND (t.status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text]))
         AND COALESCE(t.spin_multiplier, 0::numeric) <= 0::numeric
         AND t.started_at > (now() - '24:00:00'::interval)) AS null_multiplier_24h,
    ( SELECT count(*) AS count
        FROM tournaments t
       WHERE fn_spin_reserve_owner(t.club_id) = p.club_id
         AND t.variant = 'spin'::text
         AND (t.status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text]))
         AND COALESCE(t.buy_in_fee, 0::numeric) <> 0::numeric
         AND t.started_at > (now() - '24:00:00'::interval)) AS fee_violations_24h
   FROM spin_bonus_pools p
     LEFT JOIN clubs c ON c.id = p.club_id
     LEFT JOIN unions u ON u.id = p.club_id;

DO $$
DECLARE v_short int; v_adjust_total int;
BEGIN
  SELECT sum(shortfall_events) INTO v_short FROM public.v_spin_reserve_health;
  SELECT count(*) INTO v_adjust_total FROM public.spin_reserve_ledger WHERE kind='adjustment';
  IF v_short <> 0 THEN
    RAISE EXCEPTION 'expected 0 real shortfalls in the last 24h, view reports %', v_short;
  END IF;
  RAISE NOTICE 'shortfall_events now %, with % adjustment row(s) still recorded in the ledger',
    v_short, v_adjust_total;
END $$;
