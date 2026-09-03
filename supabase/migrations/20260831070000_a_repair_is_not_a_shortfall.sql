-- ============================================================================
-- 20260831070000_a_repair_is_not_a_shortfall.sql
-- TIER: 2 | AFFECTS: v_spin_reserve_health.shortfall_events
-- Applied to production via the Supabase MCP on 2026-08-31.
--
-- FOUND while verifying PHASE 2 end to end. The spin-sweep cron had been
-- returning HTTP 500 on EVERY run, and cron_health_log read 'error' for
-- spin-sweep continuously, over a condition resolved on 2026-08-23.
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
-- never been an actual shortfall on this platform; the single row reads
-- "REPAIR: removed 5 duplicate settlement pair(s)...". The alarm was
-- reporting a completed maintenance task as a live money emergency, forever.
--
-- Its three sibling counters on this same view (unbooked_24h,
-- null_multiplier_24h, fee_violations_24h) are all bounded to 24 hours.
-- shortfall_events alone was not, which is what made it permanent rather
-- than merely noisy.
--
-- WHY IT MATTERS BEYOND TIDINESS. The handler alerts on shortfall_events > 0
-- and returns 500 whenever any alert is set, so the endpoint could not report
-- anything else: a genuine thin pool, an unbooked game, or the phase-2
-- expired-unfilled counts all arrive on a channel that has been crying wolf
-- since 2026-08-23. An alarm that is always red is not an alarm.
--
-- FIX: count only rows whose note actually says SHORTFALL, bounded to 24h
-- like its siblings. Nothing is deleted - every adjustment row, repair or
-- otherwise, remains in spin_reserve_ledger and readable.
--
-- ROLLBACK: restore the previous definition (all 'adjustment', unbounded).
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
         -- Bounded like every sibling counter here, so a real event raises
         -- the alarm and lets it fall again once handled.
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
