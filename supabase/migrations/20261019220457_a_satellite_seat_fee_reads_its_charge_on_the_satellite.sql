-- 20261019220457_a_satellite_seat_fee_reads_its_charge_on_the_satellite.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261019180622 (#7472) resumes an owner-direct fee capture that was saved
-- 'legacy_unverified' during the 2026-10-19 15:43-19:07 membership move.
-- It cleared 992 of the stuck tournaments. One decided tournament still could
-- not finish: Union Mystery Bounty (PLO5), 19d8ba17-f6e5-40c1-a2db-c98e9819b005,
-- decided at 20:19 UTC with its winner unpaid. The finish refused with
-- tournament_fee_charge_evidence_mismatch on its one satellite-seat fee.
--
-- The cause is one condition in fn_accounting_qualify_owner_direct_fee:
--   l.tournament_id IS DISTINCT FROM r.tournament_id
-- A satellite seat is paid out of the SATELLITE's prize liability, so its
-- charge ledger row is recorded against the satellite
-- (chip_ledger.tournament_id = 33612f2a..., the entitlement's
-- source_satellite_id), not against the target event. The original producer
-- (fn_capture_accounting_tournament_fee) never made this check. The same
-- function's satellite branch already requires l.from_entity_id to be
-- e.source_satellite_id. So for a satellite seat the ledger's tournament is
-- the satellite, and for every other charge it stays the event itself.
--
-- Read from rows: of the 26 owner-direct legacy batches still uncaptured,
-- this is the only satellite seat and the only one whose ledger row names
-- another tournament. Its evidence otherwise matches exactly (entitlement,
-- registration, club 2a1132b9 on all three, posted ledger, 25.00 gross).
--
-- Proved in a rolled-back production transaction (CLAUDE.md 11.5): with this
-- condition, the engine's own fn_complete_tournament_terminal completes
-- 19d8ba17. It pays the 800.00 prize pool across 6 places (282.32 to the
-- winner) with one credit key each, closes escrow at exactly zero and
-- recognizes the 147.50 fee. Nothing here writes a wallet. The engine's
-- finish pays the prize, and no line reads the horse flag.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- @live-proof: position('e.source_satellite_id ELSE r.tournament_id' in pg_get_functiondef('public.fn_accounting_qualify_owner_direct_fee(uuid)'::regprocedure))>0

BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $patch$
DECLARE def text; anchor text; replacement text;
BEGIN
 def:=pg_get_functiondef('public.fn_accounting_qualify_owner_direct_fee(uuid)'::regprocedure);
 IF md5(def)<>'5ba3e7c498a79fd41e403a6d83fb6bc7' THEN
  RAISE EXCEPTION 'definition drift: fn_accounting_qualify_owner_direct_fee(uuid)';
 END IF;
 anchor:=$a$OR l.tournament_id IS DISTINCT FROM r.tournament_id OR l.status IS DISTINCT FROM 'posted'$a$;
 replacement:=$r$OR l.tournament_id IS DISTINCT FROM (CASE WHEN e.entitlement_kind='satellite_seat' THEN e.source_satellite_id ELSE r.tournament_id END) OR l.status IS DISTINCT FROM 'posted'$r$;
 IF (length(def)-length(replace(def,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'patch anchor drift: fn_accounting_qualify_owner_direct_fee(uuid)';
 END IF;
 EXECUTE replace(def,anchor,replacement);
END $patch$;

COMMIT;
