BEGIN;
CREATE FUNCTION public.zz_legacy_lane_unreviewed() RETURNS void LANGUAGE plpgsql AS
 $body$ BEGIN PERFORM public.fn_ca_lock_settlement_lane_global(); END $body$;
SELECT sep8_spin_fixture.assert(EXISTS(SELECT 1 FROM jsonb_array_elements(public.fn_ca_settlement_lane_doctrine()->'violations') v
 WHERE v->>'rule'='global_lane_callers_are_reviewed' AND v->>'found' LIKE '%zz_legacy_lane_unreviewed%'),
 'Unreviewed global callers remain refused');
ROLLBACK;
BEGIN;
CREATE FUNCTION public.zz_legacy_lane_exclusive_g() RETURNS void LANGUAGE plpgsql AS
 $body$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0)); END $body$;
SELECT sep8_spin_fixture.assert(EXISTS(SELECT 1 FROM jsonb_array_elements(public.fn_ca_settlement_lane_doctrine()->'violations') v
 WHERE v->>'rule'='g_exclusive_only_by_helpers' AND v->>'found' LIKE '%zz_legacy_lane_exclusive_g%'),
 'Undeclared exclusive G remains refused');
ROLLBACK;
BEGIN;
CREATE FUNCTION public.zz_legacy_lane_exclusive_f() RETURNS void LANGUAGE plpgsql AS
 $body$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-finish-lane:v1',0)); END $body$;
SELECT sep8_spin_fixture.assert(EXISTS(SELECT 1 FROM jsonb_array_elements(public.fn_ca_settlement_lane_doctrine()->'violations') v
 WHERE v->>'rule'='f_named_only_by_finish_helpers' AND v->>'found' LIKE '%zz_legacy_lane_exclusive_f%'),
 'Undeclared finish F remains refused');
ROLLBACK;
BEGIN;
CREATE FUNCTION public.zz_legacy_lane_rolling_hold(t uuid) RETURNS void LANGUAGE plpgsql AS
 $body$ BEGIN PERFORM public.fn_ca_lock_settlement_lane_for_tournament(t);
 PERFORM public.fn_ca_hold_legacy_tournament_fee(t,'irrelevant'); END $body$;
SELECT sep8_spin_fixture.assert(EXISTS(SELECT 1 FROM jsonb_array_elements(public.fn_ca_settlement_lane_doctrine()->'violations') v
 WHERE v->>'rule'='rolling_authority_never_reaches_global_lane' AND v->>'found' LIKE '%zz_legacy_lane_rolling_hold%'
 AND v->>'found' LIKE '%fn_ca_hold_legacy_tournament_fee%'),
 'Rolling path cannot reach the newly declared custody child');
ROLLBACK;
BEGIN;
CREATE FUNCTION public.zz_legacy_lane_rolling_resolution(t uuid) RETURNS void LANGUAGE plpgsql AS
 $body$ BEGIN PERFORM public.fn_ca_lock_settlement_lane_for_tournament(t);
 PERFORM public.fn_ca_begin_legacy_fee_resolution(t); END $body$;
SELECT sep8_spin_fixture.assert(EXISTS(SELECT 1 FROM jsonb_array_elements(public.fn_ca_settlement_lane_doctrine()->'violations') v
 WHERE v->>'rule'='rolling_authority_never_reaches_global_lane' AND v->>'found' LIKE '%zz_legacy_lane_rolling_resolution%'
 AND v->>'found' LIKE '%fn_ca_begin_legacy_fee_resolution%'),
 'Rolling path cannot reach the newly declared resolution child');
ROLLBACK;
