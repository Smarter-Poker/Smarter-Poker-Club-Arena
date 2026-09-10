-- 20260909233807_the_engine_on_main_can_read_the_entitlements_it_reads.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20260909222044_paid_spin_launch_reads_owner_only_entitlements_through_one_door
-- (applied to production 2026-09-09 22:20 UTC from branch
-- agent/codex-live-realtime/stage-b-v2, PR #3908, NOT yet on main) revoked
-- service_role's read of tournament_refund_entitlements and installed
-- fn_ca_paid_spin_launch_entitlements as the one door. The engine that
-- reads the table directly is the one on main and the one running
-- (image b53ad9b2): TournamentManagerBase's paid-Spin gate does
-- .from('tournament_refund_entitlements').select(...). Measured 23:40 UTC:
-- 9,930 "permission denied for table tournament_refund_entitlements" in
-- thirty minutes, every paid Spin on the platform standing down and
-- retrying every few seconds, 128 Spin boards REGISTERING, none able to
-- deal. The gate's failure policy is correct - unreadable evidence is not
-- evidence of non-payment - which is exactly why the revoke shows up as a
-- freeze rather than a free spin.
--
-- This restores the READ (and only the read) to the engine role until the
-- engine that walks through the door is the engine that is running. It is a
-- GRANT, so it fires no schema reload. When #3908 lands and the direct read
-- is gone from server/src, the branch that owns the door revokes this again
-- in its own migration; nothing else depends on it.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

GRANT SELECT ON TABLE public.tournament_refund_entitlements TO service_role;

COMMIT;
