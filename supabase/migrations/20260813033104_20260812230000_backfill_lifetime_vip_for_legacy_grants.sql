-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260813033104 "20260812230000_backfill_lifetime_vip_for_legacy_grants"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f47a3950031ea98e32b7ff9203b926d5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- 20260812230000_backfill_lifetime_vip_for_legacy_grants.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        3                       (data mutation on entitlements)
-- AUTHOR:      Claude (Cowork session 2026-08-12)
-- AFFECTS:     tables: public.profiles (vip_tier, vip_expires_at)
--                      public.vip_backfill_20260812_backup (created)
-- IRREVERSIBLE: no  — exact prior state is preserved in the backup table.
--
-- WHY:
--   /api/vip/check-status is the single truth source for every VIP gate.
--   It requires is_vip = true AND (vip_tier = 'lifetime' OR vip_expires_at
--   > now()). That hardening was correct — it closed a hole where expired
--   trials kept VIP forever. But 470 of 473 VIP accounts were granted
--   before the Stripe webhook was fixed to write tier/expiry, so they carry
--   is_vip = true with BOTH vip_tier and vip_expires_at NULL and therefore
--   read as NOT VIP.
--
--   Observed consequences on production 2026-08-12, reproduced in a real
--   browser on a real VIP account:
--     - /hub/trivia/pvp renders "Premium Feature - PvP Battle Mode is a
--       premium feature" on stake selection and fires no PvP API call at
--       all, i.e. 1v1 is completely unreachable for 99.4% of VIPs.
--     - StrategyTrivia takes its `if (!isVip && entryCost > 0)` branch and
--       charges 10 diamonds per game while the Diamond Cost modal promises
--       "VIP Members Play FREE - Unlimited Games, No Diamond Cost".
--       Four such game_cost rows exist in diamond_transactions.
--   Meanwhile /api/user/get-header-stats reads profiles.is_vip directly and
--   shows those same users a VIP badge — two sources of truth disagreeing.
--
--   Decision by Dan (platform owner, 2026-08-12, in-session): these 470 are
--   early users, personal friends and horses. Grant them lifetime VIP.
--   This is an owner entitlement decision, recorded here deliberately so a
--   future agent does not "correct" it back.
--
-- HOW:
--   - Snapshot every affected row (id + prior vip_tier/vip_expires_at)
--     into vip_backfill_20260812_backup so rollback is exact, not guessed.
--   - Set vip_tier = 'lifetime' for exactly those rows.
--   - vip_expires_at stays NULL: check-status short-circuits on
--     vip_tier = 'lifetime' and never reads the expiry for lifetime members.
--   - is_vip is NOT touched — it is already true for every target row.
--
-- SCOPE GUARD:
--   Targets ONLY is_vip = true AND vip_tier IS NULL AND vip_expires_at IS
--   NULL. The 3 accounts that already carry a real tier/expiry are left
--   alone, and no non-VIP account is ever granted anything.
--
-- ROLLBACK:
--   UPDATE public.profiles p
--      SET vip_tier       = b.prev_vip_tier,
--          vip_expires_at = b.prev_vip_expires_at
--     FROM public.vip_backfill_20260812_backup b
--    WHERE p.id = b.user_id;
--   DROP TABLE public.vip_backfill_20260812_backup;
--
-- See .agent/workflows/migration-safety.md for the full protocol.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. PRE-FLIGHT ASSERTIONS ─────────────────────────────────────────
DO $$
DECLARE
    v_target_count integer;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'profiles'
          AND column_name = 'vip_tier'
    ) THEN
        RAISE EXCEPTION 'pre-flight failed: profiles.vip_tier does not exist';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'profiles'
          AND column_name = 'vip_expires_at'
    ) THEN
        RAISE EXCEPTION 'pre-flight failed: profiles.vip_expires_at does not exist';
    END IF;

    SELECT count(*) INTO v_target_count
      FROM public.profiles
     WHERE is_vip IS TRUE AND vip_tier IS NULL AND vip_expires_at IS NULL;

    -- Measured at 470 immediately before writing this migration. Allow a
    -- small drift for live signups, but abort on anything wild — that would
    -- mean the target set is not what was reviewed.
    IF v_target_count NOT BETWEEN 400 AND 550 THEN
        RAISE EXCEPTION
            'pre-flight failed: expected ~470 stranded VIP rows, found %', v_target_count;
    END IF;

    RAISE NOTICE 'pre-flight ok: % stranded VIP rows will be granted lifetime', v_target_count;
END $$;

-- ─── 2. THE ACTUAL CHANGES ────────────────────────────────────────────

-- 2a. Exact-state backup for rollback.
CREATE TABLE IF NOT EXISTS public.vip_backfill_20260812_backup (
    user_id             uuid PRIMARY KEY,
    prev_is_vip         boolean,
    prev_vip_tier       text,
    prev_vip_expires_at timestamptz,
    backed_up_at        timestamptz NOT NULL DEFAULT now()
);

-- Service-role only. No client should ever read this.
ALTER TABLE public.vip_backfill_20260812_backup ENABLE ROW LEVEL SECURITY;

INSERT INTO public.vip_backfill_20260812_backup
        (user_id, prev_is_vip, prev_vip_tier, prev_vip_expires_at)
SELECT id, is_vip, vip_tier, vip_expires_at
  FROM public.profiles
 WHERE is_vip IS TRUE AND vip_tier IS NULL AND vip_expires_at IS NULL
ON CONFLICT (user_id) DO NOTHING;

-- 2b. The grant.
UPDATE public.profiles
   SET vip_tier = 'lifetime'
 WHERE is_vip IS TRUE AND vip_tier IS NULL AND vip_expires_at IS NULL;

-- ─── 3. POST-APPLY ASSERTIONS ─────────────────────────────────────────
DO $$
DECLARE
    v_remaining   integer;
    v_lifetime    integer;
    v_backed_up   integer;
    v_non_vip_hit integer;
BEGIN
    SELECT count(*) INTO v_remaining
      FROM public.profiles
     WHERE is_vip IS TRUE AND vip_tier IS NULL AND vip_expires_at IS NULL;
    IF v_remaining <> 0 THEN
        RAISE EXCEPTION 'post-apply failed: % stranded VIP rows remain', v_remaining;
    END IF;

    SELECT count(*) INTO v_lifetime
      FROM public.profiles WHERE vip_tier = 'lifetime';
    SELECT count(*) INTO v_backed_up
      FROM public.vip_backfill_20260812_backup;
    IF v_lifetime < v_backed_up THEN
        RAISE EXCEPTION
            'post-apply failed: % lifetime rows < % backed-up rows', v_lifetime, v_backed_up;
    END IF;

    -- Nothing that was not already is_vip may have been granted anything.
    SELECT count(*) INTO v_non_vip_hit
      FROM public.profiles
     WHERE is_vip IS NOT TRUE AND vip_tier = 'lifetime';
    IF v_non_vip_hit <> 0 THEN
        RAISE EXCEPTION
            'post-apply failed: % non-VIP rows received lifetime tier', v_non_vip_hit;
    END IF;

    RAISE NOTICE 'post-apply ok: % rows backed up, % lifetime VIPs total', v_backed_up, v_lifetime;
END $$;

COMMIT;
