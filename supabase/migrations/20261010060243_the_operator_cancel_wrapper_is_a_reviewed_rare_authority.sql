-- Author: Codex tournament_stops, Stable Admin six-capability task.
-- Affects: public.fn_ca_settlement_lane_doctrine() only.
-- @live-proof: md5(pg_get_functiondef(to_regprocedure('public.fn_ca_settlement_lane_doctrine()'))) = 'a5f6ef6dc123d31aa6586bffe9452ba8'
-- Reserved 2026-10-10 06:02:43 UTC by the maintained reservation tool.
-- TIER 3: live lane doctrine rejected the new operator cancellation wrapper.
-- The wrapper calls the existing rare/global atomic cancellation owner and
-- takes the same G then B lane BEFORE operation/event/roster row locks.
-- The canonical 2026-09-17 lane plan retains cancellation on the global lane.
-- Converting the wrapper to a rolling lane would upgrade shared G at the
-- original owner and violate both lock order and the rolling call-graph rule.
-- Review exactly this caller; preserve all four doctrine rules, lock helpers,
-- refund owners, permission checks, maker-checker policy and receipts.
-- Native failure-before/after, original 106 money assertions, blocking
-- lane-before-rows and simultaneous duplicate refund qualification:
-- scripts/qualify-stable-admin-cancel-lane-pg17.mjs. No production fixture.
-- Recovery is exact postimage-guarded rollback.sql beside that qualification.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';
DO $review$
DECLARE definition text; updated text;
BEGIN
 IF md5(pg_get_functiondef(to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)'))) IS DISTINCT FROM '8990d936e34696a23ea3d8e7497a2354' THEN RAISE EXCEPTION 'reviewed cancellation owner preimage drift: atomic_cancel_tournament'; END IF;
 IF md5(pg_get_functiondef(to_regprocedure('public.fn_ca_lock_settlement_lane_for_tournament(uuid,uuid)'))) IS DISTINCT FROM '9877846ffabee004690e6b24a3ddcee2' THEN RAISE EXCEPTION 'reviewed cancellation owner preimage drift: fn_ca_lock_settlement_lane_for_tournament'; END IF;
 IF md5(pg_get_functiondef(to_regprocedure('public.fn_ca_lock_settlement_lane_global()'))) IS DISTINCT FROM '7c759bb7a639c3124de2607bdbf12577' THEN RAISE EXCEPTION 'reviewed cancellation owner preimage drift: fn_ca_lock_settlement_lane_global'; END IF;
 IF md5(pg_get_functiondef(to_regprocedure('public.fn_ca_operator_cancel_tournament(uuid,uuid,text,uuid,text)'))) IS DISTINCT FROM '1927a3eb5af1d2de59a3daef7b721177' THEN RAISE EXCEPTION 'reviewed cancellation owner preimage drift: fn_ca_operator_cancel_tournament'; END IF;
 definition:=pg_get_functiondef(to_regprocedure('public.fn_ca_settlement_lane_doctrine()'));
 IF md5(definition) IS DISTINCT FROM '3e35a7d66eda27cb40fc9c8c6db269f5' THEN RAISE EXCEPTION 'lane doctrine preimage drift'; END IF;
 updated:=replace(definition,$old$'atomic_cancel_tournament','fn_award_satellite_seat'$old$,$new$'atomic_cancel_tournament','fn_ca_operator_cancel_tournament','fn_award_satellite_seat'$new$);
 IF updated=definition OR md5(updated) IS DISTINCT FROM 'a5f6ef6dc123d31aa6586bffe9452ba8' THEN RAISE EXCEPTION 'lane doctrine reviewed caller patch drift'; END IF;
 EXECUTE updated;
 IF md5(pg_get_functiondef(to_regprocedure('public.fn_ca_settlement_lane_doctrine()'))) IS DISTINCT FROM 'a5f6ef6dc123d31aa6586bffe9452ba8' THEN RAISE EXCEPTION 'lane doctrine postimage drift'; END IF;
END $review$;
COMMIT;

-- ROLLBACK BEGIN: executable inverse for a separately qualified recovery migration.
-- BEGIN;
-- SET LOCAL lock_timeout='3s';
-- SET LOCAL statement_timeout='45s';
-- DO $inverse$
-- DECLARE definition text; restored text;
-- BEGIN
--  definition:=pg_get_functiondef(to_regprocedure('public.fn_ca_settlement_lane_doctrine()'));
--  IF md5(definition) IS DISTINCT FROM 'a5f6ef6dc123d31aa6586bffe9452ba8' THEN RAISE EXCEPTION 'lane doctrine recovery postimage drift'; END IF;
--  restored:=replace(definition,$new$'atomic_cancel_tournament','fn_ca_operator_cancel_tournament','fn_award_satellite_seat'$new$,$old$'atomic_cancel_tournament','fn_award_satellite_seat'$old$);
--  IF restored=definition OR md5(restored) IS DISTINCT FROM '3e35a7d66eda27cb40fc9c8c6db269f5' THEN RAISE EXCEPTION 'lane doctrine recovery inverse drift'; END IF;
--  EXECUTE restored;
--  IF md5(pg_get_functiondef(to_regprocedure('public.fn_ca_settlement_lane_doctrine()'))) IS DISTINCT FROM '3e35a7d66eda27cb40fc9c8c6db269f5' THEN RAISE EXCEPTION 'lane doctrine recovery preimage drift'; END IF;
-- END $inverse$;
-- COMMIT;
-- ROLLBACK END
