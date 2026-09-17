-- 20260917183931_accounting_party_users_is_executable_by_the_role_whose_policy_calls_it.sql
--
-- Version is the one the Supabase management API recorded when it applied this
-- on 2026-09-17 18:39 UTC (outside the break window); the file matches it.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Migration 20260917181100 (union_weekly_accounting_atomic_activation) gave
-- union_accounting_runs the policy union_accounting_runs_scoped_read for
-- `authenticated`, whose USING expression calls
-- public.fn_accounting_party_users('club', standalone_club_id). That
-- function is SECURITY DEFINER and, since 20260914113214, executable by
-- service_role only. Postgres does not short-circuit around a function the
-- caller cannot execute, so EVERY authenticated read of the table raised
-- "permission denied for function fn_accounting_party_users", for rows the
-- caller plainly owns. The Supabase Invariants check (U4.4, the guard that
-- exists because of the 2026-08-26 outage that took 44 tables down the same
-- way) is red on every World Hub pull request until this is fixed.
--
-- The function returns the user ids that may act for a party (a player, a
-- club's owner and admins, a union's owner and overseers); it reads only
-- profiles, clubs, club_members, unions and union_admins through its own
-- SECURITY DEFINER guard and takes no caller input beyond the party
-- reference, so `authenticated` executing it exposes nothing the club and
-- union membership screens do not already show. Grant it, as the invariant
-- itself prescribes.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

GRANT EXECUTE ON FUNCTION public.fn_accounting_party_users(text, uuid) TO authenticated;

COMMIT;
