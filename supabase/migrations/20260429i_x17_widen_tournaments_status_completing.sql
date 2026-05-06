-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Round 17 — CHECK constraint violation hunt.
--
-- Scanned every literal status / category / type / wallet pass-through in
-- engine + frontend code against the allow-lists in
-- pg_constraint.consrc. Found 1 critical pre-relaunch bug:
--
--   tournaments.status_check rejects 'COMPLETING' but the engine atomic
--   finalize guard at server/src/GameServer.ts:2400 writes that value to
--   claim the RUNNING → COMPLETING transition. Without it:
--
--     1. .update fails the CHECK
--     2. JS catches the error, tournament stays in RUNNING
--     3. Stuck-COMPLETING recovery code (GameServer.ts:578 + 793) queries
--        for status='COMPLETING' to recover — but the value never landed,
--        so recovery finds nothing and tournaments accumulate as stuck
--        RUNNING rows indefinitely
--
-- Production is currently unaffected because all 133 tournaments are
-- CANCELLED — no tournament has ever been exercised through the finalize
-- path. This fix is preventive for the relaunch when tournaments will
-- actually run to completion.
--
-- Other status / category / type / wallet writes scanned and passing:
--   tables.status                     waiting/active/running/paused/closed
--   tournament_players.status         playing
--   chip_ledger.from_type / to_type   player_wallet/club_treasury/etc
--   wallet_transactions.category      buyin/cashout/etc
--   wallet_transactions.wallet_type   PLAYER (only literal seen)
--
-- Applied to production via Supabase MCP migration
-- x17_widen_tournaments_status_to_include_completing_2026_04_29.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_status_check;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_status_check
      CHECK (status = ANY (ARRAY[
        'ANNOUNCED'::text,
        'REGISTERING'::text,
        'LATE_REG'::text,
        'RUNNING'::text,
        'COMPLETING'::text,
        'COMPLETED'::text,
        'CANCELLED'::text
      ]));
